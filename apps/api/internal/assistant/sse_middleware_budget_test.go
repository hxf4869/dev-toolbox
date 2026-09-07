package assistant

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

var errSyntheticFlushFailure = errors.New("synthetic socket flush failure")

func sseTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// sseFlushErrWriter stands in for a transport that fails on flush. It supports
// deadlines, so the sseWriter keeps its per-write budget and must observe the
// flush error through the production statusWriter wrapper.
type sseFlushErrWriter struct{}

func (writer *sseFlushErrWriter) Header() http.Header              { return http.Header{} }
func (writer *sseFlushErrWriter) Write(body []byte) (int, error)   { return len(body), nil }
func (writer *sseFlushErrWriter) WriteHeader(int)                  {}
func (writer *sseFlushErrWriter) FlushError() error                { return errSyntheticFlushFailure }
func (writer *sseFlushErrWriter) SetWriteDeadline(time.Time) error { return nil }

// A flush failure must survive the real RequestLog middleware (statusWriter)
// and end the stream instead of being swallowed into a nil error.
func TestSSEFlushErrorEndsStreamThroughRealRequestLogMiddleware(t *testing.T) {
	const maxWrites = 5
	writes := 0
	var firstErr error
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		stream, err := newSSEWriter(response)
		if err != nil {
			return
		}
		for i := 0; i < maxWrites; i++ {
			if err := stream.writeComment("heartbeat"); err != nil {
				firstErr = err
				return
			}
			writes++
		}
	})
	httpapi.RequestLog(sseTestLogger(), handler).ServeHTTP(
		&sseFlushErrWriter{}, httptest.NewRequest(http.MethodGet, "/events", nil))

	if !errors.Is(firstErr, errSyntheticFlushFailure) {
		t.Fatalf("flush error through the production statusWriter = %v, want the underlying failure", firstErr)
	}
	if writes != 0 {
		t.Fatalf("the stream must end on the first failed write, but %d further writes happened", writes)
	}
}

// withShrunkWriteBudget swaps the write budget for one test. Package tests run
// sequentially (no t.Parallel in this package), so the temporary swap is safe.
func withShrunkWriteBudget(t *testing.T, budget time.Duration) {
	t.Helper()
	original := sseWriteTimeout
	sseWriteTimeout = budget
	t.Cleanup(func() { sseWriteTimeout = original })
}

// silenceStreamHandler emits a first event, stays idle far beyond the write
// budget (a model/prepare pause), then writes a second event.
func silenceStreamHandler() http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		stream, err := newSSEWriter(response)
		if err != nil {
			return
		}
		response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		response.WriteHeader(http.StatusOK)
		if stream.writeRaw("retry: 3000\n\n") != nil {
			return
		}
		if stream.write("snapshot", map[string]any{"n": 1}) != nil {
			return
		}
		time.Sleep(4 * sseWriteTimeout)
		_ = stream.write("run.status", map[string]any{"n": 2})
	})
}

func assertBothEventsDelivered(t *testing.T, response *http.Response) {
	t.Helper()
	defer response.Body.Close()
	body, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		t.Fatalf("stream was terminated around the idle stretch: %v; body=%q", readErr, string(body))
	}
	if !strings.Contains(string(body), `"n":1`) {
		t.Fatalf("first event missing: %q", string(body))
	}
	if !strings.Contains(string(body), `"n":2`) {
		t.Fatalf("second event after the silent stretch was lost: %q", string(body))
	}
}

// HTTP/1.1: idle time between events must not be counted as a slow client.
func TestSSESecondEventAfterSilenceStillDeliveredHTTP1(t *testing.T) {
	withShrunkWriteBudget(t, 250*time.Millisecond)
	server := httptest.NewServer(httpapi.RequestLog(sseTestLogger(), silenceStreamHandler()))
	defer server.Close()
	client := server.Client()
	client.Timeout = 30 * time.Second

	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	assertBothEventsDelivered(t, response)
}

// HTTP/2 conditional case: with a deadline left armed across the idle stretch
// the h2 stream is killed by the connection write timer; clearing the deadline
// after each successful write must keep both events deliverable.
func TestSSESecondEventAfterSilenceStillDeliveredHTTP2(t *testing.T) {
	withShrunkWriteBudget(t, 250*time.Millisecond)
	server := httptest.NewUnstartedServer(httpapi.RequestLog(sseTestLogger(), silenceStreamHandler()))
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	client := server.Client()
	client.Timeout = 30 * time.Second

	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if response.Proto != "HTTP/2.0" {
		t.Fatalf("expected the local fixture to negotiate HTTP/2, got %s", response.Proto)
	}
	assertBothEventsDelivered(t, response)
}

// A client that reads only the response head and never drains the body must
// release the handler within the write budget even behind the real middleware.
// The budget is shrunk for determinism: when the socket buffer fills is
// environment-dependent, the 15s timeout that releases the handler is not.
func TestSSERequestLogChainReleasesStalledReader(t *testing.T) {
	withShrunkWriteBudget(t, 500*time.Millisecond)
	released := make(chan struct{})
	server := httptest.NewServer(httpapi.RequestLog(sseTestLogger(), http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			defer close(released)
			stream, err := newSSEWriter(response)
			if err != nil {
				return
			}
			payload := strings.Repeat("x", 64*1024)
			for {
				if err := stream.writeComment(payload); err != nil {
					return
				}
			}
		})))
	defer server.Close()

	connection, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := connection.Write([]byte("GET /events HTTP/1.1\r\nHost: test\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read response head: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}
	select {
	case <-released:
	case <-time.After(20 * time.Second):
		t.Fatal("SSE handler stayed blocked writing to a client that never reads the body")
	}
}

// A browser abort (response body closed) must propagate through the public
// request context to the internal worker request, cancelling it there.
func TestSSETemporaryStreamCancellationPropagatesToWorker(t *testing.T) {
	workerSawCancel := make(chan struct{})
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		fmt.Fprint(w, "event: answer.delta\ndata: {\"delta\":\"片段\"}\n\n")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-r.Context().Done()
		close(workerSawCancel)
	}))
	defer worker.Close()

	handlerReturned := make(chan struct{})
	public := httptest.NewServer(httpapi.RequestLog(sseTestLogger(), http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			defer close(handlerReturned)
			stream, err := newSSEWriter(response)
			if err != nil {
				return
			}
			response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			response.WriteHeader(http.StatusOK)
			if stream.writeRaw("\n") != nil {
				return
			}
			sequence := 0
			service := &Service{
				workerURL:            worker.URL,
				internalServiceToken: "test",
				httpClient:           &http.Client{},
				now:                  time.Now,
			}
			execution := lockedExecution{
				modelID: uuid.New(), providerID: uuid.New(), providerDisplayName: "Provider",
				upstreamModelID: "model", contextWindow: 1024, maxOutputTokens: 256,
			}
			service.streamTemporaryAnswer(request.Context(), stream, &sequence, execution, "key", "allow",
				temporaryStreamInput{Content: "问题"}, nil, "unavailable",
				temporaryRuntimeTrace{StartedAt: time.Now().UTC()})
		})))
	defer public.Close()

	client := public.Client()
	client.Timeout = 10 * time.Second
	response, err := client.Get(public.URL)
	if err != nil {
		t.Fatal(err)
	}
	eventType, _, err := readSSEEvent(bufio.NewReader(response.Body))
	if err != nil || eventType != "answer.delta" {
		t.Fatalf("first proxied event = %q err=%v", eventType, err)
	}
	response.Body.Close() // browser AbortController: drop the unread rest

	select {
	case <-workerSawCancel:
	case <-time.After(10 * time.Second):
		t.Fatal("worker request context was not cancelled after the browser dropped the stream")
	}
	select {
	case <-handlerReturned:
	case <-time.After(10 * time.Second):
		t.Fatal("public handler did not finish after the client disconnect")
	}
}

// pagedEventQuerier teaches the shared fakeQuerier the after/limit paging of
// loadEventBatch so the runEventsStream write loop can be replayed end to end
// through the real middleware.
type pagedEventQuerier struct {
	fakeQuerier
}

func (fake *pagedEventQuerier) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	if strings.Contains(query, "FROM assistant_run_events") && len(args) >= 3 {
		after, _ := args[1].(int64)
		limit, _ := args[2].(int)
		paged := make([][]any, 0, limit)
		for _, row := range fake.eventRows {
			if row[0].(int64) > after {
				paged = append(paged, row)
				if len(paged) >= limit {
					break
				}
			}
		}
		return &fakeRows{rows: paged}, nil
	}
	return fake.fakeQuerier.Query(ctx, query, args...)
}

// A long tail spanning several batches must arrive completely, ending with the
// synthesized terminal event; and the streaming path itself never mutates or
// cancels the persistent run (a disconnect only ends the subscription).
func TestSSEPersistentStreamTailCompletesAcrossBatchesWithoutRunWrites(t *testing.T) {
	runID := uuid.New()
	fake := &pagedEventQuerier{fakeQuerier{
		progress:  []any{int64(200), "succeeded"},
		runValues: fakeRunValues("succeeded", false),
		eventRows: deltaEventRows(200, 1),
		counts:    []any{0, 0, int64(200)},
	}}
	service := &Service{broadcast: newBroadcaster(), now: time.Now}
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		stream, err := newSSEWriter(response)
		if err != nil {
			return
		}
		response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		response.WriteHeader(http.StatusOK)
		if stream.writeRaw("retry: 3000\n\n") != nil {
			return
		}
		lastSequence := int64(0)
		// Mirrors the runEventsStream loop without the tickers: batch reads
		// behind the real middleware, terminal closes the stream.
		for {
			events, terminal, err := service.loadEventBatch(request.Context(), fake, runID, lastSequence)
			if err != nil {
				return
			}
			for _, event := range events {
				if stream.writeID(event.Type, strconv.FormatInt(event.Sequence, 10), event.Payload) != nil {
					return
				}
				lastSequence = event.Sequence
			}
			if terminal {
				return
			}
			if len(events) == sseEventBatchSize {
				continue
			}
		}
	})
	server := httptest.NewServer(httpapi.RequestLog(sseTestLogger(), handler))
	defer server.Close()
	client := server.Client()
	client.Timeout = 30 * time.Second

	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		t.Fatal(readErr)
	}

	if got := strings.Count(string(body), "event: answer.delta"); got != 200 {
		t.Fatalf("streamed answer.delta events = %d, want the whole 200-event tail", got)
	}
	if !strings.Contains(string(body), "id: 200\nevent: answer.delta") {
		t.Fatal("the last stored event of the tail was not streamed")
	}
	if !strings.Contains(string(body), "id: 201\nevent: run.completed") {
		t.Fatalf("the synthesized terminal event is missing from the stream tail: %q", tail(string(body), 200))
	}
	// The persistent run is never modified by the streaming path: disconnect
	// ends the subscription only.
	for _, query := range fake.queries {
		upper := strings.ToUpper(query)
		if strings.Contains(upper, "UPDATE") || strings.Contains(upper, "INSERT") {
			t.Fatalf("streaming path issued a run-mutating query: %s", query)
		}
	}
}

func tail(value string, size int) string {
	if len(value) <= size {
		return value
	}
	return value[len(value)-size:]
}

// After a disconnect the subscription must be gone: broadcast wake-ups reach
// nobody, and no run-owned state is touched by the unsubscribe.
func TestSSEDisconnectOnlyUnsubscribesRunBroadcaster(t *testing.T) {
	runID := uuid.New()
	service := &Service{broadcast: newBroadcaster()}
	channel := service.broadcast.subscribe(runID)
	service.broadcast.unsubscribe(runID, channel)
	service.broadcast.notify(runID)
	select {
	case <-channel:
		t.Fatal("a page disconnect must not leave a live subscription behind")
	default:
	}
}

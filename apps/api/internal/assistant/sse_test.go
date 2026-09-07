package assistant

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// T28: a client that reads only the response head and never drains the body
// must not pin the connection forever. A real TCP server is required; a
// ResponseRecorder cannot reproduce a blocked write. The budget is shrunk
// because the round at which the socket buffer finally fills is
// environment-dependent; only "blocked write times out" must be deterministic.
func TestSSEWriteBudgetReleasesStalledClient(t *testing.T) {
	withShrunkWriteBudget(t, 500*time.Millisecond)
	released := make(chan struct{})
	events := make(chan string, 8)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		defer close(released)
		stream, err := newSSEWriter(response)
		events <- fmt.Sprintf("supported=%v err=%v", stream.deadlineSupport, err)
		payload := strings.Repeat("x", 64*1024)
		for i := 0; ; i++ {
			if err := stream.writeComment(payload); err != nil {
				events <- fmt.Sprintf("writeComment err=%v i=%d", err, i)
				return
			}
		}
	}))
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
	// The client now stops reading; the server must give up on its own.
	select {
	case <-released:
	case <-time.After(20 * time.Second):
		t.Fatal("SSE handler stayed blocked writing to a client that never reads the body")
	}
	for {
		select {
		case event := <-events:
			t.Log(event)
		default:
			return
		}
	}
}

func TestSSEWriterPropagatesWriteErrors(t *testing.T) {
	recorder := httptest.NewRecorder()
	stream, err := newSSEWriter(recorder)
	if err != nil {
		t.Fatal(err)
	}
	// Force the failing writer after construction: the recorder accepts
	// deadlines only in the real-server case, so swap the sink directly.
	stream.writer = failingWriter{}
	if err := stream.writeComment("heartbeat"); err == nil {
		t.Fatal("a failing connection write must surface as an error")
	}
}

// A ResponseWriter without deadline support (plain test writers) must keep
// working; it just runs without the sliding write budget.
func TestSSEWriterWithoutDeadlineSupportStillStreams(t *testing.T) {
	recorder := httptest.NewRecorder()
	stream, err := newSSEWriter(recorder)
	if err != nil {
		t.Fatalf("ResponseRecorder-backed writer should stay usable: %v", err)
	}
	if stream.deadlineSupport {
		t.Fatal("ResponseRecorder must be detected as lacking deadline support")
	}
	if err := stream.write("snapshot", map[string]any{"ok": true}); err != nil {
		t.Fatalf("write on a writer without deadline support: %v", err)
	}
	if !strings.Contains(recorder.Body.String(), "event: snapshot") {
		t.Fatalf("event was not written: %q", recorder.Body.String())
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("connection reset") }

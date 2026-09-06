package assistant

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeQuerier counts queries and returns canned rows, so the SSE read path can
// be asserted without a database.
type fakeQuerier struct {
	mu      sync.Mutex
	queries []string

	progress   []any // hasRunProgress row: maxSequence, status
	runValues  []any // full run row scan values
	runErr     error
	eventRows  [][]any // stored events: sequence, event_type, payload
	sourceRows [][]any // run sources rows
	counts     []any   // runCounts row: provided, cited, lastSequence
	// latestEventType answers the empty-batch terminal boundary check
	// (event_type of the stored event at sequence = after).
	latestEventType string
}

func (fake *fakeQuerier) record(query string) {
	fake.mu.Lock()
	fake.queries = append(fake.queries, query)
	fake.mu.Unlock()
}

func (fake *fakeQuerier) sourceQueryCount() int {
	count := 0
	for _, query := range fake.queries {
		if strings.Contains(query, "FROM assistant_run_sources s") {
			count++
		}
	}
	return count
}

func (fake *fakeQuerier) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	fake.record(query)
	switch {
	case strings.Contains(query, "SELECT COALESCE((SELECT max(sequence)"):
		return &fakeRow{values: fake.progress}
	case strings.Contains(query, "FROM assistant_run_events WHERE run_id = $1 AND sequence = $2"):
		return &fakeRow{values: []any{fake.latestEventType}}
	case strings.Contains(query, "FROM assistant_runs WHERE id = $1"):
		return &fakeRow{values: fake.runValues, err: fake.runErr}
	case strings.Contains(query, "count(*) FROM assistant_run_sources"):
		return &fakeRow{values: fake.counts}
	}
	return &fakeRow{err: errors.New("unexpected QueryRow: " + query)}
}

func (fake *fakeQuerier) Query(_ context.Context, query string, args ...any) (pgx.Rows, error) {
	fake.record(query)
	switch {
	case strings.Contains(query, "FROM assistant_run_events"):
		return &fakeRows{rows: fake.eventRows}, nil
	case strings.Contains(query, "FROM assistant_run_sources s"):
		return &fakeRows{rows: fake.sourceRows}, nil
	}
	return nil, errors.New("unexpected Query: " + query)
}

type fakeRow struct {
	values []any
	err    error
}

func (row *fakeRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	return copyScanValues(dest, row.values)
}

type fakeRows struct {
	rows  [][]any
	index int
}

func (rows *fakeRows) Next() bool {
	rows.index++
	return rows.index <= len(rows.rows)
}

func (rows *fakeRows) Scan(dest ...any) error {
	if rows.index > len(rows.rows) {
		return errors.New("fake rows exhausted")
	}
	return copyScanValues(dest, rows.rows[rows.index-1])
}

func (rows *fakeRows) Close()                        {}
func (rows *fakeRows) Err() error                    { return nil }
func (rows *fakeRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }
func (rows *fakeRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}
func (rows *fakeRows) Values() ([]any, error) { return nil, nil }
func (rows *fakeRows) RawValues() [][]byte    { return nil }
func (rows *fakeRows) Conn() *pgx.Conn        { return nil }

func copyScanValues(dest []any, values []any) error {
	if len(dest) != len(values) {
		return fmt.Errorf("scan arity mismatch: %d targets vs %d values", len(dest), len(values))
	}
	for index, target := range dest {
		targetValue := reflect.ValueOf(target)
		if targetValue.Kind() != reflect.Pointer {
			return errors.New("scan target must be a pointer")
		}
		if values[index] == nil {
			targetValue.Elem().Set(reflect.Zero(targetValue.Elem().Type()))
			continue
		}
		source := reflect.ValueOf(values[index])
		element := targetValue.Elem()
		if !source.Type().AssignableTo(element.Type()) {
			if source.Type().ConvertibleTo(element.Type()) {
				element.Set(source.Convert(element.Type()))
				continue
			}
			return fmt.Errorf("cannot scan %T into %T", values[index], target)
		}
		element.Set(source)
	}
	return nil
}

// fakeRunValues mirrors runScanTargets order for a plain running/succeeded run.
func fakeRunValues(status string, stopRequested bool) []any {
	var stopRequestedAt *time.Time
	if stopRequested {
		stopRequestedAt = &time.Time{}
	}
	nilUUID := (*uuid.UUID)(nil)
	nilString := (*string)(nil)
	nilTime := (*time.Time)(nil)
	nilInt := (*int)(nil)
	nilInt64 := (*int64)(nil)
	return []any{
		uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), nilUUID,
		status, nilString, stopRequestedAt, 1, nilString, nilInt, nilTime, nilTime,
		uuid.New(), "provider", uuid.New(), "模型", "upstream", "openai", "http://provider.test", 8192, 2048,
		nilString, nilString, "normal", "normal", "prompt-v2", "hybrid-rrf-v1", false,
		"ready", nilInt64, nilString,
		nilInt64, nilInt64, nilInt64, nilInt64, nilInt64,
		nilInt64, nilInt64, nilInt64, nilInt64, nilInt64,
		time.Now(), time.Now(), nilTime, nilTime, nilString, nilString,
	}
}

func deltaEventRows(count, firstSequence int64) [][]any {
	rows := make([][]any, 0, count)
	for sequence := firstSequence; sequence < firstSequence+count; sequence++ {
		rows = append(rows, []any{
			sequence, "answer.delta", []byte(fmt.Sprintf(`{"delta":"片段%d"}`, sequence)),
		})
	}
	return rows
}

// T29: an idle stream performs one cheap query per wake-up; it must not open
// the full read (no source snapshot load, no event scan).
func TestHasRunProgressSingleCheapQuery(t *testing.T) {
	fake := &fakeQuerier{progress: []any{int64(5), "running"}}
	progressed, err := hasRunProgress(context.Background(), fake, uuid.New(), 5)
	if err != nil {
		t.Fatal(err)
	}
	if progressed {
		t.Fatal("an unchanged run must not trigger the full read")
	}
	if len(fake.queries) != 1 {
		t.Fatalf("idle wake-up must issue exactly one query, got %d", len(fake.queries))
	}
	if strings.Contains(fake.queries[0], "assistant_run_sources") || strings.Contains(fake.queries[0], "ORDER BY sequence") {
		t.Fatalf("idle wake-up must not scan events or sources: %s", fake.queries[0])
	}
}

func TestHasRunProgressDetectsNewEventsAndTerminalState(t *testing.T) {
	fake := &fakeQuerier{progress: []any{int64(7), "running"}}
	if progressed, err := hasRunProgress(context.Background(), fake, uuid.New(), 5); err != nil || !progressed {
		t.Fatalf("new events must trigger the full read (progressed=%v err=%v)", progressed, err)
	}
	fake = &fakeQuerier{progress: []any{int64(3), "succeeded"}}
	if progressed, err := hasRunProgress(context.Background(), fake, uuid.New(), 3); err != nil || !progressed {
		t.Fatalf("a terminal run must trigger the full read to synthesize its terminal event (progressed=%v err=%v)", progressed, err)
	}
}

// T30: the fallback path reads from the database, so a missed broadcast is
// always compensated by the next tick-driven read.
func TestSSEFallbackPollingRecoversMissedBroadcast(t *testing.T) {
	if ssePollInterval < time.Second || ssePollInterval > 2*time.Second {
		t.Fatalf("fallback polling must sit between 1s and 2s, got %v", ssePollInterval)
	}
	runID := uuid.New()
	fake := &fakeQuerier{
		progress:  []any{int64(2), "running"},
		runValues: fakeRunValues("running", false),
		eventRows: deltaEventRows(2, 1),
		counts:    []any{0, 0, int64(2)},
	}
	service := &Service{}
	events, terminal, err := service.loadEventBatch(context.Background(), fake, runID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if terminal {
		t.Fatal("a running run must not end the stream")
	}
	if len(events) != 2 || events[1].Sequence != 2 {
		t.Fatalf("the poll read must return the stored events without any broadcast, got %+v", events)
	}
}

// Sources are only loaded when the batch contains a citation event.
func TestLoadEventBatchSkipsSourcesWithoutCitations(t *testing.T) {
	runID := uuid.New()
	fake := &fakeQuerier{
		runValues: fakeRunValues("running", false),
		eventRows: deltaEventRows(3, 1),
	}
	service := &Service{}
	events, terminal, err := service.loadEventBatch(context.Background(), fake, runID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if terminal || len(events) != 3 {
		t.Fatalf("unexpected batch: terminal=%v events=%d", terminal, len(events))
	}
	if fake.sourceQueryCount() != 0 {
		t.Fatal("a batch without citation events must not load run sources")
	}
}

func TestLoadEventBatchConvertsCitationsWithSources(t *testing.T) {
	citedNumber := 1
	runID := uuid.New()
	fake := &fakeQuerier{
		runValues: fakeRunValues("running", false),
		eventRows: [][]any{
			{int64(1), "answer.delta", []byte(`{"delta":"结论"}`)},
			{int64(2), "answer.citation", []byte(`{"sourceOrdinal":1}`)},
		},
		sourceRows: [][]any{
			{1, &citedNumber, &uuid.Nil, &uuid.Nil, nil, "fragment", "标题快照", "摘录", []byte(`{"status":"unavailable"}`), 1, false, nil},
		},
		counts: []any{1, 1, int64(2)},
	}
	service := &Service{}
	events, _, err := service.loadEventBatch(context.Background(), fake, runID, 0)
	if err != nil {
		t.Fatal(err)
	}
	citation := events[1]
	if citation.Type != "answer.citation" {
		t.Fatalf("unexpected event type %q", citation.Type)
	}
	if citation.Payload["citationNumber"] != 1 || citation.Payload["token"] != "[[C1]]" {
		t.Fatalf("citation conversion lost values: %+v", citation.Payload)
	}
	if _, hasSource := citation.Payload["source"]; !hasSource {
		t.Fatal("citation payload must carry the source DTO")
	}
	if fake.sourceQueryCount() != 1 {
		t.Fatalf("citation batch must load sources exactly once, got %d", fake.sourceQueryCount())
	}
}

// T31: a full batch of a terminal run must not close the stream; the terminal
// event only follows once the whole tail has been read.
func TestLoadEventBatchKeepsStreamOpenWhileTailSpansBatches(t *testing.T) {
	runID := uuid.New()
	fake := &fakeQuerier{
		runValues: fakeRunValues("succeeded", false),
		eventRows: deltaEventRows(sseEventBatchSize, 1),
		counts:    []any{0, 0, int64(sseEventBatchSize)},
	}
	service := &Service{}
	events, terminal, err := service.loadEventBatch(context.Background(), fake, runID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if terminal {
		t.Fatal("a full batch must not report terminal; unread tail events would be lost")
	}
	if len(events) != sseEventBatchSize {
		t.Fatalf("batch size %d, want %d", len(events), sseEventBatchSize)
	}
	for _, event := range events {
		if isTerminalType(event.Type) {
			t.Fatal("no terminal event may be synthesized while the tail is unfinished")
		}
	}
}

// T31: after the last stored events, the synthesized terminal follows with the
// next sequence and closes the stream.
func TestLoadEventBatchAppendsTerminalAfterWholeTail(t *testing.T) {
	runID := uuid.New()
	fake := &fakeQuerier{
		runValues: fakeRunValues("succeeded", false),
		eventRows: deltaEventRows(2, 129),
		counts:    []any{0, 0, int64(130)},
	}
	service := &Service{}
	events, terminal, err := service.loadEventBatch(context.Background(), fake, runID, 128)
	if err != nil {
		t.Fatal(err)
	}
	if !terminal {
		t.Fatal("the final batch of a terminal run must close the stream")
	}
	last := events[len(events)-1]
	if last.Type != "run.completed" {
		t.Fatalf("terminal type = %q, want run.completed", last.Type)
	}
	if last.Sequence != 131 {
		t.Fatalf("terminal sequence = %d, want the next sequence after the tail", last.Sequence)
	}
	run, isRun := last.Payload["run"].(AssistantRunDTO)
	if !isRun || run.Status != "succeeded" {
		t.Fatalf("terminal payload must carry the run DTO, got %+v", last.Payload)
	}
}

// L1: when the stored tail ends with a terminal-type event exactly at the
// batch boundary (it is the last event of a full batch), the next loop
// iteration reads an empty batch and must close the stream without
// synthesizing a second terminal event.
func TestLoadEventBatchDoesNotDuplicateTerminalAcrossBatchBoundary(t *testing.T) {
	runID := uuid.New()
	full := &fakeQuerier{
		runValues: fakeRunValues("succeeded", false),
		eventRows: append(deltaEventRows(sseEventBatchSize-1, 1),
			[]any{int64(sseEventBatchSize), "run.completed", []byte(`{}`)}),
		counts: []any{0, 0, int64(sseEventBatchSize)},
	}
	service := &Service{}
	events, terminal, err := service.loadEventBatch(context.Background(), full, runID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if terminal {
		t.Fatal("a full batch must not report terminal; unread tail events would be lost")
	}
	if len(events) != sseEventBatchSize || !isTerminalType(events[sseEventBatchSize-1].Type) {
		t.Fatalf("precondition: full batch ending with a stored terminal, got %d events", len(events))
	}

	empty := &fakeQuerier{
		runValues:       fakeRunValues("succeeded", false),
		counts:          []any{0, 0, int64(sseEventBatchSize)},
		latestEventType: "run.completed",
	}
	events, terminal, err = service.loadEventBatch(context.Background(), empty, runID, sseEventBatchSize)
	if err != nil {
		t.Fatal(err)
	}
	if !terminal {
		t.Fatal("the empty follow-up batch of a terminal run must close the stream")
	}
	if len(events) != 0 {
		t.Fatalf("a stored terminal event must not be followed by a synthesized one, got %d extra events ending with %q",
			len(events), events[len(events)-1].Type)
	}
}

func TestLoadEventBatchReflectsRequestedStop(t *testing.T) {
	runID := uuid.New()
	fake := &fakeQuerier{
		runValues: fakeRunValues("running", true),
		eventRows: [][]any{
			{int64(1), "run.status", []byte(`{"phase":"answer"}`)},
		},
	}
	service := &Service{}
	events, _, err := service.loadEventBatch(context.Background(), fake, runID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if events[0].Payload["stopRequested"] != true || events[0].Payload["status"] != "running" {
		t.Fatalf("run.status conversion lost the stop flag: %+v", events[0].Payload)
	}
}

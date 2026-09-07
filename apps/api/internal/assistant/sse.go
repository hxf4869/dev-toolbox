package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const sseHeartbeatInterval = 15 * time.Second
const ssePollInterval = time.Second

// Every network write gets a fresh bounded window. The stream itself may stay
// open for a whole run, but a client or proxy that stops reading must release
// the connection instead of blocking the handler forever. A variable so the
// write-budget tests can shrink it; production keeps 15 seconds.
var sseWriteTimeout = 15 * time.Second

// sseEventBatchSize bounds how many stored events one read loads into memory.
// A terminal run closes the stream only after a batch that was not full, so
// the whole tail is always streamed before the terminal event.
const sseEventBatchSize = 128

type sseWriter struct {
	writer     io.Writer
	controller *http.ResponseController
	// deadlineSupport records whether the underlying ResponseWriter can
	// install write deadlines. Plain test writers cannot and degrade to
	// unbounded streaming; production connections always carry the per-write
	// budget below.
	deadlineSupport bool
}

func newSSEWriter(response http.ResponseWriter) (*sseWriter, error) {
	controller := http.NewResponseController(response)
	// The stream may legitimately stay idle for a whole model/prepare phase,
	// so it must not inherit the server-wide write deadline: clear it for the
	// whole life of this response. Idle stretches are then bounded by the
	// run/prepare budgets, request cancellation and heartbeats, while every
	// actual write arms a fresh bounded window first (see armWriteBudget).
	// A real deadline error means the connection is already unusable and must
	// end the stream; only a writer without deadline support degrades.
	err := controller.SetWriteDeadline(time.Time{})
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		return nil, err
	}
	return &sseWriter{
		writer:          response,
		controller:      controller,
		deadlineSupport: err == nil,
	}, nil
}

// armWriteBudget gives the upcoming write a fresh bounded window. Called
// before every write: a write that blocks on a stalled client keeps the
// absolute deadline it was armed with, so the connection is released within
// the budget instead of blocking the handler forever.
func (stream *sseWriter) armWriteBudget() error {
	if !stream.deadlineSupport {
		return nil
	}
	return stream.controller.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
}

// clearWriteBudget removes the write deadline again after a successful
// write+flush, so idle waiting between events is never counted against the
// budget. A failure here means the connection is unusable; the caller ends
// the stream instead of writing again on it.
func (stream *sseWriter) clearWriteBudget() error {
	if !stream.deadlineSupport {
		return nil
	}
	return stream.controller.SetWriteDeadline(time.Time{})
}

func (stream *sseWriter) write(event string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if err := stream.armWriteBudget(); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(stream.writer, "event: %s\ndata: %s\n\n", event, encoded); err != nil {
		return err
	}
	if err := stream.controller.Flush(); err != nil {
		return err
	}
	return stream.clearWriteBudget()
}

func (stream *sseWriter) writeID(event, id string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if err := stream.armWriteBudget(); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(stream.writer, "id: %s\nevent: %s\ndata: %s\n\n", id, event, encoded); err != nil {
		return err
	}
	if err := stream.controller.Flush(); err != nil {
		return err
	}
	return stream.clearWriteBudget()
}

func (stream *sseWriter) writeComment(comment string) error {
	if err := stream.armWriteBudget(); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(stream.writer, ": %s\n\n", comment); err != nil {
		return err
	}
	if err := stream.controller.Flush(); err != nil {
		return err
	}
	return stream.clearWriteBudget()
}

func (stream *sseWriter) writeRaw(raw string) error {
	if err := stream.armWriteBudget(); err != nil {
		return err
	}
	if _, err := fmt.Fprint(stream.writer, raw); err != nil {
		return err
	}
	if err := stream.controller.Flush(); err != nil {
		return err
	}
	return stream.clearWriteBudget()
}

// runEventsStream implements the persistent run event stream (docs/16 §15.1):
// snapshot first, then only newer events, 15s comment heartbeats, terminal
// then close.
func (service *Service) runEventsStream(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return
	}
	after, err := parseAfterParameter(request, service.database, run.ID)
	if err != nil {
		writeValidationError(response, request)
		return
	}
	stream, streamErr := newSSEWriter(response)
	if streamErr != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store, no-transform")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	if err := stream.writeRaw("retry: 3000\n\n"); err != nil {
		return
	}
	ctx := request.Context()
	// Snapshot in one consistent read; after this only newer events stream.
	snapshotData, err := service.buildSnapshot(ctx, run.ID)
	if err != nil || snapshotData == nil {
		return
	}
	lastSequence := snapshotData.LastSequence
	if err := stream.write("snapshot", snapshotData.Payload); err != nil {
		return
	}
	if snapshotData.Terminal {
		return
	}
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	poll := time.NewTicker(ssePollInterval)
	defer poll.Stop()
	channel := service.broadcast.subscribe(run.ID)
	defer service.broadcast.unsubscribe(run.ID, channel)
	_ = after
	for {
		events, terminal, err := service.readEventsAfter(ctx, run.ID, lastSequence)
		if err != nil {
			return
		}
		for _, event := range events {
			if err := stream.writeID(event.Type, strconv.FormatInt(event.Sequence, 10), event.Payload); err != nil {
				return
			}
			lastSequence = event.Sequence
		}
		if terminal {
			return
		}
		if len(events) == sseEventBatchSize {
			// The batch was full, keep draining a long tail immediately
			// instead of waiting for the next broadcast or fallback tick.
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			if err := stream.writeComment("heartbeat"); err != nil {
				return
			}
		case <-channel:
			// Broadcast wake-up: new events were committed for this run.
		case <-poll.C:
			// Fallback tick: covers notifications lost across processes.
		}
	}
}

type snapshotData struct {
	LastSequence int64
	Terminal     bool
	Payload      any
}

func parseAfterParameter(request *http.Request, querier rowQuerier, runID uuid.UUID) (*int64, error) {
	header := request.Header.Get("Last-Event-ID")
	query := request.URL.Query().Get("after")
	var headerValue, queryValue *int64
	if header != "" {
		value, err := parseNonNegativeInt64(header)
		if err != nil {
			return nil, err
		}
		headerValue = &value
	}
	if query != "" {
		value, err := parseNonNegativeInt64(query)
		if err != nil {
			return nil, err
		}
		queryValue = &value
	}
	if headerValue != nil && queryValue != nil && *headerValue != *queryValue {
		return nil, errors.New("after mismatch")
	}
	value := headerValue
	if value == nil {
		value = queryValue
	}
	if value != nil {
		var maximum int64
		if err := querier.QueryRow(request.Context(), `
			SELECT COALESCE(max(sequence), 0) FROM assistant_run_events WHERE run_id = $1
		`, runID).Scan(&maximum); err != nil {
			return nil, err
		}
		if *value > maximum {
			return nil, errors.New("after exceeds current sequence")
		}
	}
	return value, nil
}

func parseNonNegativeInt64(raw string) (int64, error) {
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0, errors.New("invalid after")
	}
	return value, nil
}

// buildSnapshot reads run, assistant message and max event sequence in one
// repeatable-read transaction.
func (service *Service) buildSnapshot(ctx context.Context, runID uuid.UUID) (*snapshotData, error) {
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	run, err := scanRunRow(tx.QueryRow(ctx, `SELECT `+runColumns+` FROM assistant_runs WHERE id = $1`, runID))
	if err != nil {
		return nil, err
	}
	var lastSequence int64
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(max(sequence), 0) FROM assistant_run_events WHERE run_id = $1`, runID).Scan(&lastSequence); err != nil {
		return nil, err
	}
	message, err := scanMessageRow(tx.QueryRow(ctx,
		`SELECT `+messageColumns+` FROM assistant_messages WHERE id = $1`, run.OutputMessageID))
	if err != nil {
		return nil, err
	}
	runDTO, err := service.runDTO(ctx, tx, run)
	if err != nil {
		return nil, err
	}
	messageDTO, err := service.messageDTO(ctx, tx, message)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"lastSequence":     lastSequence,
		"run":              runDTO,
		"assistantMessage": messageDTO,
	}
	return &snapshotData{LastSequence: lastSequence, Terminal: run.isTerminal(), Payload: payload}, tx.Commit(ctx)
}

type readEvent struct {
	Sequence int64
	Type     string
	Payload  map[string]any
}

// readEventsAfter streams stored events beyond a sequence, then synthesizes
// the terminal event exactly once after all of them (docs/16 §15.1: terminal
// then close). Terminal run states are emitted as
// run.completed/run.stopped/run.failed.
func (service *Service) readEventsAfter(ctx context.Context, runID uuid.UUID, after int64) ([]readEvent, bool, error) {
	progressed, err := hasRunProgress(ctx, service.database, runID, after)
	if err != nil || !progressed {
		return nil, false, err
	}
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	events, terminal, err := service.loadEventBatch(ctx, tx, runID, after)
	if err != nil {
		return nil, false, err
	}
	return events, terminal, tx.Commit(ctx)
}

// hasRunProgress is the cheap wake-up check for one broadcast or fallback
// tick: a single non-transactional query. Idle streams stop here and never
// open a repeatable-read transaction or load run sources.
func hasRunProgress(ctx context.Context, querier rowQuerier, runID uuid.UUID, after int64) (bool, error) {
	var sequence int64
	var status string
	err := querier.QueryRow(ctx, `
		SELECT COALESCE((SELECT max(sequence) FROM assistant_run_events WHERE run_id = $1), 0),
		       status
		FROM assistant_runs WHERE id = $1
	`, runID).Scan(&sequence, &status)
	if err != nil {
		return false, err
	}
	if sequence > after {
		return true, nil
	}
	return status == "succeeded" || status == "failed" || status == "stopped", nil
}

// loadEventBatch reads one bounded batch of stored events in the caller's
// consistent read and converts them to the public shape. Run sources are only
// loaded when the batch actually contains a citation event. A terminal run is
// only reported once the batch was not full, so a tail spanning several
// batches is never truncated by an early terminal.
func (service *Service) loadEventBatch(ctx context.Context, querier rowQuerier, runID uuid.UUID, after int64) ([]readEvent, bool, error) {
	run, err := scanRunRow(querier.QueryRow(ctx, `SELECT `+runColumns+` FROM assistant_runs WHERE id = $1`, runID))
	if err != nil {
		return nil, false, err
	}
	rows, err := querier.Query(ctx, `
		SELECT sequence, event_type, payload FROM assistant_run_events
		WHERE run_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3
	`, runID, after, sseEventBatchSize)
	if err != nil {
		return nil, false, err
	}
	events := make([]readEvent, 0, sseEventBatchSize)
	citationIndexes := make([]int, 0)
	for rows.Next() {
		var event readEvent
		var rawType string
		var payload []byte
		if err := rows.Scan(&event.Sequence, &rawType, &payload); err != nil {
			rows.Close()
			return nil, false, err
		}
		if err := json.Unmarshal(payload, &event.Payload); err != nil {
			rows.Close()
			return nil, false, err
		}
		event.Type = rawType
		event.Payload["sequence"] = event.Sequence
		switch rawType {
		case "run.status":
			phase := event.Payload["phase"]
			event.Payload = map[string]any{
				"sequence": event.Sequence, "status": "running", "phase": phase,
				"stopRequested": run.StopRequestedAt != nil,
			}
		case "answer.citation":
			citationIndexes = append(citationIndexes, len(events))
		}
		events = append(events, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(citationIndexes) > 0 {
		if err := service.applyCitations(ctx, querier, run, events, citationIndexes); err != nil {
			return nil, false, err
		}
	}
	if run.isTerminal() && len(events) < sseEventBatchSize {
		return service.appendTerminalEvent(ctx, querier, run, events, after)
	}
	return events, false, nil
}

// applyCitations converts stored citation events with the run's source
// snapshots; it runs only for batches that contain at least one citation.
func (service *Service) applyCitations(ctx context.Context, querier rowQuerier, run runRow, events []readEvent, citationIndexes []int) error {
	sources, err := service.loadRunSources(ctx, querier, run.ID)
	if err != nil {
		return err
	}
	sourcesByOrdinal := make(map[int]sourceRow, len(sources))
	for _, source := range sources {
		sourcesByOrdinal[source.Ordinal] = source
	}
	for _, index := range citationIndexes {
		event := &events[index]
		ordinalValue, ok := event.Payload["sourceOrdinal"].(float64)
		if !ok {
			return errors.New("invalid stored citation event")
		}
		source, ok := sourcesByOrdinal[int(ordinalValue)]
		if !ok || source.CitedNumber == nil {
			return errors.New("citation source missing")
		}
		citationNumber := *source.CitedNumber
		event.Payload = map[string]any{
			"sequence": event.Sequence, "citationNumber": citationNumber,
			"token":  "[[C" + itoa(citationNumber) + "]]",
			"source": service.sourceDTO(run, source, citationNumber),
		}
	}
	return nil
}

// appendTerminalEvent appends the synthesized terminal event after every
// stored event of the batch. A stored terminal-type event closes the stream
// without a synthesized one — including when such an event was the last event
// of a previous full batch, in which case this batch is empty and the stored
// event at the after position is checked before synthesizing.
func (service *Service) appendTerminalEvent(ctx context.Context, querier rowQuerier, run runRow, events []readEvent, after int64) ([]readEvent, bool, error) {
	if last := len(events); last > 0 && isTerminalType(events[last-1].Type) {
		return events, true, nil
	}
	if len(events) == 0 && after > 0 {
		var latestType string
		if err := querier.QueryRow(ctx, `
			SELECT event_type FROM assistant_run_events WHERE run_id = $1 AND sequence = $2
		`, run.ID, after).Scan(&latestType); err == nil && isTerminalType(latestType) {
			return events, true, nil
		}
	}
	next := after
	if len(events) > 0 {
		next = events[len(events)-1].Sequence
	}
	dto, err := service.runDTO(ctx, querier, run)
	if err != nil {
		return nil, false, err
	}
	eventType := "run.failed"
	switch run.Status {
	case "succeeded":
		eventType = "run.completed"
	case "stopped":
		eventType = "run.stopped"
	}
	events = append(events, readEvent{
		Sequence: next + 1, Type: eventType,
		Payload: map[string]any{"sequence": next + 1, "run": dto},
	})
	return events, true, nil
}

func isTerminalType(value string) bool {
	return value == "run.completed" || value == "run.stopped" || value == "run.failed"
}

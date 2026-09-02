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
const ssePollInterval = 250 * time.Millisecond

type sseWriter struct {
	writer  io.Writer
	flusher http.Flusher
}

func (stream *sseWriter) write(event string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(stream.writer, "event: %s\ndata: %s\n\n", event, encoded); err != nil {
		return err
	}
	stream.flusher.Flush()
	return nil
}

func (stream *sseWriter) writeID(event, id string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(stream.writer, "id: %s\nevent: %s\ndata: %s\n\n", id, event, encoded); err != nil {
		return err
	}
	stream.flusher.Flush()
	return nil
}

func (stream *sseWriter) writeComment(comment string) error {
	if _, err := fmt.Fprintf(stream.writer, ": %s\n\n", comment); err != nil {
		return err
	}
	stream.flusher.Flush()
	return nil
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
	flusher, supportsFlush := response.(http.Flusher)
	if !supportsFlush {
		writeAssistantInternalFailure(response, request)
		return
	}
	// A long SSE stream must not inherit the server write deadline; clearing it
	// per connection keeps ordinary API timeouts intact (docs/16 §15.2).
	controller := http.NewResponseController(response)
	_ = controller.SetWriteDeadline(time.Time{})
	response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store, no-transform")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	fmt.Fprint(response, "retry: 3000\n\n")
	flusher.Flush()

	stream := &sseWriter{writer: response, flusher: flusher}
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
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			if err := stream.writeComment("heartbeat"); err != nil {
				return
			}
		case <-channel:
		case <-poll.C:
		}
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

// readEventsAfter loads and converts events beyond a sequence. Terminal run
// states are emitted exactly once as run.completed/run.stopped/run.failed.
func (service *Service) readEventsAfter(ctx context.Context, runID uuid.UUID, after int64) ([]readEvent, bool, error) {
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	run, err := scanRunRow(tx.QueryRow(ctx, `SELECT `+runColumns+` FROM assistant_runs WHERE id = $1`, runID))
	if err != nil {
		return nil, false, err
	}
	sources, err := service.loadRunSources(ctx, tx, runID)
	if err != nil {
		return nil, false, err
	}
	sourcesByOrdinal := make(map[int]sourceRow, len(sources))
	for _, source := range sources {
		sourcesByOrdinal[source.Ordinal] = source
	}
	rows, err := tx.Query(ctx, `
		SELECT sequence, event_type, payload FROM assistant_run_events
		WHERE run_id = $1 AND sequence > $2 ORDER BY sequence
	`, runID, after)
	if err != nil {
		return nil, false, err
	}
	events := make([]readEvent, 0)
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
			ordinalValue, ok := event.Payload["sourceOrdinal"].(float64)
			if !ok {
				rows.Close()
				return nil, false, errors.New("invalid stored citation event")
			}
			source, ok := sourcesByOrdinal[int(ordinalValue)]
			if !ok || source.CitedNumber == nil {
				rows.Close()
				return nil, false, errors.New("citation source missing")
			}
			citationNumber := *source.CitedNumber
			event.Payload = map[string]any{
				"sequence": event.Sequence, "citationNumber": citationNumber,
				"token":  "[[C" + itoa(citationNumber) + "]]",
				"source": service.sourceDTO(run, source, citationNumber),
			}
		}
		events = append(events, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	terminal := false
	var terminalRunDTO *AssistantRunDTO
	if run.isTerminal() {
		dto, err := service.runDTO(ctx, tx, run)
		if err != nil {
			return nil, false, err
		}
		terminalRunDTO = &dto
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	// Synthesize the terminal event after all stored events.
	if run.isTerminal() {
		if last := len(events); last > 0 && isTerminalType(events[last-1].Type) {
			terminal = true
		} else {
			next := after
			if len(events) > 0 {
				next = events[len(events)-1].Sequence
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
				Payload: map[string]any{"sequence": next + 1, "run": *terminalRunDTO},
			})
			terminal = true
		}
	}
	return events, terminal, nil
}

func isTerminalType(value string) bool {
	return value == "run.completed" || value == "run.stopped" || value == "run.failed"
}

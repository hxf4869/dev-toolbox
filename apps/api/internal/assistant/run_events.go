package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type internalEvent struct {
	EventID uuid.UUID       `json:"eventId"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type eventsInput struct {
	WorkerID     string          `json:"workerId"`
	LeaseVersion int             `json:"leaseVersion"`
	Events       []internalEvent `json:"events"`
}

type eventsResult struct {
	StopRequested bool  `json:"stopRequested"`
	LastSequence  int64 `json:"lastSequence"`
}

func (service *Service) appendRunEvents(response http.ResponseWriter, request *http.Request) {
	run, input, ok := service.decodeRunLeaseForEvents(response, request)
	if !ok {
		return
	}
	if len(input.Events) < 1 || len(input.Events) > 50 {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
		return
	}
	for _, event := range input.Events {
		if event.EventID == uuid.Nil || !validRunEventType(event.Type) || !validEventPayload(event.Type, event.Payload) {
			httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
			return
		}
	}
	ctx := request.Context()
	now := service.now().UTC()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer tx.Rollback(ctx)
	var storedRun runRow
	if err := tx.QueryRow(ctx, `SELECT `+runColumns+` FROM assistant_runs WHERE id = $1 FOR UPDATE`, run.ID).
		Scan(runScanTargets(&storedRun)...); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if storedRun.Status != "running" || storedRun.LeaseOwner == nil || *storedRun.LeaseOwner != input.WorkerID ||
		storedRun.LeaseVersion == nil || *storedRun.LeaseVersion != input.LeaseVersion ||
		storedRun.LeaseExpiresAt == nil || storedRun.LeaseExpiresAt.Before(now) {
		writeAssistantLeaseConflict(response, request)
		return
	}
	message, err := scanMessageRow(tx.QueryRow(ctx,
		`SELECT `+messageColumns+` FROM assistant_messages WHERE id = $1 FOR UPDATE`, storedRun.OutputMessageID))
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	originalReasoning := ""
	if message.ReasoningContent != nil {
		originalReasoning = *message.ReasoningContent
	}
	var maxSequence int64
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(max(sequence), 0) FROM assistant_run_events WHERE run_id = $1`, run.ID).Scan(&maxSequence); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	// Deduplicate by event ID inside the same transaction; committed repeats
	// are exact no-ops (docs/16 §14.1).
	knownIDs := make(map[uuid.UUID]string)
	rows, err := tx.Query(ctx,
		`SELECT event_id, event_type FROM assistant_run_events WHERE run_id = $1 AND event_id = ANY($2)`,
		run.ID, eventIDs(input.Events))
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	for rows.Next() {
		var id uuid.UUID
		var eventType string
		if err := rows.Scan(&id, &eventType); err != nil {
			rows.Close()
			writeAssistantInternalFailure(response, request)
			return
		}
		knownIDs[id] = eventType
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}

	content := message.Content
	boundaryState := trailingBracketCount(content)
	nextSequence := maxSequence
	citationNumbers := make(map[int]int) // sourceOrdinal -> citationNumber
	stopRequested := storedRun.StopRequestedAt != nil
	for _, event := range input.Events {
		if knownType, duplicate := knownIDs[event.EventID]; duplicate {
			if knownType != event.Type {
				writeAssistantEventConflict(response, request)
				return
			}
			continue
		}
		nextSequence++
		payload := map[string]any{}
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			writeAssistantEventConflict(response, request)
			return
		}
		switch event.Type {
		case "answer.delta":
			delta, _ := payload["delta"].(string)
			combined, boundaryErr := citationBoundaryScanWithState(content, boundaryState, delta)
			if boundaryErr != nil {
				writeAssistantEventConflict(response, request)
				return
			}
			content = combined
			boundaryState = trailingBracketCount(content)
		case "answer.citation":
			ordinal := 0
			if value, ok := payload["sourceOrdinal"].(float64); ok {
				ordinal = int(value)
			}
			if ordinal < 1 || ordinal > MaximumRunSources {
				writeAssistantEventConflict(response, request)
				return
			}
			citationNumber, err := service.assignCitationNumber(ctx, tx, storedRun, ordinal, citationNumbers)
			if err != nil {
				writeAssistantEventConflict(response, request)
				return
			}
			citationNumbers[ordinal] = citationNumber
			content += "[[C" + itoa(citationNumber) + "]]"
			boundaryState = 0
		case "reasoning.delta":
			delta, _ := payload["delta"].(string)
			originalReasoning += delta
			if len(originalReasoning) > MaximumAssistantMessageBytes {
				writeAssistantEventConflict(response, request)
				return
			}
		case "run.status":
			if phase, ok := payload["phase"].(string); ok {
				if !validRunPhase(phase) {
					writeAssistantEventConflict(response, request)
					return
				}
				if _, err := tx.Exec(ctx,
					`UPDATE assistant_runs SET phase = $2 WHERE id = $1`, run.ID, phase); err != nil {
					writeAssistantInternalFailure(response, request)
					return
				}
			}
		case "sources.ready":
			knowledgeState, _ := payload["knowledgeState"].(string)
			evidenceState, _ := payload["evidenceState"].(string)
			rewriteFallback, _ := payload["rewriteFallback"].(bool)
			if _, err := tx.Exec(ctx, `
				UPDATE assistant_runs SET knowledge_state = $2, evidence_state = $3, rewrite_fallback = $4
				WHERE id = $1
			`, run.ID, knowledgeState, evidenceState, rewriteFallback); err != nil {
				writeAssistantInternalFailure(response, request)
				return
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO assistant_run_events (run_id, sequence, event_id, event_type, payload, created_at)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, run.ID, nextSequence, event.EventID, event.Type, []byte(event.Payload), now); err != nil {
			var databaseError *pgconn.PgError
			if errors.As(err, &databaseError) && databaseError.Code == "23505" {
				writeAssistantEventConflict(response, request)
				return
			}
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if content != message.Content {
		if _, err := tx.Exec(ctx,
			`UPDATE assistant_messages SET content = $2 WHERE id = $1`, message.ID, content); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if originalReasoning != "" && (message.ReasoningContent == nil || *message.ReasoningContent != originalReasoning) {
		if _, err := tx.Exec(ctx,
			`UPDATE assistant_messages SET reasoning_content = $2 WHERE id = $1`, message.ID, originalReasoning); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	service.broadcast.notify(run.ID)
	httpapi.WriteJSON(response, http.StatusOK, eventsResult{StopRequested: stopRequested, LastSequence: nextSequence})
}

func (service *Service) decodeRunLeaseForEvents(response http.ResponseWriter, request *http.Request) (runRow, eventsInput, bool) {
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return runRow{}, eventsInput{}, false
	}
	var input eventsInput
	if httpapi.DecodeJSON(response, request, 128*1024, &input) != nil ||
		!validAssistantWorkerID(input.WorkerID) || input.LeaseVersion < 1 {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
		return runRow{}, input, false
	}
	return run, input, true
}

func eventIDs(events []internalEvent) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(events))
	for _, event := range events {
		ids = append(ids, event.EventID)
	}
	return ids
}

func validRunEventType(value string) bool {
	switch value {
	case "run.status", "sources.ready", "reasoning.delta", "reasoning.completed",
		"answer.delta", "answer.citation", "usage.updated":
		return true
	default:
		return false
	}
}

func validRunPhase(value string) bool {
	switch value {
	case "rewrite", "embedding", "retrieval", "answer", "finalizing":
		return true
	default:
		return false
	}
}

func validEventPayload(eventType string, payload json.RawMessage) bool {
	decoded := map[string]any{}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return false
	}
	switch eventType {
	case "reasoning.delta", "answer.delta":
		delta, ok := decoded["delta"].(string)
		return ok && delta != "" && len(delta) <= 16*1024
	case "reasoning.completed":
		duration, ok := decoded["durationMs"].(float64)
		return ok && duration >= 0 && float64(int64(duration)) == duration
	case "answer.citation":
		ordinal, ok := decoded["sourceOrdinal"].(float64)
		return ok && ordinal >= 1 && ordinal <= MaximumRunSources && float64(int(ordinal)) == ordinal
	case "run.status":
		phase, ok := decoded["phase"].(string)
		return ok && validRunPhase(phase)
	case "sources.ready":
		knowledgeState, state := decoded["knowledgeState"].(string)
		evidenceState, evidence := decoded["evidenceState"].(string)
		count, countOK := decoded["providedSourceCount"].(float64)
		_, fallbackOK := decoded["rewriteFallback"].(bool)
		return state && (knowledgeState == "ready" || knowledgeState == "unavailable") &&
			evidence && (evidenceState == "matched" || evidenceState == "not_found" || evidenceState == "unavailable") &&
			countOK && count >= 0 && count <= MaximumRunSources && float64(int(count)) == count && fallbackOK
	case "usage.updated":
		usage, ok := decoded["usage"].(map[string]any)
		if !ok {
			return false
		}
		for _, key := range []string{"rewriteInputTokens", "rewriteOutputTokens", "answerInputTokens", "answerOutputTokens"} {
			value, present := usage[key]
			if !present {
				return false
			}
			if value != nil {
				number, ok := value.(float64)
				if !ok || number < 0 || float64(int64(number)) != number {
					return false
				}
			}
		}
		return true
	}
	return false
}

// citationBoundaryScanWithState applies the boundary scan with a precomputed
// trailing state from the aggregated content.
func citationBoundaryScanWithState(content string, trailing int, delta string) (string, error) {
	combined := content + delta
	state := trailing
	for index := len(content); index < len(combined); index++ {
		character := combined[index]
		if character == '[' {
			if state < 2 {
				state++
			}
			continue
		}
		if state == 2 && (character == 'S' || character == 'C') {
			return "", errors.New("reserved citation prefix in answer delta")
		}
		state = 0
	}
	return combined, nil
}

func trailingBracketCount(content string) int {
	count := 0
	for index := len(content) - 1; index >= 0 && content[index] == '[' && count < 2; index-- {
		count++
	}
	return count
}

// assignCitationNumber assigns or reuses the canonical citation number for a
// source ordinal within the run (docs/16 §8.11).
func (service *Service) assignCitationNumber(ctx context.Context, tx pgx.Tx, run runRow, ordinal int, known map[int]int) (int, error) {
	if number, ok := known[ordinal]; ok {
		return number, nil
	}
	var existing *int
	if err := tx.QueryRow(ctx, `
		SELECT cited_number FROM assistant_run_sources WHERE run_id = $1 AND ordinal = $2
	`, run.ID, ordinal).Scan(&existing); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, errors.New("citation source does not belong to run")
		}
		return 0, err
	}
	if existing != nil {
		return *existing, nil
	}
	var maxCited int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(max(cited_number), 0) FROM assistant_run_sources
		WHERE run_id = $1 AND cited_number IS NOT NULL
	`, run.ID).Scan(&maxCited); err != nil {
		return 0, err
	}
	if maxCited >= MaximumRunSources {
		return 0, errors.New("citation limit exceeded")
	}
	next := maxCited + 1
	tag, err := tx.Exec(ctx, `
		UPDATE assistant_run_sources SET cited_number = $3 WHERE run_id = $1 AND ordinal = $2 AND cited_number IS NULL
	`, run.ID, ordinal, next)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() != 1 {
		return 0, errors.New("citation source assignment lost")
	}
	return next, nil
}

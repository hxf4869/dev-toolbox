package assistant

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

// loadRunStartResponse assembles the 202 payload for create/retry/replay.
func (service *Service) loadRunStartResponse(ctx context.Context, querier rowQuerier, run runRow, idempotentReplay bool) (*RunStartResponseDTO, error) {
	conversationRow, err := scanConversationRow(querier.QueryRow(ctx,
		`SELECT `+conversationColumns+` FROM assistant_conversations WHERE id = $1`, run.ConversationID))
	if err != nil {
		return nil, err
	}
	conversation, err := service.loadConversationDTO(ctx, querier, conversationRow)
	if err != nil {
		return nil, err
	}
	userMessage, err := service.loadMessage(ctx, querier, run.InputMessageID)
	if err != nil {
		return nil, err
	}
	assistantMessage, err := service.loadMessage(ctx, querier, run.OutputMessageID)
	if err != nil {
		return nil, err
	}
	userDTO, err := service.messageDTO(ctx, querier, userMessage)
	if err != nil {
		return nil, err
	}
	assistantDTO, err := service.messageDTO(ctx, querier, assistantMessage)
	if err != nil {
		return nil, err
	}
	runDTO, err := service.runDTO(ctx, querier, run)
	if err != nil {
		return nil, err
	}
	return &RunStartResponseDTO{
		Conversation: conversation, UserMessage: userDTO, AssistantMessage: assistantDTO,
		Run: runDTO, IdempotentReplay: idempotentReplay,
	}, nil
}

func (service *Service) getRun(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return
	}
	dto, err := service.runDTO(request.Context(), service.database, run)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, dto)
}

func (service *Service) loadRunOr404(response http.ResponseWriter, request *http.Request) (runRow, bool) {
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAssistantNotFound(response, request)
		return runRow{}, false
	}
	run, err := service.loadRun(request.Context(), service.database, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAssistantNotFound(response, request)
		return runRow{}, false
	}
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return runRow{}, false
	}
	return run, true
}

func (service *Service) stopRun(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	runID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	ctx := request.Context()
	now := service.now().UTC()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer tx.Rollback(ctx)
	run, err := scanRunRow(tx.QueryRow(ctx,
		`SELECT `+runColumns+` FROM assistant_runs WHERE id = $1 FOR UPDATE`, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		writeAssistantNotFound(response, request)
		return
	}
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if run.isTerminal() && run.Status != "stopped" {
		writeAssistantRunNotStoppable(response, request)
		return
	}
	if run.Status == "queued" {
		// Stop is idempotent; a queued run becomes stopped immediately.
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_runs SET status = 'stopped', finished_at = $2, phase = NULL,
			       lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_detail = NULL
			WHERE id = $1
		`, run.ID, now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_messages SET status = 'stopped', completed_at = $2
			WHERE id = $1 AND status = 'streaming'
		`, run.OutputMessageID, now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	} else if run.Status == "running" {
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_runs SET stop_requested_at = COALESCE(stop_requested_at, $2) WHERE id = $1
		`, run.ID, now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	service.broadcast.notify(run.ID)
	updated, err := service.loadRun(ctx, service.database, run.ID)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	dto, err := service.runDTO(ctx, service.database, updated)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, dto)
}

func (service *Service) retryRun(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return
	}
	var input retryRunInput
	if httpapi.DecodeJSON(response, request, 8*1024, &input) != nil || !validReasoningValue(input.Reasoning) {
		writeValidationError(response, request)
		return
	}
	if run.Status != "failed" && run.Status != "stopped" {
		writeAssistantRunNotRetryable(response, request)
		return
	}
	// Retry is only allowed for the conversation's last stopped/failed answer.
	var active bool
	if err := service.database.QueryRow(request.Context(), `
		SELECT EXISTS (SELECT 1 FROM assistant_runs WHERE conversation_id = $1 AND status IN ('queued', 'running'))
	`, run.ConversationID).Scan(&active); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if active {
		writeAssistantRunAlreadyActive(response, request)
		return
	}
	userMessage, err := service.loadMessage(request.Context(), service.database, run.InputMessageID)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	snapshot := requestSnapshot{
		RequestKind:    "retry",
		ConversationID: &run.ConversationID,
		Content:        userMessage.Content,
		ModelID:        input.ModelID,
		Reasoning:      input.Reasoning,
		RetryOfRunID:   &run.ID,
	}
	if service.resolveIdempotent(response, request, input.ClientRequestID, snapshot) {
		return
	}
	retry := retryContext{
		runID: run.ID, conversationID: run.ConversationID,
		inputMessageID: run.InputMessageID, outputMessageID: run.OutputMessageID,
		originalContent: userMessage.Content, queuedAt: service.now().UTC(),
	}
	result, conflict := service.insertRun(request, input.ClientRequestID, snapshot, input.ModelID, input.Reasoning, &retry)
	if conflict != nil {
		if errors.Is(conflict, errIdempotencyRace) {
			if service.resolveIdempotent(response, request, input.ClientRequestID, snapshot) {
				return
			}
			writeAssistantIdempotencyConflict(response, request)
			return
		}
		if runConflict, ok := conflict.(*runConflictError); ok {
			writeRunCreationError(response, request, runConflict)
			return
		}
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusAccepted, result)
}

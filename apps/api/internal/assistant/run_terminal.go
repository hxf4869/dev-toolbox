package assistant

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type completeRunInput struct {
	WorkerID     string          `json:"workerId"`
	LeaseVersion int             `json:"leaseVersion"`
	Usage        runUsageInput   `json:"usage"`
	Timings      runTimingsInput `json:"timings"`
}

type runUsageInput struct {
	AnswerContextTokens *int64 `json:"answerContextTokens"`
	RewriteInputTokens  *int64 `json:"rewriteInputTokens"`
	RewriteOutputTokens *int64 `json:"rewriteOutputTokens"`
	AnswerInputTokens   *int64 `json:"answerInputTokens"`
	AnswerOutputTokens  *int64 `json:"answerOutputTokens"`
}

type runTimingsInput struct {
	RewriteMS   *int64 `json:"rewriteMs"`
	EmbeddingMS *int64 `json:"embeddingMs"`
	RetrievalMS *int64 `json:"retrievalMs"`
	ReasoningMS *int64 `json:"reasoningMs"`
	AnswerMS    *int64 `json:"answerMs"`
}

func (service *Service) completeRun(response http.ResponseWriter, request *http.Request) {
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return
	}
	var input completeRunInput
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil || !validAssistantWorkerID(input.WorkerID) ||
		input.LeaseVersion < 1 || negativeUsage(input.Usage) || negativeTimings(input.Timings) {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
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
	var storedRun runRow
	if err := tx.QueryRow(ctx, `SELECT `+runColumns+` FROM assistant_runs WHERE id = $1 FOR UPDATE`, run.ID).
		Scan(runScanTargets(&storedRun)...); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if !validRunLeaseState(storedRun, input.WorkerID, input.LeaseVersion, now) {
		writeAssistantLeaseConflict(response, request)
		return
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_runs SET status = 'succeeded', finished_at = $2, phase = NULL,
		       lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		       rewrite_input_tokens = $3, rewrite_output_tokens = $4,
		       answer_input_tokens = $5, answer_output_tokens = $6,
		       rewrite_ms = $7, embedding_ms = $8, retrieval_ms = $9, reasoning_ms = $10, answer_ms = $11,
		       answer_context_tokens = $12,
		       error_code = NULL, error_detail = NULL
		WHERE id = $1
	`, run.ID, now, input.Usage.RewriteInputTokens, input.Usage.RewriteOutputTokens,
		input.Usage.AnswerInputTokens, input.Usage.AnswerOutputTokens,
		input.Timings.RewriteMS, input.Timings.EmbeddingMS, input.Timings.RetrievalMS,
		input.Timings.ReasoningMS, input.Timings.AnswerMS, input.Usage.AnswerContextTokens); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_messages SET status = 'complete', completed_at = $2 WHERE id = $1
	`, storedRun.OutputMessageID, now); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	service.broadcast.notify(storedRun.ID)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"status": "succeeded"})
}

func negativeUsage(usage runUsageInput) bool {
	for _, value := range []*int64{usage.RewriteInputTokens, usage.RewriteOutputTokens,
		usage.AnswerInputTokens, usage.AnswerOutputTokens, usage.AnswerContextTokens} {
		if value != nil && *value < 0 {
			return true
		}
	}
	return false
}

func negativeTimings(timings runTimingsInput) bool {
	for _, value := range []*int64{timings.RewriteMS, timings.EmbeddingMS, timings.RetrievalMS,
		timings.ReasoningMS, timings.AnswerMS} {
		if value != nil && *value < 0 {
			return true
		}
	}
	return false
}

func validRunLeaseState(run runRow, workerID string, leaseVersion int, now time.Time) bool {
	return run.Status == "running" && run.LeaseOwner != nil && *run.LeaseOwner == workerID &&
		run.LeaseVersion != nil && *run.LeaseVersion == leaseVersion &&
		run.LeaseExpiresAt != nil && run.LeaseExpiresAt.After(now)
}

type failRunInput struct {
	WorkerID     string          `json:"workerId"`
	LeaseVersion int             `json:"leaseVersion"`
	ErrorCode    string          `json:"errorCode"`
	ErrorDetail  string          `json:"errorDetail"`
	Usage        runUsageInput   `json:"usage"`
	Timings      runTimingsInput `json:"timings"`
}

func validAssistantFailureCode(value string) bool {
	switch value {
	case "ASSISTANT_PROVIDER_UNAVAILABLE", "ASSISTANT_PROVIDER_PROTOCOL_ERROR",
		"ASSISTANT_PROVIDER_CREDENTIALS_INVALID", "ASSISTANT_CITATION_INVALID",
		"ASSISTANT_SENSITIVE_POLICY_CHANGED", "ASSISTANT_CONTEXT_TOO_LARGE",
		"ASSISTANT_REASONING_UNSUPPORTED", "ASSISTANT_MODEL_UNAVAILABLE",
		"ASSISTANT_SENSITIVE_INPUT_BLOCKED", "INTERNAL_ERROR":
		return true
	default:
		return false
	}
}

func (service *Service) failRun(response http.ResponseWriter, request *http.Request) {
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return
	}
	var input failRunInput
	if httpapi.DecodeJSON(response, request, 32*1024, &input) != nil || !validAssistantWorkerID(input.WorkerID) ||
		input.LeaseVersion < 1 || !validAssistantFailureCode(input.ErrorCode) ||
		len(input.ErrorDetail) > 500 || !utf8.ValidString(input.ErrorDetail) ||
		negativeUsage(input.Usage) || negativeTimings(input.Timings) {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
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
	var storedRun runRow
	if err := tx.QueryRow(ctx, `SELECT `+runColumns+` FROM assistant_runs WHERE id = $1 FOR UPDATE`, run.ID).
		Scan(runScanTargets(&storedRun)...); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if !validRunLeaseState(storedRun, input.WorkerID, input.LeaseVersion, now) {
		writeAssistantLeaseConflict(response, request)
		return
	}
	stopRequested := storedRun.StopRequestedAt != nil
	status := "failed"
	if stopRequested {
		// An acknowledged stop is a stopped run, not a failure.
		status = "stopped"
	}
	var errorCode, errorDetail *string
	messageStatus := "failed"
	if status == "stopped" {
		messageStatus = "stopped"
	} else {
		detail := input.ErrorDetail
		code := input.ErrorCode
		errorCode, errorDetail = &code, &detail
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_runs SET status = $2, finished_at = $3, phase = NULL,
		       lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		       error_code = $4, error_detail = $5,
		       rewrite_input_tokens = $6, rewrite_output_tokens = $7,
		       answer_input_tokens = $8, answer_output_tokens = $9,
		       rewrite_ms = $10, embedding_ms = $11, retrieval_ms = $12, reasoning_ms = $13, answer_ms = $14,
		       answer_context_tokens = $15
		WHERE id = $1
	`, run.ID, status, now, errorCode, errorDetail,
		input.Usage.RewriteInputTokens, input.Usage.RewriteOutputTokens,
		input.Usage.AnswerInputTokens, input.Usage.AnswerOutputTokens,
		input.Timings.RewriteMS, input.Timings.EmbeddingMS, input.Timings.RetrievalMS,
		input.Timings.ReasoningMS, input.Timings.AnswerMS, input.Usage.AnswerContextTokens); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_messages SET status = $2, completed_at = $3 WHERE id = $1
	`, storedRun.OutputMessageID, messageStatus, now); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	service.broadcast.notify(storedRun.ID)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"status": status})
}

type titleInput struct {
	Title string `json:"title"`
}

// runTitle is a lease-free, best-effort conditional update after the first
// successful answer; it never overwrites a user title (docs/16 §14).
func (service *Service) runTitle(response http.ResponseWriter, request *http.Request) {
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return
	}
	var input titleInput
	if httpapi.DecodeJSON(response, request, 8*1024, &input) != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
		return
	}
	title := strings.TrimSpace(input.Title)
	runes := []rune(title)
	if title == "" || !utf8.ValidString(title) || len(runes) > 30 {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
		return
	}
	tag, err := service.database.Exec(request.Context(), `
		UPDATE assistant_conversations SET title = $2, title_origin = 'generated', updated_at = $3
		FROM assistant_runs
		WHERE assistant_runs.id = $1 AND assistant_conversations.id = assistant_runs.conversation_id
		  AND assistant_conversations.title_origin <> 'user' AND assistant_runs.status = 'succeeded'
	`, run.ID, title, service.now().UTC())
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"applied": tag.RowsAffected() == 1})
}

type summaryInput struct {
	Summary                claimRunSummary `json:"summary"`
	ThroughMessageSequence int64           `json:"throughMessageSequence"`
	ModelSnapshot          map[string]any  `json:"modelSnapshot"`
}

// runSummary is a lease-free, idempotent conditional update: only a newer
// throughMessageSequence replaces the stored summary; validation failures
// keep the previous one (docs/16 §8.8).
func (service *Service) runSummary(response http.ResponseWriter, request *http.Request) {
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return
	}
	var input summaryInput
	if httpapi.DecodeJSON(response, request, 256*1024, &input) != nil || input.ThroughMessageSequence < 1 {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
		return
	}
	if !validSummary(&input.Summary) || input.ModelSnapshot == nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
		return
	}
	encodedContent, err := json.Marshal(input.Summary)
	if err != nil || len(encodedContent) > MaximumSummaryBytes {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
		return
	}
	encodedModel, _ := json.Marshal(input.ModelSnapshot)
	tag, err := service.database.Exec(request.Context(), `
		INSERT INTO assistant_conversation_summaries (conversation_id, through_message_sequence, content, model_snapshot, updated_at)
		SELECT conversation_id, $2, $3::jsonb, $4::jsonb, $5 FROM assistant_runs WHERE id = $1 AND status = 'succeeded'
		ON CONFLICT (conversation_id) DO UPDATE SET
			through_message_sequence = EXCLUDED.through_message_sequence,
			content = EXCLUDED.content, model_snapshot = EXCLUDED.model_snapshot, updated_at = EXCLUDED.updated_at
		WHERE assistant_conversation_summaries.through_message_sequence < EXCLUDED.through_message_sequence
	`, run.ID, input.ThroughMessageSequence, string(encodedContent), string(encodedModel), service.now().UTC())
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"applied": tag.RowsAffected() == 1})
}

func validSummary(summary *claimRunSummary) bool {
	total := 0
	for _, group := range [][]string{summary.ConfirmedFacts, summary.Corrections,
		summary.RejectedHypotheses, summary.UnresolvedQuestions} {
		total += len(group)
		for _, entry := range group {
			if !utf8.ValidString(entry) || strings.TrimSpace(entry) == "" {
				return false
			}
		}
	}
	return total <= MaximumSummaryEntries
}

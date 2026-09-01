package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/ai"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type createRunInput struct {
	ClientRequestID uuid.UUID  `json:"clientRequestId"`
	ConversationID  *uuid.UUID `json:"conversationId"`
	FolderID        *uuid.UUID `json:"folderId"`
	Content         string     `json:"content"`
	ModelID         uuid.UUID  `json:"modelId"`
	Reasoning       string     `json:"reasoning"`
}

type retryRunInput struct {
	ClientRequestID uuid.UUID `json:"clientRequestId"`
	ModelID         uuid.UUID `json:"modelId"`
	Reasoning       string    `json:"reasoning"`
}

// requestSnapshot is the canonical idempotency comparison payload (docs/16 §8.10).
type requestSnapshot struct {
	RequestKind    string     `json:"requestKind"`
	ConversationID *uuid.UUID `json:"conversationId"`
	FolderID       *uuid.UUID `json:"folderId"`
	Content        string     `json:"content"`
	ModelID        uuid.UUID  `json:"modelId"`
	Reasoning      string     `json:"reasoning"`
	RetryOfRunID   *uuid.UUID `json:"retryOfRunId"`
}

// sameAs compares the canonical replay fields (docs/16 §8.10). Pointer fields
// compare by value so a jsonb round-trip of null vs. the same UUID matches.
func (snapshot requestSnapshot) sameAs(other requestSnapshot) bool {
	samePointer := func(left, right *uuid.UUID) bool {
		if left == nil || right == nil {
			return left == right
		}
		return *left == *right
	}
	return snapshot.RequestKind == other.RequestKind &&
		samePointer(snapshot.ConversationID, other.ConversationID) &&
		samePointer(snapshot.FolderID, other.FolderID) &&
		snapshot.Content == other.Content &&
		snapshot.ModelID == other.ModelID &&
		snapshot.Reasoning == other.Reasoning &&
		samePointer(snapshot.RetryOfRunID, other.RetryOfRunID)
}

func validReasoningValue(value string) bool {
	switch value {
	case "off", "minimal", "low", "medium", "high", "xhigh", "max":
		return true
	default:
		return false
	}
}

func validUserContent(content string) bool {
	return content != "" && utf8.ValidString(content) && len(content) <= MaximumUserMessageBytes &&
		strings.TrimSpace(content) != ""
}

func reasoningOrNull(reasoning string) *string {
	if reasoning == "off" {
		return nil
	}
	return &reasoning
}

func provisionalTitle(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		runes := []rune(line)
		if len(runes) > 120 {
			runes = runes[:120]
		}
		return string(runes)
	}
	return "新会话"
}

func (service *Service) createRun(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input createRunInput
	if httpapi.DecodeJSON(response, request, MaximumUserMessageBytes+16*1024, &input) != nil {
		writeValidationError(response, request)
		return
	}
	if !validReasoningValue(input.Reasoning) ||
		(input.ConversationID != nil && input.FolderID != nil) ||
		!validUserContent(input.Content) {
		writeValidationError(response, request)
		return
	}
	snapshot := requestSnapshot{
		RequestKind: "new", ConversationID: input.ConversationID, FolderID: input.FolderID,
		Content: input.Content, ModelID: input.ModelID, Reasoning: input.Reasoning,
	}
	if service.resolveIdempotent(response, request, input.ClientRequestID, snapshot) {
		return
	}
	result, conflict := service.insertRun(request, input.ClientRequestID, snapshot, input.ModelID, input.Reasoning, nil)
	if conflict != nil {
		if errors.Is(conflict, errIdempotencyRace) {
			// Concurrent same-clientRequestId insert: the losing transaction
			// rolls back entirely and re-reads the committed run (docs/16 §11.1).
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

var errIdempotencyRace = errors.New("idempotency race")

// resolveIdempotent performs the clientRequestId pre-check. It returns true
// when the response has been written (replay or conflict).
func (service *Service) resolveIdempotent(response http.ResponseWriter, request *http.Request, clientRequestID uuid.UUID, snapshot requestSnapshot) bool {
	existing, err := findRunByClientRequestID(request.Context(), service.database, clientRequestID)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return true
	}
	if existing == nil {
		return false
	}
	service.answerExistingRun(response, request, existing, snapshot)
	return true
}

func (service *Service) answerExistingRun(response http.ResponseWriter, request *http.Request, existing *runRow, snapshot requestSnapshot) {
	var storedRaw []byte
	if err := service.database.QueryRow(request.Context(),
		`SELECT request_snapshot FROM assistant_runs WHERE id = $1`, existing.ID).Scan(&storedRaw); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	// jsonb storage normalizes key order and whitespace, so the replay check is
	// field-by-field on the decoded canonical form, not byte equality.
	var stored requestSnapshot
	if json.Unmarshal(storedRaw, &stored) != nil || !stored.sameAs(snapshot) {
		writeAssistantIdempotencyConflict(response, request)
		return
	}
	result, err := service.loadRunStartResponse(request.Context(), service.database, *existing, true)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusAccepted, result)
}

func findRunByClientRequestID(ctx context.Context, querier rowQuerier, clientRequestID uuid.UUID) (*runRow, error) {
	run, err := scanRunRow(querier.QueryRow(ctx,
		`SELECT `+runColumns+` FROM assistant_runs WHERE client_request_id = $1`, clientRequestID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &run, nil
}

// insertRun executes the fixed-order creation transaction and returns either a
// RunStartResponseDTO or a conflict error to translate into a stable code.
func (service *Service) insertRun(request *http.Request, clientRequestID uuid.UUID, snapshot requestSnapshot, modelID uuid.UUID, reasoning string, retry *retryContext) (*RunStartResponseDTO, error) {
	ctx := request.Context()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	execution, conflict := service.lockAndValidateModel(ctx, tx, modelID, reasoning)
	if conflict != nil {
		return nil, conflict
	}
	policy, err := service.loadSensitivePolicy(ctx, tx)
	if err != nil {
		return nil, err
	}
	if policy == "block" && contentMatchesSensitivePattern(snapshot.Content) {
		return nil, &runConflictError{status: http.StatusUnprocessableEntity, code: "ASSISTANT_SENSITIVE_INPUT_BLOCKED"}
	}
	computation, err := service.computeIndexStatus(ctx, tx)
	if err != nil {
		return nil, err
	}
	knowledgeState := "unavailable"
	if computation.status == "ready" {
		knowledgeState = "ready"
	}
	now := service.now().UTC()

	var conversation messageContext
	if retry == nil {
		conversation, conflict = service.prepareNewMessages(ctx, tx, snapshot, now)
	} else {
		conversation, conflict = service.prepareRetryMessages(ctx, tx, *retry, now)
	}
	if conflict != nil {
		return nil, conflict
	}
	conversationID, inputMessageID, outputMessageID := conversation.conversationID, conversation.inputMessageID, conversation.outputMessageID
	// The snapshot stays exactly as the client submitted it (conversationId null
	// for new runs): replays compare field-by-field against this canonical form
	// and must not see the server-assigned conversation id (docs/16 §8.10).
	encodedSnapshot, _ := json.Marshal(snapshot)

	runID := uuid.New()
	queuedAt := now
	if retry != nil {
		queuedAt = retry.queuedAt
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO assistant_runs (
			id, conversation_id, input_message_id, output_message_id, retry_of_run_id, client_request_id,
			request_snapshot, status, provider_id, provider_display_name, model_id, model_display_name,
			upstream_model_id, protocol, base_url, context_window, max_output_tokens,
			reasoning_effort, reasoning_display_name, sensitive_policy, effective_sensitive_policy,
			prompt_version, retrieval_version, knowledge_state, created_at, queued_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20, $21, $22, $23, $24)
	`, runID, conversationID, inputMessageID, outputMessageID, snapshot.RetryOfRunID,
		clientRequestID, encodedSnapshot,
		execution.providerID, execution.providerDisplayName, execution.modelID, execution.modelDisplayName,
		execution.upstreamModelID, execution.protocol, execution.baseURL, execution.contextWindow,
		execution.maxOutputTokens, execution.reasoningEffort, execution.reasoningDisplayName, policy,
		PromptVersion, RetrievalVersion, knowledgeState, now, queuedAt); err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			return nil, errIdempotencyRace
		}
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE assistant_messages SET current_run_id = $2 WHERE id = $1`, outputMessageID, runID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_conversations SET selected_model_id = $2, selected_reasoning_effort = $3, updated_at = $4
		WHERE id = $1
	`, conversationID, execution.modelID, reasoningOrNull(reasoning), now); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO assistant_model_preferences (model_id, last_reasoning_effort, last_used_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (model_id) DO UPDATE SET
			last_reasoning_effort = EXCLUDED.last_reasoning_effort, last_used_at = EXCLUDED.last_used_at
	`, execution.modelID, reasoningOrNull(reasoning), now); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			return nil, errIdempotencyRace
		}
		return nil, err
	}
	run, err := service.loadRun(ctx, service.database, runID)
	if err != nil {
		return nil, err
	}
	result, err := service.loadRunStartResponse(ctx, service.database, run, false)
	if err != nil {
		return nil, err
	}
	return result, nil
}

type runConflictError struct {
	status int
	code   string
}

func (conflict *runConflictError) Error() string { return conflict.code }

type messageContext struct {
	conversationID  uuid.UUID
	inputMessageID  uuid.UUID
	outputMessageID uuid.UUID
}

type retryContext struct {
	runID           uuid.UUID
	conversationID  uuid.UUID
	inputMessageID  uuid.UUID
	outputMessageID uuid.UUID
	originalContent string
	queuedAt        time.Time
}

// prepareNewMessages creates or locks the conversation, enforces the single
// active run rule and allocates the consecutive message sequences.
func (service *Service) prepareNewMessages(ctx context.Context, tx pgx.Tx, snapshot requestSnapshot, now time.Time) (messageContext, *runConflictError) {
	messageCtx := messageContext{}
	if snapshot.ConversationID != nil {
		if err := tx.QueryRow(ctx,
			`SELECT id FROM assistant_conversations WHERE id = $1 FOR UPDATE`, *snapshot.ConversationID).Scan(&messageCtx.conversationID); errors.Is(err, pgx.ErrNoRows) {
			return messageCtx, &runConflictError{status: http.StatusNotFound, code: "NOT_FOUND"}
		} else if err != nil {
			return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
		}
		var active bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM assistant_runs WHERE conversation_id = $1 AND status IN ('queued', 'running'))
		`, messageCtx.conversationID).Scan(&active); err != nil {
			return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
		}
		if active {
			return messageCtx, &runConflictError{status: http.StatusConflict, code: "ASSISTANT_RUN_ALREADY_ACTIVE"}
		}
	} else {
		var folderID *uuid.UUID
		if snapshot.FolderID != nil {
			if err := tx.QueryRow(ctx,
				`SELECT id FROM assistant_folders WHERE id = $1`, *snapshot.FolderID).Scan(&folderID); errors.Is(err, pgx.ErrNoRows) {
				return messageCtx, &runConflictError{status: http.StatusUnprocessableEntity, code: "VALIDATION_FAILED"}
			} else if err != nil {
				return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
			}
		}
		messageCtx.conversationID = uuid.New()
		if _, err := tx.Exec(ctx, `
			INSERT INTO assistant_conversations (id, folder_id, title, title_origin, created_at, updated_at)
			VALUES ($1, $2, $3, 'provisional', $4, $4)
		`, messageCtx.conversationID, folderID, provisionalTitle(snapshot.Content), now); err != nil {
			return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
		}
	}
	var nextSequence int64
	if err := tx.QueryRow(ctx,
		`SELECT next_message_sequence FROM assistant_conversations WHERE id = $1`, messageCtx.conversationID).Scan(&nextSequence); err != nil {
		return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	messageCtx.inputMessageID = uuid.New()
	messageCtx.outputMessageID = uuid.New()
	if _, err := tx.Exec(ctx, `
		INSERT INTO assistant_messages (id, conversation_id, sequence, role, content, status, created_at)
		VALUES ($1, $2, $3, 'user', $4, 'complete', $5)
	`, messageCtx.inputMessageID, messageCtx.conversationID, nextSequence, snapshot.Content, now); err != nil {
		return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO assistant_messages (id, conversation_id, sequence, role, content, status, created_at)
		VALUES ($1, $2, $3, 'assistant', '', 'streaming', $4)
	`, messageCtx.outputMessageID, messageCtx.conversationID, nextSequence+1, now); err != nil {
		return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_conversations SET next_message_sequence = $2, updated_at = $3 WHERE id = $1
	`, messageCtx.conversationID, nextSequence+2, now); err != nil {
		return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	return messageCtx, nil
}

// prepareRetryMessages reuses the original user/assistant message positions,
// clears the previous partial answer and switches current_run_id to the new run.
func (service *Service) prepareRetryMessages(ctx context.Context, tx pgx.Tx, retry retryContext, now time.Time) (messageContext, *runConflictError) {
	messageCtx := messageContext{
		conversationID: retry.conversationID, inputMessageID: retry.inputMessageID, outputMessageID: retry.outputMessageID,
	}
	var conversationID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM assistant_conversations WHERE id = $1 FOR UPDATE`, retry.conversationID).Scan(&conversationID); errors.Is(err, pgx.ErrNoRows) {
		return messageCtx, &runConflictError{status: http.StatusNotFound, code: "NOT_FOUND"}
	} else if err != nil {
		return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM assistant_runs WHERE conversation_id = $1 AND status IN ('queued', 'running'))
	`, retry.conversationID).Scan(&active); err != nil {
		return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	if active {
		return messageCtx, &runConflictError{status: http.StatusConflict, code: "ASSISTANT_RUN_ALREADY_ACTIVE"}
	}
	// The retried answer must still be the conversation's last message.
	var lastSequence, outputSequence int64
	if err := tx.QueryRow(ctx,
		`SELECT max(sequence) FROM assistant_messages WHERE conversation_id = $1`, retry.conversationID).Scan(&lastSequence); err != nil {
		return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	if err := tx.QueryRow(ctx,
		`SELECT sequence FROM assistant_messages WHERE id = $1`, retry.outputMessageID).Scan(&outputSequence); err != nil {
		return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	if outputSequence != lastSequence {
		return messageCtx, &runConflictError{status: http.StatusConflict, code: "ASSISTANT_RUN_NOT_RETRYABLE"}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_messages SET content = '', reasoning_content = NULL, status = 'streaming',
		       completed_at = NULL WHERE id = $1
	`, retry.outputMessageID); err != nil {
		return messageCtx, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	return messageCtx, nil
}

type lockedExecution struct {
	providerID           uuid.UUID
	providerDisplayName  string
	modelID              uuid.UUID
	modelDisplayName     string
	upstreamModelID      string
	protocol             string
	baseURL              string
	contextWindow        int
	maxOutputTokens      int
	reasoningEffort      *string
	reasoningDisplayName *string
}

// lockAndValidateModel takes the fixed-order locks (provider_config row then
// provider_model row) shared with configuration changes, and validates that
// the model can execute an assistant run right now.
func (service *Service) lockAndValidateModel(ctx context.Context, tx pgx.Tx, modelID uuid.UUID, reasoning string) (lockedExecution, *runConflictError) {
	execution := lockedExecution{modelID: modelID}
	var providerEnabled, hasKey, modelEnabled bool
	err := tx.QueryRow(ctx, `
		SELECT provider.id, provider.display_name, provider.enabled, provider.protocol, provider.base_url,
		       provider.api_key_ciphertext IS NOT NULL, model.model_id, model.display_name,
		       model.context_window, model.max_output_tokens, model.enabled
		FROM provider_models model JOIN provider_configs provider ON provider.id = model.provider_config_id
		WHERE model.id = $1 AND model.deleted_at IS NULL AND provider.deleted_at IS NULL
		FOR UPDATE OF provider
	`, modelID).Scan(&execution.providerID, &execution.providerDisplayName, &providerEnabled,
		&execution.protocol, &execution.baseURL, &hasKey, &execution.upstreamModelID,
		&execution.modelDisplayName, &execution.contextWindow, &execution.maxOutputTokens, &modelEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return execution, &runConflictError{status: http.StatusConflict, code: "ASSISTANT_MODEL_UNAVAILABLE"}
	}
	if err != nil {
		return execution, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	// Model row lock completes the fixed lock order.
	if _, err := tx.Exec(ctx, `SELECT true FROM provider_models WHERE id = $1 FOR UPDATE`, modelID); err != nil {
		return execution, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
	}
	if !providerEnabled || !modelEnabled || !hasKey ||
		execution.contextWindow <= 0 || execution.maxOutputTokens <= 0 {
		return execution, &runConflictError{status: http.StatusConflict, code: "ASSISTANT_MODEL_UNAVAILABLE"}
	}
	if reasoning != "off" {
		var displayName string
		if err := tx.QueryRow(ctx, `
			SELECT display_name FROM provider_model_reasoning_options WHERE model_id = $1 AND reasoning_effort = $2
		`, modelID, reasoning).Scan(&displayName); errors.Is(err, pgx.ErrNoRows) {
			return execution, &runConflictError{status: http.StatusUnprocessableEntity, code: "ASSISTANT_REASONING_UNSUPPORTED"}
		} else if err != nil {
			return execution, &runConflictError{status: http.StatusInternalServerError, code: "INTERNAL_ERROR"}
		}
		execution.reasoningEffort = &reasoning
		execution.reasoningDisplayName = &displayName
	}
	return execution, nil
}

// contentMatchesSensitivePattern reports whether the deterministic redaction
// rules would change the content; block policy rejects such input (docs/16 §6.2).
func contentMatchesSensitivePattern(content string) bool {
	redactor := ai.NewTextRedactor()
	return redactor.Redact(content) != content
}

func writeRunCreationError(response http.ResponseWriter, request *http.Request, conflict *runConflictError) {
	httpapi.WriteError(response, request, conflict.status, conflict.code, conflictMessage(conflict.code))
}

func conflictMessage(code string) string {
	switch code {
	case "ASSISTANT_MODEL_UNAVAILABLE":
		return "所选模型当前不可用，请重新选择"
	case "ASSISTANT_REASONING_UNSUPPORTED":
		return "该思考档位无法发送到当前模型"
	case "ASSISTANT_RUN_ALREADY_ACTIVE":
		return "会话已有进行中的回答"
	case "ASSISTANT_RUN_NOT_RETRYABLE":
		return "当前回答不可重试"
	case "ASSISTANT_SENSITIVE_INPUT_BLOCKED":
		return "全局敏感策略阻止了本次发送"
	case "NOT_FOUND":
		return "资源不存在"
	default:
		return "请求无法完成"
	}
}

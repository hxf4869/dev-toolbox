package assistant

import (
	"context"
	"strings"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

const runLeaseDuration = assistantLeaseDuraton

type claimRunInput struct {
	WorkerID string `json:"workerId"`
}

type claimRunMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type claimRunSummary struct {
	ConfirmedFacts      []string `json:"confirmedFacts"`
	Corrections         []string `json:"corrections"`
	RejectedHypotheses  []string `json:"rejectedHypotheses"`
	UnresolvedQuestions []string `json:"unresolvedQuestions"`
}

type claimRunContext struct {
	Summary  *claimRunSummary `json:"summary"`
	Messages []claimRunMessage `json:"messages"`
	Question string           `json:"question"`
	// SummarySource carries the oldest successful messages to compress when the
	// rolling summary must be regenerated (docs/16 §10.3); nil otherwise.
	SummarySource *claimSummarySource `json:"summarySource"`
}

type claimSummarySource struct {
	ThroughMessageSequence int64             `json:"throughMessageSequence"`
	Messages               []claimRunMessage `json:"messages"`
}

type claimRunResult struct {
	Run struct {
		ID             uuid.UUID `json:"id"`
		ConversationID uuid.UUID `json:"conversationId"`
		OutputMessageID uuid.UUID `json:"outputMessageId"`
		LeaseVersion   int       `json:"leaseVersion"`
		StopRequested  bool      `json:"stopRequested"`
		ExpiresAt      time.Time `json:"expiresAt"`
	} `json:"run"`
	Model struct {
		ID                  uuid.UUID `json:"id"`
		DisplayName         string    `json:"displayName"`
		UpstreamModelID     string    `json:"upstreamModelId"`
		ProviderID          uuid.UUID `json:"providerId"`
		ProviderDisplayName string    `json:"providerDisplayName"`
		Protocol            string    `json:"protocol"`
		BaseURL             string    `json:"baseUrl"`
		APIKey              string    `json:"apiKey"`
		ContextWindow       int       `json:"contextWindow"`
		MaxOutputTokens     int       `json:"maxOutputTokens"`
	} `json:"model"`
	Reasoning        RunReasoningDTO `json:"reasoning"`
	SensitivePolicy  string          `json:"sensitivePolicy"`
	PromptVersion    string          `json:"promptVersion"`
	RetrievalVersion string          `json:"retrievalVersion"`
	Knowledge struct {
		State      string `json:"state"`
		Generation *int64 `json:"generation"`
		// Embedding connection snapshot for the query embedding call; lives
		// only in this lease's memory (docs/16 §7.2).
		BaseURL    string  `json:"baseUrl"`
		APIKey     string  `json:"apiKey"`
		ModelID    string  `json:"modelId"`
		Dimensions *int    `json:"dimensions"`
	} `json:"knowledge"`
	Context claimRunContext `json:"context"`
}

func (service *Service) claimRun(response http.ResponseWriter, request *http.Request) {
	var input claimRunInput
	if httpapi.DecodeJSON(response, request, 8*1024, &input) != nil || !validAssistantWorkerID(input.WorkerID) {
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
	if err := service.recoverExpiredRuns(ctx, tx, now); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	run, err := scanRunRow(tx.QueryRow(ctx, `
		SELECT `+runColumns+` FROM assistant_runs
		WHERE status = 'queued' ORDER BY queued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
	`))
	if errors.Is(err, pgx.ErrNoRows) {
		if tx.Commit(ctx) != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if !service.executionConfigCompatible(ctx, tx, run) {
		if err := service.failRunInTx(ctx, tx, run, "ASSISTANT_PROVIDER_UNAVAILABLE",
			"执行配置已变化，无法按运行快照重领", now, run.StopRequestedAt != nil); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		if tx.Commit(ctx) != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		response.WriteHeader(http.StatusNoContent)
		return
	}
	claimAttempt := 0
	if err := tx.QueryRow(ctx, `
		UPDATE assistant_runs SET status = 'running', claim_attempt = claim_attempt + 1,
		       lease_owner = $2, lease_version = claim_attempt + 1, lease_expires_at = $3,
		       heartbeat_at = $3, started_at = COALESCE(started_at, $3)
		WHERE id = $1 RETURNING claim_attempt
	`, run.ID, input.WorkerID, now.Add(runLeaseDuration)).Scan(&claimAttempt); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	// The lease version equals the new claim attempt.
	_ = claimAttempt
	var apiKeyCiphertext []byte
	if err := tx.QueryRow(ctx,
		`SELECT api_key_ciphertext FROM provider_configs WHERE id = $1`, run.ProviderID).Scan(&apiKeyCiphertext); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	apiKey, err := secretbox.Open(service.masterKey, apiKeyCiphertext)
	if err != nil {
		_ = service.failRunInTx(ctx, tx, run, "ASSISTANT_PROVIDER_CREDENTIALS_INVALID", "Provider 凭据无法解密", now, false)
		if tx.Commit(ctx) != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		response.WriteHeader(http.StatusNoContent)
		return
	}
	claimContext, err := service.buildClaimContext(ctx, tx, run)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if claimContext == nil {
		// Context cannot fit the model budget even for the minimal set.
		_ = service.failRunInTx(ctx, tx, run, "ASSISTANT_CONTEXT_TOO_LARGE", "本轮内容超过模型容量限制", now, false)
		if tx.Commit(ctx) != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		response.WriteHeader(http.StatusNoContent)
		return
	}
	config, err := service.loadEmbeddingConfig(ctx, tx)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	knowledge := struct {
		State      string `json:"state"`
		Generation *int64 `json:"generation"`
		BaseURL    string  `json:"baseUrl"`
		APIKey     string  `json:"apiKey"`
		ModelID    string  `json:"modelId"`
		Dimensions *int    `json:"dimensions"`
	}{State: run.KnowledgeState}
	if run.KnowledgeState == "ready" && config.Enabled && config.Configured {
		generation := config.Generation
		knowledge.Generation = &generation
		knowledge.ModelID = strings.TrimSpace(deref(config.ModelID))
		knowledge.BaseURL = deref(config.BaseURL)
		knowledge.Dimensions = config.Dimensions
		if ciphertext := service.loadEmbeddingCiphertext(ctx, tx); ciphertext != nil {
			if apiKey, err := secretbox.Open(service.masterKey, ciphertext); err == nil {
				knowledge.APIKey = apiKey
			}
		}
	} else if run.KnowledgeState == "ready" {
		// Index became unavailable between creation and claim; retrieval will
		// only degrade, never upgrade.
		knowledge.Generation = nil
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	result := claimRunResult{}
	result.Run.ID = run.ID
	result.Run.ConversationID = run.ConversationID
	result.Run.OutputMessageID = run.OutputMessageID
	result.Run.LeaseVersion = claimAttempt
	result.Run.StopRequested = run.StopRequestedAt != nil
	result.Run.ExpiresAt = now.Add(runLeaseDuration)
	result.Model.ID = run.ModelID
	result.Model.DisplayName = run.ModelDisplayName
	result.Model.UpstreamModelID = run.UpstreamModelID
	result.Model.ProviderID = run.ProviderID
	result.Model.ProviderDisplayName = run.ProviderDisplayName
	result.Model.Protocol = run.Protocol
	result.Model.BaseURL = run.BaseURL
	result.Model.APIKey = apiKey
	result.Model.ContextWindow = run.ContextWindow
	result.Model.MaxOutputTokens = run.MaxOutputTokens
	result.Reasoning = run.reasoningSnapshot()
	result.SensitivePolicy = run.EffectivePolicy
	result.PromptVersion = run.PromptVersion
	result.RetrievalVersion = run.RetrievalVersion
	result.Knowledge = knowledge
	result.Context = *claimContext
	httpapi.WriteJSON(response, http.StatusOK, result)
}

// executionConfigCompatible re-checks §7.2 compatibility before re-claiming a
// run from the snapshot: provider/model enabled, key present, base URL and
// protocol unchanged.
func (service *Service) executionConfigCompatible(ctx context.Context, tx pgx.Tx, run runRow) bool {
	var protocol, baseURL string
	var enabled, hasKey, modelEnabled, modelDeleted, providerDeleted bool
	err := tx.QueryRow(ctx, `
		SELECT provider.protocol, provider.base_url, provider.enabled,
		       provider.api_key_ciphertext IS NOT NULL, provider.deleted_at IS NOT NULL,
		       model.enabled, model.deleted_at IS NOT NULL
		FROM provider_models model JOIN provider_configs provider ON provider.id = model.provider_config_id
		WHERE model.id = $1
	`, run.ModelID).Scan(&protocol, &baseURL, &enabled, &hasKey, &providerDeleted, &modelEnabled, &modelDeleted)
	if err != nil {
		return false
	}
	return !providerDeleted && !modelDeleted && enabled && modelEnabled && hasKey &&
		protocol == run.Protocol && baseURL == run.BaseURL
}

// recoverExpiredRuns fails or requeues running runs whose lease expired
// (docs/16 §11.4): once user-visible deltas exist the run fails and keeps the
// partial content; otherwise a compatible run requeues for one more claim.
func (service *Service) recoverExpiredRuns(ctx context.Context, tx pgx.Tx, now time.Time) error {
	rows, err := tx.Query(ctx, `
		SELECT id, stop_requested_at IS NOT NULL FROM assistant_runs
		WHERE status = 'running' AND lease_expires_at < $1 FOR UPDATE SKIP LOCKED
	`, now)
	if err != nil {
		return err
	}
	type expiredRun struct {
		id       uuid.UUID
		stopped  bool
		hasDelta bool
	}
	expired := make([]expiredRun, 0)
	for rows.Next() {
		var item expiredRun
		if err := rows.Scan(&item.id, &item.stopped); err != nil {
			rows.Close()
			return err
		}
		expired = append(expired, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range expired {
		var deltas int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM assistant_run_events
			WHERE run_id = $1 AND event_type IN ('reasoning.delta', 'answer.delta', 'answer.citation')
		`, item.id).Scan(&deltas); err != nil {
			return err
		}
		item.hasDelta = deltas > 0
		run, err := scanRunRow(tx.QueryRow(ctx, `SELECT `+runColumns+` FROM assistant_runs WHERE id = $1`, item.id))
		if err != nil {
			return err
		}
		if item.hasDelta || run.ClaimAttempt >= 2 || !service.executionConfigCompatible(ctx, tx, run) {
			if err := service.failRunInTx(ctx, tx, run, "ASSISTANT_PROVIDER_UNAVAILABLE",
				"worker 租约过期，回答已中断", now, item.stopped); err != nil {
				return err
			}
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_runs SET status = 'queued', lease_owner = NULL, lease_version = NULL,
			       lease_expires_at = NULL, heartbeat_at = NULL WHERE id = $1
		`, item.id); err != nil {
			return err
		}
	}
	return nil
}

// failRunInTx moves a run to its terminal failure/stopped state and settles
// the assistant message with any partial content.
func (service *Service) failRunInTx(ctx context.Context, tx pgx.Tx, run runRow, code, detail string, now time.Time, stopRequested bool) error {
	status := "failed"
	if stopRequested {
		status = "stopped"
		code, detail = "", ""
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_runs SET status = $2, finished_at = $3, phase = NULL,
		       lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		       error_code = $4, error_detail = $5
		WHERE id = $1
	`, run.ID, status, now, nilIfEmpty(code), nilIfEmpty(detail)); err != nil {
		return err
	}
	messageStatus := "failed"
	if status == "stopped" {
		messageStatus = "stopped"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_messages SET status = $2, completed_at = $3 WHERE id = $1
	`, run.OutputMessageID, messageStatus, now); err != nil {
		return err
	}
	return nil
}

func nilIfEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// buildClaimContext selects the structured summary and the most recent
// successful messages that fit the model input budget (docs/16 §10.2).
func (service *Service) buildClaimContext(ctx context.Context, tx pgx.Tx, run runRow) (*claimRunContext, error) {
	input, err := scanMessageRow(tx.QueryRow(ctx,
		`SELECT `+messageColumns+` FROM assistant_messages WHERE id = $1`, run.InputMessageID))
	if err != nil {
		return nil, err
	}
	output, err := scanMessageRow(tx.QueryRow(ctx,
		`SELECT `+messageColumns+` FROM assistant_messages WHERE id = $1`, run.OutputMessageID))
	if err != nil {
		return nil, err
	}
	if output.Status != "streaming" {
		return nil, errors.New("output message not streaming")
	}
	budget := contextBudgetTokens(run.ContextWindow, run.MaxOutputTokens)

	var summaryContent []byte
	hasSummary := false
	if err := tx.QueryRow(ctx, `
		SELECT content FROM assistant_conversation_summaries WHERE conversation_id = $1
	`, run.ConversationID).Scan(&summaryContent); err == nil {
		hasSummary = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	// The current question always stays; it reserves its budget first.
	question := input.Content
	budget -= estimateTokens(question)
	if budget <= 0 {
		return nil, nil
	}
	context := claimRunContext{Messages: []claimRunMessage{}, Question: question}
	if hasSummary {
		var summary claimRunSummary
		if err := json.Unmarshal(summaryContent, &summary); err != nil {
			return nil, err
		}
		encoded, _ := json.Marshal(summary)
		if summaryBytes := estimateTokens(string(encoded)); summaryBytes < budget {
			context.Summary = &summary
			budget -= summaryBytes
		}
	}
	// Recent successful messages, newest first; stopped/failed content never
	// enters context, and canonical citation tokens are stripped.
	rows, err := tx.Query(ctx, `
		SELECT role, content, status, sequence FROM assistant_messages
		WHERE conversation_id = $1 AND id <> $2 AND id <> $3 AND status = 'complete'
		ORDER BY sequence DESC
	`, run.ConversationID, run.InputMessageID, run.OutputMessageID)
	if err != nil {
		return nil, err
	}
	history := make([]historyEntry, 0)
	for rows.Next() {
		var role, content, status string
		var sequence int64
		if err := rows.Scan(&role, &content, &status, &sequence); err != nil {
			rows.Close()
			return nil, err
		}
		history = append(history, historyEntry{role: role, content: content, sequence: sequence})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var summarizedThrough int64
	if hasSummary {
		if err := tx.QueryRow(ctx,
			`SELECT through_message_sequence FROM assistant_conversation_summaries WHERE conversation_id = $1`,
			run.ConversationID).Scan(&summarizedThrough); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	summarySource := service.summarySourceFor(history, summarizedThrough)
	for _, entry := range history {
		stripped := entry.content
		if entry.role == "assistant" {
			stripped = stripCitationTokens(stripped)
		}
		cost := estimateTokens(stripped) + 4
		if cost > budget {
			break
		}
		budget -= cost
		context.Messages = append(context.Messages, claimRunMessage{Role: entry.role, Content: stripped})
	}
	// Oldest-first order for the model.
	for left, right := 0, len(context.Messages)-1; left < right; left, right = left+1, right-1 {
		context.Messages[left], context.Messages[right] = context.Messages[right], context.Messages[left]
	}
	context.SummarySource = summarySource
	return &context, nil
}

type historyEntry struct {
	role     string
	content  string
	sequence int64
}

// summarySourceFor decides whether the rolling summary must be regenerated
// (docs/16 §10.3): more than 16 successful messages in the conversation.
// The most recent 16 successful messages (8 complete Q&A pairs) always stay
// verbatim; older ones not yet covered by the stored summary are compressed.
func (service *Service) summarySourceFor(history []historyEntry, summarizedThrough int64) *claimSummarySource {
	if len(history) <= SummaryMessageTrigger {
		return nil
	}
	// history is newest-first; the newest SummaryMessageTrigger stay verbatim.
	older := history[SummaryMessageTrigger:]
	compress := make([]historyEntry, 0, len(older))
	through := int64(0)
	for _, entry := range older {
		if entry.sequence <= summarizedThrough {
			continue
		}
		compress = append(compress, entry)
		if entry.sequence > through {
			through = entry.sequence
		}
	}
	if len(compress) == 0 {
		return nil
	}
	messages := make([]claimRunMessage, 0, len(compress))
	for index := len(compress) - 1; index >= 0; index-- {
		entry := compress[index]
		content := entry.content
		if entry.role == "assistant" {
			content = stripCitationTokens(content)
		}
		messages = append(messages, claimRunMessage{Role: entry.role, Content: content})
	}
	return &claimSummarySource{ThroughMessageSequence: through, Messages: messages}
}

// contextBudgetTokens reserves the system prompt, sources headroom, answer
// output and a safety margin from the model context window.
func contextBudgetTokens(contextWindow, maxOutputTokens int) int {
	// Sources can each reach 8 KiB; reserve the worst case for eight of them.
	sourceHeadroom := MaximumRunSources * 8192 / 3
	budget := contextWindow - maxOutputTokens - systemPromptTokenEstimate - contextSafetyTokens - sourceHeadroom
	if budget < 0 {
		budget = 0
	}
	return budget
}

// estimateTokens is a deliberately conservative CJK-first estimate: at most
// one token per three UTF-8 bytes never underestimates Chinese text.
func estimateTokens(text string) int {
	bytes := len(text)
	if bytes == 0 {
		return 0
	}
	tokens := (bytes + 2) / 3
	if tokens < 1 {
		tokens = 1
	}
	return tokens
}

type runHeartbeatInput struct {
	WorkerID     string `json:"workerId"`
	LeaseVersion int    `json:"leaseVersion"`
}

func (service *Service) heartbeatRun(response http.ResponseWriter, request *http.Request) {
	run, input, ok := service.decodeRunLease(response, request)
	if !ok {
		return
	}
	ctx := request.Context()
	now := service.now().UTC()
	var stopRequestedAt *time.Time
	err := service.database.QueryRow(ctx, `
		UPDATE assistant_runs SET heartbeat_at = $4, lease_expires_at = $5
		WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND lease_version = $3
		  AND lease_expires_at >= $4
		RETURNING stop_requested_at
	`, run.ID, input.WorkerID, input.LeaseVersion, now, now.Add(runLeaseDuration)).Scan(&stopRequestedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAssistantLeaseConflict(response, request)
		return
	}
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"stopRequested": stopRequestedAt != nil})
}

type runLeaseInput struct {
	WorkerID     string `json:"workerId"`
	LeaseVersion int    `json:"leaseVersion"`
}

func (service *Service) decodeRunLease(response http.ResponseWriter, request *http.Request) (runRow, runLeaseInput, bool) {
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return runRow{}, runLeaseInput{}, false
	}
	var input runLeaseInput
	if httpapi.DecodeJSON(response, request, 8*1024, &input) != nil ||
		!validAssistantWorkerID(input.WorkerID) || input.LeaseVersion < 1 {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
		return runRow{}, input, false
	}
	return run, input, true
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (service *Service) loadEmbeddingCiphertext(ctx context.Context, querier rowQuerier) []byte {
	var ciphertext []byte
	if err := querier.QueryRow(ctx,
		`SELECT api_key_ciphertext FROM assistant_embedding_config WHERE singleton`).Scan(&ciphertext); err != nil {
		return nil
	}
	return ciphertext
}

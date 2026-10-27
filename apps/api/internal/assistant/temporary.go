package assistant

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

const maximumTemporaryPhaseWindow = 60 * time.Second

// JSON string escaping can inflate each byte up to sixfold (\uXXXX), so the
// envelope guard must exceed the sum of the raw contract limits
// (docs/16 §13.9) or contract-valid requests get rejected at decode time.
const maximumTemporaryStreamEnvelopeBytes = 6*(MaximumTemporaryHistoryBytes+MaximumUserMessageBytes) +
	8*MaximumSummaryBytes + 16*1024

type temporaryHistoryMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type temporarySummary struct {
	ConfirmedFacts      []string `json:"confirmedFacts"`
	Corrections         []string `json:"corrections"`
	RejectedHypotheses  []string `json:"rejectedHypotheses"`
	UnresolvedQuestions []string `json:"unresolvedQuestions"`
}

type temporaryStreamInput struct {
	ClientRequestID uuid.UUID                 `json:"clientRequestId"`
	ModelID         uuid.UUID                 `json:"modelId"`
	Reasoning       string                    `json:"reasoning"`
	Summary         *temporarySummary         `json:"summary"`
	Messages        []temporaryHistoryMessage `json:"messages"`
	Content         string                    `json:"content"`
}

type temporaryEmbeddingSnapshot struct {
	BaseURL    string `json:"baseUrl"`
	APIKey     string `json:"apiKey"`
	ModelID    string `json:"modelId"`
	Dimensions int    `json:"dimensions"`
}

type temporaryRuntimeTrace struct {
	RewriteInputTokens  *int64
	RewriteOutputTokens *int64
	RewriteMS           *int64
	EmbeddingMS         *int64
	RetrievalMS         *int64
	RewriteFallback     bool
	StartedAt           time.Time
}

type temporaryRunRegistration struct {
	policy string
	cancel context.CancelCauseFunc
}

var errTemporarySensitivePolicyChanged = errors.New("temporary sensitive policy changed")

// temporaryStream executes the whole ephemeral flow inside one HTTP request:
// validation, model snapshot, optional rewrite+retrieval through the worker,
// and a proxied answer stream. Nothing chat-related is persisted.
func (service *Service) temporaryStream(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input temporaryStreamInput
	if httpapi.DecodeJSON(response, request, maximumTemporaryStreamEnvelopeBytes, &input) != nil {
		writeValidationError(response, request)
		return
	}
	if !validReasoningValue(input.Reasoning) {
		writeValidationError(response, request)
		return
	}
	// Size-class contract violations report the stable context error while
	// shape errors stay VALIDATION_FAILED (docs/16 §13.9).
	if len(input.Content) > MaximumUserMessageBytes {
		writeAssistantContextTooLarge(response, request)
		return
	}
	if !validUserContent(input.Content) {
		writeValidationError(response, request)
		return
	}
	if len(input.Messages) > MaximumTemporaryHistory {
		writeAssistantContextTooLarge(response, request)
		return
	}
	totalHistory := 0
	expectedRole := "user"
	for index, message := range input.Messages {
		if message.Role != expectedRole || !validTemporaryHistoryContent(message.Content) {
			writeValidationError(response, request)
			return
		}
		totalHistory += len(message.Content)
		if index%2 == 0 {
			expectedRole = "assistant"
		} else {
			expectedRole = "user"
		}
	}
	if len(input.Messages)%2 != 0 {
		writeValidationError(response, request)
		return
	}
	if totalHistory > MaximumTemporaryHistoryBytes {
		writeAssistantContextTooLarge(response, request)
		return
	}
	for index, message := range input.Messages {
		if message.Role == "assistant" {
			input.Messages[index].Content = stripCitationTokens(message.Content)
		}
	}
	if input.Summary != nil {
		if !validTemporarySummary(input.Summary) {
			writeValidationError(response, request)
			return
		}
		if temporarySummaryEntries(input.Summary) > MaximumSummaryEntries ||
			temporarySummaryBytes(input.Summary) > MaximumSummaryBytes {
			writeAssistantContextTooLarge(response, request)
			return
		}
	}
	// Lock and snapshot the execution configuration, then keep everything in
	// request memory only (docs/16 §7.2/§12).
	ctx := request.Context()
	tx, err := service.database.BeginTx(ctx, pgx_tx_default)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	execution, conflict := service.lockAndValidateModel(ctx, tx, input.ModelID, input.Reasoning)
	if conflict != nil {
		tx.Rollback(ctx)
		writeRunCreationError(response, request, conflict)
		return
	}
	// The current question is never truncated or dropped, so a question alone
	// over the model input budget fails before the stream starts (docs/16
	// §10.2). Everything else degrades by trimming instead.
	if inputContextBudgetTokens(execution.contextWindow, execution.maxOutputTokens) < estimateTokens(input.Content) {
		tx.Rollback(ctx)
		writeAssistantContextTooLarge(response, request)
		return
	}
	if _, err := tx.Exec(ctx, `SELECT true FROM app_settings WHERE singleton FOR SHARE`); err != nil {
		tx.Rollback(ctx)
		writeAssistantInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(ctx, `SELECT true FROM assistant_embedding_config WHERE singleton FOR SHARE`); err != nil {
		tx.Rollback(ctx)
		writeAssistantInternalFailure(response, request)
		return
	}
	policy, err := service.loadSensitivePolicy(ctx, tx)
	if err != nil {
		tx.Rollback(ctx)
		writeAssistantInternalFailure(response, request)
		return
	}
	if policy == "block" && temporaryInputMatchesSensitivePattern(input) {
		tx.Rollback(ctx)
		writeAssistantSensitiveInputBlocked(response, request)
		return
	}
	var apiKeyCiphertext []byte
	if err := tx.QueryRow(ctx,
		`SELECT api_key_ciphertext FROM provider_configs WHERE id = $1`, execution.providerID).Scan(&apiKeyCiphertext); err != nil {
		tx.Rollback(ctx)
		writeAssistantInternalFailure(response, request)
		return
	}
	config, err := service.loadEmbeddingConfig(ctx, tx)
	if err != nil {
		tx.Rollback(ctx)
		writeAssistantInternalFailure(response, request)
		return
	}
	embedding := temporaryEmbeddingSnapshot{}
	if config.Configured && config.Enabled && config.BaseURL != nil && config.ModelID != nil && config.Dimensions != nil {
		// A ciphertext read failure folds into "no credential" so a temporary
		// chat keeps running without knowledge instead of failing outright.
		if ciphertext, ciphertextErr := service.loadEmbeddingCiphertext(ctx, tx); ciphertextErr == nil && ciphertext != nil {
			if key, openErr := secretbox.Open(service.masterKey, ciphertext); openErr == nil {
				embedding = temporaryEmbeddingSnapshot{
					BaseURL: *config.BaseURL, APIKey: key, ModelID: *config.ModelID, Dimensions: *config.Dimensions,
				}
			}
		}
	}
	streamContext, unregister := service.registerTemporaryRun(ctx, policy)
	defer unregister()
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	ctx = streamContext
	apiKey, err := secretbox.Open(service.masterKey, apiKeyCiphertext)
	if err != nil {
		writeAssistantProviderCredentialsInvalid(response, request)
		return
	}
	computation, err := service.computeIndexStatus(ctx, service.database)
	knowledgeReady := err == nil && computation.status == "ready" && embedding.APIKey != ""
	// Model preference update is best-effort and never blocks the stream.
	_, _ = service.database.Exec(ctx, `
		INSERT INTO assistant_model_preferences (model_id, last_reasoning_effort, last_used_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (model_id) DO UPDATE SET
			last_reasoning_effort = EXCLUDED.last_reasoning_effort, last_used_at = EXCLUDED.last_used_at
	`, execution.modelID, reasoningOrNull(input.Reasoning), service.now().UTC())

	stream, streamErr := newSSEWriter(response)
	if streamErr != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store, no-transform")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	if stream.writeRaw("\n") != nil {
		return
	}
	sequence := 0
	emit := func(event string, payload map[string]any) bool {
		return writeTemporaryEvent(stream, &sequence, event, payload)
	}
	trace := temporaryRuntimeTrace{StartedAt: service.now().UTC()}
	initialPhase := "answer"
	if knowledgeReady {
		initialPhase = "embedding"
		if len(input.Messages) > 0 {
			initialPhase = "rewrite"
		}
	}
	if !emit("run.status", map[string]any{
		"status": "running", "phase": initialPhase,
		"model": RunModelDTO{
			ID: execution.modelID, DisplayName: execution.modelDisplayName,
			UpstreamModelID: execution.upstreamModelID, ProviderID: execution.providerID,
			ProviderDisplayName: execution.providerDisplayName, ContextWindow: execution.contextWindow,
		},
	}) {
		return
	}

	query := input.Content
	var queryVector []float32
	evidenceState := "unavailable"
	retrieved := false
	var snapshots []retrievalCandidate
	if knowledgeReady {
		rewrite := trimTemporaryRewriteContext(execution.contextWindow, execution.maxOutputTokens,
			input.Content, input.Summary, input.Messages)
		prepareInput := temporaryStreamInput{
			ClientRequestID: input.ClientRequestID, ModelID: input.ModelID, Reasoning: input.Reasoning,
			Summary: rewrite.summary, Messages: rewrite.messages, Content: input.Content,
		}
		prepare, prepareErr := service.callTemporaryPrepare(ctx, execution, apiKey, embedding, policy, prepareInput)
		if prepareErr == nil {
			trace.EmbeddingMS = &prepare.EmbeddingDurationMS
			if prepare.Rewrite != nil {
				trace.RewriteInputTokens = prepare.Rewrite.InputTokens
				trace.RewriteOutputTokens = prepare.Rewrite.OutputTokens
				trace.RewriteMS = &prepare.Rewrite.DurationMS
				trace.RewriteFallback = prepare.Rewrite.Fallback
			}
		}
		if prepareErr == nil && prepare.Status == "ready" && len(prepare.QueryVector) > 0 {
			queryVector = prepare.QueryVector
			if strings.TrimSpace(prepare.Query) != "" {
				query = prepare.Query
			}
			if !emit("run.status", map[string]any{"status": "running", "phase": "retrieval"}) {
				return
			}
			retrievalStarted := time.Now()
			candidates, retrieveErr := hybridRetrieve(ctx, service.database, config.Generation, policy, query, queryVector)
			retrievalMS := time.Since(retrievalStarted).Milliseconds()
			trace.RetrievalMS = &retrievalMS
			if retrieveErr == nil {
				snapshots = buildSourceSnapshots(candidates, policy)
				retrieved = true
			} else {
				snapshots = nil
				evidenceState = "unavailable"
			}
		}
	}
	// The answer input is bounded by the real retrieved sources — not by a
	// frozen reservation for eight maximum sources — so a small model with no
	// or few sources keeps the recent turns (docs/16 §10.2).
	answer := trimTemporaryAnswerContext(execution.contextWindow, execution.maxOutputTokens,
		input.Content, input.Summary, input.Messages, snapshots)
	if retrieved {
		evidenceState = "not_found"
		if len(answer.sources) > 0 {
			evidenceState = "matched"
		}
	}
	// The rolling-summary maintenance input travels independently of any
	// answer-side trimming: the uncovered prefix is always the raw request
	// history minus the most recent 16 successful messages (docs/16 §10.3).
	summarySource := temporarySummarySourceFor(input.Summary, input.Messages)
	if temporaryPolicyChanged(ctx) {
		_ = emit("run.failed", tracedTemporaryTerminalPayload(
			"failed", "ASSISTANT_SENSITIVE_POLICY_CHANGED", "全局敏感策略已收紧", trace, service.now().UTC(),
		))
		return
	}
	if !emit("sources.ready", map[string]any{
		"knowledgeState": knowledgeStateFor(evidenceState), "evidenceState": evidenceState,
		"providedSourceCount": len(answer.sources), "rewriteFallback": trace.RewriteFallback,
		"promptVersion": PromptVersion, "retrievalVersion": RetrievalVersion,
	}) || !emit("run.status", map[string]any{"status": "running", "phase": "answer"}) {
		return
	}
	service.streamTemporaryAnswer(ctx, stream, &sequence, execution, apiKey, policy, input,
		answer, summarySource, evidenceState, trace)
}

func validTemporarySummary(summary *temporarySummary) bool {
	for _, group := range [][]string{summary.ConfirmedFacts, summary.Corrections,
		summary.RejectedHypotheses, summary.UnresolvedQuestions} {
		for _, entry := range group {
			if strings.TrimSpace(entry) == "" {
				return false
			}
		}
	}
	return true
}

// The summary size contract (docs/16 §13.9) counts the UTF-8 bytes of the
// four arrays' entries — the same caliber the worker enforces before
// returning a summary — so JSON-encoding differences (Go escapes <>&) can
// never flip the verdict between the two ends.
func temporarySummaryBytes(summary *temporarySummary) int {
	total := 0
	for _, group := range [][]string{summary.ConfirmedFacts, summary.Corrections,
		summary.RejectedHypotheses, summary.UnresolvedQuestions} {
		for _, entry := range group {
			total += len(entry)
		}
	}
	return total
}

func temporarySummaryEntries(summary *temporarySummary) int {
	total := 0
	for _, group := range [][]string{summary.ConfirmedFacts, summary.Corrections,
		summary.RejectedHypotheses, summary.UnresolvedQuestions} {
		total += len(group)
	}
	return total
}

// History messages only answer the 256 KiB conversation total (docs/16
// §13.9): successful assistant answers may exceed the 32 KiB user-message cap.
func validTemporaryHistoryContent(content string) bool {
	return content != "" && utf8.ValidString(content) && strings.TrimSpace(content) != ""
}

type temporaryRewriteContext struct {
	summary  *temporarySummary
	messages []temporaryHistoryMessage
}

// trimTemporaryRewriteContext bounds the rewrite input by its real payload:
// the rewrite request carries no source block, so its budget reserves only the
// rewrite output cap instead of the answer's source allowance.
func trimTemporaryRewriteContext(contextWindow, maxOutputTokens int, content string,
	summary *temporarySummary, messages []temporaryHistoryMessage) *temporaryRewriteContext {
	outputCap := maxOutputTokens
	if outputCap > MaximumRewriteOutputTokens {
		outputCap = MaximumRewriteOutputTokens
	}
	budget := contextWindow - outputCap - systemPromptTokenEstimate - contextSafetyTokens
	trimmed := &temporaryRewriteContext{}
	if budget > 0 {
		budget -= estimateTokens(content)
		if budget > 0 {
			trimmed.summary, trimmed.messages = fillTemporaryContext(budget, summary, messages)
		}
	}
	return trimmed
}

type temporaryAnswerContext struct {
	summary  *temporarySummary
	messages []temporaryHistoryMessage
	sources  []retrievalCandidate
}

// trimTemporaryAnswerContext assembles the answer model input: the current
// question and the highest-ranked retrieved sources are reserved first, then
// the structured summary (only if it fits), then the most recent successful
// messages. Actual sources — not a frozen reservation for eight maximum
// sources — bound the history, so a small model with zero or few sources keeps
// the recent turns (docs/16 §10.2). The question itself is never trimmed here;
// the caller rejects an oversized question before the stream starts.
func trimTemporaryAnswerContext(contextWindow, maxOutputTokens int, content string,
	summary *temporarySummary, messages []temporaryHistoryMessage, snapshots []retrievalCandidate) *temporaryAnswerContext {
	budget := contextWindow - maxOutputTokens - systemPromptTokenEstimate - contextSafetyTokens
	if budget < 0 {
		budget = 0
	}
	budget -= estimateTokens(content)
	trimmed := &temporaryAnswerContext{sources: []retrievalCandidate{}, messages: []temporaryHistoryMessage{}}
	if budget < 0 {
		return trimmed
	}
	for _, candidate := range snapshots {
		cost := estimateTokens(candidate.Content) + estimateTokens(candidate.Title) + 8
		if cost > budget {
			break
		}
		budget -= cost
		trimmed.sources = append(trimmed.sources, candidate)
	}
	trimmed.summary, trimmed.messages = fillTemporaryContext(budget, summary, messages)
	return trimmed
}

// fillTemporaryContext spends the remaining budget on the summary (only when
// it fits) and then the most recent successful turns, newest pair first: only
// complete user+assistant pairs enter the context, so the model never sees an
// orphan assistant message whose question was dropped.
func fillTemporaryContext(budget int, summary *temporarySummary,
	messages []temporaryHistoryMessage) (*temporarySummary, []temporaryHistoryMessage) {
	var chosenSummary *temporarySummary
	if summary != nil {
		if encoded, err := jsonMarshal(summary); err == nil {
			if tokens := estimateTokens(string(encoded)); tokens < budget {
				budget -= tokens
				chosenSummary = summary
			}
		}
	}
	chosen := make([]temporaryHistoryMessage, 0, len(messages))
	for index := len(messages) - 1; index >= 1; index -= 2 {
		pairCost := estimateTokens(messages[index].Content) + 4 + estimateTokens(messages[index-1].Content) + 4
		if pairCost > budget {
			break
		}
		budget -= pairCost
		chosen = append(chosen, messages[index-1], messages[index])
	}
	// chosen is newest-pair-first with each pair in user,assistant order;
	// reverse the pair order to oldest-first.
	for left, right := 0, len(chosen)-2; left < right; left, right = left+2, right-2 {
		chosen[left], chosen[right] = chosen[right], chosen[left]
		chosen[left+1], chosen[right+1] = chosen[right+1], chosen[left+1]
	}
	return chosenSummary, chosen
}

type temporarySummarySource struct {
	Prior    *temporarySummary         `json:"prior"`
	Messages []temporaryHistoryMessage `json:"messages"`
}

// temporarySummarySourceFor freezes the rolling-summary maintenance input:
// with more than 16 successful messages in the request, everything except the
// most recent 16 is the uncovered prefix the next summary folds into the prior
// one (docs/16 §10.3). It derives from the raw request history, independent of
// any answer-side trimming.
func temporarySummarySourceFor(summary *temporarySummary, messages []temporaryHistoryMessage) *temporarySummarySource {
	if len(messages) <= SummaryMessageTrigger {
		return nil
	}
	prefix := make([]temporaryHistoryMessage, len(messages)-SummaryMessageTrigger)
	copy(prefix, messages[:len(messages)-SummaryMessageTrigger])
	return &temporarySummarySource{Prior: summary, Messages: prefix}
}

func temporaryModelPayload(execution lockedExecution, apiKey string) map[string]any {
	return map[string]any{
		"id": execution.modelID, "displayName": execution.modelDisplayName,
		"upstreamModelId": execution.upstreamModelID, "providerId": execution.providerID,
		"providerDisplayName": execution.providerDisplayName, "protocol": execution.protocol,
		"baseUrl": execution.baseURL, "apiKey": apiKey,
		"contextWindow": execution.contextWindow, "maxOutputTokens": execution.maxOutputTokens,
	}
}

// callTemporaryPrepare asks the worker for the rewritten query and its query
// embedding; a failed embedding only degrades this ephemeral run.
func (service *Service) callTemporaryPrepare(ctx context.Context, execution lockedExecution, apiKey string, embedding temporaryEmbeddingSnapshot, policy string, input temporaryStreamInput) (*temporaryPrepareResult, error) {
	payload := map[string]any{
		"model":           temporaryModelPayload(execution, apiKey),
		"embedding":       embedding,
		"reasoning":       "off",
		"sensitivePolicy": policy,
		"promptVersion":   PromptVersion,
		"summary":         input.Summary,
		"messages":        input.Messages,
		"question":        input.Content,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, maximumTemporaryPhaseWindow)
	defer cancel()
	internalRequest, err := http.NewRequestWithContext(requestCtx, http.MethodPost,
		service.workerURL+"/internal/assistant/temporary/prepare", bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	internalRequest.Header.Set("Content-Type", "application/json")
	internalRequest.Header.Set("Authorization", "Bearer "+service.internalServiceToken)
	workerResponse, err := service.httpClient.Do(internalRequest)
	if err != nil {
		return nil, err
	}
	defer workerResponse.Body.Close()
	body, err := io.ReadAll(io.LimitReader(workerResponse.Body, 1024*1024+1))
	if err != nil || len(body) > 1024*1024 || workerResponse.StatusCode != http.StatusOK {
		return nil, errTemporaryPrepareFailed
	}
	var result temporaryPrepareResult
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return nil, errTemporaryPrepareFailed
	}
	return &result, nil
}

var errTemporaryPrepareFailed = errors.New("temporary prepare failed")

type temporaryPrepareResult struct {
	Status      string    `json:"status"`
	Query       string    `json:"query"`
	QueryVector []float32 `json:"queryVector"`
	Rewrite     *struct {
		InputTokens  *int64 `json:"inputTokens"`
		OutputTokens *int64 `json:"outputTokens"`
		DurationMS   int64  `json:"durationMs"`
		Fallback     bool   `json:"fallback"`
	} `json:"rewrite"`
	EmbeddingDurationMS int64 `json:"embeddingDurationMs"`
}

// streamTemporaryAnswer proxies the worker's internal SSE to the browser,
// re-validating deltas and resolving citations inside the request.
func (service *Service) streamTemporaryAnswer(
	ctx context.Context,
	stream *sseWriter,
	sequence *int,
	execution lockedExecution,
	apiKey, policy string,
	input temporaryStreamInput,
	answer *temporaryAnswerContext,
	summarySource *temporarySummarySource,
	evidenceState string,
	trace temporaryRuntimeTrace,
) {
	emit := func(event string, payload map[string]any) bool {
		return writeTemporaryEvent(stream, sequence, event, payload)
	}
	citationCount := 0
	citationNumbers := map[int]int{}
	boundaryState := 0
	payloadSources := make([]retrievalSourcePayload, 0, len(answer.sources))
	for index, candidate := range answer.sources {
		var fragmentRef *uuid.UUID
		if candidate.FragmentID != uuid.Nil {
			fragmentRef = &candidate.FragmentID
		}
		itemRef := candidate.ItemID
		payloadSources = append(payloadSources, retrievalSourcePayload{
			Ordinal: index + 1, FragmentID: fragmentRef, ItemID: &itemRef,
			SourceKind: candidate.SourceKind, SourceClass: sourceClass(candidate.SourceKind),
			Title: candidate.Title, Content: candidate.Content, Sensitivity: candidate.Sensitivity,
		})
	}
	internalPayload := map[string]any{
		"model":           temporaryModelPayload(execution, apiKey),
		"reasoning":       input.Reasoning,
		"sensitivePolicy": policy,
		"promptVersion":   PromptVersion,
		"summary":         answer.summary,
		"messages":        answer.messages,
		"summarySource":   summarySource,
		"question":        input.Content,
		"evidenceState":   evidenceState,
		"knowledgeState":  knowledgeStateFor(evidenceState),
		"sources":         payloadSources,
	}
	encoded, err := json.Marshal(internalPayload)
	if err != nil {
		_ = emit("run.failed", tracedTemporaryTerminalPayload(
			"failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "内部请求失败", trace, service.now().UTC(),
		))
		return
	}
	// The public request context drives this request: refresh, navigation or
	// AbortController cancellation propagates to the worker and its provider
	// call (docs/16 §12).
	internalRequest, err := http.NewRequestWithContext(ctx, http.MethodPost,
		service.workerURL+"/internal/assistant/temporary/stream", bytes.NewReader(encoded))
	if err != nil {
		_ = emit("run.failed", tracedTemporaryTerminalPayload(
			"failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "内部请求失败", trace, service.now().UTC(),
		))
		return
	}
	internalRequest.Header.Set("Content-Type", "application/json")
	internalRequest.Header.Set("Authorization", "Bearer "+service.internalServiceToken)
	workerResponse, err := service.httpClient.Do(internalRequest)
	if err != nil {
		if temporaryPolicyChanged(ctx) {
			_ = emit("run.failed", tracedTemporaryTerminalPayload(
				"failed", "ASSISTANT_SENSITIVE_POLICY_CHANGED", "全局敏感策略已收紧", trace, service.now().UTC(),
			))
			return
		}
		if ctx.Err() != nil {
			// The browser cancelled; nothing left to stream.
			return
		}
		_ = emit("run.failed", tracedTemporaryTerminalPayload(
			"failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "内部请求失败", trace, service.now().UTC(),
		))
		return
	}
	defer workerResponse.Body.Close()
	if workerResponse.StatusCode != http.StatusOK {
		_ = emit("run.failed", tracedTemporaryTerminalPayload(
			"failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "内部请求失败", trace, service.now().UTC(),
		))
		return
	}
	reader := bufio.NewReaderSize(workerResponse.Body, 64*1024)
	terminalSent := false
	contentSoFar := ""
	for {
		eventType, data, readErr := readSSEEvent(reader)
		if readErr != nil {
			break
		}
		var payload map[string]any
		if json.Unmarshal([]byte(data), &payload) != nil {
			break
		}
		switch eventType {
		case "run.status", "reasoning.delta", "reasoning.completed":
			if !emit(eventType, payload) {
				return
			}
		case "usage.updated":
			mergeTemporaryUsage(payload, trace)
			if !emit(eventType, payload) {
				return
			}
		case "answer.delta":
			delta, _ := payload["delta"].(string)
			combined, scanErr := citationBoundaryScanWithState(contentSoFar, boundaryState, delta)
			if scanErr != nil {
				_ = emit("run.failed", tracedTemporaryTerminalPayload(
					"failed", "ASSISTANT_CITATION_INVALID", "回答包含无效引用", trace, service.now().UTC(),
				))
				return
			}
			contentSoFar = combined
			boundaryState = trailingBracketCount(contentSoFar)
			if !emit("answer.delta", payload) {
				return
			}
		case "answer.citation":
			ordinalValue, _ := payload["sourceOrdinal"].(float64)
			ordinal := int(ordinalValue)
			if ordinal < 1 || ordinal > len(payloadSources) {
				_ = emit("run.failed", tracedTemporaryTerminalPayload(
					"failed", "ASSISTANT_CITATION_INVALID", "回答包含无效引用", trace, service.now().UTC(),
				))
				return
			}
			citationNumber, seen := citationNumbers[ordinal]
			if !seen {
				citationCount++
				citationNumber = citationCount
				citationNumbers[ordinal] = citationNumber
			}
			payload["citationNumber"] = citationNumber
			payload["token"] = "[[C" + itoa(citationNumber) + "]]"
			payload["source"] = temporarySourceDTO(payloadSources[ordinal-1], citationNumber)
			if !emit("answer.citation", payload) {
				return
			}
		case "run.completed", "run.stopped", "run.failed":
			if terminalSent {
				return
			}
			terminalSent = true
			mergeTemporaryUsage(payload, trace)
			mergeTemporaryTimings(payload, trace, service.now().UTC())
			_ = emit(eventType, payload)
			return
		}
	}
	if !terminalSent {
		if temporaryPolicyChanged(ctx) {
			_ = emit("run.failed", tracedTemporaryTerminalPayload(
				"failed", "ASSISTANT_SENSITIVE_POLICY_CHANGED", "全局敏感策略已收紧", trace, service.now().UTC(),
			))
			return
		}
		if ctx.Err() == nil {
			_ = emit("run.failed", tracedTemporaryTerminalPayload(
				"failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "回答流中断", trace, service.now().UTC(),
			))
		}
	}
}

func writeTemporaryEvent(stream *sseWriter, sequence *int, event string, payload map[string]any) bool {
	*sequence++
	publicPayload := make(map[string]any, len(payload)+1)
	for key, value := range payload {
		publicPayload[key] = value
	}
	publicPayload["sequence"] = *sequence
	return stream.writeID(event, itoa(*sequence), publicPayload) == nil
}

func mergeTemporaryUsage(payload map[string]any, trace temporaryRuntimeTrace) {
	usage, ok := payload["usage"].(map[string]any)
	if !ok {
		usage = emptyTemporaryUsage()
		payload["usage"] = usage
	}
	usage["rewriteInputTokens"] = trace.RewriteInputTokens
	usage["rewriteOutputTokens"] = trace.RewriteOutputTokens
}

func mergeTemporaryTimings(payload map[string]any, trace temporaryRuntimeTrace, finishedAt time.Time) {
	timings, ok := payload["timings"].(map[string]any)
	if !ok {
		timings = emptyTemporaryTimings()
		payload["timings"] = timings
	}
	timings["rewriteMs"] = trace.RewriteMS
	timings["embeddingMs"] = trace.EmbeddingMS
	timings["retrievalMs"] = trace.RetrievalMS
	timings["totalMs"] = finishedAt.Sub(trace.StartedAt).Milliseconds()
}

func tracedTemporaryTerminalPayload(
	status, code, message string,
	trace temporaryRuntimeTrace,
	finishedAt time.Time,
) map[string]any {
	payload := temporaryTerminalPayload(status, code, message, nil, nil)
	mergeTemporaryUsage(payload, trace)
	mergeTemporaryTimings(payload, trace, finishedAt)
	return payload
}

func (service *Service) registerTemporaryRun(parent context.Context, policy string) (context.Context, func()) {
	ctx, cancel := context.WithCancelCause(parent)
	service.temporaryMu.Lock()
	if service.temporaryRuns == nil {
		service.temporaryRuns = make(map[uint64]temporaryRunRegistration)
	}
	service.temporarySequence++
	id := service.temporarySequence
	service.temporaryRuns[id] = temporaryRunRegistration{policy: policy, cancel: cancel}
	service.temporaryMu.Unlock()
	return ctx, func() {
		service.temporaryMu.Lock()
		delete(service.temporaryRuns, id)
		service.temporaryMu.Unlock()
		cancel(nil)
	}
}

func (service *Service) cancelTemporaryRuns(currentPolicy string) {
	currentRank := sensitivePolicyRank(currentPolicy)
	cancellations := make([]context.CancelCauseFunc, 0)
	service.temporaryMu.Lock()
	for _, run := range service.temporaryRuns {
		if sensitivePolicyRank(run.policy) < currentRank {
			cancellations = append(cancellations, run.cancel)
		}
	}
	service.temporaryMu.Unlock()
	for _, cancel := range cancellations {
		cancel(errTemporarySensitivePolicyChanged)
	}
}

func temporaryPolicyChanged(ctx context.Context) bool {
	return errors.Is(context.Cause(ctx), errTemporarySensitivePolicyChanged)
}

func temporaryInputMatchesSensitivePattern(input temporaryStreamInput) bool {
	if contentMatchesSensitivePattern(input.Content) {
		return true
	}
	if input.Summary != nil {
		encoded, err := json.Marshal(input.Summary)
		if err != nil || contentMatchesSensitivePattern(string(encoded)) {
			return true
		}
	}
	for _, message := range input.Messages {
		if contentMatchesSensitivePattern(message.Content) {
			return true
		}
	}
	return false
}

func emptyTemporaryUsage() map[string]any {
	return map[string]any{
		"rewriteInputTokens": nil, "rewriteOutputTokens": nil,
		"answerInputTokens": nil, "answerOutputTokens": nil,
		"answerContextTokens": nil,
	}
}

func emptyTemporaryTimings() map[string]any {
	return map[string]any{
		"rewriteMs": nil, "embeddingMs": nil, "retrievalMs": nil,
		"reasoningMs": nil, "answerMs": nil, "totalMs": nil,
	}
}

func knowledgeStateFor(evidenceState string) string {
	if evidenceState == "unavailable" {
		return "unavailable"
	}
	return "ready"
}

func temporarySourceDTO(payload retrievalSourcePayload, citationNumber int) map[string]any {
	locator := map[string]any{"itemId": payload.ItemID, "href": "/items/" + payload.ItemID.String()}
	if payload.FragmentID != nil {
		locator["fragmentId"] = payload.FragmentID
	}
	excerpt := payload.Content
	return map[string]any{
		"sourceOrdinal": payload.Ordinal, "citationNumber": citationNumber,
		"sourceKind": payload.SourceKind, "sourceClass": payload.SourceClass,
		"title": payload.Title, "availability": "available",
		"currentTitle": payload.Title, "titleChanged": false,
		"excerpt": excerpt, "locator": locator,
	}
}

func temporaryTerminalPayload(status, code, message string, usage, timings any) map[string]any {
	payload := map[string]any{"status": status, "temporarySummary": nil}
	if code != "" {
		payload["error"] = map[string]any{"code": code, "message": message}
	} else {
		payload["error"] = nil
	}
	if usage == nil {
		usage = emptyTemporaryUsage()
	}
	if timings == nil {
		timings = emptyTemporaryTimings()
	}
	payload["usage"] = usage
	payload["timings"] = timings
	return payload
}

// readSSEEvent reads one event block from the worker's internal stream.
func readSSEEvent(reader *bufio.Reader) (string, string, error) {
	eventType := ""
	data := strings.Builder{}
	for {
		line, err := reader.ReadString('\n')
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(trimmed, "event: ") {
			eventType = strings.TrimPrefix(trimmed, "event: ")
		} else if strings.HasPrefix(trimmed, "data: ") {
			data.WriteString(strings.TrimPrefix(trimmed, "data: "))
		} else if trimmed == "" {
			if eventType != "" || data.Len() > 0 {
				return eventType, data.String(), nil
			}
			if err != nil {
				return "", "", err
			}
			continue
		}
		if err != nil {
			if eventType != "" || data.Len() > 0 {
				return eventType, data.String(), nil
			}
			return "", "", err
		}
	}
}

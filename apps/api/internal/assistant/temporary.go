package assistant

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

const maximumTemporaryPhaseWindow = 60 * time.Second

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

// temporaryStream executes the whole ephemeral flow inside one HTTP request:
// validation, model snapshot, optional rewrite+retrieval through the worker,
// and a proxied answer stream. Nothing chat-related is persisted.
func (service *Service) temporaryStream(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input temporaryStreamInput
	if httpapi.DecodeJSON(response, request, MaximumTemporaryHistoryBytes+MaximumUserMessageBytes+16*1024, &input) != nil {
		writeValidationError(response, request)
		return
	}
	if !validReasoningValue(input.Reasoning) || !validUserContent(input.Content) ||
		len(input.Messages) > MaximumTemporaryHistory {
		writeValidationError(response, request)
		return
	}
	totalHistory := 0
	expectedRole := "user"
	for index, message := range input.Messages {
		if message.Role != expectedRole || !validUserContent(message.Content) {
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
	if len(input.Messages)%2 != 0 || totalHistory > MaximumTemporaryHistoryBytes {
		writeValidationError(response, request)
		return
	}
	for index, message := range input.Messages {
		if message.Role == "assistant" {
			input.Messages[index].Content = stripCitationTokens(message.Content)
		}
	}
	if input.Summary != nil && !validTemporarySummary(input.Summary) {
		writeValidationError(response, request)
		return
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
	policy, err := service.loadSensitivePolicy(ctx, tx)
	if err != nil {
		tx.Rollback(ctx)
		writeAssistantInternalFailure(response, request)
		return
	}
	if policy == "block" && contentMatchesSensitivePattern(input.Content) {
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
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	apiKey, err := secretbox.Open(service.masterKey, apiKeyCiphertext)
	if err != nil {
		writeAssistantProviderCredentialsInvalid(response, request)
		return
	}
	computation, err := service.computeIndexStatus(ctx, service.database)
	knowledgeReady := err == nil && computation.status == "ready"
	// Model preference update is best-effort and never blocks the stream.
	_, _ = service.database.Exec(ctx, `
		INSERT INTO assistant_model_preferences (model_id, last_reasoning_effort, last_used_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (model_id) DO UPDATE SET
			last_reasoning_effort = EXCLUDED.last_reasoning_effort, last_used_at = EXCLUDED.last_used_at
	`, execution.modelID, reasoningOrNull(input.Reasoning), service.now().UTC())

	flusher, canFlush := response.(http.Flusher)
	if !canFlush {
		writeAssistantInternalFailure(response, request)
		return
	}
	controller := http.NewResponseController(response)
	_ = controller.SetWriteDeadline(time.Time{})
	response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store, no-transform")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	fmt.Fprint(response, "\n")
	flusher.Flush()

	stream := &sseWriter{writer: response, flusher: flusher}
	sequence := 0

	query := input.Content
	var queryVector []float32
	evidenceState := "unavailable"
	var snapshots []retrievalCandidate
	if knowledgeReady {
		prepare, prepareErr := service.callTemporaryPrepare(ctx, execution, apiKey, policy, input)
		if prepareErr == nil && prepare.Status == "ready" && len(prepare.QueryVector) > 0 {
			queryVector = prepare.QueryVector
			if strings.TrimSpace(prepare.Query) != "" {
				query = prepare.Query
			}
			candidates, retrieveErr := hybridRetrieve(ctx, service.database, config.Generation, policy, query, queryVector)
			if retrieveErr == nil {
				snapshots = buildSourceSnapshots(candidates, policy)
				evidenceState = "not_found"
				if len(snapshots) > 0 {
					evidenceState = "matched"
				}
			} else {
				snapshots = nil
				evidenceState = "unavailable"
			}
		}
	}
	service.streamTemporaryAnswer(ctx, stream, &sequence, execution, apiKey, policy, input, snapshots, evidenceState)
}

func validTemporarySummary(summary *temporarySummary) bool {
	total := 0
	for _, group := range [][]string{summary.ConfirmedFacts, summary.Corrections,
		summary.RejectedHypotheses, summary.UnresolvedQuestions} {
		total += len(group)
		for _, entry := range group {
			if strings.TrimSpace(entry) == "" {
				return false
			}
		}
	}
	return total <= MaximumSummaryEntries
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
func (service *Service) callTemporaryPrepare(ctx context.Context, execution lockedExecution, apiKey, policy string, input temporaryStreamInput) (*temporaryPrepareResult, error) {
	payload := map[string]any{
		"model":           temporaryModelPayload(execution, apiKey),
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
	sources []retrievalCandidate,
	evidenceState string,
) {
	emit := func(event string, payload any) bool {
		*sequence++
		return stream.writeID(event, itoa(*sequence), payload) == nil
	}
	citationCount := 0
	citationNumbers := map[int]int{}
	boundaryState := 0
	payloadSources := make([]retrievalSourcePayload, 0, len(sources))
	for index, candidate := range sources {
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
		"model":          temporaryModelPayload(execution, apiKey),
		"reasoning":      input.Reasoning,
		"sensitivePolicy": policy,
		"promptVersion":  PromptVersion,
		"summary":        input.Summary,
		"messages":       input.Messages,
		"question":       input.Content,
		"evidenceState":  evidenceState,
		"knowledgeState": knowledgeStateFor(evidenceState),
		"sources":        payloadSources,
	}
	encoded, err := json.Marshal(internalPayload)
	if err != nil {
		_ = emit("run.failed", temporaryTerminalPayload("failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "内部请求失败", nil, nil))
		return
	}
	// The public request context drives this request: refresh, navigation or
	// AbortController cancellation propagates to the worker and its provider
	// call (docs/16 §12).
	internalRequest, err := http.NewRequestWithContext(ctx, http.MethodPost,
		service.workerURL+"/internal/assistant/temporary/stream", bytes.NewReader(encoded))
	if err != nil {
		_ = emit("run.failed", temporaryTerminalPayload("failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "内部请求失败", nil, nil))
		return
	}
	internalRequest.Header.Set("Content-Type", "application/json")
	internalRequest.Header.Set("Authorization", "Bearer "+service.internalServiceToken)
	workerResponse, err := service.httpClient.Do(internalRequest)
	if err != nil {
		if ctx.Err() != nil {
			// The browser cancelled; nothing left to stream.
			return
		}
		_ = emit("run.failed", temporaryTerminalPayload("failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "内部请求失败", nil, nil))
		return
	}
	defer workerResponse.Body.Close()
	if workerResponse.StatusCode != http.StatusOK {
		_ = emit("run.failed", temporaryTerminalPayload("failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "内部请求失败", nil, nil))
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
		case "run.status", "reasoning.delta", "reasoning.completed", "usage.updated":
			if !emit(eventType, payload) {
				return
			}
		case "answer.delta":
			delta, _ := payload["delta"].(string)
			combined, scanErr := citationBoundaryScanWithState(contentSoFar, boundaryState, delta)
			if scanErr != nil {
				_ = emit("run.failed", temporaryTerminalPayload("failed", "ASSISTANT_CITATION_INVALID", "回答包含无效引用", nil, nil))
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
				_ = emit("run.failed", temporaryTerminalPayload("failed", "ASSISTANT_CITATION_INVALID", "回答包含无效引用", nil, nil))
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
			_ = emit(eventType, payload)
			return
		}
	}
	if !terminalSent {
		_ = emit("run.failed", temporaryTerminalPayload("failed", "ASSISTANT_PROVIDER_UNAVAILABLE", "回答流中断", nil, nil))
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

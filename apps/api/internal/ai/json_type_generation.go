package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

const (
	maximumJSONAIRequestBytes = 256 * 1024
	maximumJSONAIWorkerBytes  = 320 * 1024
	maximumJSONAICodeBytes    = 256 * 1024
	jsonAIGenerationTimeout   = 30 * time.Second
	jsonAIPromptVersion       = "json-type-generation-v1"
)

type jsonAIRequest struct {
	ProviderID     string          `json:"providerId"`
	ModelID        string          `json:"modelId"`
	TargetLanguage string          `json:"targetLanguage"`
	Mode           string          `json:"mode"`
	Input          json.RawMessage `json:"input"`
}

type jsonAIProviderSnapshot struct {
	Protocol        string `json:"protocol"`
	BaseURL         string `json:"baseUrl"`
	APIKey          string `json:"apiKey"`
	ModelID         string `json:"modelId"`
	ContextWindow   int    `json:"contextWindow"`
	MaxOutputTokens int    `json:"maxOutputTokens"`
}

type jsonAIWorkerRequest struct {
	TargetLanguage string                 `json:"targetLanguage"`
	Mode           string                 `json:"mode"`
	Input          json.RawMessage        `json:"input"`
	Provider       jsonAIProviderSnapshot `json:"provider"`
	DeadlineAt     time.Time              `json:"deadlineAt"`
}

type jsonAIUsage struct {
	InputTokens  int64 `json:"inputTokens"`
	OutputTokens int64 `json:"outputTokens"`
}

type jsonAIWorkerResponse struct {
	Code          string       `json:"code"`
	PromptVersion string       `json:"promptVersion"`
	Usage         *jsonAIUsage `json:"usage"`
	Error         *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (service *Service) generateJSONTypesWithAI(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	deadline := service.now().UTC().Add(jsonAIGenerationTimeout)
	var input jsonAIRequest
	if httpapi.DecodeJSON(response, request, maximumJSONAIRequestBytes, &input) != nil || !validJSONAIRequest(input) {
		writeJSONAIError(response, request, http.StatusBadRequest, "INVALID_INPUT", "JSON 类型生成请求无效")
		return
	}
	providerID, providerErr := uuid.Parse(input.ProviderID)
	modelID, modelErr := uuid.Parse(input.ModelID)
	if providerErr != nil || modelErr != nil {
		writeJSONAIError(response, request, http.StatusBadRequest, "INVALID_INPUT", "Provider 或模型标识无效")
		return
	}

	var snapshot jsonAIProviderSnapshot
	var ciphertext []byte
	err := service.database.QueryRow(request.Context(), `
		SELECT provider.protocol, provider.base_url, provider.api_key_ciphertext,
		       model.model_id, model.context_window, model.max_output_tokens
		FROM provider_configs provider
		JOIN provider_models model ON model.provider_config_id = provider.id
		WHERE provider.id = $1 AND model.id = $2
		  AND provider.deleted_at IS NULL AND model.deleted_at IS NULL
		  AND provider.enabled AND model.enabled
		  AND provider.api_key_ciphertext IS NOT NULL
		  AND model.context_window IS NOT NULL AND model.context_window > 0
		  AND model.max_output_tokens IS NOT NULL AND model.max_output_tokens > 0
	`, providerID, modelID).Scan(
		&snapshot.Protocol, &snapshot.BaseURL, &ciphertext, &snapshot.ModelID,
		&snapshot.ContextWindow, &snapshot.MaxOutputTokens,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONAIError(response, request, http.StatusUnprocessableEntity, "AI_MODEL_UNAVAILABLE", "所选 Provider 或模型不可用")
		return
	}
	if err != nil {
		writeJSONAIInternal(response, request)
		return
	}
	snapshot.APIKey, err = secretbox.Open(service.masterKey, ciphertext)
	if err != nil {
		writeJSONAIInternal(response, request)
		return
	}

	encoded, err := encodeJSONAIWorkerRequest(jsonAIWorkerRequest{
		TargetLanguage: input.TargetLanguage,
		Mode:           input.Mode,
		Input:          input.Input,
		Provider:       snapshot,
		DeadlineAt:     deadline,
	})
	if err != nil {
		writeJSONAIInternal(response, request)
		return
	}
	ctx, cancel := context.WithDeadline(request.Context(), deadline)
	defer cancel()
	workerRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		service.workerURL+"/internal/v2/json-type-generation",
		bytes.NewReader(encoded),
	)
	if err != nil {
		writeJSONAIUnavailable(response, request)
		return
	}
	workerRequest.Header.Set("Content-Type", "application/json")
	workerRequest.Header.Set("Authorization", "Bearer "+service.internalServiceToken)
	workerResponse, err := service.httpClient.Do(workerRequest)
	if err != nil {
		writeJSONAIUnavailable(response, request)
		return
	}
	defer workerResponse.Body.Close()
	body, err := io.ReadAll(io.LimitReader(workerResponse.Body, maximumJSONAIWorkerBytes+1))
	if err != nil || len(body) > maximumJSONAIWorkerBytes {
		writeJSONAIUnavailable(response, request)
		return
	}
	result, err := decodeJSONAIWorkerResponse(body)
	if err != nil {
		writeJSONAIUnavailable(response, request)
		return
	}
	if workerResponse.StatusCode != http.StatusOK {
		writeJSONAIWorkerError(response, request, workerResponse.StatusCode, result)
		return
	}
	if result.Error != nil || result.Code == "" || len([]byte(result.Code)) > maximumJSONAICodeBytes ||
		result.PromptVersion != jsonAIPromptVersion || result.Usage != nil && (result.Usage.InputTokens < 0 || result.Usage.OutputTokens < 0) {
		writeJSONAIUnavailable(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{
		"code": result.Code, "language": input.TargetLanguage,
		"promptVersion": result.PromptVersion, "usage": result.Usage,
	})
}

func validJSONAIRequest(input jsonAIRequest) bool {
	if (input.Mode != "structure" && input.Mode != "full") || !validJSONAITargetLanguage(input.TargetLanguage) || len(input.Input) == 0 {
		return false
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(input.Input))
	decoder.UseNumber()
	return decoder.Decode(&value) == nil && decoder.Decode(&struct{}{}) == io.EOF
}

func validJSONAITargetLanguage(value string) bool {
	if strings.TrimSpace(value) != value || !utf8.ValidString(value) {
		return false
	}
	count := 0
	for _, character := range value {
		count++
		if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) || character == '\u2028' || character == '\u2029' {
			return false
		}
	}
	return count >= 1 && count <= 50
}

func encodeJSONAIWorkerRequest(input jsonAIWorkerRequest) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(input); err != nil || buffer.Len() > maximumJSONAIWorkerBytes {
		return nil, errors.New("JSON AI internal request is too large")
	}
	return buffer.Bytes(), nil
}

func decodeJSONAIWorkerResponse(body []byte) (jsonAIWorkerResponse, error) {
	var result jsonAIWorkerResponse
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return jsonAIWorkerResponse{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return jsonAIWorkerResponse{}, errors.New("invalid JSON AI worker response")
	}
	return result, nil
}

func writeJSONAIWorkerError(response http.ResponseWriter, request *http.Request, status int, result jsonAIWorkerResponse) {
	if result.Error == nil {
		writeJSONAIUnavailable(response, request)
		return
	}
	expectedStatus := map[string]int{
		"INVALID_INPUT":        http.StatusBadRequest,
		"AI_CONTEXT_TOO_LARGE": http.StatusUnprocessableEntity,
		"UPSTREAM_REJECTED":    http.StatusBadGateway,
		"UPSTREAM_UNAVAILABLE": http.StatusServiceUnavailable,
	}[result.Error.Code]
	if status != expectedStatus {
		writeJSONAIUnavailable(response, request)
		return
	}
	switch result.Error.Code {
	case "INVALID_INPUT":
		writeJSONAIError(response, request, http.StatusBadRequest, "INVALID_INPUT", "JSON 类型生成请求无效")
	case "AI_CONTEXT_TOO_LARGE":
		writeJSONAIError(response, request, http.StatusUnprocessableEntity, "AI_CONTEXT_TOO_LARGE", "当前模型容量不足，请选择更大模型或结构模式")
	case "UPSTREAM_REJECTED":
		writeJSONAIError(response, request, http.StatusBadGateway, "UPSTREAM_REJECTED", "Provider 拒绝了类型生成请求")
	case "UPSTREAM_UNAVAILABLE":
		writeJSONAIError(response, request, http.StatusServiceUnavailable, "UPSTREAM_UNAVAILABLE", "Provider 暂时不可用")
	default:
		writeJSONAIUnavailable(response, request)
	}
}

func writeJSONAIError(response http.ResponseWriter, request *http.Request, status int, code, message string) {
	httpapi.WriteError(response, request, status, code, message)
}

func writeJSONAIUnavailable(response http.ResponseWriter, request *http.Request) {
	writeJSONAIError(response, request, http.StatusServiceUnavailable, "UPSTREAM_UNAVAILABLE", "AI 类型生成服务暂时不可用")
}

func writeJSONAIInternal(response http.ResponseWriter, request *http.Request) {
	writeJSONAIError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "AI 类型生成服务暂时不可用")
}

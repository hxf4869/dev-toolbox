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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

type modelInput struct {
	ModelID         string `json:"modelId"`
	DisplayName     string `json:"displayName"`
	ContextWindow   *int   `json:"contextWindow"`
	MaxOutputTokens *int   `json:"maxOutputTokens"`
	SupportsTools   bool   `json:"supportsTools"`
	SupportsVision  bool   `json:"supportsVision"`
	Enabled         *bool  `json:"enabled"`
}

type modelEntry struct {
	ID              uuid.UUID `json:"id"`
	ProviderID      uuid.UUID `json:"providerId"`
	ModelID         string    `json:"modelId"`
	DisplayName     string    `json:"displayName"`
	ContextWindow   *int      `json:"contextWindow"`
	MaxOutputTokens *int      `json:"maxOutputTokens"`
	SupportsTools   bool      `json:"supportsTools"`
	SupportsVision  bool      `json:"supportsVision"`
	Enabled         bool      `json:"enabled"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type providerEntry struct {
	ID          uuid.UUID    `json:"id"`
	ProviderKey string       `json:"providerKey"`
	DisplayName string       `json:"displayName"`
	Protocol    string       `json:"protocol"`
	BaseURL     string       `json:"baseUrl"`
	HasAPIKey   bool         `json:"hasApiKey"`
	APIKeyMask  *string      `json:"apiKeyMask"`
	Enabled     bool         `json:"enabled"`
	Models      []modelEntry `json:"models"`
	CreatedAt   time.Time    `json:"createdAt"`
	UpdatedAt   time.Time    `json:"updatedAt"`
}

func (service *Service) listProviders(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	rows, err := service.database.Query(request.Context(), `
		SELECT id, provider_key, display_name, protocol, base_url,
		       api_key_ciphertext IS NOT NULL, api_key_tail, enabled, created_at, updated_at
		FROM provider_configs WHERE deleted_at IS NULL ORDER BY display_name, id
	`)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	providers := make([]providerEntry, 0)
	for rows.Next() {
		var entry providerEntry
		var tail *string
		if err := rows.Scan(&entry.ID, &entry.ProviderKey, &entry.DisplayName, &entry.Protocol, &entry.BaseURL,
			&entry.HasAPIKey, &tail, &entry.Enabled, &entry.CreatedAt, &entry.UpdatedAt); err != nil {
			rows.Close()
			writeProviderInternal(response, request)
			return
		}
		if tail != nil {
			masked := "•••• " + *tail
			entry.APIKeyMask = &masked
		}
		providers = append(providers, entry)
	}
	if rows.Err() != nil {
		rows.Close()
		writeProviderInternal(response, request)
		return
	}
	rows.Close()
	for index := range providers {
		providers[index].Models, err = service.modelsForProvider(request.Context(), providers[index].ID)
		if err != nil {
			writeProviderInternal(response, request)
			return
		}
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{
		"items": providers, "allowInsecureHttp": service.allowInsecureProviderHTTP,
	})
}

func (service *Service) createProvider(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input struct {
		ProviderKey string       `json:"providerKey"`
		DisplayName string       `json:"displayName"`
		Protocol    string       `json:"protocol"`
		BaseURL     string       `json:"baseUrl"`
		APIKey      string       `json:"apiKey"`
		Enabled     *bool        `json:"enabled"`
		Models      []modelInput `json:"models"`
	}
	if httpapi.DecodeJSON(response, request, 128*1024, &input) != nil || !validProviderKey(input.ProviderKey) ||
		!validProviderName(input.DisplayName) || !validProtocol(input.Protocol) || !validAPIKey(input.APIKey) {
		writeProviderValidation(response, request)
		return
	}
	baseURL, err := normalizeProviderBaseURL(input.BaseURL, service.allowInsecureProviderHTTP)
	if err != nil || len(input.Models) > 100 {
		writeProviderValidation(response, request)
		return
	}
	seenModels := map[string]struct{}{}
	for _, model := range input.Models {
		model.ModelID = strings.TrimSpace(model.ModelID)
		if !validModelInput(model) {
			writeProviderValidation(response, request)
			return
		}
		if _, duplicate := seenModels[model.ModelID]; duplicate {
			writeProviderValidation(response, request)
			return
		}
		seenModels[model.ModelID] = struct{}{}
	}
	ciphertext, err := secretbox.Seal(service.masterKey, input.APIKey)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	now := service.now().UTC()
	providerID := uuid.New()
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	if _, err := tx.Exec(request.Context(), `
		INSERT INTO provider_configs (
			id, provider_key, display_name, protocol, base_url, api_key_ciphertext,
			api_key_tail, enabled, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
	`, providerID, input.ProviderKey, strings.TrimSpace(input.DisplayName), input.Protocol,
		baseURL, ciphertext, keyTail(input.APIKey), enabled, now); err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			writeProviderValidation(response, request)
		} else {
			writeProviderInternal(response, request)
		}
		return
	}
	for _, model := range input.Models {
		if _, err := insertModel(request.Context(), tx, providerID, model, now); err != nil {
			writeProviderInternal(response, request)
			return
		}
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeProviderInternal(response, request)
		return
	}
	entry, err := service.loadProvider(request.Context(), providerID)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusCreated, entry)
}

func (service *Service) updateProvider(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeProviderNotFound(response, request)
		return
	}
	var input struct {
		DisplayName *string `json:"displayName"`
		Protocol    *string `json:"protocol"`
		BaseURL     *string `json:"baseUrl"`
		APIKey      *string `json:"apiKey"`
		Enabled     *bool   `json:"enabled"`
	}
	if httpapi.DecodeJSON(response, request, 32*1024, &input) != nil ||
		input.DisplayName == nil && input.Protocol == nil && input.BaseURL == nil && input.APIKey == nil && input.Enabled == nil {
		writeProviderValidation(response, request)
		return
	}
	var displayName, protocol, baseURL string
	var ciphertext []byte
	var tail *string
	var enabled bool
	err = service.database.QueryRow(request.Context(), `
		SELECT display_name, protocol, base_url, api_key_ciphertext, api_key_tail, enabled
		FROM provider_configs WHERE id = $1 AND deleted_at IS NULL
	`, id).Scan(&displayName, &protocol, &baseURL, &ciphertext, &tail, &enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		writeProviderNotFound(response, request)
		return
	}
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	if input.DisplayName != nil {
		if !validProviderName(*input.DisplayName) {
			writeProviderValidation(response, request)
			return
		}
		displayName = strings.TrimSpace(*input.DisplayName)
	}
	if input.Protocol != nil {
		if !validProtocol(*input.Protocol) {
			writeProviderValidation(response, request)
			return
		}
		protocol = *input.Protocol
	}
	if input.BaseURL != nil {
		baseURL, err = normalizeProviderBaseURL(*input.BaseURL, service.allowInsecureProviderHTTP)
		if err != nil {
			writeProviderValidation(response, request)
			return
		}
	}
	if input.APIKey != nil {
		if !validAPIKey(*input.APIKey) {
			writeProviderValidation(response, request)
			return
		}
		ciphertext, err = secretbox.Seal(service.masterKey, *input.APIKey)
		if err != nil {
			writeProviderInternal(response, request)
			return
		}
		value := keyTail(*input.APIKey)
		tail = &value
	}
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	now := service.now().UTC()
	if _, err := service.database.Exec(request.Context(), `
		UPDATE provider_configs SET display_name = $2, protocol = $3, base_url = $4,
		       api_key_ciphertext = $5, api_key_tail = $6, enabled = $7, updated_at = $8
		WHERE id = $1 AND deleted_at IS NULL
	`, id, displayName, protocol, baseURL, ciphertext, tail, enabled, now); err != nil {
		writeProviderInternal(response, request)
		return
	}
	entry, err := service.loadProvider(request.Context(), id)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, entry)
}

func (service *Service) deleteProvider(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeProviderNotFound(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var exists bool
	if err := tx.QueryRow(request.Context(), `SELECT true FROM provider_configs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		writeProviderNotFound(response, request)
		return
	} else if err != nil {
		writeProviderInternal(response, request)
		return
	}
	var inUse bool
	if err := tx.QueryRow(request.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM ai_task_runs task JOIN provider_models model ON model.id = task.model_id
			WHERE model.provider_config_id = $1 AND task.status IN ('queued', 'running')
		)
	`, id).Scan(&inUse); err != nil {
		writeProviderInternal(response, request)
		return
	}
	if inUse {
		httpapi.WriteError(response, request, http.StatusConflict, "PROVIDER_IN_USE", "Provider 正被运行中的任务使用")
		return
	}
	now := service.now().UTC()
	if _, err := tx.Exec(request.Context(), `UPDATE provider_models SET enabled = false, deleted_at = $2, updated_at = $2 WHERE provider_config_id = $1 AND deleted_at IS NULL`, id, now); err != nil {
		writeProviderInternal(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `
		UPDATE app_settings SET
			default_organize_model_id = CASE WHEN default_organize_model_id IN (SELECT id FROM provider_models WHERE provider_config_id = $1) THEN NULL ELSE default_organize_model_id END,
			default_review_model_id = CASE WHEN default_review_model_id IN (SELECT id FROM provider_models WHERE provider_config_id = $1) THEN NULL ELSE default_review_model_id END,
			default_vision_model_id = CASE WHEN default_vision_model_id IN (SELECT id FROM provider_models WHERE provider_config_id = $1) THEN NULL ELSE default_vision_model_id END,
			updated_at = $2 WHERE singleton
	`, id, now); err != nil {
		writeProviderInternal(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `
		UPDATE provider_configs SET enabled = false, api_key_ciphertext = NULL, api_key_tail = NULL,
		       deleted_at = $2, updated_at = $2 WHERE id = $1
	`, id, now); err != nil || tx.Commit(request.Context()) != nil {
		writeProviderInternal(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) testProvider(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	providerID, err := uuid.Parse(request.PathValue("id"))
	var input struct {
		ModelID string `json:"modelId"`
	}
	if err != nil || httpapi.DecodeJSON(response, request, 4096, &input) != nil {
		writeProviderValidation(response, request)
		return
	}
	modelID, err := uuid.Parse(input.ModelID)
	if err != nil {
		writeProviderValidation(response, request)
		return
	}
	var protocol, baseURL, upstreamModelID string
	var ciphertext []byte
	err = service.database.QueryRow(request.Context(), `
		SELECT provider.protocol, provider.base_url, provider.api_key_ciphertext, model.model_id
		FROM provider_configs provider JOIN provider_models model ON model.provider_config_id = provider.id
		WHERE provider.id = $1 AND model.id = $2 AND provider.deleted_at IS NULL
		  AND model.deleted_at IS NULL AND provider.enabled AND model.enabled
	`, providerID, modelID).Scan(&protocol, &baseURL, &ciphertext, &upstreamModelID)
	if errors.Is(err, pgx.ErrNoRows) || len(ciphertext) == 0 {
		writeProviderValidation(response, request)
		return
	}
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	apiKey, err := secretbox.Open(service.masterKey, ciphertext)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	deadline := service.now().UTC().Add(10 * time.Second)
	payload := map[string]any{
		"requestId":  httpapi.RequestIDFromContext(request.Context()),
		"provider":   map[string]any{"protocol": protocol, "baseUrl": baseURL, "apiKey": apiKey, "modelId": upstreamModelID},
		"deadlineAt": deadline,
	}
	encoded, _ := json.Marshal(payload)
	ctx, cancel := context.WithDeadline(request.Context(), deadline.Add(time.Second))
	defer cancel()
	internalRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, service.workerURL+"/internal/provider-test", bytes.NewReader(encoded))
	if err != nil {
		writeProviderUnavailable(response, request)
		return
	}
	internalRequest.Header.Set("Content-Type", "application/json")
	internalRequest.Header.Set("Authorization", "Bearer "+service.internalServiceToken)
	workerResponse, err := service.httpClient.Do(internalRequest)
	if err != nil {
		writeProviderUnavailable(response, request)
		return
	}
	defer workerResponse.Body.Close()
	body, err := io.ReadAll(io.LimitReader(workerResponse.Body, 64*1024+1))
	if err != nil || len(body) > 64*1024 {
		writeProviderUnavailable(response, request)
		return
	}
	var result struct {
		Status    string `json:"status"`
		LatencyMS int64  `json:"latencyMs"`
		Usage     *struct {
			InputTokens  int64 `json:"inputTokens"`
			OutputTokens int64 `json:"outputTokens"`
		} `json:"usage"`
		FailureCategory string `json:"failureCategory"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || decoder.Decode(&struct{}{}) != io.EOF || result.LatencyMS < 0 {
		writeProviderUnavailable(response, request)
		return
	}
	if workerResponse.StatusCode == http.StatusUnprocessableEntity && result.FailureCategory == "credentials_invalid" {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "AI_PROVIDER_CREDENTIALS_INVALID", "Provider 凭据被拒绝")
		return
	}
	if workerResponse.StatusCode != http.StatusOK || result.Status != "ok" {
		writeProviderUnavailable(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"status": "ok", "latencyMs": result.LatencyMS, "usage": result.Usage})
}

func (service *Service) loadProvider(ctx context.Context, id uuid.UUID) (providerEntry, error) {
	var entry providerEntry
	var tail *string
	err := service.database.QueryRow(ctx, `
		SELECT id, provider_key, display_name, protocol, base_url,
		       api_key_ciphertext IS NOT NULL, api_key_tail, enabled, created_at, updated_at
		FROM provider_configs WHERE id = $1 AND deleted_at IS NULL
	`, id).Scan(&entry.ID, &entry.ProviderKey, &entry.DisplayName, &entry.Protocol, &entry.BaseURL,
		&entry.HasAPIKey, &tail, &entry.Enabled, &entry.CreatedAt, &entry.UpdatedAt)
	if err != nil {
		return providerEntry{}, err
	}
	if tail != nil {
		value := "•••• " + *tail
		entry.APIKeyMask = &value
	}
	entry.Models, err = service.modelsForProvider(ctx, id)
	return entry, err
}

func (service *Service) modelsForProvider(ctx context.Context, providerID uuid.UUID) ([]modelEntry, error) {
	rows, err := service.database.Query(ctx, `
		SELECT id, provider_config_id, model_id, display_name, context_window, max_output_tokens,
		       supports_tools, supports_vision, enabled, created_at, updated_at
		FROM provider_models WHERE provider_config_id = $1 AND deleted_at IS NULL
		ORDER BY display_name, id
	`, providerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]modelEntry, 0)
	for rows.Next() {
		var entry modelEntry
		if err := rows.Scan(&entry.ID, &entry.ProviderID, &entry.ModelID, &entry.DisplayName,
			&entry.ContextWindow, &entry.MaxOutputTokens, &entry.SupportsTools, &entry.SupportsVision,
			&entry.Enabled, &entry.CreatedAt, &entry.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, entry)
	}
	return items, rows.Err()
}

func writeProviderValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Provider 配置无效")
}

func writeProviderNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "Provider 不存在")
}

func writeProviderUnavailable(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusServiceUnavailable, "AI_PROVIDER_UNAVAILABLE", "Provider 暂时不可用")
}

func writeProviderInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "Provider 服务暂时不可用")
}

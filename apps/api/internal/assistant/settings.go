package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/ai"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

// rowQuerier abstracts *pgxpool.Pool and pgx.Tx.
type rowQuerier interface {
	QueryRow(ctx context.Context, query string, args ...any) pgx.Row
	Query(ctx context.Context, query string, args ...any) (pgx.Rows, error)
}

// pgx_tx_default is the plain read-write transaction used by module handlers.
var pgx_tx_default = pgx.TxOptions{}

type embeddingConfigRow struct {
	Configured    bool
	DisplayName   *string
	BaseURL       *string
	HasAPIKey     bool
	APIKeyTail    *string
	ModelID       *string
	Dimensions    *int
	Enabled       bool
	Generation    int64
	Status        string
	LastErrorCode *string
	UpdatedAt     *time.Time
}

func (service *Service) loadEmbeddingConfig(ctx context.Context, querier rowQuerier) (embeddingConfigRow, error) {
	var row embeddingConfigRow
	err := querier.QueryRow(ctx, `
		SELECT base_url IS NOT NULL, display_name, base_url, api_key_ciphertext IS NOT NULL, api_key_tail,
		       model_id, dimensions, enabled, generation, status, last_error_code, updated_at
		FROM assistant_embedding_config WHERE singleton
	`).Scan(&row.Configured, &row.DisplayName, &row.BaseURL, &row.HasAPIKey, &row.APIKeyTail,
		&row.ModelID, &row.Dimensions, &row.Enabled, &row.Generation, &row.Status,
		&row.LastErrorCode, &row.UpdatedAt)
	return row, err
}

type embeddingSettingsDTO struct {
	Configured          bool       `json:"configured"`
	DisplayName         *string    `json:"displayName"`
	BaseURL             *string    `json:"baseUrl"`
	APIKeyConfigured    bool       `json:"apiKeyConfigured"`
	APIKeyTail          *string    `json:"apiKeyTail"`
	ModelID             *string    `json:"modelId"`
	Dimensions          *int       `json:"dimensions"`
	Enabled             bool       `json:"enabled"`
	Generation          *int64     `json:"generation"`
	Status              string     `json:"status"`
	ActiveFragmentCount int        `json:"activeFragmentCount"`
	UpdatedAt           *time.Time `json:"updatedAt"`
}

func (service *Service) getEmbeddingSettings(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	row, err := service.loadEmbeddingConfig(request.Context(), service.database)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	count, err := service.countEligibleFragments(request.Context(), service.database, row.Generation)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	writeEmbeddingSettingsDTO(response, request, row, count)
}

func writeEmbeddingSettingsDTO(response http.ResponseWriter, request *http.Request, row embeddingConfigRow, activeCount int) {
	dto := embeddingSettingsDTO{
		Configured: row.Configured, DisplayName: row.DisplayName, BaseURL: row.BaseURL,
		APIKeyConfigured: row.HasAPIKey, APIKeyTail: row.APIKeyTail, ModelID: row.ModelID,
		Dimensions: row.Dimensions, Enabled: row.Enabled, Status: row.Status,
		ActiveFragmentCount: activeCount, UpdatedAt: row.UpdatedAt,
	}
	if row.Configured {
		generation := row.Generation
		dto.Generation = &generation
	}
	httpapi.WriteJSON(response, http.StatusOK, dto)
}

type putEmbeddingSettingsInput struct {
	DisplayName    string  `json:"displayName"`
	BaseURL        string  `json:"baseUrl"`
	APIKey         *string `json:"apiKey"`
	ModelID        string  `json:"modelId"`
	Dimensions     *int    `json:"dimensions"`
	Enabled        bool    `json:"enabled"`
	ConfirmReindex bool    `json:"confirmReindex"`
}

func (service *Service) putEmbeddingSettings(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input putEmbeddingSettingsInput
	if httpapi.DecodeJSON(response, request, 32*1024, &input) != nil {
		writeValidationError(response, request)
		return
	}
	displayName := strings.TrimSpace(input.DisplayName)
	modelID := strings.TrimSpace(input.ModelID)
	if displayName == "" || !utf8.ValidString(displayName) || len([]rune(displayName)) > 120 ||
		input.Dimensions == nil || *input.Dimensions < 1 || *input.Dimensions > 16000 ||
		modelID == "" || len(modelID) > 200 {
		writeValidationError(response, request)
		return
	}
	baseURL, err := ai.NormalizeProviderBaseURL(input.BaseURL, service.allowInsecureProviderHTTP)
	if err != nil {
		writeValidationError(response, request)
		return
	}
	if input.APIKey != nil && (*input.APIKey == "" || strings.TrimSpace(*input.APIKey) != *input.APIKey) {
		writeValidationError(response, request)
		return
	}
	ctx := request.Context()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer tx.Rollback(ctx)
	var policy string
	if err := tx.QueryRow(ctx, `
		SELECT sensitive_ai_policy FROM app_settings WHERE singleton FOR SHARE
	`).Scan(&policy); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(ctx, `SELECT true FROM assistant_embedding_config WHERE singleton FOR UPDATE`); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	current, err := service.loadEmbeddingConfig(ctx, tx)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if !current.Configured && input.APIKey == nil {
		// First-time configuration must supply a key; null only keeps an existing one.
		writeValidationError(response, request)
		return
	}
	ciphertext, tail, err := sealEmbeddingKey(service.masterKey, input.APIKey)
	if err != nil {
		writeValidationError(response, request)
		return
	}
	if input.Enabled && ciphertext == nil && !current.HasAPIKey {
		writeEmbeddingConfigInvalid(response, request)
		return
	}
	connectionChanged := !current.Configured ||
		current.BaseURL == nil || *current.BaseURL != baseURL ||
		current.ModelID == nil || *current.ModelID != modelID ||
		current.Dimensions == nil || *current.Dimensions != *input.Dimensions
	enabledToggled := current.Configured && current.Enabled != input.Enabled
	needsReindex := connectionChanged || enabledToggled
	activeCount := 0
	if input.Enabled && needsReindex {
		activeCount, err = service.countEligibleFragments(ctx, tx, current.Generation+1)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		if activeCount > 0 && !input.ConfirmReindex {
			writeEmbeddingReindexConfirmationRequired(response, request)
			return
		}
	}
	generation := current.Generation
	if needsReindex {
		generation++
	}
	status := current.Status
	if !input.Enabled {
		status = "disabled"
	} else if needsReindex {
		status = "indexing"
	}
	now := service.now().UTC()
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_embedding_config SET
			base_url = $1, api_key_ciphertext = COALESCE($2, api_key_ciphertext),
			api_key_tail = COALESCE($3, api_key_tail), model_id = $4, display_name = $5,
			dimensions = $6, enabled = $7, generation = $8, status = $9,
			last_error_code = CASE WHEN $9 = 'failed' THEN last_error_code ELSE NULL END,
			updated_at = $10
		WHERE singleton
	`, baseURL, ciphertext, tail, modelID, displayName,
		*input.Dimensions, input.Enabled, generation, status, now); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if needsReindex && input.Enabled {
		if err := service.resetIndexForGeneration(ctx, tx, generation, policy, now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	} else if needsReindex {
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_fragment_embeddings SET state = 'excluded', embedding = NULL, dimensions = NULL,
			       lease_owner = NULL, lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
			       error_code = NULL, error_detail = NULL, updated_at = $1
			WHERE state <> 'excluded'
		`, now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	row, err := service.loadEmbeddingConfig(ctx, service.database)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	count, err := service.countEligibleFragments(ctx, service.database, row.Generation)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	writeEmbeddingSettingsDTO(response, request, row, count)
}

func sealEmbeddingKey(masterKey []byte, supplied *string) ([]byte, *string, error) {
	if supplied == nil {
		return nil, nil, nil
	}
	ciphertext, err := secretbox.Seal(masterKey, *supplied)
	if err != nil {
		return nil, nil, err
	}
	runes := []rune(*supplied)
	if len(runes) > 4 {
		runes = runes[len(runes)-4:]
	}
	tail := string(runes)
	return ciphertext, &tail, nil
}

func (service *Service) deleteEmbeddingSettings(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	ctx := request.Context()
	now := service.now().UTC()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT true FROM app_settings WHERE singleton FOR SHARE`); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(ctx, `SELECT true FROM assistant_embedding_config WHERE singleton FOR UPDATE`); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	current, err := service.loadEmbeddingConfig(ctx, tx)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_embedding_config SET base_url = NULL, api_key_ciphertext = NULL, api_key_tail = NULL,
		       model_id = NULL, display_name = NULL, dimensions = NULL, enabled = false,
		       generation = $1, status = 'unconfigured', last_error_code = NULL, updated_at = $2
		WHERE singleton
	`, current.Generation+1, now); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	// Invalidate in-flight leases by generation change and drop derived vectors.
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_fragment_embeddings SET embedding = NULL, dimensions = NULL,
		       state = 'excluded', lease_owner = NULL, lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		       error_code = NULL, error_detail = NULL, updated_at = $1
		WHERE state <> 'excluded'
	`, now); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

type embeddingTestInput struct {
	BaseURL    string  `json:"baseUrl"`
	APIKey     *string `json:"apiKey"`
	ModelID    string  `json:"modelId"`
	Dimensions int     `json:"dimensions"`
}

func (service *Service) testEmbeddingSettings(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input embeddingTestInput
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil ||
		input.Dimensions < 1 || input.Dimensions > 16000 || strings.TrimSpace(input.ModelID) == "" {
		writeEmbeddingConfigInvalid(response, request)
		return
	}
	baseURL, err := ai.NormalizeProviderBaseURL(input.BaseURL, service.allowInsecureProviderHTTP)
	if err != nil {
		writeEmbeddingConfigInvalid(response, request)
		return
	}
	apiKey := ""
	if input.APIKey != nil && *input.APIKey != "" {
		apiKey = *input.APIKey
	} else {
		current, err := service.loadEmbeddingConfig(request.Context(), service.database)
		if err != nil || !current.HasAPIKey {
			writeEmbeddingConfigInvalid(response, request)
			return
		}
		apiKey, err = service.loadEmbeddingKey(request.Context())
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if strings.TrimSpace(apiKey) == "" {
		writeEmbeddingConfigInvalid(response, request)
		return
	}
	result, err := service.callEmbeddingTest(request.Context(), baseURL, apiKey, strings.TrimSpace(input.ModelID), input.Dimensions)
	if err != nil {
		writeEmbeddingProviderUnavailable(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, result)
}

func (service *Service) loadEmbeddingKey(ctx context.Context) (string, error) {
	var ciphertext []byte
	if err := service.database.QueryRow(ctx,
		`SELECT api_key_ciphertext FROM assistant_embedding_config WHERE singleton`).Scan(&ciphertext); err != nil {
		return "", err
	}
	return secretbox.Open(service.masterKey, ciphertext)
}

type embeddingUsage struct {
	InputTokens *int64 `json:"inputTokens"`
	TotalTokens *int64 `json:"totalTokens"`
}

type embeddingTestResult struct {
	Status          string          `json:"status"`
	ActualDimension int             `json:"actualDimensions"`
	LatencyMS       int64           `json:"latencyMs"`
	Usage           *embeddingUsage `json:"usage"`
}

// callEmbeddingTest performs exactly one bounded probe call through the worker;
// no retries and nothing is persisted.
func (service *Service) callEmbeddingTest(ctx context.Context, baseURL, apiKey, modelID string, dimensions int) (*embeddingTestResult, error) {
	payload, _ := json.Marshal(map[string]any{
		"baseUrl": baseURL, "apiKey": apiKey, "modelId": modelID, "dimensions": dimensions,
	})
	requestCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	internalRequest, err := http.NewRequestWithContext(requestCtx, http.MethodPost,
		service.workerURL+"/internal/assistant/embedding-test", bytes.NewReader(payload))
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
	body, err := io.ReadAll(io.LimitReader(workerResponse.Body, 64*1024+1))
	if err != nil || len(body) > 64*1024 || workerResponse.StatusCode != http.StatusOK {
		return nil, errors.New("embedding test failed")
	}
	var result embeddingTestResult
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		result.Status != "ok" || result.ActualDimension < 1 {
		return nil, errors.New("embedding test invalid response")
	}
	return &result, nil
}

func (service *Service) loadSensitivePolicy(ctx context.Context, querier rowQuerier) (string, error) {
	var policy string
	err := querier.QueryRow(ctx, `SELECT sensitive_ai_policy FROM app_settings WHERE singleton`).Scan(&policy)
	return policy, err
}

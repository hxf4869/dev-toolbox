package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type modelExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type nullableIntPatch struct {
	Set   bool
	Value *int
}

func (value *nullableIntPatch) UnmarshalJSON(encoded []byte) error {
	value.Set = true
	if bytes.Equal(bytes.TrimSpace(encoded), []byte("null")) {
		value.Value = nil
		return nil
	}
	var decoded int
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return err
	}
	value.Value = &decoded
	return nil
}

func insertModel(ctx context.Context, executor modelExecutor, providerID uuid.UUID, input modelInput, now time.Time) (modelEntry, error) {
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	entry := modelEntry{
		ID: uuid.New(), ProviderID: providerID, ModelID: strings.TrimSpace(input.ModelID),
		DisplayName: strings.TrimSpace(input.DisplayName), ContextWindow: input.ContextWindow,
		MaxOutputTokens: input.MaxOutputTokens, SupportsTools: input.SupportsTools,
		SupportsVision: input.SupportsVision, Enabled: enabled,
	}
	_, err := executor.Exec(ctx, `
		INSERT INTO provider_models (
			id, provider_config_id, model_id, display_name, context_window, max_output_tokens,
			supports_tools, supports_vision, enabled, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
	`, entry.ID, providerID, entry.ModelID, entry.DisplayName, entry.ContextWindow,
		entry.MaxOutputTokens, entry.SupportsTools, entry.SupportsVision, entry.Enabled, now)
	return entry, err
}

func (service *Service) createModel(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	providerID, err := uuid.Parse(request.PathValue("id"))
	var input modelInput
	if err != nil || httpapi.DecodeJSON(response, request, 16*1024, &input) != nil || !validModelInput(input) {
		writeProviderValidation(response, request)
		return
	}
	var exists bool
	if err := service.database.QueryRow(request.Context(), `
		SELECT true FROM provider_configs WHERE id = $1 AND deleted_at IS NULL
	`, providerID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		writeProviderNotFound(response, request)
		return
	} else if err != nil {
		writeProviderInternal(response, request)
		return
	}
	now := service.now().UTC()
	entry, err := insertModel(request.Context(), service.database, providerID, input, now)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			writeProviderValidation(response, request)
		} else {
			writeProviderInternal(response, request)
		}
		return
	}
	entry.CreatedAt = now
	entry.UpdatedAt = now
	httpapi.WriteJSON(response, http.StatusCreated, entry)
}

func (service *Service) updateModel(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeModelNotFound(response, request)
		return
	}
	var input struct {
		ModelID         *string          `json:"modelId"`
		DisplayName     *string          `json:"displayName"`
		ContextWindow   nullableIntPatch `json:"contextWindow"`
		MaxOutputTokens nullableIntPatch `json:"maxOutputTokens"`
		SupportsTools   *bool            `json:"supportsTools"`
		SupportsVision  *bool            `json:"supportsVision"`
		Enabled         *bool            `json:"enabled"`
	}
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil ||
		input.ModelID == nil && input.DisplayName == nil && !input.ContextWindow.Set && !input.MaxOutputTokens.Set &&
			input.SupportsTools == nil && input.SupportsVision == nil && input.Enabled == nil {
		writeProviderValidation(response, request)
		return
	}
	var entry modelEntry
	err = service.database.QueryRow(request.Context(), `
		SELECT id, provider_config_id, model_id, display_name, context_window, max_output_tokens,
		       supports_tools, supports_vision, enabled, created_at, updated_at
		FROM provider_models WHERE id = $1 AND deleted_at IS NULL
	`, id).Scan(&entry.ID, &entry.ProviderID, &entry.ModelID, &entry.DisplayName, &entry.ContextWindow,
		&entry.MaxOutputTokens, &entry.SupportsTools, &entry.SupportsVision, &entry.Enabled,
		&entry.CreatedAt, &entry.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeModelNotFound(response, request)
		return
	}
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	if input.ModelID != nil {
		entry.ModelID = strings.TrimSpace(*input.ModelID)
	}
	if input.DisplayName != nil {
		entry.DisplayName = strings.TrimSpace(*input.DisplayName)
	}
	if input.ContextWindow.Set {
		entry.ContextWindow = input.ContextWindow.Value
	}
	if input.MaxOutputTokens.Set {
		entry.MaxOutputTokens = input.MaxOutputTokens.Value
	}
	if input.SupportsTools != nil {
		entry.SupportsTools = *input.SupportsTools
	}
	if input.SupportsVision != nil {
		entry.SupportsVision = *input.SupportsVision
	}
	if input.Enabled != nil {
		entry.Enabled = *input.Enabled
	}
	valid := modelInput{ModelID: entry.ModelID, DisplayName: entry.DisplayName, ContextWindow: entry.ContextWindow,
		MaxOutputTokens: entry.MaxOutputTokens, SupportsTools: entry.SupportsTools, SupportsVision: entry.SupportsVision}
	if !validModelInput(valid) {
		writeProviderValidation(response, request)
		return
	}
	entry.UpdatedAt = service.now().UTC()
	_, err = service.database.Exec(request.Context(), `
		UPDATE provider_models SET model_id = $2, display_name = $3, context_window = $4,
		       max_output_tokens = $5, supports_tools = $6, supports_vision = $7,
		       enabled = $8, updated_at = $9 WHERE id = $1 AND deleted_at IS NULL
	`, entry.ID, entry.ModelID, entry.DisplayName, entry.ContextWindow, entry.MaxOutputTokens,
		entry.SupportsTools, entry.SupportsVision, entry.Enabled, entry.UpdatedAt)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			writeProviderValidation(response, request)
		} else {
			writeProviderInternal(response, request)
		}
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, entry)
}

func (service *Service) deleteModel(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeModelNotFound(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var exists bool
	if err := tx.QueryRow(request.Context(), `SELECT true FROM provider_models WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		writeModelNotFound(response, request)
		return
	} else if err != nil {
		writeProviderInternal(response, request)
		return
	}
	var inUse bool
	if err := tx.QueryRow(request.Context(), `SELECT EXISTS (SELECT 1 FROM ai_task_runs WHERE model_id = $1 AND status IN ('queued', 'running'))`, id).Scan(&inUse); err != nil {
		writeProviderInternal(response, request)
		return
	}
	if inUse {
		httpapi.WriteError(response, request, http.StatusConflict, "PROVIDER_IN_USE", "模型正被运行中的任务使用")
		return
	}
	now := service.now().UTC()
	if _, err := tx.Exec(request.Context(), `
		UPDATE app_settings SET
			default_organize_model_id = NULLIF(default_organize_model_id, $1),
			default_review_model_id = NULLIF(default_review_model_id, $1),
			default_vision_model_id = NULLIF(default_vision_model_id, $1),
			schedule_organize_model_id = NULLIF(schedule_organize_model_id, $1),
			schedule_vision_model_id = NULLIF(schedule_vision_model_id, $1), updated_at = $2
		WHERE singleton
	`, id, now); err != nil {
		writeProviderInternal(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `UPDATE provider_models SET enabled = false, deleted_at = $2, updated_at = $2 WHERE id = $1`, id, now); err != nil || tx.Commit(request.Context()) != nil {
		writeProviderInternal(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func writeModelNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "模型不存在")
}

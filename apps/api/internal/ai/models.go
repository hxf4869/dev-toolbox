package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type modelExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// V3 reasoning options (docs/16 §7.2/§13.1): the six protocol values are the
// only allowed reasoning efforts; "off" is a built-in option and never stored.
var reasoningEffortPattern = map[string]bool{
	"minimal": true, "low": true, "medium": true, "high": true, "xhigh": true, "max": true,
}

type reasoningOptionInput struct {
	DisplayName string `json:"displayName"`
	Reasoning   string `json:"reasoning"`
	SortOrder   *int   `json:"sortOrder"`
}

type reasoningOptionEntry struct {
	Reasoning   string `json:"reasoning"`
	DisplayName string `json:"displayName"`
	SortOrder   int    `json:"sortOrder"`
}

func validReasoningOptions(options []reasoningOptionInput) ([]reasoningOptionInput, bool) {
	if len(options) > 6 {
		return nil, false
	}
	seenNames := map[string]struct{}{}
	seenReasonings := map[string]struct{}{}
	normalized := make([]reasoningOptionInput, 0, len(options))
	for _, option := range options {
		displayName := strings.TrimSpace(option.DisplayName)
		if displayName == "" || !utf8.ValidString(displayName) || len([]rune(displayName)) > 40 {
			return nil, false
		}
		if !reasoningEffortPattern[option.Reasoning] {
			return nil, false
		}
		if option.SortOrder == nil || *option.SortOrder < 0 || *option.SortOrder > 100 {
			return nil, false
		}
		nameKey := strings.ToLower(displayName)
		if _, duplicate := seenNames[nameKey]; duplicate {
			return nil, false
		}
		if _, duplicate := seenReasonings[option.Reasoning]; duplicate {
			return nil, false
		}
		seenNames[nameKey] = struct{}{}
		seenReasonings[option.Reasoning] = struct{}{}
		normalized = append(normalized, reasoningOptionInput{
			DisplayName: displayName, Reasoning: option.Reasoning, SortOrder: option.SortOrder,
		})
	}
	return normalized, true
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
		ReasoningOptions: []reasoningOptionEntry{},
	}
	_, err := executor.Exec(ctx, `
		INSERT INTO provider_models (
			id, provider_config_id, model_id, display_name, context_window, max_output_tokens,
			supports_tools, supports_vision, enabled, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
	`, entry.ID, providerID, entry.ModelID, entry.DisplayName, entry.ContextWindow,
		entry.MaxOutputTokens, entry.SupportsTools, entry.SupportsVision, entry.Enabled, now)
	if err != nil {
		return entry, err
	}
	for _, option := range input.ReasoningOptions {
		if _, err := executor.Exec(ctx, `
			INSERT INTO provider_model_reasoning_options (model_id, reasoning_effort, display_name, sort_order, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $5)
		`, entry.ID, option.Reasoning, option.DisplayName, *option.SortOrder, now); err != nil {
			return entry, err
		}
		entry.ReasoningOptions = append(entry.ReasoningOptions, reasoningOptionEntry{
			Reasoning: option.Reasoning, DisplayName: option.DisplayName, SortOrder: *option.SortOrder,
		})
	}
	sortReasoningOptions(entry.ReasoningOptions)
	return entry, err
}

func sortReasoningOptions(options []reasoningOptionEntry) {
	sort.SliceStable(options, func(left, right int) bool {
		if options[left].SortOrder != options[right].SortOrder {
			return options[left].SortOrder < options[right].SortOrder
		}
		return options[left].Reasoning < options[right].Reasoning
	})
}

func (service *Service) createModel(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	providerID, err := uuid.Parse(request.PathValue("id"))
	var input modelInput
	if err != nil || httpapi.DecodeJSON(response, request, 16*1024, &input) != nil || !validModelInput(input) {
		writeProviderValidation(response, request)
		return
	}
	if _, valid := validReasoningOptions(input.ReasoningOptions); !valid {
		writeProviderValidation(response, request)
		return
	}
	ctx := request.Context()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT true FROM provider_configs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE
	`, providerID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		writeProviderNotFound(response, request)
		return
	} else if err != nil {
		writeProviderInternal(response, request)
		return
	}
	now := service.now().UTC()
	entry, err := insertModel(ctx, tx, providerID, input, now)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			writeProviderValidation(response, request)
		} else {
			writeProviderInternal(response, request)
		}
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeProviderInternal(response, request)
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
		ModelID          *string                 `json:"modelId"`
		DisplayName      *string                 `json:"displayName"`
		ContextWindow    nullableIntPatch        `json:"contextWindow"`
		MaxOutputTokens  nullableIntPatch        `json:"maxOutputTokens"`
		SupportsTools    *bool                   `json:"supportsTools"`
		SupportsVision   *bool                   `json:"supportsVision"`
		Enabled          *bool                   `json:"enabled"`
		ReasoningOptions *[]reasoningOptionInput `json:"reasoningOptions"`
	}
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil ||
		input.ModelID == nil && input.DisplayName == nil && !input.ContextWindow.Set && !input.MaxOutputTokens.Set &&
			input.SupportsTools == nil && input.SupportsVision == nil && input.Enabled == nil && input.ReasoningOptions == nil {
		writeProviderValidation(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var entry modelEntry
	var providerID uuid.UUID
	err = tx.QueryRow(request.Context(), `
		SELECT id, provider_config_id, model_id, display_name, context_window, max_output_tokens,
		       supports_tools, supports_vision, enabled, created_at, updated_at
		FROM provider_models WHERE id = $1 AND deleted_at IS NULL
	`, id).Scan(&entry.ID, &providerID, &entry.ModelID, &entry.DisplayName, &entry.ContextWindow,
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
	// Fixed lock order shared with assistant run creation: provider_config then provider_model.
	if _, err := tx.Exec(request.Context(), `SELECT true FROM provider_configs WHERE id = $1 FOR UPDATE`, providerID); err != nil {
		writeProviderInternal(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `SELECT true FROM provider_models WHERE id = $1 FOR UPDATE`, id); err != nil {
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
	// Only execution-relevant changes block on queued assistant runs: upstream
	// model ID changes and disabling. Display/context/reasoningOptions never do.
	executionChanged := input.ModelID != nil || input.Enabled != nil && !*input.Enabled
	if executionChanged {
		modelID := id
		inUse, err := queuedAssistantRunsExist(request.Context(), tx, nil, &modelID)
		if err != nil {
			writeProviderInternal(response, request)
			return
		}
		if inUse {
			writeAssistantInUse(response, request)
			return
		}
	}
	entry.UpdatedAt = service.now().UTC()
	if _, err := tx.Exec(request.Context(), `
		UPDATE provider_models SET model_id = $2, display_name = $3, context_window = $4,
		       max_output_tokens = $5, supports_tools = $6, supports_vision = $7,
		       enabled = $8, updated_at = $9 WHERE id = $1 AND deleted_at IS NULL
	`, entry.ID, entry.ModelID, entry.DisplayName, entry.ContextWindow, entry.MaxOutputTokens,
		entry.SupportsTools, entry.SupportsVision, entry.Enabled, entry.UpdatedAt); err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			writeProviderValidation(response, request)
		} else {
			writeProviderInternal(response, request)
		}
		return
	}
	if input.ReasoningOptions != nil {
		options, valid := validReasoningOptions(*input.ReasoningOptions)
		if !valid {
			writeProviderValidation(response, request)
			return
		}
		if _, err := tx.Exec(request.Context(),
			`DELETE FROM provider_model_reasoning_options WHERE model_id = $1`, id); err != nil {
			writeProviderInternal(response, request)
			return
		}
		for _, option := range options {
			if _, err := tx.Exec(request.Context(), `
				INSERT INTO provider_model_reasoning_options (model_id, reasoning_effort, display_name, sort_order, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, $5)
			`, id, option.Reasoning, option.DisplayName, *option.SortOrder, entry.UpdatedAt); err != nil {
				writeProviderInternal(response, request)
				return
			}
		}
		// A full replacement that dropped previously selected efforts resets the
		// per-model preference and conversation selections to "off" in the same
		// transaction; run snapshots are never rewritten (docs/16 §7.2).
		if _, err := tx.Exec(request.Context(), `
			UPDATE assistant_model_preferences SET last_reasoning_effort = NULL
			WHERE model_id = $1 AND last_reasoning_effort IS NOT NULL
			  AND last_reasoning_effort <> ALL($2::text[])
		`, id, reasoningEffortsOf(options)); err != nil {
			writeProviderInternal(response, request)
			return
		}
		if _, err := tx.Exec(request.Context(), `
			UPDATE assistant_conversations SET selected_reasoning_effort = NULL, updated_at = $3
			WHERE selected_model_id = $1 AND selected_reasoning_effort IS NOT NULL
			  AND selected_reasoning_effort <> ALL($2::text[])
		`, id, reasoningEffortsOf(options), entry.UpdatedAt); err != nil {
			writeProviderInternal(response, request)
			return
		}
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeProviderInternal(response, request)
		return
	}
	options, err := service.reasoningOptionsForModel(request.Context(), id)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	entry.ReasoningOptions = options
	httpapi.WriteJSON(response, http.StatusOK, entry)
}

func reasoningEffortsOf(options []reasoningOptionInput) []string {
	efforts := make([]string, 0, len(options))
	for _, option := range options {
		efforts = append(efforts, option.Reasoning)
	}
	return efforts
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
	var providerID uuid.UUID
	if err := tx.QueryRow(request.Context(), `SELECT provider_config_id FROM provider_models WHERE id = $1 AND deleted_at IS NULL`, id).Scan(&providerID); errors.Is(err, pgx.ErrNoRows) {
		writeModelNotFound(response, request)
		return
	} else if err != nil {
		writeProviderInternal(response, request)
		return
	}
	// Fixed lock order shared with assistant run creation: provider_config then provider_model.
	if _, err := tx.Exec(request.Context(), `SELECT true FROM provider_configs WHERE id = $1 FOR UPDATE`, providerID); err != nil {
		writeProviderInternal(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `SELECT true FROM provider_models WHERE id = $1 FOR UPDATE`, id); err != nil {
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
	assistantInUse, err := queuedAssistantRunsExist(request.Context(), tx, nil, &id)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	if assistantInUse {
		writeAssistantInUse(response, request)
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
	// Soft delete clears conversation selections but keeps assistant_model_preferences
	// so bootstrap can distinguish first use from a last-used model gone unavailable.
	if _, err := tx.Exec(request.Context(), `
		UPDATE assistant_conversations SET selected_model_id = NULL, selected_reasoning_effort = NULL, updated_at = $2
		WHERE selected_model_id = $1
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

package ai

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

// SensitivePolicyChangeHook is wired by the integrator after both services
// exist (main.go):
//
//	ai.SensitivePolicyChangeHook = assistantService.NotifySensitivePolicyChanged
//
// It bumps the knowledge-assistant embedding generation whenever the global
// sensitive AI policy changes (docs/16 §7.3). A package-level hook keeps the
// ai→assistant wiring without an import cycle and without touching service.go.
var SensitivePolicyChangeHook func(ctx context.Context, tx pgx.Tx, previous, current string) (afterCommit func(), err error)

type aiSettings struct {
	SensitiveDisplayMode   string     `json:"sensitiveDisplayMode"`
	SensitiveAIPolicy      string     `json:"sensitiveAiPolicy"`
	AutoActivateOrganized  bool       `json:"autoActivateOrganized"`
	DefaultOrganizeModelID *uuid.UUID `json:"defaultOrganizeModelId"`
	DefaultReviewModelID   *uuid.UUID `json:"defaultReviewModelId"`
	DefaultVisionModelID   *uuid.UUID `json:"defaultVisionModelId"`
}

func (service *Service) getSettings(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	settings, err := service.loadSettings(request.Context(), service.database)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, settings)
}

func (service *Service) loadSettings(ctx context.Context, querier rowQuerier) (aiSettings, error) {
	var settings aiSettings
	err := querier.QueryRow(ctx, `
		SELECT sensitive_display_mode, sensitive_ai_policy, auto_activate_organized, default_organize_model_id,
		       default_review_model_id, default_vision_model_id
		FROM app_settings WHERE singleton
	`).Scan(&settings.SensitiveDisplayMode, &settings.SensitiveAIPolicy, &settings.AutoActivateOrganized,
		&settings.DefaultOrganizeModelID, &settings.DefaultReviewModelID, &settings.DefaultVisionModelID)
	return settings, err
}

func (service *Service) updateSettings(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input struct {
		SensitiveAIPolicy      *string `json:"sensitiveAiPolicy"`
		DefaultOrganizeModelID *string `json:"defaultOrganizeModelId"`
		DefaultReviewModelID   *string `json:"defaultReviewModelId"`
		DefaultVisionModelID   *string `json:"defaultVisionModelId"`
		AutoActivateOrganized  *bool   `json:"autoActivateOrganized"`
		ConfirmSensitiveAllow  bool    `json:"confirmSensitiveAllow"`
	}
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil {
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
	var current aiSettings
	err = tx.QueryRow(ctx, `
		SELECT sensitive_display_mode, sensitive_ai_policy, auto_activate_organized, default_organize_model_id,
		       default_review_model_id, default_vision_model_id
		FROM app_settings WHERE singleton FOR UPDATE
	`).Scan(&current.SensitiveDisplayMode, &current.SensitiveAIPolicy, &current.AutoActivateOrganized,
		&current.DefaultOrganizeModelID, &current.DefaultReviewModelID, &current.DefaultVisionModelID)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	policy := current.SensitiveAIPolicy
	if input.SensitiveAIPolicy != nil {
		policy = *input.SensitiveAIPolicy
		if policy != "block" && policy != "redact" && policy != "allow" || policy == "allow" && !input.ConfirmSensitiveAllow {
			writeProviderValidation(response, request)
			return
		}
	}
	organize, err := service.resolveDefaultModel(ctx, tx, input.DefaultOrganizeModelID, current.DefaultOrganizeModelID, false)
	if err != nil {
		writeProviderValidation(response, request)
		return
	}
	review, err := service.resolveDefaultModel(ctx, tx, input.DefaultReviewModelID, current.DefaultReviewModelID, false)
	if err != nil {
		writeProviderValidation(response, request)
		return
	}
	vision, err := service.resolveDefaultModel(ctx, tx, input.DefaultVisionModelID, current.DefaultVisionModelID, true)
	if err != nil {
		writeProviderValidation(response, request)
		return
	}
	autoActivate := current.AutoActivateOrganized
	if input.AutoActivateOrganized != nil {
		autoActivate = *input.AutoActivateOrganized
	}
	_, err = tx.Exec(ctx, `
		UPDATE app_settings SET sensitive_ai_policy = $1, default_organize_model_id = $2,
		       default_review_model_id = $3, default_vision_model_id = $4,
		       auto_activate_organized = $5, updated_at = $6
		WHERE singleton
	`, policy, organize, review, vision, autoActivate, service.now().UTC())
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	var afterPolicyCommit func()
	if input.SensitiveAIPolicy != nil && current.SensitiveAIPolicy != policy {
		// V3: a sensitive policy change bumps the embedding generation. The hook
		// is wired by the integrator to (*assistant.Service).NotifySensitivePolicyChanged.
		if SensitivePolicyChangeHook != nil {
			afterPolicyCommit, err = SensitivePolicyChangeHook(ctx, tx, current.SensitiveAIPolicy, policy)
			if err != nil {
				writeProviderInternal(response, request)
				return
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeProviderInternal(response, request)
		return
	}
	if afterPolicyCommit != nil {
		afterPolicyCommit()
	}
	settings, err := service.loadSettings(ctx, service.database)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, settings)
}

func (service *Service) resolveDefaultModel(ctx context.Context, querier rowQuerier, supplied *string, current *uuid.UUID, vision bool) (*uuid.UUID, error) {
	if supplied == nil {
		return current, nil
	}
	if *supplied == "" {
		return nil, nil
	}
	id, err := uuid.Parse(*supplied)
	if err != nil {
		return nil, errInvalidProviderInput
	}
	var supportsVision bool
	err = querier.QueryRow(ctx, `
		SELECT model.supports_vision
		FROM provider_models model JOIN provider_configs provider ON provider.id = model.provider_config_id
		WHERE model.id = $1 AND model.deleted_at IS NULL AND provider.deleted_at IS NULL
		  AND model.enabled AND provider.enabled AND model.context_window IS NOT NULL
		  AND model.max_output_tokens IS NOT NULL
	`, id).Scan(&supportsVision)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && vision && !supportsVision {
		return nil, errInvalidProviderInput
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

package ai

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

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
	settings, err := service.loadSettings(request)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, settings)
}

func (service *Service) loadSettings(request *http.Request) (aiSettings, error) {
	var settings aiSettings
	err := service.database.QueryRow(request.Context(), `
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
	current, err := service.loadSettings(request)
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
	organize, err := service.resolveDefaultModel(request, input.DefaultOrganizeModelID, current.DefaultOrganizeModelID, false)
	if err != nil {
		writeProviderValidation(response, request)
		return
	}
	review, err := service.resolveDefaultModel(request, input.DefaultReviewModelID, current.DefaultReviewModelID, false)
	if err != nil {
		writeProviderValidation(response, request)
		return
	}
	vision, err := service.resolveDefaultModel(request, input.DefaultVisionModelID, current.DefaultVisionModelID, true)
	if err != nil {
		writeProviderValidation(response, request)
		return
	}
	autoActivate := current.AutoActivateOrganized
	if input.AutoActivateOrganized != nil {
		autoActivate = *input.AutoActivateOrganized
	}
	_, err = service.database.Exec(request.Context(), `
		UPDATE app_settings SET sensitive_ai_policy = $1, default_organize_model_id = $2,
		       default_review_model_id = $3, default_vision_model_id = $4,
		       auto_activate_organized = $5, updated_at = $6
		WHERE singleton
	`, policy, organize, review, vision, autoActivate, service.now().UTC())
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	settings, err := service.loadSettings(request)
	if err != nil {
		writeProviderInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, settings)
}

func (service *Service) resolveDefaultModel(request *http.Request, supplied *string, current *uuid.UUID, vision bool) (*uuid.UUID, error) {
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
	err = service.database.QueryRow(request.Context(), `
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

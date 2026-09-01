package assistant

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

// bootstrap assembles the frozen AssistantBootstrapDTO (docs/16 §13.7).
func (service *Service) bootstrap(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	ctx := request.Context()
	computation, err := service.computeIndexStatus(ctx, service.database)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	rows, err := service.database.Query(ctx, `
		SELECT model.id, model.display_name, model.model_id, provider.id, provider.display_name
		FROM provider_models model JOIN provider_configs provider ON provider.id = model.provider_config_id
		WHERE model.deleted_at IS NULL AND provider.deleted_at IS NULL
		  AND model.enabled AND provider.enabled
		  AND model.context_window IS NOT NULL AND model.max_output_tokens IS NOT NULL
		ORDER BY provider.display_name, model.display_name, model.id
	`)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	models := make([]bootstrapModelRef, 0)
	for rows.Next() {
		var ref bootstrapModelRef
		if err := rows.Scan(&ref.id, &ref.displayName, &ref.upstreamModelID, &ref.providerID, &ref.providerName); err != nil {
			rows.Close()
			writeAssistantInternalFailure(response, request)
			return
		}
		models = append(models, ref)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	available := make(map[uuid.UUID]bool, len(models))
	dtOs := make([]AssistantModelDTO, 0, len(models))
	for _, ref := range models {
		available[ref.id] = true
		options, err := service.reasoningOptionsForModel(ctx, service.database, ref.id)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		lastReasoning, err := service.lastReasoningForModel(ctx, service.database, ref.id)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		dtOs = append(dtOs, AssistantModelDTO{
			ID: ref.id, DisplayName: ref.displayName, UpstreamModelID: ref.upstreamModelID,
			Provider:         AssistantProviderRef{ID: ref.providerID, DisplayName: ref.providerName},
			ReasoningOptions: options, LastReasoning: lastReasoning,
		})
	}
	selection, err := service.newConversationSelection(ctx, service.database, models, available)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	knowledge := KnowledgeIndexStatusDTO{
		Status: computation.status, Available: computation.status == "ready",
		SensitivePolicy: computation.policy, Counts: computation.counts,
		LastErrorCode: computation.config.LastErrorCode, UpdatedAt: computation.config.UpdatedAt,
	}
	if computation.config.Configured {
		generation := computation.config.Generation
		knowledge.Generation = &generation
	}
	httpapi.WriteJSON(response, http.StatusOK, AssistantBootstrapDTO{
		Models: dtOs, NewConversationSelection: selection, Knowledge: knowledge,
	})
}

// reasoningOptionsForModel returns "off" first, then the configured options in
// frozen sort order; off is never stored in the options table.
func (service *Service) reasoningOptionsForModel(ctx context.Context, querier rowQuerier, modelID uuid.UUID) ([]ReasoningOptionDTO, error) {
	rows, err := querier.Query(ctx, `
		SELECT reasoning_effort, display_name, sort_order
		FROM provider_model_reasoning_options WHERE model_id = $1
		ORDER BY sort_order, reasoning_effort
	`, modelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	options := make([]ReasoningOptionDTO, 0, 4)
	options = append(options, ReasoningOptionDTO{Reasoning: "off", DisplayName: "不思考", SortOrder: -1})
	for rows.Next() {
		var option ReasoningOptionDTO
		if err := rows.Scan(&option.Reasoning, &option.DisplayName, &option.SortOrder); err != nil {
			return nil, err
		}
		options = append(options, option)
	}
	return options, rows.Err()
}

// lastReasoningForModel returns the model's last used reasoning level when it
// is still configured; "off" otherwise (docs/16 §13.7).
func (service *Service) lastReasoningForModel(ctx context.Context, querier rowQuerier, modelID uuid.UUID) (string, error) {
	var last *string
	if err := querier.QueryRow(ctx,
		`SELECT last_reasoning_effort FROM assistant_model_preferences WHERE model_id = $1`, modelID).
		Scan(&last); err != nil && !isNoRows(err) {
		return "", err
	}
	if last == nil {
		return "off", nil
	}
	var valid bool
	if err := querier.QueryRow(ctx, `
		SELECT true FROM provider_model_reasoning_options WHERE model_id = $1 AND reasoning_effort = $2
	`, modelID, *last).Scan(&valid); err != nil {
		return "off", nil
	}
	if !valid {
		return "off", nil
	}
	return *last, nil
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

type bootstrapModelRef struct {
	id              uuid.UUID
	displayName     string
	upstreamModelID string
	providerID      uuid.UUID
	providerName    string
}

// newConversationSelection implements the fixed bootstrap priority chain.
func (service *Service) newConversationSelection(ctx context.Context, querier rowQuerier, models []bootstrapModelRef, available map[uuid.UUID]bool) (newConversationSelectionDTO, error) {
	if len(models) == 0 {
		reason := "no_available_model"
		return newConversationSelectionDTO{ModelID: nil, Reasoning: "off", Required: true, Reason: &reason}, nil
	}
	var recentModelID uuid.UUID
	var recentReasoning *string
	var hasAnyPreference bool
	err := querier.QueryRow(ctx, `
		SELECT model_id, last_reasoning_effort FROM assistant_model_preferences
		ORDER BY last_used_at DESC, model_id ASC LIMIT 1
	`).Scan(&recentModelID, &recentReasoning)
	switch {
	case isNoRows(err):
		reason := "first_use"
		return newConversationSelectionDTO{ModelID: nil, Reasoning: "off", Required: true, Reason: &reason}, nil
	case err != nil:
		return newConversationSelectionDTO{}, err
	default:
		hasAnyPreference = true
	}
	if !hasAnyPreference || !available[recentModelID] {
		reason := "last_model_unavailable"
		return newConversationSelectionDTO{ModelID: nil, Reasoning: "off", Required: true, Reason: &reason}, nil
	}
	lastReasoning, err := service.lastReasoningForModel(ctx, querier, recentModelID)
	if err != nil {
		return newConversationSelectionDTO{}, err
	}
	modelID := recentModelID
	return newConversationSelectionDTO{ModelID: &modelID, Reasoning: lastReasoning, Required: false, Reason: nil}, nil
}

// sourceDetail implements GET /assistant/runs/{id}/sources/{citationNumber};
// it resolves by citation number, never by the model-side ordinal, and only
// for the output message's current run (docs/16 §13.9).
func (service *Service) sourceDetail(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	runID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	citationNumber, err := parseBoundedInt(request.PathValue("citationNumber"), 1, MaximumRunSources)
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	run, err := service.loadRun(request.Context(), service.database, runID)
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	var currentRunID *uuid.UUID
	if err := service.database.QueryRow(request.Context(),
		`SELECT current_run_id FROM assistant_messages WHERE id = $1`, run.OutputMessageID).Scan(&currentRunID); err != nil ||
		currentRunID == nil || *currentRunID != run.ID {
		writeAssistantNotFound(response, request)
		return
	}
	sources, err := service.loadRunSources(request.Context(), service.database, run.ID)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	for _, source := range sources {
		if source.CitedNumber == nil || *source.CitedNumber != citationNumber {
			continue
		}
		dto := service.sourceDTO(run, source, citationNumber)
		httpapi.WriteJSON(response, http.StatusOK, dto)
		return
	}
	writeAssistantNotFound(response, request)
}

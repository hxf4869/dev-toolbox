package ai

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type taskEntry struct {
	ID                uuid.UUID       `json:"id"`
	TaskType          string          `json:"taskType"`
	ItemID            *uuid.UUID      `json:"itemId"`
	ParentTaskID      *uuid.UUID      `json:"parentTaskId"`
	TriggerType       string          `json:"triggerType"`
	ModelID           *uuid.UUID      `json:"modelId"`
	Status            string          `json:"status"`
	SensitivePolicy   string          `json:"sensitivePolicy"`
	PromptVersion     string          `json:"promptVersion"`
	SchemaVersion     string          `json:"schemaVersion"`
	QueuedAt          time.Time       `json:"queuedAt"`
	StartedAt         *time.Time      `json:"startedAt"`
	FinishedAt        *time.Time      `json:"finishedAt"`
	CancelRequestedAt *time.Time      `json:"cancelRequestedAt"`
	ErrorCode         *string         `json:"errorCode"`
	ErrorDetail       *string         `json:"errorDetail"`
	BatchSummary      json.RawMessage `json:"batchSummary,omitempty"`
	InputTokens       *int64          `json:"inputTokens"`
	OutputTokens      *int64          `json:"outputTokens"`
}

func (service *Service) createTask(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input struct {
		TaskType        string `json:"taskType"`
		ItemID          string `json:"itemId"`
		ModelID         string `json:"modelId"`
		SensitivePolicy string `json:"sensitivePolicy"`
		Options         struct {
			IncludeRelatedRecords bool `json:"includeRelatedRecords"`
		} `json:"options"`
	}
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil ||
		(input.TaskType != "organize_record" && input.TaskType != "review_record" && input.TaskType != "analyze_image") ||
		(input.SensitivePolicy != "block" && input.SensitivePolicy != "redact" && input.SensitivePolicy != "allow") {
		writeTaskValidation(response, request)
		return
	}
	itemID, itemErr := uuid.Parse(input.ItemID)
	modelID, modelErr := uuid.Parse(input.ModelID)
	if itemErr != nil || modelErr != nil {
		writeTaskValidation(response, request)
		return
	}
	var sensitivity, globalPolicy string
	var contextWindow, maxOutputTokens *int
	var supportsTools, supportsVision bool
	err := service.database.QueryRow(request.Context(), `
		SELECT item.sensitivity, settings.sensitive_ai_policy, model.context_window,
		       model.max_output_tokens, model.supports_tools, model.supports_vision
		FROM knowledge_items item
		CROSS JOIN app_settings settings
		JOIN provider_models model ON model.id = $2
		JOIN provider_configs provider ON provider.id = model.provider_config_id
		WHERE item.id = $1 AND item.deleted_at IS NULL AND settings.singleton
		  AND model.deleted_at IS NULL AND provider.deleted_at IS NULL
		  AND model.enabled AND provider.enabled
	`, itemID, modelID).Scan(&sensitivity, &globalPolicy, &contextWindow, &maxOutputTokens, &supportsTools, &supportsVision)
	if errors.Is(err, pgx.ErrNoRows) {
		writeTaskValidation(response, request)
		return
	}
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	if contextWindow == nil || maxOutputTokens == nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "AI_MODEL_LIMITS_UNKNOWN", "模型上下文或输出上限尚未配置")
		return
	}
	if !supportsTools || input.TaskType == "analyze_image" && !supportsVision {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "AI_MODEL_CAPABILITY_MISSING", "模型缺少任务所需能力")
		return
	}
	if policyRank(input.SensitivePolicy) > policyRank(globalPolicy) || sensitivity != "normal" && input.SensitivePolicy == "block" ||
		sensitivity != "normal" && input.TaskType == "analyze_image" && input.SensitivePolicy == "redact" {
		httpapi.WriteError(response, request, http.StatusConflict, "AI_SENSITIVE_BLOCKED", "当前敏感策略禁止发送该内容")
		return
	}
	snapshot, err := service.buildTaskSnapshot(request, itemID, input.TaskType, input.Options.IncludeRelatedRecords)
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	now := service.now().UTC()
	entry := taskEntry{ID: uuid.New(), TaskType: input.TaskType, ItemID: &itemID, TriggerType: "manual",
		ModelID: &modelID, Status: "queued", SensitivePolicy: input.SensitivePolicy,
		PromptVersion: promptVersionForTask(input.TaskType), SchemaVersion: "1.0", QueuedAt: now}
	_, err = service.database.Exec(request.Context(), `
		INSERT INTO ai_task_runs (
			id, task_type, item_id, trigger_type, model_id, status, sensitive_policy,
			prompt_version, schema_version, input_snapshot, queued_at
		) VALUES ($1, $2, $3, 'manual', $4, 'queued', $5, $6, '1.0', $7::jsonb, $8)
	`, entry.ID, entry.TaskType, itemID, modelID, entry.SensitivePolicy, entry.PromptVersion, snapshot, now)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "ai_task_runs_active_item_type" {
			httpapi.WriteError(response, request, http.StatusConflict, "AI_TASK_ALREADY_ACTIVE", "同一记录已有相同类型任务在运行")
			return
		}
		writeTaskInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusCreated, entry)
}

func (service *Service) buildTaskSnapshot(request *http.Request, itemID uuid.UUID, taskType string, includeRelated bool) ([]byte, error) {
	rows, err := service.database.Query(request.Context(), `
		SELECT id FROM raw_records WHERE item_id = $1 ORDER BY effective_captured_at, id
	`, itemID)
	if err != nil {
		return nil, err
	}
	rawIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		rawIDs = append(rawIDs, id)
	}
	if rows.Err() != nil {
		rows.Close()
		return nil, rows.Err()
	}
	rows.Close()
	fragmentRows, err := service.database.Query(request.Context(), `
		SELECT id FROM search_fragments WHERE item_id = $1 AND raw_record_id IS NOT NULL
		  AND source_kind IN ('raw_text', 'code') AND active ORDER BY raw_record_id, ordinal, id
	`, itemID)
	if err != nil {
		return nil, err
	}
	fragmentIDs := make([]uuid.UUID, 0)
	for fragmentRows.Next() {
		var id uuid.UUID
		if err := fragmentRows.Scan(&id); err != nil {
			fragmentRows.Close()
			return nil, err
		}
		fragmentIDs = append(fragmentIDs, id)
	}
	if fragmentRows.Err() != nil {
		fragmentRows.Close()
		return nil, fragmentRows.Err()
	}
	fragmentRows.Close()
	attachmentRows, err := service.database.Query(request.Context(), `
		SELECT attachment.id FROM attachments attachment
		JOIN raw_records record ON record.id = attachment.raw_record_id
		WHERE record.item_id = $1 AND attachment.status = 'ready'
		  AND ($2 <> 'analyze_image' OR attachment.kind = 'image')
		ORDER BY attachment.created_at, attachment.id
	`, itemID, taskType)
	if err != nil {
		return nil, err
	}
	attachmentIDs := make([]uuid.UUID, 0)
	for attachmentRows.Next() {
		var id uuid.UUID
		if err := attachmentRows.Scan(&id); err != nil {
			attachmentRows.Close()
			return nil, err
		}
		attachmentIDs = append(attachmentIDs, id)
	}
	if attachmentRows.Err() != nil {
		attachmentRows.Close()
		return nil, attachmentRows.Err()
	}
	attachmentRows.Close()
	return json.Marshal(map[string]any{
		"rawRecordIds": rawIDs, "fragmentIds": fragmentIDs, "attachmentIds": attachmentIDs,
		"includeRelatedRecords": includeRelated && taskType == "organize_record",
	})
}

func (service *Service) getTask(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeTaskNotFound(response, request)
		return
	}
	var entry taskEntry
	err = service.database.QueryRow(request.Context(), `
		SELECT id, task_type, item_id, parent_task_id, trigger_type, model_id, status,
		       sensitive_policy, prompt_version, schema_version, queued_at, started_at,
		       finished_at, cancel_requested_at, error_code, error_detail, batch_summary,
		       input_tokens, output_tokens
		FROM ai_task_runs WHERE id = $1
	`, id).Scan(&entry.ID, &entry.TaskType, &entry.ItemID, &entry.ParentTaskID, &entry.TriggerType,
		&entry.ModelID, &entry.Status, &entry.SensitivePolicy, &entry.PromptVersion,
		&entry.SchemaVersion, &entry.QueuedAt, &entry.StartedAt, &entry.FinishedAt,
		&entry.CancelRequestedAt, &entry.ErrorCode, &entry.ErrorDetail, &entry.BatchSummary,
		&entry.InputTokens, &entry.OutputTokens)
	if errors.Is(err, pgx.ErrNoRows) {
		writeTaskNotFound(response, request)
		return
	}
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, entry)
}

func promptVersionForTask(taskType string) string {
	if taskType == "review_record" {
		return "review-v1"
	}
	if taskType == "analyze_image" {
		return "image-v1"
	}
	return "organize-v1"
}

func policyRank(value string) int {
	if value == "allow" {
		return 2
	}
	if value == "redact" {
		return 1
	}
	return 0
}

func writeTaskValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "AI 任务配置无效")
}

func writeTaskNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "AI 任务不存在")
}

func writeTaskInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "AI 任务服务暂时不可用")
}

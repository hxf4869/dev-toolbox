package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const (
	maximumTaskRuntime = 5 * time.Minute
	// get_record_context + one get_attachment per image + emit_artifact_draft
	// must fit the eight-call domain-tool budget.
	maximumTaskImages = 6
)

type taskEventEntry struct {
	ID        int64           `json:"id"`
	Type      string          `json:"type"`
	Summary   *string         `json:"summary"`
	Details   json.RawMessage `json:"details"`
	CreatedAt time.Time       `json:"createdAt"`
}

type taskEntry struct {
	ID                uuid.UUID        `json:"id"`
	TaskType          string           `json:"taskType"`
	ItemID            *uuid.UUID       `json:"itemId"`
	ParentTaskID      *uuid.UUID       `json:"parentTaskId"`
	TriggerType       string           `json:"triggerType"`
	ModelID           *uuid.UUID       `json:"modelId"`
	Status            string           `json:"status"`
	SensitivePolicy   string           `json:"sensitivePolicy"`
	PromptVersion     string           `json:"promptVersion"`
	SchemaVersion     string           `json:"schemaVersion"`
	RetryOfTaskID     *uuid.UUID       `json:"retryOfTaskId"`
	QueuedAt          time.Time        `json:"queuedAt"`
	StartedAt         *time.Time       `json:"startedAt"`
	FinishedAt        *time.Time       `json:"finishedAt"`
	CancelRequestedAt *time.Time       `json:"cancelRequestedAt"`
	CancelRequested   bool             `json:"cancelRequested"`
	ErrorCode         *string          `json:"errorCode"`
	ErrorDetail       *string          `json:"errorDetail"`
	BatchSummary      json.RawMessage  `json:"batchSummary,omitempty"`
	InputTokens       *int64           `json:"inputTokens"`
	OutputTokens      *int64           `json:"outputTokens"`
	Events            []taskEventEntry `json:"events,omitempty"`
}

type createTaskInput struct {
	TaskType        string   `json:"taskType"`
	ItemID          string   `json:"itemId"`
	ItemIDs         []string `json:"itemIds"`
	ModelID         string   `json:"modelId"`
	OrganizeModelID string   `json:"organizeModelId"`
	VisionModelID   string   `json:"visionModelId"`
	SensitivePolicy string   `json:"sensitivePolicy"`
	Options         struct {
		IncludeRelatedRecords bool `json:"includeRelatedRecords"`
	} `json:"options"`
}

type taskModel struct {
	ID              uuid.UUID
	Protocol        string
	BaseURL         string
	ModelID         string
	DisplayName     string
	ContextWindow   int
	MaxOutputTokens int
	SupportsTools   bool
	SupportsVision  bool
}

type taskInputSnapshot struct {
	RawRecordIDs          []uuid.UUID `json:"rawRecordIds"`
	FragmentIDs           []uuid.UUID `json:"fragmentIds"`
	AttachmentIDs         []uuid.UUID `json:"attachmentIds"`
	IncludeRelatedRecords bool        `json:"includeRelatedRecords"`
}

func (service *Service) createTask(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input createTaskInput
	if httpapi.DecodeJSON(response, request, 64*1024, &input) != nil || !validTaskPolicy(input.SensitivePolicy) {
		writeTaskValidation(response, request)
		return
	}
	if input.TaskType == "batch_organize" {
		entry, err := service.createBatchTask(request.Context(), input, "manual", "", nil)
		writeCreatedTask(response, request, entry, err)
		return
	}
	if input.TaskType != "organize_record" && input.TaskType != "review_record" && input.TaskType != "analyze_image" ||
		len(input.ItemIDs) != 0 || input.OrganizeModelID != "" || input.VisionModelID != "" {
		writeTaskValidation(response, request)
		return
	}
	itemID, itemErr := uuid.Parse(input.ItemID)
	modelID, modelErr := uuid.Parse(input.ModelID)
	if itemErr != nil || modelErr != nil {
		writeTaskValidation(response, request)
		return
	}
	entry, err := service.createSingleTask(request.Context(), singleTaskRequest{
		TaskType: input.TaskType, ItemID: itemID, ModelID: modelID,
		SensitivePolicy: input.SensitivePolicy, IncludeRelated: input.Options.IncludeRelatedRecords,
		TriggerType: "manual",
	})
	writeCreatedTask(response, request, entry, err)
}

type singleTaskRequest struct {
	TaskType        string
	ItemID          uuid.UUID
	ModelID         uuid.UUID
	SensitivePolicy string
	IncludeRelated  bool
	TriggerType     string
	ParentTaskID    *uuid.UUID
	RetryOfTaskID   *uuid.UUID
}

func (service *Service) createSingleTask(ctx context.Context, request singleTaskRequest) (taskEntry, error) {
	model, sensitivity, globalPolicy, err := service.loadTaskModelAndItem(ctx, request.ItemID, request.ModelID)
	if err != nil {
		return taskEntry{}, err
	}
	if policyRank(request.SensitivePolicy) > policyRank(globalPolicy) ||
		sensitivity != "normal" && request.SensitivePolicy == "block" {
		return taskEntry{}, errTaskSensitiveBlocked
	}
	if request.TaskType == "analyze_image" && !model.SupportsVision {
		return taskEntry{}, errTaskCapability
	}
	if request.TaskType == "analyze_image" && sensitivity != "normal" && request.SensitivePolicy == "redact" {
		return taskEntry{}, errTaskSensitiveImage
	}
	snapshot, estimatedTokens, err := service.buildTaskSnapshot(ctx, request.ItemID, request.TaskType, request.IncludeRelated)
	if err != nil {
		return taskEntry{}, err
	}
	if request.TaskType == "analyze_image" && len(snapshot.AttachmentIDs) == 0 {
		return taskEntry{}, errTaskValidation
	}
	if request.TaskType != "analyze_image" && len(snapshot.FragmentIDs) == 0 {
		return taskEntry{}, errTaskValidation
	}
	if request.TaskType == "analyze_image" && len(snapshot.AttachmentIDs) > maximumTaskImages || estimatedTokens+model.MaxOutputTokens+1024 > model.ContextWindow {
		return taskEntry{}, errTaskContextTooLarge
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return taskEntry{}, err
	}
	now := service.now().UTC()
	entry := taskEntry{
		ID: uuid.New(), TaskType: request.TaskType, ItemID: &request.ItemID,
		ParentTaskID: request.ParentTaskID, TriggerType: request.TriggerType, ModelID: &request.ModelID,
		Status: "queued", SensitivePolicy: request.SensitivePolicy,
		PromptVersion: promptVersionForTask(request.TaskType), SchemaVersion: "1.0",
		RetryOfTaskID: request.RetryOfTaskID, QueuedAt: now,
	}
	_, err = service.database.Exec(ctx, `
		INSERT INTO ai_task_runs (
			id, task_type, item_id, parent_task_id, trigger_type, model_id, status,
			sensitive_policy, prompt_version, schema_version, input_snapshot,
			retry_of_task_id, queued_at
		) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, '1.0', $9::jsonb, $10, $11)
	`, entry.ID, entry.TaskType, request.ItemID, request.ParentTaskID, request.TriggerType,
		request.ModelID, entry.SensitivePolicy, entry.PromptVersion, encoded, request.RetryOfTaskID, now)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "ai_task_runs_active_item_type" {
			return taskEntry{}, errTaskAlreadyActive
		}
		return taskEntry{}, err
	}
	return entry, nil
}

func (service *Service) loadTaskModelAndItem(ctx context.Context, itemID, modelID uuid.UUID) (taskModel, string, string, error) {
	var model taskModel
	var sensitivity, policy string
	err := service.database.QueryRow(ctx, `
		SELECT model.id, provider.protocol, provider.base_url, model.model_id, model.display_name,
		       model.context_window, model.max_output_tokens, model.supports_tools,
		       model.supports_vision, item.sensitivity, settings.sensitive_ai_policy
		FROM knowledge_items item CROSS JOIN app_settings settings
		JOIN provider_models model ON model.id = $2
		JOIN provider_configs provider ON provider.id = model.provider_config_id
		WHERE item.id = $1 AND item.deleted_at IS NULL AND settings.singleton
		  AND model.deleted_at IS NULL AND provider.deleted_at IS NULL
		  AND model.enabled AND provider.enabled AND provider.api_key_ciphertext IS NOT NULL
		  AND model.context_window IS NOT NULL AND model.max_output_tokens IS NOT NULL
	`, itemID, modelID).Scan(&model.ID, &model.Protocol, &model.BaseURL, &model.ModelID,
		&model.DisplayName, &model.ContextWindow, &model.MaxOutputTokens, &model.SupportsTools,
		&model.SupportsVision, &sensitivity, &policy)
	if errors.Is(err, pgx.ErrNoRows) {
		return taskModel{}, "", "", errTaskValidation
	}
	return model, sensitivity, policy, err
}

func (service *Service) buildTaskSnapshot(ctx context.Context, itemID uuid.UUID, taskType string, includeRelated bool) (taskInputSnapshot, int, error) {
	snapshot := taskInputSnapshot{RawRecordIDs: []uuid.UUID{}, FragmentIDs: []uuid.UUID{}, AttachmentIDs: []uuid.UUID{}, IncludeRelatedRecords: includeRelated && taskType == "organize_record"}
	rows, err := service.database.Query(ctx, `
		SELECT id, body FROM raw_records WHERE item_id = $1 ORDER BY effective_captured_at, id
	`, itemID)
	if err != nil {
		return snapshot, 0, err
	}
	estimatedTokens := 0
	for rows.Next() {
		var id uuid.UUID
		var body string
		if err := rows.Scan(&id, &body); err != nil {
			rows.Close()
			return snapshot, 0, err
		}
		snapshot.RawRecordIDs = append(snapshot.RawRecordIDs, id)
		estimatedTokens += utf8.RuneCountInString(body)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return snapshot, 0, err
	}
	rows.Close()
	fragmentRows, err := service.database.Query(ctx, `
		SELECT id FROM search_fragments WHERE item_id = $1 AND raw_record_id IS NOT NULL
		  AND source_kind IN ('raw_text', 'code') AND active ORDER BY raw_record_id, ordinal, id
	`, itemID)
	if err != nil {
		return snapshot, 0, err
	}
	for fragmentRows.Next() {
		var id uuid.UUID
		if err := fragmentRows.Scan(&id); err != nil {
			fragmentRows.Close()
			return snapshot, 0, err
		}
		snapshot.FragmentIDs = append(snapshot.FragmentIDs, id)
	}
	if err := fragmentRows.Err(); err != nil {
		fragmentRows.Close()
		return snapshot, 0, err
	}
	fragmentRows.Close()
	if taskType == "analyze_image" || taskType == "organize_record" || taskType == "review_record" {
		attachmentRows, err := service.database.Query(ctx, `
			SELECT attachment.id FROM attachments attachment
			JOIN raw_records record ON record.id = attachment.raw_record_id
			WHERE record.item_id = $1 AND attachment.status = 'ready'
			  AND ($2 <> 'analyze_image' OR attachment.kind = 'image')
			ORDER BY attachment.created_at, attachment.id
		`, itemID, taskType)
		if err != nil {
			return snapshot, 0, err
		}
		for attachmentRows.Next() {
			var id uuid.UUID
			if err := attachmentRows.Scan(&id); err != nil {
				attachmentRows.Close()
				return snapshot, 0, err
			}
			snapshot.AttachmentIDs = append(snapshot.AttachmentIDs, id)
		}
		if err := attachmentRows.Err(); err != nil {
			attachmentRows.Close()
			return snapshot, 0, err
		}
		attachmentRows.Close()
	}
	return snapshot, estimatedTokens, nil
}

func (service *Service) listTasks(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	limit := 50
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeTaskValidation(response, request)
			return
		}
		limit = parsed
	}
	filters := []string{"true"}
	arguments := []any{}
	if raw := request.URL.Query().Get("itemId"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			writeTaskValidation(response, request)
			return
		}
		arguments = append(arguments, id)
		filters = append(filters, "item_id = $"+strconv.Itoa(len(arguments)))
	}
	if status := request.URL.Query().Get("status"); status != "" {
		if !containsTaskStatus(status) {
			writeTaskValidation(response, request)
			return
		}
		arguments = append(arguments, status)
		filters = append(filters, "status = $"+strconv.Itoa(len(arguments)))
	}
	arguments = append(arguments, limit)
	rows, err := service.database.Query(request.Context(), `
		SELECT id, task_type, item_id, parent_task_id, trigger_type, model_id, status,
		       sensitive_policy, prompt_version, schema_version, retry_of_task_id,
		       queued_at, started_at, finished_at, cancel_requested_at, error_code,
		       error_detail, batch_summary, input_tokens, output_tokens
		FROM ai_task_runs WHERE `+strings.Join(filters, " AND ")+`
		ORDER BY queued_at DESC, id DESC LIMIT $`+strconv.Itoa(len(arguments)), arguments...)
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	defer rows.Close()
	items := make([]taskEntry, 0)
	for rows.Next() {
		entry, err := scanTask(rows)
		if err != nil {
			writeTaskInternal(response, request)
			return
		}
		items = append(items, entry)
	}
	if rows.Err() != nil {
		writeTaskInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (service *Service) getTask(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeTaskNotFound(response, request)
		return
	}
	entry, err := service.loadTask(request.Context(), id, true)
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

func (service *Service) loadTask(ctx context.Context, id uuid.UUID, withEvents bool) (taskEntry, error) {
	entry, err := scanTask(service.database.QueryRow(ctx, `
		SELECT id, task_type, item_id, parent_task_id, trigger_type, model_id, status,
		       sensitive_policy, prompt_version, schema_version, retry_of_task_id,
		       queued_at, started_at, finished_at, cancel_requested_at, error_code,
		       error_detail, batch_summary, input_tokens, output_tokens
		FROM ai_task_runs WHERE id = $1
	`, id))
	if err != nil || !withEvents {
		return entry, err
	}
	rows, err := service.database.Query(ctx, `
		SELECT id, event_type, summary, details, created_at
		FROM ai_task_events WHERE task_id = $1 ORDER BY id
	`, id)
	if err != nil {
		return taskEntry{}, err
	}
	defer rows.Close()
	entry.Events = []taskEventEntry{}
	for rows.Next() {
		var event taskEventEntry
		if err := rows.Scan(&event.ID, &event.Type, &event.Summary, &event.Details, &event.CreatedAt); err != nil {
			return taskEntry{}, err
		}
		entry.Events = append(entry.Events, event)
	}
	return entry, rows.Err()
}

type taskScanner interface{ Scan(...any) error }

func scanTask(scanner taskScanner) (taskEntry, error) {
	var entry taskEntry
	err := scanner.Scan(&entry.ID, &entry.TaskType, &entry.ItemID, &entry.ParentTaskID,
		&entry.TriggerType, &entry.ModelID, &entry.Status, &entry.SensitivePolicy,
		&entry.PromptVersion, &entry.SchemaVersion, &entry.RetryOfTaskID, &entry.QueuedAt,
		&entry.StartedAt, &entry.FinishedAt, &entry.CancelRequestedAt, &entry.ErrorCode,
		&entry.ErrorDetail, &entry.BatchSummary, &entry.InputTokens, &entry.OutputTokens)
	entry.CancelRequested = entry.CancelRequestedAt != nil
	return entry, err
}

func (service *Service) cancelTask(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeTaskNotFound(response, request)
		return
	}
	now := service.now().UTC()
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	// Global row-lock order for ai_task_runs is child rows before the parent
	// row: completeTask, failTask and recoverExpiredTasks all follow it. A
	// batch cancel must do the same — peek the type without a lock, take every
	// child lock in deterministic id order, and only then lock the parent.
	// Otherwise the parent lock is held while waiting on a child lock that a
	// concurrent claim-side recovery holds, and the recovery blocks on the
	// parent in return.
	var taskType, status string
	if err := tx.QueryRow(request.Context(), `SELECT task_type, status FROM ai_task_runs WHERE id = $1`, id).Scan(&taskType, &status); errors.Is(err, pgx.ErrNoRows) {
		writeTaskNotFound(response, request)
		return
	} else if err != nil {
		writeTaskInternal(response, request)
		return
	}
	if taskType == "batch_organize" {
		if _, err := tx.Exec(request.Context(), `SELECT id FROM ai_task_runs WHERE parent_task_id = $1 ORDER BY id FOR UPDATE`, id); err != nil {
			writeTaskInternal(response, request)
			return
		}
	}
	if err := tx.QueryRow(request.Context(), `SELECT task_type, status FROM ai_task_runs WHERE id = $1 FOR UPDATE`, id).Scan(&taskType, &status); errors.Is(err, pgx.ErrNoRows) {
		writeTaskNotFound(response, request)
		return
	} else if err != nil {
		writeTaskInternal(response, request)
		return
	}
	responseStatus := http.StatusOK
	switch status {
	case "cancelled":
		if tx.Commit(request.Context()) != nil {
			writeTaskInternal(response, request)
			return
		}
		entry, err := service.loadTask(request.Context(), id, false)
		if err != nil {
			writeTaskInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, entry)
		return
	case "succeeded", "failed":
		httpapi.WriteError(response, request, http.StatusConflict, "AI_TASK_NOT_CANCELLABLE", "任务已结束，不能取消")
		return
	case "queued":
		if _, err := tx.Exec(request.Context(), `UPDATE ai_task_runs SET status = 'cancelled', cancel_requested_at = $2, finished_at = $2 WHERE id = $1`, id, now); err != nil {
			writeTaskInternal(response, request)
			return
		}
	case "running":
		if _, err := tx.Exec(request.Context(), `UPDATE ai_task_runs SET cancel_requested_at = COALESCE(cancel_requested_at, $2) WHERE id = $1`, id, now); err != nil {
			writeTaskInternal(response, request)
			return
		}
		responseStatus = http.StatusAccepted
	}
	if taskType == "batch_organize" {
		if _, err := tx.Exec(request.Context(), `
			UPDATE ai_task_runs SET status = 'cancelled', cancel_requested_at = $2, finished_at = $2
			WHERE parent_task_id = $1 AND status = 'queued'
		`, id, now); err != nil {
			writeTaskInternal(response, request)
			return
		}
		if _, err := tx.Exec(request.Context(), `
			UPDATE ai_task_runs SET cancel_requested_at = COALESCE(cancel_requested_at, $2)
			WHERE parent_task_id = $1 AND status = 'running'
		`, id, now); err != nil || service.updateBatchParent(request.Context(), tx, id, now) != nil {
			writeTaskInternal(response, request)
			return
		}
	}
	if _, err := tx.Exec(request.Context(), `INSERT INTO ai_task_events (task_id, event_type, summary, details, created_at) VALUES ($1, 'task_cancelled', '用户请求取消任务', '{}'::jsonb, $2)`, id, now); err != nil || tx.Commit(request.Context()) != nil {
		writeTaskInternal(response, request)
		return
	}
	entry, err := service.loadTask(request.Context(), id, false)
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, responseStatus, entry)
}

func (service *Service) retryTask(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeTaskNotFound(response, request)
		return
	}
	var taskType, status, policy string
	var itemID, modelID *uuid.UUID
	var snapshot []byte
	err = service.database.QueryRow(request.Context(), `
		SELECT task_type, status, sensitive_policy, item_id, model_id, input_snapshot
		FROM ai_task_runs WHERE id = $1
	`, id).Scan(&taskType, &status, &policy, &itemID, &modelID, &snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		writeTaskNotFound(response, request)
		return
	}
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	if status != "failed" && status != "cancelled" {
		httpapi.WriteError(response, request, http.StatusConflict, "AI_TASK_NOT_RETRYABLE", "只有失败或已取消的任务可以重试")
		return
	}
	if taskType == "batch_organize" {
		var batch batchSnapshot
		if json.Unmarshal(snapshot, &batch) != nil || len(batch.ItemIDs) == 0 || batch.OrganizeModelID == uuid.Nil {
			writeTaskInternal(response, request)
			return
		}
		itemIDs := make([]string, 0, len(batch.ItemIDs))
		for _, batchItemID := range batch.ItemIDs {
			itemIDs = append(itemIDs, batchItemID.String())
		}
		input := createTaskInput{
			TaskType: "batch_organize", ItemIDs: itemIDs,
			OrganizeModelID: batch.OrganizeModelID.String(), SensitivePolicy: policy,
		}
		if batch.VisionModelID != nil {
			input.VisionModelID = batch.VisionModelID.String()
		}
		entry, err := service.createBatchTask(request.Context(), input, "manual", "", &id)
		writeCreatedTask(response, request, entry, err)
		return
	}
	if itemID == nil || modelID == nil {
		writeTaskInternal(response, request)
		return
	}
	var decoded taskInputSnapshot
	if json.Unmarshal(snapshot, &decoded) != nil {
		writeTaskInternal(response, request)
		return
	}
	entry, err := service.createSingleTask(request.Context(), singleTaskRequest{
		TaskType: taskType, ItemID: *itemID, ModelID: *modelID, SensitivePolicy: policy,
		IncludeRelated: decoded.IncludeRelatedRecords, TriggerType: "manual", RetryOfTaskID: &id,
	})
	writeCreatedTask(response, request, entry, err)
}

func writeCreatedTask(response http.ResponseWriter, request *http.Request, entry taskEntry, err error) {
	switch {
	case err == nil:
		httpapi.WriteJSON(response, http.StatusCreated, entry)
	case errors.Is(err, errTaskAlreadyActive):
		httpapi.WriteError(response, request, http.StatusConflict, "AI_TASK_ALREADY_ACTIVE", "同一记录已有相同类型任务在运行")
	case errors.Is(err, errTaskSensitiveBlocked), errors.Is(err, errTaskSensitiveImage):
		httpapi.WriteError(response, request, http.StatusConflict, "AI_SENSITIVE_BLOCKED", "当前敏感策略禁止发送该内容")
	case errors.Is(err, errTaskContextTooLarge):
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "AI_CONTEXT_TOO_LARGE", "当前记录无法完整放入所选模型上下文")
	case errors.Is(err, errTaskCapability):
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "AI_MODEL_CAPABILITY_MISSING", "模型缺少任务所需能力")
	case errors.Is(err, errTaskValidation), errors.Is(err, pgx.ErrNoRows):
		writeTaskValidation(response, request)
	default:
		writeTaskInternal(response, request)
	}
}

func promptVersionForTask(taskType string) string {
	switch taskType {
	case "review_record":
		return "review-v2"
	case "analyze_image":
		return "image-v2"
	case "batch_organize":
		return "batch-v1"
	default:
		return "organize-v2"
	}
}

func policyRank(value string) int {
	switch value {
	case "allow":
		return 2
	case "redact":
		return 1
	default:
		return 0
	}
}

func validTaskPolicy(value string) bool {
	return value == "block" || value == "redact" || value == "allow"
}

func containsTaskStatus(value string) bool {
	return value == "queued" || value == "running" || value == "succeeded" || value == "failed" || value == "cancelled"
}

var (
	errTaskValidation       = errors.New("invalid AI task")
	errTaskAlreadyActive    = errors.New("AI task already active")
	errTaskSensitiveBlocked = errors.New("AI task sensitivity blocked")
	errTaskSensitiveImage   = errors.New("AI image redaction unsupported")
	errTaskContextTooLarge  = errors.New("AI task context too large")
	errTaskCapability       = errors.New("AI model capability missing")
)

func writeTaskValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "AI 任务配置无效")
}

func writeTaskNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "AI 任务不存在")
}

func writeTaskInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "AI 任务服务暂时不可用")
}

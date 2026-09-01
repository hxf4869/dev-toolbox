package ai

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

const taskLeaseDuration = 30 * time.Second

type claimRawRecord struct {
	ID            uuid.UUID `json:"id"`
	RecordRole    string    `json:"recordRole"`
	ContentFormat string    `json:"contentFormat"`
	Body          string    `json:"body"`
}

type claimFragment struct {
	ID          uuid.UUID `json:"id"`
	RawRecordID uuid.UUID `json:"rawRecordId"`
	SourceKind  string    `json:"sourceKind"`
	Ordinal     int       `json:"ordinal"`
	Content     string    `json:"content"`
}

type claimAttachment struct {
	ID        uuid.UUID `json:"id"`
	Kind      string    `json:"kind"`
	MediaType string    `json:"mediaType"`
	SizeBytes int64     `json:"sizeBytes"`
	Width     *int      `json:"width"`
	Height    *int      `json:"height"`
}

type claimRelatedRecord struct {
	ID      uuid.UUID `json:"id"`
	Title   string    `json:"title"`
	Summary string    `json:"summary"`
}

type claimInput struct {
	ItemID          uuid.UUID            `json:"itemId"`
	Sensitivity     string               `json:"sensitivity"`
	SensitivePolicy string               `json:"sensitivePolicy"`
	RawRecords      []claimRawRecord     `json:"rawRecords"`
	Fragments       []claimFragment      `json:"fragments"`
	Attachments     []claimAttachment    `json:"attachments"`
	RelatedRecords  []claimRelatedRecord `json:"relatedRecords"`
}

type claimResponse struct {
	Task struct {
		ID            uuid.UUID `json:"id"`
		Type          string    `json:"type"`
		LeaseVersion  int       `json:"leaseVersion"`
		PromptVersion string    `json:"promptVersion"`
		SchemaVersion string    `json:"schemaVersion"`
		Limits        struct {
			MaxTurns     int       `json:"maxTurns"`
			MaxToolCalls int       `json:"maxToolCalls"`
			DeadlineAt   time.Time `json:"deadlineAt"`
		} `json:"limits"`
	} `json:"task"`
	Input    claimInput `json:"input"`
	Provider struct {
		Protocol        string `json:"protocol"`
		BaseURL         string `json:"baseUrl"`
		APIKey          string `json:"apiKey"`
		ModelID         string `json:"modelId"`
		ModelName       string `json:"modelName"`
		ContextWindow   int    `json:"contextWindow"`
		MaxOutputTokens int    `json:"maxOutputTokens"`
		SupportsTools   bool   `json:"supportsTools"`
		SupportsVision  bool   `json:"supportsVision"`
	} `json:"provider"`
}

func (service *Service) claimTask(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input struct {
		WorkerID string `json:"workerId"`
	}
	if httpapi.DecodeJSON(response, request, 8*1024, &input) != nil || !validWorkerID(input.WorkerID) {
		writeInternalValidation(response, request)
		return
	}
	now := service.now().UTC()
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeInternalFailure(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	if err := service.recoverExpiredTasks(request, tx, now); err != nil {
		writeInternalFailure(response, request)
		return
	}
	var taskID, itemID, modelID uuid.UUID
	var taskType, policy, promptVersion, schemaVersion string
	var snapshotBytes []byte
	var claimAttempt int
	var startedAt *time.Time
	err = tx.QueryRow(request.Context(), `
		SELECT id, item_id, model_id, task_type, sensitive_policy, prompt_version,
		       schema_version, input_snapshot, claim_attempt, started_at
		FROM ai_task_runs
		WHERE status = 'queued' AND task_type <> 'batch_organize'
		ORDER BY queued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
	`).Scan(&taskID, &itemID, &modelID, &taskType, &policy, &promptVersion,
		&schemaVersion, &snapshotBytes, &claimAttempt, &startedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		if tx.Commit(request.Context()) != nil {
			writeInternalFailure(response, request)
			return
		}
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		writeInternalFailure(response, request)
		return
	}
	var snapshot taskInputSnapshot
	if json.Unmarshal(snapshotBytes, &snapshot) != nil {
		service.failClaimedBeforeStart(request, tx, taskID, "AI_INTERNAL_ERROR", "任务输入快照无效", now)
		_ = tx.Commit(request.Context())
		response.WriteHeader(http.StatusNoContent)
		return
	}
	var provider taskModel
	var ciphertext []byte
	var sensitivity string
	err = tx.QueryRow(request.Context(), `
		SELECT model.id, provider.protocol, provider.base_url, model.model_id, model.display_name,
		       model.context_window, model.max_output_tokens, model.supports_tools,
		       model.supports_vision, provider.api_key_ciphertext, item.sensitivity
		FROM provider_models model JOIN provider_configs provider ON provider.id = model.provider_config_id
		JOIN knowledge_items item ON item.id = $2
		WHERE model.id = $1 AND model.deleted_at IS NULL AND provider.deleted_at IS NULL
		  AND model.enabled AND provider.enabled AND provider.api_key_ciphertext IS NOT NULL
		  AND model.context_window IS NOT NULL AND model.max_output_tokens IS NOT NULL
		  AND item.deleted_at IS NULL
	`, modelID, itemID).Scan(&provider.ID, &provider.Protocol, &provider.BaseURL, &provider.ModelID,
		&provider.DisplayName, &provider.ContextWindow, &provider.MaxOutputTokens,
		&provider.SupportsTools, &provider.SupportsVision, &ciphertext, &sensitivity)
	if err != nil || taskType == "analyze_image" && !provider.SupportsVision {
		service.failClaimedBeforeStart(request, tx, taskID, "AI_MODEL_CAPABILITY_MISSING", "任务模型不可用或能力不匹配", now)
		_ = tx.Commit(request.Context())
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if sensitivity != "normal" && policy == "block" || taskType == "analyze_image" && sensitivity != "normal" && policy == "redact" {
		service.failClaimedBeforeStart(request, tx, taskID, "AI_SENSITIVE_BLOCKED", "敏感策略禁止外发任务输入", now)
		_ = tx.Commit(request.Context())
		response.WriteHeader(http.StatusNoContent)
		return
	}
	apiKey, err := secretbox.Open(service.masterKey, ciphertext)
	if err != nil {
		service.failClaimedBeforeStart(request, tx, taskID, "AI_INTERNAL_ERROR", "Provider 凭据无法解密", now)
		_ = tx.Commit(request.Context())
		response.WriteHeader(http.StatusNoContent)
		return
	}
	claimPayload, estimatedTokens, err := service.buildClaimInput(request, tx, itemID, sensitivity, policy, snapshot)
	if err != nil || taskType == "analyze_image" && len(snapshot.AttachmentIDs) > maximumTaskImages || estimatedTokens+provider.MaxOutputTokens+1024 > provider.ContextWindow {
		service.failClaimedBeforeStart(request, tx, taskID, "AI_CONTEXT_TOO_LARGE", "当前记录无法完整放入模型上下文", now)
		_ = tx.Commit(request.Context())
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if startedAt == nil {
		startedAt = &now
	}
	deadline := startedAt.Add(maximumTaskRuntime)
	if !deadline.After(now) {
		service.failClaimedBeforeStart(request, tx, taskID, "AI_TASK_DEADLINE_EXCEEDED", "任务运行时间已超过限制", now)
		_ = tx.Commit(request.Context())
		response.WriteHeader(http.StatusNoContent)
		return
	}
	claimAttempt++
	leaseExpires := now.Add(taskLeaseDuration)
	if _, err := tx.Exec(request.Context(), `
		UPDATE ai_task_runs SET status = 'running', claim_attempt = $2, lease_owner = $3,
		       lease_expires_at = $4, heartbeat_at = $5, started_at = COALESCE(started_at, $5)
		WHERE id = $1
	`, taskID, claimAttempt, input.WorkerID, leaseExpires, now); err != nil {
		writeInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `
		INSERT INTO ai_task_events (task_id, event_type, summary, details, created_at)
		VALUES ($1, 'task_started', 'worker 已领取任务', jsonb_build_object('attempt', $2::integer), $3)
	`, taskID, claimAttempt, now); err != nil || tx.Commit(request.Context()) != nil {
		writeInternalFailure(response, request)
		return
	}
	var result claimResponse
	result.Task.ID = taskID
	result.Task.Type = taskType
	result.Task.LeaseVersion = claimAttempt
	result.Task.PromptVersion = promptVersion
	result.Task.SchemaVersion = schemaVersion
	result.Task.Limits.MaxTurns = 4
	result.Task.Limits.MaxToolCalls = 8
	result.Task.Limits.DeadlineAt = deadline
	result.Input = claimPayload
	result.Provider.Protocol = provider.Protocol
	result.Provider.BaseURL = provider.BaseURL
	result.Provider.APIKey = apiKey
	result.Provider.ModelID = provider.ModelID
	result.Provider.ModelName = provider.DisplayName
	result.Provider.ContextWindow = provider.ContextWindow
	result.Provider.MaxOutputTokens = provider.MaxOutputTokens
	result.Provider.SupportsTools = provider.SupportsTools
	result.Provider.SupportsVision = provider.SupportsVision
	httpapi.WriteJSON(response, http.StatusOK, result)
}

func (service *Service) buildClaimInput(request *http.Request, tx pgx.Tx, itemID uuid.UUID, sensitivity, policy string, snapshot taskInputSnapshot) (claimInput, int, error) {
	result := claimInput{ItemID: itemID, Sensitivity: sensitivity, SensitivePolicy: policy,
		RawRecords: []claimRawRecord{}, Fragments: []claimFragment{}, Attachments: []claimAttachment{}, RelatedRecords: []claimRelatedRecord{}}
	redactor := NewTextRedactor()
	rows, err := tx.Query(request.Context(), `
		SELECT id, record_role, content_format, body FROM raw_records
		WHERE item_id = $1 AND id = ANY($2) ORDER BY effective_captured_at, id
	`, itemID, snapshot.RawRecordIDs)
	if err != nil {
		return result, 0, err
	}
	estimatedTokens := 0
	for rows.Next() {
		var entry claimRawRecord
		if err := rows.Scan(&entry.ID, &entry.RecordRole, &entry.ContentFormat, &entry.Body); err != nil {
			rows.Close()
			return result, 0, err
		}
		if policy == "redact" && sensitivity != "normal" {
			entry.Body = redactor.Redact(entry.Body)
		}
		estimatedTokens += utf8.RuneCountInString(entry.Body)
		result.RawRecords = append(result.RawRecords, entry)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return result, 0, err
	}
	rows.Close()
	if len(result.RawRecords) != len(snapshot.RawRecordIDs) {
		return result, 0, errors.New("task raw record snapshot is incomplete")
	}
	fragmentRows, err := tx.Query(request.Context(), `
		SELECT id, raw_record_id, source_kind, ordinal, content FROM search_fragments
		WHERE item_id = $1 AND id = ANY($2) AND raw_record_id IS NOT NULL
		  AND source_kind IN ('raw_text', 'code') ORDER BY raw_record_id, ordinal, id
	`, itemID, snapshot.FragmentIDs)
	if err != nil {
		return result, 0, err
	}
	for fragmentRows.Next() {
		var entry claimFragment
		if err := fragmentRows.Scan(&entry.ID, &entry.RawRecordID, &entry.SourceKind, &entry.Ordinal, &entry.Content); err != nil {
			fragmentRows.Close()
			return result, 0, err
		}
		if policy == "redact" && sensitivity != "normal" {
			entry.Content = redactor.Redact(entry.Content)
		}
		result.Fragments = append(result.Fragments, entry)
	}
	if err := fragmentRows.Err(); err != nil {
		fragmentRows.Close()
		return result, 0, err
	}
	fragmentRows.Close()
	if len(result.Fragments) != len(snapshot.FragmentIDs) {
		return result, 0, errors.New("task fragment snapshot is incomplete")
	}
	if len(snapshot.AttachmentIDs) > 0 {
		attachmentRows, err := tx.Query(request.Context(), `
			SELECT attachment.id, attachment.kind, attachment.media_type, attachment.size_bytes, attachment.width, attachment.height
			FROM attachments attachment JOIN raw_records record ON record.id = attachment.raw_record_id
			WHERE record.item_id = $1 AND attachment.id = ANY($2) AND attachment.status = 'ready'
			ORDER BY attachment.created_at, attachment.id
		`, itemID, snapshot.AttachmentIDs)
		if err != nil {
			return result, 0, err
		}
		for attachmentRows.Next() {
			var entry claimAttachment
			if err := attachmentRows.Scan(&entry.ID, &entry.Kind, &entry.MediaType, &entry.SizeBytes, &entry.Width, &entry.Height); err != nil {
				attachmentRows.Close()
				return result, 0, err
			}
			result.Attachments = append(result.Attachments, entry)
		}
		if err := attachmentRows.Err(); err != nil {
			attachmentRows.Close()
			return result, 0, err
		}
		attachmentRows.Close()
		if len(result.Attachments) != len(snapshot.AttachmentIDs) {
			return result, 0, errors.New("task attachment snapshot is incomplete")
		}
	}
	if snapshot.IncludeRelatedRecords {
		relatedRows, err := tx.Query(request.Context(), `
			SELECT item.id, item.title, item.sensitivity, COALESCE(preview.content, '')
			FROM knowledge_items item
			LEFT JOIN LATERAL (
				SELECT fragment.content FROM search_fragments fragment
				WHERE fragment.item_id = item.id AND fragment.active
				  AND fragment.source_kind IN ('raw_text', 'code')
				ORDER BY fragment.ordinal, fragment.id LIMIT 1
			) preview ON true
			WHERE item.id <> $1 AND item.deleted_at IS NULL
			  AND ($2 <> 'block' OR item.sensitivity = 'normal')
			ORDER BY item.updated_at DESC, item.id DESC LIMIT 10
		`, itemID, policy)
		if err != nil {
			return result, 0, err
		}
		for relatedRows.Next() {
			var entry claimRelatedRecord
			var relatedSensitivity string
			if err := relatedRows.Scan(&entry.ID, &entry.Title, &relatedSensitivity, &entry.Summary); err != nil {
				relatedRows.Close()
				return result, 0, err
			}
			if policy == "redact" && relatedSensitivity != "normal" {
				entry.Summary = redactor.Redact(entry.Summary)
			}
			estimatedTokens += utf8.RuneCountInString(entry.Title) + utf8.RuneCountInString(entry.Summary)
			result.RelatedRecords = append(result.RelatedRecords, entry)
		}
		if err := relatedRows.Err(); err != nil {
			relatedRows.Close()
			return result, 0, err
		}
		relatedRows.Close()
	}
	return result, estimatedTokens, nil
}

func (service *Service) recoverExpiredTasks(request *http.Request, tx pgx.Tx, now time.Time) error {
	rows, err := tx.Query(request.Context(), `
		SELECT id, parent_task_id, claim_attempt, cancel_requested_at IS NOT NULL
		FROM ai_task_runs WHERE status = 'running' AND lease_expires_at < $1
		  AND task_type <> 'batch_organize' FOR UPDATE SKIP LOCKED
	`, now)
	if err != nil {
		return err
	}
	type expired struct {
		id        uuid.UUID
		parentID  *uuid.UUID
		attempt   int
		cancelled bool
	}
	items := []expired{}
	parents := map[uuid.UUID]struct{}{}
	for rows.Next() {
		var item expired
		if err := rows.Scan(&item.id, &item.parentID, &item.attempt, &item.cancelled); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
		if item.parentID != nil {
			parents[*item.parentID] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, item := range items {
		switch {
		case item.cancelled:
			_, err = tx.Exec(request.Context(), `UPDATE ai_task_runs SET status = 'cancelled', finished_at = $2, lease_expires_at = NULL WHERE id = $1`, item.id, now)
		case item.attempt < 2:
			_, err = tx.Exec(request.Context(), `UPDATE ai_task_runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE id = $1`, item.id)
		default:
			_, err = tx.Exec(request.Context(), `UPDATE ai_task_runs SET status = 'failed', finished_at = $2, lease_expires_at = NULL, error_code = 'AI_WORKER_LEASE_EXPIRED', error_detail = 'worker 两次租约均过期' WHERE id = $1`, item.id, now)
		}
		if err != nil {
			return err
		}
	}
	for parentID := range parents {
		if err := service.updateBatchParent(request.Context(), tx, parentID, now); err != nil {
			return err
		}
	}
	return nil
}

func (service *Service) failClaimedBeforeStart(request *http.Request, tx pgx.Tx, id uuid.UUID, code, detail string, now time.Time) {
	var parentID *uuid.UUID
	_ = tx.QueryRow(request.Context(), `UPDATE ai_task_runs SET status = 'failed', finished_at = $2, error_code = $3, error_detail = $4 WHERE id = $1 RETURNING parent_task_id`, id, now, code, detail).Scan(&parentID)
	_, _ = tx.Exec(request.Context(), `INSERT INTO ai_task_events (task_id, event_type, summary, details, created_at) VALUES ($1, 'task_failed', $2, '{}'::jsonb, $3)`, id, detail, now)
	if parentID != nil {
		_ = service.updateBatchParent(request.Context(), tx, *parentID, now)
	}
}

func (service *Service) heartbeatTask(response http.ResponseWriter, request *http.Request) {
	id, workerID, leaseVersion, ok := decodeLeaseRequest(response, request)
	if !ok {
		return
	}
	now := service.now().UTC()
	var cancelRequestedAt *time.Time
	err := service.database.QueryRow(request.Context(), `
		UPDATE ai_task_runs SET heartbeat_at = $4, lease_expires_at = $5
		WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND claim_attempt = $3
		  AND lease_expires_at >= $4
		RETURNING cancel_requested_at
	`, id, workerID, leaseVersion, now, now.Add(taskLeaseDuration)).Scan(&cancelRequestedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeLeaseConflict(response, request)
		return
	}
	if err != nil {
		writeInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"cancelRequested": cancelRequestedAt != nil})
}

func (service *Service) appendTaskEvents(response http.ResponseWriter, request *http.Request) {
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeInternalValidation(response, request)
		return
	}
	var input struct {
		WorkerID     string `json:"workerId"`
		LeaseVersion int    `json:"leaseVersion"`
		Events       []struct {
			Type    string         `json:"type"`
			Summary *string        `json:"summary"`
			Details map[string]any `json:"details"`
		} `json:"events"`
	}
	if httpapi.DecodeJSON(response, request, 64*1024, &input) != nil || !validWorkerID(input.WorkerID) || input.LeaseVersion < 1 || len(input.Events) < 1 || len(input.Events) > 20 {
		writeInternalValidation(response, request)
		return
	}
	for _, event := range input.Events {
		if !validTaskEvent(event.Type) || event.Summary != nil && (!utf8.ValidString(*event.Summary) || len([]rune(*event.Summary)) > 500) || !safeEventDetails(event.Details) {
			writeInternalValidation(response, request)
			return
		}
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeInternalFailure(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var valid bool
	if err := tx.QueryRow(request.Context(), `SELECT true FROM ai_task_runs WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND claim_attempt = $3 AND lease_expires_at >= $4 FOR UPDATE`, id, input.WorkerID, input.LeaseVersion, service.now().UTC()).Scan(&valid); errors.Is(err, pgx.ErrNoRows) {
		writeLeaseConflict(response, request)
		return
	} else if err != nil {
		writeInternalFailure(response, request)
		return
	}
	now := service.now().UTC()
	for _, event := range input.Events {
		encoded, _ := json.Marshal(event.Details)
		if _, err := tx.Exec(request.Context(), `INSERT INTO ai_task_events (task_id, event_type, summary, details, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`, id, event.Type, event.Summary, encoded, now); err != nil {
			writeInternalFailure(response, request)
			return
		}
	}
	if tx.Commit(request.Context()) != nil {
		writeInternalFailure(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) failTask(response http.ResponseWriter, request *http.Request) {
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeInternalValidation(response, request)
		return
	}
	var input struct {
		WorkerID     string `json:"workerId"`
		LeaseVersion int    `json:"leaseVersion"`
		ErrorCode    string `json:"errorCode"`
		ErrorDetail  string `json:"errorDetail"`
		InputTokens  *int64 `json:"inputTokens"`
		OutputTokens *int64 `json:"outputTokens"`
	}
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil || !validWorkerID(input.WorkerID) ||
		input.LeaseVersion < 1 || !validTaskFailureCode(input.ErrorCode) ||
		!utf8.ValidString(input.ErrorDetail) || len([]rune(input.ErrorDetail)) > 500 ||
		input.InputTokens != nil && *input.InputTokens < 0 || input.OutputTokens != nil && *input.OutputTokens < 0 {
		writeInternalValidation(response, request)
		return
	}
	now := service.now().UTC()
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeInternalFailure(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var cancelRequestedAt *time.Time
	var parentID *uuid.UUID
	err = tx.QueryRow(request.Context(), `
		SELECT cancel_requested_at, parent_task_id FROM ai_task_runs
		WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND claim_attempt = $3
		  AND lease_expires_at >= $4 FOR UPDATE
	`, id, input.WorkerID, input.LeaseVersion, now).Scan(&cancelRequestedAt, &parentID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeLeaseConflict(response, request)
		return
	}
	if err != nil {
		writeInternalFailure(response, request)
		return
	}
	status := "failed"
	eventType := "task_failed"
	errorCode := &input.ErrorCode
	errorDetail := &input.ErrorDetail
	if cancelRequestedAt != nil {
		status = "cancelled"
		eventType = "task_cancelled"
		errorCode, errorDetail = nil, nil
	}
	if _, err := tx.Exec(request.Context(), `
		UPDATE ai_task_runs SET status = $2, finished_at = $3, lease_expires_at = NULL,
		       error_code = $4, error_detail = $5, input_tokens = $6, output_tokens = $7
		WHERE id = $1
	`, id, status, now, errorCode, errorDetail, input.InputTokens, input.OutputTokens); err != nil {
		writeInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `INSERT INTO ai_task_events (task_id, event_type, summary, details, created_at) VALUES ($1, $2, $3, '{}'::jsonb, $4)`, id, eventType, errorDetail, now); err != nil {
		writeInternalFailure(response, request)
		return
	}
	if parentID != nil {
		if err := service.updateBatchParent(request.Context(), tx, *parentID, now); err != nil {
			writeInternalFailure(response, request)
			return
		}
	}
	if tx.Commit(request.Context()) != nil {
		writeInternalFailure(response, request)
		return
	}
	entry, err := service.loadTask(request.Context(), id, false)
	if err != nil {
		writeInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, entry)
}

func (service *Service) getTaskAttachment(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	taskID, taskErr := uuid.Parse(request.PathValue("id"))
	attachmentID, attachmentErr := uuid.Parse(request.PathValue("attachmentId"))
	leaseVersion, leaseErr := strconv.Atoi(request.Header.Get("X-Lease-Version"))
	workerID := request.Header.Get("X-Worker-ID")
	if taskErr != nil || attachmentErr != nil || leaseErr != nil || leaseVersion < 1 || !validWorkerID(workerID) {
		writeInternalValidation(response, request)
		return
	}
	var storageKey, mediaType, sensitivity, policy string
	var sizeBytes int64
	err := service.database.QueryRow(request.Context(), `
		SELECT attachment.storage_key, attachment.media_type, attachment.size_bytes,
		       item.sensitivity, task.sensitive_policy
		FROM ai_task_runs task JOIN knowledge_items item ON item.id = task.item_id
		JOIN raw_records record ON record.item_id = item.id
		JOIN attachments attachment ON attachment.raw_record_id = record.id
		WHERE task.id = $1 AND task.status = 'running' AND task.lease_owner = $2
		  AND task.claim_attempt = $3 AND task.lease_expires_at >= $4
		  AND attachment.id = $5 AND attachment.status = 'ready' AND attachment.kind = 'image'
		  AND task.input_snapshot->'attachmentIds' ? $6
	`, taskID, workerID, leaseVersion, service.now().UTC(), attachmentID, attachmentID.String()).Scan(&storageKey, &mediaType, &sizeBytes, &sensitivity, &policy)
	if errors.Is(err, pgx.ErrNoRows) {
		writeLeaseConflict(response, request)
		return
	}
	if err != nil || sensitivity != "normal" && policy != "allow" {
		writeInternalFailure(response, request)
		return
	}
	path := filepath.Clean(filepath.Join(service.attachmentRoot, filepath.FromSlash(storageKey)))
	relative, err := filepath.Rel(service.attachmentRoot, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		writeInternalFailure(response, request)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeInternalFailure(response, request)
		return
	}
	defer file.Close()
	response.Header().Set("Content-Type", mediaType)
	response.Header().Set("Content-Length", strconv.FormatInt(sizeBytes, 10))
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(http.StatusOK)
	_, _ = io.CopyN(response, file, sizeBytes)
}

func decodeLeaseRequest(response http.ResponseWriter, request *http.Request) (uuid.UUID, string, int, bool) {
	id, err := uuid.Parse(request.PathValue("id"))
	var input struct {
		WorkerID     string `json:"workerId"`
		LeaseVersion int    `json:"leaseVersion"`
	}
	if err != nil || httpapi.DecodeJSON(response, request, 8*1024, &input) != nil || !validWorkerID(input.WorkerID) || input.LeaseVersion < 1 {
		writeInternalValidation(response, request)
		return uuid.Nil, "", 0, false
	}
	return id, input.WorkerID, input.LeaseVersion, true
}

func validWorkerID(value string) bool {
	if value == "" || len(value) > 120 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || strings.ContainsRune("._-", character) {
			continue
		}
		return false
	}
	return true
}

func validTaskEvent(value string) bool {
	switch value {
	case "model_request_started", "model_request_finished", "tool_started", "tool_finished", "candidate_received":
		return true
	default:
		return false
	}
}

func safeEventDetails(details map[string]any) bool {
	if len(details) > 8 {
		return false
	}
	allowed := map[string]struct{}{
		"turn": {}, "tool": {}, "durationMs": {}, "inputTokens": {}, "outputTokens": {},
		"attempt": {}, "failureCategory": {}, "toolCalls": {},
	}
	for key, value := range details {
		if _, ok := allowed[key]; !ok {
			return false
		}
		switch value.(type) {
		case string, float64, bool, nil:
		default:
			return false
		}
	}
	encoded, _ := json.Marshal(details)
	return len(encoded) <= 4096
}

func validTaskFailureCode(value string) bool {
	switch value {
	case "AI_PROVIDER_UNAVAILABLE", "AI_PROVIDER_CREDENTIALS_INVALID", "AI_PROTOCOL_ERROR",
		"AI_MODEL_CAPABILITY_MISSING", "AI_CONTEXT_TOO_LARGE", "AI_TOOL_INVALID",
		"AI_TOOL_LIMIT", "AI_TURN_LIMIT", "AI_ARTIFACT_SCHEMA_INVALID",
		"AI_TASK_DEADLINE_EXCEEDED", "AI_TASK_CANCELLED", "AI_SENSITIVE_BLOCKED", "AI_INTERNAL_ERROR":
		return true
	default:
		return false
	}
}

func writeInternalValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部任务请求无效")
}

func writeInternalFailure(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "内部任务服务暂时不可用")
}

func writeLeaseConflict(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "AI_TASK_LEASE_CONFLICT", "任务租约已失效")
}

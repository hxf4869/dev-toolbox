package ai

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type batchStatusCounts struct {
	Queued    int `json:"queued"`
	Running   int `json:"running"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Cancelled int `json:"cancelled"`
}

type batchSkipReasons struct {
	AlreadyCovered                     int `json:"already_covered"`
	AlreadyQueuedOrRunning             int `json:"already_queued_or_running"`
	NoSupportedContent                 int `json:"no_supported_content"`
	VisionModelUnavailable             int `json:"vision_model_unavailable"`
	SensitiveBlocked                   int `json:"sensitive_blocked"`
	SensitiveImageRedactionUnsupported int `json:"sensitive_image_redaction_unsupported"`
}

type batchSkipped struct {
	Total    int              `json:"total"`
	ByReason batchSkipReasons `json:"byReason"`
}

type batchSummary struct {
	SelectedItems     int               `json:"selectedItems"`
	CreatedChildren   int               `json:"createdChildren"`
	ChildStatusCounts batchStatusCounts `json:"childStatusCounts"`
	Skipped           batchSkipped      `json:"skipped"`
}

type batchSnapshot struct {
	ItemIDs         []uuid.UUID `json:"itemIds"`
	OrganizeModelID uuid.UUID   `json:"organizeModelId"`
	VisionModelID   *uuid.UUID  `json:"visionModelId"`
}

func (service *Service) createBatchTask(
	ctx context.Context,
	input createTaskInput,
	triggerType, scheduleKey string,
	retryOf *uuid.UUID,
) (taskEntry, error) {
	if input.ItemID != "" || input.ModelID != "" || len(input.ItemIDs) < 1 || len(input.ItemIDs) > 100 {
		return taskEntry{}, errTaskValidation
	}
	itemIDs := make([]uuid.UUID, 0, len(input.ItemIDs))
	seen := make(map[uuid.UUID]struct{}, len(input.ItemIDs))
	for _, raw := range input.ItemIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			return taskEntry{}, errTaskValidation
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		itemIDs = append(itemIDs, id)
	}
	if len(itemIDs) == 0 || len(itemIDs) > 100 {
		return taskEntry{}, errTaskValidation
	}
	organizeModelID, err := uuid.Parse(input.OrganizeModelID)
	if err != nil {
		return taskEntry{}, errTaskValidation
	}
	organizeModel, err := service.loadEnabledTaskModel(ctx, organizeModelID)
	if err != nil || !organizeModel.SupportsTools {
		return taskEntry{}, errTaskValidation
	}
	var visionModelID *uuid.UUID
	if input.VisionModelID != "" {
		parsed, err := uuid.Parse(input.VisionModelID)
		if err != nil {
			return taskEntry{}, errTaskValidation
		}
		visionModel, err := service.loadEnabledTaskModel(ctx, parsed)
		if err != nil || !visionModel.SupportsTools || !visionModel.SupportsVision {
			return taskEntry{}, errTaskValidation
		}
		visionModelID = &parsed
	}
	var globalPolicy string
	if err := service.database.QueryRow(ctx, `SELECT sensitive_ai_policy FROM app_settings WHERE singleton`).Scan(&globalPolicy); err != nil {
		return taskEntry{}, err
	}
	if policyRank(input.SensitivePolicy) > policyRank(globalPolicy) {
		return taskEntry{}, errTaskSensitiveBlocked
	}

	now := service.now().UTC()
	parentID := uuid.New()
	summary := batchSummary{SelectedItems: len(itemIDs)}
	parentSnapshot, _ := json.Marshal(batchSnapshot{ItemIDs: itemIDs, OrganizeModelID: organizeModelID, VisionModelID: visionModelID})
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return taskEntry{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO ai_task_runs (
			id, task_type, trigger_type, schedule_key, status, sensitive_policy,
			prompt_version, schema_version, input_snapshot, retry_of_task_id, queued_at
		) VALUES ($1, 'batch_organize', $2, NULLIF($3, ''), 'running', $4,
		          'batch-v1', '1.0', $5::jsonb, $6, $7)
	`, parentID, triggerType, scheduleKey, input.SensitivePolicy, parentSnapshot, retryOf, now); err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "ai_task_runs_schedule_key" {
			return taskEntry{}, errTaskAlreadyActive
		}
		return taskEntry{}, err
	}

	for _, itemID := range itemIDs {
		var sensitivity string
		var hasBody bool
		if err := tx.QueryRow(ctx, `
			SELECT item.sensitivity, EXISTS (
				SELECT 1 FROM raw_records record WHERE record.item_id = item.id AND btrim(record.body) <> ''
			) FROM knowledge_items item WHERE item.id = $1 AND item.deleted_at IS NULL
		`, itemID).Scan(&sensitivity, &hasBody); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return taskEntry{}, errTaskValidation
			}
			return taskEntry{}, err
		}
		rawSnapshot, _, err := service.buildTaskSnapshot(ctx, itemID, "organize_record", false)
		if err != nil {
			return taskEntry{}, err
		}
		imageSnapshot, _, err := service.buildTaskSnapshot(ctx, itemID, "analyze_image", false)
		if err != nil {
			return taskEntry{}, err
		}
		hasImages := len(imageSnapshot.AttachmentIDs) > 0
		if !hasBody && !hasImages {
			incrementBatchSkip(&summary, "no_supported_content")
			continue
		}
		if hasBody {
			reason := ""
			switch {
			case sensitivity != "normal" && input.SensitivePolicy == "block":
				reason = "sensitive_blocked"
			case service.artifactCovers(ctx, itemID, "organized_record", rawSnapshot):
				reason = "already_covered"
			}
			if reason != "" {
				incrementBatchSkip(&summary, reason)
			} else if err := insertBatchChild(ctx, tx, parentID, itemID, organizeModelID, "organize_record", triggerType, input.SensitivePolicy, rawSnapshot, now); err != nil {
				if errors.Is(err, errTaskAlreadyActive) || isActiveTaskConflict(err) {
					incrementBatchSkip(&summary, "already_queued_or_running")
				} else {
					return taskEntry{}, err
				}
			} else {
				summary.CreatedChildren++
				summary.ChildStatusCounts.Queued++
			}
		}
		if hasImages {
			reason := ""
			switch {
			case sensitivity != "normal" && input.SensitivePolicy == "block":
				reason = "sensitive_blocked"
			case sensitivity != "normal" && input.SensitivePolicy == "redact":
				reason = "sensitive_image_redaction_unsupported"
			case visionModelID == nil:
				reason = "vision_model_unavailable"
			case service.artifactCovers(ctx, itemID, "image_analysis", imageSnapshot):
				reason = "already_covered"
			}
			if reason != "" {
				incrementBatchSkip(&summary, reason)
			} else if err := insertBatchChild(ctx, tx, parentID, itemID, *visionModelID, "analyze_image", triggerType, input.SensitivePolicy, imageSnapshot, now); err != nil {
				if errors.Is(err, errTaskAlreadyActive) || isActiveTaskConflict(err) {
					incrementBatchSkip(&summary, "already_queued_or_running")
				} else {
					return taskEntry{}, err
				}
			} else {
				summary.CreatedChildren++
				summary.ChildStatusCounts.Queued++
			}
		}
	}
	status := "running"
	var finishedAt *time.Time
	if summary.CreatedChildren == 0 {
		status = "succeeded"
		finishedAt = &now
	}
	encodedSummary, _ := json.Marshal(summary)
	if _, err := tx.Exec(ctx, `
		UPDATE ai_task_runs SET status = $2, batch_summary = $3::jsonb, finished_at = $4 WHERE id = $1
	`, parentID, status, encodedSummary, finishedAt); err != nil {
		return taskEntry{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return taskEntry{}, err
	}
	return taskEntry{
		ID: parentID, TaskType: "batch_organize", TriggerType: triggerType, Status: status,
		SensitivePolicy: input.SensitivePolicy, PromptVersion: "batch-v1", SchemaVersion: "1.0",
		RetryOfTaskID: retryOf, QueuedAt: now, FinishedAt: finishedAt, BatchSummary: encodedSummary,
	}, nil
}

func (service *Service) loadEnabledTaskModel(ctx context.Context, id uuid.UUID) (taskModel, error) {
	var model taskModel
	err := service.database.QueryRow(ctx, `
		SELECT model.id, provider.protocol, provider.base_url, model.model_id, model.display_name,
		       model.context_window, model.max_output_tokens, model.supports_tools, model.supports_vision
		FROM provider_models model JOIN provider_configs provider ON provider.id = model.provider_config_id
		WHERE model.id = $1 AND model.deleted_at IS NULL AND provider.deleted_at IS NULL
		  AND model.enabled AND provider.enabled AND provider.api_key_ciphertext IS NOT NULL
		  AND model.context_window IS NOT NULL AND model.max_output_tokens IS NOT NULL
	`, id).Scan(&model.ID, &model.Protocol, &model.BaseURL, &model.ModelID, &model.DisplayName,
		&model.ContextWindow, &model.MaxOutputTokens, &model.SupportsTools, &model.SupportsVision)
	if errors.Is(err, pgx.ErrNoRows) {
		return taskModel{}, errTaskValidation
	}
	return model, err
}

func insertBatchChild(
	ctx context.Context,
	tx pgx.Tx,
	parentID, itemID, modelID uuid.UUID,
	taskType, triggerType, policy string,
	snapshot taskInputSnapshot,
	now time.Time,
) error {
	encoded, _ := json.Marshal(snapshot)
	tag, err := tx.Exec(ctx, `
		INSERT INTO ai_task_runs (
			id, task_type, item_id, parent_task_id, trigger_type, model_id, status,
			sensitive_policy, prompt_version, schema_version, input_snapshot, queued_at
		) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, '1.0', $9::jsonb, $10)
		ON CONFLICT (item_id, task_type) WHERE status IN ('queued', 'running') DO NOTHING
	`, uuid.New(), taskType, itemID, parentID, triggerType, modelID, policy, promptVersionForTask(taskType), encoded, now)
	if err == nil && tag.RowsAffected() == 0 {
		return errTaskAlreadyActive
	}
	return err
}

func isActiveTaskConflict(err error) bool {
	var databaseError *pgconn.PgError
	return errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "ai_task_runs_active_item_type"
}

func incrementBatchSkip(summary *batchSummary, reason string) {
	summary.Skipped.Total++
	switch reason {
	case "already_covered":
		summary.Skipped.ByReason.AlreadyCovered++
	case "already_queued_or_running":
		summary.Skipped.ByReason.AlreadyQueuedOrRunning++
	case "no_supported_content":
		summary.Skipped.ByReason.NoSupportedContent++
	case "vision_model_unavailable":
		summary.Skipped.ByReason.VisionModelUnavailable++
	case "sensitive_blocked":
		summary.Skipped.ByReason.SensitiveBlocked++
	case "sensitive_image_redaction_unsupported":
		summary.Skipped.ByReason.SensitiveImageRedactionUnsupported++
	}
}

func (service *Service) artifactCovers(ctx context.Context, itemID uuid.UUID, artifactType string, current taskInputSnapshot) bool {
	var encoded []byte
	err := service.database.QueryRow(ctx, `
		SELECT task.input_snapshot FROM item_active_artifacts active
		JOIN ai_artifacts artifact ON artifact.id = active.artifact_id
		JOIN ai_task_runs task ON task.id = artifact.task_run_id
		WHERE active.item_id = $1 AND active.artifact_type = $2 AND artifact.invalidated_at IS NULL
	`, itemID, artifactType).Scan(&encoded)
	if err != nil {
		return false
	}
	var previous taskInputSnapshot
	if json.Unmarshal(encoded, &previous) != nil {
		return false
	}
	if artifactType == "image_analysis" {
		return sameUUIDSet(previous.AttachmentIDs, current.AttachmentIDs)
	}
	return sameUUIDSet(previous.RawRecordIDs, current.RawRecordIDs)
}

func sameUUIDSet(left, right []uuid.UUID) bool {
	if len(left) != len(right) {
		return false
	}
	values := make(map[uuid.UUID]struct{}, len(left))
	for _, id := range left {
		values[id] = struct{}{}
	}
	for _, id := range right {
		if _, ok := values[id]; !ok {
			return false
		}
	}
	return true
}

func (service *Service) updateBatchParent(ctx context.Context, tx pgx.Tx, parentID uuid.UUID, now time.Time) error {
	var encoded []byte
	var cancelRequestedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT batch_summary, cancel_requested_at FROM ai_task_runs WHERE id = $1 FOR UPDATE`, parentID).Scan(&encoded, &cancelRequestedAt); err != nil {
		return err
	}
	var summary batchSummary
	if json.Unmarshal(encoded, &summary) != nil {
		return errors.New("invalid batch summary")
	}
	counts := batchStatusCounts{}
	rows, err := tx.Query(ctx, `SELECT status, COUNT(*) FROM ai_task_runs WHERE parent_task_id = $1 GROUP BY status`, parentID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return err
		}
		switch status {
		case "queued":
			counts.Queued = count
		case "running":
			counts.Running = count
		case "succeeded":
			counts.Succeeded = count
		case "failed":
			counts.Failed = count
		case "cancelled":
			counts.Cancelled = count
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	summary.ChildStatusCounts = counts
	status := "running"
	var finishedAt *time.Time
	if counts.Queued+counts.Running == 0 {
		finishedAt = &now
		switch {
		case cancelRequestedAt != nil:
			status = "cancelled"
		case counts.Failed > 0:
			status = "failed"
		case counts.Cancelled > 0:
			status = "cancelled"
		default:
			status = "succeeded"
		}
	}
	updated, _ := json.Marshal(summary)
	_, err = tx.Exec(ctx, `UPDATE ai_task_runs SET status = $2, batch_summary = $3::jsonb, finished_at = $4 WHERE id = $1`, parentID, status, updated, finishedAt)
	return err
}

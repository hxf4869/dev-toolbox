package ai

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

var localTimePattern = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)

type scheduleEntry struct {
	Frequency       string     `json:"frequency"`
	Timezone        string     `json:"timezone"`
	LocalTime       string     `json:"localTime"`
	Weekday         int        `json:"weekday"`
	OrganizeModelID *uuid.UUID `json:"organizeModelId"`
	VisionModelID   *uuid.UUID `json:"visionModelId"`
	SensitivePolicy string     `json:"sensitivePolicy"`
}

func (service *Service) getSchedule(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	entry, err := service.loadSchedule(request.Context())
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, entry)
}

func (service *Service) loadSchedule(ctx context.Context) (scheduleEntry, error) {
	var entry scheduleEntry
	err := service.database.QueryRow(ctx, `
		SELECT scheduled_organize, schedule_timezone,
		       to_char(schedule_local_time, 'HH24:MI'), schedule_weekday,
		       schedule_organize_model_id, schedule_vision_model_id, schedule_sensitive_policy
		FROM app_settings WHERE singleton
	`).Scan(&entry.Frequency, &entry.Timezone, &entry.LocalTime, &entry.Weekday,
		&entry.OrganizeModelID, &entry.VisionModelID, &entry.SensitivePolicy)
	return entry, err
}

func (service *Service) updateSchedule(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input struct {
		Frequency       string `json:"frequency"`
		Timezone        string `json:"timezone"`
		LocalTime       string `json:"localTime"`
		Weekday         int    `json:"weekday"`
		OrganizeModelID string `json:"organizeModelId"`
		VisionModelID   string `json:"visionModelId"`
		SensitivePolicy string `json:"sensitivePolicy"`
	}
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil ||
		(input.Frequency != "off" && input.Frequency != "daily" && input.Frequency != "weekly") ||
		!localTimePattern.MatchString(input.LocalTime) || !validTaskPolicy(input.SensitivePolicy) ||
		(input.Frequency == "weekly" && (input.Weekday < 1 || input.Weekday > 7)) {
		writeTaskValidation(response, request)
		return
	}
	if _, err := time.LoadLocation(input.Timezone); err != nil {
		writeTaskValidation(response, request)
		return
	}
	var globalPolicy string
	if err := service.database.QueryRow(request.Context(), `SELECT sensitive_ai_policy FROM app_settings WHERE singleton`).Scan(&globalPolicy); err != nil {
		writeTaskInternal(response, request)
		return
	}
	if policyRank(input.SensitivePolicy) > policyRank(globalPolicy) {
		writeTaskValidation(response, request)
		return
	}
	var organizeModelID, visionModelID *uuid.UUID
	if input.OrganizeModelID != "" {
		id, err := uuid.Parse(input.OrganizeModelID)
		if err != nil {
			writeTaskValidation(response, request)
			return
		}
		if _, err := service.loadEnabledTaskModel(request.Context(), id); err != nil {
			writeTaskValidation(response, request)
			return
		}
		organizeModelID = &id
	}
	if input.Frequency != "off" && organizeModelID == nil {
		writeTaskValidation(response, request)
		return
	}
	if input.VisionModelID != "" {
		id, err := uuid.Parse(input.VisionModelID)
		if err != nil {
			writeTaskValidation(response, request)
			return
		}
		model, err := service.loadEnabledTaskModel(request.Context(), id)
		if err != nil || !model.SupportsVision {
			writeTaskValidation(response, request)
			return
		}
		visionModelID = &id
	}
	weekday := input.Weekday
	if input.Frequency != "weekly" {
		weekday = 1
	}
	_, err := service.database.Exec(request.Context(), `
		UPDATE app_settings SET scheduled_organize = $1, schedule_timezone = $2,
		       schedule_local_time = $3::time, schedule_weekday = $4,
		       schedule_organize_model_id = $5, schedule_vision_model_id = $6,
		       schedule_sensitive_policy = $7, updated_at = $8
		WHERE singleton
	`, input.Frequency, input.Timezone, input.LocalTime, weekday, organizeModelID,
		visionModelID, input.SensitivePolicy, service.now().UTC())
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	entry, err := service.loadSchedule(request.Context())
	if err != nil {
		writeTaskInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, entry)
}

func (service *Service) RunScheduler(ctx context.Context, logger *slog.Logger) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		if err := service.runScheduleWindow(ctx, service.now().UTC()); err != nil && !errors.Is(err, context.Canceled) {
			logger.ErrorContext(ctx, "ai_schedule_failed", "errorType", "scheduler")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (service *Service) runScheduleWindow(ctx context.Context, now time.Time) error {
	entry, err := service.loadSchedule(ctx)
	if err != nil || entry.Frequency == "off" || entry.OrganizeModelID == nil {
		return err
	}
	location, err := time.LoadLocation(entry.Timezone)
	if err != nil {
		return err
	}
	local := now.In(location)
	configured, err := time.Parse("15:04", entry.LocalTime)
	if err != nil {
		return err
	}
	if local.Hour()*60+local.Minute() < configured.Hour()*60+configured.Minute() {
		return nil
	}
	if entry.Frequency == "weekly" && int(local.Weekday()+6)%7+1 != entry.Weekday {
		return nil
	}
	key := entry.Frequency + ":" + local.Format("2006-01-02")
	var exists bool
	if err := service.database.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM ai_task_runs WHERE schedule_key = $1)`, key).Scan(&exists); err != nil || exists {
		return err
	}
	rows, err := service.database.Query(ctx, `
		WITH current_inputs AS (
			SELECT item.id,
			       MIN(record.effective_captured_at) AS oldest_at,
			       BOOL_OR(btrim(record.body) <> '') AS has_text,
			       to_jsonb(ARRAY(
				   SELECT current_record.id::text FROM raw_records current_record
				   WHERE current_record.item_id = item.id
				   ORDER BY current_record.effective_captured_at, current_record.id
			   )) AS raw_ids,
			       to_jsonb(ARRAY(
				   SELECT image.id::text FROM raw_records image_record
				   JOIN attachments image ON image.raw_record_id = image_record.id
				   WHERE image_record.item_id = item.id AND image.status = 'ready' AND image.kind = 'image'
				   ORDER BY image.created_at, image.id
			   )) AS image_ids
			FROM knowledge_items item JOIN raw_records record ON record.item_id = item.id
			WHERE item.deleted_at IS NULL GROUP BY item.id
		)
		SELECT current.id FROM current_inputs current
		WHERE (current.has_text AND NOT EXISTS (
			SELECT 1 FROM item_active_artifacts active
			JOIN ai_artifacts artifact ON artifact.id = active.artifact_id AND artifact.invalidated_at IS NULL
			JOIN ai_task_runs task ON task.id = artifact.task_run_id
			WHERE active.item_id = current.id AND active.artifact_type = 'organized_record'
			  AND task.input_snapshot->'rawRecordIds' = current.raw_ids
		)) OR (jsonb_array_length(current.image_ids) > 0 AND NOT EXISTS (
			SELECT 1 FROM item_active_artifacts active
			JOIN ai_artifacts artifact ON artifact.id = active.artifact_id AND artifact.invalidated_at IS NULL
			JOIN ai_task_runs task ON task.id = artifact.task_run_id
			WHERE active.item_id = current.id AND active.artifact_type = 'image_analysis'
			  AND task.input_snapshot->'attachmentIds' = current.image_ids
		))
		ORDER BY current.oldest_at, current.id LIMIT 20
	`)
	if err != nil {
		return err
	}
	itemIDs := make([]string, 0, 20)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		itemIDs = append(itemIDs, id.String())
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(itemIDs) == 0 {
		return nil
	}
	input := createTaskInput{
		TaskType: "batch_organize", ItemIDs: itemIDs,
		OrganizeModelID: entry.OrganizeModelID.String(), SensitivePolicy: entry.SensitivePolicy,
	}
	if entry.VisionModelID != nil {
		input.VisionModelID = entry.VisionModelID.String()
	}
	_, err = service.createBatchTask(ctx, input, "scheduled", key, nil)
	if errors.Is(err, errTaskAlreadyActive) || errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

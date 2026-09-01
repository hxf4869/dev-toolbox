package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

var searchFragmentNamespace = uuid.MustParse("30272dc4-6069-55f1-9c15-885cb9ac5bd0")

func (service *Service) completeTask(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	taskID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeInternalValidation(response, request)
		return
	}
	var input struct {
		WorkerID     string          `json:"workerId"`
		LeaseVersion int             `json:"leaseVersion"`
		Artifact     json.RawMessage `json:"artifact"`
		InputTokens  *int64          `json:"inputTokens"`
		OutputTokens *int64          `json:"outputTokens"`
	}
	if httpapi.DecodeJSON(response, request, maximumArtifactBytes+64*1024, &input) != nil ||
		!validWorkerID(input.WorkerID) || input.LeaseVersion < 1 || len(input.Artifact) == 0 ||
		len(input.Artifact) > maximumArtifactBytes || input.InputTokens != nil && *input.InputTokens < 0 ||
		input.OutputTokens != nil && *input.OutputTokens < 0 {
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
	var itemID, modelID uuid.UUID
	var taskType, status, promptVersion, schemaVersion, sensitivePolicy, sensitivity string
	var leaseOwner *string
	var claimAttempt int
	var leaseExpiresAt, cancelRequestedAt *time.Time
	var snapshotBytes []byte
	var parentID *uuid.UUID
	err = tx.QueryRow(request.Context(), `
		SELECT task.item_id, task.model_id, task.task_type, task.status,
		       task.prompt_version, task.schema_version, task.lease_owner,
		       task.claim_attempt, task.lease_expires_at, task.cancel_requested_at,
		       task.input_snapshot, task.parent_task_id, task.sensitive_policy,
		       item.sensitivity
		FROM ai_task_runs task
		JOIN knowledge_items item ON item.id = task.item_id
		WHERE task.id = $1 FOR UPDATE OF task
	`, taskID).Scan(&itemID, &modelID, &taskType, &status, &promptVersion, &schemaVersion,
		&leaseOwner, &claimAttempt, &leaseExpiresAt, &cancelRequestedAt, &snapshotBytes,
		&parentID, &sensitivePolicy, &sensitivity)
	if errors.Is(err, pgx.ErrNoRows) {
		writeLeaseConflict(response, request)
		return
	}
	if err != nil || leaseOwner == nil || *leaseOwner != input.WorkerID || claimAttempt != input.LeaseVersion {
		writeLeaseConflict(response, request)
		return
	}
	if existing, found, err := loadArtifactForTask(request.Context(), tx, taskID); err != nil {
		writeInternalFailure(response, request)
		return
	} else if found && status == "succeeded" {
		if tx.Commit(request.Context()) != nil {
			writeInternalFailure(response, request)
			return
		}
		existing.IsStale, err = service.isArtifactStale(request.Context(), existing.ItemID, existing.ArtifactType, existing.TaskRunID)
		if err != nil {
			writeInternalFailure(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, existing)
		return
	}
	if status != "running" || leaseExpiresAt == nil || leaseExpiresAt.Before(now) {
		writeLeaseConflict(response, request)
		return
	}
	if cancelRequestedAt != nil {
		if _, err := tx.Exec(request.Context(), `
			UPDATE ai_task_runs SET status = 'cancelled', finished_at = $2, lease_expires_at = NULL
			WHERE id = $1
		`, taskID, now); err != nil {
			writeInternalFailure(response, request)
			return
		}
		if _, err := tx.Exec(request.Context(), `
			INSERT INTO ai_task_events (task_id, event_type, summary, details, created_at)
			VALUES ($1, 'task_cancelled', '用户取消早于候选提交', '{}'::jsonb, $2)
		`, taskID, now); err != nil {
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
		writeLeaseConflict(response, request)
		return
	}
	var content map[string]any
	if json.Unmarshal(input.Artifact, &content) != nil {
		writeInternalValidation(response, request)
		return
	}
	if sensitivePolicy == "redact" && sensitivity != "normal" {
		NewTextRedactor().RedactArtifact(content)
		input.Artifact, err = json.Marshal(content)
		if err != nil || len(input.Artifact) > maximumArtifactBytes {
			writeInternalValidation(response, request)
			return
		}
	}
	if err := service.artifactValidator.ValidateJSON(input.Artifact); err != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "ARTIFACT_SCHEMA_INVALID", "Artifact 未通过契约校验")
		return
	}
	var snapshot taskInputSnapshot
	if json.Unmarshal(snapshotBytes, &snapshot) != nil {
		writeInternalFailure(response, request)
		return
	}
	validated, err := validateTaskArtifact(request.Context(), tx, itemID, taskType, schemaVersion, snapshot, content)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "ARTIFACT_SCHEMA_INVALID", "Artifact 未通过任务边界校验")
		return
	}
	var modelName string
	if err := tx.QueryRow(request.Context(), `SELECT display_name FROM provider_models WHERE id = $1`, modelID).Scan(&modelName); err != nil {
		writeInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `SELECT id FROM knowledge_items WHERE id = $1 FOR UPDATE`, itemID); err != nil {
		writeInternalFailure(response, request)
		return
	}
	artifactID := uuid.New()
	var version int
	if err := tx.QueryRow(request.Context(), `SELECT COALESCE(MAX(version_number), 0) + 1 FROM ai_artifacts WHERE item_id = $1 AND artifact_type = $2`, itemID, validated.ArtifactType).Scan(&version); err != nil {
		writeInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `
		INSERT INTO ai_artifacts (
			id, item_id, task_run_id, artifact_type, version_number, schema_version,
			content, generator, model_name, prompt_version, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'builtin_worker', $8, $9, $10)
	`, artifactID, itemID, taskID, validated.ArtifactType, version, schemaVersion,
		input.Artifact, modelName, promptVersion, now); err != nil {
		writeInternalFailure(response, request)
		return
	}
	for _, rawRecordID := range validated.SourceRecordIDs {
		if _, err := tx.Exec(request.Context(), `INSERT INTO artifact_sources (artifact_id, raw_record_id, fragment_ids) VALUES ($1, $2, $3)`, artifactID, rawRecordID, validated.FragmentByRaw[rawRecordID]); err != nil {
			writeInternalFailure(response, request)
			return
		}
	}
	autoActivate := validated.ArtifactType == "image_analysis"
	if validated.ArtifactType == "organized_record" {
		if err := tx.QueryRow(request.Context(), `SELECT auto_activate_organized FROM app_settings WHERE singleton`).Scan(&autoActivate); err != nil {
			writeInternalFailure(response, request)
			return
		}
	}
	searchText := artifactSearchText(content)
	for ordinal, fragmentText := range splitArtifactSearchText(searchText) {
		sourceKind := "ai_text"
		if validated.ArtifactType == "image_analysis" {
			sourceKind = "image_text"
		}
		fragmentKey := artifactID.String() + ":search"
		if ordinal > 0 {
			fragmentKey += ":" + strconv.Itoa(ordinal)
		}
		if _, err := tx.Exec(request.Context(), `
			INSERT INTO search_fragments (
				id, item_id, artifact_id, source_kind, ordinal, content,
				normalized_content, weight, active, created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, 2, $8, $9)
		`, uuid.NewSHA1(searchFragmentNamespace, []byte(fragmentKey)), itemID,
			artifactID, sourceKind, ordinal, fragmentText, normalizeArtifactSearch(fragmentText), autoActivate, now); err != nil {
			writeInternalFailure(response, request)
			return
		}
	}
	if autoActivate {
		if err := activateArtifactInTx(request.Context(), tx, itemID, validated.ArtifactType, artifactID, now); err != nil {
			writeInternalFailure(response, request)
			return
		}
	}
	if _, err := tx.Exec(request.Context(), `
		UPDATE ai_task_runs SET status = 'succeeded', finished_at = $2, lease_expires_at = NULL,
		       input_tokens = $3, output_tokens = $4 WHERE id = $1
	`, taskID, now, input.InputTokens, input.OutputTokens); err != nil {
		writeInternalFailure(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `INSERT INTO ai_task_events (task_id, event_type, summary, details, created_at) VALUES ($1, 'task_succeeded', '模型审阅完成', '{}'::jsonb, $2)`, taskID, now); err != nil {
		writeInternalFailure(response, request)
		return
	}
	if parentID != nil {
		if err := service.updateBatchParent(request.Context(), tx, *parentID, now); err != nil {
			writeInternalFailure(response, request)
			return
		}
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeInternalFailure(response, request)
		return
	}
	entry := artifactEntry{ID: artifactID, ItemID: itemID, TaskRunID: taskID,
		ArtifactType: validated.ArtifactType, VersionNumber: version, SchemaVersion: schemaVersion,
		Content: input.Artifact, Generator: "builtin_worker", ModelName: &modelName,
		PromptVersion: &promptVersion, CreatedAt: now, Active: autoActivate, IsStale: false}
	httpapi.WriteJSON(response, http.StatusCreated, entry)
}

func validateTaskArtifact(
	ctx context.Context,
	tx pgx.Tx,
	itemID uuid.UUID,
	taskType, schemaVersion string,
	snapshot taskInputSnapshot,
	content map[string]any,
) (validatedArtifact, error) {
	artifactType, _ := content["artifactType"].(string)
	if content["schemaVersion"] != schemaVersion || taskTypeForArtifact(artifactType) != taskType {
		return validatedArtifact{}, errInvalidProviderInput
	}
	topValues, ok := stringArray(content["sourceFragmentIds"])
	if !ok || taskType != "analyze_image" && len(topValues) == 0 {
		return validatedArtifact{}, errInvalidProviderInput
	}
	allowedFragments := make(map[uuid.UUID]struct{}, len(snapshot.FragmentIDs))
	for _, id := range snapshot.FragmentIDs {
		allowedFragments[id] = struct{}{}
	}
	topFragments := make(map[uuid.UUID]struct{}, len(topValues))
	for _, raw := range topValues {
		id, err := uuid.Parse(raw)
		if err != nil {
			return validatedArtifact{}, errInvalidProviderInput
		}
		if _, allowed := allowedFragments[id]; !allowed {
			return validatedArtifact{}, errInvalidProviderInput
		}
		topFragments[id] = struct{}{}
	}
	if !validateArtifactStructure(content, topFragments) || !validateEvidenceWarnings(content) {
		return validatedArtifact{}, errInvalidProviderInput
	}
	fragmentByRaw := make(map[uuid.UUID][]uuid.UUID, len(snapshot.RawRecordIDs))
	for _, id := range snapshot.RawRecordIDs {
		fragmentByRaw[id] = []uuid.UUID{}
	}
	if len(topFragments) > 0 {
		ids := make([]uuid.UUID, 0, len(topFragments))
		for id := range topFragments {
			ids = append(ids, id)
		}
		rows, err := tx.Query(ctx, `SELECT id, raw_record_id FROM search_fragments WHERE item_id = $1 AND id = ANY($2) AND raw_record_id = ANY($3)`, itemID, ids, snapshot.RawRecordIDs)
		if err != nil {
			return validatedArtifact{}, err
		}
		count := 0
		for rows.Next() {
			var fragmentID, rawRecordID uuid.UUID
			if err := rows.Scan(&fragmentID, &rawRecordID); err != nil {
				rows.Close()
				return validatedArtifact{}, err
			}
			fragmentByRaw[rawRecordID] = append(fragmentByRaw[rawRecordID], fragmentID)
			count++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return validatedArtifact{}, err
		}
		rows.Close()
		if count != len(topFragments) {
			return validatedArtifact{}, errInvalidProviderInput
		}
	}
	attachmentIDs, imageIDs, attachmentKinds, ok := artifactAttachmentIDs(content)
	if !ok {
		return validatedArtifact{}, errInvalidProviderInput
	}
	allowedAttachments := make(map[uuid.UUID]struct{}, len(snapshot.AttachmentIDs))
	for _, id := range snapshot.AttachmentIDs {
		allowedAttachments[id] = struct{}{}
	}
	for id := range attachmentIDs {
		if _, allowed := allowedAttachments[id]; !allowed {
			return validatedArtifact{}, errInvalidProviderInput
		}
	}
	if !validateStoredAttachmentKinds(ctx, tx, itemID, attachmentIDs, attachmentKinds) {
		return validatedArtifact{}, errInvalidProviderInput
	}
	if taskType == "analyze_image" {
		if len(imageIDs) != len(snapshot.AttachmentIDs) {
			return validatedArtifact{}, errInvalidProviderInput
		}
		for _, id := range snapshot.AttachmentIDs {
			if _, covered := imageIDs[id]; !covered {
				return validatedArtifact{}, errInvalidProviderInput
			}
		}
	}
	return validatedArtifact{ArtifactType: artifactType, SourceRecordIDs: snapshot.RawRecordIDs,
		FragmentIDs: mapKeys(topFragments), FragmentByRaw: fragmentByRaw,
		AttachmentIDs: mapKeys(attachmentIDs)}, nil
}

func validateEvidenceWarnings(content map[string]any) bool {
	warnings, _ := content["warnings"].([]any)
	for _, raw := range warnings {
		warning, _ := raw.(map[string]any)
		if warning["basis"] == "source_evidence" {
			values, ok := stringArray(warning["sourceFragmentIds"])
			if !ok || len(values) == 0 {
				return false
			}
		}
	}
	return true
}

func artifactAttachmentIDs(content map[string]any) (map[uuid.UUID]struct{}, map[uuid.UUID]struct{}, map[uuid.UUID]string, bool) {
	all := map[uuid.UUID]struct{}{}
	images := map[uuid.UUID]struct{}{}
	kinds := map[uuid.UUID]string{}
	blocks, _ := content["blocks"].([]any)
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		kind, _ := block["type"].(string)
		if kind != "image_reference" && kind != "attachment_reference" {
			continue
		}
		value, _ := block["attachmentId"].(string)
		id, err := uuid.Parse(value)
		if err != nil {
			return nil, nil, nil, false
		}
		expectedKind := "file"
		if kind == "image_reference" {
			expectedKind = "image"
		}
		if previous, exists := kinds[id]; exists && previous != expectedKind {
			return nil, nil, nil, false
		}
		all[id] = struct{}{}
		kinds[id] = expectedKind
		if kind == "image_reference" {
			images[id] = struct{}{}
		}
	}
	return all, images, kinds, true
}

type attachmentQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func validateStoredAttachmentKinds(
	ctx context.Context,
	querier attachmentQuerier,
	itemID uuid.UUID,
	ids map[uuid.UUID]struct{},
	expected map[uuid.UUID]string,
) bool {
	if len(ids) == 0 {
		return true
	}
	values := mapKeys(ids)
	rows, err := querier.Query(ctx, `
		SELECT attachment.id, attachment.kind FROM attachments attachment
		JOIN raw_records record ON record.id = attachment.raw_record_id
		WHERE attachment.id = ANY($1) AND record.item_id = $2 AND attachment.status = 'ready'
	`, values, itemID)
	if err != nil {
		return false
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id uuid.UUID
		var kind string
		if rows.Scan(&id, &kind) != nil || expected[id] != kind {
			return false
		}
		count++
	}
	return rows.Err() == nil && count == len(ids)
}

func mapKeys(values map[uuid.UUID]struct{}) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(values))
	for id := range values {
		result = append(result, id)
	}
	return result
}

func loadArtifactForTask(ctx context.Context, tx pgx.Tx, taskID uuid.UUID) (artifactEntry, bool, error) {
	var entry artifactEntry
	err := tx.QueryRow(ctx, `
		SELECT artifact.id, artifact.item_id, artifact.task_run_id, artifact.artifact_type,
		       artifact.version_number, artifact.schema_version, artifact.content,
		       artifact.generator, artifact.model_name, artifact.prompt_version,
		       artifact.created_at, artifact.invalidated_at,
		       active.artifact_id IS NOT NULL
		FROM ai_artifacts artifact
		LEFT JOIN item_active_artifacts active ON active.artifact_id = artifact.id
		WHERE artifact.task_run_id = $1
	`, taskID).Scan(&entry.ID, &entry.ItemID, &entry.TaskRunID, &entry.ArtifactType,
		&entry.VersionNumber, &entry.SchemaVersion, &entry.Content, &entry.Generator,
		&entry.ModelName, &entry.PromptVersion, &entry.CreatedAt, &entry.InvalidatedAt, &entry.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		return artifactEntry{}, false, nil
	}
	return entry, err == nil, err
}

func activateArtifactInTx(ctx context.Context, tx pgx.Tx, itemID uuid.UUID, artifactType string, artifactID uuid.UUID, now time.Time) error {
	if _, err := tx.Exec(ctx, `
		UPDATE search_fragments SET active = false WHERE artifact_id IN (
			SELECT artifact_id FROM item_active_artifacts WHERE item_id = $1 AND artifact_type = $2
		)
	`, itemID, artifactType); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO item_active_artifacts (item_id, artifact_type, artifact_id, activated_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (item_id, artifact_type) DO UPDATE
		SET artifact_id = EXCLUDED.artifact_id, activated_at = EXCLUDED.activated_at
	`, itemID, artifactType, artifactID, now); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE search_fragments SET active = true WHERE artifact_id = $1`, artifactID)
	return err
}

func (service *Service) activateArtifact(response http.ResponseWriter, request *http.Request) {
	service.mutateArtifactState(response, request, "activate")
}

func (service *Service) invalidateArtifact(response http.ResponseWriter, request *http.Request) {
	service.mutateArtifactState(response, request, "invalidate")
}

func (service *Service) mutateArtifactState(response http.ResponseWriter, request *http.Request, action string) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeArtifactNotFound(response, request)
		return
	}
	now := service.now().UTC()
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var itemID uuid.UUID
	var artifactType string
	var invalidatedAt *time.Time
	if err := tx.QueryRow(request.Context(), `SELECT item_id, artifact_type, invalidated_at FROM ai_artifacts WHERE id = $1 FOR UPDATE`, id).Scan(&itemID, &artifactType, &invalidatedAt); errors.Is(err, pgx.ErrNoRows) {
		writeArtifactNotFound(response, request)
		return
	} else if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	if action == "activate" {
		if invalidatedAt != nil {
			httpapi.WriteError(response, request, http.StatusConflict, "VALIDATION_FAILED", "已作废 Artifact 不能激活")
			return
		}
		if err := activateArtifactInTx(request.Context(), tx, itemID, artifactType, id, now); err != nil {
			writeArtifactInternal(response, request)
			return
		}
	} else if invalidatedAt == nil {
		if _, err := tx.Exec(request.Context(), `UPDATE ai_artifacts SET invalidated_at = $2 WHERE id = $1`, id, now); err != nil {
			writeArtifactInternal(response, request)
			return
		}
		if _, err := tx.Exec(request.Context(), `DELETE FROM item_active_artifacts WHERE artifact_id = $1`, id); err != nil {
			writeArtifactInternal(response, request)
			return
		}
		if _, err := tx.Exec(request.Context(), `UPDATE search_fragments SET active = false WHERE artifact_id = $1`, id); err != nil {
			writeArtifactInternal(response, request)
			return
		}
	}
	if tx.Commit(request.Context()) != nil {
		writeArtifactInternal(response, request)
		return
	}
	entry, err := service.loadArtifact(request.Context(), id)
	if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, entry)
}

func (service *Service) applyArtifactSuggestions(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	var input struct {
		Title  bool     `json:"title"`
		Folder bool     `json:"folder"`
		Tags   []string `json:"tags"`
	}
	if err != nil || httpapi.DecodeJSON(response, request, 16*1024, &input) != nil || !input.Title && !input.Folder && len(input.Tags) == 0 {
		writeArtifactSchemaError(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var itemID uuid.UUID
	var encoded []byte
	var invalidatedAt *time.Time
	if err := tx.QueryRow(request.Context(), `SELECT item_id, content, invalidated_at FROM ai_artifacts WHERE id = $1 FOR UPDATE`, id).Scan(&itemID, &encoded, &invalidatedAt); errors.Is(err, pgx.ErrNoRows) {
		writeArtifactNotFound(response, request)
		return
	} else if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	if invalidatedAt != nil {
		httpapi.WriteError(response, request, http.StatusConflict, "VALIDATION_FAILED", "已作废 Artifact 不能应用建议")
		return
	}
	var content map[string]any
	if json.Unmarshal(encoded, &content) != nil {
		writeArtifactInternal(response, request)
		return
	}
	classification, _ := content["classification"].(map[string]any)
	suggestedTags, ok := stringArray(classification["suggestedTags"])
	if !ok || !selectedSuggestions(input.Tags, suggestedTags) {
		writeArtifactSchemaError(response, request)
		return
	}
	now := service.now().UTC()
	if input.Title {
		title, _ := content["title"].(string)
		if strings.TrimSpace(title) == "" || !utf8.ValidString(title) || len([]rune(title)) > 200 {
			writeArtifactSchemaError(response, request)
			return
		}
		if _, err := tx.Exec(request.Context(), `UPDATE knowledge_items SET title = $2, title_origin = 'user', updated_at = $3 WHERE id = $1`, itemID, strings.TrimSpace(title), now); err != nil {
			writeArtifactInternal(response, request)
			return
		}
	}
	if input.Folder {
		path, ok := stringArray(classification["suggestedFolderPath"])
		if !ok {
			writeArtifactSchemaError(response, request)
			return
		}
		folderID, err := ensureFolderPath(request.Context(), tx, path, now)
		if err != nil {
			writeArtifactInternal(response, request)
			return
		}
		if _, err := tx.Exec(request.Context(), `UPDATE knowledge_items SET folder_id = $2, updated_at = $3 WHERE id = $1`, itemID, folderID, now); err != nil {
			writeArtifactInternal(response, request)
			return
		}
	}
	if len(input.Tags) > 0 {
		if _, err := tx.Exec(request.Context(), `DELETE FROM item_tags WHERE item_id = $1`, itemID); err != nil {
			writeArtifactInternal(response, request)
			return
		}
		for _, name := range input.Tags {
			tagID, err := ensureTag(request.Context(), tx, name, now)
			if err != nil {
				writeArtifactInternal(response, request)
				return
			}
			if _, err := tx.Exec(request.Context(), `INSERT INTO item_tags (item_id, tag_id, created_at) VALUES ($1, $2, $3)`, itemID, tagID, now); err != nil {
				writeArtifactInternal(response, request)
				return
			}
		}
	}
	if err := rebuildAppliedMetadata(request.Context(), tx, itemID, now); err != nil {
		writeArtifactInternal(response, request)
		return
	}
	if tx.Commit(request.Context()) != nil {
		writeArtifactInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"applied": true, "itemId": itemID})
}

func selectedSuggestions(selected, suggested []string) bool {
	allowed := map[string]struct{}{}
	for _, value := range suggested {
		allowed[foldName(value)] = struct{}{}
	}
	seen := map[string]struct{}{}
	for _, value := range selected {
		key := foldName(value)
		if key == "" {
			return false
		}
		if _, ok := allowed[key]; !ok {
			return false
		}
		if _, duplicate := seen[key]; duplicate {
			return false
		}
		seen[key] = struct{}{}
	}
	return true
}

func ensureFolderPath(ctx context.Context, tx pgx.Tx, segments []string, now time.Time) (*uuid.UUID, error) {
	var parentID *uuid.UUID
	for _, raw := range segments {
		name := strings.TrimSpace(raw)
		if name == "" || len([]rune(name)) > 80 {
			return nil, errInvalidProviderInput
		}
		var id uuid.UUID
		var err error
		if parentID == nil {
			err = tx.QueryRow(ctx, `
				INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at)
				VALUES ($1, NULL, $2, 0, $3, $3)
				ON CONFLICT (lower(name)) WHERE parent_id IS NULL
				DO UPDATE SET name = folders.name RETURNING id
			`, uuid.New(), name, now).Scan(&id)
		} else {
			err = tx.QueryRow(ctx, `
				INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at)
				VALUES ($1, $2, $3, 0, $4, $4)
				ON CONFLICT (parent_id, lower(name)) WHERE parent_id IS NOT NULL
				DO UPDATE SET name = folders.name RETURNING id
			`, uuid.New(), parentID, name, now).Scan(&id)
		}
		if err != nil {
			return nil, err
		}
		parentID = &id
	}
	return parentID, nil
}

func ensureTag(ctx context.Context, tx pgx.Tx, raw string, now time.Time) (uuid.UUID, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len([]rune(name)) > 40 {
		return uuid.Nil, errInvalidProviderInput
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		INSERT INTO tags (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)
		ON CONFLICT (lower(name)) DO UPDATE SET name = tags.name RETURNING id
	`, uuid.New(), name, now).Scan(&id)
	return id, err
}

func rebuildAppliedMetadata(ctx context.Context, tx pgx.Tx, itemID uuid.UUID, now time.Time) error {
	var title string
	if err := tx.QueryRow(ctx, `SELECT title FROM knowledge_items WHERE id = $1 FOR UPDATE`, itemID).Scan(&title); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM search_fragments WHERE item_id = $1 AND source_kind IN ('title', 'metadata')`, itemID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO search_fragments (id, item_id, source_kind, ordinal, content, normalized_content, weight, active, created_at) VALUES ($1, $2, 'title', 0, $3, $4, 4, true, $5)`, uuid.NewSHA1(searchFragmentNamespace, []byte(itemID.String()+":title")), itemID, title, normalizeArtifactSearch(title), now); err != nil {
		return err
	}
	var note, folderPath *string
	if err := tx.QueryRow(ctx, `
		WITH RECURSIVE item_folder AS (
			SELECT folder.id, folder.parent_id, folder.name, 1 AS depth
			FROM knowledge_items item JOIN folders folder ON folder.id = item.folder_id WHERE item.id = $1
			UNION ALL
			SELECT parent.id, parent.parent_id, parent.name, item_folder.depth + 1
			FROM folders parent JOIN item_folder ON item_folder.parent_id = parent.id
		), path AS (SELECT string_agg(name, ' / ' ORDER BY depth DESC) AS value FROM item_folder)
		SELECT item.note, path.value FROM knowledge_items item CROSS JOIN path WHERE item.id = $1
	`, itemID).Scan(&note, &folderPath); err != nil {
		return err
	}
	values := []string{}
	if note != nil && strings.TrimSpace(*note) != "" {
		values = append(values, *note)
	}
	if folderPath != nil && *folderPath != "" {
		values = append(values, *folderPath)
	}
	rows, err := tx.Query(ctx, `SELECT tag.name FROM tags tag JOIN item_tags link ON link.tag_id = tag.id WHERE link.item_id = $1 ORDER BY lower(tag.name), tag.id`, itemID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			rows.Close()
			return err
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	metadata := strings.Join(values, "\n")
	if metadata != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO search_fragments (id, item_id, source_kind, ordinal, content, normalized_content, weight, active, created_at) VALUES ($1, $2, 'metadata', 0, $3, $4, 2, true, $5)`, uuid.NewSHA1(searchFragmentNamespace, []byte(itemID.String()+":metadata")), itemID, metadata, normalizeArtifactSearch(metadata), now); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE knowledge_items SET updated_at = $2 WHERE id = $1`, itemID, now)
	return err
}

func artifactSearchText(content map[string]any) string {
	values := []string{}
	collectArtifactStrings(content, "", &values)
	return strings.Join(values, "\n")
}

const artifactSearchFragmentMaximum = 4 * 1024

func splitArtifactSearchText(value string) []string {
	fragments := []string{}
	for start := 0; start < len(value); {
		end := min(start+artifactSearchFragmentMaximum, len(value))
		for end < len(value) && end > start && !utf8.RuneStart(value[end]) {
			end--
		}
		if end < len(value) {
			if boundary := strings.LastIndex(value[start:end], "\n"); boundary >= artifactSearchFragmentMaximum/2 {
				end = start + boundary + 1
			}
		}
		fragment := value[start:end]
		if strings.TrimSpace(fragment) != "" {
			fragments = append(fragments, fragment)
		}
		start = end
	}
	return fragments
}

func collectArtifactStrings(value any, key string, output *[]string) {
	switch typed := value.(type) {
	case map[string]any:
		for nestedKey, nested := range typed {
			if nestedKey == "id" || nestedKey == "type" || nestedKey == "attachmentId" || nestedKey == "sourceFragmentIds" || nestedKey == "schemaVersion" || nestedKey == "artifactType" || nestedKey == "basis" || nestedKey == "status" {
				continue
			}
			collectArtifactStrings(nested, nestedKey, output)
		}
	case []any:
		for _, nested := range typed {
			collectArtifactStrings(nested, key, output)
		}
	case string:
		if strings.TrimSpace(typed) != "" {
			*output = append(*output, typed)
		}
	}
}

func normalizeArtifactSearch(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

func foldName(value string) string {
	return strings.Map(func(character rune) rune { return unicode.ToLower(character) }, strings.TrimSpace(value))
}

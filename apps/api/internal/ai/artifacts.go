package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const maximumArtifactBytes = 2 * 1024 * 1024

var rawHTMLPattern = regexp.MustCompile(`(?i)<(?:/?[a-z][^>]*|!--|!doctype\b|\?xml\b)[^>]*>`)
var redactionPlaceholderPattern = regexp.MustCompile(`<(?:PRIVATE_KEY|CREDENTIAL|PASSWORD|USERNAME|API_KEY|TOKEN|SECRET|INTERNAL_IP)_[1-9][0-9]*>`)

type artifactEntry struct {
	ID            uuid.UUID       `json:"id"`
	ItemID        uuid.UUID       `json:"itemId"`
	TaskRunID     uuid.UUID       `json:"taskRunId"`
	ArtifactType  string          `json:"artifactType"`
	VersionNumber int             `json:"versionNumber"`
	SchemaVersion string          `json:"schemaVersion"`
	Content       json.RawMessage `json:"content,omitempty"`
	Generator     string          `json:"generator"`
	ModelName     *string         `json:"modelName"`
	PromptVersion *string         `json:"promptVersion"`
	CreatedAt     time.Time       `json:"createdAt"`
	InvalidatedAt *time.Time      `json:"invalidatedAt"`
	Active        bool            `json:"active"`
	IsStale       bool            `json:"isStale"`
}

type externalArtifactInput struct {
	Generator          string          `json:"generator"`
	GeneratorName      string          `json:"generatorName"`
	ModelName          string          `json:"modelName"`
	SchemaVersion      string          `json:"schemaVersion"`
	SourceRawRecordIDs []string        `json:"sourceRawRecordIds"`
	Content            json.RawMessage `json:"content"`
}

type validatedArtifact struct {
	ArtifactType    string
	SourceRecordIDs []uuid.UUID
	FragmentIDs     []uuid.UUID
	FragmentByRaw   map[uuid.UUID][]uuid.UUID
	AttachmentIDs   []uuid.UUID
}

func (service *Service) createExternalArtifact(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		writeArtifactNotFound(response, request)
		return
	}
	var input externalArtifactInput
	if httpapi.DecodeJSON(response, request, maximumArtifactBytes+64*1024, &input) != nil ||
		input.Generator != "external_agent" || input.SchemaVersion != "1.0" ||
		!validSnapshotName(input.GeneratorName, 120) || !validSnapshotName(input.ModelName, 200) ||
		len(input.Content) == 0 || len(input.Content) > maximumArtifactBytes {
		writeArtifactSchemaError(response, request)
		return
	}
	if err := service.artifactValidator.ValidateJSON(input.Content); err != nil {
		writeArtifactSchemaError(response, request)
		return
	}
	validated, sensitivity, err := service.validateExternalArtifact(request, itemID, input)
	if errors.Is(err, pgx.ErrNoRows) {
		writeArtifactNotFound(response, request)
		return
	}
	if err != nil {
		writeArtifactSchemaError(response, request)
		return
	}
	actor, _ := auth.ActorFromContext(request.Context())
	if actor.Type == "pat" && sensitivity != "normal" && !actor.HasScope("sensitive:read") {
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 无权为敏感记录提交 Artifact")
		return
	}

	now := service.now().UTC()
	taskID, artifactID := uuid.New(), uuid.New()
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var lockedSensitivity string
	if err := tx.QueryRow(request.Context(), `
		SELECT sensitivity FROM knowledge_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE
	`, itemID).Scan(&lockedSensitivity); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeArtifactNotFound(response, request)
		} else {
			writeArtifactInternal(response, request)
		}
		return
	}
	if actor.Type == "pat" && lockedSensitivity != "normal" && !actor.HasScope("sensitive:read") {
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 无权为敏感记录提交 Artifact")
		return
	}
	snapshot, _ := json.Marshal(map[string]any{
		"rawRecordIds":  validated.SourceRecordIDs,
		"fragmentIds":   validated.FragmentIDs,
		"attachmentIds": validated.AttachmentIDs,
		"generatorName": input.GeneratorName,
		"modelName":     input.ModelName,
	})
	taskType := taskTypeForArtifact(validated.ArtifactType)
	if _, err := tx.Exec(request.Context(), `
		INSERT INTO ai_task_runs (
			id, task_type, item_id, trigger_type, status, sensitive_policy,
			prompt_version, schema_version, input_snapshot, queued_at, started_at, finished_at
		) VALUES ($1, $2, $3, 'external', 'succeeded', 'block', 'external-v1', $4, $5::jsonb, $6, $6, $6)
	`, taskID, taskType, itemID, input.SchemaVersion, snapshot, now); err != nil {
		writeArtifactInternal(response, request)
		return
	}
	var version int
	if err := tx.QueryRow(request.Context(), `
		SELECT COALESCE(MAX(version_number), 0) + 1 FROM ai_artifacts
		WHERE item_id = $1 AND artifact_type = $2
	`, itemID, validated.ArtifactType).Scan(&version); err != nil {
		writeArtifactInternal(response, request)
		return
	}
	if _, err := tx.Exec(request.Context(), `
		INSERT INTO ai_artifacts (
			id, item_id, task_run_id, artifact_type, version_number, schema_version,
			content, generator, model_name, prompt_version, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'external_agent', $8, 'external-v1', $9)
	`, artifactID, itemID, taskID, validated.ArtifactType, version, input.SchemaVersion, input.Content, input.ModelName, now); err != nil {
		writeArtifactInternal(response, request)
		return
	}
	for _, rawRecordID := range validated.SourceRecordIDs {
		if _, err := tx.Exec(request.Context(), `
			INSERT INTO artifact_sources (artifact_id, raw_record_id, fragment_ids) VALUES ($1, $2, $3)
		`, artifactID, rawRecordID, validated.FragmentByRaw[rawRecordID]); err != nil {
			writeArtifactInternal(response, request)
			return
		}
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeArtifactInternal(response, request)
		return
	}
	entry, err := service.loadArtifact(request.Context(), artifactID)
	if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusCreated, entry)
}

func (service *Service) validateExternalArtifact(request *http.Request, itemID uuid.UUID, input externalArtifactInput) (validatedArtifact, string, error) {
	var sensitivity string
	if err := service.database.QueryRow(request.Context(), `SELECT sensitivity FROM knowledge_items WHERE id = $1 AND deleted_at IS NULL`, itemID).Scan(&sensitivity); err != nil {
		return validatedArtifact{}, "", err
	}
	if len(input.SourceRawRecordIDs) == 0 || len(input.SourceRawRecordIDs) > 100 {
		return validatedArtifact{}, "", errInvalidProviderInput
	}
	recordIDs := make([]uuid.UUID, 0, len(input.SourceRawRecordIDs))
	seenRecords := map[uuid.UUID]struct{}{}
	for _, value := range input.SourceRawRecordIDs {
		id, err := uuid.Parse(value)
		if err != nil {
			return validatedArtifact{}, "", errInvalidProviderInput
		}
		if _, duplicate := seenRecords[id]; duplicate {
			return validatedArtifact{}, "", errInvalidProviderInput
		}
		seenRecords[id] = struct{}{}
		recordIDs = append(recordIDs, id)
	}
	var recordCount int
	if err := service.database.QueryRow(request.Context(), `SELECT COUNT(*) FROM raw_records WHERE item_id = $1 AND id = ANY($2)`, itemID, recordIDs).Scan(&recordCount); err != nil || recordCount != len(recordIDs) {
		return validatedArtifact{}, "", errInvalidProviderInput
	}
	var content map[string]any
	decoder := json.NewDecoder(bytes.NewReader(input.Content))
	if decoder.Decode(&content) != nil {
		return validatedArtifact{}, "", errInvalidProviderInput
	}
	artifactType, _ := content["artifactType"].(string)
	if content["schemaVersion"] != input.SchemaVersion || taskTypeForArtifact(artifactType) == "" {
		return validatedArtifact{}, "", errInvalidProviderInput
	}
	topFragmentIDs, ok := stringArray(content["sourceFragmentIds"])
	if !ok {
		return validatedArtifact{}, "", errInvalidProviderInput
	}
	topFragments := map[uuid.UUID]struct{}{}
	for _, value := range topFragmentIDs {
		id, err := uuid.Parse(value)
		if err != nil {
			return validatedArtifact{}, "", errInvalidProviderInput
		}
		topFragments[id] = struct{}{}
	}
	if (artifactType == "organized_record" || artifactType == "correctness_review") && len(topFragments) == 0 {
		return validatedArtifact{}, "", errInvalidProviderInput
	}
	if !validateArtifactStructure(content, topFragments) || !validateEvidenceWarnings(content) {
		return validatedArtifact{}, "", errInvalidProviderInput
	}
	fragmentByRaw := make(map[uuid.UUID][]uuid.UUID, len(recordIDs))
	for _, id := range recordIDs {
		fragmentByRaw[id] = []uuid.UUID{}
	}
	if len(topFragments) > 0 {
		ids := make([]uuid.UUID, 0, len(topFragments))
		for id := range topFragments {
			ids = append(ids, id)
		}
		rows, err := service.database.Query(request.Context(), `
			SELECT id, raw_record_id FROM search_fragments
			WHERE id = ANY($1) AND raw_record_id = ANY($2) AND source_kind IN ('raw_text', 'code')
		`, ids, recordIDs)
		if err != nil {
			return validatedArtifact{}, "", err
		}
		count := 0
		for rows.Next() {
			var fragmentID, rawRecordID uuid.UUID
			if err := rows.Scan(&fragmentID, &rawRecordID); err != nil {
				rows.Close()
				return validatedArtifact{}, "", err
			}
			fragmentByRaw[rawRecordID] = append(fragmentByRaw[rawRecordID], fragmentID)
			count++
		}
		if rows.Err() != nil {
			rows.Close()
			return validatedArtifact{}, "", rows.Err()
		}
		rows.Close()
		if count != len(topFragments) {
			return validatedArtifact{}, "", errInvalidProviderInput
		}
	}
	attachmentIDs, _, _, ok := artifactAttachmentIDs(content)
	if !ok || !service.validateArtifactAttachments(request, itemID, content) {
		return validatedArtifact{}, "", errInvalidProviderInput
	}
	return validatedArtifact{ArtifactType: artifactType, SourceRecordIDs: recordIDs,
		FragmentIDs: mapKeys(topFragments), FragmentByRaw: fragmentByRaw,
		AttachmentIDs: mapKeys(attachmentIDs)}, sensitivity, nil
}

func validateArtifactStructure(content map[string]any, topFragments map[uuid.UUID]struct{}) bool {
	blocks, ok := content["blocks"].([]any)
	if !ok {
		return false
	}
	blockIDs := map[string]struct{}{}
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if !ok {
			return false
		}
		id, _ := block["id"].(string)
		if _, duplicate := blockIDs[id]; duplicate {
			return false
		}
		blockIDs[id] = struct{}{}
		if block["type"] == "markdown" {
			markdown, _ := block["markdown"].(string)
			if containsRawArtifactHTML(markdown) {
				return false
			}
		}
		if block["type"] == "table" {
			columns, _ := block["columns"].([]any)
			rows, _ := block["rows"].([]any)
			for _, rawRow := range rows {
				row, _ := rawRow.([]any)
				if len(row) != len(columns) {
					return false
				}
			}
		}
	}
	classification, _ := content["classification"].(map[string]any)
	tags, _ := classification["suggestedTags"].([]any)
	seenTags := map[string]struct{}{}
	for _, raw := range tags {
		tag, _ := raw.(string)
		normalized := strings.Map(func(r rune) rune { return unicode.ToLower(r) }, strings.TrimSpace(tag))
		if _, duplicate := seenTags[normalized]; duplicate {
			return false
		}
		seenTags[normalized] = struct{}{}
	}
	return walkArtifactReferences(content, topFragments)
}

func containsRawArtifactHTML(markdown string) bool {
	return rawHTMLPattern.MatchString(redactionPlaceholderPattern.ReplaceAllString(markdown, ""))
}

func walkArtifactReferences(value any, top map[uuid.UUID]struct{}) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, nested := range typed {
			if key == "sourceFragmentIds" {
				values, ok := stringArray(nested)
				if !ok {
					return false
				}
				for _, value := range values {
					id, err := uuid.Parse(value)
					if err != nil {
						return false
					}
					if _, allowed := top[id]; !allowed {
						return false
					}
				}
			}
			if !walkArtifactReferences(nested, top) {
				return false
			}
		}
	case []any:
		for _, nested := range typed {
			if !walkArtifactReferences(nested, top) {
				return false
			}
		}
	}
	return true
}

func stringArray(value any) ([]string, bool) {
	raw, ok := value.([]any)
	if !ok {
		return nil, false
	}
	result := make([]string, 0, len(raw))
	for _, value := range raw {
		text, ok := value.(string)
		if !ok {
			return nil, false
		}
		result = append(result, text)
	}
	return result, true
}

func (service *Service) validateArtifactAttachments(request *http.Request, itemID uuid.UUID, content map[string]any) bool {
	ids, images, kinds, ok := artifactAttachmentIDs(content)
	if !ok || content["artifactType"] == "image_analysis" && len(images) == 0 {
		return false
	}
	return validateStoredAttachmentKinds(request.Context(), service.database, itemID, ids, kinds)
}

func (service *Service) listArtifacts(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		writeArtifactNotFound(response, request)
		return
	}
	allowed, err := service.canReadArtifactItem(request, itemID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeArtifactNotFound(response, request)
		return
	}
	if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	if !allowed {
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 无权读取敏感 Artifact")
		return
	}
	rows, err := service.database.Query(request.Context(), `
		SELECT artifact.id, artifact.item_id, artifact.task_run_id, artifact.artifact_type,
		       artifact.version_number, artifact.schema_version, artifact.generator,
		       artifact.model_name, artifact.prompt_version, artifact.created_at,
		       artifact.invalidated_at, active.artifact_id IS NOT NULL
		FROM ai_artifacts artifact
		LEFT JOIN item_active_artifacts active ON active.artifact_id = artifact.id
		WHERE artifact.item_id = $1 ORDER BY artifact.created_at DESC, artifact.id DESC
	`, itemID)
	if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	defer rows.Close()
	items := make([]artifactEntry, 0)
	for rows.Next() {
		var entry artifactEntry
		if err := rows.Scan(&entry.ID, &entry.ItemID, &entry.TaskRunID, &entry.ArtifactType,
			&entry.VersionNumber, &entry.SchemaVersion, &entry.Generator, &entry.ModelName,
			&entry.PromptVersion, &entry.CreatedAt, &entry.InvalidatedAt, &entry.Active); err != nil {
			writeArtifactInternal(response, request)
			return
		}
		items = append(items, entry)
	}
	if rows.Err() != nil {
		writeArtifactInternal(response, request)
		return
	}
	rows.Close()
	for index := range items {
		stale, err := service.isArtifactStale(request.Context(), items[index].ItemID, items[index].ArtifactType, items[index].TaskRunID)
		if err != nil {
			writeArtifactInternal(response, request)
			return
		}
		items[index].IsStale = stale
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (service *Service) getArtifact(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeArtifactNotFound(response, request)
		return
	}
	entry, err := service.loadArtifact(request.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeArtifactNotFound(response, request)
		return
	}
	if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	allowed, err := service.canReadArtifactItem(request, entry.ItemID)
	if err != nil {
		writeArtifactInternal(response, request)
		return
	}
	if !allowed {
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 无权读取敏感 Artifact")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, entry)
}

func (service *Service) loadArtifact(ctx context.Context, id uuid.UUID) (artifactEntry, error) {
	var entry artifactEntry
	err := service.database.QueryRow(ctx, `
		SELECT artifact.id, artifact.item_id, artifact.task_run_id, artifact.artifact_type,
		       artifact.version_number, artifact.schema_version, artifact.content,
		       artifact.generator, artifact.model_name, artifact.prompt_version,
		       artifact.created_at, artifact.invalidated_at, active.artifact_id IS NOT NULL
		FROM ai_artifacts artifact
		JOIN knowledge_items item ON item.id = artifact.item_id AND item.deleted_at IS NULL
		LEFT JOIN item_active_artifacts active ON active.artifact_id = artifact.id
		WHERE artifact.id = $1
	`, id).Scan(&entry.ID, &entry.ItemID, &entry.TaskRunID, &entry.ArtifactType,
		&entry.VersionNumber, &entry.SchemaVersion, &entry.Content, &entry.Generator,
		&entry.ModelName, &entry.PromptVersion, &entry.CreatedAt, &entry.InvalidatedAt, &entry.Active)
	if err != nil {
		return artifactEntry{}, err
	}
	entry.IsStale, err = service.isArtifactStale(ctx, entry.ItemID, entry.ArtifactType, entry.TaskRunID)
	return entry, err
}

func (service *Service) isArtifactStale(ctx context.Context, itemID uuid.UUID, artifactType string, taskID uuid.UUID) (bool, error) {
	var encoded []byte
	if err := service.database.QueryRow(ctx, `SELECT input_snapshot FROM ai_task_runs WHERE id = $1`, taskID).Scan(&encoded); err != nil {
		return false, err
	}
	var previous taskInputSnapshot
	if json.Unmarshal(encoded, &previous) != nil {
		return false, errors.New("invalid artifact input snapshot")
	}
	current := make([]uuid.UUID, 0)
	query := `SELECT id FROM raw_records WHERE item_id = $1 ORDER BY id`
	if artifactType == "image_analysis" {
		query = `
			SELECT attachment.id FROM attachments attachment
			JOIN raw_records record ON record.id = attachment.raw_record_id
			WHERE record.item_id = $1 AND attachment.status = 'ready' AND attachment.kind = 'image'
			ORDER BY attachment.id
		`
	}
	rows, err := service.database.Query(ctx, query, itemID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return false, err
		}
		current = append(current, id)
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	if artifactType == "image_analysis" {
		return !sameUUIDSet(previous.AttachmentIDs, current), nil
	}
	return !sameUUIDSet(previous.RawRecordIDs, current), nil
}

func (service *Service) canReadArtifactItem(request *http.Request, itemID uuid.UUID) (bool, error) {
	var sensitivity string
	if err := service.database.QueryRow(request.Context(), `SELECT sensitivity FROM knowledge_items WHERE id = $1 AND deleted_at IS NULL`, itemID).Scan(&sensitivity); err != nil {
		return false, err
	}
	actor, _ := auth.ActorFromContext(request.Context())
	return actor.Type != "pat" || sensitivity == "normal" || actor.HasScope("sensitive:read"), nil
}

func taskTypeForArtifact(artifactType string) string {
	switch artifactType {
	case "organized_record":
		return "organize_record"
	case "correctness_review":
		return "review_record"
	case "image_analysis":
		return "analyze_image"
	default:
		return ""
	}
}

func validSnapshotName(value string, limit int) bool {
	value = strings.TrimSpace(value)
	return value != "" && utf8.ValidString(value) && len([]rune(value)) <= limit
}

func writeArtifactSchemaError(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "ARTIFACT_SCHEMA_INVALID", "Artifact 未通过契约校验")
}

func writeArtifactNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "Artifact 或记录不存在")
}

func writeArtifactInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "Artifact 服务暂时不可用")
}

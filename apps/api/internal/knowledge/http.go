package knowledge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const maxMetadataBytes = 8 * 1024 * 1024

type rawRecordEntry struct {
	ID                  uuid.UUID          `json:"id"`
	RecordRole          string             `json:"recordRole"`
	SourceType          string             `json:"sourceType"`
	ContentKind         string             `json:"contentKind"`
	ContentFormat       string             `json:"contentFormat"`
	DeclaredSensitivity string             `json:"declaredSensitivity"`
	CapturedAt          time.Time          `json:"capturedAt"`
	EffectiveCapturedAt time.Time          `json:"effectiveCapturedAt"`
	SourceTimeQuality   string             `json:"sourceTimeQuality"`
	CreatedAt           time.Time          `json:"createdAt"`
	Attachments         []attachmentEntry  `json:"attachments"`
	Relations           []rawRelationEntry `json:"relations"`
	Fragments           []rawFragmentEntry `json:"fragments"`
}

type rawFragmentEntry struct {
	ID         uuid.UUID `json:"id"`
	SourceKind string    `json:"sourceKind"`
	Ordinal    int       `json:"ordinal"`
	StartByte  int       `json:"startByte"`
	EndByte    int       `json:"endByte"`
}

type rawRelationEntry struct {
	Direction          string    `json:"direction"`
	Type               string    `json:"type"`
	RelatedRawRecordID uuid.UUID `json:"relatedRawRecordId"`
	RelatedItemID      uuid.UUID `json:"relatedItemId"`
	Origin             string    `json:"origin"`
	Confirmed          bool      `json:"confirmed"`
	CreatedAt          time.Time `json:"createdAt"`
}

type attachmentMetadata struct {
	attachmentEntry
	ItemID      uuid.UUID `json:"itemId"`
	RawRecordID uuid.UUID `json:"rawRecordId"`
	StorageKey  string    `json:"-"`
	Sensitivity string    `json:"-"`
}

func (service *Service) createJSON(response http.ResponseWriter, request *http.Request) {
	actor, _ := auth.ActorFromContext(request.Context())
	idempotencyKey, ok := parseIdempotencyKey(response, request)
	if !ok {
		return
	}
	if service.writeExistingIdempotent(response, request, actor, idempotencyKey) {
		return
	}

	var input createInput
	if httpapi.DecodeJSON(response, request, maxMetadataBytes, &input) != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "录入内容无效")
		return
	}
	result, err := service.createItem(request.Context(), actor, input, nil, idempotencyKey)
	if err != nil {
		writeCreateError(response, request, err)
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusCreated, result)
}

func (service *Service) createMultipart(response http.ResponseWriter, request *http.Request) {
	actor, _ := auth.ActorFromContext(request.Context())
	idempotencyKey, ok := parseIdempotencyKey(response, request)
	if !ok {
		return
	}
	if !extendMultipartDeadlines(response, request) {
		return
	}
	if service.writeExistingIdempotent(response, request, actor, idempotencyKey) {
		return
	}

	reader, err := request.MultipartReader()
	if err != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "multipart 请求无效")
		return
	}
	var input createInput
	metadataSeen := false
	files := make([]preparedFile, 0, maxFileCount)
	cleanup := func() {
		for _, file := range files {
			_ = os.Remove(file.TempPath)
		}
	}
	defer cleanup()
	var totalBytes int64
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "multipart 请求无效")
			return
		}
		switch part.FormName() {
		case "metadata":
			if metadataSeen || part.FileName() != "" {
				_ = part.Close()
				httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "metadata 字段无效")
				return
			}
			metadataSeen = true
			encoded, readErr := io.ReadAll(io.LimitReader(part, maxMetadataBytes+1))
			_ = part.Close()
			if readErr != nil || len(encoded) > maxMetadataBytes || decodeStrictJSON(encoded, &input) != nil {
				httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "metadata 字段无效")
				return
			}
		case "files[]":
			if part.FileName() == "" || len(files) >= maxFileCount {
				_ = part.Close()
				httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "单次最多上传 10 个文件")
				return
			}
			file, prepareErr := prepareFile(part, service.tempRoot)
			_ = part.Close()
			if prepareErr != nil {
				writeCreateError(response, request, prepareErr)
				return
			}
			files = append(files, file)
			totalBytes += file.SizeBytes
			if !totalUploadAllowed(totalBytes) {
				writeCreateError(response, request, errUploadTooLarge)
				return
			}
		default:
			_ = part.Close()
			httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "multipart 字段无效")
			return
		}
	}
	if !metadataSeen || len(files) == 0 {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "metadata 和 files[] 均为必填")
		return
	}
	result, err := service.createItem(request.Context(), actor, input, files, idempotencyKey)
	if err != nil {
		writeCreateError(response, request, err)
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusCreated, result)
}

func (service *Service) writeExistingIdempotent(response http.ResponseWriter, request *http.Request, actor auth.Actor, key string) bool {
	if key == "" {
		return false
	}
	result, found, err := service.findIdempotentResult(request.Context(), actor, key)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return true
	}
	if !found {
		return false
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, result)
	return true
}

func parseIdempotencyKey(response http.ResponseWriter, request *http.Request) (string, bool) {
	key := request.Header.Get("Idempotency-Key")
	if key != "" && (len(key) < 8 || len(key) > 200 || strings.TrimSpace(key) != key) {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key 无效")
		return "", false
	}
	return key, true
}

func decodeStrictJSON(encoded []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errInvalidInput
	}
	return nil
}

func writeCreateError(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, errInvalidInput):
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "录入内容无效")
	case errors.Is(err, errFileTooLarge), errors.Is(err, errUploadTooLarge):
		httpapi.WriteError(response, request, http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "附件超过一期上传上限")
	default:
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "保存失败，请重试")
	}
}

func (service *Service) rawRecordSummaries(request *http.Request, itemID uuid.UUID) ([]rawRecordEntry, error) {
	rows, err := service.database.Query(request.Context(), `
		SELECT id, record_role, source_type, content_kind, content_format,
		       declared_sensitivity, captured_at, effective_captured_at, source_time_quality, created_at
		FROM raw_records WHERE item_id = $1
		ORDER BY effective_captured_at DESC, id DESC
	`, itemID)
	if err != nil {
		return nil, err
	}
	result := make([]rawRecordEntry, 0)
	for rows.Next() {
		var entry rawRecordEntry
		if err := rows.Scan(&entry.ID, &entry.RecordRole, &entry.SourceType, &entry.ContentKind, &entry.ContentFormat,
			&entry.DeclaredSensitivity, &entry.CapturedAt, &entry.EffectiveCapturedAt, &entry.SourceTimeQuality, &entry.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, entry)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Finish the parent query before issuing child queries. This also keeps the
	// detail endpoint usable when the pool is intentionally limited to one
	// connection, such as during maintenance or constrained deployments.
	for index := range result {
		entry := &result[index]
		entry.Attachments, err = service.attachmentsForRawRecord(request, entry.ID)
		if err != nil {
			return nil, err
		}
		entry.Relations, err = service.relationsForRawRecord(request, entry.ID)
		if err != nil {
			return nil, err
		}
		entry.Fragments, err = service.fragmentsForRawRecord(request, entry.ID)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (service *Service) fragmentsForRawRecord(request *http.Request, rawRecordID uuid.UUID) ([]rawFragmentEntry, error) {
	rows, err := service.database.Query(request.Context(), `
		SELECT id, source_kind, ordinal, start_byte, end_byte
		FROM search_fragments
		WHERE raw_record_id = $1 AND active
		ORDER BY ordinal, id
	`, rawRecordID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]rawFragmentEntry, 0)
	for rows.Next() {
		var entry rawFragmentEntry
		if err := rows.Scan(&entry.ID, &entry.SourceKind, &entry.Ordinal, &entry.StartByte, &entry.EndByte); err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	return result, rows.Err()
}

func (service *Service) attachmentsForRawRecord(request *http.Request, rawRecordID uuid.UUID) ([]attachmentEntry, error) {
	rows, err := service.database.Query(request.Context(), `
		SELECT id, kind, original_name, display_name, client_media_type, media_type,
		       size_bytes, width, height, created_at
		FROM attachments WHERE raw_record_id = $1 AND status = 'ready'
		ORDER BY created_at, id
	`, rawRecordID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]attachmentEntry, 0)
	for rows.Next() {
		var entry attachmentEntry
		if err := rows.Scan(&entry.ID, &entry.Kind, &entry.OriginalName, &entry.DisplayName,
			&entry.ClientMediaType, &entry.MediaType, &entry.SizeBytes, &entry.Width, &entry.Height, &entry.CreatedAt); err != nil {
			return nil, err
		}
		populateAttachmentLinks(&entry)
		result = append(result, entry)
	}
	return result, rows.Err()
}

func (service *Service) relationsForRawRecord(request *http.Request, rawRecordID uuid.UUID) ([]rawRelationEntry, error) {
	rows, err := service.database.Query(request.Context(), `
		SELECT 'outgoing', relation_type, to_record_id, target.item_id, origin, confirmed, relation.created_at
		FROM raw_record_relations relation
		JOIN raw_records target ON target.id = relation.to_record_id
		WHERE relation.from_record_id = $1
		UNION ALL
		SELECT 'incoming', relation_type, from_record_id, source.item_id, origin, confirmed, relation.created_at
		FROM raw_record_relations relation
		JOIN raw_records source ON source.id = relation.from_record_id
		WHERE relation.to_record_id = $1
		ORDER BY 7, 3
	`, rawRecordID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]rawRelationEntry, 0)
	for rows.Next() {
		var entry rawRelationEntry
		if err := rows.Scan(&entry.Direction, &entry.Type, &entry.RelatedRawRecordID,
			&entry.RelatedItemID, &entry.Origin, &entry.Confirmed, &entry.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	return result, rows.Err()
}

func (service *Service) getRawRecord(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	itemID, itemErr := uuid.Parse(request.PathValue("itemId"))
	rawRecordID, recordErr := uuid.Parse(request.PathValue("rawRecordId"))
	if itemErr != nil || recordErr != nil {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "原始记录不存在")
		return
	}
	if allowed, err := service.canReadItemContent(request, itemID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "原始记录不存在")
		} else {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "原始记录暂时不可用")
		}
		return
	} else if !allowed {
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 无权读取敏感原文")
		return
	}
	var record rawRecordEntry
	var body string
	var externalID, sourcePath *string
	var sourceCreatedAt, sourceUpdatedAt *time.Time
	var sourceMetadata json.RawMessage
	err := service.database.QueryRow(request.Context(), `
		SELECT r.id, r.record_role, r.source_type, r.content_kind, r.content_format, r.body,
		       r.declared_sensitivity, r.captured_at, r.effective_captured_at,
		       r.source_external_id, r.source_path, r.source_created_at, r.source_updated_at,
		       r.source_time_quality, r.source_metadata, r.created_at
		FROM raw_records r JOIN knowledge_items i ON i.id = r.item_id
		WHERE r.id = $1 AND r.item_id = $2 AND i.deleted_at IS NULL
	`, rawRecordID, itemID).Scan(
		&record.ID, &record.RecordRole, &record.SourceType, &record.ContentKind, &record.ContentFormat, &body,
		&record.DeclaredSensitivity, &record.CapturedAt, &record.EffectiveCapturedAt,
		&externalID, &sourcePath, &sourceCreatedAt, &sourceUpdatedAt,
		&record.SourceTimeQuality, &sourceMetadata, &record.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "原始记录不存在")
		return
	}
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "原始记录暂时不可用")
		return
	}
	record.Attachments, err = service.attachmentsForRawRecord(request, record.ID)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "原始记录暂时不可用")
		return
	}
	record.Relations, err = service.relationsForRawRecord(request, record.ID)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "原始记录暂时不可用")
		return
	}
	record.Fragments, err = service.fragmentsForRawRecord(request, record.ID)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "原始记录暂时不可用")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{
		"id": record.ID, "itemId": itemID, "readOnly": true, "recordRole": record.RecordRole,
		"contentKind": record.ContentKind, "contentFormat": record.ContentFormat, "body": body,
		"declaredSensitivity": record.DeclaredSensitivity, "capturedAt": record.CapturedAt,
		"effectiveCapturedAt": record.EffectiveCapturedAt, "sourceTimeQuality": record.SourceTimeQuality,
		"source": map[string]any{"sourceType": record.SourceType, "externalId": externalID, "path": sourcePath,
			"createdAt": sourceCreatedAt, "updatedAt": sourceUpdatedAt, "metadata": sourceMetadata},
		"attachments": record.Attachments, "relations": record.Relations,
		"fragments": record.Fragments, "createdAt": record.CreatedAt,
	})
}

func (service *Service) getAttachmentMetadata(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	metadata, err := service.loadAttachmentMetadata(request, request.PathValue("id"))
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, errInvalidInput) {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "附件不存在")
		return
	}
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "附件暂时不可用")
		return
	}
	if !requestActorCanReadSensitivity(request, metadata.Sensitivity) {
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 无权读取敏感附件")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, metadata)
}

func (service *Service) getAttachmentContent(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	metadata, err := service.loadAttachmentMetadata(request, request.PathValue("id"))
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, errInvalidInput) {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "附件不存在")
		return
	}
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "附件暂时不可用")
		return
	}
	if !requestActorCanReadSensitivity(request, metadata.Sensitivity) {
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 无权读取敏感附件")
		return
	}
	path, err := service.storagePath(metadata.StorageKey)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "附件暂时不可用")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "附件原件不可用")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != metadata.SizeBytes {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "附件原件不可用")
		return
	}
	response.Header().Set("Content-Type", metadata.MediaType)
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": metadata.DisplayName})
	if disposition == "" {
		disposition = "attachment"
	}
	response.Header().Set("Content-Disposition", disposition)
	http.ServeContent(response, request, metadata.DisplayName, metadata.CreatedAt, file)
}

func (service *Service) loadAttachmentMetadata(request *http.Request, rawID string) (attachmentMetadata, error) {
	attachmentID, err := uuid.Parse(rawID)
	if err != nil {
		return attachmentMetadata{}, errInvalidInput
	}
	var metadata attachmentMetadata
	err = service.database.QueryRow(request.Context(), `
		SELECT a.id, a.kind, a.original_name, a.display_name, a.client_media_type,
		       a.media_type, a.size_bytes, a.width, a.height, a.created_at,
		       r.item_id, a.raw_record_id, a.storage_key, i.sensitivity
		FROM attachments a
		JOIN raw_records r ON r.id = a.raw_record_id
		JOIN knowledge_items i ON i.id = r.item_id
		WHERE a.id = $1 AND a.status = 'ready' AND i.deleted_at IS NULL
	`, attachmentID).Scan(
		&metadata.ID, &metadata.Kind, &metadata.OriginalName, &metadata.DisplayName,
		&metadata.ClientMediaType, &metadata.MediaType, &metadata.SizeBytes,
		&metadata.Width, &metadata.Height, &metadata.CreatedAt, &metadata.ItemID,
		&metadata.RawRecordID, &metadata.StorageKey, &metadata.Sensitivity,
	)
	if err == nil {
		populateAttachmentLinks(&metadata.attachmentEntry)
	}
	return metadata, err
}

func (service *Service) canReadItemContent(request *http.Request, itemID uuid.UUID) (bool, error) {
	var sensitivity string
	if err := service.database.QueryRow(request.Context(), `
		SELECT sensitivity FROM knowledge_items WHERE id = $1 AND deleted_at IS NULL
	`, itemID).Scan(&sensitivity); err != nil {
		return false, err
	}
	return requestActorCanReadSensitivity(request, sensitivity), nil
}

func requestActorCanReadSensitivity(request *http.Request, sensitivity string) bool {
	actor, ok := auth.ActorFromContext(request.Context())
	return !ok || actor.Type != "pat" || sensitivity == "normal" || actor.HasScope("sensitive:read")
}

func (service *Service) storagePath(storageKey string) (string, error) {
	root, err := filepath.Abs(service.root)
	if err != nil {
		return "", err
	}
	candidate, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(storageKey)))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, candidate)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errInvalidInput
	}
	return candidate, nil
}

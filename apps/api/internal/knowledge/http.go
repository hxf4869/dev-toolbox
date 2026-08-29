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
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const maxMetadataBytes = 8 * 1024 * 1024

type itemListEntry struct {
	ID              uuid.UUID `json:"id"`
	Title           string    `json:"title"`
	Sensitivity     string    `json:"sensitivity"`
	Favorite        bool      `json:"favorite"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
	EffectiveAt     time.Time `json:"effectiveCapturedAt"`
	RawRecordCount  int64     `json:"rawRecordCount"`
	AttachmentCount int64     `json:"attachmentCount"`
}

type rawRecordEntry struct {
	ID                  uuid.UUID         `json:"id"`
	RecordRole          string            `json:"recordRole"`
	SourceType          string            `json:"sourceType"`
	ContentKind         string            `json:"contentKind"`
	ContentFormat       string            `json:"contentFormat"`
	DeclaredSensitivity string            `json:"declaredSensitivity"`
	CapturedAt          time.Time         `json:"capturedAt"`
	EffectiveCapturedAt time.Time         `json:"effectiveCapturedAt"`
	SourceTimeQuality   string            `json:"sourceTimeQuality"`
	CreatedAt           time.Time         `json:"createdAt"`
	Attachments         []attachmentEntry `json:"attachments"`
}

type attachmentMetadata struct {
	attachmentEntry
	ItemID          uuid.UUID `json:"itemId"`
	RawRecordID     uuid.UUID `json:"rawRecordId"`
	ClientMediaType *string   `json:"clientMediaType"`
	StorageKey      string    `json:"-"`
}

func (service *Service) createJSON(response http.ResponseWriter, request *http.Request) {
	session, _ := auth.SessionFromContext(request.Context())
	idempotencyKey, ok := parseIdempotencyKey(response, request)
	if !ok {
		return
	}
	if service.writeExistingIdempotent(response, request, session, idempotencyKey) {
		return
	}

	var input createInput
	if httpapi.DecodeJSON(response, request, maxMetadataBytes, &input) != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "录入内容无效")
		return
	}
	result, err := service.createItem(request.Context(), session, input, nil, idempotencyKey)
	if err != nil {
		writeCreateError(response, request, err)
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusCreated, result)
}

func (service *Service) createMultipart(response http.ResponseWriter, request *http.Request) {
	session, _ := auth.SessionFromContext(request.Context())
	idempotencyKey, ok := parseIdempotencyKey(response, request)
	if !ok {
		return
	}
	if service.writeExistingIdempotent(response, request, session, idempotencyKey) {
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
			if totalBytes > maxTotalBytes {
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
	result, err := service.createItem(request.Context(), session, input, files, idempotencyKey)
	if err != nil {
		writeCreateError(response, request, err)
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusCreated, result)
}

func (service *Service) writeExistingIdempotent(response http.ResponseWriter, request *http.Request, session auth.Session, key string) bool {
	if key == "" {
		return false
	}
	result, found, err := service.findIdempotentResult(request.Context(), session.ID, key)
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

func (service *Service) listItems(response http.ResponseWriter, request *http.Request) {
	view := request.URL.Query().Get("view")
	if view != "" && view != "inbox" && view != "recent" {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "当前视图尚不可用")
		return
	}
	if request.URL.Query().Get("cursor") != "" || request.URL.Query().Get("folderId") != "" || request.URL.Query().Get("tagId") != "" {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "筛选条件无效")
		return
	}
	limit := 30
	if rawLimit := request.URL.Query().Get("limit"); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed < 10 || parsed > 100 {
			httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "limit 需在 10 到 100 之间")
			return
		}
		limit = parsed
	}
	order := "i.updated_at DESC, i.id DESC"
	if view == "recent" {
		order = "MAX(r.effective_captured_at) DESC, i.id DESC"
	}
	rows, err := service.database.Query(request.Context(), `
		SELECT i.id, i.title, i.sensitivity, i.favorite, i.created_at, i.updated_at,
		       MAX(r.effective_captured_at), COUNT(DISTINCT r.id), COUNT(a.id)
		FROM knowledge_items i
		JOIN raw_records r ON r.item_id = i.id
		LEFT JOIN attachments a ON a.raw_record_id = r.id AND a.status = 'ready'
		WHERE i.deleted_at IS NULL
		GROUP BY i.id
		ORDER BY `+order+`
		LIMIT $1
	`, limit)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "列表暂时不可用")
		return
	}
	defer rows.Close()
	items := make([]itemListEntry, 0)
	for rows.Next() {
		var item itemListEntry
		if err := rows.Scan(&item.ID, &item.Title, &item.Sensitivity, &item.Favorite, &item.CreatedAt, &item.UpdatedAt, &item.EffectiveAt, &item.RawRecordCount, &item.AttachmentCount); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "列表暂时不可用")
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "列表暂时不可用")
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items, "nextCursor": nil})
}

func (service *Service) getItem(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "记录不存在")
		return
	}
	var title, sensitivity, titleOrigin string
	var note *string
	var favorite bool
	var createdAt, updatedAt time.Time
	err = service.database.QueryRow(request.Context(), `
		SELECT title, title_origin, note, sensitivity, favorite, created_at, updated_at
		FROM knowledge_items WHERE id = $1 AND deleted_at IS NULL
	`, itemID).Scan(&title, &titleOrigin, &note, &sensitivity, &favorite, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "记录不存在")
		return
	}
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "详情暂时不可用")
		return
	}
	rawRecords, err := service.rawRecordSummaries(request, itemID)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "详情暂时不可用")
		return
	}
	attachments := make([]attachmentEntry, 0)
	for _, rawRecord := range rawRecords {
		attachments = append(attachments, rawRecord.Attachments...)
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{
		"id": itemID, "title": title, "titleOrigin": titleOrigin, "note": note,
		"sensitivity": sensitivity, "favorite": favorite, "createdAt": createdAt, "updatedAt": updatedAt,
		"rawRecords": rawRecords, "attachments": attachments,
		"artifacts": []any{}, "availableVersions": []any{},
	})
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
	defer rows.Close()
	result := make([]rawRecordEntry, 0)
	for rows.Next() {
		var entry rawRecordEntry
		if err := rows.Scan(&entry.ID, &entry.RecordRole, &entry.SourceType, &entry.ContentKind, &entry.ContentFormat,
			&entry.DeclaredSensitivity, &entry.CapturedAt, &entry.EffectiveCapturedAt, &entry.SourceTimeQuality, &entry.CreatedAt); err != nil {
			return nil, err
		}
		entry.Attachments, err = service.attachmentsForRawRecord(request, entry.ID)
		if err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	return result, rows.Err()
}

func (service *Service) attachmentsForRawRecord(request *http.Request, rawRecordID uuid.UUID) ([]attachmentEntry, error) {
	rows, err := service.database.Query(request.Context(), `
		SELECT id, kind, display_name, media_type, size_bytes, width, height, created_at
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
		if err := rows.Scan(&entry.ID, &entry.Kind, &entry.DisplayName, &entry.MediaType, &entry.SizeBytes, &entry.Width, &entry.Height, &entry.CreatedAt); err != nil {
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
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{
		"id": record.ID, "itemId": itemID, "readOnly": true, "recordRole": record.RecordRole,
		"contentKind": record.ContentKind, "contentFormat": record.ContentFormat, "body": body,
		"declaredSensitivity": record.DeclaredSensitivity, "capturedAt": record.CapturedAt,
		"effectiveCapturedAt": record.EffectiveCapturedAt, "sourceTimeQuality": record.SourceTimeQuality,
		"source": map[string]any{"sourceType": record.SourceType, "externalId": externalID, "path": sourcePath,
			"createdAt": sourceCreatedAt, "updatedAt": sourceUpdatedAt, "metadata": sourceMetadata},
		"attachments": record.Attachments, "createdAt": record.CreatedAt,
	})
}

func (service *Service) patchItem(response http.ResponseWriter, request *http.Request) {
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "记录不存在")
		return
	}
	var input struct {
		Title *string `json:"title"`
	}
	if httpapi.DecodeJSON(response, request, 4096, &input) != nil || input.Title == nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "标题无效")
		return
	}
	title := strings.TrimSpace(*input.Title)
	if title == "" || runeCount(title) > 200 {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "标题需为 1–200 个字符")
		return
	}
	now := service.now().UTC()
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "保存失败，请重试")
		return
	}
	defer tx.Rollback(request.Context())
	tag, err := tx.Exec(request.Context(), `
		UPDATE knowledge_items SET title = $2, title_origin = 'user', updated_at = $3
		WHERE id = $1 AND deleted_at IS NULL
	`, itemID, title, now)
	if err != nil || tag.RowsAffected() != 1 {
		if err == nil {
			httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "记录不存在")
		} else {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "保存失败，请重试")
		}
		return
	}
	if _, err := tx.Exec(request.Context(), `
		UPDATE search_fragments SET content = $2, normalized_content = $3
		WHERE item_id = $1 AND source_kind = 'title' AND active = true
	`, itemID, title, normalizeSearch(title)); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "保存失败，请重试")
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "保存失败，请重试")
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"id": itemID, "title": title, "titleOrigin": "user", "updatedAt": now})
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
		SELECT a.id, a.kind, a.display_name, a.media_type, a.size_bytes, a.width, a.height,
		       a.created_at, r.item_id, a.raw_record_id, a.client_media_type, a.storage_key
		FROM attachments a
		JOIN raw_records r ON r.id = a.raw_record_id
		JOIN knowledge_items i ON i.id = r.item_id
		WHERE a.id = $1 AND a.status = 'ready' AND i.deleted_at IS NULL
	`, attachmentID).Scan(
		&metadata.ID, &metadata.Kind, &metadata.DisplayName, &metadata.MediaType, &metadata.SizeBytes,
		&metadata.Width, &metadata.Height, &metadata.CreatedAt, &metadata.ItemID, &metadata.RawRecordID,
		&metadata.ClientMediaType, &metadata.StorageKey,
	)
	return metadata, err
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

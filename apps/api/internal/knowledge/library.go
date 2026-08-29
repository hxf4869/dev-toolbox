package knowledge

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type libraryItem struct {
	ID                uuid.UUID         `json:"id"`
	Title             string            `json:"title"`
	Sensitivity       string            `json:"sensitivity"`
	Favorite          bool              `json:"favorite"`
	FolderID          *uuid.UUID        `json:"folderId"`
	Tags              []tagEntry        `json:"tags"`
	Summary           string            `json:"summary"`
	CreatedAt         time.Time         `json:"createdAt"`
	UpdatedAt         time.Time         `json:"updatedAt"`
	DeletedAt         *time.Time        `json:"deletedAt"`
	EffectiveAt       time.Time         `json:"effectiveCapturedAt"`
	SourceTimeQuality string            `json:"sourceTimeQuality"`
	RawRecordCount    int64             `json:"rawRecordCount"`
	AttachmentCount   int64             `json:"attachmentCount"`
	Attachments       []attachmentEntry `json:"attachments"`
	sortTime          time.Time
}

type libraryCursor struct {
	Sort   string    `json:"s"`
	Time   time.Time `json:"t"`
	ItemID uuid.UUID `json:"i"`
}

func (service *Service) listItems(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	query := request.URL.Query()
	view := query.Get("view")
	if !containsString([]string{"", "inbox", "recent", "favorites", "sensitive", "images", "files", "trash"}, view) {
		writeLibraryValidation(response, request)
		return
	}
	sortMode := query.Get("sort")
	if sortMode == "" {
		if view == "recent" {
			sortMode = "effective_desc"
		} else {
			sortMode = "updated_desc"
		}
	}
	if !containsString([]string{"effective_desc", "updated_desc"}, sortMode) || view == "recent" && sortMode != "effective_desc" {
		writeLibraryValidation(response, request)
		return
	}
	limit := 30
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 10 || parsed > 100 {
			writeLibraryValidation(response, request)
			return
		}
		limit = parsed
	}
	var folderID, tagID *uuid.UUID
	if raw := query.Get("folderId"); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			writeLibraryValidation(response, request)
			return
		}
		folderID = &parsed
	}
	if raw := query.Get("tagId"); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			writeLibraryValidation(response, request)
			return
		}
		tagID = &parsed
	}
	var cursor *libraryCursor
	if raw := query.Get("cursor"); raw != "" {
		decoded, err := decodeLibraryCursor(raw, sortMode)
		if err != nil {
			writeLibraryValidation(response, request)
			return
		}
		cursor = &decoded
	}

	arguments := &queryArguments{}
	filters := []string{}
	if view == "trash" {
		filters = append(filters, "i.deleted_at IS NOT NULL")
	} else {
		filters = append(filters, "i.deleted_at IS NULL")
	}
	switch view {
	case "inbox":
		filters = append(filters, "i.folder_id IS NULL")
	case "favorites":
		filters = append(filters, "i.favorite = true")
	case "sensitive":
		filters = append(filters, "i.sensitivity IN ('sensitive', 'unknown')")
	case "images":
		filters = append(filters, `EXISTS (
			SELECT 1 FROM raw_records vr JOIN attachments va ON va.raw_record_id = vr.id
			WHERE vr.item_id = i.id AND va.status = 'ready' AND va.kind = 'image'
		)`)
	case "files":
		filters = append(filters, `EXISTS (
			SELECT 1 FROM raw_records vr JOIN attachments va ON va.raw_record_id = vr.id
			WHERE vr.item_id = i.id AND va.status = 'ready' AND va.kind = 'file'
		)`)
	}
	if folderID != nil {
		filters = append(filters, "i.folder_id = "+arguments.add(*folderID))
	}
	if tagID != nil {
		filters = append(filters, "EXISTS (SELECT 1 FROM item_tags filter_tags WHERE filter_tags.item_id = i.id AND filter_tags.tag_id = "+arguments.add(*tagID)+")")
	}
	sortExpression := "i.updated_at"
	if sortMode == "effective_desc" {
		sortExpression = "latest.effective_captured_at"
	}
	if cursor != nil {
		filters = append(filters, "("+sortExpression+", i.id) < ("+arguments.add(cursor.Time)+", "+arguments.add(cursor.ItemID)+")")
	}
	limitParameter := arguments.add(limit + 1)
	rows, err := service.database.Query(request.Context(), `
		SELECT i.id, i.title, i.sensitivity, i.favorite, i.folder_id,
		       i.created_at, i.updated_at, i.deleted_at,
		       latest.effective_captured_at, latest.source_time_quality,
		       (SELECT COUNT(*) FROM raw_records count_records WHERE count_records.item_id = i.id),
		       (SELECT COUNT(*) FROM raw_records count_records
		          JOIN attachments count_attachments ON count_attachments.raw_record_id = count_records.id
		        WHERE count_records.item_id = i.id AND count_attachments.status = 'ready'),
		       preview.content,
		       `+sortExpression+` AS sort_time
		FROM knowledge_items i
		JOIN LATERAL (
			SELECT effective_captured_at, source_time_quality
			FROM raw_records WHERE item_id = i.id
			ORDER BY effective_captured_at DESC, id DESC LIMIT 1
		) latest ON true
		LEFT JOIN LATERAL (
			SELECT fragment.content
			FROM search_fragments fragment
			JOIN raw_records preview_record ON preview_record.id = fragment.raw_record_id
			WHERE fragment.item_id = i.id AND fragment.active
			  AND fragment.source_kind IN ('raw_text', 'code')
			ORDER BY preview_record.effective_captured_at DESC, preview_record.id DESC,
			         fragment.ordinal, fragment.id
			LIMIT 1
		) preview ON true
		WHERE `+strings.Join(filters, " AND ")+`
		ORDER BY `+sortExpression+` DESC, i.id DESC
		LIMIT `+limitParameter,
		arguments.values...,
	)
	if err != nil {
		writeLibraryInternal(response, request)
		return
	}
	items := make([]libraryItem, 0, limit+1)
	for rows.Next() {
		var item libraryItem
		var summary *string
		if err := rows.Scan(
			&item.ID, &item.Title, &item.Sensitivity, &item.Favorite, &item.FolderID,
			&item.CreatedAt, &item.UpdatedAt, &item.DeletedAt, &item.EffectiveAt,
			&item.SourceTimeQuality, &item.RawRecordCount, &item.AttachmentCount,
			&summary, &item.sortTime,
		); err != nil {
			writeLibraryInternal(response, request)
			return
		}
		if item.Sensitivity == "normal" {
			if summary != nil {
				item.Summary = *summary
			}
		} else {
			item.Summary = "敏感内容已遮挡；打开记录后可按需揭示。"
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		rows.Close()
		writeLibraryInternal(response, request)
		return
	}
	rows.Close()
	for index := range items {
		items[index].Tags, err = service.tagEntriesForItem(request, items[index].ID)
		if err != nil {
			writeLibraryInternal(response, request)
			return
		}
		if !requestActorCanReadSensitivity(request, items[index].Sensitivity) {
			items[index].Attachments = []attachmentEntry{}
			continue
		}
		items[index].Attachments, err = service.attachmentsForItem(request, items[index].ID)
		if err != nil {
			writeLibraryInternal(response, request)
			return
		}
	}
	var nextCursor *string
	if len(items) > limit {
		last := items[limit-1]
		encoded, err := encodeLibraryCursor(libraryCursor{Sort: sortMode, Time: last.sortTime, ItemID: last.ID})
		if err != nil {
			writeLibraryInternal(response, request)
			return
		}
		nextCursor = &encoded
		items = items[:limit]
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{
		"view": view, "sort": sortMode, "items": items, "nextCursor": nextCursor,
	})
}

func (service *Service) getItem(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		writeItemNotFound(response, request)
		return
	}
	var title, sensitivity, titleOrigin string
	var note *string
	var folderID *uuid.UUID
	var favorite bool
	var createdAt, updatedAt time.Time
	err = service.database.QueryRow(request.Context(), `
		SELECT title, title_origin, note, folder_id, sensitivity, favorite, created_at, updated_at
		FROM knowledge_items WHERE id = $1 AND deleted_at IS NULL
	`, itemID).Scan(&title, &titleOrigin, &note, &folderID, &sensitivity, &favorite, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeItemNotFound(response, request)
		return
	}
	if err != nil {
		writeLibraryInternal(response, request)
		return
	}
	if !requestActorCanReadSensitivity(request, sensitivity) {
		note = nil
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{
			"id": itemID, "title": title, "titleOrigin": titleOrigin, "note": note,
			"folder": nil, "tags": []any{}, "sensitivity": sensitivity, "favorite": favorite,
			"createdAt": createdAt, "updatedAt": updatedAt, "rawRecords": []any{},
			"attachments": []any{}, "artifacts": []any{}, "availableVersions": []any{},
			"contentMasked": true,
		})
		return
	}
	rawRecords, err := service.rawRecordSummaries(request, itemID)
	if err != nil {
		writeLibraryInternal(response, request)
		return
	}
	attachments := make([]attachmentEntry, 0)
	for _, rawRecord := range rawRecords {
		attachments = append(attachments, rawRecord.Attachments...)
	}
	tags, err := service.tagEntriesForItem(request, itemID)
	if err != nil {
		writeLibraryInternal(response, request)
		return
	}
	folder, err := service.folderSummaryForItem(request, itemID, folderID)
	if err != nil {
		writeLibraryInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{
		"id": itemID, "title": title, "titleOrigin": titleOrigin, "note": note,
		"folder": folder, "tags": tags, "sensitivity": sensitivity, "favorite": favorite,
		"createdAt": createdAt, "updatedAt": updatedAt, "rawRecords": rawRecords,
		"attachments": attachments, "artifacts": []any{}, "availableVersions": []any{},
	})
}

func (service *Service) tagEntriesForItem(request *http.Request, itemID uuid.UUID) ([]tagEntry, error) {
	rows, err := service.database.Query(request.Context(), `
		SELECT t.id, t.name, t.created_at, t.updated_at
		FROM tags t JOIN item_tags it ON it.tag_id = t.id
		WHERE it.item_id = $1 ORDER BY lower(t.name), t.id
	`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]tagEntry, 0)
	for rows.Next() {
		var entry tagEntry
		if err := rows.Scan(&entry.ID, &entry.Name, &entry.CreatedAt, &entry.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	return result, rows.Err()
}

func (service *Service) attachmentsForItem(request *http.Request, itemID uuid.UUID) ([]attachmentEntry, error) {
	rows, err := service.database.Query(request.Context(), `
		SELECT a.id, a.kind, a.original_name, a.display_name, a.client_media_type,
		       a.media_type, a.size_bytes, a.width, a.height, a.created_at
		FROM attachments a JOIN raw_records r ON r.id = a.raw_record_id
		WHERE r.item_id = $1 AND a.status = 'ready'
		ORDER BY a.created_at, a.id
	`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]attachmentEntry, 0)
	for rows.Next() {
		var entry attachmentEntry
		if err := rows.Scan(&entry.ID, &entry.Kind, &entry.OriginalName, &entry.DisplayName,
			&entry.ClientMediaType, &entry.MediaType, &entry.SizeBytes, &entry.Width,
			&entry.Height, &entry.CreatedAt); err != nil {
			return nil, err
		}
		populateAttachmentLinks(&entry)
		result = append(result, entry)
	}
	return result, rows.Err()
}

func (service *Service) folderSummaryForItem(request *http.Request, itemID uuid.UUID, folderID *uuid.UUID) (any, error) {
	if folderID == nil {
		return nil, nil
	}
	var name, path string
	err := service.database.QueryRow(request.Context(), `
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_id, name, 1 AS depth FROM folders WHERE id = $1
			UNION ALL
			SELECT parent.id, parent.parent_id, parent.name, ancestors.depth + 1
			FROM folders parent JOIN ancestors ON ancestors.parent_id = parent.id
		)
		SELECT (SELECT name FROM folders WHERE id = $1), string_agg(name, ' / ' ORDER BY depth DESC)
		FROM ancestors
	`, *folderID).Scan(&name, &path)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": *folderID, "name": name, "path": path, "itemId": itemID}, nil
}

func encodeLibraryCursor(cursor libraryCursor) (string, error) {
	encoded, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func decodeLibraryCursor(value, sortMode string) (libraryCursor, error) {
	encoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(encoded) > 1024 {
		return libraryCursor{}, errInvalidInput
	}
	var cursor libraryCursor
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cursor); err != nil {
		return libraryCursor{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return libraryCursor{}, errInvalidInput
	}
	if cursor.Sort != sortMode || cursor.Time.IsZero() || cursor.ItemID == uuid.Nil {
		return libraryCursor{}, errInvalidInput
	}
	return cursor, nil
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func writeLibraryValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "资料库筛选条件无效")
}

func writeLibraryInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "资料库暂时不可用")
}

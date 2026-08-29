package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type patchItemRequest struct {
	Title       json.RawMessage `json:"title"`
	Note        json.RawMessage `json:"note"`
	FolderID    json.RawMessage `json:"folderId"`
	TagIDs      json.RawMessage `json:"tagIds"`
	Favorite    json.RawMessage `json:"favorite"`
	Sensitivity json.RawMessage `json:"sensitivity"`
}

func (service *Service) patchItem(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		writeItemNotFound(response, request)
		return
	}
	var input patchItemRequest
	if httpapi.DecodeJSON(response, request, 32*1024, &input) != nil || !patchHasFields(input) {
		writeItemValidation(response, request)
		return
	}

	title, titleSet, err := optionalTrimmedString(input.Title, false, 200)
	if err != nil {
		writeItemValidation(response, request)
		return
	}
	note, noteSet, err := optionalTrimmedString(input.Note, true, 2000)
	if err != nil {
		writeItemValidation(response, request)
		return
	}
	folderID, folderSet, err := optionalUUID(input.FolderID)
	if err != nil {
		writeItemValidation(response, request)
		return
	}
	tagIDs, tagsSet, err := optionalUUIDList(input.TagIDs, 30)
	if err != nil {
		writeItemValidation(response, request)
		return
	}
	favorite, favoriteSet, err := optionalBool(input.Favorite)
	if err != nil {
		writeItemValidation(response, request)
		return
	}
	sensitivity, sensitivitySet, err := optionalSensitivity(input.Sensitivity)
	if err != nil {
		writeItemValidation(response, request)
		return
	}

	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeItemInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())

	var currentTitle, titleOrigin, currentSensitivity string
	var currentNote *string
	var currentFolderID *uuid.UUID
	var currentFavorite bool
	err = tx.QueryRow(request.Context(), `
		SELECT title, title_origin, note, folder_id, favorite, sensitivity
		FROM knowledge_items
		WHERE id = $1 AND deleted_at IS NULL
		FOR UPDATE
	`, itemID).Scan(&currentTitle, &titleOrigin, &currentNote, &currentFolderID, &currentFavorite, &currentSensitivity)
	if errors.Is(err, pgx.ErrNoRows) {
		writeItemNotFound(response, request)
		return
	}
	if err != nil {
		writeItemInternal(response, request)
		return
	}
	if folderSet && folderID != nil {
		var exists bool
		if err := tx.QueryRow(request.Context(), "SELECT true FROM folders WHERE id = $1", *folderID).Scan(&exists); err != nil {
			writeItemValidation(response, request)
			return
		}
	}
	if tagsSet && len(tagIDs) > 0 {
		var count int
		if err := tx.QueryRow(request.Context(), "SELECT COUNT(*) FROM tags WHERE id = ANY($1)", tagIDs).Scan(&count); err != nil || count != len(tagIDs) {
			writeItemValidation(response, request)
			return
		}
	}

	now := service.now().UTC()
	updatedTitle := currentTitle
	updatedOrigin := titleOrigin
	updatedNote := currentNote
	updatedFolderID := currentFolderID
	updatedFavorite := currentFavorite
	updatedSensitivity := currentSensitivity
	if titleSet {
		updatedTitle = *title
		updatedOrigin = "user"
	}
	if noteSet {
		updatedNote = note
	}
	if folderSet {
		updatedFolderID = folderID
	}
	if favoriteSet {
		updatedFavorite = *favorite
	}
	if sensitivitySet {
		updatedSensitivity = *sensitivity
		if currentSensitivity == "normal" && updatedSensitivity != "normal" && titleOrigin == "generated" && !titleSet {
			updatedTitle = generatedTitle("", updatedSensitivity, nil, service.timezone, now)
		}
	}

	_, err = tx.Exec(request.Context(), `
		UPDATE knowledge_items
		SET title = $2, title_origin = $3, note = $4, folder_id = $5,
		    favorite = $6, sensitivity = $7, updated_at = $8
		WHERE id = $1
	`, itemID, updatedTitle, updatedOrigin, updatedNote, updatedFolderID, updatedFavorite, updatedSensitivity, now)
	if err != nil {
		writeItemInternal(response, request)
		return
	}
	if tagsSet {
		if _, err := tx.Exec(request.Context(), "DELETE FROM item_tags WHERE item_id = $1", itemID); err != nil {
			writeItemInternal(response, request)
			return
		}
		for _, tagID := range tagIDs {
			if _, err := tx.Exec(request.Context(), `
				INSERT INTO item_tags (item_id, tag_id, created_at) VALUES ($1, $2, $3)
			`, itemID, tagID, now); err != nil {
				writeItemValidation(response, request)
				return
			}
		}
	}
	if updatedTitle != currentTitle {
		if err := replaceTitleSearchFragment(request.Context(), tx, itemID, updatedTitle, now); err != nil {
			writeItemInternal(response, request)
			return
		}
	}
	if noteSet || folderSet || tagsSet {
		if err := service.rebuildItemMetadata(request.Context(), tx, itemID, now, false); err != nil {
			writeItemInternal(response, request)
			return
		}
	}
	if sensitivitySet && updatedSensitivity != currentSensitivity {
		if service.auth == nil || service.auth.InsertRequestSecurityEvent(request.Context(), tx, request, "item_sensitivity_changed", map[string]any{
			"itemId": itemID, "from": currentSensitivity, "to": updatedSensitivity,
		}) != nil {
			writeItemInternal(response, request)
			return
		}
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeItemInternal(response, request)
		return
	}

	tags, err := service.tagsForItem(request, itemID)
	if err != nil {
		writeItemInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{
		"id": itemID, "title": updatedTitle, "titleOrigin": updatedOrigin,
		"note": updatedNote, "folderId": updatedFolderID, "tagIds": tags,
		"favorite": updatedFavorite, "sensitivity": updatedSensitivity, "updatedAt": now,
	})
}

func patchHasFields(input patchItemRequest) bool {
	return input.Title != nil || input.Note != nil || input.FolderID != nil || input.TagIDs != nil || input.Favorite != nil || input.Sensitivity != nil
}

func optionalTrimmedString(raw json.RawMessage, nullable bool, maximum int) (*string, bool, error) {
	if raw == nil {
		return nil, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		if nullable {
			return nil, true, nil
		}
		return nil, false, errInvalidInput
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return nil, false, errInvalidInput
	}
	value = strings.TrimSpace(value)
	if (!nullable && value == "") || runeCount(value) > maximum {
		return nil, false, errInvalidInput
	}
	return &value, true, nil
}

func optionalUUID(raw json.RawMessage) (*uuid.UUID, bool, error) {
	if raw == nil {
		return nil, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, true, nil
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return nil, false, errInvalidInput
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return nil, false, errInvalidInput
	}
	return &id, true, nil
}

func optionalUUIDList(raw json.RawMessage, maximum int) ([]uuid.UUID, bool, error) {
	if raw == nil {
		return nil, false, nil
	}
	var values []string
	if json.Unmarshal(raw, &values) != nil || values == nil || len(values) > maximum {
		return nil, false, errInvalidInput
	}
	result := make([]uuid.UUID, 0, len(values))
	seen := make(map[uuid.UUID]struct{}, len(values))
	for _, value := range values {
		id, err := uuid.Parse(value)
		if err != nil {
			return nil, false, errInvalidInput
		}
		if _, exists := seen[id]; exists {
			return nil, false, errInvalidInput
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result, true, nil
}

func optionalBool(raw json.RawMessage) (*bool, bool, error) {
	if raw == nil {
		return nil, false, nil
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return nil, false, errInvalidInput
	}
	return &value, true, nil
}

func optionalSensitivity(raw json.RawMessage) (*string, bool, error) {
	if raw == nil {
		return nil, false, nil
	}
	var value string
	if json.Unmarshal(raw, &value) != nil || !validSensitivity(value) {
		return nil, false, errInvalidInput
	}
	return &value, true, nil
}

func replaceTitleSearchFragment(ctx context.Context, tx pgx.Tx, itemID uuid.UUID, title string, now time.Time) error {
	if _, err := tx.Exec(ctx, "DELETE FROM search_fragments WHERE item_id = $1 AND source_kind = 'title'", itemID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO search_fragments (
			id, item_id, source_kind, ordinal, content, normalized_content, weight, active, created_at
		) VALUES ($1, $2, 'title', 0, $3, $4, 4, true, $5)
	`, uuid.NewSHA1(fragmentNS, []byte(itemID.String()+":title")), itemID, title, normalizeSearch(title), now)
	return err
}

func (service *Service) tagsForItem(request *http.Request, itemID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := service.database.Query(request.Context(), `
		SELECT tag_id FROM item_tags WHERE item_id = $1 ORDER BY tag_id
	`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func writeItemValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "记录元数据无效")
}

func writeItemNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "记录不存在")
}

func writeItemInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "保存失败，请重试")
}

package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

var (
	errFolderNotEmpty = errors.New("folder is not empty")
	errConflict       = errors.New("resource conflicts with existing data")
)

type folderEntry struct {
	ID        uuid.UUID      `json:"id"`
	ParentID  *uuid.UUID     `json:"parentId"`
	Name      string         `json:"name"`
	SortOrder int            `json:"sortOrder"`
	ItemCount int64          `json:"itemCount"`
	Children  []*folderEntry `json:"children"`
	CreatedAt time.Time      `json:"createdAt"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

type tagEntry struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	ItemCount int64     `json:"itemCount"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (service *Service) listFolderTree(response http.ResponseWriter, request *http.Request) {
	rows, err := service.database.Query(request.Context(), `
		SELECT f.id, f.parent_id, f.name, f.sort_order, f.created_at, f.updated_at,
		       COUNT(i.id) FILTER (WHERE i.deleted_at IS NULL)
		FROM folders f
		LEFT JOIN knowledge_items i ON i.folder_id = f.id
		GROUP BY f.id
		ORDER BY f.sort_order, lower(f.name), f.id
	`)
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	defer rows.Close()
	all := make([]*folderEntry, 0)
	byID := make(map[uuid.UUID]*folderEntry)
	for rows.Next() {
		entry := &folderEntry{Children: make([]*folderEntry, 0)}
		if err := rows.Scan(&entry.ID, &entry.ParentID, &entry.Name, &entry.SortOrder, &entry.CreatedAt, &entry.UpdatedAt, &entry.ItemCount); err != nil {
			writeOrganizationError(response, request, err)
			return
		}
		all = append(all, entry)
		byID[entry.ID] = entry
	}
	if err := rows.Err(); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	roots := make([]*folderEntry, 0)
	for _, entry := range all {
		if entry.ParentID == nil {
			roots = append(roots, entry)
			continue
		}
		parent := byID[*entry.ParentID]
		if parent != nil {
			parent.Children = append(parent.Children, entry)
		}
	}
	sortFolderEntries(roots)
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": roots})
}

func (service *Service) createFolder(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Name     string  `json:"name"`
		ParentID *string `json:"parentId"`
	}
	if httpapi.DecodeJSON(response, request, 4096, &input) != nil {
		writeOrganizationValidation(response, request)
		return
	}
	name, err := normalizedName(input.Name, 80)
	if err != nil {
		writeOrganizationValidation(response, request)
		return
	}
	parentID, err := parseNullableUUID(input.ParentID)
	if err != nil {
		writeOrganizationValidation(response, request)
		return
	}
	now := service.now().UTC()
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	defer tx.Rollback(request.Context())
	if parentID != nil {
		depth, err := folderDepth(request.Context(), tx, *parentID)
		if err != nil || depth >= 8 {
			writeOrganizationValidation(response, request)
			return
		}
	}
	var sortOrder int
	err = tx.QueryRow(request.Context(), `
		SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folders WHERE parent_id IS NOT DISTINCT FROM $1
	`, parentID).Scan(&sortOrder)
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	entry := folderEntry{ID: uuid.New(), ParentID: parentID, Name: name, SortOrder: sortOrder, Children: make([]*folderEntry, 0), CreatedAt: now, UpdatedAt: now}
	_, err = tx.Exec(request.Context(), `
		INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $5)
	`, entry.ID, entry.ParentID, entry.Name, entry.SortOrder, now)
	if err != nil {
		writeOrganizationError(response, request, mapUniqueViolation(err))
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusCreated, entry)
}

func (service *Service) renameFolder(response http.ResponseWriter, request *http.Request) {
	folderID, err := uuid.Parse(request.PathValue("id"))
	var input struct {
		Name string `json:"name"`
	}
	if err != nil || httpapi.DecodeJSON(response, request, 4096, &input) != nil {
		writeOrganizationValidation(response, request)
		return
	}
	name, err := normalizedName(input.Name, 80)
	if err != nil {
		writeOrganizationValidation(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	defer tx.Rollback(request.Context())
	now := service.now().UTC()
	tag, err := tx.Exec(request.Context(), "UPDATE folders SET name = $2, updated_at = $3 WHERE id = $1", folderID, name, now)
	if err != nil {
		writeOrganizationError(response, request, mapUniqueViolation(err))
		return
	}
	if tag.RowsAffected() != 1 {
		writeOrganizationNotFound(response, request)
		return
	}
	if err := service.rebuildMetadataForFolderSubtree(request.Context(), tx, folderID, now); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"id": folderID, "name": name, "updatedAt": now})
}

func (service *Service) moveFolder(response http.ResponseWriter, request *http.Request) {
	folderID, err := uuid.Parse(request.PathValue("id"))
	var input struct {
		ParentID json.RawMessage `json:"parentId"`
	}
	if err != nil || httpapi.DecodeJSON(response, request, 4096, &input) != nil || len(input.ParentID) == 0 {
		writeOrganizationValidation(response, request)
		return
	}
	parentID, err := uuidFromRawNullable(input.ParentID)
	if err != nil || (parentID != nil && *parentID == folderID) {
		writeOrganizationValidation(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	defer tx.Rollback(request.Context())
	var exists bool
	if err := tx.QueryRow(request.Context(), "SELECT true FROM folders WHERE id = $1 FOR UPDATE", folderID).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeOrganizationNotFound(response, request)
		} else {
			writeOrganizationError(response, request, err)
		}
		return
	}
	parentDepth := 0
	if parentID != nil {
		if descendant, err := folderIsDescendant(request.Context(), tx, folderID, *parentID); err != nil || descendant {
			writeOrganizationValidation(response, request)
			return
		}
		parentDepth, err = folderDepth(request.Context(), tx, *parentID)
		if err != nil {
			writeOrganizationValidation(response, request)
			return
		}
	}
	subtreeDepth, err := folderSubtreeDepth(request.Context(), tx, folderID)
	if err != nil || parentDepth+subtreeDepth > 8 {
		writeOrganizationValidation(response, request)
		return
	}
	var sortOrder int
	if err := tx.QueryRow(request.Context(), `SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folders WHERE parent_id IS NOT DISTINCT FROM $1 AND id <> $2`, parentID, folderID).Scan(&sortOrder); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	now := service.now().UTC()
	if _, err := tx.Exec(request.Context(), "UPDATE folders SET parent_id = $2, sort_order = $3, updated_at = $4 WHERE id = $1", folderID, parentID, sortOrder, now); err != nil {
		writeOrganizationError(response, request, mapUniqueViolation(err))
		return
	}
	if err := service.rebuildMetadataForFolderSubtree(request.Context(), tx, folderID, now); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"id": folderID, "parentId": parentID, "sortOrder": sortOrder, "updatedAt": now})
}

func (service *Service) deleteFolder(response http.ResponseWriter, request *http.Request) {
	folderID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeOrganizationNotFound(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	defer tx.Rollback(request.Context())
	var childCount, itemCount int64
	err = tx.QueryRow(request.Context(), `
		SELECT (SELECT COUNT(*) FROM folders WHERE parent_id = $1),
		       (SELECT COUNT(*) FROM knowledge_items WHERE folder_id = $1)
	`, folderID).Scan(&childCount, &itemCount)
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	if childCount > 0 || itemCount > 0 {
		writeOrganizationError(response, request, errFolderNotEmpty)
		return
	}
	tag, err := tx.Exec(request.Context(), "DELETE FROM folders WHERE id = $1", folderID)
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	if tag.RowsAffected() != 1 {
		writeOrganizationNotFound(response, request)
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) listTags(response http.ResponseWriter, request *http.Request) {
	rows, err := service.database.Query(request.Context(), `
		SELECT t.id, t.name, t.created_at, t.updated_at,
		       COUNT(i.id) FILTER (WHERE i.deleted_at IS NULL)
		FROM tags t
		LEFT JOIN item_tags it ON it.tag_id = t.id
		LEFT JOIN knowledge_items i ON i.id = it.item_id
		GROUP BY t.id ORDER BY lower(t.name), t.id
	`)
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	defer rows.Close()
	items := make([]tagEntry, 0)
	for rows.Next() {
		var entry tagEntry
		if err := rows.Scan(&entry.ID, &entry.Name, &entry.CreatedAt, &entry.UpdatedAt, &entry.ItemCount); err != nil {
			writeOrganizationError(response, request, err)
			return
		}
		items = append(items, entry)
	}
	if err := rows.Err(); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (service *Service) createTag(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Name string `json:"name"`
	}
	if httpapi.DecodeJSON(response, request, 4096, &input) != nil {
		writeOrganizationValidation(response, request)
		return
	}
	name, err := normalizedName(input.Name, 40)
	if err != nil {
		writeOrganizationValidation(response, request)
		return
	}
	now := service.now().UTC()
	entry := tagEntry{ID: uuid.New(), Name: name, CreatedAt: now, UpdatedAt: now}
	_, err = service.database.Exec(request.Context(), "INSERT INTO tags (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)", entry.ID, name, now)
	if err != nil {
		writeOrganizationError(response, request, mapUniqueViolation(err))
		return
	}
	httpapi.WriteJSON(response, http.StatusCreated, entry)
}

func (service *Service) renameTag(response http.ResponseWriter, request *http.Request) {
	tagID, err := uuid.Parse(request.PathValue("id"))
	var input struct {
		Name string `json:"name"`
	}
	if err != nil || httpapi.DecodeJSON(response, request, 4096, &input) != nil {
		writeOrganizationValidation(response, request)
		return
	}
	name, err := normalizedName(input.Name, 40)
	if err != nil {
		writeOrganizationValidation(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	defer tx.Rollback(request.Context())
	now := service.now().UTC()
	tag, err := tx.Exec(request.Context(), "UPDATE tags SET name = $2, updated_at = $3 WHERE id = $1", tagID, name, now)
	if err != nil {
		writeOrganizationError(response, request, mapUniqueViolation(err))
		return
	}
	if tag.RowsAffected() != 1 {
		writeOrganizationNotFound(response, request)
		return
	}
	if err := service.rebuildMetadataForTag(request.Context(), tx, tagID, now); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"id": tagID, "name": name, "updatedAt": now})
}

func (service *Service) deleteTag(response http.ResponseWriter, request *http.Request) {
	tagID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeOrganizationNotFound(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	defer tx.Rollback(request.Context())
	rows, err := tx.Query(request.Context(), "SELECT item_id FROM item_tags WHERE tag_id = $1", tagID)
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	itemIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var itemID uuid.UUID
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			writeOrganizationError(response, request, err)
			return
		}
		itemIDs = append(itemIDs, itemID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		writeOrganizationError(response, request, err)
		return
	}
	rows.Close()
	tag, err := tx.Exec(request.Context(), "DELETE FROM tags WHERE id = $1", tagID)
	if err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	if tag.RowsAffected() != 1 {
		writeOrganizationNotFound(response, request)
		return
	}
	now := service.now().UTC()
	for _, itemID := range itemIDs {
		if err := service.rebuildItemMetadata(request.Context(), tx, itemID, now, true); err != nil {
			writeOrganizationError(response, request, err)
			return
		}
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeOrganizationError(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func folderDepth(ctx context.Context, tx pgx.Tx, folderID uuid.UUID) (int, error) {
	var depth int
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_id, 1 AS depth FROM folders WHERE id = $1
			UNION ALL
			SELECT f.id, f.parent_id, ancestors.depth + 1
			FROM folders f JOIN ancestors ON ancestors.parent_id = f.id
		)
		SELECT COALESCE(MAX(depth), 0) FROM ancestors
	`, folderID).Scan(&depth)
	if err == nil && depth == 0 {
		return 0, pgx.ErrNoRows
	}
	return depth, err
}

func folderSubtreeDepth(ctx context.Context, tx pgx.Tx, folderID uuid.UUID) (int, error) {
	var depth int
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE descendants AS (
			SELECT id, 1 AS depth FROM folders WHERE id = $1
			UNION ALL
			SELECT f.id, descendants.depth + 1 FROM folders f JOIN descendants ON f.parent_id = descendants.id
		)
		SELECT COALESCE(MAX(depth), 0) FROM descendants
	`, folderID).Scan(&depth)
	if err == nil && depth == 0 {
		return 0, pgx.ErrNoRows
	}
	return depth, err
}

func folderIsDescendant(ctx context.Context, tx pgx.Tx, folderID, candidate uuid.UUID) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE descendants AS (
			SELECT id FROM folders WHERE id = $1
			UNION ALL
			SELECT f.id FROM folders f JOIN descendants ON f.parent_id = descendants.id
		)
		SELECT EXISTS (SELECT 1 FROM descendants WHERE id = $2)
	`, folderID, candidate).Scan(&exists)
	return exists, err
}

func (service *Service) rebuildMetadataForFolderSubtree(ctx context.Context, tx pgx.Tx, folderID uuid.UUID, now time.Time) error {
	rows, err := tx.Query(ctx, `
		WITH RECURSIVE descendants AS (
			SELECT id FROM folders WHERE id = $1
			UNION ALL
			SELECT f.id FROM folders f JOIN descendants ON f.parent_id = descendants.id
		)
		SELECT id FROM knowledge_items WHERE folder_id IN (SELECT id FROM descendants)
	`, folderID)
	if err != nil {
		return err
	}
	itemIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var itemID uuid.UUID
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return err
		}
		itemIDs = append(itemIDs, itemID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, itemID := range itemIDs {
		if err := service.rebuildItemMetadata(ctx, tx, itemID, now, true); err != nil {
			return err
		}
	}
	return nil
}

func (service *Service) rebuildMetadataForTag(ctx context.Context, tx pgx.Tx, tagID uuid.UUID, now time.Time) error {
	rows, err := tx.Query(ctx, "SELECT item_id FROM item_tags WHERE tag_id = $1", tagID)
	if err != nil {
		return err
	}
	itemIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var itemID uuid.UUID
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return err
		}
		itemIDs = append(itemIDs, itemID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, itemID := range itemIDs {
		if err := service.rebuildItemMetadata(ctx, tx, itemID, now, true); err != nil {
			return err
		}
	}
	return nil
}

func (service *Service) rebuildItemMetadata(ctx context.Context, tx pgx.Tx, itemID uuid.UUID, now time.Time, touch bool) error {
	if _, err := tx.Exec(ctx, "DELETE FROM search_fragments WHERE item_id = $1 AND source_kind = 'metadata'", itemID); err != nil {
		return err
	}
	var note, folderPath *string
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE item_folder AS (
			SELECT f.id, f.parent_id, f.name, 1 AS depth
			FROM knowledge_items i JOIN folders f ON f.id = i.folder_id WHERE i.id = $1
			UNION ALL
			SELECT parent.id, parent.parent_id, parent.name, item_folder.depth + 1
			FROM folders parent JOIN item_folder ON item_folder.parent_id = parent.id
		), path AS (
			SELECT string_agg(name, ' / ' ORDER BY depth DESC) AS value FROM item_folder
		)
		SELECT i.note, path.value FROM knowledge_items i CROSS JOIN path WHERE i.id = $1
	`, itemID).Scan(&note, &folderPath)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
		SELECT t.name FROM tags t JOIN item_tags it ON it.tag_id = t.id
		WHERE it.item_id = $1 ORDER BY lower(t.name), t.id
	`, itemID)
	if err != nil {
		return err
	}
	values := make([]string, 0)
	if note != nil && strings.TrimSpace(*note) != "" {
		values = append(values, *note)
	}
	if folderPath != nil && *folderPath != "" {
		values = append(values, *folderPath)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		values = append(values, name)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	content := strings.Join(values, "\n")
	if content != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO search_fragments (
				id, item_id, source_kind, ordinal, content, normalized_content, weight, active, created_at
			) VALUES ($1, $2, 'metadata', 0, $3, $4, 2, true, $5)
		`, uuid.NewSHA1(fragmentNS, []byte(itemID.String()+":metadata")), itemID, content, normalizeSearch(content), now); err != nil {
			return err
		}
	}
	if touch {
		_, err = tx.Exec(ctx, "UPDATE knowledge_items SET updated_at = $2 WHERE id = $1", itemID, now)
	}
	return err
}

func normalizedName(value string, maximum int) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || runeCount(value) > maximum {
		return "", errInvalidInput
	}
	return value, nil
}

func parseNullableUUID(value *string) (*uuid.UUID, error) {
	if value == nil {
		return nil, nil
	}
	id, err := uuid.Parse(*value)
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func uuidFromRawNullable(value json.RawMessage) (*uuid.UUID, error) {
	if string(value) == "null" {
		return nil, nil
	}
	var raw string
	if err := json.Unmarshal(value, &raw); err != nil {
		return nil, err
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func mapUniqueViolation(err error) error {
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && databaseError.Code == "23505" {
		return errConflict
	}
	return err
}

func writeOrganizationError(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, errFolderNotEmpty):
		httpapi.WriteError(response, request, http.StatusConflict, "FOLDER_NOT_EMPTY", "目录仍有子目录或记录")
	case errors.Is(err, errConflict):
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "同级名称已存在")
	default:
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "资料库暂时不可用")
	}
}

func writeOrganizationValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "目录或标签内容无效")
}

func writeOrganizationNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "目录或标签不存在")
}

func sortFolderEntries(entries []*folderEntry) {
	sort.SliceStable(entries, func(left, right int) bool {
		if entries[left].SortOrder != entries[right].SortOrder {
			return entries[left].SortOrder < entries[right].SortOrder
		}
		return strings.ToLower(entries[left].Name) < strings.ToLower(entries[right].Name)
	})
	for _, entry := range entries {
		sortFolderEntries(entry.Children)
	}
}

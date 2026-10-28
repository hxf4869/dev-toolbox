package knowledge

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

var errAttachmentMissing = errors.New("attachment original is missing")

type quarantinedFile struct {
	originalPath   string
	quarantinePath string
}

func (service *Service) trashItem(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		writeItemNotFound(response, request)
		return
	}
	now := service.now().UTC()
	tag, err := service.database.Exec(request.Context(), `
		UPDATE knowledge_items
		SET deleted_at = COALESCE(deleted_at, $2), updated_at = CASE WHEN deleted_at IS NULL THEN $2 ELSE updated_at END
		WHERE id = $1
	`, itemID, now)
	if err != nil {
		writeItemInternal(response, request)
		return
	}
	if tag.RowsAffected() != 1 {
		writeItemNotFound(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) restoreItem(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		writeItemNotFound(response, request)
		return
	}
	now := service.now().UTC()
	tag, err := service.database.Exec(request.Context(), `
		UPDATE knowledge_items
		SET deleted_at = NULL, updated_at = CASE WHEN deleted_at IS NOT NULL THEN $2 ELSE updated_at END
		WHERE id = $1
	`, itemID, now)
	if err != nil {
		writeItemInternal(response, request)
		return
	}
	if tag.RowsAffected() != 1 {
		writeItemNotFound(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) purgeItem(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	var input struct {
		ConfirmItemID string `json:"confirmItemId"`
	}
	if err != nil || httpapi.DecodeJSON(response, request, 4096, &input) != nil || input.ConfirmItemID != itemID.String() {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "永久删除确认标识无效")
		return
	}

	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeItemInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var deleted bool
	if err := tx.QueryRow(request.Context(), `
		SELECT deleted_at IS NOT NULL FROM knowledge_items WHERE id = $1 FOR UPDATE
	`, itemID).Scan(&deleted); errors.Is(err, pgx.ErrNoRows) {
		writeItemNotFound(response, request)
		return
	} else if err != nil {
		writeItemInternal(response, request)
		return
	}
	if !deleted {
		httpapi.WriteError(response, request, http.StatusConflict, "ITEM_NOT_IN_TRASH", "只有回收站中的记录可以永久删除")
		return
	}

	type storageEntry struct {
		key  string
		core bool
	}
	rows, err := tx.Query(request.Context(), `
		SELECT a.storage_key, true
		FROM attachments a JOIN raw_records r ON r.id = a.raw_record_id
		WHERE r.item_id = $1
		UNION ALL
		SELECT d.storage_key, false
		FROM attachment_derivatives d
		JOIN attachments a ON a.id = d.attachment_id
		JOIN raw_records r ON r.id = a.raw_record_id
		WHERE r.item_id = $1
	`, itemID)
	if err != nil {
		writeItemInternal(response, request)
		return
	}
	entries := make([]storageEntry, 0)
	for rows.Next() {
		var entry storageEntry
		if err := rows.Scan(&entry.key, &entry.core); err != nil {
			rows.Close()
			writeItemInternal(response, request)
			return
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		writeItemInternal(response, request)
		return
	}
	rows.Close()

	operationRoot := filepath.Join(service.quarantineRoot, uuid.NewString())
	moved := make([]quarantinedFile, 0, len(entries))
	restoreMoved := func() bool {
		if err := restoreQuarantinedFiles(moved, operationRoot); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "附件回滚未完成，未恢复的隔离副本已保留，请检查存储")
			return false
		}
		return true
	}
	for _, entry := range entries {
		originalPath, err := service.storagePath(entry.key)
		if err != nil {
			if restoreMoved() {
				writeItemInternal(response, request)
			}
			return
		}
		info, err := os.Stat(originalPath)
		if errors.Is(err, os.ErrNotExist) && !entry.core {
			continue
		}
		if errors.Is(err, os.ErrNotExist) || err == nil && !info.Mode().IsRegular() {
			if restoreMoved() {
				writePurgeStorageError(response, request, errAttachmentMissing)
			}
			return
		}
		if err != nil {
			if restoreMoved() {
				writePurgeStorageError(response, request, err)
			}
			return
		}
		quarantinePath := filepath.Join(operationRoot, filepath.FromSlash(entry.key))
		if err := os.MkdirAll(filepath.Dir(quarantinePath), 0o700); err != nil {
			if restoreMoved() {
				writePurgeStorageError(response, request, err)
			}
			return
		}
		if err := os.Rename(originalPath, quarantinePath); err != nil {
			if restoreMoved() {
				writePurgeStorageError(response, request, err)
			}
			return
		}
		moved = append(moved, quarantinedFile{originalPath: originalPath, quarantinePath: quarantinePath})
	}

	// V3 knowledge assistant: erase historical run source snapshots for this
	// item inside the same transaction, before the item itself is deleted.
	// Historical answers are never rewritten; the drawer shows "来源已删除"
	// (docs/16 §8.11).
	if _, err := tx.Exec(request.Context(), `
		UPDATE assistant_run_sources SET fragment_id = NULL, item_id = NULL, artifact_id = NULL,
		       title_snapshot = '来源已删除', excerpt_snapshot = '',
		       locator_snapshot = '{"status":"unavailable"}'::jsonb
		WHERE item_id = $1
	`, itemID); err != nil {
		if restoreMoved() {
			writeItemInternal(response, request)
		}
		return
	}
	if _, err := tx.Exec(request.Context(), "DELETE FROM knowledge_items WHERE id = $1", itemID); err != nil {
		if restoreMoved() {
			writeItemInternal(response, request)
		}
		return
	}
	if service.auth == nil || service.auth.InsertRequestSecurityEvent(request.Context(), tx, request, "item_permanently_deleted", map[string]any{"itemId": itemID}) != nil {
		if restoreMoved() {
			writeItemInternal(response, request)
		}
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		if restoreMoved() {
			writeItemInternal(response, request)
		}
		return
	}
	_ = os.RemoveAll(operationRoot)
	response.WriteHeader(http.StatusNoContent)
}

// Only remove quarantine after every original has been restored. A storage
// failure must leave the remaining originals available for recovery.
func restoreQuarantinedFiles(moved []quarantinedFile, operationRoot string) error {
	for index := len(moved) - 1; index >= 0; index-- {
		if err := os.MkdirAll(filepath.Dir(moved[index].originalPath), 0o700); err != nil {
			return err
		}
		if err := os.Rename(moved[index].quarantinePath, moved[index].originalPath); err != nil {
			return err
		}
	}
	_ = os.RemoveAll(operationRoot)
	return nil
}

func writePurgeStorageError(response http.ResponseWriter, request *http.Request, err error) {
	if errors.Is(err, errAttachmentMissing) {
		httpapi.WriteError(response, request, http.StatusConflict, "ATTACHMENT_INTEGRITY_FAILED", "附件原件不完整，未执行永久删除")
		return
	}
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "附件隔离失败，未执行永久删除")
}

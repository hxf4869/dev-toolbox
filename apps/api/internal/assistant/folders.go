package assistant

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

func (service *Service) listFolders(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	rows, err := service.database.Query(request.Context(), `
		SELECT f.id, f.name, count(c.id), f.created_at, f.updated_at
		FROM assistant_folders f
		LEFT JOIN assistant_conversations c ON c.folder_id = f.id
		GROUP BY f.id
		ORDER BY lower(f.name), f.id
	`)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer rows.Close()
	items := make([]AssistantFolderDTO, 0)
	for rows.Next() {
		var folder AssistantFolderDTO
		if err := rows.Scan(&folder.ID, &folder.Name, &folder.ConversationCount, &folder.CreatedAt, &folder.UpdatedAt); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		items = append(items, folder)
	}
	if err := rows.Err(); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (service *Service) createFolder(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	name, ok := decodeFolderName(response, request)
	if !ok {
		return
	}
	var id uuid.UUID
	var createdAt, updatedAt time.Time
	err := service.database.QueryRow(request.Context(), `
		INSERT INTO assistant_folders (id, name, created_at, updated_at)
		VALUES ($1, $2, $3, $3)
		ON CONFLICT DO NOTHING
		RETURNING id, created_at, updated_at
	`, uuid.New(), name, service.now().UTC()).Scan(&id, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeValidationError(response, request)
		return
	}
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusCreated, AssistantFolderDTO{
		ID: id, Name: name, ConversationCount: 0, CreatedAt: createdAt, UpdatedAt: updatedAt,
	})
}

func (service *Service) patchFolder(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	name, ok := decodeFolderName(response, request)
	if !ok {
		return
	}
	var folder AssistantFolderDTO
	err = service.database.QueryRow(request.Context(), `
		WITH updated AS (
			UPDATE assistant_folders SET name = $2, updated_at = $3 WHERE id = $1
			RETURNING id, name, created_at, updated_at
		)
		SELECT updated.id, updated.name, count(conversation.id), updated.created_at, updated.updated_at
		FROM updated
		LEFT JOIN assistant_conversations conversation ON conversation.folder_id = updated.id
		GROUP BY updated.id, updated.name, updated.created_at, updated.updated_at
	`, id, name, service.now().UTC()).Scan(
		&folder.ID, &folder.Name, &folder.ConversationCount, &folder.CreatedAt, &folder.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAssistantNotFound(response, request)
		return
	}
	if err != nil {
		// assistant_folders_name_unique(lower(btrim(name)))冲突与 createFolder 一致
		// 返回稳定 422,原名称与数据保持不变。
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			writeValidationError(response, request)
			return
		}
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, folder)
}

type deleteFolderInput struct {
	ConversationAction string `json:"conversationAction"`
}

func (service *Service) deleteFolder(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	var input deleteFolderInput
	if httpapi.DecodeJSON(response, request, 8*1024, &input) != nil ||
		input.ConversationAction != "unfile" && input.ConversationAction != "delete" {
		writeValidationError(response, request)
		return
	}
	ctx := request.Context()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer tx.Rollback(ctx)
	var lockedID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM assistant_folders WHERE id = $1 FOR UPDATE`, id).Scan(&lockedID); errors.Is(err, pgx.ErrNoRows) {
		writeAssistantNotFound(response, request)
		return
	} else if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if input.ConversationAction == "delete" {
		// 在 active-run 检查前按 id 稳定顺序锁住文件夹内会话行,与
		// prepareNewMessages/prepareRetryMessages 共用同一行锁:并发发送的
		// queued run 要么先于此事务提交(返回 ASSISTANT_RUN_ALREADY_ACTIVE),
		// 要么等删除提交后才能取得行锁,不会被级联删除吞掉(docs/16 §13.2)。
		if _, err := tx.Exec(ctx, `SELECT id FROM assistant_conversations WHERE folder_id = $1 ORDER BY id FOR UPDATE`, id); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		var active bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM assistant_runs run JOIN assistant_conversations c ON c.id = run.conversation_id
				WHERE c.folder_id = $1 AND run.status IN ('queued', 'running')
			)
		`, id).Scan(&active); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		if active {
			writeAssistantRunAlreadyActive(response, request)
			return
		}
		if _, err := tx.Exec(ctx, `DELETE FROM assistant_conversations WHERE folder_id = $1`, id); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	} else {
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_conversations SET folder_id = NULL, updated_at = $2 WHERE folder_id = $1
		`, id, service.now().UTC()); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM assistant_folders WHERE id = $1`, id); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func decodeFolderName(response http.ResponseWriter, request *http.Request) (string, bool) {
	var input struct {
		Name string `json:"name"`
	}
	if httpapi.DecodeJSON(response, request, 8*1024, &input) != nil {
		writeValidationError(response, request)
		return "", false
	}
	name := strings.TrimSpace(input.Name)
	runes := []rune(name)
	if name == "" || len(runes) > 80 {
		writeValidationError(response, request)
		return "", false
	}
	return name, true
}

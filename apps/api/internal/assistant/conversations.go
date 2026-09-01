package assistant

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type conversationRow struct {
	ID              uuid.UUID
	FolderID        *uuid.UUID
	Title           string
	TitleOrigin     string
	PinnedAt        *time.Time
	ArchivedAt      *time.Time
	SelectedModelID *uuid.UUID
	ReasoningEffort *string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const conversationColumns = `
	id, folder_id, title, title_origin, pinned_at, archived_at,
	selected_model_id, selected_reasoning_effort, created_at, updated_at
`

func scanConversationRow(row pgx.Row) (conversationRow, error) {
	var conversation conversationRow
	err := row.Scan(&conversation.ID, &conversation.FolderID, &conversation.Title, &conversation.TitleOrigin,
		&conversation.PinnedAt, &conversation.ArchivedAt, &conversation.SelectedModelID,
		&conversation.ReasoningEffort, &conversation.CreatedAt, &conversation.UpdatedAt)
	return conversation, err
}

// loadConversationDTO assembles the public conversation shape including
// modelAvailable and lastMessagePreview (docs/16 §13.8).
func (service *Service) loadConversationDTO(ctx context.Context, querier rowQuerier, conversation conversationRow) (AssistantConversationDTO, error) {
	dto := AssistantConversationDTO{
		ID: conversation.ID, Title: conversation.Title, TitleOrigin: conversation.TitleOrigin,
		FolderID: conversation.FolderID, Pinned: conversation.PinnedAt != nil, PinnedAt: conversation.PinnedAt,
		Archived: conversation.ArchivedAt != nil, ModelID: conversation.SelectedModelID,
		Reasoning: "off",
		CreatedAt: conversation.CreatedAt, UpdatedAt: conversation.UpdatedAt,
	}
	if conversation.ReasoningEffort != nil {
		dto.Reasoning = *conversation.ReasoningEffort
	}
	if conversation.SelectedModelID != nil {
		var providerEnabled bool
		var reasoningCount int
		err := querier.QueryRow(ctx, `
			SELECT provider.enabled AND model.enabled,
			       (SELECT count(*) FROM provider_model_reasoning_options o
			        WHERE o.model_id = model.id AND ($2 = 'off' OR o.reasoning_effort = $2))
			FROM provider_models model JOIN provider_configs provider ON provider.id = model.provider_config_id
			WHERE model.id = $1 AND model.deleted_at IS NULL AND provider.deleted_at IS NULL
		`, *conversation.SelectedModelID, dto.Reasoning).Scan(&providerEnabled, &reasoningCount)
		if err == nil {
			dto.ModelAvailable = providerEnabled && (dto.Reasoning == "off" || reasoningCount > 0)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return AssistantConversationDTO{}, err
		}
	}
	var preview *string
	if err := querier.QueryRow(ctx, `
		SELECT content FROM assistant_messages
		WHERE conversation_id = $1 ORDER BY sequence DESC LIMIT 1
	`, conversation.ID).Scan(&preview); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return AssistantConversationDTO{}, err
	}
	if preview != nil {
		trimmed := previewText(*preview)
		dto.LastMessagePreview = &trimmed
	}
	var latestRun *RunSummaryDTO
	var latestRunID *uuid.UUID
	if err := querier.QueryRow(ctx, `
		SELECT m.current_run_id FROM assistant_messages m
		WHERE m.conversation_id = $1 AND m.role = 'assistant' AND m.current_run_id IS NOT NULL
		ORDER BY m.sequence DESC LIMIT 1
	`, conversation.ID).Scan(&latestRunID); err == nil {
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return AssistantConversationDTO{}, err
	}
	if latestRunID != nil {
		run, err := service.loadRun(ctx, querier, *latestRunID)
		if err == nil {
			summary := runSummaryDTO(run)
			latestRun = &summary
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return AssistantConversationDTO{}, err
		}
	}
	dto.LatestRun = latestRun
	return dto, nil
}

// previewText strips markdown/reference tokens down to 160 code points.
func previewText(content string) string {
	plain := stripCitationTokens(content)
	runes := []rune(strings.TrimSpace(plain))
	if len(runes) > 160 {
		runes = runes[:160]
	}
	return string(runes)
}

// stripCitationTokens removes canonical [[C#]] tokens from assistant content
// for previews and history playback.
func stripCitationTokens(content string) string {
	var output strings.Builder
	for index := 0; index < len(content); {
		if strings.HasPrefix(content[index:], "[[C") {
			end := index + 3
			for end < len(content) && content[end] >= '0' && content[end] <= '9' {
				end++
			}
			if strings.HasPrefix(content[end:], "]]") {
				index = end + 2
				continue
			}
		}
		output.WriteByte(content[index])
		index++
	}
	return output.String()
}

func runSummaryDTO(run runRow) RunSummaryDTO {
	return RunSummaryDTO{
		ID: run.ID, Status: run.Status, Phase: run.Phase, StopRequested: run.StopRequestedAt != nil,
		CanStop: run.canStop(), Error: run.errorDTO(), CreatedAt: run.CreatedAt, FinishedAt: run.FinishedAt,
	}
}

func (service *Service) getConversation(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	conversation, err := scanConversationRow(service.database.QueryRow(request.Context(),
		`SELECT `+conversationColumns+` FROM assistant_conversations WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		writeAssistantNotFound(response, request)
		return
	}
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	dto, err := service.loadConversationDTO(request.Context(), service.database, conversation)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, dto)
}

type listConversationsCursor struct {
	PinnedAt  *time.Time `json:"p"`
	UpdatedAt time.Time  `json:"u"`
	ID        uuid.UUID  `json:"i"`
}

func (service *Service) listConversations(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	view := request.URL.Query().Get("view")
	if view == "" {
		view = "active"
	}
	if view != "active" && view != "archived" {
		writeValidationError(response, request)
		return
	}
	folderFilter := request.URL.Query().Get("folderId")
	folderID, err := parseFolderFilter(folderFilter)
	if err != nil {
		writeValidationError(response, request)
		return
	}
	limit := 30
	if raw := request.URL.Query().Get("limit"); raw != "" {
		limit, err = parseBoundedInt(raw, 1, 100)
		if err != nil {
			writeValidationError(response, request)
			return
		}
	}
	var cursor *listConversationsCursor
	if raw := request.URL.Query().Get("cursor"); raw != "" {
		cursor, err = decodeConversationCursor(raw, view, folderFilter)
		if err != nil {
			writeValidationError(response, request)
			return
		}
	}
	query := `SELECT ` + conversationColumns + ` FROM assistant_conversations WHERE 1=1`
	args := []any{}
	if view == "active" {
		query += ` AND archived_at IS NULL`
	} else {
		query += ` AND archived_at IS NOT NULL`
	}
	switch {
	case folderFilter == "unfiled":
		query += ` AND folder_id IS NULL`
	case folderID != nil:
		args = append(args, *folderID)
		query += ` AND folder_id = $` + itoa(len(args))
	}
	// Pinned first (pinnedAt DESC within), then updatedAt DESC, id DESC; the
	// cursor predicate mirrors that mixed ordering explicitly.
	if cursor != nil {
		args = append(args, cursor.PinnedAt, cursor.UpdatedAt, cursor.ID)
		base := len(args)
		query += ` AND (
			(pinned_at IS NOT NULL AND $` + itoa(base) + `::timestamptz IS NULL)
			OR (pinned_at IS NOT NULL AND $` + itoa(base) + `::timestamptz IS NOT NULL AND (
			    pinned_at < $` + itoa(base) + `
			    OR (pinned_at = $` + itoa(base) + ` AND (
			        updated_at < $` + itoa(base+1) + `
			        OR (updated_at = $` + itoa(base+1) + ` AND id < $` + itoa(base+2) + `)))))
			OR (pinned_at IS NULL AND $` + itoa(base) + `::timestamptz IS NULL AND (
			    updated_at < $` + itoa(base+1) + `
			    OR (updated_at = $` + itoa(base+1) + ` AND id < $` + itoa(base+2) + `)))
		)`
	}
	args = append(args, limit+1)
	query += ` ORDER BY pinned_at DESC NULLS LAST, updated_at DESC, id DESC LIMIT $` + itoa(len(args))
	rows, err := service.database.Query(request.Context(), query, args...)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer rows.Close()
	conversations := make([]AssistantConversationDTO, 0, limit)
	for rows.Next() {
		conversation, err := scanConversationRow(rows)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		dto, err := service.loadConversationDTO(request.Context(), service.database, conversation)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		conversations = append(conversations, dto)
	}
	if err := rows.Err(); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	rows.Close()
	var nextCursor *string
	if len(conversations) > limit {
		conversations = conversations[:limit]
		last := conversations[len(conversations)-1]
		encoded, err := encodeConversationCursor(listConversationsCursor{
			PinnedAt: last.PinnedAt, UpdatedAt: last.UpdatedAt, ID: last.ID,
		}, view, folderFilter)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		nextCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": conversations, "nextCursor": nextCursor})
}

func parseFolderFilter(raw string) (*uuid.UUID, error) {
	if raw == "" || raw == "unfiled" {
		return nil, nil
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func itoa(value int) string { return strconv.Itoa(value) }

type patchConversationInput struct {
	Title     *string    `json:"title"`
	FolderID  **uuid.UUID `json:"folderId"`
	Pinned    *bool      `json:"pinned"`
	Archived  *bool      `json:"archived"`
	ModelID   *uuid.UUID `json:"modelId"`
	Reasoning *string    `json:"reasoning"`
}

func (service *Service) patchConversation(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	var input patchConversationInput
	if httpapi.DecodeJSON(response, request, 32*1024, &input) != nil {
		writeValidationError(response, request)
		return
	}
	// folderId uses a double pointer: omitted (nil) vs explicit null vs value.
	modelOrReasoning := input.ModelID != nil || input.Reasoning != nil
	if input.ModelID != nil != (input.Reasoning != nil) {
		writeValidationError(response, request)
		return
	}
	if input.Title == nil && input.FolderID == nil && input.Pinned == nil && input.Archived == nil && !modelOrReasoning {
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
	conversation, err := scanConversationRow(tx.QueryRow(ctx,
		`SELECT `+conversationColumns+` FROM assistant_conversations WHERE id = $1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		writeAssistantNotFound(response, request)
		return
	}
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	now := service.now().UTC()
	if input.Title != nil {
		title := strings.TrimSpace(*input.Title)
		runes := []rune(title)
		if title == "" || len(runes) > 120 {
			writeValidationError(response, request)
			return
		}
		if _, err := tx.Exec(ctx,
			`UPDATE assistant_conversations SET title = $2, title_origin = 'user', updated_at = $3 WHERE id = $1`,
			id, title, now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if input.FolderID != nil {
		if *input.FolderID != nil {
			var exists bool
			if err := tx.QueryRow(ctx,
				`SELECT true FROM assistant_folders WHERE id = $1`, **input.FolderID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
				writeValidationError(response, request)
				return
			} else if err != nil {
				writeAssistantInternalFailure(response, request)
				return
			}
		}
		if _, err := tx.Exec(ctx,
			`UPDATE assistant_conversations SET folder_id = $2, updated_at = $3 WHERE id = $1`,
			id, *input.FolderID, now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if input.Pinned != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_conversations SET pinned_at = CASE WHEN $2 THEN COALESCE(pinned_at, $3) ELSE NULL END,
			       updated_at = $3 WHERE id = $1
		`, id, *input.Pinned, now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if input.Archived != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_conversations SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, $3) ELSE NULL END,
			       updated_at = $3 WHERE id = $1
		`, id, *input.Archived, now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if modelOrReasoning {
		modelID := *input.ModelID
		reasoning := *input.Reasoning
		if !validReasoningValue(reasoning) {
			writeValidationError(response, request)
			return
		}
		if reasoning != "off" {
			var valid bool
			if err := tx.QueryRow(ctx, `
				SELECT true FROM provider_model_reasoning_options WHERE model_id = $1 AND reasoning_effort = $2
			`, modelID, reasoning).Scan(&valid); errors.Is(err, pgx.ErrNoRows) {
				writeAssistantReasoningUnsupported(response, request)
				return
			} else if err != nil {
				writeAssistantInternalFailure(response, request)
				return
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_conversations SET selected_model_id = $2, selected_reasoning_effort = $3, updated_at = $4
			WHERE id = $1
		`, id, modelID, reasoningOrNull(reasoning), now); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	conversation, err = scanConversationRow(service.database.QueryRow(ctx,
		`SELECT `+conversationColumns+` FROM assistant_conversations WHERE id = $1`, id))
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	dto, err := service.loadConversationDTO(ctx, service.database, conversation)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, dto)
}

func (service *Service) deleteConversation(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAssistantNotFound(response, request)
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
		`SELECT id FROM assistant_conversations WHERE id = $1 FOR UPDATE`, id).Scan(&lockedID); errors.Is(err, pgx.ErrNoRows) {
		writeAssistantNotFound(response, request)
		return
	} else if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM assistant_runs WHERE conversation_id = $1 AND status IN ('queued', 'running'))
	`, id).Scan(&active); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if active {
		writeAssistantRunAlreadyActive(response, request)
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM assistant_conversations WHERE id = $1`, id); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) listMessages(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	conversationID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	limit := 30
	if raw := request.URL.Query().Get("limit"); raw != "" {
		if limit, err = parseBoundedInt(raw, 1, 100); err != nil {
			writeValidationError(response, request)
			return
		}
	}
	var before *messagesCursor
	if raw := request.URL.Query().Get("before"); raw != "" {
		if before, err = decodeMessagesCursor(raw); err != nil {
			writeValidationError(response, request)
			return
		}
	}
	query := `SELECT ` + messageColumns + ` FROM assistant_messages WHERE conversation_id = $1`
	args := []any{conversationID}
	if before != nil {
		args = append(args, before.Sequence, before.ID)
		query += ` AND (sequence, id) < ($2, $3)`
	}
	args = append(args, limit+1)
	query += ` ORDER BY sequence DESC, id DESC LIMIT $` + itoa(len(args))
	rows, err := service.database.Query(request.Context(), query, args...)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	type entry struct {
		row messageRow
	}
	entries := make([]entry, 0, limit+1)
	for rows.Next() {
		row, err := scanMessageRow(rows)
		if err != nil {
			rows.Close()
			writeAssistantInternalFailure(response, request)
			return
		}
		entries = append(entries, entry{row: row})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		writeAssistantInternalFailure(response, request)
		return
	}
	rows.Close()
	var nextCursor *string
	if len(entries) > limit {
		entries = entries[:limit]
		last := entries[len(entries)-1].row
		encoded, err := encodeMessagesCursor(messagesCursor{Sequence: last.Sequence, ID: last.ID})
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		nextCursor = &encoded
	}
	items := make([]AssistantMessageDTO, 0, len(entries))
	for index := len(entries) - 1; index >= 0; index-- {
		dto, err := service.messageDTO(request.Context(), service.database, entries[index].row)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		items = append(items, dto)
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items, "nextCursor": nextCursor})
}

type messagesCursor struct {
	Sequence int64     `json:"s"`
	ID       uuid.UUID `json:"i"`
}

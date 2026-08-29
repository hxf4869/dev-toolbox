package knowledge

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type supplementRelation struct {
	Type              string `json:"type"`
	TargetRawRecordID string `json:"targetRawRecordId"`
}

type supplementInput struct {
	Body          string              `json:"body"`
	ContentFormat string              `json:"contentFormat"`
	Sensitivity   string              `json:"sensitivity"`
	Relation      *supplementRelation `json:"relation"`
	Source        *sourceInput        `json:"source"`
}

func (service *Service) createSupplementJSON(response http.ResponseWriter, request *http.Request) {
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		writeItemNotFound(response, request)
		return
	}
	actor, _ := auth.ActorFromContext(request.Context())
	key, ok := parseIdempotencyKey(response, request)
	if !ok || service.writeExistingSupplement(response, request, actor, itemID, key) {
		return
	}
	var input supplementInput
	if httpapi.DecodeJSON(response, request, maxMetadataBytes, &input) != nil {
		writeSupplementValidation(response, request)
		return
	}
	result, err := service.createSupplement(request.Context(), actor, itemID, input, nil, key)
	if err != nil {
		writeSupplementError(response, request, err)
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusCreated, result)
}

func (service *Service) createSupplementMultipart(response http.ResponseWriter, request *http.Request) {
	itemID, err := uuid.Parse(request.PathValue("itemId"))
	if err != nil {
		writeItemNotFound(response, request)
		return
	}
	actor, _ := auth.ActorFromContext(request.Context())
	key, ok := parseIdempotencyKey(response, request)
	if !ok || service.writeExistingSupplement(response, request, actor, itemID, key) {
		return
	}
	input, files, err := service.readSupplementMultipart(request)
	if err != nil {
		writeSupplementError(response, request, err)
		return
	}
	defer removePreparedFiles(files)
	result, err := service.createSupplement(request.Context(), actor, itemID, input, files, key)
	if err != nil {
		writeSupplementError(response, request, err)
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusCreated, result)
}

func (service *Service) readSupplementMultipart(request *http.Request) (supplementInput, []preparedFile, error) {
	reader, err := request.MultipartReader()
	if err != nil {
		return supplementInput{}, nil, errInvalidInput
	}
	var input supplementInput
	metadataSeen := false
	files := make([]preparedFile, 0, maxFileCount)
	var totalBytes int64
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			removePreparedFiles(files)
			return supplementInput{}, nil, errInvalidInput
		}
		switch part.FormName() {
		case "metadata":
			if metadataSeen || part.FileName() != "" {
				_ = part.Close()
				removePreparedFiles(files)
				return supplementInput{}, nil, errInvalidInput
			}
			metadataSeen = true
			encoded, readErr := io.ReadAll(io.LimitReader(part, maxMetadataBytes+1))
			_ = part.Close()
			if readErr != nil || len(encoded) > maxMetadataBytes || decodeStrictJSON(encoded, &input) != nil {
				removePreparedFiles(files)
				return supplementInput{}, nil, errInvalidInput
			}
		case "files[]":
			if part.FileName() == "" || len(files) >= maxFileCount {
				_ = part.Close()
				removePreparedFiles(files)
				return supplementInput{}, nil, errInvalidInput
			}
			file, prepareErr := prepareFile(part, service.tempRoot)
			_ = part.Close()
			if prepareErr != nil {
				removePreparedFiles(files)
				return supplementInput{}, nil, prepareErr
			}
			files = append(files, file)
			totalBytes += file.SizeBytes
			if !totalUploadAllowed(totalBytes) {
				removePreparedFiles(files)
				return supplementInput{}, nil, errUploadTooLarge
			}
		default:
			_ = part.Close()
			removePreparedFiles(files)
			return supplementInput{}, nil, errInvalidInput
		}
	}
	if !metadataSeen || len(files) == 0 {
		removePreparedFiles(files)
		return supplementInput{}, nil, errInvalidInput
	}
	return input, files, nil
}

func removePreparedFiles(files []preparedFile) {
	for _, file := range files {
		_ = os.Remove(file.TempPath)
	}
}

func (service *Service) createSupplement(ctx context.Context, actor auth.Actor, itemID uuid.UUID, input supplementInput, files []preparedFile, key string) (createResult, error) {
	if err := validateSupplementInput(input, files); err != nil {
		return createResult{}, err
	}
	now := service.now().UTC()
	source, err := resolveSource(actor, input.Source, now)
	if err != nil {
		return createResult{}, errInvalidInput
	}
	if source.ExternalID != nil {
		if result, found, err := service.findSourceResult(ctx, source.Type, *source.ExternalID); err != nil || found {
			return result, err
		}
	}
	routeKey := supplementRouteKey(itemID)
	if key != "" {
		if result, found, err := service.findSupplementResult(ctx, actor, routeKey, key); err != nil || found {
			return result, err
		}
	}

	rawRecordID := uuid.New()
	storedFiles := make([]storedFile, 0, len(files))
	for _, file := range files {
		id := uuid.New()
		storageKey := filepath.ToSlash(filepath.Join("blobs", id.String()[0:2], id.String()))
		storedFiles = append(storedFiles, storedFile{
			preparedFile: file,
			ID:           id,
			StorageKey:   storageKey,
			FinalPath:    filepath.Join(service.root, filepath.FromSlash(storageKey)),
		})
	}
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return createResult{}, err
	}
	defer tx.Rollback(ctx)
	if key != "" {
		var existingItemID, existingRawRecordID uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT created_item_id, created_raw_record_id FROM idempotency_records
			WHERE actor_type = $1 AND actor_id = $2 AND route_key = $3
			  AND idempotency_key = $4 AND expires_at > $5
		`, actor.Type, actor.ID, routeKey, key, now).Scan(&existingItemID, &existingRawRecordID)
		if err == nil {
			_ = tx.Rollback(ctx)
			return service.loadCreateResult(ctx, existingItemID, existingRawRecordID)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return createResult{}, err
		}
	}

	var title, titleOrigin, currentSensitivity string
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		SELECT title, title_origin, sensitivity, created_at
		FROM knowledge_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE
	`, itemID).Scan(&title, &titleOrigin, &currentSensitivity, &createdAt)
	if err != nil {
		return createResult{}, err
	}
	updatedSensitivity := stricterSensitivity(currentSensitivity, input.Sensitivity)
	if updatedSensitivity != currentSensitivity && titleOrigin == "generated" {
		title = generatedTitle("", updatedSensitivity, nil, service.timezone, now)
	}
	if input.Relation != nil {
		targetID, _ := uuid.Parse(input.Relation.TargetRawRecordID)
		var targetItemID uuid.UUID
		if err := tx.QueryRow(ctx, "SELECT item_id FROM raw_records WHERE id = $1", targetID).Scan(&targetItemID); err != nil {
			return createResult{}, errInvalidInput
		}
		if input.Relation.Type != "migration_duplicate" && targetItemID != itemID {
			return createResult{}, errInvalidInput
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO raw_records (
			id, item_id, record_role, source_type, content_kind, content_format, body,
			declared_sensitivity, captured_at, effective_captured_at, source_external_id,
			source_path, source_created_at, source_updated_at, source_time_quality,
			source_metadata, created_at
		) VALUES ($1, $2, 'supplement', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $8)
	`, rawRecordID, itemID, source.Type, inferContentKind(input.Body, files), input.ContentFormat,
		input.Body, input.Sensitivity, now, source.EffectiveCapturedAt, source.ExternalID,
		source.Path, source.CreatedAt, source.UpdatedAt, source.TimeQuality, source.MetadataJSON); err != nil {
		var databaseError *pgconn.PgError
		if source.ExternalID != nil && errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "raw_records_source_external_id" {
			_ = tx.Rollback(ctx)
			if result, found, lookupErr := service.findSourceResult(ctx, source.Type, *source.ExternalID); lookupErr != nil || found {
				return result, lookupErr
			}
		}
		return createResult{}, err
	}
	for _, fragment := range splitTextFragments(rawRecordID, input.Body) {
		if _, err := tx.Exec(ctx, `
			INSERT INTO search_fragments (
				id, item_id, raw_record_id, source_kind, ordinal, fragment_version,
				start_byte, end_byte, content, normalized_content, weight, active, created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 3, true, $11)
		`, fragment.ID, itemID, rawRecordID, fragment.Kind, fragment.Ordinal, fragmentVersion,
			fragment.StartByte, fragment.EndByte, fragment.Content, fragment.Normalized, now); err != nil {
			return createResult{}, err
		}
	}
	attachments := make([]attachmentEntry, 0, len(storedFiles))
	for ordinal, file := range storedFiles {
		if _, err := tx.Exec(ctx, `
			INSERT INTO attachments (
				id, raw_record_id, kind, original_name, display_name, storage_key,
				client_media_type, media_type, content_sha256, size_bytes, width, height,
				status, created_at
			) VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), $8, $9, $10, $11, $12, 'ready', $13)
		`, file.ID, rawRecordID, file.Kind, file.OriginalName, file.DisplayName, file.StorageKey,
			file.ClientMedia, file.MediaType, file.ContentSHA256, file.SizeBytes, file.Width, file.Height, now); err != nil {
			return createResult{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO search_fragments (
				id, item_id, source_kind, ordinal, content, normalized_content, weight, active, created_at
			) VALUES ($1, $2, 'filename', $3, $4, $5, 2, true, $6)
		`, uuid.NewSHA1(fragmentNS, []byte(file.ID.String()+":filename")), itemID, ordinal,
			file.DisplayName, normalizeSearch(file.DisplayName), now); err != nil {
			return createResult{}, err
		}
		attachments = append(attachments, attachmentEntryFromStoredFile(file, now))
	}
	if input.Relation != nil {
		targetID, _ := uuid.Parse(input.Relation.TargetRawRecordID)
		if _, err := tx.Exec(ctx, `
			INSERT INTO raw_record_relations (
				from_record_id, to_record_id, relation_type, origin, confirmed, created_at
			) VALUES ($1, $2, $3, 'user', true, $4)
		`, rawRecordID, targetID, input.Relation.Type, now); err != nil {
			return createResult{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE knowledge_items SET title = $2, sensitivity = $3, updated_at = $4 WHERE id = $1
	`, itemID, title, updatedSensitivity, now); err != nil {
		return createResult{}, err
	}
	if updatedSensitivity != currentSensitivity && titleOrigin == "generated" {
		if err := replaceTitleSearchFragment(ctx, tx, itemID, title, now); err != nil {
			return createResult{}, err
		}
	}
	if key != "" {
		_, err := tx.Exec(ctx, `
			INSERT INTO idempotency_records (
				actor_type, actor_id, route_key, idempotency_key, created_item_id,
				created_raw_record_id, created_at, expires_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`, actor.Type, actor.ID, routeKey, key, itemID, rawRecordID, now, now.Add(24*time.Hour))
		if err != nil {
			var databaseError *pgconn.PgError
			if errors.As(err, &databaseError) && databaseError.Code == "23505" {
				_ = tx.Rollback(ctx)
				result, found, lookupErr := service.findSupplementResult(ctx, actor, routeKey, key)
				if lookupErr != nil {
					return createResult{}, lookupErr
				}
				if found {
					return result, nil
				}
			}
			return createResult{}, err
		}
	}

	moved := make([]string, 0, len(storedFiles))
	for _, file := range storedFiles {
		if err := os.MkdirAll(filepath.Dir(file.FinalPath), 0o700); err != nil {
			removeFiles(moved)
			return createResult{}, err
		}
		if err := os.Rename(file.TempPath, file.FinalPath); err != nil {
			removeFiles(moved)
			return createResult{}, err
		}
		if err := os.Chmod(file.FinalPath, 0o600); err != nil {
			removeFiles(append(moved, file.FinalPath))
			return createResult{}, err
		}
		moved = append(moved, file.FinalPath)
	}
	if err := tx.Commit(ctx); err != nil {
		removeFiles(moved)
		return createResult{}, err
	}
	return createResult{
		Item:      itemSummary{ID: itemID, Title: title, Sensitivity: updatedSensitivity, CreatedAt: createdAt},
		RawRecord: rawRecordSummary{ID: rawRecordID, ReadOnly: true}, Attachments: attachments,
	}, nil
}

func validateSupplementInput(input supplementInput, files []preparedFile) error {
	if !utf8.ValidString(input.Body) || len([]byte(input.Body)) > 1024*1024 ||
		!validContentFormat(input.ContentFormat) || !validSensitivity(input.Sensitivity) ||
		(strings.TrimSpace(input.Body) == "" && len(files) == 0) {
		return errInvalidInput
	}
	if input.Relation != nil {
		if input.Relation.Type != "supplements" && input.Relation.Type != "supersedes" && input.Relation.Type != "migration_duplicate" {
			return errInvalidInput
		}
		if _, err := uuid.Parse(input.Relation.TargetRawRecordID); err != nil {
			return errInvalidInput
		}
	}
	return nil
}

func stricterSensitivity(left, right string) string {
	rank := map[string]int{"normal": 0, "unknown": 1, "sensitive": 2}
	if rank[right] > rank[left] {
		return right
	}
	return left
}

func supplementRouteKey(itemID uuid.UUID) string {
	return "supplement_item:" + itemID.String()
}

func (service *Service) findSupplementResult(ctx context.Context, actor auth.Actor, routeKey, key string) (createResult, bool, error) {
	var itemID, rawRecordID uuid.UUID
	err := service.database.QueryRow(ctx, `
		SELECT created_item_id, created_raw_record_id FROM idempotency_records
		WHERE actor_type = $1 AND actor_id = $2 AND route_key = $3
		  AND idempotency_key = $4 AND expires_at > $5
	`, actor.Type, actor.ID, routeKey, key, service.now().UTC()).Scan(&itemID, &rawRecordID)
	if errors.Is(err, pgx.ErrNoRows) {
		return createResult{}, false, nil
	}
	if err != nil {
		return createResult{}, false, err
	}
	result, err := service.loadCreateResult(ctx, itemID, rawRecordID)
	return result, err == nil, err
}

func (service *Service) writeExistingSupplement(response http.ResponseWriter, request *http.Request, actor auth.Actor, itemID uuid.UUID, key string) bool {
	if key == "" {
		return false
	}
	result, found, err := service.findSupplementResult(request.Context(), actor, supplementRouteKey(itemID), key)
	if err != nil {
		writeItemInternal(response, request)
		return true
	}
	if !found {
		return false
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, result)
	return true
}

func writeSupplementValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "补充记录内容无效")
}

func writeSupplementError(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeItemNotFound(response, request)
	case errors.Is(err, errInvalidInput):
		writeSupplementValidation(response, request)
	case errors.Is(err, errFileTooLarge), errors.Is(err, errUploadTooLarge):
		httpapi.WriteError(response, request, http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "附件超过一期上传上限")
	default:
		writeItemInternal(response, request)
	}
}

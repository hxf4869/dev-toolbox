package knowledge

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
)

type Service struct {
	database *pgxpool.Pool
	root     string
	tempRoot string
	blobRoot string
	timezone *time.Location
	now      func() time.Time
}

type createInput struct {
	Body          string   `json:"body"`
	ContentFormat string   `json:"contentFormat"`
	Sensitivity   string   `json:"sensitivity"`
	Title         *string  `json:"title"`
	FolderID      *string  `json:"folderId"`
	TagIDs        []string `json:"tagIds"`
}

type createResult struct {
	Item        itemSummary       `json:"item"`
	RawRecord   rawRecordSummary  `json:"rawRecord"`
	Attachments []attachmentEntry `json:"attachments,omitempty"`
}

type itemSummary struct {
	ID          uuid.UUID `json:"id"`
	Title       string    `json:"title"`
	Sensitivity string    `json:"sensitivity"`
	CreatedAt   time.Time `json:"createdAt"`
}

type rawRecordSummary struct {
	ID       uuid.UUID `json:"id"`
	ReadOnly bool      `json:"readOnly"`
}

type attachmentEntry struct {
	ID          uuid.UUID `json:"id"`
	Kind        string    `json:"kind"`
	DisplayName string    `json:"displayName"`
	MediaType   string    `json:"mediaType"`
	SizeBytes   int64     `json:"sizeBytes"`
	Width       *int      `json:"width"`
	Height      *int      `json:"height"`
	CreatedAt   time.Time `json:"createdAt"`
}

type storedFile struct {
	preparedFile
	ID         uuid.UUID
	StorageKey string
	FinalPath  string
}

func NewService(database *pgxpool.Pool, root string, timezone *time.Location) (*Service, error) {
	root = filepath.Clean(root)
	tempRoot := filepath.Join(root, "tmp")
	blobRoot := filepath.Join(root, "blobs")
	for _, path := range []string{root, tempRoot, blobRoot} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return nil, fmt.Errorf("create attachment directory: %w", err)
		}
	}
	return &Service{
		database: database,
		root:     root,
		tempRoot: tempRoot,
		blobRoot: blobRoot,
		timezone: timezone,
		now:      time.Now,
	}, nil
}

func (service *Service) RegisterRoutes(router *http.ServeMux, authService *auth.Service) {
	router.Handle("GET /api/v1/items", authService.Authenticate(http.HandlerFunc(service.listItems)))
	router.Handle("POST /api/v1/items", authService.AuthenticateMutation(http.HandlerFunc(service.createJSON)))
	router.Handle("POST /api/v1/items:multipart", authService.AuthenticateMutation(http.HandlerFunc(service.createMultipart)))
	router.Handle("GET /api/v1/items/{itemId}", authService.Authenticate(http.HandlerFunc(service.getItem)))
	router.Handle("PATCH /api/v1/items/{itemId}", authService.AuthenticateMutation(http.HandlerFunc(service.patchItem)))
	router.Handle("GET /api/v1/items/{itemId}/raw-records/{rawRecordId}", authService.Authenticate(http.HandlerFunc(service.getRawRecord)))
	router.Handle("GET /api/v1/attachments/{id}/metadata", authService.Authenticate(http.HandlerFunc(service.getAttachmentMetadata)))
	router.Handle("GET /api/v1/attachments/{id}/content", authService.Authenticate(http.HandlerFunc(service.getAttachmentContent)))
}

func (service *Service) createItem(ctx context.Context, session auth.Session, input createInput, files []preparedFile, idempotencyKey string) (createResult, error) {
	if err := validateCreateInput(input, files); err != nil {
		return createResult{}, err
	}
	if idempotencyKey != "" {
		if result, found, err := service.findIdempotentResult(ctx, session.ID, idempotencyKey); err != nil || found {
			return result, err
		}
	}

	now := service.now().UTC()
	itemID := uuid.New()
	rawRecordID := uuid.New()
	titleOrigin := "generated"
	title := generatedTitle(input.Body, input.Sensitivity, files, service.timezone, now)
	if input.Title != nil {
		title = strings.TrimSpace(*input.Title)
		titleOrigin = "user"
	}
	contentKind := inferContentKind(input.Body, files)
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
	if idempotencyKey != "" {
		var existingItemID, existingRawRecordID uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT created_item_id, created_raw_record_id
			FROM idempotency_records
			WHERE actor_type = 'session' AND actor_id = $1 AND route_key = 'create_item'
			  AND idempotency_key = $2 AND expires_at > $3
		`, session.ID, idempotencyKey, now).Scan(&existingItemID, &existingRawRecordID)
		if err == nil {
			if err := tx.Rollback(ctx); err != nil {
				return createResult{}, err
			}
			return service.loadCreateResult(ctx, existingItemID, existingRawRecordID)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return createResult{}, err
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO knowledge_items (
			id, title, title_origin, sensitivity, favorite, created_at, updated_at
		) VALUES ($1, $2, $3, $4, false, $5, $5)
	`, itemID, title, titleOrigin, input.Sensitivity, now); err != nil {
		return createResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO raw_records (
			id, item_id, record_role, source_type, content_kind, content_format, body,
			declared_sensitivity, captured_at, effective_captured_at, source_time_quality,
			source_metadata, created_at
		) VALUES ($1, $2, 'primary', 'web_capture', $3, $4, $5, $6, $7, $7, 'unknown', '{}'::jsonb, $7)
	`, rawRecordID, itemID, contentKind, input.ContentFormat, input.Body, input.Sensitivity, now); err != nil {
		return createResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO search_fragments (
			id, item_id, source_kind, ordinal, content, normalized_content, weight, active, created_at
		) VALUES ($1, $2, 'title', 0, $3, $4, 4, true, $5)
	`, uuid.New(), itemID, title, normalizeSearch(title), now); err != nil {
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
		`, uuid.New(), itemID, ordinal, file.DisplayName, normalizeSearch(file.DisplayName), now); err != nil {
			return createResult{}, err
		}
		attachments = append(attachments, attachmentEntry{
			ID: file.ID, Kind: file.Kind, DisplayName: file.DisplayName, MediaType: file.MediaType,
			SizeBytes: file.SizeBytes, Width: file.Width, Height: file.Height, CreatedAt: now,
		})
	}
	if idempotencyKey != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO idempotency_records (
				actor_type, actor_id, route_key, idempotency_key, created_item_id,
				created_raw_record_id, created_at, expires_at
			) VALUES ('session', $1, 'create_item', $2, $3, $4, $5, $6)
		`, session.ID, idempotencyKey, itemID, rawRecordID, now, now.Add(24*time.Hour)); err != nil {
			var databaseError *pgconn.PgError
			if errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "idempotency_records_pkey" {
				if rollbackErr := tx.Rollback(ctx); rollbackErr != nil {
					return createResult{}, rollbackErr
				}
				result, found, lookupErr := service.findIdempotentResult(ctx, session.ID, idempotencyKey)
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
		Item:        itemSummary{ID: itemID, Title: title, Sensitivity: input.Sensitivity, CreatedAt: now},
		RawRecord:   rawRecordSummary{ID: rawRecordID, ReadOnly: true},
		Attachments: attachments,
	}, nil
}

func validateCreateInput(input createInput, files []preparedFile) error {
	if !utf8.ValidString(input.Body) || len([]byte(input.Body)) > 1024*1024 {
		return errInvalidInput
	}
	if !validContentFormat(input.ContentFormat) || !validSensitivity(input.Sensitivity) {
		return errInvalidInput
	}
	if strings.TrimSpace(input.Body) == "" && len(files) == 0 {
		return errInvalidInput
	}
	if input.Title != nil {
		title := strings.TrimSpace(*input.Title)
		if title == "" || runeCount(title) > 200 {
			return errInvalidInput
		}
	}
	if input.FolderID != nil || len(input.TagIDs) > 0 {
		return errInvalidInput
	}
	return nil
}

func inferContentKind(body string, files []preparedFile) string {
	hasBody := strings.TrimSpace(body) != ""
	if len(files) == 0 {
		return "text"
	}
	if hasBody || (!allImages(files) && hasImage(files)) {
		return "mixed"
	}
	if allImages(files) {
		return "image"
	}
	return "file"
}

func hasImage(files []preparedFile) bool {
	for _, file := range files {
		if file.Kind == "image" {
			return true
		}
	}
	return false
}

func removeFiles(paths []string) {
	for _, path := range paths {
		_ = os.Remove(path)
	}
}

func (service *Service) findIdempotentResult(ctx context.Context, sessionID uuid.UUID, key string) (createResult, bool, error) {
	var itemID, rawRecordID uuid.UUID
	err := service.database.QueryRow(ctx, `
		SELECT created_item_id, created_raw_record_id
		FROM idempotency_records
		WHERE actor_type = 'session' AND actor_id = $1 AND route_key = 'create_item'
		  AND idempotency_key = $2 AND expires_at > $3
	`, sessionID, key, service.now().UTC()).Scan(&itemID, &rawRecordID)
	if errors.Is(err, pgx.ErrNoRows) {
		return createResult{}, false, nil
	}
	if err != nil {
		return createResult{}, false, err
	}
	result, err := service.loadCreateResult(ctx, itemID, rawRecordID)
	return result, err == nil, err
}

func (service *Service) loadCreateResult(ctx context.Context, itemID, rawRecordID uuid.UUID) (createResult, error) {
	var result createResult
	err := service.database.QueryRow(ctx, `
		SELECT id, title, sensitivity, created_at
		FROM knowledge_items WHERE id = $1
	`, itemID).Scan(&result.Item.ID, &result.Item.Title, &result.Item.Sensitivity, &result.Item.CreatedAt)
	if err != nil {
		return createResult{}, err
	}
	result.RawRecord = rawRecordSummary{ID: rawRecordID, ReadOnly: true}
	rows, err := service.database.Query(ctx, `
		SELECT id, kind, display_name, media_type, size_bytes, width, height, created_at
		FROM attachments WHERE raw_record_id = $1 AND status = 'ready'
		ORDER BY created_at, id
	`, rawRecordID)
	if err != nil {
		return createResult{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var entry attachmentEntry
		if err := rows.Scan(&entry.ID, &entry.Kind, &entry.DisplayName, &entry.MediaType, &entry.SizeBytes, &entry.Width, &entry.Height, &entry.CreatedAt); err != nil {
			return createResult{}, err
		}
		result.Attachments = append(result.Attachments, entry)
	}
	return result, rows.Err()
}

var (
	errInvalidInput   = errors.New("invalid input")
	errUploadTooLarge = errors.New("upload too large")
)

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
	database       *pgxpool.Pool
	root           string
	tempRoot       string
	blobRoot       string
	derivativeRoot string
	quarantineRoot string
	timezone       *time.Location
	auth           *auth.Service
	now            func() time.Time
	// decode bounds the concurrent heavy image decodes of this process.
	decode *decodeLimiter
	// flights coalesces concurrent thumbnail generation per attachment.
	flights *thumbnailFlights
}

type createInput struct {
	Body          string       `json:"body"`
	ContentFormat string       `json:"contentFormat"`
	Sensitivity   string       `json:"sensitivity"`
	Title         *string      `json:"title"`
	FolderID      *string      `json:"folderId"`
	TagIDs        []string     `json:"tagIds"`
	Source        *sourceInput `json:"source"`
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
	ID              uuid.UUID `json:"id"`
	Kind            string    `json:"kind"`
	OriginalName    string    `json:"originalName"`
	DisplayName     string    `json:"displayName"`
	ClientMediaType *string   `json:"clientMediaType"`
	MediaType       string    `json:"mediaType"`
	SizeBytes       int64     `json:"sizeBytes"`
	Width           *int      `json:"width"`
	Height          *int      `json:"height"`
	PreviewAllowed  bool      `json:"previewAllowed"`
	ContentURL      string    `json:"contentUrl"`
	ThumbnailURL    *string   `json:"thumbnailUrl"`
	CreatedAt       time.Time `json:"createdAt"`
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
	derivativeRoot := filepath.Join(root, "derivatives")
	quarantineRoot := filepath.Join(root, "quarantine")
	for _, path := range []string{root, tempRoot, blobRoot, derivativeRoot, quarantineRoot} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return nil, fmt.Errorf("create attachment directory: %w", err)
		}
	}
	return &Service{
		database:       database,
		root:           root,
		tempRoot:       tempRoot,
		blobRoot:       blobRoot,
		derivativeRoot: derivativeRoot,
		quarantineRoot: quarantineRoot,
		timezone:       timezone,
		now:            time.Now,
		decode:         newDecodeLimiter(thumbnailDecodeConcurrency),
		flights:        newThumbnailFlights(),
	}, nil
}

func (service *Service) RegisterRoutes(router *http.ServeMux, authService *auth.Service) {
	service.auth = authService
	router.Handle("GET /api/v1/items", authService.Authorize("records:read")(http.HandlerFunc(service.listItems)))
	router.Handle("POST /api/v1/items", authService.AuthorizeMutation("records:write")(http.HandlerFunc(service.createJSON)))
	router.Handle("POST /api/v1/items:multipart", authService.AuthorizeMutation("records:write")(http.HandlerFunc(service.createMultipart)))
	router.Handle("GET /api/v1/items/{itemId}", authService.Authorize("records:read")(http.HandlerFunc(service.getItem)))
	router.Handle("PATCH /api/v1/items/{itemId}", authService.AuthenticateMutation(http.HandlerFunc(service.patchItem)))
	router.Handle("DELETE /api/v1/items/{itemId}", authService.AuthenticateMutation(http.HandlerFunc(service.trashItem)))
	router.Handle("POST /api/v1/items/{itemId}/restore", authService.AuthenticateMutation(http.HandlerFunc(service.restoreItem)))
	router.Handle("DELETE /api/v1/items/{itemId}/purge", authService.AuthenticateMutation(http.HandlerFunc(service.purgeItem)))
	router.Handle("POST /api/v1/items/{itemId}/raw-records", authService.AuthorizeMutation("records:write")(http.HandlerFunc(service.createSupplementJSON)))
	router.Handle("POST /api/v1/items/{itemId}/raw-records:multipart", authService.AuthorizeMutation("records:write")(http.HandlerFunc(service.createSupplementMultipart)))
	router.Handle("GET /api/v1/items/{itemId}/raw-records/{rawRecordId}", authService.Authorize("records:read")(http.HandlerFunc(service.getRawRecord)))
	router.Handle("GET /api/v1/attachments/{id}/metadata", authService.Authorize("records:read", "attachments:read")(http.HandlerFunc(service.getAttachmentMetadata)))
	router.Handle("GET /api/v1/attachments/{id}/content", authService.Authorize("records:read", "attachments:read")(http.HandlerFunc(service.getAttachmentContent)))
	router.Handle("GET /api/v1/attachments/{id}/thumbnail", authService.Authorize("records:read", "attachments:read")(http.HandlerFunc(service.getAttachmentThumbnail)))
	router.Handle("POST /api/v1/search", authService.AuthorizeMutation("records:read")(http.HandlerFunc(service.searchItems)))
	router.Handle("GET /api/v1/folders/tree", authService.Authenticate(http.HandlerFunc(service.listFolderTree)))
	router.Handle("POST /api/v1/folders", authService.AuthenticateMutation(http.HandlerFunc(service.createFolder)))
	router.Handle("PATCH /api/v1/folders/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.renameFolder)))
	router.Handle("POST /api/v1/folders/{id}/move", authService.AuthenticateMutation(http.HandlerFunc(service.moveFolder)))
	router.Handle("DELETE /api/v1/folders/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.deleteFolder)))
	router.Handle("GET /api/v1/tags", authService.Authenticate(http.HandlerFunc(service.listTags)))
	router.Handle("POST /api/v1/tags", authService.AuthenticateMutation(http.HandlerFunc(service.createTag)))
	router.Handle("PATCH /api/v1/tags/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.renameTag)))
	router.Handle("DELETE /api/v1/tags/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.deleteTag)))
}

func (service *Service) createItem(ctx context.Context, actor auth.Actor, input createInput, files []preparedFile, idempotencyKey string) (createResult, error) {
	if err := validateCreateInput(input, files); err != nil {
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
	folderID, tagIDs, err := parseCreateOrganization(input)
	if err != nil {
		return createResult{}, errInvalidInput
	}
	if idempotencyKey != "" {
		if result, found, lookupErr := service.findIdempotentResult(ctx, actor, idempotencyKey); lookupErr != nil || found {
			return result, lookupErr
		}
	}

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
		if _, err := tx.Exec(ctx, `
			DELETE FROM idempotency_records
			WHERE actor_type = $1 AND actor_id = $2 AND route_key = 'create_item'
			  AND idempotency_key = $3 AND expires_at <= $4
		`, actor.Type, actor.ID, idempotencyKey, now); err != nil {
			return createResult{}, err
		}
		var existingItemID, existingRawRecordID uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT created_item_id, created_raw_record_id
			FROM idempotency_records
			WHERE actor_type = $1 AND actor_id = $2 AND route_key = 'create_item'
			  AND idempotency_key = $3 AND expires_at > $4
		`, actor.Type, actor.ID, idempotencyKey, now).Scan(&existingItemID, &existingRawRecordID)
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
	if folderID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, "SELECT true FROM folders WHERE id = $1", *folderID).Scan(&exists); err != nil {
			return createResult{}, errInvalidInput
		}
	}
	if len(tagIDs) > 0 {
		var count int
		if err := tx.QueryRow(ctx, "SELECT COUNT(*) FROM tags WHERE id = ANY($1)", tagIDs).Scan(&count); err != nil || count != len(tagIDs) {
			return createResult{}, errInvalidInput
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO knowledge_items (
			id, title, title_origin, folder_id, sensitivity, favorite, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, false, $6, $6)
	`, itemID, title, titleOrigin, folderID, input.Sensitivity, now); err != nil {
		return createResult{}, err
	}
	for _, tagID := range tagIDs {
		if _, err := tx.Exec(ctx, "INSERT INTO item_tags (item_id, tag_id, created_at) VALUES ($1, $2, $3)", itemID, tagID, now); err != nil {
			return createResult{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO raw_records (
			id, item_id, record_role, source_type, content_kind, content_format, body,
			declared_sensitivity, captured_at, effective_captured_at, source_external_id,
			source_path, source_created_at, source_updated_at, source_time_quality,
			source_metadata, created_at
		) VALUES ($1, $2, 'primary', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $8)
	`, rawRecordID, itemID, source.Type, contentKind, input.ContentFormat, input.Body,
		input.Sensitivity, now, source.EffectiveCapturedAt, source.ExternalID, source.Path,
		source.CreatedAt, source.UpdatedAt, source.TimeQuality, source.MetadataJSON); err != nil {
		var databaseError *pgconn.PgError
		if source.ExternalID != nil && errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "raw_records_source_external_id" {
			_ = tx.Rollback(ctx)
			if result, found, lookupErr := service.findSourceResult(ctx, source.Type, *source.ExternalID); lookupErr != nil || found {
				return result, lookupErr
			}
		}
		return createResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO search_fragments (
			id, item_id, source_kind, ordinal, content, normalized_content, weight, active, created_at
		) VALUES ($1, $2, 'title', 0, $3, $4, 4, true, $5)
	`, uuid.NewSHA1(fragmentNS, []byte(itemID.String()+":title")), itemID, title, normalizeSearch(title), now); err != nil {
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
	if folderID != nil || len(tagIDs) > 0 {
		if err := service.rebuildItemMetadata(ctx, tx, itemID, now, false); err != nil {
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
		`, uuid.NewSHA1(fragmentNS, []byte(file.ID.String()+":filename")), itemID, ordinal, file.DisplayName, normalizeSearch(file.DisplayName), now); err != nil {
			return createResult{}, err
		}
		attachments = append(attachments, attachmentEntryFromStoredFile(file, now))
	}
	if idempotencyKey != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO idempotency_records (
				actor_type, actor_id, route_key, idempotency_key, created_item_id,
				created_raw_record_id, created_at, expires_at
			) VALUES ($1, $2, 'create_item', $3, $4, $5, $6, $7)
		`, actor.Type, actor.ID, idempotencyKey, itemID, rawRecordID, now, now.Add(24*time.Hour)); err != nil {
			var databaseError *pgconn.PgError
			if errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "idempotency_records_pkey" {
				if rollbackErr := tx.Rollback(ctx); rollbackErr != nil {
					return createResult{}, rollbackErr
				}
				result, found, lookupErr := service.findIdempotentResult(ctx, actor, idempotencyKey)
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
	if len(input.TagIDs) > 30 {
		return errInvalidInput
	}
	return nil
}

func parseCreateOrganization(input createInput) (*uuid.UUID, []uuid.UUID, error) {
	var folderID *uuid.UUID
	if input.FolderID != nil {
		parsed, err := uuid.Parse(*input.FolderID)
		if err != nil {
			return nil, nil, err
		}
		folderID = &parsed
	}
	tagIDs := make([]uuid.UUID, 0, len(input.TagIDs))
	seen := make(map[uuid.UUID]struct{}, len(input.TagIDs))
	for _, value := range input.TagIDs {
		parsed, err := uuid.Parse(value)
		if err != nil {
			return nil, nil, err
		}
		if _, exists := seen[parsed]; exists {
			return nil, nil, errInvalidInput
		}
		seen[parsed] = struct{}{}
		tagIDs = append(tagIDs, parsed)
	}
	return folderID, tagIDs, nil
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

func attachmentEntryFromStoredFile(file storedFile, createdAt time.Time) attachmentEntry {
	var clientMediaType *string
	if file.ClientMedia != "" {
		value := file.ClientMedia
		clientMediaType = &value
	}
	entry := attachmentEntry{
		ID: file.ID, Kind: file.Kind, OriginalName: file.OriginalName, DisplayName: file.DisplayName,
		ClientMediaType: clientMediaType, MediaType: file.MediaType, SizeBytes: file.SizeBytes,
		Width: file.Width, Height: file.Height, CreatedAt: createdAt,
	}
	populateAttachmentLinks(&entry)
	return entry
}

func populateAttachmentLinks(entry *attachmentEntry) {
	entry.PreviewAllowed = previewAllowed(entry.Kind, entry.MediaType, entry.Width, entry.Height)
	entry.ContentURL = "/api/v1/attachments/" + entry.ID.String() + "/content"
	if entry.PreviewAllowed {
		value := "/api/v1/attachments/" + entry.ID.String() + "/thumbnail"
		entry.ThumbnailURL = &value
	} else {
		entry.ThumbnailURL = nil
	}
}

func (service *Service) findIdempotentResult(ctx context.Context, actor auth.Actor, key string) (createResult, bool, error) {
	var itemID, rawRecordID uuid.UUID
	err := service.database.QueryRow(ctx, `
		SELECT created_item_id, created_raw_record_id
		FROM idempotency_records
		WHERE actor_type = $1 AND actor_id = $2 AND route_key = 'create_item'
		  AND idempotency_key = $3 AND expires_at > $4
	`, actor.Type, actor.ID, key, service.now().UTC()).Scan(&itemID, &rawRecordID)
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
		SELECT id, kind, original_name, display_name, client_media_type, media_type,
		       size_bytes, width, height, created_at
		FROM attachments WHERE raw_record_id = $1 AND status = 'ready'
		ORDER BY created_at, id
	`, rawRecordID)
	if err != nil {
		return createResult{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var entry attachmentEntry
		if err := rows.Scan(&entry.ID, &entry.Kind, &entry.OriginalName, &entry.DisplayName,
			&entry.ClientMediaType, &entry.MediaType, &entry.SizeBytes, &entry.Width, &entry.Height, &entry.CreatedAt); err != nil {
			return createResult{}, err
		}
		populateAttachmentLinks(&entry)
		result.Attachments = append(result.Attachments, entry)
	}
	return result, rows.Err()
}

var (
	errInvalidInput   = errors.New("invalid input")
	errUploadTooLarge = errors.New("upload too large")
)

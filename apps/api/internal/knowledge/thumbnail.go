package knowledge

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	xdraw "golang.org/x/image/draw"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const (
	thumbnailMaxEdge   = 512
	previewMaxEdge     = 16384
	previewMaxPixels   = 40_000_000
	thumbnailMediaType = "image/png"
	// A single decode may cost up to ~160MB of RGBA buffer at the 40-megapixel
	// preview ceiling; decoding one image at a time bounds the concurrent
	// memory budget of the whole process.
	thumbnailDecodeConcurrency = 1
)

// Sentinel failures of the registration pass; they map to distinct responses.
var (
	errThumbnailGone    = errors.New("attachment or its knowledge item is gone")
	errThumbnailChanged = errors.New("attachment original changed while the thumbnail was generated")
	errThumbnailDenied  = errors.New("caller may no longer read this attachment")
)

// decodeLimiter is a shared in-process permit pool for the expensive image
// decode; waiting respects request cancellation.
type decodeLimiter struct {
	permits chan struct{}
}

func newDecodeLimiter(size int) *decodeLimiter {
	limiter := &decodeLimiter{permits: make(chan struct{}, size)}
	for range size {
		limiter.permits <- struct{}{}
	}
	return limiter
}

func (limiter *decodeLimiter) acquire(ctx context.Context) (func(), error) {
	select {
	case <-limiter.permits:
		var once sync.Once
		release := func() {
			once.Do(func() { limiter.permits <- struct{}{} })
		}
		return release, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// InFlightDecodes reports how many heavy image decodes currently hold a
// decode permit. Read-only diagnostics for observability and integration
// tests; it never changes scheduling behavior.
func (service *Service) InFlightDecodes() int {
	return cap(service.decode.permits) - len(service.decode.permits)
}

// thumbnailFlights coalesces concurrent generation of the same attachment so
// only one request decodes it; waiters re-check the stored derivative after
// the winner finishes. The unique (attachment_id, kind) key stays the final
// deduplication guarantee.
type thumbnailFlights struct {
	mu       sync.Mutex
	inflight map[uuid.UUID]chan struct{}
}

func newThumbnailFlights() *thumbnailFlights {
	return &thumbnailFlights{inflight: make(map[uuid.UUID]chan struct{})}
}

func (flights *thumbnailFlights) enter(ctx context.Context, attachmentID uuid.UUID) (func(), error) {
	for {
		flights.mu.Lock()
		if done, busy := flights.inflight[attachmentID]; busy {
			flights.mu.Unlock()
			select {
			case <-done:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		done := make(chan struct{})
		flights.inflight[attachmentID] = done
		flights.mu.Unlock()
		var once sync.Once
		return func() {
			once.Do(func() {
				flights.mu.Lock()
				delete(flights.inflight, attachmentID)
				close(done)
				flights.mu.Unlock()
			})
		}, nil
	}
}

// thumbnailLookup carries the immutable original identity plus the current
// derivative state, read without any row lock.
type thumbnailLookup struct {
	attachmentID   uuid.UUID
	kind           string
	mediaType      string
	width          *int
	height         *int
	sensitivity    string
	originalKey    string
	contentSHA     []byte
	originalSize   int64
	derivativeID   uuid.UUID
	derivativeKey  string
	derivativeSize int64
	derivativeTime time.Time
	derivativeSet  bool
}

// lookupThumbnail reads attachment identity and derivative state in one short
// read-only transaction; it never takes the attachment row lock, so cache
// hits do not serialize behind each other or behind generation.
func (service *Service) lookupThumbnail(ctx context.Context, attachmentID uuid.UUID) (*thumbnailLookup, error) {
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	lookup := &thumbnailLookup{attachmentID: attachmentID}
	err = tx.QueryRow(ctx, `
		SELECT a.kind, a.media_type, a.width, a.height, i.sensitivity,
		       a.storage_key, a.content_sha256, a.size_bytes
		FROM attachments a
		JOIN raw_records r ON r.id = a.raw_record_id
		JOIN knowledge_items i ON i.id = r.item_id
		WHERE a.id = $1 AND a.status = 'ready' AND i.deleted_at IS NULL
	`, attachmentID).Scan(
		&lookup.kind, &lookup.mediaType, &lookup.width, &lookup.height, &lookup.sensitivity,
		&lookup.originalKey, &lookup.contentSHA, &lookup.originalSize,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errThumbnailGone
	}
	if err != nil {
		return nil, err
	}
	err = tx.QueryRow(ctx, `
		SELECT id, storage_key, size_bytes, created_at
		FROM attachment_derivatives WHERE attachment_id = $1 AND kind = 'thumbnail'
	`, attachmentID).Scan(&lookup.derivativeID, &lookup.derivativeKey, &lookup.derivativeSize, &lookup.derivativeTime)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		lookup.derivativeID = uuid.NewSHA1(fragmentNS, []byte(attachmentID.String()+":thumbnail"))
		lookup.derivativeKey = filepath.ToSlash(filepath.Join("derivatives", attachmentID.String()[0:2], attachmentID.String()+".png"))
	case err != nil:
		return nil, err
	default:
		lookup.derivativeSet = true
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return lookup, nil
}

func (service *Service) getAttachmentThumbnail(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	attachmentID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAttachmentNotFound(response, request)
		return
	}
	ctx := request.Context()
	lookup, err := service.lookupThumbnail(ctx, attachmentID)
	if err != nil {
		writeThumbnailLookupFailure(response, request, err)
		return
	}
	if !authorizeThumbnailRequest(response, request, lookup) {
		return
	}
	if service.serveHealthyDerivative(response, request, lookup) {
		return
	}
	// Coalesce concurrent generation of the same attachment in-process.
	leave, err := service.flights.enter(ctx, attachmentID)
	if err != nil {
		writeThumbnailInternal(response, request)
		return
	}
	defer leave()
	// The attachment state and the derivative may both have changed while
	// waiting for the in-flight generation.
	lookup, err = service.lookupThumbnail(ctx, attachmentID)
	if err != nil {
		writeThumbnailLookupFailure(response, request, err)
		return
	}
	if !authorizeThumbnailRequest(response, request, lookup) {
		return
	}
	if service.serveHealthyDerivative(response, request, lookup) {
		return
	}
	service.generateThumbnail(response, request, lookup)
}

// generateThumbnail decodes outside any database transaction under the shared
// decode permit, writes an independent temporary file, and only then opens a
// short transaction that re-verifies the attachment and registers the
// derivative.
func (service *Service) generateThumbnail(response http.ResponseWriter, request *http.Request, lookup *thumbnailLookup) {
	ctx := request.Context()
	release, err := service.decode.acquire(ctx)
	if err != nil {
		writeThumbnailInternal(response, request)
		return
	}
	defer release()
	originalPath, err := service.storagePath(lookup.originalKey)
	if err != nil {
		writeThumbnailInternal(response, request)
		return
	}
	original, err := os.Open(originalPath)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusConflict, "ATTACHMENT_INTEGRITY_FAILED", "附件原件不可用")
		return
	}
	defer original.Close()
	config, _, err := image.DecodeConfig(original)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusUnsupportedMediaType, "PREVIEW_UNAVAILABLE", "该附件无法安全解码")
		return
	}
	width, height := config.Width, config.Height
	if width <= 0 || height <= 0 || width > previewMaxEdge || height > previewMaxEdge || int64(width)*int64(height) > previewMaxPixels {
		httpapi.WriteError(response, request, http.StatusUnsupportedMediaType, "PREVIEW_UNAVAILABLE", "图片尺寸超过一期安全预览上限")
		return
	}
	if lookup.width == nil || lookup.height == nil || *lookup.width != width || *lookup.height != height {
		httpapi.WriteError(response, request, http.StatusConflict, "ATTACHMENT_INTEGRITY_FAILED", "附件原件元数据不一致")
		return
	}
	if _, err := original.Seek(0, 0); err != nil {
		writeThumbnailInternal(response, request)
		return
	}
	decoded, _, err := image.Decode(original)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusUnsupportedMediaType, "PREVIEW_UNAVAILABLE", "该附件无法安全解码")
		return
	}
	bounds := decoded.Bounds()
	if bounds.Dx() != width || bounds.Dy() != height {
		httpapi.WriteError(response, request, http.StatusConflict, "ATTACHMENT_INTEGRITY_FAILED", "附件原件元数据不一致")
		return
	}
	targetWidth, targetHeight := thumbnailDimensions(width, height)
	thumbnail := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	xdraw.CatmullRom.Scale(thumbnail, thumbnail.Bounds(), decoded, bounds, xdraw.Over, nil)

	temporary, err := os.CreateTemp(service.tempRoot, "thumbnail-*.png")
	if err != nil {
		writeThumbnailInternal(response, request)
		return
	}
	temporaryPath := temporary.Name()
	cleanupTemporary := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := png.Encode(temporary, thumbnail); err != nil {
		cleanupTemporary()
		writeThumbnailInternal(response, request)
		return
	}
	if err := temporary.Sync(); err != nil {
		cleanupTemporary()
		writeThumbnailInternal(response, request)
		return
	}
	info, err := temporary.Stat()
	if err != nil || temporary.Close() != nil {
		cleanupTemporary()
		writeThumbnailInternal(response, request)
		return
	}
	finalPath, err := service.storagePath(lookup.derivativeKey)
	if err != nil {
		cleanupTemporary()
		writeThumbnailInternal(response, request)
		return
	}
	if err := os.MkdirAll(filepath.Dir(finalPath), 0o700); err != nil {
		cleanupTemporary()
		writeThumbnailInternal(response, request)
		return
	}
	if err := os.Rename(temporaryPath, finalPath); err != nil {
		cleanupTemporary()
		writeThumbnailInternal(response, request)
		return
	}
	if err := os.Chmod(finalPath, 0o600); err != nil {
		_ = os.Remove(finalPath)
		writeThumbnailInternal(response, request)
		return
	}

	// Short registration transaction: re-verify the attachment and register
	// the generated file. The heavy work above never holds a database lock.
	createdAt := service.now().UTC()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		removeUnregisteredDerivative(lookup, finalPath)
		writeThumbnailInternal(response, request)
		return
	}
	defer tx.Rollback(ctx)
	verifyErr := verifyAndRegisterDerivative(ctx, tx, request, lookup, info.Size(), createdAt)
	if verifyErr == nil {
		verifyErr = tx.Commit(ctx)
	}
	if verifyErr != nil {
		removeUnregisteredDerivative(lookup, finalPath)
		writeThumbnailRegistrationFailure(response, request, verifyErr)
		return
	}
	service.serveThumbnail(response, request, finalPath, createdAt)
}

// thumbnailOriginal is checked against the current database row so a deleted
// attachment, a trashed knowledge item, or a replaced original never gets its
// freshly generated thumbnail registered or served.
func verifyAndRegisterDerivative(ctx context.Context, querier derivativeQuerier, request *http.Request, lookup *thumbnailLookup, generatedSize int64, createdAt time.Time) error {
	var storageKey string
	var contentSHA []byte
	var sizeBytes int64
	var width, height *int
	var sensitivity string
	err := querier.QueryRow(ctx, `
		SELECT a.storage_key, a.content_sha256, a.size_bytes, a.width, a.height, i.sensitivity
		FROM attachments a
		JOIN raw_records r ON r.id = a.raw_record_id
		JOIN knowledge_items i ON i.id = r.item_id
		WHERE a.id = $1 AND a.status = 'ready' AND i.deleted_at IS NULL
	`, lookup.attachmentID).Scan(&storageKey, &contentSHA, &sizeBytes, &width, &height, &sensitivity)
	if errors.Is(err, pgx.ErrNoRows) {
		return errThumbnailGone
	}
	if err != nil {
		return err
	}
	if storageKey != lookup.originalKey || !bytes.Equal(contentSHA, lookup.contentSHA) || sizeBytes != lookup.originalSize ||
		width == nil || height == nil || lookup.width == nil || lookup.height == nil ||
		*width != *lookup.width || *height != *lookup.height {
		return errThumbnailChanged
	}
	if !requestActorCanReadSensitivity(request, sensitivity) {
		return errThumbnailDenied
	}
	_, err = querier.Exec(ctx, `
		INSERT INTO attachment_derivatives (id, attachment_id, kind, storage_key, media_type, size_bytes, created_at)
		VALUES ($1, $2, 'thumbnail', $3, $4, $5, $6)
		ON CONFLICT (attachment_id, kind) DO UPDATE
		SET storage_key = EXCLUDED.storage_key, media_type = EXCLUDED.media_type,
		    size_bytes = EXCLUDED.size_bytes, created_at = EXCLUDED.created_at
	`, lookup.derivativeID, lookup.attachmentID, lookup.derivativeKey, thumbnailMediaType, generatedSize, createdAt)
	return err
}

type derivativeQuerier interface {
	QueryRow(ctx context.Context, query string, args ...any) pgx.Row
	Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error)
}

// removeUnregisteredDerivative only cleans up a file when this request had to
// create the derivative record from scratch; an existing record (regenerated
// cache) keeps its file. Owners of a failed generation never touch files they
// did not rename into place themselves.
func removeUnregisteredDerivative(lookup *thumbnailLookup, finalPath string) {
	if !lookup.derivativeSet {
		_ = os.Remove(finalPath)
	}
}

func (service *Service) serveHealthyDerivative(response http.ResponseWriter, request *http.Request, lookup *thumbnailLookup) bool {
	if !lookup.derivativeSet {
		return false
	}
	path, err := service.storagePath(lookup.derivativeKey)
	if err != nil {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != lookup.derivativeSize {
		return false
	}
	service.serveThumbnail(response, request, path, lookup.derivativeTime)
	return true
}

func authorizeThumbnailRequest(response http.ResponseWriter, request *http.Request, lookup *thumbnailLookup) bool {
	if !requestActorCanReadSensitivity(request, lookup.sensitivity) {
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 无权读取敏感附件")
		return false
	}
	if !previewAllowed(lookup.kind, lookup.mediaType, lookup.width, lookup.height) {
		httpapi.WriteError(response, request, http.StatusUnsupportedMediaType, "PREVIEW_UNAVAILABLE", "该附件不支持安全预览")
		return false
	}
	return true
}

func writeThumbnailLookupFailure(response http.ResponseWriter, request *http.Request, err error) {
	if errors.Is(err, errThumbnailGone) {
		writeAttachmentNotFound(response, request)
		return
	}
	writeThumbnailInternal(response, request)
}

func writeThumbnailRegistrationFailure(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, errThumbnailGone):
		writeAttachmentNotFound(response, request)
	case errors.Is(err, errThumbnailChanged):
		httpapi.WriteError(response, request, http.StatusConflict, "ATTACHMENT_INTEGRITY_FAILED", "附件原件元数据不一致")
	case errors.Is(err, errThumbnailDenied):
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 无权读取敏感附件")
	default:
		writeThumbnailInternal(response, request)
	}
}

func previewAllowed(kind, mediaType string, width, height *int) bool {
	if kind != "image" || !safeImageMediaType(mediaType) || width == nil || height == nil || *width <= 0 || *height <= 0 {
		return false
	}
	return *width <= previewMaxEdge && *height <= previewMaxEdge && int64(*width)*int64(*height) <= previewMaxPixels
}

func thumbnailDimensions(width, height int) (int, int) {
	if width <= thumbnailMaxEdge && height <= thumbnailMaxEdge {
		return width, height
	}
	if width >= height {
		return thumbnailMaxEdge, max(1, height*thumbnailMaxEdge/width)
	}
	return max(1, width*thumbnailMaxEdge/height), thumbnailMaxEdge
}

func (service *Service) serveThumbnail(response http.ResponseWriter, request *http.Request, path string, createdAt time.Time) {
	file, err := os.Open(path)
	if err != nil {
		writeThumbnailInternal(response, request)
		return
	}
	defer file.Close()
	response.Header().Set("Content-Type", thumbnailMediaType)
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	disposition := mime.FormatMediaType("inline", map[string]string{"filename": "thumbnail.png"})
	response.Header().Set("Content-Disposition", disposition)
	http.ServeContent(response, request, "thumbnail.png", createdAt, file)
}

func writeAttachmentNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "附件不存在")
}

func writeThumbnailInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "缩略图暂时不可用")
}

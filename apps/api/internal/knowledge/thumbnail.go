package knowledge

import (
	"errors"
	"image"
	"image/png"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	xdraw "golang.org/x/image/draw"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const (
	thumbnailMaxEdge   = 512
	previewMaxEdge     = 16384
	previewMaxPixels   = 40_000_000
	thumbnailMediaType = "image/png"
)

func (service *Service) getAttachmentThumbnail(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	attachmentID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		writeAttachmentNotFound(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeThumbnailInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())

	var metadata attachmentMetadata
	err = tx.QueryRow(request.Context(), `
		SELECT a.id, a.kind, a.original_name, a.display_name, a.client_media_type,
		       a.media_type, a.size_bytes, a.width, a.height, a.created_at,
		       r.item_id, a.raw_record_id, a.storage_key
		FROM attachments a
		JOIN raw_records r ON r.id = a.raw_record_id
		JOIN knowledge_items i ON i.id = r.item_id
		WHERE a.id = $1 AND a.status = 'ready' AND i.deleted_at IS NULL
		FOR UPDATE OF a
	`, attachmentID).Scan(
		&metadata.ID, &metadata.Kind, &metadata.OriginalName, &metadata.DisplayName,
		&metadata.ClientMediaType, &metadata.MediaType, &metadata.SizeBytes,
		&metadata.Width, &metadata.Height, &metadata.CreatedAt, &metadata.ItemID,
		&metadata.RawRecordID, &metadata.StorageKey,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAttachmentNotFound(response, request)
		return
	}
	if err != nil {
		writeThumbnailInternal(response, request)
		return
	}
	if !previewAllowed(metadata.Kind, metadata.MediaType, metadata.Width, metadata.Height) {
		httpapi.WriteError(response, request, http.StatusUnsupportedMediaType, "PREVIEW_UNAVAILABLE", "该附件不支持安全预览")
		return
	}

	var derivativeID uuid.UUID
	var storageKey string
	var sizeBytes int64
	var createdAt time.Time
	derivativeExists := true
	err = tx.QueryRow(request.Context(), `
		SELECT id, storage_key, size_bytes, created_at
		FROM attachment_derivatives WHERE attachment_id = $1 AND kind = 'thumbnail'
	`, attachmentID).Scan(&derivativeID, &storageKey, &sizeBytes, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		derivativeExists = false
		derivativeID = uuid.NewSHA1(fragmentNS, []byte(attachmentID.String()+":thumbnail"))
		storageKey = filepath.ToSlash(filepath.Join("derivatives", attachmentID.String()[0:2], attachmentID.String()+".png"))
	} else if err != nil {
		writeThumbnailInternal(response, request)
		return
	}
	if derivativeExists {
		path, pathErr := service.storagePath(storageKey)
		if pathErr == nil {
			if info, statErr := os.Stat(path); statErr == nil && info.Mode().IsRegular() && info.Size() == sizeBytes {
				if err := tx.Commit(request.Context()); err != nil {
					writeThumbnailInternal(response, request)
					return
				}
				service.serveThumbnail(response, request, path, createdAt)
				return
			}
		}
	}

	originalPath, err := service.storagePath(metadata.StorageKey)
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
	if metadata.Width == nil || metadata.Height == nil || *metadata.Width != width || *metadata.Height != height {
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
	finalPath, err := service.storagePath(storageKey)
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
	sizeBytes = info.Size()
	createdAt = service.now().UTC()
	_, err = tx.Exec(request.Context(), `
		INSERT INTO attachment_derivatives (id, attachment_id, kind, storage_key, media_type, size_bytes, created_at)
		VALUES ($1, $2, 'thumbnail', $3, $4, $5, $6)
		ON CONFLICT (attachment_id, kind) DO UPDATE
		SET storage_key = EXCLUDED.storage_key, media_type = EXCLUDED.media_type,
		    size_bytes = EXCLUDED.size_bytes, created_at = EXCLUDED.created_at
	`, derivativeID, attachmentID, storageKey, thumbnailMediaType, sizeBytes, createdAt)
	if err != nil {
		if !derivativeExists {
			_ = os.Remove(finalPath)
		}
		writeThumbnailInternal(response, request)
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		if !derivativeExists {
			_ = os.Remove(finalPath)
		}
		writeThumbnailInternal(response, request)
		return
	}
	service.serveThumbnail(response, request, finalPath, createdAt)
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

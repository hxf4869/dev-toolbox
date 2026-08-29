package knowledge

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	_ "golang.org/x/image/webp"
)

const (
	maxFileBytes  = 20 * 1024 * 1024
	maxTotalBytes = 100 * 1024 * 1024
	maxFileCount  = 10
)

var errFileTooLarge = errors.New("attachment exceeds 20 MiB")

type preparedFile struct {
	TempPath      string
	OriginalName  string
	DisplayName   string
	ClientMedia   string
	MediaType     string
	Kind          string
	SizeBytes     int64
	ContentSHA256 []byte
	Width         *int
	Height        *int
}

func prepareFile(part *multipart.Part, temporaryRoot string) (preparedFile, error) {
	originalName := clientBaseName(part.FileName())
	if originalName == "" || runeCount(originalName) > 1024 {
		return preparedFile{}, fmt.Errorf("invalid attachment name")
	}
	file, err := os.CreateTemp(temporaryRoot, "upload-*")
	if err != nil {
		return preparedFile{}, fmt.Errorf("create temporary attachment: %w", err)
	}
	tempPath := file.Name()
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(tempPath)
	}
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, hasher), io.LimitReader(part, maxFileBytes+1))
	if err != nil {
		cleanup()
		return preparedFile{}, fmt.Errorf("stream attachment: %w", err)
	}
	if written > maxFileBytes {
		cleanup()
		return preparedFile{}, errFileTooLarge
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return preparedFile{}, fmt.Errorf("sync attachment: %w", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return preparedFile{}, fmt.Errorf("seek attachment: %w", err)
	}
	header := make([]byte, 512)
	headerLength, err := io.ReadFull(file, header)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		cleanup()
		return preparedFile{}, fmt.Errorf("read attachment header: %w", err)
	}
	mediaType := http.DetectContentType(header[:headerLength])
	kind := "file"
	var width, height *int
	if safeImageMediaType(mediaType) {
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			cleanup()
			return preparedFile{}, err
		}
		config, _, decodeErr := image.DecodeConfig(file)
		if decodeErr == nil && config.Width > 0 && config.Height > 0 {
			kind = "image"
			widthValue, heightValue := config.Width, config.Height
			width, height = &widthValue, &heightValue
		} else {
			mediaType = "application/octet-stream"
		}
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tempPath)
		return preparedFile{}, fmt.Errorf("close attachment: %w", err)
	}
	clientMedia := truncateRunesTo(strings.TrimSpace(part.Header.Get("Content-Type")), 255)
	return preparedFile{
		TempPath:      tempPath,
		OriginalName:  originalName,
		DisplayName:   displayName(originalName),
		ClientMedia:   clientMedia,
		MediaType:     mediaType,
		Kind:          kind,
		SizeBytes:     written,
		ContentSHA256: hasher.Sum(nil),
		Width:         width,
		Height:        height,
	}, nil
}

func truncateRunesTo(value string, limit int) string {
	runes := []rune(value)
	if len(runes) > limit {
		runes = runes[:limit]
	}
	return string(runes)
}

func clientBaseName(value string) string {
	value = strings.ReplaceAll(value, "\\", "/")
	return filepath.Base(value)
}

func displayName(value string) string {
	value = strings.Map(func(character rune) rune {
		switch {
		case unicode.IsControl(character):
			return -1
		case character == '/' || character == '\\' || character == '"' || character == ';':
			return '_'
		default:
			return character
		}
	}, value)
	value = strings.Trim(strings.TrimSpace(value), ".")
	if value == "" {
		value = "attachment"
	}
	runes := []rune(value)
	if len(runes) > 255 {
		value = string(runes[:255])
	}
	return value
}

func safeImageMediaType(value string) bool {
	switch value {
	case "image/jpeg", "image/png", "image/webp", "image/gif":
		return true
	default:
		return false
	}
}

func totalUploadAllowed(actualFileBytes int64) bool {
	return actualFileBytes <= maxTotalBytes
}

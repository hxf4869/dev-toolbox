package knowledge

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
)

var sourceNamespace = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

type sourceInput struct {
	SourceType  string              `json:"sourceType"`
	ExternalID  *string             `json:"externalId"`
	Path        *string             `json:"path"`
	CreatedAt   *string             `json:"createdAt"`
	UpdatedAt   *string             `json:"updatedAt"`
	TimeQuality string              `json:"timeQuality"`
	Metadata    sourceMetadataInput `json:"metadata"`
}

type sourceMetadataInput struct {
	SourceApplication  *string `json:"sourceApplication,omitempty"`
	ImportBatchID      *string `json:"importBatchId,omitempty"`
	OriginalURL        *string `json:"originalUrl,omitempty"`
	ExportRelativePath *string `json:"exportRelativePath,omitempty"`
	ParentExternalID   *string `json:"parentExternalId,omitempty"`
	Sequence           *int64  `json:"sequence,omitempty"`
}

type resolvedSource struct {
	Type                string
	ExternalID          *string
	Path                *string
	CreatedAt           *time.Time
	UpdatedAt           *time.Time
	TimeQuality         string
	MetadataJSON        []byte
	EffectiveCapturedAt time.Time
}

func resolveSource(actor auth.Actor, input *sourceInput, capturedAt time.Time) (resolvedSource, error) {
	if input == nil {
		sourceType := "web_capture"
		if actor.Type == "pat" {
			sourceType = "api"
		}
		return resolvedSource{Type: sourceType, TimeQuality: "unknown", MetadataJSON: []byte("{}"), EffectiveCapturedAt: capturedAt}, nil
	}
	if actor.Type != "pat" || !containsString([]string{"api", "browser_extension", "notion_migration", "wecom_migration"}, input.SourceType) {
		return resolvedSource{}, errInvalidInput
	}
	result := resolvedSource{Type: input.SourceType, TimeQuality: input.TimeQuality, EffectiveCapturedAt: capturedAt}
	if !containsString([]string{"exact", "estimated", "unknown"}, result.TimeQuality) {
		return resolvedSource{}, errInvalidInput
	}
	if input.ExternalID != nil {
		value := strings.TrimSpace(*input.ExternalID)
		parts := strings.SplitN(value, ":", 2)
		if !utf8.ValidString(value) || len([]rune(value)) > 500 || len(parts) != 2 || !sourceNamespace.MatchString(parts[0]) || strings.TrimSpace(parts[1]) == "" {
			return resolvedSource{}, errInvalidInput
		}
		result.ExternalID = &value
	}
	if input.Path != nil {
		value := strings.TrimSpace(*input.Path)
		if !utf8.ValidString(value) || value == "" || len([]rune(value)) > 2048 {
			return resolvedSource{}, errInvalidInput
		}
		result.Path = &value
	}
	var err error
	if input.CreatedAt != nil {
		value, parseErr := time.Parse(time.RFC3339, *input.CreatedAt)
		if parseErr != nil {
			return resolvedSource{}, errInvalidInput
		}
		value = value.UTC()
		result.CreatedAt = &value
	}
	if input.UpdatedAt != nil {
		value, parseErr := time.Parse(time.RFC3339, *input.UpdatedAt)
		if parseErr != nil {
			return resolvedSource{}, errInvalidInput
		}
		value = value.UTC()
		result.UpdatedAt = &value
	}
	if result.TimeQuality != "unknown" {
		if result.CreatedAt == nil {
			return resolvedSource{}, errInvalidInput
		}
		result.EffectiveCapturedAt = *result.CreatedAt
	}
	if err = validateSourceMetadata(input.Metadata); err != nil {
		return resolvedSource{}, err
	}
	result.MetadataJSON, err = json.Marshal(input.Metadata)
	if err != nil || len(result.MetadataJSON) > 16*1024 {
		return resolvedSource{}, errInvalidInput
	}
	return result, nil
}

func validateSourceMetadata(metadata sourceMetadataInput) error {
	for _, field := range []struct {
		value *string
		limit int
	}{
		{metadata.SourceApplication, 120}, {metadata.ImportBatchID, 120},
		{metadata.ExportRelativePath, 2048}, {metadata.ParentExternalID, 500},
	} {
		if field.value != nil && (!utf8.ValidString(*field.value) || len([]rune(*field.value)) > field.limit) {
			return errInvalidInput
		}
	}
	if metadata.Sequence != nil && *metadata.Sequence < 0 {
		return errInvalidInput
	}
	if metadata.OriginalURL != nil {
		if len(*metadata.OriginalURL) > 2048 {
			return errInvalidInput
		}
		parsed, err := url.Parse(*metadata.OriginalURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return errInvalidInput
		}
	}
	return nil
}

func (service *Service) findSourceResult(ctx context.Context, sourceType, externalID string) (createResult, bool, error) {
	var itemID, rawRecordID uuid.UUID
	err := service.database.QueryRow(ctx, `
		SELECT item_id, id FROM raw_records WHERE source_type = $1 AND source_external_id = $2
	`, sourceType, externalID).Scan(&itemID, &rawRecordID)
	if err == pgx.ErrNoRows {
		return createResult{}, false, nil
	}
	if err != nil {
		return createResult{}, false, err
	}
	result, err := service.loadCreateResult(ctx, itemID, rawRecordID)
	return result, err == nil, err
}

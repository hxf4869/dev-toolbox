package knowledge

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type RebuildSearchResult struct {
	Items      int `json:"items"`
	RawRecords int `json:"rawRecords"`
	Fragments  int `json:"fragments"`
}

// RebuildSearch reconstructs current search derivatives without deleting historical raw fragment versions.
func RebuildSearch(ctx context.Context, database *pgxpool.Pool, now time.Time) (RebuildSearchResult, error) {
	rows, err := database.Query(ctx, "SELECT id FROM knowledge_items ORDER BY id")
	if err != nil {
		return RebuildSearchResult{}, err
	}
	itemIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var itemID uuid.UUID
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return RebuildSearchResult{}, err
		}
		itemIDs = append(itemIDs, itemID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RebuildSearchResult{}, err
	}
	rows.Close()

	result := RebuildSearchResult{Items: len(itemIDs)}
	service := &Service{database: database}
	for _, itemID := range itemIDs {
		rawCount, fragmentCount, err := service.rebuildItemSearch(ctx, itemID, now.UTC())
		if err != nil {
			return RebuildSearchResult{}, err
		}
		result.RawRecords += rawCount
		result.Fragments += fragmentCount
	}
	return result, nil
}

func (service *Service) rebuildItemSearch(ctx context.Context, itemID uuid.UUID, now time.Time) (int, int, error) {
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(ctx)
	var title string
	if err := tx.QueryRow(ctx, "SELECT title FROM knowledge_items WHERE id = $1 FOR UPDATE", itemID).Scan(&title); err != nil {
		return 0, 0, err
	}
	type rawSource struct {
		id   uuid.UUID
		body string
	}
	rawRows, err := tx.Query(ctx, "SELECT id, body FROM raw_records WHERE item_id = $1 ORDER BY id", itemID)
	if err != nil {
		return 0, 0, err
	}
	rawSources := make([]rawSource, 0)
	for rawRows.Next() {
		var source rawSource
		if err := rawRows.Scan(&source.id, &source.body); err != nil {
			rawRows.Close()
			return 0, 0, err
		}
		rawSources = append(rawSources, source)
	}
	if err := rawRows.Err(); err != nil {
		rawRows.Close()
		return 0, 0, err
	}
	rawRows.Close()

	if _, err := tx.Exec(ctx, `
		UPDATE search_fragments SET active = false
		WHERE item_id = $1 AND source_kind IN ('raw_text', 'code')
	`, itemID); err != nil {
		return 0, 0, err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM search_fragments
		WHERE item_id = $1 AND source_kind IN ('raw_text', 'code') AND fragment_version = $2
	`, itemID, fragmentVersion); err != nil {
		return 0, 0, err
	}
	fragmentCount := 0
	for _, source := range rawSources {
		for _, fragment := range splitTextFragments(source.id, source.body) {
			if _, err := tx.Exec(ctx, `
				INSERT INTO search_fragments (
					id, item_id, raw_record_id, source_kind, ordinal, fragment_version,
					start_byte, end_byte, content, normalized_content, weight, active, created_at
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 3, true, $11)
			`, fragment.ID, itemID, source.id, fragment.Kind, fragment.Ordinal, fragmentVersion,
				fragment.StartByte, fragment.EndByte, fragment.Content, fragment.Normalized, now); err != nil {
				return 0, 0, err
			}
			fragmentCount++
		}
	}
	if err := replaceTitleSearchFragment(ctx, tx, itemID, title, now); err != nil {
		return 0, 0, err
	}
	fragmentCount++
	if err := service.rebuildItemMetadata(ctx, tx, itemID, now, false); err != nil {
		return 0, 0, err
	}
	var hasMetadata bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM search_fragments WHERE item_id = $1 AND source_kind = 'metadata')
	`, itemID).Scan(&hasMetadata); err != nil {
		return 0, 0, err
	}
	if hasMetadata {
		fragmentCount++
	}
	if _, err := tx.Exec(ctx, "DELETE FROM search_fragments WHERE item_id = $1 AND source_kind = 'filename'", itemID); err != nil {
		return 0, 0, err
	}
	attachmentRows, err := tx.Query(ctx, `
		SELECT a.id, a.display_name
		FROM attachments a JOIN raw_records r ON r.id = a.raw_record_id
		WHERE r.item_id = $1 AND a.status = 'ready'
		ORDER BY r.effective_captured_at, r.id, a.created_at, a.id
	`, itemID)
	if err != nil {
		return 0, 0, err
	}
	type filenameSource struct {
		id   uuid.UUID
		name string
	}
	filenames := make([]filenameSource, 0)
	for attachmentRows.Next() {
		var source filenameSource
		if err := attachmentRows.Scan(&source.id, &source.name); err != nil {
			attachmentRows.Close()
			return 0, 0, err
		}
		filenames = append(filenames, source)
	}
	if err := attachmentRows.Err(); err != nil {
		attachmentRows.Close()
		return 0, 0, err
	}
	attachmentRows.Close()
	for ordinal, source := range filenames {
		if _, err := tx.Exec(ctx, `
			INSERT INTO search_fragments (
				id, item_id, source_kind, ordinal, content, normalized_content, weight, active, created_at
			) VALUES ($1, $2, 'filename', $3, $4, $5, 2, true, $6)
		`, uuid.NewSHA1(fragmentNS, []byte(source.id.String()+":filename")), itemID, ordinal,
			source.name, normalizeSearch(source.name), now); err != nil {
			return 0, 0, err
		}
		fragmentCount++
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return len(rawSources), fragmentCount, nil
}

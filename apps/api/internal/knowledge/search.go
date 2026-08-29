package knowledge

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const fuzzySimilarityThreshold = 0.28

type searchRequest struct {
	Query        string   `json:"q"`
	Sort         string   `json:"sort"`
	FolderID     *string  `json:"folderId"`
	TagIDs       []string `json:"tagIds"`
	ContentKinds []string `json:"contentKinds"`
	Sensitivity  []string `json:"sensitivity"`
	From         *string  `json:"from"`
	To           *string  `json:"to"`
	Cursor       *string  `json:"cursor"`
	Limit        int      `json:"limit"`
}

type snippetPart struct {
	Text        string `json:"text"`
	Highlighted bool   `json:"highlighted"`
}

type searchResult struct {
	ItemID              uuid.UUID     `json:"itemId"`
	Title               string        `json:"title"`
	SnippetParts        []snippetPart `json:"snippetParts"`
	MatchedSource       string        `json:"matchedSource"`
	MatchedFragmentID   uuid.UUID     `json:"matchedFragmentId"`
	EffectiveCapturedAt time.Time     `json:"effectiveCapturedAt"`
	Sensitivity         string        `json:"sensitivity"`
	ArtifactIsStale     *bool         `json:"artifactIsStale"`
	matchClass          int
	similarity          float64
}

type searchCursor struct {
	Sort       string    `json:"s"`
	MatchClass int       `json:"c,omitempty"`
	Similarity float64   `json:"m,omitempty"`
	Effective  time.Time `json:"t"`
	ItemID     uuid.UUID `json:"i"`
}

type queryArguments struct {
	values []any
}

func (arguments *queryArguments) add(value any) string {
	arguments.values = append(arguments.values, value)
	return fmt.Sprintf("$%d", len(arguments.values))
}

func (service *Service) searchItems(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input searchRequest
	if httpapi.DecodeJSON(response, request, 32*1024, &input) != nil {
		writeSearchValidationError(response, request)
		return
	}
	validated, err := validateSearchRequest(input)
	if err != nil {
		writeSearchValidationError(response, request)
		return
	}
	results, total, nextCursor, err := service.runSearch(request, validated)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "搜索暂时不可用")
		return
	}
	payload := map[string]any{
		"sort":       validated.Sort,
		"items":      results,
		"nextCursor": nextCursor,
	}
	if validated.Cursor == nil {
		payload["total"] = total
	}
	httpapi.WriteJSON(response, http.StatusOK, payload)
}

type validatedSearch struct {
	Query        string
	Sort         string
	FolderID     *uuid.UUID
	TagIDs       []uuid.UUID
	ContentKinds []string
	Sensitivity  []string
	From         *time.Time
	To           *time.Time
	Cursor       *searchCursor
	Limit        int
}

func validateSearchRequest(input searchRequest) (validatedSearch, error) {
	query := strings.TrimSpace(input.Query)
	if query == "" || !utf8.ValidString(query) || runeCount(query) > 500 {
		return validatedSearch{}, errInvalidInput
	}
	sort := input.Sort
	if sort == "" {
		sort = "relevance"
	}
	if sort != "relevance" && sort != "recency" {
		return validatedSearch{}, errInvalidInput
	}
	limit := input.Limit
	if limit == 0 {
		limit = 30
	}
	if limit < 10 || limit > 100 {
		return validatedSearch{}, errInvalidInput
	}
	result := validatedSearch{Query: query, Sort: sort, Limit: limit}
	if input.FolderID != nil {
		id, err := uuid.Parse(*input.FolderID)
		if err != nil {
			return validatedSearch{}, errInvalidInput
		}
		result.FolderID = &id
	}
	if len(input.TagIDs) > 30 {
		return validatedSearch{}, errInvalidInput
	}
	seenTags := make(map[uuid.UUID]struct{}, len(input.TagIDs))
	for _, value := range input.TagIDs {
		id, err := uuid.Parse(value)
		if err != nil {
			return validatedSearch{}, errInvalidInput
		}
		if _, exists := seenTags[id]; !exists {
			seenTags[id] = struct{}{}
			result.TagIDs = append(result.TagIDs, id)
		}
	}
	if !validStringSet(input.ContentKinds, []string{"text", "image", "file", "mixed"}) ||
		!validStringSet(input.Sensitivity, []string{"normal", "sensitive", "unknown"}) {
		return validatedSearch{}, errInvalidInput
	}
	result.ContentKinds = uniqueStrings(input.ContentKinds)
	result.Sensitivity = uniqueStrings(input.Sensitivity)
	if input.From != nil {
		parsed, err := time.Parse(time.RFC3339, *input.From)
		if err != nil {
			return validatedSearch{}, errInvalidInput
		}
		parsed = parsed.UTC()
		result.From = &parsed
	}
	if input.To != nil {
		parsed, err := time.Parse(time.RFC3339, *input.To)
		if err != nil {
			return validatedSearch{}, errInvalidInput
		}
		parsed = parsed.UTC()
		result.To = &parsed
	}
	if result.From != nil && result.To != nil && result.From.After(*result.To) {
		return validatedSearch{}, errInvalidInput
	}
	if input.Cursor != nil && *input.Cursor != "" {
		cursor, err := decodeSearchCursor(*input.Cursor, sort)
		if err != nil {
			return validatedSearch{}, errInvalidInput
		}
		result.Cursor = &cursor
	}
	return result, nil
}

func validStringSet(values, allowed []string) bool {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, value := range allowed {
		allowedSet[value] = struct{}{}
	}
	for _, value := range values {
		if _, exists := allowedSet[value]; !exists {
			return false
		}
	}
	return true
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func (service *Service) runSearch(request *http.Request, input validatedSearch) ([]searchResult, int64, *string, error) {
	arguments := &queryArguments{}
	normalizedQuery := normalizeSearch(input.Query)
	queryParameter := arguments.add(normalizedQuery)
	literalParameter := arguments.add("%" + escapeLike(normalizedQuery) + "%")
	thresholdParameter := arguments.add(float32(fuzzySimilarityThreshold))

	filters := []string{"i.deleted_at IS NULL", "f.active = true"}
	if input.FolderID != nil {
		filters = append(filters, "i.folder_id = "+arguments.add(*input.FolderID))
	}
	if len(input.TagIDs) > 0 {
		tagsParameter := arguments.add(input.TagIDs)
		countParameter := arguments.add(len(input.TagIDs))
		filters = append(filters, `i.id IN (
			SELECT item_id FROM item_tags WHERE tag_id = ANY(`+tagsParameter+`)
			GROUP BY item_id HAVING COUNT(DISTINCT tag_id) = `+countParameter+`
		)`)
	}
	if len(input.ContentKinds) > 0 {
		filters = append(filters, "EXISTS (SELECT 1 FROM raw_records filter_records WHERE filter_records.item_id = i.id AND filter_records.content_kind = ANY("+arguments.add(input.ContentKinds)+"))")
	}
	if len(input.Sensitivity) > 0 {
		filters = append(filters, "i.sensitivity = ANY("+arguments.add(input.Sensitivity)+")")
	}
	if input.From != nil {
		filters = append(filters, "item_times.effective_at >= "+arguments.add(*input.From))
	}
	if input.To != nil {
		filters = append(filters, "item_times.effective_at <= "+arguments.add(*input.To))
	}

	literal := "f.normalized_content LIKE " + literalParameter + " ESCAPE '\\'"
	token := "f.search_vector @@ plainto_tsquery('simple'::regconfig, " + queryParameter + ")"
	fuzzy := "similarity(f.normalized_content, " + queryParameter + ") >= " + thresholdParameter
	matchClass := `CASE
		WHEN f.source_kind = 'title' AND f.normalized_content = ` + queryParameter + ` THEN 5
		WHEN f.source_kind IN ('raw_text', 'code', 'filename') AND (` + literal + ` OR ` + token + `) THEN 4
		WHEN f.source_kind IN ('title', 'metadata') AND (` + literal + ` OR ` + token + `) THEN 3
		WHEN f.source_kind IN ('ai_text', 'image_text') THEN 1
		ELSE 2 END`
	similarityScore := `CASE WHEN (` + literal + ` OR ` + token + `) THEN 1.0::real
		ELSE similarity(f.normalized_content, ` + queryParameter + `) END`

	cte := `WITH item_times AS (
		SELECT item_id, MAX(effective_captured_at) AS effective_at
		FROM raw_records GROUP BY item_id
	), scored AS (
		SELECT i.id AS item_id, i.title, i.sensitivity, item_times.effective_at,
		       f.id AS fragment_id, f.source_kind, f.content,
		       ` + matchClass + ` AS match_class, ` + similarityScore + ` AS similarity
		FROM search_fragments f
		JOIN knowledge_items i ON i.id = f.item_id
		JOIN item_times ON item_times.item_id = i.id
		WHERE ` + strings.Join(filters, " AND ") + `
		  AND (` + literal + ` OR ` + token + ` OR ` + fuzzy + `)
	), ranked AS (
		SELECT scored.*, ROW_NUMBER() OVER (
			PARTITION BY item_id ORDER BY match_class DESC, similarity DESC, fragment_id DESC
		) AS item_rank
		FROM scored
	), best AS (
		SELECT * FROM ranked WHERE item_rank = 1
	)`

	var total int64
	if input.Cursor == nil {
		if err := service.database.QueryRow(request.Context(), cte+` SELECT COUNT(*) FROM best`, arguments.values...).Scan(&total); err != nil {
			return nil, 0, nil, err
		}
	}

	cursorFilter := ""
	order := "match_class DESC, similarity DESC, effective_at DESC, item_id DESC"
	if input.Sort == "recency" {
		order = "effective_at DESC, item_id DESC"
	}
	if input.Cursor != nil {
		if input.Sort == "relevance" {
			cursorFilter = ` WHERE (match_class, similarity, effective_at, item_id) < (` +
				arguments.add(input.Cursor.MatchClass) + `, ` + arguments.add(float32(input.Cursor.Similarity)) + `, ` +
				arguments.add(input.Cursor.Effective) + `, ` + arguments.add(input.Cursor.ItemID) + `)`
		} else {
			cursorFilter = ` WHERE (effective_at, item_id) < (` + arguments.add(input.Cursor.Effective) + `, ` + arguments.add(input.Cursor.ItemID) + `)`
		}
	}
	limitParameter := arguments.add(input.Limit + 1)
	rows, err := service.database.Query(request.Context(), cte+`
		SELECT item_id, title, sensitivity, effective_at, fragment_id, source_kind,
		       content, match_class, similarity
		FROM best`+cursorFilter+` ORDER BY `+order+` LIMIT `+limitParameter, arguments.values...)
	if err != nil {
		return nil, 0, nil, err
	}
	defer rows.Close()
	results := make([]searchResult, 0, input.Limit+1)
	for rows.Next() {
		var result searchResult
		var content string
		if err := rows.Scan(&result.ItemID, &result.Title, &result.Sensitivity, &result.EffectiveCapturedAt,
			&result.MatchedFragmentID, &result.MatchedSource, &content, &result.matchClass, &result.similarity); err != nil {
			return nil, 0, nil, err
		}
		if result.Sensitivity == "normal" {
			result.SnippetParts = highlightedParts(content, input.Query)
		} else {
			result.SnippetParts = []snippetPart{{Text: "敏感内容已遮挡；打开记录后可按需揭示。"}}
		}
		results = append(results, result)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, nil, err
	}
	var nextCursor *string
	if len(results) > input.Limit {
		last := results[input.Limit-1]
		encoded, err := encodeSearchCursor(searchCursor{
			Sort: input.Sort, MatchClass: last.matchClass, Similarity: last.similarity,
			Effective: last.EffectiveCapturedAt, ItemID: last.ItemID,
		})
		if err != nil {
			return nil, 0, nil, err
		}
		nextCursor = &encoded
		results = results[:input.Limit]
	}
	return results, total, nextCursor, nil
}

func escapeLike(value string) string {
	return strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(value)
}

func highlightedParts(content, query string) []snippetPart {
	contentRunes := []rune(content)
	terms := []string{strings.TrimSpace(query)}
	if fields := strings.Fields(query); len(fields) > 1 {
		terms = append(terms, fields...)
	}
	for _, term := range terms {
		termRunes := []rune(term)
		if len(termRunes) == 0 || len(termRunes) > len(contentRunes) {
			continue
		}
		for start := 0; start+len(termRunes) <= len(contentRunes); start++ {
			end := start + len(termRunes)
			if !strings.EqualFold(string(contentRunes[start:end]), term) {
				continue
			}
			parts := make([]snippetPart, 0, 3)
			if start > 0 {
				parts = append(parts, snippetPart{Text: string(contentRunes[:start])})
			}
			parts = append(parts, snippetPart{Text: string(contentRunes[start:end]), Highlighted: true})
			if end < len(contentRunes) {
				parts = append(parts, snippetPart{Text: string(contentRunes[end:])})
			}
			return parts
		}
	}
	return []snippetPart{{Text: content}}
}

func encodeSearchCursor(cursor searchCursor) (string, error) {
	encoded, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func decodeSearchCursor(value, sort string) (searchCursor, error) {
	encoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(encoded) > 1024 {
		return searchCursor{}, errInvalidInput
	}
	var cursor searchCursor
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cursor); err != nil {
		return searchCursor{}, err
	}
	if cursor.Sort != sort || cursor.ItemID == uuid.Nil || cursor.Effective.IsZero() ||
		(sort == "relevance" && (cursor.MatchClass < 1 || cursor.MatchClass > 5 || cursor.Similarity < 0 || cursor.Similarity > 1)) {
		return searchCursor{}, errInvalidInput
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return searchCursor{}, errInvalidInput
	}
	return cursor, nil
}

func writeSearchValidationError(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "搜索条件无效")
}

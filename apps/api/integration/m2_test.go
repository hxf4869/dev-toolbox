//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/knowledge"
)

type m2SearchResponse struct {
	Sort  string `json:"sort"`
	Total int    `json:"total"`
	Items []struct {
		ItemID        uuid.UUID `json:"itemId"`
		Title         string    `json:"title"`
		MatchedSource string    `json:"matchedSource"`
		Sensitivity   string    `json:"sensitivity"`
		SnippetParts  []struct {
			Text        string `json:"text"`
			Highlighted bool   `json:"highlighted"`
		} `json:"snippetParts"`
	} `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

func TestM2LibrarySearchSupplementsAndLifecycle(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	assertTestDatabase(t, databaseURL)
	ctx := context.Background()
	databaseConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	// A single connection exposes handlers that accidentally issue nested
	// queries before closing their parent result set.
	databaseConfig.MaxConns = 1
	database, err := pgxpool.NewWithConfig(ctx, databaseConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	resetM2Database(t, database)
	defer resetM2Database(t, database)

	attachmentRoot := t.TempDir()
	server, client, csrf := newAuthenticatedM2Server(t, database, attachmentRoot)
	defer server.Close()

	rootFolder := createFolder(t, client, server.URL, csrf, "运维", nil)
	childFolder := createFolder(t, client, server.URL, csrf, "Linux", &rootFolder)
	tagID := createTag(t, client, server.URL, csrf, "磁盘")

	itemA := createM2Item(t, client, server.URL, csrf, "m2-create-a-0001", map[string]any{
		"body": "Docker\nalpha-only-8421\nlsblk\nmount /dev/sdb1\n", "contentFormat": "plain_text",
		"sensitivity": "normal", "folderId": childFolder.String(), "tagIds": []string{tagID.String()},
	})
	itemB := createM2Item(t, client, server.URL, csrf, "m2-create-b-0001", map[string]any{
		"body": "正文中提到 Docker 与挂载命令", "contentFormat": "plain_text",
		"sensitivity": "normal", "folderId": nil, "tagIds": []string{}, "title": "其他记录",
	})
	itemSpecial := createM2Item(t, client, server.URL, csrf, "m2-create-special-0001", map[string]any{
		"body": `percent-marker % underscore_marker path C:\ops "quoted-value" -minus-value`, "contentFormat": "plain_text",
		"sensitivity": "normal", "folderId": nil, "tagIds": []string{},
	})

	ranking := searchM2(t, client, server.URL, csrf, map[string]any{"q": "Docker", "sort": "relevance", "limit": 30})
	if ranking.Total < 2 || len(ranking.Items) < 2 || ranking.Items[0].ItemID != itemA.Item.ID || ranking.Items[1].ItemID != itemB.Item.ID {
		t.Fatalf("title-exact ranking is unstable: %+v", ranking.Items)
	}
	for _, literal := range []string{"%", "_", `\`} {
		result := searchM2(t, client, server.URL, csrf, map[string]any{"q": literal, "sort": "relevance", "limit": 30})
		if result.Total != 1 {
			t.Fatalf("literal query %q matched %d records", literal, result.Total)
		}
	}
	pathResult := searchM2(t, client, server.URL, csrf, map[string]any{"q": "/dev/sdb1", "sort": "relevance", "limit": 30})
	if pathResult.Total != 1 || pathResult.Items[0].ItemID != itemA.Item.ID {
		t.Fatalf("path literal did not find item A: %+v", pathResult)
	}
	for query, expected := range map[string]uuid.UUID{
		"lsblk": itemA.Item.ID, "mount": itemA.Item.ID, "挂载": itemB.Item.ID,
	} {
		result := searchM2(t, client, server.URL, csrf, map[string]any{"q": query, "sort": "relevance", "limit": 30})
		if result.Total < 1 || result.Items[0].ItemID != expected {
			t.Fatalf("sample query %q did not rank the expected item first: %+v", query, result.Items)
		}
	}
	recency := searchM2(t, client, server.URL, csrf, map[string]any{"q": "Docker", "sort": "recency", "limit": 30})
	if len(recency.Items) < 2 || recency.Items[0].ItemID != itemB.Item.ID || recency.Items[1].ItemID != itemA.Item.ID {
		t.Fatalf("effective-time sorting is unstable: %+v", recency.Items)
	}
	for _, literal := range []string{`"quoted-value"`, `-minus-value`} {
		result := searchM2(t, client, server.URL, csrf, map[string]any{"q": literal, "sort": "relevance", "limit": 30})
		if result.Total < 1 || result.Items[0].ItemID != itemSpecial.Item.ID {
			t.Fatalf("punctuated literal %q was interpreted as query syntax: %+v", literal, result.Items)
		}
	}

	rankToken := "rank-token"
	titleExact := createM2Item(t, client, server.URL, csrf, "m2-rank-title-0001", map[string]any{
		"body": "精确层级正文", "contentFormat": "plain_text", "sensitivity": "normal",
		"folderId": nil, "tagIds": []string{}, "title": rankToken,
	})
	factLiteral := createM2Item(t, client, server.URL, csrf, "m2-rank-fact-0001", map[string]any{
		"body": rankToken, "contentFormat": "plain_text", "sensitivity": "normal",
		"folderId": nil, "tagIds": []string{}, "title": "事实命中样例",
	})
	metadataLiteral := createM2Item(t, client, server.URL, csrf, "m2-rank-metadata-0001", map[string]any{
		"body": "元数据层级正文", "contentFormat": "plain_text", "sensitivity": "normal",
		"folderId": nil, "tagIds": []string{}, "title": "元数据命中样例",
	})
	assertStatus(t, sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/items/"+metadataLiteral.Item.ID.String(), map[string]any{
		"note": rankToken,
	}, csrf), http.StatusOK)
	fuzzy := createM2Item(t, client, server.URL, csrf, "m2-rank-fuzzy-0001", map[string]any{
		"body": "rank-tokne", "contentFormat": "plain_text", "sensitivity": "normal",
		"folderId": nil, "tagIds": []string{}, "title": "模糊命中样例",
	})
	aiDerived := createM2Item(t, client, server.URL, csrf, "m2-rank-ai-0001", map[string]any{
		"body": "派生层级正文", "contentFormat": "plain_text", "sensitivity": "normal",
		"folderId": nil, "tagIds": []string{}, "title": "AI 派生命中样例",
	})
	for _, itemID := range []uuid.UUID{factLiteral.Item.ID, aiDerived.Item.ID} {
		if _, err := database.Exec(ctx, `
			INSERT INTO search_fragments (
				id, item_id, source_kind, ordinal, content, normalized_content, weight, active, created_at
			) VALUES ($1, $2, 'ai_text', 0, $3, $3, 1, true, $4)
		`, uuid.New(), itemID, rankToken, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	rankResult := searchM2(t, client, server.URL, csrf, map[string]any{"q": rankToken, "sort": "relevance", "limit": 30})
	wantRank := []uuid.UUID{titleExact.Item.ID, factLiteral.Item.ID, metadataLiteral.Item.ID, fuzzy.Item.ID, aiDerived.Item.ID}
	if rankResult.Total != len(wantRank) || len(rankResult.Items) != len(wantRank) {
		t.Fatalf("unexpected match-class fixture result: %+v", rankResult)
	}
	for index, expected := range wantRank {
		if rankResult.Items[index].ItemID != expected {
			t.Fatalf("match-class order at %d = %s, want %s: %+v", index, rankResult.Items[index].ItemID, expected, rankResult.Items)
		}
	}
	if rankResult.Items[1].MatchedSource != "raw_text" {
		t.Fatalf("item best-fragment selection preferred a lower class: %+v", rankResult.Items[1])
	}

	folderList := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items?folderId="+childFolder.String(), nil, "", ""))
	assertStatus(t, folderList, http.StatusOK)
	if body := readResponse(t, folderList); !bytes.Contains(body, []byte(itemA.Item.ID.String())) || bytes.Contains(body, []byte(itemB.Item.ID.String())) {
		t.Fatalf("folder filter returned wrong items: %s", body)
	}
	inbox := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items?view=inbox", nil, "", ""))
	assertStatus(t, inbox, http.StatusOK)
	if body := readResponse(t, inbox); bytes.Contains(body, []byte(itemA.Item.ID.String())) || !bytes.Contains(body, []byte(itemB.Item.ID.String())) {
		t.Fatalf("inbox view ignored folder state: %s", body)
	}
	patched := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/items/"+itemA.Item.ID.String(), map[string]any{
		"note": "新服务器初始化", "favorite": true, "tagIds": []string{tagID.String()},
	}, csrf)
	assertStatus(t, patched, http.StatusOK)
	favorites := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items?view=favorites", nil, "", ""))
	assertStatus(t, favorites, http.StatusOK)
	if body := readResponse(t, favorites); !bytes.Contains(body, []byte(itemA.Item.ID.String())) {
		t.Fatalf("favorite view omitted item A: %s", body)
	}

	renameFolder := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/folders/"+childFolder.String(), map[string]any{"name": "生产运维"}, csrf)
	assertStatus(t, renameFolder, http.StatusOK)
	renameTag := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/tags/"+tagID.String(), map[string]any{"name": "块设备"}, csrf)
	assertStatus(t, renameTag, http.StatusOK)
	metadataSearch := searchM2(t, client, server.URL, csrf, map[string]any{"q": "生产运维", "sort": "relevance", "limit": 30})
	if metadataSearch.Total != 1 || metadataSearch.Items[0].ItemID != itemA.Item.ID || metadataSearch.Items[0].MatchedSource != "metadata" {
		t.Fatalf("folder metadata was not reindexed: %+v", metadataSearch)
	}
	cycle := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/folders/"+rootFolder.String()+"/move", map[string]any{"parentId": childFolder.String()}, csrf)
	assertStatus(t, cycle, http.StatusUnprocessableEntity)
	nonempty := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/folders/"+childFolder.String(), map[string]any{}, csrf)
	assertStatus(t, nonempty, http.StatusConflict)

	pngBytes := testPNG(t)
	imageSupplement := sendMultipart(t, client, server.URL+"/api/v1/items/"+itemA.Item.ID.String()+"/raw-records:multipart", csrf, "m2-supplement-image-0001", map[string]any{
		"body": "", "contentFormat": "plain_text", "sensitivity": "normal",
		"relation": map[string]any{"type": "supplements", "targetRawRecordId": itemA.RawRecord.ID.String()},
	}, "screen.png", "text/plain", pngBytes)
	assertStatus(t, imageSupplement, http.StatusCreated)
	imageResult := decodeResponse[apiResponse](t, imageSupplement)
	if len(imageResult.Attachments) != 1 || imageResult.Attachments[0].Kind != "image" || imageResult.Attachments[0].MediaType != "image/png" {
		t.Fatalf("server image detection failed: %+v", imageResult.Attachments)
	}
	imageAttachmentID := imageResult.Attachments[0].ID
	var imageKind string
	if err := database.QueryRow(ctx, "SELECT content_kind FROM raw_records WHERE id = $1", imageResult.RawRecord.ID).Scan(&imageKind); err != nil || imageKind != "image" {
		t.Fatalf("image-only content kind = %q, err = %v", imageKind, err)
	}

	thumbnail := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/attachments/"+imageAttachmentID.String()+"/thumbnail", nil, "", ""))
	assertStatus(t, thumbnail, http.StatusOK)
	assertNoStore(t, thumbnail)
	if thumbnail.Header.Get("Content-Type") != "image/png" || !strings.HasPrefix(thumbnail.Header.Get("Content-Disposition"), "inline") {
		t.Fatalf("unsafe thumbnail headers: %+v", thumbnail.Header)
	}
	firstThumbnail := readResponse(t, thumbnail)
	var originalStorageKey, derivativeStorageKey string
	if err := database.QueryRow(ctx, "SELECT storage_key FROM attachments WHERE id = $1", imageAttachmentID).Scan(&originalStorageKey); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx, "SELECT storage_key FROM attachment_derivatives WHERE attachment_id = $1", imageAttachmentID).Scan(&derivativeStorageKey); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(attachmentRoot, filepath.FromSlash(derivativeStorageKey))); err != nil {
		t.Fatal(err)
	}
	regenerated := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/attachments/"+imageAttachmentID.String()+"/thumbnail", nil, "", ""))
	assertStatus(t, regenerated, http.StatusOK)
	if regeneratedBytes := readResponse(t, regenerated); !bytes.Equal(regeneratedBytes, firstThumbnail) {
		t.Fatal("regenerated thumbnail bytes changed")
	}
	if err := os.Remove(filepath.Join(attachmentRoot, filepath.FromSlash(derivativeStorageKey))); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(ctx, "UPDATE attachments SET width = width + 1 WHERE id = $1", imageAttachmentID); err != nil {
		t.Fatal(err)
	}
	inconsistent := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/attachments/"+imageAttachmentID.String()+"/thumbnail", nil, "", ""))
	assertStatus(t, inconsistent, http.StatusConflict)
	if _, err := database.Exec(ctx, "UPDATE attachments SET width = width - 1 WHERE id = $1", imageAttachmentID); err != nil {
		t.Fatal(err)
	}
	recovered := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/attachments/"+imageAttachmentID.String()+"/thumbnail", nil, "", ""))
	assertStatus(t, recovered, http.StatusOK)
	_ = readResponse(t, recovered)
	original := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/attachments/"+imageAttachmentID.String()+"/content", nil, "", ""))
	assertStatus(t, original, http.StatusOK)
	if downloaded := readResponse(t, original); !bytes.Equal(downloaded, pngBytes) {
		t.Fatal("original image bytes changed")
	}

	fileOnly := sendMultipart(t, client, server.URL+"/api/v1/items/"+itemB.Item.ID.String()+"/raw-records:multipart", csrf, "m2-supplement-file-0001", map[string]any{
		"body": "", "contentFormat": "plain_text", "sensitivity": "normal",
	}, "report.html", "image/png", []byte("<html><script>alert(1)</script></html>"))
	assertStatus(t, fileOnly, http.StatusCreated)
	fileOnlyResult := decodeResponse[apiResponse](t, fileOnly)
	if len(fileOnlyResult.Attachments) != 1 || fileOnlyResult.Attachments[0].Kind != "file" || fileOnlyResult.Attachments[0].MediaType != "text/html; charset=utf-8" {
		t.Fatalf("server file detection failed: %+v", fileOnlyResult.Attachments)
	}
	var fileOnlyKind string
	if err := database.QueryRow(ctx, "SELECT content_kind FROM raw_records WHERE id = $1", fileOnlyResult.RawRecord.ID).Scan(&fileOnlyKind); err != nil || fileOnlyKind != "file" {
		t.Fatalf("file-only content kind = %q, err = %v", fileOnlyKind, err)
	}
	fileDownload := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+fileOnlyResult.Attachments[0].ContentURL, nil, "", ""))
	assertStatus(t, fileDownload, http.StatusOK)
	if !strings.HasPrefix(fileDownload.Header.Get("Content-Disposition"), "attachment") || fileDownload.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("unsafe HTML download headers: %+v", fileDownload.Header)
	}
	_ = readResponse(t, fileDownload)

	mixed := sendMultipart(t, client, server.URL+"/api/v1/items/"+itemB.Item.ID.String()+"/raw-records:multipart", csrf, "m2-supplement-mixed-0001", map[string]any{
		"body": "mixed supplement marker", "contentFormat": "plain_text", "sensitivity": "normal",
	}, "notes.bin", "application/octet-stream", []byte{0, 1, 2, 3})
	assertStatus(t, mixed, http.StatusCreated)
	mixedResult := decodeResponse[apiResponse](t, mixed)
	var mixedKind string
	if err := database.QueryRow(ctx, "SELECT content_kind FROM raw_records WHERE id = $1", mixedResult.RawRecord.ID).Scan(&mixedKind); err != nil || mixedKind != "mixed" {
		t.Fatalf("mixed content kind = %q, err = %v", mixedKind, err)
	}
	filenameSearch := searchM2(t, client, server.URL, csrf, map[string]any{"q": "report.html", "sort": "relevance", "limit": 30})
	if filenameSearch.Total != 1 || filenameSearch.Items[0].ItemID != itemB.Item.ID || filenameSearch.Items[0].MatchedSource != "filename" {
		t.Fatalf("filename search failed: %+v", filenameSearch)
	}
	filesView := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items?view=files", nil, "", ""))
	assertStatus(t, filesView, http.StatusOK)
	if body := readResponse(t, filesView); !bytes.Contains(body, []byte(itemB.Item.ID.String())) {
		t.Fatalf("files view omitted file-only item: %s", body)
	}
	imagesView := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items?view=images", nil, "", ""))
	assertStatus(t, imagesView, http.StatusOK)
	if body := readResponse(t, imagesView); !bytes.Contains(body, []byte(itemA.Item.ID.String())) {
		t.Fatalf("images view omitted image item: %s", body)
	}
	derivedField := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items/"+itemB.Item.ID.String()+"/raw-records", map[string]any{
		"body": "must reject", "contentFormat": "plain_text", "sensitivity": "normal", "contentKind": "text",
	}, csrf, "m2-derived-field-0001")
	assertStatus(t, derivedField, http.StatusUnprocessableEntity)

	sensitiveSupplement := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items/"+itemA.Item.ID.String()+"/raw-records", map[string]any{
		"body": "synthetic-secret-token", "contentFormat": "plain_text", "sensitivity": "sensitive",
		"relation": map[string]any{"type": "supersedes", "targetRawRecordId": itemA.RawRecord.ID.String()},
	}, csrf, "m2-supplement-sensitive-0001")
	assertStatus(t, sensitiveSupplement, http.StatusCreated)
	sensitiveResult := decodeResponse[apiResponse](t, sensitiveSupplement)
	if sensitiveResult.Item.Sensitivity != "sensitive" || !strings.HasPrefix(sensitiveResult.Item.Title, "敏感记录 ·") {
		t.Fatalf("supplement did not safely upgrade item: %+v", sensitiveResult.Item)
	}
	repeatedSupplement := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items/"+itemA.Item.ID.String()+"/raw-records", map[string]any{
		"body": "must not be stored", "contentFormat": "plain_text", "sensitivity": "normal",
	}, csrf, "m2-supplement-sensitive-0001")
	assertStatus(t, repeatedSupplement, http.StatusOK)
	if repeated := decodeResponse[apiResponse](t, repeatedSupplement); repeated.RawRecord.ID != sensitiveResult.RawRecord.ID {
		t.Fatal("supplement idempotency returned a new raw record")
	}
	normalSupplement := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items/"+itemA.Item.ID.String()+"/raw-records", map[string]any{
		"body": "normal follow-up", "contentFormat": "plain_text", "sensitivity": "normal",
	}, csrf, "m2-supplement-normal-0001")
	assertStatus(t, normalSupplement, http.StatusCreated)
	if normal := decodeResponse[apiResponse](t, normalSupplement); normal.Item.Sensitivity != "sensitive" {
		t.Fatal("normal supplement downgraded a sensitive item")
	}
	detail := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items/"+itemA.Item.ID.String(), nil, "", ""))
	assertStatus(t, detail, http.StatusOK)
	detailBody := readResponse(t, detail)
	for _, expected := range []string{"生产运维", imageResult.RawRecord.ID.String(), sensitiveResult.RawRecord.ID.String()} {
		if !bytes.Contains(detailBody, []byte(expected)) {
			t.Fatalf("item detail omitted %q: %s", expected, detailBody)
		}
	}
	sensitiveSearch := searchM2(t, client, server.URL, csrf, map[string]any{"q": "synthetic-secret-token", "sort": "relevance", "limit": 30})
	if sensitiveSearch.Total != 1 || len(sensitiveSearch.Items[0].SnippetParts) != 1 || strings.Contains(sensitiveSearch.Items[0].SnippetParts[0].Text, "synthetic") {
		t.Fatalf("sensitive search leaked source: %+v", sensitiveSearch)
	}
	filteredSensitive := searchM2(t, client, server.URL, csrf, map[string]any{
		"q": "synthetic-secret-token", "sort": "relevance", "limit": 30,
		"contentKinds": []string{"text"}, "sensitivity": []string{"sensitive"}, "folderId": childFolder.String(), "tagIds": []string{tagID.String()},
	})
	if filteredSensitive.Total != 1 || filteredSensitive.Items[0].ItemID != itemA.Item.ID {
		t.Fatalf("structured search filters excluded the matching item: %+v", filteredSensitive)
	}
	sensitiveView := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items?view=sensitive", nil, "", ""))
	assertStatus(t, sensitiveView, http.StatusOK)
	if body := readResponse(t, sensitiveView); !bytes.Contains(body, []byte(itemA.Item.ID.String())) {
		t.Fatalf("sensitive view omitted upgraded item: %s", body)
	}

	crossItem := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items/"+itemB.Item.ID.String()+"/raw-records", map[string]any{
		"body": "invalid cross relation", "contentFormat": "plain_text", "sensitivity": "normal",
		"relation": map[string]any{"type": "supplements", "targetRawRecordId": itemA.RawRecord.ID.String()},
	}, csrf, "m2-cross-invalid-0001")
	assertStatus(t, crossItem, http.StatusUnprocessableEntity)
	migrationDuplicate := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items/"+itemB.Item.ID.String()+"/raw-records", map[string]any{
		"body": "migration duplicate marker", "contentFormat": "plain_text", "sensitivity": "normal",
		"relation": map[string]any{"type": "migration_duplicate", "targetRawRecordId": itemA.RawRecord.ID.String()},
	}, csrf, "m2-cross-duplicate-0001")
	assertStatus(t, migrationDuplicate, http.StatusCreated)

	for index := 0; index < 11; index++ {
		createM2Item(t, client, server.URL, csrf, "m2-cursor-"+uuid.NewString(), map[string]any{
			"body": "cursor-fixture", "contentFormat": "plain_text", "sensitivity": "normal",
			"folderId": nil, "tagIds": []string{},
		})
	}
	firstPage := searchM2(t, client, server.URL, csrf, map[string]any{"q": "cursor-fixture", "sort": "relevance", "limit": 10})
	if firstPage.Total != 11 || len(firstPage.Items) != 10 || firstPage.NextCursor == nil {
		t.Fatalf("unexpected first cursor page: total=%d len=%d cursor=%v", firstPage.Total, len(firstPage.Items), firstPage.NextCursor)
	}
	secondPage := searchM2(t, client, server.URL, csrf, map[string]any{
		"q": "cursor-fixture", "sort": "relevance", "limit": 10, "cursor": *firstPage.NextCursor,
	})
	if len(secondPage.Items) != 1 || secondPage.NextCursor != nil {
		t.Fatalf("unexpected second cursor page: len=%d cursor=%v", len(secondPage.Items), secondPage.NextCursor)
	}
	seen := make(map[uuid.UUID]struct{})
	for _, entry := range append(firstPage.Items, secondPage.Items...) {
		if _, duplicate := seen[entry.ItemID]; duplicate {
			t.Fatalf("cursor repeated item %s", entry.ItemID)
		}
		seen[entry.ItemID] = struct{}{}
	}

	oldFragmentID := uuid.New()
	if _, err := database.Exec(ctx, `
		INSERT INTO search_fragments (
			id, item_id, raw_record_id, source_kind, ordinal, fragment_version,
			start_byte, end_byte, content, normalized_content, weight, active, created_at
		) VALUES ($1, $2, $3, 'raw_text', 999, 0, 0, 1, 'D', 'd', 3, true, $4)
	`, oldFragmentID, itemA.Item.ID, itemA.RawRecord.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	before := rawFragmentIDs(t, database, itemA.Item.ID)
	if _, err := knowledge.RebuildSearch(ctx, database, time.Now()); err != nil {
		t.Fatal(err)
	}
	afterFirst := rawFragmentIDs(t, database, itemA.Item.ID)
	if _, err := knowledge.RebuildSearch(ctx, database, time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	afterSecond := rawFragmentIDs(t, database, itemA.Item.ID)
	if !reflect.DeepEqual(afterFirst, afterSecond) || len(afterFirst) != len(before) {
		t.Fatalf("same-version rebuild changed fragment IDs: before=%v first=%v second=%v", before, afterFirst, afterSecond)
	}
	var oldActive bool
	if err := database.QueryRow(ctx, "SELECT active FROM search_fragments WHERE id = $1", oldFragmentID).Scan(&oldActive); err != nil || oldActive {
		t.Fatalf("historical fragment was deleted or left searchable: active=%v err=%v", oldActive, err)
	}

	trash := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/items/"+itemA.Item.ID.String(), map[string]any{}, csrf)
	assertStatus(t, trash, http.StatusNoContent)
	if result := searchM2(t, client, server.URL, csrf, map[string]any{"q": "alpha-only-8421", "sort": "relevance", "limit": 30}); result.Total != 0 {
		t.Fatal("trashed item remained searchable")
	}
	trashList := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items?view=trash", nil, "", ""))
	assertStatus(t, trashList, http.StatusOK)
	if body := readResponse(t, trashList); !bytes.Contains(body, []byte(itemA.Item.ID.String())) {
		t.Fatalf("trash view omitted item A: %s", body)
	}
	restore := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/items/"+itemA.Item.ID.String()+"/restore", map[string]any{}, csrf)
	assertStatus(t, restore, http.StatusNoContent)
	if result := searchM2(t, client, server.URL, csrf, map[string]any{"q": "alpha-only-8421", "sort": "relevance", "limit": 30}); result.Total != 1 {
		t.Fatal("restored item did not return to search")
	}
	badPurge := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/items/"+itemA.Item.ID.String()+"/purge", map[string]any{"confirmItemId": itemA.Item.ID.String()}, csrf)
	assertStatus(t, badPurge, http.StatusConflict)
	assertStatus(t, sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/items/"+itemA.Item.ID.String(), map[string]any{}, csrf), http.StatusNoContent)
	wrongConfirmation := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/items/"+itemA.Item.ID.String()+"/purge", map[string]any{"confirmItemId": itemB.Item.ID.String()}, csrf)
	assertStatus(t, wrongConfirmation, http.StatusUnprocessableEntity)
	purge := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/items/"+itemA.Item.ID.String()+"/purge", map[string]any{"confirmItemId": itemA.Item.ID.String()}, csrf)
	assertStatus(t, purge, http.StatusNoContent)
	var remaining int
	if err := database.QueryRow(ctx, "SELECT COUNT(*) FROM knowledge_items WHERE id = $1", itemA.Item.ID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("purged item remains: count=%d err=%v", remaining, err)
	}
	for _, key := range []string{originalStorageKey, derivativeStorageKey} {
		if _, err := os.Stat(filepath.Join(attachmentRoot, filepath.FromSlash(key))); !errorsIsNotExist(err) {
			t.Fatalf("purged storage key remains: %s, err=%v", key, err)
		}
	}
	assertStatus(t, sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/folders/"+childFolder.String(), map[string]any{}, csrf), http.StatusNoContent)
	assertStatus(t, sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/folders/"+rootFolder.String(), map[string]any{}, csrf), http.StatusNoContent)
	assertStatus(t, sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/tags/"+tagID.String(), map[string]any{}, csrf), http.StatusNoContent)
}

func newAuthenticatedM2Server(t *testing.T, database *pgxpool.Pool, attachmentRoot string) (*httptest.Server, *http.Client, string) {
	t.Helper()
	password := "M2 correct horse 电池 staple"
	if err := auth.InitializeOwner(context.Background(), database, "owner", password, time.Now()); err != nil {
		t.Fatal(err)
	}
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	server := newM1Server(t, database, attachmentRoot, location)
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := server.Client()
	client.Jar = jar
	login := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{"username": "owner", "password": password}, "")
	assertStatus(t, login, http.StatusAccepted)
	challengeID := decodeResponse[apiResponse](t, login).ChallengeID
	setup := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/setup", map[string]any{"challengeId": challengeID}, "")
	assertStatus(t, setup, http.StatusOK)
	provisioning := decodeResponse[apiResponse](t, setup)
	code, err := totp.GenerateCode(provisioning.ManualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	confirm := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/confirm", map[string]any{
		"challengeId": challengeID, "code": code, "trustDevice": false, "deviceName": "",
	}, "")
	assertStatus(t, confirm, http.StatusOK)
	return server, client, decodeResponse[apiResponse](t, confirm).CSRFToken
}

func createFolder(t *testing.T, client *http.Client, baseURL, csrf, name string, parentID *uuid.UUID) uuid.UUID {
	t.Helper()
	var parent any
	if parentID != nil {
		parent = parentID.String()
	}
	response := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/folders", map[string]any{"name": name, "parentId": parent}, csrf)
	assertStatus(t, response, http.StatusCreated)
	var payload struct {
		ID uuid.UUID `json:"id"`
	}
	decodeInto(t, readResponse(t, response), &payload)
	return payload.ID
}

func createTag(t *testing.T, client *http.Client, baseURL, csrf, name string) uuid.UUID {
	t.Helper()
	response := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/tags", map[string]any{"name": name}, csrf)
	assertStatus(t, response, http.StatusCreated)
	var payload struct {
		ID uuid.UUID `json:"id"`
	}
	decodeInto(t, readResponse(t, response), &payload)
	return payload.ID
}

func createM2Item(t *testing.T, client *http.Client, baseURL, csrf, key string, payload map[string]any) apiResponse {
	t.Helper()
	response := sendJSONWithKey(t, client, http.MethodPost, baseURL+"/api/v1/items", payload, csrf, key)
	assertStatus(t, response, http.StatusCreated)
	return decodeResponse[apiResponse](t, response)
}

func searchM2(t *testing.T, client *http.Client, baseURL, csrf string, payload map[string]any) m2SearchResponse {
	t.Helper()
	response := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/search", payload, csrf)
	assertStatus(t, response, http.StatusOK)
	assertNoStore(t, response)
	return decodeResponse[m2SearchResponse](t, response)
}

func testPNG(t *testing.T) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, 800, 400))
	for y := 0; y < 400; y++ {
		for x := 0; x < 800; x++ {
			canvas.SetRGBA(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 96, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

func rawFragmentIDs(t *testing.T, database *pgxpool.Pool, itemID uuid.UUID) []uuid.UUID {
	t.Helper()
	rows, err := database.Query(context.Background(), `
		SELECT id FROM search_fragments
		WHERE item_id = $1 AND source_kind IN ('raw_text', 'code')
		ORDER BY id
	`, itemID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		result = append(result, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func resetM2Database(t *testing.T, database *pgxpool.Pool) {
	t.Helper()
	_, err := database.Exec(context.Background(), `
		TRUNCATE TABLE attachment_derivatives, raw_record_relations, item_tags, tags, folders,
		idempotency_records, search_fragments, attachments, raw_records, knowledge_items,
		auth_sessions, trusted_devices, mfa_recovery_codes, auth_challenges,
		security_events, owner_account CASCADE
	`)
	if err != nil {
		t.Fatal(err)
	}
}

func errorsIsNotExist(err error) bool {
	return err != nil && os.IsNotExist(err)
}

//go:build integration

package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

// UX-09: contract checks for the knowledge save API as used by the Agent
// Console "save snippet" flow. All fixture data uses the ux09-test- prefix and
// lives only in the isolated integration database.

type ux09ItemSummary struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Sensitivity string `json:"sensitivity"`
}

type ux09CreateResult struct {
	Item      ux09ItemSummary `json:"item"`
	RawRecord struct {
		ID       string `json:"id"`
		ReadOnly bool   `json:"readOnly"`
	} `json:"rawRecord"`
}

type ux09OrganizationEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func ux09Decode[T any](t *testing.T, response *http.Response) T {
	t.Helper()
	defer response.Body.Close()
	var decoded T
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func ux09Search(t *testing.T, h *v3Harness, query string) map[string]any {
	t.Helper()
	response := h.post(t, "/api/v1/search", map[string]any{"q": query, "limit": 10})
	assertStatus(t, response, http.StatusOK)
	defer response.Body.Close()
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func ux09PostItem(t *testing.T, h *v3Harness, payload map[string]any, idempotencyKey string) *http.Response {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, h.server.URL+"/api/v1/items", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", h.csrf)
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	response, err := h.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

// Session (cookie) save path: create -> searchable -> readable, plus the
// documented idempotency and duplicate behaviour.
func TestUX09ConsoleSaveSessionCreateSearchRead(t *testing.T) {
	h := newV3Harness(t)

	folderResponse := h.post(t, "/api/v1/folders", map[string]any{"name": "ux09-test-dir", "parentId": nil})
	assertStatus(t, folderResponse, http.StatusCreated)
	folder := ux09Decode[ux09OrganizationEntry](t, folderResponse)
	tagResponse := h.post(t, "/api/v1/tags", map[string]any{"name": "ux09-test-tag"})
	assertStatus(t, tagResponse, http.StatusCreated)
	tag := ux09Decode[ux09OrganizationEntry](t, tagResponse)

	createPayload := map[string]any{
		"title":         "ux09-test session save snippet",
		"body":          "kubectl rollout undo deployment/api --to-revision=3",
		"contentFormat": "plain_text",
		"sensitivity":   "normal",
		"folderId":      folder.ID,
		"tagIds":        []string{tag.ID},
	}
	created := ux09PostItem(t, h, createPayload, "ux09-test-idempotency-key-01")
	assertStatus(t, created, http.StatusCreated)
	createResult := ux09Decode[ux09CreateResult](t, created)
	if createResult.Item.ID == "" || createResult.RawRecord.ID == "" {
		t.Fatal("create response missing item or rawRecord id")
	}

	// Retry with the same Idempotency-Key must return the same item, not a copy.
	replayed := ux09PostItem(t, h, createPayload, "ux09-test-idempotency-key-01")
	assertStatus(t, replayed, http.StatusOK)
	replayResult := ux09Decode[ux09CreateResult](t, replayed)
	if replayResult.Item.ID != createResult.Item.ID {
		t.Fatalf("idempotent replay created a new item %s instead of returning %s", replayResult.Item.ID, createResult.Item.ID)
	}

	// A plain duplicate without idempotency or source identity is stored as a
	// new item; the save API performs no content-level deduplication.
	duplicate := ux09PostItem(t, h, createPayload, "")
	assertStatus(t, duplicate, http.StatusCreated)
	duplicateResult := ux09Decode[ux09CreateResult](t, duplicate)
	if duplicateResult.Item.ID == createResult.Item.ID {
		t.Fatal("duplicate session save unexpectedly returned the original item")
	}

	// Both copies are searchable; relevance order between identical titles is
	// not part of the contract, only membership is.
	results := ux09Search(t, h, "ux09-test session save snippet")
	items, _ := results["items"].([]any)
	foundOriginal, foundDuplicate := false, false
	for _, entry := range items {
		item, _ := entry.(map[string]any)
		switch item["itemId"] {
		case createResult.Item.ID:
			foundOriginal = true
		case duplicateResult.Item.ID:
			foundDuplicate = true
		}
	}
	if !foundOriginal || !foundDuplicate {
		t.Fatalf("search results missing created items (original=%v duplicate=%v)", foundOriginal, foundDuplicate)
	}
}

func TestUX09ConsoleSaveSessionReadback(t *testing.T) {
	h := newV3Harness(t)

	folderResponse := h.post(t, "/api/v1/folders", map[string]any{"name": "ux09-test-dir-read", "parentId": nil})
	assertStatus(t, folderResponse, http.StatusCreated)
	folder := ux09Decode[ux09OrganizationEntry](t, folderResponse)
	tagResponse := h.post(t, "/api/v1/tags", map[string]any{"name": "ux09-test-tag-read"})
	assertStatus(t, tagResponse, http.StatusCreated)
	tag := ux09Decode[ux09OrganizationEntry](t, tagResponse)

	created := ux09PostItem(t, h, map[string]any{
		"title":         "ux09-test readback snippet",
		"body":          "docker system prune -af --volumes",
		"contentFormat": "markdown",
		"sensitivity":   "normal",
		"folderId":      folder.ID,
		"tagIds":        []string{tag.ID},
	}, "")
	assertStatus(t, created, http.StatusCreated)
	createResult := ux09Decode[ux09CreateResult](t, created)

	payload := ux09Search(t, h, "ux09-test readback snippet")
	if payload["total"].(float64) < 1 {
		t.Fatal("saved snippet is not searchable")
	}
	items := payload["items"].([]any)
	first, _ := items[0].(map[string]any)
	if first["itemId"] != createResult.Item.ID {
		t.Fatalf("search hit %v does not match created item %s", first["itemId"], createResult.Item.ID)
	}
	if first["contentKind"] != "text" {
		t.Fatalf("search contentKind = %v, want text", first["contentKind"])
	}

	detailResponse := h.get(t, "/api/v1/items/"+createResult.Item.ID)
	assertStatus(t, detailResponse, http.StatusOK)
	var detail struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		Sensitivity string `json:"sensitivity"`
		Folder      *struct {
			ID string `json:"id"`
		} `json:"folder"`
		Tags []struct {
			ID string `json:"id"`
		} `json:"tags"`
		RawRecords []struct {
			ID         string `json:"id"`
			SourceType string `json:"sourceType"`
		} `json:"rawRecords"`
	}
	if err := json.NewDecoder(detailResponse.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	detailResponse.Body.Close()
	if detail.ID != createResult.Item.ID || detail.Title != "ux09-test readback snippet" || detail.Sensitivity != "normal" {
		t.Fatalf("item detail mismatch: %+v", detail)
	}
	if detail.Folder == nil || detail.Folder.ID != folder.ID {
		t.Fatalf("folder not attached: %+v", detail.Folder)
	}
	if len(detail.Tags) != 1 || detail.Tags[0].ID != tag.ID {
		t.Fatalf("tags not attached: %+v", detail.Tags)
	}
	if len(detail.RawRecords) != 1 {
		t.Fatalf("expected one primary raw record, got %d", len(detail.RawRecords))
	}

	rawResponse := h.get(t, "/api/v1/items/"+createResult.Item.ID+"/raw-records/"+detail.RawRecords[0].ID)
	assertStatus(t, rawResponse, http.StatusOK)
	var raw struct {
		Body     string `json:"body"`
		ReadOnly bool   `json:"readOnly"`
		Source   struct {
			SourceType string         `json:"sourceType"`
			Metadata   map[string]any `json:"metadata"`
		} `json:"source"`
	}
	if err := json.NewDecoder(rawResponse.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	rawResponse.Body.Close()
	if raw.Body != "docker system prune -af --volumes" || !raw.ReadOnly {
		t.Fatalf("raw readback mismatch: body=%q readOnly=%v", raw.Body, raw.ReadOnly)
	}
	// Session saves without an explicit source default to web_capture.
	if raw.Source.SourceType != "web_capture" {
		t.Fatalf("default session sourceType = %q, want web_capture", raw.Source.SourceType)
	}
}

func TestUX09ConsoleSaveSourceProvenance(t *testing.T) {
	h := newV3Harness(t)

	// Browser sessions may not declare a source object; provenance for Console
	// saves therefore requires a PAT (or the default web_capture). timeQuality
	// is optional only when the whole source object is omitted.
	sessionWithSource := ux09PostItem(t, h, map[string]any{
		"body":          "ux09-test session must not declare source",
		"contentFormat": "plain_text",
		"sensitivity":   "normal",
		"source": map[string]any{
			"sourceType":  "api",
			"externalId":  "ux09test:session-fragment",
			"timeQuality": "unknown",
		},
	}, "")
	assertStatus(t, sessionWithSource, http.StatusUnprocessableEntity)
	sessionWithSource.Body.Close()

	tokenResponse := h.post(t, "/api/v1/tokens", map[string]any{
		"name":   "ux09-test console token",
		"scopes": []string{"records:read", "records:write"},
	})
	assertStatus(t, tokenResponse, http.StatusCreated)
	token := ux09Decode[struct {
		Token string `json:"token"`
	}](t, tokenResponse)

	patClient := *h.client
	patClient.Jar = nil
	ux09PostWithPAT := func(payload map[string]any) *http.Response {
		t.Helper()
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequest(http.MethodPost, h.server.URL+"/api/v1/items", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token.Token)
		response, err := patClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}

	savePayload := map[string]any{
		"title":         "ux09-test provenance snippet",
		"body":          "git bisect start bad-commit good-commit",
		"contentFormat": "plain_text",
		"sensitivity":   "normal",
		"source": map[string]any{
			"sourceType":  "api",
			"externalId":  "ux09test:fragment-001",
			"timeQuality": "unknown",
			"metadata":    map[string]any{"sourceApplication": "agent-console"},
		},
	}
	first := ux09PostWithPAT(savePayload)
	assertStatus(t, first, http.StatusCreated)
	firstResult := ux09Decode[ux09CreateResult](t, first)

	// Re-saving the same console fragment identity returns the original item
	// (server-side dedup via source_external_id).
	second := ux09PostWithPAT(savePayload)
	assertStatus(t, second, http.StatusCreated)
	secondResult := ux09Decode[ux09CreateResult](t, second)
	if secondResult.Item.ID != firstResult.Item.ID {
		t.Fatalf("source replay created new item %s instead of returning %s", secondResult.Item.ID, firstResult.Item.ID)
	}

	// The saved snippet is retrievable through the ordinary browser-session
	// search path, so Console saves integrate with the normal library.
	searchPayload := ux09Search(t, h, "ux09-test provenance snippet")
	items := searchPayload["items"].([]any)
	found := false
	for _, entry := range items {
		item, _ := entry.(map[string]any)
		if item["itemId"] == firstResult.Item.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("PAT-saved snippet is not searchable from the browser session")
	}

	// Provenance survives the round trip on the read-only raw-record endpoint.
	rawResponse := patGet(t, &patClient, h.server.URL+"/api/v1/items/"+firstResult.Item.ID+"/raw-records/"+firstResult.RawRecord.ID, token.Token)
	assertStatus(t, rawResponse, http.StatusOK)
	var raw struct {
		ReadOnly bool `json:"readOnly"`
		Source   struct {
			SourceType string         `json:"sourceType"`
			ExternalID *string        `json:"externalId"`
			Metadata   map[string]any `json:"metadata"`
		} `json:"source"`
	}
	if err := json.NewDecoder(rawResponse.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	rawResponse.Body.Close()
	if raw.Source.SourceType != "api" {
		t.Fatalf("sourceType = %q, want api", raw.Source.SourceType)
	}
	if raw.Source.ExternalID == nil || *raw.Source.ExternalID != "ux09test:fragment-001" {
		t.Fatalf("externalId = %v, want ux09test:fragment-001", raw.Source.ExternalID)
	}
	if raw.Source.Metadata["sourceApplication"] != "agent-console" {
		t.Fatalf("source metadata = %v, want sourceApplication agent-console", raw.Source.Metadata)
	}
}

func patGet(t *testing.T, client *http.Client, url, token string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestM3V2JSONAINarrowSynchronousPath(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	assertTestDatabase(t, databaseURL)
	database, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	resetM3Database(t, database)
	defer resetM3Database(t, database)

	var mu sync.Mutex
	workerCalls := 0
	var workerBody []byte
	var workerPath, workerAuthorization string
	worker := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(request.Body, 321*1024))
		mu.Lock()
		workerCalls++
		workerBody = append([]byte(nil), body...)
		workerPath = request.URL.Path
		workerAuthorization = request.Header.Get("Authorization")
		mu.Unlock()
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"code":"export interface Root { id: number }","promptVersion":"json-type-generation-v1","usage":{"inputTokens":42,"outputTokens":9}}`))
	}))
	defer worker.Close()

	server, client, csrf := newAuthenticatedM3Server(t, database, t.TempDir(), worker.URL)
	defer server.Close()
	providerResponse := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers", map[string]any{
		"providerKey": "json-ai-provider", "displayName": "JSON AI fixture",
		"protocol": "openai-responses", "baseUrl": "https://provider.example.test/v1",
		"apiKey": m3ProviderKey,
		"models": []map[string]any{{
			"modelId": "json-model", "displayName": "JSON Model",
			"contextWindow": 32768, "maxOutputTokens": 8192,
			"supportsTools": false, "supportsVision": false,
		}},
	}, csrf)
	assertStatus(t, providerResponse, http.StatusCreated)
	provider := decodeResponse[m3ProviderResponse](t, providerResponse)
	if len(provider.Models) != 1 {
		t.Fatalf("provider model missing: %+v", provider)
	}

	requestPayload := map[string]any{
		"providerId": provider.ID.String(), "modelId": provider.Models[0].ID.String(),
		"targetLanguage": "TypeScript", "mode": "structure",
		"input": map[string]any{"kind": "object", "properties": map[string]any{"id": map[string]any{"kind": "integer"}}},
	}
	csrfDenied := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/tools/json/type-generation/ai", requestPayload, "invalid-csrf")
	assertStatus(t, csrfDenied, http.StatusForbidden)
	if body := readResponse(t, csrfDenied); !bytes.Contains(body, []byte("MUTATION_NOT_ALLOWED")) {
		t.Fatalf("JSON AI CSRF denial did not use the stable error code: %s", body)
	}
	pat := createM3Token(t, client, server.URL, csrf, "JSON AI forbidden PAT", []string{"tasks:run"})
	patClient := &http.Client{Transport: client.Transport}
	patDenied := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/tools/json/type-generation/ai", requestPayload, pat.Token, "")
	assertStatus(t, patDenied, http.StatusForbidden)
	if body := readResponse(t, patDenied); !bytes.Contains(body, []byte("MUTATION_NOT_ALLOWED")) {
		t.Fatalf("JSON AI PAT denial did not use the stable error code: %s", body)
	}
	mu.Lock()
	if workerCalls != 0 {
		t.Fatalf("denied JSON AI request reached worker: %d", workerCalls)
	}
	mu.Unlock()
	oversizedPayload := map[string]any{
		"providerId": provider.ID.String(), "modelId": provider.Models[0].ID.String(),
		"targetLanguage": "TypeScript", "mode": "full",
		"input": map[string]any{"sample": strings.Repeat("x", 256*1024)},
	}
	oversized := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/tools/json/type-generation/ai", oversizedPayload, csrf)
	assertStatus(t, oversized, http.StatusBadRequest)
	if body := readResponse(t, oversized); !bytes.Contains(body, []byte("INVALID_INPUT")) {
		t.Fatalf("oversized JSON AI request did not use the stable error code: %s", body)
	}
	mu.Lock()
	if workerCalls != 0 {
		t.Fatalf("oversized JSON AI request reached worker: %d", workerCalls)
	}
	mu.Unlock()

	generated := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/tools/json/type-generation/ai", requestPayload, csrf)
	assertStatus(t, generated, http.StatusOK)
	generatedBody := readResponse(t, generated)
	if !bytes.Contains(generatedBody, []byte(`"language":"TypeScript"`)) ||
		!bytes.Contains(generatedBody, []byte(`"promptVersion":"json-type-generation-v1"`)) ||
		bytes.Contains(generatedBody, []byte(m3ProviderKey)) {
		t.Fatalf("unexpected public JSON AI response: %s", generatedBody)
	}

	mu.Lock()
	calls, body, path, authorization := workerCalls, append([]byte(nil), workerBody...), workerPath, workerAuthorization
	mu.Unlock()
	if calls != 1 || path != "/internal/v2/json-type-generation" || authorization != "Bearer "+m3InternalToken {
		t.Fatalf("unexpected worker call: calls=%d path=%q authorization=%q", calls, path, authorization)
	}
	if !bytes.Contains(body, []byte(m3ProviderKey)) || !bytes.Contains(body, []byte(`"mode":"structure"`)) ||
		bytes.Contains(body, []byte(`"supportsTools"`)) || bytes.Contains(body, []byte(`"taskId"`)) {
		t.Fatalf("worker received the wrong narrow snapshot: %s", body)
	}
	var internal struct {
		DeadlineAt string `json:"deadlineAt"`
	}
	if err := json.Unmarshal(body, &internal); err != nil || internal.DeadlineAt == "" {
		t.Fatalf("worker payload deadline missing: %v %s", err, body)
	}

	missingModel := requestPayload
	missingModel["modelId"] = uuid.NewString()
	unavailable := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/tools/json/type-generation/ai", missingModel, csrf)
	assertStatus(t, unavailable, http.StatusUnprocessableEntity)
	if body := readResponse(t, unavailable); !bytes.Contains(body, []byte("AI_MODEL_UNAVAILABLE")) {
		t.Fatalf("unavailable model error was not stable: %s", body)
	}
	mu.Lock()
	if workerCalls != 1 {
		t.Fatalf("unavailable model reached worker: %d", workerCalls)
	}
	mu.Unlock()

	var taskCount, artifactCount int
	if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_task_runs").Scan(&taskCount); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_artifacts").Scan(&artifactCount); err != nil {
		t.Fatal(err)
	}
	if taskCount != 0 || artifactCount != 0 {
		t.Fatalf("JSON AI created task/artifact rows: tasks=%d artifacts=%d", taskCount, artifactCount)
	}
}

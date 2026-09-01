//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/ai"
	artifactcontract "github.com/hxf4869/dev-toolbox/apps/api/internal/ai/schema"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/assistant"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/knowledge"
)

const v3InternalToken = "v3-synthetic-internal-service-token"

type v3Harness struct {
	server    *httptest.Server
	client    *http.Client
	csrf      string
	database  *pgxpool.Pool
	assistant *assistant.Service
}

func newV3Harness(t *testing.T) *v3Harness {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	assertTestDatabase(t, databaseURL)
	ctx := context.Background()
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	database, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	resetV3Database(t, database)

	password := "V3 correct horse 电池 staple"
	if err := auth.InitializeOwner(ctx, database, "owner", password, time.Now()); err != nil {
		t.Fatal(err)
	}
	authService, err := auth.NewService(database, bytes.Repeat([]byte{9}, 32), testOrigin, "127.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	knowledgeService, err := knowledge.NewService(database, t.TempDir(), location)
	if err != nil {
		t.Fatal(err)
	}
	_, currentFile, _, _ := runtime.Caller(0)
	schemaBytes, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "../../../docs/contracts/ai-artifact.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	validator, err := artifactcontract.New(schemaBytes)
	if err != nil {
		t.Fatal(err)
	}
	masterKey := bytes.Repeat([]byte{7}, 32)
	aiService := ai.NewService(database, masterKey, validator, "http://worker.invalid", v3InternalToken, t.TempDir(), false)
	assistantService := assistant.NewService(database, masterKey, "http://worker.invalid", v3InternalToken, false)
	router := http.NewServeMux()
	authService.RegisterRoutes(router)
	knowledgeService.RegisterRoutes(router, authService)
	aiService.RegisterRoutes(router, authService)
	assistantService.RegisterRoutes(router, authService)

	server := httptest.NewTLSServer(router)
	t.Cleanup(server.Close)
	client := server.Client()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
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
	csrf := decodeResponse[apiResponse](t, confirm).CSRFToken
	return &v3Harness{server: server, client: client, csrf: csrf, database: database, assistant: assistantService}
}

func resetV3Database(t *testing.T, database *pgxpool.Pool) {
	t.Helper()
	_, err := database.Exec(context.Background(), `
		TRUNCATE TABLE assistant_run_events, assistant_run_sources, assistant_runs,
		assistant_messages, assistant_conversation_summaries, assistant_conversations,
		assistant_folders, assistant_fragment_embeddings, assistant_embedding_config,
		assistant_model_preferences, provider_model_reasoning_options,
		artifact_sources, item_active_artifacts, ai_artifacts, ai_task_events,
		ai_task_runs, app_settings, provider_models, provider_configs, personal_access_tokens,
		attachment_derivatives, raw_record_relations, item_tags, tags, folders,
		idempotency_records, search_fragments, attachments, raw_records, knowledge_items,
		auth_sessions, trusted_devices, mfa_recovery_codes, auth_challenges,
		security_events, owner_account CASCADE;
		INSERT INTO app_settings (singleton, updated_at) VALUES (true, now());
		INSERT INTO assistant_embedding_config (singleton, updated_at) VALUES (true, now());
	`)
	if err != nil {
		t.Fatal(err)
	}
}

func (h *v3Harness) do(t *testing.T, method, path string, payload any, internal bool) *http.Response {
	t.Helper()
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, h.server.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", testOrigin)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if internal {
		request.Header.Set("Authorization", "Bearer "+v3InternalToken)
	} else if h.csrf != "" && method != http.MethodGet {
		request.Header.Set("X-CSRF-Token", h.csrf)
	}
	response, err := h.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func (h *v3Harness) post(t *testing.T, path string, payload any) *http.Response {
	t.Helper()
	return h.do(t, http.MethodPost, path, payload, false)
}

func (h *v3Harness) put(t *testing.T, path string, payload any) *http.Response {
	t.Helper()
	return h.do(t, http.MethodPut, path, payload, false)
}

func (h *v3Harness) delete(t *testing.T, path string, payload any) *http.Response {
	t.Helper()
	return h.do(t, http.MethodDelete, path, payload, false)
}

func (h *v3Harness) get(t *testing.T, path string) *http.Response {
	t.Helper()
	return h.do(t, http.MethodGet, path, nil, false)
}

func (h *v3Harness) internalPost(t *testing.T, path string, payload any) *http.Response {
	t.Helper()
	return h.do(t, http.MethodPost, path, payload, true)
}

func (h *v3Harness) createProviderModel(t *testing.T, reasoningOptions []map[string]any) (uuid.UUID, uuid.UUID) {
	t.Helper()
	models := []map[string]any{{
		"modelId": "mock-chat-model", "displayName": "Mock Chat",
		"contextWindow": 32768, "maxOutputTokens": 4096,
		"supportsTools": false, "supportsVision": false,
		"reasoningOptions": reasoningOptions,
	}}
	response := h.post(t, "/api/v1/ai/providers", map[string]any{
		"providerKey": "v3-provider", "displayName": "V3 Provider",
		"protocol": "openai-completions", "baseUrl": "https://provider.example/v1",
		"apiKey": "v3-provider-secret", "models": models,
	})
	assertStatus(t, response, http.StatusCreated)
	var provider struct {
		ID     uuid.UUID `json:"id"`
		Models []struct {
			ID               uuid.UUID `json:"id"`
			ReasoningOptions []struct {
				Reasoning   string `json:"reasoning"`
				DisplayName string `json:"displayName"`
				SortOrder   int    `json:"sortOrder"`
			} `json:"reasoningOptions"`
		} `json:"models"`
	}
	if err := json.NewDecoder(response.Body).Decode(&provider); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if len(provider.Models) != 1 || len(provider.Models[0].ReasoningOptions) != len(reasoningOptions) {
		t.Fatal("reasoning options missing on create response")
	}
	return provider.ID, provider.Models[0].ID
}

func v3Error(t *testing.T, response *http.Response) (int, string) {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	return response.StatusCode, envelope.Error.Code
}

func seedV3Knowledge(t *testing.T, database *pgxpool.Pool, title, content, sensitivity string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	itemID := uuid.New()
	now := time.Now().UTC()
	if _, err := database.Exec(ctx, `
		INSERT INTO knowledge_items (id, title, title_origin, sensitivity, created_at, updated_at)
		VALUES ($1, $2, 'user', $3, $4, $4)
	`, itemID, title, sensitivity, now); err != nil {
		t.Fatal(err)
	}
	recordID := uuid.New()
	if _, err := database.Exec(ctx, `
		INSERT INTO raw_records (id, item_id, record_role, source_type, content_kind, content_format,
		       body, declared_sensitivity, captured_at, effective_captured_at, source_time_quality, created_at)
		VALUES ($1, $2, 'primary', 'api', 'text', 'plain_text', $3, $4, $5, $5, 'exact', $5)
	`, recordID, itemID, content, sensitivity, now); err != nil {
		t.Fatal(err)
	}
	normalized := strings.ToLower(strings.Join(strings.Fields(content), " "))
	if _, err := database.Exec(ctx, `
		INSERT INTO search_fragments (id, item_id, raw_record_id, source_kind, ordinal, fragment_version,
		       start_byte, end_byte, content, normalized_content, weight, active, created_at)
		VALUES ($1, $2, $3, 'raw_text', 0, 1, 0, $4, $5, $6, 3, true, $7)
	`, uuid.New(), itemID, recordID, len(content), content, normalized, now); err != nil {
		t.Fatal(err)
	}
	return itemID
}

func TestV3BootstrapAndReasoningOptions(t *testing.T) {
	h := newV3Harness(t)
	response := h.get(t, "/api/v1/assistant/bootstrap")
	assertStatus(t, response, http.StatusOK)
	var bootstrap struct {
		Models                   []map[string]any `json:"models"`
		NewConversationSelection struct {
			Required bool    `json:"required"`
			Reason   *string `json:"reason"`
		} `json:"newConversationSelection"`
	}
	if err := json.NewDecoder(response.Body).Decode(&bootstrap); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if len(bootstrap.Models) != 0 || !bootstrap.NewConversationSelection.Required ||
		bootstrap.NewConversationSelection.Reason == nil || *bootstrap.NewConversationSelection.Reason != "no_available_model" {
		t.Fatal("bootstrap first-use state wrong")
	}
	_, _ = h.createProviderModel(t, []map[string]any{
		{"displayName": "最高", "reasoning": "max", "sortOrder": 10},
		{"displayName": "标准", "reasoning": "medium", "sortOrder": 5},
	})
	response = h.get(t, "/api/v1/assistant/bootstrap")
	assertStatus(t, response, http.StatusOK)
	if err := json.NewDecoder(response.Body).Decode(&bootstrap); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if len(bootstrap.Models) != 1 {
		t.Fatal("available model missing from bootstrap")
	}
	options := bootstrap.Models[0]["reasoningOptions"].([]any)
	if len(options) != 3 {
		t.Fatalf("expected off + 2 configured options, got %d", len(options))
	}
	first := options[0].(map[string]any)
	if first["reasoning"] != "off" || first["displayName"] != "不思考" || first["sortOrder"] != float64(-1) {
		t.Fatal("off option missing or misplaced")
	}
	if bootstrap.NewConversationSelection.Reason == nil || *bootstrap.NewConversationSelection.Reason != "first_use" {
		t.Fatal("first_use expected after model creation without preferences")
	}
}

func TestV3EmbeddingSettingsLifecycle(t *testing.T) {
	h := newV3Harness(t)
	response := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "知识向量", "baseUrl": "https://embed.example/v1",
		"apiKey": nil, "modelId": "text-embedding-mock", "dimensions": 1536,
		"enabled": true, "confirmReindex": false,
	})
	if status, code := v3Error(t, response); status != http.StatusUnprocessableEntity || code != "VALIDATION_FAILED" {
		t.Fatalf("first-time null key: %d %s", status, code)
	}
	response = h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "知识向量", "baseUrl": "https://embed.example/v1",
		"apiKey": "embed-secret", "modelId": "text-embedding-mock", "dimensions": 1536,
		"enabled": true, "confirmReindex": false,
	})
	assertStatus(t, response, http.StatusOK)
	var settings struct {
		Configured bool   `json:"configured"`
		Status     string `json:"status"`
		Generation *int64 `json:"generation"`
	}
	if err := json.NewDecoder(response.Body).Decode(&settings); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if !settings.Configured || settings.Status != "indexing" || settings.Generation == nil || *settings.Generation != 1 {
		t.Fatalf("unexpected settings state: %+v", settings)
	}
	// Wire the policy hook exactly as the integrator does in main.go, then
	// change the global sensitive policy: the generation must bump.
	previousHook := ai.SensitivePolicyChangeHook
	ai.SensitivePolicyChangeHook = h.assistant.NotifySensitivePolicyChanged
	t.Cleanup(func() { ai.SensitivePolicyChangeHook = previousHook })
	policyResponse := h.put(t, "/api/v1/ai/settings", map[string]any{"sensitiveAiPolicy": "block"})
	assertStatus(t, policyResponse, http.StatusOK)
	response = h.get(t, "/api/v1/assistant/embedding-settings")
	assertStatus(t, response, http.StatusOK)
	if err := json.NewDecoder(response.Body).Decode(&settings); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if settings.Generation == nil || *settings.Generation != 2 {
		t.Fatalf("policy change did not bump generation: %+v", settings)
	}
}

func TestV3RunIdempotencyAndLifecycle(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{
		{"displayName": "高", "reasoning": "high", "sortOrder": 5},
	})
	seedV3Knowledge(t, h.database, "部署手册", "使用 docker compose up -d 部署服务", "normal")
	clientRequestID := uuid.New()
	payload := map[string]any{
		"clientRequestId": clientRequestID, "conversationId": nil, "folderId": nil,
		"content": "怎么部署服务？", "modelId": modelID, "reasoning": "high",
	}
	first := h.post(t, "/api/v1/assistant/runs", payload)
	assertStatus(t, first, http.StatusAccepted)
	var start struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
		Run struct {
			ID             string `json:"id"`
			Status         string `json:"status"`
			KnowledgeState string `json:"knowledgeState"`
		} `json:"run"`
		IdempotentReplay bool `json:"idempotentReplay"`
	}
	if err := json.NewDecoder(first.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	if start.IdempotentReplay || start.Run.Status != "queued" || start.Run.KnowledgeState != "unavailable" {
		t.Fatalf("unexpected first run start: %+v", start)
	}
	replay := h.post(t, "/api/v1/assistant/runs", payload)
	assertStatus(t, replay, http.StatusAccepted)
	var replayBody struct {
		Run              struct {
			ID string `json:"id"`
		} `json:"run"`
		IdempotentReplay bool `json:"idempotentReplay"`
	}
	if err := json.NewDecoder(replay.Body).Decode(&replayBody); err != nil {
		t.Fatal(err)
	}
	replay.Body.Close()
	if !replayBody.IdempotentReplay || replayBody.Run.ID != start.Run.ID {
		t.Fatal("idempotent replay mismatch")
	}
	conflict := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": clientRequestID, "conversationId": nil, "folderId": nil,
		"content": "不同的问题", "modelId": modelID, "reasoning": "high",
	})
	if status, code := v3Error(t, conflict); status != http.StatusConflict || code != "ASSISTANT_IDEMPOTENCY_CONFLICT" {
		t.Fatalf("expected idempotency conflict, got %d %s", status, code)
	}
	second := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": start.Conversation.ID,
		"content": "另一个问题", "modelId": modelID, "reasoning": "off",
	})
	if status, code := v3Error(t, second); status != http.StatusConflict || code != "ASSISTANT_RUN_ALREADY_ACTIVE" {
		t.Fatalf("expected active run conflict, got %d %s", status, code)
	}
	stop := h.post(t, "/api/v1/assistant/runs/"+start.Run.ID+"/stop", map[string]any{})
	assertStatus(t, stop, http.StatusOK)
	var stopped struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(stop.Body).Decode(&stopped); err != nil {
		t.Fatal(err)
	}
	stop.Body.Close()
	if stopped.Status != "stopped" {
		t.Fatalf("queued stop produced %s", stopped.Status)
	}
	retry := h.post(t, "/api/v1/assistant/runs/"+start.Run.ID+"/retry", map[string]any{
		"clientRequestId": uuid.New(), "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, retry, http.StatusAccepted)
	var retryBody struct {
		Run struct {
			ID           string  `json:"id"`
			RetryOfRunID *string `json:"retryOfRunId"`
		} `json:"run"`
		AssistantMessage struct {
			CurrentRun struct {
				ID string `json:"id"`
			} `json:"currentRun"`
		} `json:"assistantMessage"`
	}
	if err := json.NewDecoder(retry.Body).Decode(&retryBody); err != nil {
		t.Fatal(err)
	}
	retry.Body.Close()
	if retryBody.Run.RetryOfRunID == nil || *retryBody.Run.RetryOfRunID != start.Run.ID ||
		retryBody.AssistantMessage.CurrentRun.ID != retryBody.Run.ID {
		t.Fatalf("retry wiring wrong: %+v", retryBody)
	}
}

func TestV3ProviderInUseNarrowing(t *testing.T) {
	h := newV3Harness(t)
	providerID, modelID := h.createProviderModel(t, []map[string]any{})
	seedV3Knowledge(t, h.database, "笔记", "内容", "normal")
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil,
		"content": "问题", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	blocked := h.do(t, http.MethodPatch, "/api/v1/ai/providers/"+providerID.String(), map[string]any{"enabled": false}, false)
	if status, code := v3Error(t, blocked); status != http.StatusConflict || code != "PROVIDER_IN_USE" {
		t.Fatalf("expected PROVIDER_IN_USE, got %d %s", status, code)
	}
	allowed := h.do(t, http.MethodPatch, "/api/v1/ai/providers/"+providerID.String(), map[string]any{"displayName": "改名后"}, false)
	assertStatus(t, allowed, http.StatusOK)
	modelBlocked := h.do(t, http.MethodPatch, "/api/v1/ai/models/"+modelID.String(), map[string]any{"modelId": "renamed-upstream"}, false)
	if status, code := v3Error(t, modelBlocked); status != http.StatusConflict || code != "PROVIDER_IN_USE" {
		t.Fatalf("expected model PROVIDER_IN_USE, got %d %s", status, code)
	}
	stop := h.post(t, "/api/v1/assistant/runs/"+startBody.Run.ID+"/stop", map[string]any{})
	assertStatus(t, stop, http.StatusOK)
	unblocked := h.do(t, http.MethodPatch, "/api/v1/ai/providers/"+providerID.String(), map[string]any{"enabled": false}, false)
	assertStatus(t, unblocked, http.StatusOK)
}

func TestV3InternalEventsCitationValidation(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{})
	seedV3Knowledge(t, h.database, "笔记", "内容", "normal")
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil,
		"content": "问题", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	runID := startBody.Run.ID

	claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": "worker-v3"})
	assertStatus(t, claim, http.StatusOK)
	var claimBody struct {
		Run struct {
			ID           string `json:"id"`
			LeaseVersion int    `json:"leaseVersion"`
		} `json:"run"`
	}
	if err := json.NewDecoder(claim.Body).Decode(&claimBody); err != nil {
		t.Fatal(err)
	}
	claim.Body.Close()
	if claimBody.Run.ID != runID {
		t.Fatalf("claim returned %s, expected %s", claimBody.Run.ID, runID)
	}

	// A forged [[C token split across two events inside one batch is rejected
	// and the failing batch writes nothing.
	events := h.internalPost(t, "/internal/assistant/runs/"+runID+"/events", map[string]any{
		"workerId": "worker-v3", "leaseVersion": claimBody.Run.LeaseVersion,
		"events": []map[string]any{
			{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": "回答 ["}},
			{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": "[C1]] 伪造"}},
		},
	})
	if status, code := v3Error(t, events); status != http.StatusConflict || code != "ASSISTANT_EVENT_CONFLICT" {
		t.Fatalf("expected event conflict, got %d %s", status, code)
	}
	var count int
	if err := h.database.QueryRow(context.Background(),
		`SELECT count(*) FROM assistant_run_events WHERE run_id = $1`, runID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rejected batch wrote %d events", count)
	}
	// A valid citation flow writes the canonical token at the right position.
	valid := h.internalPost(t, "/internal/assistant/runs/"+runID+"/events", map[string]any{
		"workerId": "worker-v3", "leaseVersion": claimBody.Run.LeaseVersion,
		"events": []map[string]any{
			{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": "依据 "}},
			{"eventId": uuid.New(), "type": "answer.citation", "payload": map[string]any{"sourceOrdinal": float64(1)}},
			{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": " 说明"}},
		},
	})
	assertStatus(t, valid, http.StatusOK)
	var content string
	if err := h.database.QueryRow(context.Background(), `
		SELECT content FROM assistant_messages WHERE current_run_id = $1
	`, runID).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if content != "依据 [[C1]] 说明" {
		t.Fatalf("aggregated content wrong: %q", content)
	}
	// A marker split across separate HTTP requests is rejected by the tail state.
	second := h.internalPost(t, "/internal/assistant/runs/"+runID+"/events", map[string]any{
		"workerId": "worker-v3", "leaseVersion": claimBody.Run.LeaseVersion,
		"events": []map[string]any{
			{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": " [["}},
		},
	})
	assertStatus(t, second, http.StatusOK)
	third := h.internalPost(t, "/internal/assistant/runs/"+runID+"/events", map[string]any{
		"workerId": "worker-v3", "leaseVersion": claimBody.Run.LeaseVersion,
		"events": []map[string]any{
			{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": "S1]] 跨请求"}},
		},
	})
	if status, code := v3Error(t, third); status != http.StatusConflict || code != "ASSISTANT_EVENT_CONFLICT" {
		t.Fatalf("expected cross-request conflict, got %d %s", status, code)
	}
}

func TestV3FolderDeleteBehaviors(t *testing.T) {
	h := newV3Harness(t)
	created := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "运维"})
	assertStatus(t, created, http.StatusCreated)
	var folder struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(created.Body).Decode(&folder); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	_, modelID := h.createProviderModel(t, []map[string]any{})
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil, "folderId": folder.ID,
		"content": "问题", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	blocked := h.delete(t, "/api/v1/assistant/folders/"+folder.ID, map[string]any{"conversationAction": "delete"})
	if status, code := v3Error(t, blocked); status != http.StatusConflict || code != "ASSISTANT_RUN_ALREADY_ACTIVE" {
		t.Fatalf("expected folder delete conflict, got %d %s", status, code)
	}
	unfile := h.delete(t, "/api/v1/assistant/folders/"+folder.ID, map[string]any{"conversationAction": "unfile"})
	assertStatus(t, unfile, http.StatusNoContent)
	var folderID *string
	if err := h.database.QueryRow(context.Background(),
		`SELECT folder_id::text FROM assistant_conversations WHERE id = $1`,
		startBody.Conversation.ID).Scan(&folderID); err != nil {
		t.Fatal(err)
	}
	if folderID != nil {
		t.Fatal("unfile did not clear folder")
	}
	missing := h.delete(t, "/api/v1/assistant/folders/"+folder.ID, map[string]any{"conversationAction": "delete"})
	assertStatus(t, missing, http.StatusNotFound)
}

func TestV3PurgeErasesSourceSnapshots(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{})
	itemID := seedV3Knowledge(t, h.database, "将被删除的笔记", "唯一内容证据", "normal")
	var fragmentID uuid.UUID
	if err := h.database.QueryRow(context.Background(),
		`SELECT id FROM search_fragments WHERE item_id = $1`, itemID).Scan(&fragmentID); err != nil {
		t.Fatal(err)
	}
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil,
		"content": "问题", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	runID := startBody.Run.ID
	if _, err := h.database.Exec(context.Background(), `
		INSERT INTO assistant_run_sources (run_id, ordinal, fragment_id, item_id, source_kind,
		       title_snapshot, excerpt_snapshot, locator_snapshot, retrieval_rank, created_at)
		VALUES ($1, 1, $2, $3, 'raw_text', '将被删除的笔记', '唯一内容证据',
		        jsonb_build_object('itemId', $4::text), 1, now())
	`, runID, fragmentID, itemID, itemID.String()); err != nil {
		t.Fatal(err)
	}
	trash := h.delete(t, "/api/v1/items/"+itemID.String(), nil)
	assertStatus(t, trash, http.StatusNoContent)
	// Rollback path: block the item DELETE, the erasure must roll back with the
	// transaction and both the item and the source snapshots stay intact.
	if _, err := h.database.Exec(context.Background(), `
		CREATE OR REPLACE FUNCTION v3_block_item_delete() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'blocked for test'; END $$;
		CREATE TRIGGER v3_block_item_delete BEFORE DELETE ON knowledge_items
		FOR EACH ROW EXECUTE FUNCTION v3_block_item_delete();
	`); err != nil {
		t.Fatal(err)
	}
	blockedPurge := h.delete(t, "/api/v1/items/"+itemID.String()+"/purge", map[string]any{"confirmItemId": itemID.String()})
	if status, _ := v3Error(t, blockedPurge); status != http.StatusInternalServerError {
		t.Fatalf("expected blocked purge to fail with 500, got %d", status)
	}
	var rollbackTitle string
	var rollbackFragment *string
	if err := h.database.QueryRow(context.Background(), `
		SELECT title_snapshot, fragment_id::text FROM assistant_run_sources WHERE run_id = $1 AND ordinal = 1
	`, runID).Scan(&rollbackTitle, &rollbackFragment); err != nil {
		t.Fatal(err)
	}
	if rollbackTitle != "将被删除的笔记" || rollbackFragment == nil {
		t.Fatalf("rolled-back purge still erased snapshots: %q %v", rollbackTitle, rollbackFragment)
	}
	if _, err := h.database.Exec(context.Background(), `
		DROP TRIGGER v3_block_item_delete ON knowledge_items;
		DROP FUNCTION v3_block_item_delete();
	`); err != nil {
		t.Fatal(err)
	}
	purge := h.delete(t, "/api/v1/items/"+itemID.String()+"/purge", map[string]any{"confirmItemId": itemID.String()})
	assertStatus(t, purge, http.StatusNoContent)
	var title, excerpt string
	var fragmentRef, itemRef *string
	if err := h.database.QueryRow(context.Background(), `
		SELECT title_snapshot, excerpt_snapshot, fragment_id::text, item_id::text
		FROM assistant_run_sources WHERE run_id = $1 AND ordinal = 1
	`, runID).Scan(&title, &excerpt, &fragmentRef, &itemRef); err != nil {
		t.Fatal(err)
	}
	if title != "来源已删除" || excerpt != "" || fragmentRef != nil || itemRef != nil {
		t.Fatalf("purge erasure incomplete: %q %q %v %v", title, excerpt, fragmentRef, itemRef)
	}
	// The historical answer content is untouched.
	var content string
	if err := h.database.QueryRow(context.Background(),
		`SELECT content FROM assistant_messages WHERE current_run_id = $1`, runID).Scan(&content); err != nil {
		t.Fatal(err)
	}
}

func TestV3HybridRetrievalReadyAndNotReady(t *testing.T) {
	h := newV3Harness(t)
	seedV3Knowledge(t, h.database, "Docker 部署指南", "使用 docker compose up -d 启动全部服务并检查健康状态", "normal")
	if _, err := h.database.Exec(context.Background(), `
		UPDATE assistant_embedding_config SET base_url = 'https://embed.example/v1',
		       api_key_ciphertext = NULL, model_id = 'mock-embed', display_name = '向量',
		       dimensions = 4, enabled = true, generation = 1, status = 'indexing', updated_at = now()
		WHERE singleton
	`); err != nil {
		t.Fatal(err)
	}
	h.assistant.RunOnce(context.Background())
	if _, err := h.database.Exec(context.Background(), `
		UPDATE assistant_fragment_embeddings SET state = 'ready',
		       embedding = $1::vector, dimensions = 4, indexed_at = now()
	`, "[0.5,0.5,0.5,0.5]"); err != nil {
		t.Fatal(err)
	}
	h.assistant.RunOnce(context.Background())
	response := h.get(t, "/api/v1/assistant/index-status")
	assertStatus(t, response, http.StatusOK)
	var status struct {
		Status    string `json:"status"`
		Available bool   `json:"available"`
		Counts    struct {
			Active int `json:"active"`
			Ready  int `json:"ready"`
		} `json:"counts"`
	}
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if status.Status != "ready" || !status.Available || status.Counts.Ready != status.Counts.Active || status.Counts.Active != 1 {
		t.Fatalf("index status not ready: %+v", status)
	}
	// A run created while ready freezes knowledge_state=ready.
	_, modelID := h.createProviderModel(t, []map[string]any{})
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil,
		"content": "怎么部署服务？", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Run struct {
			ID             string `json:"id"`
			KnowledgeState string `json:"knowledgeState"`
		} `json:"run"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	if startBody.Run.KnowledgeState != "ready" {
		t.Fatalf("expected ready knowledge state, got %s", startBody.Run.KnowledgeState)
	}
	// Claim and run retrieval with a vector below the cosine threshold: the
	// evidence state must be not_found, not unavailable.
	claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": "worker-v3"})
	assertStatus(t, claim, http.StatusOK)
	var claimBody struct {
		Run struct {
			ID           string `json:"id"`
			LeaseVersion int    `json:"leaseVersion"`
		} `json:"run"`
		Knowledge struct {
			Generation *int64 `json:"generation"`
		} `json:"knowledge"`
	}
	if err := json.NewDecoder(claim.Body).Decode(&claimBody); err != nil {
		t.Fatal(err)
	}
	claim.Body.Close()
	retrieval := h.internalPost(t, "/internal/assistant/runs/"+startBody.Run.ID+"/retrieval", map[string]any{
		"workerId": "worker-v3", "leaseVersion": claimBody.Run.LeaseVersion,
		"generation": claimBody.Knowledge.Generation, "query": "完全无关的问题内容",
		// Orthogonal to the indexed [0.5,0.5,0.5,0.5]: cosine 0 stays below the
		// 0.50 admission threshold.
		"queryVector": []float32{0.5, -0.5, 0.5, -0.5},
	})
	assertStatus(t, retrieval, http.StatusOK)
	var retrievalBody struct {
		KnowledgeState string `json:"knowledgeState"`
		EvidenceState  string `json:"evidenceState"`
		Sources        []any  `json:"sources"`
	}
	if err := json.NewDecoder(retrieval.Body).Decode(&retrievalBody); err != nil {
		t.Fatal(err)
	}
	retrieval.Body.Close()
	if retrievalBody.KnowledgeState != "ready" || retrievalBody.EvidenceState != "not_found" || len(retrievalBody.Sources) != 0 {
		t.Fatalf("threshold retrieval wrong: %+v", retrievalBody)
	}
}

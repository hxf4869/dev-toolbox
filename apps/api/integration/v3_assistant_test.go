//go:build integration

package integration_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	server         *httptest.Server
	client         *http.Client
	csrf           string
	database       *pgxpool.Pool
	assistant      *assistant.Service
	ai             *ai.Service
	totpSecret     string
	knowledge      *knowledge.Service
	attachmentRoot string
}

func newV3Harness(t *testing.T, workerURLs ...string) *v3Harness {
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
	attachmentRoot := t.TempDir()
	knowledgeService, err := knowledge.NewService(database, attachmentRoot, location)
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
	workerURL := "http://worker.invalid"
	if len(workerURLs) > 0 {
		workerURL = workerURLs[0]
	}
	assistantService := assistant.NewService(database, masterKey, workerURL, v3InternalToken, false)
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
	return &v3Harness{server: server, client: client, csrf: csrf, database: database,
		assistant: assistantService, ai: aiService, totpSecret: provisioning.ManualKey,
		knowledge: knowledgeService, attachmentRoot: attachmentRoot}
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

func insertV3RunSource(t *testing.T, database *pgxpool.Pool, runID string, itemID uuid.UUID, title, excerpt string) {
	t.Helper()
	parsedRunID, err := uuid.Parse(runID)
	if err != nil {
		t.Fatal(err)
	}
	var fragmentID uuid.UUID
	if err := database.QueryRow(context.Background(),
		`SELECT id FROM search_fragments WHERE item_id = $1 ORDER BY id LIMIT 1`, itemID).Scan(&fragmentID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(context.Background(), `
		INSERT INTO assistant_run_sources (
			run_id, ordinal, fragment_id, item_id, source_kind, title_snapshot,
			excerpt_snapshot, locator_snapshot, retrieval_rank, created_at
		) VALUES (
			$1::uuid, 1, $2::uuid, $3::uuid, 'raw_text', $4, $5,
			jsonb_build_object('itemId', ($3::uuid)::text, 'fragmentId', ($2::uuid)::text), 1, now()
		)
	`, parsedRunID, fragmentID, itemID, title, excerpt); err != nil {
		t.Fatal(err)
	}
}

type v3SSEBlock struct {
	ID    string
	Event string
	Data  string
	Raw   string
}

func readV3SSEBlock(t *testing.T, reader *bufio.Reader) v3SSEBlock {
	t.Helper()
	var block v3SSEBlock
	var lines []string
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read SSE block: %v", err)
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			if len(lines) == 0 {
				continue
			}
			block.Raw = strings.Join(lines, "\n")
			return block
		}
		lines = append(lines, line)
		switch {
		case strings.HasPrefix(line, "id: "):
			block.ID = strings.TrimPrefix(line, "id: ")
		case strings.HasPrefix(line, "event: "):
			block.Event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			block.Data = strings.TrimPrefix(line, "data: ")
		}
	}
}

func readV3SSEEvent(t *testing.T, reader *bufio.Reader, eventType string) v3SSEBlock {
	t.Helper()
	for {
		block := readV3SSEBlock(t, reader)
		if block.Event == "" {
			continue
		}
		if block.Event != eventType {
			t.Fatalf("SSE event = %s, want %s; block=%q", block.Event, eventType, block.Raw)
		}
		return block
	}
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
	if bootstrap.Models[0]["contextWindow"] != float64(32768) {
		t.Fatal("bootstrap must expose the configured context window")
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

func TestV3IndexCountsBeforeEmbeddingEnabled(t *testing.T) {
	h := newV3Harness(t)
	seedV3Knowledge(t, h.database, "正常笔记", "合成测试内容", "normal")
	seedV3Knowledge(t, h.database, "敏感笔记", "合成敏感内容", "sensitive")
	inactive := seedV3Knowledge(t, h.database, "非活跃片段", "不会被发送", "normal")
	deleted := seedV3Knowledge(t, h.database, "回收站笔记", "不会被发送", "normal")
	ctx := context.Background()
	if _, err := h.database.Exec(ctx, `UPDATE search_fragments SET active = false WHERE item_id = $1`, inactive); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec(ctx, `UPDATE knowledge_items SET deleted_at = now() WHERE id = $1`, deleted); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec(ctx, `UPDATE app_settings SET sensitive_ai_policy = 'redact' WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	check := func(wantStatus string, wantActive int) {
		t.Helper()
		response := h.get(t, "/api/v1/assistant/index-status")
		assertStatus(t, response, http.StatusOK)
		var status struct {
			Status    string         `json:"status"`
			Available bool           `json:"available"`
			Counts    map[string]int `json:"counts"`
		}
		if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if status.Status != wantStatus || status.Available || status.Counts["active"] != wantActive {
			t.Fatalf("incorrect pre-enable index status: %+v", status)
		}
		for _, key := range []string{"ready", "pending", "running", "failed"} {
			if status.Counts[key] != 0 {
				t.Fatalf("disabled index reported work: %+v", status.Counts)
			}
		}
	}
	check("unconfigured", 2)
	configure := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "合成向量", "baseUrl": "https://embed.example/v1",
		"apiKey": "embedding-test-secret", "modelId": "mock-embed", "dimensions": 4,
		"enabled": false, "confirmReindex": true,
	})
	assertStatus(t, configure, http.StatusOK)
	configure.Body.Close()
	check("disabled", 2)
	if _, err := h.database.Exec(ctx, `UPDATE app_settings SET sensitive_ai_policy = 'block' WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	check("disabled", 1)
	var queued int
	if err := h.database.QueryRow(ctx, `SELECT count(*) FROM assistant_fragment_embeddings`).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("pre-enable count reads queued %d fragments", queued)
	}
}

func TestV3IndexClaimsSmallBatchesAndPreservesCompletedVectors(t *testing.T) {
	h := newV3Harness(t)
	for index := 0; index < 9; index++ {
		seedV3Knowledge(t, h.database, "合成索引笔记", "合成索引内容", "normal")
	}
	configure := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "合成向量", "baseUrl": "https://embed.example/v1",
		"apiKey": "embedding-test-secret", "modelId": "mock-embed", "dimensions": 4,
		"enabled": true, "confirmReindex": true,
	})
	assertStatus(t, configure, http.StatusOK)
	configure.Body.Close()
	h.assistant.RunOnce(context.Background())
	claim := h.internalPost(t, "/internal/assistant/index/claim", map[string]any{"workerId": "index-test-worker"})
	assertStatus(t, claim, http.StatusOK)
	var batch struct {
		Generation int64  `json:"generation"`
		Policy     string `json:"policy"`
		Fragments  []struct {
			FragmentID      string `json:"fragmentId"`
			Attempt         int    `json:"attempt"`
			SourceCreatedAt string `json:"sourceCreatedAt"`
			Sensitivity     string `json:"sensitivity"`
		} `json:"fragments"`
	}
	if err := json.NewDecoder(claim.Body).Decode(&batch); err != nil {
		t.Fatal(err)
	}
	claim.Body.Close()
	if len(batch.Fragments) != 4 {
		t.Fatalf("expected a CPU-sized batch of 4, got %d", len(batch.Fragments))
	}
	results := make([]map[string]any, 0, len(batch.Fragments))
	for _, fragment := range batch.Fragments {
		results = append(results, map[string]any{
			"fragmentId": fragment.FragmentID, "leaseVersion": fragment.Attempt,
			"sourceCreatedAt": fragment.SourceCreatedAt, "sensitivity": fragment.Sensitivity,
			"dimensions": 4, "embedding": []float64{0.5, 0.5, 0.5, 0.5},
		})
	}
	complete := h.internalPost(t, "/internal/assistant/index/complete", map[string]any{
		"workerId": "index-test-worker", "generation": batch.Generation, "policy": batch.Policy, "results": results,
	})
	assertStatus(t, complete, http.StatusNoContent)
	complete.Body.Close()
	h.assistant.RunOnce(context.Background())
	var ready, pending int
	if err := h.database.QueryRow(context.Background(), `
		SELECT count(*) FILTER (WHERE state = 'ready'), count(*) FILTER (WHERE state = 'pending')
		FROM assistant_fragment_embeddings
	`).Scan(&ready, &pending); err != nil {
		t.Fatal(err)
	}
	if ready != 4 || pending != 5 {
		t.Fatalf("completed vectors were not preserved: ready=%d pending=%d", ready, pending)
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
	h.assistant.RunOnce(context.Background())
	response = h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "知识向量（已换密钥）", "baseUrl": "https://embed.example/v1",
		"apiKey": "rotated-embed-secret", "modelId": "text-embedding-mock", "dimensions": 1536,
		"enabled": true, "confirmReindex": false,
	})
	assertStatus(t, response, http.StatusOK)
	if err := json.NewDecoder(response.Body).Decode(&settings); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if settings.Status != "ready" || settings.Generation == nil || *settings.Generation != 1 {
		t.Fatalf("display/key-only update restarted indexing: %+v", settings)
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

func TestV3SensitivePolicyHookFailureRollsBack(t *testing.T) {
	h := newV3Harness(t)
	previousHook := ai.SensitivePolicyChangeHook
	ai.SensitivePolicyChangeHook = func(context.Context, pgx.Tx, string, string) (func(), error) {
		return nil, errors.New("synthetic generation failure")
	}
	t.Cleanup(func() { ai.SensitivePolicyChangeHook = previousHook })

	response := h.put(t, "/api/v1/ai/settings", map[string]any{"sensitiveAiPolicy": "block"})
	if status, _ := v3Error(t, response); status != http.StatusInternalServerError {
		t.Fatalf("hook failure status = %d, want 500", status)
	}
	var policy string
	var generation int64
	if err := h.database.QueryRow(context.Background(), `
		SELECT settings.sensitive_ai_policy, embedding.generation
		FROM app_settings settings CROSS JOIN assistant_embedding_config embedding
		WHERE settings.singleton AND embedding.singleton
	`).Scan(&policy, &generation); err != nil {
		t.Fatal(err)
	}
	if policy != "redact" || generation != 0 {
		t.Fatalf("failed policy update partially committed: policy=%s generation=%d", policy, generation)
	}
}

func TestV3SensitivePolicyTighteningUpdatesQueuedAndStopsRunningRuns(t *testing.T) {
	h := newV3Harness(t)
	previousHook := ai.SensitivePolicyChangeHook
	ai.SensitivePolicyChangeHook = h.assistant.NotifySensitivePolicyChanged
	t.Cleanup(func() { ai.SensitivePolicyChangeHook = previousHook })

	allow := h.put(t, "/api/v1/ai/settings", map[string]any{
		"sensitiveAiPolicy": "allow", "confirmSensitiveAllow": true,
	})
	assertStatus(t, allow, http.StatusOK)
	allow.Body.Close()
	_, modelID := h.createProviderModel(t, []map[string]any{})
	startRun := func(content string) string {
		response := h.post(t, "/api/v1/assistant/runs", map[string]any{
			"clientRequestId": uuid.New(), "conversationId": nil,
			"content": content, "modelId": modelID, "reasoning": "off",
		})
		assertStatus(t, response, http.StatusAccepted)
		var body struct {
			Run struct {
				ID string `json:"id"`
			} `json:"run"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return body.Run.ID
	}
	firstRunID := startRun("第一条排队请求")
	secondRunID := startRun("第二条排队请求")
	claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": "worker-policy"})
	assertStatus(t, claim, http.StatusOK)
	var claimed struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(claim.Body).Decode(&claimed); err != nil {
		t.Fatal(err)
	}
	claim.Body.Close()
	queuedRunID := firstRunID
	if claimed.Run.ID == firstRunID {
		queuedRunID = secondRunID
	} else if claimed.Run.ID != secondRunID {
		t.Fatalf("claimed unexpected run %s", claimed.Run.ID)
	}

	tighten := h.put(t, "/api/v1/ai/settings", map[string]any{"sensitiveAiPolicy": "redact"})
	assertStatus(t, tighten, http.StatusOK)
	tighten.Body.Close()
	var runningStatus, runningPolicy string
	var runningError *string
	if err := h.database.QueryRow(context.Background(), `
		SELECT status, effective_sensitive_policy, error_code FROM assistant_runs WHERE id = $1
	`, claimed.Run.ID).Scan(&runningStatus, &runningPolicy, &runningError); err != nil {
		t.Fatal(err)
	}
	if runningStatus != "failed" || runningPolicy != "redact" || runningError == nil ||
		*runningError != "ASSISTANT_SENSITIVE_POLICY_CHANGED" {
		t.Fatalf("running run was not stopped by policy tightening: %s %s %v", runningStatus, runningPolicy, runningError)
	}
	var messageStatus string
	if err := h.database.QueryRow(context.Background(), `
		SELECT message.status FROM assistant_messages message
		JOIN assistant_runs run ON run.output_message_id = message.id WHERE run.id = $1
	`, claimed.Run.ID).Scan(&messageStatus); err != nil {
		t.Fatal(err)
	}
	if messageStatus != "failed" {
		t.Fatalf("policy-stopped output message status = %s", messageStatus)
	}
	var queuedStatus, queuedPolicy string
	if err := h.database.QueryRow(context.Background(), `
		SELECT status, effective_sensitive_policy FROM assistant_runs WHERE id = $1
	`, queuedRunID).Scan(&queuedStatus, &queuedPolicy); err != nil {
		t.Fatal(err)
	}
	if queuedStatus != "queued" || queuedPolicy != "redact" {
		t.Fatalf("queued run did not adopt stricter policy: %s %s", queuedStatus, queuedPolicy)
	}

	queuedClaim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": "worker-policy-next"})
	assertStatus(t, queuedClaim, http.StatusOK)
	var queuedClaimBody struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
		SensitivePolicy string `json:"sensitivePolicy"`
	}
	if err := json.NewDecoder(queuedClaim.Body).Decode(&queuedClaimBody); err != nil {
		t.Fatal(err)
	}
	queuedClaim.Body.Close()
	if queuedClaimBody.Run.ID != queuedRunID || queuedClaimBody.SensitivePolicy != "redact" {
		t.Fatalf("queued claim did not use tightened policy: %+v", queuedClaimBody)
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
			ID               string `json:"id"`
			Status           string `json:"status"`
			KnowledgeState   string `json:"knowledgeState"`
			PromptVersion    string `json:"promptVersion"`
			RetrievalVersion string `json:"retrievalVersion"`
			RewriteFallback  bool   `json:"rewriteFallback"`
		} `json:"run"`
		IdempotentReplay bool `json:"idempotentReplay"`
	}
	firstBody, err := io.ReadAll(first.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(firstBody, &start); err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	if start.IdempotentReplay || start.Run.Status != "queued" || start.Run.KnowledgeState != "unavailable" ||
		start.Run.PromptVersion == "" || start.Run.RetrievalVersion == "" || start.Run.RewriteFallback {
		t.Fatalf("unexpected first run start: %+v", start)
	}
	if !bytes.Contains(firstBody, []byte(`"retrievalMs"`)) || bytes.Contains(firstBody, []byte(`"retrievalMS"`)) {
		t.Fatalf("run timing JSON uses the wrong retrieval key: %s", firstBody)
	}
	replay := h.post(t, "/api/v1/assistant/runs", payload)
	assertStatus(t, replay, http.StatusAccepted)
	var replayBody struct {
		Run struct {
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
		Status   string `json:"status"`
		CanStop  bool   `json:"canStop"`
		CanRetry bool   `json:"canRetry"`
	}
	if err := json.NewDecoder(stop.Body).Decode(&stopped); err != nil {
		t.Fatal(err)
	}
	stop.Body.Close()
	if stopped.Status != "stopped" || stopped.CanStop || !stopped.CanRetry {
		t.Fatalf("queued stop produced unexpected DTO: %+v", stopped)
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
	oldRun := h.get(t, "/api/v1/assistant/runs/"+start.Run.ID)
	assertStatus(t, oldRun, http.StatusOK)
	var oldRunDTO struct {
		CanRetry bool `json:"canRetry"`
	}
	if err := json.NewDecoder(oldRun.Body).Decode(&oldRunDTO); err != nil {
		t.Fatal(err)
	}
	oldRun.Body.Close()
	if oldRunDTO.CanRetry {
		t.Fatal("superseded retry source still advertises canRetry")
	}
	claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": "worker-v3-lifecycle"})
	assertStatus(t, claim, http.StatusOK)
	claim.Body.Close()
	runningResponse := h.get(t, "/api/v1/assistant/runs/"+retryBody.Run.ID)
	assertStatus(t, runningResponse, http.StatusOK)
	var running struct {
		Status        string     `json:"status"`
		StopRequested bool       `json:"stopRequested"`
		CanStop       bool       `json:"canStop"`
		StartedAt     *time.Time `json:"startedAt"`
	}
	if err := json.NewDecoder(runningResponse.Body).Decode(&running); err != nil {
		t.Fatal(err)
	}
	runningResponse.Body.Close()
	if running.StartedAt == nil || running.StartedAt.After(time.Now().UTC().Add(time.Second)) {
		t.Fatalf("claim exposed a future startedAt: %v", running.StartedAt)
	}
	stopRunning := h.post(t, "/api/v1/assistant/runs/"+retryBody.Run.ID+"/stop", map[string]any{})
	assertStatus(t, stopRunning, http.StatusOK)
	if err := json.NewDecoder(stopRunning.Body).Decode(&running); err != nil {
		t.Fatal(err)
	}
	stopRunning.Body.Close()
	if running.Status != "running" || !running.StopRequested || running.CanStop {
		t.Fatalf("running stop produced unexpected DTO: %+v", running)
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
	itemID := seedV3Knowledge(t, h.database, "笔记", "内容", "normal")
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
	insertV3RunSource(t, h.database, runID, itemID, "笔记", "内容")
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

func TestV3PersistentSSEPublicContract(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{})
	itemID := seedV3Knowledge(t, h.database, "SSE 笔记", "公开流来源内容", "normal")
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil,
		"content": "流式回答", "modelId": modelID, "reasoning": "off",
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
	if _, err := h.database.Exec(context.Background(), `UPDATE provider_models SET context_window = 65536 WHERE id = $1`, modelID); err != nil {
		t.Fatal(err)
	}
	claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": "worker-v3-sse"})
	assertStatus(t, claim, http.StatusOK)
	var claimBody struct {
		Run struct {
			LeaseVersion int `json:"leaseVersion"`
		} `json:"run"`
	}
	if err := json.NewDecoder(claim.Body).Decode(&claimBody); err != nil {
		t.Fatal(err)
	}
	claim.Body.Close()
	insertV3RunSource(t, h.database, runID, itemID, "SSE 笔记", "公开流来源内容")

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		h.server.URL+"/api/v1/assistant/runs/"+runID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", testOrigin)
	stream, err := h.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	assertStatus(t, stream, http.StatusOK)
	if stream.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" ||
		stream.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("unexpected SSE headers: %v", stream.Header)
	}
	reader := bufio.NewReader(stream.Body)
	snapshot := readV3SSEEvent(t, reader, "snapshot")
	if !strings.Contains(snapshot.Data, `"contextWindow":32768`) {
		t.Fatal("run must retain its creation-time window after the model configuration changes")
	}
	if snapshot.ID != "" || strings.Contains(snapshot.Raw, "id:") {
		t.Fatalf("snapshot must not carry an SSE id: %q", snapshot.Raw)
	}
	var snapshotPayload struct {
		LastSequence int64 `json:"lastSequence"`
		Run          struct {
			Status           string `json:"status"`
			PromptVersion    string `json:"promptVersion"`
			RetrievalVersion string `json:"retrievalVersion"`
		} `json:"run"`
	}
	if err := json.Unmarshal([]byte(snapshot.Data), &snapshotPayload); err != nil {
		t.Fatal(err)
	}
	if snapshotPayload.LastSequence != 0 || snapshotPayload.Run.Status != "running" ||
		snapshotPayload.Run.PromptVersion == "" || snapshotPayload.Run.RetrievalVersion == "" {
		t.Fatalf("unexpected SSE snapshot: %+v", snapshotPayload)
	}

	appendResponse := h.internalPost(t, "/internal/assistant/runs/"+runID+"/events", map[string]any{
		"workerId": "worker-v3-sse", "leaseVersion": claimBody.Run.LeaseVersion,
		"events": []map[string]any{
			{"eventId": uuid.New(), "type": "run.status", "payload": map[string]any{"phase": "answer"}},
			{"eventId": uuid.New(), "type": "sources.ready", "payload": map[string]any{
				"knowledgeState": "ready", "evidenceState": "matched",
				"providedSourceCount": 1, "rewriteFallback": true,
			}},
			{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": "依据 "}},
			{"eventId": uuid.New(), "type": "answer.citation", "payload": map[string]any{"sourceOrdinal": 1}},
			{"eventId": uuid.New(), "type": "usage.updated", "payload": map[string]any{"usage": map[string]any{
				"rewriteInputTokens": 2, "rewriteOutputTokens": 3,
				"answerInputTokens": 11, "answerOutputTokens": 5,
				"answerContextTokens": 100,
			}}},
		},
	})
	assertStatus(t, appendResponse, http.StatusOK)
	appendResponse.Body.Close()

	statusEvent := readV3SSEEvent(t, reader, "run.status")
	if statusEvent.ID != "1" || !strings.Contains(statusEvent.Data, `"status":"running"`) {
		t.Fatalf("run.status was not transformed to public shape: %q", statusEvent.Raw)
	}
	sourcesEvent := readV3SSEEvent(t, reader, "sources.ready")
	if sourcesEvent.ID != "2" || !strings.Contains(sourcesEvent.Data, `"rewriteFallback":true`) {
		t.Fatalf("sources.ready lost runtime trace: %q", sourcesEvent.Raw)
	}
	if event := readV3SSEEvent(t, reader, "answer.delta"); event.ID != "3" {
		t.Fatalf("answer.delta id = %q, want 3", event.ID)
	}
	citationEvent := readV3SSEEvent(t, reader, "answer.citation")
	var citationPayload struct {
		Sequence       int    `json:"sequence"`
		CitationNumber int    `json:"citationNumber"`
		Token          string `json:"token"`
		Source         struct {
			RunID        string `json:"runId"`
			Title        string `json:"title"`
			Availability string `json:"availability"`
		} `json:"source"`
	}
	if err := json.Unmarshal([]byte(citationEvent.Data), &citationPayload); err != nil {
		t.Fatal(err)
	}
	if citationEvent.ID != "4" || citationPayload.Sequence != 4 || citationPayload.CitationNumber != 1 ||
		citationPayload.Token != "[[C1]]" || citationPayload.Source.RunID != runID ||
		citationPayload.Source.Title != "SSE 笔记" || citationPayload.Source.Availability != "available" {
		t.Fatalf("citation event was not converted to public source: %+v", citationPayload)
	}
	if event := readV3SSEEvent(t, reader, "usage.updated"); event.ID != "5" || !strings.Contains(event.Data, `"answerContextTokens":100`) {
		t.Fatalf("usage.updated lost its full input measurement: %s", event.Data)
	}

	complete := h.internalPost(t, "/internal/assistant/runs/"+runID+"/complete", map[string]any{
		"workerId": "worker-v3-sse", "leaseVersion": claimBody.Run.LeaseVersion,
		"usage": map[string]any{
			"rewriteInputTokens": 2, "rewriteOutputTokens": 3,
			"answerInputTokens": 11, "answerOutputTokens": 5,
			"answerContextTokens": 100,
		},
		"timings": map[string]any{
			"rewriteMs": 1, "embeddingMs": 2, "retrievalMs": 7,
			"reasoningMs": 4, "answerMs": 5,
		},
	})
	assertStatus(t, complete, http.StatusOK)
	complete.Body.Close()
	terminal := readV3SSEEvent(t, reader, "run.completed")
	if !strings.Contains(terminal.Data, `"answerContextTokens":100`) || !strings.Contains(terminal.Data, `"contextWindow":32768`) {
		t.Fatal("terminal snapshot lost context measurement or model window")
	}
	var terminalPayload struct {
		Sequence int `json:"sequence"`
		Run      struct {
			Status          string `json:"status"`
			RewriteFallback bool   `json:"rewriteFallback"`
			LastSequence    int64  `json:"lastSequence"`
			Timings         struct {
				RetrievalMS *int64 `json:"retrievalMs"`
				TotalMS     *int64 `json:"totalMs"`
			} `json:"timings"`
		} `json:"run"`
	}
	if err := json.Unmarshal([]byte(terminal.Data), &terminalPayload); err != nil {
		t.Fatal(err)
	}
	if terminal.ID != "6" || terminalPayload.Sequence != 6 || terminalPayload.Run.Status != "succeeded" ||
		!terminalPayload.Run.RewriteFallback || terminalPayload.Run.LastSequence != 5 ||
		terminalPayload.Run.Timings.RetrievalMS == nil || *terminalPayload.Run.Timings.RetrievalMS != 7 ||
		terminalPayload.Run.Timings.TotalMS == nil || *terminalPayload.Run.Timings.TotalMS != 19 {
		t.Fatalf("unexpected terminal event: %+v", terminalPayload)
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
	configure := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "向量", "baseUrl": "https://embed.example/v1",
		"apiKey": "embedding-test-secret", "modelId": "mock-embed", "dimensions": 4,
		"enabled": true, "confirmReindex": true,
	})
	assertStatus(t, configure, http.StatusOK)
	configure.Body.Close()
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
	var frozenGeneration *int64
	if err := h.database.QueryRow(context.Background(), `
		SELECT knowledge_generation FROM assistant_runs WHERE id = $1
	`, startBody.Run.ID).Scan(&frozenGeneration); err != nil {
		t.Fatal(err)
	}
	if frozenGeneration == nil || *frozenGeneration != 1 {
		t.Fatalf("run did not freeze generation 1: %v", frozenGeneration)
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
	if claimBody.Knowledge.Generation == nil || *claimBody.Knowledge.Generation != 1 {
		t.Fatalf("claim did not preserve frozen generation: %+v", claimBody.Knowledge)
	}
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

	// A second run freezes generation 1, then the global config moves to 2
	// before claim. It must degrade instead of silently crossing generations.
	staleStart := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil,
		"content": "代次切换期间的问题", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, staleStart, http.StatusAccepted)
	var staleStartBody struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(staleStart.Body).Decode(&staleStartBody); err != nil {
		t.Fatal(err)
	}
	staleStart.Body.Close()
	if _, err := h.database.Exec(context.Background(), `
		UPDATE assistant_embedding_config SET generation = 2, status = 'indexing', updated_at = now()
		WHERE singleton
	`); err != nil {
		t.Fatal(err)
	}
	staleClaim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": "worker-v3-stale"})
	assertStatus(t, staleClaim, http.StatusOK)
	var staleClaimBody struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
		Knowledge struct {
			State      string `json:"state"`
			Generation *int64 `json:"generation"`
		} `json:"knowledge"`
	}
	if err := json.NewDecoder(staleClaim.Body).Decode(&staleClaimBody); err != nil {
		t.Fatal(err)
	}
	staleClaim.Body.Close()
	if staleClaimBody.Run.ID != staleStartBody.Run.ID || staleClaimBody.Knowledge.State != "unavailable" ||
		staleClaimBody.Knowledge.Generation != nil {
		t.Fatalf("stale generation was not degraded: %+v", staleClaimBody)
	}
	var storedState string
	if err := h.database.QueryRow(context.Background(), `
		SELECT knowledge_state, knowledge_generation FROM assistant_runs WHERE id = $1
	`, staleStartBody.Run.ID).Scan(&storedState, &frozenGeneration); err != nil {
		t.Fatal(err)
	}
	if storedState != "unavailable" || frozenGeneration == nil || *frozenGeneration != 1 {
		t.Fatalf("stale run lost its frozen audit generation: state=%s generation=%v", storedState, frozenGeneration)
	}
}

func TestV3IndexFailureRequiresExplicitRetry(t *testing.T) {
	h := newV3Harness(t)
	itemID := seedV3Knowledge(t, h.database, "失败索引", "需要人工重试的向量", "normal")
	if _, err := h.database.Exec(context.Background(), `
		UPDATE assistant_embedding_config SET base_url = 'https://embed.example/v1',
		       api_key_ciphertext = NULL, model_id = 'mock-embed', display_name = '向量',
		       dimensions = 4, enabled = true, generation = 1, status = 'indexing', updated_at = now()
		WHERE singleton
	`); err != nil {
		t.Fatal(err)
	}
	h.assistant.RunOnce(context.Background())
	var fragmentID uuid.UUID
	if err := h.database.QueryRow(context.Background(),
		`SELECT id FROM search_fragments WHERE item_id = $1`, itemID).Scan(&fragmentID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec(context.Background(), `
		UPDATE assistant_fragment_embeddings SET state = 'failed', attempt = 2,
		       error_code = 'EMBEDDING_PROVIDER_UNAVAILABLE', error_detail = 'synthetic failure',
		       updated_at = now()
		WHERE fragment_id = $1
	`, fragmentID); err != nil {
		t.Fatal(err)
	}
	h.assistant.RunOnce(context.Background())
	var state string
	if err := h.database.QueryRow(context.Background(), `
		SELECT state FROM assistant_fragment_embeddings WHERE fragment_id = $1
	`, fragmentID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "failed" {
		t.Fatalf("reconciler silently requeued a failed fragment: %s", state)
	}

	list := h.get(t, "/api/v1/assistant/index-failures")
	assertStatus(t, list, http.StatusOK)
	var failures struct {
		Items []struct {
			FragmentID uuid.UUID `json:"fragmentId"`
			ErrorCode  string    `json:"errorCode"`
		} `json:"items"`
	}
	if err := json.NewDecoder(list.Body).Decode(&failures); err != nil {
		t.Fatal(err)
	}
	list.Body.Close()
	if len(failures.Items) != 1 || failures.Items[0].FragmentID != fragmentID ||
		failures.Items[0].ErrorCode != "EMBEDDING_PROVIDER_UNAVAILABLE" {
		t.Fatalf("unexpected first failure page: %+v", failures.Items)
	}
	retry := h.post(t, "/api/v1/assistant/index-failures/"+fragmentID.String()+"/retry", map[string]any{})
	assertStatus(t, retry, http.StatusAccepted)
	retry.Body.Close()
	if err := h.database.QueryRow(context.Background(), `
		SELECT state FROM assistant_fragment_embeddings WHERE fragment_id = $1
	`, fragmentID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "pending" {
		t.Fatalf("explicit retry did not reset the fragment: %s", state)
	}
	if _, err := h.database.Exec(context.Background(), `
		UPDATE assistant_fragment_embeddings SET state = 'failed',
		       error_code = 'EMBEDDING_PROVIDER_UNAVAILABLE', error_detail = 'second synthetic failure'
		WHERE fragment_id = $1
	`, fragmentID); err != nil {
		t.Fatal(err)
	}
	deleted := h.delete(t, "/api/v1/assistant/embedding-settings", nil)
	assertStatus(t, deleted, http.StatusNoContent)
	deleted.Body.Close()
	var errorCode *string
	if err := h.database.QueryRow(context.Background(), `
		SELECT state, error_code FROM assistant_fragment_embeddings WHERE fragment_id = $1
	`, fragmentID).Scan(&state, &errorCode); err != nil {
		t.Fatal(err)
	}
	if state != "excluded" || errorCode != nil {
		t.Fatalf("deleting embedding settings left a failure row behind: state=%s error=%v", state, errorCode)
	}
}

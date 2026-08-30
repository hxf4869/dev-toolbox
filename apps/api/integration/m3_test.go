//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/ai"
	artifactcontract "github.com/hxf4869/dev-toolbox/apps/api/internal/ai/schema"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/knowledge"
)

const (
	m3ProviderKey   = "synthetic-provider-secret"
	m3InternalToken = "synthetic-internal-service-token"
)

type m3TokenResponse struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Prefix    string    `json:"tokenPrefix"`
	Scopes    []string  `json:"scopes"`
	Token     string    `json:"token"`
	CreatedAt time.Time `json:"createdAt"`
}

type m3ProviderResponse struct {
	ID          uuid.UUID `json:"id"`
	ProviderKey string    `json:"providerKey"`
	DisplayName string    `json:"displayName"`
	Protocol    string    `json:"protocol"`
	BaseURL     string    `json:"baseUrl"`
	HasAPIKey   bool      `json:"hasApiKey"`
	APIKeyMask  *string   `json:"apiKeyMask"`
	Models      []struct {
		ID uuid.UUID `json:"id"`
	} `json:"models"`
}

type m3WorkerCapture struct {
	mu            sync.Mutex
	calls         int
	authorization string
	request       []byte
}

func TestM3ProviderPATAndExternalArtifact(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	assertTestDatabase(t, databaseURL)
	ctx := context.Background()
	database, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	resetM3Database(t, database)
	defer resetM3Database(t, database)

	capture := &m3WorkerCapture{}
	worker := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(request.Body, 128*1024))
		capture.mu.Lock()
		capture.calls++
		call := capture.calls
		capture.authorization = request.Header.Get("Authorization")
		capture.request = append([]byte(nil), body...)
		capture.mu.Unlock()

		response.Header().Set("Content-Type", "application/json")
		switch call {
		case 1:
			response.WriteHeader(http.StatusOK)
			_, _ = response.Write([]byte(`{"status":"ok","latencyMs":4,"usage":{"inputTokens":1,"outputTokens":1}}`))
		case 2:
			response.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = response.Write([]byte(`{"status":"failed","latencyMs":2,"usage":null,"failureCategory":"credentials_invalid"}`))
		default:
			response.WriteHeader(http.StatusOK)
			_, _ = response.Write([]byte(`{"status":"ok","latencyMs":1,"usage":null} {}`))
		}
	}))
	defer worker.Close()

	server, client, csrf := newAuthenticatedM3Server(t, database, t.TempDir(), worker.URL)
	defer server.Close()
	patClient := &http.Client{Transport: client.Transport}

	providerResponse := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers", map[string]any{
		"providerKey": "local-openai",
		"displayName": "本地 OpenAI Mock",
		"protocol":    "openai-completions",
		"baseUrl":     "https://provider.example.test/gateway/v1/",
		"apiKey":      m3ProviderKey,
		"models": []map[string]any{{
			"modelId": "mock-model", "displayName": "Mock Model", "contextWindow": 8192,
			"maxOutputTokens": 1024, "supportsTools": true, "supportsVision": true,
		}},
	}, csrf)
	assertStatus(t, providerResponse, http.StatusCreated)
	providerBody := readResponse(t, providerResponse)
	if bytes.Contains(providerBody, []byte(m3ProviderKey)) || bytes.Contains(providerBody, []byte(`"apiKey"`)) {
		t.Fatal("provider create response exposed the API key")
	}
	var provider m3ProviderResponse
	decodeInto(t, providerBody, &provider)
	if provider.ProviderKey != "local-openai" || provider.BaseURL != "https://provider.example.test/gateway/v1" ||
		!provider.HasAPIKey || provider.APIKeyMask == nil || len(provider.Models) != 1 {
		t.Fatalf("unexpected provider response: %+v", provider)
	}
	modelID := provider.Models[0].ID
	clearedLimits := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/ai/models/"+modelID.String(), map[string]any{
		"contextWindow": nil, "maxOutputTokens": nil,
	}, csrf)
	assertStatus(t, clearedLimits, http.StatusOK)
	if body := readResponse(t, clearedLimits); !bytes.Contains(body, []byte(`"contextWindow":null`)) || !bytes.Contains(body, []byte(`"maxOutputTokens":null`)) {
		t.Fatalf("model limits could not be cleared to unknown: %s", body)
	}
	restoredLimits := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/ai/models/"+modelID.String(), map[string]any{
		"contextWindow": 8192, "maxOutputTokens": 1024,
	}, csrf)
	assertStatus(t, restoredLimits, http.StatusOK)
	_ = readResponse(t, restoredLimits)

	var ciphertext []byte
	if err := database.QueryRow(ctx, "SELECT api_key_ciphertext FROM provider_configs WHERE id = $1", provider.ID).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte(m3ProviderKey)) || len(ciphertext) <= len(m3ProviderKey) {
		t.Fatal("provider key was not stored as a versioned encrypted envelope")
	}
	providers := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/ai/providers", nil, "", ""))
	assertStatus(t, providers, http.StatusOK)
	if body := readResponse(t, providers); bytes.Contains(body, []byte(m3ProviderKey)) || bytes.Contains(body, []byte(`"apiKey"`)) {
		t.Fatal("provider list exposed the API key")
	}

	wrongModel := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers/"+provider.ID.String()+"/test", map[string]any{
		"modelId": uuid.New().String(),
	}, csrf)
	assertStatus(t, wrongModel, http.StatusUnprocessableEntity)
	assertWorkerCalls(t, capture, 0)

	testOK := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers/"+provider.ID.String()+"/test", map[string]any{
		"modelId": modelID.String(),
	}, csrf)
	assertStatus(t, testOK, http.StatusOK)
	if body := readResponse(t, testOK); !bytes.Contains(body, []byte(`"status":"ok"`)) || bytes.Contains(body, []byte(m3ProviderKey)) {
		t.Fatalf("unsafe provider test response: %s", body)
	}
	assertWorkerCalls(t, capture, 1)
	assertWorkerSnapshot(t, capture)

	credentials := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers/"+provider.ID.String()+"/test", map[string]any{
		"modelId": modelID.String(),
	}, csrf)
	assertStatus(t, credentials, http.StatusUnprocessableEntity)
	if body := readResponse(t, credentials); !bytes.Contains(body, []byte("AI_PROVIDER_CREDENTIALS_INVALID")) || bytes.Contains(body, []byte(m3ProviderKey)) {
		t.Fatalf("unsafe provider credentials response: %s", body)
	}
	malformed := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers/"+provider.ID.String()+"/test", map[string]any{
		"modelId": modelID.String(),
	}, csrf)
	assertStatus(t, malformed, http.StatusServiceUnavailable)
	if body := readResponse(t, malformed); !bytes.Contains(body, []byte("AI_PROVIDER_UNAVAILABLE")) {
		t.Fatalf("unexpected malformed worker mapping: %s", body)
	}
	assertWorkerCalls(t, capture, 3)

	agent := createM3Token(t, client, server.URL, csrf, "迁移 Agent", []string{
		"records:read", "records:write", "attachments:read", "artifacts:write", "tasks:run",
	})
	if !strings.HasPrefix(agent.Token, "dtb_pat_") || !strings.HasPrefix(agent.Prefix, "dtb_pat_") {
		t.Fatalf("unexpected PAT shape: %+v", agent)
	}
	var tokenHash []byte
	if err := database.QueryRow(ctx, "SELECT token_hash FROM personal_access_tokens WHERE id = $1", agent.ID).Scan(&tokenHash); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(tokenHash, []byte(agent.Token)) || len(tokenHash) != 32 {
		t.Fatal("PAT plaintext was persisted")
	}
	tokens := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/tokens", nil, "", ""))
	assertStatus(t, tokens, http.StatusOK)
	if body := readResponse(t, tokens); bytes.Contains(body, []byte(agent.Token)) || bytes.Contains(body, []byte(`"token"`)) {
		t.Fatal("PAT list repeated the once-only plaintext")
	}
	conflictRequest := newRequest(t, http.MethodGet, server.URL+"/api/v1/items", nil, "", "")
	conflictRequest.Header.Set("Authorization", "Bearer "+agent.Token)
	conflict := doRequest(t, client, conflictRequest)
	assertStatus(t, conflict, http.StatusBadRequest)
	if body := readResponse(t, conflict); !bytes.Contains(body, []byte("AUTH_METHOD_CONFLICT")) {
		t.Fatalf("cookie and bearer conflict was not explicit: %s", body)
	}

	patSettings := sendM3PATJSON(t, patClient, http.MethodGet, server.URL+"/api/v1/ai/settings", nil, agent.Token, "")
	assertStatus(t, patSettings, http.StatusForbidden)
	patMetadataPatch := sendM3PATJSON(t, patClient, http.MethodPatch, server.URL+"/api/v1/items/"+uuid.NewString(), map[string]any{"favorite": true}, agent.Token, "")
	assertStatus(t, patMetadataPatch, http.StatusForbidden)

	createPayload := map[string]any{
		"body": "migration-source-original-8421", "contentFormat": "plain_text", "sensitivity": "normal",
		"source": map[string]any{
			"sourceType": "notion_migration", "externalId": "notion:page-8421", "path": "Runbooks/Storage",
			"createdAt": "2025-01-02T03:04:05Z", "timeQuality": "exact",
			"metadata": map[string]any{"sourceApplication": "Synthetic Notion Export", "sequence": 1},
		},
	}
	created := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/items", createPayload, agent.Token, "agent-create-0001")
	assertStatus(t, created, http.StatusCreated)
	normalItem := decodeResponse[apiResponse](t, created)
	createPayload["body"] = "must-not-overwrite-original"
	repeated := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/items", createPayload, agent.Token, "agent-create-0002")
	assertStatus(t, repeated, http.StatusCreated)
	repeatedItem := decodeResponse[apiResponse](t, repeated)
	if repeatedItem.Item.ID != normalItem.Item.ID || repeatedItem.RawRecord.ID != normalItem.RawRecord.ID {
		t.Fatal("stable source identity created a duplicate raw record")
	}
	var rawBody string
	var sourceCount int
	if err := database.QueryRow(ctx, `
		SELECT min(body), count(*) FROM raw_records
		WHERE source_type = 'notion_migration' AND source_external_id = 'notion:page-8421'
	`).Scan(&rawBody, &sourceCount); err != nil {
		t.Fatal(err)
	}
	if sourceCount != 1 || rawBody != "migration-source-original-8421" {
		t.Fatalf("source replay changed raw facts: count=%d body=%q", sourceCount, rawBody)
	}

	rawRead := sendM3PATJSON(t, patClient, http.MethodGet, server.URL+"/api/v1/items/"+normalItem.Item.ID.String()+"/raw-records/"+normalItem.RawRecord.ID.String(), nil, agent.Token, "")
	assertStatus(t, rawRead, http.StatusOK)
	if body := readResponse(t, rawRead); !bytes.Contains(body, []byte("migration-source-original-8421")) {
		t.Fatalf("authorized PAT did not receive normal raw text: %s", body)
	}
	attachmentBytes := []byte("synthetic normal attachment for PAT scope checks")
	normalAttachment := sendM3PATMultipart(t, patClient,
		server.URL+"/api/v1/items/"+normalItem.Item.ID.String()+"/raw-records:multipart",
		map[string]any{
			"body": "", "contentFormat": "plain_text", "sensitivity": "normal",
			"relation": map[string]any{"type": "supplements", "targetRawRecordId": normalItem.RawRecord.ID.String()},
			"source":   map[string]any{"sourceType": "api", "externalId": "api:attachment-normal-8421", "timeQuality": "unknown"},
		}, "normal.txt", "text/plain", attachmentBytes, agent.Token, "agent-attachment-normal-0001")
	assertStatus(t, normalAttachment, http.StatusCreated)
	normalAttachmentResult := decodeResponse[apiResponse](t, normalAttachment)
	if len(normalAttachmentResult.Attachments) != 1 {
		t.Fatalf("PAT supplement attachment missing: %+v", normalAttachmentResult.Attachments)
	}
	normalAttachmentID := normalAttachmentResult.Attachments[0].ID
	normalDownload := sendM3PATJSON(t, patClient, http.MethodGet,
		server.URL+"/api/v1/attachments/"+normalAttachmentID.String()+"/content", nil, agent.Token, "")
	assertStatus(t, normalDownload, http.StatusOK)
	if body := readResponse(t, normalDownload); !bytes.Equal(body, attachmentBytes) {
		t.Fatal("authorized PAT attachment download changed bytes")
	}
	readWithoutAttachments := createM3Token(t, client, server.URL, csrf, "只读记录", []string{"records:read"})
	missingAttachmentScope := sendM3PATJSON(t, patClient, http.MethodGet,
		server.URL+"/api/v1/attachments/"+normalAttachmentID.String()+"/content", nil, readWithoutAttachments.Token, "")
	assertStatus(t, missingAttachmentScope, http.StatusForbidden)
	attachmentsWithoutRead := createM3Token(t, client, server.URL, csrf, "仅附件 scope", []string{"attachments:read"})
	missingRecordScope := sendM3PATJSON(t, patClient, http.MethodGet,
		server.URL+"/api/v1/attachments/"+normalAttachmentID.String()+"/content", nil, attachmentsWithoutRead.Token, "")
	assertStatus(t, missingRecordScope, http.StatusForbidden)

	const sensitiveBody = "sensitive-source-secret-7331"
	sensitiveCreated := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/items", map[string]any{
		"body": sensitiveBody, "contentFormat": "plain_text", "sensitivity": "sensitive",
		"source": map[string]any{"sourceType": "api", "externalId": "api:sensitive-7331", "timeQuality": "unknown"},
	}, agent.Token, "agent-sensitive-0001")
	assertStatus(t, sensitiveCreated, http.StatusCreated)
	sensitiveResponseBody := readResponse(t, sensitiveCreated)
	if bytes.Contains(sensitiveResponseBody, []byte(sensitiveBody)) {
		t.Fatal("sensitive create response echoed raw text")
	}
	var sensitiveItem apiResponse
	decodeInto(t, sensitiveResponseBody, &sensitiveItem)
	sensitiveRead := sendM3PATJSON(t, patClient, http.MethodGet, server.URL+"/api/v1/items/"+sensitiveItem.Item.ID.String()+"/raw-records/"+sensitiveItem.RawRecord.ID.String(), nil, agent.Token, "")
	assertStatus(t, sensitiveRead, http.StatusForbidden)
	sensitiveSearch := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/search", map[string]any{
		"q": "sensitive-source-secret-7331", "sort": "relevance", "limit": 30,
	}, agent.Token, "")
	assertStatus(t, sensitiveSearch, http.StatusOK)
	if body := readResponse(t, sensitiveSearch); bytes.Contains(body, []byte(sensitiveBody)) || !bytes.Contains(body, []byte(sensitiveItem.Item.ID.String())) {
		t.Fatalf("sensitive PAT search was not masked: %s", body)
	}
	sensitiveAttachment := sendM3PATMultipart(t, patClient,
		server.URL+"/api/v1/items/"+sensitiveItem.Item.ID.String()+"/raw-records:multipart",
		map[string]any{
			"body": "", "contentFormat": "plain_text", "sensitivity": "sensitive",
			"relation": map[string]any{"type": "supplements", "targetRawRecordId": sensitiveItem.RawRecord.ID.String()},
			"source":   map[string]any{"sourceType": "api", "externalId": "api:attachment-sensitive-7331", "timeQuality": "unknown"},
		}, "sensitive.txt", "text/plain", []byte("synthetic-sensitive-attachment"), agent.Token, "agent-attachment-sensitive-0001")
	assertStatus(t, sensitiveAttachment, http.StatusCreated)
	sensitiveAttachmentResult := decodeResponse[apiResponse](t, sensitiveAttachment)
	if len(sensitiveAttachmentResult.Attachments) != 1 {
		t.Fatalf("sensitive PAT supplement attachment missing: %+v", sensitiveAttachmentResult.Attachments)
	}
	sensitiveAttachmentID := sensitiveAttachmentResult.Attachments[0].ID
	sensitiveAttachmentDenied := sendM3PATJSON(t, patClient, http.MethodGet,
		server.URL+"/api/v1/attachments/"+sensitiveAttachmentID.String()+"/content", nil, agent.Token, "")
	assertStatus(t, sensitiveAttachmentDenied, http.StatusForbidden)
	sensitiveReader := createM3Token(t, client, server.URL, csrf, "敏感附件读取", []string{
		"records:read", "attachments:read", "sensitive:read",
	})
	sensitiveAttachmentAllowed := sendM3PATJSON(t, patClient, http.MethodGet,
		server.URL+"/api/v1/attachments/"+sensitiveAttachmentID.String()+"/content", nil, sensitiveReader.Token, "")
	assertStatus(t, sensitiveAttachmentAllowed, http.StatusOK)
	_ = readResponse(t, sensitiveAttachmentAllowed)

	sensitiveOnly := createM3Token(t, client, server.URL, csrf, "仅敏感附加门槛", []string{"sensitive:read"})
	insufficientRead := sendM3PATJSON(t, patClient, http.MethodGet, server.URL+"/api/v1/items", nil, sensitiveOnly.Token, "")
	assertStatus(t, insufficientRead, http.StatusForbidden)

	fragments := rawFragmentIDs(t, database, normalItem.Item.ID)
	if len(fragments) == 0 {
		t.Fatal("normal item has no source fragments")
	}
	artifactContent := validM3Artifact(fragments[0])
	artifactResponse := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/items/"+normalItem.Item.ID.String()+"/artifacts", map[string]any{
		"generator": "external_agent", "generatorName": "Synthetic Codex", "modelName": "fixture-model",
		"schemaVersion": "1.0", "sourceRawRecordIds": []string{normalItem.RawRecord.ID.String()}, "content": artifactContent,
	}, agent.Token, "")
	assertStatus(t, artifactResponse, http.StatusCreated)
	var artifact struct {
		ID     uuid.UUID `json:"id"`
		Active bool      `json:"active"`
	}
	decodeInto(t, readResponse(t, artifactResponse), &artifact)
	if artifact.ID == uuid.Nil || artifact.Active {
		t.Fatalf("external artifact was not stored as a candidate: %+v", artifact)
	}
	var artifactCount int
	if err := database.QueryRow(ctx, "SELECT count(*) FROM ai_artifacts WHERE item_id = $1", normalItem.Item.ID).Scan(&artifactCount); err != nil {
		t.Fatal(err)
	}
	invalidContent := validM3Artifact(uuid.New())
	invalidArtifact := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/items/"+normalItem.Item.ID.String()+"/artifacts", map[string]any{
		"generator": "external_agent", "generatorName": "Synthetic Codex", "modelName": "fixture-model",
		"schemaVersion": "1.0", "sourceRawRecordIds": []string{normalItem.RawRecord.ID.String()}, "content": invalidContent,
	}, agent.Token, "")
	assertStatus(t, invalidArtifact, http.StatusUnprocessableEntity)
	var artifactCountAfter int
	if err := database.QueryRow(ctx, "SELECT count(*) FROM ai_artifacts WHERE item_id = $1", normalItem.Item.ID).Scan(&artifactCountAfter); err != nil {
		t.Fatal(err)
	}
	if artifactCountAfter != artifactCount {
		t.Fatal("invalid source reference created an artifact")
	}

	sensitiveFragments := rawFragmentIDs(t, database, sensitiveItem.Item.ID)
	sensitiveArtifact := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/items/"+sensitiveItem.Item.ID.String()+"/artifacts", map[string]any{
		"generator": "external_agent", "generatorName": "Synthetic Codex", "modelName": "fixture-model",
		"schemaVersion": "1.0", "sourceRawRecordIds": []string{sensitiveItem.RawRecord.ID.String()}, "content": validM3Artifact(sensitiveFragments[0]),
	}, agent.Token, "")
	assertStatus(t, sensitiveArtifact, http.StatusForbidden)

	artifactList := sendM3PATJSON(t, patClient, http.MethodGet, server.URL+"/api/v1/items/"+normalItem.Item.ID.String()+"/artifacts", nil, agent.Token, "")
	assertStatus(t, artifactList, http.StatusOK)
	if body := readResponse(t, artifactList); !bytes.Contains(body, []byte(artifact.ID.String())) {
		t.Fatalf("candidate artifact missing from list: %s", body)
	}

	queued := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "organize_record", "itemId": normalItem.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "redact", "options": map[string]any{"includeRelatedRecords": false},
	}, agent.Token, "")
	assertStatus(t, queued, http.StatusCreated)
	var task struct {
		ID     uuid.UUID `json:"id"`
		Status string    `json:"status"`
	}
	decodeInto(t, readResponse(t, queued), &task)
	if task.Status != "queued" {
		t.Fatalf("unexpected task state: %+v", task)
	}
	taskRead := sendM3PATJSON(t, patClient, http.MethodGet, server.URL+"/api/v1/ai/tasks/"+task.ID.String(), nil, agent.Token, "")
	assertStatus(t, taskRead, http.StatusOK)
	_ = readResponse(t, taskRead)

	var hasLastUsedAt bool
	if err := database.QueryRow(ctx, "SELECT last_used_at IS NOT NULL FROM personal_access_tokens WHERE id = $1", agent.ID).Scan(&hasLastUsedAt); err != nil {
		t.Fatal(err)
	}
	if !hasLastUsedAt {
		t.Fatal("PAT last_used_at was not recorded")
	}
	revoke := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/tokens/"+agent.ID.String(), map[string]any{}, csrf)
	assertStatus(t, revoke, http.StatusNoContent)
	revokedUse := sendM3PATJSON(t, patClient, http.MethodGet, server.URL+"/api/v1/items", nil, agent.Token, "")
	assertStatus(t, revokedUse, http.StatusUnauthorized)

	expiring := createM3Token(t, client, server.URL, csrf, "即将过期", []string{"records:read"})
	if _, err := database.Exec(ctx, "UPDATE personal_access_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", expiring.ID); err != nil {
		t.Fatal(err)
	}
	expiredUse := sendM3PATJSON(t, patClient, http.MethodGet, server.URL+"/api/v1/items", nil, expiring.Token, "")
	assertStatus(t, expiredUse, http.StatusUnauthorized)
}

func newAuthenticatedM3Server(t *testing.T, database *pgxpool.Pool, attachmentRoot, workerURL string) (*httptest.Server, *http.Client, string) {
	server, client, csrf, _ := newAuthenticatedM3ServerWithService(t, database, attachmentRoot, workerURL)
	return server, client, csrf
}

func newAuthenticatedM3ServerWithService(t *testing.T, database *pgxpool.Pool, attachmentRoot, workerURL string) (*httptest.Server, *http.Client, string, *ai.Service) {
	t.Helper()
	password := "M3 correct horse 电池 staple"
	if err := auth.InitializeOwner(context.Background(), database, "owner", password, time.Now()); err != nil {
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
	aiService := ai.NewService(database, bytes.Repeat([]byte{9}, 32), validator, workerURL, m3InternalToken, attachmentRoot, false)
	router := http.NewServeMux()
	authService.RegisterRoutes(router)
	knowledgeService.RegisterRoutes(router, authService)
	aiService.RegisterRoutes(router, authService)
	server := httptest.NewTLSServer(router)
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
	return server, client, decodeResponse[apiResponse](t, confirm).CSRFToken, aiService
}

func createM3Token(t *testing.T, client *http.Client, baseURL, csrf, name string, scopes []string) m3TokenResponse {
	t.Helper()
	response := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/tokens", map[string]any{
		"name": name, "scopes": scopes,
	}, csrf)
	assertStatus(t, response, http.StatusCreated)
	return decodeResponse[m3TokenResponse](t, response)
}

func sendM3PATJSON(t *testing.T, client *http.Client, method, endpoint string, payload any, token, idempotencyKey string) *http.Response {
	t.Helper()
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	request := newRequest(t, method, endpoint, body, "", "")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	return doRequest(t, client, request)
}

func sendM3PATMultipart(
	t *testing.T,
	client *http.Client,
	endpoint string,
	metadata any,
	filename string,
	clientMediaType string,
	content []byte,
	token string,
	idempotencyKey string,
) *http.Response {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	metadataPart, err := writer.CreateFormField("metadata")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(metadataPart).Encode(metadata); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="files[]"; filename="%s"`, filename))
	header.Set("Content-Type", clientMediaType)
	filePart, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := filePart.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := newRequest(t, http.MethodPost, endpoint, &body, "", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Idempotency-Key", idempotencyKey)
	return doRequest(t, client, request)
}

func validM3Artifact(fragmentID uuid.UUID) map[string]any {
	fragments := []string{fragmentID.String()}
	return map[string]any{
		"schemaVersion": "1.0", "artifactType": "organized_record", "title": "合成整理结果",
		"summary": "仅用于本地集成测试的派生摘要。",
		"classification": map[string]any{
			"contentType": "reference", "suggestedFolderPath": []string{"测试"},
			"suggestedTags": []string{"fixture"}, "sensitivitySuggestion": "normal",
		},
		"blocks": []map[string]any{{
			"id": "summary", "type": "markdown", "markdown": "合成派生内容", "sourceFragmentIds": fragments,
		}},
		"warnings": []any{}, "sourceFragmentIds": fragments,
		"review": map[string]any{"status": "model_reviewed", "limitations": []string{"仅验证契约路径"}},
	}
}

func assertWorkerCalls(t *testing.T, capture *m3WorkerCapture, expected int) {
	t.Helper()
	capture.mu.Lock()
	defer capture.mu.Unlock()
	if capture.calls != expected {
		t.Fatalf("worker calls = %d, want %d", capture.calls, expected)
	}
}

func assertWorkerSnapshot(t *testing.T, capture *m3WorkerCapture) {
	t.Helper()
	capture.mu.Lock()
	defer capture.mu.Unlock()
	if capture.authorization != "Bearer "+m3InternalToken {
		t.Fatal("provider test did not use the internal service credential")
	}
	var payload struct {
		DeadlineAt time.Time `json:"deadlineAt"`
		Provider   struct {
			APIKey  string `json:"apiKey"`
			ModelID string `json:"modelId"`
			BaseURL string `json:"baseUrl"`
		} `json:"provider"`
	}
	if err := json.Unmarshal(capture.request, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Provider.APIKey != m3ProviderKey || payload.Provider.ModelID != "mock-model" ||
		payload.Provider.BaseURL != "https://provider.example.test/gateway/v1" {
		t.Fatal("provider test did not use the saved provider/model snapshot")
	}
	remaining := time.Until(payload.DeadlineAt)
	if remaining < 55*time.Second || remaining > 61*time.Second {
		t.Fatalf("provider test deadline remaining = %s, want about 60s", remaining)
	}
}

func resetM3Database(t *testing.T, database *pgxpool.Pool) {
	t.Helper()
	_, err := database.Exec(context.Background(), `
		TRUNCATE TABLE artifact_sources, item_active_artifacts, ai_artifacts, ai_task_events,
		ai_task_runs, app_settings, provider_models, provider_configs, personal_access_tokens,
		attachment_derivatives, raw_record_relations, item_tags, tags, folders,
		idempotency_records, search_fragments, attachments, raw_records, knowledge_items,
		auth_sessions, trusted_devices, mfa_recovery_codes, auth_challenges,
		security_events, owner_account CASCADE;
		INSERT INTO app_settings (singleton, updated_at) VALUES (true, now());
	`)
	if err != nil {
		t.Fatal(err)
	}
}

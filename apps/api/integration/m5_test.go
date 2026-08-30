//go:build integration

package integration_test

import (
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
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/ai"
	artifactcontract "github.com/hxf4869/dev-toolbox/apps/api/internal/ai/schema"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/knowledge"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/operations"
)

type m5WorkerState struct {
	mu        sync.Mutex
	testCalls int
}

type m5OperationsResponse struct {
	Version       string `json:"version"`
	SchemaVersion int    `json:"schemaVersion"`
	Overall       string `json:"overall"`
	CoreAvailable bool   `json:"coreAvailable"`
	Components    []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"components"`
	Providers []struct {
		ID              string     `json:"id"`
		Status          string     `json:"status"`
		LastTestedAt    *time.Time `json:"lastTestedAt"`
		LatencyMS       *int       `json:"latencyMs"`
		FailureCategory *string    `json:"failureCategory"`
	} `json:"providers"`
	Storage struct {
		Writable bool `json:"writable"`
	} `json:"storage"`
	Backup struct {
		State       string `json:"state"`
		SnapshotID  string `json:"snapshotId"`
		TargetLabel string `json:"targetLabel"`
	} `json:"backup"`
	Release struct {
		Checks []struct {
			Status string `json:"status"`
		} `json:"checks"`
	} `json:"release"`
}

func TestM5OperationsMigrationAndIntegrity(t *testing.T) {
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

	attachmentRoot := t.TempDir()
	statusRoot := t.TempDir()
	writeM5StatusFile(t, filepath.Join(statusRoot, "backup-status.json"), map[string]any{
		"state": "succeeded", "lastAttemptAt": "2026-08-30T04:00:00Z", "lastSuccessAt": "2026-08-30T04:00:00Z",
		"snapshotId": "m5-snapshot", "targetLabel": "异地测试仓库", "resticCheckAt": "2026-08-30T04:10:00Z", "errorCode": "",
	})
	workerState := &m5WorkerState{}
	worker := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodGet && request.URL.Path == "/health/live" {
			_, _ = response.Write([]byte(`{"status":"live"}`))
			return
		}
		if request.Method != http.MethodPost || request.URL.Path != "/internal/provider-test" {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(request.Body, 64*1024))
		if request.Header.Get("Authorization") != "Bearer "+m3InternalToken || !bytes.Contains(body, []byte("m5-synthetic-provider-key")) {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		workerState.mu.Lock()
		workerState.testCalls++
		call := workerState.testCalls
		workerState.mu.Unlock()
		if call == 1 {
			_, _ = response.Write([]byte(`{"status":"ok","latencyMs":7,"usage":null}`))
			return
		}
		response.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = response.Write([]byte(`{"status":"failed","latencyMs":9,"usage":null,"failureCategory":"credentials_invalid"}`))
	}))
	defer worker.Close()

	server, client, csrf := newAuthenticatedM5Server(t, database, attachmentRoot, statusRoot, worker.URL)
	defer server.Close()

	unauthenticated := &http.Client{Transport: client.Transport}
	privateStatus := doRequest(t, unauthenticated, newRequest(t, http.MethodGet, server.URL+"/api/v1/operations/status", nil, "", ""))
	assertStatus(t, privateStatus, http.StatusUnauthorized)
	_ = readResponse(t, privateStatus)

	providerResponse := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers", map[string]any{
		"providerKey": "m5-local", "displayName": "M5 Local Mock", "protocol": "openai-completions",
		"baseUrl": "https://provider.example.test/v1", "apiKey": "m5-synthetic-provider-key",
		"models": []map[string]any{{
			"modelId": "m5-model", "displayName": "M5 Model", "contextWindow": 8192,
			"maxOutputTokens": 1024, "supportsTools": true, "supportsVision": false,
		}},
	}, csrf)
	assertStatus(t, providerResponse, http.StatusCreated)
	provider := decodeResponse[m3ProviderResponse](t, providerResponse)
	if len(provider.Models) != 1 {
		t.Fatal("provider model was not created")
	}

	providerTest := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers/"+provider.ID.String()+"/test", map[string]any{
		"modelId": provider.Models[0].ID.String(),
	}, csrf)
	assertStatus(t, providerTest, http.StatusOK)
	_ = readResponse(t, providerTest)

	status := readM5OperationsStatus(t, client, server.URL)
	if status.Version != "v1.0.1" || status.SchemaVersion != operations.RequiredSchemaVersion || !status.CoreAvailable ||
		status.Overall != "healthy" || !status.Storage.Writable || status.Backup.State != "succeeded" ||
		status.Backup.SnapshotID != "m5-snapshot" || status.Backup.TargetLabel != "异地测试仓库" || len(status.Release.Checks) != 8 {
		t.Fatalf("unexpected healthy operations status: %+v", status)
	}
	if len(status.Providers) != 1 || status.Providers[0].Status != "healthy" || status.Providers[0].LastTestedAt == nil ||
		status.Providers[0].LatencyMS == nil || *status.Providers[0].LatencyMS != 7 || status.Providers[0].FailureCategory != nil {
		t.Fatalf("provider success was not persisted: %+v", status.Providers)
	}

	providerFailure := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers/"+provider.ID.String()+"/test", map[string]any{
		"modelId": provider.Models[0].ID.String(),
	}, csrf)
	assertStatus(t, providerFailure, http.StatusUnprocessableEntity)
	_ = readResponse(t, providerFailure)
	status = readM5OperationsStatus(t, client, server.URL)
	if !status.CoreAvailable || status.Overall != "degraded" || status.Providers[0].Status != "degraded" ||
		status.Providers[0].FailureCategory == nil || *status.Providers[0].FailureCategory != "credentials_invalid" {
		t.Fatalf("provider degradation crossed the core boundary: %+v", status)
	}

	rename := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/ai/providers/"+provider.ID.String(), map[string]any{
		"displayName": "M5 Renamed Mock",
	}, csrf)
	assertStatus(t, rename, http.StatusOK)
	var renamed struct {
		LastTestStatus *string `json:"lastTestStatus"`
	}
	decodeInto(t, readResponse(t, rename), &renamed)
	if renamed.LastTestStatus == nil || *renamed.LastTestStatus != "credentials_invalid" {
		t.Fatal("display-only provider update cleared its connection result")
	}
	connectivityChange := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/ai/providers/"+provider.ID.String(), map[string]any{
		"baseUrl": "https://provider.example.test/v2",
	}, csrf)
	assertStatus(t, connectivityChange, http.StatusOK)
	var changed struct {
		LastTestedAt   *time.Time `json:"lastTestedAt"`
		LastTestStatus *string    `json:"lastTestStatus"`
	}
	decodeInto(t, readResponse(t, connectivityChange), &changed)
	if changed.LastTestedAt != nil || changed.LastTestStatus != nil {
		t.Fatal("connectivity-changing provider update retained a stale test result")
	}

	attachmentBytes := []byte("m5 recovery attachment bytes")
	upload := sendMultipart(t, client, server.URL+"/api/v1/items:multipart", csrf, "m5-integrity-item", map[string]any{
		"body": "M5 integrity source", "contentFormat": "plain_text", "sensitivity": "normal",
		"title": "M5 integrity fixture", "folderId": nil, "tagIds": []string{},
	}, "recovery.bin", "application/octet-stream", attachmentBytes)
	assertStatus(t, upload, http.StatusCreated)
	uploaded := decodeResponse[apiResponse](t, upload)
	if len(uploaded.Attachments) != 1 {
		t.Fatal("integrity fixture attachment was not created")
	}
	var storageKey string
	if err := database.QueryRow(ctx, "SELECT storage_key FROM attachments WHERE id = $1", uploaded.Attachments[0].ID).Scan(&storageKey); err != nil {
		t.Fatal(err)
	}
	attachmentPath := filepath.Join(attachmentRoot, filepath.FromSlash(storageKey))
	orphanPath := filepath.Join(attachmentRoot, "blobs", "ff", "orphan")
	if err := os.MkdirAll(filepath.Dir(orphanPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orphanPath, []byte("orphan"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := operations.CheckIntegrity(ctx, database, attachmentRoot, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if report.State != "succeeded" || report.ReferencedAttachments != 1 || report.VerifiedAttachments != 1 ||
		len(report.OrphanAttachments) != 1 || report.OrphanAttachments[0].StorageKey != "blobs/ff/orphan" {
		t.Fatalf("unexpected valid integrity report: %+v", report)
	}
	if _, err := os.Stat(orphanPath); err != nil {
		t.Fatalf("integrity check deleted an orphan: %v", err)
	}
	if err := os.WriteFile(attachmentPath, bytes.Repeat([]byte{'x'}, len(attachmentBytes)), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err = operations.CheckIntegrity(ctx, database, attachmentRoot, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if report.State != "failed" || report.ChecksumMismatches != 1 || report.VerifiedAttachments != 0 {
		t.Fatalf("same-size corruption was not detected: %+v", report)
	}
	if err := os.WriteFile(attachmentPath, attachmentBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	var itemsBeforeFailure int
	if err := database.QueryRow(ctx, "SELECT count(*) FROM knowledge_items").Scan(&itemsBeforeFailure); err != nil {
		t.Fatal(err)
	}
	temporaryUploadRoot := filepath.Join(attachmentRoot, "tmp")
	if err := os.RemoveAll(temporaryUploadRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(temporaryUploadRoot, []byte("unavailable"), 0o600); err != nil {
		t.Fatal(err)
	}
	storageFailure := sendMultipart(t, client, server.URL+"/api/v1/items:multipart", csrf, "m5-storage-failure", map[string]any{
		"body": "must not persist", "contentFormat": "plain_text", "sensitivity": "normal",
		"title": "must not persist", "folderId": nil, "tagIds": []string{},
	}, "blocked.bin", "application/octet-stream", []byte("blocked"))
	assertStatus(t, storageFailure, http.StatusInternalServerError)
	if body := readResponse(t, storageFailure); bytes.Contains(body, []byte(temporaryUploadRoot)) || bytes.Contains(body, []byte("must not persist")) {
		t.Fatalf("storage failure leaked a path or request content: %s", body)
	}
	var itemsAfterFailure int
	if err := database.QueryRow(ctx, "SELECT count(*) FROM knowledge_items").Scan(&itemsAfterFailure); err != nil {
		t.Fatal(err)
	}
	if itemsAfterFailure != itemsBeforeFailure {
		t.Fatalf("storage failure left a half record: before=%d after=%d", itemsBeforeFailure, itemsAfterFailure)
	}
	if err := os.Remove(temporaryUploadRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(temporaryUploadRoot, 0o700); err != nil {
		t.Fatal(err)
	}

	ready := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/health/ready", nil, "", ""))
	assertStatus(t, ready, http.StatusOK)
	_ = readResponse(t, ready)
	if _, err := database.Exec(ctx, "UPDATE public.schema_version SET version = $1", operations.RequiredSchemaVersion-1); err != nil {
		t.Fatal(err)
	}
	stale := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/health/ready", nil, "", ""))
	assertStatus(t, stale, http.StatusServiceUnavailable)
	if body := readResponse(t, stale); bytes.Contains(body, []byte("schema_version")) || bytes.Contains(body, []byte("migration")) {
		t.Fatalf("readiness leaked migration details: %s", body)
	}
	if _, err := database.Exec(ctx, "UPDATE public.schema_version SET version = $1", operations.RequiredSchemaVersion); err != nil {
		t.Fatal(err)
	}
}

func TestM5FullAttachmentVolumeFailsAtomically(t *testing.T) {
	if os.Getenv("RUN_M5_FULL_STORAGE") != "1" {
		t.Skip("RUN_M5_FULL_STORAGE is not enabled")
	}
	attachmentRoot := os.Getenv("M5_FULL_STORAGE_ROOT")
	if attachmentRoot == "" {
		t.Fatal("M5_FULL_STORAGE_ROOT is not configured")
	}
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

	if err := os.MkdirAll(filepath.Join(attachmentRoot, "tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	server, client, csrf := newAuthenticatedM5Server(t, database, attachmentRoot, t.TempDir(), "http://127.0.0.1:1")
	defer server.Close()

	fillPath := filepath.Join(attachmentRoot, "full-volume.fixture")
	fill, err := os.OpenFile(fillPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(fillPath)
	block := make([]byte, 64*1024)
	for {
		written, writeErr := fill.Write(block)
		if errors.Is(writeErr, syscall.ENOSPC) {
			break
		}
		if writeErr != nil {
			t.Fatalf("filling isolated tmpfs returned %v, want ENOSPC", writeErr)
		}
		if written != len(block) {
			t.Fatalf("filling isolated tmpfs made a short write without ENOSPC: %d", written)
		}
	}
	_ = fill.Close()

	var itemsBefore int
	if err := database.QueryRow(ctx, "SELECT count(*) FROM knowledge_items").Scan(&itemsBefore); err != nil {
		t.Fatal(err)
	}
	response := sendMultipart(t, client, server.URL+"/api/v1/items:multipart", csrf, "m5-enospc", map[string]any{
		"body": "must not persist on ENOSPC", "contentFormat": "plain_text", "sensitivity": "normal",
		"title": "must not persist on ENOSPC", "folderId": nil, "tagIds": []string{},
	}, "full.bin", "application/octet-stream", []byte("bounded synthetic attachment"))
	assertStatus(t, response, http.StatusInternalServerError)
	body := readResponse(t, response)
	if bytes.Contains(body, []byte(attachmentRoot)) || bytes.Contains(body, []byte("must not persist")) {
		t.Fatalf("ENOSPC response leaked a path or request content: %s", body)
	}
	var itemsAfter int
	if err := database.QueryRow(ctx, "SELECT count(*) FROM knowledge_items").Scan(&itemsAfter); err != nil {
		t.Fatal(err)
	}
	if itemsAfter != itemsBefore {
		t.Fatalf("ENOSPC left a half record: before=%d after=%d", itemsBefore, itemsAfter)
	}
	entries, err := os.ReadDir(filepath.Join(attachmentRoot, "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("ENOSPC left temporary upload files: %v", entries)
	}
}

func newAuthenticatedM5Server(
	t *testing.T,
	database *pgxpool.Pool,
	attachmentRoot, statusRoot, workerURL string,
) (*httptest.Server, *http.Client, string) {
	t.Helper()
	password := "M5 correct horse 电池 staple"
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
	operations.RegisterRoutes(router, database)
	authService.RegisterRoutes(router)
	knowledgeService.RegisterRoutes(router, authService)
	aiService.RegisterRoutes(router, authService)
	operations.NewStatusService(database, attachmentRoot, statusRoot, workerURL, "v1.0.1").RegisterRoutes(router, authService)
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
	return server, client, decodeResponse[apiResponse](t, confirm).CSRFToken
}

func readM5OperationsStatus(t *testing.T, client *http.Client, baseURL string) m5OperationsResponse {
	t.Helper()
	response := doRequest(t, client, newRequest(t, http.MethodGet, baseURL+"/api/v1/operations/status", nil, "", ""))
	assertStatus(t, response, http.StatusOK)
	assertNoStore(t, response)
	body := readResponse(t, response)
	for _, forbidden := range [][]byte{[]byte("m5-synthetic-provider-key"), []byte(`"apiKey"`), []byte("Authorization"), []byte("M5 integrity source")} {
		if bytes.Contains(body, forbidden) {
			t.Fatalf("operations status leaked a secret or user content: %s", body)
		}
	}
	var result m5OperationsResponse
	decodeInto(t, body, &result)
	return result
}

func writeM5StatusFile(t *testing.T, path string, value any) {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}

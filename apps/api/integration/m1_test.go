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
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/knowledge"
)

const testOrigin = "https://m1.dev-toolbox.test"

type apiResponse struct {
	Status        string   `json:"status"`
	ChallengeID   string   `json:"challengeId"`
	CSRFToken     string   `json:"csrfToken"`
	RecoveryCodes []string `json:"recoveryCodes"`
	ManualKey     string   `json:"manualKey"`
	ProvisionURI  string   `json:"provisioningUri"`
	QRCodeDataURL string   `json:"qrCodeDataUrl"`
	Item          struct {
		ID          uuid.UUID `json:"id"`
		Title       string    `json:"title"`
		Sensitivity string    `json:"sensitivity"`
	} `json:"item"`
	RawRecord struct {
		ID       uuid.UUID `json:"id"`
		ReadOnly bool      `json:"readOnly"`
	} `json:"rawRecord"`
	Attachments []struct {
		ID          uuid.UUID `json:"id"`
		Kind        string    `json:"kind"`
		DisplayName string    `json:"displayName"`
		MediaType   string    `json:"mediaType"`
		SizeBytes   int64     `json:"sizeBytes"`
		ContentURL  string    `json:"contentUrl"`
	} `json:"attachments"`
}

func TestM1AuthenticationCaptureAndRecovery(t *testing.T) {
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
	resetDatabase(t, database)
	defer resetDatabase(t, database)

	password := "  Correct horse 电池 staple  "
	newPassword := "New correct horse 电池 staple"
	if err := auth.InitializeOwner(ctx, database, "owner", password, time.Now()); err != nil {
		t.Fatal(err)
	}
	attachmentRoot := t.TempDir()
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	server := newM1Server(t, database, attachmentRoot, location)
	defer func() { server.Close() }()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := server.Client()
	client.Jar = jar

	login := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{
		"username": "owner", "password": password,
	}, "")
	assertStatus(t, login, http.StatusAccepted)
	loginBody := decodeResponse[apiResponse](t, login)
	if loginBody.Status != "mfa_setup_required" || loginBody.ChallengeID == "" {
		t.Fatalf("unexpected initial login response: %+v", loginBody)
	}

	setup := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/setup", map[string]any{"challengeId": loginBody.ChallengeID}, "")
	assertStatus(t, setup, http.StatusOK)
	assertNoStore(t, setup)
	provisioning := decodeResponse[apiResponse](t, setup)
	setupAgain := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/setup", map[string]any{"challengeId": loginBody.ChallengeID}, "")
	assertStatus(t, setupAgain, http.StatusOK)
	repeated := decodeResponse[apiResponse](t, setupAgain)
	if provisioning.ManualKey == "" || repeated.ManualKey != provisioning.ManualKey || repeated.ProvisionURI != provisioning.ProvisionURI {
		t.Fatal("repeated TOTP setup did not preserve the pending secret")
	}
	if !strings.HasPrefix(provisioning.QRCodeDataURL, "data:image/png;base64,") {
		t.Fatal("TOTP setup did not return a local QR code")
	}

	code, err := totp.GenerateCode(provisioning.ManualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	confirm := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/confirm", map[string]any{
		"challengeId": loginBody.ChallengeID, "code": code, "trustDevice": true, "deviceName": "集成测试浏览器",
	}, "")
	assertStatus(t, confirm, http.StatusOK)
	assertNoStore(t, confirm)
	assertSecureCookies(t, confirm)
	authenticated := decodeResponse[apiResponse](t, confirm)
	if authenticated.Status != "authenticated" || authenticated.CSRFToken == "" || len(authenticated.RecoveryCodes) != 10 {
		t.Fatalf("unexpected TOTP confirmation response: %+v", authenticated)
	}
	csrf := authenticated.CSRFToken
	var activeSessionID uuid.UUID
	if err := database.QueryRow(ctx, "SELECT id FROM auth_sessions ORDER BY created_at DESC LIMIT 1").Scan(&activeSessionID); err != nil {
		t.Fatal(err)
	}
	staleLastSeen := time.Now().UTC().Add(-10 * time.Minute)
	if _, err := database.Exec(ctx, "UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1", activeSessionID, staleLastSeen); err != nil {
		t.Fatal(err)
	}
	refreshStartedAt := time.Now().UTC()
	refreshedSession := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/auth/session", nil, "", ""))
	assertStatus(t, refreshedSession, http.StatusOK)
	_ = readResponse(t, refreshedSession)
	var refreshedLastSeen time.Time
	if err := database.QueryRow(ctx, "SELECT last_seen_at FROM auth_sessions WHERE id = $1", activeSessionID).Scan(&refreshedLastSeen); err != nil {
		t.Fatal(err)
	}
	if refreshedLastSeen.Before(refreshStartedAt.Add(-time.Second)) {
		t.Fatalf("active session last_seen_at was not refreshed: got %s, request started at %s", refreshedLastSeen, refreshStartedAt)
	}

	conflict := newRequest(t, http.MethodGet, server.URL+"/api/v1/auth/session", nil, "", "")
	conflict.Header.Set("Authorization", "Bearer should-not-coexist")
	assertStatus(t, doRequest(t, client, conflict), http.StatusBadRequest)
	withoutCSRF := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/items", map[string]any{
		"body": "blocked", "contentFormat": "plain_text", "sensitivity": "normal", "folderId": nil, "tagIds": []string{},
	}, "")
	assertStatus(t, withoutCSRF, http.StatusForbidden)

	body := "# 挂载磁盘\n\nlsblk\n<script>alert('raw only')</script>\n"
	created := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items", map[string]any{
		"body": body, "contentFormat": "markdown", "sensitivity": "normal", "title": nil, "folderId": nil, "tagIds": []string{},
	}, csrf, "capture-00000001")
	assertStatus(t, created, http.StatusCreated)
	createdBody := decodeResponse[apiResponse](t, created)
	if createdBody.Item.ID == uuid.Nil || createdBody.RawRecord.ID == uuid.Nil || !createdBody.RawRecord.ReadOnly {
		t.Fatalf("unexpected create response: %+v", createdBody)
	}
	repeatedCreate := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items", map[string]any{
		"body": "this different body must not be compared or saved", "contentFormat": "plain_text", "sensitivity": "normal", "folderId": nil, "tagIds": []string{},
	}, csrf, "capture-00000001")
	assertStatus(t, repeatedCreate, http.StatusOK)
	repeatedCreateBody := decodeResponse[apiResponse](t, repeatedCreate)
	if repeatedCreateBody.Item.ID != createdBody.Item.ID || repeatedCreateBody.RawRecord.ID != createdBody.RawRecord.ID {
		t.Fatal("idempotent retry returned different resources")
	}

	detail := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items/"+createdBody.Item.ID.String(), nil, "", ""))
	assertStatus(t, detail, http.StatusOK)
	detailBytes := readResponse(t, detail)
	if bytes.Contains(detailBytes, []byte("\"body\"")) || bytes.Contains(detailBytes, []byte("raw only")) {
		t.Fatal("item detail leaked the immutable raw body")
	}
	raw := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items/"+createdBody.Item.ID.String()+"/raw-records/"+createdBody.RawRecord.ID.String(), nil, "", ""))
	assertStatus(t, raw, http.StatusOK)
	assertNoStore(t, raw)
	var rawPayload struct {
		Body     string `json:"body"`
		ReadOnly bool   `json:"readOnly"`
	}
	decodeInto(t, readResponse(t, raw), &rawPayload)
	if rawPayload.Body != body || !rawPayload.ReadOnly {
		t.Fatal("raw record did not preserve the exact source text")
	}
	rawPatch := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/items/"+createdBody.Item.ID.String()+"/raw-records/"+createdBody.RawRecord.ID.String(), map[string]any{"body": "overwrite"}, csrf)
	assertStatus(t, rawPatch, http.StatusMethodNotAllowed)

	server.Close()
	server = newM1Server(t, database, attachmentRoot, location)
	client = server.Client()
	client.Jar = jar
	restartedSession := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/auth/session", nil, "", ""))
	assertStatus(t, restartedSession, http.StatusOK)
	restartedRaw := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/items/"+createdBody.Item.ID.String()+"/raw-records/"+createdBody.RawRecord.ID.String(), nil, "", ""))
	assertStatus(t, restartedRaw, http.StatusOK)
	var restartedPayload struct {
		Body string `json:"body"`
	}
	decodeInto(t, readResponse(t, restartedRaw), &restartedPayload)
	if restartedPayload.Body != body {
		t.Fatal("raw record changed after API restart")
	}
	trustedRelogin := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{"username": "owner", "password": password}, "")
	assertStatus(t, trustedRelogin, http.StatusOK)
	csrf = decodeResponse[apiResponse](t, trustedRelogin).CSRFToken
	listedSessions := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/auth/sessions", nil, "", ""))
	assertStatus(t, listedSessions, http.StatusOK)
	var sessionList struct {
		Items []struct {
			ID      uuid.UUID `json:"id"`
			Current bool      `json:"current"`
		} `json:"items"`
	}
	decodeInto(t, readResponse(t, listedSessions), &sessionList)
	var previousSessionID uuid.UUID
	for _, candidate := range sessionList.Items {
		if !candidate.Current {
			previousSessionID = candidate.ID
			break
		}
	}
	if previousSessionID == uuid.Nil {
		t.Fatalf("expected a previous session after trusted-device relogin: %+v", sessionList.Items)
	}
	revokeSession := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/auth/sessions/"+previousSessionID.String(), map[string]any{}, csrf)
	assertStatus(t, revokeSession, http.StatusNoContent)

	htmlFile := []byte("<!doctype html><script>document.body.textContent='executed'</script>")
	upload := sendMultipart(t, client, server.URL+"/api/v1/items:multipart", csrf, "capture-00000002", map[string]any{
		"body": "", "contentFormat": "plain_text", "sensitivity": "sensitive", "title": nil, "folderId": nil, "tagIds": []string{},
	}, "../../evil.html", "image/png", htmlFile)
	assertStatus(t, upload, http.StatusCreated)
	uploaded := decodeResponse[apiResponse](t, upload)
	if len(uploaded.Attachments) != 1 || uploaded.Attachments[0].Kind != "file" || !strings.HasPrefix(uploaded.Attachments[0].MediaType, "text/html") {
		t.Fatalf("server media detection was not authoritative: %+v", uploaded.Attachments)
	}
	if uploaded.Item.Sensitivity != "sensitive" || !strings.HasPrefix(uploaded.Item.Title, "敏感记录 ·") {
		t.Fatal("sensitive attachment-only capture did not receive a safe generated title")
	}
	attachmentID := uploaded.Attachments[0].ID
	metadata := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/attachments/"+attachmentID.String()+"/metadata", nil, "", ""))
	assertStatus(t, metadata, http.StatusOK)
	assertNoStore(t, metadata)
	download := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/attachments/"+attachmentID.String()+"/content", nil, "", ""))
	assertStatus(t, download, http.StatusOK)
	assertNoStore(t, download)
	if !strings.HasPrefix(download.Header.Get("Content-Disposition"), "attachment") || download.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("unsafe attachment response headers")
	}
	if downloadedBytes := readResponse(t, download); !bytes.Equal(downloadedBytes, htmlFile) {
		t.Fatal("downloaded attachment bytes changed")
	}
	var storageKey, originalName string
	if err := database.QueryRow(ctx, "SELECT storage_key, original_name FROM attachments WHERE id = $1", attachmentID).Scan(&storageKey, &originalName); err != nil {
		t.Fatal(err)
	}
	if originalName != "evil.html" || !strings.HasPrefix(storageKey, "blobs/") || strings.Contains(storageKey, "evil") {
		t.Fatalf("unsafe attachment storage mapping: %q / %q", originalName, storageKey)
	}
	info, err := os.Stat(filepath.Join(attachmentRoot, filepath.FromSlash(storageKey)))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("attachment permissions = %v, %v", info, err)
	}

	devices := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/auth/trusted-devices", nil, "", ""))
	assertStatus(t, devices, http.StatusOK)
	var deviceList struct {
		Items []struct {
			ID uuid.UUID `json:"id"`
		} `json:"items"`
	}
	decodeInto(t, readResponse(t, devices), &deviceList)
	if len(deviceList.Items) != 1 {
		t.Fatalf("trusted device count = %d", len(deviceList.Items))
	}
	rename := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/auth/trusted-devices/"+deviceList.Items[0].ID.String(), map[string]any{"displayName": "工作浏览器"}, csrf)
	assertStatus(t, rename, http.StatusOK)
	logout := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/logout", map[string]any{}, csrf)
	assertStatus(t, logout, http.StatusNoContent)
	for _, cookie := range logout.Header.Values("Set-Cookie") {
		if strings.HasPrefix(cookie, "__Host-dev-toolbox-trusted-device=") {
			t.Fatal("ordinary logout unexpectedly cleared the trusted-device cookie")
		}
	}
	trustedLogin := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{"username": "owner", "password": password}, "")
	assertStatus(t, trustedLogin, http.StatusOK)
	trustedBody := decodeResponse[apiResponse](t, trustedLogin)
	csrf = trustedBody.CSRFToken
	wrongPassword := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{"username": "owner", "password": "wrong password value"}, "")
	assertStatus(t, wrongPassword, http.StatusUnauthorized)

	revoke := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/auth/trusted-devices/"+deviceList.Items[0].ID.String(), map[string]any{}, csrf)
	assertStatus(t, revoke, http.StatusNoContent)
	assertStatus(t, sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/logout", map[string]any{}, csrf), http.StatusNoContent)
	recoveryLogin := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{"username": "owner", "password": password}, "")
	assertStatus(t, recoveryLogin, http.StatusAccepted)
	recoveryChallenge := decodeResponse[apiResponse](t, recoveryLogin).ChallengeID
	recovery := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/mfa/verify", map[string]any{
		"challengeId": recoveryChallenge, "method": "recovery_code", "code": authenticated.RecoveryCodes[0], "trustDevice": false, "deviceName": "",
	}, "")
	assertStatus(t, recovery, http.StatusOK)
	recoveryBody := decodeResponse[apiResponse](t, recovery)
	assertStatus(t, sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/logout", map[string]any{}, recoveryBody.CSRFToken), http.StatusNoContent)
	reuseLogin := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{"username": "owner", "password": password}, "")
	assertStatus(t, reuseLogin, http.StatusAccepted)
	reuseChallenge := decodeResponse[apiResponse](t, reuseLogin).ChallengeID
	reuse := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/mfa/verify", map[string]any{
		"challengeId": reuseChallenge, "method": "recovery_code", "code": authenticated.RecoveryCodes[0], "trustDevice": false, "deviceName": "",
	}, "")
	assertStatus(t, reuse, http.StatusUnauthorized)
	freshCode, err := totp.GenerateCode(provisioning.ManualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	verified := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/mfa/verify", map[string]any{
		"challengeId": reuseChallenge, "method": "totp", "code": freshCode, "trustDevice": true, "deviceName": "重置前设备",
	}, "")
	assertStatus(t, verified, http.StatusOK)
	verifiedBody := decodeResponse[apiResponse](t, verified)

	regenerateCode, err := totp.GenerateCode(provisioning.ManualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	regenerated := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/recovery-codes/regenerate", map[string]any{
		"password": password, "method": "totp", "code": regenerateCode,
	}, verifiedBody.CSRFToken)
	assertStatus(t, regenerated, http.StatusOK)
	assertNoStore(t, regenerated)
	if codes := decodeResponse[apiResponse](t, regenerated).RecoveryCodes; len(codes) != 10 {
		t.Fatalf("regenerated recovery code count = %d", len(codes))
	}

	resetCode, err := totp.GenerateCode(provisioning.ManualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	reset := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/reset", map[string]any{
		"password": password, "method": "totp", "code": resetCode,
	}, verifiedBody.CSRFToken)
	assertStatus(t, reset, http.StatusAccepted)
	resetChallenge := decodeResponse[apiResponse](t, reset).ChallengeID
	resetSetup := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/setup", map[string]any{"challengeId": resetChallenge}, "")
	assertStatus(t, resetSetup, http.StatusOK)
	resetProvisioning := decodeResponse[apiResponse](t, resetSetup)
	resetConfirmCode, err := totp.GenerateCode(resetProvisioning.ManualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	resetConfirm := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/confirm", map[string]any{
		"challengeId": resetChallenge, "code": resetConfirmCode, "trustDevice": false, "deviceName": "",
	}, "")
	assertStatus(t, resetConfirm, http.StatusOK)
	resetBody := decodeResponse[apiResponse](t, resetConfirm)
	if len(resetBody.RecoveryCodes) != 10 {
		t.Fatalf("TOTP reset recovery code count = %d", len(resetBody.RecoveryCodes))
	}
	var activeSessions, activeDevices int
	if err := database.QueryRow(ctx, "SELECT count(*) FROM auth_sessions WHERE revoked_at IS NULL").Scan(&activeSessions); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx, "SELECT count(*) FROM trusted_devices WHERE revoked_at IS NULL").Scan(&activeDevices); err != nil {
		t.Fatal(err)
	}
	if activeSessions != 1 || activeDevices != 0 {
		t.Fatalf("TOTP reset left active sessions/devices: %d/%d", activeSessions, activeDevices)
	}

	changeCode, err := totp.GenerateCode(resetProvisioning.ManualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	change := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/password/change", map[string]any{
		"currentPassword": password, "newPassword": newPassword, "method": "totp", "code": changeCode,
	}, resetBody.CSRFToken)
	assertStatus(t, change, http.StatusNoContent)
	assertStatus(t, doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/auth/session", nil, "", "")), http.StatusUnauthorized)
	assertStatus(t, sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{"username": "owner", "password": password}, ""), http.StatusUnauthorized)
	newLogin := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{"username": "owner", "password": newPassword}, "")
	assertStatus(t, newLogin, http.StatusAccepted)
	if decodeResponse[apiResponse](t, newLogin).Status != "mfa_required" {
		t.Fatal("password change unexpectedly removed TOTP")
	}

	var itemCountBefore int
	if err := database.QueryRow(ctx, "SELECT count(*) FROM knowledge_items").Scan(&itemCountBefore); err != nil {
		t.Fatal(err)
	}
	if err := auth.ResetAuth(ctx, database, "Host recovery password 123", time.Now()); err != nil {
		t.Fatal(err)
	}
	var itemCountAfter int
	var totpCiphertext []byte
	if err := database.QueryRow(ctx, "SELECT count(*) FROM knowledge_items").Scan(&itemCountAfter); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx, "SELECT totp_secret_ciphertext FROM owner_account").Scan(&totpCiphertext); err != nil {
		t.Fatal(err)
	}
	if itemCountAfter != itemCountBefore || len(totpCiphertext) != 0 {
		t.Fatal("host auth recovery changed knowledge data or retained TOTP")
	}
	resetLogin := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{"username": "owner", "password": "Host recovery password 123"}, "")
	assertStatus(t, resetLogin, http.StatusAccepted)
	if decodeResponse[apiResponse](t, resetLogin).Status != "mfa_setup_required" {
		t.Fatal("host auth recovery did not force TOTP enrollment")
	}
}

func newM1Server(t *testing.T, database *pgxpool.Pool, attachmentRoot string, location *time.Location) *httptest.Server {
	t.Helper()
	authService, err := auth.NewService(database, bytes.Repeat([]byte{9}, 32), testOrigin, "127.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	knowledgeService, err := knowledge.NewService(database, attachmentRoot, location)
	if err != nil {
		t.Fatal(err)
	}
	router := http.NewServeMux()
	authService.RegisterRoutes(router)
	knowledgeService.RegisterRoutes(router, authService)
	return httptest.NewTLSServer(router)
}

func assertTestDatabase(t *testing.T, rawURL string) {
	t.Helper()
	config, err := pgx.ParseConfig(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(config.Database, "_test") {
		t.Fatalf("refusing to truncate non-test database %q", config.Database)
	}
}

func resetDatabase(t *testing.T, database *pgxpool.Pool) {
	t.Helper()
	_, err := database.Exec(context.Background(), `
		TRUNCATE TABLE idempotency_records, search_fragments, attachments, raw_records,
		knowledge_items, agent_console_ws_tickets, auth_sessions, trusted_devices,
		mfa_recovery_codes, auth_challenges, security_events, owner_account CASCADE
	`)
	if err != nil {
		t.Fatal(err)
	}
}

func sendJSON(t *testing.T, client *http.Client, method, endpoint string, payload any, csrf string) *http.Response {
	return sendJSONWithKey(t, client, method, endpoint, payload, csrf, "")
}

func sendJSONWithKey(t *testing.T, client *http.Client, method, endpoint string, payload any, csrf, idempotencyKey string) *http.Response {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := newRequest(t, method, endpoint, bytes.NewReader(encoded), csrf, "application/json")
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	return doRequest(t, client, request)
}

func sendMultipart(t *testing.T, client *http.Client, endpoint, csrf, idempotencyKey string, metadata any, filename, clientMediaType string, content []byte) *http.Response {
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
	request := newRequest(t, http.MethodPost, endpoint, &body, csrf, writer.FormDataContentType())
	request.Header.Set("Idempotency-Key", idempotencyKey)
	return doRequest(t, client, request)
}

func newRequest(t *testing.T, method, endpoint string, body io.Reader, csrf, contentType string) *http.Request {
	t.Helper()
	request, err := http.NewRequest(method, endpoint, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("User-Agent", "dev-toolbox-m1-integration")
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	return request
}

func doRequest(t *testing.T, client *http.Client, request *http.Request) *http.Response {
	t.Helper()
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func assertStatus(t *testing.T, response *http.Response, expected int) {
	t.Helper()
	if response.StatusCode != expected {
		body := readResponse(t, response)
		t.Fatalf("status = %d, want %d; response = %s", response.StatusCode, expected, body)
	}
}

func assertNoStore(t *testing.T, response *http.Response) {
	t.Helper()
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header.Get("Cache-Control"))
	}
}

func assertSecureCookies(t *testing.T, response *http.Response) {
	t.Helper()
	headers := strings.Join(response.Header.Values("Set-Cookie"), "\n")
	for _, name := range []string{"__Host-dev-toolbox-session=", "__Host-dev-toolbox-trusted-device="} {
		if !strings.Contains(headers, name) {
			t.Fatalf("missing cookie %s", name)
		}
	}
	for _, attribute := range []string{"Secure", "HttpOnly", "SameSite=Strict", "Path=/"} {
		if !strings.Contains(headers, attribute) {
			t.Fatalf("missing cookie attribute %s", attribute)
		}
	}
	if strings.Contains(strings.ToLower(headers), "domain=") {
		t.Fatal("__Host- cookies must not set Domain")
	}
}

func decodeResponse[T any](t *testing.T, response *http.Response) T {
	t.Helper()
	var value T
	decodeInto(t, readResponse(t, response), &value)
	return value
}

func decodeInto(t *testing.T, encoded []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(encoded, target); err != nil {
		t.Fatalf("decode response: %v; body = %s", err, encoded)
	}
}

func readResponse(t *testing.T, response *http.Response) []byte {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

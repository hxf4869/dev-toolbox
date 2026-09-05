//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
)

// 32 字符以上，只用于测试的 Agent Console 内部服务令牌。
const agentConsoleTestToken = "agent-console-internal-test-token-0001"

const testPassword = "  Correct horse 电池 staple  "
const testSessionCookie = "__Host-dev-toolbox-session"

type agentConsoleAuthResponse struct {
	Status    string `json:"status"`
	CSRFToken string `json:"csrfToken"`
	Session   struct {
		ID string `json:"id"`
	} `json:"session"`
}

type agentConsoleTicketResponse struct {
	Ticket    string    `json:"ticket"`
	ExpiresAt time.Time `json:"expiresAt"`
	Audience  string    `json:"audience"`
}

type agentConsoleConsumeResponse struct {
	Valid         bool       `json:"valid"`
	AuthSessionID string     `json:"authSessionId"`
	OwnerID       string     `json:"ownerId"`
	ExpiresAt     *time.Time `json:"expiresAt"`
	Reason        string     `json:"reason"`
}

type agentConsoleIntrospectResponse struct {
	Valid         bool       `json:"valid"`
	OwnerID       string     `json:"ownerId"`
	ExpiresAt     *time.Time `json:"expiresAt"`
	RevokedReason string     `json:"revokedReason"`
}

func setupAgentConsoleTest(t *testing.T) (*pgxpool.Pool, *httptest.Server) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	assertTestDatabase(t, databaseURL)
	database, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	resetDatabase(t, database)
	t.Cleanup(func() { resetDatabase(t, database) })
	authService, err := auth.NewService(database, bytes.Repeat([]byte{9}, 32), testOrigin, "127.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	router := http.NewServeMux()
	authService.RegisterRoutes(router)
	authService.RegisterAgentConsoleRoutes(router, agentConsoleTestToken)
	server := httptest.NewTLSServer(router)
	t.Cleanup(server.Close)
	return database, server
}

func newAgentConsoleClient(t *testing.T, server *httptest.Server) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	// httptest.Server.Client() 每次返回同一个共享实例；必须新建 http.Client，
	// 否则多会话测试的 Cookie Jar 会互相覆盖。
	return &http.Client{Transport: server.Client().Transport, Jar: jar}
}

// enrollAndLogin initializes the owner, enrolls TOTP and returns the first
// session's client, CSRF token, session ID and TOTP manual key.
func enrollAndLogin(t *testing.T, server *httptest.Server, database *pgxpool.Pool) (*http.Client, string, uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	if err := auth.InitializeOwner(ctx, database, "owner", testPassword, time.Now()); err != nil {
		t.Fatal(err)
	}
	client := newAgentConsoleClient(t, server)
	login := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{
		"username": "owner", "password": testPassword,
	}, "")
	assertStatus(t, login, http.StatusAccepted)
	loginBody := decodeResponse[apiResponse](t, login)
	setup := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/setup", map[string]any{
		"challengeId": loginBody.ChallengeID,
	}, "")
	assertStatus(t, setup, http.StatusOK)
	provisioning := decodeResponse[apiResponse](t, setup)
	code, err := totp.GenerateCode(provisioning.ManualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	confirm := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/totp/confirm", map[string]any{
		"challengeId": loginBody.ChallengeID, "code": code, "trustDevice": false,
	}, "")
	assertStatus(t, confirm, http.StatusOK)
	authenticated := decodeResponse[agentConsoleAuthResponse](t, confirm)
	if authenticated.Status != "authenticated" || authenticated.CSRFToken == "" || authenticated.Session.ID == "" {
		t.Fatalf("unexpected TOTP confirmation response: %+v", authenticated)
	}
	sessionID, err := uuid.Parse(authenticated.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	return client, authenticated.CSRFToken, sessionID, provisioning.ManualKey
}

// loginAdditionalSession opens one more session with the already enrolled TOTP.
func loginAdditionalSession(t *testing.T, server *httptest.Server, manualKey string) (*http.Client, string, uuid.UUID) {
	t.Helper()
	client := newAgentConsoleClient(t, server)
	login := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{
		"username": "owner", "password": testPassword,
	}, "")
	assertStatus(t, login, http.StatusAccepted)
	loginBody := decodeResponse[apiResponse](t, login)
	code, err := totp.GenerateCode(manualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	verify := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/mfa/verify", map[string]any{
		"challengeId": loginBody.ChallengeID, "method": "totp", "code": code, "trustDevice": false,
	}, "")
	assertStatus(t, verify, http.StatusOK)
	authenticated := decodeResponse[agentConsoleAuthResponse](t, verify)
	sessionID, err := uuid.Parse(authenticated.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	return client, authenticated.CSRFToken, sessionID
}

func createAgentConsoleTicket(t *testing.T, server *httptest.Server, client *http.Client, csrf string) *http.Response {
	t.Helper()
	return sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/agent-console/ws-tickets", map[string]any{}, csrf)
}

func postInternalAgentConsole(t *testing.T, server *httptest.Server, endpoint string, payload any, token string) *http.Response {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+endpoint, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return doRequest(t, server.Client(), request)
}

func consumeAgentConsoleTicket(t *testing.T, server *httptest.Server, ticket string) *agentConsoleConsumeResponse {
	t.Helper()
	response := postInternalAgentConsole(t, server, "/internal/agent-console/ws-tickets/consume", map[string]any{"ticket": ticket}, agentConsoleTestToken)
	assertStatus(t, response, http.StatusOK)
	result := decodeResponse[agentConsoleConsumeResponse](t, response)
	return &result
}

func introspectAgentConsoleSession(t *testing.T, server *httptest.Server, sessionID uuid.UUID) *agentConsoleIntrospectResponse {
	t.Helper()
	response := postInternalAgentConsole(t, server, "/internal/agent-console/auth-sessions/introspect", map[string]any{
		"authSessionId": sessionID.String(),
	}, agentConsoleTestToken)
	assertStatus(t, response, http.StatusOK)
	result := decodeResponse[agentConsoleIntrospectResponse](t, response)
	return &result
}

func sessionTokenFromJar(t *testing.T, server *httptest.Server, client *http.Client) string {
	t.Helper()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, cookie := range client.Jar.Cookies(target) {
		if cookie.Name == testSessionCookie {
			return cookie.Value
		}
	}
	t.Fatal("session cookie missing from client jar")
	return ""
}

func TestAgentConsoleTicketRequiresSessionOriginAndCSRF(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	client, csrf, _, _ := enrollAndLogin(t, server, database)

	anonymous := newAgentConsoleClient(t, server)
	unauthenticated := createAgentConsoleTicket(t, server, anonymous, "")
	assertStatus(t, unauthenticated, http.StatusUnauthorized)

	withoutOrigin, err := http.NewRequest(http.MethodPost, server.URL+"/api/v1/agent-console/ws-tickets", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	withoutOrigin.Header.Set("Content-Type", "application/json")
	withoutOrigin.Header.Set("X-CSRF-Token", csrf)
	assertStatus(t, doRequest(t, client, withoutOrigin), http.StatusForbidden)

	wrongCSRF := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/agent-console/ws-tickets", map[string]any{}, "definitely-wrong")
	assertStatus(t, wrongCSRF, http.StatusForbidden)

	issued := createAgentConsoleTicket(t, server, client, csrf)
	assertStatus(t, issued, http.StatusOK)
	assertNoStore(t, issued)
	ticket := decodeResponse[agentConsoleTicketResponse](t, issued)
	if ticket.Ticket == "" || ticket.Audience != "relay" {
		t.Fatalf("unexpected ticket response: %+v", ticket)
	}
	if expiresIn := time.Until(ticket.ExpiresAt); expiresIn <= 0 || expiresIn > 31*time.Second {
		t.Fatalf("ticket expiry not ~30s: %s", expiresIn)
	}
}

func TestAgentConsoleTicketPlaintextReturnedOnceAndOnlyDigestStored(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	client, csrf, sessionID, _ := enrollAndLogin(t, server, database)

	issued := createAgentConsoleTicket(t, server, client, csrf)
	assertStatus(t, issued, http.StatusOK)
	ticket := decodeResponse[agentConsoleTicketResponse](t, issued)

	raw, err := base64.RawURLEncoding.DecodeString(ticket.Ticket)
	if err != nil || len(raw) != 32 {
		t.Fatalf("ticket is not 32 bytes base64url: len=%d err=%v", len(raw), err)
	}
	// 库里存的是 ticket 字符串（即返回的明文本身）的 SHA-256 摘要。
	digest := sha256.Sum256([]byte(ticket.Ticket))
	var storedDigest []byte
	var storedSessionID uuid.UUID
	var consumedAt *time.Time
	if err := database.QueryRow(context.Background(), `
		SELECT ticket_digest, auth_session_id, consumed_at FROM agent_console_ws_tickets
	`).Scan(&storedDigest, &storedSessionID, &consumedAt); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(storedDigest, digest[:]) {
		t.Fatal("stored ticket_digest is not the SHA-256 of the returned ticket")
	}
	if storedSessionID != sessionID || consumedAt != nil {
		t.Fatalf("unexpected stored ticket row: session=%s consumed=%v", storedSessionID, consumedAt)
	}
}

func TestAgentConsoleConcurrentConsumeHasSingleWinner(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	client, csrf, sessionID, _ := enrollAndLogin(t, server, database)
	issued := createAgentConsoleTicket(t, server, client, csrf)
	assertStatus(t, issued, http.StatusOK)
	ticket := decodeResponse[agentConsoleTicketResponse](t, issued)

	const consumers = 8
	results := make(chan *agentConsoleConsumeResponse, consumers)
	var wg sync.WaitGroup
	for range consumers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- consumeAgentConsoleTicket(t, server, ticket.Ticket)
		}()
	}
	wg.Wait()
	close(results)

	valid := 0
	var winner *agentConsoleConsumeResponse
	for result := range results {
		if result.Valid {
			valid++
			winner = result
			continue
		}
		if result.Reason != "CONSUMED" {
			t.Fatalf("unexpected rejection reason: %+v", result)
		}
	}
	if valid != 1 || winner == nil {
		t.Fatalf("expected exactly one winner, got %d", valid)
	}
	if winner.AuthSessionID != sessionID.String() || winner.OwnerID == "" || winner.ExpiresAt == nil {
		t.Fatalf("unexpected consume result: %+v", winner)
	}
}

func TestAgentConsoleExpiredAndRevokedSessionCannotCreateOrConsume(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	ctx := context.Background()
	clientA, csrfA, sessionA, manualKey := enrollAndLogin(t, server, database)

	// Session A 过期后：无法创建 ticket。
	if _, err := database.Exec(ctx, `
		UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1
	`, sessionA); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, createAgentConsoleTicket(t, server, clientA, csrfA), http.StatusUnauthorized)

	clientB, csrfB, sessionB := loginAdditionalSession(t, server, manualKey)
	issued := createAgentConsoleTicket(t, server, clientB, csrfB)
	assertStatus(t, issued, http.StatusOK)
	ticketB := decodeResponse[agentConsoleTicketResponse](t, issued)
	if _, err := database.Exec(ctx, `
		UPDATE auth_sessions SET revoked_at = now() WHERE id = $1
	`, sessionB); err != nil {
		t.Fatal(err)
	}
	revoked := consumeAgentConsoleTicket(t, server, ticketB.Ticket)
	if revoked.Valid || revoked.Reason != "SESSION_INVALID" {
		t.Fatalf("expected SESSION_INVALID for revoked session, got %+v", revoked)
	}
	replayed := consumeAgentConsoleTicket(t, server, ticketB.Ticket)
	if replayed.Valid || replayed.Reason != "CONSUMED" {
		t.Fatalf("expected CONSUMED on replay, got %+v", replayed)
	}

	unknown := consumeAgentConsoleTicket(t, server, "totally-unknown-ticket-value")
	if unknown.Valid || unknown.Reason != "NOT_FOUND" {
		t.Fatalf("expected NOT_FOUND, got %+v", unknown)
	}
}

func TestAgentConsoleExpiredTicketIsRejected(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	ctx := context.Background()
	client, csrf, _, _ := enrollAndLogin(t, server, database)

	issued := createAgentConsoleTicket(t, server, client, csrf)
	assertStatus(t, issued, http.StatusOK)
	ticket := decodeResponse[agentConsoleTicketResponse](t, issued)
	if _, err := database.Exec(ctx, `
		UPDATE agent_console_ws_tickets SET expires_at = now() - interval '1 second'
	`); err != nil {
		t.Fatal(err)
	}
	expired := consumeAgentConsoleTicket(t, server, ticket.Ticket)
	if expired.Valid || expired.Reason != "EXPIRED" {
		t.Fatalf("expected EXPIRED, got %+v", expired)
	}
}

func TestAgentConsoleIntrospectDoesNotTouchLastSeen(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	ctx := context.Background()
	_, _, sessionID, _ := enrollAndLogin(t, server, database)

	idle := time.Now().UTC().Add(-23 * time.Hour)
	if _, err := database.Exec(ctx, `
		UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1
	`, sessionID, idle); err != nil {
		t.Fatal(err)
	}
	result := introspectAgentConsoleSession(t, server, sessionID)
	if !result.Valid || result.OwnerID == "" || result.ExpiresAt == nil || result.RevokedReason != "" {
		t.Fatalf("expected valid introspection, got %+v", result)
	}
	var lastSeen time.Time
	if err := database.QueryRow(ctx, `
		SELECT last_seen_at FROM auth_sessions WHERE id = $1
	`, sessionID).Scan(&lastSeen); err != nil {
		t.Fatal(err)
	}
	if !lastSeen.Equal(idle) {
		t.Fatalf("introspection touched last_seen_at: got %s, want %s", lastSeen, idle)
	}

	if _, err := database.Exec(ctx, `
		UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1
	`, sessionID, time.Now().UTC().Add(-25*time.Hour)); err != nil {
		t.Fatal(err)
	}
	idledOut := introspectAgentConsoleSession(t, server, sessionID)
	if idledOut.Valid || idledOut.RevokedReason != "IDLE_TIMEOUT" {
		t.Fatalf("expected IDLE_TIMEOUT, got %+v", idledOut)
	}
	unknown := introspectAgentConsoleSession(t, server, uuid.New())
	if unknown.Valid || unknown.RevokedReason != "NOT_FOUND" {
		t.Fatalf("expected NOT_FOUND, got %+v", unknown)
	}
}

func TestAgentConsoleIntrospectRejectsAfterLogoutLogoutAllRevokeAndPasswordChange(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	ctx := context.Background()
	client, csrf, sessionID, manualKey := enrollAndLogin(t, server, database)

	// 单 session revoke。
	logout := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/logout", map[string]any{}, csrf)
	assertStatus(t, logout, http.StatusNoContent)
	if result := introspectAgentConsoleSession(t, server, sessionID); result.Valid || result.RevokedReason != "REVOKED" {
		t.Fatalf("expected REVOKED after logout, got %+v", result)
	}

	// logout-all 撤销全部会话。
	clientB, csrfB, sessionB := loginAdditionalSession(t, server, manualKey)
	_, _, sessionC := loginAdditionalSession(t, server, manualKey)
	logoutAll := sendJSON(t, clientB, http.MethodPost, server.URL+"/api/v1/auth/logout-all", map[string]any{}, csrfB)
	assertStatus(t, logoutAll, http.StatusNoContent)
	for _, id := range []uuid.UUID{sessionB, sessionC} {
		if result := introspectAgentConsoleSession(t, server, id); result.Valid || result.RevokedReason != "REVOKED" {
			t.Fatalf("expected REVOKED after logout-all for %s, got %+v", id, result)
		}
	}

	// 管理 API 单独撤销另一个会话。
	clientD, csrfD, sessionD := loginAdditionalSession(t, server, manualKey)
	_, _, sessionE := loginAdditionalSession(t, server, manualKey)
	revoke := sendJSON(t, clientD, http.MethodDelete, server.URL+"/api/v1/auth/sessions/"+sessionE.String(), map[string]any{}, csrfD)
	assertStatus(t, revoke, http.StatusNoContent)
	if result := introspectAgentConsoleSession(t, server, sessionE); result.Valid || result.RevokedReason != "REVOKED" {
		t.Fatalf("expected REVOKED after single revoke, got %+v", result)
	}
	if result := introspectAgentConsoleSession(t, server, sessionD); !result.Valid {
		t.Fatalf("unrelated session must stay valid, got %+v", result)
	}

	// password_changed_at 晚于会话创建时间后必须失效（与 changePassword 使用同一条件）。
	if _, err := database.Exec(ctx, `
		UPDATE owner_account SET password_changed_at = now()
	`); err != nil {
		t.Fatal(err)
	}
	if result := introspectAgentConsoleSession(t, server, sessionD); result.Valid || result.RevokedReason != "PASSWORD_CHANGED" {
		t.Fatalf("expected PASSWORD_CHANGED, got %+v", result)
	}

	// 真实 changePassword 端点也会撤销全部会话并使会话失效。
	clientF, csrfF, sessionF := loginAdditionalSession(t, server, manualKey)
	code, err := totp.GenerateCode(manualKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	change := sendJSON(t, clientF, http.MethodPost, server.URL+"/api/v1/auth/password/change", map[string]any{
		"currentPassword": testPassword, "newPassword": "New correct horse 电池 staple",
		"method": "totp", "code": code,
	}, csrfF)
	assertStatus(t, change, http.StatusNoContent)
	if result := introspectAgentConsoleSession(t, server, sessionF); result.Valid || result.RevokedReason != "REVOKED" {
		t.Fatalf("expected REVOKED after password change, got %+v", result)
	}
}

func TestAgentConsoleBrowserSessionEndpointStillTouchesLastSeen(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	ctx := context.Background()
	client, _, sessionID, _ := enrollAndLogin(t, server, database)

	staleLastSeen := time.Now().UTC().Add(-10 * time.Minute)
	if _, err := database.Exec(ctx, `
		UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1
	`, sessionID, staleLastSeen); err != nil {
		t.Fatal(err)
	}
	refreshStartedAt := time.Now().UTC()
	refreshed := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/auth/session", nil, "", ""))
	assertStatus(t, refreshed, http.StatusOK)
	_ = readResponse(t, refreshed)
	var lastSeen time.Time
	if err := database.QueryRow(ctx, `
		SELECT last_seen_at FROM auth_sessions WHERE id = $1
	`, sessionID).Scan(&lastSeen); err != nil {
		t.Fatal(err)
	}
	if lastSeen.Before(refreshStartedAt.Add(-time.Second)) {
		t.Fatalf("/api/v1/auth/session no longer touches last_seen_at: %s", lastSeen)
	}
}

func TestAgentConsoleForwardAuthVerify(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	ctx := context.Background()
	client, csrf, sessionID, _ := enrollAndLogin(t, server, database)
	token := sessionTokenFromJar(t, server, client)

	verify := func(extraHeaders map[string]string) *http.Response {
		request, err := http.NewRequest(http.MethodGet, server.URL+"/internal/agent-console/auth-sessions/verify", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+agentConsoleTestToken)
		for name, value := range extraHeaders {
			request.Header.Set(name, value)
		}
		return doRequest(t, server.Client(), request)
	}

	browserHeaders := map[string]string{
		"Cookie":                 testSessionCookie + "=" + token,
		"X-Agent-Console-Method": "GET",
	}
	response := verify(browserHeaders)
	assertStatus(t, response, http.StatusOK)
	if response.Header.Get("X-Agent-Console-Session-Id") != sessionID.String() {
		t.Fatalf("missing identity header: %q", response.Header.Get("X-Agent-Console-Session-Id"))
	}
	var payload struct {
		Valid         bool       `json:"valid"`
		AuthSessionID string     `json:"authSessionId"`
		OwnerID       string     `json:"ownerId"`
		ExpiresAt     *time.Time `json:"expiresAt"`
	}
	decodeInto(t, readResponse(t, response), &payload)
	if !payload.Valid || payload.AuthSessionID != sessionID.String() || payload.OwnerID == "" || payload.ExpiresAt == nil {
		t.Fatalf("unexpected verify payload: %+v", payload)
	}

	// 无 Cookie 拒绝。
	assertStatus(t, verify(map[string]string{"X-Agent-Console-Method": "GET"}), http.StatusUnauthorized)

	// 写请求缺少 Origin/CSRF 拒绝。
	assertStatus(t, verify(map[string]string{
		"Cookie": testSessionCookie + "=" + token, "X-Agent-Console-Method": "POST",
	}), http.StatusUnauthorized)

	// 写请求携带正确 Origin 与 CSRF 通过；未知方法按写请求处理。
	writeHeaders := map[string]string{
		"Cookie":       testSessionCookie + "=" + token,
		"Origin":       testOrigin,
		"X-CSRF-Token": csrf,
	}
	writeHeaders["X-Agent-Console-Method"] = "POST"
	assertStatus(t, verify(writeHeaders), http.StatusOK)
	writeHeaders["X-Agent-Console-Method"] = ""
	assertStatus(t, verify(writeHeaders), http.StatusOK)

	// verify 不刷新 last_seen。
	stale := time.Now().UTC().Add(-10 * time.Minute)
	if _, err := database.Exec(ctx, `
		UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1
	`, sessionID, stale); err != nil {
		t.Fatal(err)
	}
	browserHeaders["X-Agent-Console-Method"] = "GET"
	assertStatus(t, verify(browserHeaders), http.StatusOK)
	var lastSeen time.Time
	if err := database.QueryRow(ctx, `
		SELECT last_seen_at FROM auth_sessions WHERE id = $1
	`, sessionID).Scan(&lastSeen); err != nil {
		t.Fatal(err)
	}
	if !lastSeen.Equal(stale) {
		t.Fatalf("verify touched last_seen_at: %s", lastSeen)
	}
}

func TestAgentConsoleInternalTokenIsEnforced(t *testing.T) {
	_, server := setupAgentConsoleTest(t)

	wrongToken := postInternalAgentConsole(t, server, "/internal/agent-console/ws-tickets/consume", map[string]any{"ticket": "x"}, "wrong-token-aaaaaaaaaaaaaaaaaaaa")
	assertStatus(t, wrongToken, http.StatusUnauthorized)
	missingToken := postInternalAgentConsole(t, server, "/internal/agent-console/ws-tickets/consume", map[string]any{"ticket": "x"}, "")
	assertStatus(t, missingToken, http.StatusUnauthorized)
	wrongIntrospect := postInternalAgentConsole(t, server, "/internal/agent-console/auth-sessions/introspect", map[string]any{"authSessionId": uuid.New().String()}, "wrong-token-aaaaaaaaaaaaaaaaaaaa")
	assertStatus(t, wrongIntrospect, http.StatusUnauthorized)
	wrongVerify, err := http.NewRequest(http.MethodGet, server.URL+"/internal/agent-console/auth-sessions/verify", nil)
	if err != nil {
		t.Fatal(err)
	}
	wrongVerify.Header.Set("Authorization", "Bearer wrong-token-aaaaaaaaaaaaaaaaaaaa")
	assertStatus(t, doRequest(t, server.Client(), wrongVerify), http.StatusUnauthorized)
}

func TestAgentConsoleInternalRoutesFailClosedWithoutToken(t *testing.T) {
	database, server := setupAgentConsoleTest(t)
	_, _, _, manualKey := enrollAndLogin(t, server, database)

	unconfigured := httptest.NewTLSServer(func() http.Handler {
		authService, err := auth.NewService(database, bytes.Repeat([]byte{9}, 32), testOrigin, "127.0.0.0/8")
		if err != nil {
			t.Fatal(err)
		}
		router := http.NewServeMux()
		authService.RegisterRoutes(router)
		authService.RegisterAgentConsoleRoutes(router, "")
		return router
	}())
	defer unconfigured.Close()

	response := postInternalAgentConsole(t, unconfigured, "/internal/agent-console/ws-tickets/consume", map[string]any{"ticket": "x"}, manualKey)
	assertStatus(t, response, http.StatusServiceUnavailable)
}

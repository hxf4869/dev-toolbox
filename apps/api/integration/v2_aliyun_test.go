//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/textproto"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/aliyun"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
)

const v2AliyunAccessKeyID = "LTAI5tintegrationfixture"
const v2AliyunAccessKeySecret = "integration-fake-secret"

type v2AliyunClock struct {
	mutex   sync.Mutex
	current time.Time
}

func newV2AliyunClock() *v2AliyunClock {
	return &v2AliyunClock{current: time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)}
}

func (clock *v2AliyunClock) Now() time.Time {
	clock.mutex.Lock()
	defer clock.mutex.Unlock()
	return clock.current
}

func (clock *v2AliyunClock) Set(moment time.Time) {
	clock.mutex.Lock()
	defer clock.mutex.Unlock()
	clock.current = moment
}

type v2AliyunGatewayScript struct {
	Result aliyun.TranslationResult
	Error  *aliyun.GatewayError
}

// v2AliyunFakeGateway never touches the network; outcomes are scripted and
// every issued call is counted.
type v2AliyunFakeGateway struct {
	mutex      sync.Mutex
	calls      int
	next       *v2AliyunGatewayScript
	blockUntil chan struct{}
}

func (gateway *v2AliyunFakeGateway) Translate(
	ctx context.Context, credentials aliyun.CloudCredentials, input aliyun.TranslationInput,
) (aliyun.TranslationResult, *aliyun.GatewayError) {
	gateway.mutex.Lock()
	gateway.calls++
	outcome := v2AliyunGatewayScript{Result: aliyun.TranslationResult{
		TranslatedText: "fake translation for chunk", DetectedLanguage: "zh",
		UpstreamRequestID: "fake-request-id",
	}}
	if gateway.next != nil {
		outcome = *gateway.next
		gateway.next = nil
	}
	block := gateway.blockUntil
	gateway.mutex.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return aliyun.TranslationResult{}, &aliyun.GatewayError{Category: "timeout", Uncertain: true}
		}
	}
	return outcome.Result, outcome.Error
}

func (gateway *v2AliyunFakeGateway) callCount() int {
	gateway.mutex.Lock()
	defer gateway.mutex.Unlock()
	return gateway.calls
}

func (gateway *v2AliyunFakeGateway) setNext(script v2AliyunGatewayScript) {
	gateway.mutex.Lock()
	defer gateway.mutex.Unlock()
	gateway.next = &script
}

func (gateway *v2AliyunFakeGateway) startBlocked() {
	gateway.mutex.Lock()
	defer gateway.mutex.Unlock()
	gateway.blockUntil = make(chan struct{})
}

func (gateway *v2AliyunFakeGateway) release() {
	gateway.mutex.Lock()
	block := gateway.blockUntil
	gateway.blockUntil = nil
	gateway.mutex.Unlock()
	if block != nil {
		close(block)
	}
}

func waitForGatewayCalls(t *testing.T, gateway *v2AliyunFakeGateway, expected int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if gateway.callCount() >= expected {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("gateway calls did not reach %d", expected)
}

func resetV2AliyunDatabase(t *testing.T, database *pgxpool.Pool) {
	t.Helper()
	_, err := database.Exec(context.Background(), `
		TRUNCATE TABLE aliyun_usage_calls, aliyun_usage_months, aliyun_service_settings,
		auth_sessions, trusted_devices, mfa_recovery_codes, auth_challenges,
		security_events, owner_account CASCADE;
		INSERT INTO aliyun_service_settings (id, created_at, updated_at) VALUES (1, now(), now());
	`)
	if err != nil {
		t.Fatal(err)
	}
}

type v2AliyunPermit struct {
	ticketID uuid.UUID
	token    string
}

func (env *v2AliyunEnv) releasePermit(t *testing.T, permit v2AliyunPermit) {
	t.Helper()
	request := newRequest(t, http.MethodDelete,
		env.server.URL+"/api/v1/aliyun/queue-tickets/"+permit.ticketID.String(), nil, env.csrf, "")
	assertStatus(t, doRequest(t, env.client, request), http.StatusNoContent)
}

type v2AliyunEnv struct {
	server     *httptest.Server
	client     *http.Client
	csrf       string
	gateway    *v2AliyunFakeGateway
	ocrGateway *v2AliyunFakeOcrGateway
	clock      *v2AliyunClock
	service    *aliyun.Service
}

func newV2AliyunEnv(t *testing.T, database *pgxpool.Pool) *v2AliyunEnv {
	t.Helper()
	password := "V2 aliyun correct horse 电池 staple"
	if err := auth.InitializeOwner(context.Background(), database, "owner", password, time.Now()); err != nil {
		t.Fatal(err)
	}
	authService, err := auth.NewService(database, bytes.Repeat([]byte{9}, 32), testOrigin, "127.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	gateway := &v2AliyunFakeGateway{}
	ocrGateway := &v2AliyunFakeOcrGateway{}
	clock := newV2AliyunClock()
	service := aliyun.NewService(database, bytes.Repeat([]byte{9}, 32),
		aliyun.WithTranslationGateway(gateway), aliyun.WithOcrGateway(ocrGateway), aliyun.WithClock(clock.Now))
	router := http.NewServeMux()
	authService.RegisterRoutes(router)
	service.RegisterRoutes(router, authService)
	server := httptest.NewTLSServer(router)
	t.Cleanup(server.Close)
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
	return &v2AliyunEnv{
		server: server, client: client, csrf: decodeResponse[apiResponse](t, confirm).CSRFToken,
		gateway: gateway, ocrGateway: ocrGateway, clock: clock, service: service,
	}
}

func (env *v2AliyunEnv) putSettings(t *testing.T, payload map[string]any) *http.Response {
	t.Helper()
	withCredentials := copyV2Map(payload)
	withCredentials["credentials"] = map[string]any{
		"accessKeyId": v2AliyunAccessKeyID, "accessKeySecret": v2AliyunAccessKeySecret,
	}
	return sendJSON(t, env.client, http.MethodPut, env.server.URL+"/api/v1/aliyun/settings", withCredentials, env.csrf)
}

func (env *v2AliyunEnv) defaultSettings() map[string]any {
	return map[string]any{
		"translation": map[string]any{
			"generalMonthlyLimit": 950000, "professionalMonthlyLimit": 950000,
			"autoUseProfessional": true, "professionalScene": "title",
		},
		"ocr":         map[string]any{"monthlyLimit": 190},
		"concurrency": map[string]any{"owner": 1, "global": 3},
	}
}

func copyV2Map(source map[string]any) map[string]any {
	target := make(map[string]any, len(source))
	for key, value := range source {
		target[key] = value
	}
	return target
}

func (env *v2AliyunEnv) permitFor(t *testing.T, operation string) v2AliyunPermit {
	t.Helper()
	created := sendJSON(t, env.client, http.MethodPost, env.server.URL+"/api/v1/aliyun/queue-tickets",
		map[string]any{"operation": operation}, env.csrf)
	assertStatus(t, created, http.StatusCreated)
	var ticket struct {
		TicketID uuid.UUID `json:"ticketId"`
	}
	if err := json.Unmarshal(readResponse(t, created), &ticket); err != nil {
		t.Fatal(err)
	}
	claimed := sendJSON(t, env.client, http.MethodPost,
		env.server.URL+"/api/v1/aliyun/queue-tickets/"+ticket.TicketID.String()+"/claim", nil, env.csrf)
	assertStatus(t, claimed, http.StatusOK)
	var claim struct {
		PermitToken string `json:"permitToken"`
	}
	if err := json.Unmarshal(readResponse(t, claimed), &claim); err != nil || claim.PermitToken == "" {
		t.Fatalf("claim without permit token: %s", readResponse(t, claimed))
	}
	return v2AliyunPermit{ticketID: ticket.TicketID, token: claim.PermitToken}
}

func (env *v2AliyunEnv) sendChunk(t *testing.T, permit v2AliyunPermit, idempotencyKey string, payload map[string]any) *http.Response {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := newRequest(t, http.MethodPost, env.server.URL+"/api/v1/aliyun/translation/chunks",
		bytes.NewReader(encoded), env.csrf, "application/json")
	request.Header.Set("Idempotency-Key", idempotencyKey)
	request.Header.Set("X-Cloud-Permit", permit.token)
	return doRequest(t, env.client, request)
}

func assertErrorCode(t *testing.T, response *http.Response, status int, code string) map[string]any {
	t.Helper()
	assertStatus(t, response, status)
	var envelope struct {
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(readResponse(t, response), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != code {
		t.Fatalf("error code = %q, want %q", envelope.Error.Code, code)
	}
	return envelope.Error.Details
}

// ledgerRow returns usage for a month ("2026-08") and meter; missing rows
// count as zero.
func ledgerRow(t *testing.T, database *pgxpool.Pool, month, meter string) (used, reserved int64) {
	t.Helper()
	err := database.QueryRow(context.Background(), `
		SELECT used_units, reserved_units FROM aliyun_usage_months
		WHERE month_start = ($1 || '-01')::date AND meter = $2
	`, month, meter).Scan(&used, &reserved)
	if err == pgx.ErrNoRows {
		return 0, 0
	}
	if err != nil {
		t.Fatalf("ledger row %s/%s: %v", month, meter, err)
	}
	return used, reserved
}

func ownerIDOf(t *testing.T, database *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var ownerID uuid.UUID
	if err := database.QueryRow(context.Background(), "SELECT id FROM owner_account LIMIT 1").Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	return ownerID
}

func TestV2AliyunConcurrentReservationsNeverExceedLimit(t *testing.T) {
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
	resetV2AliyunDatabase(t, database)
	defer resetV2AliyunDatabase(t, database)

	env := newV2AliyunEnv(t, database)
	settings := env.defaultSettings()
	settings["translation"].(map[string]any)["generalMonthlyLimit"] = 100
	assertStatus(t, env.putSettings(t, settings), http.StatusOK)

	const workers = 50
	ownerID := ownerIDOf(t, database)
	succeeded := make(chan struct{}, workers)
	exhausted := make(chan struct{}, workers)
	var waitGroup sync.WaitGroup
	for index := 0; index < workers; index++ {
		waitGroup.Add(1)
		go func(worker int) {
			defer waitGroup.Done()
			_, decisionErr, err := env.service.ReserveCallQuota(
				context.Background(), ownerID, uuid.New(), "mt_general", 3)
			switch {
			case err != nil:
				t.Errorf("worker %d reserve failed: %v", worker, err)
			case decisionErr != nil && decisionErr.Code == "QUOTA_EXHAUSTED":
				exhausted <- struct{}{}
			case decisionErr != nil:
				t.Errorf("worker %d unexpected stop: %v", worker, decisionErr)
			default:
				succeeded <- struct{}{}
			}
		}(index)
	}
	waitGroup.Wait()
	close(succeeded)
	close(exhausted)
	if len(succeeded) != 33 {
		t.Fatalf("succeeded reservations = %d, want 33 (100/3)", len(succeeded))
	}
	if len(exhausted) != 17 {
		t.Fatalf("exhausted rejections = %d, want 17", len(exhausted))
	}
	used, reserved := ledgerRow(t, database, "2026-08", "mt_general")
	if used != 0 || reserved != 99 {
		t.Fatalf("ledger = used %d / reserved %d, want 0/99", used, reserved)
	}

	// Race a limit reduction against fresh reservations: both orders must
	// respect the unified lock order, and a successful reduction implies the
	// ledger never exceeds the new limit.
	lower := copyV2Map(settings)
	lower["translation"].(map[string]any)["generalMonthlyLimit"] = 99
	putDone := make(chan bool, 1)
	go func() {
		response := env.putSettings(t, lower)
		putDone <- response.StatusCode == http.StatusOK
	}()
	reserveDone := make(chan struct{})
	go func() {
		defer close(reserveDone)
		_, decisionErr, err := env.service.ReserveCallQuota(
			context.Background(), ownerID, uuid.New(), "mt_general", 3)
		if err != nil {
			t.Errorf("race reserve failed: %v", err)
		} else if decisionErr != nil && decisionErr.Code != "QUOTA_EXHAUSTED" {
			t.Errorf("race reserve unexpected stop: %v", decisionErr)
		}
	}()
	limitLowered := <-putDone
	<-reserveDone
	used, reserved = ledgerRow(t, database, "2026-08", "mt_general")
	if reserved > 102 || (limitLowered && used+reserved > 99) {
		t.Fatalf("race oversold: used=%d reserved=%d lowered=%v", used, reserved, limitLowered)
	}
}

func TestV2AliyunSettlementOutcomesAndIdempotency(t *testing.T) {
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
	resetV2AliyunDatabase(t, database)
	defer resetV2AliyunDatabase(t, database)
	env := newV2AliyunEnv(t, database)
	assertStatus(t, env.putSettings(t, env.defaultSettings()), http.StatusOK)

	permit := env.permitFor(t, "translation")
	payload := map[string]any{
		// 请运行检查。 = 6 UTF-16 units.
		"sourceText": "请运行检查。", "sourceLanguage": "zh",
		"targetLanguage": "en", "expectedEngine": "general",
	}

	firstKey := uuid.NewString()
	success := env.sendChunk(t, permit, firstKey, payload)
	assertStatus(t, success, http.StatusOK)
	var successBody struct {
		TranslatedText string `json:"translatedText"`
		Engine         string `json:"engine"`
		Scene          string `json:"scene"`
		BillableUnits  int64  `json:"billableUnits"`
		Quota          struct {
			Meter     string `json:"meter"`
			Remaining int64  `json:"remaining"`
		} `json:"quota"`
		Replayed bool `json:"replayed"`
	}
	if err := json.Unmarshal(readResponse(t, success), &successBody); err != nil {
		t.Fatal(err)
	}
	if successBody.Engine != "general" || successBody.Scene != "general" ||
		successBody.BillableUnits != 6 || successBody.Quota.Meter != "mt_general" ||
		successBody.Quota.Remaining != 950000-6 || successBody.Replayed {
		t.Fatalf("unexpected chunk response: %+v", successBody)
	}
	used, reserved := ledgerRow(t, database, "2026-08", "mt_general")
	if used != 6 || reserved != 0 {
		t.Fatalf("after success ledger = %d/%d, want 6/0", used, reserved)
	}

	// Same key replay: settled without result, no second SDK call.
	replay := env.sendChunk(t, permit, firstKey, payload)
	details := assertErrorCode(t, replay, http.StatusConflict, "CALL_SETTLED_WITHOUT_RESULT")
	if details["callStatus"] != "succeeded" || details["replayed"] != true || details["meter"] != "mt_general" {
		t.Fatalf("replay details wrong: %+v", details)
	}

	// Same key with different units: idempotency key reused.
	changed := copyV2Map(payload)
	changed["sourceText"] = "不同的长度"
	reused := env.sendChunk(t, permit, firstKey, changed)
	assertErrorCode(t, reused, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED")

	// Same units but a different operation/meter must also be rejected.
	changedOperation := copyV2Map(payload)
	changedOperation["expectedEngine"] = "professional"
	reusedOperation := env.sendChunk(t, permit, firstKey, changedOperation)
	assertErrorCode(t, reusedOperation, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED")

	// failed_counted: a definite upstream rejection counts against the ledger.
	env.gateway.setNext(v2AliyunGatewayScript{Error: &aliyun.GatewayError{
		Category: "credential_invalid", RequestID: "req-failed",
	}})
	failed := env.sendChunk(t, permit, uuid.NewString(), payload)
	details = assertErrorCode(t, failed, http.StatusBadGateway, "UPSTREAM_REJECTED")
	if details["callStatus"] != "failed_counted" || details["failureCategory"] != "credential_invalid" ||
		details["upstreamRequestId"] != "req-failed" || details["countedUnits"] != float64(6) {
		t.Fatalf("failure details wrong: %+v", details)
	}

	// uncertain: a timeout counts conservatively.
	env.gateway.setNext(v2AliyunGatewayScript{Error: &aliyun.GatewayError{
		Category: "timeout", Uncertain: true,
	}})
	uncertain := env.sendChunk(t, permit, uuid.NewString(), payload)
	details = assertErrorCode(t, uncertain, http.StatusGatewayTimeout, "UPSTREAM_RESULT_UNCERTAIN")
	if details["callStatus"] != "uncertain" || details["failureCategory"] != "timeout" {
		t.Fatalf("uncertain details wrong: %+v", details)
	}

	// released: provably not issued restores the quota.
	env.gateway.setNext(v2AliyunGatewayScript{Error: &aliyun.GatewayError{
		Category: "timeout", NotIssued: true,
	}})
	released := env.sendChunk(t, permit, uuid.NewString(), payload)
	details = assertErrorCode(t, released, http.StatusServiceUnavailable, "UPSTREAM_UNAVAILABLE")
	if details["callStatus"] != "released" || details["countedUnits"] != nil {
		t.Fatalf("released details wrong: %+v", details)
	}

	if calls := env.gateway.callCount(); calls != 4 {
		t.Fatalf("fake SDK calls = %d, want 4 (replays never re-issue)", calls)
	}
	used, reserved = ledgerRow(t, database, "2026-08", "mt_general")
	if used != 18 || reserved != 0 {
		t.Fatalf("final ledger = %d/%d, want 18/0", used, reserved)
	}

	var failureCategory string
	if err := database.QueryRow(context.Background(),
		"SELECT last_failure_category FROM aliyun_service_settings WHERE id = 1").Scan(&failureCategory); err != nil {
		t.Fatal(err)
	}
	// The uncertain timeout settled last, so it owns the newest failure state.
	if failureCategory != "timeout" {
		t.Fatalf("last failure category = %q, want timeout", failureCategory)
	}
}

func TestV2AliyunLimitFloorStaleRecoveryAndMonthBoundary(t *testing.T) {
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
	resetV2AliyunDatabase(t, database)
	defer resetV2AliyunDatabase(t, database)
	env := newV2AliyunEnv(t, database)
	settings := env.defaultSettings()
	settings["translation"].(map[string]any)["generalMonthlyLimit"] = 100
	assertStatus(t, env.putSettings(t, settings), http.StatusOK)

	ownerID := ownerIDOf(t, database)
	if _, _, err := env.service.ReserveCallQuota(context.Background(), ownerID, uuid.New(), "mt_general", 60); err != nil {
		t.Fatal(err)
	}

	// A new limit below used+reserved must be rejected without saving.
	tooLow := copyV2Map(settings)
	tooLow["translation"].(map[string]any)["generalMonthlyLimit"] = 50
	assertErrorCode(t, env.putSettings(t, tooLow), http.StatusUnprocessableEntity, "INVALID_INPUT")

	// Stale reservations recover on the usage read.
	staleKey := uuid.New()
	if _, err := database.Exec(context.Background(), `
		INSERT INTO aliyun_usage_calls (request_key, owner_id, operation, meter, month_start,
			reserved_units, counted_units, status, created_at)
		VALUES ($1, $2, 'translate_general', 'mt_general', '2026-08-01', 10, 0, 'reserved', $3)
	`, staleKey, ownerID, env.clock.Now().UTC().Add(-11*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// Model the crash accurately: the abandoned reservation still holds its
	// month reserved units.
	if _, err := database.Exec(context.Background(), `
		UPDATE aliyun_usage_months SET reserved_units = reserved_units + 10
		WHERE month_start = '2026-08-01' AND meter = 'mt_general'
	`); err != nil {
		t.Fatal(err)
	}
	usage := sendJSON(t, env.client, http.MethodGet, env.server.URL+"/api/v1/aliyun/usage/current", nil, "")
	assertStatus(t, usage, http.StatusOK)
	var usageBody struct {
		Month  string `json:"month"`
		Meters []struct {
			Meter    string `json:"meter"`
			Used     int64  `json:"used"`
			Reserved int64  `json:"reserved"`
		} `json:"meters"`
	}
	if err := json.Unmarshal(readResponse(t, usage), &usageBody); err != nil {
		t.Fatal(err)
	}
	if usageBody.Month != "2026-08" || len(usageBody.Meters) != 3 {
		t.Fatalf("usage shape wrong: %s", readResponse(t, usage))
	}
	var generalUsed, generalReserved int64
	for _, meter := range usageBody.Meters {
		if meter.Meter == "mt_general" {
			generalUsed, generalReserved = meter.Used, meter.Reserved
		}
	}
	if generalUsed != 10 || generalReserved != 60 {
		t.Fatalf("after recovery used/reserved = %d/%d, want 10/60", generalUsed, generalReserved)
	}
	var staleStatus string
	if err := database.QueryRow(context.Background(),
		"SELECT status FROM aliyun_usage_calls WHERE request_key = $1", staleKey).Scan(&staleStatus); err != nil {
		t.Fatal(err)
	}
	if staleStatus != "uncertain" {
		t.Fatalf("stale call status = %q, want uncertain", staleStatus)
	}

	// Asia/Shanghai month boundary: 16:00 UTC is already the next Shanghai day.
	env.clock.Set(time.Date(2026, 8, 31, 16, 0, 0, 0, time.UTC))
	boundary := sendJSON(t, env.client, http.MethodGet, env.server.URL+"/api/v1/aliyun/usage/current", nil, "")
	assertStatus(t, boundary, http.StatusOK)
	var boundaryBody struct {
		Month    string `json:"month"`
		Timezone string `json:"timezone"`
		Source   string `json:"source"`
	}
	if err := json.Unmarshal(readResponse(t, boundary), &boundaryBody); err != nil {
		t.Fatal(err)
	}
	if boundaryBody.Month != "2026-09" || boundaryBody.Timezone != "Asia/Shanghai" ||
		boundaryBody.Source != "dev_toolbox_local_ledger" {
		t.Fatalf("boundary usage wrong: %+v", boundaryBody)
	}

	// Reserve before midnight, settle after: the call stays in its month.
	env.clock.Set(time.Date(2026, 8, 31, 15, 0, 0, 0, time.UTC)) // 23:00 Shanghai, still August
	permit := env.permitFor(t, "translation")
	env.gateway.startBlocked()
	responseDone := make(chan *http.Response, 1)
	go func() {
		// 八月末尾的片段 = 7 UTF-16 units.
		responseDone <- env.sendChunk(t, permit, uuid.NewString(), map[string]any{
			"sourceText": "八月末尾的片段", "sourceLanguage": "zh",
			"targetLanguage": "en", "expectedEngine": "general",
		})
	}()
	waitForGatewayCalls(t, env.gateway, 1)
	env.clock.Set(time.Date(2026, 9, 1, 0, 30, 0, 0, time.UTC)) // 08:30 Shanghai on Sep 1
	env.gateway.release()
	assertStatus(t, <-responseDone, http.StatusOK)
	// The clock jumped ~13h, so the earlier 60-unit reservation correctly
	// aged out as a stale reservation (10 + 60 + 7 = 77); what matters here is
	// that the boundary chunk settled into its original August meter.
	augustUsed, _ := ledgerRow(t, database, "2026-08", "mt_general")
	if augustUsed != 77 {
		t.Fatalf("August settlement missing: used = %d, want 77", augustUsed)
	}
	septemberUsed, septemberReserved := ledgerRow(t, database, "2026-09", "mt_general")
	if septemberUsed != 0 || septemberReserved != 0 {
		t.Fatalf("September meter must stay empty: %d/%d", septemberUsed, septemberReserved)
	}
}

func TestV2AliyunPreflightEngineConflictsNeverCallTheSDK(t *testing.T) {
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
	resetV2AliyunDatabase(t, database)
	defer resetV2AliyunDatabase(t, database)
	env := newV2AliyunEnv(t, database)
	settings := env.defaultSettings()
	settings["translation"].(map[string]any)["generalMonthlyLimit"] = 12
	assertStatus(t, env.putSettings(t, settings), http.StatusOK)

	preflight := sendJSON(t, env.client, http.MethodPost, env.server.URL+"/api/v1/aliyun/preflight", map[string]any{
		"operation": "translation", "sourceLanguage": "zh", "targetLanguage": "en",
		"chunkUnits": []int{10, 25},
	}, env.csrf)
	assertStatus(t, preflight, http.StatusOK)
	var plan struct {
		Operation string `json:"operation"`
		Month     string `json:"month"`
		Items     []struct {
			Index  int    `json:"index"`
			Units  int64  `json:"units"`
			Engine string `json:"engine"`
			Meter  string `json:"meter"`
			Scene  string `json:"scene"`
		} `json:"items"`
		Totals []struct {
			Meter              string `json:"meter"`
			Chunks             int    `json:"chunks"`
			Units              int64  `json:"units"`
			RemainingBefore    int64  `json:"remainingBefore"`
			RemainingAfterPlan int64  `json:"remainingAfterPlan"`
		} `json:"totals"`
	}
	if err := json.Unmarshal(readResponse(t, preflight), &plan); err != nil {
		t.Fatal(err)
	}
	if len(plan.Items) != 2 || plan.Items[0].Engine != "general" || plan.Items[1].Engine != "professional" {
		t.Fatalf("preflight items wrong: %+v", plan.Items)
	}
	if plan.Items[1].Scene != "title" || plan.Items[1].Meter != "mt_professional" {
		t.Fatalf("professional item wrong: %+v", plan.Items[1])
	}
	if len(plan.Totals) != 2 || plan.Totals[1].RemainingAfterPlan != 950000-25 {
		t.Fatalf("preflight totals wrong: %+v", plan.Totals)
	}

	// Preflight language stops happen before any queueing or reservation.
	autoPlan := sendJSON(t, env.client, http.MethodPost, env.server.URL+"/api/v1/aliyun/preflight", map[string]any{
		"operation": "translation", "sourceLanguage": "auto", "targetLanguage": "en",
		"chunkUnits": []int{25},
	}, env.csrf)
	assertErrorCode(t, autoPlan, 422, "SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL")
	badPair := sendJSON(t, env.client, http.MethodPost, env.server.URL+"/api/v1/aliyun/preflight", map[string]any{
		"operation": "translation", "sourceLanguage": "zh", "targetLanguage": "ar",
		"chunkUnits": []int{25},
	}, env.csrf)
	assertErrorCode(t, badPair, 422, "PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED")
	autoTarget := sendJSON(t, env.client, http.MethodPost, env.server.URL+"/api/v1/aliyun/preflight", map[string]any{
		"operation": "translation", "sourceLanguage": "zh", "targetLanguage": "auto",
		"chunkUnits": []int{10},
	}, env.csrf)
	assertErrorCode(t, autoTarget, http.StatusBadRequest, "INVALID_INPUT")

	firstPermit := env.permitFor(t, "translation")
	// 通用片段十个字 = 7 UTF-16 units.
	assertStatus(t, env.sendChunk(t, firstPermit, uuid.NewString(), map[string]any{
		"sourceText": "通用片段十个字", "sourceLanguage": "zh",
		"targetLanguage": "en", "expectedEngine": "general",
	}), http.StatusOK)

	// Remaining general = 5 < 7: the engine flips to professional.
	// 通用额度不够用 = 7 UTF-16 units.
	autoSource := map[string]any{
		"sourceText": "通用额度不够用", "sourceLanguage": "auto",
		"targetLanguage": "en", "expectedEngine": "general",
	}
	assertErrorCode(t, env.sendChunk(t, firstPermit, uuid.NewString(), autoSource), 422,
		"SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL")

	explicit := map[string]any{
		"sourceText": "通用额度不够用", "sourceLanguage": "zh",
		"targetLanguage": "en", "expectedEngine": "general",
	}
	details := assertErrorCode(t, env.sendChunk(t, firstPermit, uuid.NewString(), explicit), http.StatusConflict,
		"PREFLIGHT_CHANGED")
	if details["reason"] != "engine_changed" || details["expectedEngine"] != "general" ||
		details["availableEngine"] != "professional" || details["meter"] != "mt_professional" ||
		details["scene"] != "title" || details["units"] != float64(7) {
		t.Fatalf("preflight changed details wrong: %+v", details)
	}

	unsupported := map[string]any{
		"sourceText": "通用额度不够用", "sourceLanguage": "zh",
		"targetLanguage": "ar", "expectedEngine": "general",
	}
	assertErrorCode(t, env.sendChunk(t, firstPermit, uuid.NewString(), unsupported), 422,
		"PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED")

	if calls := env.gateway.callCount(); calls != 1 {
		t.Fatalf("fake SDK calls = %d, want 1 (stop conditions never call)", calls)
	}
	used, _ := ledgerRow(t, database, "2026-08", "mt_professional")
	if used != 0 {
		t.Fatalf("professional meter must stay zero: %d", used)
	}

	// Turn auto-professional off: exhausted general is a hard stop.
	env.releasePermit(t, firstPermit)
	quotaSettings := copyV2Map(settings)
	quotaSettings["translation"].(map[string]any)["generalMonthlyLimit"] = 10 // used = 7, allowed floor
	quotaSettings["translation"].(map[string]any)["autoUseProfessional"] = false
	assertStatus(t, env.putSettings(t, quotaSettings), http.StatusOK)
	secondPermit := env.permitFor(t, "translation")
	details = assertErrorCode(t, env.sendChunk(t, secondPermit, uuid.NewString(), explicit), 429, "QUOTA_EXHAUSTED")
	if details["meter"] != "mt_general" {
		t.Fatalf("quota details wrong: %+v", details)
	}
	if calls := env.gateway.callCount(); calls != 1 {
		t.Fatalf("exhausted quota must not call the SDK: %d", calls)
	}
}

func TestV2AliyunSettingsLifecyclePATAndQueueErrors(t *testing.T) {
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
	resetV2AliyunDatabase(t, database)
	defer resetV2AliyunDatabase(t, database)
	env := newV2AliyunEnv(t, database)

	initial := sendJSON(t, env.client, http.MethodGet, env.server.URL+"/api/v1/aliyun/settings", nil, "")
	assertStatus(t, initial, http.StatusOK)
	initialBody := string(readResponse(t, initial))
	if !strings.Contains(initialBody, `"configured":false`) ||
		strings.Contains(initialBody, v2AliyunAccessKeyID) {
		t.Fatalf("unconfigured settings leaked or wrong shape: %s", initialBody)
	}

	saved := env.putSettings(t, env.defaultSettings())
	assertStatus(t, saved, http.StatusOK)
	savedBody := string(readResponse(t, saved))
	if !strings.Contains(savedBody, `"accessKeyIdMasked":"****ture"`) ||
		!strings.Contains(savedBody, `"credentialVersion":1`) ||
		strings.Contains(savedBody, v2AliyunAccessKeySecret) ||
		strings.Contains(savedBody, v2AliyunAccessKeyID) {
		t.Fatalf("settings response masked wrong: %s", savedBody)
	}

	var ciphertext []byte
	if err := database.QueryRow(context.Background(),
		"SELECT access_key_id_ciphertext FROM aliyun_service_settings").Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte(v2AliyunAccessKeyID)) || len(ciphertext) < len(v2AliyunAccessKeyID) {
		t.Fatalf("access key id is not encrypted: %d bytes", len(ciphertext))
	}

	// PATs stay forbidden for aliyun settings mutations.
	pat := createM3Token(t, env.client, env.server.URL, env.csrf, "aliyun PAT", []string{"tasks:run"})
	patClient := &http.Client{Transport: env.client.Transport}
	patRequest, _ := http.NewRequest(http.MethodPut, env.server.URL+"/api/v1/aliyun/settings",
		bytes.NewReader([]byte(`{}`)))
	patRequest.Header.Set("Authorization", "Bearer "+pat.Token)
	patRequest.Header.Set("Content-Type", "application/json")
	patResponse := doRequest(t, patClient, patRequest)
	if patResponse.StatusCode != http.StatusForbidden ||
		!bytes.Contains(readResponse(t, patResponse), []byte("MUTATION_NOT_ALLOWED")) {
		t.Fatalf("PAT settings update must be MUTATION_NOT_ALLOWED: %d %s",
			patResponse.StatusCode, readResponse(t, patResponse))
	}

	// Auto-professional without a scene is rejected.
	badSettings := env.defaultSettings()
	badSettings["translation"].(map[string]any)["professionalScene"] = nil
	assertErrorCode(t, env.putSettings(t, badSettings), http.StatusBadRequest, "INVALID_INPUT")

	// Deleting credentials keeps the ledger and stops cloud calls first.
	deleteRequest := newRequest(t, http.MethodDelete, env.server.URL+"/api/v1/aliyun/settings/credentials",
		nil, env.csrf, "")
	assertStatus(t, doRequest(t, env.client, deleteRequest), http.StatusNoContent)
	permit := env.permitFor(t, "translation")
	unconfigured := env.sendChunk(t, permit, uuid.NewString(), map[string]any{
		"sourceText": "未配置凭据", "sourceLanguage": "zh",
		"targetLanguage": "en", "expectedEngine": "general",
	})
	assertErrorCode(t, unconfigured, 422, "ALIYUN_NOT_CONFIGURED")
	if calls := env.gateway.callCount(); calls != 0 {
		t.Fatalf("unconfigured credentials must not call the SDK: %d", calls)
	}
	afterDelete := sendJSON(t, env.client, http.MethodGet, env.server.URL+"/api/v1/aliyun/settings", nil, "")
	assertStatus(t, afterDelete, http.StatusOK)
	if !strings.Contains(string(readResponse(t, afterDelete)), `"configured":false`) {
		t.Fatal("credentials delete did not clear the configured flag")
	}
	var version int64
	if err := database.QueryRow(context.Background(),
		"SELECT credential_version FROM aliyun_service_settings").Scan(&version); err != nil || version != 2 {
		t.Fatalf("credential_version after delete = %d, want 2 (err=%v)", version, err)
	}

	// Queue surface over HTTP.
	unknown := sendJSON(t, env.client, http.MethodGet,
		env.server.URL+"/api/v1/aliyun/queue-tickets/"+uuid.NewString(), nil, "")
	assertErrorCode(t, unknown, http.StatusNotFound, "QUEUE_TICKET_NOT_FOUND")
	badOperation := sendJSON(t, env.client, http.MethodPost, env.server.URL+"/api/v1/aliyun/queue-tickets",
		map[string]any{"operation": "shell"}, env.csrf)
	assertErrorCode(t, badOperation, http.StatusBadRequest, "INVALID_INPUT")

	languages := sendJSON(t, env.client, http.MethodGet,
		env.server.URL+"/api/v1/aliyun/translation/languages", nil, "")
	assertStatus(t, languages, http.StatusOK)
	var languageList struct {
		Version                  string                  `json:"version"`
		GeneralLanguages         []struct{ Code string } `json:"generalLanguages"`
		ProfessionalPairsByScene map[string][][2]string  `json:"professionalPairsByScene"`
	}
	if err := json.Unmarshal(readResponse(t, languages), &languageList); err != nil {
		t.Fatal(err)
	}
	if languageList.Version != "aliyun-language-list-2026-08-31" ||
		len(languageList.GeneralLanguages) != 214 || len(languageList.ProfessionalPairsByScene) != 6 {
		t.Fatalf("language endpoint wrong: version=%q languages=%d scenes=%d",
			languageList.Version, len(languageList.GeneralLanguages), len(languageList.ProfessionalPairsByScene))
	}

	ocrPreflight := sendJSON(t, env.client, http.MethodPost, env.server.URL+"/api/v1/aliyun/preflight",
		map[string]any{"operation": "ocr", "units": 1}, env.csrf)
	assertStatus(t, ocrPreflight, http.StatusOK)
	if body := readResponse(t, ocrPreflight); !bytes.Contains(body, []byte(`"engine":"ocr"`)) ||
		!bytes.Contains(body, []byte(`"professionalScene":null`)) {
		t.Fatalf("ocr preflight wrong: %s", body)
	}
	ocrUnits := sendJSON(t, env.client, http.MethodPost, env.server.URL+"/api/v1/aliyun/preflight",
		map[string]any{"operation": "ocr", "units": 2}, env.csrf)
	assertErrorCode(t, ocrUnits, http.StatusBadRequest, "INVALID_INPUT")
}

func TestV2AliyunLogsContainNoContentOrSecrets(t *testing.T) {
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
	resetV2AliyunDatabase(t, database)
	defer resetV2AliyunDatabase(t, database)
	env := newV2AliyunEnv(t, database)
	assertStatus(t, env.putSettings(t, env.defaultSettings()), http.StatusOK)

	secretText := "机密片段不应进入日志"
	permit := env.permitFor(t, "translation")
	var buffer bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buffer, nil)))
	defer slog.SetDefault(previous)
	response := env.sendChunk(t, permit, uuid.NewString(), map[string]any{
		"sourceText": secretText, "sourceLanguage": "zh",
		"targetLanguage": "en", "expectedEngine": "general",
	})
	assertStatus(t, response, http.StatusOK)
	logOutput := buffer.String()
	for _, forbidden := range []string{secretText, v2AliyunAccessKeyID, v2AliyunAccessKeySecret, permit.token, "fake translation"} {
		if strings.Contains(logOutput, forbidden) {
			t.Fatalf("log leaked forbidden content %q: %s", forbidden, logOutput)
		}
	}
	if !strings.Contains(logOutput, "aliyun_call_settled") {
		t.Fatalf("settlement log line missing: %s", logOutput)
	}
}

// v2AliyunFakeOcrGateway never touches the network; outcomes are scripted
// and every issued call is counted.
type v2AliyunOcrScript struct {
	Result aliyun.OcrResult
	Error  *aliyun.GatewayError
}

type v2AliyunFakeOcrGateway struct {
	mutex sync.Mutex
	calls int
	next  *v2AliyunOcrScript
}

func (gateway *v2AliyunFakeOcrGateway) Recognize(
	ctx context.Context, credentials aliyun.CloudCredentials, image []byte,
) (aliyun.OcrResult, *aliyun.GatewayError) {
	gateway.mutex.Lock()
	gateway.calls++
	outcome := v2AliyunOcrScript{Result: aliyun.OcrResult{
		Text: "识别文本", UpstreamRequestID: "fake-ocr-request-id",
	}}
	if gateway.next != nil {
		outcome = *gateway.next
		gateway.next = nil
	}
	gateway.mutex.Unlock()
	return outcome.Result, outcome.Error
}

func (gateway *v2AliyunFakeOcrGateway) callCount() int {
	gateway.mutex.Lock()
	defer gateway.mutex.Unlock()
	return gateway.calls
}

func (gateway *v2AliyunFakeOcrGateway) setNext(script v2AliyunOcrScript) {
	gateway.mutex.Lock()
	defer gateway.mutex.Unlock()
	gateway.next = &script
}

func syntheticOCRPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	imageData := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			imageData.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 0x55, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, imageData); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func (env *v2AliyunEnv) sendOCR(
	t *testing.T, permit v2AliyunPermit, idempotencyKey, contentType string, content []byte,
) *http.Response {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="image"; filename="fixture.png"`)
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := newRequest(t, http.MethodPost, env.server.URL+"/api/v1/aliyun/ocr", &body,
		env.csrf, writer.FormDataContentType())
	request.Header.Set("Idempotency-Key", idempotencyKey)
	request.Header.Set("X-Cloud-Permit", permit.token)
	return doRequest(t, env.client, request)
}

func attachmentCount(t *testing.T, database *pgxpool.Pool) int64 {
	t.Helper()
	var count int64
	if err := database.QueryRow(context.Background(), "SELECT count(*) FROM attachments").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestV2AliyunOCREndToEndAndSettlement(t *testing.T) {
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
	resetV2AliyunDatabase(t, database)
	defer resetV2AliyunDatabase(t, database)
	env := newV2AliyunEnv(t, database)
	// Owner concurrency 2 lets the OCR and the mismatch-probe translation
	// permit coexist in the single-owner queue.
	settings := env.defaultSettings()
	settings["concurrency"] = map[string]any{"owner": 2, "global": 3}
	assertStatus(t, env.putSettings(t, settings), http.StatusOK)

	// Preflight confirms exactly one OCR call before anything is uploaded.
	preflight := sendJSON(t, env.client, http.MethodPost, env.server.URL+"/api/v1/aliyun/preflight",
		map[string]any{"operation": "ocr", "units": 1}, env.csrf)
	assertStatus(t, preflight, http.StatusOK)

	attachmentsBefore := attachmentCount(t, database)
	permit := env.permitFor(t, "ocr")
	validPNG := syntheticOCRPNG(t, 64, 32)

	// Confirmation-class failures happen before any SDK call.
	typeMismatch := env.sendOCR(t, permit, uuid.NewString(), "image/jpeg", validPNG)
	details := assertErrorCode(t, typeMismatch, http.StatusBadRequest, "INVALID_INPUT")
	if details["reason"] != "type_mismatch" {
		t.Fatalf("type mismatch details wrong: %+v", details)
	}
	translationPermit := env.permitFor(t, "translation")
	operationMismatch := env.sendOCR(t, translationPermit, uuid.NewString(), "image/png", validPNG)
	assertErrorCode(t, operationMismatch, http.StatusConflict, "CLOUD_PERMIT_OPERATION_MISMATCH")
	if calls := env.ocrGateway.callCount(); calls != 0 {
		t.Fatalf("pre-call rejections reached the OCR SDK: %d", calls)
	}

	// Successful recognition bills exactly one unit.
	firstKey := uuid.NewString()
	success := env.sendOCR(t, permit, firstKey, "image/png", validPNG)
	assertStatus(t, success, http.StatusOK)
	var successBody struct {
		Text              string `json:"text"`
		UpstreamRequestID string `json:"upstreamRequestId"`
		BillableUnits     int64  `json:"billableUnits"`
		Quota             struct {
			Meter     string `json:"meter"`
			Remaining int64  `json:"remaining"`
		} `json:"quota"`
		Replayed bool `json:"replayed"`
	}
	if err := json.Unmarshal(readResponse(t, success), &successBody); err != nil {
		t.Fatal(err)
	}
	if successBody.Text != "识别文本" || successBody.UpstreamRequestID != "fake-ocr-request-id" ||
		successBody.BillableUnits != 1 || successBody.Quota.Meter != "ocr_general" ||
		successBody.Quota.Remaining != 189 || successBody.Replayed {
		t.Fatalf("unexpected ocr success: %+v", successBody)
	}
	used, reserved := ledgerRow(t, database, "2026-08", "ocr_general")
	if used != 1 || reserved != 0 {
		t.Fatalf("after success ledger = %d/%d, want 1/0", used, reserved)
	}
	if calls := env.ocrGateway.callCount(); calls != 1 {
		t.Fatalf("ocr sdk calls = %d, want 1", calls)
	}

	// Same key replay: settled without result, no second SDK call.
	replay := env.sendOCR(t, permit, firstKey, "image/png", validPNG)
	details = assertErrorCode(t, replay, http.StatusConflict, "CALL_SETTLED_WITHOUT_RESULT")
	if details["callStatus"] != "succeeded" || details["replayed"] != true || details["meter"] != "ocr_general" {
		t.Fatalf("ocr replay details wrong: %+v", details)
	}
	if calls := env.ocrGateway.callCount(); calls != 1 {
		t.Fatalf("ocr replay re-issued the call: %d", calls)
	}

	// Uncertain outcome counts as used, never auto-retried.
	env.ocrGateway.setNext(v2AliyunOcrScript{Error: &aliyun.GatewayError{
		Category: "timeout", Uncertain: true,
	}})
	uncertain := env.sendOCR(t, permit, uuid.NewString(), "image/png", validPNG)
	details = assertErrorCode(t, uncertain, http.StatusGatewayTimeout, "UPSTREAM_RESULT_UNCERTAIN")
	if details["callStatus"] != "uncertain" || details["countedUnits"] != float64(1) {
		t.Fatalf("ocr uncertain details wrong: %+v", details)
	}

	// Provable upstream rejection restores the unit but keeps the category.
	env.ocrGateway.setNext(v2AliyunOcrScript{Error: &aliyun.GatewayError{
		Category: "invalid_image", UpstreamNonSuccess: true, RequestID: "req-ocr-reject",
	}})
	rejected := env.sendOCR(t, permit, uuid.NewString(), "image/png", validPNG)
	details = assertErrorCode(t, rejected, http.StatusBadGateway, "UPSTREAM_REJECTED")
	if details["callStatus"] != "released" || details["countedUnits"] != nil ||
		details["failureCategory"] != "invalid_image" || details["upstreamRequestId"] != "req-ocr-reject" {
		t.Fatalf("ocr rejection details wrong: %+v", details)
	}
	used, reserved = ledgerRow(t, database, "2026-08", "ocr_general")
	if used != 2 || reserved != 0 {
		t.Fatalf("after uncertain+released ledger = %d/%d, want 2/0", used, reserved)
	}
	if calls := env.ocrGateway.callCount(); calls != 3 {
		t.Fatalf("ocr sdk calls = %d, want 3", calls)
	}
	var failureCategory string
	if err := database.QueryRow(context.Background(),
		"SELECT last_failure_category FROM aliyun_service_settings WHERE id = 1").Scan(&failureCategory); err != nil {
		t.Fatal(err)
	}
	if failureCategory != "invalid_image" {
		t.Fatalf("last failure category = %q, want invalid_image", failureCategory)
	}

	// Hard stop at the ledger floor; the SDK is never reached.
	exhaustedSettings := copyV2Map(settings)
	exhaustedSettings["ocr"] = map[string]any{"monthlyLimit": 2}
	assertStatus(t, env.putSettings(t, exhaustedSettings), http.StatusOK)
	exhausted := env.sendOCR(t, permit, uuid.NewString(), "image/png", validPNG)
	details = assertErrorCode(t, exhausted, http.StatusTooManyRequests, "QUOTA_EXHAUSTED")
	if details["meter"] != "ocr_general" || details["remaining"] != float64(0) {
		t.Fatalf("quota exhausted details wrong: %+v", details)
	}
	if calls := env.ocrGateway.callCount(); calls != 3 {
		t.Fatalf("exhausted quota must not call the OCR SDK: %d", calls)
	}

	// No image landed anywhere: attachments table untouched.
	if after := attachmentCount(t, database); after != attachmentsBefore {
		t.Fatalf("attachments changed: before=%d after=%d", attachmentsBefore, after)
	}
}

func TestV2AliyunOCRLogsContainNoImageOrText(t *testing.T) {
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
	resetV2AliyunDatabase(t, database)
	defer resetV2AliyunDatabase(t, database)
	env := newV2AliyunEnv(t, database)
	assertStatus(t, env.putSettings(t, env.defaultSettings()), http.StatusOK)

	permit := env.permitFor(t, "ocr")
	var buffer bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buffer, nil)))
	defer slog.SetDefault(previous)
	response := env.sendOCR(t, permit, uuid.NewString(), "image/png", syntheticOCRPNG(t, 32, 32))
	assertStatus(t, response, http.StatusOK)
	logOutput := buffer.String()
	for _, forbidden := range []string{"识别文本", "fake-ocr-request-id", permit.token, "fixture.png", "image/png"} {
		if strings.Contains(logOutput, forbidden) {
			t.Fatalf("ocr log leaked %q: %s", forbidden, logOutput)
		}
	}
	if !strings.Contains(logOutput, "aliyun_call_settled") ||
		!strings.Contains(logOutput, "ocr_general") ||
		strings.Contains(logOutput, "\"text\"") {
		t.Fatalf("ocr settlement log wrong: %s", logOutput)
	}
}

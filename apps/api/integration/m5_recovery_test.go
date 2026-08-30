//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/ai"
	artifactcontract "github.com/hxf4869/dev-toolbox/apps/api/internal/ai/schema"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/knowledge"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/operations"
)

const (
	m5RecoveryPassword   = "M5 recovery correct horse 电池 staple"
	m5RecoveryTextCount  = 20
	m5RecoveryImageCount = 5
	m5RecoveryFileCount  = 5
)

type m5RecoveryFixtureState struct {
	ManualTOTPKey      string      `json:"manualTotpKey"`
	TextItemIDs        []uuid.UUID `json:"textItemIds"`
	ImageAttachmentIDs []uuid.UUID `json:"imageAttachmentIds"`
	FileAttachmentIDs  []uuid.UUID `json:"fileAttachmentIds"`
	FolderID           uuid.UUID   `json:"folderId"`
	TagID              uuid.UUID   `json:"tagId"`
	TrashedItemID      uuid.UUID   `json:"trashedItemId"`
	ArtifactItemID     uuid.UUID   `json:"artifactItemId"`
	ArtifactIDs        []uuid.UUID `json:"artifactIds"`
	ActiveArtifactID   uuid.UUID   `json:"activeArtifactId"`
	RevokedTrustedID   uuid.UUID   `json:"revokedTrustedDeviceId"`
}

type m5RecoveryVerification struct {
	Version                int    `json:"version"`
	State                  string `json:"state"`
	TextRecordsVerified    int    `json:"textRecordsVerified"`
	OriginalImagesVerified int    `json:"originalImagesVerified"`
	OrdinaryFilesVerified  int    `json:"ordinaryFilesVerified"`
	ReferencedAttachments  int    `json:"referencedAttachments"`
	VerifiedAttachments    int    `json:"verifiedAttachments"`
	AuthenticationVerified bool   `json:"authenticationVerified"`
	OrganizationVerified   bool   `json:"organizationVerified"`
	TrashVerified          bool   `json:"trashVerified"`
	AIVersionsVerified     bool   `json:"aiVersionsVerified"`
	ContainsUserContent    bool   `json:"containsUserContent"`
}

func TestM5RecoveryFixture(t *testing.T) {
	mode := os.Getenv("RUN_M5_RECOVERY_FIXTURE")
	if mode == "" {
		t.Skip("RUN_M5_RECOVERY_FIXTURE is not enabled")
	}
	if mode != "seed" && mode != "verify" {
		t.Fatalf("unsupported recovery fixture mode %q", mode)
	}
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	attachmentRoot := os.Getenv("M5_RECOVERY_ATTACHMENT_ROOT")
	statePath := os.Getenv("M5_RECOVERY_STATE_PATH")
	if databaseURL == "" || attachmentRoot == "" || statePath == "" {
		t.Fatal("TEST_DATABASE_URL, M5_RECOVERY_ATTACHMENT_ROOT and M5_RECOVERY_STATE_PATH are required")
	}
	assertTestDatabase(t, databaseURL)
	masterKey := readM5RecoveryMasterKey(t)
	database, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	if mode == "seed" {
		seedM5RecoveryFixture(t, database, attachmentRoot, masterKey, statePath)
		return
	}
	resultPath := os.Getenv("M5_RECOVERY_RESULT_PATH")
	if resultPath == "" {
		t.Fatal("M5_RECOVERY_RESULT_PATH is required in verify mode")
	}
	verifyM5RecoveryFixture(t, database, attachmentRoot, masterKey, statePath, resultPath)
}

func seedM5RecoveryFixture(t *testing.T, database *pgxpool.Pool, attachmentRoot string, masterKey []byte, statePath string) {
	t.Helper()
	ctx := context.Background()
	var owners, items int
	if err := database.QueryRow(ctx, `SELECT (SELECT count(*) FROM owner_account), (SELECT count(*) FROM knowledge_items)`).Scan(&owners, &items); err != nil {
		t.Fatal(err)
	}
	if owners != 0 || items != 0 {
		t.Fatalf("recovery seed database is not empty: owners=%d items=%d", owners, items)
	}
	if err := auth.InitializeOwner(ctx, database, "owner", m5RecoveryPassword, time.Now()); err != nil {
		t.Fatal(err)
	}
	server := newM5RecoveryServer(t, database, attachmentRoot, masterKey)
	defer server.Close()
	client, csrf, manualKey := enrollM5RecoveryOwner(t, server)

	devices := doRequest(t, client, newRequest(t, http.MethodGet, server.URL+"/api/v1/auth/trusted-devices", nil, "", ""))
	assertStatus(t, devices, http.StatusOK)
	var deviceList struct {
		Items []struct {
			ID uuid.UUID `json:"id"`
		} `json:"items"`
	}
	decodeInto(t, readResponse(t, devices), &deviceList)
	if len(deviceList.Items) != 1 {
		t.Fatalf("trusted device count = %d, want 1", len(deviceList.Items))
	}
	revokedTrustedID := deviceList.Items[0].ID
	revoke := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/auth/trusted-devices/"+revokedTrustedID.String(), map[string]any{}, csrf)
	assertStatus(t, revoke, http.StatusNoContent)

	folderID := createFolder(t, client, server.URL, csrf, "恢复演练目录", nil)
	tagID := createTag(t, client, server.URL, csrf, "恢复演练标签")
	state := m5RecoveryFixtureState{
		ManualTOTPKey: manualKey, FolderID: folderID, TagID: tagID, RevokedTrustedID: revokedTrustedID,
		TextItemIDs: []uuid.UUID{}, ImageAttachmentIDs: []uuid.UUID{}, FileAttachmentIDs: []uuid.UUID{}, ArtifactIDs: []uuid.UUID{},
	}
	var artifactRawID uuid.UUID
	for index := 1; index <= m5RecoveryTextCount; index++ {
		folderValue, tagValues := any(nil), []string{}
		if index == 1 {
			folderValue = folderID.String()
			tagValues = []string{tagID.String()}
		}
		created := createM2Item(t, client, server.URL, csrf, fmt.Sprintf("m5-recovery-text-%02d", index), map[string]any{
			"body": m5RecoveryTextBody(index), "contentFormat": "plain_text", "sensitivity": "normal",
			"title": fmt.Sprintf("恢复文本 %02d", index), "folderId": folderValue, "tagIds": tagValues,
		})
		state.TextItemIDs = append(state.TextItemIDs, created.Item.ID)
		if index == 1 {
			state.ArtifactItemID = created.Item.ID
			artifactRawID = created.RawRecord.ID
		}
	}
	state.TrashedItemID = state.TextItemIDs[len(state.TextItemIDs)-1]
	trash := sendJSON(t, client, http.MethodDelete, server.URL+"/api/v1/items/"+state.TrashedItemID.String(), map[string]any{}, csrf)
	assertStatus(t, trash, http.StatusNoContent)

	pngBytes := testPNG(t)
	for index := 1; index <= m5RecoveryImageCount; index++ {
		created := sendMultipart(t, client, server.URL+"/api/v1/items:multipart", csrf, fmt.Sprintf("m5-recovery-image-%02d", index), map[string]any{
			"body": "", "contentFormat": "plain_text", "sensitivity": "normal",
			"title": fmt.Sprintf("恢复原图 %02d", index), "folderId": nil, "tagIds": []string{},
		}, fmt.Sprintf("recovery-image-%02d.png", index), "image/png", pngBytes)
		assertStatus(t, created, http.StatusCreated)
		payload := decodeResponse[apiResponse](t, created)
		if len(payload.Attachments) != 1 {
			t.Fatalf("image fixture %d attachment count = %d", index, len(payload.Attachments))
		}
		state.ImageAttachmentIDs = append(state.ImageAttachmentIDs, payload.Attachments[0].ID)
	}
	for index := 1; index <= m5RecoveryFileCount; index++ {
		created := sendMultipart(t, client, server.URL+"/api/v1/items:multipart", csrf, fmt.Sprintf("m5-recovery-file-%02d", index), map[string]any{
			"body": "", "contentFormat": "plain_text", "sensitivity": "normal",
			"title": fmt.Sprintf("恢复附件 %02d", index), "folderId": nil, "tagIds": []string{},
		}, fmt.Sprintf("recovery-file-%02d.bin", index), "application/octet-stream", m5RecoveryFileBytes(index))
		assertStatus(t, created, http.StatusCreated)
		payload := decodeResponse[apiResponse](t, created)
		if len(payload.Attachments) != 1 {
			t.Fatalf("file fixture %d attachment count = %d", index, len(payload.Attachments))
		}
		state.FileAttachmentIDs = append(state.FileAttachmentIDs, payload.Attachments[0].ID)
	}

	patClient := &http.Client{Transport: client.Transport}
	agent := createM3Token(t, client, server.URL, csrf, "恢复演练 Agent", []string{"records:read", "artifacts:write"})
	fragments := rawFragmentIDs(t, database, state.ArtifactItemID)
	if len(fragments) == 0 {
		t.Fatal("recovery artifact source has no search fragment")
	}
	for version := 1; version <= 2; version++ {
		content := validM3Artifact(fragments[0])
		content["summary"] = fmt.Sprintf("恢复演练 AI 版本 %d", version)
		response := sendM3PATJSON(t, patClient, http.MethodPost, server.URL+"/api/v1/items/"+state.ArtifactItemID.String()+"/artifacts", map[string]any{
			"generator": "external_agent", "generatorName": "Recovery Fixture", "modelName": "fixture-model",
			"schemaVersion": "1.0", "sourceRawRecordIds": []string{artifactRawID.String()}, "content": content,
		}, agent.Token, "")
		assertStatus(t, response, http.StatusCreated)
		var artifact struct {
			ID uuid.UUID `json:"id"`
		}
		decodeInto(t, readResponse(t, response), &artifact)
		state.ArtifactIDs = append(state.ArtifactIDs, artifact.ID)
	}
	state.ActiveArtifactID = state.ArtifactIDs[1]
	activate := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/artifacts/"+state.ActiveArtifactID.String()+"/activate", map[string]any{}, csrf)
	assertStatus(t, activate, http.StatusOK)
	_ = readResponse(t, activate)

	report, err := operations.CheckIntegrity(ctx, database, attachmentRoot, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if report.State != "succeeded" || report.ReferencedAttachments != m5RecoveryImageCount+m5RecoveryFileCount {
		t.Fatalf("seed attachment integrity failed: %+v", report)
	}
	writeM5RecoveryJSON(t, statePath, state, 0o600)
}

func verifyM5RecoveryFixture(
	t *testing.T,
	database *pgxpool.Pool,
	attachmentRoot string,
	masterKey []byte,
	statePath, resultPath string,
) {
	t.Helper()
	ctx := context.Background()
	var state m5RecoveryFixtureState
	readM5RecoveryJSON(t, statePath, &state)
	if len(state.TextItemIDs) != m5RecoveryTextCount || len(state.ImageAttachmentIDs) != m5RecoveryImageCount ||
		len(state.FileAttachmentIDs) != m5RecoveryFileCount || len(state.ArtifactIDs) != 2 {
		t.Fatalf("recovery fixture state has unexpected cardinality: %+v", state)
	}

	server := newM5RecoveryServer(t, database, attachmentRoot, masterKey)
	defer server.Close()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := server.Client()
	client.Jar = jar
	login := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{
		"username": "owner", "password": m5RecoveryPassword,
	}, "")
	assertStatus(t, login, http.StatusAccepted)
	challengeID := decodeResponse[apiResponse](t, login).ChallengeID
	code, err := totp.GenerateCode(state.ManualTOTPKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	verifiedLogin := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/mfa/verify", map[string]any{
		"challengeId": challengeID, "method": "totp", "code": code, "trustDevice": false, "deviceName": "",
	}, "")
	assertStatus(t, verifiedLogin, http.StatusOK)
	if decodeResponse[apiResponse](t, verifiedLogin).Status != "authenticated" {
		t.Fatal("restored password and TOTP did not authenticate")
	}
	var revokedDevices, recoveryCodes int
	if err := database.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM trusted_devices WHERE id = $1 AND revoked_at IS NOT NULL),
		(SELECT count(*) FROM mfa_recovery_codes WHERE used_at IS NULL)
	`, state.RevokedTrustedID).Scan(&revokedDevices, &recoveryCodes); err != nil {
		t.Fatal(err)
	}
	if revokedDevices != 1 || recoveryCodes != 10 {
		t.Fatalf("restored auth state differs: revoked devices=%d recovery codes=%d", revokedDevices, recoveryCodes)
	}

	for index, itemID := range state.TextItemIDs {
		var body string
		if err := database.QueryRow(ctx, `SELECT body FROM raw_records WHERE item_id = $1 AND record_role = 'primary'`, itemID).Scan(&body); err != nil {
			t.Fatal(err)
		}
		if body != m5RecoveryTextBody(index+1) {
			t.Fatalf("restored text fixture %d changed", index+1)
		}
	}
	pngBytes := testPNG(t)
	verifyM5RecoveryAttachments(t, database, attachmentRoot, state.ImageAttachmentIDs, "image", func(int) []byte { return pngBytes })
	verifyM5RecoveryAttachments(t, database, attachmentRoot, state.FileAttachmentIDs, "file", m5RecoveryFileBytes)

	var folderName, tagName string
	var itemTags int
	if err := database.QueryRow(ctx, `SELECT
		(SELECT name FROM folders WHERE id = $1),
		(SELECT name FROM tags WHERE id = $2),
		(SELECT count(*) FROM knowledge_items item JOIN item_tags relation ON relation.item_id = item.id
		 WHERE item.id = $3 AND item.folder_id = $1 AND relation.tag_id = $2)
	`, state.FolderID, state.TagID, state.TextItemIDs[0]).Scan(&folderName, &tagName, &itemTags); err != nil {
		t.Fatal(err)
	}
	if folderName != "恢复演练目录" || tagName != "恢复演练标签" || itemTags != 1 {
		t.Fatalf("restored organization state differs: folder=%q tag=%q links=%d", folderName, tagName, itemTags)
	}
	var trashed bool
	if err := database.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM knowledge_items WHERE id = $1`, state.TrashedItemID).Scan(&trashed); err != nil {
		t.Fatal(err)
	}
	if !trashed {
		t.Fatal("restored trash state is missing")
	}
	var artifactVersions []int32
	rows, err := database.Query(ctx, `SELECT version_number FROM ai_artifacts WHERE id = ANY($1) ORDER BY version_number`, state.ArtifactIDs)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var version int32
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		artifactVersions = append(artifactVersions, version)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	var activeArtifact uuid.UUID
	if err := database.QueryRow(ctx, `SELECT artifact_id FROM item_active_artifacts WHERE item_id = $1 AND artifact_type = 'organized_record'`, state.ArtifactItemID).Scan(&activeArtifact); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(artifactVersions) != "[1 2]" || activeArtifact != state.ActiveArtifactID {
		t.Fatalf("restored AI versions differ: versions=%v active=%s", artifactVersions, activeArtifact)
	}

	integrity, err := operations.CheckIntegrity(ctx, database, attachmentRoot, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if integrity.State != "succeeded" || integrity.VerifiedAttachments != integrity.ReferencedAttachments || len(integrity.OrphanAttachments) != 0 {
		t.Fatalf("restored attachment integrity failed: %+v", integrity)
	}
	writeM5RecoveryJSON(t, resultPath, m5RecoveryVerification{
		Version: 1, State: "succeeded", TextRecordsVerified: len(state.TextItemIDs),
		OriginalImagesVerified: len(state.ImageAttachmentIDs), OrdinaryFilesVerified: len(state.FileAttachmentIDs),
		ReferencedAttachments: integrity.ReferencedAttachments, VerifiedAttachments: integrity.VerifiedAttachments,
		AuthenticationVerified: true, OrganizationVerified: true, TrashVerified: true, AIVersionsVerified: true,
		ContainsUserContent: false,
	}, 0o644)
}

func newM5RecoveryServer(t *testing.T, database *pgxpool.Pool, attachmentRoot string, masterKey []byte) *httptest.Server {
	t.Helper()
	authService, err := auth.NewService(database, masterKey, testOrigin, "127.0.0.0/8")
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
	aiService := ai.NewService(database, masterKey, validator, "http://127.0.0.1:1", m3InternalToken, attachmentRoot, false)
	router := http.NewServeMux()
	authService.RegisterRoutes(router)
	knowledgeService.RegisterRoutes(router, authService)
	aiService.RegisterRoutes(router, authService)
	return httptest.NewTLSServer(router)
}

func enrollM5RecoveryOwner(t *testing.T, server *httptest.Server) (*http.Client, string, string) {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := server.Client()
	client.Jar = jar
	login := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", map[string]any{
		"username": "owner", "password": m5RecoveryPassword,
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
		"challengeId": challengeID, "code": code, "trustDevice": true, "deviceName": "恢复演练浏览器",
	}, "")
	assertStatus(t, confirm, http.StatusOK)
	return client, decodeResponse[apiResponse](t, confirm).CSRFToken, provisioning.ManualKey
}

func verifyM5RecoveryAttachments(
	t *testing.T,
	database *pgxpool.Pool,
	root string,
	attachmentIDs []uuid.UUID,
	wantKind string,
	wantBytes func(int) []byte,
) {
	t.Helper()
	for index, attachmentID := range attachmentIDs {
		var kind, storageKey string
		if err := database.QueryRow(context.Background(), `SELECT kind, storage_key FROM attachments WHERE id = $1`, attachmentID).Scan(&kind, &storageKey); err != nil {
			t.Fatal(err)
		}
		if kind != wantKind {
			t.Fatalf("restored attachment %s kind = %q, want %q", attachmentID, kind, wantKind)
		}
		actual, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(storageKey)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(actual, wantBytes(index+1)) {
			t.Fatalf("restored attachment sample %d changed bytes", index+1)
		}
	}
}

func readM5RecoveryMasterKey(t *testing.T) []byte {
	t.Helper()
	path := os.Getenv("M5_RECOVERY_MASTER_KEY_FILE")
	if path == "" {
		t.Fatal("M5_RECOVERY_MASTER_KEY_FILE is required")
	}
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	key, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(encoded)))
	if err != nil || len(key) != 32 {
		t.Fatal("recovery master key must be base64-encoded 32 bytes")
	}
	return key
}

func m5RecoveryTextBody(index int) string {
	return fmt.Sprintf("M5 空机恢复合成文本 %02d；只用于验证 PostgreSQL dump 的原文一致性。", index)
}

func m5RecoveryFileBytes(index int) []byte {
	return []byte(fmt.Sprintf("m5 recovery ordinary attachment %02d\n", index))
}

func writeM5RecoveryJSON(t *testing.T, path string, value any, mode os.FileMode) {
	t.Helper()
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	content = append(content, '\n')
	if err := os.WriteFile(path, content, mode); err != nil {
		t.Fatal(err)
	}
}

func readM5RecoveryJSON(t *testing.T, path string, target any) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(content, target); err != nil {
		t.Fatal(err)
	}
}

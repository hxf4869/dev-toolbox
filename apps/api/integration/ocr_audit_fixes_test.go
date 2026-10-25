//go:build integration

package integration_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pquerna/otp/totp"
)

func TestOCRFixAuthChallengesExpireWithSecurityChanges(t *testing.T) {
	for _, action := range []string{"password", "logout-all", "enroll"} {
		t.Run(action, func(t *testing.T) {
			h := newV3Harness(t)
			code, err := totp.GenerateCode(h.totpSecret, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			beginReset := func() (string, string) {
				response := h.post(t, "/api/v1/auth/totp/reset", map[string]any{
					"password": "V3 correct horse 电池 staple", "method": "totp", "code": code,
				})
				assertStatus(t, response, http.StatusAccepted)
				challenge := decodeResponse[apiResponse](t, response).ChallengeID
				setup := h.post(t, "/api/v1/auth/totp/setup", map[string]any{"challengeId": challenge})
				assertStatus(t, setup, http.StatusOK)
				return challenge, decodeResponse[apiResponse](t, setup).ManualKey
			}
			oldChallenge, oldSecret := beginReset()
			switch action {
			case "password":
				response := h.post(t, "/api/v1/auth/password/change", map[string]any{
					"currentPassword": "V3 correct horse 电池 staple", "newPassword": "New synthetic password 电池 staple",
					"method": "totp", "code": code,
				})
				assertStatus(t, response, http.StatusNoContent)
				response.Body.Close()
			case "logout-all":
				response := h.post(t, "/api/v1/auth/logout-all", map[string]any{})
				assertStatus(t, response, http.StatusNoContent)
				response.Body.Close()
			case "enroll":
				newChallenge, newSecret := beginReset()
				newCode, err := totp.GenerateCode(newSecret, time.Now())
				if err != nil {
					t.Fatal(err)
				}
				response := h.post(t, "/api/v1/auth/totp/confirm", map[string]any{"challengeId": newChallenge, "code": newCode})
				assertStatus(t, response, http.StatusOK)
				response.Body.Close()
			}
			oldCode, err := totp.GenerateCode(oldSecret, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			replay := h.post(t, "/api/v1/auth/totp/confirm", map[string]any{"challengeId": oldChallenge, "code": oldCode})
			assertStatus(t, replay, http.StatusUnauthorized)
			replay.Body.Close()
			var consumed bool
			if err := h.database.QueryRow(context.Background(), `SELECT consumed_at IS NOT NULL FROM auth_challenges WHERE id = $1`, oldChallenge).Scan(&consumed); err != nil || !consumed {
				t.Fatalf("old challenge remains active: consumed=%v err=%v", consumed, err)
			}
		})
	}
}

func TestOCRFixStaleRunRetryKeepsSuccessfulAnswer(t *testing.T) {
	h := newV3Harness(t)
	const worker = "ocr-retry-worker"
	oldRun, lease := startAndClaimV3Run(t, h, worker)
	failed := h.internalPost(t, "/internal/assistant/runs/"+oldRun+"/fail", map[string]any{
		"workerId": worker, "leaseVersion": lease, "errorCode": "ASSISTANT_PROVIDER_UNAVAILABLE",
		"errorDetail": "synthetic interruption", "usage": map[string]any{}, "timings": map[string]any{},
	})
	assertStatus(t, failed, http.StatusOK)
	failed.Body.Close()
	var modelID uuid.UUID
	if err := h.database.QueryRow(context.Background(), `SELECT model_id FROM assistant_runs WHERE id = $1`, oldRun).Scan(&modelID); err != nil {
		t.Fatal(err)
	}
	retryPayload := map[string]any{"clientRequestId": uuid.New(), "modelId": modelID, "reasoning": "off"}
	retry := h.post(t, "/api/v1/assistant/runs/"+oldRun+"/retry", retryPayload)
	assertStatus(t, retry, http.StatusAccepted)
	retry.Body.Close()
	claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": worker})
	assertStatus(t, claim, http.StatusOK)
	var claimed struct {
		Run struct {
			ID           string `json:"id"`
			LeaseVersion int    `json:"leaseVersion"`
		} `json:"run"`
	}
	decodeInto(t, readResponse(t, claim), &claimed)
	delta := h.internalPost(t, "/internal/assistant/runs/"+claimed.Run.ID+"/events", map[string]any{
		"workerId": worker, "leaseVersion": claimed.Run.LeaseVersion,
		"events": []map[string]any{{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": "后续成功回答"}}},
	})
	assertStatus(t, delta, http.StatusOK)
	delta.Body.Close()
	if status := completeClaimedV3Run(t, h, claimed.Run.ID, worker, claimed.Run.LeaseVersion); status != "succeeded" {
		t.Fatalf("retry did not succeed: %s", status)
	}
	stale := h.post(t, "/api/v1/assistant/runs/"+oldRun+"/retry", map[string]any{
		"clientRequestId": uuid.New(), "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, stale, http.StatusConflict)
	stale.Body.Close()
	var currentRun, content string
	if err := h.database.QueryRow(context.Background(), `
		SELECT current_run_id::text, content FROM assistant_messages
		WHERE id = (SELECT output_message_id FROM assistant_runs WHERE id = $1)
	`, oldRun).Scan(&currentRun, &content); err != nil || currentRun != claimed.Run.ID || content != "后续成功回答" {
		t.Fatalf("successful answer changed: run=%s content=%q err=%v", currentRun, content, err)
	}
	// The original retry request remains an idempotent replay after success.
	replay := h.post(t, "/api/v1/assistant/runs/"+oldRun+"/retry", retryPayload)
	assertStatus(t, replay, http.StatusAccepted)
	replay.Body.Close()
}

func TestOCRFixConversationCursorAcrossPinnedAndFolders(t *testing.T) {
	h := newV3Harness(t)
	created := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "合成分页目录"})
	assertStatus(t, created, http.StatusCreated)
	var folder struct {
		ID uuid.UUID `json:"id"`
	}
	decodeInto(t, readResponse(t, created), &folder)
	now := time.Now().UTC().Truncate(time.Microsecond)
	for index := 0; index < 8; index++ {
		var folderID *uuid.UUID
		if index%2 == 0 {
			folderID = &folder.ID
		}
		var pinned *time.Time
		if index < 4 {
			value := now.Add(-time.Duration(index/2) * time.Minute)
			pinned = &value
		}
		if _, err := h.database.Exec(context.Background(), `
			INSERT INTO assistant_conversations (id, folder_id, title, title_origin, pinned_at, created_at, updated_at)
			VALUES ($1, $2, '合成会话', 'user', $3, $4, $5)
		`, uuid.New(), folderID, pinned, now, now.Add(-time.Duration(index/2)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	for _, filter := range []string{"", folder.ID.String(), "unfiled"} {
		t.Run(filter, func(t *testing.T) {
			rows, err := h.database.Query(context.Background(), `
				SELECT id::text FROM assistant_conversations
				WHERE $1 = '' OR ($1 = 'unfiled' AND folder_id IS NULL) OR folder_id::text = $1
				ORDER BY pinned_at DESC NULLS LAST, updated_at DESC, id DESC
			`, filter)
			if err != nil {
				t.Fatal(err)
			}
			var expected []string
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					t.Fatal(err)
				}
				expected = append(expected, id)
			}
			rows.Close()
			var actual []string
			cursor := ""
			for page := 0; page < 10; page++ {
				response := h.get(t, "/api/v1/assistant/conversations?limit=2&folderId="+filter+"&cursor="+url.QueryEscape(cursor))
				assertStatus(t, response, http.StatusOK)
				var result struct {
					Items []struct {
						ID string `json:"id"`
					} `json:"items"`
					NextCursor *string `json:"nextCursor"`
				}
				decodeInto(t, readResponse(t, response), &result)
				for _, item := range result.Items {
					actual = append(actual, item.ID)
				}
				if result.NextCursor == nil {
					break
				}
				cursor = *result.NextCursor
			}
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("cursor order differs: got %v want %v", actual, expected)
			}
		})
	}
}

func TestOCRFixLeaseRecoveryRebuildsSources(t *testing.T) {
	h := newV3Harness(t)
	runID, _ := startAndClaimV3Run(t, h, "ocr-first-worker")
	item := seedV3Knowledge(t, h.database, "合成来源", "合成检索内容", "normal")
	insertV3RunSource(t, h.database, runID, item, "合成来源", "合成检索内容")
	if _, err := h.database.Exec(context.Background(), `UPDATE assistant_runs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, runID); err != nil {
		t.Fatal(err)
	}
	claimed := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": "ocr-recovery-worker"})
	assertStatus(t, claimed, http.StatusOK)
	claimed.Body.Close()
	var count int
	if err := h.database.QueryRow(context.Background(), `SELECT count(*) FROM assistant_run_sources WHERE run_id = $1`, runID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("recovered run retained sources: count=%d err=%v", count, err)
	}
	// The next retrieval can insert the same ordinal again without a PK conflict.
	insertV3RunSource(t, h.database, runID, item, "合成来源", "重新检索内容")
}

func TestOCRFixMaintenancePolicyAfterSuccess(t *testing.T) {
	h := newV3Harness(t)
	if _, err := h.database.Exec(context.Background(), `UPDATE app_settings SET sensitive_ai_policy = 'allow'`); err != nil {
		t.Fatal(err)
	}
	runID, lease := startAndClaimV3Run(t, h, "ocr-maintenance-worker")
	completeClaimedV3Run(t, h, runID, "ocr-maintenance-worker", lease)
	for _, policy := range []string{"allow", "redact", "block"} {
		if _, err := h.database.Exec(context.Background(), `UPDATE app_settings SET sensitive_ai_policy = $1`, policy); err != nil {
			t.Fatal(err)
		}
		response := h.do(t, http.MethodGet, "/internal/assistant/runs/"+runID+"/maintenance-policy", nil, true)
		assertStatus(t, response, http.StatusOK)
		var result struct {
			Allowed bool `json:"allowed"`
		}
		decodeInto(t, readResponse(t, response), &result)
		if result.Allowed != (policy == "allow") {
			t.Fatalf("policy %s allowed=%v", policy, result.Allowed)
		}
	}
}

func TestOCRFixExpiredIdempotencyKeysCanBeReused(t *testing.T) {
	h := newV3Harness(t)
	create := func(body string) apiResponse {
		response := sendJSONWithKey(t, h.client, http.MethodPost, h.server.URL+"/api/v1/items", map[string]any{
			"body": body, "contentFormat": "plain_text", "sensitivity": "normal",
		}, h.csrf, "synthetic-create-key")
		assertStatus(t, response, http.StatusCreated)
		return decodeResponse[apiResponse](t, response)
	}
	first := create("第一条合成记录")
	if _, err := h.database.Exec(context.Background(), `UPDATE idempotency_records SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'`); err != nil {
		t.Fatal(err)
	}
	second := create("过期后的新记录")
	if first.Item.ID == second.Item.ID {
		t.Fatal("expired create key replayed the original item")
	}
	supplement := func(body string) apiResponse {
		response := sendJSONWithKey(t, h.client, http.MethodPost, h.server.URL+"/api/v1/items/"+second.Item.ID.String()+"/raw-records", map[string]any{
			"body": body, "contentFormat": "plain_text", "sensitivity": "normal",
		}, h.csrf, "synthetic-supplement-key")
		assertStatus(t, response, http.StatusCreated)
		return decodeResponse[apiResponse](t, response)
	}
	oldSupplement := supplement("第一条补充")
	if _, err := h.database.Exec(context.Background(), `UPDATE idempotency_records SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE idempotency_key = 'synthetic-supplement-key'`); err != nil {
		t.Fatal(err)
	}
	newSupplement := supplement("过期后的新补充")
	if oldSupplement.RawRecord.ID == newSupplement.RawRecord.ID {
		t.Fatal("expired supplement key replayed the original record")
	}
}

func TestOCRFixExternalArtifactSearchAndLegacyActivation(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy=%v", legacy), func(t *testing.T) {
			h := newV3Harness(t)
			item := seedV3Knowledge(t, h.database, "合成原始记录", "原始正文", "normal")
			var rawID, fragmentID uuid.UUID
			if err := h.database.QueryRow(context.Background(), `SELECT raw_record_id, id FROM search_fragments WHERE item_id = $1`, item).Scan(&rawID, &fragmentID); err != nil {
				t.Fatal(err)
			}
			content := validM3Artifact(fragmentID)
			content["summary"] = "ExternalSentinelUnique"
			response := h.post(t, "/api/v1/items/"+item.String()+"/artifacts", map[string]any{
				"generator": "external_agent", "generatorName": "synthetic-agent", "modelName": "synthetic-model",
				"schemaVersion": "1.0", "sourceRawRecordIds": []uuid.UUID{rawID}, "content": content,
			})
			assertStatus(t, response, http.StatusCreated)
			var artifact struct {
				ID uuid.UUID `json:"id"`
			}
			decodeInto(t, readResponse(t, response), &artifact)
			before := searchM2(t, h.client, h.server.URL, h.csrf, map[string]any{"q": "ExternalSentinelUnique", "sort": "relevance", "limit": 30})
			if before.Total != 0 {
				t.Fatal("inactive external candidate was searchable")
			}
			if legacy {
				if _, err := h.database.Exec(context.Background(), `DELETE FROM search_fragments WHERE artifact_id = $1`, artifact.ID); err != nil {
					t.Fatal(err)
				}
			}
			activated := h.post(t, "/api/v1/artifacts/"+artifact.ID.String()+"/activate", map[string]any{})
			assertStatus(t, activated, http.StatusOK)
			activated.Body.Close()
			after := searchM2(t, h.client, h.server.URL, h.csrf, map[string]any{"q": "ExternalSentinelUnique", "sort": "relevance", "limit": 30})
			if after.Total != 1 || after.Items[0].ItemID != item {
				t.Fatalf("active external artifact not searchable: %+v", after)
			}
		})
	}
}

func addOCRFixtureImage(t *testing.T, h *v3Harness, item uuid.UUID) {
	t.Helper()
	id := uuid.New()
	if _, err := h.database.Exec(context.Background(), `
		INSERT INTO attachments (id, raw_record_id, kind, original_name, display_name, storage_key,
		       media_type, content_sha256, size_bytes, width, height, status, created_at)
		SELECT $1::uuid, id, 'image', 'synthetic.png', 'synthetic.png', $1::text,
		       'image/png', decode(repeat('00', 32), 'hex'), 10, 100, 100, 'ready', now()
		FROM raw_records WHERE item_id = $2 LIMIT 1
	`, id, item); err != nil {
		t.Fatal(err)
	}
}

func seedOCRFixtureImageItem(t *testing.T, h *v3Harness, count int) uuid.UUID {
	t.Helper()
	item := seedV3Knowledge(t, h.database, "合成图片记录", "临时合成正文", "normal")
	if _, err := h.database.Exec(context.Background(), `UPDATE raw_records SET content_kind = 'image', body = '' WHERE item_id = $1`, item); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec(context.Background(), `DELETE FROM search_fragments WHERE item_id = $1`, item); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < count; index++ {
		addOCRFixtureImage(t, h, item)
	}
	return item
}

func TestOCRFixImageTaskFitsEightToolCalls(t *testing.T) {
	h := newV3Harness(t)
	_, model := h.createProviderModel(t, []map[string]any{})
	if _, err := h.database.Exec(context.Background(), `UPDATE provider_models SET supports_vision = true, supports_tools = true WHERE id = $1`, model); err != nil {
		t.Fatal(err)
	}
	for _, count := range []int{6, 7} {
		item := seedOCRFixtureImageItem(t, h, count)
		response := h.post(t, "/api/v1/ai/tasks", map[string]any{"taskType": "analyze_image", "itemId": item, "modelId": model, "sensitivePolicy": "block"})
		if count == 6 {
			assertStatus(t, response, http.StatusCreated)
		} else {
			assertStatus(t, response, http.StatusUnprocessableEntity)
		}
		response.Body.Close()
	}
}

func TestOCRFixSchedulerSkipsBlockedOldestItems(t *testing.T) {
	h := newV3Harness(t)
	_, model := h.createProviderModel(t, []map[string]any{})
	for index := 0; index < 40; index++ {
		var item uuid.UUID
		if index >= 20 {
			item = seedOCRFixtureImageItem(t, h, 1)
		} else {
			item = seedV3Knowledge(t, h.database, "不可执行的旧条目", "敏感合成正文", "sensitive")
		}
		if _, err := h.database.Exec(context.Background(), `UPDATE raw_records SET effective_captured_at = now() - interval '2 hours' WHERE item_id = $1`, item); err != nil {
			t.Fatal(err)
		}
	}
	eligible := seedV3Knowledge(t, h.database, "可执行的新条目", "新的合成正文", "normal")
	schedule := h.put(t, "/api/v1/ai/schedule", map[string]any{
		"frequency": "daily", "timezone": "UTC", "localTime": "00:00", "weekday": 1,
		"organizeModelId": model, "visionModelId": "", "sensitivePolicy": "block",
	})
	assertStatus(t, schedule, http.StatusOK)
	schedule.Body.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); h.ai.RunScheduler(ctx, slog.New(slog.NewTextHandler(io.Discard, nil))) }()
	t.Cleanup(func() { cancel(); <-done })
	deadline := time.Now().Add(3 * time.Second)
	for {
		var count int
		if err := h.database.QueryRow(context.Background(), `SELECT count(*) FROM ai_task_runs WHERE trigger_type = 'scheduled' AND item_id = $1`, eligible).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("eligible record starved behind blocked records")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var count int
	if err := h.database.QueryRow(context.Background(), `SELECT count(*) FROM ai_task_runs WHERE trigger_type = 'scheduled' AND parent_task_id IS NOT NULL`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("unexpected scheduled children: count=%d err=%v", count, err)
	}
}

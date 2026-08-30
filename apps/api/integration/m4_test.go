//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type m4TaskResponse struct {
	ID              uuid.UUID       `json:"id"`
	TaskType        string          `json:"taskType"`
	Status          string          `json:"status"`
	CancelRequested bool            `json:"cancelRequested"`
	RetryOfTaskID   *uuid.UUID      `json:"retryOfTaskId"`
	BatchSummary    json.RawMessage `json:"batchSummary"`
}

type m4ClaimResponse struct {
	Task struct {
		ID            uuid.UUID `json:"id"`
		Type          string    `json:"type"`
		LeaseVersion  int       `json:"leaseVersion"`
		PromptVersion string    `json:"promptVersion"`
	} `json:"task"`
	Input struct {
		Sensitivity     string `json:"sensitivity"`
		SensitivePolicy string `json:"sensitivePolicy"`
		RawRecords      []struct {
			Body string `json:"body"`
		} `json:"rawRecords"`
		Attachments []struct {
			ID        uuid.UUID `json:"id"`
			Kind      string    `json:"kind"`
			MediaType string    `json:"mediaType"`
			SizeBytes int64     `json:"sizeBytes"`
		} `json:"attachments"`
		Fragments []struct {
			ID      uuid.UUID `json:"id"`
			Content string    `json:"content"`
		} `json:"fragments"`
	} `json:"input"`
}

type m4ArtifactResponse struct {
	ID            uuid.UUID `json:"id"`
	ArtifactType  string    `json:"artifactType"`
	VersionNumber int       `json:"versionNumber"`
	Active        bool      `json:"active"`
	IsStale       bool      `json:"isStale"`
}

type m4BatchSummary struct {
	SelectedItems     int `json:"selectedItems"`
	CreatedChildren   int `json:"createdChildren"`
	ChildStatusCounts struct {
		Queued    int `json:"queued"`
		Running   int `json:"running"`
		Succeeded int `json:"succeeded"`
		Failed    int `json:"failed"`
		Cancelled int `json:"cancelled"`
	} `json:"childStatusCounts"`
	Skipped struct {
		Total    int `json:"total"`
		ByReason struct {
			AlreadyCovered                     int `json:"already_covered"`
			AlreadyQueuedOrRunning             int `json:"already_queued_or_running"`
			NoSupportedContent                 int `json:"no_supported_content"`
			VisionModelUnavailable             int `json:"vision_model_unavailable"`
			SensitiveBlocked                   int `json:"sensitive_blocked"`
			SensitiveImageRedactionUnsupported int `json:"sensitive_image_redaction_unsupported"`
		} `json:"byReason"`
	} `json:"skipped"`
}

func TestM4TaskArtifactBatchAndScheduleLifecycle(t *testing.T) {
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

	server, client, csrf, aiService := newAuthenticatedM3ServerWithService(t, database, t.TempDir(), "http://127.0.0.1:1")
	defer server.Close()
	provider := createM4Provider(t, client, server.URL, csrf)
	modelID := provider.Models[0].ID
	testM4SensitiveClaims(t, client, server.URL, csrf, modelID)
	testM4CreationBoundaries(t, client, server.URL, csrf, modelID)
	created := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items", map[string]any{
		"body": "m4-source lsblk mount /dev/sdb1", "contentFormat": "plain_text", "sensitivity": "normal",
	}, csrf, "m4-item-create-0001")
	assertStatus(t, created, http.StatusCreated)
	item := decodeResponse[apiResponse](t, created)
	fragmentID := m4FragmentID(t, database, item.Item.ID)

	task := createM4Task(t, client, server.URL, csrf, "organize_record", item.Item.ID, modelID)
	claims := concurrentM4Claims(t, client, server.URL)
	var claim m4ClaimResponse
	for _, result := range claims {
		if result.status == http.StatusOK {
			if err := json.Unmarshal(result.body, &claim); err != nil {
				t.Fatal(err)
			}
		}
	}
	if claim.Task.ID != task.ID || claim.Task.LeaseVersion != 1 || claim.Task.PromptVersion != "organize-v2" || len(claim.Input.Fragments) != 1 {
		t.Fatalf("unexpected claim: %+v", claim)
	}

	artifactPayload := validM3Artifact(fragmentID)
	testM4RejectedArtifactCandidates(t, client, server.URL, task.ID, claim.Task.LeaseVersion, artifactPayload)
	artifact := concurrentM4Completes(t, client, server.URL, task.ID, claim.Task.LeaseVersion, artifactPayload)
	if !artifact.Active || artifact.IsStale || artifact.VersionNumber != 1 {
		t.Fatalf("unexpected completed artifact: %+v", artifact)
	}
	repeated := sendM4InternalJSON(t, client, http.MethodPost,
		server.URL+"/internal/ai/tasks/"+task.ID.String()+"/complete", map[string]any{
			"workerId": "m4-worker", "leaseVersion": 1, "artifact": artifactPayload,
		})
	assertStatus(t, repeated, http.StatusOK)
	if duplicate := decodeResponse[m4ArtifactResponse](t, repeated); duplicate.ID != artifact.ID {
		t.Fatal("complete retry created another artifact")
	}
	testM4BatchSkipMatrix(t, client, server.URL, csrf, item.Item.ID, modelID)

	supplement := sendJSONWithKey(t, client, http.MethodPost,
		server.URL+"/api/v1/items/"+item.Item.ID.String()+"/raw-records", map[string]any{
			"body": "m4-new-supplement", "contentFormat": "plain_text", "sensitivity": "normal",
		}, csrf, "m4-supplement-0001")
	assertStatus(t, supplement, http.StatusCreated)
	_ = decodeResponse[apiResponse](t, supplement)

	artifacts := doRequest(t, client, newRequest(t, http.MethodGet,
		server.URL+"/api/v1/items/"+item.Item.ID.String()+"/artifacts", nil, "", ""))
	assertStatus(t, artifacts, http.StatusOK)
	var artifactList struct {
		Items []m4ArtifactResponse `json:"items"`
	}
	decodeInto(t, readResponse(t, artifacts), &artifactList)
	if len(artifactList.Items) != 1 || !artifactList.Items[0].IsStale || !artifactList.Items[0].Active {
		t.Fatalf("stale active artifact was not preserved: %+v", artifactList.Items)
	}

	search := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/search", map[string]any{
		"q": "合成派生内容", "sort": "relevance", "limit": 30,
	}, csrf)
	assertStatus(t, search, http.StatusOK)
	var searchBody struct {
		Items []struct {
			MatchedSource   string `json:"matchedSource"`
			ArtifactIsStale *bool  `json:"artifactIsStale"`
		} `json:"items"`
	}
	decodeInto(t, readResponse(t, search), &searchBody)
	if len(searchBody.Items) != 1 || searchBody.Items[0].MatchedSource != "ai_text" ||
		searchBody.Items[0].ArtifactIsStale == nil || !*searchBody.Items[0].ArtifactIsStale {
		t.Fatalf("AI search hit did not expose stale state: %+v", searchBody.Items)
	}

	applied := sendJSON(t, client, http.MethodPost,
		server.URL+"/api/v1/artifacts/"+artifact.ID.String()+"/apply-suggestions", map[string]any{
			"title": true, "folder": true, "tags": []string{"fixture"},
		}, csrf)
	assertStatus(t, applied, http.StatusOK)
	_ = readResponse(t, applied)
	var title, rawBody string
	if err := database.QueryRow(ctx, "SELECT title FROM knowledge_items WHERE id = $1", item.Item.ID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx, "SELECT body FROM raw_records WHERE id = $1", item.RawRecord.ID).Scan(&rawBody); err != nil {
		t.Fatal(err)
	}
	if title != "合成整理结果" || rawBody != "m4-source lsblk mount /dev/sdb1" {
		t.Fatalf("suggestion application crossed the raw fact boundary: title=%q body=%q", title, rawBody)
	}

	regeneratedTask := createM4Task(t, client, server.URL, csrf, "organize_record", item.Item.ID, modelID)
	regeneratedClaim := claimM4Task(t, client, server.URL, http.StatusOK)
	if regeneratedClaim.Task.ID != regeneratedTask.ID {
		t.Fatalf("unexpected regenerated claim: %+v", regeneratedClaim.Task)
	}
	regeneratedPayload := validM3Artifact(fragmentID)
	regeneratedPayload["title"] = "合成整理结果 v2"
	regeneratedComplete := sendM4InternalJSON(t, client, http.MethodPost,
		server.URL+"/internal/ai/tasks/"+regeneratedTask.ID.String()+"/complete", map[string]any{
			"workerId": "m4-worker", "leaseVersion": regeneratedClaim.Task.LeaseVersion,
			"artifact": regeneratedPayload,
		})
	assertStatus(t, regeneratedComplete, http.StatusCreated)
	regeneratedArtifact := decodeResponse[m4ArtifactResponse](t, regeneratedComplete)
	if regeneratedArtifact.VersionNumber != 2 || !regeneratedArtifact.Active || regeneratedArtifact.ID == artifact.ID {
		t.Fatalf("regeneration did not create a new active version: %+v", regeneratedArtifact)
	}
	activateStale := sendJSON(t, client, http.MethodPost,
		server.URL+"/api/v1/artifacts/"+artifact.ID.String()+"/activate", map[string]any{}, csrf)
	assertStatus(t, activateStale, http.StatusOK)
	activatedOld := decodeResponse[m4ArtifactResponse](t, activateStale)
	if !activatedOld.Active || !activatedOld.IsStale {
		t.Fatalf("stale history version could not be activated explicitly: %+v", activatedOld)
	}

	invalidated := sendJSON(t, client, http.MethodPost,
		server.URL+"/api/v1/artifacts/"+artifact.ID.String()+"/invalidate", map[string]any{}, csrf)
	assertStatus(t, invalidated, http.StatusOK)
	_ = readResponse(t, invalidated)
	activateInvalid := sendJSON(t, client, http.MethodPost,
		server.URL+"/api/v1/artifacts/"+artifact.ID.String()+"/activate", map[string]any{}, csrf)
	assertStatus(t, activateInvalid, http.StatusConflict)
	_ = readResponse(t, activateInvalid)
	applyInvalid := sendJSON(t, client, http.MethodPost,
		server.URL+"/api/v1/artifacts/"+artifact.ID.String()+"/apply-suggestions", map[string]any{"title": true}, csrf)
	assertStatus(t, applyInvalid, http.StatusConflict)
	_ = readResponse(t, applyInvalid)
	versionsAfterInvalidation := doRequest(t, client, newRequest(t, http.MethodGet,
		server.URL+"/api/v1/items/"+item.Item.ID.String()+"/artifacts", nil, "", ""))
	assertStatus(t, versionsAfterInvalidation, http.StatusOK)
	var versionHistory struct {
		Items []m4ArtifactResponse `json:"items"`
	}
	decodeInto(t, readResponse(t, versionsAfterInvalidation), &versionHistory)
	if len(versionHistory.Items) != 2 || versionHistory.Items[0].Active || versionHistory.Items[1].Active {
		t.Fatalf("invalidating the active version unexpectedly fell back: %+v", versionHistory.Items)
	}

	testM4CancellationAndLease(t, database, client, server.URL, csrf, item.Item.ID, modelID, fragmentID)
	testM4ImageTask(t, client, server.URL, csrf, modelID)
	testM4BatchAggregation(t, database, client, server.URL, csrf, item.Item.ID, modelID)
	testM4BatchCancellation(t, database, client, server.URL, csrf, modelID)
	testM4ScheduleWindow(t, database, client, server.URL, csrf, aiService, modelID)
}

func testM4BatchSkipMatrix(
	t *testing.T,
	client *http.Client,
	baseURL, csrf string,
	coveredItemID, modelID uuid.UUID,
) {
	t.Helper()
	createText := func(key, body, sensitivity string) apiResponse {
		response := sendJSONWithKey(t, client, http.MethodPost, baseURL+"/api/v1/items", map[string]any{
			"body": body, "contentFormat": "plain_text", "sensitivity": sensitivity,
		}, csrf, key)
		assertStatus(t, response, http.StatusCreated)
		return decodeResponse[apiResponse](t, response)
	}
	queuedItem := createText("m4-batch-queued-item", "queued batch input", "normal")
	queuedTask := createM4Task(t, client, baseURL, csrf, "organize_record", queuedItem.Item.ID, modelID)
	sensitiveText := createText("m4-batch-sensitive-text", "password=batch-sensitive", "sensitive")

	pureFileResponse := sendMultipart(t, client, baseURL+"/api/v1/items:multipart", csrf, "m4-batch-pure-file", map[string]any{
		"body": "", "contentFormat": "plain_text", "sensitivity": "normal",
		"title": "pure file", "folderId": nil, "tagIds": []string{},
	}, "notes.txt", "text/plain", []byte("file bytes only"))
	assertStatus(t, pureFileResponse, http.StatusCreated)
	pureFile := decodeResponse[apiResponse](t, pureFileResponse)

	pngBytes := testPNG(t)
	normalImageResponse := sendMultipart(t, client, baseURL+"/api/v1/items:multipart", csrf, "m4-batch-normal-image", map[string]any{
		"body": "", "contentFormat": "plain_text", "sensitivity": "normal",
		"title": "normal image", "folderId": nil, "tagIds": []string{},
	}, "normal.png", "image/png", pngBytes)
	assertStatus(t, normalImageResponse, http.StatusCreated)
	normalImage := decodeResponse[apiResponse](t, normalImageResponse)

	blockBatchResponse := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "batch_organize",
		"itemIds": []string{
			coveredItemID.String(), queuedItem.Item.ID.String(), pureFile.Item.ID.String(),
			normalImage.Item.ID.String(), sensitiveText.Item.ID.String(),
		},
		"organizeModelId": modelID.String(), "visionModelId": "", "sensitivePolicy": "block",
	}, csrf)
	assertStatus(t, blockBatchResponse, http.StatusCreated)
	blockBatch := decodeResponse[m4TaskResponse](t, blockBatchResponse)
	if blockBatch.Status != "succeeded" {
		t.Fatalf("all-skipped batch did not finish successfully: %+v", blockBatch)
	}
	blockSummary := decodeM4BatchSummary(t, blockBatch.BatchSummary)
	blockReasons := blockSummary.Skipped.ByReason
	if blockSummary.SelectedItems != 5 || blockSummary.CreatedChildren != 0 || blockSummary.Skipped.Total != 5 ||
		blockReasons.AlreadyCovered != 1 || blockReasons.AlreadyQueuedOrRunning != 1 ||
		blockReasons.NoSupportedContent != 1 || blockReasons.VisionModelUnavailable != 1 ||
		blockReasons.SensitiveBlocked != 1 || blockReasons.SensitiveImageRedactionUnsupported != 0 {
		t.Fatalf("block batch skip matrix mismatch: %+v", blockSummary)
	}
	assertM4SkipSum(t, blockSummary)

	sensitiveImageResponse := sendMultipart(t, client, baseURL+"/api/v1/items:multipart", csrf, "m4-batch-sensitive-image", map[string]any{
		"body": "", "contentFormat": "plain_text", "sensitivity": "sensitive",
		"title": "sensitive image", "folderId": nil, "tagIds": []string{},
	}, "sensitive.png", "image/png", pngBytes)
	assertStatus(t, sensitiveImageResponse, http.StatusCreated)
	sensitiveImage := decodeResponse[apiResponse](t, sensitiveImageResponse)
	redactBatchResponse := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "batch_organize", "itemIds": []string{sensitiveImage.Item.ID.String()},
		"organizeModelId": modelID.String(), "visionModelId": modelID.String(), "sensitivePolicy": "redact",
	}, csrf)
	assertStatus(t, redactBatchResponse, http.StatusCreated)
	redactBatch := decodeResponse[m4TaskResponse](t, redactBatchResponse)
	redactSummary := decodeM4BatchSummary(t, redactBatch.BatchSummary)
	if redactBatch.Status != "succeeded" || redactSummary.Skipped.Total != 1 ||
		redactSummary.Skipped.ByReason.SensitiveImageRedactionUnsupported != 1 {
		t.Fatalf("redact image skip mismatch: task=%+v summary=%+v", redactBatch, redactSummary)
	}
	assertM4SkipSum(t, redactSummary)

	tooMany := make([]string, 101)
	for index := range tooMany {
		tooMany[index] = coveredItemID.String()
	}
	overLimit := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "batch_organize", "itemIds": tooMany,
		"organizeModelId": modelID.String(), "visionModelId": "", "sensitivePolicy": "block",
	}, csrf)
	assertM4Error(t, overLimit, http.StatusUnprocessableEntity, "VALIDATION_FAILED")

	cancelQueued := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+queuedTask.ID.String()+"/cancel", map[string]any{}, csrf)
	assertStatus(t, cancelQueued, http.StatusOK)
	_ = readResponse(t, cancelQueued)
}

func decodeM4BatchSummary(t *testing.T, encoded json.RawMessage) m4BatchSummary {
	t.Helper()
	var summary m4BatchSummary
	if err := json.Unmarshal(encoded, &summary); err != nil {
		t.Fatal(err)
	}
	return summary
}

func assertM4SkipSum(t *testing.T, summary m4BatchSummary) {
	t.Helper()
	reasons := summary.Skipped.ByReason
	total := reasons.AlreadyCovered + reasons.AlreadyQueuedOrRunning + reasons.NoSupportedContent +
		reasons.VisionModelUnavailable + reasons.SensitiveBlocked + reasons.SensitiveImageRedactionUnsupported
	if total != summary.Skipped.Total {
		t.Fatalf("skip total %d does not equal byReason sum %d", summary.Skipped.Total, total)
	}
}

func testM4CreationBoundaries(t *testing.T, client *http.Client, baseURL, csrf string, modelID uuid.UUID) {
	t.Helper()
	created := sendJSONWithKey(t, client, http.MethodPost, baseURL+"/api/v1/items", map[string]any{
		"body": strings.Repeat("x", 400), "contentFormat": "plain_text", "sensitivity": "normal",
	}, csrf, "m4-boundary-item-0001")
	assertStatus(t, created, http.StatusCreated)
	item := decodeResponse[apiResponse](t, created)

	organize := createM4Task(t, client, baseURL, csrf, "organize_record", item.Item.ID, modelID)
	duplicate := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "organize_record", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertM4Error(t, duplicate, http.StatusConflict, "AI_TASK_ALREADY_ACTIVE")
	review := createM4Task(t, client, baseURL, csrf, "review_record", item.Item.ID, modelID)
	for _, taskID := range []uuid.UUID{organize.ID, review.ID} {
		cancelled := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+taskID.String()+"/cancel", map[string]any{}, csrf)
		assertStatus(t, cancelled, http.StatusOK)
		if entry := decodeResponse[m4TaskResponse](t, cancelled); entry.Status != "cancelled" {
			t.Fatalf("queued cancellation did not finish immediately: %+v", entry)
		}
	}
	repeatedCancel := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+organize.ID.String()+"/cancel", map[string]any{}, csrf)
	assertStatus(t, repeatedCancel, http.StatusOK)
	_ = readResponse(t, repeatedCancel)

	failedTask := createM4Task(t, client, baseURL, csrf, "organize_record", item.Item.ID, modelID)
	failedClaim := claimM4Task(t, client, baseURL, http.StatusOK)
	if failedClaim.Task.ID != failedTask.ID {
		t.Fatalf("unexpected failed-task claim: %+v", failedClaim.Task)
	}
	failM4Claim(t, client, baseURL, failedClaim)
	cancelFailed := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+failedTask.ID.String()+"/cancel", map[string]any{}, csrf)
	assertM4Error(t, cancelFailed, http.StatusConflict, "AI_TASK_NOT_CANCELLABLE")
	retryResponse := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+failedTask.ID.String()+"/retry", map[string]any{}, csrf)
	assertStatus(t, retryResponse, http.StatusCreated)
	retry := decodeResponse[m4TaskResponse](t, retryResponse)
	if retry.ID == failedTask.ID || retry.RetryOfTaskID == nil || *retry.RetryOfTaskID != failedTask.ID {
		t.Fatalf("retry did not create a linked task: %+v", retry)
	}
	cancelRetry := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+retry.ID.String()+"/cancel", map[string]any{}, csrf)
	assertStatus(t, cancelRetry, http.StatusOK)
	_ = readResponse(t, cancelRetry)

	randomModel := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "organize_record", "itemId": item.Item.ID.String(), "modelId": uuid.NewString(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertM4Error(t, randomModel, http.StatusUnprocessableEntity, "VALIDATION_FAILED")

	patchModel := func(payload map[string]any) {
		response := sendJSON(t, client, http.MethodPatch, baseURL+"/api/v1/ai/models/"+modelID.String(), payload, csrf)
		assertStatus(t, response, http.StatusOK)
		_ = readResponse(t, response)
	}
	patchModel(map[string]any{"enabled": false})
	disabled := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "organize_record", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertM4Error(t, disabled, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
	patchModel(map[string]any{"enabled": true, "supportsTools": false, "supportsVision": false})
	withoutTools := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "organize_record", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertStatus(t, withoutTools, http.StatusCreated)
	withoutToolsTask := decodeResponse[m4TaskResponse](t, withoutTools)
	cancelWithoutTools := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+withoutToolsTask.ID.String()+"/cancel", map[string]any{}, csrf)
	assertStatus(t, cancelWithoutTools, http.StatusOK)
	_ = readResponse(t, cancelWithoutTools)
	missingVision := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "analyze_image", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertM4Error(t, missingVision, http.StatusUnprocessableEntity, "AI_MODEL_CAPABILITY_MISSING")
	patchModel(map[string]any{"supportsVision": true, "contextWindow": 1200, "maxOutputTokens": 100})
	tooLarge := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "organize_record", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertM4Error(t, tooLarge, http.StatusUnprocessableEntity, "AI_CONTEXT_TOO_LARGE")
	patchModel(map[string]any{"contextWindow": 32768, "maxOutputTokens": 2048})
	noImage := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "analyze_image", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertM4Error(t, noImage, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
}

func assertM4Error(t *testing.T, response *http.Response, status int, code string) {
	t.Helper()
	assertStatus(t, response, status)
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeInto(t, readResponse(t, response), &body)
	if body.Error.Code != code {
		t.Fatalf("error code = %q, want %q", body.Error.Code, code)
	}
}

func testM4ImageTask(t *testing.T, client *http.Client, baseURL, csrf string, modelID uuid.UUID) {
	t.Helper()
	pngBytes := testPNG(t)
	upload := sendMultipart(t, client, baseURL+"/api/v1/items:multipart", csrf, "m4-image-item-0001", map[string]any{
		"body": "screenshot context", "contentFormat": "plain_text", "sensitivity": "normal",
		"title": "M4 image fixture", "folderId": nil, "tagIds": []string{},
	}, "screen.png", "application/octet-stream", pngBytes)
	assertStatus(t, upload, http.StatusCreated)
	item := decodeResponse[apiResponse](t, upload)
	if len(item.Attachments) != 1 || item.Attachments[0].Kind != "image" {
		t.Fatalf("image fixture was not detected: %+v", item.Attachments)
	}
	attachmentID := item.Attachments[0].ID
	taskResponse := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "analyze_image", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertStatus(t, taskResponse, http.StatusCreated)
	task := decodeResponse[m4TaskResponse](t, taskResponse)
	claim := claimM4Task(t, client, baseURL, http.StatusOK)
	if claim.Task.ID != task.ID || claim.Task.Type != "analyze_image" || len(claim.Input.Attachments) != 1 ||
		claim.Input.Attachments[0].ID != attachmentID || claim.Input.Attachments[0].Kind != "image" {
		t.Fatalf("unexpected image claim: %+v", claim)
	}
	attachmentRequest, err := http.NewRequest(http.MethodGet,
		baseURL+"/internal/ai/tasks/"+task.ID.String()+"/attachments/"+attachmentID.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	attachmentRequest.Header.Set("Authorization", "Bearer "+m3InternalToken)
	attachmentRequest.Header.Set("X-Worker-ID", "m4-worker")
	attachmentRequest.Header.Set("X-Lease-Version", strconv.Itoa(claim.Task.LeaseVersion))
	attachmentResponse := doRequest(t, client, attachmentRequest)
	assertStatus(t, attachmentResponse, http.StatusOK)
	if downloaded := readResponse(t, attachmentResponse); !bytes.Equal(downloaded, pngBytes) {
		t.Fatal("worker attachment endpoint changed the authorized image bytes")
	}

	missingImage := map[string]any{
		"schemaVersion": "1.0", "artifactType": "image_analysis", "title": "图片分析", "summary": "图片候选摘要",
		"classification": map[string]any{
			"contentType": "image", "suggestedFolderPath": []string{"图片"},
			"suggestedTags": []string{"截图"}, "sensitivitySuggestion": "normal",
		},
		"blocks": []map[string]any{{
			"id": "summary", "type": "markdown", "markdown": "尚未引用图片", "sourceFragmentIds": []string{},
		}},
		"warnings": []any{}, "sourceFragmentIds": []string{},
		"review": map[string]any{"status": "model_reviewed", "limitations": []string{"仅测试图片边界"}},
	}
	rejected := sendM4InternalJSON(t, client, http.MethodPost,
		baseURL+"/internal/ai/tasks/"+task.ID.String()+"/complete", map[string]any{
			"workerId": "m4-worker", "leaseVersion": claim.Task.LeaseVersion, "artifact": missingImage,
		})
	assertStatus(t, rejected, http.StatusUnprocessableEntity)
	_ = readResponse(t, rejected)
	valid := cloneM4Map(t, missingImage)
	valid["blocks"] = []map[string]any{{
		"id": "image", "type": "image_reference", "attachmentId": attachmentID.String(),
		"caption": "测试截图", "sourceFragmentIds": []string{},
	}}
	completed := sendM4InternalJSON(t, client, http.MethodPost,
		baseURL+"/internal/ai/tasks/"+task.ID.String()+"/complete", map[string]any{
			"workerId": "m4-worker", "leaseVersion": claim.Task.LeaseVersion, "artifact": valid,
		})
	assertStatus(t, completed, http.StatusCreated)
	artifact := decodeResponse[m4ArtifactResponse](t, completed)
	if artifact.ArtifactType != "image_analysis" || !artifact.Active {
		t.Fatalf("image artifact was not active: %+v", artifact)
	}
}

func testM4RejectedArtifactCandidates(
	t *testing.T,
	client *http.Client,
	baseURL string,
	taskID uuid.UUID,
	leaseVersion int,
	valid map[string]any,
) {
	t.Helper()
	foreignSource := "00000000-0000-4000-8000-000000000001"
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "wrong artifact type", mutate: func(value map[string]any) {
			value["artifactType"] = "correctness_review"
		}},
		{name: "text artifact without sources", mutate: func(value map[string]any) {
			value["sourceFragmentIds"] = []string{}
			value["blocks"].([]any)[0].(map[string]any)["sourceFragmentIds"] = []string{}
		}},
		{name: "duplicate block id", mutate: func(value map[string]any) {
			block := value["blocks"].([]any)[0].(map[string]any)
			value["blocks"] = append(value["blocks"].([]any), cloneM4Map(t, block))
		}},
		{name: "nested source outside top level", mutate: func(value map[string]any) {
			value["blocks"].([]any)[0].(map[string]any)["sourceFragmentIds"] = []string{foreignSource}
		}},
		{name: "table row column mismatch", mutate: func(value map[string]any) {
			value["blocks"] = []any{map[string]any{
				"id": "table", "type": "table", "columns": []string{"a", "b"},
				"rows": []any{[]string{"only-one"}}, "sourceFragmentIds": value["sourceFragmentIds"],
			}}
		}},
		{name: "case folded duplicate tags", mutate: func(value map[string]any) {
			value["classification"].(map[string]any)["suggestedTags"] = []string{"Go", "go"}
		}},
		{name: "raw html", mutate: func(value map[string]any) {
			value["blocks"].([]any)[0].(map[string]any)["markdown"] = "<script>alert(1)</script>"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneM4Map(t, valid)
			test.mutate(candidate)
			response := sendM4InternalJSON(t, client, http.MethodPost,
				baseURL+"/internal/ai/tasks/"+taskID.String()+"/complete", map[string]any{
					"workerId": "m4-worker", "leaseVersion": leaseVersion, "artifact": candidate,
				})
			assertStatus(t, response, http.StatusUnprocessableEntity)
			_ = readResponse(t, response)
		})
	}
}

func cloneM4Map(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var cloned map[string]any
	if err := json.Unmarshal(encoded, &cloned); err != nil {
		t.Fatal(err)
	}
	return cloned
}

func testM4SensitiveClaims(t *testing.T, client *http.Client, baseURL, csrf string, modelID uuid.UUID) {
	t.Helper()
	const original = "password=SensitiveSecret-2026 host=10.23.45.67"
	created := sendJSONWithKey(t, client, http.MethodPost, baseURL+"/api/v1/items", map[string]any{
		"body": original, "contentFormat": "plain_text", "sensitivity": "sensitive",
	}, csrf, "m4-sensitive-item-0001")
	assertStatus(t, created, http.StatusCreated)
	item := decodeResponse[apiResponse](t, created)

	redactTask := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "organize_record", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "redact", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertStatus(t, redactTask, http.StatusCreated)
	redactEntry := decodeResponse[m4TaskResponse](t, redactTask)
	redactedClaim := claimM4Task(t, client, baseURL, http.StatusOK)
	if redactedClaim.Task.ID != redactEntry.ID || redactedClaim.Input.SensitivePolicy != "redact" ||
		len(redactedClaim.Input.RawRecords) != 1 || len(redactedClaim.Input.Fragments) != 1 {
		t.Fatalf("unexpected redact claim: %+v", redactedClaim)
	}
	redacted := redactedClaim.Input.RawRecords[0].Body + "\n" + redactedClaim.Input.Fragments[0].Content
	if strings.Contains(redacted, "SensitiveSecret-2026") || strings.Contains(redacted, "10.23.45.67") ||
		!strings.Contains(redacted, "<PASSWORD_1>") || !strings.Contains(redacted, "<INTERNAL_IP_1>") {
		t.Fatalf("redact claim crossed the egress boundary: %q", redacted)
	}
	failM4Claim(t, client, baseURL, redactedClaim)

	allowSettings := sendJSON(t, client, http.MethodPut, baseURL+"/api/v1/ai/settings", map[string]any{
		"sensitiveAiPolicy": "allow", "confirmSensitiveAllow": true,
	}, csrf)
	assertStatus(t, allowSettings, http.StatusOK)
	_ = readResponse(t, allowSettings)
	allowTask := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "organize_record", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "allow", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertStatus(t, allowTask, http.StatusCreated)
	allowEntry := decodeResponse[m4TaskResponse](t, allowTask)
	allowedClaim := claimM4Task(t, client, baseURL, http.StatusOK)
	if allowedClaim.Task.ID != allowEntry.ID || allowedClaim.Input.SensitivePolicy != "allow" ||
		len(allowedClaim.Input.RawRecords) != 1 || allowedClaim.Input.RawRecords[0].Body != original ||
		len(allowedClaim.Input.Fragments) != 1 || allowedClaim.Input.Fragments[0].Content != original {
		t.Fatalf("allow claim did not preserve the explicitly authorized input: %+v", allowedClaim)
	}
	failM4Claim(t, client, baseURL, allowedClaim)

	blocked := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "organize_record", "itemId": item.Item.ID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertStatus(t, blocked, http.StatusConflict)
	_ = readResponse(t, blocked)
}

func failM4Claim(t *testing.T, client *http.Client, baseURL string, claim m4ClaimResponse) {
	t.Helper()
	response := sendM4InternalJSON(t, client, http.MethodPost,
		baseURL+"/internal/ai/tasks/"+claim.Task.ID.String()+"/fail", map[string]any{
			"workerId": "m4-worker", "leaseVersion": claim.Task.LeaseVersion,
			"errorCode": "AI_PROVIDER_UNAVAILABLE", "errorDetail": "synthetic test terminal state",
		})
	assertStatus(t, response, http.StatusOK)
	_ = readResponse(t, response)
}

func testM4CancellationAndLease(t *testing.T, database *pgxpool.Pool, client *http.Client, baseURL, csrf string, itemID, modelID, fragmentID uuid.UUID) {
	t.Helper()
	review := createM4Task(t, client, baseURL, csrf, "review_record", itemID, modelID)
	claim := claimM4Task(t, client, baseURL, http.StatusOK)
	cancelled := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+review.ID.String()+"/cancel", map[string]any{}, csrf)
	assertStatus(t, cancelled, http.StatusAccepted)
	_ = readResponse(t, cancelled)
	reviewArtifact := validM3Artifact(fragmentID)
	reviewArtifact["artifactType"] = "correctness_review"
	late := sendM4InternalJSON(t, client, http.MethodPost, baseURL+"/internal/ai/tasks/"+review.ID.String()+"/complete", map[string]any{
		"workerId": "m4-worker", "leaseVersion": claim.Task.LeaseVersion, "artifact": reviewArtifact,
	})
	assertStatus(t, late, http.StatusConflict)
	_ = readResponse(t, late)
	current := doRequest(t, client, newRequest(t, http.MethodGet, baseURL+"/api/v1/ai/tasks/"+review.ID.String(), nil, "", ""))
	assertStatus(t, current, http.StatusOK)
	if entry := decodeResponse[m4TaskResponse](t, current); entry.Status != "cancelled" {
		t.Fatalf("cancel-before-complete did not reach cancelled: %+v", entry)
	}
	var reviewArtifacts int
	if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_artifacts WHERE task_run_id = $1", review.ID).Scan(&reviewArtifacts); err != nil || reviewArtifacts != 0 {
		t.Fatalf("cancelled task created an artifact: count=%d err=%v", reviewArtifacts, err)
	}

	leaseTask := createM4Task(t, client, baseURL, csrf, "review_record", itemID, modelID)
	first := claimM4Task(t, client, baseURL, http.StatusOK)
	if _, err := database.Exec(context.Background(), "UPDATE ai_task_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", leaseTask.ID); err != nil {
		t.Fatal(err)
	}
	second := claimM4Task(t, client, baseURL, http.StatusOK)
	if second.Task.ID != first.Task.ID || second.Task.LeaseVersion != 2 {
		t.Fatalf("expired lease was not reclaimed exactly once: first=%+v second=%+v", first.Task, second.Task)
	}
	oldLease := sendM4InternalJSON(t, client, http.MethodPost, baseURL+"/internal/ai/tasks/"+leaseTask.ID.String()+"/complete", map[string]any{
		"workerId": "m4-worker", "leaseVersion": 1, "artifact": reviewArtifact,
	})
	assertStatus(t, oldLease, http.StatusConflict)
	_ = readResponse(t, oldLease)
	completed := sendM4InternalJSON(t, client, http.MethodPost, baseURL+"/internal/ai/tasks/"+leaseTask.ID.String()+"/complete", map[string]any{
		"workerId": "m4-worker", "leaseVersion": 2, "artifact": reviewArtifact,
	})
	assertStatus(t, completed, http.StatusCreated)
	_ = readResponse(t, completed)

	secondExpiryTask := createM4Task(t, client, baseURL, csrf, "review_record", itemID, modelID)
	firstExpiryClaim := claimM4Task(t, client, baseURL, http.StatusOK)
	if firstExpiryClaim.Task.ID != secondExpiryTask.ID {
		t.Fatalf("unexpected first expiry claim: %+v", firstExpiryClaim.Task)
	}
	if _, err := database.Exec(context.Background(), "UPDATE ai_task_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", secondExpiryTask.ID); err != nil {
		t.Fatal(err)
	}
	secondExpiryClaim := claimM4Task(t, client, baseURL, http.StatusOK)
	if secondExpiryClaim.Task.ID != secondExpiryTask.ID || secondExpiryClaim.Task.LeaseVersion != 2 {
		t.Fatalf("unexpected reclaimed task: %+v", secondExpiryClaim.Task)
	}
	if _, err := database.Exec(context.Background(), "UPDATE ai_task_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", secondExpiryTask.ID); err != nil {
		t.Fatal(err)
	}
	exhausted := sendM4InternalJSON(t, client, http.MethodPost, baseURL+"/internal/ai/tasks/claim", map[string]any{"workerId": "m4-worker"})
	assertStatus(t, exhausted, http.StatusNoContent)
	_ = readResponse(t, exhausted)
	var exhaustedStatus, exhaustedCode string
	if err := database.QueryRow(context.Background(), "SELECT status, error_code FROM ai_task_runs WHERE id = $1", secondExpiryTask.ID).Scan(&exhaustedStatus, &exhaustedCode); err != nil {
		t.Fatal(err)
	}
	if exhaustedStatus != "failed" || exhaustedCode != "AI_WORKER_LEASE_EXPIRED" {
		t.Fatalf("second expired lease did not fail permanently: status=%s code=%s", exhaustedStatus, exhaustedCode)
	}

	lostCancelledTask := createM4Task(t, client, baseURL, csrf, "review_record", itemID, modelID)
	lostCancelledClaim := claimM4Task(t, client, baseURL, http.StatusOK)
	if lostCancelledClaim.Task.ID != lostCancelledTask.ID {
		t.Fatalf("unexpected cancellation recovery claim: %+v", lostCancelledClaim.Task)
	}
	cancelLost := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+lostCancelledTask.ID.String()+"/cancel", map[string]any{}, csrf)
	assertStatus(t, cancelLost, http.StatusAccepted)
	_ = readResponse(t, cancelLost)
	if _, err := database.Exec(context.Background(), "UPDATE ai_task_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", lostCancelledTask.ID); err != nil {
		t.Fatal(err)
	}
	recoveredCancellation := sendM4InternalJSON(t, client, http.MethodPost, baseURL+"/internal/ai/tasks/claim", map[string]any{"workerId": "m4-worker"})
	assertStatus(t, recoveredCancellation, http.StatusNoContent)
	_ = readResponse(t, recoveredCancellation)
	var recoveredStatus string
	if err := database.QueryRow(context.Background(), "SELECT status FROM ai_task_runs WHERE id = $1", lostCancelledTask.ID).Scan(&recoveredStatus); err != nil {
		t.Fatal(err)
	}
	if recoveredStatus != "cancelled" {
		t.Fatalf("expired task with cancellation request was not cancelled: %s", recoveredStatus)
	}
}

func testM4BatchAggregation(t *testing.T, database *pgxpool.Pool, client *http.Client, baseURL, csrf string, itemID, modelID uuid.UUID) {
	t.Helper()
	batchResponse := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "batch_organize", "itemIds": []string{itemID.String(), itemID.String()},
		"organizeModelId": modelID.String(), "visionModelId": "", "sensitivePolicy": "block",
	}, csrf)
	assertStatus(t, batchResponse, http.StatusCreated)
	batch := decodeResponse[m4TaskResponse](t, batchResponse)
	if batch.Status != "running" {
		t.Fatalf("batch did not create a child: %+v", batch)
	}
	child := claimM4Task(t, client, baseURL, http.StatusOK)
	fragmentID := m4FragmentID(t, database, itemID)
	completed := sendM4InternalJSON(t, client, http.MethodPost, baseURL+"/internal/ai/tasks/"+child.Task.ID.String()+"/complete", map[string]any{
		"workerId": "m4-worker", "leaseVersion": child.Task.LeaseVersion, "artifact": validM3Artifact(fragmentID),
	})
	assertStatus(t, completed, http.StatusCreated)
	_ = readResponse(t, completed)
	parent := doRequest(t, client, newRequest(t, http.MethodGet, baseURL+"/api/v1/ai/tasks/"+batch.ID.String(), nil, "", ""))
	assertStatus(t, parent, http.StatusOK)
	entry := decodeResponse[m4TaskResponse](t, parent)
	if entry.Status != "succeeded" || !bytes.Contains(entry.BatchSummary, []byte(`"succeeded":1`)) {
		t.Fatalf("batch parent did not aggregate child success: %+v %s", entry, entry.BatchSummary)
	}
}

func testM4BatchCancellation(t *testing.T, database *pgxpool.Pool, client *http.Client, baseURL, csrf string, modelID uuid.UUID) {
	t.Helper()
	itemIDs := make([]string, 0, 3)
	for index := range 3 {
		created := sendJSONWithKey(t, client, http.MethodPost, baseURL+"/api/v1/items", map[string]any{
			"body":          fmt.Sprintf("m4 batch cancellation item %d", index),
			"contentFormat": "plain_text", "sensitivity": "normal",
		}, csrf, fmt.Sprintf("m4-batch-cancel-%d", index))
		assertStatus(t, created, http.StatusCreated)
		item := decodeResponse[apiResponse](t, created)
		itemIDs = append(itemIDs, item.Item.ID.String())
	}
	createdBatch := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": "batch_organize", "itemIds": itemIDs,
		"organizeModelId": modelID.String(), "visionModelId": "", "sensitivePolicy": "block",
	}, csrf)
	assertStatus(t, createdBatch, http.StatusCreated)
	batch := decodeResponse[m4TaskResponse](t, createdBatch)

	first := claimM4Task(t, client, baseURL, http.StatusOK)
	if len(first.Input.Fragments) == 0 {
		t.Fatal("batch child claim did not include a source fragment")
	}
	var firstParent uuid.UUID
	if err := database.QueryRow(context.Background(), "SELECT parent_task_id FROM ai_task_runs WHERE id = $1", first.Task.ID).Scan(&firstParent); err != nil {
		t.Fatal(err)
	}
	if firstParent != batch.ID {
		t.Fatalf("claimed task belongs to another batch: got=%s want=%s", firstParent, batch.ID)
	}
	firstComplete := sendM4InternalJSON(t, client, http.MethodPost, baseURL+"/internal/ai/tasks/"+first.Task.ID.String()+"/complete", map[string]any{
		"workerId": "m4-worker", "leaseVersion": first.Task.LeaseVersion,
		"artifact": validM3Artifact(first.Input.Fragments[0].ID),
	})
	assertStatus(t, firstComplete, http.StatusCreated)
	_ = readResponse(t, firstComplete)

	second := claimM4Task(t, client, baseURL, http.StatusOK)
	cancelled := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+batch.ID.String()+"/cancel", map[string]any{}, csrf)
	assertStatus(t, cancelled, http.StatusAccepted)
	cancelledParent := decodeResponse[m4TaskResponse](t, cancelled)
	if !cancelledParent.CancelRequested || cancelledParent.Status != "running" {
		t.Fatalf("running batch did not expose its cancellation request: %+v", cancelledParent)
	}
	var queuedCancelled, runningRequested int
	if err := database.QueryRow(context.Background(), `
		SELECT COUNT(*) FILTER (WHERE status = 'cancelled'),
		       COUNT(*) FILTER (WHERE status = 'running' AND cancel_requested_at IS NOT NULL)
		FROM ai_task_runs WHERE parent_task_id = $1
	`, batch.ID).Scan(&queuedCancelled, &runningRequested); err != nil {
		t.Fatal(err)
	}
	if queuedCancelled != 1 || runningRequested != 1 {
		t.Fatalf("batch cancellation did not propagate: queuedCancelled=%d runningRequested=%d", queuedCancelled, runningRequested)
	}
	failM4Claim(t, client, baseURL, second)

	parentResponse := doRequest(t, client, newRequest(t, http.MethodGet, baseURL+"/api/v1/ai/tasks/"+batch.ID.String(), nil, "", ""))
	assertStatus(t, parentResponse, http.StatusOK)
	parent := decodeResponse[m4TaskResponse](t, parentResponse)
	var summary m4BatchSummary
	if err := json.Unmarshal(parent.BatchSummary, &summary); err != nil {
		t.Fatal(err)
	}
	if parent.Status != "cancelled" || summary.ChildStatusCounts.Succeeded != 1 || summary.ChildStatusCounts.Cancelled != 2 {
		t.Fatalf("batch cancellation aggregation mismatch: parent=%+v summary=%+v", parent, summary)
	}
	var preserved int
	if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_artifacts WHERE task_run_id = $1", first.Task.ID).Scan(&preserved); err != nil {
		t.Fatal(err)
	}
	if preserved != 1 {
		t.Fatalf("batch cancellation removed a successful child artifact: %d", preserved)
	}
	repeated := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+batch.ID.String()+"/cancel", map[string]any{}, csrf)
	assertStatus(t, repeated, http.StatusOK)
	_ = readResponse(t, repeated)
	retriedResponse := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+batch.ID.String()+"/retry", map[string]any{}, csrf)
	assertStatus(t, retriedResponse, http.StatusCreated)
	retried := decodeResponse[m4TaskResponse](t, retriedResponse)
	if retried.RetryOfTaskID == nil || *retried.RetryOfTaskID != batch.ID || retried.Status != "running" {
		t.Fatalf("cancelled batch retry did not create a linked parent: %+v", retried)
	}
	cancelRetried := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks/"+retried.ID.String()+"/cancel", map[string]any{}, csrf)
	assertStatus(t, cancelRetried, http.StatusAccepted)
	_ = readResponse(t, cancelRetried)
	var activeChildren int
	if err := database.QueryRow(context.Background(), `
		SELECT count(*) FROM ai_task_runs WHERE parent_task_id = $1 AND status IN ('queued', 'running')
	`, retried.ID).Scan(&activeChildren); err != nil {
		t.Fatal(err)
	}
	if activeChildren != 0 {
		t.Fatalf("retried batch cancellation left active children: %d", activeChildren)
	}
}

func testM4ScheduleWindow(t *testing.T, database *pgxpool.Pool, client *http.Client, baseURL, csrf string, aiService interface {
	RunScheduler(context.Context, *slog.Logger)
}, modelID uuid.UUID) {
	t.Helper()
	defaultResponse := doRequest(t, client, newRequest(t, http.MethodGet, baseURL+"/api/v1/ai/schedule", nil, "", ""))
	assertStatus(t, defaultResponse, http.StatusOK)
	var defaultSchedule struct {
		Frequency string `json:"frequency"`
	}
	decodeInto(t, readResponse(t, defaultResponse), &defaultSchedule)
	if defaultSchedule.Frequency != "off" {
		t.Fatalf("automatic organization was not off by default: %+v", defaultSchedule)
	}
	for index := range 21 {
		created := sendJSONWithKey(t, client, http.MethodPost, baseURL+"/api/v1/items", map[string]any{
			"body":          fmt.Sprintf("m4 scheduled backlog item %02d", index),
			"contentFormat": "plain_text", "sensitivity": "normal",
		}, csrf, fmt.Sprintf("m4-schedule-backlog-%02d", index))
		assertStatus(t, created, http.StatusCreated)
		_ = readResponse(t, created)
	}
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	var activeArtifactID uuid.UUID
	if err := database.QueryRow(context.Background(), "SELECT artifact_id FROM item_active_artifacts ORDER BY activated_at DESC LIMIT 1").Scan(&activeArtifactID); err != nil {
		t.Fatal(err)
	}
	invalidated := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/artifacts/"+activeArtifactID.String()+"/invalidate", map[string]any{}, csrf)
	assertStatus(t, invalidated, http.StatusOK)
	_ = readResponse(t, invalidated)
	schedule := sendJSON(t, client, http.MethodPut, baseURL+"/api/v1/ai/schedule", map[string]any{
		"frequency": "daily", "timezone": "Asia/Shanghai",
		"localTime": time.Now().In(location).Add(-time.Minute).Format("15:04"), "weekday": 1,
		"organizeModelId": modelID.String(), "visionModelId": "", "sensitivePolicy": "block",
	}, csrf)
	assertStatus(t, schedule, http.StatusOK)
	_ = readResponse(t, schedule)

	run := func(waitForCreation bool) {
		var initialCount int
		if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_task_runs WHERE trigger_type = 'scheduled'").Scan(&initialCount); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			aiService.RunScheduler(ctx, slog.New(slog.NewTextHandler(os.Stderr, nil)))
		}()
		if waitForCreation {
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				var count int
				if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_task_runs WHERE trigger_type = 'scheduled'").Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count > initialCount {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
		} else {
			time.Sleep(200 * time.Millisecond)
		}
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("scheduler did not stop after context cancellation")
		}
	}
	run(true)
	var firstCount int
	if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_task_runs WHERE trigger_type = 'scheduled'").Scan(&firstCount); err != nil || firstCount == 0 {
		t.Fatalf("scheduler did not create a due window: count=%d err=%v", firstCount, err)
	}
	dailyKey := "daily:" + time.Now().In(location).Format("2006-01-02")
	var dailySummaryBytes []byte
	if err := database.QueryRow(context.Background(), `
		SELECT batch_summary FROM ai_task_runs
		WHERE task_type = 'batch_organize' AND schedule_key = $1
	`, dailyKey).Scan(&dailySummaryBytes); err != nil {
		t.Fatal(err)
	}
	var dailySummary m4BatchSummary
	if err := json.Unmarshal(dailySummaryBytes, &dailySummary); err != nil {
		t.Fatal(err)
	}
	if dailySummary.SelectedItems != 20 {
		t.Fatalf("daily scheduler did not enforce the 20-item cap: %+v", dailySummary)
	}
	run(false)
	var secondCount int
	if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_task_runs WHERE trigger_type = 'scheduled'").Scan(&secondCount); err != nil || secondCount != firstCount {
		t.Fatalf("scheduler duplicated the same window: first=%d second=%d err=%v", firstCount, secondCount, err)
	}

	localNow := time.Now().In(location)
	weekday := int(localNow.Weekday()+6)%7 + 1
	weekly := sendJSON(t, client, http.MethodPut, baseURL+"/api/v1/ai/schedule", map[string]any{
		"frequency": "weekly", "timezone": "Asia/Shanghai",
		"localTime": localNow.Add(-time.Minute).Format("15:04"), "weekday": weekday,
		"organizeModelId": modelID.String(), "visionModelId": "", "sensitivePolicy": "block",
	}, csrf)
	assertStatus(t, weekly, http.StatusOK)
	_ = readResponse(t, weekly)
	run(true)
	weeklyKey := "weekly:" + time.Now().In(location).Format("2006-01-02")
	var weeklyParents int
	if err := database.QueryRow(context.Background(), `
		SELECT count(*) FROM ai_task_runs WHERE task_type = 'batch_organize' AND schedule_key = $1
	`, weeklyKey).Scan(&weeklyParents); err != nil || weeklyParents != 1 {
		t.Fatalf("weekly scheduler did not create exactly one due window: count=%d err=%v", weeklyParents, err)
	}
	var weeklyCount int
	if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_task_runs WHERE trigger_type = 'scheduled'").Scan(&weeklyCount); err != nil {
		t.Fatal(err)
	}
	run(false)
	var repeatedWeeklyCount int
	if err := database.QueryRow(context.Background(), "SELECT count(*) FROM ai_task_runs WHERE trigger_type = 'scheduled'").Scan(&repeatedWeeklyCount); err != nil || repeatedWeeklyCount != weeklyCount {
		t.Fatalf("scheduler duplicated weekly window after restart: first=%d second=%d err=%v", weeklyCount, repeatedWeeklyCount, err)
	}
}

func createM4Provider(t *testing.T, client *http.Client, baseURL, csrf string) m3ProviderResponse {
	t.Helper()
	response := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/providers", map[string]any{
		"providerKey": "m4-local", "displayName": "M4 Local Mock", "protocol": "openai-completions",
		"baseUrl": "https://provider.example.test/v1", "apiKey": "m4-synthetic-key",
		"models": []map[string]any{{
			"modelId": "m4-model", "displayName": "M4 Model", "contextWindow": 32768,
			"maxOutputTokens": 2048, "supportsTools": true, "supportsVision": true,
		}},
	}, csrf)
	assertStatus(t, response, http.StatusCreated)
	return decodeResponse[m3ProviderResponse](t, response)
}

func createM4Task(t *testing.T, client *http.Client, baseURL, csrf, taskType string, itemID, modelID uuid.UUID) m4TaskResponse {
	t.Helper()
	response := sendJSON(t, client, http.MethodPost, baseURL+"/api/v1/ai/tasks", map[string]any{
		"taskType": taskType, "itemId": itemID.String(), "modelId": modelID.String(),
		"sensitivePolicy": "block", "options": map[string]any{"includeRelatedRecords": false},
	}, csrf)
	assertStatus(t, response, http.StatusCreated)
	return decodeResponse[m4TaskResponse](t, response)
}

func m4FragmentID(t *testing.T, database *pgxpool.Pool, itemID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := database.QueryRow(context.Background(), `
		SELECT id FROM search_fragments WHERE item_id = $1 AND source_kind IN ('raw_text', 'code')
		ORDER BY ordinal, id LIMIT 1
	`, itemID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

type m4ClaimResult struct {
	status int
	body   []byte
	err    error
}

func concurrentM4Claims(t *testing.T, client *http.Client, baseURL string) []m4ClaimResult {
	t.Helper()
	start := make(chan struct{})
	results := make(chan m4ClaimResult, 2)
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			request, err := http.NewRequest(http.MethodPost, baseURL+"/internal/ai/tasks/claim", bytes.NewBufferString(`{"workerId":"m4-worker"}`))
			if err != nil {
				results <- m4ClaimResult{err: err}
				return
			}
			request.Header.Set("Authorization", "Bearer "+m3InternalToken)
			request.Header.Set("Content-Type", "application/json")
			response, err := client.Do(request)
			if err != nil {
				results <- m4ClaimResult{err: err}
				return
			}
			body, readErr := readBoundedTestBody(response)
			results <- m4ClaimResult{status: response.StatusCode, body: body, err: readErr}
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	collected := make([]m4ClaimResult, 0, 2)
	statuses := map[int]int{}
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		collected = append(collected, result)
		statuses[result.status]++
	}
	if statuses[http.StatusOK] != 1 || statuses[http.StatusNoContent] != 1 {
		t.Fatalf("concurrent claim statuses = %+v responses=%q", statuses, [][]byte{collected[0].body, collected[1].body})
	}
	return collected
}

func concurrentM4Completes(
	t *testing.T,
	client *http.Client,
	baseURL string,
	taskID uuid.UUID,
	leaseVersion int,
	artifactPayload map[string]any,
) m4ArtifactResponse {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"workerId": "m4-worker", "leaseVersion": leaseVersion, "artifact": artifactPayload,
		"inputTokens": 12, "outputTokens": 34,
	})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan m4ClaimResult, 2)
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			request, requestErr := http.NewRequest(
				http.MethodPost,
				baseURL+"/internal/ai/tasks/"+taskID.String()+"/complete",
				bytes.NewReader(payload),
			)
			if requestErr != nil {
				results <- m4ClaimResult{err: requestErr}
				return
			}
			request.Header.Set("Authorization", "Bearer "+m3InternalToken)
			request.Header.Set("Content-Type", "application/json")
			response, requestErr := client.Do(request)
			if requestErr != nil {
				results <- m4ClaimResult{err: requestErr}
				return
			}
			body, readErr := readBoundedTestBody(response)
			results <- m4ClaimResult{status: response.StatusCode, body: body, err: readErr}
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	statuses := map[int]int{}
	artifacts := make([]m4ArtifactResponse, 0, 2)
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		statuses[result.status]++
		if result.status != http.StatusCreated && result.status != http.StatusOK {
			t.Fatalf("concurrent complete status=%d body=%s", result.status, result.body)
		}
		var artifact m4ArtifactResponse
		if err := json.Unmarshal(result.body, &artifact); err != nil {
			t.Fatal(err)
		}
		artifacts = append(artifacts, artifact)
	}
	if statuses[http.StatusCreated] != 1 || statuses[http.StatusOK] != 1 ||
		len(artifacts) != 2 || artifacts[0].ID != artifacts[1].ID {
		t.Fatalf("concurrent complete did not converge: statuses=%+v artifacts=%+v", statuses, artifacts)
	}
	return artifacts[0]
}

func claimM4Task(t *testing.T, client *http.Client, baseURL string, expected int) m4ClaimResponse {
	t.Helper()
	response := sendM4InternalJSON(t, client, http.MethodPost, baseURL+"/internal/ai/tasks/claim", map[string]any{"workerId": "m4-worker"})
	assertStatus(t, response, expected)
	return decodeResponse[m4ClaimResponse](t, response)
}

func sendM4InternalJSON(t *testing.T, client *http.Client, method, endpoint string, payload any) *http.Response {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(method, endpoint, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+m3InternalToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func readBoundedTestBody(response *http.Response) ([]byte, error) {
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 32*1024*1024+1))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if len(body) > 32*1024*1024 {
		return nil, fmt.Errorf("read response: body too large")
	}
	return body, nil
}

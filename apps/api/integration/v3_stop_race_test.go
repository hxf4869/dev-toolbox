//go:build integration

// DT-R17 回归：公开 stop 端点在 run=running 时只落 stop_requested_at（run 仍
// running 且 lease 有效），若 Worker 的 complete 请求晚到，completeRun 曾在
// FOR UPDATE 锁定后仅校验 lease、不检查 stop_requested_at，把已请求停止的
// run 覆盖成 succeeded 并把完整回答写成 complete。docs/16 §11.3 要求停止先
// 落库时，晚到的 complete 必须终止为 stopped，且部分回答内容保留。
package integration_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// startAndClaimV3Run 创建一个 run 并由内部 worker 领取，返回 runID 与 leaseVersion。
func startAndClaimV3Run(t *testing.T, h *v3Harness, workerID string) (string, int) {
	t.Helper()
	_, modelID := h.createProviderModel(t, []map[string]any{})
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
	decodeInto(t, readResponse(t, start), &startBody)
	claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": workerID})
	assertStatus(t, claim, http.StatusOK)
	var claimBody struct {
		Run struct {
			ID           string `json:"id"`
			LeaseVersion int    `json:"leaseVersion"`
		} `json:"run"`
	}
	decodeInto(t, readResponse(t, claim), &claimBody)
	if claimBody.Run.ID != startBody.Run.ID {
		t.Fatalf("claim returned %s, expected %s", claimBody.Run.ID, startBody.Run.ID)
	}
	return startBody.Run.ID, claimBody.Run.LeaseVersion
}

func completeClaimedV3Run(t *testing.T, h *v3Harness, runID string, workerID string, leaseVersion int) string {
	t.Helper()
	complete := h.internalPost(t, "/internal/assistant/runs/"+runID+"/complete", map[string]any{
		"workerId": workerID, "leaseVersion": leaseVersion,
		"usage": map[string]any{}, "timings": map[string]any{},
	})
	assertStatus(t, complete, http.StatusOK)
	var completeBody struct {
		Status string `json:"status"`
	}
	decodeInto(t, readResponse(t, complete), &completeBody)
	return completeBody.Status
}

func TestV3StopRequestedBeforeLateCompleteEndsStopped(t *testing.T) {
	h := newV3Harness(t)
	const workerID = "worker-r17-stop"
	runID, leaseVersion := startAndClaimV3Run(t, h, workerID)

	// Worker 已流式写入部分回答，用户随后点击停止（run 仍 running，仅落
	// stop_requested_at），之后晚到的 complete 才到达。
	delta := h.internalPost(t, "/internal/assistant/runs/"+runID+"/events", map[string]any{
		"workerId": workerID, "leaseVersion": leaseVersion,
		"events": []map[string]any{
			{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": "部分回答"}},
		},
	})
	assertStatus(t, delta, http.StatusOK)
	stop := h.post(t, "/api/v1/assistant/runs/"+runID+"/stop", map[string]any{})
	assertStatus(t, stop, http.StatusOK)

	if status := completeClaimedV3Run(t, h, runID, workerID, leaseVersion); status != "stopped" {
		t.Fatalf("late complete after stop must end stopped, got %q", status)
	}

	var runStatus string
	var finishedAt *time.Time
	var errorCode *string
	var leaseOwner *string
	if err := h.database.QueryRow(context.Background(), `
		SELECT status, finished_at, error_code, lease_owner FROM assistant_runs WHERE id = $1
	`, runID).Scan(&runStatus, &finishedAt, &errorCode, &leaseOwner); err != nil {
		t.Fatal(err)
	}
	if runStatus != "stopped" || finishedAt == nil || errorCode != nil || leaseOwner != nil {
		t.Fatalf("stopped run row wrong: status=%q finished_at=%v error_code=%v lease_owner=%v",
			runStatus, finishedAt, errorCode, leaseOwner)
	}
	var messageStatus, content string
	var completedAt *time.Time
	if err := h.database.QueryRow(context.Background(), `
		SELECT status, completed_at, content FROM assistant_messages WHERE current_run_id = $1
	`, runID).Scan(&messageStatus, &completedAt, &content); err != nil {
		t.Fatal(err)
	}
	if messageStatus != "stopped" || completedAt == nil || content != "部分回答" {
		t.Fatalf("stopped message row wrong: status=%q completed_at=%v content=%q",
			messageStatus, completedAt, content)
	}
}

func TestV3CompleteBeforeStopKeepsSucceeded(t *testing.T) {
	h := newV3Harness(t)
	const workerID = "worker-r17-complete"
	runID, leaseVersion := startAndClaimV3Run(t, h, workerID)

	if status := completeClaimedV3Run(t, h, runID, workerID, leaseVersion); status != "succeeded" {
		t.Fatalf("complete before stop must stay succeeded, got %q", status)
	}
	var runStatus, messageStatus string
	if err := h.database.QueryRow(context.Background(), `
		SELECT status FROM assistant_runs WHERE id = $1
	`, runID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := h.database.QueryRow(context.Background(), `
		SELECT status FROM assistant_messages WHERE current_run_id = $1
	`, runID).Scan(&messageStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" || messageStatus != "complete" {
		t.Fatalf("expected succeeded/complete, got %q/%q", runStatus, messageStatus)
	}

	stop := h.post(t, "/api/v1/assistant/runs/"+runID+"/stop", map[string]any{})
	if status, code := v3Error(t, stop); status != http.StatusConflict || code != "ASSISTANT_RUN_NOT_STOPPABLE" {
		t.Fatalf("expected 409 ASSISTANT_RUN_NOT_STOPPABLE, got %d %s", status, code)
	}
	if err := h.database.QueryRow(context.Background(), `
		SELECT status FROM assistant_runs WHERE id = $1
	`, runID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" {
		t.Fatalf("completed run must stay succeeded after late stop, got %q", runStatus)
	}
}

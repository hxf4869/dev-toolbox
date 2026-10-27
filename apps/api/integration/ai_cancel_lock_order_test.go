//go:build integration

package integration_test

// Regression for the batch-cancel row-lock order: cancelTask must take child
// row locks before the parent lock, matching recoverExpiredTasks/completeTask.
// Before the fix a batch cancel held the parent lock while waiting on a child
// lock that a claim-side recovery of the same batch held, so both transactions
// deadlocked and PostgreSQL aborted one (the caller saw an unexpected 500).
// The interleaving here is enforced by lock ownership — the recovery side
// takes the child lock before the cancel request is even sent — so the test
// never depends on timing.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestM4BatchCancelInterleavesWithExpiredLeaseRecovery(t *testing.T) {
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

	server, client, csrf, _ := newAuthenticatedM3ServerWithService(t, database, t.TempDir(), "http://127.0.0.1:1")
	defer server.Close()
	provider := createM4Provider(t, client, server.URL, csrf)
	modelID := provider.Models[0].ID

	createText := func(key, body string) apiResponse {
		response := sendJSONWithKey(t, client, http.MethodPost, server.URL+"/api/v1/items", map[string]any{
			"body": body, "contentFormat": "plain_text", "sensitivity": "normal",
		}, csrf, key)
		assertStatus(t, response, http.StatusCreated)
		return decodeResponse[apiResponse](t, response)
	}
	itemA := createText("ai-lock-order-a", "lock order fixture A with a real body")
	itemB := createText("ai-lock-order-b", "lock order fixture B with a real body")

	batchResponse := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/tasks", map[string]any{
		"taskType":        "batch_organize",
		"itemIds":         []string{itemA.Item.ID.String(), itemB.Item.ID.String()},
		"organizeModelId": modelID.String(), "visionModelId": "", "sensitivePolicy": "block",
	}, csrf)
	assertStatus(t, batchResponse, http.StatusCreated)
	batch := decodeResponse[m4TaskResponse](t, batchResponse)
	if batch.Status != "running" {
		t.Fatalf("fixture: batch should stay running with queued children: %+v", batch)
	}
	var runningChildID, queuedChildID uuid.UUID
	if err := database.QueryRow(ctx,
		`SELECT id FROM ai_task_runs WHERE parent_task_id = $1 AND status = 'queued' ORDER BY id LIMIT 1`,
		batch.ID).Scan(&runningChildID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx,
		`SELECT id FROM ai_task_runs WHERE parent_task_id = $1 AND status = 'queued' AND id <> $2 ORDER BY id LIMIT 1`,
		batch.ID, runningChildID).Scan(&queuedChildID); err != nil {
		t.Fatal(err)
	}
	// Expire the lease on one child so recoverExpiredTasks would reclaim it.
	if _, err := database.Exec(ctx, `
		UPDATE ai_task_runs SET status = 'running', started_at = now(),
		       lease_owner = 'lock-order-test', claim_attempt = 1,
		       lease_expires_at = now() - interval '1 hour',
		       heartbeat_at = now() - interval '1 hour'
		WHERE id = $1
	`, runningChildID); err != nil {
		t.Fatal(err)
	}

	// Hold the running child's row lock exactly as recoverExpiredTasks does
	// before it reaches updateBatchParent. The recovery-side lock takes are
	// bounded by a statement-level lock timeout on top of the test context.
	recoveryTx, err := database.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = recoveryTx.Rollback(context.Background()) }()
	var recoveryXID int64
	if err := recoveryTx.QueryRow(ctx, `SELECT txid_current()`).Scan(&recoveryXID); err != nil {
		t.Fatal(err)
	}
	if _, err := recoveryTx.Exec(ctx, `SET LOCAL lock_timeout = '5s'`); err != nil {
		t.Fatal(err)
	}
	if _, err := recoveryTx.Exec(ctx, `SELECT id FROM ai_task_runs WHERE id = $1 FOR UPDATE`, runningChildID); err != nil {
		t.Fatal(err)
	}

	cancelCtx, cancelCtxCancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancelCtxCancel()
	type cancelResult struct {
		status int
		body   []byte
	}
	results := make(chan cancelResult, 1)
	go func() {
		request, err := http.NewRequestWithContext(cancelCtx, http.MethodPost,
			server.URL+"/api/v1/ai/tasks/"+batch.ID.String()+"/cancel", bytes.NewReader([]byte(`{}`)))
		if err != nil {
			results <- cancelResult{status: -1, body: []byte(err.Error())}
			return
		}
		request.Header.Set("Origin", testOrigin)
		request.Header.Set("X-CSRF-Token", csrf)
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			results <- cancelResult{status: -1, body: []byte(err.Error())}
			return
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		results <- cancelResult{status: response.StatusCode, body: body}
	}()

	// Synchronization point: wait until the cancel transaction is actually
	// blocked on a row lock held by the recovery transaction. Only then is the
	// recovery side allowed to reach for the parent lock. Under the old
	// parent-first order the cancel already holds the parent lock at this
	// point, so the recovery-side parent lock deadlocks or times out; under
	// the child-first order it acquires immediately.
	waitCtx, waitCancel := context.WithTimeout(ctx, 10*time.Second)
	defer waitCancel()
	blockingOnRecovery := fmt.Sprintf("%d", recoveryXID)
	for {
		var waiting int
		queryErr := database.QueryRow(waitCtx, `
			SELECT count(*) FROM pg_locks
			WHERE locktype = 'transactionid' AND transactionid::text = $1 AND NOT granted
		`, blockingOnRecovery).Scan(&waiting)
		if queryErr == nil && waiting > 0 {
			break
		}
		if waitCtx.Err() != nil {
			t.Fatalf("取消事务未在恢复事务持有的子行锁上观察到锁等待关系（pg_locks 同步超时）")
		}
		if queryErr != nil && waitCtx.Err() == nil {
			t.Fatal(queryErr)
		}
		select {
		case <-waitCtx.Done():
			t.Fatalf("取消事务未在恢复事务持有的子行锁上观察到锁等待关系（pg_locks 同步超时）")
		case <-time.After(50 * time.Millisecond):
		}
	}

	// While the cancel is blocked on the child lock, the recovery side moves
	// on to the parent lock (bounded by the lock timeout above).
	if _, err := recoveryTx.Exec(ctx, `SELECT id FROM ai_task_runs WHERE id = $1 FOR UPDATE`, batch.ID); err != nil {
		t.Fatalf("recovery-side parent lock deadlocked against the cancel: %v", err)
	}
	if err := recoveryTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	select {
	case result := <-results:
		if result.status != http.StatusAccepted && result.status != http.StatusOK {
			t.Fatalf("cancel did not survive the interleaved recovery: status=%d body=%s", result.status, result.body)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("cancel did not complete after the recovery released its locks; lock-order regression suspected")
	}

	var queuedStatus string
	if err := database.QueryRow(ctx, `SELECT status FROM ai_task_runs WHERE id = $1`, queuedChildID).Scan(&queuedStatus); err != nil {
		t.Fatal(err)
	}
	if queuedStatus != "cancelled" {
		t.Fatalf("queued child should be cancelled, got %q", queuedStatus)
	}
	var runningStatus string
	var cancelRequestedAt *time.Time
	if err := database.QueryRow(ctx, `SELECT status, cancel_requested_at FROM ai_task_runs WHERE id = $1`, runningChildID).Scan(&runningStatus, &cancelRequestedAt); err != nil {
		t.Fatal(err)
	}
	if runningStatus != "running" || cancelRequestedAt == nil {
		t.Fatalf("running child should keep running with a cancel request, got status=%q cancelRequested=%v", runningStatus, cancelRequestedAt)
	}
	var parentCancelRequested *time.Time
	var summaryRaw []byte
	if err := database.QueryRow(ctx, `SELECT cancel_requested_at, batch_summary FROM ai_task_runs WHERE id = $1`, batch.ID).Scan(&parentCancelRequested, &summaryRaw); err != nil {
		t.Fatal(err)
	}
	if parentCancelRequested == nil {
		t.Fatal("parent batch lost the cancel request")
	}
	var summary struct {
		ChildStatusCounts struct {
			Queued    int `json:"queued"`
			Running   int `json:"running"`
			Cancelled int `json:"cancelled"`
		} `json:"childStatusCounts"`
	}
	if err := json.Unmarshal(summaryRaw, &summary); err != nil {
		t.Fatal(err)
	}
	if summary.ChildStatusCounts.Cancelled != 1 || summary.ChildStatusCounts.Running != 1 || summary.ChildStatusCounts.Queued != 0 {
		t.Fatalf("batch summary does not reflect the interleaved cancel: %+v", summary.ChildStatusCounts)
	}
}

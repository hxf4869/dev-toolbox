//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestM3PATConcurrentFirstUse is the regression test for the fixed
// concurrent first-use race in authenticatePAT (baseline before the fix:
// statuses [200 401], the row-lock loser was rejected as AUTH_REQUIRED).
// Both requests still SELECT last_used_at IS NULL and both reach the UPDATE,
// but the UPDATE no longer re-checks freshness, so each concurrent touch
// affects one row. Both concurrent first uses of a valid PAT must succeed.
func TestM3PATConcurrentFirstUse(t *testing.T) {
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

	worker := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {}))
	defer worker.Close()

	server, client, csrf := newAuthenticatedM3Server(t, database, t.TempDir(), worker.URL)
	defer server.Close()

	token := createM3Token(t, client, server.URL, csrf, "并发首用", []string{"records:read"})
	var lastUsedNull bool
	if err := database.QueryRow(ctx, "SELECT last_used_at IS NULL FROM personal_access_tokens WHERE id = $1", token.ID).Scan(&lastUsedNull); err != nil {
		t.Fatal(err)
	}
	if !lastUsedNull {
		t.Fatal("fixture: fresh PAT already had last_used_at set")
	}

	lockCtx, lockCancel := context.WithCancel(ctx)
	tx, err := database.Begin(lockCtx)
	if err != nil {
		lockCancel()
		t.Fatal(err)
	}
	var lockedID uuid.UUID
	if err := tx.QueryRow(lockCtx, "SELECT id FROM personal_access_tokens WHERE id = $1 FOR UPDATE", token.ID).Scan(&lockedID); err != nil {
		_ = tx.Rollback(context.Background())
		lockCancel()
		t.Fatal(err)
	}
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			_ = tx.Rollback(context.Background())
			lockCancel()
		})
	}
	defer release()

	patClient := &http.Client{Transport: client.Transport}
	results := make(chan patRaceResult, 2)
	for i := 0; i < 2; i++ {
		go func() {
			results <- patRaceFirstUseRequest(patClient, server.URL, token.Token)
		}()
	}

	waiters := waitForPATRaceLockWaiters(t, database, ctx, 10*time.Second)
	if waiters < 2 {
		release()
		completed := collectPATRaceResults(results, 5*time.Second)
		t.Fatalf("fixture: only %d distinct lock waiters were observed (want 2); collected %d/2 request results", waiters, len(completed))
	}
	release()

	completed := collectPATRaceResults(results, 30*time.Second)
	if len(completed) < 2 {
		t.Fatalf("fixture: only %d/2 concurrent first-use requests completed after lock release (waiters observed: %d)", len(completed), waiters)
	}
	for _, result := range completed {
		if result.err != nil {
			t.Fatalf("fixture: concurrent first-use request failed to complete: %v", result.err)
		}
	}
	sort.Slice(completed, func(i, j int) bool { return completed[i].status < completed[j].status })
	if completed[0].status != http.StatusOK || completed[1].status != http.StatusOK {
		t.Fatalf("concurrent first-use statuses = [%d %d], error codes = [%q %q]; want [200 200]",
			completed[0].status, completed[1].status, completed[0].code, completed[1].code)
	}

	var hasLastUsed bool
	if err := database.QueryRow(ctx, "SELECT last_used_at IS NOT NULL FROM personal_access_tokens WHERE id = $1", token.ID).Scan(&hasLastUsed); err != nil {
		t.Fatal(err)
	}
	if !hasLastUsed {
		t.Fatal("PAT last_used_at was not recorded after concurrent first use")
	}
}

type patRaceResult struct {
	status int
	code   string
	err    error
}

func patRaceFirstUseRequest(client *http.Client, baseURL, token string) patRaceResult {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/v1/items", nil)
	if err != nil {
		return patRaceResult{err: err}
	}
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("User-Agent", "dev-toolbox-m1-integration")
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		return patRaceResult{err: err}
	}
	defer response.Body.Close()
	result := patRaceResult{status: response.StatusCode}
	if response.StatusCode != http.StatusOK {
		var envelope struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&envelope); err == nil {
			result.code = envelope.Error.Code
		}
	}
	return result
}

func waitForPATRaceLockWaiters(t *testing.T, database *pgxpool.Pool, ctx context.Context, timeout time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(timeout)
	waiters := 0
	for {
		if err := database.QueryRow(ctx, `
			SELECT count(DISTINCT l.pid)
			FROM pg_locks l
			JOIN pg_stat_activity a ON a.pid = l.pid
			WHERE NOT l.granted
			  AND a.datname = current_database()
			  AND a.pid <> pg_backend_pid()
		`).Scan(&waiters); err != nil {
			t.Fatal(err)
		}
		if waiters >= 2 || time.Now().After(deadline) {
			return waiters
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func collectPATRaceResults(results <-chan patRaceResult, timeout time.Duration) []patRaceResult {
	deadline := time.After(timeout)
	var collected []patRaceResult
	for len(collected) < 2 {
		select {
		case result := <-results:
			collected = append(collected, result)
		case <-deadline:
			return collected
		}
	}
	return collected
}

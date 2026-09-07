//go:build integration

// Database-backed verification of the lease-free summary maintenance write
// (docs/16 §14) and the claim-side maintenance baseline pair. Requires a
// migrated PostgreSQL database via TEST_DATABASE_URL, exactly like the
// integration suite under apps/api/integration.
package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/tern/v2/migrate"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

var (
	summaryStorePool     *pgxpool.Pool
	summaryStorePoolOnce sync.Once
	summaryStorePoolErr  error
)

func openSummaryStorePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is required for the summary store test")
	}
	summaryStorePoolOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		conn, err := pgx.Connect(ctx, databaseURL)
		if err != nil {
			summaryStorePoolErr = err
			return
		}
		defer conn.Close(ctx)
		migrator, err := migrate.NewMigrator(ctx, conn, "public.schema_version")
		if err != nil {
			summaryStorePoolErr = err
			return
		}
		if err := migrator.LoadMigrations(os.DirFS("../../migrations")); err != nil {
			summaryStorePoolErr = err
			return
		}
		if err := migrator.Migrate(ctx); err != nil {
			summaryStorePoolErr = err
			return
		}
		pool, err := pgxpool.New(ctx, databaseURL)
		if err != nil {
			summaryStorePoolErr = err
			return
		}
		summaryStorePool = pool
	})
	if summaryStorePoolErr != nil {
		t.Fatalf("prepare test database: %v", summaryStorePoolErr)
	}
	return summaryStorePool
}

type summaryFixture struct {
	runID          uuid.UUID
	conversationID uuid.UUID
}

// newSummaryFixture inserts one provider/model/conversation/messages/run
// chain with the requested run status and returns its identifiers.
func newSummaryFixture(t *testing.T, pool *pgxpool.Pool, status string) summaryFixture {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	fixture := summaryFixture{
		runID:          uuid.New(),
		conversationID: uuid.New(),
	}
	providerID := uuid.New()
	modelID := uuid.New()
	inputMessageID := uuid.New()
	outputMessageID := uuid.New()
	providerKey := "fixture-" + fixture.runID.String()[:8]
	masterKey := make([]byte, 32)
	apiKeyCiphertext, err := secretbox.Seal(masterKey, "fixture-provider-key")
	if err != nil {
		t.Fatalf("seal fixture provider key: %v", err)
	}

	cleanup := func() {
		pool.Exec(ctx, `DELETE FROM assistant_conversations WHERE id = $1`, fixture.conversationID)
		pool.Exec(ctx, `DELETE FROM provider_models WHERE id = $1`, modelID)
		pool.Exec(ctx, `DELETE FROM provider_configs WHERE id = $1`, providerID)
	}
	t.Cleanup(cleanup)

	if _, err := pool.Exec(ctx, `
		INSERT INTO provider_configs (id, provider_key, display_name, protocol, base_url, api_key_ciphertext, enabled, created_at, updated_at)
		VALUES ($1, $2, 'fixture provider', 'openai-completions', 'https://provider.fixture.test', $3, true, $4, $4)
	`, providerID, providerKey, apiKeyCiphertext, now); err != nil {
		t.Fatalf("insert provider config: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO provider_models (id, provider_config_id, model_id, display_name, context_window, max_output_tokens, enabled, created_at, updated_at)
		VALUES ($1, $2, 'fixture-model', 'fixture model', 32768, 4096, true, $3, $3)
	`, modelID, providerID, now); err != nil {
		t.Fatalf("insert provider model: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO assistant_conversations (id, title, title_origin, selected_model_id, next_message_sequence, created_at, updated_at)
		VALUES ($1, 'fixture conversation', 'provisional', $2, 3, $3, $3)
	`, fixture.conversationID, modelID, now); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO assistant_messages (id, conversation_id, sequence, role, content, status, created_at, completed_at)
		VALUES
			($1, $2, 1, 'user', 'fixture question', 'complete', $3, $3),
			($4, $2, 2, 'assistant', 'fixture answer', 'streaming', $3, NULL)
	`, inputMessageID, fixture.conversationID, now, outputMessageID); err != nil {
		t.Fatalf("insert messages: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO assistant_runs (id, conversation_id, input_message_id, output_message_id, client_request_id,
		       request_snapshot, status, provider_id, provider_display_name, model_id, model_display_name,
		       upstream_model_id, protocol, base_url, context_window, max_output_tokens, sensitive_policy,
		       effective_sensitive_policy, prompt_version, retrieval_version, knowledge_state,
		       created_at, queued_at, started_at, finished_at)
		VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, 'fixture provider', $8, 'fixture model',
		       'fixture-model', 'openai-completions', 'https://provider.fixture.test', 32768, 4096,
		       'allow', 'allow', 'assistant-answer-v2', 'hybrid-rrf-v1', 'unavailable', $9, $9, $9, $9)
	`, fixture.runID, fixture.conversationID, inputMessageID, outputMessageID, uuid.New(), status,
		providerID, modelID, now); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	return fixture
}

func newSummaryStoreServer(t *testing.T, pool *pgxpool.Pool) *httptest.Server {
	t.Helper()
	masterKey := make([]byte, 32)
	service := &Service{database: pool, masterKey: masterKey, now: time.Now}
	mux := http.NewServeMux()
	mux.Handle("POST /internal/assistant/runs/claim", http.HandlerFunc(service.claimRun))
	mux.Handle("POST /internal/assistant/runs/{id}/summary", http.HandlerFunc(service.runSummary))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func postSummary(t *testing.T, server *httptest.Server, runID uuid.UUID, body string) (int, bool) {
	t.Helper()
	response, err := server.Client().Post(
		server.URL+"/internal/assistant/runs/"+runID.String()+"/summary",
		"application/json", strings.NewReader(body),
	)
	if err != nil {
		t.Fatalf("POST summary: %v", err)
	}
	defer response.Body.Close()
	var payload struct {
		Applied bool `json:"applied"`
	}
	if response.StatusCode == http.StatusOK {
		if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
			t.Fatalf("decode summary response: %v", err)
		}
	}
	return response.StatusCode, payload.Applied
}

func storedSummary(t *testing.T, pool *pgxpool.Pool, conversationID uuid.UUID) (int64, string) {
	t.Helper()
	var through int64
	var content []byte
	err := pool.QueryRow(context.Background(),
		`SELECT through_message_sequence, content FROM assistant_conversation_summaries WHERE conversation_id = $1`,
		conversationID).Scan(&through, &content)
	if err != nil {
		t.Fatalf("read stored summary: %v", err)
	}
	return through, string(content)
}

const summaryBodyTemplate = `{"summary":{"confirmedFacts":["%s"],"corrections":[],"rejectedHypotheses":[],"unresolvedQuestions":[]},` +
	`"throughMessageSequence":%d,"baselineThroughMessageSequence":%d,` +
	`"modelSnapshot":{"modelId":"fixture-model","displayName":"fixture model"}}`

func TestRunSummaryAppliesOnlyMatchingBaselineWithAdvancingWatermark(t *testing.T) {
	pool := openSummaryStorePool(t)
	server := newSummaryStoreServer(t, pool)
	fixture := newSummaryFixture(t, pool, "succeeded")

	// First write without a stored summary: baseline 0 inserts.
	status, applied := postSummary(t, server, fixture.runID, fmt.Sprintf(summaryBodyTemplate, "第一轮事实", 10, 0))
	if status != http.StatusOK || !applied {
		t.Fatalf("first summary write: status=%d applied=%t", status, applied)
	}
	through, content := storedSummary(t, pool, fixture.conversationID)
	if through != 10 || !strings.Contains(content, "第一轮事实") {
		t.Fatalf("stored summary after first write: through=%d content=%s", through, content)
	}

	// An old worker that omits the baseline is rejected and cannot fall back
	// to an unconditional overwrite.
	status, _ = postSummary(t, server, fixture.runID,
		`{"summary":{"confirmedFacts":["旧Worker"],"corrections":[],"rejectedHypotheses":[],"unresolvedQuestions":[]},`+
			`"throughMessageSequence":12,"modelSnapshot":{"modelId":"fixture-model"}}`)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("missing baseline must be rejected, got status=%d", status)
	}

	// A non-advancing or inverted watermark is invalid.
	status, _ = postSummary(t, server, fixture.runID, fmt.Sprintf(summaryBodyTemplate, "不前进", 10, 10))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("non-advancing watermark must be rejected, got status=%d", status)
	}
	status, _ = postSummary(t, server, fixture.runID, fmt.Sprintf(summaryBodyTemplate, "倒退", 9, 10))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("watermark regression must be rejected, got status=%d", status)
	}

	// Matching baseline with an advancing watermark updates cumulatively.
	status, applied = postSummary(t, server, fixture.runID, fmt.Sprintf(summaryBodyTemplate, "第二轮事实", 20, 10))
	if status != http.StatusOK || !applied {
		t.Fatalf("matching baseline write: status=%d applied=%t", status, applied)
	}
	through, content = storedSummary(t, pool, fixture.conversationID)
	if through != 20 || !strings.Contains(content, "第二轮事实") {
		t.Fatalf("stored summary after update: through=%d content=%s", through, content)
	}

	// The stale baseline 10 no longer matches the stored watermark 20.
	status, applied = postSummary(t, server, fixture.runID, fmt.Sprintf(summaryBodyTemplate, "过期基准", 30, 10))
	if status != http.StatusOK || applied {
		t.Fatalf("stale baseline must report not applied, got status=%d applied=%t", status, applied)
	}
	through, content = storedSummary(t, pool, fixture.conversationID)
	if through != 20 || !strings.Contains(content, "第二轮事实") {
		t.Fatalf("stale baseline must keep the stored summary: through=%d content=%s", through, content)
	}
}

func TestRunSummaryConcurrentWritesFromSameBaselineKeepOneResult(t *testing.T) {
	pool := openSummaryStorePool(t)
	server := newSummaryStoreServer(t, pool)
	fixture := newSummaryFixture(t, pool, "succeeded")

	// Insert race on the empty table: exactly one of two baseline-0 writers
	// wins and the loser must not overwrite the winner.
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]bool, 2)
	for index := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			_, applied := postSummary(t, server, fixture.runID,
				fmt.Sprintf(summaryBodyTemplate, fmt.Sprintf("并发首写%d", index), 10, 0))
			results[index] = applied
		}(index)
	}
	close(start)
	wg.Wait()
	if results[0] == results[1] {
		t.Fatalf("exactly one concurrent first write may apply, got %v", results)
	}
	through, content := storedSummary(t, pool, fixture.conversationID)
	if through != 10 {
		t.Fatalf("watermark after insert race = %d, want 10", through)
	}
	winner := 0
	if results[1] {
		winner = 1
	}
	if !strings.Contains(content, fmt.Sprintf("并发首写%d", winner)) {
		t.Fatalf("stored content must match the winner: %s", content)
	}

	// Same stale baseline from two writers with different results: the first
	// wins, the second is rejected even though its target watermark is larger.
	if _, applied := postSummary(t, server, fixture.runID, fmt.Sprintf(summaryBodyTemplate, "基准推进", 30, 10)); !applied {
		t.Fatal("advancing from the current baseline must apply")
	}
	start = make(chan struct{})
	for index := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			_, applied := postSummary(t, server, fixture.runID,
				fmt.Sprintf(summaryBodyTemplate, fmt.Sprintf("同基准并发%d", index), int64(40+index), 30))
			results[index] = applied
		}(index)
	}
	close(start)
	wg.Wait()
	if results[0] == results[1] {
		t.Fatalf("exactly one same-baseline writer may apply, got %v", results)
	}
	through, content = storedSummary(t, pool, fixture.conversationID)
	winner = 0
	if results[1] {
		winner = 1
	}
	if through != int64(40+winner) || !strings.Contains(content, fmt.Sprintf("同基准并发%d", winner)) {
		t.Fatalf("stored summary must match the single winner: through=%d content=%s", through, content)
	}
}

func TestRunSummaryRequiresSucceededRun(t *testing.T) {
	pool := openSummaryStorePool(t)
	server := newSummaryStoreServer(t, pool)
	fixture := newSummaryFixture(t, pool, "running")

	status, applied := postSummary(t, server, fixture.runID, fmt.Sprintf(summaryBodyTemplate, "未成功", 10, 0))
	if status != http.StatusOK || applied {
		t.Fatalf("a non-succeeded run must not store a summary, got status=%d applied=%t", status, applied)
	}
	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM assistant_conversation_summaries WHERE conversation_id = $1`,
		fixture.conversationID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("summary row must be absent, count=%d err=%v", count, err)
	}
}

// TestClaimCarriesBaselinePairIndependentOfAnswerBudget verifies the claim
// snapshot: the stored summary content and watermark travel together as the
// maintenance baseline even when the answer-side summary is dropped by the
// input budget.
func TestClaimCarriesBaselinePairIndependentOfAnswerBudget(t *testing.T) {
	pool := openSummaryStorePool(t)
	server := newSummaryStoreServer(t, pool)
	fixture := newSummaryFixture(t, pool, "queued")

	ctx := context.Background()
	now := time.Now().UTC()
	if _, err := pool.Exec(ctx, `
		INSERT INTO assistant_conversation_summaries (conversation_id, through_message_sequence, content, model_snapshot, updated_at)
		VALUES ($1, $2, $3::jsonb, '{"modelId":"fixture-model"}'::jsonb, $4)
	`, fixture.conversationID, 2,
		`{"confirmedFacts":["基准事实"],"corrections":["用户纠正"],"rejectedHypotheses":[],"unresolvedQuestions":[]}`,
		now); err != nil {
		t.Fatalf("insert baseline summary: %v", err)
	}

	// Seed uncovered history so the rolling summary must regenerate, then
	// shrink the frozen context window on the run snapshot so the answer-side
	// summary no longer fits the input budget, and claim.
	history := make([][]any, 0, 17)
	for sequence := 3; sequence <= 19; sequence++ {
		history = append(history, []any{uuid.New(), sequence, fmt.Sprintf("旧消息%d", sequence)})
	}
	for _, entry := range history {
		if _, err := pool.Exec(ctx, `
			INSERT INTO assistant_messages (id, conversation_id, sequence, role, content, status, created_at, completed_at)
			VALUES ($1, $2, $3, 'user', $4, 'complete', $5, $5)
		`, entry[0], fixture.conversationID, entry[1], entry[2], now); err != nil {
			t.Fatalf("insert history message: %v", err)
		}
	}
	if _, err := pool.Exec(ctx,
		`UPDATE assistant_runs SET context_window = 8192, max_output_tokens = 512 WHERE id = $1`, fixture.runID); err != nil {
		t.Fatalf("shrink run context window: %v", err)
	}

	response, err := server.Client().Post(server.URL+"/internal/assistant/runs/claim",
		"application/json", strings.NewReader(`{"workerId":"summary-store-test-worker"}`))
	if err != nil {
		t.Fatalf("POST claim: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("claim status = %d", response.StatusCode)
	}
	var claim struct {
		Run struct {
			ID uuid.UUID `json:"id"`
		} `json:"run"`
		Context struct {
			Summary       *json.RawMessage `json:"summary"`
			SummarySource *struct {
				Prior *struct {
					ThroughMessageSequence int64 `json:"throughMessageSequence"`
					Summary                struct {
						ConfirmedFacts []string `json:"confirmedFacts"`
						Corrections    []string `json:"corrections"`
					} `json:"summary"`
				} `json:"prior"`
				Messages []struct {
					Sequence int64  `json:"sequence"`
					Role     string `json:"role"`
					Content  string `json:"content"`
				} `json:"messages"`
			} `json:"summarySource"`
		} `json:"context"`
	}
	if err := json.NewDecoder(response.Body).Decode(&claim); err != nil {
		t.Fatalf("decode claim: %v", err)
	}
	if claim.Run.ID != fixture.runID {
		t.Fatalf("claimed unexpected run %s", claim.Run.ID)
	}
	if claim.Context.Summary != nil {
		t.Fatal("the answer-side summary must stay budget-trimmed for the tiny context window")
	}
	source := claim.Context.SummarySource
	if source == nil || source.Prior == nil {
		t.Fatalf("claim must carry the maintenance baseline: %#v", source)
	}
	if source.Prior.ThroughMessageSequence != 2 {
		t.Fatalf("baseline watermark = %d, want 2", source.Prior.ThroughMessageSequence)
	}
	if len(source.Prior.Summary.ConfirmedFacts) != 1 || source.Prior.Summary.ConfirmedFacts[0] != "基准事实" ||
		len(source.Prior.Summary.Corrections) != 1 || source.Prior.Summary.Corrections[0] != "用户纠正" {
		t.Fatalf("baseline content must match the stored summary: %#v", source.Prior.Summary)
	}
	if len(source.Messages) != 1 || source.Messages[0].Sequence != 3 || source.Messages[0].Content != "旧消息3" {
		t.Fatalf("only the oldest uncovered message past the 16-message keep window compresses: %#v",
			source.Messages)
	}
}

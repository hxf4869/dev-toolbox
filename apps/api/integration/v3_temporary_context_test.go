//go:build integration

package integration_test

// Real-database boundary coverage for the temporary chat stream (docs/19
// DT-R04): the model-locked "question alone over the input budget" 422 branch
// that the nil-DB unit tests cannot reach, the rolling-summary hand-off
// between two real public requests, and the guarantee that the ephemeral flow
// never writes the persisted chat tables. The worker here is a local
// httptest fixture — no real Provider is called, so this is a real-DB +
// HTTP/SSE integration check, not a product-level E2E.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

type temporarySummaryDTO struct {
	ConfirmedFacts      []string `json:"confirmedFacts"`
	Corrections         []string `json:"corrections"`
	RejectedHypotheses  []string `json:"rejectedHypotheses"`
	UnresolvedQuestions []string `json:"unresolvedQuestions"`
}

func (summary temporarySummaryDTO) payload() map[string]any {
	return map[string]any{
		"confirmedFacts":      summary.ConfirmedFacts,
		"corrections":         summary.Corrections,
		"rejectedHypotheses":  summary.RejectedHypotheses,
		"unresolvedQuestions": summary.UnresolvedQuestions,
	}
}

type temporaryHistoryDTO struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type temporaryStreamCapture struct {
	Model struct {
		ID              uuid.UUID `json:"id"`
		ProviderID      uuid.UUID `json:"providerId"`
		Protocol        string    `json:"protocol"`
		ContextWindow   int       `json:"contextWindow"`
		MaxOutputTokens int       `json:"maxOutputTokens"`
	} `json:"model"`
	Reasoning     string                `json:"reasoning"`
	Summary       *temporarySummaryDTO  `json:"summary"`
	Messages      []temporaryHistoryDTO `json:"messages"`
	SummarySource *struct {
		Prior    *temporarySummaryDTO  `json:"prior"`
		Messages []temporaryHistoryDTO `json:"messages"`
	} `json:"summarySource"`
	Question      string            `json:"question"`
	EvidenceState string            `json:"evidenceState"`
	Sources       []json.RawMessage `json:"sources"`
}

type temporaryWorkerStub struct {
	*httptest.Server
	mu       sync.Mutex
	captures []temporaryStreamCapture
}

func (stub *temporaryWorkerStub) captured() []temporaryStreamCapture {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	return append([]temporaryStreamCapture(nil), stub.captures...)
}

// newTemporaryWorkerStub stands in for the ai-worker internal temporary
// stream: it records each internal payload and answers with a usage event
// plus a succeeded terminal carrying the maintained rolling summary.
func newTemporaryWorkerStub(t *testing.T, respond func(call int) (summary temporarySummaryDTO, answerContextTokens int64)) *temporaryWorkerStub {
	t.Helper()
	stub := &temporaryWorkerStub{}
	stub.Server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/assistant/temporary/stream" {
			t.Errorf("unexpected worker path %s", request.URL.Path)
			response.WriteHeader(http.StatusNotFound)
			return
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read worker request: %v", err)
			response.WriteHeader(http.StatusInternalServerError)
			return
		}
		var capture temporaryStreamCapture
		if err := json.Unmarshal(body, &capture); err != nil {
			t.Errorf("decode worker request: %v", err)
			response.WriteHeader(http.StatusInternalServerError)
			return
		}
		stub.mu.Lock()
		stub.captures = append(stub.captures, capture)
		call := len(stub.captures)
		stub.mu.Unlock()
		summary, answerContextTokens := respond(call)
		usage := fmt.Sprintf(`{"answerContextTokens":%d,"answerInputTokens":21,"answerOutputTokens":7}`, answerContextTokens)
		response.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(response, "event: usage.updated\ndata: {\"usage\":%s}\n\n", usage)
		terminal, err := json.Marshal(map[string]any{
			"status": "succeeded", "usage": json.RawMessage(usage),
			"timings": map[string]any{"answerMs": 3}, "error": nil,
			"temporarySummary": summary.payload(),
		})
		if err != nil {
			t.Errorf("encode terminal event: %v", err)
			return
		}
		fmt.Fprintf(response, "event: run.completed\ndata: %s\n\n", terminal)
	}))
	t.Cleanup(stub.Server.Close)
	return stub
}

var temporaryChatTables = []string{
	"assistant_conversations", "assistant_messages", "assistant_runs",
	"assistant_run_events", "assistant_run_sources", "assistant_conversation_summaries",
}

func countTemporaryChatTables(t *testing.T, h *v3Harness) map[string]int64 {
	t.Helper()
	counts := make(map[string]int64, len(temporaryChatTables))
	for _, table := range temporaryChatTables {
		var count int64
		if err := h.database.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		counts[table] = count
	}
	return counts
}

func readTemporarySSEBlocks(t *testing.T, reader *bufio.Reader) []v3SSEBlock {
	t.Helper()
	var blocks []v3SSEBlock
	var lines []string
	flush := func() {
		if len(lines) == 0 {
			return
		}
		block := v3SSEBlock{Raw: strings.Join(lines, "\n")}
		for _, line := range lines {
			switch {
			case strings.HasPrefix(line, "id: "):
				block.ID = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "event: "):
				block.Event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				block.Data = strings.TrimPrefix(line, "data: ")
			}
		}
		blocks = append(blocks, block)
		lines = nil
	}
	for {
		line, err := reader.ReadString('\n')
		if line == "" && err != nil {
			flush()
			return blocks
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			flush()
			continue
		}
		lines = append(lines, line)
	}
}

func readTemporaryPublicStream(t *testing.T, response *http.Response) []v3SSEBlock {
	t.Helper()
	defer response.Body.Close()
	assertStatus(t, response, http.StatusOK)
	if contentType := response.Header.Get("Content-Type"); contentType != "text/event-stream; charset=utf-8" {
		t.Fatalf("temporary public stream content type = %q", contentType)
	}
	if buffering := response.Header.Get("X-Accel-Buffering"); buffering != "no" {
		t.Fatalf("temporary public stream buffering header = %q", buffering)
	}
	return readTemporarySSEBlocks(t, bufio.NewReader(response.Body))
}

func assertTemporaryEventSequence(t *testing.T, blocks []v3SSEBlock) {
	t.Helper()
	expected := []string{"run.status", "sources.ready", "run.status", "usage.updated", "run.completed"}
	names := make([]string, 0, len(blocks))
	for _, block := range blocks {
		names = append(names, block.Event)
	}
	if !reflect.DeepEqual(names, expected) {
		t.Fatalf("temporary public events = %v, want %v", names, expected)
	}
	for index := range blocks {
		if blocks[index].ID != fmt.Sprintf("%d", index+1) {
			t.Fatalf("public event %d has id %q, want %d", index+1, blocks[index].ID, index+1)
		}
	}
}

type temporaryTerminalDTO struct {
	Status           string               `json:"status"`
	Error            any                  `json:"error"`
	TemporarySummary *temporarySummaryDTO `json:"temporarySummary"`
	Usage            struct {
		AnswerContextTokens *int64 `json:"answerContextTokens"`
	} `json:"usage"`
}

func TestV3TemporaryQuestionAloneOverBudgetFailsBeforeSSE(t *testing.T) {
	var workerRequests atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		workerRequests.Add(1)
		response.WriteHeader(http.StatusNoContent)
	}))
	defer worker.Close()
	h := newV3Harness(t, worker.URL)
	small := h.post(t, "/api/v1/ai/providers", map[string]any{
		"providerKey": "v3-small-provider", "displayName": "Small Window Provider",
		"protocol": "openai-completions", "baseUrl": "https://provider.example/v1",
		"apiKey": "v3-small-provider-secret", "models": []map[string]any{{
			"modelId": "small-window-chat", "displayName": "Small Window Chat",
			"contextWindow": 8192, "maxOutputTokens": 1024,
			"supportsTools": false, "supportsVision": false,
			"reasoningOptions": []map[string]any{},
		}},
	})
	assertStatus(t, small, http.StatusCreated)
	var created struct {
		Models []struct {
			ID uuid.UUID `json:"id"`
		} `json:"models"`
	}
	if err := json.NewDecoder(small.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	small.Body.Close()
	if len(created.Models) != 1 {
		t.Fatal("small-window model was not created")
	}
	before := countTemporaryChatTables(t, h)
	// The provider API accepts any positive window with maxOutputTokens below
	// it. inputContextBudgetTokens(8192, 1024) = 8192-1024-1200-1024 = 4944
	// tokens, so 15,600 CJK bytes (5,200 estimated tokens) overflow the model
	// input budget while staying under the 32 KiB message contract cap.
	question := strings.Repeat("问", 5200)
	if len(question) != 15600 {
		t.Fatalf("question byte length = %d, want 15600", len(question))
	}
	response := h.post(t, "/api/v1/assistant/temporary/stream", map[string]any{
		"clientRequestId": uuid.New(), "modelId": created.Models[0].ID,
		"reasoning": "off", "content": question, "messages": []any{}, "summary": nil,
	})
	if status, code := v3Error(t, response); status != http.StatusUnprocessableEntity || code != "ASSISTANT_CONTEXT_TOO_LARGE" {
		t.Fatalf("oversized question got %d %s, want 422 ASSISTANT_CONTEXT_TOO_LARGE", status, code)
	}
	if contentType := response.Header.Get("Content-Type"); !strings.Contains(contentType, "application/json") || strings.Contains(contentType, "text/event-stream") {
		t.Fatalf("budget rejection must stay a JSON error before SSE headers, got %q", contentType)
	}
	if workerRequests.Load() != 0 {
		t.Fatalf("worker received %d requests after the pre-stream rejection", workerRequests.Load())
	}
	if got := countTemporaryChatTables(t, h); !reflect.DeepEqual(got, before) {
		t.Fatalf("rejected temporary request wrote chat tables: %v -> %v", before, got)
	}
}

func TestV3TemporaryRollingSummaryAndChatTableIsolation(t *testing.T) {
	firstSummary := temporarySummaryDTO{ConfirmedFacts: []string{"第一代滚动摘要事实"},
		Corrections: []string{}, RejectedHypotheses: []string{}, UnresolvedQuestions: []string{}}
	secondSummary := temporarySummaryDTO{ConfirmedFacts: []string{"第二代滚动摘要事实"},
		Corrections: []string{}, RejectedHypotheses: []string{}, UnresolvedQuestions: []string{}}
	worker := newTemporaryWorkerStub(t, func(call int) (temporarySummaryDTO, int64) {
		if call == 1 {
			return firstSummary, 200
		}
		return secondSummary, 300
	})
	h := newV3Harness(t, worker.URL)
	_, modelID := h.createProviderModel(t, []map[string]any{})
	history := make([]temporaryHistoryDTO, 0, 18)
	for round := 1; round <= 9; round++ {
		history = append(history,
			temporaryHistoryDTO{Role: "user", Content: fmt.Sprintf("第%d轮临时提问内容", round)},
			temporaryHistoryDTO{Role: "assistant", Content: fmt.Sprintf("第%d轮临时回答内容", round)},
		)
	}
	priorSummary := temporarySummaryDTO{ConfirmedFacts: []string{"旧摘要确认事实"},
		Corrections: []string{}, RejectedHypotheses: []string{}, UnresolvedQuestions: []string{}}
	question := "本轮新的临时提问"
	before := countTemporaryChatTables(t, h)

	response := h.post(t, "/api/v1/assistant/temporary/stream", map[string]any{
		"clientRequestId": uuid.New(), "modelId": modelID, "reasoning": "off",
		"content": question, "messages": history, "summary": priorSummary,
	})
	blocks := readTemporaryPublicStream(t, response)
	assertTemporaryEventSequence(t, blocks)
	if !strings.Contains(blocks[0].Data, `"contextWindow":32768`) || !strings.Contains(blocks[0].Data, modelID.String()) {
		t.Fatalf("first run.status lost the locked model snapshot: %s", blocks[0].Data)
	}
	if !strings.Contains(blocks[1].Data, `"providedSourceCount":0`) || !strings.Contains(blocks[1].Data, `"knowledgeState":"unavailable"`) {
		t.Fatalf("sources.ready wrong for a knowledge-unavailable run: %s", blocks[1].Data)
	}
	if !strings.Contains(blocks[3].Data, `"answerContextTokens":200`) {
		t.Fatalf("usage.updated lost the worker measurement: %s", blocks[3].Data)
	}
	var terminal temporaryTerminalDTO
	if err := json.Unmarshal([]byte(blocks[4].Data), &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Status != "succeeded" || terminal.Error != nil {
		t.Fatalf("terminal is not a clean success: %s", blocks[4].Data)
	}
	if !reflect.DeepEqual(terminal.TemporarySummary, &firstSummary) {
		t.Fatalf("terminal temporarySummary = %+v, want the worker-maintained first summary", terminal.TemporarySummary)
	}
	if terminal.Usage.AnswerContextTokens == nil || *terminal.Usage.AnswerContextTokens != 200 {
		t.Fatalf("terminal usage lost the context measurement: %s", blocks[4].Data)
	}
	var publicData strings.Builder
	for _, block := range blocks {
		publicData.WriteString(block.Data)
		publicData.WriteString("\n")
	}
	if strings.Contains(publicData.String(), "v3-provider-secret") || strings.Contains(publicData.String(), "baseUrl") {
		t.Fatal("temporary public stream leaked provider credentials or address")
	}
	if got := countTemporaryChatTables(t, h); !reflect.DeepEqual(got, before) {
		t.Fatalf("first temporary request wrote chat tables: %v -> %v", before, got)
	}

	captures := worker.captured()
	if len(captures) != 1 {
		t.Fatalf("worker captured %d internal streams, want 1", len(captures))
	}
	first := captures[0]
	if first.Model.ID != modelID || first.Model.ContextWindow != 32768 || first.Model.Protocol != "openai-completions" {
		t.Fatalf("internal stream carried the wrong locked model snapshot: %+v", first.Model)
	}
	if first.Reasoning != "off" || first.Question != question || first.EvidenceState != "unavailable" || len(first.Sources) != 0 {
		t.Fatalf("internal stream context wrong: %+v", first)
	}
	if !reflect.DeepEqual(first.Messages, history) {
		t.Fatalf("answer context must keep all 18 messages on a 32k window with zero sources: %+v", first.Messages)
	}
	if !reflect.DeepEqual(first.Summary, &priorSummary) {
		t.Fatalf("answer summary changed in transit: %+v", first.Summary)
	}
	if first.SummarySource == nil {
		t.Fatal("18 history messages must trigger rolling-summary maintenance")
	}
	if !reflect.DeepEqual(first.SummarySource.Prior, &priorSummary) {
		t.Fatalf("summarySource.prior = %+v, want the request summary", first.SummarySource.Prior)
	}
	if !reflect.DeepEqual(first.SummarySource.Messages, history[:2]) {
		t.Fatalf("summarySource must carry the oldest uncovered pair: %+v", first.SummarySource.Messages)
	}

	// The second request mirrors the browser: the maintained summary now
	// covers the oldest pair, so the client keeps the remaining 16 messages,
	// appends the completed pair, and sends the new summary.
	messages := make([]temporaryHistoryDTO, 0, 18)
	messages = append(messages, history[2:]...)
	messages = append(messages,
		temporaryHistoryDTO{Role: "user", Content: question},
		temporaryHistoryDTO{Role: "assistant", Content: "本轮新的临时回答"},
	)
	second := h.post(t, "/api/v1/assistant/temporary/stream", map[string]any{
		"clientRequestId": uuid.New(), "modelId": modelID, "reasoning": "off",
		"content": "第二轮新的临时提问", "messages": messages, "summary": firstSummary,
	})
	blocks = readTemporaryPublicStream(t, second)
	assertTemporaryEventSequence(t, blocks)
	if err := json.Unmarshal([]byte(blocks[4].Data), &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Status != "succeeded" || !reflect.DeepEqual(terminal.TemporarySummary, &secondSummary) {
		t.Fatalf("second terminal wrong: %s", blocks[4].Data)
	}
	if !strings.Contains(blocks[3].Data, `"answerContextTokens":300`) {
		t.Fatalf("second usage measurement lost: %s", blocks[3].Data)
	}
	captures = worker.captured()
	if len(captures) != 2 {
		t.Fatalf("worker captured %d internal streams, want 2", len(captures))
	}
	secondCapture := captures[1]
	if !reflect.DeepEqual(secondCapture.Messages, messages) {
		t.Fatalf("second answer context wrong: %+v", secondCapture.Messages)
	}
	if !reflect.DeepEqual(secondCapture.Summary, &firstSummary) {
		t.Fatalf("second answer summary wrong: %+v", secondCapture.Summary)
	}
	if secondCapture.SummarySource == nil {
		t.Fatal("second request must keep maintaining the rolling summary")
	}
	if !reflect.DeepEqual(secondCapture.SummarySource.Prior, &firstSummary) {
		t.Fatalf("second summarySource.prior = %+v, want the first maintained summary", secondCapture.SummarySource.Prior)
	}
	// Cumulative coverage baseline: the second uncovered prefix is exactly
	// the next pair — neither the already-covered oldest pair nor a skip.
	if !reflect.DeepEqual(secondCapture.SummarySource.Messages, history[2:4]) {
		t.Fatalf("second uncovered prefix wrong (double coverage or skip): %+v", secondCapture.SummarySource.Messages)
	}
	if got := countTemporaryChatTables(t, h); !reflect.DeepEqual(got, before) {
		t.Fatalf("temporary requests wrote chat tables: %v -> %v", before, got)
	}
}

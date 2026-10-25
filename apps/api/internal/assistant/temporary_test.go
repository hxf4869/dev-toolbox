package assistant

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func temporaryStreamRequestBody(t *testing.T, mutate func(input map[string]any)) string {
	t.Helper()
	input := map[string]any{
		"clientRequestId": uuid.New().String(),
		"modelId":         uuid.New().String(),
		"reasoning":       "off",
		"summary":         nil,
		"messages":        []any{},
		"content":         "当前问题",
	}
	mutate(input)
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	return string(encoded)
}

func postTemporaryStream(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/assistant/temporary/stream", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	// Validation-only requests never reach the database, so a bare service is
	// enough to exercise the contract boundary.
	(&Service{}).temporaryStream(recorder, request)
	return recorder
}

func temporaryResponseCode(t *testing.T, recorder *httptest.ResponseRecorder) (int, string) {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error envelope %q: %v", recorder.Body.String(), err)
	}
	return recorder.Code, envelope.Error.Code
}

// Size-class contract violations must report ASSISTANT_CONTEXT_TOO_LARGE while
// shape violations stay VALIDATION_FAILED (docs/16 §13.9).
func TestTemporaryStreamSizeLimitsUseStableContextCode(t *testing.T) {
	cases := []struct {
		name string
		body func(t *testing.T) string
		code string
	}{
		{
			name: "history message count over 32",
			body: func(t *testing.T) string {
				return temporaryStreamRequestBody(t, func(input map[string]any) {
					messages := make([]any, 0, 34)
					for index := 0; index < 17; index++ {
						messages = append(messages,
							map[string]any{"role": "user", "content": fmt.Sprintf("问题 %d", index)},
							map[string]any{"role": "assistant", "content": fmt.Sprintf("回答 %d", index)})
					}
					input["messages"] = messages
				})
			},
			code: "ASSISTANT_CONTEXT_TOO_LARGE",
		},
		{
			name: "current content over 32 KiB",
			body: func(t *testing.T) string {
				return temporaryStreamRequestBody(t, func(input map[string]any) {
					input["content"] = strings.Repeat("问", MaximumUserMessageBytes/3+1)
				})
			},
			code: "ASSISTANT_CONTEXT_TOO_LARGE",
		},
		{
			name: "history total over 256 KiB",
			body: func(t *testing.T) string {
				return temporaryStreamRequestBody(t, func(input map[string]any) {
					entry := strings.Repeat("a", 8300)
					messages := make([]any, 0, 32)
					for index := 0; index < 16; index++ {
						messages = append(messages,
							map[string]any{"role": "user", "content": entry},
							map[string]any{"role": "assistant", "content": entry})
					}
					input["messages"] = messages
				})
			},
			code: "ASSISTANT_CONTEXT_TOO_LARGE",
		},
		{
			name: "summary over 64 KiB with legal entry count",
			body: func(t *testing.T) string {
				return temporaryStreamRequestBody(t, func(input map[string]any) {
					entry := strings.Repeat("事", 1400)
					facts := make([]any, 0, 16)
					for index := 0; index < 16; index++ {
						facts = append(facts, fmt.Sprintf("%s %d", entry, index))
					}
					input["summary"] = map[string]any{
						"confirmedFacts": facts, "corrections": []any{},
						"rejectedHypotheses": []any{}, "unresolvedQuestions": []any{},
					}
				})
			},
			code: "ASSISTANT_CONTEXT_TOO_LARGE",
		},
		{
			name: "summary over 64 entries with legal non-empty strings",
			body: func(t *testing.T) string {
				return temporaryStreamRequestBody(t, func(input map[string]any) {
					facts := make([]any, 0, 65)
					for index := 0; index < 65; index++ {
						facts = append(facts, fmt.Sprintf("事实 %d", index))
					}
					input["summary"] = map[string]any{
						"confirmedFacts": facts, "corrections": []any{},
						"rejectedHypotheses": []any{}, "unresolvedQuestions": []any{},
					}
				})
			},
			code: "ASSISTANT_CONTEXT_TOO_LARGE",
		},
		{
			name: "odd history message count",
			body: func(t *testing.T) string {
				return temporaryStreamRequestBody(t, func(input map[string]any) {
					input["messages"] = []any{map[string]any{"role": "user", "content": "孤立用户消息"}}
				})
			},
			code: "VALIDATION_FAILED",
		},
		{
			name: "role alternation broken",
			body: func(t *testing.T) string {
				return temporaryStreamRequestBody(t, func(input map[string]any) {
					input["messages"] = []any{
						map[string]any{"role": "user", "content": "问题"},
						map[string]any{"role": "user", "content": "还是问题"},
					}
				})
			},
			code: "VALIDATION_FAILED",
		},
		{
			name: "blank current content",
			body: func(t *testing.T) string {
				return temporaryStreamRequestBody(t, func(input map[string]any) {
					input["content"] = "   "
				})
			},
			code: "VALIDATION_FAILED",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := postTemporaryStream(t, testCase.body(t))
			if recorder.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
			}
			_, code := temporaryResponseCode(t, recorder)
			if code != testCase.code {
				t.Fatalf("error code = %q, want %q", code, testCase.code)
			}
		})
	}
}

// A contract-valid envelope whose JSON-escaped form exceeds the sum of the raw
// limits must still decode and then be judged by the explicit size checks.
func TestTemporaryStreamDecodesContractReachableEnvelope(t *testing.T) {
	body := temporaryStreamRequestBody(t, func(input map[string]any) {
		entry := strings.Repeat("a", 8192)
		messages := make([]any, 0, 32)
		for index := 0; index < 16; index++ {
			messages = append(messages,
				map[string]any{"role": "user", "content": entry},
				map[string]any{"role": "assistant", "content": entry})
		}
		input["messages"] = messages
		summaryEntry := strings.Repeat("事", 1400)
		facts := make([]any, 0, 16)
		for index := 0; index < 16; index++ {
			facts = append(facts, fmt.Sprintf("%s %d", summaryEntry, index))
		}
		input["summary"] = map[string]any{
			"confirmedFacts": facts, "corrections": []any{},
			"rejectedHypotheses": []any{}, "unresolvedQuestions": []any{},
		}
	})
	if encoded := len(body); encoded <= MaximumTemporaryHistoryBytes+MaximumUserMessageBytes+16*1024 {
		t.Fatalf("test envelope %d bytes did not exceed the legacy decode limit", encoded)
	}
	recorder := postTemporaryStream(t, body)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	_, code := temporaryResponseCode(t, recorder)
	if code != "ASSISTANT_CONTEXT_TOO_LARGE" {
		t.Fatalf("error code = %q, want the decoded summary byte check to fire", code)
	}
}

func temporaryConversation(messageCount int) []temporaryHistoryMessage {
	messages := make([]temporaryHistoryMessage, 0, messageCount)
	for index := 0; index < messageCount/2; index++ {
		messages = append(messages,
			temporaryHistoryMessage{Role: "user", Content: fmt.Sprintf("用户问题 %d", index)},
			temporaryHistoryMessage{Role: "assistant", Content: fmt.Sprintf("助手回答 %d", index)})
	}
	return messages
}

// A 16k model with no retrieved sources must keep the recent turns: the
// history budget is bounded by the real sources, not by a reservation for
// eight maximum sources that do not exist.
func TestTrimTemporaryAnswerContextSmallModelKeepsHistoryWithoutSources(t *testing.T) {
	summary := &temporarySummary{ConfirmedFacts: []string{"部署使用 Docker Compose"}}
	answer := trimTemporaryAnswerContext(16384, 4096, "当前问题", summary, temporaryConversation(18), nil)
	if len(answer.sources) != 0 {
		t.Fatalf("sources = %d, want 0", len(answer.sources))
	}
	if len(answer.messages) != 18 {
		t.Fatalf("kept history = %d messages, want all 18", len(answer.messages))
	}
	if answer.summary != summary {
		t.Fatal("summary that fits the budget was dropped from the answer context")
	}
}

// Sources outrank history, and history keeps only complete pairs: when large
// retrieved sources fill the window only the highest-ranked source survives
// and the newest complete user+assistant pair fits the remainder. Budget
// arithmetic: 16384-4096-1200-1024 = 10064 tokens; question ≈ 4; source 6600
// chars × 3 bytes → 6608 tokens; each history message 1500 chars × 3 bytes →
// 1504 tokens, one pair 3008.
func TestTrimTemporaryAnswerContextDropsHistoryBeforeSources(t *testing.T) {
	summary := &temporarySummary{ConfirmedFacts: []string{"旧事实"}}
	messages := make([]temporaryHistoryMessage, 0, 18)
	for index := 0; index < 9; index++ {
		messages = append(messages,
			temporaryHistoryMessage{Role: "user", Content: strings.Repeat("问", 1500) + fmt.Sprintf(" %d", index)},
			temporaryHistoryMessage{Role: "assistant", Content: strings.Repeat("答", 1500) + fmt.Sprintf(" %d", index)})
	}
	snapshots := []retrievalCandidate{
		{Title: "S1", Content: strings.Repeat("段", 6600)},
		{Title: "S2", Content: strings.Repeat("段", 6600)},
		{Title: "S3", Content: strings.Repeat("段", 6600)},
	}
	answer := trimTemporaryAnswerContext(16384, 4096, "当前问题", summary, messages, snapshots)
	if len(answer.sources) != 1 || answer.sources[0].Title != "S1" {
		t.Fatalf("kept sources = %+v, want only the highest-ranked source", answer.sources)
	}
	if len(answer.messages) != 2 || answer.messages[0].Role != "user" || answer.messages[1].Role != "assistant" ||
		answer.messages[0].Content != messages[16].Content || answer.messages[1].Content != messages[17].Content {
		t.Fatalf("kept history = %+v, want exactly the newest complete pair", answer.messages)
	}
	if answer.summary == nil {
		t.Fatal("summary that fits the remainder was dropped")
	}
}

// The rewrite request carries no source block, so its budget reflects the
// rewrite payload and keeps recent turns even when answering with the same
// model would starve history under eight large sources.
func TestTrimTemporaryRewriteContextReflectsRewritePayload(t *testing.T) {
	summary := &temporarySummary{ConfirmedFacts: []string{"旧事实"}}
	rewrite := trimTemporaryRewriteContext(16384, 4096, "当前问题", summary, temporaryConversation(18))
	if len(rewrite.messages) != 18 {
		t.Fatalf("rewrite kept %d messages, want all 18", len(rewrite.messages))
	}
	if rewrite.summary != summary {
		t.Fatal("summary that fits the rewrite budget was dropped")
	}
	tiny := trimTemporaryRewriteContext(1024, 2048, "当前问题", nil, temporaryConversation(4))
	if len(tiny.messages) != 0 {
		t.Fatalf("tiny model rewrite kept %d messages, want none", len(tiny.messages))
	}
}

// The summary byte caliber counts raw entry bytes, not JSON-encoded length:
// '<x>' entries would balloon under Go's HTML-escaping json.Marshal and flip
// the verdict against the worker's own check (docs/16 §13.9 64 KiB total).
func TestTemporarySummaryBytesCaliber(t *testing.T) {
	within := &temporarySummary{ConfirmedFacts: []string{strings.Repeat("<x>", 21000)}}
	if bytes := temporarySummaryBytes(within); bytes != 63000 || bytes > MaximumSummaryBytes {
		t.Fatalf("63 KiB of '<x>' entries measured %d bytes, must fit the 64 KiB contract", bytes)
	}
	over := &temporarySummary{ConfirmedFacts: []string{strings.Repeat("<x>", 22000)}}
	if bytes := temporarySummaryBytes(over); bytes <= MaximumSummaryBytes {
		t.Fatalf("66 KiB of '<x>' entries measured %d bytes, must exceed the contract", bytes)
	}
	if entries := temporarySummaryEntries(within); entries != 1 {
		t.Fatalf("entries = %d, want 1", entries)
	}
}

func TestTemporarySummarySourceFor(t *testing.T) {
	summary := &temporarySummary{Corrections: []string{"端口应为 8080"}}
	if source := temporarySummarySourceFor(summary, temporaryConversation(16)); source != nil {
		t.Fatal("16 messages must not trigger summary maintenance")
	}
	source := temporarySummarySourceFor(summary, temporaryConversation(18))
	if source == nil || source.Prior != summary || len(source.Messages) != 2 {
		t.Fatalf("18 messages must expose the 2-message uncovered prefix, got %+v", source)
	}
	if source.Messages[0].Role != "user" || source.Messages[1].Role != "assistant" {
		t.Fatalf("prefix must stay oldest-first complete pairs, got %+v", source.Messages)
	}
	seventeen := append(temporaryConversation(16), temporaryHistoryMessage{Role: "user", Content: "额外问题"})
	if source := temporarySummarySourceFor(nil, seventeen); source == nil || source.Prior != nil || len(source.Messages) != 1 {
		t.Fatalf("17 messages with no prior summary = %+v", source)
	}
}

// Cross-layer contract: the internal stream request carries the trimmed
// answer context plus the untrimmed summarySource, and the worker terminal's
// temporarySummary passes through to the public SSE with merged usage.
func TestTemporaryStreamCrossLayerSummarySourceContract(t *testing.T) {
	var internalBody map[string]any
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read internal body: %v", err)
		}
		if err := json.Unmarshal(body, &internalBody); err != nil {
			t.Errorf("decode internal body: %v", err)
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		fmt.Fprint(w, "event: run.status\ndata: {\"status\":\"running\",\"phase\":\"answer\"}\n\n")
		fmt.Fprint(w, "event: answer.delta\ndata: {\"delta\":\"回答\"}\n\n")
		fmt.Fprint(w, "event: answer.citation\ndata: {\"sourceOrdinal\":2}\n\n")
		fmt.Fprint(w, "event: run.completed\ndata: "+`{"status":"succeeded","usage":{"answerInputTokens":10,"answerOutputTokens":5},"timings":{"answerMs":100},"error":null,"temporarySummary":{"confirmedFacts":["新事实"],"corrections":[],"rejectedHypotheses":[],"unresolvedQuestions":[]}}`+"\n\n")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
	}))
	defer worker.Close()

	recorder := httptest.NewRecorder()
	stream, err := newSSEWriter(recorder)
	if err != nil {
		t.Fatal(err)
	}
	recorder.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	recorder.WriteHeader(http.StatusOK)
	service := &Service{workerURL: worker.URL, internalServiceToken: "test", httpClient: &http.Client{}, now: time.Now}
	execution := lockedExecution{
		modelID: uuid.New(), providerID: uuid.New(), providerDisplayName: "Provider",
		upstreamModelID: "model", contextWindow: 8192, maxOutputTokens: 1024,
	}
	summary := &temporarySummary{ConfirmedFacts: []string{"旧事实"}}
	rawHistory := temporaryConversation(18)
	answer := &temporaryAnswerContext{
		summary:  summary,
		messages: rawHistory[2:],
		sources: []retrievalCandidate{
			{Title: "S1", Content: "片段一"}, {Title: "S2", Content: "片段二"},
		},
	}
	summarySource := temporarySummarySourceFor(summary, rawHistory)
	rewriteTokens := int64(7)
	trace := temporaryRuntimeTrace{
		RewriteInputTokens: &rewriteTokens, RewriteOutputTokens: &rewriteTokens, StartedAt: time.Now().UTC(),
	}
	sequence := 0
	service.streamTemporaryAnswer(context.Background(), stream, &sequence, execution, "key", "allow",
		temporaryStreamInput{Reasoning: "off", Content: "当前问题"}, answer, summarySource, "matched", trace)

	if internalBody == nil {
		t.Fatal("internal stream request was never received")
	}
	if messages, ok := internalBody["messages"].([]any); !ok || len(messages) != 16 {
		t.Fatalf("internal messages = %+v, want the 16 trimmed answer messages", internalBody["messages"])
	}
	if summaryPayload, ok := internalBody["summary"].(map[string]any); !ok || summaryPayload["confirmedFacts"] == nil {
		t.Fatalf("internal summary = %+v, want the answer-context summary", internalBody["summary"])
	}
	source, ok := internalBody["summarySource"].(map[string]any)
	if !ok {
		t.Fatal("internal summarySource missing")
	}
	if prior, ok := source["prior"].(map[string]any); !ok || prior["confirmedFacts"] == nil {
		t.Fatalf("summarySource.prior = %+v, want the full request summary", source["prior"])
	}
	if prefix, ok := source["messages"].([]any); !ok || len(prefix) != 2 {
		t.Fatalf("summarySource.messages = %+v, want the untrimmed 2-message prefix", source["messages"])
	}
	if sources, ok := internalBody["sources"].([]any); !ok || len(sources) != 2 {
		t.Fatalf("internal sources = %+v, want the trimmed renumbered set", internalBody["sources"])
	}

	reader := bufio.NewReader(recorder.Body)
	seenTerminal := false
	for {
		eventType, data, readErr := readSSEEvent(reader)
		if readErr != nil {
			break
		}
		var payload map[string]any
		if json.Unmarshal([]byte(data), &payload) != nil {
			t.Fatalf("event %s payload %q is not JSON", eventType, data)
		}
		switch eventType {
		case "answer.citation":
			if payload["citationNumber"] != float64(1) || payload["token"] != "[[C1]]" {
				t.Fatalf("citation payload = %+v, want renumbered first citation", payload)
			}
		case "run.completed":
			seenTerminal = true
			terminalSummary, ok := payload["temporarySummary"].(map[string]any)
			if !ok {
				t.Fatalf("terminal temporarySummary = %+v, want worker summary passthrough", payload["temporarySummary"])
			}
			facts, isList := terminalSummary["confirmedFacts"].([]any)
			if !isList || len(facts) != 1 || facts[0] != "新事实" {
				t.Fatalf("terminal temporarySummary.confirmedFacts = %+v", terminalSummary["confirmedFacts"])
			}
			usage, ok := payload["usage"].(map[string]any)
			if !ok || usage["rewriteInputTokens"] != float64(7) || usage["answerInputTokens"] != float64(10) {
				t.Fatalf("terminal usage = %+v, want merged rewrite and answer usage", payload["usage"])
			}
		}
	}
	if !seenTerminal {
		t.Fatal("public stream never received the terminal event")
	}
}

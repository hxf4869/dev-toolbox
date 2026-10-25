//go:build integration

package integration_test

// Real-database boundary coverage for the persistent chat claim budget
// (docs/16 §10.2) on an 8K-window model when the knowledge base is
// unavailable: the second question in a conversation must still receive the
// previous successful question/answer pair and the stored conversation
// summary. The harness leaves assistant_embedding_config empty, so runs are
// created with knowledgeState=unavailable and no retrieval sources can ever
// attach to them; the claim must not reserve the frozen maximum source
// headroom (MaximumRunSources*8192/3 = 21845 tokens) from a 4944-token input
// budget, which would drop the whole multi-turn history and summary. The test
// itself plays the worker against the internal lease API — no real Provider is
// called.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type persistentClaimBody struct {
	Run struct {
		ID             string `json:"id"`
		ConversationID string `json:"conversationId"`
		LeaseVersion   int    `json:"leaseVersion"`
	} `json:"run"`
	Knowledge struct {
		State      string `json:"state"`
		Generation *int64 `json:"generation"`
	} `json:"knowledge"`
	Context struct {
		Summary *struct {
			ConfirmedFacts []string `json:"confirmedFacts"`
		} `json:"summary"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
		Question string `json:"question"`
	} `json:"context"`
}

func claimPersistentRun(t *testing.T, h *v3Harness, workerID string) persistentClaimBody {
	t.Helper()
	claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": workerID})
	assertStatus(t, claim, http.StatusOK)
	var body persistentClaimBody
	if err := json.NewDecoder(claim.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	claim.Body.Close()
	return body
}

func TestV3PersistentUnavailableKnowledgeKeepsHistoryBudget(t *testing.T) {
	h := newV3Harness(t)
	workerID := "worker-v3-persistent-budget"
	// inputContextBudgetTokens(8192, 1024) = 8192-1024-1200-1024 = 4944
	// tokens — far below the frozen 21845-token source headroom.
	created := h.post(t, "/api/v1/ai/providers", map[string]any{
		"providerKey": "v3-small-provider", "displayName": "Small Window Provider",
		"protocol": "openai-completions", "baseUrl": "https://provider.example/v1",
		"apiKey": "v3-small-provider-secret", "models": []map[string]any{{
			"modelId": "small-window-chat", "displayName": "Small Window Chat",
			"contextWindow": 8192, "maxOutputTokens": 1024,
			"supportsTools": false, "supportsVision": false,
			"reasoningOptions": []map[string]any{},
		}},
	})
	assertStatus(t, created, http.StatusCreated)
	var createdBody struct {
		Models []struct {
			ID uuid.UUID `json:"id"`
		} `json:"models"`
	}
	if err := json.NewDecoder(created.Body).Decode(&createdBody); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	if len(createdBody.Models) != 1 {
		t.Fatal("small-window model was not created")
	}
	modelID := createdBody.Models[0].ID

	firstQuestion := "第一轮提问：构建管线包含哪些核心阶段"
	firstAnswer := "第一轮回答：构建管线包含编译、测试与打包三个核心阶段"
	secondQuestion := "第二轮提问：构建管线失败时如何回滚"
	summaryFact := "第一轮摘要事实：构建管线包含三个核心阶段"

	firstStart := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil,
		"content": firstQuestion, "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, firstStart, http.StatusAccepted)
	var firstStartBody struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(firstStart.Body).Decode(&firstStartBody); err != nil {
		t.Fatal(err)
	}
	firstStart.Body.Close()

	firstClaim := claimPersistentRun(t, h, workerID)
	if firstClaim.Run.ID != firstStartBody.Run.ID {
		t.Fatalf("first claim returned run %s, want %s", firstClaim.Run.ID, firstStartBody.Run.ID)
	}
	if firstClaim.Knowledge.State != "unavailable" {
		t.Fatalf("empty embedding config must produce knowledge.state=unavailable, got %q", firstClaim.Knowledge.State)
	}
	if firstClaim.Context.Question != firstQuestion {
		t.Fatalf("first claim question = %q, want the submitted first question", firstClaim.Context.Question)
	}

	events := h.internalPost(t, "/internal/assistant/runs/"+firstStartBody.Run.ID+"/events", map[string]any{
		"workerId": workerID, "leaseVersion": firstClaim.Run.LeaseVersion,
		"events": []map[string]any{
			{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": firstAnswer}},
		},
	})
	assertStatus(t, events, http.StatusOK)
	events.Body.Close()
	complete := h.internalPost(t, "/internal/assistant/runs/"+firstStartBody.Run.ID+"/complete", map[string]any{
		"workerId": workerID, "leaseVersion": firstClaim.Run.LeaseVersion,
		"usage":   map[string]any{"answerInputTokens": 11, "answerOutputTokens": 5},
		"timings": map[string]any{"answerMs": 3},
	})
	assertStatus(t, complete, http.StatusOK)
	complete.Body.Close()

	// A short stored summary covering the finished pair; it must stay well
	// inside the 4944-token input budget once no source headroom is reserved.
	var throughSequence int64
	if err := h.database.QueryRow(context.Background(),
		`SELECT coalesce(max(sequence), 0) FROM assistant_messages WHERE conversation_id = $1`,
		firstStartBody.Conversation.ID).Scan(&throughSequence); err != nil {
		t.Fatal(err)
	}
	if throughSequence < 1 {
		t.Fatalf("no conversation messages to summarize (sequence=%d)", throughSequence)
	}
	summaryWrite := h.internalPost(t, "/internal/assistant/runs/"+firstStartBody.Run.ID+"/summary", map[string]any{
		"summary": map[string]any{
			"confirmedFacts":      []string{summaryFact},
			"corrections":         []string{},
			"rejectedHypotheses":  []string{},
			"unresolvedQuestions": []string{},
		},
		"throughMessageSequence":         throughSequence,
		"baselineThroughMessageSequence": 0,
		"modelSnapshot":                  map[string]any{"displayName": "Small Window Chat"},
	})
	assertStatus(t, summaryWrite, http.StatusOK)
	var applied struct {
		Applied bool `json:"applied"`
	}
	if err := json.NewDecoder(summaryWrite.Body).Decode(&applied); err != nil {
		t.Fatal(err)
	}
	summaryWrite.Body.Close()
	if !applied.Applied {
		t.Fatal("conversation summary write was not applied after a succeeded run")
	}

	secondStart := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": firstStartBody.Conversation.ID,
		"content": secondQuestion, "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, secondStart, http.StatusAccepted)
	var secondStartBody struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(secondStart.Body).Decode(&secondStartBody); err != nil {
		t.Fatal(err)
	}
	secondStart.Body.Close()
	if secondStartBody.Run.ID == firstStartBody.Run.ID {
		t.Fatal("second question reused the first run")
	}

	secondClaim := claimPersistentRun(t, h, workerID)
	if secondClaim.Run.ID != secondStartBody.Run.ID {
		t.Fatalf("second claim returned run %s, want %s", secondClaim.Run.ID, secondStartBody.Run.ID)
	}
	if secondClaim.Knowledge.State != "unavailable" {
		t.Fatalf("second claim knowledge.state = %q, want unavailable", secondClaim.Knowledge.State)
	}
	if secondClaim.Context.Question != secondQuestion {
		t.Fatalf("second claim question = %q, want the submitted second question", secondClaim.Context.Question)
	}
	if len(secondClaim.Context.Messages) == 0 {
		t.Fatalf("knowledge-unavailable 8K claim dropped the whole successful history: summary=%v messages=%v",
			secondClaim.Context.Summary, secondClaim.Context.Messages)
	}
	var sawFirstQuestion, sawFirstAnswer bool
	for _, message := range secondClaim.Context.Messages {
		if message.Role == "user" && strings.Contains(message.Content, firstQuestion) {
			sawFirstQuestion = true
		}
		if message.Role == "assistant" && strings.Contains(message.Content, firstAnswer) {
			sawFirstAnswer = true
		}
	}
	if !sawFirstQuestion || !sawFirstAnswer {
		t.Fatalf("second claim history lost the first round (user=%v assistant=%v): %+v",
			sawFirstQuestion, sawFirstAnswer, secondClaim.Context.Messages)
	}
	if secondClaim.Context.Summary == nil {
		t.Fatalf("knowledge-unavailable 8K claim dropped the stored conversation summary: summary=nil messages=%d",
			len(secondClaim.Context.Messages))
	}
	if len(secondClaim.Context.Summary.ConfirmedFacts) != 1 ||
		!strings.Contains(secondClaim.Context.Summary.ConfirmedFacts[0], summaryFact) {
		t.Fatalf("second claim summary wrong: %+v", secondClaim.Context.Summary)
	}
}

// createPersistentSmallWindowModel registers an 8K/1024 chat model whose
// inputContextBudgetTokens is 4944 — far below the frozen 21845-token source
// headroom the claim used to reserve for knowledge-ready runs.
func createPersistentSmallWindowModel(t *testing.T, h *v3Harness) uuid.UUID {
	t.Helper()
	created := h.post(t, "/api/v1/ai/providers", map[string]any{
		"providerKey": "v3-persistent-" + uuid.NewString(), "displayName": "Persistent Small Window",
		"protocol": "openai-completions", "baseUrl": "https://provider.example/v1",
		"apiKey": "v3-persistent-provider-secret", "models": []map[string]any{{
			"modelId": "persistent-small-chat", "displayName": "Persistent Small Chat",
			"contextWindow": 8192, "maxOutputTokens": 1024,
			"supportsTools": false, "supportsVision": false,
			"reasoningOptions": []map[string]any{},
		}},
	})
	assertStatus(t, created, http.StatusCreated)
	var createdBody struct {
		Models []struct {
			ID uuid.UUID `json:"id"`
		} `json:"models"`
	}
	if err := json.NewDecoder(created.Body).Decode(&createdBody); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	if len(createdBody.Models) != 1 {
		t.Fatal("persistent small-window model was not created")
	}
	return createdBody.Models[0].ID
}

// preparePersistentReadyIndex seeds knowledge items and drives the embedding
// index to status=ready so subsequent runs are created knowledgeState=ready.
func preparePersistentReadyIndex(t *testing.T, h *v3Harness, titles, contents []string) {
	t.Helper()
	for index, content := range contents {
		seedV3Knowledge(t, h.database, titles[index], content, "normal")
	}
	configure := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "持久上下文向量", "baseUrl": "https://embed.example/v1",
		"apiKey": "embedding-test-secret", "modelId": "mock-embed", "dimensions": 4,
		"enabled": true, "confirmReindex": true,
	})
	assertStatus(t, configure, http.StatusOK)
	configure.Body.Close()
	h.assistant.RunOnce(context.Background())
	if _, err := h.database.Exec(context.Background(), `
		UPDATE assistant_fragment_embeddings SET state = 'ready',
		       embedding = $1::vector, dimensions = 4, indexed_at = now()
	`, "[0.5,0.5,0.5,0.5]"); err != nil {
		t.Fatal(err)
	}
	h.assistant.RunOnce(context.Background())
	response := h.get(t, "/api/v1/assistant/index-status")
	assertStatus(t, response, http.StatusOK)
	var status struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if status.Status != "ready" {
		t.Fatalf("embedding index not ready for knowledge-ready runs: %+v", status)
	}
}

func startPersistentRun(t *testing.T, h *v3Harness, conversationID any, content string, modelID uuid.UUID) (string, string) {
	t.Helper()
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": conversationID,
		"content": content, "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var body struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(start.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	return body.Run.ID, body.Conversation.ID
}

func submitPersistentEvents(t *testing.T, h *v3Harness, runID string, leaseVersion int, workerID string, events []map[string]any) {
	t.Helper()
	submitted := h.internalPost(t, "/internal/assistant/runs/"+runID+"/events", map[string]any{
		"workerId": workerID, "leaseVersion": leaseVersion, "events": events,
	})
	assertStatus(t, submitted, http.StatusOK)
	submitted.Body.Close()
}

func completePersistentRun(t *testing.T, h *v3Harness, runID string, leaseVersion int, workerID string) {
	t.Helper()
	complete := h.internalPost(t, "/internal/assistant/runs/"+runID+"/complete", map[string]any{
		"workerId": workerID, "leaseVersion": leaseVersion,
		"usage":   map[string]any{"answerInputTokens": 11, "answerOutputTokens": 5},
		"timings": map[string]any{"answerMs": 3},
	})
	assertStatus(t, complete, http.StatusOK)
	complete.Body.Close()
}

// TestV3PersistentReadyKnowledgeKeepsHistoryAndStripsCitations pins the
// knowledge-ready branch of the claim budget on an 8K model: the second
// question must still carry the previous successful question/answer pair, and
// the canonical [[C#]] citation token in the stored answer must be stripped
// from the history copy (docs/16 §10.2). The test plays the worker — no real
// Provider or embedding call happens.
func TestV3PersistentReadyKnowledgeKeepsHistoryAndStripsCitations(t *testing.T) {
	h := newV3Harness(t)
	workerID := "worker-v3-persistent-ready"
	preparePersistentReadyIndex(t, h,
		[]string{"构建管线部署指南"},
		[]string{"构建管线通过 docker compose 部署全部服务并检查健康状态"})
	modelID := createPersistentSmallWindowModel(t, h)

	firstQuestion := "第一轮提问：如何部署构建管线服务"
	answerPrefix := "第一轮回答：构建管线通过 docker compose 部署，核心步骤包括镜像构建、服务编排与健康检查。"
	answerSuffix := "部署完成后需要验证所有服务的健康状态。"
	secondQuestion := "第二轮提问：构建产物体积如何优化"

	firstRunID, conversationID := startPersistentRun(t, h, nil, firstQuestion, modelID)
	firstClaim := claimPersistentRun(t, h, workerID)
	if firstClaim.Run.ID != firstRunID {
		t.Fatalf("first claim returned run %s, want %s", firstClaim.Run.ID, firstRunID)
	}
	if firstClaim.Knowledge.State != "ready" {
		t.Fatalf("ready index must produce knowledge.state=ready, got %q", firstClaim.Knowledge.State)
	}
	retrieval := h.internalPost(t, "/internal/assistant/runs/"+firstRunID+"/retrieval", map[string]any{
		"workerId": workerID, "leaseVersion": firstClaim.Run.LeaseVersion,
		"generation": firstClaim.Knowledge.Generation, "query": "如何部署构建管线服务",
		"queryVector": []float32{0.5, 0.5, 0.5, 0.5},
	})
	assertStatus(t, retrieval, http.StatusOK)
	var retrievalBody struct {
		KnowledgeState string `json:"knowledgeState"`
		EvidenceState  string `json:"evidenceState"`
		Sources        []struct {
			Ordinal int `json:"ordinal"`
		} `json:"sources"`
	}
	if err := json.NewDecoder(retrieval.Body).Decode(&retrievalBody); err != nil {
		t.Fatal(err)
	}
	retrieval.Body.Close()
	if retrievalBody.EvidenceState != "matched" || len(retrievalBody.Sources) != 1 || retrievalBody.Sources[0].Ordinal != 1 {
		t.Fatalf("first-round retrieval did not solidify S1: %+v", retrievalBody)
	}
	submitPersistentEvents(t, h, firstRunID, firstClaim.Run.LeaseVersion, workerID, []map[string]any{
		{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": answerPrefix}},
		{"eventId": uuid.New(), "type": "answer.citation", "payload": map[string]any{"sourceOrdinal": 1}},
		{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": answerSuffix}},
	})
	completePersistentRun(t, h, firstRunID, firstClaim.Run.LeaseVersion, workerID)
	var stored string
	if err := h.database.QueryRow(context.Background(),
		`SELECT content FROM assistant_messages WHERE current_run_id = $1`, firstRunID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != answerPrefix+"[[C1]]"+answerSuffix {
		t.Fatalf("stored first answer = %q, want the canonical citation token kept in storage", stored)
	}

	secondRunID, _ := startPersistentRun(t, h, conversationID, secondQuestion, modelID)
	secondClaim := claimPersistentRun(t, h, workerID)
	if secondClaim.Run.ID != secondRunID {
		t.Fatalf("second claim returned run %s, want %s", secondClaim.Run.ID, secondRunID)
	}
	if secondClaim.Knowledge.State != "ready" {
		t.Fatalf("second claim knowledge.state = %q, want ready (this pins the ready-budget branch)", secondClaim.Knowledge.State)
	}
	if secondClaim.Context.Question != secondQuestion {
		t.Fatalf("second claim question = %q, want the submitted second question", secondClaim.Context.Question)
	}
	if len(secondClaim.Context.Messages) != 2 {
		t.Fatalf("knowledge-ready 8K claim dropped the successful history: %+v", secondClaim.Context.Messages)
	}
	oldest, newest := secondClaim.Context.Messages[0], secondClaim.Context.Messages[1]
	if oldest.Role != "user" || oldest.Content != firstQuestion {
		t.Fatalf("history user message = {%s %q}, want the first question verbatim", oldest.Role, oldest.Content)
	}
	if newest.Role != "assistant" || newest.Content != answerPrefix+answerSuffix {
		t.Fatalf("history assistant message = {%s %q}, want the stripped first answer", newest.Role, newest.Content)
	}
	for _, message := range secondClaim.Context.Messages {
		if strings.Contains(message.Content, "[[C") {
			t.Fatalf("canonical citation token leaked into history: %q", message.Content)
		}
	}
}

// TestV3PersistentReadySourcesNotSqueezedByHistory pins the retrieval budget
// split (docs/16 §10.2): with real matched sources and a long multi-turn
// history plus a stored summary on an 8K model, the sources that fit the
// input budget by rank must not be squeezed out by the claim history/summary,
// and the solidified ordinals still start at S1.
func TestV3PersistentReadySourcesNotSqueezedByHistory(t *testing.T) {
	h := newV3Harness(t)
	workerID := "worker-v3-persistent-sources"
	marker := "预算压力测试标记："
	unit := strings.Repeat("预算压力测试内容段落", 190) // 5727 content bytes ≈ 1909 tokens + 7 title + 8 ≈ 1924 cost
	contents := []string{marker + unit, marker + unit, marker + unit}
	titles := []string{"预算压力来源一", "预算压力来源二", "预算压力来源三"}
	preparePersistentReadyIndex(t, h, titles, contents)
	modelID := createPersistentSmallWindowModel(t, h)

	firstQuestion := "第一轮提问：" + strings.Repeat("构建部署细节", 47)  // ≈ 288 tokens
	firstAnswer := "第一轮回答：" + strings.Repeat("构建部署答案", 300)  // ≈ 1806 tokens
	secondQuestion := "第二轮提问：" + strings.Repeat("回滚预案细节", 47) // ≈ 288 tokens
	secondAnswer := "第二轮回答：" + strings.Repeat("回滚预案答案", 300) // ≈ 1806 tokens
	thirdQuestion := "第三轮提问：本轮会加载哪些知识来源"
	summaryFact := "两轮后事实：构建管线部署与回滚演练完成"

	firstRunID, conversationID := startPersistentRun(t, h, nil, firstQuestion, modelID)
	firstClaim := claimPersistentRun(t, h, workerID)
	if firstClaim.Run.ID != firstRunID {
		t.Fatalf("first claim returned run %s, want %s", firstClaim.Run.ID, firstRunID)
	}
	submitPersistentEvents(t, h, firstRunID, firstClaim.Run.LeaseVersion, workerID, []map[string]any{
		{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": firstAnswer}},
	})
	completePersistentRun(t, h, firstRunID, firstClaim.Run.LeaseVersion, workerID)

	secondRunID, _ := startPersistentRun(t, h, conversationID, secondQuestion, modelID)
	secondClaim := claimPersistentRun(t, h, workerID)
	if secondClaim.Run.ID != secondRunID {
		t.Fatalf("second claim returned run %s, want %s", secondClaim.Run.ID, secondRunID)
	}
	submitPersistentEvents(t, h, secondRunID, secondClaim.Run.LeaseVersion, workerID, []map[string]any{
		{"eventId": uuid.New(), "type": "answer.delta", "payload": map[string]any{"delta": secondAnswer}},
	})
	completePersistentRun(t, h, secondRunID, secondClaim.Run.LeaseVersion, workerID)

	var throughSequence int64
	if err := h.database.QueryRow(context.Background(),
		`SELECT coalesce(max(sequence), 0) FROM assistant_messages WHERE conversation_id = $1`,
		conversationID).Scan(&throughSequence); err != nil {
		t.Fatal(err)
	}
	summaryWrite := h.internalPost(t, "/internal/assistant/runs/"+secondRunID+"/summary", map[string]any{
		"summary": map[string]any{
			"confirmedFacts":      []string{summaryFact},
			"corrections":         []string{},
			"rejectedHypotheses":  []string{},
			"unresolvedQuestions": []string{},
		},
		"throughMessageSequence":         throughSequence,
		"baselineThroughMessageSequence": 0,
		"modelSnapshot":                  map[string]any{"displayName": "Persistent Small Chat"},
	})
	assertStatus(t, summaryWrite, http.StatusOK)
	summaryWrite.Body.Close()

	thirdRunID, _ := startPersistentRun(t, h, conversationID, thirdQuestion, modelID)
	thirdClaim := claimPersistentRun(t, h, workerID)
	if thirdClaim.Run.ID != thirdRunID {
		t.Fatalf("third claim returned run %s, want %s", thirdClaim.Run.ID, thirdRunID)
	}
	if thirdClaim.Knowledge.State != "ready" {
		t.Fatalf("third claim knowledge.state = %q, want ready", thirdClaim.Knowledge.State)
	}
	if thirdClaim.Context.Question != thirdQuestion {
		t.Fatalf("third claim question = %q, want the submitted third question", thirdClaim.Context.Question)
	}
	if thirdClaim.Context.Summary == nil ||
		len(thirdClaim.Context.Summary.ConfirmedFacts) != 1 ||
		!strings.Contains(thirdClaim.Context.Summary.ConfirmedFacts[0], summaryFact) {
		t.Fatalf("third claim lost the stored summary: %+v", thirdClaim.Context.Summary)
	}
	messages := thirdClaim.Context.Messages
	if len(messages) != 4 {
		t.Fatalf("third claim must keep both whole history pairs oldest-first, got %d messages: %+v", len(messages), messages)
	}
	want := []struct {
		role    string
		content string
	}{{"user", firstQuestion}, {"assistant", firstAnswer}, {"user", secondQuestion}, {"assistant", secondAnswer}}
	for index, expected := range want {
		if messages[index].Role != expected.role || messages[index].Content != expected.content {
			t.Fatalf("history[%d] = {%s %q…}, want {%s %q…}", index,
				messages[index].Role, messages[index].Content[:24], expected.role, expected.content[:24])
		}
	}

	// Each source costs ≈1924 tokens; remaining = 4944 - 17 ≈ 4927 after the
	// question, so exactly two ranked sources fit regardless of the long
	// history and summary already loaded into the claim context.
	retrieval := h.internalPost(t, "/internal/assistant/runs/"+thirdRunID+"/retrieval", map[string]any{
		"workerId": workerID, "leaseVersion": thirdClaim.Run.LeaseVersion,
		"generation": thirdClaim.Knowledge.Generation, "query": marker,
		"queryVector": []float32{0.5, -0.5, 0.5, -0.5},
	})
	assertStatus(t, retrieval, http.StatusOK)
	var retrievalBody struct {
		KnowledgeState string `json:"knowledgeState"`
		EvidenceState  string `json:"evidenceState"`
		Sources        []struct {
			Ordinal int    `json:"ordinal"`
			ItemID  string `json:"itemId"`
		} `json:"sources"`
	}
	if err := json.NewDecoder(retrieval.Body).Decode(&retrievalBody); err != nil {
		t.Fatal(err)
	}
	retrieval.Body.Close()
	if retrievalBody.KnowledgeState != "ready" || retrievalBody.EvidenceState != "matched" {
		t.Fatalf("third retrieval states wrong: %+v", retrievalBody)
	}
	if len(retrievalBody.Sources) != 2 {
		t.Fatalf("ranked sources that fit the budget were squeezed out by history/summary: %d sources", len(retrievalBody.Sources))
	}
	if retrievalBody.Sources[0].Ordinal != 1 || retrievalBody.Sources[1].Ordinal != 2 {
		t.Fatalf("solidified ordinals must still start at S1: %+v", retrievalBody.Sources)
	}
	rows, err := h.database.Query(context.Background(), `
		SELECT ordinal FROM assistant_run_sources WHERE run_id = $1 ORDER BY ordinal
	`, thirdRunID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ordinals []int
	for rows.Next() {
		var ordinal int
		if err := rows.Scan(&ordinal); err != nil {
			t.Fatal(err)
		}
		ordinals = append(ordinals, ordinal)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(ordinals) != 2 || ordinals[0] != 1 || ordinals[1] != 2 {
		t.Fatalf("solidified run sources = %v, want [1 2]", ordinals)
	}
}

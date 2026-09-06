//go:build integration

package integration_test

// SSE 持久流在真实 PostgreSQL 上的恢复语义（docs/16 §15.1）：
// T30 广播通知丢失（直接写库绕过进程内广播）→ 1s fallback 轮询补齐；
// T31 终态前积压超过两个批次（>2×128 条）→ 尾部全部送达后才合成终态并关闭；
// T32 中断重连带 Last-Event-ID → snapshot-first，不重复拼接已接收事件。

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const sseStreamWorkerID = "worker-v3-sse-stream"

type sseStreamRun struct {
	runID        string
	leaseVersion int
}

type sseSnapshotPayload struct {
	LastSequence     int64  `json:"lastSequence"`
	AssistantMessage struct {
		Content string `json:"content"`
	} `json:"assistantMessage"`
}

// startSSEStreamRun 创建 provider/model、发起 run 并用内部 API 认领租约。
func startSSEStreamRun(t *testing.T, h *v3Harness) sseStreamRun {
	t.Helper()
	_, modelID := h.createProviderModel(t, []map[string]any{})
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil,
		"content": "SSE 流恢复测试", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": sseStreamWorkerID})
	assertStatus(t, claim, http.StatusOK)
	var claimBody struct {
		Run struct {
			LeaseVersion int `json:"leaseVersion"`
		} `json:"run"`
	}
	if err := json.NewDecoder(claim.Body).Decode(&claimBody); err != nil {
		t.Fatal(err)
	}
	claim.Body.Close()
	return sseStreamRun{runID: startBody.Run.ID, leaseVersion: claimBody.Run.LeaseVersion}
}

// openSSEStream 打开事件流；lastEventID 非空时携带 Last-Event-ID 头模拟重连。
func openSSEStream(t *testing.T, h *v3Harness, runID, lastEventID string) (*bufio.Reader, func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		h.server.URL+"/api/v1/assistant/runs/"+runID+"/events", nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	request.Header.Set("Origin", testOrigin)
	if lastEventID != "" {
		request.Header.Set("Last-Event-ID", lastEventID)
	}
	stream, err := h.client.Do(request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	assertStatus(t, stream, http.StatusOK)
	return bufio.NewReader(stream.Body), func() {
		stream.Body.Close()
		cancel()
	}
}

// insertRunEvent 绕过服务进程直接把事件写入数据库：进程内广播不可能被触发。
func insertRunEvent(t *testing.T, database *pgxpool.Pool, runID string, sequence int64, eventType, payload string) {
	t.Helper()
	if _, err := database.Exec(context.Background(), `
		INSERT INTO assistant_run_events (run_id, sequence, event_id, event_type, payload, created_at)
		VALUES ($1::uuid, $2, $3, $4, $5::jsonb, now())
	`, runID, sequence, uuid.New(), eventType, payload); err != nil {
		t.Fatal(err)
	}
}

// appendRunEventsInternal 通过内部 API 追加事件（会更新消息内容并触发广播）。
func appendRunEventsInternal(t *testing.T, h *v3Harness, run sseStreamRun, events []map[string]any) {
	t.Helper()
	for index := range events {
		events[index]["eventId"] = uuid.New()
	}
	response := h.internalPost(t, "/internal/assistant/runs/"+run.runID+"/events", map[string]any{
		"workerId": sseStreamWorkerID, "leaseVersion": run.leaseVersion, "events": events,
	})
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
}

func completeRunInternal(t *testing.T, h *v3Harness, run sseStreamRun) {
	t.Helper()
	response := h.internalPost(t, "/internal/assistant/runs/"+run.runID+"/complete", map[string]any{
		"workerId": sseStreamWorkerID, "leaseVersion": run.leaseVersion,
		"usage":   map[string]any{"answerInputTokens": 1, "answerOutputTokens": 1, "answerContextTokens": 2},
		"timings": map[string]any{"rewriteMs": 1, "embeddingMs": 1, "retrievalMs": 1, "reasoningMs": 1, "answerMs": 1},
	})
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
}

func parseSSESnapshot(t *testing.T, block v3SSEBlock) sseSnapshotPayload {
	t.Helper()
	var payload sseSnapshotPayload
	if err := json.Unmarshal([]byte(block.Data), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

// readNextSSEEvent 返回下一个携带事件名的块，跳过注释行，不限制事件类型。
func readNextSSEEvent(t *testing.T, reader *bufio.Reader) v3SSEBlock {
	t.Helper()
	for {
		block := readV3SSEBlock(t, reader)
		if block.Event == "" {
			continue
		}
		return block
	}
}

// T30: 广播通知丢失时，1s fallback 轮询必须在短时间内补齐事件。
func TestV3SSEStreamFallbackPollingCoversLostBroadcast(t *testing.T) {
	h := newV3Harness(t)
	run := startSSEStreamRun(t, h)
	insertRunEvent(t, h.database, run.runID, 1, "run.status", `{"phase":"answer"}`)

	reader, closeStream := openSSEStream(t, h, run.runID, "")
	defer closeStream()
	snapshot := readNextSSEEvent(t, reader)
	if event := snapshot.Event; event != "snapshot" {
		t.Fatalf("first stream event = %q, want snapshot", event)
	}
	if payload := parseSSESnapshot(t, snapshot); payload.LastSequence != 1 {
		t.Fatalf("snapshot lastSequence = %d, want 1", payload.LastSequence)
	}
	// 先空等超过一个轮询周期，排除此前动作残留的广播唤醒。
	time.Sleep(1200 * time.Millisecond)

	start := time.Now()
	insertRunEvent(t, h.database, run.runID, 2, "answer.delta", `{"delta":"fallback"}`)
	insertRunEvent(t, h.database, run.runID, 3, "answer.delta", `{"delta":"-polling"}`)
	first := readNextSSEEvent(t, reader)
	second := readNextSSEEvent(t, reader)
	elapsed := time.Since(start)

	if first.ID != "2" || !strings.Contains(first.Data, "fallback") {
		t.Fatalf("first polled event wrong: %+v", first)
	}
	if second.ID != "3" || !strings.Contains(second.Data, "-polling") {
		t.Fatalf("second polled event wrong: %+v", second)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("fallback polling delivered after %v, want < 5s", elapsed)
	}
}

// T31: 终态前积压超过两个批次的事件必须全部送达，终态最后合成并正常关闭连接。
func TestV3SSEStreamTerminalOnlyAfterWholeTail(t *testing.T) {
	h := newV3Harness(t)
	run := startSSEStreamRun(t, h)
	insertRunEvent(t, h.database, run.runID, 1, "run.status", `{"phase":"answer"}`)

	reader, closeStream := openSSEStream(t, h, run.runID, "")
	defer closeStream()
	snapshot := readNextSSEEvent(t, reader)
	if event := snapshot.Event; event != "snapshot" {
		t.Fatalf("first stream event = %q, want snapshot", event)
	}
	if payload := parseSSESnapshot(t, snapshot); payload.LastSequence != 1 {
		t.Fatalf("snapshot lastSequence = %d, want 1", payload.LastSequence)
	}

	// 与置终态同一事务写入 300 条事件（超过 2×128 的批量上限）。
	const storedEvents = 300
	tx, err := h.database.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// 失败路径必须归还连接，否则 t.Cleanup 里的 pool.Close 会永久等待。
	defer tx.Rollback(context.Background())
	for sequence := 2; sequence <= storedEvents+1; sequence++ {
		if _, err := tx.Exec(context.Background(), `
			INSERT INTO assistant_run_events (run_id, sequence, event_id, event_type, payload, created_at)
			VALUES ($1::uuid, $2, $3, 'answer.delta', jsonb_build_object('delta', $4::text), now())
		`, run.runID, sequence, uuid.New(), strconv.Itoa(sequence)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(context.Background(),
		`UPDATE assistant_runs SET status = 'succeeded', finished_at = now() WHERE id = $1::uuid`, run.runID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}

	// 读取：id 2..301 必须全部按序到达，run.completed(302) 是最后一个事件。
	next := int64(2)
	var terminal v3SSEBlock
	for {
		block := readNextSSEEvent(t, reader)
		if block.Event == "run.completed" {
			terminal = block
			break
		}
		if block.ID != strconv.FormatInt(next, 10) {
			t.Fatalf("streamed event id = %q, want %d (%s)", block.ID, next, block.Event)
		}
		next++
	}
	if next != storedEvents+2 {
		t.Fatalf("streamed %d stored events, want %d before terminal", next-2, storedEvents)
	}
	if terminal.ID != strconv.FormatInt(storedEvents+2, 10) {
		t.Fatalf("terminal id = %q, want %d", terminal.ID, storedEvents+2)
	}
	// 终态之后服务端必须关闭连接。
	if _, err := reader.ReadString('\n'); err != io.EOF {
		t.Fatalf("stream must close after terminal, got %v", err)
	}
}

// T32: 中断重连带 Last-Event-ID 时按 snapshot-first 合同恢复：快照携带完整
// 回答与最新 lastSequence，之后只送更新事件，不重复拼接已接收内容。
func TestV3SSEStreamReconnectResumesFromSnapshotWithoutReplay(t *testing.T) {
	h := newV3Harness(t)
	run := startSSEStreamRun(t, h)

	reader1, closeStream1 := openSSEStream(t, h, run.runID, "")
	snapshot1 := readNextSSEEvent(t, reader1)
	if event := snapshot1.Event; event != "snapshot" {
		t.Fatalf("first stream event = %q, want snapshot", event)
	}
	if payload := parseSSESnapshot(t, snapshot1); payload.LastSequence != 0 {
		t.Fatalf("initial snapshot lastSequence = %d, want 0", payload.LastSequence)
	}
	appendRunEventsInternal(t, h, run, []map[string]any{
		{"type": "run.status", "payload": map[string]any{"phase": "answer"}},
		{"type": "answer.delta", "payload": map[string]any{"delta": "依据"}},
		{"type": "answer.delta", "payload": map[string]any{"delta": "来源"}},
	})
	for _, id := range []string{"1", "2", "3"} {
		if block := readNextSSEEvent(t, reader1); block.ID != id {
			t.Fatalf("first connection event id = %q, want %s (%s)", block.ID, id, block.Event)
		}
	}
	// 客户端中断。
	closeStream1()

	appendRunEventsInternal(t, h, run, []map[string]any{
		{"type": "answer.delta", "payload": map[string]any{"delta": "补充"}},
		{"type": "answer.delta", "payload": map[string]any{"delta": "内容"}},
		{"type": "answer.delta", "payload": map[string]any{"delta": "A"}},
	})

	// 重连：客户端只确认到 3，服务端以快照为准补齐。
	reader2, closeStream2 := openSSEStream(t, h, run.runID, "3")
	defer closeStream2()
	snapshotBlock := readNextSSEEvent(t, reader2)
	if snapshotBlock.Event != "snapshot" {
		t.Fatalf("reconnect first event = %q, want snapshot", snapshotBlock.Event)
	}
	snapshot2 := parseSSESnapshot(t, snapshotBlock)
	if snapshot2.LastSequence != 6 {
		t.Fatalf("reconnect snapshot lastSequence = %d, want 6", snapshot2.LastSequence)
	}
	if !strings.Contains(snapshot2.AssistantMessage.Content, "依据来源补充内容A") {
		t.Fatalf("snapshot message lost accumulated deltas: %q", snapshot2.AssistantMessage.Content)
	}

	// 快照之后只能收到新事件；若重复回放 4..6，此处读到的 id 不会是 7。
	appendRunEventsInternal(t, h, run, []map[string]any{
		{"type": "answer.delta", "payload": map[string]any{"delta": "尾"}},
	})
	resumed := readNextSSEEvent(t, reader2)
	if resumed.ID != "7" || !strings.Contains(resumed.Data, "尾") {
		t.Fatalf("replayed event after snapshot: id=%q data=%s", resumed.ID, resumed.Data)
	}

	completeRunInternal(t, h, run)
	terminal := readNextSSEEvent(t, reader2)
	if terminal.Event != "run.completed" {
		t.Fatalf("terminal event = %q, want run.completed", terminal.Event)
	}
	if terminal.ID != "8" {
		t.Fatalf("terminal id = %q, want 8", terminal.ID)
	}
	if _, err := reader2.ReadString('\n'); err != io.EOF {
		t.Fatalf("reconnected stream must close after terminal, got %v", err)
	}
}

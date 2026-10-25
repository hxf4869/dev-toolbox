//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// R240 回归 1:deleteFolder 的 active-run 检查必须与公开 createRun 的会话行锁
// 互斥。测试在隔离测试库内用 BEFORE INSERT advisory 门强制交错:createRun 已
// 持会话行锁、在插入 run 处等待,deleteFolder 必须先在会话行相关 SQL 上等待,
// 并在 createRun 提交后看到 queued run,返回 ASSISTANT_RUN_ALREADY_ACTIVE 且
// 不删任何数据。现网该交错的实际行为以观测为准(2026-10-23 观测:create 202/
// delete 500 且数据保留,违背 409 合同)。
func TestV3FolderDeleteConcurrentActiveRunIsRejected(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{})

	created := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "R240 race folder"})
	assertStatus(t, created, http.StatusCreated)
	var folder struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(created.Body).Decode(&folder); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()

	// 用公开 API 建立文件夹内会话,再停止首个 run,得到一个无活动 run 的会话。
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil, "folderId": folder.ID,
		"content": "R240 首条用于建会话的请求", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	stop := h.post(t, "/api/v1/assistant/runs/"+startBody.Run.ID+"/stop", map[string]any{})
	assertStatus(t, stop, http.StatusOK)
	stop.Body.Close()

	ctx := context.Background()
	if _, err := h.database.Exec(ctx, `
		DROP TRIGGER IF EXISTS r240_gate_run_insert ON assistant_runs;
		DROP FUNCTION IF EXISTS r240_gate_run_insert();
		CREATE FUNCTION r240_gate_run_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
		BEGIN
			PERFORM pg_advisory_xact_lock(9124024012401::bigint);
			RETURN NEW;
		END
		$fn$;
		CREATE TRIGGER r240_gate_run_insert BEFORE INSERT ON assistant_runs
		FOR EACH ROW EXECUTE FUNCTION r240_gate_run_insert();
	`); err != nil {
		t.Fatal(err)
	}
	// 先注册触发器清理,再注册 gate 连接清理:t.Cleanup 按 LIFO 执行,gate 连接
	// 必须先释放,阻塞中的 INSERT 提交后 DROP TRIGGER 才拿得到锁,不会互相等。
	t.Cleanup(func() {
		_, _ = h.database.Exec(context.Background(), `
			DROP TRIGGER IF EXISTS r240_gate_run_insert ON assistant_runs;
			DROP FUNCTION IF EXISTS r240_gate_run_insert();
		`)
	})

	gate, err := pgx.Connect(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gate.Close(ctx) })
	var gatePID uint32
	if err := gate.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&gatePID); err != nil {
		t.Fatal(err)
	}
	// 会话级 advisory 锁作为测试门:createRun 事务内的触发器会在这里排队。
	if _, err := gate.Exec(ctx, `SELECT pg_advisory_lock(9124024012401::bigint)`); err != nil {
		t.Fatal(err)
	}

	createDone := r240AsyncRequest(t, h, http.MethodPost, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": startBody.Conversation.ID,
		"content": "R240 与文件夹删除并发的新请求", "modelId": modelID, "reasoning": "off",
	})
	createPID, createWait, createQuery := r240WaitBackendBlockedBy(t, h.database, gatePID, 10*time.Second)
	if createWait != "Lock" || !strings.Contains(createQuery, "assistant_runs") {
		t.Fatalf("createRun not gated at assistant_runs insert: wait=%s query=%s", createWait, createQuery)
	}
	t.Logf("createRun backend %d gated by advisory lock at: %s", createPID, createQuery)

	deleteDone := r240AsyncRequest(t, h, http.MethodDelete, "/api/v1/assistant/folders/"+folder.ID,
		map[string]any{"conversationAction": "delete"})
	deletePID, deleteWait, deleteQuery := r240WaitBackendBlockedBy(t, h.database, createPID, 10*time.Second)
	// 锁住会话行的实现无论阻塞在 FOR UPDATE 还是级联 DELETE 上,都必须是
	// assistant_conversations 相关 SQL;这是删除事务与 createRun 竞争的位置。
	if deleteWait != "Lock" || !strings.Contains(deleteQuery, "assistant_conversations") {
		t.Fatalf("deleteFolder not waiting on conversation-row SQL: pid=%d wait=%s query=%s", deletePID, deleteWait, deleteQuery)
	}
	t.Logf("deleteFolder backend %d blocked by createRun %d at: %s", deletePID, createPID, deleteQuery)

	if _, err := gate.Exec(ctx, `SELECT pg_advisory_unlock(9124024012401::bigint)`); err != nil {
		t.Fatal(err)
	}

	// 先回收两个响应再断言:并发交错下 createRun 提交后的读回(loadRun)与
	// 删除事务的相对顺序不确定,提前 assert 202 可能掩盖 delete 的真实结果。
	createResponse := r240Receive(t, createDone, "createRun")
	deleteResponse := r240Receive(t, deleteDone, "deleteFolder")
	if deleteResponse.StatusCode != http.StatusConflict {
		// 非 409 不能走 v3Error 解码;run 计数按 conversation_id 统计,不依赖
		// 可能无法返回的新 run ID,两个 body 都关闭,真实 HTTP 结果与存活计数
		// 写进单条失败信息。
		_, _ = io.Copy(io.Discard, createResponse.Body)
		createResponse.Body.Close()
		_, _ = io.Copy(io.Discard, deleteResponse.Body)
		deleteResponse.Body.Close()
		var folderRows, conversationRows, runRows, messageRows int
		if err := h.database.QueryRow(ctx, `
			SELECT
				(SELECT count(*) FROM assistant_folders WHERE id = $1),
				(SELECT count(*) FROM assistant_conversations WHERE id = $2),
				(SELECT count(*) FROM assistant_runs WHERE conversation_id = $2),
				(SELECT count(*) FROM assistant_messages WHERE conversation_id = $2)
		`, folder.ID, startBody.Conversation.ID).Scan(&folderRows, &conversationRows, &runRows, &messageRows); err != nil {
			t.Fatal(err)
		}
		t.Fatalf("createRun HTTP=%d, deleteFolder HTTP=%d (want 202/409); survival counts folders=%d conversations=%d runs=%d messages=%d (violates the active-run guard contract)",
			createResponse.StatusCode, deleteResponse.StatusCode, folderRows, conversationRows, runRows, messageRows)
	}
	assertStatus(t, createResponse, http.StatusAccepted)
	var raced struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(createResponse.Body).Decode(&raced); err != nil {
		t.Fatal(err)
	}
	createResponse.Body.Close()
	if status, code := v3Error(t, deleteResponse); status != http.StatusConflict || code != "ASSISTANT_RUN_ALREADY_ACTIVE" {
		t.Fatalf("expected folder delete to reject with ASSISTANT_RUN_ALREADY_ACTIVE, got %d %s", status, code)
	}

	// createRun 提交的 run、消息和会话必须全部保留,文件夹删除整体回滚。
	var runStatus string
	if err := h.database.QueryRow(ctx,
		`SELECT status FROM assistant_runs WHERE id = $1`, raced.Run.ID).Scan(&runStatus); err != nil {
		t.Fatalf("raced run was not preserved: %v", err)
	}
	if runStatus != "queued" {
		t.Fatalf("raced run status = %s, want queued", runStatus)
	}
	var messageCount int
	if err := h.database.QueryRow(ctx,
		`SELECT count(*) FROM assistant_messages WHERE conversation_id = $1`, startBody.Conversation.ID).Scan(&messageCount); err != nil {
		t.Fatal(err)
	}
	if messageCount != 4 {
		t.Fatalf("conversation messages = %d, want 4 (2 per run)", messageCount)
	}
	conversation := h.get(t, "/api/v1/assistant/conversations/"+startBody.Conversation.ID)
	assertStatus(t, conversation, http.StatusOK)
	conversation.Body.Close()
	var folderCount int
	if err := h.database.QueryRow(ctx,
		`SELECT count(*) FROM assistant_folders WHERE id = $1`, folder.ID).Scan(&folderCount); err != nil {
		t.Fatal(err)
	}
	if folderCount != 1 {
		t.Fatal("rejected folder delete still removed the folder")
	}
	// 两次正常发送(各 2 条消息)后序号推进恰为 5:证明 runs_create 的合并
	// 会话行 UPDATE 既不漏增也不多增。
	var nextSequence int64
	if err := h.database.QueryRow(ctx,
		`SELECT next_message_sequence FROM assistant_conversations WHERE id = $1`,
		startBody.Conversation.ID).Scan(&nextSequence); err != nil {
		t.Fatal(err)
	}
	if nextSequence != 5 {
		t.Fatalf("conversation next_message_sequence = %d, want 5 (two sends × 2 messages)", nextSequence)
	}
}

// R240 串行对照:文件夹内会话的 run 已到终态(stopped)时,delete 分支应 204,
// 并完整级联清除 folder/conversation/runs/messages。该合同分支此前没有实际
// 成功路径测试;并发用例观测到非合同行为时,用它区分锁竞争与普通级联失败。
func TestV3FolderDeleteFinishedConversationRemovesData(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{})

	created := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "R240 finished folder"})
	assertStatus(t, created, http.StatusCreated)
	var folder struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(created.Body).Decode(&folder); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil, "folderId": folder.ID,
		"content": "R240 串行对照请求", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	stop := h.post(t, "/api/v1/assistant/runs/"+startBody.Run.ID+"/stop", map[string]any{})
	assertStatus(t, stop, http.StatusOK)
	stop.Body.Close()
	var stopped string
	if err := h.database.QueryRow(context.Background(),
		`SELECT status FROM assistant_runs WHERE id = $1`, startBody.Run.ID).Scan(&stopped); err != nil {
		t.Fatal(err)
	}
	if stopped != "stopped" {
		t.Fatalf("setup run status = %s, want stopped", stopped)
	}

	deleted := h.delete(t, "/api/v1/assistant/folders/"+folder.ID, map[string]any{"conversationAction": "delete"})
	if deleted.StatusCode != http.StatusNoContent {
		_, _ = io.Copy(io.Discard, deleted.Body)
		deleted.Body.Close()
		var folderRows, conversationRows, runRows, messageRows int
		if err := h.database.QueryRow(context.Background(), `
			SELECT
				(SELECT count(*) FROM assistant_folders WHERE id = $1),
				(SELECT count(*) FROM assistant_conversations WHERE id = $2),
				(SELECT count(*) FROM assistant_runs WHERE conversation_id = $2),
				(SELECT count(*) FROM assistant_messages WHERE conversation_id = $2)
		`, folder.ID, startBody.Conversation.ID).Scan(&folderRows, &conversationRows, &runRows, &messageRows); err != nil {
			t.Fatal(err)
		}
		t.Fatalf("serial delete with finished run: HTTP=%d, want 204; remaining folders=%d conversations=%d runs=%d messages=%d",
			deleted.StatusCode, folderRows, conversationRows, runRows, messageRows)
	}
	deleted.Body.Close()
	var folderRows, conversationRows, runRows, messageRows int
	if err := h.database.QueryRow(context.Background(), `
		SELECT
			(SELECT count(*) FROM assistant_folders WHERE id = $1),
			(SELECT count(*) FROM assistant_conversations WHERE id = $2),
			(SELECT count(*) FROM assistant_runs WHERE conversation_id = $2),
			(SELECT count(*) FROM assistant_messages WHERE conversation_id = $2)
	`, folder.ID, startBody.Conversation.ID).Scan(&folderRows, &conversationRows, &runRows, &messageRows); err != nil {
		t.Fatal(err)
	}
	if folderRows != 0 || conversationRows != 0 || runRows != 0 || messageRows != 0 {
		t.Fatalf("204 left rows behind: folders=%d conversations=%d runs=%d messages=%d",
			folderRows, conversationRows, runRows, messageRows)
	}
}

// R240 回归 2:assistant_folders_name_unique 建立在 lower(btrim(name)) 上,
// createFolder 对规范化重名返回 422 VALIDATION_FAILED;patchFolder 命中同一
// 23505 时当前返回 500。PATCH 必须同样返回稳定 422,并保留原名称。
func TestV3FolderPatchDuplicateNormalizedNameIsRejected(t *testing.T) {
	h := newV3Harness(t)
	first := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "Reports"})
	assertStatus(t, first, http.StatusCreated)
	var reports struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(first.Body).Decode(&reports); err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	second := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "Scratch"})
	assertStatus(t, second, http.StatusCreated)
	var scratch struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(second.Body).Decode(&scratch); err != nil {
		t.Fatal(err)
	}
	second.Body.Close()

	// 基准:createFolder 对大小写/空白规范化重名已是 422 VALIDATION_FAILED。
	duplicate := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "  reports  "})
	if status, code := v3Error(t, duplicate); status != http.StatusUnprocessableEntity || code != "VALIDATION_FAILED" {
		t.Fatalf("createFolder duplicate baseline: got %d %s", status, code)
	}

	patch := h.do(t, http.MethodPatch, "/api/v1/assistant/folders/"+scratch.ID, map[string]any{"name": " REPORTS "}, false)
	if status, code := v3Error(t, patch); status != http.StatusUnprocessableEntity || code != "VALIDATION_FAILED" {
		t.Fatalf("patchFolder normalized duplicate: got %d %s, want 422 VALIDATION_FAILED", status, code)
	}
	var stored string
	if err := h.database.QueryRow(context.Background(),
		`SELECT name FROM assistant_folders WHERE id = $1`, scratch.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "Scratch" {
		t.Fatalf("rejected patch changed stored name to %q", stored)
	}

	// 规范化后等于自身名称的重命名不受唯一索引影响,仍应成功并落库为 trim 后名称。
	keep := h.do(t, http.MethodPatch, "/api/v1/assistant/folders/"+scratch.ID, map[string]any{"name": " Scratch "}, false)
	assertStatus(t, keep, http.StatusOK)
	var kept struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(keep.Body).Decode(&kept); err != nil {
		t.Fatal(err)
	}
	keep.Body.Close()
	if kept.Name != "Scratch" {
		t.Fatalf("self-normalized rename lost trim: %q", kept.Name)
	}
}

// R253 回归:文件夹删除事务先锁住 folder 行，公开新建 Run(folderId)随后等待。
// 删除提交后应返回 422 VALIDATION_FAILED，不留孤儿 conversation/run/messages。
// 控制事务沿用 deleteFolder 的 FOR UPDATE + DELETE + COMMIT；pg_blocking_pids
// 确认公开请求真实等待该事务，记录实际 SQL，不绑定旧实现的 INSERT 语句。
func TestV3NewRunWithFolderConcurrentDeleteIsRejected(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{})

	created := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "R253 race folder"})
	assertStatus(t, created, http.StatusCreated)
	var folder struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(created.Body).Decode(&folder); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()

	ctx := context.Background()
	control, err := pgx.Connect(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = control.Close(ctx) })
	var controlPID uint32
	if err := control.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&controlPID); err != nil {
		t.Fatal(err)
	}
	controlTx, err := control.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// 无论断言结果如何都先注册回滚(提交/回滚后再调用是 no-op),避免控制事务
	// 泄漏锁造成后续用例假超时。
	t.Cleanup(func() { _ = controlTx.Rollback(ctx) })
	// 与生产 deleteFolder 相同的锁起点:先 FOR UPDATE 锁住 folder 行,删除事务
	// 在此之后才 unfile/删除 children 并 DELETE folder。
	if _, err := controlTx.Exec(ctx,
		`SELECT id FROM assistant_folders WHERE id = $1 FOR UPDATE`, folder.ID); err != nil {
		t.Fatal(err)
	}

	content := "R253 与文件夹删除并发的新会话请求"
	clientRequestID := uuid.New()
	createDone := r240AsyncRequest(t, h, http.MethodPost, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": clientRequestID, "conversationId": nil, "folderId": folder.ID,
		"content": content, "modelId": modelID, "reasoning": "off",
	})
	runPID, runWait, runQuery := r240WaitBackendBlockedBy(t, h.database, controlPID, 10*time.Second)
	// 阻塞门只要求公开请求真实等在控制事务的 folder 行锁上;具体阻塞语句随
	// 实现对该行的锁强度不同,故仅断言 Lock 等待并记录实际 SQL。
	if runWait != "Lock" {
		t.Fatalf("new-run not blocked by control tx: pid=%d wait=%s query=%s", runPID, runWait, runQuery)
	}
	t.Logf("new-run backend %d blocked by control %d at: %s", runPID, controlPID, runQuery)

	// 同一控制事务完成锁定删除(空文件夹,与 deleteFolder 对 folder 行的
	// DELETE+COMMIT 语义一致),提交后放行阻塞中的 FK 检查。
	if _, err := controlTx.Exec(ctx, `DELETE FROM assistant_folders WHERE id = $1`, folder.ID); err != nil {
		t.Fatal(err)
	}
	if err := controlTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	response := r240Receive(t, createDone, "new-run")
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &envelope)
	t.Logf("new-run under concurrent folder delete observed: HTTP=%d code=%q body=%s",
		response.StatusCode, envelope.Error.Code, strings.TrimSpace(string(body)))

	var conversationRows, runRows, messageRows, folderRows int
	if err := h.database.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM assistant_conversations WHERE title = $1),
			(SELECT count(*) FROM assistant_runs WHERE client_request_id = $2),
			(SELECT count(*) FROM assistant_messages m JOIN assistant_conversations c ON c.id = m.conversation_id WHERE c.title = $1),
			(SELECT count(*) FROM assistant_folders WHERE id = $3)
	`, content, clientRequestID, folder.ID).Scan(&conversationRows, &runRows, &messageRows, &folderRows); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnprocessableEntity || envelope.Error.Code != "VALIDATION_FAILED" {
		t.Fatalf("new-run under concurrent folder delete: HTTP=%d code=%q, want 422 VALIDATION_FAILED; survivors conversations=%d runs=%d messages=%d folders=%d; body=%s",
			response.StatusCode, envelope.Error.Code, conversationRows, runRows, messageRows, folderRows, strings.TrimSpace(string(body)))
	}
	if conversationRows != 0 || runRows != 0 || messageRows != 0 {
		t.Fatalf("rejected new-run left orphans: conversations=%d runs=%d messages=%d",
			conversationRows, runRows, messageRows)
	}
	if folderRows != 0 {
		t.Fatal("control delete did not remove the folder")
	}
}

// R256 回归 1:公开 PATCH /api/v1/assistant/conversations/{id} 的 folderId 三态
// 合同(docs/16 §13.3/13.4):键省略不改文件夹,显式 null 移回未分类,非法非
// UUID 值 422 且不清/改文件夹。UI"移至未分类"只发送 {"folderId": null},
// 必须以真实 HTTP 请求验证,不接受源码注释里的双指针假设。
func TestV3ConversationFolderPatchNullAndOmitted(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{})

	created := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "R256 patch folder"})
	assertStatus(t, created, http.StatusCreated)
	var folder struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(created.Body).Decode(&folder); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()

	// 公开 API 建立文件夹内会话,保留 queued run(docs/16 §13.4:活动 run 期间
	// 允许改会话元数据),作为 folder 变更不得扰动的基准。
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil, "folderId": folder.ID,
		"content": "R256 建立文件夹内会话的请求", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	conversationID := startBody.Conversation.ID
	conversationPath := "/api/v1/assistant/conversations/" + conversationID

	ctx := context.Background()
	var baselineStatus string
	var baselineMessages int
	if err := h.database.QueryRow(ctx, `
		SELECT (SELECT status FROM assistant_runs WHERE conversation_id = $1),
		       (SELECT count(*) FROM assistant_messages WHERE conversation_id = $1)
	`, conversationID).Scan(&baselineStatus, &baselineMessages); err != nil {
		t.Fatal(err)
	}
	if baselineStatus != "queued" {
		t.Fatalf("setup run status = %s, want queued", baselineStatus)
	}
	storedFolder := func() *string {
		var folderID *string
		if err := h.database.QueryRow(ctx,
			`SELECT folder_id::text FROM assistant_conversations WHERE id = $1`, conversationID).Scan(&folderID); err != nil {
			t.Fatal(err)
		}
		return folderID
	}
	assertPreserved := func(stage string) {
		t.Helper()
		var status string
		var messages int
		if err := h.database.QueryRow(ctx, `
			SELECT (SELECT status FROM assistant_runs WHERE conversation_id = $1),
			       (SELECT count(*) FROM assistant_messages WHERE conversation_id = $1)
		`, conversationID).Scan(&status, &messages); err != nil {
			t.Fatal(err)
		}
		if status != baselineStatus || messages != baselineMessages {
			t.Fatalf("%s: run status=%s (baseline %s), messages=%d (baseline %d)",
				stage, status, baselineStatus, messages, baselineMessages)
		}
	}
	patchFolder := func(payload map[string]any) (int, string, *string) {
		response := h.do(t, http.MethodPatch, conversationPath, payload, false)
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &envelope)
		var dto struct {
			FolderID *string `json:"folderId"`
		}
		_ = json.Unmarshal(body, &dto)
		return response.StatusCode, envelope.Error.Code, dto.FolderID
	}

	// 键省略:只改 title,文件夹必须保持。
	status, code, dtoFolder := patchFolder(map[string]any{"title": "R256 改名后"})
	if status != http.StatusOK || code != "" || dtoFolder == nil || *dtoFolder != folder.ID {
		t.Fatalf("patch without folderId: HTTP=%d code=%q dtoFolder=%v, want 200 keeping folder %s",
			status, code, dtoFolder, folder.ID)
	}
	if stored := storedFolder(); stored == nil || *stored != folder.ID {
		t.Fatalf("patch without folderId changed stored folder to %v", stored)
	}
	assertPreserved("patch without folderId")

	// 显式 null:移回未分类,DTO 与库内 folder_id 都为 NULL。
	status, code, dtoFolder = patchFolder(map[string]any{"folderId": nil})
	if status != http.StatusOK || code != "" || dtoFolder != nil {
		t.Fatalf("patch folderId null: HTTP=%d code=%q dtoFolder=%v, want 200 with folderId null",
			status, code, dtoFolder)
	}
	if stored := storedFolder(); stored != nil {
		t.Fatalf("patch folderId null left stored folder %v", stored)
	}
	assertPreserved("patch folderId null")

	// 移回有效文件夹仍成功。
	status, code, dtoFolder = patchFolder(map[string]any{"folderId": folder.ID})
	if status != http.StatusOK || code != "" || dtoFolder == nil || *dtoFolder != folder.ID {
		t.Fatalf("patch folderId back: HTTP=%d code=%q dtoFolder=%v, want 200 with folder %s",
			status, code, dtoFolder, folder.ID)
	}
	if stored := storedFolder(); stored == nil || *stored != folder.ID {
		t.Fatalf("patch folderId back left stored folder %v", stored)
	}
	assertPreserved("patch folderId back")

	// 非法非 UUID 输入:422 且不清/改文件夹。
	status, code, dtoFolder = patchFolder(map[string]any{"folderId": 123})
	if status != http.StatusUnprocessableEntity || code != "VALIDATION_FAILED" {
		t.Fatalf("patch folderId 123: HTTP=%d code=%q, want 422 VALIDATION_FAILED", status, code)
	}
	if stored := storedFolder(); stored == nil || *stored != folder.ID {
		t.Fatalf("rejected invalid folderId changed stored folder to %v", stored)
	}
	assertPreserved("patch folderId invalid")
}

// R256 回归 2:会话移入目标文件夹与并发删除该文件夹交错(deleteFolder 先
// 锁定目标 folder 行并提交)时,公开 PATCH 的真实结果:应 422
// VALIDATION_FAILED,会话保持未分类,run/messages 不变。控制事务沿用
// deleteFolder 的 FOR UPDATE 锁起点;pg_blocking_pids 确认公开请求真实等待
// 并记录实际 SQL,不绑定旧实现的具体语句。
func TestV3ConversationFolderMoveConcurrentDelete(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{})

	created := h.post(t, "/api/v1/assistant/folders", map[string]any{"name": "R256 race folder"})
	assertStatus(t, created, http.StatusCreated)
	var folder struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(created.Body).Decode(&folder); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()

	// folderId 省略建立初始未分类会话(queued run + 消息)。
	start := h.post(t, "/api/v1/assistant/runs", map[string]any{
		"clientRequestId": uuid.New(), "conversationId": nil,
		"content": "R256 初始未分类会话请求", "modelId": modelID, "reasoning": "off",
	})
	assertStatus(t, start, http.StatusAccepted)
	var startBody struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
	}
	if err := json.NewDecoder(start.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}
	start.Body.Close()
	conversationID := startBody.Conversation.ID

	ctx := context.Background()
	var initialFolder *string
	var baselineStatus string
	var baselineMessages int
	if err := h.database.QueryRow(ctx, `
		SELECT folder_id::text,
		       (SELECT status FROM assistant_runs WHERE conversation_id = $1),
		       (SELECT count(*) FROM assistant_messages WHERE conversation_id = $1)
		FROM assistant_conversations WHERE id = $1
	`, conversationID).Scan(&initialFolder, &baselineStatus, &baselineMessages); err != nil {
		t.Fatal(err)
	}
	if initialFolder != nil || baselineStatus != "queued" {
		t.Fatalf("setup: folder=%v runStatus=%s, want unfiled queued conversation", initialFolder, baselineStatus)
	}

	control, err := pgx.Connect(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = control.Close(ctx) })
	var controlPID uint32
	if err := control.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&controlPID); err != nil {
		t.Fatal(err)
	}
	controlTx, err := control.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = controlTx.Rollback(ctx) })
	// 与 deleteFolder 相同的锁起点:先 FOR UPDATE 锁住目标 folder 行。
	if _, err := controlTx.Exec(ctx,
		`SELECT id FROM assistant_folders WHERE id = $1 FOR UPDATE`, folder.ID); err != nil {
		t.Fatal(err)
	}

	moveDone := r240AsyncRequest(t, h, http.MethodPatch,
		"/api/v1/assistant/conversations/"+conversationID, map[string]any{"folderId": folder.ID})
	movePID, moveWait, moveQuery := r240WaitBackendBlockedBy(t, h.database, controlPID, 10*time.Second)
	if moveWait != "Lock" {
		t.Fatalf("move not blocked by control tx: pid=%d wait=%s query=%s", movePID, moveWait, moveQuery)
	}
	t.Logf("move backend %d blocked by control %d at: %s", movePID, controlPID, moveQuery)

	if _, err := controlTx.Exec(ctx, `DELETE FROM assistant_folders WHERE id = $1`, folder.ID); err != nil {
		t.Fatal(err)
	}
	if err := controlTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	response := r240Receive(t, moveDone, "move")
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &envelope)
	t.Logf("move under concurrent folder delete observed: HTTP=%d code=%q body=%s",
		response.StatusCode, envelope.Error.Code, strings.TrimSpace(string(body)))

	var storedFolder *string
	var status string
	var messages int
	var folderRows int
	if err := h.database.QueryRow(ctx, `
		SELECT folder_id::text,
		       (SELECT status FROM assistant_runs WHERE conversation_id = $1),
		       (SELECT count(*) FROM assistant_messages WHERE conversation_id = $1),
		       (SELECT count(*) FROM assistant_folders WHERE id = $2)
		FROM assistant_conversations WHERE id = $1
	`, conversationID, folder.ID).Scan(&storedFolder, &status, &messages, &folderRows); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnprocessableEntity || envelope.Error.Code != "VALIDATION_FAILED" {
		t.Fatalf("move under concurrent folder delete: HTTP=%d code=%q, want 422 VALIDATION_FAILED; conversation folder=%v runStatus=%s messages=%d folders=%d; body=%s",
			response.StatusCode, envelope.Error.Code, storedFolder, status, messages, folderRows, strings.TrimSpace(string(body)))
	}
	if storedFolder != nil {
		t.Fatalf("rejected move changed conversation folder to %v", storedFolder)
	}
	if status != baselineStatus || messages != baselineMessages {
		t.Fatalf("rejected move disturbed run/messages: status=%s (baseline %s), messages=%d (baseline %d)",
			status, baselineStatus, messages, baselineMessages)
	}
	if folderRows != 0 {
		t.Fatal("control delete did not remove the folder")
	}
}

type r240AsyncResult struct {
	response *http.Response
	err      error
}

// r240AsyncRequest 在 goroutine 中发起与 h.do 相同形状的公开请求;请求自身带
// 短 deadline 的 Context 并挂 t.Cleanup,异常路径也能取消在途请求,并发阶段的
// 响应只经 channel 回收,断言留在测试 goroutine。
func r240AsyncRequest(t *testing.T, h *v3Harness, method, path string, payload any) <-chan r240AsyncResult {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	request, err := http.NewRequestWithContext(ctx, method, h.server.URL+path, bytes.NewReader(encoded))
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", h.csrf)
	results := make(chan r240AsyncResult, 1)
	go func() {
		response, err := h.client.Do(request)
		results <- r240AsyncResult{response: response, err: err}
	}()
	return results
}

func r240Receive(t *testing.T, results <-chan r240AsyncResult, label string) *http.Response {
	t.Helper()
	select {
	case result := <-results:
		if result.err != nil {
			t.Fatalf("%s request failed: %v", label, result.err)
		}
		return result.response
	case <-time.After(20 * time.Second):
		t.Fatalf("timed out waiting for %s response", label)
	}
	return nil
}

// r240WaitBackendBlockedBy 轮询 pg_stat_activity,直到出现被 blockerPID 阻塞的
// 后端,返回其 pid、wait_event_type 和当前 SQL。QueryRow 本身受同 deadline 的
// Context 约束,等待的是明确状态,不依赖固定 sleep。
func r240WaitBackendBlockedBy(t *testing.T, database *pgxpool.Pool, blockerPID uint32, timeout time.Duration) (uint32, string, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	deadline := time.Now().Add(timeout)
	for {
		var pid uint32
		var waitType, query string
		err := database.QueryRow(ctx, `
			SELECT pid, wait_event_type, left(query, 240)
			FROM pg_stat_activity
			WHERE datname = current_database()
			  AND pid <> pg_backend_pid()
			  AND pg_blocking_pids(pid) @> ARRAY[$1::int]
			LIMIT 1
		`, int32(blockerPID)).Scan(&pid, &waitType, &query)
		if err == nil {
			return pid, waitType, query
		}
		if errors.Is(err, pgx.ErrNoRows) {
			if !time.Now().Before(deadline) {
				t.Fatalf("no backend became blocked by %d within %s", blockerPID, timeout)
			}
			time.Sleep(25 * time.Millisecond)
			continue
		}
		if errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("no backend became blocked by %d within %s", blockerPID, timeout)
		}
		t.Fatalf("inspecting pg_stat_activity: %v", err)
	}
}

//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// TestV3IndexGenerationRebuildResetsAttempts 驱动同一个片段集合走过三轮索引代次：
// 初建、两次“停用再启用”触发的重建。generation 重建必须把行级 attempt 归零，
// 否则第三次 claim 的 attempt+1 会超出迁移 008 的 CHECK 上限并以内部失败告终。
// 三轮全部执行完后再统一断言，失败信息携带各轮 claim 状态与 attempt 证据。
func TestV3IndexGenerationRebuildResetsAttempts(t *testing.T) {
	h := newV3Harness(t)
	seedV3Knowledge(t, h.database, "重建尝试合成知识一", "第一组用于重建尝试轮次的合成内容", "normal")
	seedV3Knowledge(t, h.database, "重建尝试合成知识二", "第二组用于重建尝试轮次的合成内容", "normal")

	type rebuildRound struct {
		claimStatus int
		claimCode   string
		generation  int64
		policy      string
		attempts    []int
		indexStatus string
	}
	roundLabels := []string{"第1轮(初建)", "第2轮(第一次重建)", "第3轮(第二次重建)"}
	summarize := func(rounds []rebuildRound) string {
		summary := make([]string, 0, len(rounds))
		for index, round := range rounds {
			summary = append(summary, fmt.Sprintf("%s claim=%d code=%q generation=%d policy=%s attempts=%v indexStatus=%q",
				roundLabels[index], round.claimStatus, round.claimCode, round.generation, round.policy, round.attempts, round.indexStatus))
		}
		return strings.Join(summary, " | ")
	}

	// runIndexRound 执行单轮 claim/complete/状态检查；claim 非 200 只记录并跳过后续步骤。
	runIndexRound := func(round *rebuildRound) {
		h.assistant.RunOnce(context.Background())
		claim := h.internalPost(t, "/internal/assistant/index/claim", map[string]any{"workerId": "rebuild-attempt-worker"})
		round.claimStatus = claim.StatusCode
		if claim.StatusCode != http.StatusOK {
			status, code := v3Error(t, claim)
			round.claimStatus, round.claimCode = status, code
			return
		}
		var batch struct {
			Generation int64  `json:"generation"`
			Policy     string `json:"policy"`
			Fragments  []struct {
				FragmentID      string `json:"fragmentId"`
				Attempt         int    `json:"attempt"`
				SourceCreatedAt string `json:"sourceCreatedAt"`
				Sensitivity     string `json:"sensitivity"`
			} `json:"fragments"`
		}
		if err := json.NewDecoder(claim.Body).Decode(&batch); err != nil {
			claim.Body.Close()
			t.Fatalf("claim 响应解码失败: %v", err)
		}
		claim.Body.Close()
		round.generation = batch.Generation
		round.policy = batch.Policy
		results := make([]map[string]any, 0, len(batch.Fragments))
		for _, fragment := range batch.Fragments {
			round.attempts = append(round.attempts, fragment.Attempt)
			results = append(results, map[string]any{
				"fragmentId": fragment.FragmentID, "leaseVersion": fragment.Attempt,
				"sourceCreatedAt": fragment.SourceCreatedAt, "sensitivity": fragment.Sensitivity,
				"dimensions": 4, "embedding": []float64{0.5, 0.5, 0.5, 0.5},
			})
		}
		complete := h.internalPost(t, "/internal/assistant/index/complete", map[string]any{
			"workerId": "rebuild-attempt-worker", "generation": batch.Generation,
			"policy": batch.Policy, "results": results,
		})
		assertStatus(t, complete, http.StatusNoContent)
		complete.Body.Close()
		h.assistant.RunOnce(context.Background())
		response := h.get(t, "/api/v1/assistant/index-status")
		assertStatus(t, response, http.StatusOK)
		var status struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
			response.Body.Close()
			t.Fatalf("index-status 响应解码失败: %v", err)
		}
		response.Body.Close()
		round.indexStatus = status.Status
	}

	rounds := make([]rebuildRound, 3)

	// 第 1 轮（初建）：首次启用向量配置，入队全部片段。
	configure := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "合成向量", "baseUrl": "https://embed.example/v1",
		"apiKey": "embedding-test-secret", "modelId": "mock-embed", "dimensions": 4,
		"enabled": true, "confirmReindex": true,
	})
	assertStatus(t, configure, http.StatusOK)
	configure.Body.Close()
	runIndexRound(&rounds[0])

	// 第 2、3 轮（重建）：停用把行置 excluded，再启用经代次重建重新入队。
	for index := 1; index <= 2; index++ {
		disable := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
			"displayName": "合成向量", "baseUrl": "https://embed.example/v1",
			"apiKey": nil, "modelId": "mock-embed", "dimensions": 4,
			"enabled": false, "confirmReindex": false,
		})
		assertStatus(t, disable, http.StatusOK)
		disable.Body.Close()
		enable := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
			"displayName": "合成向量", "baseUrl": "https://embed.example/v1",
			"apiKey": nil, "modelId": "mock-embed", "dimensions": 4,
			"enabled": true, "confirmReindex": true,
		})
		assertStatus(t, enable, http.StatusOK)
		enable.Body.Close()
		runIndexRound(&rounds[index])
	}

	// 收尾断言 1：三轮 claim 全部成功。
	for _, round := range rounds {
		if round.claimStatus != http.StatusOK {
			t.Fatalf("三轮 claim 应全部 200，实际各轮结果: %s", summarize(rounds))
		}
	}
	// 收尾断言 2：generation 重建后每轮片段 attempt 都应回到 1（leaseVersion==1）。
	for index, round := range rounds {
		for _, attempt := range round.attempts {
			if attempt != 1 {
				t.Fatalf("%s 片段 attempt 应为 1，实际各轮结果: %s", roundLabels[index], summarize(rounds))
			}
		}
	}
	// 收尾断言 3：每轮 claim 成功后索引终态均为 ready。
	for index, round := range rounds {
		if round.indexStatus != "ready" {
			t.Fatalf("%s 索引终态应为 ready，实际各轮结果: %s", roundLabels[index], summarize(rounds))
		}
	}
}

//go:build integration

package integration_test

// Regression for the index claim credential boundary: when the embedding
// ciphertext is missing or undecryptable, the claim must fail closed with the
// existing internal failure response instead of returning a 200 with an empty
// API key. Failed claims must not commit running leases and must not consume
// fragment attempts. A restored credential claims normally.

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestV3IndexClaimFailsClosedOnUnusableCredential(t *testing.T) {
	h := newV3Harness(t)
	seedV3Knowledge(t, h.database, "凭据失败合成知识", "凭据失败场景的合成正文内容", "normal")

	configure := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "合成向量", "baseUrl": "https://embed.example/v1",
		"apiKey": "embedding-test-secret", "modelId": "mock-embed", "dimensions": 4,
		"enabled": true, "confirmReindex": true,
	})
	assertStatus(t, configure, http.StatusOK)
	configure.Body.Close()
	h.assistant.RunOnce(context.Background())

	type claimBatch struct {
		Generation int64  `json:"generation"`
		Policy     string `json:"policy"`
		APIKey     string `json:"apiKey"`
		Fragments  []struct {
			FragmentID string `json:"fragmentId"`
			Attempt    int    `json:"attempt"`
		} `json:"fragments"`
	}
	assertPendingLeasesUntouched := func(stage string) {
		t.Helper()
		var pending, running, maxAttempt int
		if err := h.database.QueryRow(context.Background(), `
			SELECT count(*) FILTER (WHERE state = 'pending'),
			       count(*) FILTER (WHERE state = 'running'),
			       COALESCE(max(attempt), 0)
			FROM assistant_fragment_embeddings
		`).Scan(&pending, &running, &maxAttempt); err != nil {
			t.Fatal(err)
		}
		if pending != 1 || running != 0 || maxAttempt != 0 {
			t.Fatalf("%s: 领取失败不得留下 running 租约或消耗 attempt（pending=%d running=%d attempt=%d）", stage, pending, running, maxAttempt)
		}
	}

	// 场景一：配置为 enabled 但密文为 NULL。
	if _, err := h.database.Exec(context.Background(),
		`UPDATE assistant_embedding_config SET api_key_ciphertext = NULL WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	missingResponse := h.internalPost(t, "/internal/assistant/index/claim", map[string]any{"workerId": "credential-worker"})
	missingStatus, missingCode := v3Error(t, missingResponse)
	if missingStatus != http.StatusInternalServerError || missingCode != "INTERNAL_ERROR" {
		t.Fatalf("密文缺失的 claim 应为 500 INTERNAL_ERROR，实际 %d %s", missingStatus, missingCode)
	}
	assertPendingLeasesUntouched("密文缺失")

	// 场景二：密文存在但无法用主密钥解密。
	if _, err := h.database.Exec(context.Background(),
		`UPDATE assistant_embedding_config SET api_key_ciphertext = '\x00ff10ee'::bytea WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	corruptResponse := h.internalPost(t, "/internal/assistant/index/claim", map[string]any{"workerId": "credential-worker"})
	corruptStatus, corruptCode := v3Error(t, corruptResponse)
	if corruptStatus != http.StatusInternalServerError || corruptCode != "INTERNAL_ERROR" {
		t.Fatalf("密文损坏的 claim 应为 500 INTERNAL_ERROR，实际 %d %s", corruptStatus, corruptCode)
	}
	assertPendingLeasesUntouched("密文损坏")

	// 恢复有效凭据后领取正常，attempt 恰好消耗一次。
	restore := h.put(t, "/api/v1/assistant/embedding-settings", map[string]any{
		"displayName": "合成向量", "baseUrl": "https://embed.example/v1",
		"apiKey": "embedding-test-secret", "modelId": "mock-embed", "dimensions": 4,
		"enabled": true, "confirmReindex": false,
	})
	assertStatus(t, restore, http.StatusOK)
	restore.Body.Close()
	h.assistant.RunOnce(context.Background())

	validResponse := h.internalPost(t, "/internal/assistant/index/claim", map[string]any{"workerId": "credential-worker"})
	assertStatus(t, validResponse, http.StatusOK)
	var validBatch claimBatch
	if err := json.NewDecoder(validResponse.Body).Decode(&validBatch); err != nil {
		validResponse.Body.Close()
		t.Fatalf("正常 claim 响应解码失败: %v", err)
	}
	validResponse.Body.Close()
	if validBatch.APIKey == "" {
		t.Fatal("有效凭据的 claim 必须携带 APIKey")
	}
	if len(validBatch.Fragments) == 0 {
		t.Fatal("有效凭据的 claim 应返回待索引片段")
	}
	for _, fragment := range validBatch.Fragments {
		if fragment.Attempt != 1 {
			t.Fatalf("恢复后首次领取 attempt 应为 1，实际 %d", fragment.Attempt)
		}
	}
}

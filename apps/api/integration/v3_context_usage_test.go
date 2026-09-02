//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/assistant"
	"github.com/jackc/tern/v2/migrate"
)

func TestV3ContextUsageTerminalRoundtrip(t *testing.T) {
	h := newV3Harness(t)
	_, modelID := h.createProviderModel(t, []map[string]any{})
	for _, operation := range []string{"complete", "fail", "legacy-complete"} {
		t.Run(operation, func(t *testing.T) {
			start := h.post(t, "/api/v1/assistant/runs", map[string]any{
				"clientRequestId": uuid.New(), "conversationId": nil,
				"content": "合成上下文计量", "modelId": modelID, "reasoning": "off",
			})
			assertStatus(t, start, http.StatusAccepted)
			start.Body.Close()
			claim := h.internalPost(t, "/internal/assistant/runs/claim", map[string]any{"workerId": "context-test"})
			assertStatus(t, claim, http.StatusOK)
			var claimed struct {
				Run struct {
					ID           string
					LeaseVersion int
				} `json:"run"`
			}
			if err := json.NewDecoder(claim.Body).Decode(&claimed); err != nil {
				t.Fatal(err)
			}
			claim.Body.Close()
			usage := map[string]any{"answerInputTokens": 20, "answerOutputTokens": 5}
			if operation != "legacy-complete" {
				usage["answerContextTokens"] = 100
			}
			path := strings.TrimPrefix(operation, "legacy-")
			payload := map[string]any{
				"workerId": "context-test", "leaseVersion": claimed.Run.LeaseVersion,
				"usage": usage, "timings": map[string]any{},
			}
			if path == "fail" {
				payload["errorCode"] = "ASSISTANT_PROVIDER_UNAVAILABLE"
				payload["errorDetail"] = "synthetic failure"
			}
			terminal := h.internalPost(t, "/internal/assistant/runs/"+claimed.Run.ID+"/"+path, payload)
			assertStatus(t, terminal, http.StatusOK)
			terminal.Body.Close()
			response := h.get(t, "/api/v1/assistant/runs/"+claimed.Run.ID)
			assertStatus(t, response, http.StatusOK)
			var run assistant.AssistantRunDTO
			if err := json.NewDecoder(response.Body).Decode(&run); err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if operation == "legacy-complete" {
				if run.Usage.AnswerContextTokens != nil {
					t.Fatal("old worker usage must not be backfilled")
				}
			} else if run.Usage.AnswerContextTokens == nil || *run.Usage.AnswerContextTokens != 100 {
				t.Fatal("complete input usage was not persisted")
			}
			if run.Usage.AnswerInputTokens == nil || *run.Usage.AnswerInputTokens != 20 || run.Model.ContextWindow != 32768 {
				t.Fatal("raw usage or model snapshot changed unexpectedly")
			}
		})
	}
	t.Run("migration-preserves-history", func(t *testing.T) {
		ctx := context.Background()
		connection, err := h.database.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Release()
		migrator, err := migrate.NewMigrator(ctx, connection.Conn(), "public.schema_version")
		if err != nil {
			t.Fatal(err)
		}
		if err := migrator.LoadMigrations(os.DirFS("../migrations")); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := migrator.MigrateTo(ctx, 9); err != nil {
				t.Error(err)
			}
		}()
		if err := migrator.MigrateTo(ctx, 8); err != nil {
			t.Fatal(err)
		}
		var preserved int
		if err := connection.QueryRow(ctx, `SELECT count(*) FROM assistant_runs WHERE answer_input_tokens = 20`).Scan(&preserved); err != nil || preserved != 3 {
			t.Fatal("schema 8 rollback changed historical input usage")
		}
		if err := migrator.MigrateTo(ctx, 9); err != nil {
			t.Fatal(err)
		}
		if err := connection.QueryRow(ctx, `SELECT count(*) FROM assistant_runs WHERE answer_input_tokens = 20 AND answer_context_tokens IS NULL`).Scan(&preserved); err != nil || preserved != 3 {
			t.Fatal("schema 9 must preserve history without inventing cache counts")
		}
	})
}

func TestV3TemporaryContextUsageSnapshot(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/assistant/temporary/stream" {
			t.Error("unexpected worker call")
			response.WriteHeader(404)
			return
		}
		response.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(response, "event: usage.updated\ndata: {\"usage\":{\"answerContextTokens\":100,\"answerInputTokens\":20,\"answerOutputTokens\":5}}\n\n")
		io.WriteString(response, "event: run.completed\ndata: {\"status\":\"succeeded\",\"usage\":{\"answerContextTokens\":100,\"answerInputTokens\":20,\"answerOutputTokens\":5},\"timings\":{},\"error\":null,\"temporarySummary\":null}\n\n")
	}))
	defer worker.Close()
	h := newV3Harness(t, worker.URL)
	_, modelID := h.createProviderModel(t, []map[string]any{})
	response := h.post(t, "/api/v1/assistant/temporary/stream", map[string]any{
		"clientRequestId": uuid.New(), "modelId": modelID, "reasoning": "off", "content": "合成临时统计", "messages": []any{}, "summary": nil,
	})
	assertStatus(t, response, http.StatusOK)
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	stream := string(body)
	if !strings.Contains(stream, `"contextWindow":32768`) || !strings.Contains(stream, "event: run.completed") || strings.Count(stream, `"answerContextTokens":100`) != 2 {
		t.Fatalf("temporary public stream lost model snapshot or usage: %s", stream)
	}
	if strings.Contains(stream, "v3-provider-secret") || strings.Contains(stream, "baseUrl") {
		t.Fatal("temporary model snapshot exposed provider credentials or address")
	}
	var runs int
	if err := h.database.QueryRow(context.Background(), `SELECT count(*) FROM assistant_runs`).Scan(&runs); err != nil || runs != 0 {
		t.Fatal("temporary context measurement must not create a persisted run")
	}
}

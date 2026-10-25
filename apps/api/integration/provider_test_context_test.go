//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProviderConnectionResultBelongsToTestedConfiguration(t *testing.T) {
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

	cases := []struct {
		name             string
		patch            map[string]any
		firstCredentials bool
		preserveFirst    bool
	}{
		{name: "changed_connection_success", patch: map[string]any{"baseUrl": "https://provider.example.test/v2"}},
		{name: "replaced_key_credentials", patch: map[string]any{"apiKey": "replacement-synthetic-provider-secret"}, firstCredentials: true},
		{name: "display_name_only", patch: map[string]any{"displayName": "Renamed snapshot fixture"}, preserveFirst: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			resetM3Database(t, database)
			defer resetM3Database(t, database)
			entered := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			var calls atomic.Int32
			worker := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				call := calls.Add(1)
				if call == 1 {
					close(entered)
					select {
					case <-release:
					case <-request.Context().Done():
						return
					}
				}
				response.Header().Set("Content-Type", "application/json")
				if call == 1 && testCase.firstCredentials {
					response.WriteHeader(http.StatusUnprocessableEntity)
					_ = json.NewEncoder(response).Encode(map[string]any{"status": "failed", "latencyMs": 2, "usage": nil, "failureCategory": "credentials_invalid"})
					return
				}
				_ = json.NewEncoder(response).Encode(map[string]any{"status": "ok", "latencyMs": 7, "usage": nil})
			}))
			defer worker.Close()
			server, client, csrf := newAuthenticatedM3Server(t, database, t.TempDir(), worker.URL)
			defer server.Close()
			defer releaseOnce.Do(func() { close(release) })

			created := sendJSON(t, client, http.MethodPost, server.URL+"/api/v1/ai/providers", map[string]any{
				"providerKey": "snapshot-fixture", "displayName": "Snapshot fixture", "protocol": "openai-completions",
				"baseUrl": "https://provider.example.test/v1", "apiKey": m3ProviderKey,
				"models": []map[string]any{{"modelId": "snapshot-model", "displayName": "Snapshot model", "contextWindow": 8192, "maxOutputTokens": 1024, "supportsTools": true}},
			}, csrf)
			assertStatus(t, created, http.StatusCreated)
			provider := decodeResponse[m3ProviderResponse](t, created)
			if len(provider.Models) != 1 {
				t.Fatal("fixture model was not created")
			}
			endpoint := server.URL + "/api/v1/ai/providers/" + provider.ID.String() + "/test"
			payload := map[string]any{"modelId": provider.Models[0].ID.String()}
			encoded, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			request := newRequest(t, http.MethodPost, endpoint, bytes.NewReader(encoded), csrf, "application/json")
			type requestResult struct {
				status int
				err    error
			}
			completed := make(chan requestResult, 1)
			go func() {
				response, requestErr := client.Do(request)
				if requestErr != nil {
					completed <- requestResult{err: requestErr}
					return
				}
				_, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
				_ = response.Body.Close()
				completed <- requestResult{status: response.StatusCode, err: readErr}
			}()
			select {
			case <-entered:
			case result := <-completed:
				t.Fatalf("provider test returned before reaching the fixture: status=%d error=%v", result.status, result.err)
			case <-time.After(5 * time.Second):
				t.Fatal("provider test did not reach the local worker fixture")
			}

			changed := sendJSON(t, client, http.MethodPatch, server.URL+"/api/v1/ai/providers/"+provider.ID.String(), testCase.patch, csrf)
			assertStatus(t, changed, http.StatusOK)
			_ = readResponse(t, changed)
			releaseOnce.Do(func() { close(release) })
			select {
			case result := <-completed:
				want := http.StatusOK
				if testCase.firstCredentials {
					want = http.StatusUnprocessableEntity
				}
				if result.err != nil || result.status != want {
					t.Fatalf("original probe changed its HTTP outcome: status=%d want=%d error=%v", result.status, want, result.err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("released provider test did not finish")
			}

			var testedAt *time.Time
			var status *string
			if err := database.QueryRow(ctx, "SELECT last_tested_at, last_test_status FROM provider_configs WHERE id = $1", provider.ID).Scan(&testedAt, &status); err != nil {
				t.Fatal(err)
			}
			if testCase.preserveFirst {
				if testedAt == nil || status == nil || *status != "ok" {
					t.Fatal("display-only update discarded a current connection result")
				}
			} else if testedAt != nil || status != nil {
				t.Fatal("old probe restored a connection result after the connection configuration changed")
			}

			fresh := sendJSON(t, client, http.MethodPost, endpoint, payload, csrf)
			assertStatus(t, fresh, http.StatusOK)
			_ = readResponse(t, fresh)
			if err := database.QueryRow(ctx, "SELECT last_tested_at, last_test_status FROM provider_configs WHERE id = $1", provider.ID).Scan(&testedAt, &status); err != nil {
				t.Fatal(err)
			}
			if testedAt == nil || status == nil || *status != "ok" || calls.Load() != 2 {
				t.Fatalf("fresh connection result was not recorded exactly once, fixture calls=%d", calls.Load())
			}
		})
	}
}

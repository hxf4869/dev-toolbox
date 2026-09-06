package operations

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVersionReportsInjectedCommitOverEnvironment(t *testing.T) {
	buildCommit = "build-injected-sha"
	t.Cleanup(func() { buildCommit = "" })
	t.Setenv("GIT_COMMIT", "environment-sha")
	t.Setenv("APP_VERSION", "3.0.0-test")

	router := http.NewServeMux()
	RegisterRoutes(router, fakePinger{})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/version", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", response.Header().Get("Cache-Control"))
	}
	var payload map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["apiVersion"] != "v1" {
		t.Fatalf("apiVersion = %q, want v1", payload["apiVersion"])
	}
	if payload["appVersion"] != "3.0.0-test" {
		t.Fatalf("appVersion = %q, want 3.0.0-test", payload["appVersion"])
	}
	if payload["commit"] != "build-injected-sha" {
		t.Fatalf("commit = %q, want build-injected-sha", payload["commit"])
	}
}

func TestVersionFallsBackToUnknownWithoutInjection(t *testing.T) {
	t.Setenv("GIT_COMMIT", "")
	t.Setenv("APP_VERSION", "")

	router := http.NewServeMux()
	RegisterRoutes(router, fakePinger{})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/version", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var payload map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["commit"] != "unknown" {
		t.Fatalf("commit = %q, want unknown", payload["commit"])
	}
	if payload["appVersion"] != "development" {
		t.Fatalf("appVersion = %q, want development", payload["appVersion"])
	}
	if payload["apiVersion"] != "v1" {
		t.Fatalf("apiVersion = %q, want v1", payload["apiVersion"])
	}
}

func TestVersionUsesEnvironmentCommitWhenBuildInjectionMissing(t *testing.T) {
	buildCommit = ""
	t.Setenv("GIT_COMMIT", "environment-only-sha")

	router := http.NewServeMux()
	RegisterRoutes(router, fakePinger{})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/version", nil))

	var payload map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["commit"] != "environment-only-sha" {
		t.Fatalf("commit = %q, want environment-only-sha", payload["commit"])
	}
}

package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestLogUsesRequestIDAndRouteTemplate(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	router := http.NewServeMux()
	router.HandleFunc("POST /api/search", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})
	handler := RequestID(RequestLog(logger, router))
	request := httptest.NewRequest(http.MethodPost, "/api/search?q=Token-secret", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	requestID := response.Header().Get("X-Request-ID")
	if !strings.HasPrefix(requestID, "req_") {
		t.Fatalf("X-Request-ID = %q", requestID)
	}
	logLine := output.String()
	if !strings.Contains(logLine, `"requestId":"`+requestID+`"`) {
		t.Fatalf("log does not contain request ID: %s", logLine)
	}
	if !strings.Contains(logLine, `"route":"POST /api/search"`) {
		t.Fatalf("log does not contain route template: %s", logLine)
	}
	if strings.Contains(logLine, "Token-secret") || strings.Contains(logLine, "q=") {
		t.Fatalf("log contains query input: %s", logLine)
	}
}

func TestRequestIDAcceptsSanitizedGatewayValue(t *testing.T) {
	handler := RequestID(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		if got := RequestIDFromContext(request.Context()); got != "gateway-request_123" {
			t.Fatalf("request ID = %q", got)
		}
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Request-ID", "gateway-request_123")

	handler.ServeHTTP(httptest.NewRecorder(), request)
}

func TestRequestIDRejectsUnsafeHeaderValue(t *testing.T) {
	handler := RequestID(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		if got := RequestIDFromContext(request.Context()); !strings.HasPrefix(got, "req_") {
			t.Fatalf("request ID = %q", got)
		}
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Request-ID", "unsafe value\nnext")

	handler.ServeHTTP(httptest.NewRecorder(), request)
}

package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
	"unicode"
)

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusWriter) WriteHeader(status int) {
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *statusWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

// FlushError forwards a real flush failure (broken client, proxy disconnect)
// to callers such as http.ResponseController. Implementing it is required:
// ResponseController prefers FlushError over the no-return-value Flush and
// never unwraps past a Flush implementation, so without this method the
// logging wrapper would swallow transport errors from SSE streams.
func (writer *statusWriter) FlushError() error {
	return http.NewResponseController(writer.ResponseWriter).Flush()
}

func (writer *statusWriter) Flush() {
	_ = writer.FlushError()
}

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestID := strings.TrimSpace(request.Header.Get("X-Request-ID"))
		if !validRequestID(requestID) {
			requestID = newRequestID()
		}
		response.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(response, request.WithContext(withRequestID(request.Context(), requestID)))
	})
}

func validRequestID(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if unicode.IsLetter(character) || unicode.IsDigit(character) || character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func RequestLog(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		started := time.Now()
		writer := &statusWriter{ResponseWriter: response, status: http.StatusOK}
		route := routePattern(next, request)
		next.ServeHTTP(writer, request)
		logger.InfoContext(
			request.Context(),
			"http_request",
			"requestId", RequestIDFromContext(request.Context()),
			"method", request.Method,
			"route", route,
			"status", writer.status,
			"durationMs", time.Since(started).Milliseconds(),
		)
	})
}

type routeMatcher interface {
	Handler(*http.Request) (http.Handler, string)
}

func routePattern(next http.Handler, request *http.Request) string {
	if request.Pattern != "" {
		return request.Pattern
	}
	if matcher, ok := next.(routeMatcher); ok {
		_, pattern := matcher.Handler(request)
		if pattern != "" {
			return pattern
		}
	}
	return "unmatched"
}

func Recover(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.ErrorContext(
					request.Context(),
					"http_panic",
					"requestId", RequestIDFromContext(request.Context()),
					"errorType", "panic",
					"stackBytes", len(debug.Stack()),
				)
				WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			}
		}()
		next.ServeHTTP(response, request)
	})
}

func newRequestID() string {
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return "req_unavailable"
	}
	return "req_" + hex.EncodeToString(random)
}

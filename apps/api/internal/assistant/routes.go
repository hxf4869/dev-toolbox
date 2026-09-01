package assistant

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

// RegisterRoutes wires every assistant endpoint. The integrator calls it once
// from cmd/server/main.go after authService construction:
//
//	assistantService.RegisterRoutes(router, authService)
//	go assistantService.Run(ctx, logger)
func (service *Service) RegisterRoutes(router *http.ServeMux, authService *auth.Service) {
	// Bootstrap, embedding settings and index status/failures.
	router.Handle("GET /api/v1/assistant/bootstrap", authService.Authenticate(http.HandlerFunc(service.bootstrap)))
	router.Handle("GET /api/v1/assistant/embedding-settings", authService.Authenticate(http.HandlerFunc(service.getEmbeddingSettings)))
	router.Handle("PUT /api/v1/assistant/embedding-settings", authService.AuthenticateMutation(http.HandlerFunc(service.putEmbeddingSettings)))
	router.Handle("DELETE /api/v1/assistant/embedding-settings", authService.AuthenticateMutation(http.HandlerFunc(service.deleteEmbeddingSettings)))
	router.Handle("POST /api/v1/assistant/embedding-settings/test", authService.AuthenticateMutation(http.HandlerFunc(service.testEmbeddingSettings)))
	router.Handle("GET /api/v1/assistant/index-status", authService.Authenticate(http.HandlerFunc(service.getIndexStatus)))
	router.Handle("GET /api/v1/assistant/index-failures", authService.Authenticate(http.HandlerFunc(service.listIndexFailures)))
	router.Handle("POST /api/v1/assistant/index-failures/{fragmentId}/retry", authService.AuthenticateMutation(http.HandlerFunc(service.retryIndexFailure)))
	// Folders, conversations, messages.
	router.Handle("GET /api/v1/assistant/folders", authService.Authenticate(http.HandlerFunc(service.listFolders)))
	router.Handle("POST /api/v1/assistant/folders", authService.AuthenticateMutation(http.HandlerFunc(service.createFolder)))
	router.Handle("PATCH /api/v1/assistant/folders/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.patchFolder)))
	router.Handle("DELETE /api/v1/assistant/folders/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.deleteFolder)))
	router.Handle("GET /api/v1/assistant/conversations", authService.Authenticate(http.HandlerFunc(service.listConversations)))
	router.Handle("GET /api/v1/assistant/conversations/{id}", authService.Authenticate(http.HandlerFunc(service.getConversation)))
	router.Handle("PATCH /api/v1/assistant/conversations/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.patchConversation)))
	router.Handle("DELETE /api/v1/assistant/conversations/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.deleteConversation)))
	router.Handle("GET /api/v1/assistant/conversations/{id}/messages", authService.Authenticate(http.HandlerFunc(service.listMessages)))
	// Runs.
	router.Handle("POST /api/v1/assistant/runs", authService.AuthenticateMutation(http.HandlerFunc(service.createRun)))
	router.Handle("GET /api/v1/assistant/runs/{id}", authService.Authenticate(http.HandlerFunc(service.getRun)))
	router.Handle("POST /api/v1/assistant/runs/{id}/stop", authService.AuthenticateMutation(http.HandlerFunc(service.stopRun)))
	router.Handle("POST /api/v1/assistant/runs/{id}/retry", authService.AuthenticateMutation(http.HandlerFunc(service.retryRun)))
	router.Handle("GET /api/v1/assistant/runs/{id}/events", authService.Authenticate(http.HandlerFunc(service.runEventsStream)))
	router.Handle("GET /api/v1/assistant/runs/{id}/sources/{citationNumber}", authService.Authenticate(http.HandlerFunc(service.sourceDetail)))
	// Temporary ephemeral stream.
	router.Handle("POST /api/v1/assistant/temporary/stream", authService.AuthenticateMutation(http.HandlerFunc(service.temporaryStream)))
	// Internal worker API: never exposed through Caddy.
	router.Handle("POST /internal/assistant/runs/claim", service.internalOnly(http.HandlerFunc(service.claimRun)))
	router.Handle("POST /internal/assistant/runs/{id}/heartbeat", service.internalOnly(http.HandlerFunc(service.heartbeatRun)))
	router.Handle("POST /internal/assistant/runs/{id}/retrieval", service.internalOnly(http.HandlerFunc(service.runRetrieval)))
	router.Handle("POST /internal/assistant/runs/{id}/events", service.internalOnly(http.HandlerFunc(service.appendRunEvents)))
	router.Handle("POST /internal/assistant/runs/{id}/complete", service.internalOnly(http.HandlerFunc(service.completeRun)))
	router.Handle("POST /internal/assistant/runs/{id}/fail", service.internalOnly(http.HandlerFunc(service.failRun)))
	router.Handle("POST /internal/assistant/runs/{id}/title", service.internalOnly(http.HandlerFunc(service.runTitle)))
	router.Handle("POST /internal/assistant/runs/{id}/summary", service.internalOnly(http.HandlerFunc(service.runSummary)))
	router.Handle("POST /internal/assistant/index/claim", service.internalOnly(http.HandlerFunc(service.claimIndexBatch)))
	router.Handle("POST /internal/assistant/index/heartbeat", service.internalOnly(http.HandlerFunc(service.heartbeatIndex)))
	router.Handle("POST /internal/assistant/index/complete", service.internalOnly(http.HandlerFunc(service.completeIndexBatch)))
	router.Handle("POST /internal/assistant/index/fail", service.internalOnly(http.HandlerFunc(service.failIndexBatch)))
	// Temporary prepare/stream and the embedding probe are worker-hosted
	// endpoints; the Go API calls them outbound and therefore registers nothing
	// here for them.
}

func (service *Service) internalOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		httpapi.NoStore(response)
		header := request.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") || !constantTimeTokenEqual(strings.TrimPrefix(header, "Bearer "), service.internalServiceToken) {
			httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "内部服务凭据无效")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func constantTimeTokenEqual(supplied, expected string) bool {
	suppliedHash := sha256.Sum256([]byte(supplied))
	expectedHash := sha256.Sum256([]byte(expected))
	return supplied != "" && subtle.ConstantTimeCompare(suppliedHash[:], expectedHash[:]) == 1
}

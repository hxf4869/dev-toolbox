package ai

import (
	"net/http"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	artifactcontract "github.com/hxf4869/dev-toolbox/apps/api/internal/ai/schema"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
)

type Service struct {
	database                  *pgxpool.Pool
	masterKey                 []byte
	artifactValidator         *artifactcontract.Validator
	workerURL                 string
	attachmentRoot            string
	internalServiceToken      string
	allowInsecureProviderHTTP bool
	httpClient                *http.Client
	now                       func() time.Time
}

func NewService(
	database *pgxpool.Pool,
	masterKey []byte,
	validator *artifactcontract.Validator,
	workerURL, internalServiceToken, attachmentRoot string,
	allowInsecureProviderHTTP bool,
) *Service {
	return &Service{
		database: database, masterKey: append([]byte(nil), masterKey...), artifactValidator: validator,
		workerURL: workerURL, internalServiceToken: internalServiceToken,
		attachmentRoot:            filepath.Clean(attachmentRoot),
		allowInsecureProviderHTTP: allowInsecureProviderHTTP,
		httpClient:                &http.Client{Timeout: 12 * time.Second}, now: time.Now,
	}
}

func (service *Service) RegisterRoutes(router *http.ServeMux, authService *auth.Service) {
	router.Handle("GET /api/v1/ai/providers", authService.Authenticate(http.HandlerFunc(service.listProviders)))
	router.Handle("POST /api/v1/ai/providers", authService.AuthenticateMutation(http.HandlerFunc(service.createProvider)))
	router.Handle("PATCH /api/v1/ai/providers/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.updateProvider)))
	router.Handle("DELETE /api/v1/ai/providers/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.deleteProvider)))
	router.Handle("POST /api/v1/ai/providers/{id}/test", authService.AuthenticateMutation(http.HandlerFunc(service.testProvider)))
	router.Handle("POST /api/v1/ai/providers/{id}/models", authService.AuthenticateMutation(http.HandlerFunc(service.createModel)))
	router.Handle("PATCH /api/v1/ai/models/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.updateModel)))
	router.Handle("DELETE /api/v1/ai/models/{id}", authService.AuthenticateMutation(http.HandlerFunc(service.deleteModel)))
	router.Handle("GET /api/v1/ai/settings", authService.Authenticate(http.HandlerFunc(service.getSettings)))
	router.Handle("PUT /api/v1/ai/settings", authService.AuthenticateMutation(http.HandlerFunc(service.updateSettings)))
	router.Handle("POST /api/v1/items/{itemId}/artifacts", authService.AuthorizeMutation("artifacts:write")(http.HandlerFunc(service.createExternalArtifact)))
	router.Handle("GET /api/v1/items/{itemId}/artifacts", authService.Authorize("records:read")(http.HandlerFunc(service.listArtifacts)))
	router.Handle("GET /api/v1/artifacts/{id}", authService.Authorize("records:read")(http.HandlerFunc(service.getArtifact)))
	router.Handle("POST /api/v1/artifacts/{id}/activate", authService.AuthenticateMutation(http.HandlerFunc(service.activateArtifact)))
	router.Handle("POST /api/v1/artifacts/{id}/invalidate", authService.AuthenticateMutation(http.HandlerFunc(service.invalidateArtifact)))
	router.Handle("POST /api/v1/artifacts/{id}/apply-suggestions", authService.AuthenticateMutation(http.HandlerFunc(service.applyArtifactSuggestions)))
	router.Handle("POST /api/v1/ai/tasks", authService.AuthorizeMutation("tasks:run")(http.HandlerFunc(service.createTask)))
	router.Handle("GET /api/v1/ai/tasks", authService.Authorize("tasks:run")(http.HandlerFunc(service.listTasks)))
	router.Handle("GET /api/v1/ai/tasks/{id}", authService.Authorize("tasks:run")(http.HandlerFunc(service.getTask)))
	router.Handle("POST /api/v1/ai/tasks/{id}/cancel", authService.AuthorizeMutation("tasks:run")(http.HandlerFunc(service.cancelTask)))
	router.Handle("POST /api/v1/ai/tasks/{id}/retry", authService.AuthorizeMutation("tasks:run")(http.HandlerFunc(service.retryTask)))
	router.Handle("GET /api/v1/ai/schedule", authService.Authenticate(http.HandlerFunc(service.getSchedule)))
	router.Handle("PUT /api/v1/ai/schedule", authService.AuthenticateMutation(http.HandlerFunc(service.updateSchedule)))

	router.Handle("POST /internal/ai/tasks/claim", service.internalOnly(http.HandlerFunc(service.claimTask)))
	router.Handle("POST /internal/ai/tasks/{id}/heartbeat", service.internalOnly(http.HandlerFunc(service.heartbeatTask)))
	router.Handle("POST /internal/ai/tasks/{id}/events", service.internalOnly(http.HandlerFunc(service.appendTaskEvents)))
	router.Handle("POST /internal/ai/tasks/{id}/complete", service.internalOnly(http.HandlerFunc(service.completeTask)))
	router.Handle("POST /internal/ai/tasks/{id}/fail", service.internalOnly(http.HandlerFunc(service.failTask)))
	router.Handle("GET /internal/ai/tasks/{id}/attachments/{attachmentId}", service.internalOnly(http.HandlerFunc(service.getTaskAttachment)))
}

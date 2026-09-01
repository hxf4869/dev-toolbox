package aliyun

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
)

// Service owns the aliyun module: settings, quota ledger, queue, translation.
type Service struct {
	database   *pgxpool.Pool
	masterKey  []byte
	gateway    TranslationGateway
	ocrGateway OcrGateway
	queue      *queueManager
	now        func() time.Time
	startupRun bool
}

// Option is the seam used by tests (fake gateway, deterministic clock).
type Option func(*Service)

// WithTranslationGateway swaps the official SDK adapter for a test double.
func WithTranslationGateway(gateway TranslationGateway) Option {
	return func(service *Service) { service.gateway = gateway }
}

// WithOcrGateway swaps the official OCR SDK adapter for a test double.
func WithOcrGateway(gateway OcrGateway) Option {
	return func(service *Service) { service.ocrGateway = gateway }
}

// WithClock injects a deterministic clock for time-driven semantics.
func WithClock(now func() time.Time) Option {
	return func(service *Service) { service.now = now }
}

// NewService wires the aliyun module. main.go integrates it with
//
//	aliyunService := aliyun.NewService(pool, cfg.MasterKey)
//	aliyunService.RegisterRoutes(router, authService)
//
// The construction performs the one startup sweep of stale reservations
// required by docs/11 §5.4; failures are logged and do not abort startup.
func NewService(database *pgxpool.Pool, masterKey []byte, options ...Option) *Service {
	service := &Service{
		database:   database,
		masterKey:  append([]byte(nil), masterKey...),
		gateway:    NewSDKTranslationGateway(),
		ocrGateway: NewSDKOcrGateway(),
		now:        time.Now,
	}
	for _, option := range options {
		option(service)
	}
	service.queue = newQueueManager(1, 3, service.now)
	service.loadQueueLimits()
	service.runStartupRecovery()
	return service
}

// loadQueueLimits restores the persisted owner/global limits before the first
// ticket is accepted. Defaults remain in effect only when storage is absent or
// unavailable during startup.
func (service *Service) loadQueueLimits() {
	if service.database == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	snapshot, err := service.readSettings(ctx)
	if err != nil {
		slog.Default().Warn("aliyun_queue_limits_restore_failed", "errorType", "database")
		return
	}
	service.queue.UpdateLimits(int(snapshot.OwnerConcurrency), int(snapshot.GlobalConcurrency))
}

const settlementDeadline = 10 * time.Second

// settlementContext keeps the quota transaction alive after a client abort,
// while still bounding database work during shutdown or storage failure.
func settlementContext(requestContext context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(requestContext), settlementDeadline)
}

func (service *Service) runStartupRecovery() {
	if service.startupRun || service.database == nil {
		return
	}
	service.startupRun = true
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := service.recoverStaleReservations(ctx); err != nil {
		slog.ErrorContext(ctx, "aliyun_startup_recovery_failed", "errorType", "database")
	}
}

// RegisterRoutes mounts the docs/11 §7–§10 endpoints. All routes require the
// owner web session; mutations use AuthenticateMutation with the stable
// MUTATION_NOT_ALLOWED code (PATs are rejected).
func (service *Service) RegisterRoutes(router *http.ServeMux, authService *auth.Service) {
	service.runStartupRecovery()
	router.Handle("GET /api/v1/aliyun/settings", authService.Authenticate(http.HandlerFunc(service.handleGetSettings)))
	router.Handle("PUT /api/v1/aliyun/settings", authService.AuthenticateMutation(http.HandlerFunc(service.handleUpdateSettings), "MUTATION_NOT_ALLOWED"))
	router.Handle("DELETE /api/v1/aliyun/settings/credentials", authService.AuthenticateMutation(http.HandlerFunc(service.handleDeleteCredentials), "MUTATION_NOT_ALLOWED"))
	router.Handle("GET /api/v1/aliyun/usage/current", authService.Authenticate(http.HandlerFunc(service.handleCurrentUsage)))
	router.Handle("GET /api/v1/aliyun/translation/languages", authService.Authenticate(http.HandlerFunc(service.handleTranslationLanguages)))
	router.Handle("POST /api/v1/aliyun/preflight", authService.AuthenticateMutation(http.HandlerFunc(service.handlePreflight), "MUTATION_NOT_ALLOWED"))
	router.Handle("POST /api/v1/aliyun/queue-tickets", authService.AuthenticateMutation(http.HandlerFunc(service.handleCreateTicket), "MUTATION_NOT_ALLOWED"))
	router.Handle("GET /api/v1/aliyun/queue-tickets/{ticketId}", authService.Authenticate(http.HandlerFunc(service.handleGetTicket)))
	router.Handle("DELETE /api/v1/aliyun/queue-tickets/{ticketId}", authService.AuthenticateMutation(http.HandlerFunc(service.handleDeleteTicket), "MUTATION_NOT_ALLOWED"))
	router.Handle("POST /api/v1/aliyun/queue-tickets/{ticketId}/claim", authService.AuthenticateMutation(http.HandlerFunc(service.handleClaimTicket), "MUTATION_NOT_ALLOWED"))
	router.Handle("POST /api/v1/aliyun/translation/chunks", authService.AuthenticateMutation(http.HandlerFunc(service.handleTranslateChunk), "MUTATION_NOT_ALLOWED"))
	router.Handle("POST /api/v1/aliyun/ocr", authService.AuthenticateMutation(http.HandlerFunc(service.handleRecognizeOCR), "MUTATION_NOT_ALLOWED"))
}

// withSettingsTransaction runs one settings-owned transaction with the common
// lock order; the body decides the writes.
func (service *Service) withSettingsTransaction(
	ctx context.Context, body func(ctx context.Context, tx pgx.Tx) error,
) error {
	transaction, err := service.database.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(transaction)
	if err := body(ctx, transaction); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}

// ticketOwnerFromRequest resolves the caller for queue authorization.
func ticketOwnerFromRequest(request *http.Request) (uuid.UUID, bool) {
	actor, ok := auth.ActorFromContext(request.Context())
	if !ok {
		return uuid.Nil, false
	}
	return actor.OwnerID, true
}

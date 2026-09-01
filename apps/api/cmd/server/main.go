package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pgxvector "github.com/pgvector/pgvector-go/pgx"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/ai"
	artifactcontract "github.com/hxf4869/dev-toolbox/apps/api/internal/ai/schema"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/aliyun"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/assistant"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/knowledge"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/operations"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/config"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "api")
	slog.SetDefault(logger)
	cfg, err := config.Load()
	if err != nil {
		logger.Error("configuration_invalid", "errorType", "configuration")
		os.Exit(1)
	}

	schemaBytes, err := os.ReadFile(cfg.ArtifactSchemaPath)
	if err != nil {
		logger.Error("artifact_schema_unavailable", "errorType", "filesystem")
		os.Exit(1)
	}
	artifactValidator, err := artifactcontract.New(schemaBytes)
	if err != nil {
		logger.Error("artifact_schema_invalid", "errorType", "schema")
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		logger.Error("database_pool_failed", "errorType", "database")
		os.Exit(1)
	}
	poolConfig.AfterConnect = func(connectionContext context.Context, connection *pgx.Conn) error {
		return pgxvector.RegisterTypes(connectionContext, connection)
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		logger.Error("database_pool_failed", "errorType", "database")
		os.Exit(1)
	}
	defer pool.Close()

	authService, err := auth.NewService(pool, cfg.MasterKey, cfg.AppOrigin, cfg.TrustedProxyCIDRs)
	if err != nil {
		logger.Error("auth_service_invalid", "errorType", "configuration")
		os.Exit(1)
	}
	knowledgeService, err := knowledge.NewService(pool, cfg.AttachmentRoot, cfg.AppTimezone)
	if err != nil {
		logger.Error("attachment_storage_unavailable", "errorType", "filesystem")
		os.Exit(1)
	}
	aiService := ai.NewService(
		pool, cfg.MasterKey, artifactValidator, cfg.AIWorkerURL, cfg.InternalServiceToken, cfg.AttachmentRoot,
		cfg.AllowInsecureProviderHTTP,
	)
	assistantService := assistant.NewService(
		pool, cfg.MasterKey, cfg.AIWorkerURL, cfg.InternalServiceToken, cfg.AllowInsecureProviderHTTP,
	)
	ai.SensitivePolicyChangeHook = assistantService.NotifySensitivePolicyChanged

	aliyunService := aliyun.NewService(pool, cfg.MasterKey)

	router := http.NewServeMux()
	operations.RegisterRoutes(router, pool)
	authService.RegisterRoutes(router)
	aliyunService.RegisterRoutes(router, authService)
	knowledgeService.RegisterRoutes(router, authService)
	aiService.RegisterRoutes(router, authService)
	assistantService.RegisterRoutes(router, authService)
	operations.NewStatusService(
		pool, cfg.AttachmentRoot, cfg.OperationsStatusRoot, cfg.AIWorkerURL, cfg.AppVersion,
	).RegisterRoutes(router, authService)
	go aiService.RunScheduler(ctx, logger)
	go assistantService.Run(ctx, logger)

	handler := httpapi.RequestID(httpapi.Recover(logger, httpapi.RequestLog(logger, router)))
	server := &http.Server{
		Addr:              cfg.HTTPAddress,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		// 45s Aliyun deadline + bounded settlement and response headroom.
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("api_started", "address", cfg.HTTPAddress)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		logger.Info("api_stopping", "signal", "shutdown")
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("api_stopped_unexpectedly", "errorType", "http_server")
			os.Exit(1)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("api_shutdown_failed", "errorType", "http_server")
		os.Exit(1)
	}
}

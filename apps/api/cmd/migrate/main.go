package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/tern/v2/migrate"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "api-migrate")
	cfg, err := config.LoadMigration()
	if err != nil {
		logger.Error("configuration_invalid", "errorType", "configuration")
		os.Exit(1)
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("database_connect_failed", "errorType", "database")
		os.Exit(1)
	}
	defer conn.Close(ctx)

	migrator, err := migrate.NewMigrator(ctx, conn, "public.schema_version")
	if err != nil {
		logger.Error("migration_initialize_failed", "errorType", "migration")
		os.Exit(1)
	}
	if err := migrator.LoadMigrations(os.DirFS(cfg.MigrationsPath)); err != nil {
		logger.Error("migration_load_failed", "errorType", "migration")
		os.Exit(1)
	}
	migrator.OnStart = func(sequence int32, name, direction, _ string) {
		logger.Info("migration_started", "sequence", sequence, "name", name, "direction", direction)
	}
	if err := migrator.Migrate(ctx); err != nil {
		logger.Error("migration_failed", "errorType", "migration")
		os.Exit(1)
	}
	logger.Info("migration_complete")
}

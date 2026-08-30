package main

import (
	"context"
	"flag"
	"log/slog"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/tern/v2/migrate"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "api-migrate")
	preflight := flag.Bool("preflight", false, "只读检查当前 Schema 与待应用迁移")
	flag.Parse()
	if flag.NArg() != 0 {
		logger.Error("migration_arguments_invalid", "errorType", "configuration")
		os.Exit(2)
	}
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
	if *preflight {
		var versionTableExists bool
		if err := conn.QueryRow(ctx, `SELECT to_regclass('public.schema_version') IS NOT NULL`).Scan(&versionTableExists); err != nil || !versionTableExists {
			logger.Error("migration_preflight_failed", "errorType", "migration")
			os.Exit(1)
		}
	}

	migrator, err := migrate.NewMigrator(ctx, conn, "public.schema_version")
	if err != nil {
		logger.Error("migration_initialize_failed", "errorType", "migration")
		os.Exit(1)
	}
	if err := migrator.LoadMigrations(os.DirFS(cfg.MigrationsPath)); err != nil {
		logger.Error("migration_load_failed", "errorType", "migration")
		os.Exit(1)
	}
	if *preflight {
		current, err := migrator.GetCurrentVersion(ctx)
		target := int32(len(migrator.Migrations))
		if err != nil || current < 0 || current > target {
			logger.Error("migration_preflight_failed", "errorType", "migration")
			os.Exit(1)
		}
		logger.Info("migration_preflight_complete", "currentVersion", current, "targetVersion", target, "pending", target-current)
		return
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

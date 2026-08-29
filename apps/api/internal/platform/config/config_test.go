package config

import "testing"

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("POSTGRES_PASSWORD_FILE", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected missing DATABASE_URL to fail")
	}
}

func TestLoadUsesNarrowDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/dev_toolbox")
	t.Setenv("HTTP_ADDRESS", "")
	t.Setenv("ARTIFACT_SCHEMA_PATH", "")
	t.Setenv("MIGRATIONS_PATH", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.HTTPAddress != "0.0.0.0:8080" {
		t.Fatalf("HTTPAddress = %q", cfg.HTTPAddress)
	}
	if cfg.MigrationsPath != "migrations" {
		t.Fatalf("MigrationsPath = %q", cfg.MigrationsPath)
	}
}

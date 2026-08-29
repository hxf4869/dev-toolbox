package config

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("POSTGRES_PASSWORD_FILE", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected missing DATABASE_URL to fail")
	}
}

func TestLoadUsesNarrowDefaults(t *testing.T) {
	masterKeyPath := filepath.Join(t.TempDir(), "master-key")
	if err := os.WriteFile(masterKeyPath, []byte(base64.StdEncoding.EncodeToString(make([]byte, 32))), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL", "postgres://example.invalid/dev_toolbox")
	t.Setenv("APP_MASTER_KEY_FILE", masterKeyPath)
	t.Setenv("INTERNAL_SERVICE_TOKEN", "0123456789abcdef0123456789abcdef")
	t.Setenv("HTTP_ADDRESS", "")
	t.Setenv("APP_ORIGIN", "")
	t.Setenv("APP_TIMEZONE", "")
	t.Setenv("ATTACHMENT_ROOT", "")
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
	if len(cfg.MasterKey) != 32 {
		t.Fatalf("MasterKey length = %d", len(cfg.MasterKey))
	}
}

func TestLoadRejectsOriginWithPath(t *testing.T) {
	masterKeyPath := filepath.Join(t.TempDir(), "master-key")
	if err := os.WriteFile(masterKeyPath, []byte(base64.StdEncoding.EncodeToString(make([]byte, 32))), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL", "postgres://example.invalid/dev_toolbox")
	t.Setenv("APP_MASTER_KEY_FILE", masterKeyPath)
	t.Setenv("INTERNAL_SERVICE_TOKEN", "0123456789abcdef0123456789abcdef")
	t.Setenv("APP_ORIGIN", "https://toolbox.example.com/path")

	if _, err := Load(); err == nil {
		t.Fatal("expected APP_ORIGIN with path to fail")
	}
}

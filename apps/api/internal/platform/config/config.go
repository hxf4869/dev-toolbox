package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	HTTPAddress        string
	DatabaseURL        string
	ArtifactSchemaPath string
	MigrationsPath     string
}

func Load() (Config, error) {
	databaseURL, err := loadDatabaseURL()
	if err != nil {
		return Config{}, err
	}
	cfg := Config{
		HTTPAddress:        valueOrDefault("HTTP_ADDRESS", "0.0.0.0:8080"),
		DatabaseURL:        databaseURL,
		ArtifactSchemaPath: valueOrDefault("ARTIFACT_SCHEMA_PATH", "../../docs/contracts/ai-artifact.schema.json"),
		MigrationsPath:     valueOrDefault("MIGRATIONS_PATH", "migrations"),
	}
	return cfg, nil
}

func loadDatabaseURL() (string, error) {
	if databaseURL := os.Getenv("DATABASE_URL"); databaseURL != "" {
		return databaseURL, nil
	}
	passwordFile := os.Getenv("POSTGRES_PASSWORD_FILE")
	if passwordFile == "" {
		return "", errors.New("DATABASE_URL or POSTGRES_PASSWORD_FILE is required")
	}
	passwordBytes, err := os.ReadFile(passwordFile)
	if err != nil {
		return "", fmt.Errorf("read PostgreSQL password file: %w", err)
	}
	host := os.Getenv("PGHOST")
	database := os.Getenv("PGDATABASE")
	user := os.Getenv("PGUSER")
	if host == "" || database == "" || user == "" {
		return "", errors.New("PGHOST, PGDATABASE and PGUSER are required with POSTGRES_PASSWORD_FILE")
	}
	port := valueOrDefault("PGPORT", "5432")
	databaseURL := &url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(user, strings.TrimSpace(string(passwordBytes))),
		Host:   net.JoinHostPort(host, port),
		Path:   "/" + database,
	}
	query := databaseURL.Query()
	query.Set("sslmode", valueOrDefault("PGSSLMODE", "require"))
	databaseURL.RawQuery = query.Encode()
	return databaseURL.String(), nil
}

func valueOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

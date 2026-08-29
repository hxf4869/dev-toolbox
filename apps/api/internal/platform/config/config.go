package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	_ "time/tzdata"
)

type Config struct {
	HTTPAddress               string
	DatabaseURL               string
	AppOrigin                 string
	AppTimezone               *time.Location
	MasterKey                 []byte
	AttachmentRoot            string
	TrustedProxyCIDRs         string
	ArtifactSchemaPath        string
	MigrationsPath            string
	AIWorkerURL               string
	InternalServiceToken      string
	AllowInsecureProviderHTTP bool
}

type MigrationConfig struct {
	DatabaseURL    string
	MigrationsPath string
}

func Load() (Config, error) {
	databaseURL, err := LoadDatabaseURL()
	if err != nil {
		return Config{}, err
	}
	masterKey, err := loadMasterKey()
	if err != nil {
		return Config{}, err
	}
	appOrigin := valueOrDefault("APP_ORIGIN", "http://localhost:8080")
	if err := validateOrigin(appOrigin); err != nil {
		return Config{}, err
	}
	appTimezone, err := time.LoadLocation(valueOrDefault("APP_TIMEZONE", "Asia/Shanghai"))
	if err != nil {
		return Config{}, fmt.Errorf("load APP_TIMEZONE: %w", err)
	}
	internalToken, err := loadTextSecret("INTERNAL_SERVICE_TOKEN", "INTERNAL_SERVICE_TOKEN_FILE")
	if err != nil {
		return Config{}, err
	}
	workerURL := valueOrDefault("AI_WORKER_URL", "http://ai-worker:3001")
	if err := validateInternalServiceURL(workerURL); err != nil {
		return Config{}, err
	}
	cfg := Config{
		HTTPAddress:               valueOrDefault("HTTP_ADDRESS", "0.0.0.0:8080"),
		DatabaseURL:               databaseURL,
		AppOrigin:                 appOrigin,
		AppTimezone:               appTimezone,
		MasterKey:                 masterKey,
		AttachmentRoot:            filepath.Clean(valueOrDefault("ATTACHMENT_ROOT", "../../deploy/data/attachments")),
		TrustedProxyCIDRs:         os.Getenv("TRUSTED_PROXY_CIDRS"),
		ArtifactSchemaPath:        valueOrDefault("ARTIFACT_SCHEMA_PATH", "../../docs/contracts/ai-artifact.schema.json"),
		MigrationsPath:            valueOrDefault("MIGRATIONS_PATH", "migrations"),
		AIWorkerURL:               strings.TrimRight(workerURL, "/"),
		InternalServiceToken:      internalToken,
		AllowInsecureProviderHTTP: strings.EqualFold(os.Getenv("ALLOW_INSECURE_PROVIDER_HTTP"), "true"),
	}
	return cfg, nil
}

func LoadMigration() (MigrationConfig, error) {
	databaseURL, err := LoadDatabaseURL()
	if err != nil {
		return MigrationConfig{}, err
	}
	return MigrationConfig{
		DatabaseURL:    databaseURL,
		MigrationsPath: valueOrDefault("MIGRATIONS_PATH", "migrations"),
	}, nil
}

func LoadDatabaseURL() (string, error) {
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

func loadMasterKey() ([]byte, error) {
	path := os.Getenv("APP_MASTER_KEY_FILE")
	if path == "" {
		return nil, errors.New("APP_MASTER_KEY_FILE is required")
	}
	encoded, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read application master key: %w", err)
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil {
		return nil, errors.New("application master key must be base64")
	}
	if len(key) != 32 {
		return nil, errors.New("application master key must decode to 32 bytes")
	}
	return key, nil
}

func loadTextSecret(valueKey, fileKey string) (string, error) {
	value := strings.TrimSpace(os.Getenv(valueKey))
	if value == "" {
		path := os.Getenv(fileKey)
		if path == "" {
			return "", fmt.Errorf("%s or %s is required", valueKey, fileKey)
		}
		encoded, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", fileKey, err)
		}
		value = strings.TrimSpace(string(encoded))
	}
	if len(value) < 32 || len(value) > 512 {
		return "", fmt.Errorf("%s must contain 32 to 512 characters", valueKey)
	}
	return value, nil
}

func validateOrigin(value string) error {
	origin, err := url.Parse(value)
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Host == "" || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.User != nil {
		return errors.New("APP_ORIGIN must be an HTTP(S) origin without path, query, fragment or userinfo")
	}
	return nil
}

func validateInternalServiceURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.User != nil ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("AI_WORKER_URL must be an HTTP origin without path, query, fragment or userinfo")
	}
	return nil
}

func valueOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

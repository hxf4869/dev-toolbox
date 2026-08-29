package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrOwnerExists   = errors.New("owner already exists")
	ErrOwnerNotFound = errors.New("owner not found")
)

func InitializeOwner(ctx context.Context, database *pgxpool.Pool, username, password string, now time.Time) error {
	username = strings.TrimSpace(username)
	if username == "" || len([]rune(username)) > 120 {
		return errors.New("username must contain 1–120 characters")
	}
	passwordHash, err := HashPassword(password)
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ownerID := uuid.New()
	now = now.UTC()
	_, err = tx.Exec(ctx, `
		INSERT INTO owner_account (
			id, username, password_hash, password_changed_at, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $4, $4)
	`, ownerID, username, passwordHash, now)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return ErrOwnerExists
		}
		return fmt.Errorf("create owner: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO security_events (id, event_type, details, created_at)
		VALUES ($1, 'owner_initialized', '{}'::jsonb, $2)
	`, uuid.New(), now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func ResetAuth(ctx context.Context, database *pgxpool.Pool, password string, now time.Time) error {
	passwordHash, err := HashPassword(password)
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	now = now.UTC()
	tag, err := tx.Exec(ctx, `
		UPDATE owner_account
		SET password_hash = $1,
		    totp_secret_ciphertext = NULL,
		    totp_enabled_at = NULL,
		    password_changed_at = $2,
		    updated_at = $2
	`, passwordHash, now)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOwnerNotFound
	}
	if _, err := tx.Exec(ctx, "DELETE FROM mfa_recovery_codes"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE auth_challenges SET consumed_at = $1 WHERE consumed_at IS NULL", now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE auth_sessions SET revoked_at = $1 WHERE revoked_at IS NULL", now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE trusted_devices SET revoked_at = $1 WHERE revoked_at IS NULL", now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO security_events (id, event_type, details, created_at)
		VALUES ($1, 'auth_reset_by_host', '{}'::jsonb, $2)
	`, uuid.New(), now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

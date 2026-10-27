//go:build integration

package integration_test

// Regression for the MFA fault/credential classification: a challenge whose
// stored TOTP ciphertext cannot be decrypted is a system fault (5xx) and must
// not consume the wrong-credential rate limit budget (the limiter starts
// rejecting with 429 after three recorded failures). An unknown challenge
// stays a plain authentication failure.

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestAuthMfaSystemFaultIsNotACredentialError(t *testing.T) {
	h := newV3Harness(t)
	ctx := context.Background()
	var ownerID uuid.UUID
	if err := h.database.QueryRow(ctx, `SELECT id FROM owner_account LIMIT 1`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}

	challengeID := uuid.New()
	if _, err := h.database.Exec(ctx, `
		INSERT INTO auth_challenges (id, owner_account_id, mode, pending_totp_secret_ciphertext,
		       failed_attempts, expires_at, created_at)
		VALUES ($1, $2, 'totp_enroll', '\x00ff10ee'::bytea, 0, now() + interval '10 minutes', now())
	`, challengeID, ownerID); err != nil {
		t.Fatal(err)
	}

	// 密文无法解密是系统故障：连续四次都必须是 500 INTERNAL_ERROR。若该故障
	// 被当作验证码错误计账，第三次起 limiter 会改答 429 RATE_LIMITED。
	for attempt := 1; attempt <= 4; attempt++ {
		response := h.post(t, "/api/v1/auth/totp/confirm", map[string]any{
			"challengeId": challengeID.String(), "code": "000000", "trustDevice": false,
		})
		status, code := v3Error(t, response)
		if status != http.StatusInternalServerError || code != "INTERNAL_ERROR" {
			t.Fatalf("解密故障第 %d 次应为 500 INTERNAL_ERROR，实际 %d %s", attempt, status, code)
		}
	}

	// 未知 challenge 仍是普通认证失败。
	unknownChallenge := uuid.New()
	for attempt := 1; attempt <= 2; attempt++ {
		response := h.post(t, "/api/v1/auth/mfa/verify", map[string]any{
			"challengeId": unknownChallenge.String(), "method": "totp", "code": "000000", "trustDevice": false,
		})
		status, code := v3Error(t, response)
		if status != http.StatusUnauthorized || code != "AUTH_INVALID_CREDENTIALS" {
			t.Fatalf("未知 challenge 第 %d 次应为 401 AUTH_INVALID_CREDENTIALS，实际 %d %s", attempt, status, code)
		}
	}
}

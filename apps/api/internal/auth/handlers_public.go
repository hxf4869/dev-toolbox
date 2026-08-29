package auth

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type mfaVerifyRequest struct {
	ChallengeID string `json:"challengeId"`
	Method      string `json:"method"`
	Code        string `json:"code"`
	TrustDevice bool   `json:"trustDevice"`
	DeviceName  string `json:"deviceName"`
}

type challengeRequest struct {
	ChallengeID string `json:"challengeId"`
}

type totpConfirmRequest struct {
	ChallengeID string `json:"challengeId"`
	Code        string `json:"code"`
	TrustDevice bool   `json:"trustDevice"`
	DeviceName  string `json:"deviceName"`
}

func (service *Service) login(response http.ResponseWriter, request *http.Request) {
	var input loginRequest
	if httpapi.DecodeJSON(response, request, 4096, &input) != nil || input.Username == "" || input.Password == "" {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "请输入账号和密码")
		return
	}
	ip := clientIP(request, service.trustedProxies)
	rateKeys := []string{"login-ip:" + ipString(ip), "login-account:" + input.Username}
	if allowed, retryAfter := service.limiter.allowed(rateKeys...); !allowed {
		response.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(retryAfter.Seconds())))))
		httpapi.WriteError(response, request, http.StatusTooManyRequests, "RATE_LIMITED", "尝试过于频繁，请稍后再试")
		return
	}

	var ownerID uuid.UUID
	var username string
	passwordHash := service.dummyHash
	var totpCiphertext []byte
	err := service.database.QueryRow(request.Context(), `
		SELECT id, username, password_hash, totp_secret_ciphertext
		FROM owner_account
		LIMIT 1
	`).Scan(&ownerID, &username, &passwordHash, &totpCiphertext)
	ownerExists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if !VerifyPassword(passwordHash, input.Password) || !ownerExists || subtleUsernameCompare(username, input.Username) == 0 {
		service.limiter.failure(rateKeys...)
		service.recordSecurityEvent(request.Context(), nil, "login_failed", ip, request.UserAgent(), map[string]any{})
		httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_INVALID_CREDENTIALS", "凭据无效或已过期")
		return
	}
	service.limiter.success(rateKeys...)

	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	defer tx.Rollback(request.Context())

	trustedDeviceID, err := service.validTrustedDevice(request.Context(), tx, request)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if trustedDeviceID != nil && len(totpCiphertext) > 0 {
		session, err := service.createSession(request.Context(), tx, trustedDeviceID, ip, request.UserAgent())
		if err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
		if err := service.insertSecurityEvent(request.Context(), tx, "login_success", ip, request.UserAgent(), map[string]any{"trustedDevice": true}); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
		if err := tx.Commit(request.Context()); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
		setSessionCookie(response, session)
		service.writeAuthenticated(response, ownerID, username, session, nil)
		return
	}

	mode := "mfa_verify"
	if len(totpCiphertext) == 0 {
		mode = "totp_enroll"
	}
	challengeID := uuid.New()
	now := service.now().UTC()
	expiresAt := now.Add(5 * time.Minute)
	if _, err := tx.Exec(request.Context(), `
		INSERT INTO auth_challenges (id, owner_account_id, mode, expires_at, created_at)
		VALUES ($1, $2, $3, $4, $5)
	`, challengeID, ownerID, mode, expiresAt, now); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	status := "mfa_required"
	if mode == "totp_enroll" {
		status = "mfa_setup_required"
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusAccepted, map[string]any{
		"status":      status,
		"challengeId": challengeID,
		"expiresAt":   expiresAt,
	})
}

func (service *Service) setupTOTP(response http.ResponseWriter, request *http.Request) {
	var input challengeRequest
	if httpapi.DecodeJSON(response, request, 4096, &input) != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "challengeId 无效")
		return
	}
	challengeID, err := uuid.Parse(input.ChallengeID)
	if err != nil {
		service.invalidCredentials(response, request)
		return
	}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	defer tx.Rollback(request.Context())

	var username string
	var pendingCiphertext []byte
	err = tx.QueryRow(request.Context(), `
		SELECT owner.username, challenge.pending_totp_secret_ciphertext
		FROM auth_challenges challenge
		JOIN owner_account owner ON owner.id = challenge.owner_account_id
		WHERE challenge.id = $1
		  AND challenge.mode = 'totp_enroll'
		  AND challenge.consumed_at IS NULL
		  AND challenge.expires_at > $2
		  AND challenge.failed_attempts < 5
		FOR UPDATE OF challenge
	`, challengeID, service.now().UTC()).Scan(&username, &pendingCiphertext)
	if err != nil {
		service.invalidCredentials(response, request)
		return
	}

	var provisioning TOTPProvisioning
	if len(pendingCiphertext) == 0 {
		provisioning, err = newTOTP(username)
		if err == nil {
			pendingCiphertext, err = encryptSecret(service.masterKey, provisioning.Secret)
		}
		if err == nil {
			_, err = tx.Exec(request.Context(), `
				UPDATE auth_challenges
				SET pending_totp_secret_ciphertext = $2
				WHERE id = $1
			`, challengeID, pendingCiphertext)
		}
	} else {
		var secret string
		secret, err = decryptSecret(service.masterKey, pendingCiphertext)
		if err == nil {
			provisioning, err = provisioningFromSecret(username, secret)
		}
	}
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, provisioning)
}

func (service *Service) verifyMFA(response http.ResponseWriter, request *http.Request) {
	var input mfaVerifyRequest
	if httpapi.DecodeJSON(response, request, 8192, &input) != nil || (input.Method != "totp" && input.Method != "recovery_code") {
		service.invalidCredentials(response, request)
		return
	}
	service.finishChallenge(response, request, input.ChallengeID, "mfa_verify", input.Method, input.Code, input.TrustDevice, input.DeviceName)
}

func (service *Service) confirmTOTP(response http.ResponseWriter, request *http.Request) {
	var input totpConfirmRequest
	if httpapi.DecodeJSON(response, request, 8192, &input) != nil {
		service.invalidCredentials(response, request)
		return
	}
	service.finishChallenge(response, request, input.ChallengeID, "totp_enroll", "totp", input.Code, input.TrustDevice, input.DeviceName)
}

func (service *Service) finishChallenge(response http.ResponseWriter, request *http.Request, challengeValue, expectedMode, method, code string, trustDevice bool, deviceName string) {
	challengeID, err := uuid.Parse(challengeValue)
	if err != nil {
		service.invalidCredentials(response, request)
		return
	}
	ip := clientIP(request, service.trustedProxies)
	rateKeys := []string{"mfa-ip:" + ipString(ip), "mfa-challenge:" + challengeID.String()}
	if allowed, retryAfter := service.limiter.allowed(rateKeys...); !allowed {
		response.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(retryAfter.Seconds())))))
		httpapi.WriteError(response, request, http.StatusTooManyRequests, "RATE_LIMITED", "尝试过于频繁，请稍后再试")
		return
	}

	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	defer tx.Rollback(request.Context())

	var ownerID uuid.UUID
	var username string
	var mode string
	var failedAttempts int
	var currentTOTPCiphertext []byte
	var pendingTOTPCiphertext []byte
	err = tx.QueryRow(request.Context(), `
		SELECT owner.id, owner.username, challenge.mode, challenge.failed_attempts,
		       owner.totp_secret_ciphertext, challenge.pending_totp_secret_ciphertext
		FROM auth_challenges challenge
		JOIN owner_account owner ON owner.id = challenge.owner_account_id
		WHERE challenge.id = $1
		  AND challenge.consumed_at IS NULL
		  AND challenge.expires_at > $2
		  AND challenge.failed_attempts < 5
		FOR UPDATE OF challenge, owner
	`, challengeID, service.now().UTC()).Scan(
		&ownerID,
		&username,
		&mode,
		&failedAttempts,
		&currentTOTPCiphertext,
		&pendingTOTPCiphertext,
	)
	if err != nil || mode != expectedMode {
		service.limiter.failure(rateKeys...)
		service.invalidCredentials(response, request)
		return
	}

	valid := false
	usedRecoveryID := uuid.Nil
	if expectedMode == "totp_enroll" {
		if len(pendingTOTPCiphertext) > 0 {
			secret, decryptErr := decryptSecret(service.masterKey, pendingTOTPCiphertext)
			valid = decryptErr == nil && validateTOTP(secret, code, service.now())
		}
	} else {
		valid, usedRecoveryID, err = service.verifySecondFactor(request.Context(), tx, currentTOTPCiphertext, method, code)
		if err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
	}
	if !valid {
		failedAttempts++
		consumedAt := any(nil)
		if failedAttempts >= 5 {
			consumedAt = service.now().UTC()
		}
		_, _ = tx.Exec(request.Context(), `
			UPDATE auth_challenges SET failed_attempts = $2, consumed_at = $3 WHERE id = $1
		`, challengeID, failedAttempts, consumedAt)
		_ = tx.Commit(request.Context())
		service.limiter.failure(rateKeys...)
		service.recordSecurityEvent(request.Context(), nil, "mfa_failed", ip, request.UserAgent(), map[string]any{})
		service.invalidCredentials(response, request)
		return
	}
	service.limiter.success(rateKeys...)

	now := service.now().UTC()
	if usedRecoveryID != uuid.Nil {
		if _, err := tx.Exec(request.Context(), `
			UPDATE mfa_recovery_codes SET used_at = $2 WHERE id = $1 AND used_at IS NULL
		`, usedRecoveryID, now); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
	}

	var recoveryCodes []string
	if expectedMode == "totp_enroll" {
		resetting := len(currentTOTPCiphertext) > 0
		if resetting {
			if _, err := tx.Exec(request.Context(), "UPDATE auth_sessions SET revoked_at = $1 WHERE revoked_at IS NULL", now); err != nil {
				httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
				return
			}
			if _, err := tx.Exec(request.Context(), "UPDATE trusted_devices SET revoked_at = $1 WHERE revoked_at IS NULL", now); err != nil {
				httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
				return
			}
		}
		if _, err := tx.Exec(request.Context(), "DELETE FROM mfa_recovery_codes"); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
		var hashes []string
		recoveryCodes, hashes, err = generateRecoveryCodes(10)
		if err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
		for _, hash := range hashes {
			if _, err := tx.Exec(request.Context(), `
				INSERT INTO mfa_recovery_codes (id, code_hash, created_at) VALUES ($1, $2, $3)
			`, uuid.New(), hash, now); err != nil {
				httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
				return
			}
		}
		if _, err := tx.Exec(request.Context(), `
			UPDATE owner_account
			SET totp_secret_ciphertext = $2, totp_enabled_at = $3, updated_at = $3
			WHERE id = $1
		`, ownerID, pendingTOTPCiphertext, now); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
	}

	var device *issuedDevice
	var deviceID *uuid.UUID
	if trustDevice {
		created, err := service.createTrustedDevice(request.Context(), tx, deviceName)
		if err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
		device = &created
		deviceID = &created.ID
	}
	session, err := service.createSession(request.Context(), tx, deviceID, ip, request.UserAgent())
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if _, err := tx.Exec(request.Context(), `
		UPDATE auth_challenges SET consumed_at = $2 WHERE id = $1
	`, challengeID, now); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	eventType := "login_success"
	if expectedMode == "totp_enroll" {
		eventType = "totp_enabled"
	}
	if err := service.insertSecurityEvent(request.Context(), tx, eventType, ip, request.UserAgent(), map[string]any{"trustedDevice": trustDevice}); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	setSessionCookie(response, session)
	if device != nil {
		setDeviceCookie(response, *device)
	} else if expectedMode == "totp_enroll" {
		http.SetCookie(response, &http.Cookie{Name: deviceCookieName, Value: "", Path: "/", MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	}
	service.writeAuthenticated(response, ownerID, username, session, recoveryCodes)
}

func (service *Service) verifySecondFactor(ctx context.Context, tx pgx.Tx, totpCiphertext []byte, method, code string) (bool, uuid.UUID, error) {
	switch method {
	case "totp":
		secret, err := decryptSecret(service.masterKey, totpCiphertext)
		if err != nil {
			return false, uuid.Nil, err
		}
		return validateTOTP(secret, code, service.now()), uuid.Nil, nil
	case "recovery_code":
		var id uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT id FROM mfa_recovery_codes
			WHERE code_hash = $1 AND used_at IS NULL
			FOR UPDATE
		`, recoveryCodeHash(code)).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, uuid.Nil, nil
		}
		return err == nil, id, err
	default:
		return false, uuid.Nil, nil
	}
}

func (service *Service) validTrustedDevice(ctx context.Context, tx pgx.Tx, request *http.Request) (*uuid.UUID, error) {
	cookie, err := request.Cookie(deviceCookieName)
	if err != nil || cookie.Value == "" {
		return nil, nil
	}
	var id uuid.UUID
	now := service.now().UTC()
	err = tx.QueryRow(ctx, `
		SELECT id FROM trusted_devices
		WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2
		FOR UPDATE
	`, tokenHash(cookie.Value), now).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "UPDATE trusted_devices SET last_used_at = $2 WHERE id = $1", id, now); err != nil {
		return nil, err
	}
	return &id, nil
}

func (service *Service) writeAuthenticated(response http.ResponseWriter, ownerID uuid.UUID, username string, session issuedSession, recoveryCodes []string) {
	httpapi.NoStore(response)
	payload := map[string]any{
		"status": "authenticated",
		"owner": map[string]any{
			"id":       ownerID,
			"username": username,
		},
		"session": map[string]any{
			"id":        session.ID,
			"expiresAt": session.ExpiresAt,
		},
		"csrfToken": session.CSRFToken,
	}
	if recoveryCodes != nil {
		payload["recoveryCodes"] = recoveryCodes
	}
	httpapi.WriteJSON(response, http.StatusOK, payload)
}

func (service *Service) invalidCredentials(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_INVALID_CREDENTIALS", "凭据无效或已过期")
}

func subtleUsernameCompare(left, right string) int {
	if len(left) != len(right) {
		return 0
	}
	var difference byte
	for index := range len(left) {
		difference |= left[index] ^ right[index]
	}
	if difference == 0 {
		return 1
	}
	return 0
}

func ipString(ip net.IP) string {
	if ip == nil {
		return "unknown"
	}
	return ip.String()
}

func (service *Service) recordSecurityEvent(ctx context.Context, tx pgx.Tx, eventType string, ip net.IP, userAgent string, details map[string]any) {
	if tx != nil {
		_ = service.insertSecurityEvent(ctx, tx, eventType, ip, userAgent, details)
		return
	}
	encoded, _ := json.Marshal(details)
	_, _ = service.database.Exec(ctx, `
		INSERT INTO security_events (id, event_type, client_ip, user_agent, details, created_at)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6)
	`, uuid.New(), eventType, nullableIP(ip), truncateRunes(userAgent, 512), string(encoded), service.now().UTC())
}

func (service *Service) insertSecurityEvent(ctx context.Context, tx pgx.Tx, eventType string, ip net.IP, userAgent string, details map[string]any) error {
	encoded, _ := json.Marshal(details)
	_, err := tx.Exec(ctx, `
		INSERT INTO security_events (id, event_type, client_ip, user_agent, details, created_at)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6)
	`, uuid.New(), eventType, nullableIP(ip), truncateRunes(userAgent, 512), string(encoded), service.now().UTC())
	return err
}

package auth

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type sensitiveAuthRequest struct {
	Password string `json:"password"`
	Method   string `json:"method"`
	Code     string `json:"code"`
}

type passwordChangeRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
	Method          string `json:"method"`
	Code            string `json:"code"`
}

type renameDeviceRequest struct {
	DisplayName string `json:"displayName"`
}

func (service *Service) sessionBootstrap(response http.ResponseWriter, request *http.Request) {
	session, _ := SessionFromContext(request.Context())
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{
		"status": "authenticated",
		"owner": map[string]any{
			"id":       session.OwnerID,
			"username": session.Username,
		},
		"session": map[string]any{
			"id":              session.ID,
			"createdAt":       session.CreatedAt,
			"lastSeenAt":      session.LastSeenAt,
			"expiresAt":       session.ExpiresAt,
			"trustedDeviceId": session.TrustedDeviceID,
		},
		"csrfToken": session.CSRFToken,
	})
}

func (service *Service) logout(response http.ResponseWriter, request *http.Request) {
	session, _ := SessionFromContext(request.Context())
	now := service.now().UTC()
	_, err := service.database.Exec(request.Context(), `
		UPDATE auth_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL
	`, session.ID, now)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	clearSessionCookie(response)
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) logoutAll(response http.ResponseWriter, request *http.Request) {
	session, _ := SessionFromContext(request.Context())
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	defer tx.Rollback(request.Context())
	now := service.now().UTC()
	if _, err := tx.Exec(request.Context(), "UPDATE auth_sessions SET revoked_at = $1 WHERE revoked_at IS NULL", now); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if _, err := tx.Exec(request.Context(), "UPDATE trusted_devices SET revoked_at = $1 WHERE revoked_at IS NULL", now); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := service.insertSecurityEvent(request.Context(), tx, "logout_all", clientIP(request, service.trustedProxies), request.UserAgent(), map[string]any{"sessionId": session.ID}); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	clearAuthCookies(response)
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) changePassword(response http.ResponseWriter, request *http.Request) {
	var input passwordChangeRequest
	if httpapi.DecodeJSON(response, request, 8192, &input) != nil || ValidateNewPassword(input.NewPassword) != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "新密码至少需要 12 个字符")
		return
	}
	session, _ := SessionFromContext(request.Context())
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	defer tx.Rollback(request.Context())

	if ok, err := service.verifySensitiveAction(request, tx, session.OwnerID, input.CurrentPassword, input.Method, input.Code); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	} else if !ok {
		service.invalidCredentials(response, request)
		return
	}
	newHash, err := HashPassword(input.NewPassword)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", err.Error())
		return
	}
	now := service.now().UTC()
	if _, err := tx.Exec(request.Context(), `
		UPDATE owner_account
		SET password_hash = $2, password_changed_at = $3, updated_at = $3
		WHERE id = $1
	`, session.OwnerID, newHash, now); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if _, err := tx.Exec(request.Context(), "UPDATE auth_sessions SET revoked_at = $1 WHERE revoked_at IS NULL", now); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if _, err := tx.Exec(request.Context(), "UPDATE trusted_devices SET revoked_at = $1 WHERE revoked_at IS NULL", now); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := service.insertSecurityEvent(request.Context(), tx, "password_changed", clientIP(request, service.trustedProxies), request.UserAgent(), map[string]any{}); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	clearAuthCookies(response)
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) resetTOTP(response http.ResponseWriter, request *http.Request) {
	var input sensitiveAuthRequest
	if httpapi.DecodeJSON(response, request, 8192, &input) != nil {
		service.invalidCredentials(response, request)
		return
	}
	session, _ := SessionFromContext(request.Context())
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	defer tx.Rollback(request.Context())
	if ok, err := service.verifySensitiveAction(request, tx, session.OwnerID, input.Password, input.Method, input.Code); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	} else if !ok {
		service.invalidCredentials(response, request)
		return
	}
	now := service.now().UTC()
	challengeID := uuid.New()
	expiresAt := now.Add(5 * time.Minute)
	if _, err := tx.Exec(request.Context(), `
		INSERT INTO auth_challenges (id, owner_account_id, mode, expires_at, created_at)
		VALUES ($1, $2, 'totp_enroll', $3, $4)
	`, challengeID, session.OwnerID, expiresAt, now); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := service.insertSecurityEvent(request.Context(), tx, "totp_reset_started", clientIP(request, service.trustedProxies), request.UserAgent(), map[string]any{}); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusAccepted, map[string]any{
		"status":      "mfa_setup_required",
		"challengeId": challengeID,
		"expiresAt":   expiresAt,
	})
}

func (service *Service) regenerateRecoveryCodes(response http.ResponseWriter, request *http.Request) {
	var input sensitiveAuthRequest
	if httpapi.DecodeJSON(response, request, 8192, &input) != nil {
		service.invalidCredentials(response, request)
		return
	}
	session, _ := SessionFromContext(request.Context())
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	defer tx.Rollback(request.Context())
	if ok, err := service.verifySensitiveAction(request, tx, session.OwnerID, input.Password, input.Method, input.Code); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	} else if !ok {
		service.invalidCredentials(response, request)
		return
	}
	codes, hashes, err := generateRecoveryCodes(10)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if _, err := tx.Exec(request.Context(), "DELETE FROM mfa_recovery_codes"); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	now := service.now().UTC()
	for _, hash := range hashes {
		if _, err := tx.Exec(request.Context(), `
			INSERT INTO mfa_recovery_codes (id, code_hash, created_at) VALUES ($1, $2, $3)
		`, uuid.New(), hash, now); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
	}
	if err := service.insertSecurityEvent(request.Context(), tx, "recovery_codes_regenerated", clientIP(request, service.trustedProxies), request.UserAgent(), map[string]any{}); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"recoveryCodes": codes})
}

func (service *Service) verifySensitiveAction(request *http.Request, tx pgx.Tx, ownerID uuid.UUID, password, method, code string) (bool, error) {
	var passwordHash string
	var totpCiphertext []byte
	err := tx.QueryRow(request.Context(), `
		SELECT password_hash, totp_secret_ciphertext
		FROM owner_account WHERE id = $1
		FOR UPDATE
	`, ownerID).Scan(&passwordHash, &totpCiphertext)
	if err != nil {
		return false, err
	}
	if !VerifyPassword(passwordHash, password) {
		return false, nil
	}
	valid, recoveryID, err := service.verifySecondFactor(request.Context(), tx, totpCiphertext, method, code)
	if err != nil || !valid {
		return valid, err
	}
	if recoveryID != uuid.Nil {
		tag, err := tx.Exec(request.Context(), `
			UPDATE mfa_recovery_codes SET used_at = $2
			WHERE id = $1 AND used_at IS NULL
		`, recoveryID, service.now().UTC())
		if err != nil || tag.RowsAffected() != 1 {
			return false, err
		}
	}
	return true, nil
}

func (service *Service) listTrustedDevices(response http.ResponseWriter, request *http.Request) {
	rows, err := service.database.Query(request.Context(), `
		SELECT id, display_name, created_at, last_used_at, expires_at
		FROM trusted_devices
		WHERE revoked_at IS NULL AND expires_at > $1
		ORDER BY last_used_at DESC, id DESC
	`, service.now().UTC())
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var displayName string
		var createdAt, lastUsedAt, expiresAt time.Time
		if err := rows.Scan(&id, &displayName, &createdAt, &lastUsedAt, &expiresAt); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
		items = append(items, map[string]any{
			"id": id, "displayName": displayName, "createdAt": createdAt,
			"lastUsedAt": lastUsedAt, "expiresAt": expiresAt,
		})
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (service *Service) renameTrustedDevice(response http.ResponseWriter, request *http.Request) {
	deviceID, err := uuid.Parse(request.PathValue("id"))
	var input renameDeviceRequest
	if err != nil || httpapi.DecodeJSON(response, request, 4096, &input) != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "设备名称无效")
		return
	}
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" || len([]rune(displayName)) > 120 {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "设备名称需为 1–120 个字符")
		return
	}
	tag, err := service.database.Exec(request.Context(), `
		UPDATE trusted_devices SET display_name = $2
		WHERE id = $1 AND revoked_at IS NULL AND expires_at > $3
	`, deviceID, displayName, service.now().UTC())
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if tag.RowsAffected() == 0 {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "设备不存在")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"id": deviceID, "displayName": displayName})
}

func (service *Service) revokeTrustedDevice(response http.ResponseWriter, request *http.Request) {
	deviceID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "设备不存在")
		return
	}
	tag, err := service.database.Exec(request.Context(), `
		UPDATE trusted_devices SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL
	`, deviceID, service.now().UTC())
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if tag.RowsAffected() == 0 {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "设备不存在")
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (service *Service) listSessions(response http.ResponseWriter, request *http.Request) {
	current, _ := SessionFromContext(request.Context())
	rows, err := service.database.Query(request.Context(), `
		SELECT id, created_at, last_seen_at, expires_at, trusted_device_id, user_agent
		FROM auth_sessions
		WHERE revoked_at IS NULL AND expires_at > $1 AND last_seen_at > $1 - interval '24 hours'
		ORDER BY last_seen_at DESC, id DESC
	`, service.now().UTC())
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var createdAt, lastSeenAt, expiresAt time.Time
		var trustedDeviceID *uuid.UUID
		var userAgent *string
		if err := rows.Scan(&id, &createdAt, &lastSeenAt, &expiresAt, &trustedDeviceID, &userAgent); err != nil {
			httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
			return
		}
		items = append(items, map[string]any{
			"id": id, "createdAt": createdAt, "lastSeenAt": lastSeenAt, "expiresAt": expiresAt,
			"trustedDeviceId": trustedDeviceID, "userAgent": userAgent, "current": id == current.ID,
		})
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (service *Service) revokeSession(response http.ResponseWriter, request *http.Request) {
	sessionID, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "会话不存在")
		return
	}
	tag, err := service.database.Exec(request.Context(), `
		UPDATE auth_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL
	`, sessionID, service.now().UTC())
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if tag.RowsAffected() == 0 {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "会话不存在")
		return
	}
	current, _ := SessionFromContext(request.Context())
	if sessionID == current.ID {
		clearSessionCookie(response)
	}
	response.WriteHeader(http.StatusNoContent)
}

package auth

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type sessionContextKey struct{}

type Session struct {
	ID              uuid.UUID
	OwnerID         uuid.UUID
	Username        string
	CSRFToken       string
	CreatedAt       time.Time
	LastSeenAt      time.Time
	ExpiresAt       time.Time
	TrustedDeviceID *uuid.UUID
}

func SessionFromContext(ctx context.Context) (Session, bool) {
	session, ok := ctx.Value(sessionContextKey{}).(Session)
	return session, ok
}

func (service *Service) OriginOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !service.validOrigin(request) {
			httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "请求来源未通过校验")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func (service *Service) Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		sessionCookie, cookieErr := request.Cookie(sessionCookieName)
		authorization := strings.TrimSpace(request.Header.Get("Authorization"))
		if cookieErr == nil && authorization != "" {
			httpapi.WriteError(response, request, http.StatusBadRequest, "AUTH_METHOD_CONFLICT", "不能同时使用 Cookie 会话和 Bearer Token")
			return
		}
		if cookieErr != nil || sessionCookie.Value == "" || authorization != "" {
			httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "请先登录")
			return
		}

		now := service.now().UTC()
		var session Session
		var csrfHash []byte
		err := service.database.QueryRow(request.Context(), `
			SELECT s.id, owner.id, owner.username, s.csrf_token_hash, s.created_at, s.last_seen_at,
			       s.expires_at, s.trusted_device_id
			FROM auth_sessions s
			CROSS JOIN owner_account owner
			WHERE s.token_hash = $1
			  AND s.revoked_at IS NULL
			  AND s.expires_at > $2
			  AND s.last_seen_at > $2 - interval '24 hours'
			  AND s.created_at >= owner.password_changed_at
		`, tokenHash(sessionCookie.Value), now).Scan(
			&session.ID,
			&session.OwnerID,
			&session.Username,
			&csrfHash,
			&session.CreatedAt,
			&session.LastSeenAt,
			&session.ExpiresAt,
			&session.TrustedDeviceID,
		)
		if err != nil {
			if err != pgx.ErrNoRows {
				// Authentication failures intentionally share the same external result.
			}
			clearSessionCookie(response)
			httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "请先登录")
			return
		}
		session.CSRFToken = csrfToken(service.masterKey, sessionCookie.Value)
		if subtle.ConstantTimeCompare(csrfHash, tokenHash(session.CSRFToken)) != 1 {
			clearSessionCookie(response)
			httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "请先登录")
			return
		}
		if now.Sub(session.LastSeenAt) >= 5*time.Minute {
			_, _ = service.database.Exec(request.Context(), `
				UPDATE auth_sessions SET last_seen_at = $2
				WHERE id = $1 AND revoked_at IS NULL AND last_seen_at < $2 - interval '5 minutes'
			`, session.ID, now)
			session.LastSeenAt = now
		}
		next.ServeHTTP(response, request.WithContext(context.WithValue(request.Context(), sessionContextKey{}, session)))
	})
}

func (service *Service) AuthenticateMutation(next http.Handler) http.Handler {
	return service.Authenticate(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !service.validOrigin(request) {
			httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "请求来源未通过校验")
			return
		}
		session, _ := SessionFromContext(request.Context())
		provided := request.Header.Get("X-CSRF-Token")
		if subtle.ConstantTimeCompare([]byte(provided), []byte(session.CSRFToken)) != 1 {
			httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "CSRF Token 无效")
			return
		}
		next.ServeHTTP(response, request)
	}))
}

func (service *Service) validOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	return subtle.ConstantTimeCompare([]byte(origin), []byte(service.appOrigin)) == 1
}

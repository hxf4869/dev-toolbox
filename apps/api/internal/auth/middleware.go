package auth

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type sessionContextKey struct{}
type actorContextKey struct{}

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

type Actor struct {
	Type     string
	ID       uuid.UUID
	OwnerID  uuid.UUID
	Username string
	Scopes   map[string]struct{}
}

func (actor Actor) HasScope(scope string) bool {
	if actor.Type == "session" {
		return true
	}
	_, ok := actor.Scopes[scope]
	return ok
}

func SessionFromContext(ctx context.Context) (Session, bool) {
	session, ok := ctx.Value(sessionContextKey{}).(Session)
	return session, ok
}

func ActorFromContext(ctx context.Context) (Actor, bool) {
	actor, ok := ctx.Value(actorContextKey{}).(Actor)
	return actor, ok
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

// Authenticate is deliberately session-only and protects owner administration.
func (service *Service) Authenticate(next http.Handler) http.Handler {
	return service.withAuthentication(false, nil, "FORBIDDEN", next)
}

func (service *Service) AuthenticateMutation(next http.Handler, mutationForbiddenCode ...string) http.Handler {
	forbiddenCode := "FORBIDDEN"
	if len(mutationForbiddenCode) == 1 && mutationForbiddenCode[0] != "" {
		forbiddenCode = mutationForbiddenCode[0]
	}
	return service.withAuthentication(true, nil, forbiddenCode, next)
}

// Authorize accepts either the owner session or a PAT carrying every listed scope.
func (service *Service) Authorize(requiredScopes ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return service.withAuthentication(false, requiredScopes, "FORBIDDEN", next)
	}
}

// AuthorizeMutation applies Origin and CSRF to Cookie sessions. Bearer PATs are
// authenticated by their header and therefore do not use browser CSRF tokens.
func (service *Service) AuthorizeMutation(requiredScopes ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return service.withAuthentication(true, requiredScopes, "FORBIDDEN", next)
	}
}

func (service *Service) withAuthentication(mutation bool, requiredScopes []string, mutationForbiddenCode string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		sessionCookie, cookieErr := request.Cookie(sessionCookieName)
		authorization := strings.TrimSpace(request.Header.Get("Authorization"))
		hasCookie := cookieErr == nil && sessionCookie.Value != ""
		if hasCookie && authorization != "" {
			httpapi.WriteError(response, request, http.StatusBadRequest, "AUTH_METHOD_CONFLICT", "不能同时使用 Cookie 会话和 Bearer Token")
			return
		}

		if authorization != "" {
			actor, ok := service.authenticatePAT(request, authorization)
			if !ok {
				httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "Token 无效或已失效")
				return
			}
			if requiredScopes == nil {
				httpapi.WriteError(response, request, http.StatusForbidden, mutationForbiddenCode, "Token 不能执行所有者设置操作")
				return
			}
			for _, scope := range requiredScopes {
				if !actor.HasScope(scope) {
					httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN", "Token 权限不足")
					return
				}
			}
			ctx := context.WithValue(request.Context(), actorContextKey{}, actor)
			next.ServeHTTP(response, request.WithContext(ctx))
			return
		}

		if !hasCookie {
			httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "请先登录")
			return
		}
		session, ok := service.authenticateSession(request, sessionCookie.Value)
		if !ok {
			clearSessionCookie(response)
			httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "请先登录")
			return
		}
		if mutation {
			if !service.validOrigin(request) {
				httpapi.WriteError(response, request, http.StatusForbidden, mutationForbiddenCode, "请求来源未通过校验")
				return
			}
			provided := request.Header.Get("X-CSRF-Token")
			if subtle.ConstantTimeCompare([]byte(provided), []byte(session.CSRFToken)) != 1 {
				httpapi.WriteError(response, request, http.StatusForbidden, mutationForbiddenCode, "CSRF Token 无效")
				return
			}
		}
		actor := Actor{Type: "session", ID: session.ID, OwnerID: session.OwnerID, Username: session.Username}
		ctx := context.WithValue(request.Context(), sessionContextKey{}, session)
		ctx = context.WithValue(ctx, actorContextKey{}, actor)
		next.ServeHTTP(response, request.WithContext(ctx))
	})
}

func (service *Service) authenticateSession(request *http.Request, token string) (Session, bool) {
	session, ok := service.lookupSession(request.Context(), token)
	if !ok {
		return Session{}, false
	}
	service.touchSession(request.Context(), &session)
	return session, true
}

// lookupSession queries and validates a browser session without updating
// last_seen_at. Callers that represent real browser activity must follow up
// with touchSession; internal Agent Console endpoints deliberately never do.
func (service *Service) lookupSession(ctx context.Context, token string) (Session, bool) {
	now := service.now().UTC()
	var session Session
	var csrfHash []byte
	err := service.database.QueryRow(ctx, `
		SELECT s.id, owner.id, owner.username, s.csrf_token_hash, s.created_at, s.last_seen_at,
		       s.expires_at, s.trusted_device_id
		FROM auth_sessions s
		CROSS JOIN owner_account owner
		WHERE s.token_hash = $1
		  AND s.revoked_at IS NULL
		  AND s.expires_at > $2::timestamptz
		  AND s.last_seen_at > $2::timestamptz - interval '24 hours'
		  AND s.created_at >= owner.password_changed_at
	`, tokenHash(token), now).Scan(
		&session.ID, &session.OwnerID, &session.Username, &csrfHash,
		&session.CreatedAt, &session.LastSeenAt, &session.ExpiresAt, &session.TrustedDeviceID,
	)
	if err != nil {
		return Session{}, false
	}
	session.CSRFToken = csrfToken(service.masterKey, token)
	if subtle.ConstantTimeCompare(csrfHash, tokenHash(session.CSRFToken)) != 1 {
		return Session{}, false
	}
	return session, true
}

// touchSession keeps the existing 5-minute last_seen refresh for browser traffic.
func (service *Service) touchSession(ctx context.Context, session *Session) {
	now := service.now().UTC()
	if now.Sub(session.LastSeenAt) < 5*time.Minute {
		return
	}
	_, err := service.database.Exec(ctx, `
		UPDATE auth_sessions SET last_seen_at = $2::timestamptz
		WHERE id = $1 AND revoked_at IS NULL
		  AND last_seen_at < $2::timestamptz - interval '5 minutes'
	`, session.ID, now)
	if err != nil {
		slog.ErrorContext(ctx, "auth_session_last_seen_update_failed", "errorType", "database")
	} else {
		session.LastSeenAt = now
	}
}

func (service *Service) authenticatePAT(request *http.Request, authorization string) (Actor, bool) {
	parts := strings.Fields(authorization)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return Actor{}, false
	}
	now := service.now().UTC()
	var actor Actor
	var scopes []string
	var lastUsedAt *time.Time
	err := service.database.QueryRow(request.Context(), `
		SELECT pat.id, owner.id, owner.username, pat.scopes, pat.last_used_at
		FROM personal_access_tokens pat
		CROSS JOIN owner_account owner
		WHERE pat.token_hash = $1
		  AND pat.revoked_at IS NULL
		  AND (pat.expires_at IS NULL OR pat.expires_at > $2)
	`, tokenHash(parts[1]), now).Scan(&actor.ID, &actor.OwnerID, &actor.Username, &scopes, &lastUsedAt)
	if err != nil {
		if err != pgx.ErrNoRows {
			// Authentication failures intentionally share one external result.
		}
		return Actor{}, false
	}
	actor.Type = "pat"
	actor.Scopes = make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		actor.Scopes[scope] = struct{}{}
	}
	if lastUsedAt == nil || now.Sub(*lastUsedAt) >= 5*time.Minute {
		result, updateErr := service.database.Exec(request.Context(), `
			UPDATE personal_access_tokens SET last_used_at = GREATEST(last_used_at, $2::timestamptz)
			WHERE id = $1 AND revoked_at IS NULL
		`, actor.ID, now)
		if updateErr != nil || result.RowsAffected() != 1 {
			return Actor{}, false
		}
	}
	return actor, true
}

func (service *Service) validOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	return subtle.ConstantTimeCompare([]byte(origin), []byte(service.appOrigin)) == 1
}

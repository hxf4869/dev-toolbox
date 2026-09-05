package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const (
	// agentConsoleTicketTTL 一次性 WebSocket ticket 的有效期。
	agentConsoleTicketTTL = 30 * time.Second
	// agentConsoleAudience ticket 允许的消费方；首版只有 Relay。
	agentConsoleAudience = "relay"
	// 网关在转发前必须删除客户端提交的这两组 header，再以 verify 响应为准重建。
	agentConsoleSessionIDHeader = "X-Agent-Console-Session-Id"
	agentConsoleOwnerIDHeader   = "X-Agent-Console-Owner-Id"
	// 网关把浏览器原始请求方法放进该 header；无法确认方法时按写请求处理（fail closed）。
	agentConsoleMethodHeader = "X-Agent-Console-Method"
)

// 稳定的无效原因，供 Relay 生成稳定的关闭原因；不进入浏览器可见文案。
const (
	ticketReasonNotFound  = "NOT_FOUND"
	ticketReasonConsumed  = "CONSUMED"
	ticketReasonExpired   = "EXPIRED"
	sessionReasonRevoked  = "REVOKED"
	sessionReasonExpired  = "EXPIRED"
	sessionReasonIdle     = "IDLE_TIMEOUT"
	sessionReasonPassword = "PASSWORD_CHANGED"
	sessionReasonNotFound = "NOT_FOUND"
	// ticket 被本次消费占用，但其登录会话已失效时的 consume 拒绝原因。
	ticketReasonSessionInvalid = "SESSION_INVALID"
)

// RegisterAgentConsoleRoutes adds the public ticket endpoint and the internal
// consume/introspect/verify endpoints. internalToken is loaded from
// AGENT_CONSOLE_INTERNAL_TOKEN or AGENT_CONSOLE_INTERNAL_TOKEN_FILE; when it is
// empty the internal routes stay registered but fail closed with 503, so an
// unconfigured deployment never exposes an unauthenticated internal path.
func (service *Service) RegisterAgentConsoleRoutes(router *http.ServeMux, internalToken string) {
	service.agentConsoleInternalToken = internalToken
	router.Handle("POST /api/v1/agent-console/ws-tickets", service.AuthenticateMutation(http.HandlerFunc(service.createAgentConsoleTicket)))
	router.Handle("POST /internal/agent-console/ws-tickets/consume", service.internalOnly(http.HandlerFunc(service.consumeAgentConsoleTicket)))
	router.Handle("POST /internal/agent-console/auth-sessions/introspect", service.internalOnly(http.HandlerFunc(service.introspectAgentConsoleSession)))
	router.Handle("GET /internal/agent-console/auth-sessions/verify", service.internalOnly(http.HandlerFunc(service.verifyAgentConsoleSession)))
}

// internalOnly authenticates internal network callers with the dedicated
// Agent Console service token, compared in constant time. It is separate from
// INTERNAL_SERVICE_TOKEN so the Relay can never call AI worker endpoints.
func (service *Service) internalOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		httpapi.NoStore(response)
		expected := service.agentConsoleInternalToken
		if expected == "" {
			httpapi.WriteError(response, request, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "内部服务未配置")
			return
		}
		header := request.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") || !constantTimeTokenEqual(strings.TrimPrefix(header, "Bearer "), expected) {
			httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "内部服务凭据无效")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func constantTimeTokenEqual(supplied, expected string) bool {
	suppliedHash := sha256.Sum256([]byte(supplied))
	expectedHash := sha256.Sum256([]byte(expected))
	return supplied != "" && subtle.ConstantTimeCompare(suppliedHash[:], expectedHash[:]) == 1
}

type issuedTicket struct {
	Ticket    string    `json:"ticket"`
	ExpiresAt time.Time `json:"expiresAt"`
	Audience  string    `json:"audience"`
}

// createAgentConsoleTicket issues a one-time WebSocket ticket for the current
// browser session. The plaintext ticket is returned exactly once; only its
// SHA-256 digest is stored.
func (service *Service) createAgentConsoleTicket(response http.ResponseWriter, request *http.Request) {
	session, _ := SessionFromContext(request.Context())
	ticket, err := randomToken()
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	now := service.now().UTC()
	expiresAt := now.Add(agentConsoleTicketTTL)
	_, err = service.database.Exec(request.Context(), `
		INSERT INTO agent_console_ws_tickets (
			id, ticket_digest, auth_session_id, owner_id, audience, expires_at, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, uuid.New(), tokenHash(ticket), session.ID, session.OwnerID, agentConsoleAudience, expiresAt, now)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	httpapi.NoStore(response)
	httpapi.WriteJSON(response, http.StatusOK, issuedTicket{Ticket: ticket, ExpiresAt: expiresAt, Audience: agentConsoleAudience})
}

type ticketConsumeResult struct {
	Valid         bool       `json:"valid"`
	AuthSessionID uuid.UUID  `json:"authSessionId,omitempty"`
	OwnerID       uuid.UUID  `json:"ownerId,omitempty"`
	ExpiresAt     *time.Time `json:"expiresAt,omitempty"`
	Reason        string     `json:"reason,omitempty"`
}

// consumeAgentConsoleTicket atomically consumes a ticket and only succeeds when
// the ticket is unused, unexpired and its auth session is still valid. The
// single UPDATE guarantees that concurrent consumers cannot all succeed.
func (service *Service) consumeAgentConsoleTicket(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Ticket string `json:"ticket"`
	}
	if httpapi.DecodeJSON(response, request, 4096, &input) != nil || input.Ticket == "" {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "ticket 无效")
		return
	}
	now := service.now().UTC()
	digest := tokenHash(input.Ticket)
	var authSessionID, ownerID uuid.UUID
	var expiresAt time.Time
	err := service.database.QueryRow(request.Context(), `
		UPDATE agent_console_ws_tickets
		SET consumed_at = $2
		WHERE ticket_digest = $1 AND consumed_at IS NULL AND expires_at > $2
		RETURNING auth_session_id, owner_id, expires_at
	`, digest, now).Scan(&authSessionID, &ownerID, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		service.writeTicketRejection(response, request, digest, now)
		return
	}
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	// ticket 已被本次消费占用；对应登录会话必须仍然有效（ revoked/expired
	// session 签发的 ticket 不能消费）。失败即拒绝，ticket 不会复活。
	state, ok, err := service.inspectAuthSession(request.Context(), authSessionID)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if !ok {
		httpapi.WriteJSON(response, http.StatusOK, ticketConsumeResult{Valid: false, Reason: ticketReasonSessionInvalid})
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, ticketConsumeResult{
		Valid:         true,
		AuthSessionID: authSessionID,
		OwnerID:       ownerID,
		ExpiresAt:     &state.expiresAt,
	})
}

// writeTicketRejection reports why a ticket did not consume, without mutating it.
func (service *Service) writeTicketRejection(response http.ResponseWriter, request *http.Request, digest []byte, now time.Time) {
	reason := ticketReasonNotFound
	var consumedAt *time.Time
	var expiresAt time.Time
	err := service.database.QueryRow(request.Context(), `
		SELECT consumed_at, expires_at FROM agent_console_ws_tickets WHERE ticket_digest = $1
	`, digest).Scan(&consumedAt, &expiresAt)
	if err == nil {
		switch {
		case consumedAt != nil:
			reason = ticketReasonConsumed
		case !expiresAt.After(now):
			reason = ticketReasonExpired
		}
	}
	httpapi.WriteJSON(response, http.StatusOK, ticketConsumeResult{Valid: false, Reason: reason})
}

type sessionIntrospection struct {
	Valid         bool       `json:"valid"`
	OwnerID       uuid.UUID  `json:"ownerId,omitempty"`
	ExpiresAt     *time.Time `json:"expiresAt,omitempty"`
	RevokedReason string     `json:"revokedReason,omitempty"`
}

type authSessionState struct {
	authSessionID uuid.UUID
	ownerID       uuid.UUID
	expiresAt     time.Time
	revokedReason string
}

// inspectAuthSession mirrors the browser session conditions (revoked, expires,
// 24h idle, password change) for one session ID. It never updates last_seen_at.
func (service *Service) inspectAuthSession(ctx context.Context, sessionID uuid.UUID) (authSessionState, bool, error) {
	now := service.now().UTC()
	var state authSessionState
	var revokedAt *time.Time
	var lastSeenAt time.Time
	var passwordCurrent bool
	err := service.database.QueryRow(ctx, `
		SELECT s.id, owner.id, s.expires_at, s.revoked_at, s.last_seen_at,
		       s.created_at >= owner.password_changed_at
		FROM auth_sessions s
		CROSS JOIN owner_account owner
		WHERE s.id = $1
	`, sessionID).Scan(&state.authSessionID, &state.ownerID, &state.expiresAt, &revokedAt, &lastSeenAt, &passwordCurrent)
	if errors.Is(err, pgx.ErrNoRows) {
		return authSessionState{authSessionID: sessionID, revokedReason: sessionReasonNotFound}, false, nil
	}
	if err != nil {
		return authSessionState{}, false, err
	}
	switch {
	case revokedAt != nil:
		state.revokedReason = sessionReasonRevoked
	case !state.expiresAt.After(now):
		state.revokedReason = sessionReasonExpired
	case !passwordCurrent:
		state.revokedReason = sessionReasonPassword
	case !lastSeenAt.After(now.Add(-24 * time.Hour)):
		state.revokedReason = sessionReasonIdle
	}
	return state, state.revokedReason == "", nil
}

// introspectAgentConsoleSession answers Relay's periodic revocation checks.
// It must not refresh the 24h idle window, so last_seen_at stays untouched.
func (service *Service) introspectAgentConsoleSession(response http.ResponseWriter, request *http.Request) {
	var input struct {
		AuthSessionID string `json:"authSessionId"`
	}
	if httpapi.DecodeJSON(response, request, 4096, &input) != nil {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "authSessionId 无效")
		return
	}
	sessionID, err := uuid.Parse(input.AuthSessionID)
	if err != nil {
		httpapi.WriteJSON(response, http.StatusOK, sessionIntrospection{Valid: false, RevokedReason: sessionReasonNotFound})
		return
	}
	state, valid, err := service.inspectAuthSession(request.Context(), sessionID)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		return
	}
	if !valid {
		httpapi.WriteJSON(response, http.StatusOK, sessionIntrospection{Valid: false, RevokedReason: state.revokedReason})
		return
	}
	expiresAt := state.expiresAt
	httpapi.WriteJSON(response, http.StatusOK, sessionIntrospection{Valid: true, OwnerID: state.ownerID, ExpiresAt: &expiresAt})
}

type sessionVerification struct {
	Valid         bool       `json:"valid"`
	AuthSessionID uuid.UUID  `json:"authSessionId,omitempty"`
	OwnerID       uuid.UUID  `json:"ownerId,omitempty"`
	ExpiresAt     *time.Time `json:"expiresAt,omitempty"`
}

// verifyAgentConsoleSession is the forward-auth entry for /agent-console/api/*.
// The gateway forwards the browser's original Cookie, Origin and X-CSRF-Token
// headers plus X-Agent-Console-Method; it is the same session validation the
// browser endpoints perform, minus the last_seen touch. Valid responses also
// carry the identity headers the gateway copies onto the Relay request after
// deleting any client-supplied copies.
func (service *Service) verifyAgentConsoleSession(response http.ResponseWriter, request *http.Request) {
	token := sessionTokenFromCookieHeader(request.Header.Get("Cookie"))
	session, ok := service.lookupSession(request.Context(), token)
	if ok && isAgentConsoleWrite(request.Header.Get(agentConsoleMethodHeader)) {
		ok = service.validOrigin(request) &&
			subtle.ConstantTimeCompare([]byte(request.Header.Get("X-CSRF-Token")), []byte(session.CSRFToken)) == 1
	}
	if !ok {
		httpapi.WriteError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "请先登录")
		return
	}
	expiresAt := session.ExpiresAt
	response.Header().Set(agentConsoleSessionIDHeader, session.ID.String())
	response.Header().Set(agentConsoleOwnerIDHeader, session.OwnerID.String())
	httpapi.WriteJSON(response, http.StatusOK, sessionVerification{
		Valid:         true,
		AuthSessionID: session.ID,
		OwnerID:       session.OwnerID,
		ExpiresAt:     &expiresAt,
	})
}

// isAgentConsoleWrite treats an unknown original method as a write so a
// misconfigured gateway cannot silently skip Origin/CSRF validation.
func isAgentConsoleWrite(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

func sessionTokenFromCookieHeader(value string) string {
	if value == "" {
		return ""
	}
	header := http.Header{}
	header.Set("Cookie", value)
	cookie, err := (&http.Request{Header: header}).Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return cookie.Value
}

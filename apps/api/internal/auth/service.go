package auth

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	sessionCookieName = "__Host-dev-toolbox-session"
	deviceCookieName  = "__Host-dev-toolbox-trusted-device"
)

type Service struct {
	database       *pgxpool.Pool
	masterKey      []byte
	appOrigin      string
	trustedProxies []*net.IPNet
	limiter        *loginLimiter
	dummyHash      string
	now            func() time.Time
}

func NewService(database *pgxpool.Pool, masterKey []byte, appOrigin, trustedProxyCIDRs string) (*Service, error) {
	trustedProxies, err := parseTrustedProxyCIDRs(trustedProxyCIDRs)
	if err != nil {
		return nil, err
	}
	dummyHash, err := HashPassword("invalid-account-placeholder")
	if err != nil {
		return nil, err
	}
	return &Service{
		database:       database,
		masterKey:      append([]byte(nil), masterKey...),
		appOrigin:      appOrigin,
		trustedProxies: trustedProxies,
		limiter:        newLoginLimiter(),
		dummyHash:      dummyHash,
		now:            time.Now,
	}, nil
}

func (service *Service) RegisterRoutes(router *http.ServeMux) {
	router.Handle("POST /api/v1/auth/login", service.OriginOnly(http.HandlerFunc(service.login)))
	router.Handle("POST /api/v1/auth/mfa/verify", service.OriginOnly(http.HandlerFunc(service.verifyMFA)))
	router.Handle("POST /api/v1/auth/totp/setup", service.OriginOnly(http.HandlerFunc(service.setupTOTP)))
	router.Handle("POST /api/v1/auth/totp/confirm", service.OriginOnly(http.HandlerFunc(service.confirmTOTP)))

	router.Handle("GET /api/v1/auth/session", service.Authenticate(http.HandlerFunc(service.sessionBootstrap)))
	router.Handle("POST /api/v1/auth/logout", service.AuthenticateMutation(http.HandlerFunc(service.logout)))
	router.Handle("POST /api/v1/auth/logout-all", service.AuthenticateMutation(http.HandlerFunc(service.logoutAll)))
	router.Handle("POST /api/v1/auth/password/change", service.AuthenticateMutation(http.HandlerFunc(service.changePassword)))
	router.Handle("POST /api/v1/auth/totp/reset", service.AuthenticateMutation(http.HandlerFunc(service.resetTOTP)))
	router.Handle("POST /api/v1/auth/totp/recovery-codes/regenerate", service.AuthenticateMutation(http.HandlerFunc(service.regenerateRecoveryCodes)))
	router.Handle("GET /api/v1/auth/trusted-devices", service.Authenticate(http.HandlerFunc(service.listTrustedDevices)))
	router.Handle("PATCH /api/v1/auth/trusted-devices/{id}", service.AuthenticateMutation(http.HandlerFunc(service.renameTrustedDevice)))
	router.Handle("DELETE /api/v1/auth/trusted-devices/{id}", service.AuthenticateMutation(http.HandlerFunc(service.revokeTrustedDevice)))
	router.Handle("GET /api/v1/auth/sessions", service.Authenticate(http.HandlerFunc(service.listSessions)))
	router.Handle("DELETE /api/v1/auth/sessions/{id}", service.AuthenticateMutation(http.HandlerFunc(service.revokeSession)))
}

type issuedSession struct {
	ID        uuid.UUID
	Token     string
	CSRFToken string
	ExpiresAt time.Time
}

type issuedDevice struct {
	ID        uuid.UUID
	Token     string
	ExpiresAt time.Time
}

func (service *Service) createSession(ctx context.Context, tx pgx.Tx, trustedDeviceID *uuid.UUID, clientIP net.IP, userAgent string) (issuedSession, error) {
	token, err := randomToken()
	if err != nil {
		return issuedSession{}, err
	}
	csrf := csrfToken(service.masterKey, token)
	now := service.now().UTC()
	session := issuedSession{
		ID:        uuid.New(),
		Token:     token,
		CSRFToken: csrf,
		ExpiresAt: now.Add(7 * 24 * time.Hour),
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO auth_sessions (
			id, token_hash, csrf_token_hash, trusted_device_id,
			created_at, last_seen_at, expires_at, client_ip, user_agent
		) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)
	`, session.ID, tokenHash(token), tokenHash(csrf), trustedDeviceID, now, session.ExpiresAt, nullableIP(clientIP), truncateRunes(userAgent, 512))
	if err != nil {
		return issuedSession{}, fmt.Errorf("create session: %w", err)
	}
	return session, nil
}

func (service *Service) createTrustedDevice(ctx context.Context, tx pgx.Tx, displayName string) (issuedDevice, error) {
	token, err := randomToken()
	if err != nil {
		return issuedDevice{}, err
	}
	now := service.now().UTC()
	device := issuedDevice{
		ID:        uuid.New(),
		Token:     token,
		ExpiresAt: now.Add(90 * 24 * time.Hour),
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO trusted_devices (id, token_hash, display_name, created_at, last_used_at, expires_at)
		VALUES ($1, $2, $3, $4, $4, $5)
	`, device.ID, tokenHash(token), normalizedDeviceName(displayName), now, device.ExpiresAt)
	if err != nil {
		return issuedDevice{}, fmt.Errorf("create trusted device: %w", err)
	}
	return device, nil
}

func normalizedDeviceName(value string) string {
	value = truncateRunes(value, 120)
	if value == "" {
		return "可信设备"
	}
	return value
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) > limit {
		runes = runes[:limit]
	}
	return string(runes)
}

func nullableIP(ip net.IP) any {
	if ip == nil {
		return nil
	}
	return ip.String()
}

func setSessionCookie(response http.ResponseWriter, session issuedSession) {
	http.SetCookie(response, &http.Cookie{
		Name:     sessionCookieName,
		Value:    session.Token,
		Path:     "/",
		MaxAge:   int(time.Until(session.ExpiresAt).Seconds()),
		Expires:  session.ExpiresAt,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
}

func setDeviceCookie(response http.ResponseWriter, device issuedDevice) {
	http.SetCookie(response, &http.Cookie{
		Name:     deviceCookieName,
		Value:    device.Token,
		Path:     "/",
		MaxAge:   int(time.Until(device.ExpiresAt).Seconds()),
		Expires:  device.ExpiresAt,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearAuthCookies(response http.ResponseWriter) {
	clearSessionCookie(response)
	clearDeviceCookie(response)
}

func clearSessionCookie(response http.ResponseWriter) {
	clearCookie(response, sessionCookieName)
}

func clearDeviceCookie(response http.ResponseWriter) {
	clearCookie(response, deviceCookieName)
}

func clearCookie(response http.ResponseWriter, name string) {
	http.SetCookie(response, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
}

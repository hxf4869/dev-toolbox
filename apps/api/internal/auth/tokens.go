package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

var patScopes = map[string]struct{}{
	"records:read":     {},
	"records:write":    {},
	"attachments:read": {},
	"artifacts:write":  {},
	"tasks:run":        {},
	"sensitive:read":   {},
}

type tokenEntry struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"tokenPrefix"`
	Scopes     []string   `json:"scopes"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	ExpiresAt  *time.Time `json:"expiresAt"`
	RevokedAt  *time.Time `json:"revokedAt"`
}

func (service *Service) listTokens(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	rows, err := service.database.Query(request.Context(), `
		SELECT id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
		FROM personal_access_tokens ORDER BY created_at DESC, id DESC
	`)
	if err != nil {
		writeTokenInternal(response, request)
		return
	}
	defer rows.Close()
	items := make([]tokenEntry, 0)
	for rows.Next() {
		var entry tokenEntry
		if err := rows.Scan(&entry.ID, &entry.Name, &entry.Prefix, &entry.Scopes, &entry.CreatedAt,
			&entry.LastUsedAt, &entry.ExpiresAt, &entry.RevokedAt); err != nil {
			writeTokenInternal(response, request)
			return
		}
		items = append(items, entry)
	}
	if rows.Err() != nil {
		writeTokenInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (service *Service) createToken(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	var input struct {
		Name      string   `json:"name"`
		Scopes    []string `json:"scopes"`
		ExpiresAt *string  `json:"expiresAt"`
	}
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil {
		writeTokenValidation(response, request)
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" || !utf8.ValidString(name) || len([]rune(name)) > 120 {
		writeTokenValidation(response, request)
		return
	}
	scopes, ok := normalizePATScopes(input.Scopes)
	if !ok {
		writeTokenValidation(response, request)
		return
	}
	now := service.now().UTC()
	var expiresAt *time.Time
	if input.ExpiresAt != nil {
		parsed, err := time.Parse(time.RFC3339, *input.ExpiresAt)
		if err != nil || !parsed.After(now) {
			writeTokenValidation(response, request)
			return
		}
		parsed = parsed.UTC()
		expiresAt = &parsed
	}
	plaintext, err := generatePAT()
	if err != nil {
		writeTokenInternal(response, request)
		return
	}
	prefix := plaintext[:16]
	entry := tokenEntry{ID: uuid.New(), Name: name, Prefix: prefix, Scopes: scopes, CreatedAt: now, ExpiresAt: expiresAt}
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeTokenInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	if _, err := tx.Exec(request.Context(), `
		INSERT INTO personal_access_tokens (
			id, name, token_prefix, token_hash, scopes, created_at, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, entry.ID, entry.Name, entry.Prefix, tokenHash(plaintext), entry.Scopes, now, expiresAt); err != nil {
		writeTokenInternal(response, request)
		return
	}
	if err := service.InsertRequestSecurityEvent(request.Context(), tx, request, "pat_created", map[string]any{
		"tokenId": entry.ID, "scopes": entry.Scopes,
	}); err != nil || tx.Commit(request.Context()) != nil {
		writeTokenInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusCreated, map[string]any{
		"id": entry.ID, "name": entry.Name, "tokenPrefix": entry.Prefix,
		"scopes": entry.Scopes, "createdAt": entry.CreatedAt, "expiresAt": entry.ExpiresAt,
		"token": plaintext,
	})
}

func (service *Service) revokeToken(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	id, err := uuid.Parse(request.PathValue("id"))
	if err != nil {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "Token 不存在")
		return
	}
	now := service.now().UTC()
	tx, err := service.database.BeginTx(request.Context(), pgx.TxOptions{})
	if err != nil {
		writeTokenInternal(response, request)
		return
	}
	defer tx.Rollback(request.Context())
	var revokedAt *time.Time
	if err := tx.QueryRow(request.Context(), `
		SELECT revoked_at FROM personal_access_tokens WHERE id = $1 FOR UPDATE
	`, id).Scan(&revokedAt); errors.Is(err, pgx.ErrNoRows) {
		httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "Token 不存在")
		return
	} else if err != nil {
		writeTokenInternal(response, request)
		return
	}
	if revokedAt == nil {
		if _, err := tx.Exec(request.Context(), "UPDATE personal_access_tokens SET revoked_at = $2 WHERE id = $1", id, now); err != nil {
			writeTokenInternal(response, request)
			return
		}
		if err := service.InsertRequestSecurityEvent(request.Context(), tx, request, "pat_revoked", map[string]any{"tokenId": id}); err != nil {
			writeTokenInternal(response, request)
			return
		}
	}
	if err := tx.Commit(request.Context()); err != nil {
		writeTokenInternal(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func normalizePATScopes(values []string) ([]string, bool) {
	if len(values) == 0 || len(values) > len(patScopes) {
		return nil, false
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, allowed := patScopes[value]; !allowed {
			return nil, false
		}
		if _, duplicate := seen[value]; duplicate {
			return nil, false
		}
		seen[value] = struct{}{}
	}
	result := make([]string, 0, len(seen))
	for value := range seen {
		result = append(result, value)
	}
	sort.Strings(result)
	return result, true
}

func generatePAT() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return "dtb_pat_" + base64.RawURLEncoding.EncodeToString(buffer), nil
}

func writeTokenValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Token 配置无效")
}

func writeTokenInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "Token 服务暂时不可用")
}

package ai

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

func (service *Service) internalOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		httpapi.NoStore(response)
		header := request.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") || !constantTimeTokenEqual(strings.TrimPrefix(header, "Bearer "), service.internalServiceToken) {
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

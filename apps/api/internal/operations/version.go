package operations

import (
	"net/http"
	"os"
	"strings"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

// apiVersion is the public API contract version (AGENTS.md: 公共 API 使用 /api/v1)。
const apiVersion = "v1"

// buildCommit is the place to inject the source revision at build time, e.g.
// go build -ldflags "-X github.com/hxf4869/dev-toolbox/apps/api/internal/operations.buildCommit=$(git rev-parse HEAD)".
// The release chain does not inject it yet, so it stays empty outside tests
// and the handler falls back to GIT_COMMIT and then "unknown" — never a guess.
var buildCommit string

func (handler Handler) version(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	commit := strings.TrimSpace(buildCommit)
	if commit == "" {
		commit = strings.TrimSpace(os.Getenv("GIT_COMMIT"))
	}
	if commit == "" {
		commit = "unknown"
	}
	appVersion := strings.TrimSpace(os.Getenv("APP_VERSION"))
	if appVersion == "" {
		appVersion = "development"
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]string{
		"apiVersion": apiVersion,
		"appVersion": appVersion,
		"commit":     commit,
	})
}

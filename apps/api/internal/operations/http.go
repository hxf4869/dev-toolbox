package operations

import (
	"context"
	"net/http"
	"time"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type databasePinger interface {
	Ping(context.Context) error
}

type Handler struct {
	database databasePinger
}

func RegisterRoutes(router *http.ServeMux, database databasePinger) {
	handler := Handler{database: database}
	router.HandleFunc("GET /health/live", handler.live)
	router.HandleFunc("GET /health/ready", handler.ready)
}

func (handler Handler) live(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	httpapi.WriteJSON(response, http.StatusOK, map[string]string{
		"status":  "live",
		"service": "api",
	})
}

func (handler Handler) ready(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	if err := handler.database.Ping(ctx); err != nil {
		httpapi.WriteError(response, request, http.StatusServiceUnavailable, "INTERNAL_ERROR", "服务尚未就绪")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]string{
		"status":  "ready",
		"service": "api",
	})
}

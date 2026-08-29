package operations

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakePinger struct {
	err error
}

func (pinger fakePinger) Ping(context.Context) error {
	return pinger.err
}

func TestReadinessReportsDatabaseStateWithoutDetails(t *testing.T) {
	router := http.NewServeMux()
	RegisterRoutes(router, fakePinger{err: errors.New("contains private database detail")})
	request := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", response.Code)
	}
	if body := response.Body.String(); body == "" || contains(body, "private database detail") {
		t.Fatalf("unsafe response body = %q", body)
	}
}

func TestLivenessDoesNotDependOnDatabase(t *testing.T) {
	router := http.NewServeMux()
	RegisterRoutes(router, fakePinger{err: errors.New("offline")})
	request := httptest.NewRequest(http.MethodGet, "/health/live", nil)
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
}

func contains(value, fragment string) bool {
	for index := 0; index+len(fragment) <= len(value); index++ {
		if value[index:index+len(fragment)] == fragment {
			return true
		}
	}
	return false
}

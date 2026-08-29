package auth

import (
	"net/http/httptest"
	"testing"
)

func TestClientIPIgnoresForwardedHeaderFromUntrustedPeer(t *testing.T) {
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "203.0.113.5:40123"
	request.Header.Set("X-Forwarded-For", "198.51.100.9")

	if got := clientIP(request, nil).String(); got != "203.0.113.5" {
		t.Fatalf("client IP = %s", got)
	}
}

func TestClientIPUsesForwardedHeaderFromTrustedProxy(t *testing.T) {
	networks, err := parseTrustedProxyCIDRs("172.16.0.0/12")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "172.18.0.4:40123"
	request.Header.Set("X-Forwarded-For", "198.51.100.9, 172.18.0.2")

	if got := clientIP(request, networks).String(); got != "198.51.100.9" {
		t.Fatalf("client IP = %s", got)
	}
}

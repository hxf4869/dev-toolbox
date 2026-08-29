package auth

import (
	"testing"
	"time"
)

func TestLoginLimiterAddsBoundedDelayAfterRepeatedFailure(t *testing.T) {
	now := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	limiter := newLoginLimiter()
	limiter.now = func() time.Time { return now }
	for range 3 {
		limiter.failure("ip:example")
	}
	allowed, retryAfter := limiter.allowed("ip:example")
	if allowed || retryAfter != 500*time.Millisecond {
		t.Fatalf("allowed=%v retryAfter=%v", allowed, retryAfter)
	}
	now = now.Add(time.Second)
	if allowed, _ := limiter.allowed("ip:example"); !allowed {
		t.Fatal("expected limiter to allow after delay")
	}
}

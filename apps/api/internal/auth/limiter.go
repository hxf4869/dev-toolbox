package auth

import (
	"sync"
	"time"
)

type limitEntry struct {
	failures     int
	blockedUntil time.Time
	lastSeen     time.Time
}

type loginLimiter struct {
	mu      sync.Mutex
	entries map[string]limitEntry
	now     func() time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{entries: make(map[string]limitEntry), now: time.Now}
}

func (limiter *loginLimiter) allowed(keys ...string) (bool, time.Duration) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := limiter.now()
	var longest time.Duration
	for _, key := range keys {
		entry := limiter.entries[key]
		if remaining := entry.blockedUntil.Sub(now); remaining > longest {
			longest = remaining
		}
	}
	return longest <= 0, longest
}

func (limiter *loginLimiter) failure(keys ...string) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := limiter.now()
	limiter.prune(now)
	for _, key := range keys {
		entry := limiter.entries[key]
		if now.Sub(entry.lastSeen) > 10*time.Minute {
			entry.failures = 0
		}
		entry.failures++
		entry.lastSeen = now
		if entry.failures >= 3 {
			delay := time.Duration(entry.failures-2) * 500 * time.Millisecond
			if delay > 5*time.Second {
				delay = 5 * time.Second
			}
			entry.blockedUntil = now.Add(delay)
		}
		limiter.entries[key] = entry
	}
}

func (limiter *loginLimiter) success(keys ...string) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	for _, key := range keys {
		delete(limiter.entries, key)
	}
}

func (limiter *loginLimiter) prune(now time.Time) {
	for key, entry := range limiter.entries {
		if now.Sub(entry.lastSeen) > 15*time.Minute {
			delete(limiter.entries, key)
		}
	}
	if len(limiter.entries) < 2048 {
		return
	}
	for key := range limiter.entries {
		delete(limiter.entries, key)
		if len(limiter.entries) < 1536 {
			break
		}
	}
}

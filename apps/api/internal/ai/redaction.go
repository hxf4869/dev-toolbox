package ai

import (
	"regexp"
	"strconv"
	"strings"
)

type textRedactor struct {
	values   map[string]string
	counters map[string]int
}

var (
	privateKeyPattern = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	credentialPattern = regexp.MustCompile(`(?i)\b(password|passwd|token|secret|api[_-]?key)\b(\s*[:=]\s*)([^\s,;]+)`)
	bearerPattern     = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`)
	privateIPPattern  = regexp.MustCompile(`\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b`)
)

func newTextRedactor() *textRedactor {
	return &textRedactor{values: map[string]string{}, counters: map[string]int{}}
}

func (redactor *textRedactor) Redact(value string) string {
	value = privateKeyPattern.ReplaceAllStringFunc(value, func(match string) string {
		return redactor.placeholder("PRIVATE_KEY", match)
	})
	value = credentialPattern.ReplaceAllStringFunc(value, func(match string) string {
		parts := credentialPattern.FindStringSubmatch(match)
		if len(parts) != 4 {
			return redactor.placeholder("CREDENTIAL", match)
		}
		return parts[1] + parts[2] + redactor.placeholder(strings.ToUpper(strings.ReplaceAll(parts[1], "-", "_")), parts[3])
	})
	value = bearerPattern.ReplaceAllStringFunc(value, func(match string) string {
		return "Bearer " + redactor.placeholder("TOKEN", match)
	})
	return privateIPPattern.ReplaceAllStringFunc(value, func(match string) string {
		return redactor.placeholder("INTERNAL_IP", match)
	})
}

func (redactor *textRedactor) placeholder(category, original string) string {
	key := category + "\x00" + original
	if existing, ok := redactor.values[key]; ok {
		return existing
	}
	redactor.counters[category]++
	value := "<" + category + "_" + strconv.Itoa(redactor.counters[category]) + ">"
	redactor.values[key] = value
	return value
}

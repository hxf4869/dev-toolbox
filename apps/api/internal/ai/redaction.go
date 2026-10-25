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
	credentialPattern = regexp.MustCompile(`(?i)\b((?:[a-z0-9]+[_-])*(?:password|passwd|username|token|secret|api[_-]?key))\b(["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)`)
	bearerPattern     = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`)
	privateIPPattern  = regexp.MustCompile(`\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b`)
)

// NewTextRedactor builds a per-request redactor. The assistant module reuses this
// exported entry so knowledge snippets follow the same deterministic rules; the
// placeholder format and algorithms must stay identical to the one-shot behavior.
func NewTextRedactor() *textRedactor {
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
		return parts[1] + parts[2] + redactor.placeholder(credentialCategory(parts[1]), parts[3])
	})
	value = bearerPattern.ReplaceAllStringFunc(value, func(match string) string {
		return "Bearer " + redactor.placeholder("TOKEN", match)
	})
	return privateIPPattern.ReplaceAllStringFunc(value, func(match string) string {
		return redactor.placeholder("INTERNAL_IP", match)
	})
}

func (redactor *textRedactor) RedactArtifact(value any) any {
	switch typed := value.(type) {
	case string:
		return redactor.Redact(typed)
	case map[string]any:
		for key, nested := range typed {
			typed[key] = redactor.RedactArtifact(nested)
		}
	case []any:
		for index, nested := range typed {
			typed[index] = redactor.RedactArtifact(nested)
		}
	}
	return value
}

func credentialCategory(key string) string {
	normalized := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
	switch {
	case strings.HasSuffix(normalized, "password"), strings.HasSuffix(normalized, "passwd"):
		return "PASSWORD"
	case strings.HasSuffix(normalized, "username"):
		return "USERNAME"
	case strings.HasSuffix(normalized, "api_key"):
		return "API_KEY"
	case strings.HasSuffix(normalized, "token"):
		return "TOKEN"
	case strings.HasSuffix(normalized, "secret"):
		return "SECRET"
	default:
		return "CREDENTIAL"
	}
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

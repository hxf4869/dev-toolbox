package ai

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

var providerKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

var errInvalidProviderInput = errors.New("invalid provider input")

// NormalizeProviderBaseURL is the exported URL validation entry reused by the
// assistant module; the security rules must stay identical for both paths.
func NormalizeProviderBaseURL(value string, allowHTTP bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 2048 {
		return "", errInvalidProviderInput
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Scheme != "https" && !(allowHTTP && parsed.Scheme == "http")) {
		return "", errInvalidProviderInput
	}
	escapedPath := strings.TrimRight(parsed.EscapedPath(), "/")
	decodedPath, err := url.PathUnescape(escapedPath)
	if err != nil {
		return "", errInvalidProviderInput
	}
	parsed.Path = decodedPath
	if decodedPath == escapedPath {
		parsed.RawPath = ""
	} else {
		parsed.RawPath = escapedPath
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func validProviderKey(value string) bool {
	return len(value) <= 64 && providerKeyPattern.MatchString(value)
}

func validProtocol(value string) bool {
	return value == "openai-completions" || value == "openai-responses" || value == "anthropic-messages"
}

func validProviderName(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && utf8.ValidString(value) && len([]rune(value)) <= 120
}

func validAPIKey(value string) bool {
	return value != "" && strings.TrimSpace(value) == value && utf8.ValidString(value) && len(value) <= 8192
}

func keyTail(value string) string {
	runes := []rune(value)
	if len(runes) > 4 {
		runes = runes[len(runes)-4:]
	}
	return string(runes)
}

func validModelInput(input modelInput) bool {
	modelID := strings.TrimSpace(input.ModelID)
	name := strings.TrimSpace(input.DisplayName)
	if modelID == "" || !utf8.ValidString(modelID) || len([]rune(modelID)) > 200 ||
		name == "" || !utf8.ValidString(name) || len([]rune(name)) > 120 {
		return false
	}
	if input.ContextWindow != nil && *input.ContextWindow <= 0 || input.MaxOutputTokens != nil && *input.MaxOutputTokens <= 0 {
		return false
	}
	return input.ContextWindow == nil || input.MaxOutputTokens == nil || *input.MaxOutputTokens < *input.ContextWindow
}

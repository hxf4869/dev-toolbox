package ai

import "testing"

func TestNormalizeProviderBaseURL(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		value     string
		allowHTTP bool
		want      string
	}{
		{name: "https root", value: "https://provider.example/", want: "https://provider.example"},
		{name: "path without slash", value: "https://provider.example/gateway/v1", want: "https://provider.example/gateway/v1"},
		{name: "path with slash", value: "https://provider.example/gateway/v1/", want: "https://provider.example/gateway/v1"},
		{name: "escaped path", value: "https://provider.example/team%20one/v1/", want: "https://provider.example/team%20one/v1"},
		{name: "escaped slash remains data", value: "https://provider.example/team%2Fone/", want: "https://provider.example/team%2Fone"},
		{name: "explicit development http", value: "http://127.0.0.1:11434/api/", allowHTTP: true, want: "http://127.0.0.1:11434/api"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeProviderBaseURL(test.value, test.allowHTTP)
			if err != nil || got != test.want {
				t.Fatalf("normalizeProviderBaseURL(%q) = %q, %v; want %q", test.value, got, err, test.want)
			}
		})
	}
}

func TestNormalizeProviderBaseURLRejectsUnsafeValues(t *testing.T) {
	t.Parallel()
	for _, value := range []string{
		"http://provider.example/v1",
		"https://user:secret@provider.example/v1",
		"https://provider.example/v1?token=value",
		"https://provider.example/v1#fragment",
		"file:///tmp/provider",
		"/relative/path",
	} {
		t.Run(value, func(t *testing.T) {
			if _, err := normalizeProviderBaseURL(value, false); err == nil {
				t.Fatalf("normalizeProviderBaseURL(%q) unexpectedly succeeded", value)
			}
		})
	}
}

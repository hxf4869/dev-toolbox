package ai

import (
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestTextRedactorRedactsNamespacedCredentialKeys(t *testing.T) {
	redacted := newTextRedactor().Redact(strings.Join([]string{
		"KAFKA_MANAGER_USERNAME: demo-user",
		"KAFKA_MANAGER_PASSWORD: DemoPassword-2026",
		"APPLICATION_SECRET=DemoApplicationSecret",
		"DB_PASSWORD=DemoPassword-2026",
	}, "\n"))

	for _, value := range []string{"demo-user", "DemoPassword-2026", "DemoApplicationSecret"} {
		if strings.Contains(redacted, value) {
			t.Fatalf("credential value remained after redaction: %q", value)
		}
	}
	for _, placeholder := range []string{"<USERNAME_1>", "<PASSWORD_1>", "<SECRET_1>"} {
		if !strings.Contains(redacted, placeholder) {
			t.Fatalf("missing placeholder %q in %q", placeholder, redacted)
		}
	}
	if strings.Count(redacted, "<PASSWORD_1>") != 2 {
		t.Fatalf("repeated password did not reuse its placeholder: %q", redacted)
	}
}

func TestTextRedactorRedactsNestedArtifactStrings(t *testing.T) {
	artifact := map[string]any{
		"artifactType":      "organized_record",
		"schemaVersion":     "1.0",
		"sourceFragmentIds": []any{"30272dc4-6069-55f1-9c15-885cb9ac5bd0"},
		"blocks": []any{
			map[string]any{
				"type": "code",
				"text": "KAFKA_MANAGER_PASSWORD=DemoPassword-2026\nAPPLICATION_SECRET=DemoApplicationSecret",
			},
			map[string]any{
				"type": "paragraph",
				"text": "DB_PASSWORD: DemoPassword-2026",
			},
		},
		"metadata": map[string]any{
			"enabled": true,
			"count":   float64(2),
		},
	}

	newTextRedactor().RedactArtifact(artifact)

	encoded := artifact["blocks"].([]any)
	first := encoded[0].(map[string]any)["text"].(string)
	second := encoded[1].(map[string]any)["text"].(string)
	for _, value := range []string{"DemoPassword-2026", "DemoApplicationSecret"} {
		if strings.Contains(first+second, value) {
			t.Fatalf("credential value remained after nested redaction: %q", value)
		}
	}
	if !strings.Contains(first, "KAFKA_MANAGER_PASSWORD=<PASSWORD_1>") ||
		!strings.Contains(first, "APPLICATION_SECRET=<SECRET_1>") ||
		!strings.Contains(second, "DB_PASSWORD: <PASSWORD_1>") {
		t.Fatalf("unexpected redacted artifact strings: %q / %q", first, second)
	}
	if artifact["artifactType"] != "organized_record" || artifact["schemaVersion"] != "1.0" ||
		!reflect.DeepEqual(artifact["sourceFragmentIds"], []any{"30272dc4-6069-55f1-9c15-885cb9ac5bd0"}) ||
		!reflect.DeepEqual(artifact["metadata"], map[string]any{"enabled": true, "count": float64(2)}) {
		t.Fatalf("artifact structure changed during redaction: %#v", artifact)
	}
}

func TestRedactedArtifactPlaceholdersRemainValidMarkdown(t *testing.T) {
	fragmentID := uuid.MustParse("30272dc4-6069-55f1-9c15-885cb9ac5bd0")
	artifact := map[string]any{
		"sourceFragmentIds": []any{fragmentID.String()},
		"classification":    map[string]any{"suggestedTags": []any{}},
		"blocks": []any{map[string]any{
			"id": "block_1", "type": "markdown",
			"markdown":          "KAFKA_MANAGER_PASSWORD=DemoPassword-2026，服务地址为 192.168.1.20。",
			"sourceFragmentIds": []any{fragmentID.String()},
		}},
	}

	newTextRedactor().RedactArtifact(artifact)

	if !validateArtifactStructure(artifact, map[uuid.UUID]struct{}{fragmentID: {}}) {
		t.Fatal("server-generated redaction placeholders were rejected as raw HTML")
	}
	markdown := artifact["blocks"].([]any)[0].(map[string]any)["markdown"].(string)
	if !strings.Contains(markdown, "<PASSWORD_1>") || !strings.Contains(markdown, "<INTERNAL_IP_1>") {
		t.Fatalf("expected typed redaction placeholders, got %q", markdown)
	}
	if !containsRawArtifactHTML("<script>alert(1)</script>") {
		t.Fatal("real HTML must remain rejected")
	}
	if !containsRawArtifactHTML("<UNRECOGNIZED_1>") {
		t.Fatal("unknown angle-bracket tokens must remain rejected")
	}
}

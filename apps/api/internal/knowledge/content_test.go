package knowledge

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSensitiveGeneratedTitleNeverIncludesBody(t *testing.T) {
	body := "Bearer synthetic-secret-token"
	title := generatedTitle(body, "sensitive", nil, time.FixedZone("CST", 8*60*60), time.Date(2026, 8, 30, 1, 2, 0, 0, time.UTC))
	if strings.Contains(title, "synthetic") || title != "敏感记录 · 08-30 09:02" {
		t.Fatalf("title = %q", title)
	}
}

func TestFragmentsPreserveByteRangesAndMaximum(t *testing.T) {
	body := "# 标题\n\n普通段落\n\n```sh\n" + strings.Repeat("echo 中文路径\n", 900) + "```\n"
	fragments := splitTextFragments(uuid.MustParse("2d4e8bdf-6e4e-4d7b-a11d-994b1f18a017"), body)
	if len(fragments) < 3 {
		t.Fatalf("fragment count = %d", len(fragments))
	}
	for _, fragment := range fragments {
		if fragment.EndByte-fragment.StartByte > fragmentMaximum {
			t.Fatalf("fragment %d exceeds maximum", fragment.Ordinal)
		}
		if body[fragment.StartByte:fragment.EndByte] != fragment.Content {
			t.Fatalf("fragment %d byte range drifted", fragment.Ordinal)
		}
	}
	if fragments[1].ID != splitTextFragments(uuid.MustParse("2d4e8bdf-6e4e-4d7b-a11d-994b1f18a017"), body)[1].ID {
		t.Fatal("fragment ID is not deterministic")
	}
}

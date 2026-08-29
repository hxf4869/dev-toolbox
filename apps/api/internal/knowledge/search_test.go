package knowledge

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestEscapeLikeTreatsSearchSyntaxAsLiteral(t *testing.T) {
	if got := escapeLike(`100%_C:\ops`); got != `100\%\_C:\\ops` {
		t.Fatalf("escaped query = %q", got)
	}
}

func TestHighlightedPartsArePlainRuneSafeText(t *testing.T) {
	for _, test := range []struct {
		content string
		query   string
	}{
		{content: "前缀 👩🏽‍💻 挂载 <script>alert(1)</script> 后缀", query: "挂载"},
		{content: "emoji 👩🏽‍💻 保持完整", query: "👩🏽‍💻"},
		{content: "组合字符 Cafe\u0301 完整", query: "Cafe\u0301"},
	} {
		parts := highlightedParts(test.content, test.query)
		var rebuilt strings.Builder
		highlighted := ""
		for _, part := range parts {
			rebuilt.WriteString(part.Text)
			if part.Highlighted {
				highlighted += part.Text
			}
		}
		if rebuilt.String() != test.content || highlighted != test.query {
			t.Fatalf("highlight drifted: rebuilt=%q highlighted=%q", rebuilt.String(), highlighted)
		}
		if strings.Contains(test.content, "<script>") && !strings.Contains(rebuilt.String(), "<script>") {
			t.Fatal("plain snippet unexpectedly rewrote source text")
		}
	}
}

func TestSearchNormalizationUnifiesLineEndingsAndWhitespace(t *testing.T) {
	if got := normalizeSearch(" Docker\r\n\tMOUNT   /Dev/SDB1 "); got != "docker mount /dev/sdb1" {
		t.Fatalf("normalized search = %q", got)
	}
}

func TestSearchCursorRejectsSortMismatchAndUnknownFields(t *testing.T) {
	cursor := searchCursor{
		Sort: "relevance", MatchClass: 4, Similarity: 1,
		Effective: time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC), ItemID: uuid.New(),
	}
	encoded, err := encodeSearchCursor(cursor)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeSearchCursor(encoded, "recency"); err == nil {
		t.Fatal("cursor from another sort was accepted")
	}
	if _, err := decodeSearchCursor("eyJzIjoicmVsZXZhbmNlIiwidW5rbm93biI6dHJ1ZX0", "relevance"); err == nil {
		t.Fatal("cursor with unknown fields was accepted")
	}
}

func TestSensitivityOnlyAutoUpgrades(t *testing.T) {
	tests := []struct {
		current  string
		incoming string
		want     string
	}{
		{current: "normal", incoming: "unknown", want: "unknown"},
		{current: "unknown", incoming: "sensitive", want: "sensitive"},
		{current: "sensitive", incoming: "normal", want: "sensitive"},
		{current: "unknown", incoming: "normal", want: "unknown"},
	}
	for _, test := range tests {
		if got := stricterSensitivity(test.current, test.incoming); got != test.want {
			t.Fatalf("stricterSensitivity(%q, %q) = %q, want %q", test.current, test.incoming, got, test.want)
		}
	}
}

func TestPreviewBoundsAndThumbnailDimensions(t *testing.T) {
	width, height := 800, 400
	if !previewAllowed("image", "image/png", &width, &height) {
		t.Fatal("ordinary PNG should allow preview")
	}
	if gotWidth, gotHeight := thumbnailDimensions(width, height); gotWidth != 512 || gotHeight != 256 {
		t.Fatalf("thumbnail dimensions = %dx%d", gotWidth, gotHeight)
	}
	tooWide, one := 20_000, 1
	if previewAllowed("image", "image/png", &tooWide, &one) {
		t.Fatal("oversized image should not allow preview")
	}
	if previewAllowed("file", "image/png", &width, &height) {
		t.Fatal("non-image attachment should not allow preview")
	}
}

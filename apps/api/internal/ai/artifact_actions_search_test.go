package ai

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSplitArtifactSearchTextBoundsAndPreservesUTF8(t *testing.T) {
	value := strings.Repeat("中间件命令 <example> --flag=value\n", 400)
	fragments := splitArtifactSearchText(value)
	if len(fragments) < 2 {
		t.Fatalf("fragment count = %d, want at least 2", len(fragments))
	}
	if joined := strings.Join(fragments, ""); joined != value {
		t.Fatal("fragments did not preserve the search text")
	}
	for index, fragment := range fragments {
		if len(fragment) > artifactSearchFragmentMaximum {
			t.Fatalf("fragment %d is %d bytes", index, len(fragment))
		}
		if !utf8.ValidString(fragment) {
			t.Fatalf("fragment %d is not valid UTF-8", index)
		}
	}
}

func TestSplitArtifactSearchTextOmitsEmptyContent(t *testing.T) {
	if fragments := splitArtifactSearchText(" \n\t "); len(fragments) != 0 {
		t.Fatalf("fragments = %q, want none", fragments)
	}
}

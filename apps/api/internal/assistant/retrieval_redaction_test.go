package assistant

import (
	"strings"
	"testing"
)

func TestBuildSourceSnapshotsRedactsTitlesAndContentUnderRedactPolicy(t *testing.T) {
	title := "部署 password=hunter2 指南"
	content := "api_key=sk-ant-synthetic-000 连接 internal 10.0.0.7"
	candidates := []retrievalCandidate{
		{Title: title, Content: content, Sensitivity: "normal"},
		{Title: title, Content: content, Sensitivity: "sensitive"},
	}

	snapshots := buildSourceSnapshots(candidates, "redact")

	for index, snapshot := range snapshots {
		if strings.Contains(snapshot.Title, "hunter2") {
			t.Fatalf("snapshot %d title still contains the synthetic password: %q", index, snapshot.Title)
		}
		if strings.Contains(snapshot.Content, "sk-ant-synthetic-000") {
			t.Fatalf("snapshot %d content still contains the synthetic api key: %q", index, snapshot.Content)
		}
		if !strings.Contains(snapshot.Title, "<PASSWORD_") {
			t.Fatalf("snapshot %d title missing redaction placeholder: %q", index, snapshot.Title)
		}
		if !strings.Contains(snapshot.Content, "<API_KEY_") {
			t.Fatalf("snapshot %d content missing redaction placeholder: %q", index, snapshot.Content)
		}
	}
	// The same secret in title and content of one source must resolve to the
	// same placeholder so the model sees a consistent view of one source.
	sameValue := "token=abc-synthetic-secret"
	shared := buildSourceSnapshots([]retrievalCandidate{{Title: sameValue, Content: sameValue}}, "redact")
	if shared[0].Title != shared[0].Content {
		t.Fatalf("title and content placeholders diverge: %q vs %q", shared[0].Title, shared[0].Content)
	}
}

func TestBuildSourceSnapshotsKeepsAllowPolicyUntouched(t *testing.T) {
	candidates := []retrievalCandidate{{Title: "password=hunter2", Content: "api_key=sk-ant-synthetic-000"}}
	snapshots := buildSourceSnapshots(candidates, "allow")
	if snapshots[0].Title != "password=hunter2" || snapshots[0].Content != "api_key=sk-ant-synthetic-000" {
		t.Fatalf("allow policy must not rewrite source text: %+v", snapshots[0])
	}
}

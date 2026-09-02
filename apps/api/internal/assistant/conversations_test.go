package assistant

import "testing"

func TestStripCitationTokens(t *testing.T) {
	for _, test := range []struct {
		name, input, want string
	}{
		{"empty", "", ""},
		{"canonical", "版本[[C1]]，配置[[C2]]", "版本，配置"},
		{"legacy", "版本[S4]，配置[S3][S4]", "版本，配置"},
		{"mixed", "版本[S8][[C1]]，配置[S1]", "版本，配置"},
		{"ordinary labels", "[SQL] [Source] [1] [S]", "[SQL] [Source] [1] [S]"},
		{"incomplete ordinary text", "[S [S1", "[S [S1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := stripCitationTokens(test.input); got != test.want {
				t.Fatalf("stripCitationTokens() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSummarySourceDoesNotReplayOldAssistantSourceOrdinals(t *testing.T) {
	history := make([]historyEntry, SummaryMessageTrigger)
	history = append(history,
		historyEntry{role: "assistant", content: "旧结论[S3][[C1]]", sequence: 2},
		historyEntry{role: "user", content: "解释 [S3]", sequence: 1},
	)
	summary := (&Service{}).summarySourceFor(history, 0)
	if summary == nil || len(summary.Messages) != 2 {
		t.Fatalf("expected the two older messages in summary input, got %#v", summary)
	}
	if summary.Messages[0].Content != "解释 [S3]" || summary.Messages[1].Content != "旧结论" {
		t.Fatalf("user text must stay intact and old assistant markers must be removed: %#v", summary.Messages)
	}
}

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
	summary := (&Service{}).summarySourceFor(history, 0, nil)
	if summary == nil || len(summary.Messages) != 2 {
		t.Fatalf("expected the two older messages in summary input, got %#v", summary)
	}
	if summary.Prior != nil {
		t.Fatalf("no stored summary means no maintenance baseline, got %#v", summary.Prior)
	}
	if summary.Messages[0].Content != "解释 [S3]" || summary.Messages[1].Content != "旧结论" {
		t.Fatalf("user text must stay intact and old assistant markers must be removed: %#v", summary.Messages)
	}
}

func TestSummarySourceCarriesMatchingBaselineForCumulativeMaintenance(t *testing.T) {
	history := make([]historyEntry, SummaryMessageTrigger)
	for index := range history {
		history[index] = historyEntry{role: "user", content: "近期", sequence: int64(26 - index)}
	}
	history = append(history,
		historyEntry{role: "user", content: "旧新消息", sequence: 9},
		historyEntry{role: "assistant", content: "旧覆盖消息", sequence: 8},
	)
	baseline := int64(8)
	prior := &claimSummaryPrior{
		ThroughMessageSequence: baseline,
		Summary:                claimRunSummary{ConfirmedFacts: []string{"仍然成立的事实"}},
	}
	summary := (&Service{}).summarySourceFor(history, baseline, prior)
	if summary == nil || len(summary.Messages) != 1 {
		t.Fatalf("only the message past the baseline must be compressed, got %#v", summary)
	}
	if summary.Prior != prior || summary.Prior.ThroughMessageSequence != baseline {
		t.Fatalf("the maintenance baseline must travel with the messages: %#v", summary.Prior)
	}
	if summary.Messages[0].Sequence != 9 || summary.Messages[0].Content != "旧新消息" {
		t.Fatalf("unexpected compress message: %#v", summary.Messages[0])
	}
	// Everything covered by the baseline leaves nothing to compress, so no
	// maintenance input is produced at all.
	if covered := (&Service{}).summarySourceFor(history, 9, prior); covered != nil {
		t.Fatalf("a fully covered history must not schedule maintenance: %#v", covered)
	}
}

func TestClaimContextSensitivePatternCoversSummaryMaintenanceInput(t *testing.T) {
	contextValue := claimRunContext{
		Question: "普通问题",
		SummarySource: &claimSummarySource{
			Prior: &claimSummaryPrior{
				ThroughMessageSequence: 3,
				Summary:                claimRunSummary{ConfirmedFacts: []string{"api_key=baseline-secret"}},
			},
			Messages: []claimSummaryMessage{{Sequence: 4, Role: "user", Content: "token=new-secret"}},
		},
	}
	if !claimContextMatchesSensitivePattern(contextValue) {
		t.Fatal("a secret inside the summary maintenance baseline or new messages was not detected")
	}
}

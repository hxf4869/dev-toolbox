package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRunCanStopHonorsRequestedStop(t *testing.T) {
	now := time.Now()
	if !(runRow{Status: "queued"}).canStop() || !(runRow{Status: "running"}).canStop() {
		t.Fatal("queued and running runs should be stoppable before a request")
	}
	if (runRow{Status: "running", StopRequestedAt: &now}).canStop() {
		t.Fatal("a running run must stop advertising canStop after stop was requested")
	}
}

func TestTotalRunTimingSumsRecordedPhases(t *testing.T) {
	rewrite, embedding, answer := int64(12), int64(8), int64(30)
	got := totalRunTiming(runRow{RewriteMS: &rewrite, EmbeddingMS: &embedding, AnswerMS: &answer})
	if got == nil || *got != 50 {
		t.Fatalf("totalRunTiming = %v, want 50", got)
	}
	if totalRunTiming(runRow{}) != nil {
		t.Fatal("an entirely unmeasured run must keep totalMs null")
	}
}

func TestRunTimingsUsesCamelCaseRetrievalMs(t *testing.T) {
	encoded, err := json.Marshal(RunTimingsDTO{})
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if !strings.Contains(text, `"retrievalMs"`) || strings.Contains(text, `"retrievalMS"`) {
		t.Fatalf("unexpected timing JSON: %s", text)
	}
}

func TestValidEventPayloadRequiresPublicRuntimeShape(t *testing.T) {
	validSources := json.RawMessage(`{
		"knowledgeState":"ready","evidenceState":"matched",
		"providedSourceCount":2,"rewriteFallback":true
	}`)
	if !validEventPayload("sources.ready", validSources) {
		t.Fatal("valid sources.ready payload was rejected")
	}
	if validEventPayload("sources.ready", json.RawMessage(`{
		"knowledgeState":"ready","evidenceState":"matched","providedSourceCount":2
	}`)) {
		t.Fatal("sources.ready without rewriteFallback was accepted")
	}
	if !validEventPayload("usage.updated", json.RawMessage(`{"usage":{
		"rewriteInputTokens":null,"rewriteOutputTokens":2,
		"answerInputTokens":10,"answerOutputTokens":4
	}}`)) {
		t.Fatal("valid nested usage payload was rejected")
	}
	if validEventPayload("usage.updated", json.RawMessage(`{"rewriteInputTokens":2}`)) {
		t.Fatal("legacy top-level usage payload was accepted")
	}
}

func TestInputContextBudgetDoesNotPreRejectSmallModels(t *testing.T) {
	if got := inputContextBudgetTokens(16_384, 2_048); got <= 0 {
		t.Fatalf("usable model input budget was lost to source reservation: %d", got)
	}
}

func TestContextUsageAcceptsLegacyMissingButRejectsInvalidMeasurement(t *testing.T) {
	for _, value := range []string{"null", "18400", "-1", "1.5"} {
		payload := json.RawMessage(`{"usage":{"rewriteInputTokens":null,"rewriteOutputTokens":null,"answerInputTokens":980,"answerOutputTokens":230,"answerContextTokens":` + value + `}}`)
		want := value == "null" || value == "18400"
		if validEventPayload("usage.updated", payload) != want {
			t.Errorf("context usage %s: acceptance should be %t", value, want)
		}
	}
	negative := int64(-1)
	if !negativeUsage(runUsageInput{AnswerContextTokens: &negative}) {
		t.Fatal("negative terminal context usage was accepted")
	}
	var legacy runUsageInput
	if err := json.Unmarshal([]byte(`{"answerInputTokens":980}`), &legacy); err != nil || legacy.AnswerContextTokens != nil {
		t.Fatal("missing cached-input measurement must remain unknown")
	}
	encoded, err := json.Marshal(RunUsageDTO{})
	if err != nil || !strings.Contains(string(encoded), `"answerContextTokens":null`) {
		t.Fatal("unmeasured public usage must include an explicit null")
	}
}

func TestTemporaryPolicyTighteningCancelsOnlyWeakerRuns(t *testing.T) {
	service := &Service{}
	allowContext, unregisterAllow := service.registerTemporaryRun(context.Background(), "allow")
	defer unregisterAllow()
	blockContext, unregisterBlock := service.registerTemporaryRun(context.Background(), "block")
	defer unregisterBlock()

	service.cancelTemporaryRuns("redact")
	select {
	case <-allowContext.Done():
		if !errors.Is(context.Cause(allowContext), errTemporarySensitivePolicyChanged) {
			t.Fatalf("allow run cancellation cause = %v", context.Cause(allowContext))
		}
	default:
		t.Fatal("allow temporary run was not cancelled by redact tightening")
	}
	select {
	case <-blockContext.Done():
		t.Fatal("an already stricter temporary run was cancelled")
	default:
	}
}

func TestBlockPolicyScansTheWholeOutboundContext(t *testing.T) {
	contextValue := claimRunContext{
		Messages: []claimRunMessage{{Role: "user", Content: "api_key=history-secret"}},
		Question: "普通问题",
	}
	if !claimContextMatchesSensitivePattern(contextValue) {
		t.Fatal("persistent history secret was not detected")
	}
	temporary := temporaryStreamInput{
		Messages: []temporaryHistoryMessage{{Role: "user", Content: "token=temporary-secret"}},
		Content:  "普通问题",
	}
	if !temporaryInputMatchesSensitivePattern(temporary) {
		t.Fatal("temporary history secret was not detected")
	}
}

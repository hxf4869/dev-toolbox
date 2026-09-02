package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/assistant"
)

func fixture(t *testing.T) (dataset, report) {
	t.Helper()
	input, err := readDataset("testdata/synthetic.json", "../../../../docs/contracts/assistant-evaluation.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	output := report{Version: 1, Kind: input.Kind}
	for _, q := range input.Questions {
		generation, accepted, evidence := int64(1), true, "matched"
		r := result{QuestionID: q.ID, Question: q.Content, Run: assistant.AssistantRunDTO{
			ID: uuid.New(), Status: "succeeded", KnowledgeState: "ready", EvidenceState: &evidence,
		}, KnowledgeGeneration: &generation, Sources: []source{}, Human: humanReview{Accepted: &accepted}}
		if q.Expected == "answer" {
			for i, id := range q.ExpectedFragments {
				number := i + 1
				r.Sources = append(r.Sources, source{Ordinal: number, FragmentID: &id, CitationNumber: &number})
			}
			r.Answer = "合成验收答案 [[C1]]"
			if len(r.Sources) > 1 {
				r.Answer += " 和 [[C2]]"
			}
			r.Run.ProvidedSourceCount, r.Run.CitationCount = len(r.Sources), len(r.Sources)
		} else {
			evidence = "not_found"
			r.Answer = "当前知识库未找到足够依据。"
		}
		output.Results = append(output.Results, r)
	}
	return input, output
}

func TestSyntheticThresholdsNeverClaimRealAcceptance(t *testing.T) {
	input, output := fixture(t)
	summary, err := scoreReport(input, output)
	if err != nil || !summary.ThresholdsMet || summary.RealEvaluationAccepted || summary.ExpectedSourcesFound != 34 {
		t.Fatalf("wrong summary: %+v %v", summary, err)
	}
	output.Results[0].Human.Accepted = nil
	summary, err = scoreReport(input, output)
	if err != nil || summary.ThresholdsMet || summary.HumanReviewsComplete != 39 {
		t.Fatal("missing human review accepted")
	}
}

func TestRetrievalThresholdAndGroundedThreshold(t *testing.T) {
	input, output := fixture(t)
	input.Kind, output.Kind = "real", "real"
	for i := 0; i < 3; i++ {
		output.Results[i].Sources = nil
		output.Results[i].Answer = "未找到期望来源"
		output.Results[i].Run.ProvidedSourceCount = 0
		output.Results[i].Run.CitationCount = 0
	}
	for i := 0; i < 5; i++ {
		rejected := false
		output.Results[i].Human = humanReview{Accepted: &rejected, FailureCategory: "answer"}
	}
	summary, err := scoreReport(input, output)
	if err != nil || !summary.RealEvaluationAccepted || summary.ExpectedSourcesFound != 31 || summary.CorrectGroundedAnswers != 29 {
		t.Fatalf("threshold boundary wrong: %+v %v", summary, err)
	}
	output.Results[3].Sources = nil
	summary, _ = scoreReport(input, output)
	if summary.ThresholdsMet {
		t.Fatal("30/34 recall accepted")
	}
}

func TestCitationForgeryAndUnavailableCannotPass(t *testing.T) {
	for _, text := range []string{"伪造 [[C8]]", "原始 [[S1]]", "畸形 [[C0]]"} {
		input, output := fixture(t)
		output.Results[0].Answer += text
		if checkResult(input.Questions[0], output.Results[0]).CitationValid {
			t.Fatal("forged citation accepted")
		}
	}
	input, output := fixture(t)
	i := len(output.Results) - 1
	evidence := "unavailable"
	output.Results[i].Run.KnowledgeState = "unavailable"
	output.Results[i].Run.EvidenceState = &evidence
	output.Results[i].Answer = "知识库当前不可用"
	output.Results[i].KnowledgeGeneration = nil
	summary, _ := scoreReport(input, output)
	if summary.ThresholdsMet || summary.CorrectRefusals != 5 {
		t.Fatal("unavailable confused with not_found")
	}
}

func TestDatasetRejectsMissingExpectedAndInvalidFollowup(t *testing.T) {
	input, _ := fixture(t)
	input.Questions[0].ExpectedFragments = nil
	if validateDataset(input) == nil {
		t.Fatal("missing expected fragments accepted")
	}
	input, _ = fixture(t)
	missing := "unknown"
	input.Questions[28].FollowUpTo = &missing
	if validateDataset(input) == nil {
		t.Fatal("unknown followup accepted")
	}
}

func TestRunRequiresAuthorizationBeforeHTTP(t *testing.T) {
	err := execute([]string{"run", "--cases", "testdata/synthetic.json", "--schema", "../../../../docs/contracts/assistant-evaluation.schema.json", "--report", filepath.Join(t.TempDir(), "report.json")})
	if err == nil {
		t.Fatal("run without authorization accepted")
	}
}

func TestLoginUsesMFAAndTerminalSnapshot(t *testing.T) {
	var sawCookie bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/login":
			w.WriteHeader(202)
			_, _ = w.Write([]byte(`{"status":"mfa_required","challengeId":"test"}`))
		case "/api/v1/auth/mfa/verify":
			http.SetCookie(w, &http.Cookie{Name: "__Host-dev-toolbox-session", Value: "synthetic-session", Secure: true, Path: "/"})
			_, _ = w.Write([]byte(`{"csrfToken":"synthetic-csrf"}`))
		default:
			sawCookie = r.Header.Get("Cookie") == "__Host-dev-toolbox-session=synthetic-session"
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("event: snapshot\ndata: {\"run\":{\"status\":\"succeeded\"}}\n\n"))
		}
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "auth.json")
	raw, _ := json.Marshal(map[string]string{"username": "fixture", "password": "synthetic-only", "totpCode": "123456"})
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	c := evaluationClient{origin: server.URL, http: server.Client()}
	if err := c.login(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	if err := c.wait(context.Background(), uuid.New()); err != nil || !sawCookie {
		t.Fatalf("terminal snapshot failed: %v", err)
	}
}

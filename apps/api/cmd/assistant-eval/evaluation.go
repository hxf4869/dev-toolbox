package main

import (
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/assistant"
)

type dataset struct {
	Version   int        `json:"version"`
	Kind      string     `json:"kind"`
	Questions []question `json:"questions"`
}

type question struct {
	ID                string   `json:"questionId"`
	Category          string   `json:"category"`
	NoteOnly          bool     `json:"noteOnly"`
	Content           string   `json:"content"`
	Expected          string   `json:"expected"`
	ExpectedFragments []string `json:"expectedFragmentIds"`
	AllowedFragments  []string `json:"allowedFragmentIds"`
	FollowUpTo        *string  `json:"followUpTo"`
}

type source struct {
	Ordinal        int     `json:"sourceOrdinal"`
	FragmentID     *string `json:"fragmentId"`
	CitationNumber *int    `json:"citationNumber"`
	Title          string  `json:"title"`
	Excerpt        string  `json:"excerpt"`
}

type humanReview struct {
	Accepted        *bool  `json:"accepted"`
	FailureCategory string `json:"failureCategory"`
}

type result struct {
	QuestionID          string                    `json:"questionId"`
	Question            string                    `json:"question"`
	Run                 assistant.AssistantRunDTO `json:"run"`
	KnowledgeGeneration *int64                    `json:"knowledgeGeneration"`
	Answer              string                    `json:"answer"`
	Sources             []source                  `json:"top8"`
	Automatic           automatic                 `json:"automatic"`
	Human               humanReview               `json:"human"`
}

type report struct {
	Version int      `json:"version"`
	Kind    string   `json:"kind"`
	Results []result `json:"results"`
}

type automatic struct {
	ExpectedSourcesFound bool   `json:"expectedSourcesFound"`
	CitationValid        bool   `json:"citationValid"`
	RefusalValid         bool   `json:"refusalValid"`
	FailureCategory      string `json:"failureCategory"`
}

type score struct {
	Kind                   string `json:"kind"`
	Questions              int    `json:"questions"`
	ExpectedSourcesFound   int    `json:"expectedSourcesFound"`
	CorrectGroundedAnswers int    `json:"correctGroundedAnswers"`
	CorrectRefusals        int    `json:"correctRefusals"`
	CitationChecksPassed   int    `json:"citationChecksPassed"`
	HumanReviewsComplete   int    `json:"humanReviewsComplete"`
	ThresholdsMet          bool   `json:"thresholdsMet"`
	RealEvaluationAccepted bool   `json:"realEvaluationAccepted"`
}

func readDataset(path, schemaPath string) (dataset, error) {
	var input dataset
	raw, err := os.ReadFile(path)
	if err != nil {
		return input, errors.New("无法读取题集")
	}
	schemaRaw, err := os.ReadFile(schemaPath)
	if err != nil {
		return input, errors.New("无法读取评测 Schema")
	}
	var schemaDoc, document any
	if json.Unmarshal(schemaRaw, &schemaDoc) != nil || json.Unmarshal(raw, &document) != nil {
		return input, errors.New("题集或 Schema 不是有效 JSON")
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	const resource = "https://dev-toolbox.local/schemas/assistant-evaluation-1.json"
	if err := compiler.AddResource(resource, schemaDoc); err != nil {
		return input, errors.New("评测 Schema 无效")
	}
	compiled, err := compiler.Compile(resource)
	if err != nil || compiled.Validate(document) != nil {
		return input, errors.New("题集不符合评测 Schema（不输出题目内容）")
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return input, errors.New("题集字段无效")
	}
	return input, validateDataset(input)
}

func validateDataset(input dataset) error {
	counts := map[string]int{}
	seen := map[string]question{}
	// Follow-ups extend a single chronological conversation; they are not branches.
	usedParent := map[string]bool{}
	for _, q := range input.Questions {
		if _, exists := seen[q.ID]; exists || strings.TrimSpace(q.Content) == "" || len(q.Content) > 32*1024-40 {
			return errors.New("题号重复、题目为空或题目超过发送上限")
		}
		if q.Expected == "answer" {
			if q.Category == "not_found" || len(q.ExpectedFragments) == 0 {
				return errors.New("有答案题必须标注期望来源")
			}
			for _, id := range q.ExpectedFragments {
				if !slices.Contains(q.AllowedFragments, id) {
					return errors.New("期望来源必须包含在允许来源中")
				}
			}
		} else if q.Category != "not_found" || len(q.ExpectedFragments) != 0 || len(q.AllowedFragments) != 0 {
			return errors.New("无答案题不得配置期望或允许来源")
		}
		if q.Category == "follow_up" {
			if q.FollowUpTo == nil || seen[*q.FollowUpTo].Expected != "answer" || usedParent[*q.FollowUpTo] {
				return errors.New("追问题必须引用前面的有答案题，且不能分支")
			}
			usedParent[*q.FollowUpTo] = true
		} else if q.FollowUpTo != nil {
			return errors.New("非追问题不能配置 followUpTo")
		}
		seen[q.ID] = q
		counts[q.Category]++
	}
	for category, expected := range map[string]int{"direct_fact": 12, "paraphrase": 10, "cross_note": 6, "follow_up": 6, "not_found": 6} {
		if counts[category] != expected {
			return errors.New("题目分布必须为 12/10/6/6/6，共 40 题")
		}
	}
	return nil
}

var canonicalCitation = regexp.MustCompile(`\[\[C([0-9]+)\]\]`)

func checkResult(q question, r result) automatic {
	check := automatic{CitationValid: true}
	fragments := []string{}
	ordinals, citations := map[int]bool{}, map[int]bool{}
	for _, s := range r.Sources {
		if s.Ordinal < 1 || s.Ordinal > 8 || ordinals[s.Ordinal] || s.FragmentID == nil {
			check.CitationValid = false
		}
		ordinals[s.Ordinal] = true
		if s.FragmentID != nil {
			fragments = append(fragments, *s.FragmentID)
		}
		if s.CitationNumber != nil {
			n := *s.CitationNumber
			if n < 1 || n > 8 || citations[n] || s.FragmentID == nil || !slices.Contains(q.AllowedFragments, *s.FragmentID) {
				check.CitationValid = false
			}
			citations[n] = true
		}
	}
	markers := map[int]bool{}
	for _, marker := range canonicalCitation.FindAllStringSubmatch(r.Answer, -1) {
		n, _ := strconv.Atoi(marker[1])
		markers[n] = true
		if !citations[n] {
			check.CitationValid = false
		}
	}
	remainder := canonicalCitation.ReplaceAllString(r.Answer, "")
	if strings.Contains(remainder, "[[S") || strings.Contains(remainder, "[[C") || len(markers) != len(citations) ||
		len(r.Sources) > 8 || r.Run.ProvidedSourceCount != len(r.Sources) || r.Run.CitationCount != len(citations) {
		check.CitationValid = false
	}
	check.ExpectedSourcesFound = q.Expected == "answer" && len(q.ExpectedFragments) > 0
	for _, expected := range q.ExpectedFragments {
		check.ExpectedSourcesFound = check.ExpectedSourcesFound && slices.Contains(fragments, expected)
	}
	check.RefusalValid = q.Expected == "not_found" && r.Run.KnowledgeState == "ready" &&
		r.Run.EvidenceState != nil && *r.Run.EvidenceState == "not_found" && len(citations) == 0 && len(r.Sources) == 0 &&
		strings.Contains(r.Answer, "当前知识库未找到足够依据") && !strings.Contains(r.Answer, "知识库当前不可用")
	switch {
	case r.Run.Status != "succeeded":
		check.FailureCategory = "runtime"
	case r.Run.KnowledgeState != "ready" || r.KnowledgeGeneration == nil:
		check.FailureCategory = "availability"
	case !check.CitationValid:
		check.FailureCategory = "citation"
	case q.Expected == "not_found" && !check.RefusalValid:
		check.FailureCategory = "refusal"
	case q.Expected == "answer" && !check.ExpectedSourcesFound:
		check.FailureCategory = "retrieval"
	}
	return check
}

func scoreReport(input dataset, output report) (score, error) {
	summary := score{Kind: input.Kind, Questions: len(output.Results)}
	if output.Version != 1 || output.Kind != input.Kind || len(output.Results) != len(input.Questions) {
		return summary, errors.New("报告与题集版本、种类或题数不一致")
	}
	allRunsReady := true
	for i, r := range output.Results {
		q := input.Questions[i]
		if r.QuestionID != q.ID || r.Question != q.Content || r.Run.ID == uuid.Nil {
			return summary, errors.New("报告与题集题号、题目或运行标识不一致")
		}
		check := checkResult(q, r)
		allRunsReady = allRunsReady && r.Run.Status == "succeeded" && r.Run.KnowledgeState == "ready" && r.KnowledgeGeneration != nil
		if check.ExpectedSourcesFound {
			summary.ExpectedSourcesFound++
		}
		if check.CitationValid {
			summary.CitationChecksPassed++
		}
		if r.Human.Accepted != nil {
			if !slices.Contains([]string{"", "retrieval", "answer", "citation", "refusal", "availability", "runtime"}, r.Human.FailureCategory) ||
				(*r.Human.Accepted && r.Human.FailureCategory != "") || (!*r.Human.Accepted && r.Human.FailureCategory == "") {
				return summary, errors.New("人工评分与失败分类不一致")
			}
			summary.HumanReviewsComplete++
			if *r.Human.Accepted && check.CitationValid {
				if q.Expected == "answer" {
					summary.CorrectGroundedAnswers++
				}
				if check.RefusalValid {
					summary.CorrectRefusals++
				}
			}
		}
	}
	summary.ThresholdsMet = allRunsReady && summary.ExpectedSourcesFound >= 31 && summary.CorrectGroundedAnswers >= 29 &&
		summary.CorrectRefusals == 6 && summary.CitationChecksPassed == 40 && summary.HumanReviewsComplete == 40
	summary.RealEvaluationAccepted = input.Kind == "real" && summary.ThresholdsMet
	return summary, nil
}

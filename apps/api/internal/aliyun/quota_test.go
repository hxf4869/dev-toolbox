package aliyun

import (
	"testing"
	"time"
)

func TestUTF16LengthMatchesJavaScriptStringLength(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  int
	}{
		{"empty", "", 0},
		{"ascii", "hello", 5},
		{"chinese", "中文翻译", 4},
		{"emoji surrogate pair", "😀", 2},
		{"mixed", "a中😀b", 5},
		{"combining", "e\u0301", 2},
		{"max chunk", string([]rune("界")), 1},
	}
	for _, test := range cases {
		if got := utf16Length(test.value); got != test.want {
			t.Fatalf("%s: utf16Length = %d, want %d", test.name, got, test.want)
		}
	}
	if got := utf16Length("😀😀"); got != 4 {
		t.Fatalf("two surrogate pairs = %d, want 4", got)
	}
}

func TestShanghaiMonthBoundaries(t *testing.T) {
	shanghai := shanghaiZone
	cases := []struct {
		now   time.Time
		month string
		reset string
	}{
		{time.Date(2026, 8, 31, 23, 59, 59, 0, shanghai), "2026-08", "2026-09-01"},
		{time.Date(2026, 9, 1, 0, 0, 1, 0, shanghai), "2026-09", "2026-10-01"},
		{time.Date(2026, 12, 31, 23, 0, 0, 0, shanghai), "2026-12", "2027-01-01"},
		// 16:00 UTC on the last day of a month is already the next month in Shanghai.
		{time.Date(2026, 8, 31, 16, 0, 0, 0, time.UTC), "2026-09", "2026-10-01"},
		{time.Date(2026, 8, 31, 15, 59, 0, 0, time.UTC), "2026-08", "2026-09-01"},
	}
	for _, test := range cases {
		monthStart := currentMonthStart(test.now)
		if got := monthStart.Format("2006-01"); got != test.month {
			t.Fatalf("now=%s month=%s, want %s", test.now, got, test.month)
		}
		if got := nextMonthStart(monthStart).Format("2006-01-02"); got != test.reset {
			t.Fatalf("now=%s reset=%s, want %s", test.now, got, test.reset)
		}
	}
}

func scenePointer(value string) *string { return &value }

func TestDecideEngineGeneralSufficient(t *testing.T) {
	choice, decisionErr := decideEngine(true, scenePointer("title"), 1000, 5000, 100)
	if decisionErr != nil {
		t.Fatalf("unexpected stop: %v", decisionErr)
	}
	if choice.Engine != "general" || choice.Meter != meterGeneral || choice.Scene != "general" {
		t.Fatalf("unexpected choice: %+v", choice)
	}
}

func TestDecideEngineSwitchesWholeChunkToProfessional(t *testing.T) {
	choice, decisionErr := decideEngine(true, scenePointer("communication"), 100, 5000, 4999)
	if decisionErr != nil {
		t.Fatalf("unexpected stop: %v", decisionErr)
	}
	if choice.Engine != "professional" || choice.Meter != meterProfessional || choice.Scene != "communication" {
		t.Fatalf("unexpected choice: %+v", choice)
	}
}

func TestDecideEngineStopsBeforeCloudCall(t *testing.T) {
	cases := []struct {
		name             string
		autoUse          bool
		scene            *string
		generalRemaining int64
		profRemaining    int64
		units            int64
		wantCode         string
		wantStatus       int
	}{
		{"scene missing", true, nil, 0, 5000, 10, "PROFESSIONAL_SCENE_REQUIRED", statusUnprocessableEntity},
		{"auto switch off", false, scenePointer("title"), 0, 5000, 10, "QUOTA_EXHAUSTED", statusTooManyRequests},
		{"professional exhausted", true, scenePointer("title"), 0, 5, 10, "QUOTA_EXHAUSTED", statusTooManyRequests},
	}
	for _, test := range cases {
		_, decisionErr := decideEngine(test.autoUse, test.scene, test.generalRemaining, test.profRemaining, test.units)
		if decisionErr == nil {
			t.Fatalf("%s: expected stop", test.name)
		}
		if decisionErr.Code != test.wantCode || decisionErr.Status != test.wantStatus {
			t.Fatalf("%s: got %s/%d, want %s/%d", test.name, decisionErr.Code, decisionErr.Status, test.wantCode, test.wantStatus)
		}
	}
}

func TestQuotaExhaustedDetails(t *testing.T) {
	decisionErr := quotaExhausted(meterGeneral, -5)
	if decisionErr.Details["remaining"] != int64(0) {
		t.Fatalf("negative remaining must clamp to zero: %+v", decisionErr.Details)
	}
	if decisionErr.Details["meter"] != meterGeneral {
		t.Fatalf("meter detail missing: %+v", decisionErr.Details)
	}
}

func TestProfessionalLanguageBlocker(t *testing.T) {
	if code := professionalLanguageBlocker("title", "auto", "en"); code != "SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL" {
		t.Fatalf("auto source must be stopped, got %q", code)
	}
	if code := professionalLanguageBlocker("communication", "zh", "ru"); code != "" {
		t.Fatalf("supported pair must pass, got %q", code)
	}
	if code := professionalLanguageBlocker("communication", "ru", "ar"); code != "PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED" {
		t.Fatalf("set-internal pair must be rejected, got %q", code)
	}
	if code := professionalLanguageBlocker("finance", "zh", "ja"); code != "PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED" {
		t.Fatalf("scene-external pair must be rejected, got %q", code)
	}
}

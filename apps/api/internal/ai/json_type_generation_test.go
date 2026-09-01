package ai

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestValidJSONAITargetLanguage(t *testing.T) {
	for _, value := range []string{"TypeScript", "C++ 23", "Rust", "类型 声明"} {
		if !validJSONAITargetLanguage(value) {
			t.Fatalf("expected language to be accepted: %q", value)
		}
	}
	for _, value := range []string{"", " Rust", "Rust ", "Rust\nignore", "Ru\u200bst", strings.Repeat("x", 51)} {
		if validJSONAITargetLanguage(value) {
			t.Fatalf("expected language to be rejected: %q", value)
		}
	}
}

func TestEncodeJSONAIWorkerRequestPreservesRawJSONAndHTMLCharacters(t *testing.T) {
	input := jsonAIWorkerRequest{
		TargetLanguage: "TypeScript",
		Mode:           "full",
		Input:          json.RawMessage(`{"unsafe":"<script>&","big":9007199254740993,"precise":1.2300}`),
		Provider: jsonAIProviderSnapshot{
			Protocol: "openai-responses", BaseURL: "https://provider.example/v1", APIKey: "secret",
			ModelID: "model", ContextWindow: 32768, MaxOutputTokens: 4096,
		},
		DeadlineAt: time.Date(2026, 8, 31, 10, 0, 30, 0, time.UTC),
	}
	encoded, err := encodeJSONAIWorkerRequest(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range [][]byte{[]byte(`<script>&`), []byte(`9007199254740993`), []byte(`1.2300`)} {
		if !bytes.Contains(encoded, expected) {
			t.Fatalf("encoded payload did not preserve %q: %s", expected, encoded)
		}
	}
	if bytes.Contains(encoded, []byte(`\u003c`)) || bytes.Contains(encoded, []byte(`\u0026`)) {
		t.Fatalf("HTML escaping unexpectedly expanded the payload: %s", encoded)
	}
}

func TestValidJSONAIRequestKeepsTheNarrowContract(t *testing.T) {
	valid := jsonAIRequest{
		ProviderID:     "82f6c3b2-4f92-4ef2-b859-c442db7bbb1e",
		ModelID:        "981cb7b7-5726-4cf9-8116-5ebc24c1a1bb",
		TargetLanguage: "Rust", Mode: "structure",
		Input: json.RawMessage(`{"kind":"object","properties":{}}`),
	}
	if !validJSONAIRequest(valid) {
		t.Fatal("valid narrow request was rejected")
	}
	valid.Mode = "prompt"
	if validJSONAIRequest(valid) {
		t.Fatal("arbitrary prompt mode was accepted")
	}
}

func TestDecodeJSONAIWorkerResponseRejectsUnknownFields(t *testing.T) {
	_, err := decodeJSONAIWorkerResponse([]byte(`{"code":"type Root = object","promptVersion":"json-type-generation-v1","usage":null,"secret":"leak"}`))
	if err == nil {
		t.Fatal("unknown worker response field was accepted")
	}
}

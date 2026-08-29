package schema

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSharedArtifactFixtures(t *testing.T) {
	root := repositoryRoot(t)
	schemaBytes, err := os.ReadFile(filepath.Join(root, "docs", "contracts", "ai-artifact.schema.json"))
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	validator, err := New(schemaBytes)
	if err != nil {
		t.Fatalf("New(): %v", err)
	}

	tests := []struct {
		name  string
		valid bool
	}{
		{name: "valid-organized.json", valid: true},
		{name: "invalid-unknown-block.json", valid: false},
		{name: "invalid-uuid.json", valid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document, err := os.ReadFile(filepath.Join(root, "tests", "fixtures", "ai-artifact", test.name))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			err = validator.ValidateJSON(document)
			if test.valid && err != nil {
				t.Fatalf("expected valid, got %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("expected invalid fixture to fail")
			}
		})
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", "..", "..", ".."))
}

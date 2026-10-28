package knowledge

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreQuarantinedFilesRetainsOriginalWhenRestoreFails(t *testing.T) {
	for _, failure := range []string{"parent", "target"} {
		t.Run(failure, func(t *testing.T) {
			root := t.TempDir()
			quarantine := filepath.Join(root, "quarantine")
			if err := os.Mkdir(quarantine, 0o700); err != nil {
				t.Fatal(err)
			}
			copyPath := filepath.Join(quarantine, "original")
			content := []byte("synthetic original")
			if err := os.WriteFile(copyPath, content, 0o600); err != nil {
				t.Fatal(err)
			}
			original := filepath.Join(root, "blobs", "original")
			if failure == "parent" {
				if err := os.WriteFile(filepath.Dir(original), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			} else if err := os.MkdirAll(original, 0o700); err != nil {
				t.Fatal(err)
			}
			moved := []quarantinedFile{{originalPath: original, quarantinePath: copyPath}}
			if err := restoreQuarantinedFiles(moved, quarantine); err == nil {
				t.Fatal("expected a storage restore error")
			}
			remaining, err := os.ReadFile(copyPath)
			if err != nil || string(remaining) != string(content) {
				t.Fatalf("recoverable original was lost: %v", err)
			}
		})
	}
}

func TestRestoreQuarantinedFilesCleansUpOnlyAfterRestoringAllFiles(t *testing.T) {
	root := t.TempDir()
	quarantine := filepath.Join(root, "quarantine")
	if err := os.Mkdir(quarantine, 0o700); err != nil {
		t.Fatal(err)
	}
	moved := []quarantinedFile{}
	for _, name := range []string{"first", "second"} {
		copyPath := filepath.Join(quarantine, name)
		if err := os.WriteFile(copyPath, []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
		moved = append(moved, quarantinedFile{originalPath: filepath.Join(root, "blobs", name), quarantinePath: copyPath})
	}
	if err := restoreQuarantinedFiles(moved, quarantine); err != nil {
		t.Fatal(err)
	}
	for _, file := range moved {
		if _, err := os.Stat(file.originalPath); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(quarantine); !os.IsNotExist(err) {
		t.Fatalf("completed rollback left quarantine: %v", err)
	}
}

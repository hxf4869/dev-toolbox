package operations

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCheckAttachmentFilesReportsEveryRecoveryBoundaryWithoutDeletingOrphans(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "blobs", "aa"), 0o700); err != nil {
		t.Fatal(err)
	}
	validBytes := []byte("verified attachment bytes")
	validDigest := sha256.Sum256(validBytes)
	validKey := "blobs/aa/valid"
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(validKey)), validBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	sizeKey := "blobs/aa/size"
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(sizeKey)), []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	checksumKey := "blobs/aa/checksum"
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(checksumKey)), validBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	orphanKey := "blobs/aa/orphan"
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(orphanKey)), []byte("orphan"), 0o600); err != nil {
		t.Fatal(err)
	}

	references := []attachmentReference{
		{ID: uuid.New(), StorageKey: validKey, SizeBytes: int64(len(validBytes)), SHA256: validDigest[:], Status: "ready"},
		{ID: uuid.New(), StorageKey: "blobs/aa/missing", SizeBytes: 4, SHA256: validDigest[:], Status: "ready"},
		{ID: uuid.New(), StorageKey: sizeKey, SizeBytes: 99, SHA256: validDigest[:], Status: "ready"},
		{ID: uuid.New(), StorageKey: checksumKey, SizeBytes: int64(len(validBytes)), SHA256: make([]byte, sha256.Size), Status: "ready"},
		{ID: uuid.New(), StorageKey: "../outside", SizeBytes: 1, SHA256: validDigest[:], Status: "ready"},
	}
	report, err := checkAttachmentFiles(root, references, time.Date(2026, 8, 30, 1, 2, 3, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if report.State != "failed" || report.ReferencedAttachments != 5 || report.VerifiedAttachments != 1 ||
		report.MissingAttachments != 1 || report.SizeMismatches != 1 || report.ChecksumMismatches != 1 ||
		report.UnsafeReferences != 1 || len(report.OrphanAttachments) != 1 || report.OrphanAttachments[0].StorageKey != orphanKey {
		t.Fatalf("unexpected report: %+v", report)
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(orphanKey))); err != nil {
		t.Fatalf("orphan was modified or deleted: %v", err)
	}
}

func TestCheckAttachmentFilesTreatsNonReadyAndSymlinkAsFailures(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "blobs"), 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkKey := "blobs/link"
	if err := os.Symlink(target, filepath.Join(root, filepath.FromSlash(linkKey))); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("data"))
	report, err := checkAttachmentFiles(root, []attachmentReference{
		{ID: uuid.New(), StorageKey: "blobs/pending", SizeBytes: 0, SHA256: digest[:], Status: "pending_delete"},
		{ID: uuid.New(), StorageKey: linkKey, SizeBytes: 4, SHA256: digest[:], Status: "ready"},
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if report.State != "failed" || report.MissingAttachments != 1 || report.UnsafeReferences != 1 {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestCheckAttachmentFilesRejectsSymlinkedParent(t *testing.T) {
	root := t.TempDir()
	external := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "blobs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(external, "outside"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(root, "blobs", "linked")); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("data"))
	report, err := checkAttachmentFiles(root, []attachmentReference{{
		ID: uuid.New(), StorageKey: "blobs/linked/outside", SizeBytes: 4, SHA256: digest[:], Status: "ready",
	}}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if report.State != "failed" || report.UnsafeReferences != 1 || report.VerifiedAttachments != 0 {
		t.Fatalf("symlinked parent was not rejected: %+v", report)
	}
}

package operations

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStatusFilesExposeOnlyValidatedOperationalState(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 8, 30, 3, 4, 5, 0, time.UTC)
	writeStatusFixture(t, filepath.Join(root, "backup-status.json"), backupStatus{
		State: "succeeded", LastAttemptAt: &now, LastSuccessAt: &now, SnapshotID: "abc123",
		TargetLabel: "异地主仓库", ResticCheckAt: &now,
	})
	writeStatusFixture(t, filepath.Join(root, "restore-status.json"), restoreStatus{
		State: "succeeded", VerifiedAt: &now, SnapshotID: "abc123", ReferencedAttachments: 12,
		VerifiedAttachments: 12, OrphanAttachments: 1,
	})
	writeStatusFixture(t, filepath.Join(root, "release-status.json"), releaseStatus{
		CandidateVersion: "v1.0.1", GeneratedAt: &now,
		Checks: []releaseCheck{{ID: "data_integrity", Label: "原始数据与附件", Status: "passed", Summary: "完整性检查通过", CheckedAt: &now}},
	})
	service := &StatusService{statusRoot: root, appVersion: "v1.0.1"}

	backup := service.readBackupStatus()
	restore := service.readRestoreStatus()
	release := service.readReleaseStatus()
	if backup.State != "succeeded" || backup.SnapshotID != "abc123" || restore.State != "succeeded" || restore.OrphanAttachments != 1 {
		t.Fatalf("unexpected operational state: backup=%+v restore=%+v", backup, restore)
	}
	if release.CandidateVersion != "v1.0.1" || release.Checks[0].Status != "passed" || len(release.Checks) != 8 {
		t.Fatalf("unexpected release state: %+v", release)
	}
}

func TestStatusFilesRejectUnknownOrUnsafeFields(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "backup-status.json"), []byte(`{"state":"succeeded","unknown":"value"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "restore-status.json"), []byte(`{"state":"failed","errorCode":"contains details"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	service := &StatusService{statusRoot: root, appVersion: "test"}
	if status := service.readBackupStatus(); status.State != "failed" || status.ErrorCode != "STATUS_FILE_INVALID" {
		t.Fatalf("unsafe backup status accepted: %+v", status)
	}
	if status := service.readRestoreStatus(); status.State != "failed" || status.ErrorCode != "STATUS_FILE_INVALID" {
		t.Fatalf("unsafe restore status accepted: %+v", status)
	}
}

func writeStatusFixture(t *testing.T, path string, value any) {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}

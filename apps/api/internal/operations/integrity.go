package operations

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type attachmentReference struct {
	ID         uuid.UUID
	StorageKey string
	SizeBytes  int64
	SHA256     []byte
	Status     string
}

type IntegrityIssue struct {
	AttachmentID string `json:"attachmentId,omitempty"`
	StorageKey   string `json:"storageKey"`
	Code         string `json:"code"`
	ExpectedSize *int64 `json:"expectedSize,omitempty"`
	ActualSize   *int64 `json:"actualSize,omitempty"`
}

type OrphanAttachment struct {
	StorageKey string `json:"storageKey"`
	SizeBytes  int64  `json:"sizeBytes"`
}

type IntegrityReport struct {
	Version               int                `json:"version"`
	State                 string             `json:"state"`
	CheckedAt             time.Time          `json:"checkedAt"`
	ReferencedAttachments int                `json:"referencedAttachments"`
	VerifiedAttachments   int                `json:"verifiedAttachments"`
	MissingAttachments    int                `json:"missingAttachments"`
	SizeMismatches        int                `json:"sizeMismatches"`
	ChecksumMismatches    int                `json:"checksumMismatches"`
	UnsafeReferences      int                `json:"unsafeReferences"`
	OrphanAttachments     []OrphanAttachment `json:"orphanAttachments"`
	Issues                []IntegrityIssue   `json:"issues"`
}

func CheckIntegrity(ctx context.Context, database *pgxpool.Pool, attachmentRoot string, now time.Time) (IntegrityReport, error) {
	references, err := loadAttachmentReferences(ctx, database)
	if err != nil {
		return IntegrityReport{}, err
	}
	return checkAttachmentFiles(filepath.Clean(attachmentRoot), references, now.UTC())
}

func loadAttachmentReferences(ctx context.Context, database *pgxpool.Pool) ([]attachmentReference, error) {
	rows, err := database.Query(ctx, `
		SELECT id, storage_key, size_bytes, content_sha256, status
		FROM attachments ORDER BY storage_key, id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]attachmentReference, 0)
	for rows.Next() {
		var entry attachmentReference
		if err := rows.Scan(&entry.ID, &entry.StorageKey, &entry.SizeBytes, &entry.SHA256, &entry.Status); err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	return result, rows.Err()
}

func checkAttachmentFiles(root string, references []attachmentReference, checkedAt time.Time) (IntegrityReport, error) {
	report := IntegrityReport{
		Version: 1, State: "succeeded", CheckedAt: checkedAt, ReferencedAttachments: len(references),
		OrphanAttachments: []OrphanAttachment{}, Issues: []IntegrityIssue{},
	}
	referencedKeys := make(map[string]struct{}, len(references))
	for _, reference := range references {
		referencedKeys[reference.StorageKey] = struct{}{}
		issue := verifyAttachmentReference(root, reference)
		if issue == nil {
			report.VerifiedAttachments++
			continue
		}
		report.State = "failed"
		report.Issues = append(report.Issues, *issue)
		switch issue.Code {
		case "ATTACHMENT_MISSING", "ATTACHMENT_NOT_READY":
			report.MissingAttachments++
		case "ATTACHMENT_SIZE_MISMATCH":
			report.SizeMismatches++
		case "ATTACHMENT_CHECKSUM_MISMATCH":
			report.ChecksumMismatches++
		default:
			report.UnsafeReferences++
		}
	}
	orphans, err := findOrphanAttachments(root, referencedKeys)
	if err != nil {
		return IntegrityReport{}, err
	}
	report.OrphanAttachments = orphans
	return report, nil
}

func verifyAttachmentReference(root string, reference attachmentReference) *IntegrityIssue {
	issue := IntegrityIssue{AttachmentID: reference.ID.String(), StorageKey: reference.StorageKey}
	if reference.Status != "ready" {
		issue.Code = "ATTACHMENT_NOT_READY"
		return &issue
	}
	path, ok := safeStoragePath(root, reference.StorageKey)
	if !ok {
		issue.Code = "ATTACHMENT_STORAGE_KEY_INVALID"
		return &issue
	}
	info, unsafePath, err := lstatWithoutSymlinkComponents(root, path)
	if errors.Is(err, os.ErrNotExist) {
		issue.Code = "ATTACHMENT_MISSING"
		return &issue
	}
	if err != nil || unsafePath || !info.Mode().IsRegular() {
		issue.Code = "ATTACHMENT_FILE_UNSAFE"
		return &issue
	}
	if info.Size() != reference.SizeBytes {
		expected, actual := reference.SizeBytes, info.Size()
		issue.Code = "ATTACHMENT_SIZE_MISMATCH"
		issue.ExpectedSize, issue.ActualSize = &expected, &actual
		return &issue
	}
	file, err := os.Open(path)
	if err != nil {
		issue.Code = "ATTACHMENT_FILE_UNREADABLE"
		return &issue
	}
	hasher := sha256.New()
	_, copyErr := io.Copy(hasher, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		issue.Code = "ATTACHMENT_FILE_UNREADABLE"
		return &issue
	}
	actual := hasher.Sum(nil)
	if len(reference.SHA256) != sha256.Size || !equalBytes(actual, reference.SHA256) {
		issue.Code = "ATTACHMENT_CHECKSUM_MISMATCH"
		return &issue
	}
	return nil
}

func findOrphanAttachments(root string, referenced map[string]struct{}) ([]OrphanAttachment, error) {
	blobRoot := filepath.Join(root, "blobs")
	rootInfo, err := os.Lstat(blobRoot)
	if errors.Is(err, os.ErrNotExist) {
		return []OrphanAttachment{}, nil
	} else if err != nil {
		return nil, err
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return nil, errors.New("attachment blob root is unsafe")
	}
	orphans := make([]OrphanAttachment, 0)
	err = filepath.WalkDir(blobRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(relative)
		if _, exists := referenced[key]; !exists {
			orphans = append(orphans, OrphanAttachment{StorageKey: key, SizeBytes: info.Size()})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(orphans, func(left, right int) bool { return orphans[left].StorageKey < orphans[right].StorageKey })
	return orphans, nil
}

func lstatWithoutSymlinkComponents(root, path string) (os.FileInfo, bool, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, false, err
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return rootInfo, true, nil
	}
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return nil, true, err
	}
	parts := strings.Split(relative, string(filepath.Separator))
	current := root
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, lstatErr := os.Lstat(current)
		if lstatErr != nil {
			return nil, false, lstatErr
		}
		if info.Mode()&os.ModeSymlink != 0 || index < len(parts)-1 && !info.IsDir() {
			return info, true, nil
		}
		if index == len(parts)-1 {
			return info, false, nil
		}
	}
	return rootInfo, true, errors.New("empty attachment path")
}

func safeStoragePath(root, key string) (string, bool) {
	if key == "" || strings.ContainsRune(key, '\x00') || filepath.IsAbs(key) || filepath.Clean(key) != filepath.FromSlash(key) {
		return "", false
	}
	path := filepath.Join(root, filepath.FromSlash(key))
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	return path, true
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var difference byte
	for index := range left {
		difference |= left[index] ^ right[index]
	}
	return difference == 0
}

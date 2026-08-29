package knowledge

import (
	"errors"
	"io"
	"mime/multipart"
	"os"
	"testing"
)

type zeroReader struct{}

func (zeroReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = '0'
	}
	return len(buffer), nil
}

func TestDisplayNameBlocksPathAndHeaderSemantics(t *testing.T) {
	if got := clientBaseName("../../etc/passwd"); got != "passwd" {
		t.Fatalf("base name = %q", got)
	}
	if got := clientBaseName("..\\..\\windows\\secret.txt"); got != "secret.txt" {
		t.Fatalf("Windows base name = %q", got)
	}
	if got := displayName("report\r\n\"; filename=evil.html"); got != "report__ filename=evil.html" {
		t.Fatalf("display name = %q", got)
	}
}

func TestPrepareFileEnforcesExactTwentyMiBBoundary(t *testing.T) {
	for _, test := range []struct {
		name    string
		size    int64
		wantErr error
	}{
		{name: "exact limit", size: maxFileBytes},
		{name: "one byte over", size: maxFileBytes + 1, wantErr: errFileTooLarge},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			requestFile, err := os.CreateTemp(root, "multipart-*")
			if err != nil {
				t.Fatal(err)
			}
			writer := multipart.NewWriter(requestFile)
			part, err := writer.CreateFormFile("files[]", "boundary.bin")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := io.CopyN(part, zeroReader{}, test.size); err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := requestFile.Seek(0, io.SeekStart); err != nil {
				t.Fatal(err)
			}
			reader := multipart.NewReader(requestFile, writer.Boundary())
			uploadPart, err := reader.NextPart()
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := prepareFile(uploadPart, root)
			_ = uploadPart.Close()
			_ = requestFile.Close()
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("prepareFile error = %v, want %v", err, test.wantErr)
			}
			if test.wantErr == nil {
				defer os.Remove(prepared.TempPath)
				if prepared.SizeBytes != maxFileBytes {
					t.Fatalf("size = %d", prepared.SizeBytes)
				}
			}
		})
	}
}

func TestActualFileTotalAllowsExactHundredMiB(t *testing.T) {
	if !totalUploadAllowed(100 * 1024 * 1024) {
		t.Fatal("exactly 100 MiB should be accepted independent of multipart framing")
	}
	if totalUploadAllowed(100*1024*1024 + 1) {
		t.Fatal("100 MiB plus one byte should be rejected")
	}
}

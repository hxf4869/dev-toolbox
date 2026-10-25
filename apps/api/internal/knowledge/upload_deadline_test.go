package knowledge

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

const (
	// Mirrors main.go's server-wide 15s read budget, shrunk so a slow upload
	// crosses it within the test's fixed stall window.
	deadlineTestReadBudget  = 2 * time.Second
	deadlineTestWriteBudget = 2 * time.Second
	deadlineTestStall       = 3 * time.Second
)

// newDeadlineTestServer mounts the real multipart handlers plus a plain
// control handler behind the production middleware chain so the deadline
// setup must work through RequestLog's statusWriter.
func newDeadlineTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	service := &Service{tempRoot: t.TempDir()}
	router := http.NewServeMux()
	router.Handle("POST /api/v1/items:multipart", http.HandlerFunc(service.createMultipart))
	router.Handle("POST /api/v1/items/{itemId}/raw-records:multipart", http.HandlerFunc(service.createSupplementMultipart))
	router.HandleFunc("POST /api/v1/items", func(response http.ResponseWriter, request *http.Request) {
		if _, err := io.ReadAll(request.Body); err != nil {
			httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID", "读取失败")
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]bool{"ok": true})
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewUnstartedServer(httpapi.RequestID(httpapi.Recover(logger, httpapi.RequestLog(logger, router))))
	server.Config.ReadTimeout = deadlineTestReadBudget
	server.Config.WriteTimeout = deadlineTestWriteBudget
	server.Start()
	t.Cleanup(server.Close)
	return server
}

// slowMultipartBody streams a small multipart body whose file part stalls
// mid-content. The trailing unknown part makes both real handlers exit via
// the existing 422 branch only after fully reading the body, without any
// Idempotency-Key or database access.
func slowMultipartBody(stall time.Duration) io.Reader {
	reader, writer := io.Pipe()
	const boundary = "dt-r123-boundary"
	go func() {
		defer writer.Close()
		chunks := []string{
			"--" + boundary + "\r\n" +
				"Content-Disposition: form-data; name=\"metadata\"\r\n\r\n" +
				"{\"body\":\"慢速上传\",\"contentFormat\":\"markdown\",\"sensitivity\":\"normal\"}\r\n",
			"--" + boundary + "\r\n" +
				"Content-Disposition: form-data; name=\"files[]\"; filename=\"note.txt\"\r\n" +
				"Content-Type: text/plain\r\n\r\n",
			"attachment",
		}
		for _, chunk := range chunks {
			if _, err := writer.Write([]byte(chunk)); err != nil {
				return
			}
		}
		time.Sleep(stall)
		for _, chunk := range []string{
			"-bytes\r\n",
			"--" + boundary + "\r\n" +
				"Content-Disposition: form-data; name=\"unknown_part\"\r\n\r\nx\r\n",
			"--" + boundary + "--\r\n",
		} {
			if _, err := writer.Write([]byte(chunk)); err != nil {
				return
			}
		}
	}()
	return reader
}

func TestMultipartUploadSurvivesSlowClientPastGlobalDeadlines(t *testing.T) {
	server := newDeadlineTestServer(t)
	client := &http.Client{Timeout: 30 * time.Second}
	// Each entry exits through its existing 422 branch once the stalled body
	// has been fully read; neither may touch the (absent) database.
	targets := map[string]struct {
		target  string
		message string
	}{
		"create-item": {server.URL + "/api/v1/items:multipart", "multipart 字段无效"},
		"supplement-raw-record": {
			server.URL + "/api/v1/items/" + uuid.NewString() + "/raw-records:multipart",
			"补充记录内容无效",
		},
	}
	for name, test := range targets {
		t.Run(name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodPost, test.target, slowMultipartBody(deadlineTestStall))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "multipart/form-data; boundary=dt-r123-boundary")
			response, err := client.Do(request)
			if err != nil {
				t.Fatalf("slow multipart upload failed: %v", err)
			}
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			if response.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, body = %s", response.StatusCode, body)
			}
			if !strings.Contains(string(body), test.message) {
				t.Fatalf("expected the unknown-part 422 branch after a full body read, body = %s", body)
			}
		})
	}
}

func TestPlainUploadStillBoundedByGlobalReadDeadline(t *testing.T) {
	server := newDeadlineTestServer(t)
	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/v1/items", slowMultipartBody(deadlineTestStall))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "multipart/form-data; boundary=dt-r123-boundary")
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
	if err != nil {
		return // transport failure is the deadline doing its job
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode == http.StatusOK && strings.Contains(string(body), "true") {
		t.Fatal("a request that crosses the global read deadline must not complete successfully")
	}
}

type deadlineRecordingWriter struct {
	http.ResponseWriter
	readDeadline  time.Time
	writeDeadline time.Time
}

func (writer *deadlineRecordingWriter) SetReadDeadline(deadline time.Time) error {
	writer.readDeadline = deadline
	return nil
}

func (writer *deadlineRecordingWriter) SetWriteDeadline(deadline time.Time) error {
	writer.writeDeadline = deadline
	return nil
}

func TestMultipartDeadlinesAnchorAtSameStart(t *testing.T) {
	writer := &deadlineRecordingWriter{ResponseWriter: httptest.NewRecorder()}
	before := time.Now()
	if !extendMultipartDeadlines(writer, httptest.NewRequest(http.MethodPost, "/api/v1/items:multipart", nil)) {
		t.Fatal("supported writer must be reported as extended")
	}
	after := time.Now()
	if margin := writer.writeDeadline.Sub(writer.readDeadline); margin != multipartWriteBudget-multipartReadBudget {
		t.Fatalf("write deadline must share the read budget's start, margin = %v", margin)
	}
	if writer.readDeadline.Before(before.Add(multipartReadBudget)) || writer.readDeadline.After(after.Add(multipartReadBudget)) {
		t.Fatalf("read deadline = %v, want start+%v within [%v, %v]",
			writer.readDeadline, multipartReadBudget, before.Add(multipartReadBudget), after.Add(multipartReadBudget))
	}
}

func TestMultipartDeadlineSetupFailureWritesInternalError(t *testing.T) {
	recorder := httptest.NewRecorder()
	if extendMultipartDeadlines(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/items:multipart", nil)) {
		t.Fatal("writer without deadline support must not be reported as extended")
	}
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
	if !strings.Contains(recorder.Body.String(), "INTERNAL_ERROR") {
		t.Fatalf("body = %s, want the internal error envelope", recorder.Body.String())
	}
}

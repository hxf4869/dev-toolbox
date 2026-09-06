//go:build integration

package integration_test

// 缩略图生成在真实 PostgreSQL 与真实附件目录上的并发与一致性语义：
// T33 多附件并发请求 → 解码受共享 permit 限制（峰值 ≤ 1）；
// T34 同一附件并发生成 → 唯一派生记录、无临时文件残留、全部命中同一结果；
// T35 解码期间附件删除/原件替换 → 不登记过期派生物、不重新暴露已删除内容。

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// thumbnailSmallPNG 小尺寸测试图（64×48），生成即命中真实解码路径但开销极小。
var thumbnailSmallPNG = sync.OnceValue(func() []byte {
	return mustEncodePNG(64, 48, func(x, y int) color.RGBA {
		return color.RGBA{R: uint8(x * 4 % 255), G: uint8(y * 5 % 255), B: 96, A: 255}
	})
})

// thumbnailWidePNG 中等尺寸（1500×1000）：单次解码在数十毫秒量级，
// 10 张串行解码足以被采样器观测，又不会拖慢整个测试。
var thumbnailWidePNG = sync.OnceValue(func() []byte {
	return mustEncodePNG(1500, 1000, func(x, y int) color.RGBA {
		return color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: uint8((x + y) % 255), A: 255}
	})
})

// thumbnailHugePNG 接近预览像素上限的图（6300×6300，40M 上限以内）：
// 服务端解码显著慢于测试的删除/替换注入时机，用于制造确定性的解码窗口。
var thumbnailHugePNG = sync.OnceValue(func() []byte {
	return mustEncodePNG(6300, 6300, func(x, y int) color.RGBA {
		if x == y {
			return color.RGBA{R: 255, A: 255}
		}
		return color.RGBA{R: 12, G: 34, B: 56, A: 255}
	})
})

func mustEncodePNG(width, height int, fill func(x, y int) color.RGBA) []byte {
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			canvas.SetRGBA(x, y, fill(x, y))
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		panic(err)
	}
	return encoded.Bytes()
}

// uploadThumbnailFixture 通过公共 API 上传图片附件，返回知识条目与附件 ID。
func uploadThumbnailFixture(t *testing.T, h *v3Harness, name string, content []byte) (uuid.UUID, uuid.UUID) {
	t.Helper()
	response := sendMultipart(t, h.client, h.server.URL+"/api/v1/items:multipart",
		h.csrf, "thumb-fixture-"+name+"-"+uuid.New().String(), map[string]any{
			"body": "", "contentFormat": "plain_text", "sensitivity": "normal", "title": name,
		}, name+".png", "image/png", content)
	assertStatus(t, response, http.StatusCreated)
	result := decodeResponse[apiResponse](t, response)
	if len(result.Attachments) != 1 {
		t.Fatalf("expected one attachment for %s, got %+v", name, result.Attachments)
	}
	return result.Item.ID, result.Attachments[0].ID
}

func getThumbnail(t *testing.T, h *v3Harness, attachmentID uuid.UUID) *http.Response {
	t.Helper()
	request := newRequest(t, http.MethodGet,
		h.server.URL+"/api/v1/attachments/"+attachmentID.String()+"/thumbnail", nil, "", "")
	response, err := h.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func countDerivativeRows(t *testing.T, h *v3Harness, attachmentID uuid.UUID) int {
	t.Helper()
	var count int
	if err := h.database.QueryRow(context.Background(),
		`SELECT count(*) FROM attachment_derivatives WHERE attachment_id = $1`, attachmentID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func listDerivativeFiles(t *testing.T, root string) []string {
	t.Helper()
	var files []string
	derivatives := filepath.Join(root, "derivatives")
	entries, err := os.ReadDir(derivatives)
	if os.IsNotExist(err) {
		return files
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, first := range entries {
		if !first.IsDir() {
			files = append(files, filepath.Join(derivatives, first.Name()))
			continue
		}
		children, err := os.ReadDir(filepath.Join(derivatives, first.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, child := range children {
			files = append(files, filepath.Join(derivatives, first.Name(), child.Name()))
		}
	}
	return files
}

func countDecodeTempFiles(t *testing.T, root string) int {
	t.Helper()
	leftovers, err := filepath.Glob(filepath.Join(root, "tmp", "thumbnail-*"))
	if err != nil {
		t.Fatal(err)
	}
	return len(leftovers)
}

// T33: 并发请求多个附件时，真实 HTTP 路径上的重型解码被共享 permit 串行化。
func TestV3ThumbnailConcurrentRequestsBoundedDecode(t *testing.T) {
	h := newV3Harness(t)
	content := thumbnailWidePNG()
	attachmentIDs := make([]uuid.UUID, 0, 10)
	for index := range 10 {
		_, attachmentID := uploadThumbnailFixture(t, h, "t33-"+string(rune('a'+index)), content)
		attachmentIDs = append(attachmentIDs, attachmentID)
	}

	var peak atomic.Int64
	samplerDone := make(chan struct{})
	samplerStop := make(chan struct{})
	go func() {
		defer close(samplerDone)
		ticker := time.NewTicker(2 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-samplerStop:
				return
			case <-ticker.C:
				current := int64(h.knowledge.InFlightDecodes())
				for {
					previous := peak.Load()
					if current <= previous || peak.CompareAndSwap(previous, current) {
						break
					}
				}
			}
		}
	}()

	type result struct {
		status int
		body   []byte
	}
	results := make(chan result, len(attachmentIDs))
	var wg sync.WaitGroup
	for _, attachmentID := range attachmentIDs {
		wg.Add(1)
		go func(id uuid.UUID) {
			defer wg.Done()
			response := getThumbnail(t, h, id)
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Error(err)
			}
			response.Body.Close()
			results <- result{status: response.StatusCode, body: body}
		}(attachmentID)
	}
	wg.Wait()
	close(samplerStop)
	<-samplerDone

	first := <-results
	if first.status != http.StatusOK {
		t.Fatalf("thumbnail status = %d, body = %s", first.status, first.body)
	}
	for range len(attachmentIDs) - 1 {
		if other := <-results; other.status != http.StatusOK || !bytes.Equal(other.body, first.body) {
			t.Fatalf("concurrent thumbnail diverged: status=%d", other.status)
		}
	}
	if peak := peak.Load(); peak != 1 {
		t.Fatalf("peak concurrent decodes = %d, want exactly 1", peak)
	}
	for _, attachmentID := range attachmentIDs {
		if count := countDerivativeRows(t, h, attachmentID); count != 1 {
			t.Fatalf("attachment %s has %d derivative rows, want 1", attachmentID, count)
		}
	}
}

// T34: 同一附件并发生成只产生一条派生记录与一个派生文件，且无解码临时文件残留。
func TestV3ThumbnailSameAttachmentConcurrentSingleDerivative(t *testing.T) {
	h := newV3Harness(t)
	_, attachmentID := uploadThumbnailFixture(t, h, "t34-same", thumbnailSmallPNG())

	type result struct {
		status int
		body   []byte
	}
	const concurrency = 6
	results := make(chan result, concurrency)
	var wg sync.WaitGroup
	for range concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response := getThumbnail(t, h, attachmentID)
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Error(err)
			}
			response.Body.Close()
			results <- result{status: response.StatusCode, body: body}
		}()
	}
	wg.Wait()

	var first result
	for index := range concurrency {
		if index == 0 {
			first = <-results
			if first.status != http.StatusOK {
				t.Fatalf("thumbnail status = %d, body = %s", first.status, first.body)
			}
			continue
		}
		if other := <-results; other.status != http.StatusOK || !bytes.Equal(other.body, first.body) {
			t.Fatalf("concurrent generation of one attachment returned diverging results")
		}
	}
	if count := countDerivativeRows(t, h, attachmentID); count != 1 {
		t.Fatalf("derivative rows = %d, want exactly 1", count)
	}
	files := listDerivativeFiles(t, h.attachmentRoot)
	if len(files) != 1 {
		t.Fatalf("derivative files = %v, want exactly 1", files)
	}
	if leftovers := countDecodeTempFiles(t, h.attachmentRoot); leftovers != 0 {
		t.Fatalf("%d decode temp files left behind", leftovers)
	}
}

// T35a: 解码期间附件被删除 → 不登记派生物、不重新暴露已删除内容、临时文件清理。
func TestV3ThumbnailAttachmentDeletedDuringDecode(t *testing.T) {
	h := newV3Harness(t)
	itemID, attachmentID := uploadThumbnailFixture(t, h, "t35-delete", thumbnailHugePNG())

	type outcome struct {
		status int
		code   string
	}
	delivered := make(chan outcome, 1)
	go func() {
		response := getThumbnail(t, h, attachmentID)
		status, code := v3Error(t, response)
		delivered <- outcome{status: status, code: code}
	}()

	// 等请求进入重型解码窗口后删除附件（回收站化知识条目）。
	time.Sleep(300 * time.Millisecond)
	if _, err := h.database.Exec(context.Background(),
		`UPDATE knowledge_items SET deleted_at = now() WHERE id = $1`, itemID); err != nil {
		t.Fatal(err)
	}

	select {
	case got := <-delivered:
		if got.status != http.StatusNotFound || got.code != "NOT_FOUND" {
			t.Fatalf("deleted attachment served status=%d code=%s, want 404 NOT_FOUND", got.status, got.code)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("thumbnail request did not finish after deletion")
	}
	if count := countDerivativeRows(t, h, attachmentID); count != 0 {
		t.Fatalf("deleted attachment kept %d derivative rows", count)
	}
	if files := listDerivativeFiles(t, h.attachmentRoot); len(files) != 0 {
		t.Fatalf("deleted attachment left derivative files: %v", files)
	}
	if leftovers := countDecodeTempFiles(t, h.attachmentRoot); leftovers != 0 {
		t.Fatalf("%d decode temp files left behind", leftovers)
	}
	// 已删除附件不得再次暴露内容。
	if response := getThumbnail(t, h, attachmentID); response.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		t.Fatalf("second lookup status = %d, body = %s", response.StatusCode, body)
	}
}

// T35b: 解码期间原件被替换 → 校验失败、不登记过期派生物、文件不落地。
func TestV3ThumbnailOriginalReplacedDuringDecode(t *testing.T) {
	h := newV3Harness(t)
	_, attachmentID := uploadThumbnailFixture(t, h, "t35-replace", thumbnailHugePNG())

	type outcome struct {
		status int
		code   string
	}
	delivered := make(chan outcome, 1)
	go func() {
		response := getThumbnail(t, h, attachmentID)
		status, code := v3Error(t, response)
		delivered <- outcome{status: status, code: code}
	}()

	// 解码窗口内替换原件身份标识（存储键、内容摘要、大小）。
	time.Sleep(300 * time.Millisecond)
	if _, err := h.database.Exec(context.Background(), `
		UPDATE attachments
		SET storage_key = 'blobs/zz/replaced-original',
		    content_sha256 = decode(repeat('ab', 32), 'hex'),
		    size_bytes = size_bytes + 1
		WHERE id = $1
	`, attachmentID); err != nil {
		t.Fatal(err)
	}

	select {
	case got := <-delivered:
		if got.status != http.StatusConflict || got.code != "ATTACHMENT_INTEGRITY_FAILED" {
			t.Fatalf("replaced original served status=%d code=%s, want 409 ATTACHMENT_INTEGRITY_FAILED", got.status, got.code)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("thumbnail request did not finish after original replacement")
	}
	if count := countDerivativeRows(t, h, attachmentID); count != 0 {
		t.Fatalf("stale derivative registered for replaced original: %d rows", count)
	}
	if files := listDerivativeFiles(t, h.attachmentRoot); len(files) != 0 {
		t.Fatalf("stale derivative files left on disk: %v", files)
	}
	if leftovers := countDecodeTempFiles(t, h.attachmentRoot); leftovers != 0 {
		t.Fatalf("%d decode temp files left behind", leftovers)
	}
}

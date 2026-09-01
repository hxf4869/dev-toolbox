package aliyun

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	ocr "github.com/alibabacloud-go/ocr-api-20210707/v3/client"
	"github.com/alibabacloud-go/tea/dara"
	"github.com/google/uuid"
)

func syntheticPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	imageData := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			imageData.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 0x7F, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, imageData); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func syntheticJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	imageData := image.NewGray(image.Rect(0, 0, width, height))
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, imageData, nil); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// syntheticWebP crafts a minimal lossless WebP whose VP8L header carries the
// given dimensions; DecodeConfig reads only that header.
func syntheticWebP(width, height int) []byte {
	vp8l := make([]byte, 5)
	vp8l[0] = 0x2f // VP8L signature
	binary.LittleEndian.PutUint32(vp8l[1:5], uint32(width-1)|uint32(height-1)<<14)
	chunk := make([]byte, 0, 8+len(vp8l))
	chunk = append(chunk, 'V', 'P', '8', 'L')
	chunk = binary.LittleEndian.AppendUint32(chunk, uint32(len(vp8l)))
	chunk = append(chunk, vp8l...)
	file := make([]byte, 0, 12+len(chunk))
	file = append(file, 'R', 'I', 'F', 'F')
	file = binary.LittleEndian.AppendUint32(file, uint32(4+len(chunk)))
	file = append(file, 'W', 'E', 'B', 'P')
	return append(file, chunk...)
}

func ocrUploadRequest(t *testing.T, contentType string, content []byte, extraParts ...func(*multipart.Writer)) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="image"; filename="fixture-image"`)
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	for _, extra := range extraParts {
		extra(writer)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/api/v1/aliyun/ocr", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func withExtraField(writer *multipart.Writer) {
	_ = writer.WriteField("url", "https://images.example.test/scan.png")
}

func withSecondFile(writer *multipart.Writer) {
	part, err := writer.CreateFormFile("image", "second.png")
	if err != nil {
		return
	}
	_, _ = part.Write([]byte("duplicate"))
}

func assertUploadRejected(t *testing.T, reason string, request *http.Request) []byte {
	t.Helper()
	data, decisionErr := parseOcrUpload(request)
	if data != nil || decisionErr == nil {
		t.Fatalf("expected upload rejection %q, got data=%d err=%v", reason, len(data), decisionErr)
	}
	if decisionErr.Code != "INVALID_INPUT" || decisionErr.Status != statusBadRequest {
		t.Fatalf("rejection must be INVALID_INPUT/400: %+v", decisionErr)
	}
	if got := decisionErr.Details["reason"]; got != reason {
		t.Fatalf("rejection reason = %v, want %q (details %+v)", got, reason, decisionErr.Details)
	}
	return nil
}

func TestOcrUploadAcceptsPngJpegWebp(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		contentType string
		content     []byte
	}{
		{"png", "image/png", syntheticPNG(t, 32, 32)},
		{"jpeg", "image/jpeg", syntheticJPEG(t, 48, 24)},
		{"webp", "image/webp", syntheticWebP(64, 32)},
		{"png at limits", "image/png", syntheticPNG(t, 4096, 96)},
	} {
		data, decisionErr := parseOcrUpload(ocrUploadRequest(t, testCase.contentType, testCase.content))
		if decisionErr != nil {
			t.Fatalf("%s rejected: %+v", testCase.name, decisionErr)
		}
		if len(data) != len(testCase.content) {
			t.Fatalf("%s: returned %d bytes, want %d", testCase.name, len(data), len(testCase.content))
		}
	}
}

func TestOcrUploadRejectsBadDimensions(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		width  int
		height int
		reason string
	}{
		{"too small width", 15, 64, "too_small"},
		{"too small height", 64, 15, "too_small"},
		{"too long edge", 4097, 64, "too_large"},
		{"aspect exactly 50", 16, 800, "aspect_ratio"},
	} {
		request := ocrUploadRequest(t, "image/png", syntheticPNG(t, testCase.width, testCase.height))
		assertUploadRejected(t, testCase.reason, request)
	}
	// Aspect ratio 49 stays inside the boundary.
	if _, decisionErr := parseOcrUpload(ocrUploadRequest(t, "image/png", syntheticPNG(t, 16, 784))); decisionErr != nil {
		t.Fatalf("aspect 49 must pass: %+v", decisionErr)
	}
}

func TestOcrUploadRejectsWrongContainer(t *testing.T) {
	// PNG bytes declared as JPEG.
	assertUploadRejected(t, "type_mismatch", ocrUploadRequest(t, "image/jpeg", syntheticPNG(t, 32, 32)))
	// WebP bytes declared as PNG.
	assertUploadRejected(t, "type_mismatch", ocrUploadRequest(t, "image/png", syntheticWebP(32, 32)))
	// Missing declared type.
	assertUploadRejected(t, "type_mismatch", ocrUploadRequest(t, "", syntheticPNG(t, 32, 32)))
	// Unknown magic bytes (also covers URLs, base64 payloads, file paths).
	assertUploadRejected(t, "unsupported_type", ocrUploadRequest(t, "text/plain", []byte("https://example.test/a.png")))
	assertUploadRejected(t, "unsupported_type", ocrUploadRequest(t, "application/json", []byte(`{"image":"/tmp/scan.png"}`)))
	assertUploadRejected(t, "unsupported_type", ocrUploadRequest(t, "image/png", []byte("/etc/hostname")))
	// PNG magic with a truncated body cannot be decoded.
	truncated := syntheticPNG(t, 32, 32)[:20]
	assertUploadRejected(t, "undecodable_image", ocrUploadRequest(t, "image/png", truncated))
	// WebP magic with a broken VP8L chunk.
	broken := syntheticWebP(32, 32)
	broken[len(broken)-1] ^= 0xFF
	request := ocrUploadRequest(t, "image/webp", broken)
	data, decisionErr := parseOcrUpload(request)
	if decisionErr == nil && len(data) > 0 {
		t.Fatalf("corrupted webp header accepted")
	}
}

func TestOcrUploadRejectsMultipartShape(t *testing.T) {
	// A second form field (e.g. a URL) is rejected.
	assertUploadRejected(t, "multiple_parts",
		ocrUploadRequest(t, "image/png", syntheticPNG(t, 32, 32), withExtraField))
	// A second file part is rejected.
	assertUploadRejected(t, "multiple_parts",
		ocrUploadRequest(t, "image/png", syntheticPNG(t, 32, 32), withSecondFile))

	// A plain form field instead of the image file part.
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("image", "not-a-file")
	_ = writer.Close()
	fieldRequest := httptest.NewRequest("POST", "/api/v1/aliyun/ocr", &body)
	fieldRequest.Header.Set("Content-Type", writer.FormDataContentType())
	assertUploadRejected(t, "image_part_is_field", fieldRequest)

	// Non-multipart bodies (base64 JSON, raw URL) never reach the parser.
	jsonRequest := httptest.NewRequest("POST", "/api/v1/aliyun/ocr",
		strings.NewReader(`{"image":"data:image/png;base64,AAAA"}`))
	jsonRequest.Header.Set("Content-Type", "application/json")
	assertUploadRejected(t, "body_not_multipart", jsonRequest)

	emptyRequest := httptest.NewRequest("POST", "/api/v1/aliyun/ocr", strings.NewReader(""))
	emptyRequest.Header.Set("Content-Type", "multipart/form-data")
	assertUploadRejected(t, "body_not_multipart", emptyRequest)
}

func TestOcrUploadRejectsOversizedFile(t *testing.T) {
	oversized := append(syntheticPNG(t, 32, 32), make([]byte, ocrMaxImageBytes)...)
	if len(oversized) <= ocrMaxImageBytes {
		t.Fatalf("fixture too small: %d", len(oversized))
	}
	assertUploadRejected(t, "file_too_large", ocrUploadRequest(t, "image/png", oversized))
	if ocrMaxImageBytes != 5<<20 {
		t.Fatalf("product cap must stay 5 MiB: %d", ocrMaxImageBytes)
	}
	if ocrMultipartOverheadBytes <= 0 {
		t.Fatal("multipart overhead must be a fixed positive budget")
	}
}

func TestDetectImageTypeByMagicBytes(t *testing.T) {
	if got := detectImageType(syntheticPNG(t, 16, 16)); got != "png" {
		t.Fatalf("png detection = %q", got)
	}
	if got := detectImageType(syntheticJPEG(t, 16, 16)); got != "jpeg" {
		t.Fatalf("jpeg detection = %q", got)
	}
	if got := detectImageType(syntheticWebP(16, 16)); got != "webp" {
		t.Fatalf("webp detection = %q", got)
	}
	for _, junk := range [][]byte{nil, {0x00}, {0xFF, 0xD8}, []byte("GIF89a"), []byte("RIFF0000WAVE")} {
		if got := detectImageType(junk); got != "" {
			t.Fatalf("junk detected as %q", got)
		}
	}
}

func recognizeResponse(code, data *string) *ocr.RecognizeGeneralResponse {
	body := &ocr.RecognizeGeneralResponseBody{Code: code, Data: data, RequestId: dara.String("req-ocr")}
	return &ocr.RecognizeGeneralResponse{Body: body}
}

func TestDecodeRecognizeResponseMatrix(t *testing.T) {
	code200 := "200"
	code400 := "400"
	parseable := `{"content":"识别文本","sideResults":[]}`

	// Success requires a parseable Data payload, never Code alone.
	result, gatewayErr := decodeRecognizeResponse(recognizeResponse(&code200, &parseable))
	if gatewayErr != nil || result.Text != "识别文本" || result.UpstreamRequestID != "req-ocr" {
		t.Fatalf("parseable data must succeed: %+v %+v", result, gatewayErr)
	}
	// Empty content still parses and counts as a successful recognition.
	emptyContent := `{"content":""}`
	result, gatewayErr = decodeRecognizeResponse(recognizeResponse(&code200, &emptyContent))
	if gatewayErr != nil || result.Text != "" {
		t.Fatalf("empty content must parse: %+v %+v", result, gatewayErr)
	}
	// Code==200 with unparseable Data is a definite failure, not a success.
	for _, bad := range []string{"not-json", `{"other":1}`, ""} {
		_, gatewayErr := decodeRecognizeResponse(recognizeResponse(&code200, &bad))
		if gatewayErr == nil || gatewayErr.UpstreamNonSuccess {
			t.Fatalf("unparseable Data %q must be a definite failure: %+v", bad, gatewayErr)
		}
		if gatewayErr.Category != failureUnknown {
			t.Fatalf("unparseable Data category: %+v", gatewayErr)
		}
	}
	// Missing Data payload is a definite failure.
	_, gatewayErr = decodeRecognizeResponse(recognizeResponse(&code200, nil))
	if gatewayErr == nil || gatewayErr.UpstreamNonSuccess {
		t.Fatalf("missing Data must be a definite failure: %+v", gatewayErr)
	}
	// A parseable Data.content is successful even when Code is not 200; the
	// product contract deliberately does not make Code the success predicate.
	result, gatewayErr = decodeRecognizeResponse(recognizeResponse(&code400, &parseable))
	if gatewayErr != nil || result.Text != "识别文本" {
		t.Fatalf("parseable data must win over non-200 code: %+v %+v", result, gatewayErr)
	}
	// A non-200 body without usable Data is provable upstream non-success.
	_, gatewayErr = decodeRecognizeResponse(recognizeResponse(&code400, nil))
	if gatewayErr == nil || !gatewayErr.UpstreamNonSuccess {
		t.Fatalf("non-200 body without data must prove upstream non-success: %+v", gatewayErr)
	}
	// Empty body is a definite failure.
	_, gatewayErr = decodeRecognizeResponse(&ocr.RecognizeGeneralResponse{})
	if gatewayErr == nil || gatewayErr.UpstreamNonSuccess {
		t.Fatalf("empty body must be a definite failure: %+v", gatewayErr)
	}
}

func TestOcrSettlementPlanCoversThreePaths(t *testing.T) {
	key := uuid.New()
	at := time.Unix(1780000000, 0).UTC()

	plan := ocrSettlementPlan(key, at, OcrResult{Text: "文本", UpstreamRequestID: "r1"}, nil)
	if plan.Status != callSucceeded || plan.FailureCategory != "" || plan.UpstreamRequestID != "r1" {
		t.Fatalf("success plan wrong: %+v", plan)
	}

	// Local pre-call stop: released without a failure category.
	plan = ocrSettlementPlan(key, at, OcrResult{}, &GatewayError{Category: failureTimeout, NotIssued: true})
	if plan.Status != callReleased || plan.FailureCategory != "" {
		t.Fatalf("not-issued plan wrong: %+v", plan)
	}

	// Provable upstream rejection: released, category kept for the trail.
	plan = ocrSettlementPlan(key, at, OcrResult{}, &GatewayError{
		Category: failureInvalidImage, UpstreamNonSuccess: true, RequestID: "r2",
	})
	if plan.Status != callReleased || plan.FailureCategory != failureInvalidImage || plan.UpstreamRequestID != "r2" {
		t.Fatalf("upstream rejection plan wrong: %+v", plan)
	}

	// Ambiguous outcome: uncertain, counted.
	plan = ocrSettlementPlan(key, at, OcrResult{}, &GatewayError{Category: failureTimeout, Uncertain: true})
	if plan.Status != callUncertain || plan.FailureCategory != failureTimeout {
		t.Fatalf("uncertain plan wrong: %+v", plan)
	}

	// Definite failure without proof of non-success: counted.
	plan = ocrSettlementPlan(key, at, OcrResult{}, &GatewayError{Category: failureUnknown})
	if plan.Status != callFailedCounted || plan.FailureCategory != failureUnknown {
		t.Fatalf("failed_counted plan wrong: %+v", plan)
	}
}

func TestOcrSdkAdapterFacts(t *testing.T) {
	if ocrEndpoint != "ocr-api.cn-hangzhou.aliyuncs.com" {
		t.Fatalf("ocr endpoint must stay fixed: %s", ocrEndpoint)
	}
	if sdkCallDeadline != 45*time.Second {
		t.Fatalf("ocr deadline must stay 45s: %s", sdkCallDeadline)
	}
	if runtime := noRetryRuntime(); runtime.Autoretry == nil || *runtime.Autoretry {
		t.Fatal("SDK runtime must disable automatic retry")
	}
}

func TestOcrDataPayloadOnlyConsumesContent(t *testing.T) {
	// Full upstream payloads with coordinates, tables and confidence must not
	// leak anything beyond content into OcrResult.
	full := `{"content":"第一行\n第二行","blocks":[{"word":"第一行","pos":[]}],"fig":false}`
	result, gatewayErr := decodeRecognizeResponse(recognizeResponse(dara.String("200"), &full))
	if gatewayErr != nil {
		t.Fatalf("full payload must parse: %+v", gatewayErr)
	}
	encoded, _ := json.Marshal(result)
	if bytes.Contains(encoded, []byte("blocks")) || bytes.Contains(encoded, []byte("word")) {
		t.Fatalf("result leaked non-contract fields: %s", encoded)
	}
}

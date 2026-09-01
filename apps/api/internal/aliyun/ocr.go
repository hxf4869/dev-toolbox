package aliyun

import (
	"bytes"
	"context"
	"errors"
	"image"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"

	// Standard and repo-approved decoders registered for image.DecodeConfig.
	_ "golang.org/x/image/webp"
	_ "image/jpeg"
	_ "image/png"
)

// OCR upload boundaries fixed by docs/11 §11.1.
const (
	ocrMaxImageBytes          = 5 << 20 // 5 MiB product cap for the image itself
	ocrMultipartOverheadBytes = 64 * 1024
	ocrMinDimension           = 15 // width and height must be strictly greater
	ocrMaxDimension           = 4096
	ocrMaxAspectRatio         = 50 // max/min must stay strictly below
)

var ocrCanonicalTypes = map[string]string{
	"png":  "image/png",
	"jpeg": "image/jpeg",
	"webp": "image/webp",
}

func invalidImageUpload(reason string, details map[string]any) *decisionError {
	if details == nil {
		details = map[string]any{}
	}
	details["reason"] = reason
	return &decisionError{Status: statusBadRequest, Code: codeInvalidInput, Details: details}
}

// detectImageType identifies PNG/JPEG/WebP by magic bytes only.
func detectImageType(data []byte) string {
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		return "png"
	case len(data) >= 3 && bytes.Equal(data[:3], []byte{0xFF, 0xD8, 0xFF}):
		return "jpeg"
	case len(data) >= 12 && bytes.Equal(data[0:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "webp"
	default:
		return ""
	}
}

// parseOcrUpload enforces every pre-call boundary of docs/11 §11.1: one
// multipart file part named image, 5 MiB cap plus fixed overhead, magic bytes
// matching the declared type, and dimension/aspect limits. The image buffer
// lives only for this request and is handed straight to the gateway.
func parseOcrUpload(request *http.Request) ([]byte, *decisionError) {
	mediaType, params, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" || params["boundary"] == "" {
		return nil, invalidImageUpload("body_not_multipart", nil)
	}
	maxRequest := int64(ocrMaxImageBytes + ocrMultipartOverheadBytes)
	reader := multipart.NewReader(io.LimitReader(request.Body, maxRequest+1), params["boundary"])

	part, err := reader.NextPart()
	if err != nil {
		return nil, invalidImageUpload("missing_image_part", nil)
	}
	if part.FormName() != "image" {
		part.Close()
		return nil, invalidImageUpload("missing_image_part", nil)
	}
	if part.FileName() == "" {
		part.Close()
		return nil, invalidImageUpload("image_part_is_field", nil)
	}
	declared := part.Header.Get("Content-Type")
	data, err := io.ReadAll(io.LimitReader(part, ocrMaxImageBytes+1))
	part.Close()
	if err != nil {
		return nil, invalidImageUpload("unreadable_image", nil)
	}
	if len(data) > ocrMaxImageBytes {
		return nil, invalidImageUpload("file_too_large", map[string]any{"maxBytes": ocrMaxImageBytes})
	}
	if extra, extraErr := reader.NextPart(); extra != nil {
		extra.Close()
		return nil, invalidImageUpload("multiple_parts", nil)
	} else if extraErr != nil && !errors.Is(extraErr, io.EOF) {
		return nil, invalidImageUpload("malformed_body", nil)
	}

	detected := detectImageType(data)
	if detected == "" {
		return nil, invalidImageUpload("unsupported_type", nil)
	}
	if ocrCanonicalTypes[detected] != declared {
		return nil, invalidImageUpload("type_mismatch", map[string]any{
			"detectedType": ocrCanonicalTypes[detected], "declaredType": declared,
		})
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, invalidImageUpload("undecodable_image", nil)
	}
	dimensionDetails := map[string]any{"width": config.Width, "height": config.Height}
	longEdge := max(config.Width, config.Height)
	shortEdge := min(config.Width, config.Height)
	if config.Width <= ocrMinDimension || config.Height <= ocrMinDimension {
		return nil, invalidImageUpload("too_small", dimensionDetails)
	}
	if longEdge > ocrMaxDimension {
		return nil, invalidImageUpload("too_large", dimensionDetails)
	}
	if shortEdge <= 0 || longEdge >= shortEdge*ocrMaxAspectRatio {
		return nil, invalidImageUpload("aspect_ratio", dimensionDetails)
	}
	return data, nil
}

// reserveOCRCall performs the docs/11 §5.1 reservation for one OCR call on
// the ocr_general meter with the common lock order and §6 replay semantics.
func (service *Service) reserveOCRCall(
	ctx context.Context, ownerID, requestKey uuid.UUID,
) (reservation, *decisionError, error) {
	if err := service.recoverStaleReservations(ctx); err != nil {
		return reservation{}, nil, err
	}
	now := service.now().UTC()
	monthStart := currentMonthStart(service.now())

	transaction, err := service.database.Begin(ctx)
	if err != nil {
		return reservation{}, nil, err
	}
	defer rollbackUnlessCommitted(transaction)

	settings, err := lockSettingsShare(ctx, transaction)
	if err != nil {
		return reservation{}, nil, err
	}
	_, found, err := readExistingCall(ctx, transaction, requestKey)
	if err != nil {
		return reservation{}, nil, err
	}
	usage, err := ensureMonthRow(ctx, transaction, monthStart, meterOCR)
	if err != nil {
		return reservation{}, nil, err
	}
	remaining := settings.OCRLimit - usage.Used - usage.Reserved
	choice := engineChoice{Engine: "ocr", Meter: meterOCR, Scene: ""}
	if found {
		locked, err := lockCallRow(ctx, transaction, requestKey)
		if err != nil {
			return reservation{}, nil, err
		}
		var decisionErr *decisionError
		if remaining < 1 {
			decisionErr = quotaExhausted(meterOCR, remaining)
		}
		return reservation{}, replayDecision(locked, choice, decisionErr, 1), nil
	}
	if remaining < 1 {
		return reservation{}, quotaExhausted(meterOCR, remaining), nil
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO aliyun_usage_calls (request_key, owner_id, operation, meter, month_start,
			reserved_units, counted_units, status, created_at)
		VALUES ($1, $2, $3, $4, $5, 1, 0, $6, $7)
	`, requestKey, ownerID, operationOCRGeneral, meterOCR, monthStart, callReserved, now); err != nil {
		return reservation{}, nil, err
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE aliyun_usage_months SET reserved_units = reserved_units + 1, updated_at = $3
		WHERE month_start = $1 AND meter = $2
	`, monthStart, meterOCR, now); err != nil {
		return reservation{}, nil, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return reservation{}, nil, err
	}
	return reservation{
		Call: existingCall{
			RequestKey: requestKey, Status: callReserved, Operation: operationOCRGeneral,
			Meter: meterOCR, MonthStart: monthStart, ReservedUnits: 1,
		},
		Engine:     choice,
		Remaining:  remaining - 1,
		MonthStart: monthStart,
	}, nil, nil
}

type ocrSuccess struct {
	Text              string     `json:"text"`
	UpstreamRequestID string     `json:"upstreamRequestId"`
	BillableUnits     int64      `json:"billableUnits"`
	Quota             chunkQuota `json:"quota"`
	Replayed          bool       `json:"replayed"`
}

// handleRecognizeOCR implements docs/11 §11.1: boundary validation before the
// cloud call, permit/idempotency/in-flight checks, one-unit reservation, one
// RecognizeGeneral call and the OCR settlement rules.
func (service *Service) handleRecognizeOCR(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	requestKey, err := uuid.Parse(request.Header.Get("Idempotency-Key"))
	if err != nil {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	imageData, inputErr := parseOcrUpload(request)
	if inputErr != nil {
		writeDecisionError(response, request, inputErr)
		return
	}
	ownerID, ok := ticketOwnerFromRequest(request)
	if !ok {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	permit, code := service.queue.ValidatePermit(request.Header.Get("X-Cloud-Permit"), ownerID, OperationOCR)
	if code != "" {
		writeAliyunError(response, request, code, nil)
		return
	}
	// The §6 idempotency answer wins over CLOUD_PERMIT_BUSY (docs/11 §9.5).
	replay, decisionErr, err := service.replayExistingKey(
		request.Context(), requestKey, operationOCRGeneral, meterOCR, 1,
	)
	if err != nil {
		writeInternalError(response, request)
		return
	}
	if replay {
		writeDecisionError(response, request, decisionErr)
		return
	}
	release, code := service.queue.BeginInflight(permit, requestKey)
	if code != "" {
		writeCodeError(response, request, code)
		return
	}
	defer release()

	snapshot, err := service.readSettings(request.Context())
	if err != nil {
		writeInternalError(response, request)
		return
	}
	if !snapshot.HasCredentials {
		writeCodeError(response, request, codeNotConfigured)
		return
	}
	accessKeyID, accessKeySecret, err := service.decryptCredentials(snapshot)
	if err != nil {
		writeInternalError(response, request)
		return
	}

	reserved, decisionErr, err := service.reserveOCRCall(request.Context(), ownerID, requestKey)
	if err != nil {
		writeInternalError(response, request)
		return
	}
	if decisionErr != nil {
		writeDecisionError(response, request, decisionErr)
		return
	}

	callCtx, cancel := mergeCancelContexts(request.Context(), permit.context)
	defer cancel()
	started := service.now()
	result, gatewayErr := service.ocrGateway.Recognize(callCtx, CloudCredentials{
		AccessKeyID: accessKeyID, AccessKeySecret: accessKeySecret, Version: snapshot.CredentialVersion,
	}, imageData)
	duration := service.now().Sub(started)
	// The bounded image buffer is never referenced past the gateway return.
	imageData = nil

	settleCtx, settleCancel := settlementContext(request.Context())
	defer settleCancel()
	settlement, err := service.settleOCROutcome(settleCtx, requestKey, result, gatewayErr)
	if err != nil {
		writeInternalError(response, request)
		return
	}
	service.logSettlement(context.WithoutCancel(request.Context()), requestKey, reserved, settlement, gatewayErr, duration)

	remaining := reserved.Remaining
	if settlement.Status == callReleased {
		remaining++
	}
	if gatewayErr != nil {
		writeUpstreamError(response, request, gatewayErr, settlement, meterOCR, remaining)
		return
	}
	httpapi.WriteJSON(response, statusOK, ocrSuccess{
		Text:              result.Text,
		UpstreamRequestID: result.UpstreamRequestID,
		BillableUnits:     1,
		Quota:             chunkQuota{Meter: meterOCR, Remaining: remaining},
		Replayed:          false,
	})
}

// settleOCROutcome applies the OCR column of docs/11 §5.3: released only with
// positive proof of an upstream non-success without a recognition result,
// uncertain for anything ambiguous, failed_counted for definite failures
// that cannot be proven unbilled.
func (service *Service) settleOCROutcome(
	ctx context.Context, requestKey uuid.UUID, result OcrResult, gatewayErr *GatewayError,
) (settleResult, error) {
	return service.settleCall(ctx, ocrSettlementPlan(requestKey, service.now().UTC(), result, gatewayErr))
}

// ocrSettlementPlan maps a gateway outcome to its OCR settlement row update.
func ocrSettlementPlan(requestKey uuid.UUID, at time.Time, result OcrResult, gatewayErr *GatewayError) settleInput {
	input := settleInput{RequestKey: requestKey, At: at}
	switch {
	case gatewayErr == nil:
		input.Status = callSucceeded
		input.UpstreamRequestID = result.UpstreamRequestID
	case gatewayErr.NotIssued:
		input.Status = callReleased
	case gatewayErr.Uncertain:
		input.Status = callUncertain
		input.FailureCategory = gatewayErr.Category
	case gatewayErr.UpstreamNonSuccess:
		// Only successful recognitions bill upstream (docs/11 §2.2), so a
		// definitive upstream rejection restores the reserved unit while
		// still advancing the failure trail via its category.
		input.Status = callReleased
		input.FailureCategory = gatewayErr.Category
		input.UpstreamRequestID = gatewayErr.RequestID
	default:
		input.Status = callFailedCounted
		input.FailureCategory = gatewayErr.Category
		input.UpstreamRequestID = gatewayErr.RequestID
	}
	return input
}

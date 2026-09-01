package aliyun

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	mt "github.com/alibabacloud-go/alimt-20181012/v2/client"
	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	ocr "github.com/alibabacloud-go/ocr-api-20210707/v3/client"
	openapiutil "github.com/alibabacloud-go/openapi-util/service"
	"github.com/alibabacloud-go/tea/dara"
	"github.com/alibabacloud-go/tea/tea"
)

// Fixed endpoints per docs/11 §2.1/§2.2; never accepted from requests.
const (
	translationEndpoint = "mt.cn-hangzhou.aliyuncs.com"
	ocrEndpoint         = "ocr-api.cn-hangzhou.aliyuncs.com"
	sdkCallDeadline     = 45 * time.Second
)

// Stable failure categories, docs/11 §13.1 (11 values).
const (
	failureCredentialInvalid = "credential_invalid"
	failurePermissionDenied  = "permission_denied"
	failureServiceNotOpen    = "service_not_open"
	failureAccountArrears    = "account_arrears"
	failureUnsupportedLang   = "unsupported_language"
	failureInputTooLong      = "input_too_long"
	failureInvalidImage      = "invalid_image"
	failureThrottled         = "throttled"
	failureTimeout           = "timeout"
	failureUnavailable       = "unavailable"
	failureUnknown           = "unknown"
)

var validFailureCategories = map[string]struct{}{
	failureCredentialInvalid: {}, failurePermissionDenied: {}, failureServiceNotOpen: {},
	failureAccountArrears: {}, failureUnsupportedLang: {}, failureInputTooLong: {},
	failureInvalidImage: {}, failureThrottled: {}, failureTimeout: {},
	failureUnavailable: {}, failureUnknown: {},
}

// CloudCredentials is the decrypted RAM credential snapshot handed to the gateway.
type CloudCredentials struct {
	AccessKeyID     string
	AccessKeySecret string
	Version         int64
}

// TranslationInput is the module-internal validated DTO for one chunk.
type TranslationInput struct {
	Engine         string // general | professional
	Scene          string // general or one of the six professional scenes
	SourceLanguage string // never auto for professional
	SourceText     string
	TargetLanguage string
}

// TranslationResult carries only the fields the API may return.
type TranslationResult struct {
	TranslatedText    string
	DetectedLanguage  string
	UpstreamRequestID string
}

// GatewayError is the only error shape the gateway may return. Category uses
// the stable §13.1 enum; upstream messages never leave the adapter.
type GatewayError struct {
	Category  string
	RequestID string
	// Uncertain marks outcomes where the server cannot prove the request was
	// not accepted upstream (timeout, connection loss, 5xx); these settle as
	// uncertain and count against the local ledger.
	Uncertain bool
	// NotIssued marks local failures provably before any bytes were sent.
	NotIssued bool
	// UpstreamNonSuccess marks positive evidence that the upstream answered
	// with a definitive non-success (explicit error response). OCR may settle
	// such calls as released because only successful recognitions bill.
	UpstreamNonSuccess bool
	Issue              error
}

func (e *GatewayError) Error() string {
	category := e.Category
	if category == "" {
		category = "uncategorized"
	}
	if e.NotIssued {
		return fmt.Sprintf("aliyun call not issued: %s", category)
	}
	if e.Uncertain {
		return fmt.Sprintf("aliyun call uncertain: %s", category)
	}
	return fmt.Sprintf("aliyun call failed: %s", category)
}

// TranslationGateway is the narrow seam in front of the official SDK. Tests
// inject fakes; production uses NewSDKTranslationGateway.
type TranslationGateway interface {
	Translate(ctx context.Context, credentials CloudCredentials, input TranslationInput) (TranslationResult, *GatewayError)
}

type sdkTranslationGateway struct {
	clients credentialClientCache[*mt.Client]
}

// NewSDKTranslationGateway returns the production alimt adapter. Clients are
// cached per credential version and replaced atomically; calls are issued at
// most once with a fixed 45s total deadline and no automatic retry.
func NewSDKTranslationGateway() TranslationGateway {
	return &sdkTranslationGateway{}
}

func (gateway *sdkTranslationGateway) clientFor(credentials CloudCredentials) (*mt.Client, error) {
	return gateway.clients.get(credentials.Version, credentials.AccessKeyID, credentials.AccessKeySecret,
		func() (*mt.Client, error) {
			return mt.NewClient(&openapi.Config{
				AccessKeyId:     dara.String(credentials.AccessKeyID),
				AccessKeySecret: dara.String(credentials.AccessKeySecret),
				Endpoint:        dara.String(translationEndpoint),
			})
		})
}

// credentialClientCache is the shared credential-version-keyed client cache
// used by every aliyun SDK gateway: a client is reused while the credential
// version and AccessKey ID are unchanged and replaced atomically otherwise.
type credentialClientCache[T any] struct {
	mutex       sync.Mutex
	ready       bool
	version     int64
	accessKeyID string
	client      T
}

func (cache *credentialClientCache[T]) get(
	version int64, accessKeyID, accessKeySecret string, build func() (T, error),
) (T, error) {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	if cache.ready && cache.version == version && cache.accessKeyID == accessKeyID {
		return cache.client, nil
	}
	client, err := build()
	if err != nil {
		return client, err
	}
	cache.client = client
	cache.version = version
	cache.accessKeyID = accessKeyID
	cache.ready = true
	return client, nil
}

func (gateway *sdkTranslationGateway) Translate(
	ctx context.Context, credentials CloudCredentials, input TranslationInput,
) (TranslationResult, *GatewayError) {
	if ctx.Err() != nil {
		return TranslationResult{}, &GatewayError{Category: failureTimeout, Uncertain: false, NotIssued: true, Issue: ctx.Err()}
	}
	client, err := gateway.clientFor(credentials)
	if err != nil {
		return TranslationResult{}, &GatewayError{Category: failureUnknown, Uncertain: true, NotIssued: true, Issue: err}
	}
	callCtx, cancel := context.WithTimeout(ctx, sdkCallDeadline)
	defer cancel()

	general, professional, callErr := callTranslationSDK(callCtx, client, input)
	if callErr != nil {
		return TranslationResult{}, mapSDKError(callErr)
	}
	if general != nil {
		return decodeGeneralResponse(general)
	}
	if professional != nil {
		return decodeProfessionalResponse(professional)
	}
	return TranslationResult{}, &GatewayError{Category: failureUnknown, Uncertain: true, Issue: errors.New("empty sdk response")}
}

// callTranslationSDK keeps the generated client's context-aware calls behind
// one panic boundary so an SDK defect still reaches the normal settlement path.
func callTranslationSDK(
	ctx context.Context, client *mt.Client, input TranslationInput,
) (general *mt.TranslateGeneralResponse, professional *mt.TranslateResponse, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("sdk panic: %v", recovered)
		}
	}()
	runtime := noRetryRuntime()
	if input.Engine == "professional" {
		professional, err = client.TranslateWithContext(ctx, &mt.TranslateRequest{
			FormatType:     dara.String("text"),
			Scene:          dara.String(input.Scene),
			SourceLanguage: dara.String(input.SourceLanguage),
			SourceText:     dara.String(input.SourceText),
			TargetLanguage: dara.String(input.TargetLanguage),
		}, runtime)
		return nil, professional, err
	}
	general, err = client.TranslateGeneralWithContext(ctx, &mt.TranslateGeneralRequest{
		FormatType:     dara.String("text"),
		Scene:          dara.String("general"),
		SourceLanguage: dara.String(input.SourceLanguage),
		SourceText:     dara.String(input.SourceText),
		TargetLanguage: dara.String(input.TargetLanguage),
	}, runtime)
	return general, nil, err
}

func decodeGeneralResponse(response *mt.TranslateGeneralResponse) (TranslationResult, *GatewayError) {
	body := response.Body
	if body == nil {
		return TranslationResult{}, &GatewayError{Category: failureUnknown, Uncertain: true, Issue: errors.New("empty sdk body")}
	}
	if body.Code != nil && *body.Code != 200 {
		return TranslationResult{}, &GatewayError{
			Category:  classifyUpstreamTextOnly(*body.Code, deref(body.Message)),
			RequestID: deref(body.RequestId),
			Issue:     fmt.Errorf("general translate body code %d", *body.Code),
		}
	}
	if body.Data == nil || body.Data.Translated == nil {
		return TranslationResult{}, &GatewayError{
			Category:  failureUnknown,
			RequestID: deref(body.RequestId),
			Issue:     errors.New("missing translated text"),
		}
	}
	return TranslationResult{
		TranslatedText:    *body.Data.Translated,
		DetectedLanguage:  deref(body.Data.DetectedLanguage),
		UpstreamRequestID: deref(body.RequestId),
	}, nil
}

func decodeProfessionalResponse(response *mt.TranslateResponse) (TranslationResult, *GatewayError) {
	body := response.Body
	if body == nil {
		return TranslationResult{}, &GatewayError{Category: failureUnknown, Uncertain: true, Issue: errors.New("empty sdk body")}
	}
	if body.Code != nil && *body.Code != 200 {
		return TranslationResult{}, &GatewayError{
			Category:  classifyUpstreamTextOnly(*body.Code, deref(body.Message)),
			RequestID: deref(body.RequestId),
			Issue:     fmt.Errorf("professional translate body code %d", *body.Code),
		}
	}
	if body.Data == nil || body.Data.Translated == nil {
		return TranslationResult{}, &GatewayError{
			Category:  failureUnknown,
			RequestID: deref(body.RequestId),
			Issue:     errors.New("missing translated text"),
		}
	}
	return TranslationResult{
		TranslatedText:    *body.Data.Translated,
		DetectedLanguage:  deref(body.Data.DetectedLanguage),
		UpstreamRequestID: deref(body.RequestId),
	}, nil
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// mapSDKError converts SDK/network errors to the stable categories without
// leaking the upstream message.
func mapSDKError(err error) *GatewayError {
	var sdkError *dara.SDKError
	if errors.As(err, &sdkError) {
		return classifySDKError(sdkError)
	}
	var netError net.Error
	if errors.Is(err, context.Canceled) {
		return &GatewayError{Category: failureTimeout, Uncertain: true, Issue: err}
	}
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netError) && netError.Timeout()) {
		return &GatewayError{Category: failureTimeout, Uncertain: true, Issue: err}
	}
	if errors.As(err, &netError) {
		return &GatewayError{Category: failureUnavailable, Uncertain: true, Issue: err}
	}
	return &GatewayError{Category: failureUnknown, Uncertain: true, Issue: err}
}

func classifySDKError(sdkError *dara.SDKError) *GatewayError {
	code := deref(sdkError.Code)
	message := deref(sdkError.Message)
	requestID := extractSDKRequestID(sdkError)
	status := 0
	if sdkError.StatusCode != nil {
		status = *sdkError.StatusCode
	}
	if status >= 500 {
		return &GatewayError{Category: failureUnavailable, Uncertain: true, RequestID: requestID, Issue: sdkError}
	}
	category, uncertain := classifyUpstreamText(code, message)
	if status == 429 && category == failureUnknown {
		// A definitive 429 is an explicit upstream throttle response.
		category, uncertain = failureThrottled, false
	}
	if uncertain && status >= 400 && status < 500 && category == failureUnknown {
		// A definitive 4xx proves the request reached Aliyun and was rejected.
		uncertain = false
	}
	return &GatewayError{
		Category: category, Uncertain: uncertain, UpstreamNonSuccess: !uncertain,
		RequestID: requestID, Issue: sdkError,
	}
}

func classifyUpstreamTextOnly(code int32, message string) string {
	category, _ := classifyUpstreamText(fmt.Sprintf("%d", code), message)
	return category
}

func classifyUpstreamText(code, message string) (string, bool) {
	combined := strings.ToLower(code + " " + message)
	switch {
	case strings.Contains(combined, "invalidaccesskeyid"),
		strings.Contains(combined, "signaturedoesnotmatch"),
		strings.Contains(combined, "securitytoken"),
		strings.Contains(combined, "invalidaccesskey"):
		return failureCredentialInvalid, false
	case strings.Contains(combined, "servicenotopen"),
		strings.Contains(combined, "service_not_open"),
		strings.Contains(combined, "notopened"),
		strings.Contains(combined, "not_opened"):
		return failureServiceNotOpen, false
	case strings.Contains(combined, "forbidden"),
		strings.Contains(combined, "ramuser"),
		strings.Contains(combined, "subuser"),
		strings.Contains(combined, "accesscontrol"),
		strings.Contains(combined, "unauthorized"):
		return failurePermissionDenied, false
	case strings.Contains(combined, "arrears"),
		strings.Contains(combined, "insufficientbalance"),
		strings.Contains(combined, "accountunnormal"),
		strings.Contains(combined, "account abnormal"):
		return failureAccountArrears, false
	case strings.Contains(combined, "sourcelanguage"),
		strings.Contains(combined, "targetlanguage"),
		strings.Contains(combined, "unsupportedlanguage"),
		strings.Contains(combined, "language is not"),
		strings.Contains(combined, "invalidlanguage"):
		return failureUnsupportedLang, false
	case strings.Contains(combined, "texttoolong"),
		strings.Contains(combined, "too long"),
		strings.Contains(combined, "exceed"),
		strings.Contains(combined, "exceeds"),
		strings.Contains(combined, "limit"):
		return failureInputTooLong, false
	case strings.Contains(combined, "throttling"),
		strings.Contains(combined, "throttle"),
		strings.Contains(combined, "flowcontrol"),
		strings.Contains(combined, "flowlimit"),
		strings.Contains(combined, "ratelimit"):
		return failureThrottled, false
	default:
		return failureUnknown, true
	}
}

func extractSDKRequestID(sdkError *dara.SDKError) string {
	data := deref(sdkError.Data)
	if data == "" {
		return ""
	}
	var payload struct {
		RequestID string `json:"RequestId"`
	}
	if json.Unmarshal([]byte(data), &payload) != nil {
		return ""
	}
	return payload.RequestID
}

// OcrResult carries only the fields the OCR API may return; coordinates,
// tables, layout and confidence never leave the gateway (docs/11 §11.1).
type OcrResult struct {
	Text              string
	UpstreamRequestID string
}

// OcrGateway is the narrow seam in front of the official RecognizeGeneral
// SDK; tests inject fakes, production uses NewSDKOcrGateway.
type OcrGateway interface {
	Recognize(ctx context.Context, credentials CloudCredentials, image []byte) (OcrResult, *GatewayError)
}

type sdkOcrGateway struct {
	clients credentialClientCache[*ocr.Client]
}

// NewSDKOcrGateway returns the production RecognizeGeneral adapter with the
// same credential-version cache mechanism as the translation gateway. The
// binary Body stream is sent once with a fixed 45s deadline, no retries and
// no Url field.
func NewSDKOcrGateway() OcrGateway {
	return &sdkOcrGateway{}
}

func (gateway *sdkOcrGateway) clientFor(credentials CloudCredentials) (*ocr.Client, error) {
	return gateway.clients.get(credentials.Version, credentials.AccessKeyID, credentials.AccessKeySecret,
		func() (*ocr.Client, error) {
			return ocr.NewClient(&openapi.Config{
				AccessKeyId:     dara.String(credentials.AccessKeyID),
				AccessKeySecret: dara.String(credentials.AccessKeySecret),
				Endpoint:        dara.String(ocrEndpoint),
			})
		})
}

func (gateway *sdkOcrGateway) Recognize(
	ctx context.Context, credentials CloudCredentials, image []byte,
) (OcrResult, *GatewayError) {
	if ctx.Err() != nil {
		return OcrResult{}, &GatewayError{Category: failureTimeout, NotIssued: true, Issue: ctx.Err()}
	}
	client, err := gateway.clientFor(credentials)
	if err != nil {
		return OcrResult{}, &GatewayError{Category: failureUnknown, NotIssued: true, Issue: err}
	}
	callCtx, cancel := context.WithTimeout(ctx, sdkCallDeadline)
	defer cancel()

	response, callErr := recognizeGeneralWithContext(callCtx, client, image)
	if callErr != nil {
		return OcrResult{}, mapSDKError(callErr)
	}
	return decodeRecognizeResponse(response)
}

// The OCR SDK version in use does not generate RecognizeGeneralWithContext,
// so invoke its embedded OpenAPI client with the same fixed generated request
// shape. This makes request cancellation reach the HTTP transport.
func recognizeGeneralWithContext(
	ctx context.Context, client *ocr.Client, image []byte,
) (response *ocr.RecognizeGeneralResponse, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("sdk panic: %v", recovered)
		}
	}()
	reader := bytes.NewReader(image)
	request := &openapi.OpenApiRequest{
		Query:  openapiutil.Query(map[string]interface{}{}),
		Body:   reader,
		Stream: reader,
	}
	params := &openapi.Params{
		Action:      dara.String("RecognizeGeneral"),
		Version:     dara.String("2021-07-07"),
		Protocol:    dara.String("HTTPS"),
		Pathname:    dara.String("/"),
		Method:      dara.String("POST"),
		AuthType:    dara.String("AK"),
		Style:       dara.String("RPC"),
		ReqBodyType: dara.String("formData"),
		BodyType:    dara.String("json"),
	}
	body, err := client.CallApiWithCtx(ctx, params, request, noRetryRuntime())
	if err != nil {
		return nil, err
	}
	response = &ocr.RecognizeGeneralResponse{}
	if err := tea.Convert(body, response); err != nil {
		return nil, err
	}
	return response, nil
}

// noRetryRuntime disables the SDK's built-in retry loop for every call.
func noRetryRuntime() *dara.RuntimeOptions {
	return &dara.RuntimeOptions{Autoretry: dara.Bool(false)}
}

// decodeRecognizeResponse applies the docs/11 §2.2 success rule: an SDK
// success response counts only when the Data JSON string parses; Code alone
// is never sufficient.
func decodeRecognizeResponse(response *ocr.RecognizeGeneralResponse) (OcrResult, *GatewayError) {
	body := response.Body
	if body == nil {
		return OcrResult{}, &GatewayError{Category: failureUnknown, Issue: errors.New("empty sdk body")}
	}
	var payload struct {
		Content *string `json:"content"`
	}
	var dataErr error
	if body.Data != nil {
		dataErr = json.Unmarshal([]byte(*body.Data), &payload)
		if dataErr == nil && payload.Content != nil {
			return OcrResult{Text: *payload.Content, UpstreamRequestID: deref(body.RequestId)}, nil
		}
	}
	if body.Code != nil && *body.Code != "200" {
		category, _ := classifyUpstreamText(deref(body.Code), deref(body.Message))
		return OcrResult{}, &GatewayError{
			Category: category, UpstreamNonSuccess: true,
			RequestID: deref(body.RequestId), Issue: fmt.Errorf("recognize body code %s", deref(body.Code)),
		}
	}
	if body.Data == nil {
		return OcrResult{}, &GatewayError{
			Category: failureUnknown, RequestID: deref(body.RequestId),
			Issue: errors.New("missing ocr data payload"),
		}
	}
	return OcrResult{}, &GatewayError{
		Category: failureUnknown, RequestID: deref(body.RequestId),
		Issue: errors.New("unparseable ocr data payload"),
	}
}

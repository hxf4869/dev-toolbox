package aliyun

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

// mergeCancelContexts is canceled when either parent is canceled, so permit
// cancellation propagates into an in-flight SDK call (docs/11 §14).
func mergeCancelContexts(primary, secondary context.Context) (context.Context, context.CancelFunc) {
	merged, cancel := context.WithCancel(primary)
	go func() {
		select {
		case <-secondary.Done():
			cancel()
		case <-merged.Done():
		}
	}()
	return merged, cancel
}

const (
	maximumPreflightBytes = 64 * 1024
	maximumChunkBytes     = 64 * 1024
	maximumSourceUnits    = 4999
	maximumPlanChunks     = 191
	maximumPlanUnits      = int64(950000)
)

type preflightRequest struct {
	Operation      string  `json:"operation"`
	SourceLanguage string  `json:"sourceLanguage"`
	TargetLanguage string  `json:"targetLanguage"`
	ChunkUnits     []int64 `json:"chunkUnits"`
	Units          *int64  `json:"units"`
}

type preflightPlanItem struct {
	Index  int    `json:"index"`
	Units  int64  `json:"units"`
	Engine string `json:"engine"`
	Meter  string `json:"meter"`
	Scene  any    `json:"scene"`
}

type preflightTotal struct {
	Meter              string `json:"meter"`
	Chunks             int    `json:"chunks"`
	Units              int64  `json:"units"`
	Limit              int64  `json:"limit"`
	Used               int64  `json:"used"`
	Reserved           int64  `json:"reserved"`
	RemainingBefore    int64  `json:"remainingBefore"`
	RemainingAfterPlan int64  `json:"remainingAfterPlan"`
}

type preflightPlan struct {
	Operation         string              `json:"operation"`
	Month             string              `json:"month"`
	ResetAt           time.Time           `json:"resetAt"`
	Source            string              `json:"source"`
	ProfessionalScene any                 `json:"professionalScene"`
	Items             []preflightPlanItem `json:"items"`
	Totals            []preflightTotal    `json:"totals"`
}

// handlePreflight simulates per-chunk engine selection on the current ledger.
// It never reserves quota and never touches the queue or the SDK.
func (service *Service) handlePreflight(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	var payload preflightRequest
	if httpapi.DecodeJSON(response, request, maximumPreflightBytes, &payload) != nil {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	switch payload.Operation {
	case "translation":
		service.handleTranslationPreflight(response, request, payload)
	case "ocr":
		service.handleOCRPreflight(response, request, payload)
	default:
		writeCodeError(response, request, codeInvalidInput)
	}
}

func (service *Service) handleTranslationPreflight(response http.ResponseWriter, request *http.Request, payload preflightRequest) {
	if !validPlanChunks(payload.ChunkUnits) {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	if payload.Units != nil {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	source := payload.SourceLanguage
	target := payload.TargetLanguage
	if source != "auto" && !IsValidGeneralLanguage(source) {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	if !IsValidGeneralLanguage(target) || target == "auto" {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	if source != "auto" && source == target {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	plan, decisionErr, err := service.simulateTranslationPlan(request.Context(), source, target, payload.ChunkUnits)
	if err != nil {
		writeInternalError(response, request)
		return
	}
	if decisionErr != nil {
		writeDecisionError(response, request, decisionErr)
		return
	}
	httpapi.WriteJSON(response, statusOK, plan)
}

func (service *Service) handleOCRPreflight(response http.ResponseWriter, request *http.Request, payload preflightRequest) {
	if payload.Units == nil || *payload.Units != 1 ||
		payload.SourceLanguage != "" || payload.TargetLanguage != "" || len(payload.ChunkUnits) != 0 {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	monthStart, settings, ledger, err := service.currentUsage(request.Context())
	if err != nil {
		writeInternalError(response, request)
		return
	}
	remaining := clampZero(settings.OCRLimit - ledger.OCR.Used - ledger.OCR.Reserved)
	if remaining < 1 {
		writeDecisionError(response, request, quotaExhausted(meterOCR, remaining))
		return
	}
	httpapi.WriteJSON(response, statusOK, service.buildPreflightPlan("ocr", monthStart, settings,
		[]preflightPlanItem{{Index: 0, Units: 1, Engine: "ocr", Meter: meterOCR, Scene: nil}},
		map[string]planAccumulator{meterOCR: {chunks: 1, units: 1}}, ledger))
}

type planAccumulator struct {
	chunks int
	units  int64
}

func validPlanChunks(units []int64) bool {
	if len(units) < 1 || len(units) > maximumPlanChunks {
		return false
	}
	total := int64(0)
	for _, value := range units {
		if value < 1 || value > maximumSourceUnits {
			return false
		}
		total += value
	}
	return total <= maximumPlanUnits
}

// simulateTranslationPlan walks the chunkUnits in order against the current
// snapshot and returns the docs/11 §9.1 plan or the first stop condition.
func (service *Service) simulateTranslationPlan(
	ctx context.Context, source, target string, chunkUnits []int64,
) (preflightPlan, *decisionError, error) {
	monthStart, settings, ledger, err := service.currentUsage(ctx)
	if err != nil {
		return preflightPlan{}, nil, err
	}
	limits := settings.limits()
	generalRemaining := limits.GeneralLimit - ledger.General.Used - ledger.General.Reserved
	professionalRemaining := limits.ProfessionalLimit - ledger.Professional.Used - ledger.Professional.Reserved
	items := make([]preflightPlanItem, 0, len(chunkUnits))
	accumulator := map[string]planAccumulator{}
	for index, units := range chunkUnits {
		choice, decisionErr := decideEngine(
			settings.AutoUseProfessional, settings.ProfessionalScene,
			generalRemaining, professionalRemaining, units,
		)
		if decisionErr != nil {
			return preflightPlan{}, decisionErr, nil
		}
		if choice.Engine == "professional" {
			if code := professionalLanguageBlocker(choice.Scene, source, target); code != "" {
				return preflightPlan{}, languageStopError(code), nil
			}
			professionalRemaining -= units
		} else {
			generalRemaining -= units
		}
		entry := accumulator[choice.Meter]
		entry.chunks++
		entry.units += units
		accumulator[choice.Meter] = entry
		items = append(items, preflightPlanItem{
			Index: index, Units: units, Engine: choice.Engine, Meter: choice.Meter, Scene: choice.Scene,
		})
	}
	return service.buildPreflightPlan("translation", monthStart, settings, items, accumulator, ledger), nil, nil
}

func (service *Service) buildPreflightPlan(
	operation string, monthStart time.Time, settings settingsSnapshot,
	items []preflightPlanItem, accumulator map[string]planAccumulator, ledger monthLedger,
) preflightPlan {
	limits := settings.limits()
	order := []string{meterGeneral, meterProfessional, meterOCR}
	totals := make([]preflightTotal, 0, len(accumulator))
	for _, meter := range order {
		entry, ok := accumulator[meter]
		if !ok {
			continue
		}
		usage := ledger.usageFor(meter)
		limit := int64(0)
		switch meter {
		case meterGeneral:
			limit = limits.GeneralLimit
		case meterProfessional:
			limit = limits.ProfessionalLimit
		default:
			limit = limits.OCRLimit
		}
		remainingBefore := clampZero(limit - usage.Used - usage.Reserved)
		totals = append(totals, preflightTotal{
			Meter: meter, Chunks: entry.chunks, Units: entry.units, Limit: limit,
			Used: usage.Used, Reserved: usage.Reserved,
			RemainingBefore:    remainingBefore,
			RemainingAfterPlan: clampZero(remainingBefore - entry.units),
		})
	}
	var scene any
	if operation == "translation" && settings.ProfessionalScene != nil {
		scene = *settings.ProfessionalScene
	}
	return preflightPlan{
		Operation: operation, Month: monthStart.Format("2006-01"),
		ResetAt: nextMonthStart(monthStart).In(shanghaiZone),
		Source:  "dev_toolbox_local_ledger", ProfessionalScene: scene,
		Items: items, Totals: totals,
	}
}

type ticketCreateRequest struct {
	Operation string `json:"operation"`
}

func (service *Service) handleCreateTicket(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	var payload ticketCreateRequest
	if httpapi.DecodeJSON(response, request, 4*1024, &payload) != nil ||
		(payload.Operation != OperationTranslation && payload.Operation != OperationOCR) {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	ownerID, ok := ticketOwnerFromRequest(request)
	if !ok {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	view, code := service.queue.Create(ownerID, payload.Operation)
	if code != "" {
		writeAliyunError(response, request, code, nil)
		return
	}
	httpapi.WriteJSON(response, statusCreated, ticketCreateBody(view))
}

type ticketCreateWaitingBody struct {
	TicketID  uuid.UUID `json:"ticketId"`
	Operation string    `json:"operation"`
	Status    string    `json:"status"`
	Position  int       `json:"position"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type ticketCreateReadyBody struct {
	TicketID  uuid.UUID `json:"ticketId"`
	Operation string    `json:"operation"`
	Status    string    `json:"status"`
	ClaimBy   time.Time `json:"claimBy"`
}

func ticketCreateBody(view ticketView) any {
	if view.Status == ticketWaiting {
		return ticketCreateWaitingBody{
			TicketID: view.TicketID, Operation: view.Operation, Status: view.Status,
			Position: *view.Position, ExpiresAt: *view.ExpiresAt,
		}
	}
	return ticketCreateReadyBody{
		TicketID: view.TicketID, Operation: view.Operation, Status: view.Status,
		ClaimBy: *view.ClaimBy,
	}
}

type ticketWaitingBody struct {
	TicketID  uuid.UUID `json:"ticketId"`
	Operation string    `json:"operation"`
	Status    string    `json:"status"`
	Position  int       `json:"position"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type ticketReadyBody struct {
	TicketID  uuid.UUID `json:"ticketId"`
	Operation string    `json:"operation"`
	Status    string    `json:"status"`
	ClaimBy   time.Time `json:"claimBy"`
}

type ticketActiveBody struct {
	TicketID          uuid.UUID `json:"ticketId"`
	Operation         string    `json:"operation"`
	Status            string    `json:"status"`
	IdleExpiresAt     time.Time `json:"idleExpiresAt"`
	AbsoluteExpiresAt time.Time `json:"absoluteExpiresAt"`
	CancelRequested   bool      `json:"cancelRequested"`
}

type ticketTerminalBody struct {
	TicketID  uuid.UUID `json:"ticketId"`
	Operation string    `json:"operation"`
	Status    string    `json:"status"`
}

func ticketGetBody(view ticketView) any {
	switch view.Status {
	case ticketWaiting:
		return ticketWaitingBody{
			TicketID: view.TicketID, Operation: view.Operation, Status: view.Status,
			Position: *view.Position, ExpiresAt: *view.ExpiresAt,
		}
	case ticketReady:
		return ticketReadyBody{
			TicketID: view.TicketID, Operation: view.Operation, Status: view.Status,
			ClaimBy: *view.ClaimBy,
		}
	case ticketActive:
		return ticketActiveBody{
			TicketID: view.TicketID, Operation: view.Operation, Status: view.Status,
			IdleExpiresAt: *view.IdleExpiresAt, AbsoluteExpiresAt: *view.AbsoluteExpiresAt,
			CancelRequested: *view.CancelRequested,
		}
	default:
		return ticketTerminalBody{TicketID: view.TicketID, Operation: view.Operation, Status: view.Status}
	}
}

func (service *Service) handleGetTicket(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	ticketID, err := uuid.Parse(request.PathValue("ticketId"))
	if err != nil {
		writeCodeError(response, request, errTicketNotFound)
		return
	}
	ownerID, ok := ticketOwnerFromRequest(request)
	if !ok {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	view, code := service.queue.Get(ownerID, ticketID)
	if code != "" {
		writeAliyunError(response, request, code, nil)
		return
	}
	httpapi.WriteJSON(response, statusOK, ticketGetBody(view))
}

func (service *Service) handleDeleteTicket(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	ticketID, err := uuid.Parse(request.PathValue("ticketId"))
	if err != nil {
		writeCodeError(response, request, errTicketNotFound)
		return
	}
	ownerID, ok := ticketOwnerFromRequest(request)
	if !ok {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	if code := service.queue.Delete(ownerID, ticketID); code != "" {
		writeAliyunError(response, request, code, nil)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

type ticketClaimBody struct {
	TicketID          uuid.UUID `json:"ticketId"`
	Status            string    `json:"status"`
	PermitToken       string    `json:"permitToken"`
	IdleExpiresAt     time.Time `json:"idleExpiresAt"`
	AbsoluteExpiresAt time.Time `json:"absoluteExpiresAt"`
}

func (service *Service) handleClaimTicket(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	ticketID, err := uuid.Parse(request.PathValue("ticketId"))
	if err != nil {
		writeCodeError(response, request, errTicketNotFound)
		return
	}
	ownerID, ok := ticketOwnerFromRequest(request)
	if !ok {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	result, code := service.queue.Claim(ownerID, ticketID)
	if code != "" {
		writeAliyunError(response, request, code, nil)
		return
	}
	httpapi.WriteJSON(response, statusOK, ticketClaimBody{
		TicketID: result.View.TicketID, Status: ticketActive, PermitToken: result.Permit.token,
		IdleExpiresAt: *result.View.IdleExpiresAt, AbsoluteExpiresAt: *result.View.AbsoluteExpiresAt,
	})
}

type chunkRequest struct {
	SourceText     string `json:"sourceText"`
	SourceLanguage string `json:"sourceLanguage"`
	TargetLanguage string `json:"targetLanguage"`
	ExpectedEngine string `json:"expectedEngine"`
}

type chunkQuota struct {
	Meter     string `json:"meter"`
	Remaining int64  `json:"remaining"`
}

type chunkSuccess struct {
	TranslatedText    string     `json:"translatedText"`
	DetectedLanguage  string     `json:"detectedLanguage"`
	Engine            string     `json:"engine"`
	Scene             string     `json:"scene"`
	BillableUnits     int64      `json:"billableUnits"`
	UpstreamRequestID string     `json:"upstreamRequestId"`
	Quota             chunkQuota `json:"quota"`
	Replayed          bool       `json:"replayed"`
}

// handleTranslateChunk implements docs/11 §10.2: permit checks, idempotency
// priority, in-flight exclusivity, engine re-decision, reservation, one SDK
// call and settlement.
func (service *Service) handleTranslateChunk(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	requestKey, err := uuid.Parse(request.Header.Get("Idempotency-Key"))
	if err != nil {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	permitToken := request.Header.Get("X-Cloud-Permit")
	var payload chunkRequest
	if httpapi.DecodeJSON(response, request, maximumChunkBytes, &payload) != nil {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	units := int64(utf16Length(payload.SourceText))
	if !validChunkRequest(payload, units) {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	ownerID, ok := ticketOwnerFromRequest(request)
	if !ok {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	permit, code := service.queue.ValidatePermit(permitToken, ownerID, OperationTranslation)
	if code != "" {
		writeAliyunError(response, request, code, nil)
		return
	}
	// The §6 idempotency answer wins over CLOUD_PERMIT_BUSY (docs/11 §9.5).
	expectedOperation, expectedMeter := operationTranslateGeneral, meterGeneral
	if payload.ExpectedEngine == "professional" {
		expectedOperation, expectedMeter = operationTranslateProfessional, meterProfessional
	}
	replay, decisionErr, err := service.replayExistingKey(
		request.Context(), requestKey, expectedOperation, expectedMeter, units,
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
		// Local decryption failure happens before any ledger change.
		writeInternalError(response, request)
		return
	}
	if !service.queue.ProjectedRun(permit, units) {
		writeCodeError(response, request, codeInvalidInput)
		return
	}

	reserved, decisionErr, err := service.reserveTranslation(request.Context(), reserveInput{
		OwnerID: ownerID, RequestKey: requestKey, Units: units,
		SourceLanguage: payload.SourceLanguage, TargetLanguage: payload.TargetLanguage,
		ExpectedEngine: payload.ExpectedEngine,
	})
	if err != nil {
		writeInternalError(response, request)
		return
	}
	if decisionErr != nil {
		writeDecisionError(response, request, decisionErr)
		return
	}
	service.queue.RecordRun(permit, units)

	callCtx, cancel := mergeCancelContexts(request.Context(), permit.context)
	defer cancel()
	started := service.now()
	result, gatewayErr := service.gateway.Translate(callCtx, CloudCredentials{
		AccessKeyID: accessKeyID, AccessKeySecret: accessKeySecret, Version: snapshot.CredentialVersion,
	}, TranslationInput{
		Engine: reserved.Engine.Engine, Scene: reserved.Engine.Scene,
		SourceLanguage: payload.SourceLanguage, SourceText: payload.SourceText,
		TargetLanguage: payload.TargetLanguage,
	})
	duration := service.now().Sub(started)

	settleCtx, settleCancel := settlementContext(request.Context())
	defer settleCancel()
	settlement, err := service.settleOutcome(settleCtx, requestKey, result, gatewayErr)
	if err != nil {
		writeInternalError(response, request)
		return
	}
	service.logSettlement(context.WithoutCancel(request.Context()), requestKey, reserved, settlement, gatewayErr, duration)

	remaining := reserved.Remaining
	if settlement.Status == callReleased {
		remaining += units
	}
	if gatewayErr != nil {
		writeUpstreamError(response, request, gatewayErr, settlement, reserved.Engine.Meter, remaining)
		return
	}
	httpapi.WriteJSON(response, statusOK, chunkSuccess{
		TranslatedText:    result.TranslatedText,
		DetectedLanguage:  result.DetectedLanguage,
		Engine:            reserved.Engine.Engine,
		Scene:             reserved.Engine.Scene,
		BillableUnits:     units,
		UpstreamRequestID: result.UpstreamRequestID,
		Quota:             chunkQuota{Meter: reserved.Engine.Meter, Remaining: remaining},
		Replayed:          false,
	})
}

func validChunkRequest(payload chunkRequest, units int64) bool {
	if payload.SourceText == "" || units < 1 || units > maximumSourceUnits {
		return false
	}
	if payload.SourceLanguage != "auto" && !IsValidGeneralLanguage(payload.SourceLanguage) {
		return false
	}
	if !IsValidGeneralLanguage(payload.TargetLanguage) || payload.TargetLanguage == "auto" {
		return false
	}
	if payload.SourceLanguage != "auto" && payload.SourceLanguage == payload.TargetLanguage {
		return false
	}
	return payload.ExpectedEngine == "general" || payload.ExpectedEngine == "professional"
}

// replayExistingKey answers a request key that already has a call row without
// occupying the permit's in-flight slot.
func (service *Service) replayExistingKey(
	ctx context.Context, requestKey uuid.UUID, operation, meter string, units int64,
) (bool, *decisionError, error) {
	call, found, err := service.readCall(ctx, requestKey)
	if err != nil || !found {
		return false, nil, err
	}
	if call.Operation != operation || call.Meter != meter || call.ReservedUnits != units {
		return true, idempotencyReused(call), nil
	}
	return true, existingKeyResponse(call), nil
}

func (service *Service) readCall(ctx context.Context, requestKey uuid.UUID) (existingCall, bool, error) {
	call, err := scanCall(service.database.QueryRow(ctx, `
		SELECT `+callColumns+`FROM aliyun_usage_calls WHERE request_key = $1
	`, requestKey), requestKey)
	if err == pgx.ErrNoRows {
		return existingCall{}, false, nil
	}
	if err != nil {
		return existingCall{}, false, err
	}
	return call, true, nil
}

func (service *Service) decryptCredentials(snapshot settingsSnapshot) (string, string, error) {
	accessKeyID, err := secretbox.Open(service.masterKey, snapshot.AccessKeyIDCipher)
	if err != nil {
		return "", "", err
	}
	accessKeySecret, err := secretbox.Open(service.masterKey, snapshot.AccessKeySecretCiper)
	if err != nil {
		return "", "", err
	}
	return accessKeyID, accessKeySecret, nil
}

// settleOutcome maps the gateway result to the §5.3 settlement statuses.
func (service *Service) settleOutcome(
	ctx context.Context, requestKey uuid.UUID, result TranslationResult, gatewayErr *GatewayError,
) (settleResult, error) {
	input := settleInput{RequestKey: requestKey, At: service.now().UTC()}
	switch {
	case gatewayErr == nil:
		input.Status = callSucceeded
		input.UpstreamRequestID = result.UpstreamRequestID
	case gatewayErr.NotIssued:
		input.Status = callReleased
	case gatewayErr.Uncertain:
		input.Status = callUncertain
		input.FailureCategory = gatewayErr.Category
	default:
		input.Status = callFailedCounted
		input.FailureCategory = gatewayErr.Category
		input.UpstreamRequestID = gatewayErr.RequestID
	}
	return service.settleCall(ctx, input)
}

// writeUpstreamError renders UPSTREAM_* with the fixed §13.1 details fields.
func writeUpstreamError(
	response http.ResponseWriter, request *http.Request, gatewayErr *GatewayError,
	settlement settleResult, meter string, remaining int64,
) {
	_, code := upstreamStatusOf(gatewayErr)
	category := any(gatewayErr.Category)
	if gatewayErr.Category == "" {
		category = nil
	}
	requestID := any(gatewayErr.RequestID)
	if gatewayErr.RequestID == "" {
		requestID = nil
	}
	var countedUnits any
	if settlement.Status == callSucceeded || settlement.Status == callFailedCounted || settlement.Status == callUncertain {
		countedUnits = settlement.CountedUnits
	}
	writeAliyunError(response, request, code, map[string]any{
		"failureCategory":   category,
		"upstreamRequestId": requestID,
		"callStatus":        settlement.Status,
		"meter":             meter,
		"countedUnits":      countedUnits,
		"remaining":         clampZero(remaining),
	})
}

func upstreamStatusOf(gatewayErr *GatewayError) (int, string) {
	if gatewayErr.NotIssued {
		return statusServiceUnavailable, "UPSTREAM_UNAVAILABLE"
	}
	switch gatewayErr.Category {
	case failureThrottled:
		return statusTooManyRequests, "UPSTREAM_THROTTLED"
	case failureUnavailable:
		return statusServiceUnavailable, "UPSTREAM_UNAVAILABLE"
	case failureTimeout, failureUnknown:
		if gatewayErr.Uncertain {
			return statusGatewayTimeout, "UPSTREAM_RESULT_UNCERTAIN"
		}
		return statusBadGateway, "UPSTREAM_REJECTED"
	default:
		return statusBadGateway, "UPSTREAM_REJECTED"
	}
}

// logSettlement records only the docs/10 §11 fields; never text or secrets.
func (service *Service) logSettlement(
	ctx context.Context, requestKey uuid.UUID, reserved reservation,
	settlement settleResult, gatewayErr *GatewayError, duration time.Duration,
) {
	record := slog.Default()
	category := ""
	if gatewayErr != nil {
		category = gatewayErr.Category
	}
	record.InfoContext(ctx, "aliyun_call_settled",
		"operation", reserved.Call.Operation,
		"engine", reserved.Engine.Engine,
		"meter", reserved.Call.Meter,
		"units", reserved.Call.ReservedUnits,
		"status", settlement.Status,
		"failureCategory", category,
		"durationMs", duration.Milliseconds(),
	)
}

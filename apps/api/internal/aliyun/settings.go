package aliyun

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

const (
	generalLimitFloor, generalLimitCeiling           = int64(1), int64(1000000)
	professionalLimitFloor, professionalLimitCeiling = int64(1), int64(1000000)
	ocrLimitFloor, ocrLimitCeiling                   = int64(1), int64(200)
)

type settingsResponse struct {
	Credentials credentialsView `json:"credentials"`
	Translation translationView `json:"translation"`
	OCR         ocrSettingsView `json:"ocr"`
	Concurrency concurrencyView `json:"concurrency"`
	Status      statusView      `json:"status"`
}

type credentialsView struct {
	Configured        bool    `json:"configured"`
	AccessKeyIDMasked *string `json:"accessKeyIdMasked"`
	CredentialVersion int64   `json:"credentialVersion"`
}

type translationView struct {
	GeneralMonthlyLimit      int64   `json:"generalMonthlyLimit"`
	ProfessionalMonthlyLimit int64   `json:"professionalMonthlyLimit"`
	AutoUseProfessional      bool    `json:"autoUseProfessional"`
	ProfessionalScene        *string `json:"professionalScene"`
}

type ocrSettingsView struct {
	MonthlyLimit int64 `json:"monthlyLimit"`
}

type concurrencyView struct {
	Owner  int16 `json:"owner"`
	Global int16 `json:"global"`
}

type statusView struct {
	LastSuccessAt       *time.Time `json:"lastSuccessAt"`
	LastFailureAt       *time.Time `json:"lastFailureAt"`
	LastFailureCategory *string    `json:"lastFailureCategory"`
}

func (service *Service) handleGetSettings(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	snapshot, err := service.readSettings(request.Context())
	if err != nil {
		writeInternalError(response, request)
		return
	}
	httpapi.WriteJSON(response, statusOK, settingsResponse{
		Credentials: credentialsView{
			Configured:        snapshot.HasCredentials,
			AccessKeyIDMasked: maskedKeyTail(snapshot.AccessKeyIDTail),
			CredentialVersion: snapshot.CredentialVersion,
		},
		Translation: translationView{
			GeneralMonthlyLimit:      snapshot.GeneralLimit,
			ProfessionalMonthlyLimit: snapshot.ProfessionalLimit,
			AutoUseProfessional:      snapshot.AutoUseProfessional,
			ProfessionalScene:        snapshot.ProfessionalScene,
		},
		OCR:         ocrSettingsView{MonthlyLimit: snapshot.OCRLimit},
		Concurrency: concurrencyView{Owner: snapshot.OwnerConcurrency, Global: snapshot.GlobalConcurrency},
		Status: statusView{
			LastSuccessAt: snapshot.LastSuccessAt, LastFailureAt: snapshot.LastFailureAt,
			LastFailureCategory: snapshot.LastFailureCategory,
		},
	})
}

func maskedKeyTail(tail *string) *string {
	if tail == nil || *tail == "" {
		return nil
	}
	masked := "****" + *tail
	return &masked
}

func (service *Service) readSettings(ctx context.Context) (settingsSnapshot, error) {
	return scanSettings(service.database.QueryRow(ctx, settingsShareSQL))
}

type settingsUpdateRequest struct {
	Credentials *settingsCredentialsInput `json:"credentials"`
	Translation *translationSettingsInput `json:"translation"`
	OCR         *ocrSettingsInput         `json:"ocr"`
	Concurrency *concurrencyInput         `json:"concurrency"`
}

type settingsCredentialsInput struct {
	AccessKeyID     string `json:"accessKeyId"`
	AccessKeySecret string `json:"accessKeySecret"`
}

type translationSettingsInput struct {
	GeneralMonthlyLimit      *int64  `json:"generalMonthlyLimit"`
	ProfessionalMonthlyLimit *int64  `json:"professionalMonthlyLimit"`
	AutoUseProfessional      *bool   `json:"autoUseProfessional"`
	ProfessionalScene        *string `json:"professionalScene"`
}

type ocrSettingsInput struct {
	MonthlyLimit *int64 `json:"monthlyLimit"`
}

type concurrencyInput struct {
	Owner  *int16 `json:"owner"`
	Global *int16 `json:"global"`
}

// handleUpdateSettings performs the full-replacement update of docs/11 §8.2:
// encrypt first (any failure changes nothing), then one transaction that locks
// settings, recovers stale reservations, locks the current month rows in
// ascending meter order and rejects limits below used+reserved.
func (service *Service) handleUpdateSettings(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	var payload settingsUpdateRequest
	if httpapi.DecodeJSON(response, request, 64*1024, &payload) != nil {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	if payload.Translation == nil || payload.OCR == nil || payload.Concurrency == nil {
		writeCodeError(response, request, codeInvalidInput)
		return
	}
	generalLimit, professionalLimit, ocrLimit, ownerLimit, globalLimit, scene, autoUse, ok :=
		service.validateSettingsPayload(&payload)
	if !ok {
		writeCodeError(response, request, codeInvalidInput)
		return
	}

	var keyIDCipher, keySecretCipher []byte
	var keyTail *string
	if payload.Credentials != nil {
		if payload.Credentials.AccessKeyID == "" || payload.Credentials.AccessKeySecret == "" {
			writeCodeError(response, request, codeInvalidInput)
			return
		}
		var err error
		keyIDCipher, err = secretbox.Seal(service.masterKey, payload.Credentials.AccessKeyID)
		if err != nil {
			writeInternalError(response, request)
			return
		}
		keySecretCipher, err = secretbox.Seal(service.masterKey, payload.Credentials.AccessKeySecret)
		if err != nil {
			writeInternalError(response, request)
			return
		}
		tail := keyTailOf(payload.Credentials.AccessKeyID)
		keyTail = &tail
	}

	ctx := request.Context()
	err := service.withSettingsTransaction(ctx, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := lockSettingsUpdate(ctx, tx); err != nil {
			return err
		}
		if err := service.recoverStaleWithinTx(ctx, tx); err != nil {
			return err
		}
		monthStart := currentMonthStart(service.now())
		months := []string{meterGeneral, meterProfessional, meterOCR}
		usages := map[string]meterUsage{}
		for _, meter := range months {
			usage, err := ensureMonthRow(ctx, tx, monthStart, meter)
			if err != nil {
				return err
			}
			usages[meter] = usage
		}
		if minimum := usages[meterGeneral].Used + usages[meterGeneral].Reserved; minimum > generalLimit {
			return &limitTooLowError{meter: meterGeneral, minimum: minimum}
		}
		if minimum := usages[meterProfessional].Used + usages[meterProfessional].Reserved; minimum > professionalLimit {
			return &limitTooLowError{meter: meterProfessional, minimum: minimum}
		}
		if minimum := usages[meterOCR].Used + usages[meterOCR].Reserved; minimum > ocrLimit {
			return &limitTooLowError{meter: meterOCR, minimum: minimum}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE aliyun_service_settings
			SET general_monthly_limit = $1, professional_monthly_limit = $2, ocr_monthly_limit = $3,
			    owner_concurrency = $4, global_concurrency = $5, professional_scene = $6,
			    auto_use_professional = $7, updated_at = $8
			WHERE id = 1
		`, generalLimit, professionalLimit, ocrLimit, ownerLimit, globalLimit,
			nullableScene(scene), autoUse, service.now().UTC()); err != nil {
			return err
		}
		if payload.Credentials != nil {
			if _, err := tx.Exec(ctx, `
				UPDATE aliyun_service_settings
				SET access_key_id_ciphertext = $1, access_key_secret_ciphertext = $2,
				    access_key_id_tail = $3, credential_version = credential_version + 1
				WHERE id = 1
			`, keyIDCipher, keySecretCipher, keyTail); err != nil {
				return err
			}
		}
		return nil
	})
	if limitErr, ok := err.(*limitTooLowError); ok {
		httpapi.WriteError(
			response, request, statusUnprocessableEntity, codeInvalidInput, limitErr.message(),
		)
		return
	}
	if err != nil {
		writeInternalError(response, request)
		return
	}
	// Same-process queue limits swap atomically before the 200 returns.
	service.queue.UpdateLimits(int(ownerLimit), int(globalLimit))
	service.handleGetSettings(response, request)
}

type limitTooLowError struct {
	meter   string
	minimum int64
}

func (err *limitTooLowError) Error() string {
	return fmt.Sprintf("%s limit below current usage %d", err.meter, err.minimum)
}

func (err *limitTooLowError) message() string {
	switch err.meter {
	case meterProfessional:
		return "专业版月度上限不能低于当前月已用与预留之和"
	case meterOCR:
		return "OCR 月度上限不能低于当前月已用与预留之和"
	default:
		return "通用版月度上限不能低于当前月已用与预留之和"
	}
}

func (service *Service) validateSettingsPayload(payload *settingsUpdateRequest) (
	generalLimit, professionalLimit, ocrLimit int64, ownerLimit, globalLimit int16, scene *string, autoUse bool, ok bool,
) {
	translation := payload.Translation
	if translation.GeneralMonthlyLimit == nil || translation.ProfessionalMonthlyLimit == nil ||
		translation.AutoUseProfessional == nil || payload.OCR.MonthlyLimit == nil ||
		payload.Concurrency.Owner == nil || payload.Concurrency.Global == nil {
		return 0, 0, 0, 0, 0, nil, false, false
	}
	generalLimit = *translation.GeneralMonthlyLimit
	professionalLimit = *translation.ProfessionalMonthlyLimit
	ocrLimit = *payload.OCR.MonthlyLimit
	ownerLimit = *payload.Concurrency.Owner
	globalLimit = *payload.Concurrency.Global
	autoUse = *translation.AutoUseProfessional
	if generalLimit < generalLimitFloor || generalLimit > generalLimitCeiling ||
		professionalLimit < professionalLimitFloor || professionalLimit > professionalLimitCeiling ||
		ocrLimit < ocrLimitFloor || ocrLimit > ocrLimitCeiling ||
		ownerLimit < 1 || ownerLimit > 3 || globalLimit < 1 || globalLimit > 10 || globalLimit < ownerLimit {
		return 0, 0, 0, 0, 0, nil, false, false
	}
	if translation.ProfessionalScene != nil && *translation.ProfessionalScene != "" {
		if !IsProfessionalScene(*translation.ProfessionalScene) {
			return 0, 0, 0, 0, 0, nil, false, false
		}
		scene = translation.ProfessionalScene
	}
	if autoUse && (scene == nil || *scene == "") {
		return 0, 0, 0, 0, 0, nil, false, false
	}
	return generalLimit, professionalLimit, ocrLimit, ownerLimit, globalLimit, scene, autoUse, true
}

func nullableScene(scene *string) any {
	if scene == nil {
		return nil
	}
	return *scene
}

func keyTailOf(accessKeyID string) string {
	trimmed := strings.TrimSpace(accessKeyID)
	if len(trimmed) > 4 {
		return trimmed[len(trimmed)-4:]
	}
	return trimmed
}

// handleDeleteCredentials removes the encrypted credentials, bumps the
// credential version and keeps the ledger untouched (docs/11 §8.3).
func (service *Service) handleDeleteCredentials(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	ctx := request.Context()
	err := service.withSettingsTransaction(ctx, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := lockSettingsUpdate(ctx, tx); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE aliyun_service_settings
			SET access_key_id_ciphertext = NULL, access_key_secret_ciphertext = NULL,
			    access_key_id_tail = NULL, credential_version = credential_version + 1,
			    updated_at = $1
			WHERE id = 1
		`, service.now().UTC())
		return err
	})
	if err != nil {
		writeInternalError(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

type usageMeterView struct {
	Meter     string `json:"meter"`
	Limit     int64  `json:"limit"`
	Used      int64  `json:"used"`
	Reserved  int64  `json:"reserved"`
	Remaining int64  `json:"remaining"`
}

type usageResponse struct {
	Month    string           `json:"month"`
	Timezone string           `json:"timezone"`
	Meters   []usageMeterView `json:"meters"`
	Source   string           `json:"source"`
}

func (service *Service) handleCurrentUsage(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	monthStart, settings, ledger, err := service.currentUsage(request.Context())
	if err != nil {
		writeInternalError(response, request)
		return
	}
	limits := settings.limits()
	meters := []meterUsage{ledger.General, ledger.Professional, ledger.OCR}
	limitsByMeter := map[string]int64{
		meterGeneral: limits.GeneralLimit, meterProfessional: limits.ProfessionalLimit, meterOCR: limits.OCRLimit,
	}
	views := make([]usageMeterView, 0, len(meters))
	for _, usage := range meters {
		limit := limitsByMeter[usage.Meter]
		views = append(views, usageMeterView{
			Meter: usage.Meter, Limit: limit, Used: usage.Used, Reserved: usage.Reserved,
			Remaining: clampZero(limit - usage.Used - usage.Reserved),
		})
	}
	httpapi.WriteJSON(response, statusOK, usageResponse{
		Month:    monthStart.Format("2006-01"),
		Timezone: "Asia/Shanghai",
		Meters:   views,
		Source:   "dev_toolbox_local_ledger",
	})
}

// handleTranslationLanguages serves the same embedded static document used by
// server-side validation (docs/11 §8.5).
func (service *Service) handleTranslationLanguages(response http.ResponseWriter, request *http.Request) {
	prepareResponse(response)
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(statusOK)
	_, _ = response.Write(RawLanguageList())
}

func writeInternalError(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "阿里云服务暂时不可用")
}

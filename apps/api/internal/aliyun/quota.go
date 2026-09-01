package aliyun

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Meters and operations, docs/11 §4.
const (
	meterGeneral      = "mt_general"
	meterProfessional = "mt_professional"
	meterOCR          = "ocr_general"

	operationTranslateGeneral      = "translate_general"
	operationTranslateProfessional = "translate_professional"
	operationOCRGeneral            = "ocr_general"
)

// Call statuses, docs/11 §4.3.
const (
	callReserved      = "reserved"
	callSucceeded     = "succeeded"
	callReleased      = "released"
	callFailedCounted = "failed_counted"
	callUncertain     = "uncertain"
)

// staleReservationAge: every SDK call has a 45s total deadline and never
// retries, so a reservation older than 10 minutes is crash residue.
const staleReservationAge = 10 * time.Minute

type settingsSnapshot struct {
	CredentialVersion    int64
	HasCredentials       bool
	AccessKeyIDCipher    []byte
	AccessKeySecretCiper []byte
	AccessKeyIDTail      *string
	ProfessionalScene    *string
	AutoUseProfessional  bool
	GeneralLimit         int64
	ProfessionalLimit    int64
	OCRLimit             int64
	OwnerConcurrency     int16
	GlobalConcurrency    int16
	LastSuccessAt        *time.Time
	LastFailureAt        *time.Time
	LastFailureCategory  *string
}

type meterUsage struct {
	Meter    string
	Used     int64
	Reserved int64
}

type monthLedger struct {
	General      meterUsage
	Professional meterUsage
	OCR          meterUsage
}

type limitsView struct {
	GeneralLimit      int64
	ProfessionalLimit int64
	OCRLimit          int64
}

func (snapshot settingsSnapshot) limits() limitsView {
	return limitsView{
		GeneralLimit: snapshot.GeneralLimit, ProfessionalLimit: snapshot.ProfessionalLimit,
		OCRLimit: snapshot.OCRLimit,
	}
}

func (ledger monthLedger) usageFor(meter string) meterUsage {
	switch meter {
	case meterProfessional:
		return ledger.Professional
	case meterOCR:
		return ledger.OCR
	default:
		return ledger.General
	}
}

var shanghaiZone = loadShanghaiZone()

func loadShanghaiZone() *time.Location {
	if location, err := time.LoadLocation("Asia/Shanghai"); err == nil {
		return location
	}
	return time.FixedZone("Asia/Shanghai", 8*60*60)
}

// currentMonthStart returns the first day of the current Asia/Shanghai month.
func currentMonthStart(now time.Time) time.Time {
	local := now.In(shanghaiZone)
	return time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, shanghaiZone)
}

// nextMonthStart returns the first day of the following Asia/Shanghai month.
func nextMonthStart(monthStart time.Time) time.Time {
	local := monthStart.In(shanghaiZone)
	return time.Date(local.Year(), local.Month()+1, 1, 0, 0, 0, 0, shanghaiZone)
}

type engineChoice struct {
	Engine string
	Meter  string
	Scene  string
}

// decisionError carries the pre-call stop conditions of docs/11 §5.2/§9.1.
type decisionError struct {
	Status  int
	Code    string
	Details map[string]any
}

func (e *decisionError) Error() string {
	return fmt.Sprintf("engine decision stopped: %s", e.Code)
}

func quotaExhausted(meter string, remaining int64) *decisionError {
	return &decisionError{
		Status:  statusTooManyRequests,
		Code:    "QUOTA_EXHAUSTED",
		Details: map[string]any{"meter": meter, "remaining": clampZero(remaining)},
	}
}

func clampZero(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

// decideEngine implements docs/11 §5.2 on a locked snapshot. A chunk switches
// engines as a whole and is never split across two meters.
func decideEngine(
	autoUseProfessional bool,
	scene *string,
	generalRemaining, professionalRemaining int64,
	units int64,
) (engineChoice, *decisionError) {
	if generalRemaining >= units {
		return engineChoice{Engine: "general", Meter: meterGeneral, Scene: "general"}, nil
	}
	if !autoUseProfessional {
		return engineChoice{}, quotaExhausted(meterGeneral, generalRemaining)
	}
	if scene == nil || *scene == "" {
		return engineChoice{}, &decisionError{Status: statusUnprocessableEntity, Code: "PROFESSIONAL_SCENE_REQUIRED"}
	}
	if professionalRemaining < units {
		return engineChoice{}, quotaExhausted(meterProfessional, professionalRemaining)
	}
	return engineChoice{Engine: "professional", Meter: meterProfessional, Scene: *scene}, nil
}

// professionalLanguageBlocker returns the pre-call language stop code when a
// professional engine is required: the source must be explicit and the
// directed pair must be in the configured scene matrix.
func professionalLanguageBlocker(scene, source, target string) string {
	if source == "auto" {
		return "SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL"
	}
	if !SupportsProfessionalPair(scene, source, target) {
		return "PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED"
	}
	return ""
}

func languageStopError(code string) *decisionError {
	return &decisionError{Status: statusUnprocessableEntity, Code: code}
}

type existingCall struct {
	RequestKey        uuid.UUID
	Status            string
	Operation         string
	Meter             string
	MonthStart        time.Time
	ReservedUnits     int64
	CountedUnits      int64
	UpstreamRequestID *string
	FailureCategory   *string
}

func (call existingCall) settled() bool {
	return call.Status != callReserved
}

type reservation struct {
	Call       existingCall
	Engine     engineChoice
	Remaining  int64
	MonthStart time.Time
}

type reserveInput struct {
	OwnerID        uuid.UUID
	RequestKey     uuid.UUID
	Units          int64
	SourceLanguage string
	TargetLanguage string
	ExpectedEngine string
	// SkipEngineCheck bypasses the expectedEngine comparison for direct ledger
	// reservations used by cross-package integration tests.
	SkipEngineCheck bool
}

const settingsShareSQL = `SELECT access_key_id_ciphertext IS NOT NULL,
	credential_version, access_key_id_ciphertext, access_key_secret_ciphertext, access_key_id_tail,
	professional_scene, auto_use_professional, general_monthly_limit, professional_monthly_limit,
	ocr_monthly_limit, owner_concurrency, global_concurrency, last_success_at, last_failure_at,
	last_failure_category
	FROM aliyun_service_settings WHERE id = 1 `

// lockSettingsShare reads the settings row with FOR SHARE (docs/11 §5).
func lockSettingsShare(ctx context.Context, tx pgx.Tx) (settingsSnapshot, error) {
	return scanSettings(tx.QueryRow(ctx, settingsShareSQL+"FOR SHARE"))
}

// lockSettingsUpdate reads the settings row with FOR UPDATE.
func lockSettingsUpdate(ctx context.Context, tx pgx.Tx) (settingsSnapshot, error) {
	return scanSettings(tx.QueryRow(ctx, settingsShareSQL+"FOR UPDATE"))
}

func scanSettings(row pgx.Row) (settingsSnapshot, error) {
	var snapshot settingsSnapshot
	err := row.Scan(
		&snapshot.HasCredentials, &snapshot.CredentialVersion, &snapshot.AccessKeyIDCipher,
		&snapshot.AccessKeySecretCiper, &snapshot.AccessKeyIDTail, &snapshot.ProfessionalScene,
		&snapshot.AutoUseProfessional, &snapshot.GeneralLimit, &snapshot.ProfessionalLimit,
		&snapshot.OCRLimit, &snapshot.OwnerConcurrency, &snapshot.GlobalConcurrency,
		&snapshot.LastSuccessAt, &snapshot.LastFailureAt, &snapshot.LastFailureCategory,
	)
	return snapshot, err
}

// ensureMonthRow lazily creates one meter row and returns it locked.
func ensureMonthRow(ctx context.Context, tx pgx.Tx, monthStart time.Time, meter string) (meterUsage, error) {
	if _, err := tx.Exec(ctx, `
		INSERT INTO aliyun_usage_months (month_start, meter, used_units, reserved_units, updated_at)
		VALUES ($1, $2, 0, 0, $3)
		ON CONFLICT (month_start, meter) DO NOTHING
	`, monthStart, meter, time.Now().UTC()); err != nil {
		return meterUsage{}, err
	}
	var usage meterUsage
	err := tx.QueryRow(ctx, `
		SELECT meter, used_units, reserved_units FROM aliyun_usage_months
		WHERE month_start = $1 AND meter = $2 FOR UPDATE
	`, monthStart, meter).Scan(&usage.Meter, &usage.Used, &usage.Reserved)
	return usage, err
}

const callColumns = `status, operation, meter, month_start, reserved_units, counted_units,
		       upstream_request_id, failure_category `

func scanCall(row pgx.Row, requestKey uuid.UUID) (existingCall, error) {
	call := existingCall{RequestKey: requestKey}
	err := row.Scan(
		&call.Status, &call.Operation, &call.Meter, &call.MonthStart, &call.ReservedUnits,
		&call.CountedUnits, &call.UpstreamRequestID, &call.FailureCategory,
	)
	return call, err
}

// readExistingCall loads a call row without locking; callers re-check under lock.
func readExistingCall(ctx context.Context, tx pgx.Tx, requestKey uuid.UUID) (existingCall, bool, error) {
	call, err := scanCall(tx.QueryRow(ctx, `
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

// lockCallRow re-reads the call row with FOR UPDATE after month rows are locked.
func lockCallRow(ctx context.Context, tx pgx.Tx, requestKey uuid.UUID) (existingCall, error) {
	return scanCall(tx.QueryRow(ctx, `
		SELECT `+callColumns+`FROM aliyun_usage_calls WHERE request_key = $1 FOR UPDATE
	`, requestKey), requestKey)
}

// reserveTranslation performs the docs/11 §5.1 transaction including the
// repeated engine decision and the idempotency contract of §6. It returns a
// decisionError for every pre-call stop; the ledger is unchanged in that case.
func (service *Service) reserveTranslation(ctx context.Context, input reserveInput) (reservation, *decisionError, error) {
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
	_, found, err := readExistingCall(ctx, transaction, input.RequestKey)
	if err != nil {
		return reservation{}, nil, err
	}

	// Lock both translation meters of the current month in ascending meter order.
	generalUsage, err := ensureMonthRow(ctx, transaction, monthStart, meterGeneral)
	if err != nil {
		return reservation{}, nil, err
	}
	professionalUsage, err := ensureMonthRow(ctx, transaction, monthStart, meterProfessional)
	if err != nil {
		return reservation{}, nil, err
	}
	limits := settings.limits()
	generalRemaining := limits.GeneralLimit - generalUsage.Used - generalUsage.Reserved
	professionalRemaining := limits.ProfessionalLimit - professionalUsage.Used - professionalUsage.Reserved

	choice, decisionErr := decideEngine(
		settings.AutoUseProfessional, settings.ProfessionalScene,
		generalRemaining, professionalRemaining, input.Units,
	)

	if found {
		locked, err := lockCallRow(ctx, transaction, input.RequestKey)
		if err != nil {
			return reservation{}, nil, err
		}
		return reservation{}, replayDecision(locked, choice, decisionErr, input.Units), nil
	}
	if decisionErr != nil {
		return reservation{}, decisionErr, nil
	}
	if choice.Engine == "professional" {
		if code := professionalLanguageBlocker(choice.Scene, input.SourceLanguage, input.TargetLanguage); code != "" {
			return reservation{}, languageStopError(code), nil
		}
	}
	if input.ExpectedEngine != "" && !input.SkipEngineCheck && input.ExpectedEngine != choice.Engine {
		remaining := generalRemaining
		if choice.Meter == meterProfessional {
			remaining = professionalRemaining
		}
		return reservation{}, preflightChangedError(input.ExpectedEngine, choice, input.Units, remaining), nil
	}

	operation := operationTranslateGeneral
	usage := generalUsage
	limit := limits.GeneralLimit
	if choice.Meter == meterProfessional {
		operation = operationTranslateProfessional
		usage = professionalUsage
		limit = limits.ProfessionalLimit
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO aliyun_usage_calls (request_key, owner_id, operation, meter, month_start,
			reserved_units, counted_units, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)
	`, input.RequestKey, input.OwnerID, operation, choice.Meter, monthStart, input.Units, callReserved, now); err != nil {
		return reservation{}, nil, err
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE aliyun_usage_months SET reserved_units = reserved_units + $3, updated_at = $4
		WHERE month_start = $1 AND meter = $2
	`, monthStart, choice.Meter, input.Units, now); err != nil {
		return reservation{}, nil, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return reservation{}, nil, err
	}
	return reservation{
		Call: existingCall{
			RequestKey: input.RequestKey, Status: callReserved, Operation: operation,
			Meter: choice.Meter, MonthStart: monthStart, ReservedUnits: input.Units,
		},
		Engine:     choice,
		Remaining:  limit - usage.Used - usage.Reserved - input.Units,
		MonthStart: monthStart,
	}, nil, nil
}

// replayDecision answers a request key that already exists (docs/11 §6).
func replayDecision(locked existingCall, choice engineChoice, decisionErr *decisionError, units int64) *decisionError {
	if decisionErr == nil {
		if choice.Meter != locked.Meter || units != locked.ReservedUnits {
			return idempotencyReused(locked)
		}
	} else if units != locked.ReservedUnits {
		return idempotencyReused(locked)
	}
	return existingKeyResponse(locked)
}

func idempotencyReused(call existingCall) *decisionError {
	return &decisionError{
		Status: statusConflict,
		Code:   "IDEMPOTENCY_KEY_REUSED",
		Details: map[string]any{
			"originalOperation": call.Operation,
			"originalMeter":     call.Meter,
			"originalUnits":     call.ReservedUnits,
		},
	}
}

func existingKeyResponse(call existingCall) *decisionError {
	if !call.settled() {
		return &decisionError{
			Status:  statusConflict,
			Code:    "CALL_IN_PROGRESS",
			Details: map[string]any{"meter": call.Meter},
		}
	}
	category := any(nil)
	if call.FailureCategory != nil {
		category = *call.FailureCategory
	}
	requestID := any(nil)
	if call.UpstreamRequestID != nil {
		requestID = *call.UpstreamRequestID
	}
	return &decisionError{
		Status: statusConflict,
		Code:   "CALL_SETTLED_WITHOUT_RESULT",
		Details: map[string]any{
			"callStatus":        call.Status,
			"meter":             call.Meter,
			"countedUnits":      call.CountedUnits,
			"failureCategory":   category,
			"upstreamRequestId": requestID,
			"replayed":          true,
		},
	}
}

// preflightChangedError uses the fixed details shape of docs/11 §9.1.
func preflightChangedError(expectedEngine string, choice engineChoice, units int64, remaining int64) *decisionError {
	return &decisionError{
		Status: statusConflict,
		Code:   "PREFLIGHT_CHANGED",
		Details: map[string]any{
			"reason":          "engine_changed",
			"expectedEngine":  expectedEngine,
			"availableEngine": choice.Engine,
			"meter":           choice.Meter,
			"scene":           choice.Scene,
			"units":           units,
			"remaining":       clampZero(remaining),
		},
	}
}

type settleInput struct {
	RequestKey        uuid.UUID
	Status            string
	FailureCategory   string
	UpstreamRequestID string
	At                time.Time
}

type settleResult struct {
	CountedUnits int64
	Meter        string
	Status       string
	AlreadyDone  bool
}

// settleCall applies the docs/11 §5.3 settlement exactly once. Repeated
// settlement is a no-op that returns the stored metadata.
func (service *Service) settleCall(ctx context.Context, input settleInput) (settleResult, error) {
	transaction, err := service.database.Begin(ctx)
	if err != nil {
		return settleResult{}, err
	}
	defer rollbackUnlessCommitted(transaction)

	if _, err := lockSettingsUpdate(ctx, transaction); err != nil {
		return settleResult{}, err
	}
	preview, found, err := readExistingCall(ctx, transaction, input.RequestKey)
	if err != nil {
		return settleResult{}, err
	}
	if !found {
		return settleResult{}, fmt.Errorf("settle: unknown request key")
	}
	if _, err := ensureMonthRow(ctx, transaction, preview.MonthStart, preview.Meter); err != nil {
		return settleResult{}, err
	}
	call, err := lockCallRow(ctx, transaction, input.RequestKey)
	if err != nil {
		return settleResult{}, err
	}
	if call.Status != callReserved {
		_ = transaction.Rollback(ctx)
		return settleResult{CountedUnits: call.CountedUnits, Meter: call.Meter, Status: call.Status, AlreadyDone: true}, nil
	}
	now := input.At.UTC()
	counted := int64(0)
	switch input.Status {
	case callSucceeded, callFailedCounted, callUncertain:
		counted = call.ReservedUnits
		if _, err := transaction.Exec(ctx, `
			UPDATE aliyun_usage_months
			SET used_units = used_units + $3, reserved_units = reserved_units - $4, updated_at = $5
			WHERE month_start = $1 AND meter = $2
		`, call.MonthStart, call.Meter, counted, call.ReservedUnits, now); err != nil {
			return settleResult{}, err
		}
	case callReleased:
		if _, err := transaction.Exec(ctx, `
			UPDATE aliyun_usage_months SET reserved_units = reserved_units - $3, updated_at = $4
			WHERE month_start = $1 AND meter = $2
		`, call.MonthStart, call.Meter, call.ReservedUnits, now); err != nil {
			return settleResult{}, err
		}
	default:
		return settleResult{}, fmt.Errorf("settle: invalid status %q", input.Status)
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE aliyun_usage_calls
		SET status = $2, counted_units = $3, failure_category = $4, upstream_request_id = $5,
		    settled_at = $6
		WHERE request_key = $1
	`, input.RequestKey, input.Status, counted, nullableString(input.FailureCategory), nullableString(input.UpstreamRequestID), now); err != nil {
		return settleResult{}, err
	}
	if input.Status == callSucceeded {
		if err := bumpSuccess(ctx, transaction, now); err != nil {
			return settleResult{}, err
		}
	}
	// failed_counted/uncertain always advance the failure trail; a released
	// call only does when it carries an upstream failure category (docs/11
	// §5.3: 上游明确失败), never for local pre-call stops.
	if input.Status == callFailedCounted || input.Status == callUncertain ||
		(input.Status == callReleased && input.FailureCategory != "") {
		if err := bumpFailure(ctx, transaction, now, input.FailureCategory); err != nil {
			return settleResult{}, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return settleResult{}, err
	}
	return settleResult{CountedUnits: counted, Meter: call.Meter, Status: input.Status}, nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// bumpSuccess only moves last_success_at forward.
func bumpSuccess(ctx context.Context, tx pgx.Tx, at time.Time) error {
	_, err := tx.Exec(ctx, `
		UPDATE aliyun_service_settings
		SET last_success_at = $1, updated_at = $1
		WHERE id = 1 AND (last_success_at IS NULL OR last_success_at <= $1)
	`, at)
	return err
}

// bumpFailure only moves the failure trail forward; an older completion never
// overwrites a newer failure or its category.
func bumpFailure(ctx context.Context, tx pgx.Tx, at time.Time, category string) error {
	if category == "" {
		category = failureUnknown
	}
	_, err := tx.Exec(ctx, `
		UPDATE aliyun_service_settings
		SET last_failure_at = $1, last_failure_category = $2, updated_at = $1
		WHERE id = 1 AND (last_failure_at IS NULL OR last_failure_at <= $1)
	`, at, category)
	return err
}

type monthMeter struct {
	month time.Time
	meter string
}

// recoverStaleReservations converts crash-left reservations older than 10
// minutes into uncertain, counted in their original month (docs/11 §5.4).
func (service *Service) recoverStaleReservations(ctx context.Context) error {
	cutoff := service.now().UTC().Add(-staleReservationAge)
	var stale int
	if err := service.database.QueryRow(ctx, `
		SELECT count(*) FROM aliyun_usage_calls
		WHERE status = $1 AND created_at < $2
	`, callReserved, cutoff).Scan(&stale); err != nil {
		return err
	}
	if stale == 0 {
		return nil
	}
	return service.withSettingsTransaction(ctx, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := lockSettingsUpdate(ctx, tx); err != nil {
			return err
		}
		return service.recoverStaleWithinTx(ctx, tx)
	})
}

// recoverStaleWithinTx performs the §5.4 recovery inside a transaction that
// already holds the settings row lock. Candidate rows are only IDs; every
// decision is re-checked under the common lock order.
func (service *Service) recoverStaleWithinTx(ctx context.Context, tx pgx.Tx) error {
	cutoff := service.now().UTC().Add(-staleReservationAge)
	rows, err := tx.Query(ctx, `
		SELECT request_key FROM aliyun_usage_calls
		WHERE status = $1 AND created_at < $2
		ORDER BY request_key ASC
	`, callReserved, cutoff)
	if err != nil {
		return err
	}
	var candidates []uuid.UUID
	for rows.Next() {
		var key uuid.UUID
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, key)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(candidates) == 0 {
		return nil
	}

	// Lock every affected (month, meter) in ascending order before
	// re-checking each call under its row lock (docs/11 §5).
	previews := make([]existingCall, 0, len(candidates))
	affected := make([]monthMeter, 0, len(candidates))
	seen := map[monthMeter]struct{}{}
	for _, key := range candidates {
		call, found, err := readExistingCall(ctx, tx, key)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		previews = append(previews, call)
		pair := monthMeter{month: call.MonthStart, meter: call.Meter}
		if _, ok := seen[pair]; !ok {
			seen[pair] = struct{}{}
			affected = append(affected, pair)
		}
	}
	if len(previews) == 0 {
		return nil
	}
	sort.Slice(affected, func(i, j int) bool {
		if affected[i].month.Equal(affected[j].month) {
			return affected[i].meter < affected[j].meter
		}
		return affected[i].month.Before(affected[j].month)
	})
	for _, pair := range affected {
		if _, err := ensureMonthRow(ctx, tx, pair.month, pair.meter); err != nil {
			return err
		}
	}

	now := service.now().UTC()
	for _, preview := range previews {
		call, err := lockCallRow(ctx, tx, preview.RequestKey)
		if err != nil {
			return err
		}
		if call.Status != callReserved {
			continue
		}
		var createdAt time.Time
		if err := tx.QueryRow(ctx, `
			SELECT created_at FROM aliyun_usage_calls WHERE request_key = $1
		`, call.RequestKey).Scan(&createdAt); err != nil {
			return err
		}
		if !createdAt.Before(cutoff) {
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE aliyun_usage_months
			SET used_units = used_units + $3, reserved_units = reserved_units - $4, updated_at = $5
			WHERE month_start = $1 AND meter = $2
		`, call.MonthStart, call.Meter, call.ReservedUnits, call.ReservedUnits, now); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE aliyun_usage_calls
			SET status = $2, counted_units = $3, failure_category = $4, settled_at = $5
			WHERE request_key = $1
		`, call.RequestKey, callUncertain, call.ReservedUnits, failureUnknown, now); err != nil {
			return err
		}
		if err := bumpFailure(ctx, tx, now, failureUnknown); err != nil {
			return err
		}
	}
	return nil
}

func rollbackUnlessCommitted(transaction pgx.Tx) {
	_ = transaction.Rollback(context.Background())
}

// currentUsage reads the current Shanghai month ledger after stale recovery.
func (service *Service) currentUsage(ctx context.Context) (time.Time, settingsSnapshot, monthLedger, error) {
	if err := service.recoverStaleReservations(ctx); err != nil {
		return time.Time{}, settingsSnapshot{}, monthLedger{}, err
	}
	monthStart := currentMonthStart(service.now())
	transaction, err := service.database.Begin(ctx)
	if err != nil {
		return time.Time{}, settingsSnapshot{}, monthLedger{}, err
	}
	defer rollbackUnlessCommitted(transaction)
	settings, err := lockSettingsShare(ctx, transaction)
	if err != nil {
		return time.Time{}, settingsSnapshot{}, monthLedger{}, err
	}
	ledger := monthLedger{
		General:      meterUsage{Meter: meterGeneral},
		Professional: meterUsage{Meter: meterProfessional},
		OCR:          meterUsage{Meter: meterOCR},
	}
	rows, err := transaction.Query(ctx, `
		SELECT meter, used_units, reserved_units FROM aliyun_usage_months
		WHERE month_start = $1 ORDER BY meter ASC
	`, monthStart)
	if err != nil {
		return time.Time{}, settingsSnapshot{}, monthLedger{}, err
	}
	for rows.Next() {
		var meter string
		var used, reserved int64
		if err := rows.Scan(&meter, &used, &reserved); err != nil {
			rows.Close()
			return time.Time{}, settingsSnapshot{}, monthLedger{}, err
		}
		switch meter {
		case meterGeneral:
			ledger.General = meterUsage{Meter: meter, Used: used, Reserved: reserved}
		case meterProfessional:
			ledger.Professional = meterUsage{Meter: meter, Used: used, Reserved: reserved}
		case meterOCR:
			ledger.OCR = meterUsage{Meter: meter, Used: used, Reserved: reserved}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return time.Time{}, settingsSnapshot{}, monthLedger{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return time.Time{}, settingsSnapshot{}, monthLedger{}, err
	}
	return monthStart, settings, ledger, nil
}

// ReserveCallQuota exposes the §5.1 reservation transaction as the narrow
// ledger seam for cross-package integration tests; production reservations
// go through reserveTranslation on the same lock order.
func (service *Service) ReserveCallQuota(
	ctx context.Context, ownerID, requestKey uuid.UUID, meter string, units int64,
) (reservation, *decisionError, error) {
	if meter != meterGeneral && meter != meterProfessional && meter != meterOCR {
		return reservation{}, nil, fmt.Errorf("invalid meter %q", meter)
	}
	if err := service.recoverStaleReservations(ctx); err != nil {
		return reservation{}, nil, err
	}
	transaction, err := service.database.Begin(ctx)
	if err != nil {
		return reservation{}, nil, err
	}
	defer rollbackUnlessCommitted(transaction)
	settings, err := lockSettingsShare(ctx, transaction)
	if err != nil {
		return reservation{}, nil, err
	}
	if _, found, err := readExistingCall(ctx, transaction, requestKey); err != nil {
		return reservation{}, nil, err
	} else if found {
		return reservation{}, nil, fmt.Errorf("request key already exists")
	}
	monthStart := currentMonthStart(service.now())
	usage, err := ensureMonthRow(ctx, transaction, monthStart, meter)
	if err != nil {
		return reservation{}, nil, err
	}
	limits := settings.limits()
	limit := int64(0)
	operation := operationOCRGeneral
	switch meter {
	case meterGeneral:
		limit, operation = limits.GeneralLimit, operationTranslateGeneral
	case meterProfessional:
		limit, operation = limits.ProfessionalLimit, operationTranslateProfessional
	case meterOCR:
		limit, operation = limits.OCRLimit, operationOCRGeneral
	}
	if usage.Used+usage.Reserved+units > limit {
		return reservation{}, quotaExhausted(meter, limit-usage.Used-usage.Reserved), nil
	}
	now := service.now().UTC()
	if _, err := transaction.Exec(ctx, `
		INSERT INTO aliyun_usage_calls (request_key, owner_id, operation, meter, month_start,
			reserved_units, counted_units, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)
	`, requestKey, ownerID, operation, meter, monthStart, units, callReserved, now); err != nil {
		return reservation{}, nil, err
	}
	if _, err := transaction.Exec(ctx, `
		UPDATE aliyun_usage_months SET reserved_units = reserved_units + $3, updated_at = $4
		WHERE month_start = $1 AND meter = $2
	`, monthStart, meter, units, now); err != nil {
		return reservation{}, nil, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return reservation{}, nil, err
	}
	engine, scene := "general", "general"
	if meter == meterProfessional {
		engine = "professional"
	} else if meter == meterOCR {
		engine, scene = "ocr", ""
	}
	return reservation{
		Call: existingCall{
			RequestKey: requestKey, Status: callReserved, Operation: operation,
			Meter: meter, MonthStart: monthStart, ReservedUnits: units,
		},
		Engine:     engineChoice{Engine: engine, Meter: meter, Scene: scene},
		Remaining:  limit - usage.Used - usage.Reserved - units,
		MonthStart: monthStart,
	}, nil, nil
}

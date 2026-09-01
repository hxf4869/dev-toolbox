package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/ai"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

// eligibleFragmentsSource is the ONE canonical construction of eligible
// knowledge fragments (docs/16 §9.1). Every consumer (reconciler, index
// status, run-creation completeness check, retrieval) must wrap this CTE.
// Parameters: $1 = sensitive policy, $2 = embedding generation. It yields one
// row per fact-layer eligible fragment with `embedding_ready` telling whether
// the current-generation embedding row matches the fact layer.
func eligibleFragmentsSource(policy string, generation int64) string {
	return `WITH eligible AS (
		SELECT f.id, f.item_id, f.raw_record_id, f.artifact_id, f.source_kind, f.ordinal,
		       f.start_byte, f.end_byte, f.content, f.normalized_content, f.search_vector,
		       f.weight, f.created_at,
		       i.title, i.sensitivity,
		       (e.fragment_id IS NOT NULL AND e.source_created_at = f.created_at
		        AND e.generation = $2 AND e.policy_snapshot = $1
		        AND e.sensitivity_snapshot = i.sensitivity AND e.state = 'ready') AS embedding_ready
		FROM search_fragments f
		JOIN knowledge_items i ON i.id = f.item_id
		LEFT JOIN ai_artifacts artifact ON artifact.id = f.artifact_id
		LEFT JOIN assistant_fragment_embeddings e ON e.fragment_id = f.id
		WHERE i.deleted_at IS NULL
		  AND f.active
		  AND f.source_kind IN ('title', 'metadata', 'raw_text', 'code', 'ai_text', 'image_text')
		  AND (f.artifact_id IS NULL OR (artifact.invalidated_at IS NULL AND EXISTS (
		       SELECT 1 FROM item_active_artifacts active
		       WHERE active.item_id = f.item_id AND active.artifact_id = f.artifact_id)))
		  AND ($1 = 'block' AND i.sensitivity = 'normal' OR $1 <> 'block')
	)`
}

type indexStatusCounts struct {
	Active   int64 `json:"active"`
	Ready    int64 `json:"ready"`
	Pending  int64 `json:"pending"`
	Running  int64 `json:"running"`
	Failed   int64 `json:"failed"`
	Excluded int64 `json:"excluded"`
}

type knowledgeIndexStatusDTO struct {
	Status         string            `json:"status"`
	Available      bool              `json:"available"`
	Generation     *int64            `json:"generation"`
	SensitivePolicy string           `json:"sensitivePolicy"`
	Counts         indexStatusCounts `json:"counts"`
	LastErrorCode  *string           `json:"lastErrorCode"`
	UpdatedAt      *time.Time        `json:"updatedAt"`
}

type indexComputation struct {
	config embeddingConfigRow
	policy string
	counts indexStatusCounts
	status string
}

// computeIndexStatus performs the read-only completeness judgment shared by
// the status API and run creation; it never writes.
func (service *Service) computeIndexStatus(ctx context.Context, querier rowQuerier) (indexComputation, error) {
	config, err := service.loadEmbeddingConfig(ctx, querier)
	if err != nil {
		return indexComputation{}, err
	}
	policy, err := service.loadSensitivePolicy(ctx, querier)
	if err != nil {
		return indexComputation{}, err
	}
	computation := indexComputation{config: config, policy: policy}
	switch {
	case !config.Configured:
		computation.status = "unconfigured"
	case !config.Enabled:
		computation.status = "disabled"
	}
	if !config.Configured || !config.Enabled {
		var excluded int64
		if err := querier.QueryRow(ctx,
			`SELECT count(*) FROM assistant_fragment_embeddings WHERE state = 'excluded'`).Scan(&excluded); err != nil {
			return indexComputation{}, err
		}
		computation.counts.Excluded = excluded
		return computation, nil
	}
	query := eligibleFragmentsSource(policy, config.Generation) + `
		SELECT count(*) AS active,
		       count(*) FILTER (WHERE eligible.embedding_ready) AS ready,
		       count(*) FILTER (WHERE NOT eligible.embedding_ready AND e_row.state = 'pending') AS pending,
		       count(*) FILTER (WHERE NOT eligible.embedding_ready AND e_row.state = 'running') AS running,
		       count(*) FILTER (WHERE e_row.state = 'failed' AND e_row.generation = $2) AS failed
		FROM eligible
		LEFT JOIN assistant_fragment_embeddings e_row ON e_row.fragment_id = eligible.id`
	if err := querier.QueryRow(ctx, query, policy, config.Generation).Scan(
		&computation.counts.Active, &computation.counts.Ready,
		&computation.counts.Pending, &computation.counts.Running, &computation.counts.Failed,
	); err != nil {
		return indexComputation{}, err
	}
	if err := querier.QueryRow(ctx,
		`SELECT count(*) FROM assistant_fragment_embeddings WHERE state = 'excluded'`).Scan(&computation.counts.Excluded); err != nil {
		return indexComputation{}, err
	}
	switch {
	case computation.counts.Failed > 0:
		computation.status = "failed"
	case computation.counts.Active == computation.counts.Ready:
		computation.status = "ready"
	default:
		computation.status = "indexing"
	}
	return computation, nil
}

func (service *Service) countEligibleFragments(ctx context.Context, querier rowQuerier, generation int64) (int, error) {
	policy, err := service.loadSensitivePolicy(ctx, querier)
	if err != nil {
		return 0, err
	}
	var count int
	err = querier.QueryRow(ctx, eligibleFragmentsSource(policy, generation)+
		` SELECT count(*) FROM eligible`, policy, generation).Scan(&count)
	return count, err
}

// getIndexStatus is the public read-only endpoint; it must not write.
func (service *Service) getIndexStatus(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	computation, err := service.computeIndexStatus(request.Context(), service.database)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	writeIndexStatus(response, request, computation)
}

func writeIndexStatus(response http.ResponseWriter, request *http.Request, computation indexComputation) {
	dto := knowledgeIndexStatusDTO{
		Status: computation.status, Available: computation.status == "ready",
		SensitivePolicy: computation.policy, Counts: computation.counts,
		LastErrorCode: computation.config.LastErrorCode, UpdatedAt: computation.config.UpdatedAt,
	}
	if computation.config.Configured {
		generation := computation.config.Generation
		dto.Generation = &generation
	}
	httpapi.WriteJSON(response, http.StatusOK, dto)
}

// reconcileIndex is the single writer for index queue rows and the global
// status. It runs on the reconciler loop only.
func (service *Service) reconcileIndex(ctx context.Context, now time.Time) {
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT true FROM assistant_embedding_config WHERE singleton FOR UPDATE`); err != nil {
		return
	}
	computation, err := service.computeIndexStatus(ctx, tx)
	if err != nil {
		return
	}
	if !computation.config.Configured || !computation.config.Enabled {
		_ = tx.Rollback(ctx)
		return
	}
	if err := service.requeueIndexRows(ctx, tx, computation.config.Generation, computation.policy, now); err != nil {
		return
	}
	updated, err := service.computeIndexStatus(ctx, tx)
	if err != nil {
		return
	}
	if updated.status != computation.config.Status {
		errorCode := updated.config.LastErrorCode
		if updated.status == "failed" && errorCode == nil {
			code, err := firstCurrentFailureCode(ctx, tx, updated.config.Generation)
			if err == nil {
				errorCode = code
			}
		}
		if updated.status != "failed" {
			errorCode = nil
		}
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_embedding_config SET status = $1, last_error_code = $2, updated_at = $3
			WHERE singleton
		`, updated.status, errorCode, now); err != nil {
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
}

func firstCurrentFailureCode(ctx context.Context, tx pgx.Tx, generation int64) (*string, error) {
	var code *string
	err := tx.QueryRow(ctx, `
		SELECT error_code FROM assistant_fragment_embeddings
		WHERE state = 'failed' AND generation = $1 AND error_code IS NOT NULL
		ORDER BY updated_at DESC, fragment_id LIMIT 1
	`, generation).Scan(&code)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return code, err
}

// requeueIndexRows reconciles embedding rows with the fact layer:
//  1. eligible fragments missing a current ready row are enqueued (or requeued
//     when their lease expired),
//  2. rows that are no longer eligible become excluded,
//  3. expired running leases with attempts left return to pending, others fail.
func (service *Service) requeueIndexRows(ctx context.Context, tx pgx.Tx, generation int64, policy string, now time.Time) error {
	// Expired running leases: retry once (attempt < maximum), otherwise fail.
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_fragment_embeddings SET state = 'pending', lease_owner = NULL,
		       lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = $2
		WHERE state = 'running' AND lease_expires_at < $1 AND attempt < $3
	`, now, now, MaximumIndexAttempt); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_fragment_embeddings SET state = 'failed', lease_owner = NULL,
		       lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		       error_code = 'EMBEDDING_PROVIDER_UNAVAILABLE', error_detail = '索引租约过期且重试次数已用尽',
		       updated_at = $2
		WHERE state = 'running' AND lease_expires_at < $1 AND attempt >= $3
	`, now, now, MaximumIndexAttempt); err != nil {
		return err
	}
	// Enqueue eligible fragments that lack a current matching ready embedding.
	if _, err := tx.Exec(ctx, eligibleFragmentsSource(policy, generation)+`
		INSERT INTO assistant_fragment_embeddings (
			fragment_id, source_created_at, generation, sensitivity_snapshot, policy_snapshot,
			state, updated_at
		)
		SELECT eligible.id, eligible.created_at, $2, eligible.sensitivity, $1, 'pending', $3
		FROM eligible
		WHERE NOT eligible.embedding_ready
		ON CONFLICT (fragment_id) DO UPDATE SET
			source_created_at = EXCLUDED.source_created_at,
			generation = EXCLUDED.generation,
			sensitivity_snapshot = EXCLUDED.sensitivity_snapshot,
			policy_snapshot = EXCLUDED.policy_snapshot,
			state = 'pending', embedding = NULL, dimensions = NULL,
			lease_owner = NULL, lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
			error_code = NULL, error_detail = NULL, updated_at = EXCLUDED.updated_at
		WHERE assistant_fragment_embeddings.state <> 'running'
		   OR assistant_fragment_embeddings.lease_expires_at IS NULL
		   OR assistant_fragment_embeddings.lease_expires_at < $3
	`, policy, generation, now); err != nil {
		return err
	}
	// Exclude rows whose fragment is no longer eligible (policy, trash, inactive).
	if _, err := tx.Exec(ctx, eligibleFragmentsSource(policy, generation)+`
		UPDATE assistant_fragment_embeddings e SET state = 'excluded', embedding = NULL, dimensions = NULL,
		       lease_owner = NULL, lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		       updated_at = $3
		WHERE e.state IN ('pending', 'ready')
		  AND NOT EXISTS (SELECT 1 FROM eligible WHERE eligible.id = e.fragment_id)
	`, policy, generation, now); err != nil {
		return err
	}
	return nil
}

// resetIndexForGeneration is used after a generation bump: every row is
// dropped back to the new generation queue (ready vectors cleared), running
// leases invalidated, and non-eligible rows excluded.
func (service *Service) resetIndexForGeneration(ctx context.Context, tx pgx.Tx, generation int64, policy string, now time.Time) error {
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_fragment_embeddings SET state = 'excluded', embedding = NULL, dimensions = NULL,
		       lease_owner = NULL, lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		       updated_at = $1
		WHERE state IN ('pending', 'running', 'ready')
	`, now); err != nil {
		return err
	}
	return service.requeueIndexRows(ctx, tx, generation, policy, now)
}

// bumpGenerationForPolicyChange implements the settings.go hook semantics:
// every policy change rebuilds, tightening clears derived vectors first.
func (service *Service) bumpGenerationForPolicyChange(ctx context.Context, previous, current string, now time.Time) error {
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT true FROM assistant_embedding_config WHERE singleton FOR UPDATE`); err != nil {
		return err
	}
	config, err := service.loadEmbeddingConfig(ctx, tx)
	if err != nil {
		return err
	}
	generation := config.Generation + 1
	status := config.Status
	if config.Enabled {
		status = "indexing"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_embedding_config SET generation = $1, status = $2, updated_at = $3
		WHERE singleton
	`, generation, status, now); err != nil {
		return err
	}
	if config.Enabled {
		if err := service.resetIndexForGeneration(ctx, tx, generation, current, now); err != nil {
			return err
		}
	} else if _, err := tx.Exec(ctx, `
		UPDATE assistant_fragment_embeddings SET embedding = NULL, dimensions = NULL,
		       lease_owner = NULL, lease_version = NULL, lease_expires_at = NULL, updated_at = $1
		WHERE state IN ('pending', 'running', 'ready')
	`, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type indexClaimInput struct {
	WorkerID string `json:"workerId"`
}

type indexClaimFragment struct {
	FragmentID     uuid.UUID `json:"fragmentId"`
	ItemID         uuid.UUID `json:"itemId"`
	SourceKind     string    `json:"sourceKind"`
	Sensitivity    string    `json:"sensitivity"`
	Content        string    `json:"content"`
	Attempt        int       `json:"attempt"`
	SourceCreatedAt time.Time `json:"sourceCreatedAt"`
}

type indexClaimResult struct {
	Generation int64                `json:"generation"`
	Policy     string               `json:"policy"`
	ExpiresAt  time.Time            `json:"expiresAt"`
	BaseURL    string               `json:"baseUrl"`
	APIKey     string               `json:"apiKey"`
	ModelID    string               `json:"modelId"`
	Dimensions int                  `json:"dimensions"`
	Fragments  []indexClaimFragment `json:"fragments"`
}

func (service *Service) claimIndexBatch(response http.ResponseWriter, request *http.Request) {
	var input indexClaimInput
	if httpapi.DecodeJSON(response, request, 8*1024, &input) != nil || !validAssistantWorkerID(input.WorkerID) {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部索引请求无效")
		return
	}
	ctx := request.Context()
	now := service.now().UTC()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer tx.Rollback(ctx)
	config, err := service.loadEmbeddingConfig(ctx, tx)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	policy, err := service.loadSensitivePolicy(ctx, tx)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if !config.Configured || !config.Enabled {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	rows, err := tx.Query(ctx, eligibleFragmentsSource(policy, config.Generation)+`, pending AS (
		SELECT e.fragment_id, e.attempt
		FROM assistant_fragment_embeddings e
		WHERE e.state = 'pending' AND e.generation = $2 AND e.policy_snapshot = $1
		ORDER BY e.updated_at, e.fragment_id
		LIMIT $3 FOR UPDATE SKIP LOCKED
	)
	SELECT pending.fragment_id, pending.attempt, eligible.item_id, eligible.source_kind,
	       eligible.sensitivity, eligible.content, eligible.created_at
	FROM pending JOIN eligible ON eligible.id = pending.fragment_id
	`, policy, config.Generation, IndexBatchSize)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	type claimedRow struct {
		fragment  indexClaimFragment
		attempt   int
	}
	claimed := make([]claimedRow, 0, IndexBatchSize)
	for rows.Next() {
		var row claimedRow
		if err := rows.Scan(&row.fragment.FragmentID, &row.attempt, &row.fragment.ItemID,
			&row.fragment.SourceKind, &row.fragment.Sensitivity, &row.fragment.Content,
			&row.fragment.SourceCreatedAt); err != nil {
			rows.Close()
			writeAssistantInternalFailure(response, request)
			return
		}
		claimed = append(claimed, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if len(claimed) == 0 {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	expires := now.Add(assistantLeaseDuraton)
	for index, row := range claimed {
		if _, err := tx.Exec(ctx, `
			UPDATE assistant_fragment_embeddings SET state = 'running', attempt = attempt + 1,
			       lease_owner = $2, lease_version = attempt + 1, lease_expires_at = $3,
			       heartbeat_at = $3, updated_at = $3
			WHERE fragment_id = $1
		`, row.fragment.FragmentID, input.WorkerID, expires); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		claimed[index].attempt = row.attempt + 1
	}
	result := indexClaimResult{Generation: config.Generation, Policy: policy, ExpiresAt: expires, Fragments: []indexClaimFragment{}}
	// Embedding connection snapshot; exists only inside this lease response.
	result.BaseURL = deref(config.BaseURL)
	result.ModelID = deref(config.ModelID)
	result.Dimensions = 0
	if config.Dimensions != nil {
		result.Dimensions = *config.Dimensions
	}
	if ciphertext := service.loadEmbeddingCiphertext(ctx, tx); ciphertext != nil {
		if apiKey, err := secretbox.Open(service.masterKey, ciphertext); err == nil {
			result.APIKey = apiKey
		}
	}
	for _, row := range claimed {
		row.fragment.Attempt = row.attempt
		// One redactor instance per fragment (docs/16 §6.2); block never reaches
		// the queue because sensitive fragments are ineligible under block policy.
		if policy == "redact" && row.fragment.Sensitivity != "normal" {
			row.fragment.Content = ai.NewTextRedactor().Redact(row.fragment.Content)
		}
		result.Fragments = append(result.Fragments, row.fragment)
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, result)
}

type indexLeaseEntry struct {
	FragmentID   uuid.UUID `json:"fragmentId"`
	LeaseVersion int       `json:"leaseVersion"`
}

type indexHeartbeatInput struct {
	WorkerID string            `json:"workerId"`
	Leases   []indexLeaseEntry `json:"leases"`
}

func (service *Service) heartbeatIndex(response http.ResponseWriter, request *http.Request) {
	var input indexHeartbeatInput
	if httpapi.DecodeJSON(response, request, 16*1024, &input) != nil || !validAssistantWorkerID(input.WorkerID) ||
		len(input.Leases) < 1 || len(input.Leases) > IndexBatchSize {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部索引请求无效")
		return
	}
	now := service.now().UTC()
	for _, lease := range input.Leases {
		tag, err := service.database.Exec(request.Context(), `
			UPDATE assistant_fragment_embeddings SET lease_expires_at = $3, heartbeat_at = $3, updated_at = $3
			WHERE fragment_id = $1 AND state = 'running' AND lease_owner = $2 AND lease_version = $4
			  AND lease_expires_at >= $5
		`, lease.FragmentID, input.WorkerID, now.Add(assistantLeaseDuraton), lease.LeaseVersion, now)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		if tag.RowsAffected() != 1 {
			writeAssistantLeaseConflict(response, request)
			return
		}
	}
	response.WriteHeader(http.StatusNoContent)
}

type indexCompleteInput struct {
	WorkerID   string             `json:"workerId"`
	Generation int64              `json:"generation"`
	Policy     string             `json:"policy"`
	Results    []indexResultEntry `json:"results"`
}

type indexResultEntry struct {
	FragmentID      uuid.UUID `json:"fragmentId"`
	LeaseVersion    int       `json:"leaseVersion"`
	Embedding       []float32 `json:"embedding"`
	Dimensions      int       `json:"dimensions"`
	SourceCreatedAt time.Time `json:"sourceCreatedAt"`
	Sensitivity     string    `json:"sensitivity"`
}

func (service *Service) completeIndexBatch(response http.ResponseWriter, request *http.Request) {
	var input indexCompleteInput
	if httpapi.DecodeJSON(response, request, 1024*1024, &input) != nil || !validAssistantWorkerID(input.WorkerID) ||
		input.Generation < 1 || input.Policy != "block" && input.Policy != "redact" && input.Policy != "allow" ||
		len(input.Results) < 1 || len(input.Results) > IndexBatchSize {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部索引请求无效")
		return
	}
	ctx := request.Context()
	now := service.now().UTC()
	tx, err := service.database.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer tx.Rollback(ctx)
	for _, entry := range input.Results {
		if entry.Dimensions < 1 || entry.Dimensions > 16000 || len(entry.Embedding) != entry.Dimensions ||
			entry.LeaseVersion < 1 ||
			entry.Sensitivity != "normal" && entry.Sensitivity != "sensitive" && entry.Sensitivity != "unknown" {
			writeEmbeddingDimensionMismatch(response, request)
			return
		}
		for _, value := range entry.Embedding {
			if !finiteFloat32(value) {
				writeEmbeddingResponseInvalid(response, request)
				return
			}
		}
	}
	for _, entry := range input.Results {
		// CAS completion per docs/16 §8.5: fragment facts, generation, policy and
		// lease version must all still match what was claimed, otherwise the
		// stale result is discarded.
		tag, err := tx.Exec(ctx, `
			UPDATE assistant_fragment_embeddings SET state = 'ready', embedding = $2, dimensions = $3,
			       indexed_at = $4, heartbeat_at = $4, lease_expires_at = NULL, lease_owner = NULL,
			       lease_version = NULL, error_code = NULL, error_detail = NULL, updated_at = $4
			WHERE fragment_id = $1 AND state = 'running' AND lease_owner = $5 AND lease_version = $6
			  AND source_created_at = $7 AND generation = $8
			  AND sensitivity_snapshot = $9 AND policy_snapshot = $10
		`, entry.FragmentID, vectorFor(entry.Embedding), entry.Dimensions, now,
			input.WorkerID, entry.LeaseVersion, entry.SourceCreatedAt, input.Generation,
			entry.Sensitivity, input.Policy)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		if tag.RowsAffected() != 1 {
			writeAssistantLeaseConflict(response, request)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

type indexFailureEntry struct {
	FragmentID   uuid.UUID `json:"fragmentId"`
	LeaseVersion int       `json:"leaseVersion"`
	ErrorCode    string    `json:"errorCode"`
	ErrorDetail  string    `json:"errorDetail"`
}

type indexFailInput struct {
	WorkerID string              `json:"workerId"`
	Failures []indexFailureEntry `json:"failures"`
}

func (service *Service) failIndexBatch(response http.ResponseWriter, request *http.Request) {
	var input indexFailInput
	if httpapi.DecodeJSON(response, request, 64*1024, &input) != nil || !validAssistantWorkerID(input.WorkerID) ||
		len(input.Failures) < 1 || len(input.Failures) > IndexBatchSize {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部索引请求无效")
		return
	}
	for _, failure := range input.Failures {
		if !validIndexErrorCode(failure.ErrorCode) || len(failure.ErrorDetail) > 500 || failure.LeaseVersion < 1 {
			httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部索引请求无效")
			return
		}
	}
	ctx := request.Context()
	now := service.now().UTC()
	for _, failure := range input.Failures {
		tag, err := service.database.Exec(ctx, `
			UPDATE assistant_fragment_embeddings SET state = 'failed', lease_owner = NULL,
			       lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
			       error_code = $3, error_detail = $4, updated_at = $5
			WHERE fragment_id = $1 AND state = 'running' AND lease_owner = $2
			  AND lease_version = $6 AND lease_expires_at >= $5
		`, failure.FragmentID, input.WorkerID, failure.ErrorCode, failure.ErrorDetail, now, failure.LeaseVersion)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		if tag.RowsAffected() != 1 {
			writeAssistantLeaseConflict(response, request)
			return
		}
	}
	response.WriteHeader(http.StatusNoContent)
}

func validIndexErrorCode(value string) bool {
	switch value {
	case "EMBEDDING_PROVIDER_UNAVAILABLE", "EMBEDDING_DIMENSION_MISMATCH", "EMBEDDING_RESPONSE_INVALID":
		return true
	default:
		return false
	}
}

type indexFailureDTO struct {
	FragmentID uuid.UUID `json:"fragmentId"`
	ItemID     uuid.UUID `json:"itemId"`
	ItemTitle  string    `json:"itemTitle"`
	SourceKind string    `json:"sourceKind"`
	Attempt    int       `json:"attempt"`
	ErrorCode  string    `json:"errorCode"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

func (service *Service) listIndexFailures(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	limit := 50
	if raw := request.URL.Query().Get("limit"); raw != "" {
		value, err := parseBoundedInt(raw, 1, 100)
		if err != nil {
			writeValidationError(response, request)
			return
		}
		limit = value
	}
	cursor, err := decodeIndexFailureCursor(request.URL.Query().Get("cursor"))
	if err != nil {
		writeValidationError(response, request)
		return
	}
	args := []any{}
	query := `
		SELECT e.fragment_id, i.id, i.title, f.source_kind, e.attempt, e.error_code, e.updated_at
		FROM assistant_fragment_embeddings e
		JOIN search_fragments f ON f.id = e.fragment_id
		JOIN knowledge_items i ON i.id = f.item_id
		WHERE e.state = 'failed'`
	if cursor != nil {
		args = append(args, cursor.UpdatedAt, cursor.FragmentID)
		query += ` AND (e.updated_at, e.fragment_id) < ($1, $2)`
	}
	args = append(args, limit+1)
	query += ` ORDER BY e.updated_at DESC, e.fragment_id DESC LIMIT $3`
	rows, err := service.database.Query(request.Context(), query, args...)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	defer rows.Close()
	items := make([]indexFailureDTO, 0, limit)
	for rows.Next() {
		var entry indexFailureDTO
		var errorCode string
		if err := rows.Scan(&entry.FragmentID, &entry.ItemID, &entry.ItemTitle, &entry.SourceKind,
			&entry.Attempt, &errorCode, &entry.UpdatedAt); err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		entry.ErrorCode = errorCode
		items = append(items, entry)
	}
	if err := rows.Err(); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	rows.Close()
	var nextCursor *string
	if len(items) > limit {
		last := items[limit-1]
		encoded, err := encodeIndexFailureCursor(last.UpdatedAt, last.FragmentID)
		if err != nil {
			writeAssistantInternalFailure(response, request)
			return
		}
		nextCursor = &encoded
		items = items[:limit]
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items, "nextCursor": nextCursor})
}

type indexFailureCursor struct {
	UpdatedAt  time.Time `json:"t"`
	FragmentID uuid.UUID `json:"f"`
}

func decodeIndexFailureCursor(raw string) (*indexFailureCursor, error) {
	if raw == "" {
		return nil, nil
	}
	cursor := &indexFailureCursor{}
	if err := json.Unmarshal([]byte(raw), cursor); err != nil || cursor.FragmentID == uuid.Nil || cursor.UpdatedAt.IsZero() {
		return nil, errors.New("invalid cursor")
	}
	return cursor, nil
}

func encodeIndexFailureCursor(updatedAt time.Time, fragmentID uuid.UUID) (string, error) {
	encoded, err := json.Marshal(indexFailureCursor{UpdatedAt: updatedAt, FragmentID: fragmentID})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func (service *Service) retryIndexFailure(response http.ResponseWriter, request *http.Request) {
	httpapi.NoStore(response)
	fragmentID, err := uuid.Parse(request.PathValue("fragmentId"))
	if err != nil {
		writeAssistantNotFound(response, request)
		return
	}
	now := service.now().UTC()
	tag, err := service.database.Exec(request.Context(), `
		UPDATE assistant_fragment_embeddings SET state = 'pending', attempt = 0,
		       lease_owner = NULL, lease_version = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		       error_code = NULL, error_detail = NULL, updated_at = $2
		WHERE fragment_id = $1 AND state = 'failed'
	`, fragmentID, now)
	if err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if tag.RowsAffected() != 1 {
		writeAssistantNotFound(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusAccepted, map[string]any{
		"fragmentId": fragmentID, "state": "pending",
	})
}

func validAssistantWorkerID(value string) bool {
	if value == "" || len(value) > 120 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func parseBoundedInt(raw string, minimum, maximum int) (int, error) {
	value := 0
	if raw == "" {
		return 0, errors.New("empty")
	}
	for _, digit := range raw {
		if digit < '0' || digit > '9' {
			return 0, errors.New("not a number")
		}
		value = value*10 + int(digit-'0')
		if value > maximum {
			return 0, errors.New("out of range")
		}
	}
	if value < minimum {
		return 0, errors.New("out of range")
	}
	return value, nil
}

func writeEmbeddingDimensionMismatch(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "EMBEDDING_DIMENSION_MISMATCH", "向量维度与配置不一致")
}

func writeEmbeddingResponseInvalid(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusBadGateway, "EMBEDDING_RESPONSE_INVALID", "Embedding 响应无效")
}

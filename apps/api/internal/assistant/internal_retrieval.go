package assistant

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/httpapi"
)

type retrievalInput struct {
	WorkerID     string    `json:"workerId"`
	LeaseVersion int       `json:"leaseVersion"`
	Generation   int64     `json:"generation"`
	Query        string    `json:"query"`
	QueryVector  []float32 `json:"queryVector"`
}

type retrievalSourcePayload struct {
	Ordinal       int        `json:"ordinal"`
	FragmentID    *uuid.UUID `json:"fragmentId"`
	ItemID        *uuid.UUID `json:"itemId"`
	SourceKind    string     `json:"sourceKind"`
	SourceClass   string     `json:"sourceClass"`
	Title         string     `json:"title"`
	Content       string     `json:"content"`
	Sensitivity   string     `json:"sensitivity"`
}

type retrievalResult struct {
	KnowledgeState string                  `json:"knowledgeState"`
	EvidenceState  string                  `json:"evidenceState"`
	Sources        []retrievalSourcePayload `json:"sources"`
}

// solidifyRunSources freezes the budget-trimmed, redacted sources that are
// actually sent to the model as S1..S8 (docs/16 §8.11).
func solidifyRunSources(ctx context.Context, tx pgx.Tx, run runRow, candidates []retrievalCandidate, now time.Time) error {
	for index, candidate := range candidates {
		ordinal := index + 1
		title := candidate.Title
		if title == "" {
			title = "未命名记录"
		}
		locator := map[string]any{"itemId": candidate.ItemID}
		if candidate.FragmentID != uuid.Nil {
			locator["fragmentId"] = candidate.FragmentID
		}
		if candidate.RawRecordID != nil {
			locator["rawRecordId"] = *candidate.RawRecordID
		}
		if candidate.ArtifactID != nil {
			locator["artifactId"] = *candidate.ArtifactID
		}
		if candidate.Ordinal > 0 {
			locator["ordinal"] = candidate.Ordinal
		}
		if candidate.StartByte != nil {
			locator["startByte"] = *candidate.StartByte
		}
		if candidate.EndByte != nil {
			locator["endByte"] = *candidate.EndByte
		}
		encodedLocator, err := jsonMarshal(locator)
		if err != nil {
			return err
		}
		var fragmentID *uuid.UUID
		if candidate.FragmentID != uuid.Nil {
			fragmentID = &candidate.FragmentID
		}
		itemID := candidate.ItemID
		if _, err := tx.Exec(ctx, `
			INSERT INTO assistant_run_sources (
				run_id, ordinal, fragment_id, item_id, artifact_id, source_kind,
				title_snapshot, excerpt_snapshot, locator_snapshot, retrieval_rank, created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		`, run.ID, ordinal, fragmentID, itemID, candidate.ArtifactID, candidate.SourceKind,
			title, candidate.Content, encodedLocator, ordinal, now); err != nil {
			return err
		}
	}
	return nil
}

func sourceClass(kind string) string {
	if kind == "ai_text" || kind == "image_text" {
		return "ai_derived"
	}
	return "primary"
}

func (service *Service) runRetrieval(response http.ResponseWriter, request *http.Request) {
	run, ok := service.loadRunOr404(response, request)
	if !ok {
		return
	}
	var input retrievalInput
	if httpapi.DecodeJSON(response, request, 256*1024, &input) != nil ||
		!validAssistantWorkerID(input.WorkerID) || input.LeaseVersion < 1 ||
		input.Generation < 1 || len(input.Query) == 0 || len(input.Query) > 4096 ||
		len(input.QueryVector) > 16000 {
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "内部助手请求无效")
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
	var storedRun runRow
	if err := tx.QueryRow(ctx, `SELECT `+runColumns+` FROM assistant_runs WHERE id = $1 FOR UPDATE`, run.ID).
		Scan(runScanTargets(&storedRun)...); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	if storedRun.Status != "running" || storedRun.LeaseOwner == nil || *storedRun.LeaseOwner != input.WorkerID ||
		storedRun.LeaseVersion == nil || *storedRun.LeaseVersion != input.LeaseVersion ||
		storedRun.LeaseExpiresAt == nil || storedRun.LeaseExpiresAt.Before(now) {
		writeAssistantLeaseConflict(response, request)
		return
	}
	result, conflict := service.executeRetrieval(ctx, tx, storedRun, input, now)
	if conflict != nil {
		if conflict.code == "ASSISTANT_LEASE_CONFLICT" {
			writeAssistantLeaseConflict(response, request)
			return
		}
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, conflict.code, "检索请求无效")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeAssistantInternalFailure(response, request)
		return
	}
	service.broadcast.notify(storedRun.ID)
	httpapi.WriteJSON(response, http.StatusOK, result)
}

// executeRetrieval revalidates the frozen generation, runs hybrid retrieval,
// trims to the context budget and freezes S1..S8 in one transaction.
func (service *Service) executeRetrieval(ctx context.Context, tx pgx.Tx, run runRow, input retrievalInput, now time.Time) (*retrievalResult, *runConflictError) {
	if run.KnowledgeState != "ready" {
		// Knowledge was unavailable at creation; skip retrieval entirely.
		if _, err := tx.Exec(ctx,
			`UPDATE assistant_runs SET evidence_state = 'unavailable' WHERE id = $1`, run.ID); err != nil {
			return nil, &runConflictError{code: "INTERNAL_ERROR"}
		}
		return &retrievalResult{KnowledgeState: "unavailable", EvidenceState: "unavailable", Sources: []retrievalSourcePayload{}}, nil
	}
	config, err := service.loadEmbeddingConfig(ctx, tx)
	if err != nil {
		return nil, &runConflictError{code: "INTERNAL_ERROR"}
	}
	// The frozen generation from the claim must still be current; anything else
	// degrades this run to unavailable without touching the global index state.
	if !config.Enabled || !config.Configured || config.Generation != input.Generation {
		if _, err := tx.Exec(ctx,
			`UPDATE assistant_runs SET evidence_state = 'unavailable' WHERE id = $1`, run.ID); err != nil {
			return nil, &runConflictError{code: "INTERNAL_ERROR"}
		}
		return &retrievalResult{KnowledgeState: "unavailable", EvidenceState: "unavailable", Sources: []retrievalSourcePayload{}}, nil
	}
	candidates, err := hybridRetrieve(ctx, tx, config.Generation, run.EffectivePolicy, input.Query, input.QueryVector)
	if err != nil {
		return nil, &runConflictError{code: "INTERNAL_ERROR"}
	}
	snapshots := buildSourceSnapshots(candidates, run.EffectivePolicy)
	trimmed := service.trimSourcesToBudget(ctx, tx, run, snapshots)
	if trimmed == nil {
		return nil, &runConflictError{code: "ASSISTANT_CONTEXT_TOO_LARGE"}
	}
	evidenceState := "not_found"
	if len(trimmed) > 0 {
		evidenceState = "matched"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_runs SET evidence_state = $2 WHERE id = $1
	`, run.ID, evidenceState); err != nil {
		return nil, &runConflictError{code: "INTERNAL_ERROR"}
	}
	if err := solidifyRunSources(ctx, tx, run, trimmed, now); err != nil {
		return nil, &runConflictError{code: "INTERNAL_ERROR"}
	}
	payload := make([]retrievalSourcePayload, 0, len(trimmed))
	for index, candidate := range trimmed {
		fragmentID := candidate.FragmentID
		if fragmentID == uuid.Nil {
			fragmentID = uuid.Nil
		}
		var fragmentRef *uuid.UUID
		if candidate.FragmentID != uuid.Nil {
			fragmentRef = &candidate.FragmentID
		}
		itemRef := candidate.ItemID
		payload = append(payload, retrievalSourcePayload{
			Ordinal: index + 1, FragmentID: fragmentRef, ItemID: &itemRef,
			SourceKind: candidate.SourceKind, SourceClass: sourceClass(candidate.SourceKind),
			Title: candidate.Title, Content: candidate.Content, Sensitivity: candidate.Sensitivity,
		})
	}
	return &retrievalResult{
		KnowledgeState: "ready", EvidenceState: evidenceState, Sources: payload,
	}, nil
}

// trimSourcesToBudget drops the lowest-ranked sources first when the context
// cannot hold every candidate (docs/16 §10.2). Returning nil signals a
// context that cannot fit at all.
func (service *Service) trimSourcesToBudget(ctx context.Context, tx pgx.Tx, run runRow, snapshots []retrievalCandidate) []retrievalCandidate {
	budget := contextBudgetTokens(run.ContextWindow, run.MaxOutputTokens)
	// Recompute the same deterministic history/summary/question cost that the
	// claim used; sources may then consume the remainder.
	summaryCost := 0
	var summaryContent []byte
	if err := tx.QueryRow(ctx,
		`SELECT content FROM assistant_conversation_summaries WHERE conversation_id = $1`, run.ConversationID).Scan(&summaryContent); err == nil {
		summaryCost = estimateTokens(string(summaryContent)) + 4
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	rows, err := tx.Query(ctx, `
		SELECT role, content FROM assistant_messages
		WHERE conversation_id = $1 AND id <> $2 AND id <> $3 AND status = 'complete'
		ORDER BY sequence DESC
	`, run.ConversationID, run.InputMessageID, run.OutputMessageID)
	if err != nil {
		return nil
	}
	type historyEntry struct {
		role    string
		content string
	}
	history := make([]historyEntry, 0)
	for rows.Next() {
		var entry historyEntry
		if err := rows.Scan(&entry.role, &entry.content); err != nil {
			rows.Close()
			return nil
		}
		history = append(history, entry)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil
	}
	remaining := budget - summaryCost
	for _, entry := range history {
		content := entry.content
		if entry.role == "assistant" {
			content = stripCitationTokens(content)
		}
		cost := estimateTokens(content) + 4
		if cost > remaining {
			break
		}
		remaining -= cost
	}
	var question string
	if err := tx.QueryRow(ctx,
		`SELECT content FROM assistant_messages WHERE id = $1`, run.InputMessageID).Scan(&question); err != nil {
		return nil
	}
	questionCost := estimateTokens(question)
	if questionCost > remaining {
		return nil
	}
	remaining -= questionCost
	trimmed := make([]retrievalCandidate, 0, len(snapshots))
	for _, candidate := range snapshots {
		cost := estimateTokens(candidate.Content) + estimateTokens(candidate.Title) + 8
		if cost > remaining {
			break
		}
		remaining -= cost
		trimmed = append(trimmed, candidate)
	}
	return trimmed
}

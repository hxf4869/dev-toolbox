package assistant

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type runRow struct {
	AnswerContextTokens  *int64
	ID                   uuid.UUID
	ConversationID       uuid.UUID
	InputMessageID       uuid.UUID
	OutputMessageID      uuid.UUID
	ClientRequestID      uuid.UUID
	RetryOfRunID         *uuid.UUID
	Status               string
	Phase                *string
	StopRequestedAt      *time.Time
	ClaimAttempt         int
	LeaseOwner           *string
	LeaseVersion         *int
	LeaseExpiresAt       *time.Time
	HeartbeatAt          *time.Time
	ProviderID           uuid.UUID
	ProviderDisplayName  string
	ModelID              uuid.UUID
	ModelDisplayName     string
	UpstreamModelID      string
	Protocol             string
	BaseURL              string
	ContextWindow        int
	MaxOutputTokens      int
	ReasoningEffort      *string
	ReasoningDisplayName *string
	SensitivePolicy      string
	EffectivePolicy      string
	PromptVersion        string
	RetrievalVersion     string
	RewriteFallback      bool
	KnowledgeState       string
	KnowledgeGeneration  *int64
	EvidenceState        *string
	RewriteInputTokens   *int64
	RewriteOutputTokens  *int64
	AnswerInputTokens    *int64
	AnswerOutputTokens   *int64
	RewriteMS            *int64
	EmbeddingMS          *int64
	RetrievalMS          *int64
	ReasoningMS          *int64
	AnswerMS             *int64
	CreatedAt            time.Time
	QueuedAt             time.Time
	StartedAt            *time.Time
	FinishedAt           *time.Time
	ErrorCode            *string
	ErrorDetail          *string
}

const runColumns = `
	id, conversation_id, input_message_id, output_message_id, client_request_id, retry_of_run_id,
	status, phase, stop_requested_at, claim_attempt, lease_owner, lease_version, lease_expires_at,
	heartbeat_at, provider_id, provider_display_name, model_id, model_display_name,
	upstream_model_id, protocol, base_url, context_window, max_output_tokens,
	reasoning_effort, reasoning_display_name, sensitive_policy, effective_sensitive_policy,
	prompt_version, retrieval_version, rewrite_fallback, knowledge_state, knowledge_generation, evidence_state,
	rewrite_input_tokens, rewrite_output_tokens, answer_input_tokens, answer_output_tokens, answer_context_tokens,
	rewrite_ms, embedding_ms, retrieval_ms, reasoning_ms, answer_ms,
	created_at, queued_at, started_at, finished_at, error_code, error_detail
`

func runScanTargets(run *runRow) []any {
	return []any{&run.ID, &run.ConversationID, &run.InputMessageID, &run.OutputMessageID,
		&run.ClientRequestID, &run.RetryOfRunID, &run.Status, &run.Phase, &run.StopRequestedAt,
		&run.ClaimAttempt, &run.LeaseOwner, &run.LeaseVersion, &run.LeaseExpiresAt,
		&run.HeartbeatAt, &run.ProviderID, &run.ProviderDisplayName, &run.ModelID, &run.ModelDisplayName,
		&run.UpstreamModelID, &run.Protocol, &run.BaseURL, &run.ContextWindow, &run.MaxOutputTokens,
		&run.ReasoningEffort, &run.ReasoningDisplayName, &run.SensitivePolicy, &run.EffectivePolicy,
		&run.PromptVersion, &run.RetrievalVersion, &run.RewriteFallback, &run.KnowledgeState, &run.KnowledgeGeneration, &run.EvidenceState,
		&run.RewriteInputTokens, &run.RewriteOutputTokens, &run.AnswerInputTokens, &run.AnswerOutputTokens, &run.AnswerContextTokens,
		&run.RewriteMS, &run.EmbeddingMS, &run.RetrievalMS, &run.ReasoningMS, &run.AnswerMS,
		&run.CreatedAt, &run.QueuedAt, &run.StartedAt, &run.FinishedAt, &run.ErrorCode, &run.ErrorDetail}
}

func scanRunRow(row pgx.Row) (runRow, error) {
	var run runRow
	err := row.Scan(runScanTargets(&run)...)
	return run, err
}

func (service *Service) loadRun(ctx context.Context, querier rowQuerier, id uuid.UUID) (runRow, error) {
	return scanRunRow(querier.QueryRow(ctx, `SELECT `+runColumns+` FROM assistant_runs WHERE id = $1`, id))
}

func (run runRow) isTerminal() bool {
	return run.Status == "succeeded" || run.Status == "failed" || run.Status == "stopped"
}

func (run runRow) canStop() bool {
	return (run.Status == "queued" || run.Status == "running") && run.StopRequestedAt == nil
}

func (run runRow) reasoningSnapshot() RunReasoningDTO {
	if run.ReasoningEffort == nil {
		return RunReasoningDTO{Reasoning: "off", DisplayName: "不思考"}
	}
	return RunReasoningDTO{Reasoning: *run.ReasoningEffort, DisplayName: *run.ReasoningDisplayName}
}

func (run runRow) errorDTO() *RunErrorDTO {
	if run.ErrorCode == nil {
		return nil
	}
	message := "回答失败"
	if run.ErrorDetail != nil {
		message = *run.ErrorDetail
	}
	return &RunErrorDTO{Code: *run.ErrorCode, Message: message}
}

// runCounts returns providedSourceCount, citationCount and lastSequence.
func (service *Service) runCounts(ctx context.Context, querier rowQuerier, run runRow) (int, int, int64, error) {
	var provided, cited int
	var lastSequence int64
	if err := querier.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM assistant_run_sources WHERE run_id = $1),
		       (SELECT count(*) FROM assistant_run_sources WHERE run_id = $1 AND cited_number IS NOT NULL),
		       COALESCE((SELECT max(sequence) FROM assistant_run_events WHERE run_id = $1), 0)
	`, run.ID).Scan(&provided, &cited, &lastSequence); err != nil {
		return 0, 0, 0, err
	}
	return provided, cited, lastSequence, nil
}

func (service *Service) runDTO(ctx context.Context, querier rowQuerier, run runRow) (AssistantRunDTO, error) {
	provided, cited, lastSequence, err := service.runCounts(ctx, querier, run)
	if err != nil {
		return AssistantRunDTO{}, err
	}
	canRetry, err := service.runRetryable(ctx, querier, run)
	if err != nil {
		return AssistantRunDTO{}, err
	}
	dto := AssistantRunDTO{
		ID: run.ID, ConversationID: run.ConversationID, InputMessageID: run.InputMessageID,
		OutputMessageID: run.OutputMessageID, ClientRequestID: run.ClientRequestID,
		RetryOfRunID: run.RetryOfRunID, Status: run.Status, Phase: run.Phase,
		StopRequested: run.StopRequestedAt != nil,
		Model: RunModelDTO{
			ID: run.ModelID, DisplayName: run.ModelDisplayName, UpstreamModelID: run.UpstreamModelID,
			ProviderID: run.ProviderID, ProviderDisplayName: run.ProviderDisplayName,
			ContextWindow: run.ContextWindow,
		},
		Reasoning:     run.reasoningSnapshot(),
		PromptVersion: run.PromptVersion, RetrievalVersion: run.RetrievalVersion,
		RewriteFallback: run.RewriteFallback,
		KnowledgeState:  run.KnowledgeState, EvidenceState: run.EvidenceState,
		Usage: RunUsageDTO{
			RewriteInputTokens: run.RewriteInputTokens, RewriteOutputTokens: run.RewriteOutputTokens,
			AnswerInputTokens: run.AnswerInputTokens, AnswerOutputTokens: run.AnswerOutputTokens,
			AnswerContextTokens: run.AnswerContextTokens,
		},
		Timings: RunTimingsDTO{
			RewriteMS: run.RewriteMS, EmbeddingMS: run.EmbeddingMS, RetrievalMS: run.RetrievalMS,
			ReasoningMS: run.ReasoningMS, AnswerMS: run.AnswerMS,
		},
		ProvidedSourceCount: provided, CitationCount: cited, LastSequence: lastSequence,
		CanStop: run.canStop(), CanRetry: canRetry, Error: run.errorDTO(),
		CreatedAt: run.CreatedAt, StartedAt: run.StartedAt, FinishedAt: run.FinishedAt,
	}
	if run.isTerminal() {
		dto.Timings.TotalMS = totalRunTiming(run)
	}
	return dto, nil
}

func (service *Service) runRetryable(ctx context.Context, querier rowQuerier, run runRow) (bool, error) {
	if run.Status != "failed" && run.Status != "stopped" {
		return false, nil
	}
	var retryable bool
	err := querier.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM assistant_messages message
			WHERE message.id = $1 AND message.current_run_id = $2
			  AND message.sequence = (
				SELECT max(sequence) FROM assistant_messages WHERE conversation_id = $3
			  )
		)
	`, run.OutputMessageID, run.ID, run.ConversationID).Scan(&retryable)
	return retryable, err
}

func totalRunTiming(run runRow) *int64 {
	values := []*int64{run.RewriteMS, run.EmbeddingMS, run.RetrievalMS, run.ReasoningMS, run.AnswerMS}
	var total int64
	found := false
	for _, value := range values {
		if value != nil {
			total += *value
			found = true
		}
	}
	if !found {
		return nil
	}
	return &total
}

type messageRow struct {
	ID               uuid.UUID
	ConversationID   uuid.UUID
	Sequence         int64
	Role             string
	Content          string
	ReasoningContent *string
	Status           string
	CurrentRunID     *uuid.UUID
	CreatedAt        time.Time
	CompletedAt      *time.Time
}

const messageColumns = `id, conversation_id, sequence, role, content, reasoning_content, status, current_run_id, created_at, completed_at`

func scanMessageRow(row pgx.Row) (messageRow, error) {
	var message messageRow
	err := row.Scan(&message.ID, &message.ConversationID, &message.Sequence, &message.Role,
		&message.Content, &message.ReasoningContent, &message.Status, &message.CurrentRunID,
		&message.CreatedAt, &message.CompletedAt)
	return message, err
}

func (service *Service) loadMessage(ctx context.Context, querier rowQuerier, id uuid.UUID) (messageRow, error) {
	return scanMessageRow(querier.QueryRow(ctx, `SELECT `+messageColumns+` FROM assistant_messages WHERE id = $1`, id))
}

type sourceRow struct {
	Ordinal         int
	CitedNumber     *int
	FragmentID      *uuid.UUID
	ItemID          *uuid.UUID
	ArtifactID      *uuid.UUID
	SourceKind      string
	TitleSnapshot   string
	ExcerptSnapshot string
	LocatorSnapshot []byte
	RetrievalRank   int
	ItemDeleted     bool
	CurrentTitle    *string
}

func (service *Service) loadRunSources(ctx context.Context, querier rowQuerier, runID uuid.UUID) ([]sourceRow, error) {
	rows, err := querier.Query(ctx, `
		SELECT s.ordinal, s.cited_number, s.fragment_id, s.item_id, s.artifact_id, s.source_kind,
		       s.title_snapshot, s.excerpt_snapshot, s.locator_snapshot, s.retrieval_rank,
		       i.id IS NULL OR i.deleted_at IS NOT NULL, i.title
		FROM assistant_run_sources s
		LEFT JOIN knowledge_items i ON i.id = s.item_id
		WHERE s.run_id = $1
		ORDER BY s.ordinal
	`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sources := make([]sourceRow, 0)
	for rows.Next() {
		var source sourceRow
		if err := rows.Scan(&source.Ordinal, &source.CitedNumber, &source.FragmentID, &source.ItemID,
			&source.ArtifactID, &source.SourceKind, &source.TitleSnapshot, &source.ExcerptSnapshot,
			&source.LocatorSnapshot, &source.RetrievalRank, &source.ItemDeleted, &source.CurrentTitle); err != nil {
			return nil, err
		}
		sources = append(sources, source)
	}
	return sources, rows.Err()
}

// sourceDTO maps a stored snapshot to the public source shape; permanently
// purged items keep "来源已删除" with null details (docs/16 §8.11).
func (service *Service) sourceDTO(run runRow, source sourceRow, citationNumber int) AssistantSourceDTO {
	erased := source.ItemDeleted ||
		(source.FragmentID == nil && source.ItemID == nil && source.ArtifactID == nil)
	dto := AssistantSourceDTO{
		RunID: run.ID, SourceOrdinal: source.Ordinal, CitationNumber: citationNumber,
		SourceKind: source.SourceKind, Title: source.TitleSnapshot, Availability: "available",
	}
	if source.SourceKind == "ai_text" || source.SourceKind == "image_text" {
		dto.SourceClass = "ai_derived"
	} else {
		dto.SourceClass = "primary"
	}
	if erased {
		dto.Title = "来源已删除"
		dto.Availability = "unavailable"
		dto.CurrentTitle = nil
		dto.TitleChanged = false
		dto.Excerpt = nil
		dto.Locator = nil
		return dto
	}
	if source.CurrentTitle != nil && *source.CurrentTitle != source.TitleSnapshot {
		dto.CurrentTitle = source.CurrentTitle
		dto.TitleChanged = true
	} else if source.CurrentTitle != nil {
		dto.CurrentTitle = source.CurrentTitle
		dto.TitleChanged = false
	} else {
		// Fragment from a trashed but not purged item still resolves its title.
		dto.CurrentTitle = &source.TitleSnapshot
		dto.TitleChanged = false
	}
	if source.ExcerptSnapshot != "" {
		excerpt := source.ExcerptSnapshot
		dto.Excerpt = &excerpt
	}
	var locator SourceLocatorDTO
	if err := jsonUnmarshal(source.LocatorSnapshot, &locator); err == nil && locator.ItemID != uuid.Nil {
		locator.Href = "/items/" + locator.ItemID.String()
		dto.Locator = &locator
	}
	return dto
}

func (service *Service) citationRefs(ctx context.Context, querier rowQuerier, run runRow) ([]CitationRefDTO, error) {
	sources, err := service.loadRunSources(ctx, querier, run.ID)
	if err != nil {
		return nil, err
	}
	citations := make([]CitationRefDTO, 0)
	for _, source := range sources {
		if source.CitedNumber == nil {
			continue
		}
		dto := service.sourceDTO(run, source, *source.CitedNumber)
		citations = append(citations, CitationRefDTO{
			RunID: run.ID, SourceOrdinal: source.Ordinal, CitationNumber: *source.CitedNumber,
			SourceKind: dto.SourceKind, SourceClass: dto.SourceClass, Title: dto.Title,
			Availability: dto.Availability,
		})
	}
	return citations, nil
}

func (service *Service) messageDTO(ctx context.Context, querier rowQuerier, message messageRow) (AssistantMessageDTO, error) {
	dto := AssistantMessageDTO{
		ID: message.ID, ConversationID: message.ConversationID, Sequence: message.Sequence,
		Role: message.Role, Content: message.Content, ReasoningContent: message.ReasoningContent,
		Status: message.Status, Citations: []CitationRefDTO{}, CreatedAt: message.CreatedAt,
		CompletedAt: message.CompletedAt,
	}
	if message.Role == "assistant" {
		var reasoningMS *int64
		if message.CurrentRunID != nil {
			run, err := service.loadRun(ctx, querier, *message.CurrentRunID)
			if err == nil {
				reasoningMS = run.ReasoningMS
				runDTO, err := service.runDTO(ctx, querier, run)
				if err != nil {
					return AssistantMessageDTO{}, err
				}
				dto.CurrentRun = &runDTO
				citations, err := service.citationRefs(ctx, querier, run)
				if err != nil {
					return AssistantMessageDTO{}, err
				}
				dto.Citations = citations
			} else {
				return AssistantMessageDTO{}, err
			}
		}
		dto.ReasoningDurationMS = reasoningMS
	}
	return dto, nil
}

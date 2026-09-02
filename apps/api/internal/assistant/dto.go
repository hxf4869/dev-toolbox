package assistant

import (
	"time"

	"github.com/google/uuid"
)

// Public DTOs frozen by docs/16 §13.6–§13.9 and §15.
type ReasoningOptionDTO struct {
	Reasoning   string `json:"reasoning"`
	DisplayName string `json:"displayName"`
	SortOrder   int    `json:"sortOrder"`
}

type AssistantModelDTO struct {
	ContextWindow    int                  `json:"contextWindow"`
	ID               uuid.UUID            `json:"id"`
	DisplayName      string               `json:"displayName"`
	UpstreamModelID  string               `json:"upstreamModelId"`
	Provider         AssistantProviderRef `json:"provider"`
	ReasoningOptions []ReasoningOptionDTO `json:"reasoningOptions"`
	LastReasoning    string               `json:"lastReasoning"`
}

type AssistantProviderRef struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"displayName"`
}

type KnowledgeIndexStatusDTO struct {
	Status          string            `json:"status"`
	Available       bool              `json:"available"`
	Generation      *int64            `json:"generation"`
	SensitivePolicy string            `json:"sensitivePolicy"`
	Counts          indexStatusCounts `json:"counts"`
	LastErrorCode   *string           `json:"lastErrorCode"`
	UpdatedAt       *time.Time        `json:"updatedAt"`
}

type AssistantBootstrapDTO struct {
	Models                   []AssistantModelDTO         `json:"models"`
	NewConversationSelection newConversationSelectionDTO `json:"newConversationSelection"`
	Knowledge                KnowledgeIndexStatusDTO     `json:"knowledge"`
}

type newConversationSelectionDTO struct {
	ModelID   *uuid.UUID `json:"modelId"`
	Reasoning string     `json:"reasoning"`
	Required  bool       `json:"required"`
	Reason    *string    `json:"reason"`
}

type AssistantFolderDTO struct {
	ID                uuid.UUID `json:"id"`
	Name              string    `json:"name"`
	ConversationCount int       `json:"conversationCount"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type RunErrorDTO struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type RunUsageDTO struct {
	AnswerContextTokens *int64 `json:"answerContextTokens"`
	RewriteInputTokens  *int64 `json:"rewriteInputTokens"`
	RewriteOutputTokens *int64 `json:"rewriteOutputTokens"`
	AnswerInputTokens   *int64 `json:"answerInputTokens"`
	AnswerOutputTokens  *int64 `json:"answerOutputTokens"`
}

type RunTimingsDTO struct {
	RewriteMS   *int64 `json:"rewriteMs"`
	EmbeddingMS *int64 `json:"embeddingMs"`
	RetrievalMS *int64 `json:"retrievalMs"`
	ReasoningMS *int64 `json:"reasoningMs"`
	AnswerMS    *int64 `json:"answerMs"`
	TotalMS     *int64 `json:"totalMs"`
}

type RunSummaryDTO struct {
	ID            uuid.UUID    `json:"id"`
	Status        string       `json:"status"`
	Phase         *string      `json:"phase"`
	StopRequested bool         `json:"stopRequested"`
	CanStop       bool         `json:"canStop"`
	CanRetry      bool         `json:"canRetry"`
	Error         *RunErrorDTO `json:"error"`
	CreatedAt     time.Time    `json:"createdAt"`
	FinishedAt    *time.Time   `json:"finishedAt"`
}

type CitationRefDTO struct {
	RunID          uuid.UUID `json:"runId"`
	SourceOrdinal  int       `json:"sourceOrdinal"`
	CitationNumber int       `json:"citationNumber"`
	SourceKind     string    `json:"sourceKind"`
	SourceClass    string    `json:"sourceClass"`
	Title          string    `json:"title"`
	Availability   string    `json:"availability"`
}

type SourceLocatorDTO struct {
	ItemID      uuid.UUID  `json:"itemId"`
	Href        string     `json:"href"`
	FragmentID  *uuid.UUID `json:"fragmentId"`
	RawRecordID *uuid.UUID `json:"rawRecordId"`
	ArtifactID  *uuid.UUID `json:"artifactId"`
	Ordinal     *int       `json:"ordinal"`
	StartByte   *int       `json:"startByte"`
	EndByte     *int       `json:"endByte"`
}

type AssistantSourceDTO struct {
	RunID          uuid.UUID         `json:"runId"`
	SourceOrdinal  int               `json:"sourceOrdinal"`
	CitationNumber int               `json:"citationNumber"`
	SourceKind     string            `json:"sourceKind"`
	SourceClass    string            `json:"sourceClass"`
	Title          string            `json:"title"`
	Availability   string            `json:"availability"`
	CurrentTitle   *string           `json:"currentTitle"`
	TitleChanged   bool              `json:"titleChanged"`
	Excerpt        *string           `json:"excerpt"`
	Locator        *SourceLocatorDTO `json:"locator"`
}

type AssistantRunDTO struct {
	ID                  uuid.UUID       `json:"id"`
	ConversationID      uuid.UUID       `json:"conversationId"`
	InputMessageID      uuid.UUID       `json:"inputMessageId"`
	OutputMessageID     uuid.UUID       `json:"outputMessageId"`
	ClientRequestID     uuid.UUID       `json:"clientRequestId"`
	RetryOfRunID        *uuid.UUID      `json:"retryOfRunId"`
	Status              string          `json:"status"`
	Phase               *string         `json:"phase"`
	StopRequested       bool            `json:"stopRequested"`
	Model               RunModelDTO     `json:"model"`
	Reasoning           RunReasoningDTO `json:"reasoning"`
	PromptVersion       string          `json:"promptVersion"`
	RetrievalVersion    string          `json:"retrievalVersion"`
	RewriteFallback     bool            `json:"rewriteFallback"`
	KnowledgeState      string          `json:"knowledgeState"`
	EvidenceState       *string         `json:"evidenceState"`
	Usage               RunUsageDTO     `json:"usage"`
	Timings             RunTimingsDTO   `json:"timings"`
	ProvidedSourceCount int             `json:"providedSourceCount"`
	CitationCount       int             `json:"citationCount"`
	LastSequence        int64           `json:"lastSequence"`
	CanStop             bool            `json:"canStop"`
	CanRetry            bool            `json:"canRetry"`
	Error               *RunErrorDTO    `json:"error"`
	CreatedAt           time.Time       `json:"createdAt"`
	StartedAt           *time.Time      `json:"startedAt"`
	FinishedAt          *time.Time      `json:"finishedAt"`
}

type RunModelDTO struct {
	ContextWindow       int       `json:"contextWindow"`
	ID                  uuid.UUID `json:"id"`
	DisplayName         string    `json:"displayName"`
	UpstreamModelID     string    `json:"upstreamModelId"`
	ProviderID          uuid.UUID `json:"providerId"`
	ProviderDisplayName string    `json:"providerDisplayName"`
}

type RunReasoningDTO struct {
	Reasoning   string `json:"reasoning"`
	DisplayName string `json:"displayName"`
}

type AssistantConversationDTO struct {
	ID                 uuid.UUID      `json:"id"`
	Title              string         `json:"title"`
	TitleOrigin        string         `json:"titleOrigin"`
	FolderID           *uuid.UUID     `json:"folderId"`
	Pinned             bool           `json:"pinned"`
	PinnedAt           *time.Time     `json:"pinnedAt"`
	Archived           bool           `json:"archived"`
	ModelID            *uuid.UUID     `json:"modelId"`
	ModelAvailable     bool           `json:"modelAvailable"`
	Reasoning          string         `json:"reasoning"`
	LatestRun          *RunSummaryDTO `json:"latestRun"`
	LastMessagePreview *string        `json:"lastMessagePreview"`
	CreatedAt          time.Time      `json:"createdAt"`
	UpdatedAt          time.Time      `json:"updatedAt"`
}

type AssistantMessageDTO struct {
	ID                  uuid.UUID        `json:"id"`
	ConversationID      uuid.UUID        `json:"conversationId"`
	Sequence            int64            `json:"sequence"`
	Role                string           `json:"role"`
	Content             string           `json:"content"`
	ReasoningContent    *string          `json:"reasoningContent"`
	ReasoningDurationMS *int64           `json:"reasoningDurationMs"`
	Status              string           `json:"status"`
	CurrentRun          *AssistantRunDTO `json:"currentRun"`
	Citations           []CitationRefDTO `json:"citations"`
	CreatedAt           time.Time        `json:"createdAt"`
	CompletedAt         *time.Time       `json:"completedAt"`
}

type RunStartResponseDTO struct {
	Conversation     AssistantConversationDTO `json:"conversation"`
	UserMessage      AssistantMessageDTO      `json:"userMessage"`
	AssistantMessage AssistantMessageDTO      `json:"assistantMessage"`
	Run              AssistantRunDTO          `json:"run"`
	IdempotentReplay bool                     `json:"idempotentReplay"`
}

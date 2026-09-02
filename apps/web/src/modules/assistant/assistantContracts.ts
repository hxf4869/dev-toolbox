export type UUID = string
export type UTCDateTime = string

export type Reasoning = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ConfiguredReasoning = Exclude<Reasoning, 'off'>
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped'
export type RunPhase = 'rewrite' | 'embedding' | 'retrieval' | 'answer' | 'finalizing'
export type SourceKind = 'title' | 'metadata' | 'raw_text' | 'code' | 'ai_text' | 'image_text'
export type KnowledgeStatus = 'unconfigured' | 'indexing' | 'ready' | 'failed' | 'disabled'
export type SensitivePolicy = 'block' | 'redact' | 'allow'
export type EvidenceState = 'matched' | 'not_found' | 'unavailable'

export interface ReasoningOptionDTO {
  reasoning: Reasoning
  displayName: string
  sortOrder: number
}

export interface ConfiguredReasoningOptionDTO {
  reasoning: ConfiguredReasoning
  displayName: string
  sortOrder: number
}

export interface AssistantModelDTO {
  id: UUID
  displayName: string
  upstreamModelId: string
  provider: {
    id: UUID
    displayName: string
  }
  reasoningOptions: ReasoningOptionDTO[]
  lastReasoning: Reasoning
}

export interface KnowledgeIndexStatusDTO {
  status: KnowledgeStatus
  available: boolean
  generation: number | null
  sensitivePolicy: SensitivePolicy
  counts: {
    active: number
    ready: number
    pending: number
    running: number
    failed: number
    excluded: number
  }
  lastErrorCode: string | null
  updatedAt: UTCDateTime | null
}

export interface AssistantBootstrapDTO {
  models: AssistantModelDTO[]
  newConversationSelection: {
    modelId: UUID | null
    reasoning: Reasoning
    required: boolean
    reason: 'first_use' | 'last_model_unavailable' | 'no_available_model' | null
  }
  knowledge: KnowledgeIndexStatusDTO
}

export interface EmbeddingSettingsDTO {
  configured: boolean
  displayName: string | null
  baseUrl: string | null
  apiKeyConfigured: boolean
  apiKeyTail: string | null
  modelId: string | null
  dimensions: number | null
  enabled: boolean
  generation: number | null
  status: KnowledgeStatus
  activeFragmentCount: number
  updatedAt: UTCDateTime | null
}

export interface PutEmbeddingSettingsRequestDTO {
  displayName: string
  baseUrl: string
  apiKey: string | null
  modelId: string
  dimensions: number
  enabled: boolean
  confirmReindex: boolean
}

export interface TestEmbeddingSettingsRequestDTO {
  baseUrl: string
  apiKey: string | null
  modelId: string
  dimensions: number
}

export interface TestEmbeddingSettingsResponseDTO {
  status: 'ok'
  actualDimensions: number
  latencyMs: number
  usage: {
    inputTokens: number | null
    totalTokens: number | null
  } | null
}

export interface IndexFailureDTO {
  fragmentId: UUID
  itemId: UUID
  itemTitle: string
  sourceKind: SourceKind
  attempt: number
  errorCode: string
  updatedAt: UTCDateTime
}

export interface IndexFailureListDTO {
  items: IndexFailureDTO[]
  nextCursor: string | null
}

export interface AssistantFolderDTO {
  id: UUID
  name: string
  conversationCount: number
  createdAt: UTCDateTime
  updatedAt: UTCDateTime
}

export interface RunErrorDTO {
  code: string
  message: string
}

export interface RunSummaryDTO {
  id: UUID
  status: RunStatus
  phase: RunPhase | null
  stopRequested: boolean
  canStop: boolean
  canRetry: boolean
  error: RunErrorDTO | null
  createdAt: UTCDateTime
  finishedAt: UTCDateTime | null
}

export interface CitationRefDTO {
  runId: UUID
  sourceOrdinal: number
  citationNumber: number
  sourceKind: SourceKind
  sourceClass: 'primary' | 'ai_derived'
  title: string
  availability: 'available' | 'unavailable'
}

export interface AssistantConversationDTO {
  id: UUID
  title: string
  titleOrigin: 'provisional' | 'generated' | 'user'
  folderId: UUID | null
  pinned: boolean
  pinnedAt: UTCDateTime | null
  archived: boolean
  modelId: UUID | null
  modelAvailable: boolean
  reasoning: Reasoning
  latestRun: RunSummaryDTO | null
  lastMessagePreview: string | null
  createdAt: UTCDateTime
  updatedAt: UTCDateTime
}

export interface AssistantRunDTO {
  id: UUID
  conversationId: UUID
  inputMessageId: UUID
  outputMessageId: UUID
  clientRequestId: UUID
  retryOfRunId: UUID | null
  status: RunStatus
  phase: RunPhase | null
  stopRequested: boolean
  model: {
    id: UUID
    displayName: string
    upstreamModelId: string
    providerId: UUID
    providerDisplayName: string
  }
  reasoning: {
    reasoning: Reasoning
    displayName: string
  }
  promptVersion: string
  retrievalVersion: string
  rewriteFallback: boolean
  knowledgeState: 'ready' | 'unavailable'
  evidenceState: EvidenceState | null
  usage: {
    rewriteInputTokens: number | null
    rewriteOutputTokens: number | null
    answerInputTokens: number | null
    answerOutputTokens: number | null
  }
  timings: {
    rewriteMs: number | null
    embeddingMs: number | null
    retrievalMs: number | null
    reasoningMs: number | null
    answerMs: number | null
    totalMs: number | null
  }
  providedSourceCount: number
  citationCount: number
  lastSequence: number
  canStop: boolean
  canRetry: boolean
  error: RunErrorDTO | null
  createdAt: UTCDateTime
  startedAt: UTCDateTime | null
  finishedAt: UTCDateTime | null
}

export interface AssistantMessageDTO {
  id: UUID
  conversationId: UUID
  sequence: number
  role: 'user' | 'assistant'
  content: string
  reasoningContent: string | null
  reasoningDurationMs: number | null
  status: 'complete' | 'streaming' | 'stopped' | 'failed'
  currentRun: AssistantRunDTO | null
  citations: CitationRefDTO[]
  createdAt: UTCDateTime
  completedAt: UTCDateTime | null
}

export interface AssistantSourceDTO extends CitationRefDTO {
  currentTitle: string | null
  titleChanged: boolean
  excerpt: string | null
  locator: {
    itemId: UUID
    href: string
    fragmentId: UUID | null
    rawRecordId: UUID | null
    artifactId: UUID | null
    ordinal: number | null
    startByte: number | null
    endByte: number | null
  } | null
}

export interface RunStartResponseDTO {
  conversation: AssistantConversationDTO
  userMessage: AssistantMessageDTO
  assistantMessage: AssistantMessageDTO
  run: AssistantRunDTO
  idempotentReplay: boolean
}

export interface TemporaryHistoryMessageDTO {
  role: 'user' | 'assistant'
  content: string
}

export interface TemporarySummaryDTO {
  confirmedFacts: string[]
  corrections: string[]
  rejectedHypotheses: string[]
  unresolvedQuestions: string[]
}

export interface TemporaryStreamRequestDTO {
  clientRequestId: UUID
  modelId: UUID
  reasoning: Reasoning
  summary: TemporarySummaryDTO | null
  messages: TemporaryHistoryMessageDTO[]
  content: string
}

export type TemporarySourceDTO = Omit<AssistantSourceDTO, 'runId'>

export interface RunStartRequestDTO {
  clientRequestId: UUID
  conversationId: UUID | null
  folderId?: UUID | null
  content: string
  modelId: UUID
  reasoning: Reasoning
}

export interface RunRetryRequestDTO {
  clientRequestId: UUID
  modelId: UUID
  reasoning: Reasoning
}

export interface AssistantConversationListDTO {
  items: AssistantConversationDTO[]
  nextCursor: string | null
}

export interface AssistantMessageListDTO {
  items: AssistantMessageDTO[]
  nextCursor: string | null
}

export interface AssistantFolderListDTO {
  items: AssistantFolderDTO[]
}

export interface SnapshotEvent {
  lastSequence: number
  run: AssistantRunDTO
  assistantMessage: AssistantMessageDTO
}

export interface RunStatusEvent {
  sequence: number
  status: 'queued' | 'running'
  phase: RunPhase | null
  stopRequested: boolean
}

export interface SourcesReadyEvent {
  sequence: number
  knowledgeState: 'ready' | 'unavailable'
  evidenceState: EvidenceState
  providedSourceCount: number
  rewriteFallback: boolean
}

export interface TemporarySourcesReadyEvent extends SourcesReadyEvent {
  promptVersion: string
  retrievalVersion: string
}

export interface ReasoningDeltaEvent {
  sequence: number
  delta: string
}

export interface ReasoningCompletedEvent {
  sequence: number
  durationMs: number
}

export interface AnswerDeltaEvent {
  sequence: number
  delta: string
}

export interface AnswerCitationEvent {
  sequence: number
  citationNumber: number
  token: string
  source: AssistantSourceDTO
}

export interface TemporaryAnswerCitationEvent {
  sequence: number
  citationNumber: number
  token: string
  source: TemporarySourceDTO
}

export interface UsageUpdatedEvent {
  sequence: number
  usage: AssistantRunDTO['usage']
}

export interface TerminalEvent {
  sequence: number
  run: AssistantRunDTO
}

export interface TemporaryRunStatusEvent {
  sequence: number
  status: 'running'
  phase: RunPhase | null
}

export interface TemporaryTerminalEvent {
  sequence: number
  status: 'succeeded' | 'failed' | 'stopped'
  usage: AssistantRunDTO['usage']
  timings: AssistantRunDTO['timings']
  error: RunErrorDTO | null
  temporarySummary: TemporarySummaryDTO | null
}

export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    requestId: string
    fieldErrors: Array<{ field: string; reason: string }>
  }
}

import type {
  AssistantBootstrapDTO,
  AssistantConversationDTO,
  AssistantFolderDTO,
  AssistantMessageDTO,
  AssistantModelDTO,
  AssistantRunDTO,
  AssistantSourceDTO,
  EmbeddingSettingsDTO,
  KnowledgeIndexStatusDTO,
  RunStartResponseDTO,
  TemporaryStreamRequestDTO,
} from './assistantContracts'
import type { SseEnvelope } from './assistantSse'

export const MOCK_IDS = {
  provider: '11111111-1111-4111-8111-111111111111',
  model: '22222222-2222-4222-8222-222222222222',
  unavailableModel: '22222222-2222-4222-8222-222222222299',
  folder: '33333333-3333-4333-8333-333333333333',
  conversation: '44444444-4444-4444-8444-444444444444',
  archivedConversation: '44444444-4444-4444-8444-444444444445',
  userMessage: '55555555-5555-4555-8555-555555555555',
  assistantMessage: '66666666-6666-4666-8666-666666666666',
  run: '77777777-7777-4777-8777-777777777777',
  request: '88888888-8888-4888-8888-888888888888',
  item: '99999999-9999-4999-8999-999999999999',
  fragment: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const

const now = '2026-09-02T03:00:00Z'

export const assistantModelFixture: AssistantModelDTO = {
  id: MOCK_IDS.model,
  displayName: '工程助手模型',
  upstreamModelId: 'assistant-model-v1',
  contextWindow: 128000,
  provider: { id: MOCK_IDS.provider, displayName: '本地 Mock Provider' },
  reasoningOptions: [
    { reasoning: 'off', displayName: '不思考', sortOrder: -1 },
    { reasoning: 'medium', displayName: '标准', sortOrder: 0 },
    { reasoning: 'high', displayName: '深入', sortOrder: 10 },
  ],
  lastReasoning: 'medium',
}

export const knowledgeFixtures = {
  unconfigured: knowledge('unconfigured', false, null, {
    active: 24,
    ready: 0,
    pending: 0,
    running: 0,
    failed: 0,
    excluded: 0,
  }),
  indexing: knowledge('indexing', false, 2, {
    active: 24,
    ready: 10,
    pending: 11,
    running: 3,
    failed: 0,
    excluded: 2,
  }),
  failed: {
    ...knowledge('failed', false, 2, {
      active: 24,
      ready: 21,
      pending: 0,
      running: 0,
      failed: 3,
      excluded: 2,
    }),
    lastErrorCode: 'EMBEDDING_PROVIDER_UNAVAILABLE',
  },
  readyEmpty: knowledge('ready', true, 2, {
    active: 0,
    ready: 0,
    pending: 0,
    running: 0,
    failed: 0,
    excluded: 0,
  }),
  ready: knowledge('ready', true, 2, {
    active: 24,
    ready: 24,
    pending: 0,
    running: 0,
    failed: 0,
    excluded: 2,
  }),
  disabled: knowledge('disabled', false, 3, {
    active: 24,
    ready: 0,
    pending: 0,
    running: 0,
    failed: 0,
    excluded: 24,
  }),
} satisfies Record<string, KnowledgeIndexStatusDTO>

export const bootstrapFixtures = {
  firstUse: bootstrap({
    knowledge: knowledgeFixtures.ready,
    selection: { modelId: null, reasoning: 'off', required: true, reason: 'first_use' },
  }),
  noModels: bootstrap({
    models: [],
    knowledge: knowledgeFixtures.unconfigured,
    selection: {
      modelId: null,
      reasoning: 'off',
      required: true,
      reason: 'no_available_model',
    },
  }),
  lastModelUnavailable: bootstrap({
    knowledge: knowledgeFixtures.ready,
    selection: {
      modelId: null,
      reasoning: 'off',
      required: true,
      reason: 'last_model_unavailable',
    },
  }),
  embeddingUnconfigured: bootstrap({
    knowledge: knowledgeFixtures.unconfigured,
    selection: {
      modelId: MOCK_IDS.model,
      reasoning: 'medium',
      required: false,
      reason: null,
    },
  }),
  indexing: bootstrap({
    knowledge: knowledgeFixtures.indexing,
    selection: {
      modelId: MOCK_IDS.model,
      reasoning: 'medium',
      required: false,
      reason: null,
    },
  }),
  failed: bootstrap({
    knowledge: knowledgeFixtures.failed,
    selection: {
      modelId: MOCK_IDS.model,
      reasoning: 'medium',
      required: false,
      reason: null,
    },
  }),
  readyEmpty: bootstrap({
    knowledge: knowledgeFixtures.readyEmpty,
    selection: {
      modelId: MOCK_IDS.model,
      reasoning: 'medium',
      required: false,
      reason: null,
    },
  }),
  ready: bootstrap({
    knowledge: knowledgeFixtures.ready,
    selection: {
      modelId: MOCK_IDS.model,
      reasoning: 'medium',
      required: false,
      reason: null,
    },
  }),
} satisfies Record<string, AssistantBootstrapDTO>

export const folderFixture: AssistantFolderDTO = {
  id: MOCK_IDS.folder,
  name: '服务器运维',
  conversationCount: 2,
  createdAt: now,
  updatedAt: now,
}

export const conversationFixture: AssistantConversationDTO = {
  id: MOCK_IDS.conversation,
  title: 'Docker 数据目录迁移',
  titleOrigin: 'generated',
  folderId: MOCK_IDS.folder,
  pinned: true,
  pinnedAt: now,
  archived: false,
  modelId: MOCK_IDS.model,
  modelAvailable: true,
  reasoning: 'medium',
  latestRun: null,
  lastMessagePreview: '如何迁移 Docker 数据目录？',
  createdAt: now,
  updatedAt: now,
}

export const archivedConversationFixture: AssistantConversationDTO = {
  ...conversationFixture,
  id: MOCK_IDS.archivedConversation,
  title: '旧服务器检查清单',
  pinned: false,
  pinnedAt: null,
  archived: true,
}

export const runFixtures = {
  queued: run('queued', null),
  running: run('running', 'answer'),
  succeeded: {
    ...run('succeeded', null),
    evidenceState: 'matched',
    providedSourceCount: 1,
    citationCount: 1,
    lastSequence: 7,
    canStop: false,
    timings: {
      rewriteMs: 42,
      embeddingMs: 18,
      retrievalMs: 9,
      reasoningMs: 820,
      answerMs: 1260,
      totalMs: 2149,
    },
    usage: {
      rewriteInputTokens: 120,
      rewriteOutputTokens: 18,
      answerInputTokens: 980,
      answerOutputTokens: 230,
      answerContextTokens: 18400,
    },
    finishedAt: now,
  },
  failedPartial: {
    ...run('failed', null),
    evidenceState: 'matched',
    providedSourceCount: 1,
    citationCount: 0,
    lastSequence: 5,
    canStop: false,
    canRetry: true,
    error: { code: 'ASSISTANT_PROVIDER_UNAVAILABLE', message: 'Provider 暂时不可用' },
    finishedAt: now,
  },
  stopped: {
    ...run('stopped', null),
    evidenceState: 'unavailable',
    lastSequence: 4,
    canStop: false,
    canRetry: true,
    finishedAt: now,
  },
  notFound: {
    ...run('succeeded', null),
    evidenceState: 'not_found',
    lastSequence: 4,
    canStop: false,
    finishedAt: now,
  },
  unavailable: {
    ...run('succeeded', null),
    knowledgeState: 'unavailable',
    evidenceState: 'unavailable',
    lastSequence: 4,
    canStop: false,
    finishedAt: now,
  },
} satisfies Record<string, AssistantRunDTO>

export const userMessageFixture: AssistantMessageDTO = {
  id: MOCK_IDS.userMessage,
  conversationId: MOCK_IDS.conversation,
  sequence: 1,
  role: 'user',
  content: '如何迁移 Docker 数据目录？',
  reasoningContent: null,
  reasoningDurationMs: null,
  status: 'complete',
  currentRun: null,
  citations: [],
  createdAt: now,
  completedAt: now,
}

export const assistantMessageFixture: AssistantMessageDTO = {
  id: MOCK_IDS.assistantMessage,
  conversationId: MOCK_IDS.conversation,
  sequence: 2,
  role: 'assistant',
  content: '先停止 Docker 服务，再迁移数据目录。[[C1]]',
  reasoningContent: '需要先确认原数据目录和目标磁盘。',
  reasoningDurationMs: 820,
  status: 'complete',
  currentRun: runFixtures.succeeded,
  citations: [
    {
      runId: MOCK_IDS.run,
      sourceOrdinal: 1,
      citationNumber: 1,
      sourceKind: 'raw_text',
      sourceClass: 'primary',
      title: 'Docker 数据目录迁移记录',
      availability: 'available',
    },
  ],
  createdAt: now,
  completedAt: now,
}

export const sourceFixtures = {
  available: {
    runId: MOCK_IDS.run,
    sourceOrdinal: 1,
    citationNumber: 1,
    sourceKind: 'raw_text',
    sourceClass: 'primary',
    title: 'Docker 数据目录迁移记录',
    availability: 'available',
    currentTitle: 'Docker 数据迁移与校验',
    titleChanged: true,
    excerpt: '停止 Docker，复制数据目录，修改 daemon.json 后再启动并检查。',
    locator: {
      itemId: MOCK_IDS.item,
      href: `/items/${MOCK_IDS.item}`,
      fragmentId: MOCK_IDS.fragment,
      rawRecordId: null,
      artifactId: null,
      ordinal: 1,
      startByte: 0,
      endByte: 128,
    },
  },
  aiDerived: {
    runId: MOCK_IDS.run,
    sourceOrdinal: 2,
    citationNumber: 2,
    sourceKind: 'ai_text',
    sourceClass: 'ai_derived',
    title: '磁盘迁移摘要',
    availability: 'available',
    currentTitle: '磁盘迁移摘要',
    titleChanged: false,
    excerpt: '这是根据原始记录生成的摘要。',
    locator: {
      itemId: MOCK_IDS.item,
      href: `/items/${MOCK_IDS.item}`,
      fragmentId: MOCK_IDS.fragment,
      rawRecordId: null,
      artifactId: MOCK_IDS.fragment,
      ordinal: 2,
      startByte: null,
      endByte: null,
    },
  },
  deleted: {
    runId: MOCK_IDS.run,
    sourceOrdinal: 1,
    citationNumber: 1,
    sourceKind: 'raw_text',
    sourceClass: 'primary',
    title: '来源已删除',
    availability: 'unavailable',
    currentTitle: null,
    titleChanged: false,
    excerpt: null,
    locator: null,
  },
} satisfies Record<string, AssistantSourceDTO>

export const persistentStreamFixtures = {
  reasoningAndCitation: [
    snapshot(runFixtures.running, streamingMessage(), 0),
    event('run.status', { sequence: 1, status: 'running', phase: 'answer', stopRequested: false }),
    event('reasoning.delta', { sequence: 2, delta: '正在核对来源。' }),
    event('reasoning.completed', { sequence: 3, durationMs: 820 }),
    event('answer.delta', { sequence: 4, delta: '先停止 Docker 服务。' }),
    event('answer.citation', {
      sequence: 5,
      citationNumber: 1,
      token: '[[C1]]',
      source: sourceFixtures.available,
    }),
    event('usage.updated', { sequence: 6, usage: runFixtures.succeeded.usage }),
    event('run.completed', { sequence: 7, run: runFixtures.succeeded }),
  ],
  reconnectSnapshot: [snapshot(runFixtures.running, streamingMessage('已恢复内容'), 4)],
  duplicateSequence: [
    snapshot(runFixtures.running, streamingMessage(), 2),
    event('answer.delta', { sequence: 2, delta: '不得重复' }),
    event('answer.delta', { sequence: 3, delta: '只追加一次' }),
  ],
  failedPartial: [
    snapshot(runFixtures.running, streamingMessage('已生成的安全部分'), 4),
    event('run.failed', { sequence: 5, run: runFixtures.failedPartial }),
  ],
  stopped: [
    snapshot(runFixtures.running, streamingMessage('停止前的部分'), 3),
    event('run.stopped', { sequence: 4, run: runFixtures.stopped }),
  ],
} satisfies Record<string, SseEnvelope[]>

export const temporaryFixture: {
  request: TemporaryStreamRequestDTO
  events: SseEnvelope[]
} = {
  request: {
    clientRequestId: MOCK_IDS.request,
    modelId: MOCK_IDS.model,
    reasoning: 'off',
    summary: null,
    messages: [],
    content: '本次对话不会保存吗？',
  },
  events: [
    event('run.status', { sequence: 1, status: 'running', phase: 'answer' }),
    event('sources.ready', {
      sequence: 2,
      knowledgeState: 'ready',
      evidenceState: 'not_found',
      providedSourceCount: 0,
      rewriteFallback: true,
      promptVersion: 'assistant-answer-v1',
      retrievalVersion: 'hybrid-rrf-v1',
    }),
    event('answer.delta', { sequence: 3, delta: '不会保存到 Dev Toolbox。' }),
    event('run.completed', {
      sequence: 4,
      status: 'succeeded',
      usage: runFixtures.succeeded.usage,
      timings: runFixtures.succeeded.timings,
      error: null,
      temporarySummary: null,
    }),
  ],
}

export const folderDeletionFixtures = {
  unfile: {
    request: { conversationAction: 'unfile' as const },
    expectedConversation: { ...conversationFixture, folderId: null },
  },
  permanentDelete: {
    request: { conversationAction: 'delete' as const },
    expectedConversationIds: [] as string[],
    requiresSecondConfirmation: true,
  },
}

export const embeddingSettingsFixtures = {
  unconfigured: {
    configured: false,
    displayName: null,
    baseUrl: null,
    apiKeyConfigured: false,
    apiKeyTail: null,
    modelId: null,
    dimensions: null,
    enabled: false,
    generation: null,
    status: 'unconfigured',
    activeFragmentCount: 24,
    updatedAt: null,
  },
  ready: {
    configured: true,
    displayName: '知识向量',
    baseUrl: 'https://provider.example.test/v1',
    apiKeyConfigured: true,
    apiKeyTail: '1234',
    modelId: 'text-embedding-3-large',
    dimensions: 3072,
    enabled: true,
    generation: 2,
    status: 'ready',
    activeFragmentCount: 24,
    updatedAt: now,
  },
} satisfies Record<string, EmbeddingSettingsDTO>

export const runStartFixture: RunStartResponseDTO = {
  conversation: conversationFixture,
  userMessage: userMessageFixture,
  assistantMessage: streamingMessage(),
  run: runFixtures.queued,
  idempotentReplay: false,
}

function knowledge(
  status: KnowledgeIndexStatusDTO['status'],
  available: boolean,
  generation: number | null,
  counts: KnowledgeIndexStatusDTO['counts'],
): KnowledgeIndexStatusDTO {
  return {
    status,
    available,
    generation,
    sensitivePolicy: 'redact',
    counts,
    lastErrorCode: null,
    updatedAt: now,
  }
}

function bootstrap(options: {
  models?: AssistantModelDTO[]
  knowledge: KnowledgeIndexStatusDTO
  selection: AssistantBootstrapDTO['newConversationSelection']
}): AssistantBootstrapDTO {
  return {
    models: options.models ?? [assistantModelFixture],
    newConversationSelection: options.selection,
    knowledge: options.knowledge,
  }
}

function run(status: AssistantRunDTO['status'], phase: AssistantRunDTO['phase']): AssistantRunDTO {
  return {
    id: MOCK_IDS.run,
    conversationId: MOCK_IDS.conversation,
    inputMessageId: MOCK_IDS.userMessage,
    outputMessageId: MOCK_IDS.assistantMessage,
    clientRequestId: MOCK_IDS.request,
    retryOfRunId: null,
    status,
    phase,
    stopRequested: false,
    model: {
      id: MOCK_IDS.model,
      displayName: assistantModelFixture.displayName,
      upstreamModelId: assistantModelFixture.upstreamModelId,
      contextWindow: assistantModelFixture.contextWindow,
      providerId: MOCK_IDS.provider,
      providerDisplayName: assistantModelFixture.provider.displayName,
    },
    reasoning: { reasoning: 'medium', displayName: '标准' },
    promptVersion: 'assistant-answer-v1',
    retrievalVersion: 'hybrid-rrf-v1',
    rewriteFallback: false,
    knowledgeState: 'ready',
    evidenceState: null,
    usage: {
      rewriteInputTokens: null,
      rewriteOutputTokens: null,
      answerInputTokens: null,
      answerOutputTokens: null,
      answerContextTokens: null,
    },
    timings: {
      rewriteMs: null,
      embeddingMs: null,
      retrievalMs: null,
      reasoningMs: null,
      answerMs: null,
      totalMs: null,
    },
    providedSourceCount: 0,
    citationCount: 0,
    lastSequence: 0,
    canStop: status === 'queued' || status === 'running',
    canRetry: false,
    error: null,
    createdAt: now,
    startedAt: status === 'queued' ? null : now,
    finishedAt: null,
  }
}

function streamingMessage(content = ''): AssistantMessageDTO {
  return {
    id: MOCK_IDS.assistantMessage,
    conversationId: MOCK_IDS.conversation,
    sequence: 2,
    role: 'assistant',
    content,
    reasoningContent: null,
    reasoningDurationMs: null,
    status: 'streaming',
    currentRun: runFixtures.running,
    citations: [],
    createdAt: now,
    completedAt: null,
  }
}

function snapshot(
  runValue: AssistantRunDTO,
  assistantMessage: AssistantMessageDTO,
  lastSequence: number,
): SseEnvelope {
  return {
    type: 'snapshot',
    data: { lastSequence, run: runValue, assistantMessage },
  }
}

function event(type: string, data: unknown): SseEnvelope {
  const sequence = (data as { sequence?: number }).sequence
  return { type, data, ...(sequence === undefined ? {} : { id: String(sequence) }) }
}

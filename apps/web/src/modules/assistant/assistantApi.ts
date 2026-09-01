import { ApiError, apiRequest, jsonRequest, type ApiErrorBody } from '../../lib/api'
import type {
  AssistantBootstrapDTO,
  AssistantConversationDTO,
  AssistantConversationListDTO,
  AssistantFolderDTO,
  AssistantFolderListDTO,
  AssistantMessageListDTO,
  AssistantRunDTO,
  AssistantSourceDTO,
  EmbeddingSettingsDTO,
  IndexFailureListDTO,
  KnowledgeIndexStatusDTO,
  PutEmbeddingSettingsRequestDTO,
  Reasoning,
  RunRetryRequestDTO,
  RunStartRequestDTO,
  RunStartResponseDTO,
  TemporaryStreamRequestDTO,
  TestEmbeddingSettingsRequestDTO,
  TestEmbeddingSettingsResponseDTO,
  UUID,
} from './assistantContracts'
import { parseSseStream, type SseEnvelope } from './assistantSse'

export interface ConversationListQuery {
  view?: 'active' | 'archived'
  folderId?: UUID | 'unfiled'
  cursor?: string
  limit?: number
}

export interface MessageListQuery {
  before?: string
  limit?: number
}

export interface ConversationPatchRequest {
  title?: string
  folderId?: UUID | null
  pinned?: boolean
  archived?: boolean
  modelId?: UUID
  reasoning?: Reasoning
}

export interface AssistantApi {
  getBootstrap(): Promise<AssistantBootstrapDTO>
  getEmbeddingSettings(): Promise<EmbeddingSettingsDTO>
  putEmbeddingSettings(value: PutEmbeddingSettingsRequestDTO): Promise<EmbeddingSettingsDTO>
  deleteEmbeddingSettings(): Promise<void>
  testEmbeddingSettings(
    value: TestEmbeddingSettingsRequestDTO,
  ): Promise<TestEmbeddingSettingsResponseDTO>
  getIndexStatus(): Promise<KnowledgeIndexStatusDTO>
  getIndexFailures(cursor?: string, limit?: number): Promise<IndexFailureListDTO>
  retryIndexFailure(fragmentId: UUID): Promise<{ fragmentId: UUID; state: 'pending' }>
  getFolders(): Promise<AssistantFolderListDTO>
  createFolder(name: string): Promise<AssistantFolderDTO>
  renameFolder(id: UUID, name: string): Promise<AssistantFolderDTO>
  deleteFolder(id: UUID, conversationAction: 'unfile' | 'delete'): Promise<void>
  getConversations(query?: ConversationListQuery): Promise<AssistantConversationListDTO>
  getConversation(id: UUID): Promise<AssistantConversationDTO>
  patchConversation(id: UUID, value: ConversationPatchRequest): Promise<AssistantConversationDTO>
  deleteConversation(id: UUID): Promise<void>
  getMessages(id: UUID, query?: MessageListQuery): Promise<AssistantMessageListDTO>
  startRun(value: RunStartRequestDTO): Promise<RunStartResponseDTO>
  getRun(id: UUID): Promise<AssistantRunDTO>
  stopRun(id: UUID): Promise<AssistantRunDTO>
  retryRun(id: UUID, value: RunRetryRequestDTO): Promise<RunStartResponseDTO>
  getSource(runId: UUID, citationNumber: number): Promise<AssistantSourceDTO>
  streamPersistentRun(
    runId: UUID,
    options: { afterSequence?: number; signal: AbortSignal },
  ): AsyncGenerator<SseEnvelope>
  streamTemporaryRun(
    value: TemporaryStreamRequestDTO,
    signal: AbortSignal,
  ): AsyncGenerator<SseEnvelope>
}

export function createAssistantApi(csrfToken: () => string): AssistantApi {
  return {
    getBootstrap: () => apiRequest('/api/v1/assistant/bootstrap'),
    getEmbeddingSettings: () => apiRequest('/api/v1/assistant/embedding-settings'),
    putEmbeddingSettings: (value) =>
      apiRequest(
        '/api/v1/assistant/embedding-settings',
        jsonRequest('PUT', value, csrfToken()),
      ),
    deleteEmbeddingSettings: () =>
      apiRequest('/api/v1/assistant/embedding-settings', {
        method: 'DELETE',
        headers: csrfHeaders(csrfToken()),
      }),
    testEmbeddingSettings: (value) =>
      apiRequest(
        '/api/v1/assistant/embedding-settings/test',
        jsonRequest('POST', value, csrfToken()),
      ),
    getIndexStatus: () => apiRequest('/api/v1/assistant/index-status'),
    getIndexFailures: (cursor, limit) =>
      apiRequest(withQuery('/api/v1/assistant/index-failures', { cursor, limit })),
    retryIndexFailure: (fragmentId) =>
      apiRequest(`/api/v1/assistant/index-failures/${encodeURIComponent(fragmentId)}/retry`, {
        method: 'POST',
        headers: csrfHeaders(csrfToken()),
      }),
    getFolders: () => apiRequest('/api/v1/assistant/folders'),
    createFolder: (name) =>
      apiRequest(
        '/api/v1/assistant/folders',
        jsonRequest('POST', { name }, csrfToken()),
      ),
    renameFolder: (id, name) =>
      apiRequest(
        `/api/v1/assistant/folders/${encodeURIComponent(id)}`,
        jsonRequest('PATCH', { name }, csrfToken()),
      ),
    deleteFolder: (id, conversationAction) =>
      apiRequest(`/api/v1/assistant/folders/${encodeURIComponent(id)}`, {
        ...jsonRequest('DELETE', { conversationAction }, csrfToken()),
      }),
    getConversations: (query = {}) =>
      apiRequest(
        withQuery('/api/v1/assistant/conversations', {
          view: query.view,
          folderId: query.folderId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      ),
    getConversation: (id) =>
      apiRequest(`/api/v1/assistant/conversations/${encodeURIComponent(id)}`),
    patchConversation: (id, value) =>
      apiRequest(
        `/api/v1/assistant/conversations/${encodeURIComponent(id)}`,
        jsonRequest('PATCH', value, csrfToken()),
      ),
    deleteConversation: (id) =>
      apiRequest(`/api/v1/assistant/conversations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: csrfHeaders(csrfToken()),
      }),
    getMessages: (id, query = {}) =>
      apiRequest(
        withQuery(`/api/v1/assistant/conversations/${encodeURIComponent(id)}/messages`, {
          before: query.before,
          limit: query.limit,
        }),
      ),
    startRun: (value) =>
      apiRequest(
        '/api/v1/assistant/runs',
        jsonRequest('POST', value, csrfToken()),
      ),
    getRun: (id) => apiRequest(`/api/v1/assistant/runs/${encodeURIComponent(id)}`),
    stopRun: (id) =>
      apiRequest(`/api/v1/assistant/runs/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
        headers: csrfHeaders(csrfToken()),
      }),
    retryRun: (id, value) =>
      apiRequest(
        `/api/v1/assistant/runs/${encodeURIComponent(id)}/retry`,
        jsonRequest('POST', value, csrfToken()),
      ),
    getSource: (runId, citationNumber) =>
      apiRequest(
        `/api/v1/assistant/runs/${encodeURIComponent(runId)}/sources/${citationNumber}`,
      ),
    streamPersistentRun: (runId, options) =>
      openEventStream(
        withQuery(`/api/v1/assistant/runs/${encodeURIComponent(runId)}/events`, {
          after: options.afterSequence,
        }),
        { method: 'GET', signal: options.signal },
      ),
    streamTemporaryRun: (value, signal) =>
      openEventStream('/api/v1/assistant/temporary/stream', {
        ...jsonRequest('POST', value, csrfToken()),
        signal,
      }),
  }
}

async function* openEventStream(
  path: string,
  init: RequestInit,
): AsyncGenerator<SseEnvelope> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'text/event-stream',
      ...init.headers,
    },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody
    throw new ApiError(response.status, body)
  }
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.toLocaleLowerCase().startsWith('text/event-stream')) {
    throw new Error('Assistant SSE 响应类型无效')
  }
  if (!response.body) throw new Error('Assistant SSE 响应缺少流正文')
  yield* parseSseStream(response.body)
}

function withQuery(
  path: string,
  values: Record<string, string | number | undefined>,
) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

function csrfHeaders(token: string) {
  return token ? { 'X-CSRF-Token': token } : undefined
}

/**
 * 阿里云翻译链路的浏览器 API client（docs/11 §8.5、§9、§10.2）。
 *
 * 只访问 /api/v1/aliyun/* 端点；正文、译文、permitToken 不进 URL、不写日志。
 * 错误沿用应用 envelope，并保留稳定错误码与 details（PREFLIGHT_CHANGED 需要）。
 */

import type {
  AliyunUsageSnapshot,
  PreflightPlan,
  QueueTicketClaimResponse,
  QueueTicketSnapshot,
  TranslationChunkResponse,
  TranslationLanguagesResponse,
  TranslationEngine,
} from './contracts'

export interface TranslateApiErrorBody {
  error?: {
    code?: string
    message?: string
    details?: Record<string, unknown>
    requestId?: string
  }
}

export class TranslateApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>
  readonly requestId?: string

  constructor(status: number, body: TranslateApiErrorBody) {
    super(body.error?.message || '请求未成功，请稍后重试')
    this.name = 'TranslateApiError'
    this.status = status
    this.code = body.error?.code || 'UNKNOWN_ERROR'
    this.details = body.error?.details ?? {}
    this.requestId = body.error?.requestId
  }
}

/** 与 lib/api 的 apiRequest 同构，但保留 error.details 供稳定码映射使用。 */
async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  })
  if (response.status === 204) return undefined as T
  const body = (await response.json().catch(() => ({}))) as TranslateApiErrorBody | T
  if (!response.ok) throw new TranslateApiError(response.status, body as TranslateApiErrorBody)
  return body as T
}

function jsonInit(options: {
  method: string
  body?: unknown
  csrfToken?: string
  extraHeaders?: Record<string, string>
  signal?: AbortSignal
  keepalive?: boolean
}): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.csrfToken) headers['X-CSRF-Token'] = options.csrfToken
  for (const [key, value] of Object.entries(options.extraHeaders ?? {})) {
    headers[key] = value
  }
  return {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    keepalive: options.keepalive,
  }
}

export function fetchTranslationLanguages(): Promise<TranslationLanguagesResponse> {
  return requestJson<TranslationLanguagesResponse>('/api/v1/aliyun/translation/languages')
}

/** 页面头部“本地保护账本”额度摘要；不携带任何内容参数。 */
export function fetchUsageCurrent(): Promise<AliyunUsageSnapshot> {
  return requestJson<AliyunUsageSnapshot>('/api/v1/aliyun/usage/current')
}

export interface TranslationPreflightInput {
  sourceLanguage: string
  targetLanguage: string
  chunkUnits: number[]
}

export function preflightTranslation(
  input: TranslationPreflightInput,
  csrfToken: string,
): Promise<PreflightPlan> {
  return requestJson<PreflightPlan>(
    '/api/v1/aliyun/preflight',
    jsonInit({
      method: 'POST',
      body: { operation: 'translation', ...input },
      csrfToken,
    }),
  )
}

export function createQueueTicket(csrfToken: string): Promise<QueueTicketSnapshot> {
  return requestJson<QueueTicketSnapshot>(
    '/api/v1/aliyun/queue-tickets',
    jsonInit({ method: 'POST', body: { operation: 'translation' }, csrfToken }),
  )
}

export function getQueueTicket(ticketId: string): Promise<QueueTicketSnapshot> {
  return requestJson<QueueTicketSnapshot>(`/api/v1/aliyun/queue-tickets/${ticketId}`)
}

export function claimQueueTicket(
  ticketId: string,
  csrfToken: string,
): Promise<QueueTicketClaimResponse> {
  return requestJson<QueueTicketClaimResponse>(
    `/api/v1/aliyun/queue-tickets/${ticketId}/claim`,
    jsonInit({ method: 'POST', csrfToken }),
  )
}

export function deleteQueueTicket(
  ticketId: string,
  csrfToken: string,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  return requestJson<void>(
    `/api/v1/aliyun/queue-tickets/${ticketId}`,
    jsonInit({ method: 'DELETE', csrfToken, keepalive: options.keepalive }),
  )
}

export interface TranslationChunkRequest {
  ticketId: string
  permitToken: string
  csrfToken: string
  idempotencyKey: string
  sourceText: string
  sourceLanguage: string
  targetLanguage: string
  expectedEngine: TranslationEngine
  signal?: AbortSignal
}

export function postTranslationChunk(
  request: TranslationChunkRequest,
): Promise<TranslationChunkResponse> {
  const { ticketId, permitToken, csrfToken, idempotencyKey, signal, ...body } = request
  return requestJson<TranslationChunkResponse>(
    '/api/v1/aliyun/translation/chunks',
    jsonInit({
      method: 'POST',
      body,
      csrfToken,
      signal,
      extraHeaders: {
        'Idempotency-Key': idempotencyKey,
        'X-Cloud-Permit': permitToken,
      },
    }),
  )
}

/** 每个片段尝试使用新的幂等键；手动重试同样走这里生成新键。 */
export function createIdempotencyKey(): string {
  const webCrypto = globalThis.crypto
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID()
  if (typeof webCrypto?.getRandomValues !== 'function') {
    throw new Error('当前浏览器无法生成安全请求标识，请升级浏览器后重试。')
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

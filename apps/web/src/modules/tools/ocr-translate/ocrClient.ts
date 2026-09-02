/**
 * 阿里云通用文字识别的浏览器 API client（docs/11 §9、§11、§13）。
 *
 * 只访问 /api/v1/aliyun/*；图片以 multipart 单个 image part 上传，禁止 URL 或
 * base64 JSON。permitToken、图片与识别文本不进 URL、不写日志、不落存储。
 * 错误 envelope 与 V2.1 共用（TranslateApiError），稳定错误码到 OCR UI 动作的
 * 映射在本模块单独维护（文案面向“图片识别”，不是翻译片段）。
 */

import { ALIYUN_FAILURE_CATEGORY_LABELS } from '../../settings/aliyunContracts'
import { createIdempotencyKey, TranslateApiError } from '../translate/translateClient'

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  })
  if (response.status === 204) return undefined as T
  const body = (await response.json().catch(() => ({}))) as T | { error?: { code?: string; message?: string } }
  if (!response.ok) throw new TranslateApiError(response.status, body as { error?: { code?: string; message?: string } })
  return body as T
}

function jsonInit(options: {
  method: string
  body?: unknown
  csrfToken?: string
  keepalive?: boolean
}): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.csrfToken) headers['X-CSRF-Token'] = options.csrfToken
  return {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    keepalive: options.keepalive,
  }
}

export interface OcrPreflightPlan {
  operation: 'ocr'
  month: string
  resetAt: string
  totals: {
    meter: 'ocr_general'
    chunks: number
    units: number
    limit: number
    used: number
    reserved: number
    remainingBefore: number
    remainingAfterPlan: number
  }[]
}

/** 预检：预计 1 次云 OCR 调用，不携带图片、不预留（docs/11 §9.1）。 */
export function preflightOcr(csrfToken: string): Promise<OcrPreflightPlan> {
  return requestJson<OcrPreflightPlan>(
    '/api/v1/aliyun/preflight',
    jsonInit({ method: 'POST', body: { operation: 'ocr', units: 1 }, csrfToken }),
  )
}

export interface OcrQueueTicketSnapshot {
  ticketId: string
  operation: 'ocr'
  status: 'waiting' | 'ready' | 'active' | 'expired' | 'cancelled'
  position?: number
  expiresAt?: string
  claimBy?: string
}

export function createOcrQueueTicket(csrfToken: string): Promise<OcrQueueTicketSnapshot> {
  return requestJson<OcrQueueTicketSnapshot>(
    '/api/v1/aliyun/queue-tickets',
    jsonInit({ method: 'POST', body: { operation: 'ocr' }, csrfToken }),
  )
}

export function getOcrQueueTicket(ticketId: string): Promise<OcrQueueTicketSnapshot> {
  return requestJson<OcrQueueTicketSnapshot>(`/api/v1/aliyun/queue-tickets/${ticketId}`)
}

export interface OcrQueueTicketClaimResponse {
  ticketId: string
  status: 'active'
  permitToken: string
  idleExpiresAt: string
  absoluteExpiresAt: string
}

export function claimOcrQueueTicket(
  ticketId: string,
  csrfToken: string,
): Promise<OcrQueueTicketClaimResponse> {
  return requestJson<OcrQueueTicketClaimResponse>(
    `/api/v1/aliyun/queue-tickets/${ticketId}/claim`,
    jsonInit({ method: 'POST', csrfToken }),
  )
}

export function deleteOcrQueueTicket(
  ticketId: string,
  csrfToken: string,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  return requestJson<void>(
    `/api/v1/aliyun/queue-tickets/${ticketId}`,
    jsonInit({ method: 'DELETE', csrfToken, keepalive: options.keepalive }),
  )
}

export interface OcrResponse {
  text: string
  upstreamRequestId: string | null
  billableUnits: number
  quota: { meter: 'ocr_general'; remaining: number }
  replayed: boolean
}

export interface CloudOcrRequestInput {
  blob: Blob
  fileName: string
  permitToken: string
  csrfToken: string
  idempotencyKey: string
  signal?: AbortSignal
}

/**
 * 云端重识别上传：multipart/form-data 只含一个 image part（docs/11 §11.1）。
 * 幂等键由调用方在每次新的用户确认后生成（手动重试使用新键）。
 */
export async function postCloudOcr(request: CloudOcrRequestInput): Promise<OcrResponse> {
  const form = new FormData()
  form.append('image', request.blob, request.fileName)
  const response = await fetch('/api/v1/aliyun/ocr', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Idempotency-Key': request.idempotencyKey,
      'X-Cloud-Permit': request.permitToken,
      'X-CSRF-Token': request.csrfToken,
    },
    body: form,
    signal: request.signal,
  })
  const body = (await response.json().catch(() => ({}))) as
    | OcrResponse
    | { error?: { code?: string; message?: string } }
  if (!response.ok) {
    throw new TranslateApiError(response.status, body as { error?: { code?: string; message?: string } })
  }
  return body as OcrResponse
}

export { createIdempotencyKey }

export type OcrCloudErrorKind =
  | 'settings'
  | 'quota'
  | 'manual-retry'
  | 'requeue'
  | 'uncertain'
  | 'plain'

export interface OcrCloudErrorAction {
  kind: OcrCloudErrorKind
  title: string
  detail: string
}

/** 稳定错误码 → 云 OCR 的 UI 动作（docs/11 §13；文案与翻译片段场景区分）。 */
export function describeOcrCloudError(
  code: string,
  status: number,
  details: Record<string, unknown> = {},
): OcrCloudErrorAction {
  if (code === 'ALIYUN_NOT_CONFIGURED') {
    return {
      kind: 'settings',
      title: '阿里云凭据尚未配置',
      detail: '云端重识别需要实例所有者先在设置中保存阿里云 AccessKey；本地识别不受影响，图片与文字仍留在本设备。',
    }
  }
  if (code === 'QUOTA_EXHAUSTED') {
    return {
      kind: 'quota',
      title: '本月云 OCR 额度已用尽',
      detail: '已硬停止，没有继续付费的旁路；请等待下月重置、降低本月其他使用，或到设置页核对本地保护账本。',
    }
  }
  if (code === 'UPSTREAM_RESULT_UNCERTAIN' || details.callStatus === 'uncertain') {
    return {
      kind: 'uncertain',
      title: '结果不确定',
      detail: '该次调用已保守计量、识别结果未收到，不会自动重试；手动重试可能重复计费。',
    }
  }
  if (code === 'NETWORK_ERROR') {
    return {
      kind: 'uncertain',
      title: '结果不确定',
      detail: '网络错误导致无法确认上游是否受理；该次调用按已保守计量处理，不会自动重试；手动重试可能重复计费。',
    }
  }
  if (code === 'UPSTREAM_THROTTLED') {
    return {
      kind: 'manual-retry',
      title: '上游限流',
      detail: '该次调用已按服务端结算状态计量；不会自动重试，可稍后手动重试。',
    }
  }
  if (code === 'UPSTREAM_REJECTED' || code === 'UPSTREAM_UNAVAILABLE') {
    const category = typeof details.failureCategory === 'string' ? details.failureCategory : ''
    const needsSettings = ['credential_invalid', 'permission_denied', 'service_not_open', 'account_arrears'].includes(category)
    const settlement = details.callStatus === 'released'
      ? '本次未扣减本地保护额度。'
      : typeof details.countedUnits === 'number'
        ? `本次已计入本地保护账本 ${details.countedUnits} 次。`
        : '该次调用已按服务端结算状态计量。'
    const requestHint = typeof details.upstreamRequestId === 'string'
      ? ` 上游 RequestId：${details.upstreamRequestId}。`
      : ''
    return {
      kind: needsSettings ? 'settings' : 'manual-retry',
      title: ALIYUN_FAILURE_CATEGORY_LABELS[category] ?? (code === 'UPSTREAM_UNAVAILABLE' ? '上游服务暂不可用' : '上游明确失败'),
      detail: `${settlement}${needsSettings ? '请先处理配置或账号问题，再重新发起识别。' : '可手动重试，重试使用新的请求标识。'}不会自动重试。${requestHint}`,
    }
  }
  if (code === 'CALL_SETTLED_WITHOUT_RESULT') {
    return {
      kind: 'manual-retry',
      title: '调用已结算，但结果未收到',
      detail: '相同请求标识已按保守结果结算，图片与文本不会保存；只能手动发起新请求，可能再次计费。',
    }
  }
  if (code === 'INVALID_INPUT') {
    return {
      kind: 'plain',
      title: '图片未通过服务端校验',
      detail: '服务端在云调用前再次校验类型、大小、宽高与比例；请更换符合 PNG/JPEG/WebP、不超过 5 MiB、最长边不超过 4096 px、宽高大于 15 px 且长短边比小于 50 的图片。',
    }
  }
  if (code === 'QUEUE_FULL') {
    return {
      kind: 'requeue',
      title: '排队已满',
      detail: '当前等待的队列已满；请稍后由你重新发起云端识别。',
    }
  }
  if (code === 'QUEUE_TICKET_NOT_FOUND' || code === 'QUEUE_TICKET_EXPIRED' || code === 'QUEUE_TICKET_CANCELLED') {
    return {
      kind: 'requeue',
      title: '排队凭证已失效',
      detail: '队列凭证不存在、已过期或已取消（服务可能已重启）；需要你重新发起云端识别，不会自动重试。',
    }
  }
  if (code === 'CLOUD_PERMIT_EXPIRED' || code === 'CLOUD_PERMIT_INVALID') {
    return {
      kind: 'requeue',
      title: '云调用许可已失效',
      detail: '需要重新发起云端识别；不会自动重试。',
    }
  }
  if (code === 'CLOUD_PERMIT_BUSY') {
    return {
      kind: 'plain',
      title: '同一调用已有请求在途',
      detail: '当前许可正处理另一个请求；等待其返回即可，不会自动重发。',
    }
  }
  if (code === 'CLOUD_PERMIT_OPERATION_MISMATCH' || code === 'IDEMPOTENCY_KEY_REUSED') {
    return {
      kind: 'plain',
      title: '请求与接口状态不一致',
      detail: '这是客户端问题；不会自动重试，请重新发起云端识别。',
    }
  }
  if (code === 'CALL_IN_PROGRESS') {
    return {
      kind: 'plain',
      title: '同一请求正在处理',
      detail: '该请求已有同标识请求在途；等待返回即可，不会重复上传图片。',
    }
  }
  if (code === 'AUTH_REQUIRED' || code === 'MUTATION_NOT_ALLOWED') {
    return {
      kind: 'plain',
      title: '登录状态已失效',
      detail: '请重新登录后再继续；图片与已识别文字仍保留在本页。',
    }
  }
  return {
    kind: 'plain',
    title: '云端识别未成功',
    detail: `稳定错误码 ${code}（HTTP ${status}）；不会自动重试。`,
  }
}

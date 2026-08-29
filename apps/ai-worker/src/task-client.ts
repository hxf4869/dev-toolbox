export type TaskType = 'organize_record' | 'review_record' | 'analyze_image'

export interface ClaimedRawRecord {
  readonly id: string
  readonly recordRole: string
  readonly contentFormat: string
  readonly body: string
}

export interface ClaimedFragment {
  readonly id: string
  readonly rawRecordId: string
  readonly sourceKind: string
  readonly ordinal: number
  readonly content: string
}

export interface ClaimedAttachment {
  readonly id: string
  readonly kind: 'image' | 'file'
  readonly mediaType: string
  readonly sizeBytes: number
  readonly width: number | null
  readonly height: number | null
}

export interface ClaimedRelatedRecord {
  readonly id: string
  readonly title: string
  readonly summary: string
}

export interface ClaimedTask {
  readonly task: {
    readonly id: string
    readonly type: TaskType
    readonly leaseVersion: number
    readonly promptVersion: string
    readonly schemaVersion: string
    readonly limits: {
      readonly maxTurns: number
      readonly maxToolCalls: number
      readonly deadlineAt: string
    }
  }
  readonly input: {
    readonly itemId: string
    readonly sensitivity: 'normal' | 'sensitive' | 'unknown'
    readonly sensitivePolicy: 'block' | 'redact' | 'allow'
    readonly rawRecords: readonly ClaimedRawRecord[]
    readonly fragments: readonly ClaimedFragment[]
    readonly attachments: readonly ClaimedAttachment[]
    readonly relatedRecords: readonly ClaimedRelatedRecord[]
  }
  readonly provider: {
    readonly protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
    readonly baseUrl: string
    readonly apiKey: string
    readonly modelId: string
    readonly modelName: string
    readonly contextWindow: number
    readonly maxOutputTokens: number
    readonly supportsTools: boolean
    readonly supportsVision: boolean
  }
}

export interface SafeTaskEvent {
  readonly type: 'model_request_started' | 'model_request_finished' | 'tool_started' | 'tool_finished' | 'candidate_received'
  readonly summary?: string
  readonly details: Readonly<Record<string, string | number | boolean | null>>
}

export class TaskClientError extends Error {
  constructor(readonly status: number, readonly code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'TaskClientError'
  }
}

export class TaskClient {
  constructor(
    readonly baseUrl: string,
    readonly serviceToken: string,
    readonly workerId: string,
  ) {}

  async claim(signal?: AbortSignal): Promise<ClaimedTask | null> {
    const response = await this.request('/internal/ai/tasks/claim', {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.status === 204) return null
    const value = await decodeJson(response, 32 * 1024 * 1024)
    if (!isClaimedTask(value)) throw new TaskClientError(502, 'INVALID_CLAIM_RESPONSE')
    return value
  }

  async heartbeat(claim: ClaimedTask, signal?: AbortSignal): Promise<{ readonly cancelRequested: boolean }> {
    return this.jsonRequest(`/internal/ai/tasks/${claim.task.id}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify(this.leaseBody(claim)),
      ...(signal === undefined ? {} : { signal }),
    }, 64 * 1024) as Promise<{ readonly cancelRequested: boolean }>
  }

  async events(claim: ClaimedTask, events: readonly SafeTaskEvent[], signal?: AbortSignal): Promise<void> {
    const response = await this.request(`/internal/ai/tasks/${claim.task.id}/events`, {
      method: 'POST',
      body: JSON.stringify({ ...this.leaseBody(claim), events }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.status !== 204) await throwResponseError(response)
  }

  async attachment(claim: ClaimedTask, attachment: ClaimedAttachment, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(
      `/internal/ai/tasks/${claim.task.id}/attachments/${attachment.id}`,
      {
        method: 'GET',
        headers: {
          'x-worker-id': this.workerId,
          'x-lease-version': String(claim.task.leaseVersion),
        },
        ...(signal === undefined ? {} : { signal }),
      },
    )
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== attachment.mediaType.toLowerCase()) {
      throw new TaskClientError(502, 'ATTACHMENT_MEDIA_TYPE_MISMATCH')
    }
    const bytes = await readBounded(response, attachment.sizeBytes + 1)
    if (bytes.byteLength !== attachment.sizeBytes) {
      throw new TaskClientError(502, 'ATTACHMENT_SIZE_MISMATCH')
    }
    return bytes
  }

  async complete(
    claim: ClaimedTask,
    artifact: Record<string, unknown>,
    usage: { readonly inputTokens: number; readonly outputTokens: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.jsonRequest(`/internal/ai/tasks/${claim.task.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ ...this.leaseBody(claim), artifact, ...usage }),
      ...(signal === undefined ? {} : { signal }),
    }, 4 * 1024 * 1024)
  }

  async fail(
    claim: ClaimedTask,
    errorCode: string,
    errorDetail: string,
    usage: { readonly inputTokens: number; readonly outputTokens: number },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.jsonRequest(`/internal/ai/tasks/${claim.task.id}/fail`, {
      method: 'POST',
      body: JSON.stringify({ ...this.leaseBody(claim), errorCode, errorDetail, ...usage }),
      ...(signal === undefined ? {} : { signal }),
    }, 256 * 1024)
  }

  private leaseBody(claim: ClaimedTask): { readonly workerId: string; readonly leaseVersion: number } {
    return { workerId: this.workerId, leaseVersion: claim.task.leaseVersion }
  }

  private async jsonRequest(path: string, init: RequestInit, maximumBytes: number): Promise<unknown> {
    return decodeJson(await this.request(path, init), maximumBytes)
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      const timeoutSignal = AbortSignal.timeout(15_000)
      const signal = init.signal === undefined || init.signal === null
        ? timeoutSignal
        : AbortSignal.any([init.signal, timeoutSignal])
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
      })
    } catch (error) {
      throw new TaskClientError(0, 'API_UNAVAILABLE', error)
    }
    if (!response.ok) await throwResponseError(response)
    return response
  }
}

async function decodeJson(response: Response, maximumBytes: number): Promise<unknown> {
  const bytes = await readBounded(response, maximumBytes)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    throw new TaskClientError(502, 'INVALID_API_RESPONSE', error)
  }
}

async function throwResponseError(response: Response): Promise<never> {
  let code = 'API_REQUEST_FAILED'
  try {
    const value = await decodeJson(response, 64 * 1024)
    if (isObject(value) && isObject(value.error) && typeof value.error.code === 'string') {
      code = value.error.code
    }
  } catch {
    // Keep the stable local failure code; never surface the response body.
  }
  throw new TaskClientError(response.status, code)
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new TaskClientError(502, 'API_RESPONSE_TOO_LARGE')
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maximumBytes) throw new TaskClientError(502, 'API_RESPONSE_TOO_LARGE')
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function isClaimedTask(value: unknown): value is ClaimedTask {
  if (!isObject(value) || !isObject(value.task) || !isObject(value.input) || !isObject(value.provider)) return false
  const task = value.task
  const input = value.input
  const provider = value.provider
  return (
    typeof task.id === 'string' &&
    (task.type === 'organize_record' || task.type === 'review_record' || task.type === 'analyze_image') &&
    Number.isSafeInteger(task.leaseVersion) &&
    typeof task.promptVersion === 'string' &&
    typeof task.schemaVersion === 'string' &&
    isObject(task.limits) &&
    Number.isSafeInteger(task.limits.maxTurns) &&
    Number.isSafeInteger(task.limits.maxToolCalls) &&
    typeof task.limits.deadlineAt === 'string' &&
    typeof input.itemId === 'string' &&
    Array.isArray(input.rawRecords) && Array.isArray(input.fragments) &&
    Array.isArray(input.attachments) && Array.isArray(input.relatedRecords) &&
    typeof provider.protocol === 'string' && typeof provider.baseUrl === 'string' &&
    typeof provider.apiKey === 'string' && typeof provider.modelId === 'string' &&
    Number.isSafeInteger(provider.contextWindow) && Number.isSafeInteger(provider.maxOutputTokens)
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

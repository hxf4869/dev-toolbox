// Internal client for the assistant Go API (docs/16 §14). Mirrors the
// existing TaskClient transport discipline: bearer service token, bounded
// JSON bodies, manual redirects and stable failure codes.

export class AssistantClientError extends Error {
  constructor(readonly status: number, readonly code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'AssistantClientError'
  }
}

export interface ClaimedAssistantRun {
  readonly run: {
    readonly id: string
    readonly conversationId: string
    readonly outputMessageId: string
    readonly leaseVersion: number
    readonly stopRequested: boolean
    readonly expiresAt: string
  }
  readonly model: {
    readonly id: string
    readonly displayName: string
    readonly upstreamModelId: string
    readonly providerId: string
    readonly providerDisplayName: string
    readonly protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
    readonly baseUrl: string
    readonly apiKey: string
    readonly contextWindow: number
    readonly maxOutputTokens: number
  }
  readonly reasoning: { readonly reasoning: string; readonly displayName: string }
  readonly sensitivePolicy: 'block' | 'redact' | 'allow'
  readonly promptVersion: string
  readonly retrievalVersion: string
  readonly knowledge: {
    readonly state: 'ready' | 'unavailable'
    readonly generation: number | null
    readonly baseUrl: string
    readonly apiKey: string
    readonly modelId: string
    readonly dimensions: number | null
  }
  readonly context: {
    readonly summary: {
      readonly confirmedFacts: readonly string[]
      readonly corrections: readonly string[]
      readonly rejectedHypotheses: readonly string[]
      readonly unresolvedQuestions: readonly string[]
    } | null
    readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
    readonly question: string
  }
}

export interface ClaimedIndexBatch {
  readonly generation: number
  readonly policy: 'block' | 'redact' | 'allow'
  readonly expiresAt: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly modelId: string
  readonly dimensions: number
  readonly fragments: readonly {
    readonly fragmentId: string
    readonly itemId: string
    readonly sourceKind: string
    readonly sensitivity: string
    readonly content: string
    readonly attempt: number
    readonly sourceCreatedAt: string
  }[]
}

export interface RetrievalSourcePayload {
  readonly ordinal: number
  readonly fragmentId: string | null
  readonly itemId: string | null
  readonly sourceKind: string
  readonly sourceClass: 'primary' | 'ai_derived'
  readonly title: string
  readonly content: string
  readonly sensitivity: string
}

export interface AssistantEvent {
  readonly eventId: string
  readonly type: string
  readonly payload: Record<string, unknown>
}

export interface SourceSnapshotInput {
  readonly ordinal: number
  readonly fragmentId: string | null
  readonly itemId: string | null
  readonly sourceKind: string
  readonly sourceClass: 'primary' | 'ai_derived'
  readonly title: string
  readonly content: string
  readonly sensitivity: string
}

export class AssistantClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly workerId: string,
  ) {}

  async claimRun(signal?: AbortSignal): Promise<ClaimedAssistantRun | null> {
    const response = await this.request('/internal/assistant/runs/claim', {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.status === 204) return null
    return validateJson(await readBoundedJson(response, 8 * 1024 * 1024), isClaimedRun)
  }

  async heartbeatRun(runId: string, leaseVersion: number, signal?: AbortSignal): Promise<{ readonly stopRequested: boolean }> {
    return this.jsonRequest(`/internal/assistant/runs/${runId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId, leaseVersion }),
    }, 64 * 1024, signal) as Promise<{ readonly stopRequested: boolean }>
  }

  async retrieval(
    runId: string,
    leaseVersion: number,
    generation: number,
    query: string,
    queryVector: readonly number[],
    signal?: AbortSignal,
  ): Promise<{ readonly knowledgeState: string; readonly evidenceState: string; readonly sources: readonly RetrievalSourcePayload[] }> {
    return this.jsonRequest(`/internal/assistant/runs/${runId}/retrieval`, {
      method: 'POST',
      body: JSON.stringify({
        workerId: this.workerId, leaseVersion, generation, query, queryVector,
      }),
    }, 2 * 1024 * 1024, signal) as Promise<{
      readonly knowledgeState: string
      readonly evidenceState: string
      readonly sources: readonly RetrievalSourcePayload[]
    }>
  }

  async events(runId: string, leaseVersion: number, events: readonly AssistantEvent[], signal?: AbortSignal): Promise<{ readonly stopRequested: boolean; readonly lastSequence: number }> {
    return this.jsonRequest(`/internal/assistant/runs/${runId}/events`, {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId, leaseVersion, events }),
    }, 64 * 1024, signal) as Promise<{ readonly stopRequested: boolean; readonly lastSequence: number }>
  }

  async completeRun(
    runId: string,
    leaseVersion: number,
    usage: Record<string, number | null>,
    timings: Record<string, number | null>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.jsonRequest(`/internal/assistant/runs/${runId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId, leaseVersion, usage, timings }),
    }, 64 * 1024, signal)
  }

  async failRun(
    runId: string,
    leaseVersion: number,
    errorCode: string,
    errorDetail: string,
    usage: Record<string, number | null>,
    timings: Record<string, number | null>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.jsonRequest(`/internal/assistant/runs/${runId}/fail`, {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId, leaseVersion, errorCode, errorDetail, usage, timings }),
    }, 64 * 1024, signal)
  }

  async runTitle(runId: string, title: string, signal?: AbortSignal): Promise<void> {
    await this.jsonRequest(`/internal/assistant/runs/${runId}/title`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }, 8 * 1024, signal)
  }

  async runSummary(runId: string, summary: Record<string, string[]>, throughMessageSequence: number, modelSnapshot: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    await this.jsonRequest(`/internal/assistant/runs/${runId}/summary`, {
      method: 'POST',
      body: JSON.stringify({ summary, throughMessageSequence, modelSnapshot }),
    }, 256 * 1024, signal)
  }

  async claimIndexBatch(signal?: AbortSignal): Promise<ClaimedIndexBatch | null> {
    const response = await this.request('/internal/assistant/index/claim', {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.status === 204) return null
    return validateJson(await readBoundedJson(response, 8 * 1024 * 1024), isClaimedIndexBatch)
  }

  async heartbeatIndex(leases: readonly { fragmentId: string; leaseVersion: number }[], signal?: AbortSignal): Promise<void> {
    await this.jsonRequest('/internal/assistant/index/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId, leases }),
    }, 64 * 1024, signal)
  }

  async completeIndexBatch(
    generation: number,
    policy: string,
    results: readonly { fragmentId: string; leaseVersion: number; embedding: number[]; dimensions: number; sourceCreatedAt: string; sensitivity: string }[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.jsonRequest('/internal/assistant/index/complete', {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId, generation, policy, results }),
    }, 8 * 1024 * 1024, signal)
  }

  async failIndexBatch(
    failures: readonly { fragmentId: string; leaseVersion: number; errorCode: string; errorDetail: string }[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.jsonRequest('/internal/assistant/index/fail', {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId, failures }),
    }, 64 * 1024, signal)
  }

  private async jsonRequest(path: string, init: RequestInit, maximumBytes: number, signal?: AbortSignal): Promise<unknown> {
    const merged: RequestInit = {
      ...init,
      ...(signal === undefined ? {} : init.signal !== undefined && init.signal !== null
        ? {}
        : { signal }),
    }
    return readBoundedJson(await this.request(path, merged), maximumBytes)
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      const timeoutSignal = AbortSignal.timeout(120_000)
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
      throw new AssistantClientError(0, 'API_UNAVAILABLE', error)
    }
    if (!response.ok) await throwResponseError(response)
    return response
  }

  // prepareTemporary performs the rewrite + query embedding phase through the
  // worker; the Go API invokes this endpoint, so the client exposes the call
  // shape for the temporary lane server instead.
}

export async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const bytes = await readBounded(response, maximumBytes)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    throw new AssistantClientError(502, 'INVALID_API_RESPONSE', error)
  }
}

async function throwResponseError(response: Response): Promise<never> {
  let code = 'API_REQUEST_FAILED'
  try {
    const value = await readBoundedJson(response, 64 * 1024)
    if (isObject(value) && isObject(value.error) && typeof value.error.code === 'string') {
      code = value.error.code
    }
  } catch {
    // Keep the stable local failure code; never surface the response body.
  }
  throw new AssistantClientError(response.status, code)
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new AssistantClientError(502, 'API_RESPONSE_TOO_LARGE')
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
      if (total > maximumBytes) throw new AssistantClientError(502, 'API_RESPONSE_TOO_LARGE')
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

function validateJson<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (!guard(value)) throw new AssistantClientError(502, 'INVALID_API_RESPONSE')
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isClaimedRun(value: unknown): value is ClaimedAssistantRun {
  return (
    isObject(value) && isObject(value.run) && isObject(value.model) &&
    isObject(value.reasoning) && isObject(value.knowledge) && isObject(value.context) &&
    typeof value.run.id === 'string' && Number.isSafeInteger(value.run.leaseVersion) &&
    typeof value.model.apiKey === 'string' && typeof value.model.protocol === 'string' &&
    (value.knowledge.state === 'ready' || value.knowledge.state === 'unavailable') &&
    Array.isArray(value.context.messages) && typeof value.context.question === 'string'
  )
}

function isClaimedIndexBatch(value: unknown): value is ClaimedIndexBatch {
  return (
    isObject(value) && isObject(value.fragments) === false && Array.isArray(value.fragments) &&
    Number.isSafeInteger(value.generation) && typeof value.policy === 'string'
  )
}

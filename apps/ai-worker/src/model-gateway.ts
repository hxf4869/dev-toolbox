import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { stream as streamAnthropicRaw, streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { stream as streamOpenAICompletionsRaw, streamSimple as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { stream as streamOpenAIResponsesRaw, streamSimple as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'

const maximumResponseBytes = 4 * 1024 * 1024
const maximumProviderTestWindowMs = 65_000
const maximumEmbeddingResponseBytes = 32 * 1024 * 1024

// V3 assistant: deterministic Anthropic thinking budgets per reasoning level.
// The six contract levels map to fixed budgets; nothing is silently clamped.
const anthropicThinkingBudgets: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
}
const minimumAnswerTokens = 1024

export type ProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface ProviderSnapshot {
  readonly protocol: ProviderProtocol
  readonly baseUrl: string
  readonly apiKey: string
  readonly modelId: string
}

export interface ProviderTestResult {
  readonly status: 'ok'
  readonly latencyMs: number
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null
}

export interface TaskProviderSnapshot extends ProviderSnapshot {
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly supportsTools: boolean
  readonly supportsVision: boolean
}

export interface ProviderTurnRequest {
  readonly provider: TaskProviderSnapshot
  readonly context: Context
  readonly deadlineAt: Date
  readonly maxOutputTokens: number
  readonly allowInsecureHttp: boolean
  readonly signal?: AbortSignal
}

export interface ProviderTurnResult {
  readonly message: AssistantMessage
  readonly attempts: number
}

export type ProviderFailureCategory =
  | 'credentials_invalid'
  | 'unavailable'
  | 'protocol_error'
  | 'capability_mismatch'
  | 'reasoning_unsupported'
  | 'embedding_dimension_mismatch'
  | 'embedding_response_invalid'

export class ProviderGatewayError extends Error {
  constructor(readonly category: ProviderFailureCategory, cause?: unknown) {
    super(category, cause === undefined ? undefined : { cause })
    this.name = 'ProviderGatewayError'
  }
}

export async function testProviderConnection(
  snapshot: ProviderSnapshot,
  deadlineAt: Date,
  allowInsecureHttp: boolean,
): Promise<ProviderTestResult> {
  const baseUrl = normalizeBaseUrl(snapshot.baseUrl, allowInsecureHttp)
  if (!isProtocol(snapshot.protocol) || !snapshot.apiKey || snapshot.apiKey.length > 8192 || !snapshot.modelId || snapshot.modelId.length > 200) {
    throw new ProviderGatewayError('unavailable')
  }
  const remainingMs = deadlineAt.getTime() - Date.now()
  if (remainingMs <= 0 || remainingMs > maximumProviderTestWindowMs) throw new ProviderGatewayError('unavailable')

  const expectedUrl = new URL(endpointFor(snapshot.protocol), `${baseUrl}/`).toString()
  let responseStatus: number | undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), remainingMs)
  const startedAt = performance.now()
  try {
    const model: Model<Api> = {
      id: snapshot.modelId,
      name: snapshot.modelId,
      api: snapshot.protocol,
      provider: 'dev-toolbox-custom',
      baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1,
    }
    const context: Context = {
      systemPrompt: 'This is a connection check. Return exactly OK.',
      messages: [{ role: 'user', content: 'OK', timestamp: Date.now() }],
    }
    const options: SimpleStreamOptions = {
      apiKey: snapshot.apiKey,
      signal: controller.signal,
      maxTokens: 1,
      maxRetries: 0,
      timeoutMs: remainingMs,
      fetch: boundedFetch(expectedUrl, sdkRequestUrl(snapshot.protocol, baseUrl), (status) => {
        responseStatus = status
      }),
      onResponse: (response) => {
        responseStatus = response.status
      },
    }
    const message = await runStream(snapshot.protocol, model, context, options).result()
    ensureSuccessfulMessage(message)
    const totalTokens = message.usage.input + message.usage.output
    return {
      status: 'ok',
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      usage:
        totalTokens > 0
          ? { inputTokens: message.usage.input, outputTokens: message.usage.output }
          : null,
    }
  } catch (error) {
    if (responseStatus === 401 || responseStatus === 403) throw new ProviderGatewayError('credentials_invalid', error)
    throw new ProviderGatewayError('unavailable', error)
  } finally {
    clearTimeout(timeout)
  }
}

export async function runProviderTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
  return runProviderTurnWithAttempts(request, 3)
}

export async function runProviderTurnOnce(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
  return runProviderTurnWithAttempts(request, 1)
}

async function runProviderTurnWithAttempts(
  request: ProviderTurnRequest,
  maximumAttempts: 1 | 3,
): Promise<ProviderTurnResult> {
  const provider = request.provider
  const baseUrl = normalizeBaseUrl(provider.baseUrl, request.allowInsecureHttp)
  if (
    !isProtocol(provider.protocol) ||
    !provider.apiKey ||
    provider.apiKey.length > 8192 ||
    !provider.modelId ||
    provider.modelId.length > 200 ||
    !Number.isSafeInteger(provider.contextWindow) ||
    provider.contextWindow <= 0 ||
    !Number.isSafeInteger(provider.maxOutputTokens) ||
    provider.maxOutputTokens <= 0 ||
    provider.maxOutputTokens >= provider.contextWindow ||
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens <= 0 ||
    request.maxOutputTokens > provider.maxOutputTokens
  ) {
    throw new ProviderGatewayError('protocol_error')
  }

  const hasImages = request.context.messages.some(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  )
  if (hasImages && !provider.supportsVision) {
    throw new ProviderGatewayError('capability_mismatch')
  }
  if ((request.context.tools?.length ?? 0) > 0 && !provider.supportsTools) {
    throw new ProviderGatewayError('capability_mismatch')
  }

  const expectedUrl = new URL(endpointFor(provider.protocol), `${baseUrl}/`).toString()
  const allowedAdapterUrl = sdkRequestUrl(provider.protocol, baseUrl)
  const model: Model<Api> = {
    id: provider.modelId,
    name: provider.modelId,
    api: provider.protocol,
    provider: 'dev-toolbox-custom',
    baseUrl,
    reasoning: false,
    input: provider.supportsVision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: provider.contextWindow,
    maxTokens: provider.maxOutputTokens,
  }

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (request.signal?.aborted) throw new ProviderGatewayError('unavailable', request.signal.reason)
    const remainingMs = request.deadlineAt.getTime() - Date.now()
    if (remainingMs <= 0) throw new ProviderGatewayError('unavailable')
    let responseStatus: number | undefined
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), remainingMs)
    try {
      const options: SimpleStreamOptions = {
        apiKey: provider.apiKey,
        signal: request.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, request.signal]),
        maxTokens: request.maxOutputTokens,
        maxRetries: 0,
        timeoutMs: remainingMs,
        fetch: boundedFetch(expectedUrl, allowedAdapterUrl, (status) => {
          responseStatus = status
        }),
        onResponse: (response) => {
          responseStatus = response.status
        },
      }
      const message = await runStream(provider.protocol, model, request.context, options).result()
      validateTaskMessage(message, request.context)
      return { message, attempts: attempt }
    } catch (error) {
      if (request.signal?.aborted) throw new ProviderGatewayError('unavailable', error)
      const failure = classifyTaskFailure(error, responseStatus)
      if (!failure.retryable || attempt === maximumAttempts) throw failure.error
      const afterRequestMs = request.deadlineAt.getTime() - Date.now()
      const backoffMs = Math.min(attempt === 1 ? 250 : 500, afterRequestMs - 1)
      if (backoffMs <= 0) throw new ProviderGatewayError('unavailable', error)
      await wait(backoffMs, request.signal)
    } finally {
      clearTimeout(timeout)
    }
  }
  throw new ProviderGatewayError('unavailable')
}

function runStream(
  protocol: ProviderProtocol,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
): AssistantMessageEventStream {
  if (protocol === 'openai-completions') {
    return streamOpenAICompletions(model as Model<'openai-completions'>, context, options)
  }
  if (protocol === 'openai-responses') {
    return streamOpenAIResponses(model as Model<'openai-responses'>, context, options)
  }
  return streamAnthropic(model as Model<'anthropic-messages'>, context, options)
}

function boundedFetch(expectedUrl: string, allowedAdapterUrl: string, onStatus: (status: number) => void): typeof fetch {
  return async (input, init) => {
    const actualUrl = input instanceof Request ? input.url : String(input)
    const actual = new URL(actualUrl)
    const allowed = new URL(allowedAdapterUrl)
    if (actual.origin !== allowed.origin || actual.pathname !== allowed.pathname || actual.search || actual.hash) {
      throw new ProviderGatewayError('protocol_error', new Error(`unexpected provider endpoint: ${actual.pathname}`))
    }
    const outbound = input instanceof Request ? new Request(expectedUrl, input) : expectedUrl
    const response = await fetch(outbound, { ...init, redirect: 'manual' })
    onStatus(response.status)
    if (response.status >= 300 && response.status < 400) return response
    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > maximumResponseBytes) throw new ProviderGatewayError('unavailable')
    if (response.body === null) return response
    let received = 0
    const boundedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > maximumResponseBytes) {
          controller.error(new ProviderGatewayError('unavailable'))
          return
        }
        controller.enqueue(chunk)
      },
    }))
    return new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

function sdkRequestUrl(protocol: ProviderProtocol, baseUrl: string): string {
  if (protocol === 'anthropic-messages') return `${baseUrl}/v1/messages`
  return new URL(endpointFor(protocol), `${baseUrl}/`).toString()
}

function normalizeBaseUrl(value: string, allowInsecureHttp: boolean): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ProviderGatewayError('unavailable')
  }
  if (
    !parsed.host ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' && !(allowInsecureHttp && parsed.protocol === 'http:'))
  ) {
    throw new ProviderGatewayError('unavailable')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function endpointFor(protocol: ProviderProtocol): string {
  if (protocol === 'openai-completions') return 'chat/completions'
  if (protocol === 'openai-responses') return 'responses'
  return 'messages'
}

function isProtocol(value: string): value is ProviderProtocol {
  return value === 'openai-completions' || value === 'openai-responses' || value === 'anthropic-messages'
}

function ensureSuccessfulMessage(message: AssistantMessage): void {
  if (message.stopReason === 'error' || message.stopReason === 'aborted' || !message.content.some((part) => part.type === 'text')) {
    throw new ProviderGatewayError('unavailable', new Error(message.errorMessage ?? 'provider returned no text'))
  }
}

function validateTaskMessage(message: AssistantMessage, context: Context): void {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new ProviderGatewayError('unavailable', new Error(message.errorMessage ?? 'provider request failed'))
  }
  if (message.stopReason === 'length' || message.content.length === 0) {
    throw new ProviderGatewayError('protocol_error', new Error(message.errorMessage ?? 'provider returned an unusable message'))
  }
  const allowedTools = new Set((context.tools ?? []).map((tool) => tool.name))
  const toolCalls = message.content.filter((part) => part.type === 'toolCall')
  if (message.stopReason === 'toolUse' && toolCalls.length === 0) {
    throw new ProviderGatewayError('protocol_error')
  }
  for (const toolCall of toolCalls) {
    if (
      toolCall.namespace !== undefined ||
      !allowedTools.has(toolCall.name) ||
      typeof toolCall.arguments !== 'object' ||
      toolCall.arguments === null ||
      Array.isArray(toolCall.arguments)
    ) {
      throw new ProviderGatewayError('protocol_error')
    }
  }
}

function classifyTaskFailure(
  error: unknown,
  responseStatus: number | undefined,
): { error: ProviderGatewayError; retryable: boolean } {
  if (responseStatus === 401 || responseStatus === 403) {
    return { error: new ProviderGatewayError('credentials_invalid', error), retryable: false }
  }
  if ([408, 429, 500, 502, 503, 504].includes(responseStatus ?? 0)) {
    return { error: new ProviderGatewayError('unavailable', error), retryable: true }
  }
  if (responseStatus !== undefined) {
    return { error: new ProviderGatewayError('protocol_error', error), retryable: false }
  }
  if (error instanceof ProviderGatewayError) {
    return { error, retryable: error.category === 'unavailable' }
  }
  return { error: new ProviderGatewayError('unavailable', error), retryable: true }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const finish = (): void => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timeout = setTimeout(finish, milliseconds)
    const abort = (): void => {
      clearTimeout(timeout)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// V3 assistant chat streaming (docs/16 §7.2). The low-level protocol stream()
// entry points are used directly with explicit per-protocol reasoning options
// so the configured effort is sent verbatim — streamSimple would silently
// clamp unsupported levels, which the contract forbids.
// ---------------------------------------------------------------------------

export type AssistantReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AssistantStreamRequest {
  readonly protocol: ProviderProtocol
  readonly baseUrl: string
  readonly apiKey: string
  readonly modelId: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly reasoning: AssistantReasoningLevel
  readonly context: Context
  readonly deadlineAt: Date
  readonly allowInsecureHttp: boolean
  readonly signal?: AbortSignal
}

export function anthropicBudgetFor(level: AssistantReasoningLevel): number | null {
  if (level === 'off') return null
  return anthropicThinkingBudgets[level] ?? null
}

// Builds the shared pi-ai Model for assistant requests. reasoning is enabled
// so protocol adapters accept thinking options; supportsReasoningEffort is
// pinned so custom endpoints always receive reasoning_effort.
function assistantModel(request: AssistantStreamRequest, baseUrl: string): Model<Api> {
  return {
    id: request.modelId,
    name: request.modelId,
    api: request.protocol,
    provider: 'dev-toolbox-custom',
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: request.contextWindow,
    maxTokens: request.maxOutputTokens,
    ...(request.protocol === 'openai-completions'
      ? { compat: { supportsReasoningEffort: true } }
      : {}),
    // Responses otherwise injects effort="none" when off, contrary to §7.2.
    thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
  } as unknown as Model<Api>
}

function verifyOutboundReasoning(
  protocol: ProviderProtocol,
  level: AssistantReasoningLevel,
): (payload: unknown) => void {
  return (payload) => {
    if (!isObjectPayload(payload)) {
      throw new ProviderGatewayError('reasoning_unsupported')
    }
    if (protocol === 'openai-completions') {
      const sent = payload['reasoning_effort']
      if (level === 'off' ? sent !== undefined : sent !== level) {
        throw new ProviderGatewayError('reasoning_unsupported')
      }
      return
    }
    if (protocol === 'openai-responses') {
      const reasoning = payload['reasoning'] as Record<string, unknown> | undefined
      const sent = reasoning?.['effort']
      if (level === 'off' ? sent !== undefined : sent !== level) {
        throw new ProviderGatewayError('reasoning_unsupported')
      }
      return
    }
    const thinking = payload['thinking'] as Record<string, unknown> | undefined
    if (level === 'off') {
      if (thinking !== undefined && thinking['type'] !== 'disabled') {
        throw new ProviderGatewayError('reasoning_unsupported')
      }
      return
    }
    const budget = anthropicThinkingBudgets[level]
    if (
      !thinking ||
      thinking['type'] !== 'enabled' ||
      thinking['budget_tokens'] !== budget
    ) {
      throw new ProviderGatewayError('reasoning_unsupported')
    }
  }
}

function isObjectPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assistantStreamChat(request: AssistantStreamRequest): AssistantMessageEventStream {
  const baseUrl = normalizeBaseUrl(request.baseUrl, request.allowInsecureHttp)
  const expectedUrl = new URL(endpointFor(request.protocol), `${baseUrl}/`).toString()
  const allowedAdapterUrl = sdkRequestUrl(request.protocol, baseUrl)
  const model = assistantModel(request, baseUrl)
  const verify = verifyOutboundReasoning(request.protocol, request.reasoning)
  const remainingMs = request.deadlineAt.getTime() - Date.now()
  if (remainingMs <= 0) throw new ProviderGatewayError('unavailable')
  const deadlineSignal = AbortSignal.timeout(remainingMs)
  const signal = request.signal === undefined
    ? deadlineSignal
    : AbortSignal.any([deadlineSignal, request.signal])
  const base = {
    apiKey: request.apiKey,
    maxRetries: 0,
    fetch: boundedFetch(expectedUrl, allowedAdapterUrl, () => {}),
    onPayload: (payload: unknown) => {
      verify(payload)
      return undefined
    },
    signal,
    timeoutMs: remainingMs,
  }
  const maxTokens = request.maxOutputTokens
  if (request.protocol === 'anthropic-messages') {
    const budget = anthropicBudgetFor(request.reasoning)
    if (request.reasoning !== 'off') {
      if (budget === null || budget + minimumAnswerTokens > request.maxOutputTokens) {
        throw new ProviderGatewayError('reasoning_unsupported')
      }
    }
    return streamAnthropicRaw(model as Model<'anthropic-messages'>, request.context, {
      ...base,
      maxTokens,
      thinkingEnabled: request.reasoning !== 'off',
      ...(request.reasoning === 'off' ? {} : { thinkingBudgetTokens: budget! }),
    })
  }
  const effort = request.reasoning === 'off' ? undefined : request.reasoning
  if (request.protocol === 'openai-completions') {
    return streamOpenAICompletionsRaw(model as Model<'openai-completions'>, request.context, {
      ...base,
      maxTokens,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    })
  }
  return streamOpenAIResponsesRaw(model as Model<'openai-responses'>, request.context, {
    ...base,
    maxTokens,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  })
}

// ---------------------------------------------------------------------------
// V3 embeddings (docs/16 §7.3): one bounded POST to `${baseUrl}/embeddings`
// with the OpenAI-compatible {model, input, dimensions} shape. Redirects are
// refused, response size is bounded, every element must be finite and every
// vector must match the expected dimension.
// ---------------------------------------------------------------------------

export interface EmbeddingRequest {
  readonly baseUrl: string
  readonly apiKey: string
  readonly modelId: string
  readonly input: readonly string[]
  readonly dimensions: number
  readonly allowInsecureHttp: boolean
  readonly signal?: AbortSignal
}

export interface EmbeddingResult {
  readonly embeddings: readonly (readonly number[])[]
  readonly usage: { readonly inputTokens: number | null; readonly totalTokens: number | null } | null
}

export async function generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResult> {
  const baseUrl = normalizeBaseUrl(request.baseUrl, request.allowInsecureHttp)
  if (!request.apiKey || !request.modelId || request.input.length === 0 || request.input.length > 16) {
    throw new ProviderGatewayError('unavailable')
  }
  const url = new URL('embeddings', `${baseUrl}/`).toString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: request.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, request.signal]),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.modelId,
        input: request.input,
        dimensions: request.dimensions,
      }),
    })
    if (response.status >= 300 && response.status < 400) {
      throw new ProviderGatewayError('unavailable')
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > maximumEmbeddingResponseBytes) throw new ProviderGatewayError('unavailable')
    const raw = await response.arrayBuffer()
    if (raw.byteLength > maximumEmbeddingResponseBytes) throw new ProviderGatewayError('unavailable')
    if (response.status === 401 || response.status === 403) {
      throw new ProviderGatewayError('credentials_invalid')
    }
    if (response.status !== 200) {
      throw new ProviderGatewayError('unavailable')
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(new TextDecoder().decode(raw))
    } catch (error) {
      throw new ProviderGatewayError('protocol_error', error)
    }
    if (!isObjectPayload(decoded) || !Array.isArray(decoded['data'])) {
      throw new ProviderGatewayError('protocol_error')
    }
    const data = decoded['data'] as unknown[]
    if (data.length !== request.input.length) {
      throw new ProviderGatewayError('protocol_error')
    }
    const embeddings: number[][] = []
    for (const entry of data) {
      if (!isObjectPayload(entry) || !Array.isArray(entry['embedding'])) {
        throw new ProviderGatewayError('protocol_error')
      }
      const vector = (entry['embedding'] as unknown[]).map((value) => Number(value))
      if (vector.length !== request.dimensions) {
        throw new ProviderGatewayError('embedding_dimension_mismatch')
      }
      if (vector.some((value) => !Number.isFinite(value))) {
        throw new ProviderGatewayError('embedding_response_invalid')
      }
      const norm = vector.reduce((sum, value) => sum + value * value, 0)
      if (norm === 0) throw new ProviderGatewayError('embedding_response_invalid')
      embeddings.push(vector)
    }
    let usage: { inputTokens: number | null; totalTokens: number | null } | null = null
    if (isObjectPayload(decoded['usage'])) {
      const rawUsage = decoded['usage'] as Record<string, unknown>
      const inputTokens = typeof rawUsage['prompt_tokens'] === 'number' ? rawUsage['prompt_tokens'] : null
      const totalTokens = typeof rawUsage['total_tokens'] === 'number' ? rawUsage['total_tokens'] : null
      usage = { inputTokens, totalTokens }
    }
    return { embeddings, usage }
  } finally {
    clearTimeout(timeout)
  }
}

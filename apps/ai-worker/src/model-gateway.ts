import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'

const maximumResponseBytes = 4 * 1024 * 1024

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
  if (remainingMs <= 0 || remainingMs > 15_000) throw new ProviderGatewayError('unavailable')

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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
      if (!failure.retryable || attempt === 3) throw failure.error
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
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximumResponseBytes) throw new ProviderGatewayError('unavailable')
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
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

// V3 assistant wiring entry (docs/16 §19.1). The integrator's
// apps/ai-worker/src/index.ts calls exactly two functions from this module:
//
//   import {
//     startAssistantRunners,
//     handleAssistantInternalRequest,
//   } from './assistant/index.js'
//
//   const assistant = startAssistantRunners({
//     apiInternalUrl: config.apiInternalUrl,
//     serviceToken: config.serviceToken,
//     workerId: config.workerId,
//     allowInsecureProviderHttp: config.allowInsecureProviderHttp,
//   })
//   // inside handleRequest, before the 404 fallback:
//   if (await handleAssistantInternalRequest(request, response, config)) return
//   // on shutdown:
//   await assistant.stop()

import { createHash, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  AssistantClient,
  AssistantClientError,
  type ClaimedAssistantRun,
  type ClaimedIndexBatch,
} from './client.js'
import { AssistantRunner } from './runner.js'
import { ProviderGatewayError, generateEmbeddings } from '../model-gateway.js'
import { log } from '../logger.js'

const idleDelayMs = 1_000
const indexHeartbeatMs = 10_000
const indexEmbeddingTimeoutMs = 180_000

const embeddingProbeText = 'Dev Toolbox 知识库 Embedding 连接探针。'

export interface AssistantRunnerOptions {
  readonly apiInternalUrl: string
  readonly serviceToken: string
  readonly workerId: string
  readonly allowInsecureProviderHttp: boolean
  readonly chatSlots?: number
}

export interface RunningAssistant {
  stop(): void
}

// startAssistantRunners launches the assistant chat lane (default two slots)
// and the embedding index lane (one slot). They claim independently and never
// touch the existing AI Task lane.
export function startAssistantRunners(options: AssistantRunnerOptions): RunningAssistant {
  const controller = new AbortController()
  const client = new AssistantClient(options.apiInternalUrl, options.serviceToken, options.workerId)
  const runner = new AssistantRunner(client, options.allowInsecureProviderHttp)
  const indexRunner = new EmbeddingIndexRunner(client, options.allowInsecureProviderHttp)
  const loops: Promise<void>[] = []

  const chatSlots = options.chatSlots ?? 2
  for (let slot = 0; slot < chatSlots; slot++) {
    loops.push(
      runAssistantLoop(client, runner, controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) {
          log('error', 'assistant_loop_failed', { errorType: error instanceof Error ? error.name : 'unknown' })
          process.exitCode = 1
        }
      }),
    )
  }
  loops.push(
    runIndexLoop(client, indexRunner, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        log('error', 'assistant_index_loop_failed', { errorType: error instanceof Error ? error.name : 'unknown' })
        process.exitCode = 1
      }
    }),
  )

  return {
    stop(): void {
      controller.abort(new Error('assistant runners stopping'))
      // Loops finish their current claim; abortableDelay resolves promptly.
      void Promise.allSettled(loops)
    },
  }
}

async function runAssistantLoop(
  client: AssistantClient,
  runner: AssistantRunner,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let claim: ClaimedAssistantRun | null
    try {
      claim = await client.claimRun(signal)
    } catch {
      if (signal.aborted) return
      await abortableDelay(idleDelayMs, signal)
      continue
    }
    if (claim === null) {
      await abortableDelay(idleDelayMs, signal)
      continue
    }
    await runner.run(claim, signal)
  }
}

async function runIndexLoop(
  client: AssistantClient,
  runner: EmbeddingIndexRunner,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let batch: ClaimedIndexBatch | null
    try {
      batch = await client.claimIndexBatch(signal)
    } catch {
      if (signal.aborted) return
      await abortableDelay(idleDelayMs, signal)
      continue
    }
    if (batch === null) {
      await abortableDelay(idleDelayMs, signal)
      continue
    }
    await runner.run(batch, signal)
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timeout = setTimeout(finish, milliseconds)
    const abort = (): void => {
      clearTimeout(timeout)
      finish()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

// EmbeddingIndexRunner processes one claimed batch: a single embeddings call
// with one whitelisted transient retry, all-or-nothing completion.
export class EmbeddingIndexRunner {
  constructor(
    readonly client: AssistantClient,
    readonly allowInsecureProviderHttp: boolean,
  ) {}

  async run(batch: ClaimedIndexBatch, shutdownSignal?: AbortSignal): Promise<void> {
    const leases = batch.fragments.map((fragment) => ({
      fragmentId: fragment.fragmentId,
      leaseVersion: fragment.attempt,
    }))
    let stopped = false
    const heartbeatTimer = setInterval(() => {
      void this.client.heartbeatIndex(leases).catch(() => {
        stopped = true
      })
    }, indexHeartbeatMs)
    try {
      if (batch.fragments.length === 0) return
      let lastError: unknown = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (stopped || shutdownSignal?.aborted) return
        try {
          const result = await generateEmbeddings({
            baseUrl: batch.baseUrl,
            apiKey: batch.apiKey,
            modelId: batch.modelId,
            dimensions: batch.dimensions,
            input: batch.fragments.map((fragment) => fragment.content),
            allowInsecureHttp: this.allowInsecureProviderHttp,
            timeoutMs: indexEmbeddingTimeoutMs,
            ...(shutdownSignal === undefined ? {} : { signal: shutdownSignal }),
          })
          // All-or-nothing: every claimed fragment must produce a result.
          if (result.embeddings.length !== batch.fragments.length) {
            await this.failAll(batch, 'EMBEDDING_RESPONSE_INVALID', 'Embedding 响应缺失部分向量')
            return
          }
          await this.client.completeIndexBatch(
            batch.generation,
            batch.policy,
            batch.fragments.map((fragment, index) => ({
              fragmentId: fragment.fragmentId,
              leaseVersion: fragment.attempt,
              embedding: [...(result.embeddings[index] ?? [])],
              dimensions: batch.dimensions,
              sourceCreatedAt: fragment.sourceCreatedAt,
              sensitivity: fragment.sensitivity,
            })),
          )
          return
        } catch (error) {
          lastError = error
          const retryable = error instanceof ProviderGatewayError && error.category === 'unavailable'
          if (!retryable || attempt === 2) break
        }
      }
      const failure = indexFailure(lastError)
      await this.failAll(batch, failure.code, failure.detail)
    } finally {
      clearInterval(heartbeatTimer)
    }
  }

  private async failAll(batch: ClaimedIndexBatch, code: string, detail: string): Promise<void> {
    try {
      await this.client.failIndexBatch(
        batch.fragments.map((fragment) => ({
          fragmentId: fragment.fragmentId,
          leaseVersion: fragment.attempt,
          errorCode: code,
          errorDetail: detail,
        })),
      )
    } catch (error) {
      if (!(error instanceof AssistantClientError && error.status === 409)) throw error
    }
  }
}

function indexFailure(error: unknown): { code: string; detail: string } {
  if (error instanceof ProviderGatewayError) {
    if (error.category === 'embedding_dimension_mismatch') {
      return { code: 'EMBEDDING_DIMENSION_MISMATCH', detail: '向量维度与配置不一致' }
    }
    if (error.category === 'embedding_response_invalid') {
      return { code: 'EMBEDDING_RESPONSE_INVALID', detail: 'Embedding 响应无效' }
    }
    if (error.category === 'credentials_invalid') {
      return { code: 'EMBEDDING_PROVIDER_UNAVAILABLE', detail: 'Embedding 凭据被拒绝' }
    }
    return { code: 'EMBEDDING_PROVIDER_UNAVAILABLE', detail: 'Embedding 服务暂时不可用' }
  }
  return { code: 'EMBEDDING_PROVIDER_UNAVAILABLE', detail: 'Embedding 服务暂时不可用' }
}

// handleAssistantInternalRequest serves the worker-hosted assistant endpoints
// called by the Go API. Returns false when the request is not assistant
// related so the integrator's router can continue.
export async function handleAssistantInternalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AssistantRunnerOptions,
): Promise<boolean> {
  if (request.method !== 'POST' || !request.url?.startsWith('/internal/assistant/')) {
    return false
  }
  if (!validInternalAuthorization(request.headers.authorization, options.serviceToken)) {
    writeJson(response, 401, { error: { code: 'AUTH_REQUIRED', message: '内部服务凭据无效' } })
    return true
  }
  const path = request.url
  if (path === '/internal/assistant/embedding-test') {
    await handleEmbeddingTest(request, response, options)
    return true
  }
  if (path === '/internal/assistant/temporary/prepare' || path === '/internal/assistant/temporary/stream') {
    // Implemented by the temporary lane module.
    const { handleTemporaryRequest } = await import('./temporary.js')
    await handleTemporaryRequest(request, response, options, path)
    return true
  }
  return false
}

interface EmbeddingTestBody {
  baseUrl: string
  apiKey: string
  modelId: string
  dimensions: number
}

async function handleEmbeddingTest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AssistantRunnerOptions,
): Promise<void> {
  let body: EmbeddingTestBody
  try {
    body = await readJsonBody(request, 64 * 1024) as EmbeddingTestBody
  } catch {
    writeJson(response, 422, { error: { code: 'VALIDATION_FAILED', message: 'Embedding 测试请求无效' } })
    return
  }
  if (
    typeof body?.baseUrl !== 'string' || typeof body?.apiKey !== 'string' ||
    typeof body?.modelId !== 'string' || !Number.isSafeInteger(body?.dimensions) ||
    body.dimensions < 1 || body.dimensions > 16000
  ) {
    writeJson(response, 422, { error: { code: 'VALIDATION_FAILED', message: 'Embedding 测试请求无效' } })
    return
  }
  const started = performance.now()
  try {
    const result = await generateEmbeddings({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      modelId: body.modelId,
      input: [embeddingProbeText],
      dimensions: body.dimensions,
      allowInsecureHttp: options.allowInsecureProviderHttp,
    })
    const first = result.embeddings[0]
    writeJson(response, 200, {
      status: 'ok',
      actualDimensions: first ? first.length : 0,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      usage: result.usage,
    })
  } catch (error) {
    if (error instanceof ProviderGatewayError && error.category === 'credentials_invalid') {
      writeJson(response, 422, { error: { code: 'EMBEDDING_CREDENTIALS_INVALID', message: 'Embedding 凭据被拒绝' } })
      return
    }
    writeJson(response, 503, { error: { code: 'EMBEDDING_PROVIDER_UNAVAILABLE', message: 'Embedding 服务暂时不可用' } })
  }
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximumBytes) throw new Error('body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function validInternalAuthorization(value: string | undefined, expectedToken: string): boolean {
  const supplied = value?.startsWith('Bearer ') === true ? value.slice('Bearer '.length) : ''
  const suppliedHash = createHash('sha256').update(supplied).digest()
  const expectedHash = createHash('sha256').update(expectedToken).digest()
  return timingSafeEqual(suppliedHash, expectedHash) && supplied.length > 0
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

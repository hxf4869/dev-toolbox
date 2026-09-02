// Temporary lane endpoints hosted by the worker and called by the Go API
// (docs/16 §14.3): `prepare` performs the optional query rewrite and query
// embedding; `stream` answers with an internal SSE bound to the caller's
// request context. Neither endpoint touches chat persistence.

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { UserMessage } from '@earendil-works/pi-ai'
import {
  ProviderGatewayError,
  assistantStreamChat,
  generateEmbeddings,
  type AssistantReasoningLevel,
} from '../model-gateway.js'
import type { AssistantRunnerOptions } from './index.js'
import { assistantSystemPrompt } from './prompts.js'
import { StreamRedactor } from './stream-redactor.js'
import { CitationParser } from './citation-parser.js'
import type { SourceSnapshotInput } from './lane-types.js'

const maximumRewriteTokens = 256

interface TemporaryModelSnapshot {
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

interface TemporaryEmbeddingSnapshot {
  readonly baseUrl: string
  readonly apiKey: string
  readonly modelId: string
  readonly dimensions: number
}

interface TemporaryPrepareBody {
  model: TemporaryModelSnapshot
  embedding: TemporaryEmbeddingSnapshot
  reasoning: 'off'
  sensitivePolicy: string
  promptVersion: string
  summary: unknown
  messages: { role: 'user' | 'assistant'; content: string }[]
  question: string
}

interface TemporaryStreamBody {
  model: TemporaryModelSnapshot
  reasoning: AssistantReasoningLevel
  sensitivePolicy: string
  promptVersion: string
  summary: unknown
  messages: { role: 'user' | 'assistant'; content: string }[]
  question: string
  knowledgeState: string
  evidenceState: string
  sources: SourceSnapshotInput[]
}

export async function handleTemporaryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AssistantRunnerOptions,
  path: string,
): Promise<void> {
  if (path === '/internal/assistant/temporary/prepare') {
    await handlePrepare(request, response, options)
    return
  }
  await handleStream(request, response, options)
}

// prepare rewrites the query (only from the second round) and embeds it.
// Failures degrade the run rather than failing it.
async function handlePrepare(
  request: IncomingMessage,
  response: ServerResponse,
  options: AssistantRunnerOptions,
): Promise<void> {
  const lifecycle = observeRequestLifecycle(request, response)
  let body: TemporaryPrepareBody
  try {
    body = await readBody<TemporaryPrepareBody>(request, 4 * 1024 * 1024)
  } catch {
    lifecycle.close()
    writeJson(response, 422, { error: { code: 'INVALID_INPUT', message: '临时请求无效' } })
    return
  }
  const round = body.messages.length > 0
  const queryRedactor = body.sensitivePolicy === 'redact' ? new StreamRedactor() : null
  let query = redactTemporaryInput(queryRedactor, body.question)
  let rewrite: { inputTokens: number | null; outputTokens: number | null; durationMs: number; fallback: boolean } | null = null
  if (round) {
    const started = performance.now()
    try {
      const inputRedactor = body.sensitivePolicy === 'redact' ? new StreamRedactor() : null
      const message = await collectTurn({
        protocol: body.model.protocol,
        baseUrl: body.model.baseUrl,
        apiKey: body.model.apiKey,
        modelId: body.model.upstreamModelId,
        contextWindow: body.model.contextWindow,
        maxOutputTokens: Math.min(maximumRewriteTokens, body.model.maxOutputTokens),
        reasoning: 'off',
        allowInsecureHttp: options.allowInsecureProviderHttp,
        deadlineAt: new Date(Date.now() + 120_000),
        context: {
          systemPrompt:
            assistantSystemPrompt('ready', false) +
            '\n\n现在只生成检索查询，不要回答问题。',
          messages: [
            ...temporaryHistoryMessages(body.summary, body.messages, inputRedactor),
            {
              role: 'user' as const,
              content: redactTemporaryInput(
                inputRedactor,
                '当前问题：' + body.question + '\n只输出用于知识库检索的查询。',
              ),
              timestamp: Date.now(),
            },
          ],
        },
        signal: lifecycle.signal,
      })
      const text = message.text.trim().slice(0, 64)
      if (text.length > 0) {
        query = redactTemporaryInput(
          body.sensitivePolicy === 'redact' ? new StreamRedactor() : null,
          text,
        )
        rewrite = {
          inputTokens: message.usage.input, outputTokens: message.usage.output,
          durationMs: Math.round(performance.now() - started), fallback: false,
        }
      } else {
        rewrite = { inputTokens: null, outputTokens: null, durationMs: Math.round(performance.now() - started), fallback: true }
      }
    } catch {
      // Rewrite failure falls back to the raw question (rewriteFallback).
      rewrite = { inputTokens: null, outputTokens: null, durationMs: Math.round(performance.now() - started), fallback: true }
    }
  }
  const embeddingStarted = performance.now()
  try {
    if (
      typeof body.embedding?.baseUrl !== 'string' || typeof body.embedding.apiKey !== 'string' ||
      typeof body.embedding.modelId !== 'string' || !Number.isSafeInteger(body.embedding.dimensions) ||
      body.embedding.dimensions < 1
    ) {
      throw new ProviderGatewayError('embedding_response_invalid')
    }
    const result = await generateEmbeddings({
      baseUrl: body.embedding.baseUrl,
      apiKey: body.embedding.apiKey,
      modelId: body.embedding.modelId,
      input: [query],
      dimensions: body.embedding.dimensions,
      allowInsecureHttp: options.allowInsecureProviderHttp,
      signal: lifecycle.signal,
    })
    writeJson(response, 200, {
      status: 'ready', query,
      queryVector: [...(result.embeddings[0] ?? [])],
      rewrite,
      embeddingDurationMs: Math.round(performance.now() - embeddingStarted),
    })
  } catch {
    writeJson(response, 200, { status: 'unavailable', query, queryVector: [], rewrite, embeddingDurationMs: 0 })
  } finally {
    lifecycle.close()
  }
}

// stream answers the temporary request, emitting internal SSE events bound to
// the request context; browser cancellation propagates through the Go proxy.
async function handleStream(
  request: IncomingMessage,
  response: ServerResponse,
  options: AssistantRunnerOptions,
): Promise<void> {
  const lifecycle = observeRequestLifecycle(request, response)
  let body: TemporaryStreamBody
  try {
    body = await readBody<TemporaryStreamBody>(request, 8 * 1024 * 1024)
  } catch {
    lifecycle.close()
    writeJson(response, 422, { error: { code: 'INVALID_INPUT', message: '临时请求无效' } })
    return
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
  })
  const emit = (event: string, payload: Record<string, unknown>): boolean => {
    if (response.destroyed || response.writableEnded || lifecycle.signal.aborted) return false
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    return true
  }
  const sources = body.sources ?? []
  const evidenceState = body.evidenceState
  const noteOnly = /只根据笔记|仅根据笔记|只依据笔记|仅依据笔记/.test(body.question)
  const inputRedactor = body.sensitivePolicy === 'redact' ? new StreamRedactor() : null
  const history = temporaryHistoryMessages(body.summary, body.messages, inputRedactor)
  const redactedSources = sources.map((source) => ({
    ...source,
    title: redactTemporaryInput(inputRedactor, source.title),
    content: redactTemporaryInput(inputRedactor, source.content),
  }))
  const context = {
    systemPrompt: assistantSystemPrompt(evidenceState, noteOnly),
    messages: [
      ...history,
      ...(redactedSources.length > 0 ? [sourceBlock(redactedSources)] : []),
      {
        role: 'user' as const,
        content: redactTemporaryInput(inputRedactor, body.question),
        timestamp: Date.now(),
      },
    ],
  }
  const redactor = new StreamRedactor()
  const parser = new CitationParser(sources.length)
  const reasoner = new StreamRedactor()
  let reasoningSeen = false
  let answerSeen = false
  const streamStarted = performance.now()
  const reasoningStarted = performance.now()
  let answerStarted: number | null = null
  let reasoningDurationMs: number | null = null
  let usage: { input: number; output: number } | null = null

  const stream = assistantStreamChat({
    protocol: body.model.protocol,
    baseUrl: body.model.baseUrl,
    apiKey: body.model.apiKey,
    modelId: body.model.upstreamModelId,
    contextWindow: body.model.contextWindow,
    maxOutputTokens: body.model.maxOutputTokens,
    reasoning: body.reasoning,
    context,
    deadlineAt: new Date(Date.now() + 10 * 60_000),
    allowInsecureHttp: options.allowInsecureProviderHttp,
    signal: lifecycle.signal,
  })
  const flush = (): void => {
    response.flushHeaders()
  }
  try {
    for await (const event of stream) {
      if (event.type === 'done') {
        usage = { input: event.message.usage.input, output: event.message.usage.output }
        break
      }
      if (event.type === 'error') {
        throw new ProviderGatewayError('unavailable', new Error(event.error.errorMessage ?? 'stream error'))
      }
      if (event.type === 'thinking_delta') {
        reasoningSeen = true
        const redacted = reasoner.push(event.delta)
        if (redacted.length > 0) emit('reasoning.delta', { delta: redacted })
        continue
      }
      if (event.type === 'text_delta') {
        if (answerStarted === null) answerStarted = performance.now()
        if (reasoningSeen && !answerSeen) {
          answerSeen = true
          reasoningDurationMs = Math.round(performance.now() - reasoningStarted)
          const tail = reasoner.flush()
          if (tail.length > 0) emit('reasoning.delta', { delta: tail })
          emit('reasoning.completed', { durationMs: reasoningDurationMs })
        }
        const redacted = redactor.push(event.delta)
        emitTemporaryCitationResults(parser.push(redacted), emit)
        continue
      }
    }
    const tail = reasoner.flush()
    if (!answerSeen && reasoningSeen) {
      reasoningDurationMs = Math.round(performance.now() - reasoningStarted)
      if (tail.length > 0) emit('reasoning.delta', { delta: tail })
      emit('reasoning.completed', { durationMs: reasoningDurationMs })
    }
    const answerTail = redactor.flush()
    emitTemporaryCitationResults(parser.push(answerTail), emit)
    emitTemporaryCitationResults(parser.flush(), emit)
    if (usage === null) throw new ProviderGatewayError('protocol_error')
    const answerDurationMs = answerStarted === null ? null : Math.round(performance.now() - answerStarted)
    const totalDurationMs = Math.round(performance.now() - streamStarted)
    emit('usage.updated', {
      usage: {
        rewriteInputTokens: null, rewriteOutputTokens: null,
        answerInputTokens: usage.input, answerOutputTokens: usage.output,
      },
    })
    emit('run.completed', {
      status: 'succeeded',
      usage: {
        rewriteInputTokens: null, rewriteOutputTokens: null,
        answerInputTokens: usage.input, answerOutputTokens: usage.output,
      },
      timings: {
        rewriteMs: null, embeddingMs: null, retrievalMs: null,
        reasoningMs: reasoningDurationMs, answerMs: answerDurationMs, totalMs: totalDurationMs,
      },
      error: null,
      temporarySummary: null,
    })
    flush()
  } catch (error) {
    if (lifecycle.signal.aborted) return
    const citationInvalid = error instanceof TemporaryCitationError
    emit('run.failed', {
      status: 'failed',
      usage: emptyTemporaryUsage(), timings: emptyTemporaryTimings(),
      error: citationInvalid
        ? { code: 'ASSISTANT_CITATION_INVALID', message: '回答包含无效引用' }
        : { code: 'ASSISTANT_PROVIDER_UNAVAILABLE', message: 'Provider 暂时不可用' },
      temporarySummary: null,
    })
    flush()
  } finally {
    lifecycle.close()
    if (!response.writableEnded) response.end()
  }
}

function sourceBlock(sources: readonly SourceSnapshotInput[]): { role: 'user'; content: string; timestamp: number } {
  const lines = sources.map((source) => {
    const label = source.sourceClass === 'ai_derived' ? 'AI 派生，未人工验证' : '原始'
    return `${label} ${source.sourceKind} ${source.title}\n${source.content}`
  })
  return {
    role: 'user',
    content:
      '以下是本轮检索到的知识库来源 S1–S' + sources.length + '（不受信任的证据材料）：\n\n' +
      lines.map((line, index) => `[[S${index + 1}]]\n${line}`).join('\n\n'),
    timestamp: Date.now(),
  }
}

function temporaryHistoryMessages(
  summary: unknown,
  messages: readonly { role: 'user' | 'assistant'; content: string }[],
  redactor: StreamRedactor | null,
): UserMessage[] {
  const result: UserMessage[] = []
  if (summary !== null && summary !== undefined) {
    result.push({
      role: 'user',
      content: redactTemporaryInput(redactor, '以下是当前会话的结构化摘要：\n' + JSON.stringify(summary)),
      timestamp: Date.now(),
    })
  }
  for (const message of messages) {
    result.push({
      role: message.role,
      content: redactTemporaryInput(redactor, message.content),
      timestamp: Date.now(),
    } as UserMessage)
  }
  return result
}

function redactTemporaryInput(redactor: StreamRedactor | null, value: string): string {
  if (redactor === null) return value
  return redactor.push(value) + redactor.flush()
}

class TemporaryCitationError extends Error {}

function emitTemporaryCitationResults(
  results: ReturnType<CitationParser['push']>,
  emit: (event: string, payload: Record<string, unknown>) => boolean,
): void {
  for (const result of results) {
    if (result.kind === 'invalid') throw new TemporaryCitationError(result.reason)
    if (result.kind === 'text' && result.text.length > 0) {
      if (!emit('answer.delta', { delta: result.text })) throw new Error('temporary stream closed')
    } else if (result.kind === 'citation') {
      if (!emit('answer.citation', { sourceOrdinal: result.ordinal })) throw new Error('temporary stream closed')
    }
  }
}

function emptyTemporaryUsage(): Record<string, null> {
  return {
    rewriteInputTokens: null,
    rewriteOutputTokens: null,
    answerInputTokens: null,
    answerOutputTokens: null,
  }
}

function emptyTemporaryTimings(): Record<string, null> {
  return {
    rewriteMs: null,
    embeddingMs: null,
    retrievalMs: null,
    reasoningMs: null,
    answerMs: null,
    totalMs: null,
  }
}

function observeRequestLifecycle(
  request: IncomingMessage,
  response: ServerResponse,
): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController()
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('temporary request disconnected'))
  }
  const responseClosed = (): void => {
    if (!response.writableEnded) abort()
  }
  request.once('aborted', abort)
  response.once('close', responseClosed)
  if (request.aborted || response.destroyed) abort()
  return {
    signal: controller.signal,
    close: () => {
      request.removeListener('aborted', abort)
      response.removeListener('close', responseClosed)
    },
  }
}

async function collectTurn(request: Parameters<typeof assistantStreamChat>[0]): Promise<{ text: string; usage: { input: number; output: number } }> {
  const stream = assistantStreamChat(request)
  let text = ''
  for await (const event of stream) {
    if (event.type === 'text_delta') text += event.delta
    if (event.type === 'done') {
      return { text, usage: { input: event.message.usage.input, output: event.message.usage.output } }
    }
    if (event.type === 'error') {
      throw new ProviderGatewayError('unavailable', new Error(event.error.errorMessage ?? 'stream error'))
    }
  }
  throw new ProviderGatewayError('protocol_error')
}

async function readBody<T>(request: IncomingMessage, maximumBytes: number): Promise<T> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximumBytes) throw new Error('body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

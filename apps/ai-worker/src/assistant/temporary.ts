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

interface TemporaryPrepareBody {
  model: TemporaryModelSnapshot
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
  let body: TemporaryPrepareBody
  try {
    body = await readBody<TemporaryPrepareBody>(request, 4 * 1024 * 1024)
  } catch {
    writeJson(response, 422, { error: { code: 'INVALID_INPUT', message: '临时请求无效' } })
    return
  }
  const round = body.messages.length > 0
  let query = body.question
  let rewrite: { inputTokens: number | null; outputTokens: number | null; durationMs: number; fallback: boolean } | null = null
  if (round) {
    const started = performance.now()
    try {
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
            ...(body.messages.map((entry) => ({ role: entry.role, content: entry.content, timestamp: Date.now() })) as UserMessage[]),
            {
              role: 'user' as const,
              content: '当前问题：' + body.question + '\n只输出用于知识库检索的查询。',
              timestamp: Date.now(),
            },
          ],
        },
      })
      const text = message.text.trim().slice(0, 64)
      if (text.length > 0) {
        query = text
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
    const result = await generateEmbeddings({
      baseUrl: body.model.baseUrl,
      apiKey: body.model.apiKey,
      modelId: body.model.upstreamModelId,
      input: [query],
      dimensions: embedDimensions(body),
      allowInsecureHttp: options.allowInsecureProviderHttp,
    })
    writeJson(response, 200, {
      status: 'ready', query,
      queryVector: [...(result.embeddings[0] ?? [])],
      rewrite,
      embeddingDurationMs: Math.round(performance.now() - embeddingStarted),
    })
  } catch {
    writeJson(response, 200, { status: 'unavailable', query, queryVector: [], rewrite, embeddingDurationMs: 0 })
  }
}

function embedDimensions(body: TemporaryPrepareBody): number {
  const extended = body as TemporaryPrepareBody & { embeddingDimensions?: number }
  if (typeof extended.embeddingDimensions === 'number' && extended.embeddingDimensions > 0) {
    return extended.embeddingDimensions
  }
  throw new ProviderGatewayError('embedding_response_invalid')
}

// stream answers the temporary request, emitting internal SSE events bound to
// the request context; browser cancellation propagates through the Go proxy.
async function handleStream(
  request: IncomingMessage,
  response: ServerResponse,
  options: AssistantRunnerOptions,
): Promise<void> {
  let body: TemporaryStreamBody
  try {
    body = await readBody<TemporaryStreamBody>(request, 8 * 1024 * 1024)
  } catch {
    writeJson(response, 422, { error: { code: 'INVALID_INPUT', message: '临时请求无效' } })
    return
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
  })
  const emit = (event: string, payload: Record<string, unknown>): boolean => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    return true
  }
  const sources = body.sources ?? []
  const evidenceState = body.evidenceState
  const noteOnly = /只根据笔记|仅根据笔记|只依据笔记|仅依据笔记/.test(body.question)
  const context = {
    systemPrompt: assistantSystemPrompt(evidenceState, noteOnly),
    messages: [
      ...(body.messages.map((entry) => ({ role: entry.role, content: entry.content, timestamp: Date.now() })) as UserMessage[]),
      ...(sources.length > 0 ? [sourceBlock(sources)] : []),
      { role: 'user' as const, content: body.question, timestamp: Date.now() },
    ],
  }
  const redactor = new StreamRedactor()
  const parser = new CitationParser(sources.length)
  const reasoner = new StreamRedactor()
  let reasoningSeen = false
  let answerSeen = false
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
        if (reasoningSeen && !answerSeen) {
          answerSeen = true
          const tail = reasoner.flush()
          if (tail.length > 0) emit('reasoning.delta', { delta: tail })
          emit('reasoning.completed', { durationMs: 0 })
        }
        const redacted = redactor.push(event.delta)
        for (const result of parser.push(redacted)) {
          if (result.kind === 'text' && result.text.length > 0) emit('answer.delta', { delta: result.text })
          else if (result.kind === 'citation') emit('answer.citation', { sourceOrdinal: result.ordinal })
          else throw new ProviderGatewayError('protocol_error')
        }
        continue
      }
    }
    const tail = reasoner.flush()
    if (!answerSeen && tail.length > 0) emit('reasoning.delta', { delta: tail })
    for (const result of parser.flush()) {
      if (result.kind === 'invalid') throw new ProviderGatewayError('protocol_error')
      if (result.kind === 'text' && result.text.length > 0) emit('answer.delta', { delta: result.text })
      else if (result.kind === 'citation') emit('answer.citation', { sourceOrdinal: result.ordinal })
    }
    const answerTail = redactor.flush()
    if (answerTail.length > 0) emit('answer.delta', { delta: answerTail })
    emit('usage.updated', {
      usage: {
        rewriteInputTokens: null, rewriteOutputTokens: null,
        answerInputTokens: usage?.input ?? null, answerOutputTokens: usage?.output ?? null,
      },
    })
    emit('run.completed', {
      status: 'succeeded',
      usage: {
        rewriteInputTokens: null, rewriteOutputTokens: null,
        answerInputTokens: usage?.input ?? null, answerOutputTokens: usage?.output ?? null,
      },
      timings: { rewriteMs: null, embeddingMs: null, retrievalMs: null, reasoningMs: null, answerMs: null },
      error: null,
      temporarySummary: null,
    })
    flush()
  } catch {
    emit('run.failed', {
      status: 'failed',
      usage: null, timings: null,
      error: { code: 'ASSISTANT_PROVIDER_UNAVAILABLE', message: 'Provider 暂时不可用' },
      temporarySummary: null,
    })
    flush()
  } finally {
    response.end()
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
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

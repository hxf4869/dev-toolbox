// V3 assistant workers (docs/16 §5.2/§11.2/§9.2): an AssistantRunner with two
// chat execution slots and an EmbeddingIndexRunner with a single low priority
// slot. Both reuse the service token API client; neither touches PostgreSQL.

import { randomUUID } from 'node:crypto'

import type { AssistantMessageEvent, Message, UserMessage } from '@earendil-works/pi-ai'

import {
  AssistantClient,
  AssistantClientError,
  type AssistantEvent,
  type ClaimedAssistantRun,
  type ClaimedIndexBatch,
  type RetrievalSourcePayload,
} from './client.js'
import { CitationParser } from './citation-parser.js'
import {
  ProviderGatewayError,
  anthropicBudgetFor,
  assistantStreamChat,
  generateEmbeddings,
  type AssistantReasoningLevel,
} from '../model-gateway.js'
import { assistantPromptVersion, assistantSystemPrompt, summaryPrompt, titlePrompt } from './prompts.js'
import { StreamRedactor } from './stream-redactor.js'
import { historyMessage } from './history-message.js'

const heartbeatIntervalMs = 10_000
const batchIntervalMs = 150
const batchMaximumBytes = 4 * 1024
const maximumAnswerRuntimeMs = 10 * 60_000
// Auxiliary title/summary maintenance runs after the run already succeeded.
// Its total wall-clock budget is independent of and far below the answer
// runtime cap, so a slow Provider cannot hold a chat execution slot for the
// full answer window (docs/16 §11.2).
const auxiliaryMaintenanceBudgetMs = 60_000
// The summary maintenance input gets its own model budget: the rolling
// summary trigger threshold (60% of the context window, docs/16 §10.3) minus
// a fixed generation reserve. It is independent of the answer input budget
// the Go API applies to claim.context.
const summaryMaintenanceShare = 0.6
const summaryGenerationReserveTokens = 1024

export interface AssistantRunnerOptions {
  readonly apiInternalUrl: string
  readonly serviceToken: string
  readonly workerId: string
  readonly allowInsecureProviderHttp: boolean
  readonly chatSlots?: number
}

export class AssistantExecutionError extends Error {
  constructor(readonly code: string, readonly detail: string, cause?: unknown) {
    super(detail, cause === undefined ? undefined : { cause })
    this.name = 'AssistantExecutionError'
  }
}

export class AssistantRunner {
  constructor(
    readonly client: AssistantClient,
    readonly allowInsecureProviderHttp: boolean,
  ) {}

  async run(claim: ClaimedAssistantRun, shutdownSignal?: AbortSignal): Promise<void> {
    const heartbeat = new RunHeartbeat(this.client, claim, shutdownSignal)
    const usage = {
      rewriteInputTokens: null as number | null,
      rewriteOutputTokens: null as number | null,
      answerInputTokens: null as number | null,
      answerOutputTokens: null as number | null,
      answerContextTokens: null as number | null,
    }
    const timings = {
      rewriteMs: null as number | null,
      embeddingMs: null as number | null,
      retrievalMs: null as number | null,
      reasoningMs: null as number | null,
      answerMs: null as number | null,
    }
    try {
      await heartbeat.start()
      await this.execute(claim, usage, timings, heartbeat)
    } catch (error) {
      if (heartbeat.leaseLost || shutdownSignal?.aborted) return
      const failure = normalizeFailure(error, heartbeat.stopRequested)
      try {
        await this.client.failRun(
          claim.run.id, claim.run.leaseVersion, failure.code, failure.detail, usage, timings,
        )
      } catch (failError) {
        if (!isLeaseConflict(failError)) throw failError
      }
      return
    } finally {
      // Ends the execution-lease heartbeat on every path. A tick that is
      // still in flight is neutralized inside RunHeartbeat, so its late 409
      // against the already-succeeded run cannot abort the maintenance below
      // (docs/16 §14).
      heartbeat.stop()
    }
    // Auxiliary maintenance only ever runs for a completed answer, after the
    // lease heartbeat stopped, in its own bounded cancel scope. It never
    // touches the execution lease and its failure never fails the answer.
    await this.maintainTitleAndSummary(claim, shutdownSignal)
  }

  private async execute(
    claim: ClaimedAssistantRun,
    usage: Record<string, number | null>,
    timings: Record<string, number | null>,
    heartbeat: RunHeartbeat,
  ): Promise<void> {
    const deadline = Date.now() + maximumAnswerRuntimeMs
    let query = redactProviderInput(
      claim.sensitivePolicy === 'redact' ? new StreamRedactor() : null,
      claim.context.question,
    )
    let rewriteFallback = false
    let queryVector: number[] = []
    let evidenceState = 'unavailable'
    let sources: readonly RetrievalSourcePayload[] = []

    if (claim.knowledge.state === 'ready' && claim.knowledge.generation !== null) {
      // Query rewrite only from the second round; first round uses the raw question.
      if (claim.context.messages.length > 0) {
        await this.emitPhase(claim, heartbeat, 'rewrite')
        const rewritten = await this.rewriteQuery(claim, heartbeat.signal)
        query = rewritten.query
        rewriteFallback = rewritten.fallback
        usage.rewriteInputTokens = rewritten.inputTokens
        usage.rewriteOutputTokens = rewritten.outputTokens
        timings.rewriteMs = rewritten.durationMs
      }
      await this.emitPhase(claim, heartbeat, 'embedding')
      const embeddingStarted = performance.now()
      const embedding = await generateEmbeddings({
        baseUrl: claim.knowledge.baseUrl,
        apiKey: claim.knowledge.apiKey,
        modelId: claim.knowledge.modelId,
        input: [query],
        dimensions: claim.knowledge.dimensions ?? 0,
        allowInsecureHttp: this.allowInsecureProviderHttp,
        signal: heartbeat.signal,
      }).catch(() => {
        // A query embedding failure only degrades this run (docs/16 §7.3).
        return null
      })
      timings.embeddingMs = Math.round(performance.now() - embeddingStarted)
      if (embedding !== null && embedding.embeddings.length === 1) {
        queryVector = [...embedding.embeddings[0]!]
        await this.emitPhase(claim, heartbeat, 'retrieval')
        const retrievalStarted = performance.now()
        const result = await this.client.retrieval(
          claim.run.id, claim.run.leaseVersion, claim.knowledge.generation, query, queryVector, heartbeat.signal,
        )
        timings.retrievalMs = Math.round(performance.now() - retrievalStarted)
        evidenceState = result.evidenceState
        sources = result.sources
        await this.emit(claim, heartbeat, [{
          eventId: randomUUID(), type: 'sources.ready',
          payload: { knowledgeState: 'ready', evidenceState, providedSourceCount: sources.length, rewriteFallback },
        }])
      } else {
        evidenceState = 'unavailable'
        await this.emit(claim, heartbeat, [{
          eventId: randomUUID(), type: 'sources.ready',
          payload: { knowledgeState: 'unavailable', evidenceState, providedSourceCount: 0, rewriteFallback },
        }])
      }
    } else {
      await this.emit(claim, heartbeat, [{
        eventId: randomUUID(), type: 'sources.ready',
        payload: { knowledgeState: 'unavailable', evidenceState, providedSourceCount: 0, rewriteFallback },
      }])
    }

    await this.emitPhase(claim, heartbeat, 'answer')
    await this.streamAnswer(claim, usage, timings, heartbeat, evidenceState, sources, deadline)
  }

  private async rewriteQuery(
    claim: ClaimedAssistantRun,
    signal: AbortSignal,
  ): Promise<{ query: string; inputTokens: number | null; outputTokens: number | null; durationMs: number; fallback: boolean }> {
    const started = performance.now()
    const fallbackQuery = redactProviderInput(
      claim.sensitivePolicy === 'redact' ? new StreamRedactor() : null,
      claim.context.question,
    )
    const inputRedactor = claim.sensitivePolicy === 'redact' ? new StreamRedactor() : null
    const context = {
      systemPrompt: assistantSystemPrompt('ready', false) + '\n\n' +
        '现在只生成检索查询，不要回答问题。',
      messages: [
        ...providerHistoryMessages(claim, inputRedactor),
        {
          role: 'user' as const,
          content: redactProviderInput(
            inputRedactor,
            '当前问题：' + claim.context.question + '\n只输出用于知识库检索的查询。',
          ),
          timestamp: Date.now(),
        },
      ],
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (signal.aborted) throw new AssistantExecutionError('ASSISTANT_PROVIDER_UNAVAILABLE', '回答已取消')
      try {
        const message = await collectAssistantTurn({
          protocol: claim.model.protocol,
          baseUrl: claim.model.baseUrl,
          apiKey: claim.model.apiKey,
          modelId: claim.model.upstreamModelId,
          contextWindow: claim.model.contextWindow,
          maxOutputTokens: Math.min(256, claim.model.maxOutputTokens),
          reasoning: 'off',
          context,
          allowInsecureHttp: this.allowInsecureProviderHttp,
          deadlineAt: new Date(Date.now() + maximumAnswerRuntimeMs),
          signal,
        })
        const text = message.text.trim().slice(0, 64)
        if (text.length > 0) {
          return {
            // Query embedding is a separate Provider request and therefore
            // gets its own redactor lifecycle (docs/16 §6.2).
            query: redactProviderInput(
              claim.sensitivePolicy === 'redact' ? new StreamRedactor() : null,
              text,
            ),
            inputTokens: message.usage.input,
            outputTokens: message.usage.output,
            durationMs: Math.round(performance.now() - started),
            fallback: false,
          }
        }
        break
      } catch (error) {
        const retryable = error instanceof ProviderGatewayError && error.category === 'unavailable'
        if (!retryable || attempt === 2) break
      }
    }
    // Rewrite failure falls back to the raw question with rewriteFallback.
    return {
      query: fallbackQuery, inputTokens: null, outputTokens: null,
      durationMs: Math.round(performance.now() - started), fallback: true,
    }
  }

  private async streamAnswer(
    claim: ClaimedAssistantRun,
    usage: Record<string, number | null>,
    timings: Record<string, number | null>,
    heartbeat: RunHeartbeat,
    evidenceState: string,
    sources: readonly RetrievalSourcePayload[],
    deadline: number,
  ): Promise<void> {
    // One same-model retry is allowed only before any user-visible delta
    // (docs/16 §11.2); afterwards an interruption fails the run and keeps the
    // partial content.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let sawDelta = false
      try {
        await this.answerOnce(claim, usage, timings, heartbeat, evidenceState, sources, deadline, (sent) => {
          if (sent) sawDelta = true
        })
        return
      } catch (error) {
        const retryable = !sawDelta && error instanceof ProviderGatewayError && error.category === 'unavailable'
        if (retryable && attempt === 1) continue
        throw error
      }
    }
  }

  private async answerOnce(
    claim: ClaimedAssistantRun,
    usage: Record<string, number | null>,
    timings: Record<string, number | null>,
    heartbeat: RunHeartbeat,
    evidenceState: string,
    sources: readonly RetrievalSourcePayload[],
    deadline: number,
    onDelta: (sent: boolean) => void,
  ): Promise<void> {
    const noteOnly = isNoteOnlyRequest(claim.context.question)
    const systemPrompt = assistantSystemPrompt(evidenceState, noteOnly)
    const outbound = providerAnswerMessages(claim, sources)
    const context = {
      systemPrompt,
      messages: outbound,
    }
    const reasoningStarted = performance.now()
    let answerStarted: number | null = null
    let reasoningSeen = false
    let answerSeen = false

    const redactor = new StreamRedactor()
    const parser = new CitationParser(sources.length)
    const reasoner = new StreamRedactor()

    const flusher = new EventFlusher(async (events) => {
      await this.client.events(claim.run.id, claim.run.leaseVersion, events, heartbeat.signal)
    })

    const stream = assistantStreamChat({
      protocol: claim.model.protocol,
      baseUrl: claim.model.baseUrl,
      apiKey: claim.model.apiKey,
      modelId: claim.model.upstreamModelId,
      contextWindow: claim.model.contextWindow,
      maxOutputTokens: claim.model.maxOutputTokens,
      reasoning: (claim.reasoning.reasoning === 'off' ? 'off' : claim.reasoning.reasoning) as AssistantReasoningLevel,
      context,
      deadlineAt: new Date(deadline),
      allowInsecureHttp: this.allowInsecureProviderHttp,
      signal: heartbeat.signal,
    })

    let usageCaptured = false
    for await (const event of stream) {
      ensureAlive(heartbeat, deadline)
      if (event.type === 'done') {
        usage.answerInputTokens = event.message.usage.input
        usage.answerOutputTokens = event.message.usage.output
        const contextTokens = event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite
        usage.answerContextTokens = contextTokens > 0 ? contextTokens : null
        usageCaptured = true
        break
      }
      if (event.type === 'error') {
        throw new ProviderGatewayError('unavailable', new Error(event.error.errorMessage ?? 'stream error'))
      }
      if (event.type === 'thinking_delta') {
        reasoningSeen = true
        const redacted = reasoner.push(event.delta)
        if (redacted.length > 0) {
          await flusher.push('reasoning.delta', { delta: redacted })
        }
        continue
      }
      if (event.type === 'text_delta') {
        if (answerStarted === null) answerStarted = performance.now()
        if (reasoningSeen && !answerSeen) {
          answerSeen = true
          timings.reasoningMs = Math.round(performance.now() - reasoningStarted)
          const tail = reasoner.flush()
          if (tail.length > 0) {
            await flusher.push('reasoning.delta', { delta: tail })
          }
          await flusher.push('reasoning.completed', { durationMs: timings.reasoningMs ?? 0 })
        }
        // Output redaction precedes citation parsing; any reserved prefix is a
        // hard protocol failure (docs/16 §8.11).
        const redacted = redactor.push(event.delta)
        await submitCitationResults(parser.push(redacted), flusher, onDelta)
        continue
      }
    }
    timings.answerMs = answerStarted === null ? null : Math.round(performance.now() - answerStarted)
    const reasoningTail = reasoner.flush()
    if (!answerSeen && reasoningSeen) {
      timings.reasoningMs = Math.round(performance.now() - reasoningStarted)
      if (reasoningTail.length > 0) await flusher.push('reasoning.delta', { delta: reasoningTail })
      await flusher.push('reasoning.completed', { durationMs: timings.reasoningMs ?? 0 })
    }
    const answerTail = redactor.flush()
    await submitCitationResults(parser.push(answerTail), flusher, onDelta)
    await submitCitationResults(parser.flush(), flusher, onDelta)
    await flusher.push('usage.updated', {
      usage: {
        rewriteInputTokens: usage.rewriteInputTokens, rewriteOutputTokens: usage.rewriteOutputTokens,
        answerInputTokens: usage.answerInputTokens, answerOutputTokens: usage.answerOutputTokens,
        answerContextTokens: usage.answerContextTokens,
      },
    })
    await flusher.drain()
    if (!usageCaptured) {
      throw new AssistantExecutionError('ASSISTANT_PROVIDER_PROTOCOL_ERROR', 'Provider 未返回完整回答')
    }
    await this.emitPhase(claim, heartbeat, 'finalizing')
    await this.client.completeRun(claim.run.id, claim.run.leaseVersion, usage, timings, heartbeat.signal)
  }

  private async emit(claim: ClaimedAssistantRun, heartbeat: RunHeartbeat, events: readonly AssistantEvent[]): Promise<void> {
    await this.client.events(claim.run.id, claim.run.leaseVersion, events, heartbeat.signal)
  }

  private async emitPhase(
    claim: ClaimedAssistantRun,
    heartbeat: RunHeartbeat,
    phase: 'rewrite' | 'embedding' | 'retrieval' | 'answer' | 'finalizing',
  ): Promise<void> {
    await this.emit(claim, heartbeat, [{ eventId: randomUUID(), type: 'run.status', payload: { phase } }])
  }

  // Best-effort title after the first successful answer and cumulative
  // summary upkeep. Runs strictly after completeRun returned and the
  // execution-lease heartbeat stopped, inside its own finite cancel scope
  // that still responds to the run's original shutdown signal. It reuses the
  // lease-free title/summary API and never re-issues the answer request
  // (docs/16 §11.2, §14).
  private async maintainTitleAndSummary(claim: ClaimedAssistantRun, shutdownSignal?: AbortSignal): Promise<void> {
    if (shutdownSignal?.aborted) return
    const maintenance = new AbortController()
    const deadline = Date.now() + auxiliaryMaintenanceBudgetMs
    const budgetTimer = setTimeout(
      () => maintenance.abort(new Error('assistant auxiliary maintenance budget exhausted')),
      auxiliaryMaintenanceBudgetMs,
    )
    const abortOnShutdown = (): void => {
      maintenance.abort(shutdownSignal?.reason)
    }
    shutdownSignal?.addEventListener('abort', abortOnShutdown, { once: true })
    try {
      await this.maintainTitle(claim, maintenance.signal, deadline)
      await this.maintainSummary(claim, maintenance.signal, deadline)
    } finally {
      clearTimeout(budgetTimer)
      shutdownSignal?.removeEventListener('abort', abortOnShutdown)
    }
  }

  private async maintainTitle(claim: ClaimedAssistantRun, signal: AbortSignal, deadline: number): Promise<void> {
    const firstAnswer = claim.context.messages.filter((message) => message.role === 'assistant').length === 0
    if (!firstAnswer) return
    try {
      const titleRedactor = claim.sensitivePolicy === 'redact' ? new StreamRedactor() : null
      const message = await collectAssistantTurn({
        protocol: claim.model.protocol,
        baseUrl: claim.model.baseUrl,
        apiKey: claim.model.apiKey,
        modelId: claim.model.upstreamModelId,
        contextWindow: claim.model.contextWindow,
        maxOutputTokens: Math.min(64, claim.model.maxOutputTokens),
        reasoning: 'off',
        context: {
          systemPrompt: titlePrompt,
          messages: [
            {
              role: 'user',
              content: redactProviderInput(titleRedactor, claim.context.question),
              timestamp: Date.now(),
            },
          ],
        },
        allowInsecureHttp: this.allowInsecureProviderHttp,
        deadlineAt: new Date(deadline),
        signal,
      })
      const title = message.text.trim().replace(/^["'「『]|["'」』]$/g, '').slice(0, 30)
      if (title.length > 0) {
        await this.client.runTitle(claim.run.id, title, signal)
      }
    } catch {
      // Title failure keeps the provisional title and never fails the answer.
    }
  }

  private async maintainSummary(claim: ClaimedAssistantRun, signal: AbortSignal, deadline: number): Promise<void> {
    const summarySource = claim.context.summarySource
    if (summarySource === null || summarySource.messages.length === 0) return
    const redactor = claim.sensitivePolicy === 'redact' ? new StreamRedactor() : null
    // The maintenance input merges the stored baseline summary with the new
    // uncovered messages; its watermark targets only what actually entered
    // the model input (docs/16 §10.3).
    const input = summaryMaintenanceInput(claim.model.contextWindow, redactor, summarySource)
    if (input === null) return
    try {
      const message = await collectAssistantTurn({
        protocol: claim.model.protocol,
        baseUrl: claim.model.baseUrl,
        apiKey: claim.model.apiKey,
        modelId: claim.model.upstreamModelId,
        contextWindow: claim.model.contextWindow,
        maxOutputTokens: Math.min(1024, claim.model.maxOutputTokens),
        reasoning: 'off',
        context: {
          systemPrompt: summaryPrompt(),
          messages: [
            {
              role: 'user',
              content: input.prompt,
              timestamp: Date.now(),
            },
          ],
        },
        allowInsecureHttp: this.allowInsecureProviderHttp,
        deadlineAt: new Date(deadline),
        signal,
      })
      const parsed = parseSummary(message.text)
      if (parsed !== null) {
        await this.client.runSummary(
          claim.run.id, parsed, input.throughMessageSequence, input.baselineThroughMessageSequence,
          { modelId: claim.model.id, displayName: claim.model.displayName }, signal,
        )
      }
    } catch {
      // Summary failure keeps the complete history and the stored baseline;
      // the run stays successful.
    }
  }
}

interface SummaryMaintenanceInput {
  readonly prompt: string
  readonly throughMessageSequence: number
  readonly baselineThroughMessageSequence: number
}

// summaryMaintenanceInput assembles the cumulative summary model input: the
// redacted stored baseline summary plus the consecutive oldest-first prefix
// of uncovered messages that fits the maintenance budget (docs/16 §10.3).
// The target watermark is the sequence of the last message actually included,
// so it can never advance past content the model did not see. Returns null —
// skip maintenance without advancing anything — when even the baseline alone
// does not fit or no message fits beside it.
export function summaryMaintenanceInput(
  contextWindow: number,
  redactor: StreamRedactor | null,
  summarySource: NonNullable<ClaimedAssistantRun['context']['summarySource']>,
): SummaryMaintenanceInput | null {
  const budget = Math.floor(contextWindow * summaryMaintenanceShare) - summaryGenerationReserveTokens
  if (budget <= 0) return null
  const baseline = summarySource.prior === null ? 0 : summarySource.prior.throughMessageSequence
  const sections: string[] = []
  let used = 0
  if (summarySource.prior !== null) {
    // The stored baseline is Provider input like any other content and goes
    // through the same redactor (docs/16 §6.2).
    const baselineText = redactProviderInput(redactor, JSON.stringify(summarySource.prior.summary))
    const baselineCost = estimateTokens(baselineText)
    if (baselineCost > budget) return null
    sections.push('以下是当前会话已有的结构化摘要（维护基准）：\n' + baselineText)
    used = baselineCost
  }
  const lines: string[] = []
  let through = baseline
  for (const message of summarySource.messages) {
    const line = redactProviderInput(redactor, `${message.role === 'user' ? '用户' : '助手'}: ${message.content}`)
    const cost = estimateTokens(line)
    if (used + cost > budget) break
    lines.push(line)
    used += cost
    through = message.sequence
  }
  if (lines.length === 0) return null
  sections.push('以下是该基准之后新增、尚未进入摘要的成功对话：\n' + lines.join('\n\n'))
  sections.push(
    '请把基准摘要与新增对话合并为一份更新后的完整结构化摘要：' +
    '基准中仍然成立的旧事实、旧纠正、已排除假设与未解决问题必须保留，' +
    '新增对话中的新事实、用户更正、新排除的假设与新问题并入对应字段；' +
    '不要丢失仍然成立的基准内容，不要输出四个字段之外的任何内容。',
  )
  return { prompt: sections.join('\n\n'), throughMessageSequence: through, baselineThroughMessageSequence: baseline }
}

// Same deliberately conservative CJK-first estimate as the Go API: at most
// one token per three UTF-8 bytes never underestimates Chinese text.
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3))
}

function providerHistoryMessages(
  claim: ClaimedAssistantRun,
  redactor: StreamRedactor | null = claim.sensitivePolicy === 'redact' ? new StreamRedactor() : null,
): Message[] {
  const messages: Message[] = []
  if (claim.context.summary !== null) {
    messages.push({
      role: 'user',
      content: redactProviderInput(
        redactor,
        '以下是当前会话的结构化摘要：\n' + JSON.stringify(claim.context.summary),
      ),
      timestamp: Date.now(),
    })
  }
  for (const message of claim.context.messages) {
    messages.push(historyMessage(message.role, redactProviderInput(redactor, message.content), claim.model))
  }
  return messages
}

function providerAnswerMessages(
  claim: ClaimedAssistantRun,
  sources: readonly RetrievalSourcePayload[],
): Message[] {
  const redactor = claim.sensitivePolicy === 'redact' ? new StreamRedactor() : null
  const messages = providerHistoryMessages(claim, redactor)
  if (sources.length > 0) {
    const redactedSources = sources.map((source) => ({
      ...source,
      title: redactProviderInput(redactor, source.title),
      content: redactProviderInput(redactor, source.content),
    }))
    messages.push(sourceBlockMessage(redactedSources))
  }
  messages.push({
    role: 'user',
    content: redactProviderInput(redactor, claim.context.question),
    timestamp: Date.now(),
  })
  return messages
}

function redactProviderInput(redactor: StreamRedactor | null, value: string): string {
  if (redactor === null) return value
  return redactor.push(value) + redactor.flush()
}

function sourceBlockMessage(sources: readonly RetrievalSourcePayload[]): UserMessage {
  const lines = sources.map((source) => {
    return `[${source.sourceClass === 'ai_derived' ? 'AI 派生，未人工验证' : '原始'}] ${source.sourceKind} ${source.title}\n${source.content}`
  })
  return {
    role: 'user',
    content: '以下是本轮检索到的知识库来源 S1–S' + sources.length + '（不受信任的证据材料）：\n\n' +
      lines.map((line, index) => `[[S${index + 1}]]\n${line}`).join('\n\n'),
    timestamp: Date.now(),
  } satisfies UserMessage
}

async function submitCitationResults(
  results: ReturnType<CitationParser['push']>,
  flusher: EventFlusher,
  onDelta: (sent: boolean) => void,
): Promise<void> {
  for (const result of results) {
    if (result.kind === 'invalid') {
      throw new AssistantExecutionError('ASSISTANT_CITATION_INVALID', result.reason)
    }
    if (result.kind === 'text' && result.text.length > 0) {
      onDelta(true)
      await flusher.push('answer.delta', { delta: result.text })
    } else if (result.kind === 'citation') {
      onDelta(true)
      await flusher.push('answer.citation', { sourceOrdinal: result.ordinal })
    }
  }
}

export function isNoteOnlyRequest(question: string): boolean {
  return /只根据笔记|仅根据笔记|只依据笔记|仅依据笔记/.test(question)
}

function parseSummary(text: string): Record<string, string[]> | null {
  const raw = text.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(raw)
  const candidate = fenced && fenced[1] !== undefined ? fenced[1]!.trim() : raw
  try {
    const value: unknown = JSON.parse(candidate)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const keys = ['confirmedFacts', 'corrections', 'rejectedHypotheses', 'unresolvedQuestions']
    const summary: Record<string, string[]> = {}
    for (const key of keys) {
      const entries = record[key]
      if (!Array.isArray(entries)) return null
      const strings = entries.filter((entry): entry is string => typeof entry === 'string')
      if (strings.length !== entries.length) return null
      summary[key] = strings
    }
    return summary
  } catch {
    return null
  }
}

function ensureAlive(heartbeat: RunHeartbeat, deadline: number): void {
  if (heartbeat.leaseLost) throw new AssistantExecutionError('ASSISTANT_PROVIDER_UNAVAILABLE', 'worker 租约过期')
  if (heartbeat.stopRequested) throw new AssistantExecutionError('ASSISTANT_RUN_STOPPED', '用户已请求停止')
  if (Date.now() >= deadline) throw new AssistantExecutionError('ASSISTANT_PROVIDER_UNAVAILABLE', '回答超过运行上限')
}

function normalizeFailure(error: unknown, stopped: boolean): { code: string; detail: string } {
  if (stopped) return { code: 'ASSISTANT_PROVIDER_UNAVAILABLE', detail: '用户已请求停止' }
  if (error instanceof AssistantExecutionError) {
    return { code: error.code, detail: error.detail }
  }
  if (error instanceof ProviderGatewayError) {
    if (error.category === 'credentials_invalid') return { code: 'ASSISTANT_PROVIDER_CREDENTIALS_INVALID', detail: 'Provider 凭据无效' }
    if (error.category === 'reasoning_unsupported') return { code: 'ASSISTANT_REASONING_UNSUPPORTED', detail: '该思考档位无法发送到当前模型' }
    if (error.category === 'protocol_error') return { code: 'ASSISTANT_PROVIDER_PROTOCOL_ERROR', detail: 'Provider 返回了不符合协议的响应' }
    if (error.category === 'embedding_dimension_mismatch') return { code: 'EMBEDDING_DIMENSION_MISMATCH', detail: '向量维度与配置不一致' }
    if (error.category === 'embedding_response_invalid') return { code: 'EMBEDDING_RESPONSE_INVALID', detail: 'Embedding 响应无效' }
    return { code: 'ASSISTANT_PROVIDER_UNAVAILABLE', detail: 'Provider 暂时不可用' }
  }
  return { code: 'INTERNAL_ERROR', detail: 'AI worker 内部错误' }
}

function isLeaseConflict(error: unknown): boolean {
  return error instanceof AssistantClientError && error.status === 409 && error.code === 'ASSISTANT_LEASE_CONFLICT'
}

export { anthropicBudgetFor }

interface CollectedTurn {
  text: string
  usage: { input: number; output: number }
}

// collectAssistantTurn runs a complete non-streamed turn for auxiliary
// requests (rewrite, title, summary): reasoning stays off and usage returns.
async function collectAssistantTurn(request: Parameters<typeof assistantStreamChat>[0]): Promise<CollectedTurn> {
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

// EventFlusher batches small deltas by time and size before submitting.
export class EventFlusher {
  #queue: AssistantEvent[] = []
  #bytes = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #pending: Promise<void> = Promise.resolve()
  #failure: unknown = null

  constructor(private readonly submit: (events: readonly AssistantEvent[]) => Promise<void>) {}

  async push(type: string, payload: Record<string, unknown>): Promise<void> {
    if (this.#failure !== null) throw this.#failure
    const event: AssistantEvent = { eventId: randomUUID(), type, payload }
    this.#queue.push(event)
    this.#bytes += JSON.stringify(payload).length
    // Go accepts at most 50 events per request, including tiny parsed deltas.
    if (this.#bytes >= batchMaximumBytes || this.#queue.length >= 50) {
      await this.drain()
      return
    }
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null
        void this.drain().catch((error: unknown) => {
          if (this.#failure === null) this.#failure = error
        })
      }, batchIntervalMs)
    }
  }

  async drain(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#queue.length > 0) {
      const batch = this.#queue
      this.#queue = []
      this.#bytes = 0
      this.#pending = this.#pending.then(() => this.submit(batch))
    }
    try {
      await this.#pending
    } catch (error) {
      if (this.#failure === null) this.#failure = error
      throw error
    }
    if (this.#failure !== null) throw this.#failure
  }
}

// RunHeartbeat keeps the run lease alive and surfaces stop/lease loss.
class RunHeartbeat {
  readonly #controller = new AbortController()
  #timer: ReturnType<typeof setTimeout> | undefined
  #stopped = false
  readonly #shutdownAbort: (() => void) | null
  leaseLost = false
  stopRequested = false

  constructor(
    private readonly client: AssistantClient,
    private readonly claim: ClaimedAssistantRun,
    private readonly shutdownSignal?: AbortSignal,
  ) {
    this.#shutdownAbort = shutdownSignal === undefined ? null : () => {
      this.leaseLost = true
      this.#controller.abort(this.shutdownSignal?.reason)
    }
    if (shutdownSignal?.aborted) {
      this.#shutdownAbort?.()
    } else if (this.#shutdownAbort !== null) {
      shutdownSignal?.addEventListener('abort', this.#shutdownAbort, { once: true })
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  async start(): Promise<void> {
    await this.tick()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    if (this.#shutdownAbort !== null) {
      this.shutdownSignal?.removeEventListener('abort', this.#shutdownAbort)
    }
  }

  private async tick(): Promise<void> {
    if (this.#stopped) return
    let result: { readonly stopRequested: boolean }
    try {
      result = await this.client.heartbeatRun(this.claim.run.id, this.claim.run.leaseVersion)
    } catch (error) {
      // stop() may have run while this request was in flight (the execution
      // phase already ended); a late 409 against the succeeded run must not
      // flip leaseLost or abort anything afterwards (docs/16 §14).
      if (this.#stopped) return
      this.leaseLost = true
      this.#controller.abort(error)
      return
    }
    if (this.#stopped) return
    if (result.stopRequested) {
      this.stopRequested = true
      this.#controller.abort(new Error('assistant run stop requested'))
      return
    }
    this.#timer = setTimeout(() => {
      void this.tick()
    }, heartbeatIntervalMs)
  }
}

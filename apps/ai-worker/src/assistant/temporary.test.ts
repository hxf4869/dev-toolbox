// Temporary lane rolling summary maintenance (DT-R04): after a successful
// answer stream the worker merges the request's prior summary with the full
// uncovered prefix from summarySource and reports the sanitized cumulative
// summary on run.completed. The Provider is a deterministic
// openai-completions SSE fixture, mirroring runner-maintenance.test.ts.
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleTemporaryRequest } from './temporary.js'
import type { AssistantRunnerOptions } from './index.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

interface SseEvent {
  event: string
  data: Record<string, unknown>
}

interface RecordedProviderCall {
  kind: 'answer' | 'summary'
  body: string
}

interface StubHandlers {
  answerModelText?: string
  // Summary model response text; defaults to a valid merged summary with
  // empty and whitespace-only entries that sanitization must drop.
  summaryModelText?: string
  // Replaces the whole summary Provider response (failure/timeout injection).
  summaryFetch?: (signal: AbortSignal | undefined) => Response | Promise<Response>
}

const options: AssistantRunnerOptions = {
  apiInternalUrl: 'http://api.example.test',
  serviceToken: 'synthetic-service-token',
  workerId: 'temporary-test-worker',
  allowInsecureProviderHttp: true,
}

function baseStreamBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: {
      id: '9a5a8a2a-4444-4444-8444-444444444444',
      displayName: 'fixture model',
      upstreamModelId: 'fixture-model',
      providerId: '9a5a8a2a-5555-4555-8555-555555555555',
      providerDisplayName: 'fixture provider',
      protocol: 'openai-completions',
      baseUrl: 'http://provider.fixture.test',
      apiKey: 'fixture-provider-key',
      contextWindow: 32768,
      maxOutputTokens: 4096,
    },
    reasoning: 'off',
    sensitivePolicy: 'allow',
    promptVersion: 'assistant-answer-v2',
    summary: null,
    messages: [],
    question: '合成问题',
    knowledgeState: 'unavailable',
    evidenceState: 'unavailable',
    sources: [],
    summarySource: null,
    ...overrides,
  }
}

function prefixMessages(count: number): { role: 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'user' | 'assistant'; content: string }[] = []
  for (let index = 0; index < count; index++) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `第${index + 1}条历史消息：临时会话滚动摘要维护的前缀内容样本`,
    })
  }
  return messages
}

function rollingSummarySource(count = 18): Record<string, unknown> {
  return {
    prior: {
      confirmedFacts: ['基准中记录的架构边界'],
      corrections: ['基准中的用户纠正'],
      rejectedHypotheses: [],
      unresolvedQuestions: [],
    },
    messages: prefixMessages(count),
  }
}

const defaultSummaryModelText = JSON.stringify({
  confirmedFacts: ['旧事实保留', '', '   '],
  corrections: ['合并后的纠正'],
  rejectedHypotheses: [],
  unresolvedQuestions: [''],
})

async function runTemporaryStream(
  handlers: StubHandlers,
  bodyOverrides: Record<string, unknown> = {},
): Promise<{ providerCalls: RecordedProviderCall[]; timeline: string[]; events: SseEvent[] }> {
  const providerCalls: RecordedProviderCall[] = []
  const timeline: string[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (!url.endsWith('/chat/completions')) {
      throw new Error(`unexpected synthetic request: ${url}`)
    }
    const body = typeof init?.body === 'string' ? init.body : ''
    const request = JSON.parse(body) as { messages: { role: string; content: string }[] }
    const system = request.messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .map((message) => message.content).join('\n')
    const kind = /confirmedFacts/.test(system) ? 'summary' as const : 'answer' as const
    providerCalls.push({ kind, body })
    timeline.push(`provider:${kind}`)
    if (kind === 'summary' && handlers.summaryFetch) return handlers.summaryFetch(init?.signal)
    const text = kind === 'summary'
      ? handlers.summaryModelText ?? defaultSummaryModelText
      : handlers.answerModelText ?? '合成回答正文'
    return completionSse(text)
  })
  vi.stubGlobal('fetch', fetch)

  const chunks: string[] = []
  const emitter = new EventEmitter()
  const response = Object.assign(emitter, {
    destroyed: false,
    writableEnded: false,
    writeHead: () => undefined,
    write: (chunk: string) => {
      chunks.push(chunk)
      const eventName = /^event: (.+)$/m.exec(chunk)?.[1]
      if (eventName !== undefined) timeline.push(`sse:${eventName}`)
      return true
    },
    flushHeaders: () => undefined,
    end: () => {
      emitter.writableEnded = true
    },
  }) as unknown as ServerResponse
  const request = Readable.from([Buffer.from(JSON.stringify(baseStreamBody(bodyOverrides)))]) as unknown as IncomingMessage

  await handleTemporaryRequest(request, response, options, '/internal/assistant/temporary/stream')

  const events: SseEvent[] = []
  for (const block of chunks.join('').split('\n\n')) {
    if (block.trim() === '') continue
    const eventName = /^event: (.+)$/m.exec(block)?.[1]
    const dataLine = /^data: (.+)$/m.exec(block)?.[1]
    if (eventName === undefined || dataLine === undefined) continue
    events.push({ event: eventName, data: JSON.parse(dataLine) as Record<string, unknown> })
  }
  return { providerCalls, timeline, events }
}

function completionSse(text: string): Response {
  const chunk = (delta: Record<string, unknown>): string =>
    'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n'
  const usage = 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 48, total_tokens: 168 },
  }) + '\n\n'
  return new Response(
    chunk({ role: 'assistant' }) + chunk({ content: text }) + usage + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function completedEvent(events: SseEvent[]): SseEvent {
  const event = events.find((candidate) => candidate.event === 'run.completed')
  expect(event).toBeDefined()
  return event!
}

function summaryRequestBody(providerCalls: RecordedProviderCall[]): {
  reasoning_effort?: unknown
  max_tokens?: number
  max_completion_tokens?: number
  model?: string
  messages: { role: string; content: string }[]
} {
  const call = providerCalls.find((candidate) => candidate.kind === 'summary')
  expect(call).toBeDefined()
  return JSON.parse(call!.body)
}

describe('temporary rolling summary maintenance (DT-R04)', () => {
  it('maintains a cumulative summary after a successful answer and reports the sanitized result', async () => {
    const { providerCalls, timeline, events } = await runTemporaryStream(
      {},
      { summarySource: rollingSummarySource() },
    )

    expect(providerCalls.filter((call) => call.kind === 'answer')).toHaveLength(1)
    const summaryRequest = summaryRequestBody(providerCalls)
    const summaryInput = summaryRequest.messages.at(-1)!.content
    expect(summaryInput).toContain('维护基准')
    expect(summaryInput).toContain('基准中记录的架构边界')
    expect(summaryInput).toContain('基准中的用户纠正')
    expect(summaryInput).toContain(prefixMessages(18)[3]!.content)
    expect(summaryInput).toContain('合并')
    // Same model snapshot with reasoning off and the bounded output cap.
    expect(summaryRequest.model).toBe('fixture-model')
    expect(summaryRequest.reasoning_effort).toBeUndefined()
    expect(summaryRequest.max_completion_tokens ?? summaryRequest.max_tokens).toBe(1024)

    // Maintenance runs after the answer stream and before the terminal events.
    expect(timeline.indexOf('provider:summary')).toBeGreaterThan(timeline.indexOf('provider:answer'))
    expect(timeline.indexOf('provider:summary')).toBeLessThan(timeline.indexOf('sse:usage.updated'))
    expect(timeline.indexOf('sse:usage.updated')).toBeLessThan(timeline.indexOf('sse:run.completed'))

    const completed = completedEvent(events)
    expect(completed.data.status).toBe('succeeded')
    expect(completed.data.temporarySummary).toEqual({
      confirmedFacts: ['旧事实保留'],
      corrections: ['合并后的纠正'],
      rejectedHypotheses: [],
      unresolvedQuestions: [],
    })
    // Answer usage/timings reporting is unchanged by maintenance.
    const usageUpdated = events.find((candidate) => candidate.event === 'usage.updated')!
    expect(usageUpdated.data.usage).toEqual(completed.data.usage)
    expect(usageUpdated.data.usage).toMatchObject({ answerInputTokens: 120, answerOutputTokens: 48 })
    expect(events.find((candidate) => candidate.event === 'run.failed')).toBeUndefined()
  })

  it('redacts sensitive model output before the summary enters the public terminal', async () => {
    // Synthetic fixture values shaped like the redactor's token/private-IP
    // rules; not real credentials.
    const summaryModelText = JSON.stringify({
      confirmedFacts: ['网关使用 Bearer SYNTHETICTOKEN12345678 访问 192.168.77.77'],
      corrections: [],
      rejectedHypotheses: [],
      unresolvedQuestions: [],
    })
    const { events } = await runTemporaryStream(
      { summaryModelText },
      { sensitivePolicy: 'redact', summarySource: rollingSummarySource() },
    )

    const completed = completedEvent(events)
    const summary = JSON.stringify(completed.data.temporarySummary)
    expect(summary).not.toContain('SYNTHETICTOKEN12345678')
    expect(summary).not.toContain('192.168.77.77')
    expect(summary).toContain('<TOKEN_1>')
    expect(summary).toContain('<INTERNAL_IP_1>')
  })

  it.each(['allow', 'redact'])('applies %s to temporary answers and summaries', async (sensitivePolicy) => {
    const text = '合成服务地址 192.168.77.77'
    const { events } = await runTemporaryStream({
      answerModelText: text,
      summaryModelText: JSON.stringify({ confirmedFacts: [text], corrections: [], rejectedHypotheses: [], unresolvedQuestions: [] }),
    }, { sensitivePolicy, summarySource: rollingSummarySource() })
    const answer = events.filter((event) => event.event === 'answer.delta').map((event) => event.data.delta).join('')
    const expected = sensitivePolicy === 'allow' ? text : '合成服务地址 <INTERNAL_IP_1>'
    expect(answer).toBe(expected)
    expect(completedEvent(events).data.temporarySummary).toMatchObject({ confirmedFacts: [expected] })
  })

  it('skips maintenance entirely when prior plus the full prefix exceeds the budget', async () => {
    const { providerCalls, events } = await runTemporaryStream(
      {},
      { model: { ...(baseStreamBody().model as Record<string, unknown>), contextWindow: 2000 }, summarySource: rollingSummarySource() },
    )

    expect(providerCalls.filter((call) => call.kind === 'answer')).toHaveLength(1)
    expect(providerCalls.filter((call) => call.kind === 'summary')).toHaveLength(0)
    const completed = completedEvent(events)
    expect(completed.data.status).toBe('succeeded')
    expect(completed.data.temporarySummary).toBeNull()
  })

  it('keeps temporarySummary null and the run successful when the model output is invalid', async () => {
    const { providerCalls, events } = await runTemporaryStream(
      { summaryModelText: '这不是 JSON' },
      { summarySource: rollingSummarySource() },
    )

    expect(providerCalls.filter((call) => call.kind === 'summary')).toHaveLength(1)
    const completed = completedEvent(events)
    expect(completed.data.status).toBe('succeeded')
    expect(completed.data.temporarySummary).toBeNull()
    expect(events.find((candidate) => candidate.event === 'run.failed')).toBeUndefined()
  })

  it('keeps temporarySummary null and the run successful when the summary provider call fails', async () => {
    const { events } = await runTemporaryStream(
      { summaryFetch: () => new Response('upstream down', { status: 500 }) },
      { summarySource: rollingSummarySource() },
    )

    const completed = completedEvent(events)
    expect(completed.data.status).toBe('succeeded')
    expect(completed.data.temporarySummary).toBeNull()
    expect(events.find((candidate) => candidate.event === 'run.failed')).toBeUndefined()
  })

  it('keeps temporarySummary null and the run successful when the summary call exceeds its budget', async () => {
    const running = runTemporaryStream(
      {
        summaryFetch: (signal) => new Promise<Response>((_, reject) => {
          if (signal?.aborted) {
            reject(signal.reason)
            return
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      },
      { summarySource: rollingSummarySource() },
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const { providerCalls, events } = await running

    expect(providerCalls.filter((call) => call.kind === 'summary')).toHaveLength(1)
    const completed = completedEvent(events)
    expect(completed.data.status).toBe('succeeded')
    expect(completed.data.temporarySummary).toBeNull()
    expect(events.find((candidate) => candidate.event === 'run.failed')).toBeUndefined()
  })

  it('maintains from the full summarySource prefix even when the answer messages were trimmed', async () => {
    const summarySource = rollingSummarySource() as { messages: { role: 'user' | 'assistant'; content: string }[] }
    const oldest = summarySource.messages[0]!.content
    const { providerCalls, events } = await runTemporaryStream(
      {},
      {
        messages: summarySource.messages.slice(-2),
        summarySource,
      },
    )

    const answerCall = providerCalls.find((call) => call.kind === 'answer')!
    expect(answerCall.body).not.toContain(oldest)
    const summaryInput = summaryRequestBody(providerCalls).messages.at(-1)!.content
    expect(summaryInput).toContain(oldest)
    expect(summaryInput).toContain(summarySource.messages[17]!.content)
    expect(completedEvent(events).data.temporarySummary).toEqual({
      confirmedFacts: ['旧事实保留'],
      corrections: ['合并后的纠正'],
      rejectedHypotheses: [],
      unresolvedQuestions: [],
    })
  })

  it('does not call the provider for maintenance without a summarySource', async () => {
    const { providerCalls, events } = await runTemporaryStream(
      {},
      { messages: prefixMessages(4) },
    )

    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]!.kind).toBe('answer')
    const completed = completedEvent(events)
    expect(completed.data.status).toBe('succeeded')
    expect(completed.data.temporarySummary).toBeNull()
  })
})

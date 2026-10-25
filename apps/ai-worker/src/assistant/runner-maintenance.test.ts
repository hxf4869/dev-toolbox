// Runner-level tests for the post-success auxiliary maintenance lifecycle
// (docs/16 §11.2, §14) and the cumulative summary maintenance input
// (docs/16 §10.3). The Provider is a deterministic openai-completions SSE
// fixture; the internal Go API endpoints are stubbed per request path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaimedAssistantRun } from './client.js'
import { AssistantClient } from './client.js'
import { AssistantRunner } from './runner.js'

const runId = '9a5a8a2a-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

interface RecordedCall {
  readonly url: string
  readonly body: string
}

interface StubHandlers {
  // Provider model response text for the summary call; defaults to a valid
  // merged summary.
  summaryModelText?: string
  // Holds the title model response until the returned release is invoked.
  holdTitleModel?: (release: (error?: unknown) => void) => void
  // Holds the complete request until the returned release is invoked.
  holdComplete?: (release: () => void) => void
  // Heartbeat responses by call number (1-based); the last entry repeats.
  heartbeatResponses?: (call: number) => Response | Promise<Response>
  // Events responses by call number (1-based); defaults to no stop request.
  eventsResponses?: (call: number) => Response
  // Status carried by the /complete response; defaults to 'succeeded'.
  completeStatus?: string
  summarySource?: ClaimedAssistantRun['context']['summarySource']
  contextSummary?: ClaimedAssistantRun['context']['summary']
  historyMessages?: ClaimedAssistantRun['context']['messages']
  sensitivePolicy?: ClaimedAssistantRun['sensitivePolicy']
  contextWindow?: number
}

function createHarness(handlers: StubHandlers = {}) {
  const calls: RecordedCall[] = []
  const providerCalls: { kind: 'answer' | 'title' | 'summary'; body: string }[] = []

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const body = init?.body === undefined || typeof init.body !== 'string' ? '' : init.body
    calls.push({ url, body })
    if (url.endsWith('/chat/completions')) {
      const request = JSON.parse(body) as { messages: { role: string; content: string }[] }
      const system = request.messages
        .filter((message) => message.role === 'system' || message.role === 'developer')
        .map((message) => message.content).join('\n')
      const kind = /不超过 30 个字符/.test(system) ? 'title' as const
        : /confirmedFacts/.test(system) ? 'summary' as const
          : 'answer' as const
      providerCalls.push({ kind, body })
      return providerSse(kind, handlers, init?.signal)
    }
    if (/\/heartbeat$/.test(url)) {
      const respond = handlers.heartbeatResponses ?? (() => jsonResponse({ stopRequested: false }))
      return respond(calls.filter((call) => /\/heartbeat$/.test(call.url)).length)
    }
    if (/\/events$/.test(url)) {
      const respond = handlers.eventsResponses ?? (() => jsonResponse({ stopRequested: false, lastSequence: 1 }))
      return respond(calls.filter((call) => /\/events$/.test(call.url)).length)
    }
    if (/\/complete$/.test(url)) {
      const status = handlers.completeStatus ?? 'succeeded'
      if (handlers.holdComplete) {
        return new Promise<Response>((resolve) => {
          handlers.holdComplete!(() => resolve(jsonResponse({ status })))
        })
      }
      return jsonResponse({ status })
    }
    if (/\/fail$/.test(url)) return jsonResponse({ status: 'failed' })
    if (/\/title$/.test(url)) return jsonResponse({ applied: true })
    if (/\/summary$/.test(url)) return jsonResponse({ applied: true })
    throw new Error(`unexpected synthetic request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)

  const client = new AssistantClient('http://api.example.test', 'synthetic-service-token', 'maintenance-test-worker')
  const runner = new AssistantRunner(client, true)
  const claim = baseClaim(handlers)
  return { fetch, calls, providerCalls, runner, claim }
}

function jsonResponse(payload: unknown): Response {
  return Response.json(payload)
}

function providerSse(
  kind: 'answer' | 'title' | 'summary',
  handlers: StubHandlers,
  signal?: AbortSignal,
): Response | Promise<Response> {
  let text: string
  if (kind === 'summary') {
    text = handlers.summaryModelText ??
      JSON.stringify({ confirmedFacts: ['合并后的事实'], corrections: [], rejectedHypotheses: [], unresolvedQuestions: [] })
  } else if (kind === 'title') {
    text = '合成维护标题'
  } else {
    text = '合成回答正文'
  }
  const respond = (): Response => {
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
  if (kind === 'title' && handlers.holdTitleModel) {
    return new Promise<Response>((resolve, reject) => {
      const release = (error?: unknown): void => {
        if (error !== undefined) reject(error)
        else resolve(respond())
      }
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      handlers.holdTitleModel!(release)
    })
  }
  return respond()
}

function baseClaim(handlers: StubHandlers): ClaimedAssistantRun {
  return {
    run: {
      id: runId,
      conversationId: '9a5a8a2a-2222-4222-8222-222222222222',
      outputMessageId: '9a5a8a2a-3333-4333-8333-333333333333',
      leaseVersion: 2,
      stopRequested: false,
      expiresAt: '2026-09-06T00:00:30Z',
    },
    model: {
      id: '9a5a8a2a-4444-4444-8444-444444444444',
      displayName: 'fixture model',
      upstreamModelId: 'fixture-model',
      providerId: '9a5a8a2a-5555-4555-8555-555555555555',
      providerDisplayName: 'fixture provider',
      protocol: 'openai-completions',
      baseUrl: 'http://provider.fixture.test',
      apiKey: 'fixture-provider-key',
      contextWindow: handlers.contextWindow ?? 32768,
      maxOutputTokens: 4096,
    },
    reasoning: { reasoning: 'off', displayName: '关闭' },
    sensitivePolicy: handlers.sensitivePolicy ?? 'allow',
    promptVersion: 'assistant-answer-v2',
    retrievalVersion: 'hybrid-rrf-v1',
    knowledge: {
      state: 'unavailable', generation: null, baseUrl: '', apiKey: '', modelId: '', dimensions: null,
    },
    context: {
      summary: handlers.contextSummary ?? null,
      messages: handlers.historyMessages ?? [],
      question: '合成问题',
      summarySource: handlers.summarySource !== undefined ? handlers.summarySource : null,
    },
  }
}

function baselineSummary(): NonNullable<NonNullable<ClaimedAssistantRun['context']['summarySource']>['prior']> {
  return {
    throughMessageSequence: 5,
    summary: {
      confirmedFacts: ['基准中记录的架构边界'], corrections: ['基准中的用户纠正'], rejectedHypotheses: [], unresolvedQuestions: [],
    },
  }
}

function coveredSummarySource(): NonNullable<ClaimedAssistantRun['context']['summarySource']> {
  return {
    prior: baselineSummary(),
    messages: [
      { sequence: 6, role: 'user', content: '第一条新增消息' },
      { sequence: 7, role: 'assistant', content: '第二条新增消息' },
      { sequence: 8, role: 'user', content: '第三条新增消息' },
    ],
  }
}

async function drive(running: Promise<void>, milliseconds = 1_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds)
  await running
}

describe('cumulative summary maintenance (R2-DT02)', () => {
  it('merges the stored baseline with the new messages and writes back baseline and target watermarks', async () => {
    const { runner, claim, providerCalls, calls } = createHarness({
      summarySource: coveredSummarySource(),
    })
    await drive(runner.run(claim))

    // The provider saw exactly one answer call plus one summary call; the
    // answer itself was never re-requested for the title or summary.
    expect(providerCalls.filter((call) => call.kind === 'answer')).toHaveLength(1)
    const summaryCall = providerCalls.find((call) => call.kind === 'summary')
    expect(summaryCall).toBeDefined()
    const summaryRequest = JSON.parse(summaryCall!.body) as { messages: { role: string; content: string }[] }
    const summaryInput = summaryRequest.messages.at(-1)!.content
    expect(summaryInput).toContain('维护基准')
    expect(summaryInput).toContain('基准中记录的架构边界')
    expect(summaryInput).toContain('基准中的用户纠正')
    expect(summaryInput).toContain('第一条新增消息')
    expect(summaryInput).toContain('第二条新增消息')
    expect(summaryInput).toContain('第三条新增消息')
    expect(summaryInput).toContain('合并')

    // The write-back carries the baseline it was built on and the target
    // watermark of the last included message.
    const summaryWrite = calls.find((call) => /\/summary$/.test(call.url))
    expect(summaryWrite).toBeDefined()
    const payload = JSON.parse(summaryWrite!.body) as {
      throughMessageSequence: number
      baselineThroughMessageSequence: number
      summary: { confirmedFacts: string[] }
    }
    expect(payload.baselineThroughMessageSequence).toBe(5)
    expect(payload.throughMessageSequence).toBe(8)
    expect(payload.summary.confirmedFacts).toEqual(['合并后的事实'])
  })

  it('still maintains from the baseline when the answer-side summary was budget-trimmed to null', async () => {
    const { runner, claim, providerCalls, calls } = createHarness({
      summarySource: coveredSummarySource(),
      contextSummary: null,
    })
    await drive(runner.run(claim))
    expect(providerCalls.find((call) => call.kind === 'summary')).toBeDefined()
    expect(calls.filter((call) => /\/summary$/.test(call.url))).toHaveLength(1)
  })

  it('redacts the baseline summary through the same redactor as the new messages', async () => {
    const { runner, claim, providerCalls } = createHarness({
      sensitivePolicy: 'redact',
      summarySource: {
        prior: {
          throughMessageSequence: 5,
          summary: {
            confirmedFacts: ['基准密钥 api_key=supersecret123'], corrections: [], rejectedHypotheses: [], unresolvedQuestions: [],
          },
        },
        messages: [{ sequence: 6, role: 'user', content: '新消息 api_key=newsecret456' }],
      },
    })
    await drive(runner.run(claim))

    const summaryInput = JSON.parse(
      (providerCalls.find((call) => call.kind === 'summary')!).body,
    ) as { messages: { content: string }[] }
    const content = summaryInput.messages.at(-1)!.content
    expect(content).not.toContain('supersecret123')
    expect(content).not.toContain('newsecret456')
    expect(content).toContain('<API_KEY_')
  })

  it('sends only the consecutive oldest prefix that fits the budget and targets its last sequence', async () => {
    const { runner, claim, providerCalls, calls } = createHarness({
      // 60% of 3000 minus the 1024 generation reserve leaves ~776 tokens.
      contextWindow: 3000,
      summarySource: {
        prior: baselineSummary(),
        messages: [
          { sequence: 6, role: 'user', content: 'x'.repeat(900) },
          { sequence: 7, role: 'user', content: 'y'.repeat(2400) },
          { sequence: 8, role: 'user', content: 'z'.repeat(900) },
        ],
      },
    })
    await drive(runner.run(claim))

    const summaryInput = JSON.parse(
      (providerCalls.find((call) => call.kind === 'summary')!).body,
    ) as { messages: { content: string }[] }
    const content = summaryInput.messages.at(-1)!.content
    expect(content).toContain('x'.repeat(900))
    expect(content).not.toContain('y'.repeat(2400))
    expect(content).not.toContain('z'.repeat(900))

    const summaryWrite = JSON.parse(
      (calls.find((call) => /\/summary$/.test(call.url))!).body,
    ) as { throughMessageSequence: number; baselineThroughMessageSequence: number }
    // The watermark must only advance to the last message actually included.
    expect(summaryWrite.throughMessageSequence).toBe(6)
    expect(summaryWrite.baselineThroughMessageSequence).toBe(5)
  })

  it('skips maintenance entirely when even the baseline does not fit the budget', async () => {
    const { runner, claim, providerCalls, calls } = createHarness({
      contextWindow: 3000,
      summarySource: {
        prior: {
          throughMessageSequence: 5,
          summary: {
            confirmedFacts: ['z'.repeat(2400)], corrections: [], rejectedHypotheses: [], unresolvedQuestions: [],
          },
        },
        messages: [{ sequence: 6, role: 'user', content: 'x'.repeat(10) }],
      },
    })
    await drive(runner.run(claim))
    expect(providerCalls.filter((call) => call.kind === 'summary')).toHaveLength(0)
    expect(calls.filter((call) => /\/summary$/.test(call.url))).toHaveLength(0)
  })

  it('keeps the stored summary when the model returns invalid JSON', async () => {
    const { runner, claim, calls } = createHarness({
      summarySource: coveredSummarySource(),
      summaryModelText: '这不是 JSON',
    })
    await drive(runner.run(claim))
    expect(calls.filter((call) => /\/summary$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/fail$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/complete$/.test(call.url))).toHaveLength(1)
  })
})

describe('auxiliary maintenance lifecycle after success (R2-DT03)', () => {
  it('finishes maintenance when an in-flight heartbeat tick returns 409 after completeRun', async () => {
    let releaseComplete!: () => void
    let releaseHeartbeat!: (response: Response) => void
    let releaseTitle!: (error?: unknown) => void
    const { runner, claim, calls } = createHarness({
      summarySource: coveredSummarySource(),
      holdComplete: (release) => { releaseComplete = release },
      holdTitleModel: (release) => { releaseTitle = release },
      heartbeatResponses: (call) => {
        if (call === 1) return jsonResponse({ stopRequested: false })
        return new Promise<Response>((resolve) => { releaseHeartbeat = resolve })
      },
    })

    const running = runner.run(claim)
    await vi.advanceTimersByTimeAsync(0)
    // The answer phase completed but completeRun is still in flight.
    expect(calls.filter((call) => /\/complete$/.test(call.url))).toHaveLength(1)

    // A heartbeat tick starts in flight while completeRun has not returned.
    await vi.advanceTimersByTimeAsync(10_000)

    // completeRun returns, the execution heartbeat stops, maintenance starts.
    releaseComplete()
    await vi.advanceTimersByTimeAsync(0)
    expect(releaseTitle).toBeDefined()

    // Only now the in-flight tick answers with the post-success 409; it must
    // not abort the running maintenance.
    releaseHeartbeat(new Response(null, { status: 409 }))
    await vi.advanceTimersByTimeAsync(0)

    releaseTitle()
    await vi.advanceTimersByTimeAsync(1_000)
    await running

    expect(calls.filter((call) => /\/title$/.test(call.url))).toHaveLength(1)
    expect(calls.filter((call) => /\/summary$/.test(call.url))).toHaveLength(1)
    expect(calls.filter((call) => /\/fail$/.test(call.url))).toHaveLength(0)
  })

  it('stops the lease heartbeat before maintenance and never fires a tick during it', async () => {
    let releaseTitle!: (error?: unknown) => void
    let heartbeatCalls = 0
    const { runner, claim, calls } = createHarness({
      summarySource: coveredSummarySource(),
      holdTitleModel: (release) => { releaseTitle = release },
      heartbeatResponses: () => {
        heartbeatCalls += 1
        return jsonResponse({ stopRequested: false })
      },
    })

    const running = runner.run(claim)
    await vi.advanceTimersByTimeAsync(0)
    const beatsBeforeMaintenance = heartbeatCalls

    // Cross several old heartbeat intervals while maintenance is held: no
    // further lease heartbeat may go out after completeRun stopped it.
    await vi.advanceTimersByTimeAsync(35_000)
    expect(heartbeatCalls).toBe(beatsBeforeMaintenance)

    releaseTitle()
    await vi.advanceTimersByTimeAsync(1_000)
    await running

    expect(calls.filter((call) => /\/title$/.test(call.url))).toHaveLength(1)
    expect(calls.filter((call) => /\/summary$/.test(call.url))).toHaveLength(1)
    expect(calls.filter((call) => /\/fail$/.test(call.url))).toHaveLength(0)
  })

  it('aborts auxiliary maintenance on shutdown without failing the successful answer', async () => {
    const shutdown = new AbortController()
    const { runner, claim, calls } = createHarness({
      summarySource: null,
      holdTitleModel: () => {
        // Released only through the shutdown propagation into the Provider
        // request signal.
      },
    })

    const running = runner.run(claim, shutdown.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.filter((call) => /\/complete$/.test(call.url))).toHaveLength(1)

    shutdown.abort(new Error('assistant runners stopping'))
    await vi.advanceTimersByTimeAsync(1_000)
    await running

    expect(calls.filter((call) => /\/title$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/summary$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/fail$/.test(call.url))).toHaveLength(0)
  })

  it('aborts auxiliary maintenance when the bounded budget expires and keeps the answer successful', async () => {
    const { runner, claim, calls } = createHarness({
      summarySource: null,
      holdTitleModel: () => {
        // Never released: the maintenance budget must cut it off.
      },
    })

    const running = runner.run(claim)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    await running

    expect(calls.filter((call) => /\/complete$/.test(call.url))).toHaveLength(1)
    expect(calls.filter((call) => /\/title$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/fail$/.test(call.url))).toHaveLength(0)
  })

  it('sends the generated title through the lease-free title API', async () => {
    const { runner, claim, calls } = createHarness({})
    await drive(runner.run(claim))
    const titleWrite = calls.find((call) => /\/title$/.test(call.url))
    expect(titleWrite).toBeDefined()
    expect(JSON.parse(titleWrite!.body)).toEqual({ title: '合成维护标题' })
  })
})

describe('stop signal consumption across API responses (DT-R17)', () => {
  it('interrupts the run before the answer when the first events response reports stopRequested', async () => {
    const { runner, claim, providerCalls, calls } = createHarness({
      // Knowledge is unavailable, so the very first /events request carries
      // sources.ready; answering it with a stop request must end the run
      // before any Provider answer call.
      eventsResponses: (call) => call === 1
        ? jsonResponse({ stopRequested: true, lastSequence: 1 })
        : jsonResponse({ stopRequested: false, lastSequence: 1 }),
    })
    await drive(runner.run(claim))

    expect(providerCalls.filter((call) => call.kind === 'answer')).toHaveLength(0)
    expect(calls.filter((call) => /\/complete$/.test(call.url))).toHaveLength(0)
    const fail = calls.find((call) => /\/fail$/.test(call.url))
    expect(fail).toBeDefined()
    expect((JSON.parse(fail!.body) as { errorCode: string }).errorCode).toBe('ASSISTANT_PROVIDER_UNAVAILABLE')
    expect(calls.filter((call) => /\/title$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/summary$/.test(call.url))).toHaveLength(0)
  })

  it('interrupts the answer stream when an answer-delta events flush reports stopRequested', async () => {
    const { runner, claim, calls } = createHarness({
      // sources.ready and run.status(answer) stay quiet; the first answer
      // batch flush answers with a stop request.
      eventsResponses: (call) => call >= 3
        ? jsonResponse({ stopRequested: true, lastSequence: 1 })
        : jsonResponse({ stopRequested: false, lastSequence: 1 }),
    })
    await drive(runner.run(claim))

    const eventsBodies = calls.filter((call) => /\/events$/.test(call.url)).map((call) => call.body)
    expect(eventsBodies.some((body) => body.includes('answer.delta'))).toBe(true)
    expect(calls.filter((call) => /\/complete$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/fail$/.test(call.url))).toHaveLength(1)
    expect(calls.filter((call) => /\/title$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/summary$/.test(call.url))).toHaveLength(0)
  })

  it('skips maintenance when complete returns the stopped terminal status', async () => {
    const { runner, claim, providerCalls, calls } = createHarness({
      completeStatus: 'stopped',
      summarySource: coveredSummarySource(),
    })
    await drive(runner.run(claim))

    expect(calls.filter((call) => /\/complete$/.test(call.url))).toHaveLength(1)
    expect(providerCalls.filter((call) => call.kind === 'title')).toHaveLength(0)
    expect(providerCalls.filter((call) => call.kind === 'summary')).toHaveLength(0)
    expect(calls.filter((call) => /\/title$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/summary$/.test(call.url))).toHaveLength(0)
    expect(calls.filter((call) => /\/fail$/.test(call.url))).toHaveLength(0)
  })
})

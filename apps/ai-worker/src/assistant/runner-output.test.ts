import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AssistantClient, AssistantEvent, ClaimedAssistantRun } from './client.js'
import { AssistantRunner } from './runner.js'

const mocks = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('../model-gateway.js', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  assistantStreamChat: mocks.stream,
}))

afterEach(() => {
  mocks.stream.mockReset()
  vi.useRealTimers()
})

const done = () => ({
  type: 'done',
  message: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
})

function harness(sensitivePolicy: ClaimedAssistantRun['sensitivePolicy'] = 'allow') {
  const calls: { kind: string; events?: readonly AssistantEvent[] }[] = []
  const client = {
    heartbeatRun: vi.fn(async () => ({ stopRequested: false })),
    events: vi.fn(async (_id: string, _lease: number, events: readonly AssistantEvent[]) => {
      calls.push({ kind: 'events', events })
      return { stopRequested: false, lastSequence: 1 }
    }),
    completeRun: vi.fn(async () => {
      calls.push({ kind: 'complete' })
      return { status: 'succeeded' }
    }),
    failRun: vi.fn(async () => {
      calls.push({ kind: 'fail' })
      return { status: 'failed' }
    }),
    maintenancePolicy: vi.fn(async () => ({ allowed: false })),
  }
  const claim: ClaimedAssistantRun = {
    run: {
      id: 'fixture-run', conversationId: 'fixture-conversation', outputMessageId: 'fixture-message',
      leaseVersion: 1, stopRequested: false, expiresAt: '2099-01-01T00:00:00Z',
    },
    model: {
      id: 'fixture-model', displayName: 'fixture', upstreamModelId: 'fixture', providerId: 'fixture',
      providerDisplayName: 'fixture', protocol: 'openai-completions', baseUrl: 'http://provider.example.test',
      apiKey: 'synthetic-test-key', contextWindow: 32768, maxOutputTokens: 4096,
    },
    reasoning: { reasoning: 'off', displayName: '关闭' },
    sensitivePolicy, promptVersion: 'assistant-answer-v2', retrievalVersion: 'hybrid-rrf-v1',
    knowledge: { state: 'unavailable', generation: null, baseUrl: '', apiKey: '', modelId: '', dimensions: null },
    context: { summary: null, messages: [], question: '合成问题', summarySource: null },
  }
  return { client, calls, claim, runner: new AssistantRunner(client as unknown as AssistantClient, true) }
}

describe('assistant output policy and failure lifecycle', () => {
  it.each(['allow', 'redact'])('applies %s to answer and reasoning output', async (policy) => {
    const { runner, claim, calls } = harness(policy)
    const raw = '合成服务地址 192.168.77.77'
    mocks.stream.mockImplementation(async function* () {
      yield { type: 'thinking_delta', delta: raw }
      yield { type: 'text_delta', delta: raw }
      yield done()
    })
    await runner.run(claim)
    for (const type of ['answer.delta', 'reasoning.delta']) {
      const text = calls.flatMap((call) => call.events ?? [])
        .filter((event) => event.type === type).map((event) => event.payload.delta).join('')
      expect(text).toBe(policy === 'allow' ? raw : '合成服务地址 <INTERNAL_IP_1>')
    }
  })

  it('does not retry after user-visible reasoning was persisted', async () => {
    const { runner, claim, calls, client } = harness()
    mocks.stream.mockImplementation(async function* () {
      yield { type: 'thinking_delta', delta: '合成的可见推理内容。'.repeat(700) }
      yield { type: 'error', error: { errorMessage: 'synthetic disconnect' } }
    })
    await runner.run(claim)
    expect(calls.flatMap((call) => call.events ?? []).some((event) => event.type === 'reasoning.delta')).toBe(true)
    expect(mocks.stream).toHaveBeenCalledTimes(1)
    expect(client.failRun).toHaveBeenCalledTimes(1)
    expect(client.completeRun).not.toHaveBeenCalled()
  })

  it('still retries an unavailable provider before any visible output', async () => {
    const { runner, claim, client } = harness()
    let attempts = 0
    mocks.stream.mockImplementation(async function* () {
      attempts += 1
      if (attempts === 1) yield { type: 'error', error: { errorMessage: 'synthetic disconnect' } }
      else {
        yield { type: 'text_delta', delta: '合成回答' }
        yield done()
      }
    })
    await runner.run(claim)
    expect(attempts).toBe(2)
    expect(client.completeRun).toHaveBeenCalledTimes(1)
    expect(client.failRun).not.toHaveBeenCalled()
  })

  it('settles buffered output before failing and leaves no late timer writes', async () => {
    vi.useFakeTimers()
    const { runner, claim, calls } = harness()
    mocks.stream.mockImplementation(async function* () {
      yield { type: 'text_delta', delta: '已经生成的部分回答。' }
      yield { type: 'error', error: { errorMessage: 'synthetic disconnect' } }
    })
    await runner.run(claim)
    const failedAt = calls.findIndex((call) => call.kind === 'fail')
    const prior = calls.slice(0, failedAt).flatMap((call) => call.events ?? [])
    expect(prior.some((event) => event.type === 'answer.delta')).toBe(true)
    const count = calls.length
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toHaveLength(count)
  })
})

import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssistantClient, type ClaimedAssistantRun } from './client.js'
import { AssistantRunner } from './runner.js'
import { handleTemporaryRequest } from './temporary.js'

const localFetch = globalThis.fetch
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const claim: ClaimedAssistantRun = {
  run: { id: 'synthetic-run', conversationId: 'synthetic-chat', outputMessageId: 'synthetic-answer', leaseVersion: 1, stopRequested: false, expiresAt: '2099-01-01T00:00:00Z' },
  model: {
    id: 'synthetic-model', displayName: 'Mock', upstreamModelId: 'mock-chat-model',
    providerId: 'synthetic-provider', providerDisplayName: 'Mock Provider', protocol: 'openai-completions',
    baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-key', contextWindow: 32768, maxOutputTokens: 4096,
  },
  reasoning: { reasoning: 'off', displayName: '不思考' }, sensitivePolicy: 'allow',
  promptVersion: 'assistant-answer-v1', retrievalVersion: 'hybrid-rrf-v1',
  knowledge: { state: 'unavailable', generation: null, baseUrl: '', apiKey: '', modelId: '', dimensions: null },
  context: { summary: null, messages: [{ role: 'user', content: '合成问题' }, { role: 'assistant', content: '合成回答' }], question: '继续' },
}

const cases = [
  { name: 'input plus cache reads and writes', input: 30, read: 60, write: 10, expected: 100 },
  { name: 'fully cached input', input: 0, read: 100, write: 0, expected: 100 },
  { name: 'missing provider usage', input: 0, read: 0, write: 0, expected: null },
]

describe('assistant complete context usage through the real SDK adapter', () => {
  it.each(cases)('records $name in persistent events and completion', async (sample) => {
    const fetch = mockProvider(sample)
    const client = new AssistantClient('http://api.invalid', 'synthetic-service-token', 'test-worker')
    vi.spyOn(client, 'heartbeatRun').mockResolvedValue({ stopRequested: false })
    const events = vi.spyOn(client, 'events').mockResolvedValue({ stopRequested: false, lastSequence: 1 })
    const complete = vi.spyOn(client, 'completeRun').mockResolvedValue()
    const fail = vi.spyOn(client, 'failRun').mockResolvedValue()
    await new AssistantRunner(client, false).run(claim)

    expect(fail).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0]?.[2]).toMatchObject({ answerContextTokens: sample.expected, answerInputTokens: sample.input })
    const usageEvent = events.mock.calls.flatMap((call) => call[2]).find((event) => event.type === 'usage.updated')
    expect(usageEvent?.payload['usage']).toMatchObject({ answerContextTokens: sample.expected })
  })

  it.each(cases)('records $name in temporary events and completion', async (sample) => {
    const fetch = mockProvider(sample)
    const server = createServer((request, response) => {
      void handleTemporaryRequest(request, response, {
        apiInternalUrl: 'http://api.invalid', serviceToken: 'synthetic-service-token', workerId: 'test-worker', allowInsecureProviderHttp: false,
      }, '/internal/assistant/temporary/stream')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('mock server failed to bind')
      const response = await localFetch(`http://127.0.0.1:${address.port}/internal/assistant/temporary/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: claim.model, reasoning: 'off', sensitivePolicy: 'allow', promptVersion: claim.promptVersion, ...claim.context, knowledgeState: 'unavailable', evidenceState: 'unavailable', sources: [] }),
      })
      const stream = await response.text()
      expect(response.status).toBe(200)
      expect(stream).toContain('event: run.completed')
      const usage = stream.split('\n\n').filter((event) => /event: (usage.updated|run.completed)/.test(event))
        .map((event) => JSON.parse(event.split('\ndata: ')[1]!).usage)
      expect(usage).toHaveLength(2)
      for (const value of usage) expect(value).toMatchObject({ answerContextTokens: sample.expected, answerInputTokens: sample.input })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

function mockProvider(sample: typeof cases[number]) {
  const usage = sample.expected === null ? {} : { usage: {
    prompt_tokens: sample.input + sample.read + sample.write, completion_tokens: 3,
    prompt_tokens_details: { cached_tokens: sample.read, cache_write_tokens: sample.write },
  } }
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== 'https://provider.example/v1/chat/completions') throw new Error('unexpected outbound request')
    return new Response(
      'data: {"choices":[{"delta":{"content":"合成回答"}}]}\n\n' +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], ...usage })}\n\n` +
      'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } },
    )
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

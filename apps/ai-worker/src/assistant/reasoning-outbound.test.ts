import { describe, expect, it } from 'vitest'

import { ProviderGatewayError, assistantStreamChat } from '../model-gateway.js'
import type { AssistantReasoningLevel } from '../model-gateway.js'
import { historyMessage } from './history-message.js'

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

// A mock fetch captures the exact outbound payload so the test can assert the
// reasoning parameter was sent verbatim (docs/16 §20.1 outbound fixtures).
async function capturedBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  if (input instanceof Request) {
    try {
      return JSON.parse(await input.clone().text()) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  try {
    return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function captureFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const body = await capturedBody(input, init)
    captured.push({ url, body })
    return new Response(buildMockStream(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
}

function buildMockStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      // A minimal OpenAI completions chunk stream; other protocols accept the
      // same assertions because verification happens on the request payload.
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
        'data: [DONE]\n\n',
      ))
      controller.close()
    },
  })
}

const baseRequest = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'test-key',
  modelId: 'mock-model',
  contextWindow: 8192,
  maxOutputTokens: 1024,
  context: {
    systemPrompt: 'test',
    messages: [{ role: 'user' as const, content: '问题', timestamp: Date.now() }],
  },
  deadlineAt: new Date(Date.now() + 30_000),
  allowInsecureHttp: false,
}

describe('assistant reasoning outbound fixtures', () => {
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)(
    'serializes text-only assistant history through the real %s adapter', async (protocol) => {
      const captured: CapturedRequest[] = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = captureFetch(captured)
      try {
        const model = { protocol, upstreamModelId: 'mock-model' }
        const stream = assistantStreamChat({
          ...baseRequest, protocol, reasoning: 'off',
          context: { messages: [
            historyMessage('user', '上一轮问题', model),
            historyMessage('assistant', '上一轮回答', model),
            historyMessage('user', '继续解释', model),
          ] },
        })
        const streamErrors: string[] = []
        for await (const event of stream) {
          if (event.type === 'error') streamErrors.push(event.error.errorMessage ?? 'stream error')
          if (event.type === 'done') break
        }
        expect(captured, streamErrors.join('; ')).toHaveLength(1)
        const messages = captured[0]?.body['messages'] ?? captured[0]?.body['input']
        expect(JSON.stringify(messages)).toContain('上一轮回答')
        expect(JSON.stringify(messages)).toContain('"role":"assistant"')
      } finally { globalThis.fetch = originalFetch }
    },
  )

  it('sends reasoning_effort verbatim for openai-completions', async () => {
    const captured: CapturedRequest[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = captureFetch(captured)
    try {
      for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
        captured.length = 0
        const stream = assistantStreamChat({
          ...baseRequest,
          protocol: 'openai-completions',
          reasoning: level as AssistantReasoningLevel,
        } as typeof baseRequest & { fetch: typeof fetch })
        for await (const event of stream) {
          if (event.type === 'done') break
        }
        expect(captured[0]?.body['reasoning_effort']).toBe(level)
      }
      // off sends no reasoning field at all.
      captured.length = 0
      const stream = assistantStreamChat({
        ...baseRequest,
        protocol: 'openai-completions',
        reasoning: 'off',
      } as typeof baseRequest & { fetch: typeof fetch })
      for await (const event of stream) {
        if (event.type === 'done') break
      }
      expect(captured[0]?.body['reasoning_effort']).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sends reasoning.effort verbatim for openai-responses', async () => {
    const captured: CapturedRequest[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = captureFetch(captured)
    try {
    for (const level of ['low', 'high', 'max'] as const) {
      captured.length = 0
      const stream = assistantStreamChat({
        ...baseRequest,
        protocol: 'openai-responses',
        reasoning: level,
      } as typeof baseRequest & { fetch: typeof fetch })
      for await (const event of stream) {
        if (event.type === 'done') break
      }
      const reasoning = captured[0]?.body['reasoning'] as Record<string, unknown> | undefined
      expect(reasoning?.['effort']).toBe(level)
    }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sends the exact thinking budget for anthropic-messages and fails on mismatch', async () => {
    const captured: CapturedRequest[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = captureFetch(captured)
    try {
    const budgets: Record<string, number> = {
      minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32768,
    }
    for (const level of ['low', 'high', 'max'] as const) {
      captured.length = 0
      const stream = assistantStreamChat({
        ...baseRequest,
        protocol: 'anthropic-messages',
        reasoning: level,
        maxOutputTokens: 65536,
      } as typeof baseRequest & { fetch: typeof fetch })
      for await (const event of stream) {
        if (event.type === 'done') break
      }
      const thinking = captured[0]?.body['thinking'] as Record<string, unknown> | undefined
      expect(thinking?.['type']).toBe('enabled')
      expect(thinking?.['budget_tokens']).toBe(budgets[level])
    }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws reasoning_unsupported when the budget cannot fit', () => {
    expect(() =>
      assistantStreamChat({
        ...baseRequest,
        protocol: 'anthropic-messages',
        reasoning: 'max',
        maxOutputTokens: 4096,
      }),
    ).toThrow(ProviderGatewayError)
  })
})

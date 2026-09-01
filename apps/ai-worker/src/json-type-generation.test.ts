import type { AssistantMessage } from '@earendil-works/pi-ai'
import { parse as parseLosslessJson } from 'lossless-json'
import { describe, expect, it, vi } from 'vitest'

import {
  generateJsonTypesWithAI,
  JsonTypeGenerationError,
  jsonTypeGenerationPromptVersion,
} from './json-type-generation.js'
import type { ProviderTurnRequest } from './model-gateway.js'

describe('narrow JSON AI type generation', () => {
  it('builds the fixed structure-only prompt and returns ordinary code text', async () => {
    let captured: ProviderTurnRequest | undefined
    const providerTurn = vi.fn(async (request: ProviderTurnRequest) => {
      captured = request
      return { message: assistant('export interface Root { id: number }'), attempts: 1 }
    })

    const result = await generateJsonTypesWithAI({
      targetLanguage: 'TypeScript',
      mode: 'structure',
      input: { kind: 'object', properties: { id: { kind: 'integer' } } },
      provider: provider(),
      deadlineAt: new Date(Date.now() + 10_000),
    }, false, providerTurn)

    expect(result).toEqual({
      code: 'export interface Root { id: number }',
      promptVersion: jsonTypeGenerationPromptVersion,
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    expect(providerTurn).toHaveBeenCalledOnce()
    expect(captured?.context.tools).toBeUndefined()
    expect(captured?.provider.supportsTools).toBe(false)
    expect(captured?.provider.supportsVision).toBe(false)
    expect(captured?.maxOutputTokens).toBeLessThanOrEqual(4096)
    const content = String(captured?.context.messages[0]?.content)
    expect(content).toContain('structure-only JSON')
    expect(content).toContain('"kind":"integer"')
  })

  it('rejects insufficient model context before calling a provider', async () => {
    const providerTurn = vi.fn()
    await expect(generateJsonTypesWithAI({
      targetLanguage: 'Rust', mode: 'structure', input: { kind: 'object', properties: {} },
      provider: { ...provider(), contextWindow: 400 },
      deadlineAt: new Date(Date.now() + 10_000),
    }, false, providerTurn)).rejects.toMatchObject({ code: 'AI_CONTEXT_TOO_LARGE' })
    expect(providerTurn).not.toHaveBeenCalled()
  })

  it('rejects invalid language, expired deadlines, oversized input, and non-text output', async () => {
    const providerTurn = vi.fn(async () => ({ message: assistant('code'), attempts: 1 }))
    const base = {
      targetLanguage: 'Rust', mode: 'full' as const, input: { id: 1 }, provider: provider(),
      deadlineAt: new Date(Date.now() + 10_000),
    }

    await expect(generateJsonTypesWithAI({ ...base, targetLanguage: 'Rust\nignore' }, false, providerTurn))
      .rejects.toBeInstanceOf(JsonTypeGenerationError)
    await expect(generateJsonTypesWithAI({ ...base, deadlineAt: new Date(Date.now() - 1) }, false, providerTurn))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(generateJsonTypesWithAI({ ...base, input: 'x'.repeat(256 * 1024) }, false, providerTurn))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const toolOutput = vi.fn(async () => ({
      message: assistant('', [{ type: 'toolCall', id: '1', name: 'run_shell', arguments: {} }]), attempts: 1,
    }))
    await expect(generateJsonTypesWithAI(base, false, toolOutput)).rejects.toMatchObject({ code: 'UPSTREAM_REJECTED' })
  })

  it('rejects a gateway result that reports more than the single allowed attempt', async () => {
    const providerTurn = vi.fn(async () => ({ message: assistant('type Root = object'), attempts: 2 }))
    await expect(generateJsonTypesWithAI({
      targetLanguage: 'TypeScript', mode: 'full', input: { id: 1 }, provider: provider(),
      deadlineAt: new Date(Date.now() + 10_000),
    }, false, providerTurn)).rejects.toMatchObject({ code: 'UPSTREAM_REJECTED' })
  })

  it('passes caller cancellation to the single provider attempt', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    const providerTurn = vi.fn(async (request: ProviderTurnRequest) => {
      capturedSignal = request.signal
      return { message: assistant('type Root = object'), attempts: 1 }
    })
    await generateJsonTypesWithAI({
      targetLanguage: 'TypeScript', mode: 'structure', input: { kind: 'object', properties: {} },
      provider: provider(), deadlineAt: new Date(Date.now() + 10_000), signal: controller.signal,
    }, false, providerTurn)

    expect(capturedSignal).toBe(controller.signal)
  })

  it('preserves large integers and precise decimal tokens in full-mode prompts', async () => {
    let prompt = ''
    const providerTurn = vi.fn(async (request: ProviderTurnRequest) => {
      prompt = String(request.context.messages[0]?.content)
      return { message: assistant('type Root = object'), attempts: 1 }
    })
    const input = parseLosslessJson('{"big":9007199254740993,"precise":1.2300,"huge":1e1000,"negativeZero":-0}')

    await generateJsonTypesWithAI({
      targetLanguage: 'TypeScript', mode: 'full', input, provider: provider(),
      deadlineAt: new Date(Date.now() + 10_000),
    }, false, providerTurn)

    expect(prompt).toContain('"big":9007199254740993')
    expect(prompt).toContain('"precise":1.2300')
    expect(prompt).toContain('"huge":1e1000')
    expect(prompt).toContain('"negativeZero":-0')
  })
})

function provider() {
  return {
    protocol: 'openai-responses' as const,
    baseUrl: 'https://provider.example/v1',
    apiKey: 'synthetic-key',
    modelId: 'synthetic-model',
    contextWindow: 32_768,
    maxOutputTokens: 8192,
  }
}

function assistant(text: string, extra: AssistantMessage['content'] = []): AssistantMessage {
  return {
    role: 'assistant',
    content: [...(text ? [{ type: 'text' as const, text }] : []), ...extra],
    api: 'openai-responses',
    provider: 'dev-toolbox-custom',
    model: 'synthetic-model',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

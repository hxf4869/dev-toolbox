import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  createServer,
  request as createHttpRequest,
  type Server,
} from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateJsonTypesWithAI } from './json-type-generation.js'
import { observeJsonTypeGenerationHttpLifecycle } from './json-type-generation-http.js'
import type { ProviderTurnRequest, ProviderTurnResult } from './model-gateway.js'

describe('JSON type generation HTTP cancellation', () => {
  const servers = new Set<Server>()

  afterEach(async () => {
    await Promise.all([...servers].map(async (server) => {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    }))
    servers.clear()
  })

  it('aborts the same provider signal when the client disconnects after a complete body', async () => {
    const providerStarted = deferred<void>()
    const providerAborted = deferred<void>()
    let providerSignal: AbortSignal | undefined
    const providerTurn = vi.fn((request: ProviderTurnRequest): Promise<ProviderTurnResult> => {
      providerSignal = request.signal
      providerStarted.resolve()
      return new Promise((_, reject) => {
        const signal = request.signal
        if (signal === undefined) {
          reject(new Error('missing provider signal'))
          return
        }
        const handleAbort = () => {
          providerAborted.resolve()
          reject(signal.reason)
        }
        if (signal.aborted) handleAbort()
        else signal.addEventListener('abort', handleAbort, { once: true })
      })
    })
    const harness = await startHarness(providerTurn)
    servers.add(harness.server)
    const body = JSON.stringify({ input: 'complete' })
    const client = createHttpRequest({
      host: '127.0.0.1', port: harness.port, method: 'POST', path: '/',
      headers: { 'content-length': Buffer.byteLength(body) },
    })
    client.on('error', () => {})
    client.end(body)

    await within(providerStarted.promise, 'provider start')
    expect(harness.state.requestCompleteBeforeProvider).toBe(true)
    expect(providerSignal).toBe(harness.state.lifecycleSignal)
    client.destroy()

    await within(providerAborted.promise, 'provider abort')
    await within(harness.state.handlerSettled.promise, 'handler settle')
    expect(providerSignal?.aborted).toBe(true)
    expect(providerTurn).toHaveBeenCalledOnce()
    expect(harness.state.responseWrites).toBe(0)
  })

  it('returns a normal response without aborting the provider signal', async () => {
    let providerSignal: AbortSignal | undefined
    const providerTurn = vi.fn(async (request: ProviderTurnRequest): Promise<ProviderTurnResult> => {
      providerSignal = request.signal
      return { message: assistant('export interface Root { id: number }'), attempts: 1 }
    })
    const harness = await startHarness(providerTurn)
    servers.add(harness.server)
    const body = JSON.stringify({ input: 'complete' })

    const result = await within(readResponse(harness.port, body), 'normal response')
    await within(harness.state.handlerSettled.promise, 'handler settle')

    expect(result).toEqual({ status: 200, body: 'export interface Root { id: number }' })
    expect(providerSignal).toBe(harness.state.lifecycleSignal)
    expect(providerSignal?.aborted).toBe(false)
    expect(providerTurn).toHaveBeenCalledOnce()
    expect(harness.state.responseWrites).toBe(1)
  })

  it('aborts while reading a partial body and never starts the provider', async () => {
    const providerTurn = vi.fn(async (): Promise<ProviderTurnResult> => ({
      message: assistant('unreachable'), attempts: 1,
    }))
    const harness = await startHarness(providerTurn)
    servers.add(harness.server)
    const client = createHttpRequest({
      host: '127.0.0.1', port: harness.port, method: 'POST', path: '/',
      headers: { 'content-length': 128 },
    })
    client.on('error', () => {})
    client.write('{"partial":')

    await within(harness.state.firstBodyChunk.promise, 'first body chunk')
    client.destroy()

    await within(harness.state.signalAborted.promise, 'request abort')
    await within(harness.state.handlerSettled.promise, 'handler settle')
    expect(harness.state.requestCompleteAtAbort).toBe(false)
    expect(harness.state.lifecycleSignal?.aborted).toBe(true)
    expect(providerTurn).not.toHaveBeenCalled()
    expect(harness.state.responseWrites).toBe(0)
  })
})

interface HarnessState {
  lifecycleSignal?: AbortSignal
  requestCompleteBeforeProvider?: boolean
  requestCompleteAtAbort?: boolean
  responseWrites: number
  readonly firstBodyChunk: Deferred<void>
  readonly signalAborted: Deferred<void>
  readonly handlerSettled: Deferred<void>
}

async function startHarness(providerTurn: (request: ProviderTurnRequest) => Promise<ProviderTurnResult>): Promise<{
  server: Server
  port: number
  state: HarnessState
}> {
  const state: HarnessState = {
    responseWrites: 0,
    firstBodyChunk: deferred<void>(),
    signalAborted: deferred<void>(),
    handlerSettled: deferred<void>(),
  }
  const server = createServer((request, response) => {
    void (async () => {
      const lifecycle = observeJsonTypeGenerationHttpLifecycle(request, response)
      state.lifecycleSignal = lifecycle.signal
      lifecycle.signal.addEventListener('abort', () => {
        state.requestCompleteAtAbort = request.complete
        state.signalAborted.resolve()
      }, { once: true })
      try {
        for await (const chunk of request) {
          if (Buffer.byteLength(chunk) > 0) state.firstBodyChunk.resolve()
        }
        state.requestCompleteBeforeProvider = request.complete
        const result = await generateJsonTypesWithAI({
          targetLanguage: 'TypeScript',
          mode: 'structure',
          input: { kind: 'object', properties: { id: { kind: 'integer' } } },
          provider: {
            protocol: 'openai-responses',
            baseUrl: 'https://provider.invalid/v1',
            apiKey: 'synthetic-key',
            modelId: 'synthetic-model',
            contextWindow: 32_768,
            maxOutputTokens: 8192,
          },
          deadlineAt: new Date(Date.now() + 10_000),
          signal: lifecycle.signal,
        }, false, providerTurn)
        if (!lifecycle.canWriteResponse()) return
        state.responseWrites += 1
        response.statusCode = 200
        response.end(result.code)
      } catch {
        if (lifecycle.canWriteResponse()) {
          state.responseWrites += 1
          response.statusCode = 500
          response.end('synthetic failure')
        }
      } finally {
        lifecycle.dispose()
        state.handlerSettled.resolve()
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('loopback server has no TCP address')
  return { server, port: address.port, state }
}

function readResponse(port: number, body: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = createHttpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/',
      headers: { 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
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

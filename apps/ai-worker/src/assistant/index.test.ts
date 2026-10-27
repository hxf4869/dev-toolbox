import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateEmbeddings } from '../model-gateway.js'
import { AssistantClient, AssistantClientError, type ClaimedIndexBatch } from './client.js'
import { EmbeddingIndexRunner, startAssistantRunners } from './index.js'

const batch: ClaimedIndexBatch = {
  generation: 2,
  policy: 'redact',
  expiresAt: '2026-09-02T00:00:30Z',
  baseUrl: 'http://embedding.example.test/v1',
  apiKey: 'synthetic-embedding-key',
  modelId: 'mock-embedding',
  dimensions: 4,
  fragments: [{
    fragmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    itemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sourceKind: 'raw_text',
    sensitivity: 'normal',
    content: '合成 CPU 索引测试',
    attempt: 1,
    sourceCreatedAt: '2026-09-02T00:00:00Z',
  }],
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('EmbeddingIndexRunner CPU requests', () => {
  it('allows a 90-second embedding with heartbeats and accepts the API 204 completion', async () => {
    const fetch = mockEmbeddingDelay(90_000)
    const runner = createRunner()
    const running = runner.run(batch)

    await vi.advanceTimersByTimeAsync(90_000)
    await running

    expect(requestsTo(fetch, '/v1/embeddings')).toHaveLength(1)
    expect(requestsTo(fetch, '/index/heartbeat').length).toBeGreaterThanOrEqual(8)
    expect(requestsTo(fetch, '/index/complete')).toHaveLength(1)
    expect(requestsTo(fetch, '/index/fail')).toHaveLength(0)
  })

  it('bounds indexing at 180 seconds and continues after a 204 failure acknowledgement', async () => {
    const slowFetch = mockEmbeddingDelay(181_000)
    const runner = createRunner()
    const running = runner.run(batch)

    await vi.advanceTimersByTimeAsync(180_000)
    await running
    expect(requestsTo(slowFetch, '/v1/embeddings')).toHaveLength(1)
    expect(requestsTo(slowFetch, '/index/complete')).toHaveLength(0)
    expect(requestsTo(slowFetch, '/index/fail')).toHaveLength(1)

    const nextFetch = mockEmbeddingDelay(0)
    const next = runner.run(batch)
    await vi.advanceTimersByTimeAsync(0)
    await next
    expect(requestsTo(nextFetch, '/index/complete')).toHaveLength(1)
    expect(requestsTo(nextFetch, '/index/fail')).toHaveLength(0)
  })

  it('keeps query and connection-probe embeddings at the default 60-second timeout', async () => {
    const fetch = mockEmbeddingDelay(90_000)
    const result = generateEmbeddings({
      ...batch,
      input: ['合成查询'],
      allowInsecureHttp: true,
    }).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(requestsTo(fetch, '/v1/embeddings')).toHaveLength(1)
  })

  it('still rejects malformed non-empty JSON from the internal API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })))
    const client = new AssistantClient('http://api.example.test', 'synthetic-service-token', 'index-test-worker')
    await expect(client.heartbeatIndex([{ fragmentId: batch.fragments[0]!.fragmentId, leaseVersion: 1 }]))
      .rejects.toMatchObject({ status: 502, code: 'INVALID_API_RESPONSE' })
  })
})

describe('assistant lane loops', () => {
  it('keeps the index lane alive when failIndexBatch reports a transient 500 (T24)', async () => {
    const fetch = stubIndexLaneFetch({
      embeddings: () => new Response('upstream down', { status: 500 }),
      fail: () => new Response('api busy', { status: 500 }),
    })
    const runners = startAssistantRunners({ ...laneOptions() })

    await vi.advanceTimersByTimeAsync(0)
    expect(requestsTo(fetch, '/index/claim')).toHaveLength(1)
    expect(requestsTo(fetch, '/v1/embeddings')).toHaveLength(2)
    expect(requestsTo(fetch, '/index/fail')).toHaveLength(1)

    // The lane survives the failed failure-report and claims again.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(requestsTo(fetch, '/index/claim').length).toBeGreaterThanOrEqual(2)

    // stop() is awaitable and resolves once the loops settled.
    await expect(runners.stop()).resolves.toBeUndefined()
  })

  it('treats a stale-lease 409 as terminal for the batch and keeps claiming (T26)', async () => {
    const fetch = stubIndexLaneFetch({
      embeddings: () => Response.json({ data: [{ embedding: [0.5, 0.5, 0.5, 0.5] }] }),
      complete: () => new Response(null, { status: 409 }),
      fail: () => new Response(null, { status: 409 }),
    })
    const runners = startAssistantRunners({ ...laneOptions() })

    await vi.advanceTimersByTimeAsync(0)
    // One embedding attempt, one 409-terminated completion, one swallowed 409 failure
    // report; the stale leaseVersion must never be retried for the same batch.
    expect(requestsTo(fetch, '/v1/embeddings')).toHaveLength(1)
    expect(requestsTo(fetch, '/index/complete')).toHaveLength(1)
    expect(requestsTo(fetch, '/index/fail')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(requestsTo(fetch, '/index/claim').length).toBeGreaterThanOrEqual(2)

    await expect(runners.stop()).resolves.toBeUndefined()
  })

  it('reports a non-recoverable report defect through onLaneFailure (T25)', async () => {
    const fetch = stubIndexLaneFetch({
      embeddings: () => new Response('upstream down', { status: 500 }),
      fail: () => new Response('validation failed', { status: 400 }),
    })
    const onLaneFailure = vi.fn()
    const runners = startAssistantRunners({ ...laneOptions(), onLaneFailure })

    await vi.advanceTimersByTimeAsync(0)
    expect(onLaneFailure).toHaveBeenCalledOnce()
    const [lane, error] = onLaneFailure.mock.calls[0]!
    expect(lane).toBe('index')
    expect(error).toBeInstanceOf(AssistantClientError)
    expect((error as AssistantClientError).status).toBe(400)
    expect(requestsTo(fetch, '/index/claim')).toHaveLength(1)

    // stop() stays awaitable even though the lane already died.
    await runners.stop()
  })

  it('keeps the index lane alive through transient claim failures', async () => {
    let claimCalls = 0
    const fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/index/claim')) {
        claimCalls += 1
        if (claimCalls <= 2) return new Response('api down', { status: 503 })
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected synthetic request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    const onLaneFailure = vi.fn()
    const runners = startAssistantRunners({ ...laneOptions(), onLaneFailure })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(claimCalls).toBe(3)
    expect(onLaneFailure).not.toHaveBeenCalled()

    await expect(runners.stop()).resolves.toBeUndefined()
  })

  it('routes 401 claim failures to onLaneFailure instead of silent retries', async () => {
    let claimCalls = 0
    const fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/index/claim')) {
        claimCalls += 1
        return Response.json({ error: { code: 'AUTH_REQUIRED', message: '内部服务凭据无效' } }, { status: 401 })
      }
      throw new Error(`unexpected synthetic request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    const onLaneFailure = vi.fn()
    const runners = startAssistantRunners({ ...laneOptions(), onLaneFailure })

    await vi.advanceTimersByTimeAsync(0)
    expect(onLaneFailure).toHaveBeenCalledOnce()
    const [lane, error] = onLaneFailure.mock.calls[0]!
    expect(lane).toBe('index')
    expect((error as AssistantClientError).status).toBe(401)
    expect(claimCalls).toBe(1)
    expect(requestsTo(fetch, '/index/claim')).toHaveLength(1)

    await runners.stop()
  })

  it('routes chat lane 401 claim failures to onLaneFailure as well', async () => {
    const fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/runs/claim')) {
        return Response.json({ error: { code: 'AUTH_REQUIRED', message: '内部服务凭据无效' } }, { status: 401 })
      }
      throw new Error(`unexpected synthetic request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    const onLaneFailure = vi.fn()
    const runners = startAssistantRunners({ ...laneOptions(), chatSlots: 1, onLaneFailure })

    await vi.advanceTimersByTimeAsync(0)
    expect(onLaneFailure).toHaveBeenCalledOnce()
    const [lane, error] = onLaneFailure.mock.calls[0]!
    expect(lane).toBe('chat')
    expect((error as AssistantClientError).status).toBe(401)

    await runners.stop()
  })
})

function laneOptions() {
  return {
    apiInternalUrl: 'http://api.example.test',
    serviceToken: 'synthetic-service-token',
    workerId: 'loop-test-worker',
    allowInsecureProviderHttp: true,
    chatSlots: 0,
  }
}

function stubIndexLaneFetch(handlers: {
  embeddings: () => Response
  complete?: () => Response
  fail: () => Response
}) {
  let claimCalls = 0
  const fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/index/claim')) {
      claimCalls += 1
      return claimCalls === 1 ? Response.json(batch) : new Response(null, { status: 204 })
    }
    if (url.endsWith('/v1/embeddings')) return handlers.embeddings()
    if (url.endsWith('/index/complete')) return handlers.complete?.() ?? new Response(null, { status: 204 })
    if (url.endsWith('/index/fail')) return handlers.fail()
    throw new Error(`unexpected synthetic request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function createRunner() {
  return new EmbeddingIndexRunner(
    new AssistantClient('http://api.example.test', 'synthetic-service-token', 'index-test-worker'),
    true,
  )
}

function mockEmbeddingDelay(delayMs: number) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/v1/embeddings')) {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal
        const abort = () => {
          clearTimeout(timer)
          reject(signal?.reason)
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort)
          resolve(Response.json({ data: [{ embedding: [0.5, 0.5, 0.5, 0.5] }] }))
        }, delayMs)
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (/\/internal\/assistant\/index\/(heartbeat|complete|fail)$/.test(url)) {
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected synthetic request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function requestsTo(fetch: ReturnType<typeof mockEmbeddingDelay>, suffix: string) {
  return fetch.mock.calls.filter(([input]) => String(input).endsWith(suffix))
}

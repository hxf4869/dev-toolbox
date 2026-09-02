import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateEmbeddings } from '../model-gateway.js'
import { AssistantClient, type ClaimedIndexBatch } from './client.js'
import { EmbeddingIndexRunner } from './index.js'

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

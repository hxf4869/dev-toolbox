import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreflightPlan, TranslationEngine } from './contracts'
import { prepareTranslationRun } from './prepare'
import { useTranslateRun, type TranslateChunkSeed } from './useTranslateRun'

interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: any
  signal?: AbortSignal
}

const CSRF = 'csrf-translate-run'

/** 构造恰好两个片段的输入：4999 units 无边界前缀 + 收尾段。 */
const TWO_CHUNK_SOURCE = `${'a'.repeat(4999)}。${'b'.repeat(10)}`

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function errorResponse(code: string, status: number, details: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: { code, message: `${code} message`, details, requestId: 'req-1' } }, status)
}

function makePlan(units: number[], engine: TranslationEngine = 'general'): PreflightPlan {
  return {
    operation: 'translation',
    month: '2026-08',
    resetAt: '2026-09-01T00:00:00+08:00',
    source: 'dev_toolbox_local_ledger',
    professionalScene: null,
    items: units.map((unit, index) => ({
      index,
      units: unit,
      engine,
      meter: engine === 'general' ? 'mt_general' : 'mt_professional',
      scene: engine === 'general' ? 'general' : null,
    })),
    totals: [],
  }
}

function seedsFrom(source: string, protectionEnabled = true) {
  const prepared = prepareTranslationRun(source, protectionEnabled)
  return {
    seeds: prepared.chunks,
    runId: prepared.runId,
    segmentMap: prepared.segmentMap,
    protectionEnabled,
  }
}

function installFetch(handler: (request: RecordedRequest) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      signal: init?.signal ?? undefined,
    }
    requests.push(request)
    return handler(request)
  })
  vi.stubGlobal('fetch', fetchMock)
  return requests
}

const chunkPosts = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.path === '/api/v1/aliyun/translation/chunks')

const postedPaths = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.method === 'POST' || request.method === 'DELETE').map((r) => `${r.method} ${r.path}`)

describe('useTranslateRun 运行编排', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => vi.unstubAllGlobals())

  it('ready ticket：claim 后顺序发送片段，头部与请求体符合合同', async () => {
    const payload = seedsFrom(TWO_CHUNK_SOURCE)
    expect(payload.seeds).toHaveLength(2)
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-1', operation: 'translation', status: 'ready', claimBy: '2026-08-31T10:00:15Z' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-1/claim') {
        return jsonResponse({ ticketId: 't-1', status: 'active', permitToken: 'permit-1', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        return jsonResponse({
          translatedText: request.body.sourceText,
          detectedLanguage: 'zh',
          engine: 'general',
          scene: 'general',
          billableUnits: request.body.sourceText.length,
          upstreamRequestId: 'up-1',
          quota: { meter: 'mt_general', remaining: 950_000 },
          replayed: false,
        })
      }
      if (request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-1') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const run = useTranslateRun()
    await run.start(
      {
        chunks: payload.seeds,
        plan: makePlan(payload.seeds.map((seed) => seed.units)),
        sourceLanguage: 'auto',
        targetLanguage: 'en',
        runId: payload.runId,
        segmentMap: payload.segmentMap,
        protectionEnabled: payload.protectionEnabled,
      },
      () => CSRF,
    )

    expect(postedPaths(requests)).toEqual([
      'POST /api/v1/aliyun/queue-tickets',
      'POST /api/v1/aliyun/queue-tickets/t-1/claim',
      'POST /api/v1/aliyun/translation/chunks',
      'POST /api/v1/aliyun/translation/chunks',
      'DELETE /api/v1/aliyun/queue-tickets/t-1',
    ])
    const posts = chunkPosts(requests)
    expect(posts.map((post) => post.body.sourceText)).toEqual(payload.seeds.map((seed) => seed.sourceText))
    for (const post of posts) {
      expect(post.body).toMatchObject({ sourceLanguage: 'auto', targetLanguage: 'en', expectedEngine: 'general' })
      expect(post.headers['X-Cloud-Permit']).toBe('permit-1')
      expect(post.headers['X-CSRF-Token']).toBe(CSRF)
      expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    }
    expect(new Set(posts.map((post) => post.headers['Idempotency-Key'])).size).toBe(2)
    expect(run.phase.value).toBe('finished')
    expect(run.chunks.value.map((chunk) => chunk.status)).toEqual(['success', 'success'])
    expect(run.detectedLanguage.value).toBe('zh')
    expect(run.completedCount.value).toBe(2)
  })

  it('waiting ticket：轮询显示位置，ready 后继续；取消只 DELETE 不 claim', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    let polls = 0
    const secondPollGate = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    const requests = installFetch(async (request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-2', operation: 'translation', status: 'waiting', position: 2, expiresAt: '2026-08-31T10:02:00Z' }, 201)
      }
      if (request.method === 'GET' && request.path === '/api/v1/aliyun/queue-tickets/t-2') {
        polls += 1
        if (polls === 1) {
          return jsonResponse({ ticketId: 't-2', operation: 'translation', status: 'waiting', position: 1, expiresAt: '2026-08-31T10:02:00Z' })
        }
        await secondPollGate
        return jsonResponse({ ticketId: 't-2', operation: 'translation', status: 'ready', claimBy: 'x' })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-2/claim') {
        return jsonResponse({ ticketId: 't-2', status: 'active', permitToken: 'permit-2', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        return jsonResponse({ translatedText: request.body.sourceText, detectedLanguage: null, engine: 'general', scene: 'general', billableUnits: 1, upstreamRequestId: null, quota: { meter: 'mt_general', remaining: 1 }, replayed: false })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const payload = seedsFrom('只有一段。')
    const run = useTranslateRun({ pollIntervalMs: 1 })
    const pending = run.start(
      {
        chunks: payload.seeds,
        plan: makePlan([payload.seeds[0]!.units]),
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        runId: payload.runId,
        segmentMap: payload.segmentMap,
        protectionEnabled: true,
      },
      () => CSRF,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(run.phase.value).toBe('waiting')
    expect(run.queuePosition.value).toBe(1)
    gate.release?.()
    await pending
    expect(polls).toBeGreaterThanOrEqual(2)
    expect(run.phase.value).toBe('finished')

    // —— 取消语义：排队中 DELETE，不 claim、不发 chunk ——
    const cancelRequests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-3', operation: 'translation', status: 'waiting', position: 4, expiresAt: '2026-08-31T10:02:00Z' }, 201)
      }
      if (request.method === 'GET' && request.path === '/api/v1/aliyun/queue-tickets/t-3') {
        return jsonResponse({ ticketId: 't-3', operation: 'translation', status: 'waiting', position: 4, expiresAt: '2026-08-31T10:02:00Z' })
      }
      if (request.method === 'DELETE') return new Response(null, { status: 204 })
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })
    const run2 = useTranslateRun({ pollIntervalMs: 1 })
    const pendingCancel = run2.start(
      {
        chunks: [{ index: 0, units: 5, sourceText: '片段内容' }],
        plan: makePlan([5]),
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        runId: 'r',
        segmentMap: new Map(),
        protectionEnabled: false,
      },
      () => CSRF,
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(run2.phase.value).toBe('waiting')
    await run2.cancel()
    await pendingCancel
    expect(postedPaths(cancelRequests)).toEqual([
      'POST /api/v1/aliyun/queue-tickets',
      'DELETE /api/v1/aliyun/queue-tickets/t-3',
    ])
    expect(run2.phase.value).toBe('cancelled')
    expect(run2.cancelBreakdown.value).toMatchObject({ notSent: 1, sent: 0, uncertain: 0 })
  })

  it('PREFLIGHT_CHANGED：停止发送并 DELETE ticket；重新确认前 chunk POST 不再增加', async () => {
    const payload = seedsFrom(TWO_CHUNK_SOURCE)
    expect(payload.seeds).toHaveLength(2)
    const replan: { seeds: TranslateChunkSeed[] | null } = { seeds: null }
    let secondChunkAttempts = 0
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-4', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-4/claim') {
        return jsonResponse({ ticketId: 't-4', status: 'active', permitToken: 'permit-4', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'DELETE') return new Response(null, { status: 204 })
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        const isSecondChunk = request.body.sourceText === payload.seeds[1]!.sourceText
        if (isSecondChunk) {
          secondChunkAttempts += 1
          if (secondChunkAttempts === 1) {
            return errorResponse('PREFLIGHT_CHANGED', 409, {
              reason: 'engine_changed',
              expectedEngine: 'general',
              availableEngine: 'professional',
              meter: 'mt_professional',
              scene: 'title',
              units: request.body.sourceText.length,
              remaining: 950_000,
            })
          }
        }
        return jsonResponse({ translatedText: request.body.sourceText, detectedLanguage: 'zh', engine: 'general', scene: 'general', billableUnits: 1, upstreamRequestId: null, quota: { meter: 'mt_general', remaining: 1 }, replayed: false })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const run = useTranslateRun({
      pollIntervalMs: 1,
      onReplanRequired(seeds) {
        replan.seeds = seeds
      },
    })
    await run.start(
      {
        chunks: payload.seeds,
        plan: makePlan(payload.seeds.map((seed) => seed.units)),
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        runId: payload.runId,
        segmentMap: payload.segmentMap,
        protectionEnabled: true,
      },
      () => CSRF,
    )

    expect(run.phase.value).toBe('replan')
    expect(run.chunks.value.map((chunk) => chunk.status)).toEqual(['success', 'pending'])
    expect(replan.seeds?.map((seed) => seed.index)).toEqual([1])
    expect(requests.some((request) => request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-4')).toBe(true)
    const postsAfterReplan = chunkPosts(requests).length
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(chunkPosts(requests).length).toBe(postsAfterReplan) // 第二次确认前 0 次新增

    // —— 用户再次确认（新计划）后才继续发送剩余片段 ——
    const remaining = payload.seeds.filter((seed) => seed.index !== 0)
    await run.start(
      {
        chunks: remaining,
        plan: makePlan(remaining.map((seed) => seed.units), 'professional'),
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        runId: payload.runId,
        segmentMap: payload.segmentMap,
        protectionEnabled: true,
      },
      () => CSRF,
    )
    expect(chunkPosts(requests)).toHaveLength(postsAfterReplan + 1)
    const lastPost = chunkPosts(requests).at(-1)!
    expect(lastPost.body.expectedEngine).toBe('professional')
    expect(lastPost.body.sourceText).toBe(payload.seeds[1]!.sourceText)
    expect(run.phase.value).toBe('finished')
    expect(run.chunks.value.map((chunk) => chunk.status)).toEqual(['success', 'success'])
  })

  it('片段失败后“继续”只重发失败片段且使用新 Idempotency-Key', async () => {
    const payload = seedsFrom(TWO_CHUNK_SOURCE)
    let chunkAttempt = 0
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-5', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-5/claim') {
        return jsonResponse({ ticketId: 't-5', status: 'active', permitToken: 'permit-5', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        chunkAttempt += 1
        if (chunkAttempt === 2) return errorResponse('UPSTREAM_REJECTED', 502)
        return jsonResponse({ translatedText: request.body.sourceText, detectedLanguage: null, engine: 'general', scene: 'general', billableUnits: 1, upstreamRequestId: null, quota: { meter: 'mt_general', remaining: 1 }, replayed: false })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const run = useTranslateRun()
    await run.start(
      {
        chunks: payload.seeds,
        plan: makePlan(payload.seeds.map((seed) => seed.units)),
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        runId: payload.runId,
        segmentMap: payload.segmentMap,
        protectionEnabled: true,
      },
      () => CSRF,
    )
    expect(run.phase.value).toBe('paused')
    expect(run.chunks.value.map((chunk) => chunk.status)).toEqual(['success', 'failed'])
    expect(run.runError.value?.code).toBe('UPSTREAM_REJECTED')
    const failedKey = chunkPosts(requests)[1]!.headers['Idempotency-Key']

    await run.continueFromFailure()
    expect(chunkPosts(requests)).toHaveLength(3)
    const retryPost = chunkPosts(requests).at(-1)!
    expect(retryPost.body.sourceText).toBe(payload.seeds[1]!.sourceText)
    expect(retryPost.headers['Idempotency-Key']).not.toBe(failedKey)
    expect(run.phase.value).toBe('finished')
    expect(run.chunks.value.map((chunk) => chunk.status)).toEqual(['success', 'success'])
    // 复用同一 permit，不重新排队。
    expect(requests.filter((request) => request.path === '/api/v1/aliyun/queue-tickets').length).toBe(2)
  })

  it('运行中取消：DELETE ticket，在途片段按结果不确定呈现并区分三类片段', async () => {
    const payload = seedsFrom(TWO_CHUNK_SOURCE)
    const inFlight: { release: (() => void) | null } = { release: null }
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-6', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-6/claim') {
        return jsonResponse({ ticketId: 't-6', status: 'active', permitToken: 'permit-6', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'DELETE') return new Response(null, { status: 204 })
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        return new Promise<Response>((resolve, reject) => {
          inFlight.release = () => resolve(jsonResponse({ translatedText: request.body.sourceText, detectedLanguage: null, engine: 'general', scene: 'general', billableUnits: 1, upstreamRequestId: null, quota: { meter: 'mt_general', remaining: 1 }, replayed: false }))
          request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }) as Promise<Response>
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const run = useTranslateRun()
    const pending = run.start(
      {
        chunks: payload.seeds,
        plan: makePlan(payload.seeds.map((seed) => seed.units)),
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        runId: payload.runId,
        segmentMap: payload.segmentMap,
        protectionEnabled: true,
      },
      () => CSRF,
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(run.phase.value).toBe('running')

    await run.cancel()
    inFlight.release?.()
    await pending
    expect(requests.some((request) => request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-6')).toBe(true)
    expect(run.phase.value).toBe('cancelled')
    expect(run.cancelBreakdown.value).toMatchObject({ notSent: 1, sent: 0, uncertain: 1 })
    expect(run.chunks.value[0]!.status).toBe('uncertain')
    expect(run.chunks.value[0]!.errorCode).toBe('CLIENT_CANCELLED')
  })

  it('UPSTREAM_RESULT_UNCERTAIN：片段标记不确定并暂停，不自动重试', async () => {
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-7', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-7/claim') {
        return jsonResponse({ ticketId: 't-7', status: 'active', permitToken: 'permit-7', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        return errorResponse('UPSTREAM_RESULT_UNCERTAIN', 504, {
          failureCategory: 'timeout',
          upstreamRequestId: 'up-7',
          callStatus: 'uncertain',
          meter: 'mt_general',
          countedUnits: 6,
          remaining: 950_000,
        })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const payload = seedsFrom('单段内容。')
    const run = useTranslateRun()
    await run.start(
      {
        chunks: payload.seeds,
        plan: makePlan([payload.seeds[0]!.units]),
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        runId: payload.runId,
        segmentMap: payload.segmentMap,
        protectionEnabled: true,
      },
      () => CSRF,
    )
    expect(run.phase.value).toBe('paused')
    expect(run.chunks.value[0]!.status).toBe('uncertain')
    expect(run.hasUncertainChunks.value).toBe(true)
    expect(chunkPosts(requests)).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(chunkPosts(requests)).toHaveLength(1)
  })

  it('占位符校验失败：保留原文、标记 restore-failed，额度已用不重发', async () => {
    const source = '先 `npm run build` 再继续'
    const payload = seedsFrom(source)
    expect(payload.seeds).toHaveLength(1)
    expect(payload.segmentMap.size).toBe(1)
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-8', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-8/claim') {
        return jsonResponse({ ticketId: 't-8', status: 'active', permitToken: 'permit-8', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        return jsonResponse({ translatedText: '占位符消失了', detectedLanguage: 'zh', engine: 'general', scene: 'general', billableUnits: 20, upstreamRequestId: null, quota: { meter: 'mt_general', remaining: 950_000 }, replayed: false })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const run = useTranslateRun()
    await run.start(
      {
        chunks: payload.seeds,
        plan: makePlan([payload.seeds[0]!.units]),
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        runId: payload.runId,
        segmentMap: payload.segmentMap,
        protectionEnabled: true,
      },
      () => CSRF,
    )
    expect(run.phase.value).toBe('finished')
    const chunk = run.chunks.value[0]!
    expect(chunk.status).toBe('restore-failed')
    expect(chunk.resultText).toBe(source)
    expect(chunk.errorCode).toBe('PLACEHOLDER_RESTORE_FAILED')
    expect(run.completedCount.value).toBe(1)
    expect(chunkPosts(requests)).toHaveLength(1)
  })

  it('保护关闭：不做占位符校验，译文直接采用', async () => {
    const source = '包含 __DT_FAKE_001__ 形状字符串'
    const payload = seedsFrom(source, false)
    expect(payload.seeds).toHaveLength(1)
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-9', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-9/claim') {
        return jsonResponse({ ticketId: 't-9', status: 'active', permitToken: 'permit-9', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        return jsonResponse({ translatedText: `${request.body.sourceText}（已翻译）`, detectedLanguage: null, engine: 'general', scene: 'general', billableUnits: 1, upstreamRequestId: null, quota: { meter: 'mt_general', remaining: 1 }, replayed: false })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const run = useTranslateRun()
    await run.start(
      {
        chunks: payload.seeds,
        plan: makePlan([payload.seeds[0]!.units]),
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        runId: payload.runId,
        segmentMap: payload.segmentMap,
        protectionEnabled: false,
      },
      () => CSRF,
    )
    expect(run.chunks.value[0]!.status).toBe('success')
    expect(run.chunks.value[0]!.resultText).toBe(`${source}（已翻译）`)
  })
})

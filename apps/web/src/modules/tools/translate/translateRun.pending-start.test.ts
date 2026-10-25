/**
 * 红测（DT-R47）：start() 通过 isBusy 检查后 park 在 supersedeActiveRun 的
 * pendingTicketRelease（在途旧 DELETE）上，续体没有归属复查——旧 DELETE 返回
 * 后直接 generation += 1、cancelRequested = false，并以过期输入创建新 queue
 * ticket/claim/发送 chunk。dispose() 与 resetForNewRun() 只置 cancelRequested
 * = true、不递增 generation，作废不了这个正等待旧清理的续体。
 *
 * 时序：run A 的 chunk POST 在途 → cancel() 真实 abort 使其按 cancelled 收尾
 * （phase='cancelled'、isBusy=false，cancel 自身仍 await 被 gate 阻塞的
 * DELETE t-p1）→ 显式 start(B) 通过 isBusy 检查后 park 在旧 DELETE 上 →
 * dispose()/resetForNewRun() → 旧 DELETE 返回 → B 以过期输入意外继续运行。
 * 不使用 PREFLIGHT_CHANGED 构造本窗口（DELETE 未回时仍 busy，证明不了本路径）。
 *
 * 用例 1、2 在当前实现上应为红；用例 3 是正常守卫，修复后也必须保持绿。
 * 用例 4 补充 dispose 终态：TranslateView 的 onBeforeUnmount 不递增 preflightGeneration，
 * 晚到的 preflight 回包会在离页后仍调用 helper.start——dispose 必须拒绝其后的一切新准入。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreflightPlan, TranslationEngine } from './contracts'
import { prepareTranslationRun } from './prepare'
import { useTranslateRun } from './useTranslateRun'

interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: any
  signal?: AbortSignal
}

const CSRF = 'csrf-translate-pending-start'

/** A 的输入：构造恰好两个片段，4999 units 无边界前缀 + 收尾段。 */
const TWO_CHUNK_SOURCE = `${'a'.repeat(4999)}。${'b'.repeat(10)}`

/** B 的输入：与 A 不同的单段文本。 */
const FRESH_SOURCE = '全新输入内容。'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
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

const queueTicketPosts = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets')

const postedPaths = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.method === 'POST' || request.method === 'DELETE').map((r) => `${r.method} ${r.path}`)

const chunkSuccessResponse = (sourceText: string) =>
  jsonResponse({
    translatedText: sourceText,
    detectedLanguage: 'zh',
    engine: 'general',
    scene: 'general',
    billableUnits: sourceText.length,
    upstreamRequestId: null,
    quota: { meter: 'mt_general', remaining: 1 },
    replayed: false,
  })

interface DeleteGate {
  release: (() => void) | null
}

interface PendingStartWindow {
  run: ReturnType<typeof useTranslateRun>
  requests: RecordedRequest[]
  deleteGate: DeleteGate
  pendingA: Promise<void>
  cancelling: Promise<void>
  startB: Promise<void>
  freshSeedSourceText: string
}

/** 驱动到缺陷窗口：A 已 cancelled、cancel 仍 await 被 gate 阻塞的 DELETE t-p1、B 的 start park 在该 DELETE 上。 */
async function driveIntoPendingStartWindow(): Promise<PendingStartWindow> {
  const payloadA = seedsFrom(TWO_CHUNK_SOURCE)
  expect(payloadA.seeds).toHaveLength(2)
  const payloadB = seedsFrom(FRESH_SOURCE)
  expect(payloadB.seeds).toHaveLength(1)

  const deleteGate: DeleteGate = { release: null }
  let queueCreates = 0
  const requests = installFetch((request) => {
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
      queueCreates += 1
      // 第 1 次创建归 A（t-p1）；之后每次归 B 的意外运行（t-p2），保证它能正常走完。
      const ticketId = queueCreates === 1 ? 't-p1' : 't-p2'
      return jsonResponse({ ticketId, operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-p1/claim') {
      return jsonResponse({ ticketId: 't-p1', status: 'active', permitToken: 'permit-p1', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-p2/claim') {
      return jsonResponse({ ticketId: 't-p2', status: 'active', permitToken: 'permit-p2', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
      if (request.headers['X-Cloud-Permit'] === 'permit-p1') {
        // A 的在途 chunk：挂起直到真实 abort 才 reject（translateRun.test.ts「运行中取消」模式）。
        return new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }) as Promise<Response>
      }
      // B 的 chunk：echo 成功响应，占位符校验可过。
      return chunkSuccessResponse(request.body.sourceText)
    }
    if (request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-p1') {
      return new Promise<Response>((resolve) => {
        deleteGate.release = () => resolve(new Response(null, { status: 204 }))
      })
    }
    if (request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-p2') {
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected request: ${request.method} ${request.path}`)
  })

  const run = useTranslateRun()

  // a. A 运行中，chunk POST 已发出。
  const pendingA = run.start(
    {
      chunks: payloadA.seeds,
      plan: makePlan(payloadA.seeds.map((seed) => seed.units)),
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      runId: payloadA.runId,
      segmentMap: payloadA.segmentMap,
      protectionEnabled: true,
    },
    () => CSRF,
  )
  await wait(5)
  expect(run.phase.value).toBe('running')
  expect(chunkPosts(requests).length).toBeGreaterThanOrEqual(1)

  // b. 取消：chunk 被真实 abort，phase 先到 cancelled、isBusy=false；DELETE t-p1 已进入被阻塞的 gate。
  const cancelling = run.cancel()
  await wait(5)
  expect(run.phase.value).toBe('cancelled')
  expect(run.isBusy.value).toBe(false)
  expect(
    requests.some((request) => request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-p1'),
  ).toBe(true)

  // c. 显式新发起 B：通过 isBusy 检查后 park 在旧 DELETE 上，尚未创建新 queue。
  const startB = run.start(
    {
      chunks: payloadB.seeds,
      plan: makePlan([payloadB.seeds[0]!.units]),
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      runId: payloadB.runId,
      segmentMap: payloadB.segmentMap,
      protectionEnabled: true,
    },
    () => CSRF,
  )
  await wait(5)
  expect(queueTicketPosts(requests)).toHaveLength(1)

  return { run, requests, deleteGate, pendingA, cancelling, startB, freshSeedSourceText: payloadB.seeds[0]!.sourceText }
}

async function settleAfterRelease(ctx: PendingStartWindow): Promise<void> {
  ctx.deleteGate.release?.()
  await ctx.cancelling
  await ctx.startB
  await ctx.pendingA
  await wait(10)
}

describe('useTranslateRun 等待旧清理期间的启动归属', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => vi.unstubAllGlobals())

  it('dispose 边界：等待旧 DELETE 的启动被作废，不再创建新 queue/claim/chunk', async () => {
    const ctx = await driveIntoPendingStartWindow()
    ctx.run.dispose()
    await settleAfterRelease(ctx)

    expect(postedPaths(ctx.requests)).toEqual([
      'POST /api/v1/aliyun/queue-tickets',
      'POST /api/v1/aliyun/queue-tickets/t-p1/claim',
      'POST /api/v1/aliyun/translation/chunks',
      'DELETE /api/v1/aliyun/queue-tickets/t-p1',
    ])
    expect(chunkPosts(ctx.requests)).toHaveLength(1)
    expect(ctx.requests.some((request) => request.path.includes('t-p2'))).toBe(false)
  })

  it('resetForNewRun 边界：等待旧 DELETE 的启动被新输入作废，不再创建新 queue/claim/chunk', async () => {
    const ctx = await driveIntoPendingStartWindow()
    ctx.run.resetForNewRun()
    await settleAfterRelease(ctx)

    expect(postedPaths(ctx.requests)).toEqual([
      'POST /api/v1/aliyun/queue-tickets',
      'POST /api/v1/aliyun/queue-tickets/t-p1/claim',
      'POST /api/v1/aliyun/translation/chunks',
      'DELETE /api/v1/aliyun/queue-tickets/t-p1',
    ])
    expect(chunkPosts(ctx.requests)).toHaveLength(1)
    expect(ctx.requests.some((request) => request.path.includes('t-p2'))).toBe(false)
  })

  it('正常守卫：无作废时显式新发起在旧清理完成后继续运行', async () => {
    const ctx = await driveIntoPendingStartWindow()
    await settleAfterRelease(ctx)

    expect(queueTicketPosts(ctx.requests)).toHaveLength(2)
    expect(
      ctx.requests.some(
        (request) => request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-p2/claim',
      ),
    ).toBe(true)
    expect(chunkPosts(ctx.requests).some((request) => request.body.sourceText === ctx.freshSeedSourceText)).toBe(true)
    expect(ctx.run.phase.value).toBe('finished')
  })

  it('dispose 终态：离页后晚到 preflight 回包再调 start，不创建任何 queue/claim/chunk', async () => {
    // 直接消费者依据：TranslateView requestPreflightAndRun 在 await preflight 后只比较
    // 自身 preflightGeneration（onBeforeUnmount 不递增它）再 startPlannedRun → void run.start。
    // 离页时 preflight 在途，回包后仍会调用一个已 dispose 的 helper。
    const payload = seedsFrom(FRESH_SOURCE)
    expect(payload.seeds).toHaveLength(1)
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-late', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-late/claim') {
        return jsonResponse({ ticketId: 't-late', status: 'active', permitToken: 'permit-late', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        return chunkSuccessResponse(request.body.sourceText)
      }
      if (request.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const run = useTranslateRun()
    run.dispose()
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
    await wait(10)

    expect(queueTicketPosts(requests)).toHaveLength(0)
    expect(requests.some((request) => request.method === 'POST' && request.path.endsWith('/claim'))).toBe(false)
    expect(chunkPosts(requests)).toHaveLength(0)
    expect(postedPaths(requests)).toEqual([])
  })
})

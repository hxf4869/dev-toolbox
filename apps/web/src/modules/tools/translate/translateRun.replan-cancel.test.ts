/**
 * 红测（DT-R41）：PREFLIGHT_CHANGED 处理在 releaseActiveTicket 的 DELETE
 * 返回后未复查 cancelRequested/generation，直接进入 replan 并回调
 * onReplanRequired。取消或离页发生在 DELETE 在途时，晚到的回调仍会触发
 * 一次重新预检续传。两条测试都必须保持「回调从未发生」的断言。
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

const CSRF = 'csrf-translate-replan-cancel'

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

const preflightChangedResponse = (sourceText: string) =>
  errorResponse('PREFLIGHT_CHANGED', 409, {
    reason: 'engine_changed',
    expectedEngine: 'general',
    availableEngine: 'professional',
    meter: 'mt_professional',
    scene: 'title',
    units: sourceText.length,
    remaining: 950_000,
  })

describe('useTranslateRun PREFLIGHT_CHANGED 取消/离页边界', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => vi.unstubAllGlobals())

  it('DELETE 在途时用户取消：不触发 onReplanRequired，最终为 cancelled 且无新增请求', async () => {
    const payload = seedsFrom(TWO_CHUNK_SOURCE)
    expect(payload.seeds).toHaveLength(2)
    const onReplanRequired = vi.fn()
    const deleteGate: { release: (() => void) | null } = { release: null }
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-r1', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-r1/claim') {
        return jsonResponse({ ticketId: 't-r1', status: 'active', permitToken: 'permit-r1', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-r1') {
        return new Promise<Response>((resolve) => {
          deleteGate.release = () => resolve(new Response(null, { status: 204 }))
        })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        if (request.body.sourceText === payload.seeds[1]!.sourceText) {
          return preflightChangedResponse(request.body.sourceText)
        }
        return chunkSuccessResponse(request.body.sourceText)
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const run = useTranslateRun({ onReplanRequired })
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
    expect(
      requests.some((request) => request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-r1'),
    ).toBe(true)

    const cancelling = run.cancel()
    deleteGate.release?.()
    await cancelling
    await pending

    expect(onReplanRequired).toHaveBeenCalledTimes(0)
    expect(run.phase.value).toBe('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(postedPaths(requests)).toEqual([
      'POST /api/v1/aliyun/queue-tickets',
      'POST /api/v1/aliyun/queue-tickets/t-r1/claim',
      'POST /api/v1/aliyun/translation/chunks',
      'POST /api/v1/aliyun/translation/chunks',
      'DELETE /api/v1/aliyun/queue-tickets/t-r1',
    ])
  })

  it('DELETE 在途时离页 dispose：不触发 onReplanRequired，也无新增请求', async () => {
    const payload = seedsFrom('单段内容。')
    const onReplanRequired = vi.fn()
    const deleteGate: { release: (() => void) | null } = { release: null }
    const requests = installFetch((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
        return jsonResponse({ ticketId: 't-r2', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-r2/claim') {
        return jsonResponse({ ticketId: 't-r2', status: 'active', permitToken: 'permit-r2', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
      }
      if (request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-r2') {
        return new Promise<Response>((resolve) => {
          deleteGate.release = () => resolve(new Response(null, { status: 204 }))
        })
      }
      if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
        return preflightChangedResponse(request.body.sourceText)
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`)
    })

    const run = useTranslateRun({ onReplanRequired })
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
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(
      requests.some((request) => request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-r2'),
    ).toBe(true)

    run.dispose()
    deleteGate.release?.()
    await pending

    expect(onReplanRequired).toHaveBeenCalledTimes(0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(postedPaths(requests)).toEqual([
      'POST /api/v1/aliyun/queue-tickets',
      'POST /api/v1/aliyun/queue-tickets/t-r2/claim',
      'POST /api/v1/aliyun/translation/chunks',
      'DELETE /api/v1/aliyun/queue-tickets/t-r2',
    ])
  })
})

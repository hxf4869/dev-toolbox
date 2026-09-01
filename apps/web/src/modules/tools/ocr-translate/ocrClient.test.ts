import { describe, expect, it, vi, afterEach } from 'vitest'

import { describeOcrCloudError, postCloudOcr } from './ocrClient'

describe('postCloudOcr（multipart 合同）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('只发送一个 image part 并携带幂等/permit/CSRF 头', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      captured = { url, init: init ?? {} }
      return new Response(JSON.stringify({
        text: '识别文本',
        upstreamRequestId: 'qa-ocr-1',
        billableUnits: 1,
        quota: { meter: 'ocr_general', remaining: 187 },
        replayed: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    const blob = new Blob(['image-bytes'], { type: 'image/png' })
    const response = await postCloudOcr({
      blob,
      fileName: 'shot.png',
      permitToken: 'qa-permit',
      csrfToken: 'qa-csrf',
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    })

    expect(captured?.url).toBe('/api/v1/aliyun/ocr')
    expect(captured?.init.method).toBe('POST')
    const headers = new Headers(captured?.init.headers)
    expect(headers.get('Idempotency-Key')).toBe('33333333-3333-4333-8333-333333333333')
    expect(headers.get('X-Cloud-Permit')).toBe('qa-permit')
    expect(headers.get('X-CSRF-Token')).toBe('qa-csrf')
    expect(captured?.init.body).toBeInstanceOf(FormData)
    const form = captured?.init.body as FormData
    const parts = Array.from(form.entries())
    expect(parts).toHaveLength(1)
    expect(parts[0]?.[0]).toBe('image')
    expect(response.text).toBe('识别文本')
    expect(response.quota.remaining).toBe(187)
  })

  it('上传失败时抛出带稳定错误码的 TranslateApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'QUOTA_EXHAUSTED', message: '本月应用保护额度已用尽' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )))
    const blob = new Blob(['x'], { type: 'image/png' })
    const error = (await postCloudOcr({
      blob,
      fileName: 'a.png',
      permitToken: 'p',
      csrfToken: 'c',
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    }).catch((caught: unknown) => caught)) as { code: string; status: number }
    expect(error.code).toBe('QUOTA_EXHAUSTED')
    expect(error.status).toBe(429)
  })
})

describe('describeOcrCloudError（稳定码 → OCR UI 动作）', () => {
  it('未配置与额度耗尽指向设置', () => {
    expect(describeOcrCloudError('ALIYUN_NOT_CONFIGURED', 422).kind).toBe('settings')
    expect(describeOcrCloudError('QUOTA_EXHAUSTED', 429).kind).toBe('quota')
  })

  it('结果不确定与网络错误按保守计量呈现', () => {
    expect(describeOcrCloudError('UPSTREAM_RESULT_UNCERTAIN', 504).kind).toBe('uncertain')
    expect(describeOcrCloudError('NETWORK_ERROR', 0).kind).toBe('uncertain')
  })

  it('上游拒绝/限流为手动重试，不自动重试', () => {
    expect(describeOcrCloudError('UPSTREAM_THROTTLED', 429).kind).toBe('manual-retry')
    expect(describeOcrCloudError('UPSTREAM_REJECTED', 502).kind).toBe('manual-retry')
    expect(describeOcrCloudError('CALL_SETTLED_WITHOUT_RESULT', 409).kind).toBe('manual-retry')
  })

  it('队列与许可失效需要重新排队', () => {
    expect(describeOcrCloudError('QUEUE_FULL', 429).kind).toBe('requeue')
    expect(describeOcrCloudError('QUEUE_TICKET_NOT_FOUND', 404).kind).toBe('requeue')
    expect(describeOcrCloudError('CLOUD_PERMIT_EXPIRED', 410).kind).toBe('requeue')
  })

  it('未知错误仍给出稳定码且不自动重试', () => {
    const action = describeOcrCloudError('SOMETHING_NEW', 500)
    expect(action.kind).toBe('plain')
    expect(action.detail).toContain('SOMETHING_NEW')
  })
})

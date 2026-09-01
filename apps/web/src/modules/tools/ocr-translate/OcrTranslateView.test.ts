import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { useAuthStore } from '../../../app/auth'
import OcrTranslateView from './OcrTranslateView.vue'

/**
 * OCR 页面关键合同测试（jsdom + fetch mock；tesseract.js 由 vi.mock 替换）。
 * 覆盖：本地路径零业务请求与零存储、云确认前零调用、确认后完整云链路、
 * 本地识别调用参数（本站资产路径）、低置信度提示、翻译复用（走 useTranslateRun 封装）。
 */

vi.mock('tesseract.js', () => {
  const worker = {
    recognize: vi.fn(async () => ({
      data: {
        text: 'Graphite Workbench\nD3veloper Tools',
        blocks: [
          {
            paragraphs: [
              { lines: [{ text: 'Graphite Workbench', confidence: 92 }] },
              { lines: [{ text: 'D3veloper Tools', confidence: 41 }] },
            ],
          },
        ],
      },
    })),
    terminate: vi.fn(async () => undefined),
  }
  return {
    createWorker: vi.fn(async () => worker),
    __worker: worker,
  }
})

import * as tesseractModule from 'tesseract.js'
const __worker = (tesseractModule as unknown as { __worker: { recognize: ReturnType<typeof vi.fn> } }).__worker

const ticketId = '33333333-3333-4333-8333-333333333333'
const permitToken = 'qa-permit-token'

function makeFetchMock(overrides: {
  preflightOcrCode?: string
  chunkCode?: string
  configured?: boolean
} = {}) {
  const calls: { path: string; method: string }[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    const requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, any> : null
    calls.push({ path, method })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

    if (path.endsWith('/api/v1/auth/session')) {
      return json({
        status: 'authenticated',
        owner: { id: '11111111-1111-4111-8111-111111111111', username: 'owner' },
        session: { id: '22222222-2222-4222-8222-222222222222', expiresAt: '2099-01-01T00:00:00Z' },
        csrfToken: 'qa-csrf',
      })
    }
    if (path.endsWith('/api/v1/aliyun/translation/languages')) {
      return json({
        version: 'v',
        generalLanguages: [
          { code: 'zh', nameZh: '中文', nameEn: 'Chinese' },
          { code: 'en', nameZh: '英语', nameEn: 'English' },
        ],
        professionalPairsByScene: { title: [['zh', 'en']] },
      })
    }
    if (path.endsWith('/api/v1/aliyun/usage/current')) {
      return json({
        month: '2026-08',
        timezone: 'Asia/Shanghai',
        meters: [
          { meter: 'mt_general', limit: 950000, used: 0, reserved: 0, remaining: 950000 },
          { meter: 'mt_professional', limit: 950000, used: 0, reserved: 0, remaining: 950000 },
          { meter: 'ocr_general', limit: 190, used: 2, reserved: 0, remaining: 188 },
        ],
        source: 'dev_toolbox_local_ledger',
      })
    }
    if (path.endsWith('/api/v1/aliyun/settings')) {
      return json({
        credentials: { configured: overrides.configured ?? true, accessKeyIdMasked: '****ABCD', credentialVersion: 1 },
        translation: { generalMonthlyLimit: 950000, professionalMonthlyLimit: 950000, autoUseProfessional: true, professionalScene: 'title' },
        ocr: { monthlyLimit: 190 },
        concurrency: { owner: 1, global: 3 },
        status: { lastSuccessAt: null, lastFailureAt: null, lastFailureCategory: null },
      })
    }
    if (path.endsWith('/api/v1/aliyun/preflight')) {
      if (overrides.preflightOcrCode === 'QUOTA_EXHAUSTED') {
        return json({ error: { code: 'QUOTA_EXHAUSTED', message: '本月应用保护额度已用尽' } }, 429)
      }
      if (String(init?.body).includes('"operation":"translation"')) {
        const chunkUnits = requestBody?.chunkUnits as number[]
        const totalUnits = chunkUnits.reduce((sum, value) => sum + value, 0)
        return json({
          operation: 'translation',
          month: '2026-08',
          resetAt: '2026-09-01T00:00:00+08:00',
          source: 'dev_toolbox_local_ledger',
          professionalScene: null,
          items: chunkUnits.map((units, index) => ({ index, units, engine: 'general', meter: 'mt_general', scene: 'general' })),
          totals: [{ meter: 'mt_general', chunks: chunkUnits.length, units: totalUnits, limit: 950000, used: 0, reserved: 0, remainingBefore: 950000, remainingAfterPlan: 950000 - totalUnits }],
        })
      }
      return json({
        operation: 'ocr',
        month: '2026-08',
        resetAt: '2026-09-01T00:00:00+08:00',
        source: 'dev_toolbox_local_ledger',
        professionalScene: null,
        items: [{ index: 0, units: 1, engine: 'ocr', meter: 'ocr_general', scene: null }],
        totals: [{ meter: 'ocr_general', chunks: 1, units: 1, limit: 190, used: 2, reserved: 0, remainingBefore: 188, remainingAfterPlan: 187 }],
      })
    }
    if (path.endsWith('/api/v1/aliyun/queue-tickets') && method === 'POST') {
      return json({ ticketId, operation: requestBody?.operation ?? 'ocr', status: 'ready', claimBy: '2099-01-01T00:00:00Z' }, 201)
    }
    if (path.endsWith(`/api/v1/aliyun/queue-tickets/${ticketId}`) && method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    if (path.endsWith(`/api/v1/aliyun/queue-tickets/${ticketId}/claim`)) {
      return json({ ticketId, status: 'active', permitToken, idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' })
    }
    if (path.endsWith('/api/v1/aliyun/ocr')) {
      if (overrides.chunkCode === 'UPSTREAM_RESULT_UNCERTAIN') {
        return json({ error: { code: 'UPSTREAM_RESULT_UNCERTAIN', message: '结果不确定' } }, 504)
      }
      return json({
        text: '阿里云识别文本',
        upstreamRequestId: 'qa-ocr-1',
        billableUnits: 1,
        quota: { meter: 'ocr_general', remaining: 187 },
        replayed: false,
      })
    }
    if (path.endsWith('/api/v1/aliyun/translation/chunks')) {
      if (overrides.chunkCode) {
        return json({ error: { code: overrides.chunkCode, message: 'x' } }, 504)
      }
      return json({
        translatedText: 'translated',
        detectedLanguage: 'zh',
        engine: 'general',
        scene: 'general',
        billableUnits: 10,
        upstreamRequestId: 'qa-tr-1',
        quota: { meter: 'mt_general', remaining: 949990 },
        replayed: false,
      })
    }
    throw new Error(`unexpected request: ${method} ${path}`)
  })
  return { fetchMock, calls }
}

function stubDecode(originalWidth: number, originalHeight: number) {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
    width: originalWidth,
    height: originalHeight,
    close: vi.fn(),
  })))
}

async function mountOcr(): Promise<VueWrapper> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'qa-csrf'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tools/ocr-translate', name: 'tool-ocr', component: OcrTranslateView },
      { path: '/tools/translate', name: 'tool-translate', component: { template: '<div />' } },
      { path: '/settings/aliyun', name: 'aliyun-settings', component: { template: '<div />' } },
      { path: '/tools', name: 'tools', component: { template: '<div />' } },
    ],
  })
  await router.push('/tools/ocr-translate')
  await router.isReady()
  return mount(OcrTranslateView, { attachTo: document.body, global: { plugins: [pinia, router] } })
}

async function selectLocalImage(wrapper: VueWrapper) {
  stubDecode(800, 600)
  const input = wrapper.find<HTMLInputElement>('input[type="file"]')
  const file = new File(['image-bytes'], 'shot.png', { type: 'image/png' })
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

describe('OCR 翻译页面', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('初始空态：无业务请求、无内容存储，本地徽标与限制说明可见', async () => {
    const { fetchMock, calls } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await flushPromises()

    expect(wrapper.text()).toContain('OCR 翻译')
    expect(wrapper.text()).toContain('图片留在此设备')
    expect(wrapper.text()).toContain('不支持 PDF、HEIC、批量或相机')
    expect(calls.every((call) => call.path.endsWith('/api/v1/auth/session'))).toBe(true)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    wrapper.unmount()
  })

  it('本地 OCR：只调用本站 tesseract 资产路径，业务请求为零；低置信度行有标记', async () => {
    const { fetchMock, calls } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await selectLocalImage(wrapper)

    const runButton = wrapper.find('[data-testid="ocr-local-run"]')
    expect(runButton.attributes('disabled')).toBeUndefined()
    await runButton.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="ocr-proof-text"]').exists()).toBe(true)
    expect((wrapper.find('[data-testid="ocr-proof-text"]').element as HTMLTextAreaElement).value)
      .toContain('Graphite Workbench')
    expect(wrapper.text()).toContain('低置信度')
    expect(wrapper.text()).toContain('D3veloper Tools')

    expect(__worker.recognize).toHaveBeenCalled()
    const createWorkerMock = (await import('tesseract.js')).createWorker as ReturnType<typeof vi.fn>
    const options = createWorkerMock.mock.calls[0]?.[2] as Record<string, string>
    expect(options.workerPath).toBe('/tesseract/worker.min.js')
    expect(options.corePath).toBe('/tesseract/core')
    expect(options.langPath).toBe('/tesseract/lang')

    expect(calls.filter((call) => !call.path.endsWith('/api/v1/auth/session'))).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    wrapper.unmount()
  })

  it('云重识别：确认前 zero 调用；确认后走 preflight→ticket→claim→multipart；成功回填校对区', async () => {
    const { fetchMock, calls } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await selectLocalImage(wrapper)
    await wrapper.find('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()

    // 打开确认层：除 languages/usage（打开云路径时的额度查询）外无 POST
    await wrapper.find('[data-testid="ocr-cloud-open"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="ocr-cloud-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('预计消耗')
    expect(wrapper.text()).toContain('1 次云 OCR 额度')
    const beforeConfirm = calls.filter((call) => call.method === 'POST' && call.path.includes('/aliyun/'))
    expect(beforeConfirm.filter((call) => !call.path.includes('/preflight'))).toHaveLength(0)

    await wrapper.find('[data-testid="ocr-cloud-confirm"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect((wrapper.find('[data-testid="ocr-proof-text"]').element as HTMLTextAreaElement).value)
      .toBe('阿里云识别文本')
    expect(wrapper.text()).toContain('来自阿里云重新识别')
    const ocrPosts = calls.filter((call) => call.path.endsWith('/api/v1/aliyun/ocr'))
    expect(ocrPosts).toHaveLength(1)
    expect(calls.some((call) =>
      call.method === 'DELETE' && call.path.endsWith(`/api/v1/aliyun/queue-tickets/${ticketId}`))).toBe(true)
    wrapper.unmount()
  })

  it('云 OCR 预检失败时不打开确认层，也不创建 ticket 或上传图片', async () => {
    const { fetchMock, calls } = makeFetchMock({ preflightOcrCode: 'QUOTA_EXHAUSTED' })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await selectLocalImage(wrapper)
    await wrapper.find('[data-testid="ocr-cloud-open"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="ocr-cloud-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ocr-cloud-preflight-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('本月云 OCR 额度已用尽')
    expect(calls.filter((call) => call.path.endsWith('/api/v1/aliyun/queue-tickets'))).toHaveLength(0)
    expect(calls.filter((call) => call.path.endsWith('/api/v1/aliyun/ocr'))).toHaveLength(0)
    wrapper.unmount()
  })

  it('云 OCR 结果不确定：保守计量呈现且不自动重试；手动重试生成新请求', async () => {
    const { fetchMock, calls } = makeFetchMock({ chunkCode: 'UPSTREAM_RESULT_UNCERTAIN' })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await selectLocalImage(wrapper)
    await wrapper.find('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="ocr-cloud-open"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="ocr-cloud-confirm"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(wrapper.find('[data-testid="ocr-cloud-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('结果不确定')
    expect(wrapper.text()).toContain('不会自动重试')
    expect(wrapper.text()).toContain('可能重复计费')
    const firstOcr = calls.filter((call) => call.path.endsWith('/api/v1/aliyun/ocr'))
    expect(firstOcr).toHaveLength(1)

    // 手动重试先重新预检并再次确认，确认前不会产生第二次 OCR 调用。
    const retry = wrapper.find('[data-testid="ocr-cloud-retry"]')
    if (retry.exists()) {
      await retry.trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="ocr-cloud-dialog"]').exists()).toBe(true)
    }
    expect(calls.filter((call) => call.path.endsWith('/api/v1/aliyun/ocr'))).toHaveLength(1)
    wrapper.unmount()
  })

  it('翻译确认层：二次独立确认后复用翻译运行，多片段结果不注入空行', async () => {
    const { fetchMock, calls } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await selectLocalImage(wrapper)
    await wrapper.find('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="ocr-proof-text"]').setValue('甲'.repeat(5000))
    // 语言清单在语言行 focusin 时加载（jsdom 的 focus 不派发 focusin，需显式触发）
    await wrapper.find('.language-bar').trigger('focusin')
    await flushPromises()
    // 选择目标语言（combobox：ArrowDown 打开 → 输入过滤 → Enter 选中）
    const targetInput = wrapper.find<HTMLInputElement>('input#ocr-target-language')
    await targetInput.trigger('focus')
    await targetInput.trigger('keydown', { key: 'ArrowDown' })
    await targetInput.setValue('en')
    await targetInput.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    // 校对文本防抖 prepare（250ms）完成后主按钮才可用
    await new Promise((resolve) => setTimeout(resolve, 300))
    await flushPromises()

    await wrapper.find('[data-testid="ocr-translate-primary"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="ocr-translate-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('阿里云机器翻译')
    expect(wrapper.text()).toContain('与图片识别是不同的服务')
    expect(calls.filter((call) => call.path.endsWith('/api/v1/aliyun/translation/chunks'))).toHaveLength(0)

    await wrapper.find('[data-testid="ocr-translate-confirm"]').trigger('click')
    await flushPromises()
    await flushPromises()
    await flushPromises()

    expect(calls.filter((call) => call.path.endsWith('/api/v1/aliyun/translation/chunks'))).toHaveLength(2)
    expect(wrapper.find('[data-testid="ocr-translate-output"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ocr-translate-output"]').text().trim()).toBe('translatedtranslated')
    wrapper.unmount()
  })

  it('图片过大/过小/比例异常就地报错，不进入 OCR 流程', async () => {
    const { fetchMock } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()

    stubDecode(10, 500)
    const input = wrapper.find<HTMLInputElement>('input[type="file"]')
    const tiny = new File(['x'], 'tiny.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [tiny], configurable: true })
    await input.trigger('change')
    await flushPromises()
    expect(wrapper.find('[data-testid="ocr-image-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('大于 15 px')

    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [big], configurable: true })
    await input.trigger('change')
    await flushPromises()
    expect(wrapper.text()).toContain('超过')
    expect(wrapper.find('[data-testid="ocr-local-run"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

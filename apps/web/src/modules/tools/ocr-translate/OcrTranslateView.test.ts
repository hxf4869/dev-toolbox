import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { useAuthStore } from '../../../app/auth'
import OcrTranslateView from './OcrTranslateView.vue'

/**
 * OCR 页面关键合同测试（jsdom + fetch mock；tesseract.js 由 vi.mock 替换）。
 * 覆盖：本地路径零业务请求与零存储、云确认前零调用、确认后完整云链路、
 * 本地识别调用参数（本站资产路径）、低置信度提示、翻译复用（走 useTranslateRun 封装）、
 * 图片候选竞态（慢 A 快 B、旧失败不污染、卸载迟到、等待终止期间候选更替）、
 * 运行期识别失败的就地提示/保留/显式重试与迟到失败不污染，及损坏/缩放失败反馈。
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
const __worker = (tesseractModule as unknown as {
  __worker: { recognize: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
}).__worker

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
        return json({ error: { code: 'UPSTREAM_RESULT_UNCERTAIN', message: '结果不确定', details: {
          failureCategory: 'timeout', callStatus: 'uncertain', countedUnits: 1, remaining: 187,
        } } }, 504)
      }
      if (overrides.chunkCode === 'UPSTREAM_REJECTED') {
        return json({ error: { code: 'UPSTREAM_REJECTED', message: '上游拒绝了本次调用', details: {
          failureCategory: 'permission_denied', callStatus: 'released', countedUnits: null,
          remaining: 188, upstreamRequestId: 'qa-ocr-denied',
        } } }, 502)
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

async function selectLocalImage(wrapper: VueWrapper, fileName = 'shot.png') {
  stubDecode(800, 600)
  const input = wrapper.find<HTMLInputElement>('input[type="file"]')
  const file = new File(['image-bytes'], fileName, { type: 'image/png' })
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

/** 按文件名挂起解码的受控 gate：模拟慢解码、损坏图片与缩放失败的真实异步边界。 */
function makeDecodeGate() {
  type FakeBitmap = { width: number; height: number; close: () => void }
  let resolveBitmap!: (bitmap: FakeBitmap) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<FakeBitmap>((res, rej) => {
    resolveBitmap = res
    reject = rej
  })
  return {
    promise,
    resolve: (width: number, height: number) => resolveBitmap({ width, height, close: vi.fn() }),
    reject,
  }
}

function stubGatedDecode() {
  // 每次解码尝试都是独立 gate；gateFor 取同名最近一次，支持同一文件被反复选择。
  const latest = new Map<string, ReturnType<typeof makeDecodeGate>>()
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => {
    const name = blob instanceof File ? blob.name : 'unknown'
    const gate = makeDecodeGate()
    latest.set(name, gate)
    return gate.promise
  }))
  return {
    gateFor(name: string) {
      const gate = latest.get(name) ?? makeDecodeGate()
      latest.set(name, gate)
      return gate
    },
  }
}

async function chooseFile(wrapper: VueWrapper, file: File) {
  const input = wrapper.get<HTMLInputElement>('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
}

function fileNamed(name: string): File {
  return new File(['image-bytes'], name, { type: 'image/png' })
}

/** jsdom 无 blob URL：以可恢复 spy 固定返回值并统计真实调用次数。 */
function spyObjectUrls() {
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:qa-mock')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  return { create, revoke }
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

  it('更换图片始终能打开选择器，连续换图和重选同一文件会重置旧识别结果且不上传', async () => {
    const { fetchMock, calls } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    const input = wrapper.get<HTMLInputElement>('input[type="file"]')
    const click = vi.spyOn(input.element, 'click').mockImplementation(() => undefined)
    await selectLocalImage(wrapper)
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()

    expect(input.element.isConnected).toBe(true)
    await wrapper.get('.link-button').trigger('click')
    expect(click).toHaveBeenCalledTimes(1)
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="ocr-proof-text"]').element.value)
      .toContain('Graphite Workbench')

    await selectLocalImage(wrapper, 'replacement.png')
    expect(wrapper.get('.image-info__name').text()).toBe('replacement.png')
    expect(wrapper.find('[data-testid="ocr-proof-text"]').exists()).toBe(false)
    expect(input.element.value).toBe('')
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()

    await wrapper.get('.link-button').trigger('click')
    expect(click).toHaveBeenCalledTimes(2)
    await selectLocalImage(wrapper, 'replacement.png')
    expect(wrapper.find('[data-testid="ocr-proof-text"]').exists()).toBe(false)
    expect(calls).toHaveLength(0)
    wrapper.unmount()
  })

  it('取消换图或选择无效文件时，保留原图片和校对文字', async () => {
    const { fetchMock, calls } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await selectLocalImage(wrapper)
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="ocr-proof-text"]').setValue('已校对的文字')
    const input = wrapper.get<HTMLInputElement>('input[type="file"]')
    await input.trigger('cancel')
    expect(wrapper.get('.image-info__name').text()).toBe('shot.png')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="ocr-proof-text"]').element.value).toBe('已校对的文字')

    Object.defineProperty(input.element, 'files', {
      value: [new File(['not an image'], 'invalid.txt', { type: 'text/plain' })],
      configurable: true,
    })
    await input.trigger('change')
    await flushPromises()
    expect(wrapper.get('[data-testid="ocr-image-error"]').attributes('role')).toBe('alert')
    expect(wrapper.get('.image-info__name').text()).toBe('shot.png')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="ocr-proof-text"]').element.value).toBe('已校对的文字')
    expect(calls).toHaveLength(0)
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
    expect(wrapper.get('[aria-label="本地保护账本剩余"]').text()).toContain('187')
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

  it('云 OCR 权限拒绝显示设置入口和结算状态，换图清除错误且不自动重试', async () => {
    const { fetchMock, calls } = makeFetchMock({ chunkCode: 'UPSTREAM_REJECTED' })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await selectLocalImage(wrapper)
    await wrapper.get('[data-testid="ocr-cloud-open"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="ocr-cloud-confirm"]').trigger('click')
    await flushPromises()

    const errorPanel = wrapper.get('[data-testid="ocr-cloud-error"]')
    expect(errorPanel.text()).toContain('RAM 权限不足')
    expect(errorPanel.text()).toContain('本次未扣减本地保护额度')
    expect(errorPanel.text()).toContain('qa-ocr-denied')
    expect(errorPanel.get('a').attributes('href')).toBe('/settings/aliyun')
    expect(wrapper.find('[data-testid="ocr-cloud-retry"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="本地保护账本剩余"]').text()).toContain('188')

    await selectLocalImage(wrapper, 'replacement.png')
    expect(wrapper.find('[data-testid="ocr-cloud-error"]').exists()).toBe(false)
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

  it('慢 A 快 B：先到的 B 应用后，迟到的 A 不再覆盖预览、不再创建对象 URL', async () => {
    const { fetchMock } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const urls = spyObjectUrls()
    const decode = stubGatedDecode()
    const wrapper = await mountOcr()

    await chooseFile(wrapper, fileNamed('slow-a.png'))
    await chooseFile(wrapper, fileNamed('fast-b.png'))
    decode.gateFor('fast-b.png').resolve(800, 600)
    await flushPromises()
    expect(wrapper.get('.image-info__name').text()).toBe('fast-b.png')
    expect(urls.create).toHaveBeenCalledTimes(1)

    decode.gateFor('slow-a.png').resolve(1200, 900)
    await flushPromises()
    expect(wrapper.get('.image-info__name').text()).toBe('fast-b.png')
    expect(wrapper.text()).toContain('800 × 600 px')
    expect(urls.create).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="ocr-image-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('旧候选 A 的解码失败不污染已应用的 B', async () => {
    const { fetchMock } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    spyObjectUrls()
    const decode = stubGatedDecode()
    const wrapper = await mountOcr()

    await chooseFile(wrapper, fileNamed('slow-a.png'))
    await chooseFile(wrapper, fileNamed('fast-b.png'))
    decode.gateFor('fast-b.png').resolve(800, 600)
    await flushPromises()
    expect(wrapper.get('.image-info__name').text()).toBe('fast-b.png')

    decode.gateFor('slow-a.png').reject(new DOMException('The source image could not be decoded.', 'InvalidStateError'))
    await flushPromises()
    expect(wrapper.find('[data-testid="ocr-image-error"]').exists()).toBe(false)
    expect(wrapper.get('.image-info__name').text()).toBe('fast-b.png')
    expect(wrapper.get('[data-testid="ocr-local-run"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('卸载后迟到的候选不再创建对象 URL', async () => {
    const { fetchMock } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const urls = spyObjectUrls()
    const decode = stubGatedDecode()
    const wrapper = await mountOcr()

    await chooseFile(wrapper, fileNamed('late.png'))
    wrapper.unmount()
    decode.gateFor('late.png').resolve(800, 600)
    await flushPromises()
    expect(urls.create).not.toHaveBeenCalled()
  })

  it('等待 worker 终止期间候选被无效的 B 取代：A 不应用、旧图保留、本地识别解除 busy 且迟到结果不回填', async () => {
    const { fetchMock } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const urls = spyObjectUrls()
    const decode = stubGatedDecode()
    const wrapper = await mountOcr()

    await chooseFile(wrapper, fileNamed('shot.png'))
    decode.gateFor('shot.png').resolve(800, 600)
    await flushPromises()
    expect(urls.create).toHaveBeenCalledTimes(1)

    let finishRecognize!: (value: unknown) => void
    __worker.recognize.mockImplementationOnce(() => new Promise((resolve) => { finishRecognize = resolve }))
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="ocr-local-progress"]').exists()).toBe(true)

    // A 合法；应用时需等待 worker 真正终止。
    let finishTerminate!: () => void
    __worker.terminate.mockImplementationOnce(() => new Promise<void>((resolve) => { finishTerminate = resolve }))
    await chooseFile(wrapper, fileNamed('valid-a.png'))
    decode.gateFor('valid-a.png').resolve(1024, 768)
    await flushPromises()
    expect(__worker.terminate).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="ocr-local-progress"]').exists()).toBe(true)

    // 等待期间用户换成损坏的 B：B 的错误立即可见，A 失去候选归属。
    await chooseFile(wrapper, fileNamed('corrupt-b.png'))
    decode.gateFor('corrupt-b.png').reject(new DOMException('The source image could not be decoded.', 'InvalidStateError'))
    await flushPromises()
    expect(wrapper.get('[data-testid="ocr-image-error"]').text()).toContain('无法读取这张图片')
    expect(wrapper.get('.image-info__name').text()).toBe('shot.png')

    finishTerminate()
    await flushPromises()
    expect(wrapper.get('.image-info__name').text()).toBe('shot.png')
    expect(wrapper.find('[data-testid="ocr-local-progress"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ocr-local-cancel"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="ocr-local-run"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('已取消本地识别')
    expect(wrapper.get('[data-testid="ocr-image-error"]').text()).toContain('无法读取这张图片')
    expect(urls.create).toHaveBeenCalledTimes(1)

    finishRecognize({ data: { text: 'LATE RESULT', blocks: [] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="ocr-proof-text"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('本地识别失败就地提示并保留原图与已识别内容；显式重试丢弃死亡 worker 重建并成功', async () => {
    const { fetchMock, calls } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await selectLocalImage(wrapper)
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="ocr-proof-text"]').element.value)
      .toContain('Graphite Workbench')
    const createWorkerMock = (await import('tesseract.js')).createWorker as ReturnType<typeof vi.fn>
    expect(createWorkerMock).toHaveBeenCalledTimes(1)

    // 运行期 worker 死亡：补丁后 SDK 会让在途识别以错误拒绝。
    __worker.recognize.mockImplementationOnce(async () => {
      throw new Error('synthetic worker death')
    })
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()

    const error = wrapper.get('[data-testid="ocr-local-error"]')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toContain('本地识别失败')
    expect(wrapper.get('.image-info__name').text()).toBe('shot.png')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="ocr-proof-text"]').element.value)
      .toContain('Graphite Workbench')
    expect(wrapper.find('[data-testid="ocr-local-progress"]').exists()).toBe(false)
    // 死亡句柄已被丢弃：单例终止收尾，下一次识别必须重建，而不是复用死亡句柄。
    expect(__worker.terminate).toHaveBeenCalledTimes(1)
    expect(createWorkerMock).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()
    expect(createWorkerMock).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="ocr-local-error"]').exists()).toBe(false)
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="ocr-proof-text"]').element.value)
      .toContain('Graphite Workbench')
    expect(calls.filter((call) => !call.path.endsWith('/api/v1/auth/session'))).toHaveLength(0)
    wrapper.unmount()
  })

  it('识别失败迟到：不覆盖取消状态，原图保留', async () => {
    const { fetchMock } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountOcr()
    await selectLocalImage(wrapper)

    let failRecognize!: (error: unknown) => void
    __worker.recognize.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failRecognize = reject }),
    )
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="ocr-local-progress"]').exists()).toBe(true)

    await wrapper.get('[data-testid="ocr-local-cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已取消本地识别')

    failRecognize(new Error('late worker death'))
    await flushPromises()
    expect(wrapper.text()).toContain('已取消本地识别')
    expect(wrapper.find('[data-testid="ocr-local-error"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('本地识别失败')
    expect(wrapper.get('.image-info__name').text()).toBe('shot.png')
    expect(wrapper.get('[data-testid="ocr-local-run"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('识别失败迟到：不污染换图后的新归属状态', async () => {
    const { fetchMock } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    spyObjectUrls()
    const decode = stubGatedDecode()
    const wrapper = await mountOcr()

    await chooseFile(wrapper, fileNamed('shot.png'))
    decode.gateFor('shot.png').resolve(800, 600)
    await flushPromises()

    // A 的识别停在真实 SDK 的 loadImage 之前：在途且不可完成。
    let failRecognize!: (error: unknown) => void
    __worker.recognize.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failRecognize = reject }),
    )
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()

    // 换图终止 A 的 worker，replacement.png 应用。
    await chooseFile(wrapper, fileNamed('replacement.png'))
    decode.gateFor('replacement.png').resolve(1024, 768)
    await flushPromises()
    expect(wrapper.get('.image-info__name').text()).toBe('replacement.png')

    // 新归属 B 立即启动识别，停在受控 gate 在途。
    let finishRecognize!: (value: unknown) => void
    __worker.recognize.mockImplementationOnce(
      () => new Promise((resolve) => { finishRecognize = resolve }),
    )
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="ocr-local-progress"]').exists()).toBe(true)
    const terminatesBeforeLateFailure = __worker.terminate.mock.calls.length

    // A 的迟到失败：不得终止 B 正在使用的 worker，也不得抢写状态。
    failRecognize(new Error('late worker death'))
    await flushPromises()
    expect(__worker.terminate.mock.calls.length).toBe(terminatesBeforeLateFailure)
    expect(wrapper.find('[data-testid="ocr-local-progress"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ocr-local-error"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('本地识别失败')

    // B 正常完成：新校对文字成功显示。
    finishRecognize({ data: { text: 'B 的识别文本', blocks: [] } })
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="ocr-proof-text"]').element.value)
      .toBe('B 的识别文本')
    expect(wrapper.find('[data-testid="ocr-local-progress"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('损坏图片或缩放失败就地提示并保留原图与校对文字，同一文件可再次选择', async () => {
    const { fetchMock, calls } = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const urls = spyObjectUrls()
    const decode = stubGatedDecode()
    const wrapper = await mountOcr()
    const input = wrapper.get<HTMLInputElement>('input[type="file"]')

    await chooseFile(wrapper, fileNamed('shot.png'))
    decode.gateFor('shot.png').resolve(800, 600)
    await flushPromises()
    await wrapper.get('[data-testid="ocr-local-run"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="ocr-proof-text"]').setValue('已校对的文字')
    expect(urls.create).toHaveBeenCalledTimes(1)

    const corrupt = fileNamed('corrupt.png')
    await chooseFile(wrapper, corrupt)
    expect(input.element.value).toBe('')
    decode.gateFor('corrupt.png').reject(new DOMException('The source image could not be decoded.', 'InvalidStateError'))
    await flushPromises()
    const error = wrapper.get('[data-testid="ocr-image-error"]')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toContain('无法读取这张图片')
    expect(error.text()).toContain('请更换图片后重试')
    expect(wrapper.get('.image-info__name').text()).toBe('shot.png')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="ocr-proof-text"]').element.value).toBe('已校对的文字')

    // 超过 4096 px 需要本地缩放；canvas 不可用时缩放抛错，同样就地提示。
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await chooseFile(wrapper, fileNamed('huge.png'))
    decode.gateFor('huge.png').resolve(5000, 4000)
    await flushPromises()
    expect(getContext).toHaveBeenCalled()
    expect(wrapper.get('[data-testid="ocr-image-error"]').text()).toContain('无法读取这张图片')
    expect(wrapper.get('.image-info__name').text()).toBe('shot.png')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="ocr-proof-text"]').element.value).toBe('已校对的文字')
    expect(urls.create).toHaveBeenCalledTimes(1)

    // 同一个 File 对象再次选择：input 已清空，change 再次触发并正常应用。
    await chooseFile(wrapper, corrupt)
    decode.gateFor('corrupt.png').resolve(640, 480)
    await flushPromises()
    expect(wrapper.find('[data-testid="ocr-image-error"]').exists()).toBe(false)
    expect(wrapper.get('.image-info__name').text()).toBe('corrupt.png')
    expect(wrapper.find('[data-testid="ocr-proof-text"]').exists()).toBe(false)
    expect(urls.create).toHaveBeenCalledTimes(2)
    expect(calls.filter((call) => !call.path.endsWith('/api/v1/auth/session'))).toHaveLength(0)
    wrapper.unmount()
  })
})

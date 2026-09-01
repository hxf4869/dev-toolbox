import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../../app/auth'
import TranslateView from './TranslateView.vue'

interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: any
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>

const LANGUAGES = {
  version: 'aliyun-language-list-2026-08-31',
  generalLanguages: [
    { code: 'zh', nameZh: '中文', nameEn: 'Chinese' },
    { code: 'en', nameZh: '英语', nameEn: 'English' },
    { code: 'ja', nameZh: '日语', nameEn: 'Japanese' },
  ],
  professionalPairsByScene: {
    finance: [['zh', 'en'], ['en', 'zh']],
  },
}

const USAGE = {
  month: '2026-08',
  timezone: 'Asia/Shanghai',
  meters: [
    { meter: 'mt_general', limit: 950_000, used: 1200, reserved: 0, remaining: 948_800 },
    { meter: 'mt_professional', limit: 950_000, used: 0, reserved: 0, remaining: 950_000 },
    { meter: 'ocr_general', limit: 190, used: 2, reserved: 0, remaining: 188 },
  ],
  source: 'dev_toolbox_local_ledger',
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function errorResponse(code: string, status: number, details: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: { code, message: `${code} message`, details, requestId: 'req-view' } }, status)
}

/** 常规成功链路的默认服务器：languages/usage GET、ready ticket、claim、回显占位符的 chunk。 */
function defaultHandler(overrides: {
  preflight?: Handler
  chunk?: Handler
  ticket?: Handler
} = {}): Handler {
  return (request) => {
    if (request.method === 'GET' && request.path === '/api/v1/aliyun/translation/languages') {
      return jsonResponse(LANGUAGES)
    }
    if (request.method === 'GET' && request.path === '/api/v1/aliyun/usage/current') {
      return jsonResponse(USAGE)
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/preflight') {
      return overrides.preflight ? overrides.preflight(request) : jsonResponse({
        operation: 'translation',
        month: '2026-08',
        resetAt: '2026-09-01T00:00:00+08:00',
        source: 'dev_toolbox_local_ledger',
        professionalScene: null,
        items: request.body.chunkUnits.map((units: number, index: number) => ({
          index, units, engine: 'general', meter: 'mt_general', scene: 'general',
        })),
        totals: [{
          meter: 'mt_general',
          chunks: request.body.chunkUnits.length,
          units: request.body.chunkUnits.reduce((sum: number, value: number) => sum + value, 0),
          limit: 950_000, used: 1200, reserved: 0, remainingBefore: 948_800, remainingAfterPlan: 948_800,
        }],
      })
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
      return overrides.ticket
        ? overrides.ticket(request)
        : jsonResponse({ ticketId: 't-view', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-view/claim') {
      return jsonResponse({ ticketId: 't-view', status: 'active', permitToken: 'permit-view', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
    }
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    if (request.method === 'GET' && request.path === '/api/v1/aliyun/queue-tickets/t-view') {
      return jsonResponse({ ticketId: 't-view', operation: 'translation', status: 'ready', claimBy: 'x' })
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
      return overrides.chunk
        ? overrides.chunk(request)
        : jsonResponse({
          translatedText: request.body.sourceText,
          detectedLanguage: 'zh',
          engine: 'general',
          scene: 'general',
          billableUnits: request.body.sourceText.length,
          upstreamRequestId: 'up-view',
          quota: { meter: 'mt_general', remaining: 948_800 },
          replayed: false,
        })
    }
    throw new Error(`unexpected request: ${request.method} ${request.path}`)
  }
}

let activeRequests: RecordedRequest[] = []
let activeRouter: Router | null = null

async function mountView(handler: Handler): Promise<VueWrapper> {
  activeRequests = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    activeRequests.push(request)
    return handler(request)
  }))
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-translate-view'
  activeRouter = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tools', component: { template: '<div />' } },
      { path: '/tools/translate', component: { template: '<div />' } },
      { path: '/settings/aliyun', component: { template: '<div />' } },
    ],
  })
  await activeRouter.push('/tools/translate')
  await activeRouter.isReady()
  const wrapper = mount(TranslateView, {
    attachTo: document.body,
    global: { plugins: [pinia, activeRouter] },
  })
  await flushPromises()
  return wrapper
}

async function chooseLanguage(wrapper: VueWrapper, selectId: string, keyword: string): Promise<void> {
  const input = wrapper.get(`#${selectId}`)
  await input.setValue(keyword)
  await flushPromises()
  const container = input.element.closest('.language-select')
  const option = wrapper.findAll('[role="option"]').find((entry) =>
    container?.contains(entry.element) === true && entry.text().includes(keyword))
  if (!option) throw new Error(`option not found: ${keyword}`)
  await option.trigger('click')
  await flushPromises()
  // 用原生 blur 移开焦点（合成事件不改变 activeElement），等待延迟收起后显示已选语言。
  ;(input.element as HTMLInputElement).blur()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await flushPromises()
}

/** 输入文本并等待 250ms 防抖的本地统计完成。 */
async function setInput(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.get('#translate-input').setValue(text)
  await new Promise((resolve) => setTimeout(resolve, 300))
  await flushPromises()
}

const chunkPosts = () => activeRequests.filter((request) => request.path === '/api/v1/aliyun/translation/chunks')
const posts = () => activeRequests.filter((request) => request.method === 'POST')

describe('TranslateView 文本翻译工作台', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('默认译为中文；点击翻译后直接预检、排队、claim 并发送片段', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const wrapper = await mountView(defaultHandler())
    expect((wrapper.get('#translate-target-language').element as HTMLInputElement).value).toBe('中文')
    const source = '查看 https://example.com/docs 的说明，然后运行 `npm run build`。'
    await setInput(wrapper, source)
    await chooseLanguage(wrapper, 'translate-target-language', '英语')

    expect(wrapper.text()).toContain('1 个请求')
    expect(wrapper.text()).toContain('仅自然语言片段发送至阿里云')
    // 主操作前：只有清单/额度 GET，零 POST。
    expect(posts()).toHaveLength(0)
    expect(activeRequests.every((request) => request.method === 'GET')).toBe(true)

    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()
    const preflight = posts().find((request) => request.path === '/api/v1/aliyun/preflight')
    expect(preflight?.body).toMatchObject({ operation: 'translation', sourceLanguage: 'auto', targetLanguage: 'en' })
    expect(Array.isArray(preflight?.body.chunkUnits)).toBe(true)
    expect(wrapper.find('.confirmation-dialog').exists()).toBe(false)
    const paths = posts().map((request) => `${request.method} ${request.path}`)
    expect(paths).toContain('POST /api/v1/aliyun/queue-tickets')
    expect(paths).toContain('POST /api/v1/aliyun/queue-tickets/t-view/claim')
    expect(chunkPosts()).toHaveLength(1)
    const chunkPost = chunkPosts()[0]!
    expect(chunkPost.headers['X-Cloud-Permit']).toBe('permit-view')
    expect(chunkPost.headers['X-CSRF-Token']).toBe('csrf-translate-view')
    expect(chunkPost.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(chunkPost.body.sourceText).toContain('__DT_')
    expect(chunkPost.body.expectedEngine).toBe('general')
    expect(activeRequests.some((request) =>
      request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-view')).toBe(true)

    expect(wrapper.get('[data-testid="translate-output"]').text()).toContain('https://example.com/docs')
    expect(wrapper.get('[data-testid="translate-output"]').text()).toContain('`npm run build`')
    expect(wrapper.text()).toContain('检测语言：中文')
    expect(wrapper.text()).toContain('实际引擎：通用版')
    expect(wrapper.text()).toContain('已完成 1 / 1 段')

    // 隐私：不写任何浏览器存储，URL 不含内容。
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
    expect(activeRouter?.currentRoute.value.fullPath).toBe('/tools/translate')
    wrapper.unmount()
  })

  it('多片段译文按原分块直接拼回，不额外插入空行', async () => {
    let chunkIndex = 0
    const wrapper = await mountView(defaultHandler({
      chunk: () => {
        chunkIndex += 1
        return jsonResponse({
          translatedText: chunkIndex === 1 ? '甲' : '乙',
          detectedLanguage: 'zh', engine: 'general', scene: 'general', billableUnits: 1,
          upstreamRequestId: `up-${chunkIndex}`, quota: { meter: 'mt_general', remaining: 1 }, replayed: false,
        })
      },
    }))
    await setInput(wrapper, '原'.repeat(5000))
    await chooseLanguage(wrapper, 'translate-target-language', '英语')
    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()

    expect(chunkPosts()).toHaveLength(2)
    expect(wrapper.get('[data-testid="translate-output"]').text().trim()).toBe('甲乙')
    wrapper.unmount()
  })

  it('「查看发送范围」只展示本地预览，不产生任何 POST', async () => {
    const wrapper = await mountView(defaultHandler())
    await setInput(wrapper, '运行 `docker compose up` 之后检查。')
    await wrapper.get('.link-button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="translate-send-preview"]').text()).toContain('__DT_')
    expect(wrapper.find('[data-testid="translate-confirm-send"]').exists()).toBe(false)
    expect(posts()).toHaveLength(0)
    await wrapper.get('.confirmation-dialog footer button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.confirmation-dialog').exists()).toBe(false)
    wrapper.unmount()
  })

  it('输入变化会作废旧预检，迟到响应不能触发旧文本发送', async () => {
    let preflightCalls = 0
    const pendingFirst: { resolve?: (response: Response) => void } = {}
    const planResponse = (request: RecordedRequest) => jsonResponse({
      operation: 'translation',
      month: '2026-08',
      resetAt: '2026-09-01T00:00:00+08:00',
      source: 'dev_toolbox_local_ledger',
      professionalScene: null,
      items: request.body.chunkUnits.map((units: number, index: number) => ({
        index, units, engine: 'general', meter: 'mt_general', scene: 'general',
      })),
      totals: [{
        meter: 'mt_general', chunks: request.body.chunkUnits.length,
        units: request.body.chunkUnits.reduce((sum: number, value: number) => sum + value, 0),
        limit: 950_000, used: 0, reserved: 0, remainingBefore: 950_000, remainingAfterPlan: 949_000,
      }],
    })
    const wrapper = await mountView(defaultHandler({
      preflight: (request) => {
        preflightCalls += 1
        if (preflightCalls === 1) {
          return new Promise<Response>((resolve) => {
            pendingFirst.resolve = resolve
          })
        }
        return planResponse(request)
      },
    }))
    await setInput(wrapper, '第一版文本')
    await chooseLanguage(wrapper, 'translate-target-language', '英语')
    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.confirmation-dialog').exists()).toBe(false)

    await setInput(wrapper, '第二版文本')
    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="translate-output"]').text()).toContain('第二版文本')
    expect(chunkPosts()).toHaveLength(1)

    pendingFirst.resolve!(planResponse(activeRequests.find((request) =>
      request.method === 'POST' && request.path === '/api/v1/aliyun/preflight')!))
    await flushPromises()
    expect(chunkPosts()).toHaveLength(1)
    expect(wrapper.get('[data-testid="translate-output"]').text()).toContain('第二版文本')
    expect(wrapper.get('[data-testid="translate-output"]').text()).not.toContain('第一版文本')
    wrapper.unmount()
  })

  it('自动检测时交换被拦截并提示；明确语言后交换成功', async () => {
    const wrapper = await mountView(defaultHandler())
    await setInput(wrapper, 'some text')
    await wrapper.get('.swap-button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('请先手动选择明确的源语言')
    expect((wrapper.get('#translate-source-language').element as HTMLInputElement).value).toBe('自动检测')

    // 用英文名与中文名分别搜索，覆盖按中英文名/code 搜索。
    await chooseLanguage(wrapper, 'translate-source-language', 'English')
    await chooseLanguage(wrapper, 'translate-target-language', '中文')
    await wrapper.get('.swap-button').trigger('click')
    await flushPromises()
    expect((wrapper.get('#translate-source-language').element as HTMLInputElement).value).toBe('中文')
    expect((wrapper.get('#translate-target-language').element as HTMLInputElement).value).toBe('英语')
    wrapper.unmount()
  })

  it('QUOTA_EXHAUSTED：硬停止呈现 + 设置入口，无继续付费旁路，输入保留', async () => {
    const wrapper = await mountView(defaultHandler({
      preflight: () => errorResponse('QUOTA_EXHAUSTED', 429, { meter: 'mt_general', remaining: 0 }),
    }))
    const source = '仍然存在的输入内容'
    await setInput(wrapper, source)
    await chooseLanguage(wrapper, 'translate-target-language', '英语')
    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()

    const errorPanel = wrapper.get('[data-testid="translate-preflight-error"]')
    expect(errorPanel.text()).toContain('本月应用保护额度已用尽')
    expect(errorPanel.text()).toContain('没有继续付费的旁路')
    expect(errorPanel.find('a[href="/settings/aliyun"]').exists()).toBe(true)
    expect(posts()).toHaveLength(1) // 只有 preflight，无排队
    expect((wrapper.get('#translate-input').element as HTMLTextAreaElement).value).toBe(source)
    wrapper.unmount()
  })

  it('ALIYUN_NOT_CONFIGURED：显示前往设置且不清空输入', async () => {
    const wrapper = await mountView(defaultHandler({
      preflight: () => errorResponse('ALIYUN_NOT_CONFIGURED', 422),
    }))
    await setInput(wrapper, '待翻译内容')
    await chooseLanguage(wrapper, 'translate-target-language', '英语')
    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()

    const errorPanel = wrapper.get('[data-testid="translate-preflight-error"]')
    expect(errorPanel.text()).toContain('阿里云凭据尚未配置')
    expect(errorPanel.find('a[href="/settings/aliyun"]').exists()).toBe(true)
    expect((wrapper.get('#translate-input').element as HTMLTextAreaElement).value).toBe('待翻译内容')
    wrapper.unmount()
  })

  it('结果不确定：琥珀呈现、说明保守计量与重复计费，可手动继续且换新请求标识', async () => {
    let attempts = 0
    const wrapper = await mountView(defaultHandler({
      chunk: (request) => {
        attempts += 1
        return attempts === 1
          ? errorResponse('UPSTREAM_RESULT_UNCERTAIN', 504, {
            failureCategory: 'timeout', upstreamRequestId: 'up-1', callStatus: 'uncertain',
            meter: 'mt_general', countedUnits: 10, remaining: 950_000,
          })
          : jsonResponse({
            translatedText: request.body.sourceText,
            detectedLanguage: null, engine: 'general', scene: 'general', billableUnits: 1,
            upstreamRequestId: 'up-2', quota: { meter: 'mt_general', remaining: 1 }, replayed: false,
          })
      },
    }))
    await setInput(wrapper, '一段需要翻译的文本。')
    await chooseLanguage(wrapper, 'translate-target-language', '英语')
    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()

    const runErrorPanel = wrapper.get('[data-testid="translate-run-error"]')
    expect(runErrorPanel.text()).toContain('结果不确定')
    expect(runErrorPanel.text()).toContain('保守计量')
    expect(runErrorPanel.text()).toContain('不会自动重试')
    expect(runErrorPanel.text()).toContain('重复计费')
    const firstKey = chunkPosts()[0]!.headers['Idempotency-Key']
    expect(chunkPosts()).toHaveLength(1)

    const continueButton = wrapper.findAll('button').find((entry) => entry.text().includes('从失败片段继续'))
    expect(continueButton).toBeDefined()
    await continueButton!.trigger('click')
    await flushPromises()
    expect(chunkPosts()).toHaveLength(2)
    expect(chunkPosts()[1]!.headers['Idempotency-Key']).not.toBe(firstKey)
    expect(wrapper.text()).toContain('已完成 1 / 1 段')
    wrapper.unmount()
  })

  it('占位符还原失败：片段保留原文并显示客户端状态，云额度已用', async () => {
    const wrapper = await mountView(defaultHandler({
      chunk: () => jsonResponse({
        translatedText: '译文里没有占位符',
        detectedLanguage: 'zh', engine: 'general', scene: 'general', billableUnits: 10,
        upstreamRequestId: null, quota: { meter: 'mt_general', remaining: 1 }, replayed: false,
      }),
    }))
    const source = '先 `npm run build` 再继续'
    await setInput(wrapper, source)
    await chooseLanguage(wrapper, 'translate-target-language', '英语')
    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('占位符还原失败，保留原文')
    expect(wrapper.text()).not.toContain('PLACEHOLDER_RESTORE_FAILED')
    expect(wrapper.text()).toContain('云额度已经使用')
    expect(wrapper.get('[data-testid="translate-output"]').text()).toContain('`npm run build`')
    wrapper.unmount()
  })

  it('排队中显示位置与到期并可取消：取消只 DELETE ticket', async () => {
    const wrapper = await mountView(defaultHandler({
      ticket: () => jsonResponse({
        ticketId: 't-view', operation: 'translation', status: 'waiting',
        position: 4, expiresAt: '2026-08-31T10:02:00Z',
      }, 201),
    }))
    await setInput(wrapper, '排队测试文本。')
    await chooseLanguage(wrapper, 'translate-target-language', '英语')
    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()

    const queue = wrapper.get('[data-testid="translate-queue"]')
    expect(queue.text()).toContain('当前队列位置')
    expect(queue.text()).toContain('4')
    expect(wrapper.text()).not.toContain('%')

    await wrapper.get('[data-testid="translate-cancel"]').trigger('click')
    await flushPromises()
    expect(activeRequests.some((request) => request.method === 'DELETE' && request.path === '/api/v1/aliyun/queue-tickets/t-view')).toBe(true)
    expect(chunkPosts()).toHaveLength(0)
    expect(wrapper.text()).toContain('已取消')
    expect(wrapper.text()).toContain('未发送 1 段')
    wrapper.unmount()
  })
})

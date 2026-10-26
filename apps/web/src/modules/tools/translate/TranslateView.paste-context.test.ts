import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../../app/auth'
import TranslateView from './TranslateView.vue'

interface RecordedRequest {
  method: string
  path: string
  body: any
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

const PASTE_DENIED = '浏览器未允许读取剪贴板，请使用系统粘贴快捷键。'
const PASTE_BUTTON = '[aria-label="粘贴剪贴板文本到原文"]'
const CLEAR_BUTTON = '[aria-label="清空原文"]'

const LANGUAGES = {
  version: 'aliyun-language-list-2026-08-31',
  generalLanguages: [
    { code: 'zh', nameZh: '中文', nameEn: 'Chinese' },
    { code: 'en', nameZh: '英语', nameEn: 'English' },
  ],
  professionalPairsByScene: {},
}

const USAGE = {
  month: '2026-08',
  timezone: 'Asia/Shanghai',
  meters: [
    { meter: 'mt_general', limit: 950_000, used: 1200, reserved: 0, remaining: 948_800 },
  ],
  source: 'dev_toolbox_local_ledger',
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function planResponse(request: RecordedRequest): Response {
  return jsonResponse({
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

function chunkResponse(request: RecordedRequest): Response {
  return jsonResponse({
    translatedText: request.body.sourceText,
    detectedLanguage: 'zh',
    engine: 'general',
    scene: 'general',
    billableUnits: request.body.sourceText.length,
    upstreamRequestId: 'up-paste',
    quota: { meter: 'mt_general', remaining: 948_800 },
    replayed: false,
  })
}

/** 纯 mock HTTP：清单/额度 GET，预检、ready ticket、claim、回显 chunk；预检与 chunk 可被用例挂起。 */
function apiHandler(overrides: { preflight?: Handler; chunk?: Handler } = {}): Handler {
  return (request) => {
    if (request.method === 'GET' && request.path === '/api/v1/aliyun/translation/languages') {
      return jsonResponse(LANGUAGES)
    }
    if (request.method === 'GET' && request.path === '/api/v1/aliyun/usage/current') {
      return jsonResponse(USAGE)
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/preflight') {
      return overrides.preflight ? overrides.preflight(request) : planResponse(request)
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets') {
      return jsonResponse({ ticketId: 't-paste', operation: 'translation', status: 'ready', claimBy: 'x' }, 201)
    }
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/queue-tickets/t-paste/claim') {
      return jsonResponse({ ticketId: 't-paste', status: 'active', permitToken: 'permit-paste', idleExpiresAt: 'x', absoluteExpiresAt: 'y' })
    }
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    if (request.method === 'POST' && request.path === '/api/v1/aliyun/translation/chunks') {
      return overrides.chunk ? overrides.chunk(request) : chunkResponse(request)
    }
    throw new Error(`unexpected request: ${request.method} ${request.path}`)
  }
}

let activeRequests: RecordedRequest[] = []
let clipboardReads: Deferred<string>[] = []

/** 每次点击粘贴都得到一个独立的挂起读取，由用例决定 resolve/reject 的顺序。 */
function installClipboard(): void {
  clipboardReads = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: () => {
        const read = deferred<string>()
        clipboardReads.push(read)
        return read.promise
      },
    },
  })
}

async function mountView(handler: Handler): Promise<VueWrapper> {
  activeRequests = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    activeRequests.push(request)
    return handler(request)
  }))
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-paste-context'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tools', component: { template: '<div />' } },
      { path: '/tools/translate', component: { template: '<div />' } },
      { path: '/settings/aliyun', component: { template: '<div />' } },
    ],
  })
  await router.push('/tools/translate')
  await router.isReady()
  const wrapper = mount(TranslateView, {
    attachTo: document.body,
    global: { plugins: [pinia, router] },
  })
  await flushPromises()
  return wrapper
}

/** 输入文本并等待 250ms 防抖的本地统计完成。 */
async function setInput(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.get('#translate-input').setValue(text)
  await new Promise((resolve) => setTimeout(resolve, 300))
  await flushPromises()
}

async function clickPaste(wrapper: VueWrapper): Promise<void> {
  await wrapper.get(PASTE_BUTTON).trigger('click')
  await flushPromises()
}

async function clickClear(wrapper: VueWrapper): Promise<void> {
  await wrapper.get(CLEAR_BUTTON).trigger('click')
  await flushPromises()
}

const inputValue = (wrapper: VueWrapper): string =>
  (wrapper.get('#translate-input').element as HTMLTextAreaElement).value

const posts = () => activeRequests.filter((request) => request.method === 'POST')
const chunkPosts = () => activeRequests.filter((request) => request.path === '/api/v1/aliyun/translation/chunks')
const preflightPosts = () => activeRequests.filter((request) => request.path === '/api/v1/aliyun/preflight')

describe('TranslateView 粘贴读取与输入上下文', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    installClipboard()
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('正常粘贴：读取成功后写入原文并进入本地统计', async () => {
    const wrapper = await mountView(apiHandler())
    await clickPaste(wrapper)
    expect(clipboardReads).toHaveLength(1)
    expect(inputValue(wrapper)).toBe('')

    clipboardReads[0]!.resolve('来自剪贴板的原文')
    await flushPromises()
    expect(inputValue(wrapper)).toBe('来自剪贴板的原文')
    expect(wrapper.text()).not.toContain(PASTE_DENIED)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await flushPromises()
    expect(wrapper.text()).toContain('1 个请求')
    expect(posts()).toHaveLength(0)
    wrapper.unmount()
  })

  it('读取失败提示使用系统粘贴；重试成功后写入原文并清掉旧读取错误', async () => {
    const wrapper = await mountView(apiHandler())
    await clickPaste(wrapper)
    clipboardReads[0]!.reject(new DOMException('denied', 'NotAllowedError'))
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe(PASTE_DENIED)
    expect(inputValue(wrapper)).toBe('')

    await clickPaste(wrapper)
    expect(clipboardReads).toHaveLength(2)
    clipboardReads[1]!.resolve('第二次读取成功')
    await flushPromises()
    expect(inputValue(wrapper)).toBe('第二次读取成功')
    expect(wrapper.text()).not.toContain(PASTE_DENIED)
    wrapper.unmount()
  })

  it('迟到的读取成功不覆盖期间手动输入的原文', async () => {
    const wrapper = await mountView(apiHandler())
    await clickPaste(wrapper)
    await wrapper.get('#translate-input').setValue('手动输入的内容')
    await flushPromises()
    expect(inputValue(wrapper)).toBe('手动输入的内容')

    clipboardReads[0]!.resolve('迟到的剪贴板内容')
    await flushPromises()
    expect(inputValue(wrapper)).toBe('手动输入的内容')
    expect(wrapper.text()).not.toContain(PASTE_DENIED)
    wrapper.unmount()
  })

  it('清空原文后迟到的读取失败不再重现提示', async () => {
    const wrapper = await mountView(apiHandler())
    await setInput(wrapper, '原有文本')
    await clickPaste(wrapper)
    await clickClear(wrapper)
    expect(inputValue(wrapper)).toBe('')

    clipboardReads[0]!.reject(new DOMException('denied', 'NotAllowedError'))
    await flushPromises()
    expect(wrapper.text()).not.toContain(PASTE_DENIED)
    expect(inputValue(wrapper)).toBe('')
    wrapper.unmount()
  })

  it('原文已空时清空仍会作废等待中的读取', async () => {
    const wrapper = await mountView(apiHandler())
    expect(inputValue(wrapper)).toBe('')
    await clickPaste(wrapper)
    await clickClear(wrapper)

    clipboardReads[0]!.resolve('迟到的剪贴板内容')
    await flushPromises()
    expect(inputValue(wrapper)).toBe('')
    wrapper.unmount()
  })

  it('连续两次粘贴时以较新的读取结果为准', async () => {
    const wrapper = await mountView(apiHandler())
    await clickPaste(wrapper)
    await clickPaste(wrapper)
    expect(clipboardReads).toHaveLength(2)

    clipboardReads[1]!.resolve('第二次读取')
    await flushPromises()
    expect(inputValue(wrapper)).toBe('第二次读取')

    clipboardReads[0]!.resolve('第一次读取')
    await flushPromises()
    expect(inputValue(wrapper)).toBe('第二次读取')
    wrapper.unmount()
  })

  it('预检进行中迟到的读取不改写原文、不打断当前预检，也不产生新请求', async () => {
    const preflightGate = deferred<Response>()
    const wrapper = await mountView(apiHandler({
      preflight: (request) => {
        if (preflightPosts().length === 1) return preflightGate.promise
        return planResponse(request)
      },
    }))
    const source = '需要翻译的原文'
    await setInput(wrapper, source)
    await clickPaste(wrapper)
    expect(clipboardReads).toHaveLength(1)

    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()
    expect(preflightPosts()).toHaveLength(1)
    expect(wrapper.get('[data-testid="translate-primary"]').text()).toBe('准备翻译…')
    const postsBefore = posts().length

    clipboardReads[0]!.resolve('迟到的剪贴板内容')
    await flushPromises()
    expect(inputValue(wrapper)).toBe(source)
    expect(wrapper.get('[data-testid="translate-primary"]').text()).toBe('准备翻译…')
    expect(posts()).toHaveLength(postsBefore)

    preflightGate.resolve(planResponse(preflightPosts()[0]!))
    await flushPromises()
    expect(preflightPosts()).toHaveLength(1)
    expect(chunkPosts()).toHaveLength(1)
    expect(wrapper.get('[data-testid="translate-output"]').text()).toContain(source)
    expect(wrapper.text()).toContain('已完成 1 / 1 段')
    expect(inputValue(wrapper)).toBe(source)
    wrapper.unmount()
  })

  it('运行中字段锁定，迟到的读取不改写原文；完成后原文仍是发送时的快照', async () => {
    const chunkGate = deferred<Response>()
    const wrapper = await mountView(apiHandler({
      chunk: () => chunkGate.promise,
    }))
    const source = '运行期间保持不变的原文'
    await setInput(wrapper, source)
    await clickPaste(wrapper)
    expect(clipboardReads).toHaveLength(1)

    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()
    expect(chunkPosts()).toHaveLength(1)
    expect((wrapper.get('#translate-input').element as HTMLTextAreaElement).disabled).toBe(true)
    expect((wrapper.get(PASTE_BUTTON).element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.get(CLEAR_BUTTON).element as HTMLButtonElement).disabled).toBe(true)

    clipboardReads[0]!.resolve('迟到的剪贴板内容')
    await flushPromises()
    expect(inputValue(wrapper)).toBe(source)
    expect(wrapper.text()).not.toContain(PASTE_DENIED)

    chunkGate.resolve(chunkResponse(chunkPosts()[0]!))
    await flushPromises()
    expect(wrapper.get('[data-testid="translate-output"]').text()).toContain(source)
    expect(wrapper.text()).toContain('已完成 1 / 1 段')
    expect(inputValue(wrapper)).toBe(source)
    expect(chunkPosts()).toHaveLength(1)
    wrapper.unmount()
  })

  it('预检失败回到可编辑后，迟到的读取仍不得改写原文或提示错误', async () => {
    const wrapper = await mountView(apiHandler({
      preflight: () => jsonResponse({
        error: { code: 'QUOTA_EXHAUSTED', message: 'quota', details: { meter: 'mt_general', remaining: 0 }, requestId: 'r-paste' },
      }, 429),
    }))
    const source = '预检失败后保留的原文'
    await setInput(wrapper, source)
    await clickPaste(wrapper)
    expect(clipboardReads).toHaveLength(1)

    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="translate-preflight-error"]').exists()).toBe(true)
    expect((wrapper.get('#translate-input').element as HTMLTextAreaElement).disabled).toBe(false)
    expect((wrapper.get(PASTE_BUTTON).element as HTMLButtonElement).disabled).toBe(false)

    clipboardReads[0]!.resolve('迟到的剪贴板内容')
    await flushPromises()
    expect(inputValue(wrapper)).toBe(source)
    expect(wrapper.text()).not.toContain(PASTE_DENIED)
    wrapper.unmount()
  })

  it('预检进行中新点粘贴生效并作废旧预检，晚到的旧预检不再排队或发送', async () => {
    const preflightGate = deferred<Response>()
    let preflightCalls = 0
    const wrapper = await mountView(apiHandler({
      preflight: (request) => {
        preflightCalls += 1
        return preflightCalls === 1 ? preflightGate.promise : planResponse(request)
      },
    }))
    await setInput(wrapper, '旧原文')
    await wrapper.get('[data-testid="translate-primary"]').trigger('click')
    await flushPromises()
    expect(preflightCalls).toBe(1)
    expect(wrapper.get('[data-testid="translate-primary"]').text()).toBe('准备翻译…')
    // 预检进行中原文与粘贴按钮仍可编辑（原行为：新编辑作废旧预检）。
    expect((wrapper.get('#translate-input').element as HTMLTextAreaElement).disabled).toBe(false)
    expect((wrapper.get(PASTE_BUTTON).element as HTMLButtonElement).disabled).toBe(false)

    await clickPaste(wrapper)
    expect(clipboardReads).toHaveLength(1)
    clipboardReads[0]!.resolve('预检期间粘贴的新原文')
    await flushPromises()
    expect(inputValue(wrapper)).toBe('预检期间粘贴的新原文')
    const postsAfterPaste = posts().length

    preflightGate.resolve(planResponse(preflightPosts()[0]!))
    await flushPromises()
    expect(preflightCalls).toBe(1)
    expect(posts()).toHaveLength(postsAfterPaste)
    expect(chunkPosts()).toHaveLength(0)
    expect(inputValue(wrapper)).toBe('预检期间粘贴的新原文')
    expect(wrapper.find('[data-testid="translate-preflight-error"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

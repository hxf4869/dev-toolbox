// DT-R67 baseline 合同测试：ItemDetailView「按需读取原始记录」成功后的键盘焦点归属。
// ① normal 条目无搜索命中（fragments 空、无 query.hit）：读取成功后旧「查看原始记录」按钮被 v-if 卸载，
//    合同落点是新渲染的 .raw-content。R67 baseline（修复前）生产代码无命中分支没有任何 focus 兜底，
//    焦点落 BODY（实机已证明），本断言曾红。
// ② raw GET 挂起期间组件外（Workspace 搜索框）的有效焦点与草稿不被抢走、正文正常渲染；
// ③ 带合法 route.query.hit 时 .matched-fragment anchor 获焦并 scrollIntoView({ block: 'center' })——②③均为既有 guard。
// 装置沿用 raw-race 的受控 deferred raw GET gate 与 supplement-refresh / dialog-a11y 的 attachTo body
// 真实焦点取证（buttonByExactText 先 focus 再 click）；③ 的 scrollIntoView 是 jsdom 缺失 API 的环境 stub，非产品行为。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import ItemDetailView from './ItemDetailView.vue'

const RAW_A = 'raw-a'
const RAW_RECORD_PATH = `/api/v1/items/item-1/raw-records/${RAW_A}`

// 含中文与标点的多字符明文（约 50 字），供正文逐字核对与 ③ 的字节区间计算。
const RAW_BODY =
  '十月清晨的玻璃窗上凝着一层薄雾，指尖划过留下三道细痕；楼下早点铺的蒸汽混着雨后泥土味，把整条巷子叫醒了。'

interface RawPending {
  id: string
  resolve: () => void
  reject: (error: unknown) => void
}

interface RawFragment {
  id: string
  sourceKind: 'raw_text'
  ordinal: number
  startByte: number
  endByte: number
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function rawSummary(fragments: RawFragment[]) {
  return {
    id: RAW_A,
    recordRole: 'primary',
    sourceType: 'web_quick_capture',
    contentKind: 'text',
    contentFormat: 'plain_text',
    declaredSensitivity: 'normal',
    capturedAt: '2026-09-01T08:00:00Z',
    effectiveCapturedAt: '2026-09-01T08:00:00Z',
    sourceTimeQuality: 'trusted',
    createdAt: '2026-09-01T08:00:00Z',
    attachments: [],
    relations: [],
    fragments,
  }
}

function itemDetail(fragments: RawFragment[]) {
  return {
    id: 'item-1',
    title: '按需读取焦点验证条目',
    titleOrigin: 'user',
    note: null,
    folder: null,
    tags: [],
    sensitivity: 'normal',
    favorite: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    rawRecords: [rawSummary(fragments)],
    attachments: [],
    artifacts: [],
    availableVersions: [],
  }
}

function rawRecordDto(fragments: RawFragment[]) {
  return {
    ...rawSummary(fragments),
    itemId: 'item-1',
    readOnly: true,
    body: RAW_BODY,
    source: { sourceType: 'web_quick_capture', metadata: {} },
  }
}

// 受控 raw GET gate（沿用 raw-race 写法）：raw-records GET 返回 deferred Promise 存入 pending，
// 由用例决定 resolve 时机；详情 GET 即时返回。每次响应都经工厂重新构造，不共享 fixture 引用。
function installFetchMock(options: { detail: () => unknown; rawRecord: () => unknown }) {
  const rawCalls: string[] = []
  const pending: RawPending[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string) => {
      const url = String(path)
      if (url === RAW_RECORD_PATH) {
        rawCalls.push(url)
        return new Promise<Response>((resolve, reject) => {
          pending.push({
            id: RAW_A,
            resolve: () => resolve(jsonResponse(options.rawRecord())),
            reject,
          })
        })
      }
      return Promise.resolve(jsonResponse(options.detail()))
    }),
  )
  return { rawCalls, pending }
}

// 触发按钮与弹窗内按钮必须精确匹配文本，避免 includes 歧义（沿用 dialog-a11y 写法）。
function buttonByExactText(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll('button')].find(
    (entry) => (entry.textContent ?? '').trim() === text,
  )
  expect(button, `button with exact text "${text}"`).toBeTruthy()
  return button as HTMLButtonElement
}

let activeWrapper: ReturnType<typeof mount> | null = null

// 真实 vue-router（memory history）+ 真实 Pinia；query 由挂载前的 router.push 提供（③ 的 query.hit）。
async function mountDetail(query?: Record<string, string>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: { template: '<div />' } },
      { path: '/items/:itemId', name: 'item-detail', component: ItemDetailView },
    ],
  })
  await router.push(query ? { path: '/', query } : '/')
  activeWrapper = mount(ItemDetailView, {
    props: { itemId: 'item-1' },
    attachTo: document.body,
    global: { plugins: [router] },
  })
  await flushPromises()
  return activeWrapper
}

describe('ItemDetailView on-demand raw reveal keyboard focus', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = null
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('① 无搜索命中的 normal 条目：读取成功后焦点应落在新渲染的 .raw-content，而非 BODY', async () => {
    const mock = installFetchMock({ detail: () => itemDetail([]), rawRecord: () => rawRecordDto([]) })
    await mountDetail()

    const trigger = buttonByExactText('查看原始记录')
    trigger.focus()
    expect(document.activeElement, '点击前焦点在「查看原始记录」触发按钮上').toBe(trigger)

    trigger.click()
    await flushPromises()
    expect(mock.rawCalls, 'raw GET 已发出').toEqual([RAW_RECORD_PATH])
    expect(mock.pending, 'raw GET 恰好一笔挂起').toHaveLength(1)

    mock.pending[0].resolve()
    await flushPromises()
    await flushPromises()

    // 环境取证：旧触发按钮已被 v-if 卸载，reveal 占位被正文取代。
    expect(trigger.isConnected, '旧「查看原始记录」按钮已断连').toBe(false)
    expect(document.querySelector('.reveal-state'), '.reveal-state 已移除').toBeNull()
    const rawContent = document.querySelector<HTMLElement>('.raw-content')
    expect(rawContent, '.raw-content 已渲染').toBeTruthy()
    expect(rawContent!.textContent, '正文逐字等于 fixture body').toBe(RAW_BODY)

    // 核心合同：读取成功后焦点必须落在新渲染的 .raw-content 上。R67 baseline（修复前）生产代码在
    // 无命中分支不置任何焦点，触发按钮卸载后焦点掉回 BODY，本断言曾红（DT-R67 实机证明的缺口）。
    expect(document.activeElement, '读取成功后焦点应落在 .raw-content').toBe(rawContent)
    expect(document.activeElement, '焦点不得掉回 BODY').not.toBe(document.body)
  })

  it('② raw GET 挂起期间组件外输入框已持有效焦点与草稿：完成后不抢焦、草稿保留、正文正常渲染', async () => {
    const mock = installFetchMock({ detail: () => itemDetail([]), rawRecord: () => rawRecordDto([]) })
    await mountDetail()

    const trigger = buttonByExactText('查看原始记录')
    trigger.focus()
    trigger.click()
    await flushPromises()
    expect(mock.rawCalls, 'raw GET 已发出').toEqual([RAW_RECORD_PATH])
    expect(mock.pending, 'raw GET 挂起中，尚未 resolve').toHaveLength(1)

    // 模拟组件外常驻的 Workspace 搜索框（沿用 supplement-refresh case2 的宿主 input 装置）。
    const host = document.createElement('input')
    document.body.appendChild(host)
    host.focus()
    host.value = '外部搜索草稿'
    host.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.activeElement, '外部输入框持有有效焦点').toBe(host)

    mock.pending[0].resolve()
    await flushPromises()
    await flushPromises()

    // 既有 guard：读取完成只渲染正文，不触碰组件外的有效焦点与草稿。
    expect(document.activeElement, '读取完成后不得抢走外部输入框焦点').toBe(host)
    expect(host.value, '外部草稿保留').toBe('外部搜索草稿')
    const rawContent = document.querySelector<HTMLElement>('.raw-content')
    expect(rawContent, '.raw-content 已渲染').toBeTruthy()
    expect(rawContent!.textContent, '正文逐字等于 fixture body').toBe(RAW_BODY)

    host.remove()
  })

  it('③ 带合法 query.hit 的读取成功后 .matched-fragment anchor 获焦并 scrollIntoView 居中', async () => {
    // jsdom 未实现 Element.prototype.scrollIntoView：先补空实现再 spy（环境 stub，非产品行为），结束恢复原值。
    const scrollHost = Element.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }
    const hadScrollIntoView = typeof scrollHost.scrollIntoView === 'function'
    if (!hadScrollIntoView) scrollHost.scrollIntoView = () => {}
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      // fragment 覆盖 body 前 3 个字符的 UTF-8 字节区间（每字 3 字节，落在字符边界）。
      const prefix = RAW_BODY.slice(0, 3)
      const startByte = 0
      const endByte = new TextEncoder().encode(prefix).length
      expect(endByte, '字节区间非空').toBeGreaterThan(0)
      expect(endByte, '字节区间不超过全文').toBeLessThanOrEqual(new TextEncoder().encode(RAW_BODY).length)

      // summary 与 raw DTO 各自带同一个合法 fragment（每次工厂调用返回全新对象，不共享引用）。
      const makeFragments = (): RawFragment[] => [
        { id: 'frag-1', sourceKind: 'raw_text', ordinal: 0, startByte, endByte },
      ]
      const mock = installFetchMock({
        detail: () => itemDetail(makeFragments()),
        rawRecord: () => rawRecordDto(makeFragments()),
      })
      await mountDetail({ hit: 'frag-1' })

      const trigger = buttonByExactText('查看原始记录')
      trigger.focus()
      expect(document.activeElement, '点击前焦点在「查看原始记录」触发按钮上').toBe(trigger)
      trigger.click()
      await flushPromises()
      expect(mock.pending, 'raw GET 恰好一笔挂起').toHaveLength(1)

      mock.pending[0].resolve()
      await flushPromises()
      await flushPromises()

      // 既有 guard：命中 anchor 渲染、内容为字节区间解码文本，并接收焦点与居中滚动。
      const anchor = document.querySelector<HTMLElement>('.matched-fragment')
      expect(anchor, '.matched-fragment anchor 已渲染').toBeTruthy()
      expect(anchor!.querySelector('pre')?.textContent ?? '', 'anchor 内容为字节区间解码文本').toBe(prefix)
      expect(document.activeElement, 'anchor 获得焦点').toBe(anchor)
      expect(scrollSpy, 'scrollIntoView 以 block:center 调用').toHaveBeenCalledWith({ block: 'center' })
      expect(
        scrollSpy.mock.instances.some((instance) => instance === anchor),
        'scrollIntoView 的调用目标是 anchor 元素',
      ).toBe(true)
    } finally {
      scrollSpy.mockRestore()
      if (!hadScrollIntoView) delete scrollHost.scrollIntoView
    }
  })
})

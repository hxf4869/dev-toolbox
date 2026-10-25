// DT-R197：附件图片预览失败提示与主动重试的合同测试。
// 现网复现：缩略图 500/断网时 img error 后只剩浏览器坏图与文件名，无失败提示也无恢复入口。
// case1：error 后显示「预览加载失败」与「重试预览」；仅一次显式点击重挂 img 触发一次新加载
//        （src 保持原 URL、无缓存破坏参数），不自动轮询；失败可重复进入，重试成功恢复后不保留旧错误；
//        失败不串到同页其它附件。
// case2：静态不支持预览仍用既有文案且无重试入口；敏感未揭示不渲染 img、无重试入口（不得为重试提前请求），
//        确认揭示后按同一门控加载。
// case3：失败态跟随详情生命周期：切换条目后（含同 id 附件）失败态整体清空，不残留旧错误。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import ItemDetailView from './ItemDetailView.vue'

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// AttachmentEntry 公开 shape（library.ts）；thumbnailUrl 缺省为合法预览端点。
function imageAttachment(id: string, overrides?: Record<string, unknown>) {
  return {
    id,
    kind: 'image',
    originalName: `${id}.png`,
    displayName: `截图 ${id}`,
    clientMediaType: 'image/png',
    mediaType: 'image/png',
    sizeBytes: 2048,
    width: 640,
    height: 400,
    previewAllowed: true,
    contentUrl: `/api/v1/attachments/${id}/content`,
    thumbnailUrl: `/api/v1/attachments/${id}/thumbnail`,
    createdAt: '2026-09-01T08:00:00Z',
    ...overrides,
  }
}

function rawSummary() {
  return {
    id: 'raw-a',
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
    fragments: [],
  }
}

function itemDetail(id: string, sensitivity: 'normal' | 'sensitive', attachments: unknown[]) {
  return {
    id,
    title: `条目 ${id}`,
    titleOrigin: 'user',
    note: null,
    folder: null,
    tags: [],
    sensitivity,
    favorite: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    rawRecords: [rawSummary()],
    attachments,
    artifacts: [],
    availableVersions: [],
  }
}

// 受控 fetch mock：按条目 id 返回可变 detail（切换条目时各自 shape 稳定）；
// 揭示流程的 raw-records GET 返回最小合法 RawRecord，导航端点返回空集合。
function installFetchMock(items: Record<string, () => unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      if (url === '/api/v1/folders/tree') return Promise.resolve(jsonResponse({ items: [] }))
      if (url === '/api/v1/tags') return Promise.resolve(jsonResponse({ items: [] }))
      const rawMatch = url.match(/^\/api\/v1\/items\/([^/]+)\/raw-records\/([^/]+)$/)
      if (rawMatch && method === 'GET') {
        return Promise.resolve(
          jsonResponse({
            ...rawSummary(),
            itemId: rawMatch[1],
            readOnly: true,
            body: '原始正文',
            source: { sourceType: 'web_quick_capture', metadata: {} },
          }),
        )
      }
      const itemMatch = url.match(/^\/api\/v1\/items\/([^/]+)$/)
      if (itemMatch && method === 'GET') {
        const factory = items[itemMatch[1]]
        return Promise.resolve(jsonResponse(factory ? factory() : itemDetail(itemMatch[1], 'normal', [])))
      }
      return Promise.resolve(jsonResponse({}))
    }),
  )
}

let activeWrapper: ReturnType<typeof mount> | null = null

async function mountDetail(itemId: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: { template: '<div />' } },
      { path: '/items/:itemId', name: 'item-detail', component: ItemDetailView },
    ],
  })
  await router.push('/')
  activeWrapper = mount(ItemDetailView, {
    props: { itemId },
    attachTo: document.body,
    global: { plugins: [router] },
  })
  await flushPromises()
  return activeWrapper
}

async function openAttachmentsTab() {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('.detail-tabs button')].find((button) =>
    (button.textContent ?? '').includes('附件'),
  )
  expect(tab, 'attachments tab button').toBeTruthy()
  tab!.click()
  await flushPromises()
}

function previewImgs() {
  return [...document.querySelectorAll<HTMLImageElement>('.attachment-preview img')]
}

function retryButtons() {
  return [...document.querySelectorAll<HTMLButtonElement>('.attachment-preview button')].filter((button) =>
    (button.textContent ?? '').includes('重试预览'),
  )
}

function failureNotices() {
  return [...document.querySelectorAll('.attachment-preview span')].filter(
    (span) => (span.textContent ?? '').trim() === '预览加载失败',
  )
}

describe('ItemDetailView attachment preview failure and retry', () => {
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

  it('case1 加载失败显示失败态与一次显式重试，恢复后不保留旧错误且不串到其它附件', async () => {
    installFetchMock({
      'item-1': () =>
        itemDetail('item-1', 'normal', [
          imageAttachment('att-a', { displayName: '截图甲' }),
          imageAttachment('att-b', { displayName: '截图乙' }),
        ]),
    })
    await mountDetail('item-1')
    await openAttachmentsTab()

    // 初始：两个 eligible 图片附件都渲染 img（jsdom 不自动加载，不发 load/error）。
    expect(previewImgs().length, '初始两个缩略图 img').toBe(2)
    const imgA = previewImgs().find((img) => img.alt === '截图甲')
    expect(imgA, '附件甲的 img').toBeTruthy()

    // 缩略图请求失败（如 500/断网）：img error 后必须出现失败文案与重试入口，坏图不再渲染。
    imgA!.dispatchEvent(new Event('error'))
    await flushPromises()
    expect(failureNotices().length, 'error 后显示一处「预览加载失败」').toBe(1)
    expect(retryButtons().length, 'error 后显示一个「重试预览」按钮').toBe(1)
    expect(previewImgs().length, '失败附件不再渲染 img').toBe(1)
    expect(previewImgs()[0].alt, '另一附件的 img 不受影响').toBe('截图乙')

    // 不自动轮询/后台重试：再刷一轮微任务后失败附件仍无 img。
    await flushPromises()
    expect(previewImgs().length, '无自动重试').toBe(1)

    // 一次显式重试 = 一次新加载：img 以同一 src 重挂（无缓存破坏参数），旧错误清除。
    retryButtons()[0].click()
    await flushPromises()
    expect(failureNotices().length, '重试后旧错误清除').toBe(0)
    expect(retryButtons().length, '重试后无重试入口').toBe(0)
    const newImgs = previewImgs()
    expect(newImgs.length, '重试后两个 img 都在').toBe(2)
    const newImgA = newImgs.find((img) => img.alt === '截图甲')
    expect(newImgA, '重挂后的附件甲 img').toBeTruthy()
    expect(newImgA).not.toBe(imgA)
    expect(newImgA!.getAttribute('src'), '重试保持原 URL，不加缓存参数').toBe('/api/v1/attachments/att-a/thumbnail')

    // 失败可重复进入：再次 error 后失败态再次出现，再次重试恢复显示。
    newImgA!.dispatchEvent(new Event('error'))
    await flushPromises()
    expect(failureNotices().length, '再次失败重新显示失败态').toBe(1)
    retryButtons()[0].click()
    await flushPromises()
    expect(failureNotices().length, '再次重试后恢复显示').toBe(0)
    expect(previewImgs().length, '成功恢复后图片显示').toBe(2)
  })

  it('case2 静态不支持预览沿用既有文案且无重试入口；敏感未揭示不请求缩略图，揭示后按门控加载', async () => {
    // 阶段一：普通条目的静态附件（预览不允许 / 无缩略 URL / 文件类型）。
    installFetchMock({
      'item-static': () =>
        itemDetail('item-static', 'normal', [
          imageAttachment('att-c', { previewAllowed: false, displayName: '静态丙' }),
          imageAttachment('att-d', { thumbnailUrl: null, displayName: '静态丁' }),
        ]),
    })
    await mountDetail('item-static')
    await openAttachmentsTab()
    expect(previewImgs().length, '静态附件不渲染 img').toBe(0)
    expect(retryButtons().length, '静态附件无重试入口').toBe(0)
    expect(
      [...document.querySelectorAll('.attachment-preview span')].filter(
        (span) => (span.textContent ?? '').trim() === '安全预览不可用',
      ).length,
      '静态附件沿用既有文案',
    ).toBe(2)
    activeWrapper?.unmount()
    activeWrapper = null
    document.body.innerHTML = ''

    // 阶段二：敏感条目的 eligible 图片附件，未揭示时不渲染 img、无重试入口。
    installFetchMock({
      'item-s': () => itemDetail('item-s', 'sensitive', [imageAttachment('att-e', { displayName: '敏感戊' })]),
    })
    await mountDetail('item-s')
    await openAttachmentsTab()
    expect(previewImgs().length, '敏感未揭示不请求缩略图').toBe(0)
    expect(retryButtons().length, '敏感未揭示无重试入口').toBe(0)
    expect(
      [...document.querySelectorAll('.attachment-preview span')].filter(
        (span) => (span.textContent ?? '').trim() === '敏感图片未请求',
      ).length,
      '敏感未揭示沿用既有文案',
    ).toBe(1)

    // 走真实揭示流程：确认后缩略图按同一门控开始加载。
    const revealButton = [...document.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').includes('揭示附件'),
    )
    expect(revealButton, '「揭示附件」按钮').toBeTruthy()
    revealButton!.click()
    await flushPromises()
    const confirmButton = [...document.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').includes('确认揭示'),
    )
    expect(confirmButton, '「确认揭示」按钮').toBeTruthy()
    confirmButton!.click()
    await flushPromises()
    expect(previewImgs().length, '揭示后渲染缩略图 img').toBe(1)
    expect(previewImgs()[0].alt, '揭示后加载的是敏感附件').toBe('敏感戊')
    expect(retryButtons().length, '揭示成功加载中无重试入口').toBe(0)
  })

  it('case3 失败态跟随详情生命周期：切换条目后失败态清空，不串到后续附件', async () => {
    // 两个条目复用同一附件 id：若失败态未随详情重置，切换后残留会立刻暴露。
    const shared = () => [imageAttachment('att-shared', { displayName: '共享截图' })]
    installFetchMock({
      'item-1': () => itemDetail('item-1', 'normal', shared()),
      'item-2': () => itemDetail('item-2', 'normal', shared()),
    })
    const wrapper = await mountDetail('item-1')
    await openAttachmentsTab()
    expect(previewImgs().length, '初始 img 渲染').toBe(1)
    previewImgs()[0].dispatchEvent(new Event('error'))
    await flushPromises()
    expect(failureNotices().length, '切换前进入失败态').toBe(1)

    // 切换条目触发详情重载：失败态属于上一个详情生命周期，必须整体清空。
    await wrapper.setProps({ itemId: 'item-2' })
    await flushPromises()
    expect(failureNotices().length, '切换条目后失败态清空').toBe(0)
    expect(retryButtons().length, '切换条目后无重试入口').toBe(0)
    expect(previewImgs().length, '切换后新详情的缩略图正常渲染').toBe(1)
    expect(previewImgs()[0].alt, '渲染的是新详情的附件').toBe('共享截图')
  })
})

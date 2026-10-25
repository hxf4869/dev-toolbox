import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import { useLibraryStore } from './library'
import WorkspaceView from './WorkspaceView.vue'

interface FetchCall {
  path: string
  init: RequestInit
}

const searchResult = {
  itemId: 'item-1',
  title: 'ux07 docker 挂载记录',
  snippetParts: [{ text: 'docker 挂载', highlighted: true }],
  matchedSource: 'raw_text',
  matchedFragmentId: 'frag-1',
  effectiveCapturedAt: '2026-09-01T00:00:00Z',
  sensitivity: 'normal',
  contentKind: 'text',
  artifactIsStale: null,
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installFetchMock(onBrowse?: (url: string) => Promise<Response>, onRestore?: () => Promise<Response>) {
  const calls: FetchCall[] = []
  const mock = vi.fn().mockImplementation((path: string, init: RequestInit) => {
    const url = String(path)
    calls.push({ path: url, init })
    if (url.startsWith('/api/v1/search')) return Promise.resolve(jsonResponse({ sort: 'relevance', total: 1, items: [searchResult], nextCursor: null }))
    if (url.endsWith('/restore') && init.method === 'POST' && onRestore) return onRestore()
    if (url.startsWith('/api/v1/items/')) return Promise.resolve(jsonResponse(itemDetail()))
    if (url.startsWith('/api/v1/items?')) return onBrowse?.(url) ?? Promise.resolve(jsonResponse({ items: [], nextCursor: null }))
    if (url.startsWith('/api/v1/folders/tree')) return Promise.resolve(jsonResponse({ items: [] }))
    if (url.startsWith('/api/v1/tags')) return Promise.resolve(jsonResponse({ items: [] }))
    return Promise.resolve(jsonResponse({}))
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

function itemDetail() {
  return {
    id: 'item-1',
    title: 'ux07 docker 挂载记录',
    titleOrigin: 'user',
    note: null,
    folder: null,
    tags: [],
    sensitivity: 'normal',
    favorite: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    rawRecords: [],
    attachments: [],
    artifacts: [],
    availableVersions: [],
  }
}

async function mountWorkspace(query: Record<string, string> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: WorkspaceView },
      { path: '/items/:itemId', name: 'item-detail', component: WorkspaceView },
    ],
  })
  await router.push({ path: '/', query })
  const wrapper = mount(WorkspaceView, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('WorkspaceView search resilience', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('keeps the previous result list visible when a refresh fails', async () => {
    const calls = installFetchMock()
    const library = useLibraryStore()
    library.query = 'docker 挂载'
    const { wrapper } = await mountWorkspace()
    expect(calls.filter((call) => call.path.startsWith('/api/v1/search'))).toHaveLength(1)

    calls.length = 0
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disconnected')))
    await library.search({ sort: 'updated_desc' })
    await flushPromises()
    await nextTick()

    expect(library.error).not.toBe('')
    expect(library.results).toHaveLength(1)
    expect(wrapper.find('.refresh-error').exists()).toBe(true)
    expect(wrapper.find('.refresh-error').attributes('role')).toBe('alert')
    expect(wrapper.text()).toContain('ux07 docker 挂载记录')
    wrapper.unmount()
  })

  it('keeps normal search hits navigable in the trash route and while clearing the search', async () => {
    const calls = installFetchMock()
    const library = useLibraryStore()
    library.query = 'docker 挂载'
    const { wrapper } = await mountWorkspace({ view: 'trash' })
    try {
      expect(calls.filter((call) => call.path.startsWith('/api/v1/search'))).toHaveLength(1)
      expect(library.mode).toBe('search')
      expect(wrapper.find('.result-card').element.tagName).toBe('A')
      expect(wrapper.find('.result-card').attributes('href')).toContain('/items/item-1')
      expect(wrapper.find('.result-card').text()).toContain('命中原文')
      expect(wrapper.findAll('button').some((button) => ['恢复', '永久删除'].includes(button.text()))).toBe(false)

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await wrapper.find('button[aria-label="清除搜索"]').trigger('click')
      await nextTick()
      expect(library.mode).toBe('browse')
      expect(library.query).toBe('')
      expect(wrapper.find('.result-card').element.tagName).toBe('A')
      expect(wrapper.findAll('button').some((button) => ['恢复', '永久删除'].includes(button.text()))).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      await flushPromises()
      expect(wrapper.find('.result-card').exists()).toBe(false)
      expect(wrapper.text()).toContain('回收站是空的')
      expect(calls.some((call) => call.init.method === 'DELETE' || call.path.endsWith('/restore'))).toBe(false)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('keeps active browse entries free of trash actions during a trash refresh and failure', async () => {
    let resolveTrash!: (response: Response) => void
    const trashRead = new Promise<Response>((resolve) => { resolveTrash = resolve })
    const activeItem = {
      id: 'item-1', title: searchResult.title, sensitivity: 'normal', favorite: false,
      folderId: null, tags: [], summary: '普通列表保留的上次摘要',
      createdAt: searchResult.effectiveCapturedAt, updatedAt: searchResult.effectiveCapturedAt,
      deletedAt: null, effectiveCapturedAt: searchResult.effectiveCapturedAt,
      sourceTimeQuality: 'user', rawRecordCount: 1, attachmentCount: 0, attachments: [],
    }
    const calls = installFetchMock((url) => new URL(url, 'http://localhost').searchParams.get('view') === 'trash'
      ? trashRead : Promise.resolve(jsonResponse({ items: [activeItem], nextCursor: null })))
    const { wrapper, router } = await mountWorkspace()
    try {
      expect(wrapper.find('.result-card').element.tagName).toBe('A')
      await router.push({ path: '/', query: { view: 'trash' } })
      await flushPromises()
      expect(useLibraryStore().loading).toBe(true)
      expect(wrapper.find('.result-card').element.tagName).toBe('A')
      expect(wrapper.findAll('button').some((button) => ['恢复', '永久删除'].includes(button.text()))).toBe(false)
      resolveTrash(new Response(JSON.stringify({ error: { code: 'LIBRARY_UNAVAILABLE', message: '合成回收站读取失败' } }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      }))
      await flushPromises()
      expect(wrapper.find('.refresh-error').text()).toContain('合成回收站读取失败')
      expect(wrapper.find('.result-card').element.tagName).toBe('A')
      expect(wrapper.findAll('button').some((button) => ['恢复', '永久删除'].includes(button.text()))).toBe(false)
      expect(calls.some((call) => call.init.method === 'DELETE' || call.path.endsWith('/restore'))).toBe(false)
    } finally {
      resolveTrash(jsonResponse({ items: [], nextCursor: null }))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('pins recent browsing to effective capture time even when a URL requests updated sort', async () => {
    const calls = installFetchMock()
    const { wrapper } = await mountWorkspace({ view: 'recent', sort: 'updated_desc' })
    try {
      const browse = calls.find((call) => call.path.startsWith('/api/v1/items?'))!
      const parameters = new URL(browse.path, 'http://localhost').searchParams
      expect(parameters.get('view')).toBe('recent')
      expect(parameters.get('sort')).toBe('effective_desc')
      const sort = wrapper.find('.results-pane__header select').element as HTMLSelectElement
      expect(sort.value).toBe('effective_desc')
      expect(sort.disabled).toBe(true)
      expect(calls.some((call) => call.path === '/api/v1/search')).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('allows relevance search from recent and restores fixed ordering when search is cleared', async () => {
    const calls = installFetchMock()
    const library = useLibraryStore()
    library.query = 'docker 挂载'
    const { wrapper } = await mountWorkspace({ view: 'recent', sort: 'updated_desc' })
    try {
      const search = calls.find((call) => call.path === '/api/v1/search')!
      expect(JSON.parse(String(search.init.body)).sort).toBe('relevance')
      const sort = wrapper.find('.results-pane__header select').element as HTMLSelectElement
      expect(sort.disabled).toBe(false)
      expect(sort.value).toBe('updated_desc')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await wrapper.find('button[aria-label="清除搜索"]').trigger('click')
      await nextTick()
      expect(sort.disabled).toBe(true)
      expect(sort.value).toBe('effective_desc')
      await vi.advanceTimersByTimeAsync(200)
      await flushPromises()
      const browse = calls.filter((call) => call.path.startsWith('/api/v1/items?')).at(-1)!
      expect(new URL(browse.path, 'http://localhost').searchParams.get('sort')).toBe('effective_desc')
      expect(library.mode).toBe('browse')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('shows a restore failure, clears it for a different action, and restores only on explicit retry', async () => {
    let restores = 0
    let restored = false
    const deletedItem = {
      id: 'item-1', title: '合成回收站记录', sensitivity: 'normal', favorite: false,
      folderId: null, tags: [], summary: '', createdAt: searchResult.effectiveCapturedAt,
      updatedAt: searchResult.effectiveCapturedAt, deletedAt: searchResult.effectiveCapturedAt,
      effectiveCapturedAt: searchResult.effectiveCapturedAt, sourceTimeQuality: 'user',
      rawRecordCount: 1, attachmentCount: 0, attachments: [],
    }
    const calls = installFetchMock(
      async () => jsonResponse({ items: restored ? [] : [deletedItem], nextCursor: null }),
      async () => {
        restores += 1
        if (restores === 1) return new Response(JSON.stringify({ error: { code: 'RESTORE_UNAVAILABLE', message: '合成恢复暂时不可用' } }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        })
        restored = true
        return new Response(null, { status: 204 })
      },
    )
    const { wrapper } = await mountWorkspace({ view: 'trash' })
    const restore = () => wrapper.findAll('button').find((button) => button.text() === '恢复')!
    try {
      await restore().trigger('click')
      await flushPromises()
      expect(restores).toBe(1)
      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
      expect(wrapper.find('[role="alert"]').text()).toContain('合成恢复暂时不可用')
      expect(wrapper.find('.result-card--trash').text()).toContain(deletedItem.title)
      expect(restore().attributes('disabled')).toBeUndefined()

      await wrapper.findAll('button').find((button) => button.text() === '永久删除')!.trigger('click')
      await flushPromises()
      expect(document.querySelector('.purge-dialog__error')).toBeNull()
      const cancel = [...document.querySelectorAll<HTMLButtonElement>('.purge-overlay button')].find((button) => button.textContent?.trim() === '取消')!
      cancel.click()
      await flushPromises()
      expect(calls.some((call) => call.path.endsWith('/purge'))).toBe(false)
      expect(restores).toBe(1)

      await restore().trigger('click')
      await flushPromises()
      expect(restores).toBe(2)
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(wrapper.find('.result-card--trash').exists()).toBe(false)
      expect(wrapper.text()).toContain('回收站是空的')
    } finally {
      wrapper.unmount()
    }
  })

  it('does not refetch the result list when only the hit fragment changes', async () => {
    const calls = installFetchMock()
    const library = useLibraryStore()
    library.query = 'docker 挂载'
    const { wrapper, router } = await mountWorkspace()
    const searchCalls = () => calls.filter((call) => call.path.startsWith('/api/v1/search')).length
    expect(searchCalls()).toBe(1)

    await router.push({ name: 'item-detail', params: { itemId: 'item-1' }, query: { hit: 'frag-1' } })
    await flushPromises()
    expect(searchCalls()).toBe(1)

    await router.push({ name: 'workspace', query: { hit: 'frag-1' } })
    await flushPromises()
    expect(searchCalls()).toBe(1)
    wrapper.unmount()
  })

  it('restores the list scroll position after returning from the detail view', async () => {
    installFetchMock()
    const { wrapper, router } = await mountWorkspace()

    const pane = wrapper.find('.results-pane').element as HTMLElement
    let scrollTopValue = 0
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value
      },
    })

    scrollTopValue = 320
    pane.dispatchEvent(new Event('scroll'))
    await nextTick()

    await router.push({ name: 'item-detail', params: { itemId: 'item-1' }, query: {} })
    await flushPromises()
    await router.push({ name: 'workspace', query: {} })
    await flushPromises()
    await nextTick()

    expect(scrollTopValue).toBe(320)
    wrapper.unmount()
  })

  it('labels the matched source and content kind instead of raw tokens', async () => {
    installFetchMock()
    const library = useLibraryStore()
    library.query = 'docker 挂载'
    const { wrapper } = await mountWorkspace()
    await flushPromises()

    const card = wrapper.find('.result-card')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('命中原文')
    expect(card.text()).toContain('文本')
    expect(card.text()).not.toContain('raw_text')
    wrapper.unmount()
  })
})

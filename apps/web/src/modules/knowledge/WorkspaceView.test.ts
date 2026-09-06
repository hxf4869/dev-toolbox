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

function installFetchMock() {
  const calls: FetchCall[] = []
  const mock = vi.fn().mockImplementation((path: string, init: RequestInit) => {
    const url = String(path)
    calls.push({ path: url, init })
    if (url.startsWith('/api/v1/search')) return Promise.resolve(jsonResponse({ sort: 'relevance', total: 1, items: [searchResult], nextCursor: null }))
    if (url.startsWith('/api/v1/items/')) return Promise.resolve(jsonResponse(itemDetail()))
    if (url.startsWith('/api/v1/items?')) return Promise.resolve(jsonResponse({ items: [], nextCursor: null }))
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

async function mountWorkspace() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: WorkspaceView },
      { path: '/items/:itemId', name: 'item-detail', component: WorkspaceView },
    ],
  })
  await router.push('/')
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

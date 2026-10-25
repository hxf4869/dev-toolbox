import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import type { KnowledgeIndexStatusDTO } from '../assistant/assistantContracts'
import { embeddingSettingsFixtures, knowledgeFixtures, MOCK_IDS } from '../assistant/assistantMocks'
import ProviderSettingsView from './ProviderSettingsView.vue'

describe('ProviderSettingsView index polling', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('refreshes index status to terminal ready without a reload and keeps the form draft', async () => {
    const statusQueue: KnowledgeIndexStatusDTO[] = [knowledgeFixtures.indexing, knowledgeFixtures.ready]
    let statusReads = 0
    let embeddingSettingsReads = 0
    let failureReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') {
        embeddingSettingsReads += 1
        return jsonResponse(embeddingSettingsFixtures.ready)
      }
      if (path === '/api/v1/assistant/index-status') {
        return jsonResponse(statusQueue[Math.min(statusReads++, statusQueue.length - 1)])
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') {
        failureReads += 1
        return jsonResponse({ items: [], nextCursor: null })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()

    expect(indexCount('待处理')).toBe('11')
    expect(statusReads).toBe(1)

    const modelInput = document.querySelector<HTMLInputElement>(
      '.embedding-form input[placeholder="text-embedding-3-small"]',
    )!
    await setInput(modelInput, 'text-embedding-draft-edit')

    await vi.advanceTimersByTimeAsync(2000)

    expect(document.querySelector<HTMLElement>('.index-status')!.textContent).toContain('可检索')
    expect(indexCount('待处理')).toBe('0')
    expect(modelInput.value).toBe('text-embedding-draft-edit')
    expect(embeddingSettingsReads).toBe(1)
    expect(statusReads).toBe(2)
    expect(failureReads).toBe(2)

    await vi.advanceTimersByTimeAsync(10000)
    expect(statusReads).toBe(2)
    wrapper.unmount()
  })

  it('drops a superseded in-flight poll response and stops requesting after unmount', async () => {
    const failure = {
      fragmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      itemId: MOCK_IDS.item,
      itemTitle: '重建中失败记录',
      sourceKind: 'raw_text',
      attempt: 1,
      errorCode: 'EMBEDDING_PROVIDER_UNAVAILABLE',
      updatedAt: '2026-09-02T03:00:00Z',
    }
    const laterStatus: KnowledgeIndexStatusDTO = {
      ...knowledgeFixtures.indexing,
      counts: { ...knowledgeFixtures.indexing.counts, pending: 5, running: 0 },
    }
    let statusReads = 0
    const inFlightPoll = deferred<Response>()
    let retried = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') {
        statusReads += 1
        if (statusReads === 1) return jsonResponse(knowledgeFixtures.indexing)
        if (statusReads === 2) return inFlightPoll.promise
        return jsonResponse(laterStatus)
      }
      if (path === `/api/v1/assistant/index-failures/${failure.fragmentId}/retry` && init?.method === 'POST') {
        retried = true
        return jsonResponse({ fragmentId: failure.fragmentId, state: 'pending' }, 202)
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') {
        return jsonResponse({ items: [failure], nextCursor: null })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()
    expect(statusReads).toBe(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(statusReads).toBe(2)

    clickButton('重试', document.querySelector<HTMLElement>('.index-failures')!)
    await flushPromises()
    expect(retried).toBe(true)
    expect(statusReads).toBe(3)
    expect(indexCount('待处理')).toBe('5')

    inFlightPoll.resolve(jsonResponse(knowledgeFixtures.ready))
    await flushPromises()
    expect(indexCount('待处理')).toBe('5')

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(10000)
    expect(statusReads).toBe(3)
  })

  it('recovers manually after an auto refresh failure without touching the form draft', async () => {
    let statusReads = 0
    let pollFailing = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') {
        statusReads += 1
        if (statusReads > 1 && pollFailing) {
          return jsonResponse({ error: { code: 'INDEX_STATUS_UNAVAILABLE', message: '索引状态读取失败' } }, 500)
        }
        return jsonResponse(statusReads === 1 ? knowledgeFixtures.indexing : knowledgeFixtures.ready)
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()

    await vi.advanceTimersByTimeAsync(2000)
    const statusSection = document.querySelector<HTMLElement>('.index-status')!
    expect(statusSection.textContent).toContain('自动刷新索引状态失败')
    expect(indexCount('待处理')).toBe('11')

    await vi.advanceTimersByTimeAsync(6000)
    expect(statusReads).toBe(2)

    const modelInput = document.querySelector<HTMLInputElement>(
      '.embedding-form input[placeholder="text-embedding-3-small"]',
    )!
    await setInput(modelInput, 'text-embedding-draft-edit')

    pollFailing = false
    clickButton('刷新索引状态', statusSection)
    await flushPromises()

    expect(statusSection.textContent).not.toContain('自动刷新索引状态失败')
    expect(statusSection.textContent).toContain('可检索')
    expect(indexCount('待处理')).toBe('0')
    expect(modelInput.value).toBe('text-embedding-draft-edit')
    expect(statusReads).toBe(3)

    await vi.advanceTimersByTimeAsync(6000)
    expect(statusReads).toBe(3)
    wrapper.unmount()
  })

  it('drops the initial embedding section response and never polls after an early unmount', async () => {
    let statusReads = 0
    const initialStatus = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') {
        statusReads += 1
        return initialStatus.promise
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()
    expect(statusReads).toBe(1)

    wrapper.unmount()
    initialStatus.resolve(jsonResponse(knowledgeFixtures.indexing))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10000)

    expect(statusReads).toBe(1)
  })

  it('ignores a late failed poll superseded by a newer successful refresh', async () => {
    const failure = {
      fragmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      itemId: MOCK_IDS.item,
      itemTitle: '重建中失败记录',
      sourceKind: 'raw_text',
      attempt: 1,
      errorCode: 'EMBEDDING_PROVIDER_UNAVAILABLE',
      updatedAt: '2026-09-02T03:00:00Z',
    }
    let statusReads = 0
    const stalePoll = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') {
        statusReads += 1
        if (statusReads === 1) return jsonResponse(knowledgeFixtures.indexing)
        if (statusReads === 2) return stalePoll.promise
        return jsonResponse(knowledgeFixtures.ready)
      }
      if (path === `/api/v1/assistant/index-failures/${failure.fragmentId}/retry` && init?.method === 'POST') {
        return jsonResponse({ fragmentId: failure.fragmentId, state: 'pending' }, 202)
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') {
        return jsonResponse({ items: [failure], nextCursor: null })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()

    await vi.advanceTimersByTimeAsync(2000)
    expect(statusReads).toBe(2)

    clickButton('重试', document.querySelector<HTMLElement>('.index-failures')!)
    await flushPromises()
    expect(statusReads).toBe(3)
    expect(indexCount('待处理')).toBe('0')

    stalePoll.resolve(
      jsonResponse({ error: { code: 'INDEX_STATUS_UNAVAILABLE', message: '索引状态读取失败' } }, 500),
    )
    await flushPromises()
    const statusSection = document.querySelector<HTMLElement>('.index-status')!
    expect(statusSection.textContent).toContain('可检索')
    expect(statusSection.textContent).not.toContain('自动刷新索引状态失败')
    expect(
      Array.from(statusSection.querySelectorAll('button')).filter(
        (button) => button.textContent?.trim() === '刷新索引状态',
      ),
    ).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(6000)
    expect(statusReads).toBe(3)
    wrapper.unmount()
  })

  it('keeps expanded failure pages across same-generation automatic polls', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => failureEntry(index))
    const failedWithPending: KnowledgeIndexStatusDTO = {
      ...knowledgeFixtures.failed,
      counts: { ...knowledgeFixtures.failed.counts, failed: 51, pending: 2 },
    }
    const progressed: KnowledgeIndexStatusDTO = {
      ...failedWithPending,
      counts: { ...failedWithPending.counts, pending: 1 },
    }
    let statusReads = 0
    let firstPageReads = 0
    let secondPageReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') {
        statusReads += 1
        return jsonResponse(statusReads === 1 ? failedWithPending : progressed)
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') {
        firstPageReads += 1
        return jsonResponse({ items: firstPage, nextCursor: 'page-2' })
      }
      if (path === '/api/v1/assistant/index-failures?cursor=page-2&limit=50') {
        secondPageReads += 1
        return jsonResponse({ items: [failureEntry(50)], nextCursor: null })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(50)

    clickButton('加载更多失败项')
    await flushPromises()
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(51)

    await vi.advanceTimersByTimeAsync(2000)
    expect(statusReads).toBe(2)
    expect(indexCount('待处理')).toBe('1')
    expect(firstPageReads).toBe(1)
    expect(secondPageReads).toBe(1)
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(51)

    await vi.advanceTimersByTimeAsync(2000)
    expect(statusReads).toBe(3)
    expect(firstPageReads).toBe(1)
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(51)
    wrapper.unmount()
  })

  it('drops a late load-more page after a manual refresh resets the failure list', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => failureEntry(index))
    const rebuilt: KnowledgeIndexStatusDTO = {
      ...knowledgeFixtures.failed,
      generation: 3,
      counts: { ...knowledgeFixtures.failed.counts, failed: 2, pending: 1 },
    }
    const latePage = deferred<Response>()
    let retried = false
    let statusReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') {
        statusReads += 1
        return jsonResponse(
          statusReads === 1
            ? { ...knowledgeFixtures.failed, counts: { ...knowledgeFixtures.failed.counts, failed: 51, pending: 2 } }
            : rebuilt,
        )
      }
      if (path === '/api/v1/assistant/index-failures/fragment-30/retry' && init?.method === 'POST') {
        retried = true
        return jsonResponse({ fragmentId: 'fragment-30', state: 'pending' }, 202)
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') {
        return jsonResponse(
          retried
            ? { items: [failureEntry(200), failureEntry(201)], nextCursor: null }
            : { items: firstPage, nextCursor: 'page-2' },
        )
      }
      if (path === '/api/v1/assistant/index-failures?cursor=page-2&limit=50') return latePage.promise
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(50)

    clickButton('加载更多失败项')
    await flushPromises()
    expect(statusReads).toBe(1)

    document.querySelectorAll<HTMLButtonElement>('.index-failures li button')[30]!.click()
    await flushPromises()
    expect(retried).toBe(true)
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(2)

    latePage.resolve(jsonResponse({ items: [failureEntry(50)], nextCursor: null }))
    await flushPromises()
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(2)
    wrapper.unmount()
  })

  it('refreshes the first failure page when new failures appear on a non-expanded list', async () => {
    let statusReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') {
        statusReads += 1
        const failed = statusReads === 1 ? 2 : 3
        return jsonResponse({
          ...knowledgeFixtures.failed,
          counts: { ...knowledgeFixtures.failed.counts, failed, pending: 1 },
        })
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') {
        const total = statusReads === 1 ? 2 : 3
        return jsonResponse({ items: Array.from({ length: total }, (_, index) => failureEntry(index)), nextCursor: null })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(2000)
    expect(indexCount('失败')).toBe('3')
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(3)
    expect(document.body.textContent).toContain('失败记录 2')
    expect(document.querySelector<HTMLButtonElement>('.index-failures li button')!.textContent).toContain('重试')
    wrapper.unmount()
  })

  it('keeps an expanded last page and offers an explicit refresh when new failures appear', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => failureEntry(index))
    const refreshedFirstPage = [failureEntry(51), ...Array.from({ length: 49 }, (_, index) => failureEntry(index))]
    let statusReads = 0
    let firstPageReads = 0
    let secondPageReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') {
        statusReads += 1
        const failed = statusReads <= 1 ? 51 : 52
        return jsonResponse({
          ...knowledgeFixtures.failed,
          counts: { ...knowledgeFixtures.failed.counts, failed, pending: 2 },
        })
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') {
        firstPageReads += 1
        return jsonResponse({ items: firstPageReads === 1 ? firstPage : refreshedFirstPage, nextCursor: 'page-2' })
      }
      if (path === '/api/v1/assistant/index-failures?cursor=page-2&limit=50') {
        secondPageReads += 1
        return jsonResponse({ items: [failureEntry(50)], nextCursor: null })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()
    clickButton('加载更多失败项')
    await flushPromises()
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(51)

    await vi.advanceTimersByTimeAsync(2000)
    expect(indexCount('失败')).toBe('52')
    expect(firstPageReads).toBe(1)
    expect(secondPageReads).toBe(1)
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(51)

    const refreshEntry = Array.from(document.querySelectorAll<HTMLButtonElement>('.index-failures button')).find(
      (button) => button.textContent?.trim() === '有新失败 · 刷新列表',
    )
    expect(refreshEntry).toBeTruthy()
    refreshEntry!.click()
    await flushPromises()

    expect(statusReads).toBe(3)
    expect(firstPageReads).toBe(2)
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(50)
    expect(document.body.textContent).toContain('失败记录 51')
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.index-failures button')).filter(
        (button) => button.textContent?.trim() === '有新失败 · 刷新列表',
      ),
    ).toHaveLength(0)
    wrapper.unmount()
  })

  it('offers an explicit refresh only after the failed count grows on an expanded middle page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => failureEntry(index))
    const refreshedFirstPage = [failureEntry(150), ...Array.from({ length: 49 }, (_, index) => failureEntry(index))]
    const secondPage = Array.from({ length: 50 }, (_, index) => failureEntry(50 + index))
    let statusReads = 0
    let firstPageReads = 0
    let secondPageReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') {
        statusReads += 1
        const failed = statusReads <= 2 ? 150 : 151
        const pending = statusReads === 1 ? 2 : 1
        return jsonResponse({
          ...knowledgeFixtures.failed,
          counts: { ...knowledgeFixtures.failed.counts, failed, pending },
        })
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') {
        firstPageReads += 1
        return jsonResponse({ items: firstPageReads === 1 ? firstPage : refreshedFirstPage, nextCursor: 'page-2' })
      }
      if (path === '/api/v1/assistant/index-failures?cursor=page-2&limit=50') {
        secondPageReads += 1
        return jsonResponse({ items: secondPage, nextCursor: 'page-3' })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(50)
    expect(indexCount('失败')).toBe('150')
    expect(statusReads).toBe(1)
    expect(firstPageReads).toBe(1)

    clickButton('加载更多失败项')
    await flushPromises()
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(100)
    expect(secondPageReads).toBe(1)
    expect(firstPageReads).toBe(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(statusReads).toBe(2)
    expect(indexCount('待处理')).toBe('1')
    expect(indexCount('失败')).toBe('150')
    expect(firstPageReads).toBe(1)
    expect(secondPageReads).toBe(1)
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(100)
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.index-failures button')).filter(
        (button) => button.textContent?.trim() === '有新失败 · 刷新列表',
      ),
    ).toHaveLength(0)
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.index-failures button')).filter(
        (button) => button.textContent?.trim() === '加载更多失败项',
      ),
    ).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(statusReads).toBe(3)
    expect(indexCount('失败')).toBe('151')
    expect(firstPageReads).toBe(1)
    expect(secondPageReads).toBe(1)
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(100)
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.index-failures button')).filter(
        (button) => button.textContent?.trim() === '加载更多失败项',
      ),
    ).toHaveLength(1)
    const refreshEntry = Array.from(document.querySelectorAll<HTMLButtonElement>('.index-failures button')).find(
      (button) => button.textContent?.trim() === '有新失败 · 刷新列表',
    )
    expect(refreshEntry).toBeTruthy()
    refreshEntry!.click()
    await flushPromises()

    expect(statusReads).toBe(4)
    expect(firstPageReads).toBe(2)
    expect(secondPageReads).toBe(1)
    expect(document.querySelectorAll('.index-failures li')).toHaveLength(50)
    expect(document.body.textContent).toContain('失败记录 150')
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.index-failures button')).filter(
        (button) => button.textContent?.trim() === '有新失败 · 刷新列表',
      ),
    ).toHaveLength(0)
    wrapper.unmount()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function failureEntry(index: number) {
  return {
    fragmentId: `fragment-${index}`,
    itemId: MOCK_IDS.item,
    itemTitle: `失败记录 ${index}`,
    sourceKind: 'raw_text',
    attempt: 1,
    errorCode: 'EMBEDDING_PROVIDER_UNAVAILABLE',
    updatedAt: '2026-09-02T03:00:00Z',
  }
}

async function mountView(): Promise<VueWrapper> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test-value'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/settings/providers', name: 'provider-settings', component: { template: '<div />' } }],
  })
  await router.push('/settings/providers')
  await router.isReady()
  const wrapper = mount(ProviderSettingsView, {
    attachTo: document.body,
    global: { plugins: [pinia, router] },
  })
  await flushPromises()
  return wrapper
}

function providersResponse() {
  return jsonResponse({
    items: [
      {
        id: MOCK_IDS.provider,
        providerKey: 'local-mock',
        displayName: '本地 Mock',
        protocol: 'openai-completions',
        baseUrl: 'https://provider.example.test/v1',
        hasApiKey: true,
        apiKeyMask: '•••• 1234',
        enabled: true,
        models: [],
        createdAt: '2026-09-02T03:00:00Z',
        updatedAt: '2026-09-02T03:00:00Z',
      },
    ],
    allowInsecureHttp: false,
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function clickButton(text: string, root: ParentNode = document) {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (entry) => entry.textContent?.trim() === text,
  )
  if (!button) throw new Error(`button not found: ${text}`)
  button.click()
}

async function setInput(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

function indexCount(label: string) {
  const entry = Array.from(document.querySelectorAll('.index-counts > div')).find(
    (row) => row.querySelector('dt')?.textContent === label,
  )
  return entry?.querySelector('dd')?.textContent ?? ''
}

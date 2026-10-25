import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import ItemDetailView from './ItemDetailView.vue'

const RAW_A = 'raw-a'
const RAW_B = 'raw-b'

interface RawPending {
  id: string
  resolve: () => void
  reject: (error: unknown) => void
}

function rawSummary(id: string) {
  // A and B are told apart in the switch list by their formatted capture date.
  const capturedAt = id === RAW_B ? '2026-09-02T08:00:00Z' : '2026-09-01T08:00:00Z'
  return {
    id,
    recordRole: 'primary',
    sourceType: 'web_quick_capture',
    contentKind: 'text',
    contentFormat: 'plain_text',
    declaredSensitivity: 'normal',
    capturedAt,
    effectiveCapturedAt: capturedAt,
    sourceTimeQuality: 'trusted',
    createdAt: capturedAt,
    attachments: [],
    relations: [],
    fragments: [],
  }
}

function itemDetail(sensitivity: string) {
  return {
    id: 'item-1',
    title: '竞态验证条目',
    titleOrigin: 'user',
    note: null,
    folder: null,
    tags: [],
    sensitivity,
    favorite: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    rawRecords: [rawSummary(RAW_A), rawSummary(RAW_B)],
    attachments: [],
    artifacts: [],
    availableVersions: [],
  }
}

function rawRecordBody(id: string) {
  return {
    ...rawSummary(id),
    itemId: 'item-1',
    readOnly: true,
    body: `原始正文 ${id}`,
    source: { sourceType: 'web_quick_capture', metadata: {} },
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Defers every raw-record fetch so tests decide the arrival order of A and B.
function installFetchMock(sensitivity = 'normal') {
  const rawCalls: string[] = []
  const pending: RawPending[] = []
  const mock = vi.fn().mockImplementation((path: string, init: RequestInit) => {
    const url = String(path)
    if (init.method === 'PATCH') return Promise.resolve(new Response(null, { status: 204 }))
    const rawMatch = url.match(/^\/api\/v1\/items\/item-1\/raw-records\/([^/]+)$/)
    if (rawMatch) {
      const id = rawMatch[1]
      rawCalls.push(id)
      return new Promise<Response>((resolve, reject) => {
        pending.push({
          id,
          resolve: () => resolve(jsonResponse(rawRecordBody(id))),
          reject,
        })
      })
    }
    return Promise.resolve(jsonResponse(itemDetail(sensitivity)))
  })
  vi.stubGlobal('fetch', mock)
  return { rawCalls, pending }
}

function takePending(pending: RawPending[], id: string) {
  const index = pending.findIndex((entry) => entry.id === id)
  expect(index, `expected a pending fetch for ${id}`).toBeGreaterThanOrEqual(0)
  return pending.splice(index, 1)[0]
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

// Every writeText call parks on a manual promise so tests decide when a copy
// settles relative to raw-record switches and the 1600ms feedback timer.
function stubPendingClipboard() {
  const writes: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
  const writeText = vi.fn().mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        writes.push({ resolve, reject })
      }),
  )
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return { writeText, writes }
}

function findCopyButton(wrapper: DetailWrapper, label: string) {
  const button = wrapper.findAll('button').find((entry) => entry.text().includes(label))
  expect(button, `copy button labelled ${label}`).toBeDefined()
  return button!
}

async function mountDetail(sensitivity = 'normal') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: { template: '<div />' } },
      { path: '/items/:itemId', name: 'item-detail', component: ItemDetailView },
    ],
  })
  await router.push('/')
  const wrapper = mount(ItemDetailView, {
    props: { itemId: 'item-1' },
    global: { plugins: [router] },
  })
  await flushPromises()
  return wrapper
}

type DetailWrapper = Awaited<ReturnType<typeof mountDetail>>

async function clickReveal(wrapper: DetailWrapper) {
  const button = wrapper.find('.reveal-state button')
  expect(button.exists()).toBe(true)
  await button.trigger('click')
}

async function clickRawOption(wrapper: DetailWrapper, id: string) {
  const marker = id === RAW_B ? '9月2日' : '9月1日'
  const button = wrapper.findAll('.raw-history button').find((entry) => entry.text().includes(marker))
  expect(button, `raw switch button for ${id}`).toBeDefined()
  await button!.trigger('click')
}

describe('ItemDetailView raw record fetch race', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps raw B as the shown and copied record when raw A resolves after a switch', async () => {
    const writeText = stubClipboard()
    const { rawCalls, pending } = installFetchMock()
    const wrapper = await mountDetail()
    expect(rawCalls).toHaveLength(0)

    await clickReveal(wrapper)
    await clickRawOption(wrapper, RAW_B)
    await clickReveal(wrapper)
    takePending(pending, RAW_B).resolve()
    await flushPromises()
    takePending(pending, RAW_A).resolve()
    await flushPromises()

    expect(wrapper.find('.raw-content').text()).toContain('原始正文 raw-b')
    expect(wrapper.find('.raw-content').text()).not.toContain('原始正文 raw-a')

    const copy = wrapper.findAll('button').find((button) => button.text().includes('复制全部原文'))
    expect(copy).toBeDefined()
    await copy!.trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('原始正文 raw-b')
    wrapper.unmount()
  })

  it('does not attach a late raw A response after switching to B without revealing it', async () => {
    const { rawCalls, pending } = installFetchMock()
    const wrapper = await mountDetail()

    await clickReveal(wrapper)
    await clickRawOption(wrapper, RAW_B)
    takePending(pending, RAW_A).resolve()
    await flushPromises()
    await flushPromises()

    expect(rawCalls).toEqual([RAW_A])
    expect(wrapper.find('.reveal-state').exists()).toBe(true)
    expect(wrapper.find('.raw-content').exists()).toBe(false)
    wrapper.unmount()
  })

  it('ignores a stale raw failure while the newly selected raw is still loading', async () => {
    const { pending } = installFetchMock()
    const wrapper = await mountDetail()

    await clickReveal(wrapper)
    await clickRawOption(wrapper, RAW_B)
    await clickReveal(wrapper)
    takePending(pending, RAW_A).reject(new Error('A 读取失败'))
    await flushPromises()

    expect(wrapper.find('.detail-notice').exists()).toBe(false)
    const revealButton = wrapper.find('.reveal-state button')
    expect(revealButton.text()).toContain('正在读取')
    expect(revealButton.attributes('disabled')).toBeDefined()

    takePending(pending, RAW_B).resolve()
    await flushPromises()
    expect(wrapper.find('.raw-content').text()).toContain('原始正文 raw-b')
    wrapper.unmount()
  })

  it('invalidates an in-flight raw fetch when the metadata reloads', async () => {
    const { pending } = installFetchMock()
    const wrapper = await mountDetail()

    await clickReveal(wrapper)
    await wrapper.find('.favorite').trigger('click')
    await flushPromises()
    takePending(pending, RAW_A).resolve()
    await flushPromises()
    await flushPromises()

    expect(wrapper.find('.reveal-state').exists()).toBe(true)
    expect(wrapper.find('.raw-content').exists()).toBe(false)
    wrapper.unmount()
  })

  it('never fetches sensitive raw content before the explicit reveal confirmation', async () => {
    const { rawCalls } = installFetchMock('sensitive')
    const wrapper = await mountDetail('sensitive')

    await clickRawOption(wrapper, RAW_B)
    await clickReveal(wrapper)
    await flushPromises()

    expect(rawCalls).toHaveLength(0)
    expect(document.querySelector('.confirm-dialog')).not.toBeNull()

    ;(document.querySelector('.confirm-dialog button') as HTMLButtonElement).click()
    await flushPromises()
    expect(rawCalls).toEqual([RAW_B])
    wrapper.unmount()
  })

  it('ignores a late copy success from raw A after switching to raw B and copies B precisely', async () => {
    const { writeText, writes } = stubPendingClipboard()
    const { pending } = installFetchMock()
    const wrapper = await mountDetail()
    await clickReveal(wrapper)
    takePending(pending, RAW_A).resolve()
    await flushPromises()

    vi.useFakeTimers()
    await findCopyButton(wrapper, '复制全部原文').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('原始正文 raw-a')

    await clickRawOption(wrapper, RAW_B)
    await clickReveal(wrapper)
    takePending(pending, RAW_B).resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.find('.raw-content').text()).toContain('原始正文 raw-b')

    writes[0].resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(findCopyButton(wrapper, '复制全部原文')).toBeDefined()

    await findCopyButton(wrapper, '复制全部原文').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenLastCalledWith('原始正文 raw-b')
    writes[1].resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(findCopyButton(wrapper, '已复制全部')).toBeDefined()

    await vi.advanceTimersByTimeAsync(1600)
    expect(findCopyButton(wrapper, '复制全部原文')).toBeDefined()
    wrapper.unmount()
  })

  it('ignores a late copy failure from raw A after switching to raw B', async () => {
    const { writeText, writes } = stubPendingClipboard()
    const { pending } = installFetchMock()
    const wrapper = await mountDetail()
    await clickReveal(wrapper)
    takePending(pending, RAW_A).resolve()
    await flushPromises()

    vi.useFakeTimers()
    await findCopyButton(wrapper, '复制全部原文').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    await clickRawOption(wrapper, RAW_B)
    await clickReveal(wrapper)
    takePending(pending, RAW_B).resolve()
    await vi.advanceTimersByTimeAsync(0)

    writes[0].reject(new Error('clipboard denied'))
    await vi.advanceTimersByTimeAsync(0)
    expect(findCopyButton(wrapper, '复制全部原文')).toBeDefined()

    await findCopyButton(wrapper, '复制全部原文').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenLastCalledWith('原始正文 raw-b')
    writes[1].resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(findCopyButton(wrapper, '已复制全部')).toBeDefined()
    wrapper.unmount()
  })

  it('keeps the full 1600ms feedback window when the same raw is copied twice', async () => {
    stubClipboard()
    const { pending } = installFetchMock()
    const wrapper = await mountDetail()
    await clickReveal(wrapper)
    takePending(pending, RAW_A).resolve()
    await flushPromises()

    vi.useFakeTimers()
    await findCopyButton(wrapper, '复制全部原文').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(findCopyButton(wrapper, '已复制全部')).toBeDefined()

    await vi.advanceTimersByTimeAsync(800)
    expect(findCopyButton(wrapper, '已复制全部')).toBeDefined()

    await findCopyButton(wrapper, '已复制全部').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(800)
    expect(findCopyButton(wrapper, '已复制全部')).toBeDefined()

    await vi.advanceTimersByTimeAsync(800)
    expect(findCopyButton(wrapper, '复制全部原文')).toBeDefined()
    wrapper.unmount()
  })

  it('does not let the raw A copy timer clear the raw B copy feedback after a switch', async () => {
    stubClipboard()
    const { pending } = installFetchMock()
    const wrapper = await mountDetail()
    await clickReveal(wrapper)
    takePending(pending, RAW_A).resolve()
    await flushPromises()

    vi.useFakeTimers()
    await findCopyButton(wrapper, '复制全部原文').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(findCopyButton(wrapper, '已复制全部')).toBeDefined()

    await vi.advanceTimersByTimeAsync(500)
    await clickRawOption(wrapper, RAW_B)
    await clickReveal(wrapper)
    takePending(pending, RAW_B).resolve()
    await vi.advanceTimersByTimeAsync(0)
    await findCopyButton(wrapper, '复制全部原文').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(findCopyButton(wrapper, '已复制全部')).toBeDefined()

    await vi.advanceTimersByTimeAsync(1100)
    expect(findCopyButton(wrapper, '已复制全部')).toBeDefined()

    await vi.advanceTimersByTimeAsync(500)
    expect(findCopyButton(wrapper, '复制全部原文')).toBeDefined()
    wrapper.unmount()
  })
})

import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import TaskCenterView from './TaskCenterView.vue'

const itemID = '11111111-1111-4111-8111-111111111111'
const modelID = '33333333-3333-4333-8333-333333333333'

describe('task center batch model availability', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('shows an actionable no-model notice with a provider settings link once providers load without usable models', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [disabledProvider()] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') {
        return jsonResponse({ items: [libraryItem()] })
      }
      if (path === '/api/v1/ai/tasks?limit=100') return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountWithRouter(TaskCenterView, '/ai/tasks')

    buttonByText('批量整理').click()
    await nextTick()
    const panel = document.querySelector<HTMLElement>('.batch-panel')
    expect(panel).not.toBeNull()
    expect(panel!.textContent).not.toContain('没有可用模型')

    await flushPromises()
    expect(panel!.textContent).toContain('没有可用模型')
    const link = panel!.querySelector<HTMLAnchorElement>('a[href="/settings/providers"]')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('tabindex')).not.toBe('-1')
    expect(buttonByText('开始批量整理').disabled).toBe(true)
    wrapper.unmount()
  })

  it('keeps the existing error and retry path instead of claiming missing models when the providers read fails', async () => {
    let providerCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') {
        providerCalls += 1
        return jsonResponse({ error: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'Provider 列表读取失败' } }, 503)
      }
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') {
        return jsonResponse({ items: [libraryItem()] })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    const errorNotice = document.querySelector<HTMLElement>('.center-notice--error')
    expect(errorNotice).not.toBeNull()
    expect(errorNotice!.textContent).toContain('Provider 列表读取失败')

    buttonByText('批量整理').click()
    await nextTick()
    const panel = document.querySelector<HTMLElement>('.batch-panel')
    expect(panel).not.toBeNull()
    expect(panel!.textContent).not.toContain('没有可用模型')
    expect(panel!.querySelector('a[href="/settings/providers"]')).toBeNull()

    buttonByText('重新读取').click()
    await flushPromises()
    expect(providerCalls).toBe(2)
    expect(document.querySelector('.center-notice--error')?.textContent).toContain('Provider 列表读取失败')
    wrapper.unmount()
  })
})

async function mountWithRouter(component: object, path: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ai/tasks', name: 'task-center', component: { template: '<div />' } },
      { path: '/items/:itemId', name: 'item-detail', component: { template: '<div />' } },
      { path: '/settings/ai-schedule', name: 'ai-schedule-settings', component: { template: '<div />' } },
      { path: '/settings/providers', name: 'provider-settings', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  return mount(component, { attachTo: document.body, global: { plugins: [pinia, router] } })
}

function disabledProvider() {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    displayName: '已停用 Provider',
    enabled: false,
    models: [
      {
        id: modelID,
        displayName: 'Mock Model',
        modelId: 'mock-model',
        contextWindow: 8192,
        maxOutputTokens: 1024,
        supportsTools: true,
        supportsVision: true,
        enabled: true,
      },
    ],
  }
}

function settings() {
  return {
    sensitiveDisplayMode: 'masked',
    sensitiveAiPolicy: 'block',
    defaultOrganizeModelId: null,
    defaultReviewModelId: null,
    defaultVisionModelId: null,
  }
}

function libraryItem() {
  return {
    id: itemID,
    title: '生产排障记录',
    sensitivity: 'normal',
    favorite: false,
    folderId: null,
    tags: [],
    summary: '摘要',
    createdAt: '2026-08-30T01:00:00Z',
    updatedAt: '2026-08-30T01:00:00Z',
    deletedAt: null,
    effectiveCapturedAt: '2026-08-30T01:00:00Z',
    sourceTimeQuality: 'exact',
    rawRecordCount: 1,
    attachmentCount: 0,
    attachments: [],
  }
}

function buttonByText(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent?.trim().includes(text))
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

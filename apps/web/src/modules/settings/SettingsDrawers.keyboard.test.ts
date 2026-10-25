import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import {
  embeddingSettingsFixtures,
  knowledgeFixtures,
  MOCK_IDS,
} from '../assistant/assistantMocks'
import ProviderSettingsView from './ProviderSettingsView.vue'
import TokenSettingsView from './TokenSettingsView.vue'

const providerWithModel = {
  id: MOCK_IDS.provider,
  providerKey: 'local-mock',
  displayName: '本地 Mock',
  protocol: 'openai-completions',
  baseUrl: 'https://provider.example.test/v1',
  hasApiKey: true,
  apiKeyMask: '•••• 1234',
  enabled: true,
  createdAt: '2026-09-02T03:00:00Z',
  updatedAt: '2026-09-02T03:00:00Z',
  models: [
    {
      id: MOCK_IDS.model,
      providerId: MOCK_IDS.provider,
      modelId: 'mock-model',
      displayName: 'Mock Model',
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsTools: true,
      supportsVision: false,
      enabled: true,
      reasoningOptions: [],
      createdAt: '2026-09-02T03:00:00Z',
      updatedAt: '2026-09-02T03:00:00Z',
    },
  ],
}

describe('SettingsDrawers keyboard: composing Escape must not close drawers', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('provider create drawer keeps the draft through composing Escape and closes only on plain Escape', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) {
        return jsonResponse({ items: [], allowInsecureHttp: false })
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettingsView(ProviderSettingsView, '/settings/providers', 'provider-settings')

    const openButton = findButton('新增 Provider')
    const drawer = await openDrawerFrom(openButton)
    const displayNameInput = drawerFieldInput(drawer, '显示名')
    const draft = '合成显示名草稿'
    await focusAndSetInput(displayNameInput, draft)

    await composingEscapeKeepsDrawer(drawer, displayNameInput, draft, { isComposing: true })
    await composingEscapeKeepsDrawer(drawer, displayNameInput, draft, { isComposing: false, keyCode: 229 })

    pressKey(activeElement(), { key: 'Escape' })
    await flushPromises()

    expect(document.body.contains(drawer)).toBe(false)
    expect(document.querySelector('section[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(openButton)
    expect(mutatingRequestCount(fetchMock)).toBe(0)
    wrapper.unmount()
  })

  it('model edit drawer keeps the draft through composing Escape and closes only on plain Escape', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) {
        return jsonResponse({ items: [structuredClone(providerWithModel)], allowInsecureHttp: false })
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettingsView(ProviderSettingsView, '/settings/providers', 'provider-settings')

    const openButton = document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')
    if (!openButton) throw new Error('button not found: 编辑模型')
    const drawer = await openDrawerFrom(openButton)
    const displayNameInput = drawerFieldInput(drawer, '显示名')
    const draft = '合成模型草稿'
    await focusAndSetInput(displayNameInput, draft)

    await composingEscapeKeepsDrawer(drawer, displayNameInput, draft, { isComposing: true })
    await composingEscapeKeepsDrawer(drawer, displayNameInput, draft, { isComposing: false, keyCode: 229 })

    pressKey(activeElement(), { key: 'Escape' })
    await flushPromises()

    expect(document.body.contains(drawer)).toBe(false)
    expect(document.querySelector('section[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(openButton)
    expect(mutatingRequestCount(fetchMock)).toBe(0)
    wrapper.unmount()
  })

  it('token create drawer keeps the draft through composing Escape and closes only on plain Escape', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/tokens') return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettingsView(TokenSettingsView, '/settings/tokens', 'token-settings')

    const openButton = findButton('创建 Token')
    const drawer = await openDrawerFrom(openButton)
    const nameInput = drawer.querySelector<HTMLInputElement>('input[placeholder*="Notion"]')
    if (!nameInput) throw new Error('drawer input not found: Token 名称（Notion placeholder）')
    const draft = '合成迁移脚本'
    await focusAndSetInput(nameInput, draft)

    await composingEscapeKeepsDrawer(drawer, nameInput, draft, { isComposing: true })
    await composingEscapeKeepsDrawer(drawer, nameInput, draft, { isComposing: false, keyCode: 229 })

    pressKey(activeElement(), { key: 'Escape' })
    await flushPromises()

    expect(document.body.contains(drawer)).toBe(false)
    expect(document.querySelector('section[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(openButton)
    expect(mutatingRequestCount(fetchMock)).toBe(0)
    wrapper.unmount()
  })
})

async function mountSettingsView(component: object, path: string, name: string): Promise<VueWrapper> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test-value'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path, name, component: { template: '<div />' } }],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(component, {
    attachTo: document.body,
    global: { plugins: [pinia, router] },
  })
  await flushPromises()
  return wrapper
}

async function openDrawerFrom(openButton: HTMLButtonElement): Promise<HTMLElement> {
  // jsdom's click() alone does not run focusing steps, so focus the opener
  // first to reproduce a real user whose activeElement is the open button.
  openButton.focus()
  openButton.click()
  await flushPromises()
  const drawer = document.querySelector<HTMLElement>('section.settings-drawer[role="dialog"]')
  if (!drawer) throw new Error('settings drawer not open')
  return drawer
}

function drawerFieldInput(drawer: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(drawer.querySelectorAll<HTMLLabelElement>('label.settings-field')).find(
    (entry) => entry.querySelector('span')?.textContent?.trim() === labelText,
  )
  const input = label?.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error(`drawer input not found: ${labelText}`)
  return input
}

async function focusAndSetInput(input: HTMLInputElement, draft: string) {
  input.focus()
  input.value = draft
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
  expect(document.activeElement).toBe(input)
}

async function composingEscapeKeepsDrawer(
  drawer: HTMLElement,
  input: HTMLInputElement,
  draft: string,
  init: { isComposing: boolean; keyCode?: number },
) {
  pressKey(activeElement(), { key: 'Escape', ...init })
  await flushPromises()
  expect(document.body.contains(drawer)).toBe(true)
  expect(input.value).toBe(draft)
}

function activeElement(): HTMLElement {
  const element = document.activeElement
  if (!element) throw new Error('no active element')
  return element as HTMLElement
}

function pressKey(target: Element, init: KeyboardEventInit & { keyCode?: number }) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

function mutatingRequestCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const path = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    return method === 'POST' || method === 'PATCH' || method === 'DELETE' || path.includes('/test')
  }).length
}

function findButton(text: string, root: ParentNode = document): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (entry) => entry.textContent?.trim() === text,
  )
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

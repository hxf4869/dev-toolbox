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

const createdProviderEntry = {
  id: '55555555-5555-4555-8555-555555555555',
  providerKey: 'synthetic-only',
  displayName: '合成 Provider',
  protocol: 'openai-completions',
  baseUrl: 'https://provider.example.test/v1',
  hasApiKey: true,
  apiKeyMask: '•••• NTHC',
  enabled: true,
  createdAt: '2026-10-22T03:00:00Z',
  updatedAt: '2026-10-22T03:00:00Z',
  models: [],
}

const providerWithReasoning = {
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
      reasoningOptions: [
        { displayName: '简短', reasoning: 'low', sortOrder: 0 },
        { displayName: '深入', reasoning: 'high', sortOrder: 10 },
      ],
      createdAt: '2026-09-02T03:00:00Z',
      updatedAt: '2026-09-02T03:00:00Z',
    },
  ],
}

const syntheticTokenEntry = {
  id: '44444444-4444-4444-8444-444444444444',
  name: '合成迁移脚本',
  tokenPrefix: 'dtb_pat_syntheti',
  scopes: ['records:read'],
  createdAt: '2026-10-22T03:00:00Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

describe('SettingsDrawers saving: drafts must stay locked while a save request is in flight', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('provider create drawer locks the draft during the controlled POST and closes after 201', async () => {
    let providerCreated = false
    let postBody: Record<string, unknown> | undefined
    const gate = deferred<Response>()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && init?.method === 'POST') {
        postBody = JSON.parse(String(init.body))
        return gate.promise
      }
      if (path === '/api/v1/ai/providers' && !init?.method) {
        return jsonResponse(
          providerCreated
            ? { items: [structuredClone(createdProviderEntry)], allowInsecureHttp: false }
            : { items: [], allowInsecureHttp: false },
        )
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettingsView(ProviderSettingsView, '/settings/providers', 'provider-settings')

    const drawer = await openDrawerFrom(findButton('新增 Provider'))
    await focusAndSetInput(drawerFieldInput(drawer, '稳定 Provider Key'), 'synthetic-only')
    await focusAndSetInput(drawerFieldInput(drawer, '显示名'), '合成 Provider')
    await focusAndSetInput(drawerFieldInput(drawer, 'Base URL'), 'https://provider.example.test/v1')
    await focusAndSetInput(drawerFieldInput(drawer, 'API Key'), 'SYNTHETIC_ONLY_PROVIDER_KEY')

    const saveButton = findButton('保存 Provider', drawer)
    saveButton.focus()
    saveButton.click()
    await flushPromises()

    const providerKeyInput = drawerFieldInput(drawer, '稳定 Provider Key')
    expect(providerKeyInput.readOnly).toBe(true)
    expect(drawerFieldInput(drawer, '显示名').readOnly).toBe(true)
    expect(drawerFieldInput(drawer, 'Base URL').readOnly).toBe(true)
    expect(drawerFieldInput(drawer, 'API Key').readOnly).toBe(true)
    expect(drawer.querySelector<HTMLSelectElement>('select')!.disabled).toBe(true)
    const enabledCheckbox = drawer.querySelector<HTMLInputElement>('label.settings-check input[type="checkbox"]')
    if (!enabledCheckbox) throw new Error('provider drawer enabled checkbox not found')
    expect(enabledCheckbox.disabled).toBe(true)
    expect(drawer.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.disabled).toBe(true)
    expect(findButton('取消', drawer).disabled).toBe(true)
    const submitButton = drawer.querySelector<HTMLButtonElement>('footer button[type="submit"]')
    if (!submitButton) throw new Error('provider drawer submit button not found')
    expect(submitButton.disabled).toBe(true)
    expect(submitButton.textContent?.trim()).toBe('正在保存…')
    expect(document.activeElement).toBe(providerKeyInput)
    expect(mutatingRequestCount(fetchMock)).toBe(1)
    expect(postBody).toEqual({
      providerKey: 'synthetic-only',
      displayName: '合成 Provider',
      protocol: 'openai-completions',
      baseUrl: 'https://provider.example.test/v1',
      apiKey: 'SYNTHETIC_ONLY_PROVIDER_KEY',
      enabled: true,
      models: [],
    })

    providerCreated = true
    gate.resolve(jsonResponse(createdProviderEntry, 201))
    await flushPromises()
    await flushPromises()

    expect(document.querySelector('section.settings-drawer[role="dialog"]')).toBeNull()
    expect(mutatingRequestCount(fetchMock)).toBe(1)
    expect(document.body.textContent).toContain('合成 Provider')
    wrapper.unmount()
  })

  it('model edit drawer locks every field and reasoning row during the controlled PATCH and restores the exact draft after an explicit 422', async () => {
    let patchBody: Record<string, unknown> | undefined
    const gate = deferred<Response>()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === `/api/v1/ai/models/${MOCK_IDS.model}` && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body))
        return gate.promise
      }
      if (path === '/api/v1/ai/providers' && !init?.method) {
        return jsonResponse({ items: [structuredClone(providerWithReasoning)], allowInsecureHttp: false })
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettingsView(ProviderSettingsView, '/settings/providers', 'provider-settings')

    const editButton = document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')
    if (!editButton) throw new Error('button not found: 编辑模型')
    const drawer = await openDrawerFrom(editButton)
    await focusAndSetInput(drawerFieldInput(drawer, '显示名'), '合成模型草稿')

    const saveButton = findButton('保存模型', drawer)
    saveButton.focus()
    saveButton.click()
    await flushPromises()

    const modelIdInput = drawerFieldInput(drawer, '上游模型 ID')
    expect(modelIdInput.readOnly).toBe(true)
    expect(drawerFieldInput(drawer, '显示名').readOnly).toBe(true)
    expect(drawerFieldInput(drawer, '上下文窗口').readOnly).toBe(true)
    expect(drawerFieldInput(drawer, '最大输出 Token').readOnly).toBe(true)
    const rows = Array.from(drawer.querySelectorAll<HTMLElement>('.reasoning-editor__row'))
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.querySelector<HTMLInputElement>('input')!.readOnly).toBe(true)
      expect(row.querySelector<HTMLSelectElement>('select')!.disabled).toBe(true)
      for (const title of ['上移', '下移', '删除档位']) {
        expect(row.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!.disabled).toBe(true)
      }
    }
    expect(findButton('添加思考档位', drawer).disabled).toBe(true)
    for (const checkbox of capabilityCheckboxes(drawer)) {
      expect(checkbox.disabled).toBe(true)
    }
    expect(drawer.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.disabled).toBe(true)
    expect(findButton('取消', drawer).disabled).toBe(true)
    const submitButton = drawer.querySelector<HTMLButtonElement>('footer button[type="submit"]')
    if (!submitButton) throw new Error('model drawer submit button not found')
    expect(submitButton.disabled).toBe(true)
    expect(submitButton.textContent?.trim()).toBe('正在保存…')
    expect(document.activeElement).toBe(modelIdInput)
    rows[0]!.querySelector<HTMLButtonElement>('button[title="下移"]')!.click()
    await flushPromises()
    expect(
      Array.from(drawer.querySelectorAll<HTMLElement>('.reasoning-editor__row')).map(
        (row) => row.querySelector<HTMLInputElement>('input')!.value,
      ),
    ).toEqual(['简短', '深入'])
    expect(mutatingRequestCount(fetchMock)).toBe(1)
    expect(patchBody).toEqual({
      modelId: 'mock-model',
      displayName: '合成模型草稿',
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsTools: true,
      supportsVision: false,
      enabled: true,
      reasoningOptions: [
        { displayName: '简短', reasoning: 'low', sortOrder: 0 },
        { displayName: '深入', reasoning: 'high', sortOrder: 10 },
      ],
    })

    gate.resolve(jsonResponse({ error: { code: 'AI_MODEL_INVALID', message: '合成 422：模型配置被拒绝' } }, 422))
    await flushPromises()

    expect(document.querySelector('section.settings-drawer[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('合成 422：模型配置被拒绝')
    expect(drawerFieldInput(drawer, '显示名').value).toBe('合成模型草稿')
    const settledRows = Array.from(drawer.querySelectorAll<HTMLElement>('.reasoning-editor__row'))
    expect(settledRows.map((row) => row.querySelector<HTMLInputElement>('input')!.value)).toEqual(['简短', '深入'])
    expect(drawerFieldInput(drawer, '上游模型 ID').readOnly).toBe(false)
    expect(drawerFieldInput(drawer, '显示名').readOnly).toBe(false)
    expect(drawerFieldInput(drawer, '上下文窗口').readOnly).toBe(false)
    expect(drawerFieldInput(drawer, '最大输出 Token').readOnly).toBe(false)
    for (const row of settledRows) {
      expect(row.querySelector<HTMLInputElement>('input')!.readOnly).toBe(false)
      expect(row.querySelector<HTMLSelectElement>('select')!.disabled).toBe(false)
      expect(row.querySelector<HTMLButtonElement>('button[title="删除档位"]')!.disabled).toBe(false)
    }
    for (const checkbox of capabilityCheckboxes(drawer)) {
      expect(checkbox.disabled).toBe(false)
    }
    expect(findButton('添加思考档位', drawer).disabled).toBe(false)
    expect(settledRows[0]!.querySelector<HTMLButtonElement>('button[title="上移"]')!.disabled).toBe(true)
    expect(settledRows[0]!.querySelector<HTMLButtonElement>('button[title="下移"]')!.disabled).toBe(false)
    expect(settledRows[1]!.querySelector<HTMLButtonElement>('button[title="上移"]')!.disabled).toBe(false)
    expect(settledRows[1]!.querySelector<HTMLButtonElement>('button[title="下移"]')!.disabled).toBe(true)
    expect(drawer.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.disabled).toBe(false)
    expect(findButton('取消', drawer).disabled).toBe(false)
    expect(drawer.querySelector<HTMLButtonElement>('footer button[type="submit"]')!.disabled).toBe(false)
    expect(mutatingRequestCount(fetchMock)).toBe(1)
    wrapper.unmount()
  })

  it('token create drawer locks during POST, keeps the draft after 422, and the explicit retry hands focus to the issued plaintext then back to the opener', async () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      let tokenCreated = false
      let postCount = 0
      const gate = deferred<Response>()
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path === '/api/v1/tokens' && init?.method === 'POST') {
          postCount += 1
          if (postCount === 1) return gate.promise
          tokenCreated = true
          return jsonResponse(
            {
              id: syntheticTokenEntry.id,
              name: syntheticTokenEntry.name,
              tokenPrefix: syntheticTokenEntry.tokenPrefix,
              scopes: syntheticTokenEntry.scopes,
              createdAt: syntheticTokenEntry.createdAt,
              expiresAt: null,
              token: 'SYNTHETIC_ONLY_PAT_PLAINTEXT',
            },
            201,
          )
        }
        if (path === '/api/v1/tokens') {
          return jsonResponse(tokenCreated ? { items: [structuredClone(syntheticTokenEntry)] } : { items: [] })
        }
        throw new Error(`unexpected request: ${path}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const wrapper = await mountSettingsView(TokenSettingsView, '/settings/tokens', 'token-settings')

      const openButton = findButton('创建 Token')
      const drawer = await openDrawerFrom(openButton)
      const nameInput = drawer.querySelector<HTMLInputElement>('input[placeholder*="Notion"]')
      if (!nameInput) throw new Error('drawer input not found: Token 名称（Notion placeholder）')
      await focusAndSetInput(nameInput, '合成迁移脚本')

      const submitButton = findButton('创建并显示一次', drawer)
      submitButton.focus()
      submitButton.click()
      await flushPromises()

      expect(nameInput.readOnly).toBe(true)
      const expiresInput = drawer.querySelector<HTMLInputElement>('input[type="datetime-local"]')
      if (!expiresInput) throw new Error('drawer input not found: 到期时间 datetime-local')
      expect(expiresInput.disabled).toBe(true)
      const scopeBoxes = Array.from(drawer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      expect(scopeBoxes).toHaveLength(6)
      for (const box of scopeBoxes) {
        expect(box.disabled).toBe(true)
      }
      expect(drawer.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.disabled).toBe(true)
      expect(findButton('取消', drawer).disabled).toBe(true)
      const pendingSubmit = drawer.querySelector<HTMLButtonElement>('footer button[type="submit"]')
      if (!pendingSubmit) throw new Error('token drawer submit button not found')
      expect(pendingSubmit.disabled).toBe(true)
      expect(pendingSubmit.textContent?.trim()).toBe('正在创建…')
      expect(document.activeElement).toBe(nameInput)
      expect(postCount).toBe(1)

      gate.resolve(jsonResponse({ error: { code: 'TOKEN_INVALID', message: '合成 422：Token 名称被拒绝' } }, 422))
      await flushPromises()

      expect(document.querySelector('section.settings-drawer[role="dialog"]')).not.toBeNull()
      expect(document.body.textContent).toContain('合成 422：Token 名称被拒绝')
      expect(nameInput.value).toBe('合成迁移脚本')
      expect(nameInput.readOnly).toBe(false)
      expect(drawer.querySelector<HTMLInputElement>('input[type="datetime-local"]')!.disabled).toBe(false)
      for (const box of drawer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        expect(box.disabled).toBe(false)
      }
      expect(drawer.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.disabled).toBe(false)
      expect(findButton('取消', drawer).disabled).toBe(false)
      expect(drawer.querySelector<HTMLButtonElement>('footer button[type="submit"]')!.disabled).toBe(false)
      expect(postCount).toBe(1)

      const retryButton = findButton('创建并显示一次', drawer)
      retryButton.focus()
      retryButton.click()
      await flushPromises()
      await flushPromises()

      expect(document.querySelector('section.settings-drawer[role="dialog"]')).toBeNull()
      expect(document.querySelector('#issued-token-title')).not.toBeNull()
      const plaintextInput = document.querySelector<HTMLInputElement>('input[readonly]')
      if (!plaintextInput) throw new Error('issued plaintext input not found')
      expect(plaintextInput.value).toBe('SYNTHETIC_ONLY_PAT_PLAINTEXT')
      expect(document.activeElement).toBe(plaintextInput)
      expect(plaintextInput.selectionStart).toBe(0)
      expect(plaintextInput.selectionEnd).toBe('SYNTHETIC_ONLY_PAT_PLAINTEXT'.length)
      expect(postCount).toBe(2)
      expect(writeText).not.toHaveBeenCalled()

      findButton('我已安全保存').click()
      await flushPromises()

      expect(document.body.textContent).not.toContain('SYNTHETIC_ONLY_PAT_PLAINTEXT')
      expect(document.querySelector('input[readonly]')).toBeNull()
      expect(document.activeElement).toBe(openButton)
      expect(writeText).not.toHaveBeenCalled()
      wrapper.unmount()
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
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

function capabilityCheckboxes(drawer: HTMLElement): HTMLInputElement[] {
  const fieldset = Array.from(drawer.querySelectorAll<HTMLFieldSetElement>('fieldset')).find(
    (entry) => entry.querySelector('legend')?.textContent?.trim() === '模型能力',
  )
  if (!fieldset) throw new Error('capability fieldset not found: 模型能力')
  const boxes = Array.from(fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
  if (boxes.length !== 3) throw new Error(`capability checkboxes not 3: ${boxes.length}`)
  return boxes
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

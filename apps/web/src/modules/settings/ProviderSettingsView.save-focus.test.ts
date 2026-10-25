import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import { embeddingSettingsFixtures, knowledgeFixtures, MOCK_IDS } from '../assistant/assistantMocks'
import ProviderSettingsView from './ProviderSettingsView.vue'

const ISO = '2026-10-20T08:00:00Z'
const LEADING_PROVIDER_ID = '99999999-9999-4999-8999-999999999999'
const LEADING_MODEL_ID = '3f3f3f3f-3f3f-43f3-83f3-3f3f3f3f3f3f'

const leadingProviderFixture = {
  id: LEADING_PROVIDER_ID,
  providerKey: 'leading-mock',
  displayName: '前置 Provider',
  protocol: 'openai-completions',
  baseUrl: 'https://provider.example.test/v1',
  hasApiKey: true,
  apiKeyMask: '•••• 5678',
  enabled: true,
  createdAt: ISO,
  updatedAt: ISO,
  models: [
    {
      id: '5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e5e',
      providerId: LEADING_PROVIDER_ID,
      modelId: 'leading-provider-model',
      displayName: '前置 Provider 模型',
      contextWindow: 4096,
      maxOutputTokens: 512,
      supportsTools: false,
      supportsVision: false,
      enabled: true,
      reasoningOptions: [],
      createdAt: ISO,
      updatedAt: ISO,
    },
  ],
}

const leadingModelFixture = {
  id: LEADING_MODEL_ID,
  providerId: MOCK_IDS.provider,
  modelId: 'leading-model',
  displayName: '前置模型',
  contextWindow: 4096,
  maxOutputTokens: 512,
  supportsTools: false,
  supportsVision: false,
  enabled: true,
  reasoningOptions: [],
  createdAt: ISO,
  updatedAt: ISO,
}

const targetModelFixture = {
  id: MOCK_IDS.model,
  providerId: MOCK_IDS.provider,
  modelId: 'target-model',
  displayName: '目标模型',
  contextWindow: 8192,
  maxOutputTokens: 1024,
  supportsTools: true,
  supportsVision: false,
  enabled: true,
  reasoningOptions: [],
  createdAt: ISO,
  updatedAt: ISO,
}

const targetProviderFixture = {
  id: MOCK_IDS.provider,
  providerKey: 'target-mock',
  displayName: '目标 Provider',
  protocol: 'openai-completions',
  baseUrl: 'https://provider.example.test/v1',
  hasApiKey: true,
  apiKeyMask: '•••• 1234',
  enabled: true,
  createdAt: ISO,
  updatedAt: ISO,
  models: [leadingModelFixture, targetModelFixture],
}

function initialProviders() {
  return [structuredClone(leadingProviderFixture), structuredClone(targetProviderFixture)]
}

function providersAfterProviderRename() {
  const items = initialProviders()
  const target = items.find((entry) => entry.id === MOCK_IDS.provider)
  if (!target) throw new Error('fixture broken: target provider missing')
  target.displayName = '目标 Provider 已改名'
  return items
}

function providersAfterModelRename() {
  const items = initialProviders()
  const target = items.find((entry) => entry.id === MOCK_IDS.provider)
  if (!target) throw new Error('fixture broken: target provider missing')
  const model = target.models.find((entry) => entry.id === MOCK_IDS.model)
  if (!model) throw new Error('fixture broken: target model missing')
  model.displayName = '目标模型 已改名'
  return items
}

let activeWrapper: VueWrapper | null = null

describe('ProviderSettingsView save focus baseline: where focus lands after the fresh list GET rebuilds cards', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    // 失败的断言会让 case 在末尾之前中断，所以统一在这里卸载组件并恢复 fetch stub。
    activeWrapper?.unmount()
    activeWrapper = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('provider edit save rebuilds the target card after the gated refresh GET and focus must return to the new card edit button', async () => {
    const h = stubSettingsFetch()
    await mountSettingsView()

    const card = providerCard('目标 Provider')
    const editButton = findButton('编辑与替换密钥', card)
    const drawer = await openDrawerFrom(editButton)
    expect(drawer.querySelector('#provider-editor-title')?.textContent?.trim()).toBe('编辑 Provider')

    await focusAndSetInput(drawerFieldInput(drawer, '显示名'), '目标 Provider 已改名')

    const saveButton = findButton('保存 Provider', drawer)
    saveButton.focus()
    saveButton.click()
    await flushPromises()
    await flushPromises()

    // 装置有效性：保存 PATCH 已发出，旧卡片因 loading 卸载，刷新 GET 仍挂起。
    expect(editButton.isConnected).toBe(false)
    expect(document.querySelector('section.settings-drawer[role="dialog"]')).toBeNull()
    expect(document.querySelector('.settings-loading')).not.toBeNull()
    expect(mutatingRequestCount(h.fetchMock)).toBe(1)
    expect(h.providerPatchBody()).toEqual({
      displayName: '目标 Provider 已改名',
      protocol: 'openai-completions',
      baseUrl: 'https://provider.example.test/v1',
      enabled: true,
    })

    h.gate.resolve(jsonResponse({ items: providersAfterProviderRename(), allowInsecureHttp: false }))
    await flushPromises()
    await flushPromises()

    expect(document.querySelector('.settings-loading')).toBeNull()
    const newCard = providerCard('目标 Provider 已改名')
    const newEditButton = findButton('编辑与替换密钥', newCard)
    expect(newEditButton).not.toBe(editButton)
    expect(newEditButton.isConnected).toBe(true)
    expect(document.activeElement, describeActive()).toBe(newEditButton)
    expect(mutatingRequestCount(h.fetchMock)).toBe(1)
  })

  it('model edit save rebuilds the target row after the gated refresh GET and focus must return to the new row edit button', async () => {
    const h = stubSettingsFetch()
    await mountSettingsView()

    const card = providerCard('目标 Provider')
    const row = modelRow(card, 'target-model')
    const editButton = row.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')
    if (!editButton) throw new Error('button not found: 编辑模型')
    const drawer = await openDrawerFrom(editButton)
    expect(drawer.querySelector('#model-editor-title')?.textContent?.trim()).toBe('编辑模型')
    expect(drawer.querySelector('.settings-kicker')?.textContent?.trim()).toBe('目标 Provider')

    await focusAndSetInput(drawerFieldInput(drawer, '显示名'), '目标模型 已改名')

    const saveButton = findButton('保存模型', drawer)
    saveButton.focus()
    saveButton.click()
    await flushPromises()
    await flushPromises()

    // 装置有效性：模型 PATCH 已发出，旧行随整卡卸载，刷新 GET 仍挂起。
    expect(editButton.isConnected).toBe(false)
    expect(document.querySelector('section.settings-drawer[role="dialog"]')).toBeNull()
    expect(document.querySelector('.settings-loading')).not.toBeNull()
    expect(mutatingRequestCount(h.fetchMock)).toBe(1)
    expect(h.modelPatchBody()).toEqual({
      modelId: 'target-model',
      displayName: '目标模型 已改名',
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsTools: true,
      supportsVision: false,
      enabled: true,
      reasoningOptions: [],
    })

    h.gate.resolve(jsonResponse({ items: providersAfterModelRename(), allowInsecureHttp: false }))
    await flushPromises()
    await flushPromises()

    expect(document.querySelector('.settings-loading')).toBeNull()
    const newRow = modelRow(providerCard('目标 Provider'), 'target-model')
    expect(newRow.querySelector('strong')?.textContent?.trim()).toBe('目标模型 已改名')
    const newEditButton = newRow.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')
    if (!newEditButton) throw new Error('button not found: 编辑模型（重建后的行）')
    expect(newEditButton).not.toBe(editButton)
    expect(newEditButton.isConnected).toBe(true)
    expect(document.activeElement, describeActive()).toBe(newEditButton)
    expect(mutatingRequestCount(h.fetchMock)).toBe(1)
  })

  it('guard: provider create drawer opened while the post-save refresh GET is pending keeps its readonly focus, unlocks after the GET settles, and only then takes a draft', async () => {
    const h = stubSettingsFetch()
    await mountSettingsView()

    const card = providerCard('目标 Provider')
    const editButton = findButton('编辑与替换密钥', card)
    const drawer = await openDrawerFrom(editButton)
    await focusAndSetInput(drawerFieldInput(drawer, '显示名'), '目标 Provider 已改名')
    const saveButton = findButton('保存 Provider', drawer)
    saveButton.focus()
    saveButton.click()
    await flushPromises()
    await flushPromises()

    expect(editButton.isConnected).toBe(false)
    expect(document.querySelector('section.settings-drawer[role="dialog"]')).toBeNull()
    expect(document.querySelector('.settings-loading')).not.toBeNull()
    expect(mutatingRequestCount(h.fetchMock)).toBe(1)

    const addButton = findButton('新增 Provider')
    expect(addButton.disabled).toBe(false)
    expect(addButton.isConnected).toBe(true)
    const bDrawer = await openDrawerFrom(addButton)
    expect(bDrawer.querySelector('#provider-editor-title')?.textContent?.trim()).toBe('新增 Provider')

    // 刷新 GET 完成前 busy 仍为 true，B 的输入框是 readonly：真实用户只能聚焦、不能键入，
    // 所以这里只 focus，不赋值也不派发 input；草稿要等解锁后再录入。
    const bInput = drawerFieldInput(bDrawer, '显示名')
    expect(bInput.readOnly).toBe(true)
    expect(bInput.value).toBe('')
    bInput.focus()
    await flushPromises()
    expect(document.activeElement).toBe(bInput)

    h.gate.resolve(jsonResponse({ items: providersAfterProviderRename(), allowInsecureHttp: false }))
    await flushPromises()
    await flushPromises()

    expect(document.body.contains(bDrawer)).toBe(true)
    expect(document.querySelector('section.settings-drawer[role="dialog"]')).toBe(bDrawer)
    expect(bDrawer.querySelector('#provider-editor-title')?.textContent?.trim()).toBe('新增 Provider')
    expect(document.activeElement, describeActive()).toBe(bInput)
    expect(bInput.readOnly).toBe(false)
    expect(providerCard('目标 Provider 已改名').isConnected).toBe(true)

    await focusAndSetInput(bInput, 'B 草稿 Provider')
    expect(bInput.value).toBe('B 草稿 Provider')
    expect(document.querySelector('section.settings-drawer[role="dialog"]')).toBe(bDrawer)
    expect(mutatingRequestCount(h.fetchMock)).toBe(1)
  })
})

const reasoningProviderFixture = {
  id: MOCK_IDS.provider,
  providerKey: 'reasoning-mock',
  displayName: '档位 Provider',
  protocol: 'openai-completions',
  baseUrl: 'https://provider.example.test/v1',
  hasApiKey: true,
  apiKeyMask: '•••• 1234',
  enabled: true,
  createdAt: ISO,
  updatedAt: ISO,
  models: [
    {
      id: MOCK_IDS.model,
      providerId: MOCK_IDS.provider,
      modelId: 'reasoning-model',
      displayName: '档位模型',
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsTools: true,
      supportsVision: false,
      enabled: true,
      reasoningOptions: [
        { reasoning: 'low', displayName: '低', sortOrder: 10 },
        { reasoning: 'minimal', displayName: '最小', sortOrder: 20 },
      ],
      createdAt: ISO,
      updatedAt: ISO,
    },
  ],
}

describe('ProviderSettingsView reasoning editor focus: add/move/delete keeps a valid focused control so Escape still closes', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('add moves focus to the new row display-name input, including the 6th row whose add button just disabled', async () => {
    const h = stubReasoningFetch()
    await mountSettingsView()

    const editButton = document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')
    if (!editButton) throw new Error('button not found: 编辑模型')
    const drawer = await openDrawerFrom(editButton)
    expect(reasoningRows().length).toBe(2)

    const addButton = findButton('添加思考档位', drawer)
    addButton.focus()
    addButton.click()
    await flushPromises()

    expect(reasoningRows().length).toBe(3)
    expect(document.activeElement, describeActive()).toBe(reasoningRow('medium').querySelector('input'))

    addButton.click()
    addButton.click()
    addButton.click()
    await flushPromises()

    expect(reasoningRows().length).toBe(6)
    expect(addButton.disabled).toBe(true)
    expect(document.activeElement, describeActive()).toBe(reasoningRow('max').querySelector('input'))

    await escapeFromActiveClosesDrawer(drawer, editButton)
    expect(mutatingRequestCount(h.fetchMock)).toBe(0)
  })

  it('moving the second row up to the first keeps focus on that row, not on its now-disabled up button', async () => {
    const h = stubReasoningFetch()
    await mountSettingsView()

    const editButton = document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')
    if (!editButton) throw new Error('button not found: 编辑模型')
    const drawer = await openDrawerFrom(editButton)

    const upButton = rowActionButton(reasoningRow('minimal'), 0)
    upButton.focus()
    upButton.click()
    await flushPromises()

    const movedRow = reasoningRow('minimal')
    expect(reasoningRows()[0]).toBe(movedRow)
    expect(rowActionButton(movedRow, 0).disabled).toBe(true)
    expect(document.activeElement, describeActive()).toBe(movedRow.querySelector('input'))

    await escapeFromActiveClosesDrawer(drawer, editButton)
    expect(mutatingRequestCount(h.fetchMock)).toBe(0)
  })

  it('deleting the first row focuses the row that took its place; Escape from that input closes the drawer', async () => {
    const h = stubReasoningFetch()
    await mountSettingsView()

    const editButton = document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')
    if (!editButton) throw new Error('button not found: 编辑模型')
    const drawer = await openDrawerFrom(editButton)

    const deleteButton = rowActionButton(reasoningRow('low'), 2)
    deleteButton.focus()
    deleteButton.click()
    await flushPromises()

    expect(reasoningRows().length).toBe(1)
    const remainingRow = reasoningRow('minimal')
    expect(document.activeElement, describeActive()).toBe(remainingRow.querySelector('input'))

    await escapeFromActiveClosesDrawer(drawer, editButton)
    expect(mutatingRequestCount(h.fetchMock)).toBe(0)
  })

  it('deleting the last remaining row focuses the add button; Escape from it closes the drawer', async () => {
    const h = stubReasoningFetch()
    await mountSettingsView()

    const editButton = document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')
    if (!editButton) throw new Error('button not found: 编辑模型')
    const drawer = await openDrawerFrom(editButton)

    const minimalDeleteButton = rowActionButton(reasoningRow('minimal'), 2)
    minimalDeleteButton.focus()
    minimalDeleteButton.click()
    await flushPromises()
    const lowDeleteButton = rowActionButton(reasoningRow('low'), 2)
    lowDeleteButton.focus()
    lowDeleteButton.click()
    await flushPromises()

    expect(reasoningRows().length).toBe(0)
    const addButton = findButton('添加思考档位', drawer)
    expect(addButton.disabled).toBe(false)
    expect(document.activeElement, describeActive()).toBe(addButton)

    await escapeFromActiveClosesDrawer(drawer, editButton)
    expect(mutatingRequestCount(h.fetchMock)).toBe(0)
  })
})

async function escapeFromActiveClosesDrawer(drawer: HTMLElement, opener: HTMLButtonElement) {
  // 只从当前 activeElement 派发 Escape：真实用户的按键路径经过焦点元素冒泡到 dialog keydown；
  // 焦点已落在 body 或被卸载元素时，这条路径才是唯一能暴露失效的方式。
  const active = document.activeElement
  if (!(active instanceof Element)) throw new Error('no active element to dispatch Escape from')
  active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flushPromises()
  expect(document.body.contains(drawer)).toBe(false)
  expect(document.querySelector('section.settings-drawer[role="dialog"]')).toBeNull()
  expect(document.activeElement, describeActive()).toBe(opener)
}

function stubReasoningFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/v1/ai/providers' && !init?.method) {
      return jsonResponse({ items: [structuredClone(reasoningProviderFixture)], allowInsecureHttp: false })
    }
    if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
    if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
    if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
    throw new Error(`unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock }
}

function reasoningRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.reasoning-editor__row'))
}

function reasoningRow(reasoning: string): HTMLElement {
  const row = reasoningRows().find((entry) => entry.querySelector('select')?.value === reasoning)
  if (!row) throw new Error(`reasoning row not found: ${reasoning}`)
  return row
}

function rowActionButton(row: HTMLElement, index: 0 | 1 | 2): HTMLButtonElement {
  // 行内按钮顺序与模板一致：上移、下移、删除。
  const button = row.querySelectorAll<HTMLButtonElement>('.reasoning-editor__actions button')[index]
  if (!button) throw new Error(`row action button not found: index ${index}`)
  return button
}

function stubSettingsFetch() {
  const gate = deferred<Response>()
  let providerListGetCount = 0
  let providerPatchBody: Record<string, unknown> | undefined
  let modelPatchBody: Record<string, unknown> | undefined
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === `/api/v1/ai/providers/${MOCK_IDS.provider}` && init?.method === 'PATCH') {
      providerPatchBody = JSON.parse(String(init.body))
      const updated = structuredClone(targetProviderFixture)
      updated.displayName = '目标 Provider 已改名'
      return jsonResponse(updated)
    }
    if (path === `/api/v1/ai/models/${MOCK_IDS.model}` && init?.method === 'PATCH') {
      modelPatchBody = JSON.parse(String(init.body))
      const updated = structuredClone(targetModelFixture)
      updated.displayName = '目标模型 已改名'
      return jsonResponse(updated)
    }
    if (path === '/api/v1/ai/providers' && !init?.method) {
      providerListGetCount += 1
      // 第 1 次 GET 是 mount 读取；第 2 次是保存后的刷新，用 gate 由测试显式放行。
      if (providerListGetCount === 1) {
        return jsonResponse({ items: initialProviders(), allowInsecureHttp: false })
      }
      return gate.promise
    }
    if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
    if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
    if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
    throw new Error(`unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    gate,
    providerPatchBody: () => providerPatchBody,
    modelPatchBody: () => modelPatchBody,
  }
}

async function mountSettingsView(): Promise<void> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test-value'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/providers', name: 'provider-settings', component: { template: '<div />' } },
    ],
  })
  await router.push('/settings/providers')
  await router.isReady()
  activeWrapper = mount(ProviderSettingsView, {
    attachTo: document.body,
    global: { plugins: [pinia, router] },
  })
  await flushPromises()
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

function providerCard(displayName: string): HTMLElement {
  const card = Array.from(document.querySelectorAll<HTMLElement>('article.provider-card')).find(
    (entry) => entry.querySelector('h3')?.textContent?.trim() === displayName,
  )
  if (!card) throw new Error(`provider card not found: ${displayName}`)
  return card
}

function modelRow(card: HTMLElement, modelId: string): HTMLElement {
  const row = Array.from(card.querySelectorAll<HTMLElement>('tbody tr')).find(
    (entry) => entry.querySelector('code')?.textContent?.trim() === modelId,
  )
  if (!row) throw new Error(`model row not found: ${modelId}`)
  return row
}

function describeActive(): string {
  const active = document.activeElement
  if (!active) return 'activeElement: null'
  if (active === document.body) return 'activeElement: <body>'
  const element = active as HTMLElement
  const tag = element.tagName.toLowerCase()
  let label = element.getAttribute('aria-label') ?? ''
  if (!label && element instanceof HTMLInputElement) label = element.value
  if (!label) label = (element.textContent ?? '').trim()
  return `activeElement: <${tag}> "${label.slice(0, 40)}" connected=${element.isConnected}`
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

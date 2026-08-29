import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import AISecuritySettingsView from './AISecuritySettingsView.vue'
import ProviderSettingsView from './ProviderSettingsView.vue'
import TokenSettingsView from './TokenSettingsView.vue'

const provider = {
  id: '11111111-1111-4111-8111-111111111111',
  providerKey: 'local-mock',
  displayName: '本地 Mock',
  protocol: 'openai-completions',
  baseUrl: 'https://provider.example.test/v1',
  hasApiKey: true,
  apiKeyMask: '•••• 1234',
  enabled: true,
  createdAt: '2026-08-30T01:00:00Z',
  updatedAt: '2026-08-30T01:00:00Z',
  models: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      providerId: '11111111-1111-4111-8111-111111111111',
      modelId: 'mock-model',
      displayName: 'Mock Model',
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsTools: true,
      supportsVision: true,
      enabled: true,
      createdAt: '2026-08-30T01:00:00Z',
      updatedAt: '2026-08-30T01:00:00Z',
    },
  ],
}

describe('M3 settings surfaces', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('keeps Provider connection outcomes as page states and sends only the saved model ID', async () => {
    let testCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) {
        return jsonResponse({ items: [provider], allowInsecureHttp: false })
      }
      if (path.endsWith('/test')) {
        testCalls += 1
        if (testCalls === 1) {
          return jsonResponse({
            status: 'ok',
            latencyMs: 12,
            usage: { inputTokens: 1, outputTokens: 1 },
          })
        }
        return jsonResponse(
          { error: { code: 'AI_PROVIDER_CREDENTIALS_INVALID', message: 'Provider 凭据被拒绝' } },
          422,
        )
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettings(ProviderSettingsView, '/settings/providers')
    await flushPromises()

    buttonByText('测试连接').click()
    await flushPromises()
    expect(document.body.textContent).toContain('连接成功 · 12 ms')
    const firstTest = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/test'))
    expect(JSON.parse(String((firstTest?.[1] as RequestInit).body))).toEqual({ modelId: provider.models[0].id })

    buttonByText('测试连接').click()
    await flushPromises()
    expect(document.body.textContent).toContain('凭据被 Provider 拒绝，请替换 API Key')
    wrapper.unmount()
  })

  it('sends cleared model limits as explicit null values', async () => {
    let patchBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) {
        return jsonResponse({ items: [provider], allowInsecureHttp: false })
      }
      if (path === `/api/v1/ai/models/${provider.models[0].id}` && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body))
        return jsonResponse({ ...provider.models[0], ...patchBody })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettings(ProviderSettingsView, '/settings/providers')
    await flushPromises()

    document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')?.click()
    await flushPromises()
    const limits = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
    expect(limits).toHaveLength(2)
    await setInput(limits[0]!, '')
    await setInput(limits[1]!, '')
    buttonByText('保存模型').click()
    await flushPromises()

    expect(patchBody).toMatchObject({ contextWindow: null, maxOutputTokens: null })
    wrapper.unmount()
  })

  it('shows PAT plaintext once and leaves sensitive:read off by default', async () => {
    const issued = 'dtb_pat_synthetic_once_only_value'
    let created = false
    let submitted: { name: string; scopes: string[]; expiresAt: string | null } | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/tokens' && init?.method === 'POST') {
        submitted = JSON.parse(String(init.body))
        created = true
        return jsonResponse({
          id: '33333333-3333-4333-8333-333333333333',
          name: submitted?.name,
          tokenPrefix: 'dtb_pat_syntheti',
          scopes: submitted?.scopes,
          createdAt: '2026-08-30T01:00:00Z',
          expiresAt: null,
          token: issued,
        }, 201)
      }
      if (path === '/api/v1/tokens') {
        return jsonResponse({
          items: created
            ? [
                {
                  id: '33333333-3333-4333-8333-333333333333',
                  name: 'Notion 迁移',
                  tokenPrefix: 'dtb_pat_syntheti',
                  scopes: ['records:read'],
                  createdAt: '2026-08-30T01:00:00Z',
                  lastUsedAt: null,
                  expiresAt: null,
                  revokedAt: null,
                },
              ]
            : [],
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettings(TokenSettingsView, '/settings/tokens')
    await flushPromises()

    buttonByText('创建 Token').click()
    await flushPromises()
    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder*="Notion"]')
    expect(nameInput).not.toBeNull()
    await setInput(nameInput!, 'Notion 迁移')
    const sensitive = document.querySelector<HTMLInputElement>('input[value="sensitive:read"]')
    expect(sensitive?.checked).toBe(false)
    buttonByText('创建并显示一次').click()
    await flushPromises()

    expect(submitted).toEqual({ name: 'Notion 迁移', scopes: ['records:read'], expiresAt: null })
    expect(document.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(issued)
    buttonByText('我已安全保存').click()
    await flushPromises()
    expect(document.querySelector<HTMLInputElement>('input[readonly]')).toBeNull()
    expect(document.body.textContent).toContain('dtb_pat_syntheti')
    wrapper.unmount()
  })

  it('requires explicit confirmation before allowing sensitive Provider egress', async () => {
    let putBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') {
        return jsonResponse({ items: [provider], allowInsecureHttp: false })
      }
      if (path === '/api/v1/ai/settings' && init?.method === 'PUT') {
        putBody = JSON.parse(String(init.body))
        return jsonResponse({
          sensitiveDisplayMode: 'masked',
          sensitiveAiPolicy: 'allow',
          defaultOrganizeModelId: null,
          defaultReviewModelId: null,
          defaultVisionModelId: null,
        })
      }
      if (path === '/api/v1/ai/settings') {
        return jsonResponse({
          sensitiveDisplayMode: 'masked',
          sensitiveAiPolicy: 'redact',
          defaultOrganizeModelId: null,
          defaultReviewModelId: null,
          defaultVisionModelId: null,
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettings(AISecuritySettingsView, '/settings/ai-security')
    await flushPromises()

    const allow = document.querySelector<HTMLInputElement>('input[value="allow"]')
    expect(allow).not.toBeNull()
    allow!.click()
    buttonByText('保存策略').click()
    await flushPromises()
    expect(putBody).toBeUndefined()
    expect(document.body.textContent).toContain('确认允许敏感原文外发')

    buttonByText('确认允许并保存').click()
    await flushPromises()
    expect(putBody).toMatchObject({
      sensitiveAiPolicy: 'allow',
      confirmSensitiveAllow: true,
    })
    wrapper.unmount()
  })
})

async function mountSettings(component: object, path: string): Promise<VueWrapper> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test-value'
  const routes = [
    '/settings/providers',
    '/settings/tokens',
    '/settings/ai-security',
    '/settings/security',
    '/settings/appearance',
  ].map((routePath) => ({
    path: routePath,
    name: routePath.slice('/settings/'.length) + '-settings',
    component: { template: '<div />' },
  }))
  routes[0]!.name = 'provider-settings'
  routes[1]!.name = 'token-settings'
  routes[2]!.name = 'ai-security-settings'
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  return mount(component, { attachTo: document.body, global: { plugins: [pinia, router] } })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function buttonByText(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes(text),
  )
  if (!button) throw new Error(`button not found: ${text}`)
  return button as HTMLButtonElement
}

async function setInput(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

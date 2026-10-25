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
      reasoningOptions: [],
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

  for (const lateKind of ['success', 'failure'] as const) {
    it('keeps the post-create Token snapshot when the initial ' + lateKind + ' response arrives late', async () => {
      let resolveInitial!: (response: Response) => void
      const initialRead = new Promise<Response>((resolve) => { resolveInitial = resolve })
      let reads = 0
      let posts = 0
      const tokenName = 'R159 合成 Token'
      const metadata = {
        id: '77777777-7777-4777-8777-777777777777', name: tokenName,
        tokenPrefix: 'dtb_pat_r159_syn', scopes: ['records:read'],
        createdAt: '2026-10-01T00:00:00Z', expiresAt: null,
      }
      const listed = { ...metadata, lastUsedAt: null, revokedAt: null }
      const syntheticToken = 'dtb_pat_r159_synthetic_never_real'
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path === '/api/v1/tokens' && init?.method === 'POST') {
          posts += 1
          return jsonResponse({ ...metadata, token: syntheticToken }, 201)
        }
        if (path === '/api/v1/tokens') {
          reads += 1
          return reads === 1 ? initialRead : jsonResponse({ items: [listed] })
        }
        throw new Error('unexpected request: ' + path)
      })
      vi.stubGlobal('fetch', fetchMock)
      const wrapper = await mountSettings(TokenSettingsView, '/settings/tokens')
      try {
        await flushPromises()
        expect(reads).toBe(1)
        expect(buttonByText('创建 Token').disabled).toBe(false)
        buttonByText('创建 Token').click()
        await flushPromises()
        const nameInput = document.querySelector<HTMLInputElement>('input[placeholder*="Notion"]')
        expect(nameInput).not.toBeNull()
        await setInput(nameInput!, tokenName)
        buttonByText('创建并显示一次').click()
        await flushPromises()
        expect(posts).toBe(1)
        expect(reads).toBe(2)
        expect(document.querySelector<HTMLInputElement>('.issued-dialog input[readonly]')?.value).toBe(syntheticToken)
        buttonByText('我已安全保存').click()
        await flushPromises()
        expect(document.querySelector('.issued-dialog')).toBeNull()
        expect(document.querySelector('.token-list')?.textContent ?? '').toContain(tokenName)

        resolveInitial(lateKind === 'success'
          ? jsonResponse({ items: [] })
          : jsonResponse({ error: { code: 'TOKEN_READ_FAILED', message: '旧 Token 列表读取失败' } }, 503))
        await flushPromises()
        expect(document.querySelector('.token-list')?.textContent ?? '').toContain(tokenName)
        expect(document.querySelector('[role="alert"]')).toBeNull()
        expect(posts).toBe(1)
        expect(reads).toBe(2)
      } finally {
        resolveInitial(jsonResponse({ items: [] }))
        await flushPromises()
        wrapper.unmount()
      }
    })
  }

  it('keeps a current Token list read failure visible', async () => {
    let reads = 0
    let resolveRetry!: (response: Response) => void
    const retryRead = new Promise<Response>((resolve) => { resolveRetry = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/tokens') {
        reads += 1
        if (reads === 1) {
          return jsonResponse({ error: { code: 'TOKEN_READ_FAILED', message: 'Token 列表当前不可用' } }, 503)
        }
        return retryRead
      }
      throw new Error('unexpected request: ' + String(input))
    }))
    const wrapper = await mountSettings(TokenSettingsView, '/settings/tokens')
    try {
      await flushPromises()
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Token 列表当前不可用')
      expect(document.querySelector('.settings-loading')).toBeNull()
      expect(document.querySelector('.settings-empty')).toBeNull()
      expect(document.body.textContent).not.toContain('尚无 Personal Access Token')
      expect(document.querySelector('.settings-toolbar')).toBeNull()
      expect(document.body.textContent).not.toContain('0 个有效 Token')
      expect(document.querySelector('.settings-context')).toBeNull()
      expect(buttonByText('创建 Token').disabled).toBe(false)

      buttonByText('重试').click()
      await flushPromises()
      expect(reads).toBe(2)
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.querySelector('.settings-loading')).not.toBeNull()
      expect(document.querySelector('.settings-toolbar')).toBeNull()
      expect(document.querySelector('.settings-empty')).toBeNull()
      expect(document.querySelector('.settings-context')).toBeNull()

      resolveRetry(jsonResponse({ items: [] }))
      await flushPromises()
      expect(document.querySelector('.settings-loading')).toBeNull()
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.querySelector('.settings-toolbar')?.textContent).toContain('0 个有效 Token · 0 个历史记录')
      expect(document.querySelector('.settings-empty')?.textContent).toContain('尚无 Personal Access Token')
      expect(document.querySelector('.settings-context')?.textContent).toContain('历史记录')
    } finally {
      resolveRetry(jsonResponse({ items: [] }))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('hides the stale Token list while the post-revoke refresh fails and restores it after retry', async () => {
    const active = {
      id: '88888888-8888-4888-8888-888888888888', name: 'R281 合成撤销目标',
      tokenPrefix: 'dtb_pat_r281_syn', scopes: ['records:read'],
      createdAt: '2026-10-20T00:00:00Z', lastUsedAt: null, expiresAt: null, revokedAt: null,
    }
    let reads = 0
    let deletes = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/tokens/' + active.id && init?.method === 'DELETE') {
        deletes += 1
        return new Response(null, { status: 204 })
      }
      if (path === '/api/v1/tokens') {
        reads += 1
        if (reads === 1) return jsonResponse({ items: [active] })
        if (reads === 2) {
          return jsonResponse({ error: { code: 'TOKEN_READ_FAILED', message: '撤销后 Token 列表读取失败' } }, 503)
        }
        return jsonResponse({ items: [{ ...active, revokedAt: '2026-10-25T00:00:00Z' }] })
      }
      throw new Error('unexpected request: ' + path)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettings(TokenSettingsView, '/settings/tokens')
    try {
      await flushPromises()
      expect(reads).toBe(1)
      expect(document.querySelector('.settings-toolbar')?.textContent).toContain('1 个有效 Token · 1 个历史记录')
      buttonByText('撤销 Token').click()
      await flushPromises()
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
      buttonByText('确认撤销').click()
      await flushPromises()
      expect(deletes).toBe(1)
      expect(reads).toBe(2)
      expect(document.querySelector('[role="alertdialog"]')).toBeNull()
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('撤销后 Token 列表读取失败')
      expect(document.querySelector('.token-list')).toBeNull()
      expect(document.querySelector('.token-card')).toBeNull()
      expect(document.querySelector('.settings-toolbar')).toBeNull()
      expect(document.querySelector('.settings-context')).toBeNull()
      expect(document.querySelector('.settings-empty')).toBeNull()
      expect(Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('撤销 Token'))).toBe(false)

      buttonByText('重试').click()
      await flushPromises()
      expect(reads).toBe(3)
      expect(deletes).toBe(1)
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.querySelector('.settings-toolbar')?.textContent).toContain('0 个有效 Token · 1 个历史记录')
      expect(document.querySelector('.settings-context')).not.toBeNull()
      expect(document.querySelector('.token-card .settings-status')?.textContent).toBe('已撤销')
      expect(buttonByText('已撤销').disabled).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps a revoke failure attached to the Token whose confirmation is open', async () => {
    const base = {
      tokenPrefix: 'dtb_pat_r281_syn', scopes: ['records:read'],
      createdAt: '2026-10-20T00:00:00Z', lastUsedAt: null, expiresAt: null, revokedAt: null,
    }
    const tokenA = { ...base, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'R281 合成 A' }
    const tokenB = { ...base, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'R281 合成 B' }
    let reads = 0
    const deletes: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.startsWith('/api/v1/tokens/') && init?.method === 'DELETE') {
        const id = path.slice('/api/v1/tokens/'.length)
        deletes.push(id)
        return jsonResponse(
          { error: { code: 'TOKEN_REVOKE_FAILED', message: '合成 Token ' + (id === tokenA.id ? 'A' : 'B') + ' 撤销失败' } },
          503,
        )
      }
      if (path === '/api/v1/tokens') {
        reads += 1
        return jsonResponse({ items: [tokenA, tokenB] })
      }
      throw new Error('unexpected request: ' + path)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettings(TokenSettingsView, '/settings/tokens')
    try {
      await flushPromises()
      expect(reads).toBe(1)
      const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
      const revokeButtonFor = (tokenName: string) => {
        const card = Array.from(document.querySelectorAll<HTMLElement>('.token-card')).find((entry) =>
          entry.textContent?.includes(tokenName),
        )
        const button = card?.querySelector<HTMLButtonElement>('footer button')
        if (!button) throw new Error('revoke button not found: ' + tokenName)
        return button
      }

      revokeButtonFor(tokenA.name).click()
      await flushPromises()
      expect(dialog()?.querySelector('h2')?.textContent).toContain(tokenA.name)
      buttonByText('确认撤销').click()
      await flushPromises()
      expect(deletes).toEqual([tokenA.id])
      expect(dialog()?.querySelector('h2')?.textContent).toContain(tokenA.name)
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('合成 Token A 撤销失败')

      buttonByText('取消').click()
      await flushPromises()
      expect(dialog()).toBeNull()

      revokeButtonFor(tokenB.name).click()
      await flushPromises()
      expect(dialog()?.querySelector('h2')?.textContent).toContain(tokenB.name)
      expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
      expect(dialog()?.textContent).not.toContain('合成 Token A 撤销失败')

      buttonByText('确认撤销').click()
      await flushPromises()
      expect(deletes).toEqual([tokenA.id, tokenB.id])
      expect(dialog()?.querySelector('h2')?.textContent).toContain(tokenB.name)
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('合成 Token B 撤销失败')
      expect(dialog()?.textContent).not.toContain('合成 Token A 撤销失败')
      expect(reads).toBe(1)
    } finally {
      wrapper.unmount()
    }
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

  it('blocks default-policy editing, fake summary and saving until settings load succeeds', async () => {
    let settingsFailing = true
    let putBody: Record<string, unknown> | undefined
    const realSettings = {
      sensitiveDisplayMode: 'masked',
      sensitiveAiPolicy: 'block',
      defaultOrganizeModelId: provider.models[0].id,
      defaultReviewModelId: null,
      defaultVisionModelId: provider.models[0].id,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') {
        return jsonResponse({ items: [provider], allowInsecureHttp: false })
      }
      if (path === '/api/v1/ai/settings' && init?.method === 'PUT') {
        putBody = JSON.parse(String(init.body))
        return jsonResponse(realSettings)
      }
      if (path === '/api/v1/ai/settings') {
        if (settingsFailing) {
          return jsonResponse(
            { error: { code: 'AI_SETTINGS_UNAVAILABLE', message: 'AI 安全设置读取失败' } },
            503,
          )
        }
        return jsonResponse(realSettings)
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettings(AISecuritySettingsView, '/settings/ai-security')
    await flushPromises()

    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(buttonByText('重新读取')).toBeTruthy()
    expect(document.querySelector<HTMLInputElement>('input[value="allow"]')).toBeNull()
    expect(document.querySelector<HTMLSelectElement>('select')).toBeNull()
    expect(document.body.textContent).not.toContain('当前策略摘要')
    expect(document.body.textContent).not.toContain('遮挡后外发')
    const save = buttonByText('保存策略')
    expect(save.disabled).toBe(true)
    save.click()
    await flushPromises()
    expect(putBody).toBeUndefined()

    settingsFailing = false
    buttonByText('重新读取').click()
    await flushPromises()
    expect(document.querySelector<HTMLInputElement>('input[value="block"]')?.checked).toBe(true)
    expect(document.body.textContent).toContain('当前策略摘要')
    expect(document.body.textContent).toContain('阻止外发')
    const selects = document.querySelectorAll<HTMLSelectElement>('select')
    expect(selects[0]?.value).toBe(provider.models[0].id)
    expect(selects[1]?.value).toBe('')
    expect(selects[2]?.value).toBe(provider.models[0].id)
    expect(save.disabled).toBe(false)

    save.click()
    await flushPromises()
    expect(putBody).toMatchObject({
      sensitiveAiPolicy: 'block',
      defaultOrganizeModelId: provider.models[0].id,
      defaultVisionModelId: provider.models[0].id,
      confirmSensitiveAllow: false,
    })
    wrapper.unmount()
  })

  it('withdraws the saved notice when a default model changes after a successful save', async () => {
    let putCalls = 0
    const realSettings = {
      sensitiveDisplayMode: 'masked',
      sensitiveAiPolicy: 'block',
      defaultOrganizeModelId: provider.models[0].id,
      defaultReviewModelId: null,
      defaultVisionModelId: provider.models[0].id,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') {
        return jsonResponse({ items: [provider], allowInsecureHttp: false })
      }
      if (path === '/api/v1/ai/settings' && init?.method === 'PUT') {
        putCalls += 1
        return jsonResponse(realSettings)
      }
      if (path === '/api/v1/ai/settings') {
        return jsonResponse(realSettings)
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSettings(AISecuritySettingsView, '/settings/ai-security')
    await flushPromises()

    buttonByText('保存策略').click()
    await flushPromises()
    expect(putCalls).toBe(1)
    expect(document.body.textContent).toContain('策略与默认模型已保存')

    const organize = document.querySelectorAll<HTMLSelectElement>('select')[0]!
    organize.value = ''
    organize.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    expect(document.body.textContent).not.toContain('策略与默认模型已保存')
    const pending = Array.from(document.querySelectorAll('dt')).find((dt) => dt.textContent === '待保存变更')
    expect(pending?.nextElementSibling?.textContent).toBe('1')
    const selects = document.querySelectorAll<HTMLSelectElement>('select')
    expect(selects[0]?.value).toBe('')
    expect(selects[1]?.value).toBe('')
    expect(selects[2]?.value).toBe(provider.models[0].id)
    expect(putCalls).toBe(1)
    wrapper.unmount()
  })

  it('locks policy radios and default models while a save is pending and restores the draft after a 503', async () => {
    let putCalls = 0
    let putBody: Record<string, unknown> | undefined
    let resolvePut!: (response: Response) => void
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') {
        return jsonResponse({ items: [provider], allowInsecureHttp: false })
      }
      if (path === '/api/v1/ai/settings' && init?.method === 'PUT') {
        putCalls += 1
        putBody = JSON.parse(String(init.body))
        return new Promise<Response>((resolve) => {
          resolvePut = resolve
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
    let wrapper: VueWrapper | undefined
    try {
      wrapper = await mountSettings(AISecuritySettingsView, '/settings/ai-security')
      await flushPromises()

      const selects = document.querySelectorAll<HTMLSelectElement>('select')
      expect(selects).toHaveLength(3)
      for (const select of selects) {
        select.value = provider.models[0].id
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      await flushPromises()

      buttonByText('保存策略').click()
      await flushPromises()
      expect(putCalls).toBe(1)
      expect(putBody).toMatchObject({
        sensitiveAiPolicy: 'redact',
        defaultOrganizeModelId: provider.models[0].id,
        defaultReviewModelId: provider.models[0].id,
        defaultVisionModelId: provider.models[0].id,
      })

      const radios = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[name="sensitive-policy"]'))
      expect(radios().map((radio) => radio.disabled)).toEqual([true, true, true])
      expect(Array.from(selects, (select) => select.disabled)).toEqual([true, true, true])

      const saving = buttonByText('正在保存')
      expect(saving.textContent).toContain('正在保存')
      expect(saving.disabled).toBe(true)
      saving.click()
      await flushPromises()
      expect(putCalls).toBe(1)

      const block = document.querySelector<HTMLInputElement>('input[value="block"]')!
      block.click()
      await flushPromises()
      expect(block.checked).toBe(false)
      expect(document.querySelector<HTMLInputElement>('input[value="redact"]')?.checked).toBe(true)

      resolvePut(jsonResponse({ error: { code: 'AI_SETTINGS_SAVE_FAILED', message: 'AI 安全设置保存失败' } }, 503))
      await flushPromises()

      expect(radios().map((radio) => radio.disabled)).toEqual([false, false, false])
      expect(Array.from(selects, (select) => select.disabled)).toEqual([false, false, false])
      expect(selects[0]?.value).toBe(provider.models[0].id)
      expect(selects[1]?.value).toBe(provider.models[0].id)
      expect(selects[2]?.value).toBe(provider.models[0].id)
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('AI 安全设置保存失败')
      block.click()
      await flushPromises()
      expect(block.checked).toBe(true)
      expect(document.querySelector<HTMLInputElement>('input[value="redact"]')?.checked).toBe(false)
      expect(putCalls).toBe(1)
    } finally {
      resolvePut(jsonResponse({ error: { code: 'AI_SETTINGS_SAVE_FAILED', message: 'AI 安全设置保存失败' } }, 503))
      await flushPromises()
      wrapper?.unmount()
    }
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

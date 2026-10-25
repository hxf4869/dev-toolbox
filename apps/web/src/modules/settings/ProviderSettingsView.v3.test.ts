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

const provider = {
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

describe('ProviderSettingsView V3', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  for (const lateKind of ['success', 'failure'] as const) {
    it('keeps the post-create Provider list when the initial ' + lateKind + ' response arrives late', async () => {
      let resolveInitial!: (response: Response) => void
      const initialRead = new Promise<Response>((resolve) => { resolveInitial = resolve })
      let reads = 0
      let posts = 0
      const created = { ...structuredClone(provider), providerKey: 'r162-synthetic', displayName: 'R162 合成 Provider', models: [] }
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path === '/api/v1/ai/providers' && init?.method === 'POST') {
          posts += 1
          return jsonResponse(created, 201)
        }
        if (path === '/api/v1/ai/providers' && !init?.method) {
          reads += 1
          return reads === 1 ? initialRead : jsonResponse({ items: [created], allowInsecureHttp: false })
        }
        if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
        if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
        if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
        throw new Error('unexpected request: ' + path)
      }))
      const wrapper = await mountView()
      try {
        expect(reads).toBe(1)
        clickButton('新增 Provider')
        await flushPromises()
        const inputs = document.querySelectorAll<HTMLInputElement>('#provider-form input:not([type="checkbox"])')
        expect(inputs).toHaveLength(4)
        await setInput(inputs[0]!, 'r162-synthetic')
        await setInput(inputs[1]!, created.displayName)
        await setInput(inputs[2]!, created.baseUrl)
        await setInput(inputs[3]!, 'r162-synthetic-never-real')
        clickButton('保存 Provider')
        await flushPromises()
        expect(posts).toBe(1)
        expect(reads).toBe(2)
        expect(document.querySelector('#provider-form')).toBeNull()
        expect(document.querySelector('.provider-card')?.textContent ?? '').toContain(created.displayName)

        resolveInitial(lateKind === 'success'
          ? jsonResponse({ items: [], allowInsecureHttp: false })
          : jsonResponse({ error: { code: 'PROVIDER_READ_FAILED', message: '旧 Provider 列表读取失败' } }, 503))
        await flushPromises()
        expect(document.querySelector('.provider-card')?.textContent ?? '').toContain(created.displayName)
        expect(document.querySelector('[role="alert"]')).toBeNull()
        expect(posts).toBe(1)
        expect(reads).toBe(2)
      } finally {
        resolveInitial(jsonResponse({ items: [], allowInsecureHttp: false }))
        await flushPromises()
        wrapper.unmount()
      }
    })
  }

  it('keeps a current Provider list failure visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ error: { code: 'PROVIDER_READ_FAILED', message: 'Provider 列表当前不可用' } }, 503)
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error('unexpected request: ' + path)
    }))
    const wrapper = await mountView()
    try {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Provider 列表当前不可用')
      expect(document.querySelector('.settings-loading')).toBeNull()
    } finally {
      wrapper.unmount()
    }
  })

  it('shows Provider test success only for the selected tested model and never auto-tests a new selection', async () => {
    const first = structuredClone(provider.models[0]!)
    const second = { ...first, id: '22222222-2222-4222-8222-222222222299', modelId: 'r174-model-b', displayName: 'R174 模型 B' }
    const configured = { ...structuredClone(provider), models: [first, second] }
    const sentModels: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return jsonResponse({ items: [configured], allowInsecureHttp: false })
      if (path === '/api/v1/ai/providers/' + provider.id + '/test' && init?.method === 'POST') {
        sentModels.push((JSON.parse(String(init.body)) as { modelId: string }).modelId)
        return jsonResponse({ status: 'ok', latencyMs: sentModels.length === 1 ? 12 : 34, usage: null })
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error('unexpected request: ' + path)
    }))
    const wrapper = await mountView()
    try {
      const connection = document.querySelector<HTMLElement>('.connection-test')!
      const selection = connection.querySelector<HTMLSelectElement>('select')!
      clickButton('测试连接', connection)
      await flushPromises()
      expect(connection.querySelector('.connection-result')?.textContent).toContain('12 ms')
      selection.value = second.id
      selection.dispatchEvent(new Event('change', { bubbles: true }))
      await flushPromises()
      expect(connection.querySelector('.connection-result')).toBeNull()
      expect(sentModels).toEqual([first.id])
      clickButton('测试连接', connection)
      await flushPromises()
      expect(connection.querySelector('.connection-result')?.textContent).toContain('34 ms')
      expect(sentModels).toEqual([first.id, second.id])
    } finally {
      wrapper.unmount()
    }
  })

  it('hides a pending Provider test error after model selection changes and preserves a current credentials error', async () => {
    const first = structuredClone(provider.models[0]!)
    const second = { ...first, id: '22222222-2222-4222-8222-222222222299', modelId: 'r174-model-b', displayName: 'R174 模型 B' }
    const configured = { ...structuredClone(provider), models: [first, second] }
    let resolveFirst!: (response: Response) => void
    const firstTest = new Promise<Response>((resolve) => { resolveFirst = resolve })
    const sentModels: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return jsonResponse({ items: [configured], allowInsecureHttp: false })
      if (path === '/api/v1/ai/providers/' + provider.id + '/test' && init?.method === 'POST') {
        sentModels.push((JSON.parse(String(init.body)) as { modelId: string }).modelId)
        return sentModels.length === 1 ? firstTest : jsonResponse({ error: { code: 'AI_PROVIDER_CREDENTIALS_INVALID', message: '当前模型凭据被拒绝' } }, 422)
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error('unexpected request: ' + path)
    }))
    const wrapper = await mountView()
    try {
      const connection = document.querySelector<HTMLElement>('.connection-test')!
      const selection = connection.querySelector<HTMLSelectElement>('select')!
      clickButton('测试连接', connection)
      await flushPromises()
      selection.value = second.id
      selection.dispatchEvent(new Event('change', { bubbles: true }))
      await flushPromises()
      expect(connection.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
      expect(sentModels).toEqual([first.id])
      resolveFirst(jsonResponse({ error: { code: 'AI_PROVIDER_CREDENTIALS_INVALID', message: '旧模型凭据被拒绝' } }, 422))
      await flushPromises()
      expect(connection.querySelector('.connection-result')).toBeNull()
      expect(connection.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
      clickButton('测试连接', connection)
      await flushPromises()
      expect(connection.querySelector('.connection-result')?.textContent).toContain('凭据被 Provider 拒绝')
      expect(sentModels).toEqual([first.id, second.id])
    } finally {
      resolveFirst(jsonResponse({ error: { code: 'AI_PROVIDER_CREDENTIALS_INVALID', message: '旧模型凭据被拒绝' } }, 422))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('does not offer a connection test for a disabled Provider', async () => {
    let tests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return jsonResponse({ items: [{ ...structuredClone(provider), enabled: false }], allowInsecureHttp: false })
      if (path === '/api/v1/ai/providers/' + provider.id + '/test' && init?.method === 'POST') {
        tests += 1
        return jsonResponse({ status: 'ok', latencyMs: 12, usage: null })
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error('unexpected request: ' + path)
    }))
    const wrapper = await mountView()
    try {
      const connection = document.querySelector<HTMLElement>('.connection-test')!
      const button = connection.querySelector<HTMLButtonElement>('button')!
      expect(connection.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true)
      expect(button.disabled).toBe(true)
      button.click()
      await flushPromises()
      expect(tests).toBe(0)
    } finally {
      wrapper.unmount()
    }
  })

  for (const hasFallback of [true, false]) {
    it('reconciles a disabled selected model ' + (hasFallback ? 'to an enabled fallback' : 'to an empty disabled test state'), async () => {
      const first = structuredClone(provider.models[0]!)
      const second = { ...first, id: '22222222-2222-4222-8222-222222222299', modelId: 'r177-fallback', displayName: 'R177 可用模型' }
      let configured = { ...structuredClone(provider), models: hasFallback ? [first, second] : [first] }
      let patches = 0
      const sentModels: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path === '/api/v1/ai/providers' && !init?.method) return jsonResponse({ items: [configured], allowInsecureHttp: false })
        if (path === '/api/v1/ai/models/' + first.id && init?.method === 'PATCH') {
          patches += 1
          const payload = JSON.parse(String(init.body))
          configured = { ...configured, models: configured.models.map((model) => model.id === first.id ? { ...model, ...payload, updatedAt: '2026-10-01T00:00:00Z' } : model) }
          return jsonResponse(configured.models[0])
        }
        if (path === '/api/v1/ai/providers/' + provider.id + '/test' && init?.method === 'POST') {
          sentModels.push((JSON.parse(String(init.body)) as { modelId: string }).modelId)
          return jsonResponse({ status: 'ok', latencyMs: 12, usage: null })
        }
        if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
        if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
        if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
        throw new Error('unexpected request: ' + path)
      }))
      const wrapper = await mountView()
      try {
        expect(document.querySelector<HTMLSelectElement>('.connection-test select')?.value).toBe(first.id)
        document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')!.click()
        await flushPromises()
        const capabilities = document.querySelectorAll<HTMLInputElement>('#model-form input[type="checkbox"]')
        expect(capabilities).toHaveLength(3)
        capabilities[2]!.click()
        await flushPromises()
        clickButton('保存模型')
        await flushPromises()
        expect(patches).toBe(1)
        expect(configured.models[0]?.enabled).toBe(false)
        const connection = document.querySelector<HTMLElement>('.connection-test')!
        const selection = connection.querySelector<HTMLSelectElement>('select')!
        const button = connection.querySelector<HTMLButtonElement>('button')!
        expect(selection.value).toBe(hasFallback ? second.id : '')
        expect(button.disabled).toBe(!hasFallback)
        expect(sentModels).toEqual([])
        button.click()
        await flushPromises()
        expect(sentModels).toEqual(hasFallback ? [second.id] : [])
      } finally {
        wrapper.unmount()
      }
    })
  }

  for (const scenario of ['provider-completed', 'model-pending'] as const) {
    it('invalidates ' + scenario + ' connection feedback after saving configuration with the same record ID', async () => {
      const pending = scenario === 'model-pending'
      let configured = structuredClone(provider)
      let resolveFirst!: (response: Response) => void
      const firstTest = new Promise<Response>((resolve) => { resolveFirst = resolve })
      let tests = 0
      let patches = 0
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path === '/api/v1/ai/providers' && !init?.method) return jsonResponse({ items: [configured], allowInsecureHttp: false })
        if (path === '/api/v1/ai/providers/' + provider.id && init?.method === 'PATCH') {
          patches += 1
          const payload = JSON.parse(String(init.body))
          configured = { ...configured, ...payload }
          return jsonResponse(configured)
        }
        if (path === '/api/v1/ai/models/' + provider.models[0]!.id && init?.method === 'PATCH') {
          patches += 1
          const payload = JSON.parse(String(init.body))
          configured = { ...configured, models: [{ ...configured.models[0]!, ...payload }] }
          return jsonResponse(configured.models[0])
        }
        if (path === '/api/v1/ai/providers/' + provider.id + '/test' && init?.method === 'POST') {
          tests += 1
          expect((JSON.parse(String(init.body)) as { modelId: string }).modelId).toBe(provider.models[0]!.id)
          return tests === 1 && pending ? firstTest : jsonResponse({ status: 'ok', latencyMs: tests === 1 ? 12 : 34, usage: null })
        }
        if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
        if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
        if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
        throw new Error('unexpected request: ' + path)
      }))
      const wrapper = await mountView()
      try {
        clickButton('测试连接', document.querySelector<HTMLElement>('.connection-test')!)
        await flushPromises()
        expect(tests).toBe(1)
        if (!pending) expect(document.querySelector('.connection-result')?.textContent).toContain('12 ms')
        if (pending) {
          document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')!.click()
          await flushPromises()
          await setInput(document.querySelector<HTMLInputElement>('#model-form input')!, 'r183-replaced-upstream-model')
          clickButton('保存模型')
        } else {
          clickButton('编辑与替换密钥')
          await flushPromises()
          await setInput(document.querySelectorAll<HTMLInputElement>('#provider-form input:not([type="checkbox"])')[2]!, 'https://replacement.example.test/v1')
          clickButton('保存 Provider')
        }
        await flushPromises()
        expect(patches).toBe(1)
        expect(document.querySelector('#provider-form, #model-form')).toBeNull()
        const connection = document.querySelector<HTMLElement>('.connection-test')!
        expect(connection.querySelector<HTMLSelectElement>('select')?.value).toBe(provider.models[0]!.id)
        expect(connection.querySelector('.connection-result')).toBeNull()
        expect(tests).toBe(1)
        if (pending) {
          expect(configured.models[0]!.modelId).toBe('r183-replaced-upstream-model')
          expect(connection.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
          resolveFirst(jsonResponse({ error: { code: 'AI_PROVIDER_CREDENTIALS_INVALID', message: '旧配置凭据被拒绝' } }, 422))
          await flushPromises()
          expect(connection.querySelector('.connection-result')).toBeNull()
        } else {
          expect(configured.baseUrl).toBe('https://replacement.example.test/v1')
        }
        expect(connection.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
        clickButton('测试连接', connection)
        await flushPromises()
        expect(connection.querySelector('.connection-result')?.textContent).toContain('34 ms')
        expect(tests).toBe(2)
        expect(patches).toBe(1)
      } finally {
        resolveFirst(jsonResponse({ status: 'ok', latencyMs: 12, usage: null }))
        await flushPromises()
        wrapper.unmount()
      }
    })
  }

  it('validates reasoning options and saves their visible order as a full replacement', async () => {
    let patchBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      if (path === `/api/v1/ai/models/${MOCK_IDS.model}` && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body))
        return jsonResponse({ ...provider.models[0], ...patchBody })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()

    document.querySelector<HTMLButtonElement>('button[aria-label="编辑模型"]')!.click()
    await flushPromises()
    const names = document.querySelectorAll<HTMLInputElement>('.reasoning-editor__row input')
    expect(names).toHaveLength(2)

    await setInput(names[1]!, '简短')
    clickButton('保存模型')
    await flushPromises()
    expect(patchBody).toBeUndefined()
    expect(document.body.textContent).toContain('显示名不能重复')

    await setInput(names[1]!, '深入')
    document.querySelectorAll<HTMLButtonElement>('.reasoning-editor__row')[0]!
      .querySelector<HTMLButtonElement>('button[title="下移"]')!
      .click()
    await flushPromises()
    clickButton('保存模型')
    await flushPromises()

    expect(patchBody?.reasoningOptions).toEqual([
      { displayName: '深入', reasoning: 'high', sortOrder: 0 },
      { displayName: '简短', reasoning: 'low', sortOrder: 10 },
    ])
    expect(JSON.stringify(patchBody)).not.toContain('"off"')
    wrapper.unmount()
  })

  for (const lateKind of ['success', 'failure'] as const) {
    it('discards an Embedding test ' + lateKind + ' after the connection model changes while pending', async () => {
      let resolveTest!: (response: Response) => void
      const pendingTest = new Promise<Response>((resolve) => { resolveTest = resolve })
      let tests = 0
      let testedModel = ''
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
        if (path === '/api/v1/assistant/embedding-settings/test' && init?.method === 'POST') {
          tests += 1
          testedModel = (JSON.parse(String(init.body)) as { modelId: string }).modelId
          return pendingTest
        }
        if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
        if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
        if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
        throw new Error('unexpected request: ' + path)
      }))
      const wrapper = await mountView()
      try {
        const card = document.querySelector<HTMLElement>('.embedding-card')!
        const modelInput = card.querySelector<HTMLInputElement>('input[placeholder="text-embedding-3-small"]')!
        await setInput(modelInput, 'r168-model-a')
        clickButton('测试连接', card)
        await flushPromises()
        expect(tests).toBe(1)
        expect(testedModel).toBe('r168-model-a')
        expect(modelInput.disabled || modelInput.readOnly).toBe(false)
        await setInput(modelInput, 'r168-model-b')
        expect(card.querySelector('.embedding-test-result')).toBeNull()
        resolveTest(lateKind === 'success'
          ? jsonResponse({ status: 'ok', actualDimensions: 3072, latencyMs: 18, usage: null })
          : jsonResponse({ error: { code: 'EMBEDDING_PROVIDER_UNAVAILABLE', message: '旧模型连接测试失败' } }, 503))
        await flushPromises()
        expect(modelInput.value).toBe('r168-model-b')
        expect(card.querySelector('.embedding-test-result')).toBeNull()
        expect(card.textContent).not.toContain('旧模型连接测试失败')
        const testButton = Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent?.trim() === '测试连接')
        expect(testButton?.disabled).toBe(false)
        expect(tests).toBe(1)
      } finally {
        resolveTest(jsonResponse({ status: 'ok', actualDimensions: 3072, latencyMs: 18, usage: null }))
        await flushPromises()
        wrapper.unmount()
      }
    })
  }

  it('keeps a current Embedding test failure visible and allows an explicit retry', async () => {
    let tests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings/test' && init?.method === 'POST') {
        tests += 1
        return jsonResponse({ error: { code: 'EMBEDDING_PROVIDER_UNAVAILABLE', message: '当前模型连接测试失败' } }, 503)
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error('unexpected request: ' + path)
    }))
    const wrapper = await mountView()
    try {
      const card = document.querySelector<HTMLElement>('.embedding-card')!
      clickButton('测试连接', card)
      await flushPromises()
      expect(card.textContent).toContain('当前模型连接测试失败')
      const testButton = Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent?.trim() === '测试连接')
      expect(testButton?.disabled).toBe(false)
      expect(tests).toBe(1)
    } finally {
      wrapper.unmount()
    }
  })

  it('tests once, displays absent usage, and confirms a server-required full reindex', async () => {
    const putBodies: Array<Record<string, unknown>> = []
    let embeddingTests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings/test' && init?.method === 'POST') {
        embeddingTests += 1
        return jsonResponse({ status: 'ok', actualDimensions: 3072, latencyMs: 18, usage: null })
      }
      if (path === '/api/v1/assistant/embedding-settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        putBodies.push(body)
        if (!body.confirmReindex) {
          return jsonResponse({
            error: {
              code: 'EMBEDDING_REINDEX_CONFIRMATION_REQUIRED',
              message: '需要确认全量重建',
              requestId: 'request-test',
              fieldErrors: [],
            },
          }, 409)
        }
        return jsonResponse({
          ...embeddingSettingsFixtures.ready,
          modelId: body.modelId,
          dimensions: body.dimensions,
          generation: 3,
          status: 'indexing',
        })
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()

    const modelInput = document.querySelector<HTMLInputElement>('.embedding-form input[placeholder="text-embedding-3-small"]')!
    await setInput(modelInput, 'text-embedding-v2')
    const embeddingCard = document.querySelector<HTMLElement>('.embedding-card')!
    clickButton('测试连接', embeddingCard)
    await flushPromises()
    expect(embeddingTests).toBe(1)
    expect(embeddingCard.textContent).toContain('Provider 未返回')

    clickButton('保存 Embedding', embeddingCard)
    await flushPromises()
    expect(putBodies[0]).toMatchObject({
      modelId: 'text-embedding-v2',
      apiKey: null,
      confirmReindex: false,
    })
    expect(document.body.textContent).toContain('24 个活跃片段')
    expect(document.body.textContent).toContain('最多 16 个片段')
    expect(document.body.textContent).toContain('可能产生 Provider 费用')

    clickButton('确认重建并保存')
    await flushPromises()
    expect(putBodies[1]).toMatchObject({
      modelId: 'text-embedding-v2',
      apiKey: null,
      confirmReindex: true,
    })
    wrapper.unmount()
  })

  it('keeps the Embedding form readonly during save and restores the unsaved draft after a 503', async () => {
    let resolveSave!: (response: Response) => void
    const pendingSave = new Promise<Response>((resolve) => { resolveSave = resolve })
    let saves = 0
    let savedName = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings' && init?.method === 'PUT') {
        saves += 1
        savedName = (JSON.parse(String(init.body)) as { displayName: string }).displayName
        return pendingSave
      }
      if (path === '/api/v1/assistant/embedding-settings') return jsonResponse(embeddingSettingsFixtures.ready)
      if (path === '/api/v1/assistant/index-status') return jsonResponse(knowledgeFixtures.ready)
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error('unexpected request: ' + path)
    }))
    const wrapper = await mountView()
    try {
      const card = document.querySelector<HTMLElement>('.embedding-card')!
      const fields = Array.from(card.querySelectorAll<HTMLInputElement>('.embedding-form input:not([type="checkbox"])'))
      const enabled = card.querySelector<HTMLInputElement>('.embedding-form input[type="checkbox"]')!
      expect(fields).toHaveLength(5)
      await setInput(fields[0]!, 'R171 保存草稿 A')
      await setInput(fields[3]!, 'r171-synthetic-never-real')
      const valuesBefore = fields.map((field) => field.value)
      const enabledBefore = enabled.checked
      clickButton('保存 Embedding', card)
      await flushPromises()
      expect(saves).toBe(1)
      expect(savedName).toBe('R171 保存草稿 A')
      expect(fields.every((field) => field.readOnly)).toBe(true)
      expect(enabled.disabled).toBe(true)
      enabled.click()
      await flushPromises()
      expect(enabled.checked).toBe(enabledBefore)
      expect(fields.map((field) => field.value)).toEqual(valuesBefore)
      resolveSave(jsonResponse({ error: { code: 'EMBEDDING_SAVE_FAILED', message: '保存暂时不可用' } }, 503))
      await flushPromises()
      expect(fields.every((field) => !field.readOnly && !field.disabled)).toBe(true)
      expect(enabled.disabled).toBe(false)
      expect(fields.map((field) => field.value)).toEqual(valuesBefore)
      expect(enabled.checked).toBe(enabledBefore)
      expect(card.textContent).toContain('保存暂时不可用')
      await setInput(fields[0]!, 'R171 失败后编辑 B')
      expect(fields[0]!.value).toBe('R171 失败后编辑 B')
      expect(saves).toBe(1)
    } finally {
      resolveSave(jsonResponse({ error: { code: 'EMBEDDING_SAVE_FAILED', message: '保存暂时不可用' } }, 503))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('shows the refreshed eligible count before enabling a disabled embedding', async () => {
    let indexReads = 0
    let saveRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings' && init?.method === 'PUT') {
        saveRequests += 1
        return jsonResponse({ error: { code: 'EMBEDDING_REINDEX_CONFIRMATION_REQUIRED' } }, 409)
      }
      if (path === '/api/v1/assistant/embedding-settings') {
        return jsonResponse({ ...embeddingSettingsFixtures.ready, enabled: false, status: 'disabled', activeFragmentCount: 24 })
      }
      if (path === '/api/v1/assistant/index-status') {
        indexReads += 1
        return jsonResponse({
          ...knowledgeFixtures.disabled,
          counts: { active: indexReads === 1 ? 24 : 31, ready: 0, pending: 0, running: 0, failed: 0, excluded: 0 },
        })
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') return jsonResponse({ items: [], nextCursor: null })
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()
    await wrapper.get('.embedding-form input[type="checkbox"]').setValue(true)
    clickButton('保存 Embedding', document.querySelector<HTMLElement>('.embedding-card')!)
    await flushPromises()

    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('31 个活跃片段')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).not.toContain('0 个活跃片段')
    expect(indexReads).toBe(2)
    expect(saveRequests).toBe(1)
    wrapper.unmount()
  })

  it('retries only a failed fragment and keeps deletion behind a separate confirmation', async () => {
    let retried = false
    let deleted = false
    const failure = {
      fragmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      itemId: MOCK_IDS.item,
      itemTitle: '迁移失败记录',
      sourceKind: 'raw_text',
      attempt: 2,
      errorCode: 'EMBEDDING_PROVIDER_UNAVAILABLE',
      updatedAt: '2026-09-02T03:00:00Z',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers' && !init?.method) return providersResponse()
      if (path === '/api/v1/assistant/embedding-settings' && init?.method === 'DELETE') {
        deleted = true
        return new Response(null, { status: 204 })
      }
      if (path === '/api/v1/assistant/embedding-settings') {
        return jsonResponse(deleted ? embeddingSettingsFixtures.unconfigured : embeddingSettingsFixtures.ready)
      }
      if (path === '/api/v1/assistant/index-status') {
        return jsonResponse(deleted ? knowledgeFixtures.unconfigured : knowledgeFixtures.failed)
      }
      if (path === `/api/v1/assistant/index-failures/${failure.fragmentId}/retry` && init?.method === 'POST') {
        retried = true
        return jsonResponse({ fragmentId: failure.fragmentId, state: 'pending' }, 202)
      }
      if (path === '/api/v1/assistant/index-failures?limit=50') {
        return jsonResponse({ items: retried || deleted ? [] : [failure], nextCursor: null })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountView()

    clickButton('重试', document.querySelector<HTMLElement>('.index-failures')!)
    await flushPromises()
    expect(retried).toBe(true)
    expect(document.body.textContent).not.toContain('迁移失败记录')

    clickButton('删除 Embedding 配置')
    await flushPromises()
    expect(deleted).toBe(false)
    expect(document.body.textContent).toContain('原始笔记不会删除')
    clickButton('确认删除配置')
    await flushPromises()
    expect(deleted).toBe(true)
    wrapper.unmount()
  })
})

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
  return jsonResponse({ items: [structuredClone(provider)], allowInsecureHttp: false })
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

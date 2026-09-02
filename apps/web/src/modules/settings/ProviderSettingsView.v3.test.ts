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

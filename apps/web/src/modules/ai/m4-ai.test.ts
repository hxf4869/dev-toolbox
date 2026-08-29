import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import ItemAIView from './ItemAIView.vue'
import type { ArtifactDetail, ArtifactSummary } from './contracts'

const itemID = '11111111-1111-4111-8111-111111111111'
const artifactID = '22222222-2222-4222-8222-222222222222'
const taskID = '33333333-3333-4333-8333-333333333333'
const modelID = '44444444-4444-4444-8444-444444444444'
const fragmentID = '55555555-5555-4555-8555-555555555555'

describe('M4 item AI surface', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('warns before activating a stale version and applies only selected suggestions', async () => {
    let active = false
    let appliedBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') {
        return jsonResponse({ items: [provider()] })
      }
      if (path === '/api/v1/ai/settings') {
        return jsonResponse({
          sensitiveDisplayMode: 'masked',
          sensitiveAiPolicy: 'redact',
          defaultOrganizeModelId: modelID,
          defaultReviewModelId: modelID,
          defaultVisionModelId: modelID,
        })
      }
      if (path === `/api/v1/items/${itemID}/artifacts`) {
        return jsonResponse({ items: [{ ...summary(), active }] })
      }
      if (path === `/api/v1/artifacts/${artifactID}`) {
        return jsonResponse({ ...detail(), active })
      }
      if (path === `/api/v1/ai/tasks?itemId=${itemID}&limit=20`) {
        return jsonResponse({ items: [failedTask()] })
      }
      if (path === `/api/v1/artifacts/${artifactID}/activate` && init?.method === 'POST') {
        active = true
        return jsonResponse({ ...detail(), active: true })
      }
      if (path === `/api/v1/artifacts/${artifactID}/apply-suggestions` && init?.method === 'POST') {
        appliedBody = JSON.parse(String(init.body))
        return jsonResponse({ applied: true, itemId: itemID })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountView()
    await flushPromises()

    expect(document.body.textContent).toContain('此 AI 版本未覆盖最新原始记录')
    buttonByText('设为当前版本').click()
    await flushPromises()
    expect(document.body.textContent).toContain('设为当前派生版本')
    expect(document.body.textContent).toContain('执行动作前请先核对新增原文')
    buttonByText('确认').click()
    await flushPromises()
    expect(active).toBe(true)
    expect(document.body.textContent).toContain('原始记录未改变')

    buttonByText('应用建议').click()
    await flushPromises()
    const title = document.querySelector<HTMLInputElement>('.suggestion input[type="checkbox"]')
    expect(title).not.toBeNull()
    title!.click()
    const tag = document.querySelector<HTMLInputElement>('.tag-suggestion input[value="后端"]')
    expect(tag).not.toBeNull()
    tag!.click()
    await flushPromises()
    buttonByText('应用所选建议').click()
    await flushPromises()

    expect(appliedBody).toEqual({ title: true, folder: false, tags: ['后端'] })
    expect(wrapper.emitted('changed')).toHaveLength(2)
    wrapper.unmount()
  })

  it('creates a retry task without changing the failed task history', async () => {
    let retryCalled = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/ai/settings') {
        return jsonResponse({ sensitiveDisplayMode: 'masked', sensitiveAiPolicy: 'redact', defaultOrganizeModelId: modelID, defaultReviewModelId: modelID, defaultVisionModelId: modelID })
      }
      if (path === `/api/v1/items/${itemID}/artifacts`) return jsonResponse({ items: [] })
      if (path === `/api/v1/ai/tasks?itemId=${itemID}&limit=20`) return jsonResponse({ items: [failedTask()] })
      if (path === `/api/v1/ai/tasks/${taskID}/retry` && init?.method === 'POST') {
        retryCalled = true
        return jsonResponse({ ...failedTask(), id: '66666666-6666-4666-8666-666666666666', status: 'queued', retryOfTaskId: taskID, errorCode: null, errorDetail: null })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountView()
    await flushPromises()

    buttonByText('重试').click()
    await flushPromises()
    expect(retryCalled).toBe(true)
    expect(document.body.textContent).toContain('等待中')
    expect(document.body.textContent).toContain('失败')
    wrapper.unmount()
  })
})

async function mountView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: { template: '<div />' } },
      { path: '/ai/tasks', name: 'task-center', component: { template: '<div />' } },
      { path: '/items/:itemId', name: 'item-detail', component: { template: '<div />' } },
    ],
  })
  await router.push(`/items/${itemID}`)
  await router.isReady()
  return mount(ItemAIView, {
    attachTo: document.body,
    props: {
      itemId: itemID,
      sensitivity: 'normal',
      attachments: [],
      initialArtifacts: [summary()],
    },
    global: { plugins: [pinia, router] },
  })
}

function provider() {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    displayName: '本地 Mock',
    enabled: true,
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

function summary(): ArtifactSummary {
  return {
    id: artifactID,
    itemId: itemID,
    taskRunId: taskID,
    artifactType: 'organized_record',
    versionNumber: 1,
    schemaVersion: '1.0',
    generator: 'builtin_worker',
    modelName: 'Mock Model',
    promptVersion: 'organize-v1',
    createdAt: '2026-08-30T01:00:00Z',
    invalidatedAt: null,
    active: false,
    isStale: true,
  }
}

function detail(): ArtifactDetail {
  return {
    ...summary(),
    itemId: itemID,
    taskRunId: taskID,
    content: {
      schemaVersion: '1.0',
      artifactType: 'organized_record',
      title: '建议标题',
      summary: '建议摘要',
      classification: {
        contentType: 'development',
        suggestedFolderPath: ['开发', 'Go'],
        suggestedTags: ['后端', 'Go'],
        sensitivitySuggestion: 'normal',
      },
      blocks: [{ id: 'body', type: 'markdown', markdown: '内容', sourceFragmentIds: [fragmentID] }],
      warnings: [],
      sourceFragmentIds: [fragmentID],
      review: { status: 'model_reviewed', limitations: ['需要人工核对'] },
    },
  }
}

function failedTask() {
  return {
    id: taskID,
    taskType: 'organize_record',
    itemId: itemID,
    parentTaskId: null,
    triggerType: 'manual',
    modelId: modelID,
    status: 'failed',
    sensitivePolicy: 'redact',
    promptVersion: 'organize-v1',
    schemaVersion: '1.0',
    retryOfTaskId: null,
    queuedAt: '2026-08-30T01:00:00Z',
    startedAt: '2026-08-30T01:00:01Z',
    finishedAt: '2026-08-30T01:00:02Z',
    cancelRequestedAt: null,
    cancelRequested: false,
    errorCode: 'AI_PROVIDER_UNAVAILABLE',
    errorDetail: 'Provider 暂时不可用',
    inputTokens: null,
    outputTokens: null,
    events: [],
  } as const
}

function buttonByText(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((entry) =>
    entry.textContent?.trim().includes(text),
  )
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

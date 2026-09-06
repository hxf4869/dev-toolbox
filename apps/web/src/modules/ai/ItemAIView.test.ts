import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import ItemAIView from './ItemAIView.vue'
import type { ArtifactSummary, AITask } from './contracts'

interface RecordedCall {
  method: string
  path: string
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function taskFixture(overrides: Partial<AITask>): AITask {
  return {
    id: 'task-1',
    taskType: 'organize_record',
    itemId: 'item-1',
    parentTaskId: null,
    triggerType: 'manual',
    modelId: 'model-1',
    status: 'queued',
    sensitivePolicy: 'block',
    promptVersion: 'organize-v2',
    schemaVersion: '1.0',
    retryOfTaskId: null,
    queuedAt: '2026-09-01T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    cancelRequested: false,
    errorCode: null,
    errorDetail: null,
    inputTokens: null,
    outputTokens: null,
    ...overrides,
  }
}

function artifactFixture(): ArtifactSummary {
  return {
    id: 'artifact-1',
    itemId: 'item-1',
    taskRunId: 'task-1',
    artifactType: 'organized_record',
    versionNumber: 1,
    schemaVersion: '1.0',
    generator: 'builtin_worker',
    modelName: 'mock-model',
    promptVersion: 'organize-v2',
    createdAt: '2026-09-01T00:00:05Z',
    invalidatedAt: null,
    active: true,
    isStale: false,
  }
}

function artifactDetailFixture() {
  return {
    ...artifactFixture(),
    content: {
      schemaVersion: '1.0',
      artifactType: 'organized_record',
      title: '整理标题',
      summary: '整理摘要',
      classification: {
        contentType: 'development',
        suggestedFolderPath: [],
        suggestedTags: [],
        sensitivitySuggestion: 'normal',
      },
      blocks: [],
      warnings: [],
      sourceFragmentIds: [],
      review: { status: 'model_reviewed', limitations: [] },
    },
  }
}

function installFetchMock(options: {
  tasks: AITask[]
  artifacts: ArtifactSummary[]
}) {
  const calls: RecordedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url })
      if (url.startsWith('/api/v1/ai/providers')) return Promise.resolve(jsonResponse({ items: [] }))
      if (url.startsWith('/api/v1/ai/settings')) {
        return Promise.resolve(
          jsonResponse({
            sensitiveDisplayMode: 'masked',
            sensitiveAiPolicy: 'block',
            defaultOrganizeModelId: null,
            defaultReviewModelId: null,
            defaultVisionModelId: null,
          }),
        )
      }
      if (url.startsWith('/api/v1/ai/tasks?')) return Promise.resolve(jsonResponse({ items: options.tasks }))
      if (url.startsWith('/api/v1/ai/tasks/') && url.endsWith('/retry')) {
        const retry = taskFixture({ id: 'task-2', status: 'queued', retryOfTaskId: 'task-1' })
        return Promise.resolve(jsonResponse(retry))
      }
      if (/\/api\/v1\/artifacts\/[^/]+$/.test(url)) {
        return Promise.resolve(jsonResponse(artifactDetailFixture()))
      }
      if (url.includes('/artifacts')) return Promise.resolve(jsonResponse({ items: options.artifacts }))
      return Promise.resolve(jsonResponse({}))
    }),
  )
  return calls
}

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: { template: '<div />' } },
      { path: '/tasks', name: 'task-center', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  return mount(ItemAIView, {
    props: {
      itemId: 'item-1',
      sensitivity: 'normal' as const,
      attachments: [],
      initialArtifacts: [],
    },
    global: { plugins: [router] },
  })
}

describe('ItemAIView state recovery', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('rebuilds task and artifact state from server facts when the user returns', async () => {
    installFetchMock({
      tasks: [taskFixture({ status: 'running', startedAt: '2026-09-01T00:00:01Z' })],
      artifacts: [],
    })
    const firstVisit = await mountView()
    await flushPromises()
    expect(firstVisit.text()).toContain('运行中')
    firstVisit.unmount()

    installFetchMock({
      tasks: [taskFixture({ status: 'succeeded', finishedAt: '2026-09-01T00:00:04Z' })],
      artifacts: [artifactFixture()],
    })
    const secondVisit = await mountView()
    await flushPromises()

    expect(secondVisit.text()).toContain('模型审阅完成')
    expect(secondVisit.text()).toContain('整理标题')
    expect(secondVisit.text()).toContain('v1 · 当前')
    secondVisit.unmount()
  })

  it('keeps the original record usable after an AI failure and retries the existing task', async () => {
    const calls = installFetchMock({
      tasks: [taskFixture({ status: 'failed', errorCode: 'PROVIDER_FAILED', finishedAt: '2026-09-01T00:00:04Z' })],
      artifacts: [],
    })
    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('失败')
    expect(wrapper.text()).toContain('你仍可完整使用原始记录')

    const retryButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('重试'))
    expect(retryButton).toBeDefined()
    await retryButton?.trigger('click')
    await flushPromises()

    const retryCall = calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/api/v1/ai/tasks/task-1/retry'),
    )
    expect(retryCall).toBeDefined()
    expect(wrapper.text()).toContain('等待中')
    wrapper.unmount()
  })
})

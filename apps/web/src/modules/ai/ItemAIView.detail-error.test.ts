// DT-R121：列表已成功列出版本、但该版本详情 GET 失败时，不得落进“暂无 AI 派生版本”
// 误导空态；应呈现可理解的读取失败与原地“重新加载”入口，重读只 GET 当前版本详情。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import ItemAIView from './ItemAIView.vue'
import type { ArtifactDetail, ArtifactSummary } from './contracts'

const ITEM_ID = 'item-1'
const ARTIFACT_A = 'artifact-a'
const ARTIFACT_B = 'artifact-b'

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

function summaryFixture(id: string): ArtifactSummary {
  const isB = id === ARTIFACT_B
  return {
    id,
    itemId: ITEM_ID,
    taskRunId: 'task-1',
    artifactType: 'organized_record',
    versionNumber: isB ? 2 : 1,
    schemaVersion: '1.0',
    generator: 'builtin_worker',
    modelName: 'mock-model',
    promptVersion: 'organize-v2',
    createdAt: isB ? '2026-09-02T00:00:05Z' : '2026-09-01T00:00:05Z',
    invalidatedAt: null,
    active: isB,
    isStale: false,
  }
}

function detailFixture(id: string): ArtifactDetail {
  const isB = id === ARTIFACT_B
  return {
    ...summaryFixture(id),
    itemId: ITEM_ID,
    taskRunId: 'task-1',
    content: {
      schemaVersion: '1.0',
      artifactType: 'organized_record',
      title: isB ? '版本B标题' : '版本A标题',
      summary: isB ? '版本B摘要' : '版本A摘要',
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
  artifacts: ArtifactSummary[]
  // 第 n 次（从 1 起）对版本详情的 GET；返回 rejected Promise 即模拟该次读取失败。
  detail: (id: string, call: number) => Response | Promise<Response>
}) {
  const calls: RecordedCall[] = []
  let detailCalls = 0
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
      if (url.startsWith('/api/v1/ai/tasks?')) return Promise.resolve(jsonResponse({ items: [] }))
      if (url.startsWith(`/api/v1/items/${ITEM_ID}/artifacts`)) {
        return Promise.resolve(jsonResponse({ items: options.artifacts }))
      }
      const detailMatch = url.match(/^\/api\/v1\/artifacts\/([^/]+)$/)
      if (detailMatch && method === 'GET') {
        detailCalls += 1
        const call = detailCalls
        const id = detailMatch[1]
        return options.detail(id, call)
      }
      if (method !== 'GET') return Promise.resolve(jsonResponse({ ok: true }))
      return Promise.resolve(jsonResponse({}))
    }),
  )
  return {
    calls,
    detailGetCount: () => detailCalls,
  }
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((entry) => entry.text().includes(text))
  expect(button, `button ${text}`).toBeDefined()
  return button!
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
    attachTo: document.body,
    props: {
      itemId: ITEM_ID,
      sensitivity: 'normal' as const,
      attachments: [],
      initialArtifacts: [],
    },
    global: { plugins: [router] },
  })
}

async function selectVersion(wrapper: Awaited<ReturnType<typeof mountView>>, id: string) {
  const select = wrapper.find('.artifact-toolbar select')
  expect(select.exists(), 'version select').toBe(true)
  await select.setValue(id)
}

describe('ItemAIView artifact detail load failure', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('shows a readable load failure with a reload entry instead of the empty state', async () => {
    installFetchMock({
      artifacts: [summaryFixture(ARTIFACT_A)],
      detail: () => Promise.reject(new Error('版本详情暂时无法读取')),
    })
    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).not.toContain('暂无 AI 派生版本')
    expect(wrapper.text()).toContain('版本内容读取失败')
    expect(wrapper.text()).toContain('版本详情暂时无法读取')
    expect(buttonByText(wrapper, '重新加载')).toBeTruthy()
    wrapper.unmount()
  })

  it('reloads only the current detail via GET and restores content after an explicit retry', async () => {
    const { calls, detailGetCount } = installFetchMock({
      artifacts: [summaryFixture(ARTIFACT_A)],
      detail: (id, call) =>
        call === 1
          ? Promise.reject(new Error('版本详情暂时无法读取'))
          : Promise.resolve(jsonResponse(detailFixture(id))),
    })
    const wrapper = await mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('版本内容读取失败')
    expect(detailGetCount()).toBe(1)

    // 双击发生在 DOM 更新前：加载中的第二次发起必须被拦下，只允许一次重读 GET。
    const reload = buttonByText(wrapper, '重新加载')
    reload.element.click()
    reload.element.click()
    await flushPromises()

    expect(detailGetCount()).toBe(2)
    expect(
      calls.filter((call) => call.method !== 'GET'),
      'retry must not create tasks or POST anything',
    ).toHaveLength(0)
    expect(wrapper.text()).toContain('版本A标题')
    expect(wrapper.text()).not.toContain('版本内容读取失败')
    expect(wrapper.text()).not.toContain('暂无 AI 派生版本')
    wrapper.unmount()
  })

  it('keeps the true empty state when the artifact list is empty', async () => {
    const { detailGetCount } = installFetchMock({
      artifacts: [],
      detail: () => Promise.reject(new Error('版本详情暂时无法读取')),
    })
    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('暂无 AI 派生版本')
    expect(wrapper.text()).not.toContain('版本内容读取失败')
    expect(detailGetCount()).toBe(0)
    wrapper.unmount()
  })

  it('clears the stale failure when the user switches to another version after a failure', async () => {
    installFetchMock({
      artifacts: [summaryFixture(ARTIFACT_A), summaryFixture(ARTIFACT_B)],
      detail: (id) =>
        id === ARTIFACT_B
          ? Promise.reject(new Error('B 版本读取失败'))
          : Promise.resolve(jsonResponse(detailFixture(id))),
    })
    const wrapper = await mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('版本内容读取失败')
    expect(wrapper.text()).toContain('B 版本读取失败')

    await selectVersion(wrapper, ARTIFACT_A)
    await flushPromises()

    expect(wrapper.text()).toContain('版本A标题')
    expect(wrapper.text()).not.toContain('版本内容读取失败')
    expect(wrapper.text()).not.toContain('B 版本读取失败')
    wrapper.unmount()
  })
})

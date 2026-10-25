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

interface ArtifactPending {
  id: string
  resolve: () => void
  reject: (error: unknown) => void
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
        suggestedTags: isB ? ['新标签'] : ['旧标签'],
        sensitivitySuggestion: 'normal',
      },
      blocks: [],
      warnings: [],
      sourceFragmentIds: [],
      review: { status: 'model_reviewed', limitations: [] },
    },
  }
}

// Defers every artifact detail fetch so tests decide the arrival order of A and B.
function installFetchMock() {
  const calls: RecordedCall[] = []
  const pending: ArtifactPending[] = []
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
        return Promise.resolve(
          jsonResponse({ items: [summaryFixture(ARTIFACT_A), summaryFixture(ARTIFACT_B)] }),
        )
      }
      const actionMatch = url.match(
        /^\/api\/v1\/artifacts\/([^/]+)\/(activate|invalidate|apply-suggestions)$/,
      )
      if (actionMatch && method === 'POST') return Promise.resolve(jsonResponse({ ok: true }))
      const detailMatch = url.match(/^\/api\/v1\/artifacts\/([^/]+)$/)
      if (detailMatch) {
        const id = detailMatch[1]
        return new Promise<Response>((resolve, reject) => {
          pending.push({
            id,
            resolve: () => resolve(jsonResponse(detailFixture(id))),
            reject,
          })
        })
      }
      return Promise.resolve(jsonResponse({}))
    }),
  )
  return { calls, pending }
}

function takePending(pending: ArtifactPending[], id: string) {
  const index = pending.findIndex((entry) => entry.id === id)
  expect(index, `expected a pending fetch for ${id}`).toBeGreaterThanOrEqual(0)
  return pending.splice(index, 1)[0]
}

function buttonByText(text: string) {
  const button = [...document.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(text),
  )
  expect(button, `button ${text}`).toBeTruthy()
  return button as HTMLButtonElement
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

type ViewWrapper = Awaited<ReturnType<typeof mountView>>

async function selectVersion(wrapper: ViewWrapper, id: string) {
  const select = wrapper.find('.artifact-toolbar select')
  expect(select.exists(), 'version select').toBe(true)
  await select.setValue(id)
}

describe('ItemAIView artifact version race', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('keeps version B as the shown and acted-on version when a late A response arrives', async () => {
    const { calls, pending } = installFetchMock()
    const wrapper = await mountView()
    await flushPromises()

    await selectVersion(wrapper, ARTIFACT_A)
    await selectVersion(wrapper, ARTIFACT_B)
    takePending(pending, ARTIFACT_B).resolve()
    await flushPromises()
    takePending(pending, ARTIFACT_B).resolve()
    await flushPromises()
    takePending(pending, ARTIFACT_A).resolve()
    await flushPromises()

    expect(wrapper.text()).toContain('版本B标题')
    expect(wrapper.text()).not.toContain('版本A标题')
    expect(wrapper.text()).not.toContain('正在读取版本内容')

    buttonByText('作废版本').click()
    await flushPromises()
    expect(document.body.textContent).toContain('作废这个版本')
    buttonByText('确认').click()
    await flushPromises()

    expect(
      calls.find(
        (call) => call.method === 'POST' && call.path === `/api/v1/artifacts/${ARTIFACT_B}/invalidate`,
      ),
    ).toBeDefined()
    expect(
      calls.some(
        (call) => call.method === 'POST' && call.path === `/api/v1/artifacts/${ARTIFACT_A}/invalidate`,
      ),
    ).toBe(false)
    wrapper.unmount()
  })

  it('ignores a stale version A failure while version B is still loading', async () => {
    const { pending } = installFetchMock()
    const wrapper = await mountView()
    await flushPromises()

    await selectVersion(wrapper, ARTIFACT_A)
    await selectVersion(wrapper, ARTIFACT_B)
    takePending(pending, ARTIFACT_A).reject(new Error('A 读取失败'))
    await flushPromises()

    expect(wrapper.find('.ai-notice--error').exists()).toBe(false)
    expect(wrapper.text()).toContain('正在读取版本内容')

    takePending(pending, ARTIFACT_B).resolve()
    await flushPromises()
    takePending(pending, ARTIFACT_B).resolve()
    await flushPromises()

    expect(wrapper.text()).toContain('版本B标题')
    expect(wrapper.text()).not.toContain('正在读取版本内容')
    expect(wrapper.find('.ai-notice--error').exists()).toBe(false)
    wrapper.unmount()
  })

  it('closes the apply dialog opened for the old version when the selection switches', async () => {
    const { calls, pending } = installFetchMock()
    const wrapper = await mountView()
    await flushPromises()

    await selectVersion(wrapper, ARTIFACT_A)
    takePending(pending, ARTIFACT_A).resolve()
    await flushPromises()
    buttonByText('应用建议').click()
    await flushPromises()
    expect(document.body.textContent).toContain('选择要应用的建议')
    const title = document.querySelector<HTMLInputElement>('.suggestion input[type="checkbox"]')
    expect(title).not.toBeNull()
    title!.click()
    await flushPromises()

    await selectVersion(wrapper, ARTIFACT_B)
    await flushPromises()
    expect(document.body.textContent).not.toContain('选择要应用的建议')
    // DT-R25：旧版本的“应用建议”触发按钮随详情一起被移除，焦点应落回仍在组件中的版本选择器。
    expect(document.activeElement).toBe(wrapper.find('.artifact-toolbar select').element)
    takePending(pending, ARTIFACT_B).resolve()
    await flushPromises()
    takePending(pending, ARTIFACT_B).resolve()
    await flushPromises()

    expect(document.body.textContent).toContain('版本B标题')
    expect(document.body.textContent).not.toContain('选择要应用的建议')
    expect(
      calls.some((call) => call.method === 'POST' && call.path.endsWith('/apply-suggestions')),
    ).toBe(false)
    wrapper.unmount()
  })
})

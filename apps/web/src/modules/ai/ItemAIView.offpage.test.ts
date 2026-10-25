// DT-R27 离页竞态：组件 unmount 后，晚到的任务/POST 响应不得再触发任何 UI 读取、
// 轮询调度或父级刷新通知（后端任务继续执行，前端绝不补发 cancel）。
// 计数全部来自 fetch mock 的真实调用记录；先记录卸载前基线，再 resolve 晚到响应并推进 timer。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ItemAIView from './ItemAIView.vue'
import type { AITask, ArtifactDetail, ArtifactSummary, TaskStatus } from './contracts'

const ITEM_ID = 'item-1'
const ARTIFACT_A = 'artifact-a'
const ARTIFACT_B = 'artifact-b'
const TASK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const REVIEW_TASK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

interface RecordedCall {
  method: string
  path: string
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function taskFixture(
  id: string,
  status: TaskStatus,
  taskType: AITask['taskType'] = 'organize_record',
): AITask {
  return {
    id,
    taskType,
    itemId: ITEM_ID,
    parentTaskId: null,
    triggerType: 'manual',
    modelId: null,
    status,
    sensitivePolicy: 'block',
    promptVersion: 'organize-v1',
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
    events: [],
  }
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

interface FetchPlan {
  // 第 n 次（从 1 起）任务列表 GET 的返回；返回挂起 Promise 即挂起该次请求。
  tasksList: (call: number) => Response | Promise<Response>
  artifactsList?: (call: number) => Response | Promise<Response>
  retryPost?: () => Response | Promise<Response>
  invalidatePost?: () => Response | Promise<Response>
}

function installFetchMock(plan: FetchPlan) {
  const calls: RecordedCall[] = []
  let tasksListCalls = 0
  let artifactsListCalls = 0
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, path })
    if (path === '/api/v1/ai/providers') return Promise.resolve(jsonResponse({ items: [] }))
    if (path === '/api/v1/ai/settings') {
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
    if (path.startsWith('/api/v1/ai/tasks?')) {
      tasksListCalls += 1
      return Promise.resolve(plan.tasksList(tasksListCalls))
    }
    if (path === `/api/v1/items/${ITEM_ID}/artifacts`) {
      artifactsListCalls += 1
      return Promise.resolve(
        plan.artifactsList
          ? plan.artifactsList(artifactsListCalls)
          : jsonResponse({ items: [summaryFixture(ARTIFACT_A), summaryFixture(ARTIFACT_B)] }),
      )
    }
    if (new RegExp(`^/api/v1/ai/tasks/[^/]+/retry$`).test(path) && method === 'POST') {
      return Promise.resolve(plan.retryPost ? plan.retryPost() : jsonResponse(taskFixture(TASK_ID, 'queued')))
    }
    if (new RegExp(`^/api/v1/ai/tasks/[^/]+/cancel$`).test(path) && method === 'POST') {
      return Promise.resolve(jsonResponse(taskFixture(TASK_ID, 'running')))
    }
    const actionMatch = path.match(/^\/api\/v1\/artifacts\/([^/]+)\/(activate|invalidate|apply-suggestions)$/)
    if (actionMatch && method === 'POST') {
      if (actionMatch[2] === 'invalidate' && plan.invalidatePost) {
        return Promise.resolve(plan.invalidatePost())
      }
      return Promise.resolve(jsonResponse({ ok: true }))
    }
    if (/^\/api\/v1\/artifacts\/[^/]+$/.test(path) && method === 'GET') {
      return Promise.resolve(jsonResponse(detailFixture(path.split('/').at(-1) ?? '')))
    }
    throw new Error(`unexpected request: ${method} ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls }
}

const isTasksListGet = (path: string) => path.startsWith('/api/v1/ai/tasks?')
const isArtifactsListGet = (path: string) => path === `/api/v1/items/${ITEM_ID}/artifacts`
const isArtifactDetailGet = (path: string) => /^\/api\/v1\/artifacts\/[^/]+$/.test(path)
const isCancelPost = (path: string) => /^\/api\/v1\/ai\/tasks\/[^/]+\/cancel$/.test(path)

function countCalls(calls: RecordedCall[], method: string, match: (path: string) => boolean) {
  return calls.filter((call) => call.method === method && match(call.path)).length
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

describe('ItemAIView off-page behavior', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('schedules no polling and no artifact reads when the initial task list resolves after unmount', async () => {
    vi.useFakeTimers()
    const lateTasks = deferred<Response>()
    const running = () => jsonResponse({ items: [taskFixture(TASK_ID, 'running')] })
    const { calls } = installFetchMock({
      tasksList: (call) => (call === 1 ? lateTasks.promise : running()),
    })
    const wrapper = await mountView()
    await flushPromises()

    const tasksBaseline = countCalls(calls, 'GET', isTasksListGet)
    const listBaseline = countCalls(calls, 'GET', isArtifactsListGet)
    const detailBaseline = countCalls(calls, 'GET', isArtifactDetailGet)
    expect(tasksBaseline, 'initial task list GET must have been issued').toBe(1)
    expect(listBaseline, 'initial artifact list GET must have been issued').toBe(1)
    expect(detailBaseline, 'initial artifact detail GET must have been issued').toBe(1)

    wrapper.unmount()
    lateTasks.resolve(running())
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3800)

    expect(countCalls(calls, 'GET', isTasksListGet), 'no task list GET after unmount').toBe(
      tasksBaseline,
    )
    expect(countCalls(calls, 'GET', isArtifactsListGet), 'no artifact list GET after unmount').toBe(
      listBaseline,
    )
    expect(
      countCalls(calls, 'GET', isArtifactDetailGet),
      'no artifact detail GET after unmount',
    ).toBe(detailBaseline)
  })

  it('stops the polling chain when an in-flight poll resolves after unmount', async () => {
    vi.useFakeTimers()
    const latePoll = deferred<Response>()
    const running = () => jsonResponse({ items: [taskFixture(TASK_ID, 'running')] })
    const { calls } = installFetchMock({
      tasksList: (call) => (call === 2 ? latePoll.promise : running()),
    })
    const wrapper = await mountView()
    await flushPromises()

    await vi.advanceTimersByTimeAsync(2500)
    const tasksBaseline = countCalls(calls, 'GET', isTasksListGet)
    const listBaseline = countCalls(calls, 'GET', isArtifactsListGet)
    const detailBaseline = countCalls(calls, 'GET', isArtifactDetailGet)
    expect(tasksBaseline, 'first poll must be in flight').toBe(2)
    expect(listBaseline).toBe(1)
    expect(detailBaseline).toBe(1)

    wrapper.unmount()
    latePoll.resolve(running())
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3000)

    expect(countCalls(calls, 'GET', isTasksListGet), 'no further poll after unmount').toBe(
      tasksBaseline,
    )
    expect(countCalls(calls, 'GET', isArtifactsListGet), 'no artifact list GET after unmount').toBe(
      listBaseline,
    )
    expect(
      countCalls(calls, 'GET', isArtifactDetailGet),
      'no artifact detail GET after unmount',
    ).toBe(detailBaseline)
  })

  it('schedules no reload after unmount when a retry POST resolves late', async () => {
    vi.useFakeTimers()
    const lateRetry = deferred<Response>()
    const failed = () => jsonResponse({ items: [taskFixture(TASK_ID, 'failed')] })
    const retryPath = `/api/v1/ai/tasks/${TASK_ID}/retry`
    const { calls } = installFetchMock({
      tasksList: () => failed(),
      retryPost: () => lateRetry.promise,
    })
    const wrapper = await mountView()
    await flushPromises()

    const tasksBaseline = countCalls(calls, 'GET', isTasksListGet)
    const listBaseline = countCalls(calls, 'GET', isArtifactsListGet)
    expect(tasksBaseline, 'initial task list GET must have been issued').toBe(1)

    buttonByText('重试').click()
    await flushPromises()
    expect(countCalls(calls, 'POST', (path) => path === retryPath)).toBe(1)

    wrapper.unmount()
    lateRetry.resolve(jsonResponse(taskFixture(TASK_ID, 'queued')))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3800)

    expect(countCalls(calls, 'POST', (path) => path === retryPath), 'retry fires exactly once').toBe(
      1,
    )
    expect(countCalls(calls, 'POST', isCancelPost), 'never cancels the backend task').toBe(0)
    expect(countCalls(calls, 'GET', isTasksListGet), 'no task reload after unmount').toBe(
      tasksBaseline,
    )
    expect(countCalls(calls, 'GET', isArtifactsListGet), 'no artifact list GET after unmount').toBe(
      listBaseline,
    )
  })

  it('does not reload artifacts or notify the parent when an artifact action resolves after unmount', async () => {
    vi.useFakeTimers()
    const lateInvalidate = deferred<Response>()
    const invalidatePath = `/api/v1/artifacts/${ARTIFACT_B}/invalidate`
    const { calls } = installFetchMock({
      tasksList: () => jsonResponse({ items: [] }),
      invalidatePost: () => lateInvalidate.promise,
    })
    const wrapper = await mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('版本B标题')

    const listBaseline = countCalls(calls, 'GET', isArtifactsListGet)
    const detailBaseline = countCalls(calls, 'GET', isArtifactDetailGet)
    expect(listBaseline).toBe(1)
    expect(detailBaseline).toBe(1)

    buttonByText('作废版本').click()
    await flushPromises()
    expect(document.body.textContent).toContain('作废这个版本')
    buttonByText('确认').click()
    await flushPromises()
    expect(countCalls(calls, 'POST', (path) => path === invalidatePath)).toBe(1)
    const changedAtUnmount = wrapper.emitted('changed')?.length ?? 0

    wrapper.unmount()
    lateInvalidate.resolve(jsonResponse({ ok: true }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)

    expect(countCalls(calls, 'GET', isArtifactsListGet), 'no artifact list reload after unmount').toBe(
      listBaseline,
    )
    expect(
      countCalls(calls, 'GET', isArtifactDetailGet),
      'no artifact detail reload after unmount',
    ).toBe(detailBaseline)
    // 现存合同守卫：Vue 核心对已卸载实例的 emit 直接早退（instance.isUnmounted），
    // 该保障先于本轮修复即存在，不归本轮修复；本用例旧红仅由上面两条 artifact 重读计数承担。
    expect(wrapper.emitted('changed')?.length ?? 0).toBe(changedAtUnmount)
  })

  it('stops an orphaned 2500ms poll overwritten by a retry timer from issuing a GET after unmount', async () => {
    vi.useFakeTimers()
    // 同一记录允许不同 taskType 并发：running 整理 + failed 审阅可重试，不会触发后端 AI_TASK_ALREADY_ACTIVE。
    const { calls } = installFetchMock({
      tasksList: () =>
        jsonResponse({
          items: [
            taskFixture(TASK_ID, 'running', 'organize_record'),
            taskFixture(REVIEW_TASK_ID, 'failed', 'review_record'),
          ],
        }),
      retryPost: () => jsonResponse(taskFixture(REVIEW_TASK_ID, 'queued', 'review_record')),
    })
    const wrapper = await mountView()
    await flushPromises()
    const tasksBaseline = countCalls(calls, 'GET', isTasksListGet)
    expect(tasksBaseline, 'initial task list GET must have been issued').toBe(1)

    // 挂载期间重试成功：800ms timer 覆盖掉仍在等待的 2500ms 轮询句柄。
    const retryPath = `/api/v1/ai/tasks/${REVIEW_TASK_ID}/retry`
    buttonByText('重试').click()
    await flushPromises()
    expect(countCalls(calls, 'POST', (path) => path === retryPath)).toBe(1)

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(2600)

    expect(
      countCalls(calls, 'GET', isTasksListGet),
      'orphaned 2500ms poll must not issue a GET after unmount',
    ).toBe(tasksBaseline)
    expect(countCalls(calls, 'POST', (path) => path === retryPath), 'retry fires exactly once').toBe(
      1,
    )
    expect(countCalls(calls, 'POST', isCancelPost), 'never cancels the backend task').toBe(0)
  })

  it('starts no nested artifact detail read when the post-action list resolves after unmount', async () => {
    vi.useFakeTimers()
    const lateList = deferred<Response>()
    const list = () => jsonResponse({ items: [summaryFixture(ARTIFACT_A), summaryFixture(ARTIFACT_B)] })
    const { calls } = installFetchMock({
      tasksList: () => jsonResponse({ items: [] }),
      invalidatePost: () => jsonResponse({ ok: true }),
      artifactsList: (call) => (call === 2 ? lateList.promise : list()),
    })
    const wrapper = await mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('版本B标题')

    const listBaseline = countCalls(calls, 'GET', isArtifactsListGet)
    const detailBaseline = countCalls(calls, 'GET', isArtifactDetailGet)
    expect(listBaseline).toBe(1)
    expect(detailBaseline).toBe(1)

    // 动作 POST 在挂载时正常完成，随后的列表读取挂起；此时离页。
    buttonByText('作废版本').click()
    await flushPromises()
    buttonByText('确认').click()
    await flushPromises()
    expect(countCalls(calls, 'GET', isArtifactsListGet), 'post-action list read is in flight').toBe(
      listBaseline + 1,
    )
    const changedAtUnmount = wrapper.emitted('changed')?.length ?? 0

    wrapper.unmount()
    // 列表仍包含当前选中版本：旧代码会因 current 仍在而显式 loadArtifact(id) 补发详情 GET。
    lateList.resolve(list())
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)

    expect(
      countCalls(calls, 'GET', isArtifactsListGet),
      'no artifact list GET beyond the in-flight one',
    ).toBe(listBaseline + 1)
    expect(
      countCalls(calls, 'GET', isArtifactDetailGet),
      'no nested artifact detail read after unmount',
    ).toBe(detailBaseline)
    // 现存合同守卫：Vue 核心对已卸载实例的 emit 直接早退（instance.isUnmounted），
    // 该保障先于本轮修复即存在，不归本轮修复；本用例旧红由详情重读计数承担。
    expect(wrapper.emitted('changed')?.length ?? 0).toBe(changedAtUnmount)
  })
})

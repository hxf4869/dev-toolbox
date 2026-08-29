import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import AIScheduleView from './AIScheduleView.vue'
import TaskCenterView from './TaskCenterView.vue'

const itemID = '11111111-1111-4111-8111-111111111111'
const taskID = '22222222-2222-4222-8222-222222222222'
const modelID = '33333333-3333-4333-8333-333333333333'

describe('M4 task workbench', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('shows a running cancellation as a request and creates an isolated batch payload', async () => {
    let cancelRequested = false
    let batchBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') {
        return jsonResponse({ items: [libraryItem()] })
      }
      if (path === '/api/v1/ai/tasks?limit=100') {
        return jsonResponse({ items: [runningTask(cancelRequested)] })
      }
      if (path === `/api/v1/ai/tasks/${taskID}` && !init?.method) {
        return jsonResponse(runningTask(cancelRequested, true))
      }
      if (path === `/api/v1/ai/tasks/${taskID}/cancel` && init?.method === 'POST') {
        cancelRequested = true
        return jsonResponse(runningTask(true))
      }
      if (path === '/api/v1/ai/tasks' && init?.method === 'POST') {
        batchBody = JSON.parse(String(init.body))
        return jsonResponse({ ...runningTask(false), id: '44444444-4444-4444-8444-444444444444', taskType: 'batch_organize', itemId: null, status: 'running', batchSummary: { selectedItems: 1, createdChildren: 1, childStatusCounts: { queued: 1, running: 0, succeeded: 0, failed: 0, cancelled: 0 }, skipped: { total: 0, byReason: { already_covered: 0, already_queued_or_running: 0, no_supported_content: 0, vision_model_unavailable: 0, sensitive_blocked: 0, sensitive_image_redaction_unsupported: 0 } } } }, 201)
      }
      if (path === '/api/v1/ai/tasks/44444444-4444-4444-8444-444444444444') {
        return jsonResponse({ ...runningTask(false, true), id: '44444444-4444-4444-8444-444444444444', taskType: 'batch_organize', itemId: null })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    buttonByText('取消任务').click()
    await flushPromises()
    expect(cancelRequested).toBe(true)
    expect(document.body.textContent).toContain('取消请求已记录')
    expect(document.body.textContent).toContain('等待安全边界')

    buttonByText('批量整理').click()
    await flushPromises()
    const item = document.querySelector<HTMLInputElement>('.batch-list input[type="checkbox"]')
    expect(item).not.toBeNull()
    item!.click()
    await flushPromises()
    buttonByText('开始批量整理').click()
    await flushPromises()

    expect(batchBody).toEqual({
      taskType: 'batch_organize',
      itemIds: [itemID],
      organizeModelId: modelID,
      visionModelId: modelID,
      sensitivePolicy: 'redact',
    })
    wrapper.unmount()
  })

  it('keeps automatic organization off by default and saves an explicit daily window', async () => {
    let savedBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/ai/schedule' && init?.method === 'PUT') {
        savedBody = JSON.parse(String(init.body))
        return jsonResponse({ ...savedBody, organizeModelId: modelID, visionModelId: null })
      }
      if (path === '/api/v1/ai/schedule') {
        return jsonResponse({ frequency: 'off', timezone: 'Asia/Shanghai', localTime: '02:00', weekday: 1, organizeModelId: null, visionModelId: null, sensitivePolicy: 'block' })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountWithRouter(AIScheduleView, '/settings/ai-schedule')
    await flushPromises()

    expect(document.body.textContent).toContain('已关闭')
    document.querySelector<HTMLInputElement>('input[value="daily"]')?.click()
    const selects = document.querySelectorAll<HTMLSelectElement>('.schedule-form select')
    const organizeSelect = Array.from(selects).find((select) =>
      Array.from(select.options).some((option) => option.value === modelID),
    )
    expect(organizeSelect).not.toBeNull()
    organizeSelect!.value = modelID
    organizeSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    buttonByText('保存设置').click()
    await flushPromises()

    expect(savedBody).toMatchObject({
      frequency: 'daily',
      timezone: 'Asia/Shanghai',
      localTime: '02:00',
      organizeModelId: modelID,
      sensitivePolicy: 'block',
    })
    expect(document.body.textContent).toContain('自动整理设置已保存')
    wrapper.unmount()
  })

  it('offers retry for a cancelled batch and opens the new parent task', async () => {
    const retryID = '66666666-6666-4666-8666-666666666666'
    let retried = false
    const cancelled = batchTask(taskID, 'cancelled')
    const retry = batchTask(retryID, 'queued', taskID)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') {
        return jsonResponse({ items: [libraryItem()] })
      }
      if (path === '/api/v1/ai/tasks?limit=100') {
        return jsonResponse({ items: retried ? [retry, cancelled] : [cancelled] })
      }
      if (path === `/api/v1/ai/tasks/${taskID}` && !init?.method) return jsonResponse(cancelled)
      if (path === `/api/v1/ai/tasks/${taskID}/retry` && init?.method === 'POST') {
        retried = true
        return jsonResponse(retry, 201)
      }
      if (path === `/api/v1/ai/tasks/${retryID}` && !init?.method) return jsonResponse(retry)
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    buttonByText('创建重试任务').click()
    await flushPromises()

    expect(retried).toBe(true)
    expect(document.body.textContent).toContain('已创建新的重试任务')
    expect(document.body.textContent).toContain(`这是任务 ${taskID.slice(0, 8)}`)
    wrapper.unmount()
  })
})

async function mountWithRouter(component: object, path: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ai/tasks', name: 'task-center', component: { template: '<div />' } },
      { path: '/items/:itemId', name: 'item-detail', component: { template: '<div />' } },
      { path: '/settings/ai-schedule', name: 'ai-schedule-settings', component: { template: '<div />' } },
      { path: '/settings/providers', name: 'provider-settings', component: { template: '<div />' } },
      { path: '/settings/tokens', name: 'token-settings', component: { template: '<div />' } },
      { path: '/settings/ai-security', name: 'ai-security-settings', component: { template: '<div />' } },
      { path: '/settings/security', name: 'security-settings', component: { template: '<div />' } },
      { path: '/settings/appearance', name: 'appearance-settings', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  return mount(component, { attachTo: document.body, global: { plugins: [pinia, router] } })
}

function provider() {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    displayName: '本地 Mock',
    enabled: true,
    models: [{ id: modelID, displayName: 'Mock Model', modelId: 'mock-model', contextWindow: 8192, maxOutputTokens: 1024, supportsTools: true, supportsVision: true, enabled: true }],
  }
}

function settings() {
  return { sensitiveDisplayMode: 'masked', sensitiveAiPolicy: 'redact', defaultOrganizeModelId: modelID, defaultReviewModelId: modelID, defaultVisionModelId: modelID }
}

function libraryItem() {
  return { id: itemID, title: '生产排障记录', sensitivity: 'normal', favorite: false, folderId: null, tags: [], summary: '摘要', createdAt: '2026-08-30T01:00:00Z', updatedAt: '2026-08-30T01:00:00Z', deletedAt: null, effectiveCapturedAt: '2026-08-30T01:00:00Z', sourceTimeQuality: 'exact', rawRecordCount: 1, attachmentCount: 0, attachments: [] }
}

function runningTask(cancelRequested = false, withEvents = false) {
  return {
    id: taskID, taskType: 'organize_record', itemId: itemID, parentTaskId: null, triggerType: 'manual', modelId: modelID,
    status: 'running', sensitivePolicy: 'redact', promptVersion: 'organize-v1', schemaVersion: '1.0', retryOfTaskId: null,
    queuedAt: '2026-08-30T01:00:00Z', startedAt: '2026-08-30T01:00:01Z', finishedAt: null,
    cancelRequestedAt: cancelRequested ? '2026-08-30T01:00:02Z' : null, cancelRequested,
    errorCode: null, errorDetail: null, inputTokens: null, outputTokens: null,
    events: withEvents ? [{ id: 1, type: 'model_request_started', summary: '正在请求模型', details: {}, createdAt: '2026-08-30T01:00:02Z' }] : undefined,
  }
}

function batchTask(id: string, status: 'queued' | 'cancelled', retryOfTaskId: string | null = null) {
  return {
    id, taskType: 'batch_organize', itemId: null, parentTaskId: null, triggerType: 'manual', modelId: modelID,
    status, sensitivePolicy: 'redact', promptVersion: 'batch-organize-v1', schemaVersion: '1.0', retryOfTaskId,
    queuedAt: '2026-08-30T01:00:00Z', startedAt: status === 'cancelled' ? '2026-08-30T01:00:01Z' : null,
    finishedAt: status === 'cancelled' ? '2026-08-30T01:00:02Z' : null, cancelRequestedAt: null,
    cancelRequested: false, errorCode: null, errorDetail: null, inputTokens: null, outputTokens: null,
    events: [],
    batchSummary: {
      selectedItems: 1,
      createdChildren: status === 'cancelled' ? 1 : 0,
      childStatusCounts: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: status === 'cancelled' ? 1 : 0 },
      skipped: { total: 0, byReason: { already_covered: 0, already_queued_or_running: 0, no_supported_content: 0, vision_model_unavailable: 0, sensitive_blocked: 0, sensitive_image_redaction_unsupported: 0 } },
    },
  }
}

function buttonByText(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent?.trim().includes(text))
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

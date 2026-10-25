import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import TaskCenterView from './TaskCenterView.vue'
import { taskStatusLabels, type TaskStatus } from './contracts'

const taskAID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const taskBID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const taskCID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const taskDID = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'

describe('task center selection and polling ownership', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the latest clicked task when an earlier detail response resolves late and scopes follow-up actions to it', async () => {
    vi.useFakeTimers()
    const detailA = deferred<Response>()
    const detailB = deferred<Response>()
    const cancelPost = deferred<Response>()
    let aDetailCalls = 0
    let bDetailCalls = 0
    let listCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        listCalls += 1
        return jsonResponse({ items: [task(taskAID), task(taskBID, 'running')] })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return aDetailCalls === 1 ? jsonResponse(task(taskAID)) : detailA.promise
      }
      if (path === `/api/v1/ai/tasks/${taskBID}` && !init?.method) {
        bDetailCalls += 1
        return bDetailCalls === 1 ? detailB.promise : jsonResponse(task(taskBID, 'running'))
      }
      if (path === `/api/v1/ai/tasks/${taskBID}/cancel` && init?.method === 'POST') return cancelPost.promise
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')

    listButton(0).click()
    listButton(1).click()
    detailB.resolve(jsonResponse(task(taskBID, 'running')))
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)

    detailA.resolve(jsonResponse(task(taskAID)))
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()

    buttonByText('取消任务').click()
    await flushPromises()
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/cancel'))).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/v1/ai/tasks/${taskAID}/cancel`)).toBe(false)

    wrapper.unmount()
    cancelPost.resolve(jsonResponse({ ...task(taskBID, 'running'), cancelRequested: true }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10000)
    expect(listCalls).toBe(1)
    expect(bDetailCalls).toBe(1)
    expect(aDetailCalls).toBe(2)
  })

  it('does not surface a stale detail failure or clear the loading state of the newer request', async () => {
    const detailA = deferred<Response>()
    const detailB = deferred<Response>()
    let aDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') return jsonResponse({ items: [task(taskAID), task(taskBID)] })
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return aDetailCalls === 1 ? jsonResponse(task(taskAID)) : detailA.promise
      }
      if (path === `/api/v1/ai/tasks/${taskBID}`) return detailB.promise
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    listButton(0).click()
    listButton(1).click()
    detailA.reject(new Error('旧任务详情读取失败'))
    await flushPromises()
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(document.querySelector('.task-detail .center-loading')).not.toBeNull()

    detailB.resolve(jsonResponse(task(taskBID)))
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    wrapper.unmount()
  })

  it('does not let a background list poll reselect the previous task while the clicked detail is pending', async () => {
    vi.useFakeTimers()
    const detailB = deferred<Response>()
    let aDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        return jsonResponse({ items: [task(taskAID, 'running'), task(taskBID)] })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return jsonResponse(task(taskAID, 'running'))
      }
      if (path === `/api/v1/ai/tasks/${taskBID}`) return detailB.promise
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?taskId=${taskAID}`)
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')

    listButton(1).click()
    await vi.advanceTimersByTimeAsync(2500)
    expect(aDetailCalls).toBe(1)
    expect(document.querySelector('.task-detail .center-loading')).not.toBeNull()

    detailB.resolve(jsonResponse(task(taskBID)))
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    wrapper.unmount()
  })

  it('stops polling after unmount when a list response lands late with running tasks', async () => {
    vi.useFakeTimers()
    const lateList = deferred<Response>()
    let listCalls = 0
    let aDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        listCalls += 1
        return listCalls === 1 ? jsonResponse({ items: [task(taskAID, 'running')] }) : lateList.promise
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return jsonResponse(task(taskAID, 'running'))
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await vi.advanceTimersByTimeAsync(2500)
    expect(listCalls).toBe(2)
    wrapper.unmount()

    lateList.resolve(jsonResponse({ items: [task(taskAID, 'running')] }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10000)
    expect(listCalls).toBe(2)
    expect(aDetailCalls).toBe(1)
  })

  it('does not start task loading when the bootstrap read resolves after unmount', async () => {
    const lateProviders = deferred<Response>()
    let listCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return lateProviders.promise
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        listCalls += 1
        return jsonResponse({ items: [task(taskAID)] })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(task(taskAID))
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()
    expect(listCalls).toBe(0)

    wrapper.unmount()
    lateProviders.resolve(jsonResponse({ items: [] }))
    await flushPromises()
    expect(listCalls).toBe(0)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/v1/ai/tasks/'))).toHaveLength(0)
  })

  it('refreshes the cancelled task in place, and stays on the newer task when the cancel POST lands late', async () => {
    vi.useFakeTimers()
    const cancelPostA = deferred<Response>()
    const cancelPostB = deferred<Response>()
    let listCalls = 0
    let aDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        listCalls += 1
        const items =
          listCalls === 1
            ? [task(taskAID, 'running'), task(taskBID, 'running'), task(taskCID, 'running')]
            : listCalls === 2
              ? [task(taskAID, 'cancelled'), task(taskBID, 'running'), task(taskCID, 'running')]
              : [task(taskAID, 'cancelled'), task(taskBID, 'cancelled'), task(taskCID, 'running')]
        return jsonResponse({ items })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return jsonResponse(task(taskAID, aDetailCalls === 1 ? 'running' : 'cancelled'))
      }
      if (path === `/api/v1/ai/tasks/${taskBID}` && !init?.method) return jsonResponse(task(taskBID, 'running'))
      if (path === `/api/v1/ai/tasks/${taskCID}`) return jsonResponse(task(taskCID, 'running'))
      if (path === `/api/v1/ai/tasks/${taskAID}/cancel` && init?.method === 'POST') return cancelPostA.promise
      if (path === `/api/v1/ai/tasks/${taskBID}/cancel` && init?.method === 'POST') return cancelPostB.promise
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?taskId=${taskAID}`)
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(buttonByText('取消任务').disabled).toBe(false)

    buttonByText('取消任务').click()
    await flushPromises()
    cancelPostA.resolve(jsonResponse(task(taskAID, 'cancelled')))
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(detailStatusText()).toBe(taskStatusLabels.cancelled)
    expect(noticeElement()?.textContent).toContain('任务已取消')
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)

    expect(listButton(1).disabled).toBe(false)
    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)

    buttonByText('取消任务').click()
    await flushPromises()
    expect(listButton(2).disabled).toBe(false)
    expect(statusTab('全部').disabled).toBe(false)
    listButton(2).click()
    await flushPromises()
    expect(detailTaskText()).toContain('cccccccc')
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)

    cancelPostB.resolve(jsonResponse(task(taskBID, 'cancelled')))
    await flushPromises()
    expect(detailTaskText()).toContain('cccccccc')
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(noticeElement()).toBeNull()
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(buttonByText('取消任务').disabled).toBe(false)
    expect(listButton(1).textContent).toContain(taskStatusLabels.cancelled)
    wrapper.unmount()
  })

  it('keeps the normal retry follow-up: resets the filter, selects the new retry task and updates the URL', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100')
        return jsonResponse({ items: [task(taskAID, 'failed'), task(taskBID, 'running'), task(taskCID, 'queued')] })
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(task(taskAID, 'failed'))
      if (path === `/api/v1/ai/tasks/${taskCID}`) return jsonResponse({ ...task(taskCID, 'queued'), retryOfTaskId: taskAID })
      if (path === `/api/v1/ai/tasks/${taskAID}/retry` && init?.method === 'POST')
        return jsonResponse({ ...task(taskCID, 'queued'), retryOfTaskId: taskAID })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const retryPostCalls = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === `/api/v1/ai/tasks/${taskAID}/retry` && init?.method === 'POST',
      )
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?status=failed&taskId=${taskAID}`)
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)
    expect(statusTab(taskStatusLabels.failed).disabled).toBe(false)

    buttonByText('创建重试任务').click()
    await flushPromises()
    expect(detailTaskText()).toContain('cccccccc')
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(router.currentRoute.value.query.status).toBeUndefined()
    expect(activeStatusTab()).toContain('全部')
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(3)
    expect(noticeElement()?.textContent).toContain('已创建新的重试任务')
    expect(buttonByText('取消任务').disabled).toBe(false)
    expect(retryPostCalls()).toHaveLength(1)

    const fullPathAfterRetry = router.currentRoute.value.fullPath
    wrapper.unmount()
    const remounted = await mountWithRouter(TaskCenterView, fullPathAfterRetry)
    await flushPromises()
    expect(remounted.router.currentRoute.value.fullPath).toBe(fullPathAfterRetry)
    expect(activeStatusTab()).toContain('全部')
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(3)
    expect(listButton(2).textContent).toContain(taskStatusLabels.queued)
    expect(detailTaskText()).toContain('cccccccc')
    expect(remounted.router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(buttonByText('取消任务').disabled).toBe(false)
    expect(retryPostCalls()).toHaveLength(1)
    remounted.wrapper.unmount()
  })

  it('does not let a late retry follow-up override the newer selection or the user-applied filter', async () => {
    vi.useFakeTimers()
    const retryPost = deferred<Response>()
    let listCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        listCalls += 1
        const items =
          listCalls <= 2
            ? [task(taskAID, 'failed'), task(taskBID, 'failed')]
            : [task(taskAID, 'failed'), task(taskBID, 'failed'), { ...task(taskCID, 'queued'), retryOfTaskId: taskAID }]
        return jsonResponse({ items })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(task(taskAID, 'failed'))
      if (path === `/api/v1/ai/tasks/${taskBID}`) return jsonResponse(task(taskBID, 'failed'))
      if (path === `/api/v1/ai/tasks/${taskCID}`) return jsonResponse({ ...task(taskCID, 'queued'), retryOfTaskId: taskAID })
      if (path === `/api/v1/ai/tasks/${taskAID}/retry` && init?.method === 'POST') return retryPost.promise
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?taskId=${taskAID}`)
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(listButton(1).disabled).toBe(false)
    expect(statusTab('全部').disabled).toBe(false)

    buttonByText('创建重试任务').click()
    await flushPromises()
    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)

    expect(statusTab(taskStatusLabels.failed).disabled).toBe(false)
    statusTab(taskStatusLabels.failed).click()
    await flushPromises()
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)

    retryPost.resolve(jsonResponse({ ...task(taskCID, 'queued'), retryOfTaskId: taskAID }))
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)
    expect(noticeElement()).toBeNull()
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/v1/ai/tasks/${taskCID}`)).toBe(false)
    expect(statusTab('全部').textContent).toContain('3')
    wrapper.unmount()
  })

  it('keeps the user status filter when the item filter is cleared while a retry is pending', async () => {
    vi.useFakeTimers()
    const retryPost = deferred<Response>()
    let unfilteredLists = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100&itemId=item-1')
        return jsonResponse({ items: [task(taskAID, 'failed')] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        unfilteredLists += 1
        const items =
          unfilteredLists === 1
            ? [task(taskAID, 'failed')]
            : [task(taskAID, 'failed'), { ...task(taskCID, 'queued'), retryOfTaskId: taskAID }]
        return jsonResponse({ items })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(task(taskAID, 'failed'))
      if (path === `/api/v1/ai/tasks/${taskCID}`) return jsonResponse({ ...task(taskCID, 'queued'), retryOfTaskId: taskAID })
      if (path === `/api/v1/ai/tasks/${taskAID}/retry` && init?.method === 'POST') return retryPost.promise
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(
      TaskCenterView,
      `/ai/tasks?itemId=item-1&status=failed&taskId=${taskAID}`,
    )
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)

    const clearItem = document.querySelector<HTMLButtonElement>('.filter-chip button')
    if (!clearItem) throw new Error('clear item filter button not found')
    expect(clearItem.disabled).toBe(false)

    buttonByText('创建重试任务').click()
    await flushPromises()
    clearItem.click()
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)
    expect(document.querySelector('.filter-chip')).toBeNull()

    retryPost.resolve(jsonResponse({ ...task(taskCID, 'queued'), retryOfTaskId: taskAID }))
    await flushPromises()
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/v1/ai/tasks/${taskCID}`)).toBe(false)
    expect(statusTab('全部').textContent).toContain('2')
    wrapper.unmount()
  })

  it('does not hijack the selection when the retry list refresh resolves after the user switched tasks', async () => {
    vi.useFakeTimers()
    const refreshList = deferred<Response>()
    let listCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        listCalls += 1
        return listCalls === 1
          ? jsonResponse({ items: [task(taskAID, 'failed'), task(taskBID, 'running')] })
          : refreshList.promise
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(task(taskAID, 'failed'))
      if (path === `/api/v1/ai/tasks/${taskBID}`) return jsonResponse(task(taskBID, 'running'))
      if (path === `/api/v1/ai/tasks/${taskCID}`) return jsonResponse({ ...task(taskCID, 'queued'), retryOfTaskId: taskAID })
      if (path === `/api/v1/ai/tasks/${taskAID}/retry` && init?.method === 'POST')
        return jsonResponse({ ...task(taskCID, 'queued'), retryOfTaskId: taskAID })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?taskId=${taskAID}`)
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')

    buttonByText('创建重试任务').click()
    await flushPromises()
    expect(noticeElement()?.textContent).toContain('已创建新的重试任务')

    expect(listButton(1).disabled).toBe(false)
    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)

    refreshList.resolve(jsonResponse({ items: [task(taskAID, 'failed'), task(taskBID, 'running'), task(taskCID, 'queued')] }))
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/v1/ai/tasks/${taskCID}`)).toBe(false)
    expect(buttonByText('取消任务').disabled).toBe(false)
    wrapper.unmount()
  })

  it('shows the cancel failure in context without letting the stale failure cover the newer task', async () => {
    vi.useFakeTimers()
    const cancelPostA = deferred<Response>()
    const cancelPostB = deferred<Response>()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100')
        return jsonResponse({ items: [task(taskAID, 'running'), task(taskBID, 'running')] })
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(task(taskAID, 'running'))
      if (path === `/api/v1/ai/tasks/${taskBID}`) return jsonResponse(task(taskBID, 'running'))
      if (path === `/api/v1/ai/tasks/${taskAID}/cancel` && init?.method === 'POST') return cancelPostA.promise
      if (path === `/api/v1/ai/tasks/${taskBID}/cancel` && init?.method === 'POST') return cancelPostB.promise
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?taskId=${taskAID}`)
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')

    buttonByText('取消任务').click()
    await flushPromises()
    cancelPostA.reject(new Error('取消请求失败'))
    await flushPromises()
    expect(document.querySelector('.center-notice--error')?.textContent).toContain('取消请求失败')
    expect(buttonByText('取消任务').disabled).toBe(false)

    expect(listButton(1).disabled).toBe(false)
    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(document.querySelector('.center-notice--error')).toBeNull()

    buttonByText('取消任务').click()
    await flushPromises()
    expect(listButton(0).disabled).toBe(false)
    listButton(0).click()
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')

    cancelPostB.reject(new Error('旧任务取消失败'))
    await flushPromises()
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(buttonByText('取消任务').disabled).toBe(false)
    wrapper.unmount()
  })

  it('follows browser history back and forward between task URLs and does not re-read details for its own URL writes', async () => {
    let aDetailCalls = 0
    let bDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100')
        return jsonResponse({ items: [task(taskAID, 'failed'), task(taskBID, 'failed')] })
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return jsonResponse(task(taskAID, 'failed'))
      }
      if (path === `/api/v1/ai/tasks/${taskBID}`) {
        bDetailCalls += 1
        return jsonResponse(task(taskBID, 'failed'))
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(aDetailCalls).toBe(1)

    listButton(0).click()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(aDetailCalls).toBe(2)

    await router.push('/ai/tasks')
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBeUndefined()
    expect(detailTaskText()).toContain('aaaaaaaa')

    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(aDetailCalls).toBe(2)
    expect(bDetailCalls).toBe(1)

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(listButton(0).classList.contains('active')).toBe(true)
    expect(aDetailCalls).toBe(3)
    expect(bDetailCalls).toBe(1)

    router.forward()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(aDetailCalls).toBe(3)
    expect(bDetailCalls).toBe(2)
    wrapper.unmount()
  })

  it('discards the back-navigation detail response that lands after a forward re-targets the current task', async () => {
    const backDetailA = deferred<Response>()
    const forwardDetailB = deferred<Response>()
    let aDetailCalls = 0
    let bDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100')
        return jsonResponse({ items: [task(taskAID, 'failed'), task(taskBID, 'failed')] })
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return aDetailCalls <= 2 ? jsonResponse(task(taskAID, 'failed')) : backDetailA.promise
      }
      if (path === `/api/v1/ai/tasks/${taskBID}`) {
        bDetailCalls += 1
        return bDetailCalls === 1 ? jsonResponse(task(taskBID, 'failed')) : forwardDetailB.promise
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')

    listButton(0).click()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    await router.push('/ai/tasks')
    await flushPromises()
    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(aDetailCalls).toBe(2)
    expect(bDetailCalls).toBe(1)

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(aDetailCalls).toBe(3)
    expect(document.querySelector('.task-detail .center-loading')).not.toBeNull()

    router.forward()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(bDetailCalls).toBe(2)
    expect(document.querySelector('.task-detail .center-loading')).not.toBeNull()

    forwardDetailB.resolve(jsonResponse(task(taskBID, 'failed')))
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()

    backDetailA.resolve(jsonResponse(task(taskAID, 'failed')))
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(document.querySelector('.center-notice--error')).toBeNull()
    wrapper.unmount()
  })

  it('clears the previous task detail when the back-navigation detail read fails and recovers on forward', async () => {
    const backDetailA = deferred<Response>()
    let aDetailCalls = 0
    let bDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100')
        return jsonResponse({ items: [task(taskAID, 'failed'), task(taskBID, 'failed')] })
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return aDetailCalls <= 2 ? jsonResponse(task(taskAID, 'failed')) : backDetailA.promise
      }
      if (path === `/api/v1/ai/tasks/${taskBID}`) {
        bDetailCalls += 1
        return jsonResponse(task(taskBID, 'failed'))
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')

    listButton(0).click()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    await router.push('/ai/tasks')
    await flushPromises()
    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(aDetailCalls).toBe(2)
    expect(bDetailCalls).toBe(1)

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(aDetailCalls).toBe(3)
    expect(document.querySelector('.task-detail .center-loading')).not.toBeNull()

    backDetailA.reject(new Error('任务详情读取失败'))
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(document.querySelector('.center-notice--error')?.textContent).toContain('任务详情读取失败')
    expect(detailTaskText()).toBe('')
    expect(document.querySelector('.task-detail .center-empty')).not.toBeNull()
    expect(document.querySelector('.task-list > button.active')).toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)

    router.forward()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(true)
    expect(bDetailCalls).toBe(2)
    wrapper.unmount()
  })

  it('re-reads the list for the current record context on public navigation and browser history', async () => {
    const fullListFirst = deferred<Response>()
    const listScopes: Array<string | null> = []
    const taskA = { ...task(taskAID, 'failed'), itemId: 'item-a' }
    const taskB = { ...task(taskBID, 'failed'), itemId: 'item-b' }
    let bDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path.startsWith('/api/v1/ai/tasks?')) {
        const scope = listScope(path)
        listScopes.push(scope)
        if (scope === 'item-a') return jsonResponse({ items: [taskA] })
        return listScopes.filter((entry) => entry === null).length === 1
          ? fullListFirst.promise
          : jsonResponse({ items: [taskA, taskB] })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(taskA)
      if (path === `/api/v1/ai/tasks/${taskBID}`) {
        bDetailCalls += 1
        return jsonResponse(taskB)
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks?itemId=item-a')
    await flushPromises()
    expect(listScopes).toEqual(['item-a'])
    expect(document.querySelector('.filter-chip')?.textContent).toContain('item-a')
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(1)
    expect(statusTab('全部').textContent).toContain('1')
    expect(detailTaskText()).toContain('aaaaaaaa')

    await router.push('/ai/tasks')
    await flushPromises()
    expect(router.currentRoute.value.query.itemId).toBeUndefined()
    expect(listScopes).toEqual(['item-a', null])
    expect(document.querySelector('.filter-chip')).toBeNull()
    expect(document.querySelector('.center-loading')?.textContent ?? '').toContain('正在读取任务队列')
    expect(document.querySelector('.task-layout')).toBeNull()
    expect(document.querySelector('.center-empty')).toBeNull()
    expect(statusTab('全部').textContent).toContain('0')
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)

    fullListFirst.resolve(jsonResponse({ items: [taskA, taskB] }))
    await flushPromises()
    expect(document.querySelector('.center-loading')).toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(2)
    expect(statusTab('全部').textContent).toContain('2')
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(buttonByText('创建重试任务').disabled).toBe(false)

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query.itemId).toBe('item-a')
    expect(listScopes).toEqual(['item-a', null, 'item-a'])
    expect(document.querySelector('.filter-chip')?.textContent).toContain('item-a')
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(1)
    expect(statusTab('全部').textContent).toContain('1')
    expect(detailTaskText()).toContain('aaaaaaaa')

    router.forward()
    await flushPromises()
    expect(router.currentRoute.value.query.itemId).toBeUndefined()
    expect(listScopes).toEqual(['item-a', null, 'item-a', null])
    expect(document.querySelector('.filter-chip')).toBeNull()
    expect(document.querySelector('.center-loading')).toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(2)
    expect(statusTab('全部').textContent).toContain('2')
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(bDetailCalls).toBe(0)
    wrapper.unmount()
  })

  it('clears the item filter with one unfiltered list read and keeps the task and status query', async () => {
    const fullList = deferred<Response>()
    const listScopes: Array<string | null> = []
    const taskA = { ...task(taskAID, 'failed'), itemId: 'item-a' }
    const taskB = { ...task(taskBID, 'failed'), itemId: 'item-b' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path.startsWith('/api/v1/ai/tasks?')) {
        const scope = listScope(path)
        listScopes.push(scope)
        return scope === 'item-a' ? jsonResponse({ items: [taskA] }) : fullList.promise
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(taskA)
      if (path === `/api/v1/ai/tasks/${taskBID}`) return jsonResponse(taskB)
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(
      TaskCenterView,
      `/ai/tasks?itemId=item-a&status=failed&taskId=${taskAID}`,
    )
    await flushPromises()
    expect(listScopes).toEqual(['item-a'])
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)

    const clearItem = document.querySelector<HTMLButtonElement>('.filter-chip button')
    if (!clearItem) throw new Error('clear item filter button not found')
    clearItem.click()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ status: 'failed', taskId: taskAID })
    expect(document.querySelector('.filter-chip')).toBeNull()
    expect(listScopes).toEqual(['item-a', null])
    expect(document.querySelector('.center-loading')?.textContent ?? '').toContain('正在读取任务队列')
    expect(document.querySelector('.task-layout')).toBeNull()
    expect(document.querySelector('.center-empty')).toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)

    fullList.resolve(jsonResponse({ items: [taskA, taskB] }))
    await flushPromises()
    expect(listScopes).toEqual(['item-a', null])
    expect(router.currentRoute.value.query).toEqual({ status: 'failed', taskId: taskAID })
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(2)
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    wrapper.unmount()
  })

  it('drops the stale detail when the record context changes mid-read and keeps the failed new scope recoverable', async () => {
    const detailB = deferred<Response>()
    const listScopes: Array<string | null> = []
    const taskA = { ...task(taskAID, 'failed'), itemId: 'item-a' }
    const taskB = { ...task(taskBID, 'failed'), itemId: 'item-a' }
    const taskC = { ...task(taskCID, 'failed'), itemId: 'item-c' }
    let bDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path.startsWith('/api/v1/ai/tasks?')) {
        const scope = listScope(path)
        listScopes.push(scope)
        if (scope === 'item-a') return jsonResponse({ items: [taskA, taskB] })
        if (listScopes.filter((entry) => entry === null).length === 1) throw new Error('任务列表读取失败')
        return jsonResponse({ items: [taskA, taskB, taskC] })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(taskA)
      if (path === `/api/v1/ai/tasks/${taskBID}`) {
        bDetailCalls += 1
        return bDetailCalls === 1 ? detailB.promise : jsonResponse(taskB)
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks?itemId=item-a')
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(2)

    listButton(1).click()
    await flushPromises()
    expect(bDetailCalls).toBe(1)
    expect(document.querySelector('.task-detail .center-loading')).not.toBeNull()

    await router.push('/ai/tasks')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
    expect(listScopes).toEqual(['item-a', null])
    expect(document.querySelector('.filter-chip')).toBeNull()
    expect(document.querySelector('.center-notice--error')?.textContent).toContain('任务列表读取失败')
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(0)
    expect(document.querySelector('.task-list .center-empty')).toBeNull()
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(document.querySelector('.task-detail .center-empty')).not.toBeNull()
    expect(detailTaskText()).toBe('')
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)

    detailB.resolve(jsonResponse(taskB))
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
    expect(document.querySelector('.center-notice--error')?.textContent).toContain('任务列表读取失败')
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(0)
    expect(detailTaskText()).toBe('')
    expect(document.querySelector('.task-detail .center-empty')).not.toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)

    buttonByText('重新读取').click()
    await flushPromises()
    expect(listScopes).toEqual(['item-a', null, null])
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(document.querySelector('.filter-chip')).toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(3)
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBeUndefined()
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    wrapper.unmount()
  })

  it('explains the offline state instead of stale or empty copy when the record context changes offline, and recovers once online', async () => {
    const listScopes: Array<string | null> = []
    const taskA = { ...task(taskAID, 'failed'), itemId: 'item-a' }
    const taskB = { ...task(taskBID, 'failed'), itemId: 'item-b' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path.startsWith('/api/v1/ai/tasks?')) {
        const scope = listScope(path)
        listScopes.push(scope)
        return jsonResponse({ items: scope === 'item-a' ? [taskA] : [taskA, taskB] })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(taskA)
      if (path === `/api/v1/ai/tasks/${taskBID}`) return jsonResponse(taskB)
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks?itemId=item-a')
    await flushPromises()
    expect(listScopes).toEqual(['item-a'])
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(1)
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(document.querySelector('.center-notice--warning')).toBeNull()

    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    await flushPromises()
    await router.push('/ai/tasks')
    await flushPromises()
    expect(listScopes).toEqual(['item-a'])
    expect(router.currentRoute.value.query.itemId).toBeUndefined()
    expect(document.querySelector('.filter-chip')).toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(0)
    expect(detailTaskText()).toBe('')
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)
    expect(document.querySelector('.center-loading')).toBeNull()
    const offlineNotice = document.querySelector('.center-notice--warning')?.textContent ?? ''
    expect(offlineNotice).toContain('当前离线')
    expect(offlineNotice).not.toContain('已显示最后一次读取')
    const emptyTitle = document.querySelector('.task-list .center-empty h2')?.textContent ?? ''
    expect(emptyTitle).not.toContain('没有符合条件的任务')
    expect(emptyTitle).toContain('暂时无法读取')
    expect(document.querySelector('.task-list .center-empty p')?.textContent ?? '').toContain('联网')

    onLine.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await flushPromises()
    expect(listScopes).toEqual(['item-a', null])
    expect(document.querySelector('.center-notice--warning')).toBeNull()
    expect(document.querySelector('.task-list .center-empty')).toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(2)
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    expect(document.querySelector('.filter-chip')).toBeNull()
    wrapper.unmount()
  })

  it('recovers the off-list task behind the public retry link on remount without inserting it into the recent list', async () => {
    let aDetailCalls = 0
    let cDetailCalls = 0
    let listCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        listCalls += 1
        return jsonResponse({ items: [{ ...task(taskAID, 'failed'), retryOfTaskId: taskCID }] })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return jsonResponse({ ...task(taskAID, 'failed'), retryOfTaskId: taskCID })
      }
      if (path === `/api/v1/ai/tasks/${taskCID}`) {
        cDetailCalls += 1
        return jsonResponse(task(taskCID, 'failed'))
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(aDetailCalls).toBe(1)

    const oldTaskButton = document.querySelector<HTMLButtonElement>('.retry-link button')
    if (!oldTaskButton) throw new Error('retry link button not found')
    oldTaskButton.click()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(detailTaskText()).toContain('cccccccc')
    expect(cDetailCalls).toBe(1)

    const linkedPath = router.currentRoute.value.fullPath
    wrapper.unmount()
    const remounted = await mountWithRouter(TaskCenterView, linkedPath)
    await flushPromises()
    expect(remounted.router.currentRoute.value.fullPath).toBe(linkedPath)
    expect(listCalls).toBe(2)
    expect(cDetailCalls).toBe(2)
    expect(aDetailCalls).toBe(1)
    expect(detailTaskText()).toContain('cccccccc')
    expect(detailStatusText()).toBe(taskStatusLabels.failed)
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(1)
    expect(listButton(0).textContent).not.toContain('cccccccc')
    expect(listButton(0).classList.contains('active')).toBe(false)
    expect(statusTab('全部').textContent).toContain('1')
    remounted.wrapper.unmount()
  })

  it('syncs the off-list task with history back and forward and keeps the forward task when the back read lands late', async () => {
    const backDetailC = deferred<Response>()
    let aDetailCalls = 0
    let cDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') return jsonResponse({ items: [task(taskAID, 'failed')] })
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return jsonResponse(task(taskAID, 'failed'))
      }
      if (path === `/api/v1/ai/tasks/${taskCID}`) {
        cDetailCalls += 1
        return cDetailCalls === 2 ? backDetailC.promise : jsonResponse(task(taskCID, 'failed'))
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?taskId=${taskCID}`)
    await flushPromises()
    expect(detailTaskText()).toContain('cccccccc')
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(aDetailCalls).toBe(0)
    expect(cDetailCalls).toBe(1)
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(1)

    await router.push('/ai/tasks')
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBeUndefined()
    expect(detailTaskText()).toContain('cccccccc')

    listButton(0).click()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(aDetailCalls).toBe(1)

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(cDetailCalls).toBe(2)
    expect(document.querySelector('.task-detail .center-loading')).not.toBeNull()
    expect(detailTaskText()).toBe('')

    router.forward()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(aDetailCalls).toBe(2)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()

    backDetailC.resolve(jsonResponse(task(taskCID, 'failed')))
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    expect(cDetailCalls).toBe(2)
    expect(aDetailCalls).toBe(2)
    wrapper.unmount()
  })

  it('shows the real off-list read failure without falling back and keeps the record scope until the chip is cleared', async () => {
    const listScopes: Array<string | null> = []
    const taskA = { ...task(taskAID, 'failed'), itemId: 'item-a' }
    const taskB = { ...task(taskBID, 'failed'), itemId: 'item-b' }
    let dDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path.startsWith('/api/v1/ai/tasks?')) {
        const scope = listScope(path)
        listScopes.push(scope)
        return jsonResponse({ items: scope === 'item-a' ? [taskA] : [taskA, taskB] })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(taskA)
      if (path === `/api/v1/ai/tasks/${taskBID}`) return jsonResponse(taskB)
      if (path === `/api/v1/ai/tasks/${taskCID}`)
        return jsonResponse({ error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已被清理' } }, 404)
      if (path === `/api/v1/ai/tasks/${taskDID}`) {
        dDetailCalls += 1
        return jsonResponse({ ...task(taskDID, 'failed'), itemId: 'item-b' })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const detailCallsFor = (id: string) => fetchMock.mock.calls.filter(([input]) => String(input) === `/api/v1/ai/tasks/${id}`)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?taskId=${taskCID}`)
    await flushPromises()
    expect(listScopes).toEqual([null])
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(document.querySelector('.center-notice--error')?.textContent).toContain('任务不存在或已被清理')
    expect(detailTaskText()).toBe('')
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(document.querySelector('.task-detail .center-empty')).not.toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(2)
    expect(document.querySelector('.task-list > button.active')).toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)
    expect(detailCallsFor(taskCID)).toHaveLength(1)
    expect(detailCallsFor(taskAID)).toHaveLength(0)
    expect(detailCallsFor(taskBID)).toHaveLength(0)

    await router.push(`/ai/tasks?itemId=item-a&taskId=${taskDID}`)
    await flushPromises()
    expect(listScopes).toEqual([null, 'item-a'])
    expect(document.querySelector('.filter-chip')?.textContent).toContain('item-a')
    expect(dDetailCalls).toBe(1)
    expect(document.querySelector('.center-notice--error')?.textContent).toContain('不属于当前记录')
    expect(detailTaskText()).toBe('')
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(document.querySelector('.task-detail .center-empty')).not.toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(1)
    expect(document.querySelector('.task-list > button.active')).toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)
    expect(router.currentRoute.value.query.taskId).toBe(taskDID)
    expect(detailCallsFor(taskAID)).toHaveLength(0)

    const clearItem = document.querySelector<HTMLButtonElement>('.filter-chip button')
    if (!clearItem) throw new Error('clear item filter button not found')
    clearItem.click()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ taskId: taskDID })
    expect(listScopes).toEqual([null, 'item-a', null])
    expect(document.querySelector('.filter-chip')).toBeNull()
    expect(dDetailCalls).toBe(2)
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(detailTaskText()).toContain('d1d1d1d1')
    expect(detailStatusText()).toBe(taskStatusLabels.failed)
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(2)
    expect(document.querySelector('.task-list > button.active')).toBeNull()
    expect(detailCallsFor(taskAID)).toHaveLength(0)
    wrapper.unmount()
  })

  it('rejects a non-uuid task link without extra requests and keeps empty or array queries free of direct detail reads', async () => {
    let aDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') return jsonResponse({ items: [task(taskAID, 'failed')] })
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return jsonResponse(task(taskAID, 'failed'))
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const detailPathCalls = () => fetchMock.mock.calls.filter(([input]) => /^\/api\/v1\/ai\/tasks\/.+/.test(String(input)))
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(aDetailCalls).toBe(1)

    await router.push('/ai/tasks?taskId=..%2Fsettings%2Fproviders')
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe('../settings/providers')
    expect(document.querySelector('.center-notice--error')?.textContent).toContain('任务标识无效')
    expect(detailTaskText()).toBe('')
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(document.querySelector('.task-detail .center-empty')).not.toBeNull()
    expect(document.querySelector('.task-list > button.active')).toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)
    expect(aDetailCalls).toBe(1)
    expect(detailPathCalls()).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('..'))).toBe(false)

    await router.push('/ai/tasks?taskId=')
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe('')
    expect(detailPathCalls()).toHaveLength(1)
    expect(detailTaskText()).toBe('')

    await router.push(`/ai/tasks?taskId=${taskAID}&taskId=${taskBID}`)
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toEqual([taskAID, taskBID])
    expect(detailPathCalls()).toHaveLength(1)
    expect(detailTaskText()).toBe('')
    wrapper.unmount()

    const remounted = await mountWithRouter(TaskCenterView, '/ai/tasks?taskId=no-such-task')
    await flushPromises()
    expect(remounted.router.currentRoute.value.query.taskId).toBe('no-such-task')
    expect(document.querySelector('.center-notice--error')?.textContent).toContain('任务标识无效')
    expect(detailTaskText()).toBe('')
    expect(document.querySelector('.task-detail .center-empty')).not.toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(1)
    expect(document.querySelector('.task-list > button.active')).toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)
    expect(detailPathCalls()).toHaveLength(1)
    expect(aDetailCalls).toBe(1)
    remounted.wrapper.unmount()
  })

  it('invalidates the in-flight detail read when history returns to the displayed off-list task', async () => {
    const detailA = deferred<Response>()
    let aDetailCalls = 0
    let cDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') return jsonResponse({ items: [task(taskAID, 'failed')] })
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return aDetailCalls === 1 ? detailA.promise : jsonResponse(task(taskAID, 'failed'))
      }
      if (path === `/api/v1/ai/tasks/${taskCID}`) {
        cDetailCalls += 1
        return jsonResponse(task(taskCID, 'succeeded'))
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?taskId=${taskCID}`)
    await flushPromises()
    expect(detailTaskText()).toContain('cccccccc')
    expect(cDetailCalls).toBe(1)

    await router.push('/ai/tasks')
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBeUndefined()
    listButton(0).click()
    await flushPromises()
    expect(aDetailCalls).toBe(1)
    expect(router.currentRoute.value.query.taskId).toBeUndefined()
    expect(document.querySelector('.task-detail .center-loading')).not.toBeNull()

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(detailTaskText()).toContain('cccccccc')
    expect(cDetailCalls).toBe(1)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)

    detailA.resolve(jsonResponse(task(taskAID, 'failed')))
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(detailTaskText()).toContain('cccccccc')
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).some((entry) => entry.textContent?.includes('创建重试任务')),
    ).toBe(false)
    expect(aDetailCalls).toBe(1)
    expect(cDetailCalls).toBe(1)
    wrapper.unmount()
  })

  it('keeps the single poller refreshing an active off-list task from mount and history until it turns terminal', async () => {
    vi.useFakeTimers()
    let listCalls = 0
    let aDetailCalls = 0
    let cDetailCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/settings') return jsonResponse(settings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100') return jsonResponse({ items: [] })
      if (path === '/api/v1/ai/tasks?limit=100') {
        listCalls += 1
        return jsonResponse({ items: [task(taskAID, 'failed')] })
      }
      if (path === `/api/v1/ai/tasks/${taskAID}`) {
        aDetailCalls += 1
        return jsonResponse(task(taskAID, 'failed'))
      }
      if (path === `/api/v1/ai/tasks/${taskCID}`) {
        cDetailCalls += 1
        if (cDetailCalls >= 5) throw new Error(`unexpected request: ${path}`)
        return jsonResponse(task(taskCID, cDetailCalls === 4 ? 'failed' : 'running'))
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?taskId=${taskCID}`)
    await flushPromises()
    expect(detailTaskText()).toContain('cccccccc')
    expect(detailStatusText()).toBe(taskStatusLabels.running)
    expect(buttonByText('取消任务').disabled).toBe(false)
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(1)
    expect(listCalls).toBe(1)
    expect(cDetailCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(2500)
    expect(listCalls).toBe(2)
    expect(cDetailCalls).toBe(2)
    expect(detailTaskText()).toContain('cccccccc')
    expect(detailStatusText()).toBe(taskStatusLabels.running)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()

    await router.push('/ai/tasks')
    await flushPromises()
    listButton(0).click()
    await flushPromises()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(router.currentRoute.value.query.taskId).toBe(taskAID)
    expect(aDetailCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(listCalls).toBe(2)
    expect(cDetailCalls).toBe(2)
    expect(aDetailCalls).toBe(1)

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(cDetailCalls).toBe(3)
    expect(detailTaskText()).toContain('cccccccc')
    expect(detailStatusText()).toBe(taskStatusLabels.running)
    expect(buttonByText('取消任务').disabled).toBe(false)
    expect(listCalls).toBe(2)

    await vi.advanceTimersByTimeAsync(2500)
    expect(listCalls).toBe(3)
    expect(cDetailCalls).toBe(4)
    expect(detailTaskText()).toContain('cccccccc')
    expect(detailStatusText()).toBe(taskStatusLabels.failed)
    expect(buttonByText('创建重试任务').disabled).toBe(false)
    expect(document.querySelector('.task-detail .center-loading')).toBeNull()
    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(document.querySelectorAll('.task-list > button')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(10000)
    expect(listCalls).toBe(3)
    expect(cDetailCalls).toBe(4)
    expect(aDetailCalls).toBe(1)
    expect(router.currentRoute.value.query.taskId).toBe(taskCID)
    expect(document.querySelector('.center-notice--error')).toBeNull()
    wrapper.unmount()
  })
})

describe('batch organize draft and navigation ownership', () => {
  const batchTaskID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the normal batch success: closes the panel, clears the submitted selection and the status filter in UI and URL, and selects the new batch', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const initialList = [task(taskAID, 'failed')]
    let listItems = [...initialList]
    const { fetchMock, listCalls } = createBatchMock({ list: () => listItems, post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?status=failed`)
    await flushPromises()
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)

    await openPanelAndSubmitBatch()
    listItems = [...initialList, batchTask(batchTaskID)]
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    const postCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === '/api/v1/ai/tasks' && init?.method === 'POST',
    )
    expect(postCalls).toHaveLength(1)
    expect(JSON.parse(String(postCalls[0]?.[1]?.body))).toEqual({
      taskType: 'batch_organize',
      itemIds: ['item-batch-1'],
      organizeModelId: 'model-o1',
      visionModelId: 'model-v1',
      sensitivePolicy: 'allow',
    })
    expect(document.querySelector('.batch-panel')).toBeNull()
    expect(noticeElement()?.textContent).toContain('批量任务已建立')
    expect(activeStatusTab()).toContain('全部')
    expect(router.currentRoute.value.query.status).toBeUndefined()
    expect(detailTaskText()).toContain('dddddddd')
    expect(router.currentRoute.value.query.taskId).toBe(batchTaskID)
    expect(listCalls()).toBeGreaterThanOrEqual(2)
    expect(statusTab('全部').textContent).toContain('2')

    batchToggleButton().click()
    await flushPromises()
    expect(batchFooterText()).toContain('已选择 0 / 100 条')
    expect(batchCheckbox(0).checked).toBe(false)
    expect(buttonByText('开始批量整理').textContent).not.toContain('正在建立批次')
    wrapper.unmount()
  })

  it('keeps a newer checkbox selection draft when the batch POST succeeds late', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const initialList = [task(taskAID), task(taskBID)]
    let listItems = [...initialList]
    const { fetchMock } = createBatchMock({ list: () => listItems, post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await openPanelAndSubmitBatch()
    batchCheckbox(1).click()
    await flushPromises()
    listItems = [...initialList, batchTask(batchTaskID)]
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    expect(document.querySelector('.batch-panel')).not.toBeNull()
    expect(batchCheckbox(0).checked).toBe(true)
    expect(batchCheckbox(1).checked).toBe(true)
    expect(batchFooterText()).toContain('已选择 2 / 100 条')
    expect(noticeElement()).toBeNull()
    expect(router.currentRoute.value.query.taskId).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps a newer organize model draft when the batch POST succeeds late', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const { fetchMock } = createBatchMock({ list: () => [task(taskAID)], post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await openPanelAndSubmitBatch()
    changeSelect(batchConfigSelect('正文整理模型'), 'model-o2')
    await flushPromises()
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    expect(document.querySelector('.batch-panel')).not.toBeNull()
    expect(batchConfigSelect('正文整理模型').value).toBe('model-o2')
    expect(batchCheckbox(0).checked).toBe(true)
    expect(batchFooterText()).toContain('已选择 1 / 100 条')
    expect(noticeElement()).toBeNull()
    wrapper.unmount()
  })

  it('keeps a newer vision model draft when the batch POST succeeds late', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const { fetchMock } = createBatchMock({ list: () => [task(taskAID)], post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await openPanelAndSubmitBatch()
    changeSelect(batchConfigSelect('视觉模型'), 'model-v2')
    await flushPromises()
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    expect(document.querySelector('.batch-panel')).not.toBeNull()
    expect(batchConfigSelect('视觉模型').value).toBe('model-v2')
    expect(batchCheckbox(0).checked).toBe(true)
    expect(batchFooterText()).toContain('已选择 1 / 100 条')
    expect(noticeElement()).toBeNull()
    wrapper.unmount()
  })

  it('keeps a newer sensitive policy draft when the batch POST succeeds late', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const { fetchMock } = createBatchMock({ list: () => [task(taskAID)], post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await openPanelAndSubmitBatch()
    changeSelect(batchConfigSelect('敏感策略'), 'redact')
    await flushPromises()
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    expect(document.querySelector('.batch-panel')).not.toBeNull()
    expect(batchConfigSelect('敏感策略').value).toBe('redact')
    expect(batchCheckbox(0).checked).toBe(true)
    expect(batchFooterText()).toContain('已选择 1 / 100 条')
    expect(noticeElement()).toBeNull()
    wrapper.unmount()
  })

  it('keeps a reopened batch panel with the same values open when the POST succeeds late', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const initialList = [task(taskAID, 'failed')]
    let listItems = [...initialList]
    const { fetchMock } = createBatchMock({ list: () => listItems, post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?status=failed`)
    await flushPromises()

    await openPanelAndSubmitBatch()
    expect(buttonByText('正在建立批次…').disabled).toBe(true)
    closeBatchPanel()
    await flushPromises()
    expect(document.querySelector('.batch-panel')).toBeNull()
    batchToggleButton().click()
    await flushPromises()
    expect(batchFooterText()).toContain('已选择 1 / 100 条')

    listItems = [...initialList, batchTask(batchTaskID)]
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    expect(document.querySelector('.batch-panel')).not.toBeNull()
    expect(batchFooterText()).toContain('已选择 1 / 100 条')
    expect(batchCheckbox(0).checked).toBe(true)
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)
    expect(router.currentRoute.value.query.status).toBe('failed')
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(router.currentRoute.value.query.taskId).toBeUndefined()
    expect(noticeElement()).toBeNull()
    expect(buttonByText('开始批量整理').disabled).toBe(false)
    wrapper.unmount()
  })

  it('keeps the task the user switched to when the batch POST succeeds late', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const initialList = [task(taskAID), task(taskBID)]
    let listItems = [...initialList]
    const { fetchMock } = createBatchMock({ list: () => listItems, post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await openPanelAndSubmitBatch()
    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')

    listItems = [...initialList, batchTask(batchTaskID)]
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(noticeElement()).toBeNull()
    expect(statusTab('全部').textContent).toContain('3')
    wrapper.unmount()
  })

  it('keeps the status filter the user applied when the batch POST succeeds late', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const initialList = [task(taskAID, 'failed'), task(taskBID)]
    let listItems = [...initialList]
    const { fetchMock } = createBatchMock({ list: () => listItems, post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await openPanelAndSubmitBatch()
    statusTab(taskStatusLabels.failed).click()
    await flushPromises()
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)
    expect(router.currentRoute.value.query.status).toBe('failed')

    listItems = [...initialList, batchTask(batchTaskID)]
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    expect(activeStatusTab()).toContain(taskStatusLabels.failed)
    expect(router.currentRoute.value.query.status).toBe('failed')
    expect(router.currentRoute.value.query.taskId).toBeUndefined()
    expect(noticeElement()).toBeNull()
    expect(statusTab('全部').textContent).toContain('3')
    wrapper.unmount()
  })

  it('keeps the cleared item filter context when the batch POST succeeds late', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const filteredList = [task(taskAID)]
    let unfilteredList = [task(taskAID)]
    const { fetchMock } = createBatchMock({
      list: (_call, path) => (path.includes('itemId=') ? filteredList : unfilteredList),
      post: () => batchPost.promise,
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, `/ai/tasks?itemId=item-batch-1`)
    await flushPromises()
    expect(document.querySelector('.filter-chip')).not.toBeNull()

    await openPanelAndSubmitBatch()
    const clearItem = document.querySelector<HTMLButtonElement>('.filter-chip button')
    if (!clearItem) throw new Error('clear item filter button not found')
    clearItem.click()
    await flushPromises()
    expect(document.querySelector('.filter-chip')).toBeNull()
    expect(router.currentRoute.value.query.itemId).toBeUndefined()

    unfilteredList = [task(taskAID), batchTask(batchTaskID)]
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    expect(router.currentRoute.value.query.itemId).toBeUndefined()
    expect(document.querySelector('.filter-chip')).toBeNull()
    expect(detailTaskText()).toContain('aaaaaaaa')
    expect(router.currentRoute.value.query.taskId).toBeUndefined()
    expect(noticeElement()).toBeNull()
    expect(statusTab('全部').textContent).toContain('2')
    wrapper.unmount()
  })

  it('keeps the task chosen while the post-batch list refresh is pending', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const refreshList = deferred<Response>()
    let listCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [batchProvider()] })
      if (path === '/api/v1/ai/settings') return jsonResponse(batchSettings())
      if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100')
        return jsonResponse({
          items: [libraryItemFixture('item-batch-1', '批量条目一'), libraryItemFixture('item-batch-2', '批量条目二')],
        })
      if (path === '/api/v1/ai/tasks?limit=100') {
        listCalls += 1
        return listCalls === 1 ? jsonResponse({ items: [task(taskAID), task(taskBID)] }) : refreshList.promise
      }
      if (path === '/api/v1/ai/tasks' && init?.method === 'POST') return batchPost.promise
      if (path === `/api/v1/ai/tasks/${taskAID}`) return jsonResponse(task(taskAID))
      if (path === `/api/v1/ai/tasks/${taskBID}`) return jsonResponse(task(taskBID))
      if (path === `/api/v1/ai/tasks/${batchTaskID}`) return jsonResponse(batchTask(batchTaskID))
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await openPanelAndSubmitBatch()
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()
    expect(document.querySelector('.batch-panel')).toBeNull()
    expect(noticeElement()?.textContent).toContain('批量任务已建立')

    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')

    refreshList.resolve(jsonResponse({ items: [task(taskAID), task(taskBID), batchTask(batchTaskID)] }))
    await flushPromises()

    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    wrapper.unmount()
  })

  it('keeps the draft and shows the retryable error when the batch POST fails in context', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const { fetchMock, listCalls } = createBatchMock({ list: () => [task(taskAID, 'failed')], post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = await mountWithRouter(TaskCenterView, `/ai/tasks?status=failed`)
    await flushPromises()

    await openPanelAndSubmitBatch()
    batchPost.reject(new Error('批量创建失败'))
    await flushPromises()

    expect(document.querySelector('.center-notice--error')?.textContent).toContain('批量创建失败')
    expect(document.querySelector('.batch-panel')).not.toBeNull()
    expect(batchCheckbox(0).checked).toBe(true)
    expect(batchFooterText()).toContain('已选择 1 / 100 条')
    expect(batchConfigSelect('正文整理模型').value).toBe('model-o1')
    expect(batchConfigSelect('视觉模型').value).toBe('model-v1')
    expect(batchConfigSelect('敏感策略').value).toBe('allow')
    expect(activeStatusTab()).toContain(taskStatusLabels.failed)
    expect(buttonByText('开始批量整理').disabled).toBe(false)
    expect(listCalls()).toBe(1)
    wrapper.unmount()
  })

  it('does not cover a newer policy draft with a late batch failure', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const { fetchMock } = createBatchMock({ list: () => [task(taskAID)], post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await openPanelAndSubmitBatch()
    changeSelect(batchConfigSelect('敏感策略'), 'redact')
    await flushPromises()
    batchPost.reject(new Error('旧批次创建失败'))
    await flushPromises()

    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(document.querySelector('.batch-panel')).not.toBeNull()
    expect(batchConfigSelect('敏感策略').value).toBe('redact')
    expect(batchFooterText()).toContain('已选择 1 / 100 条')
    wrapper.unmount()
  })

  it('does not cover a newer task context with a late batch failure', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const { fetchMock } = createBatchMock({ list: () => [task(taskAID), task(taskBID)], post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper, router } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()

    await openPanelAndSubmitBatch()
    listButton(1).click()
    await flushPromises()
    expect(detailTaskText()).toContain('bbbbbbbb')

    batchPost.reject(new Error('旧批次创建失败'))
    await flushPromises()

    expect(document.querySelector('.center-notice--error')).toBeNull()
    expect(detailTaskText()).toContain('bbbbbbbb')
    expect(router.currentRoute.value.query.taskId).toBe(taskBID)
    expect(document.querySelector('.batch-panel')).not.toBeNull()
    wrapper.unmount()
  })

  it('does not refresh the queue after unmount when the batch POST resolves late', async () => {
    vi.useFakeTimers()
    const batchPost = deferred<Response>()
    const { fetchMock, listCalls, detailCalls } = createBatchMock({ list: () => [task(taskAID)], post: () => batchPost.promise })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = await mountWithRouter(TaskCenterView, '/ai/tasks')
    await flushPromises()
    const listsBefore = listCalls()
    const detailsBefore = detailCalls().length

    await openPanelAndSubmitBatch()
    wrapper.unmount()
    batchPost.resolve(jsonResponse(batchTask(batchTaskID)))
    await flushPromises()

    expect(listCalls()).toBe(listsBefore)
    expect(detailCalls().length).toBe(detailsBefore)
  })
})

async function mountWithRouter(component: object, path: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test'
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ai/tasks', name: 'task-center', component: { template: '<div />' } },
      { path: '/items/:itemId', name: 'item-detail', component: { template: '<div />' } },
      { path: '/settings/ai-schedule', name: 'ai-schedule-settings', component: { template: '<div />' } },
      { path: '/settings/providers', name: 'provider-settings', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(component, { attachTo: document.body, global: { plugins: [pinia, router] } })
  return { wrapper, router }
}

function task(id: string, status: TaskStatus = 'succeeded') {
  return {
    id,
    taskType: 'organize_record',
    itemId: null,
    parentTaskId: null,
    triggerType: 'manual',
    modelId: null,
    status,
    sensitivePolicy: 'block',
    promptVersion: 'organize-v1',
    schemaVersion: '1.0',
    retryOfTaskId: null,
    queuedAt: '2026-09-01T00:00:00Z',
    startedAt: '2026-09-01T00:00:01Z',
    finishedAt: status === 'succeeded' ? '2026-09-01T00:00:02Z' : null,
    cancelRequestedAt: null,
    cancelRequested: false,
    errorCode: null,
    errorDetail: null,
    inputTokens: null,
    outputTokens: null,
    events: [],
  }
}

function settings() {
  return {
    sensitiveDisplayMode: 'masked',
    sensitiveAiPolicy: 'block',
    defaultOrganizeModelId: null,
    defaultReviewModelId: null,
    defaultVisionModelId: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function listButton(index: number) {
  const button = document.querySelectorAll<HTMLButtonElement>('.task-list > button')[index]
  if (!button) throw new Error(`task list button not found: ${index}`)
  return button
}

function buttonByText(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent?.trim().includes(text))
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

function detailTaskText() {
  return document.querySelector('.task-detail header p')?.textContent ?? ''
}

function detailStatusText() {
  return document.querySelector('.task-detail .detail-status')?.textContent?.trim() ?? ''
}

function statusTab(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.status-tabs button')).find((entry) =>
    entry.textContent?.includes(label),
  )
  if (!button) throw new Error(`status tab not found: ${label}`)
  return button
}

function activeStatusTab() {
  return document.querySelector<HTMLButtonElement>('.status-tabs button[aria-current="page"]')?.textContent ?? ''
}

function noticeElement() {
  return document.querySelector('.center-notice:not(.center-notice--warning):not(.center-notice--error)')
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function listScope(path: string) {
  return new URL(path, 'http://localhost').searchParams.get('itemId')
}

function batchTask(id: string, status: TaskStatus = 'queued') {
  return { ...task(id, status), taskType: 'batch_organize' }
}

function batchProvider() {
  const model = (id: string, supportsVision: boolean) => ({
    id,
    displayName: `模型 ${id}`,
    modelId: `demo/${id}`,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsTools: false,
    supportsVision,
    enabled: true,
  })
  return {
    id: 'provider-1',
    displayName: '演示 Provider',
    enabled: true,
    models: [model('model-o1', false), model('model-o2', false), model('model-v1', true), model('model-v2', true)],
  }
}

function batchSettings() {
  return {
    sensitiveDisplayMode: 'masked',
    sensitiveAiPolicy: 'allow',
    defaultOrganizeModelId: 'model-o1',
    defaultReviewModelId: null,
    defaultVisionModelId: 'model-v1',
  }
}

function libraryItemFixture(id: string, title: string) {
  return {
    id,
    title,
    sensitivity: 'normal',
    favorite: false,
    tags: [],
    summary: '',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    effectiveCapturedAt: '2026-09-01T00:00:00Z',
    sourceTimeQuality: 'exact',
    rawRecordCount: 2,
    attachmentCount: 1,
    attachments: [],
  }
}

function createBatchMock(options: { list: (call: number, path: string) => unknown[]; post: () => Response | Promise<Response> }) {
  let listCalls = 0
  const detailCalls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/v1/ai/providers') return jsonResponse({ items: [batchProvider()] })
    if (path === '/api/v1/ai/settings') return jsonResponse(batchSettings())
    if (path === '/api/v1/items?view=recent&sort=effective_desc&limit=100')
      return jsonResponse({
        items: [libraryItemFixture('item-batch-1', '批量条目一'), libraryItemFixture('item-batch-2', '批量条目二')],
      })
    if (path.startsWith('/api/v1/ai/tasks?')) {
      listCalls += 1
      return jsonResponse({ items: options.list(listCalls, path) })
    }
    if (path === '/api/v1/ai/tasks' && init?.method === 'POST') return options.post()
    const detailMatch = /^\/api\/v1\/ai\/tasks\/([^/?]+)$/.exec(path)
    if (detailMatch) {
      detailCalls.push(detailMatch[1])
      return jsonResponse(task(detailMatch[1]))
    }
    throw new Error(`unexpected request: ${path}`)
  })
  return { fetchMock, listCalls: () => listCalls, detailCalls: () => detailCalls.slice() }
}

function batchToggleButton() {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.task-center__header button')).find((entry) =>
    entry.textContent?.includes('批量整理'),
  )
  if (!button) throw new Error('batch toggle button not found')
  return button
}

function closeBatchPanel() {
  const button = document.querySelector<HTMLButtonElement>('.batch-panel > header button')
  if (!button) throw new Error('close batch panel button not found')
  button.click()
}

function batchCheckbox(index: number) {
  const input = document.querySelectorAll<HTMLInputElement>('.batch-list input[type="checkbox"]')[index]
  if (!input) throw new Error(`batch checkbox not found: ${index}`)
  return input
}

function batchConfigSelect(label: string) {
  const select = Array.from(document.querySelectorAll<HTMLLabelElement>('.batch-config label'))
    .find((entry) => entry.querySelector('span')?.textContent?.includes(label))
    ?.querySelector('select')
  if (!select) throw new Error(`batch config select not found: ${label}`)
  return select
}

function changeSelect(select: HTMLSelectElement, value: string) {
  select.value = value
  select.dispatchEvent(new Event('change'))
}

function batchFooterText() {
  return document.querySelector('.batch-panel > footer span')?.textContent ?? ''
}

async function openPanelAndSubmitBatch() {
  batchToggleButton().click()
  await flushPromises()
  batchCheckbox(0).click()
  await flushPromises()
  buttonByText('开始批量整理').click()
  await flushPromises()
}

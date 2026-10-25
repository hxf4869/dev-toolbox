// 旧红测试（DT-R25）：ItemAIView 两个 Teleport 弹窗的键盘可访问性。
// 当前生产代码缺少 Escape 关闭、Tab 焦点圈定和关闭后焦点回归；
// 本文件断言修复语义，预期在未修复的生产代码上红。
// DT-R252 回归：POST 在途（busy）期间 backdrop、取消、Escape 与 header X 均不得关闭弹窗。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import ItemAIView from './ItemAIView.vue'
import type { ArtifactDetail, ArtifactSummary } from './contracts'

const ITEM_ID = 'item-1'
const ARTIFACT = 'artifact-1'

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

function summaryFixture(): ArtifactSummary {
  return {
    id: ARTIFACT,
    itemId: ITEM_ID,
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

// apply 弹窗的渲染依赖 content.classification（selectedClassification）。
function detailFixture(): ArtifactDetail {
  return {
    ...summaryFixture(),
    itemId: ITEM_ID,
    taskRunId: 'task-1',
    content: {
      schemaVersion: '1.0',
      artifactType: 'organized_record',
      title: '示例标题',
      summary: '示例摘要',
      classification: {
        contentType: 'development',
        suggestedFolderPath: ['工作', '笔记'],
        suggestedTags: ['示例标签'],
        sensitivitySuggestion: 'normal',
      },
      blocks: [],
      warnings: [],
      sourceFragmentIds: [],
      review: { status: 'model_reviewed', limitations: [] },
    },
  }
}

function installFetchMock(options?: { hangActionPosts?: boolean; deferActionPosts?: boolean }) {
  const calls: RecordedCall[] = []
  // deferActionPosts 模式收集在途的动作 POST，由测试决定何时释放，驱动 busy→成功关闭。
  const actionPending: { path: string; resolve: () => void }[] = []
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
        return Promise.resolve(jsonResponse({ items: [summaryFixture()] }))
      }
      const actionMatch = url.match(
        /^\/api\/v1\/artifacts\/([^/]+)\/(activate|invalidate|apply-suggestions)$/,
      )
      if (actionMatch && method === 'POST') {
        // 挂起的 POST 永不 settle，用于构造 busy（POST 在途）期间弹窗全按钮禁用的状态。
        if (options?.hangActionPosts) return new Promise<Response>(() => {})
        if (options?.deferActionPosts) {
          return new Promise<Response>((resolve) => {
            actionPending.push({ path: url, resolve: () => resolve(jsonResponse({ ok: true })) })
          })
        }
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      const detailMatch = url.match(/^\/api\/v1\/artifacts\/([^/]+)$/)
      if (detailMatch) return Promise.resolve(jsonResponse(detailFixture()))
      return Promise.resolve(jsonResponse({}))
    }),
  )
  return { calls, actionPending }
}

// 触发按钮与提交按钮（“应用建议” vs “应用所选建议”）必须精确匹配，避免 includes 歧义。
function buttonByExactText(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll('button')].find(
    (entry) => (entry.textContent ?? '').trim() === text,
  )
  expect(button, `button with exact text "${text}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function applyDialog() {
  return document.querySelector<HTMLElement>('.ai-dialog.apply-dialog')
}

function confirmDialog() {
  return document.querySelector<HTMLElement>('.ai-dialog[role="alertdialog"]')
}

function focusedElement() {
  const active = document.activeElement
  expect(active, 'document.activeElement should exist').toBeTruthy()
  return active as HTMLElement
}

function pressKey(key: 'Escape' | 'Tab', shiftKey = false) {
  focusedElement().dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, shiftKey }),
  )
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

async function openApplyDialog() {
  buttonByExactText('应用建议').click()
  await flushPromises()
  expect(document.body.textContent).toContain('选择要应用的建议')
}

describe('ItemAIView dialog keyboard accessibility', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('closes the apply dialog on Escape without sending apply-suggestions and restores focus to the trigger', async () => {
    const { calls } = installFetchMock()
    const wrapper = await mountView()
    await flushPromises()

    await openApplyDialog()

    pressKey('Escape')
    await flushPromises()

    expect(document.body.textContent).not.toContain('选择要应用的建议')
    expect(
      calls.some((call) => call.method === 'POST' && call.path.includes('/apply-suggestions')),
    ).toBe(false)
    expect((focusedElement().textContent ?? '').trim()).toBe('应用建议')
    wrapper.unmount()
  })

  it('traps Tab focus inside the apply dialog', async () => {
    installFetchMock()
    const wrapper = await mountView()
    await flushPromises()

    await openApplyDialog()
    const dialog = applyDialog()
    expect(dialog, 'apply dialog').toBeTruthy()

    // 打开时初焦为弹窗内第一个可用 button（header 关闭图标按钮），当前行为已正确。
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭')

    // 勾选标题建议，使提交按钮变为可用（可聚焦）。
    const titleCheckbox = dialog!.querySelector<HTMLInputElement>('.suggestion input[type="checkbox"]')
    expect(titleCheckbox, 'title suggestion checkbox').not.toBeNull()
    titleCheckbox!.click()
    await flushPromises()

    const first = dialog!.querySelector<HTMLElement>('button[aria-label="关闭"]')
    const last = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => (entry.textContent ?? '').trim() === '应用所选建议',
    )
    expect(first, 'first focusable control').toBeTruthy()
    expect(last, 'last focusable control').toBeTruthy()
    expect(last!.disabled).toBe(false)

    first!.focus()
    pressKey('Tab', true)
    await flushPromises()
    expect(document.activeElement).toBe(last)
    expect(dialog!.contains(focusedElement())).toBe(true)

    last!.focus()
    pressKey('Tab')
    await flushPromises()
    expect(document.activeElement).toBe(first)
    expect(dialog!.contains(focusedElement())).toBe(true)
    wrapper.unmount()
  })

  it('closes the invalidate confirm dialog on Escape without sending the POST and restores focus', async () => {
    const { calls } = installFetchMock()
    const wrapper = await mountView()
    await flushPromises()

    buttonByExactText('作废版本').click()
    await flushPromises()
    expect(document.body.textContent).toContain('作废这个版本')
    const dialog = confirmDialog()
    expect(dialog, 'confirm dialog').toBeTruthy()

    // 打开时初焦为“取消”按钮，当前行为已正确。
    const cancel = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => (entry.textContent ?? '').trim() === '取消',
    )
    expect(cancel, 'cancel button').toBeTruthy()
    expect(document.activeElement).toBe(cancel)

    pressKey('Escape')
    await flushPromises()

    expect(document.body.textContent).not.toContain('作废这个版本')
    expect(
      calls.some(
        (call) => call.method === 'POST' && call.path === `/api/v1/artifacts/${ARTIFACT}/invalidate`,
      ),
    ).toBe(false)
    expect((focusedElement().textContent ?? '').trim()).toBe('作废版本')
    wrapper.unmount()
  })

  it('keeps focus inside the confirm dialog while the invalidate POST is pending', async () => {
    installFetchMock({ hangActionPosts: true })
    const wrapper = await mountView()
    await flushPromises()

    buttonByExactText('作废版本').click()
    await flushPromises()
    const dialog = confirmDialog()
    expect(dialog, 'confirm dialog').toBeTruthy()
    const confirmButton = buttonByExactText('确认', dialog!)
    const cancelButton = buttonByExactText('取消', dialog!)

    confirmButton.click()
    await flushPromises()

    // busy（POST 在途）：确认与取消都被禁用；浏览器会把焦点从被禁用的按钮上挤到 body。
    expect(confirmButton.disabled).toBe(true)
    expect(cancelButton.disabled).toBe(true)
    // 焦点必须被拉回弹窗内的可聚焦处（容器），而不是停留在被禁用的按钮或 body 上。
    const active = focusedElement()
    expect(dialog!.contains(active)).toBe(true)
    expect((active as HTMLButtonElement).disabled).toBeFalsy()

    // Tab 仍被圈定：focusable 为空时事件必须被拦截，焦点不出弹窗。
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    active.dispatchEvent(tabEvent)
    await flushPromises()
    expect(tabEvent.defaultPrevented).toBe(true)
    expect(dialog!.contains(focusedElement())).toBe(true)
    wrapper.unmount()
  })

  // DT-R252：真实提交进入 pending 后，用户 dismiss 入口（backdrop/取消/Escape/header X）都不得关闭弹窗。
  it('keeps the invalidate confirm dialog open while its POST is pending; backdrop, cancel and Escape cannot dismiss it', async () => {
    const { calls, actionPending } = installFetchMock({ deferActionPosts: true })
    const wrapper = await mountView()
    await flushPromises()

    buttonByExactText('作废版本').click()
    await flushPromises()
    const dialog = confirmDialog()
    expect(dialog, 'confirm dialog').toBeTruthy()
    buttonByExactText('确认', dialog!).click()
    await flushPromises()

    const invalidateCount = () =>
      calls.filter(
        (call) => call.method === 'POST' && call.path === `/api/v1/artifacts/${ARTIFACT}/invalidate`,
      ).length
    // busy 由真实在途的 invalidate POST 驱动：恰一次，未 settle。
    expect(invalidateCount(), 'invalidate POST 恰一次').toBe(1)
    expect(actionPending.length).toBe(1)

    // backdrop @click.self 在 busy 期间不得关闭：点击遮罩空白处，弹窗保持。
    const overlay = document.querySelector<HTMLElement>('.ai-overlay')
    expect(overlay, 'confirm overlay').toBeTruthy()
    overlay!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(confirmDialog(), 'busy 期间 backdrop 点击后弹窗仍在').not.toBeNull()

    // 取消按钮 busy 时禁用，真实点击不得关闭。
    buttonByExactText('取消', dialog!).click()
    await flushPromises()
    expect(confirmDialog(), 'busy 期间点击取消后弹窗仍在').not.toBeNull()

    // Escape 从当前焦点（弹窗容器）发出：POST 已发出，不得关闭。
    pressKey('Escape')
    await flushPromises()
    expect(confirmDialog(), 'busy 期间 Escape 后弹窗仍在').not.toBeNull()
    expect(invalidateCount(), 'busy 期间不追加请求').toBe(1)

    // 释放 POST：成功后正常关闭，仍只有一次请求。
    actionPending[0].resolve()
    await flushPromises()
    expect(confirmDialog(), '成功后弹窗关闭').toBeNull()
    expect(invalidateCount(), '释放后不追加请求').toBe(1)
    wrapper.unmount()
  })

  it('keeps the apply dialog open while apply-suggestions is pending; backdrop, cancel, header X and Escape cannot dismiss it', async () => {
    const { calls, actionPending } = installFetchMock({ deferActionPosts: true })
    const wrapper = await mountView()
    await flushPromises()

    await openApplyDialog()
    const dialog = applyDialog()
    expect(dialog, 'apply dialog').toBeTruthy()
    // 勾选标题建议，使提交按钮可用后真实提交。
    const titleCheckbox = dialog!.querySelector<HTMLInputElement>('.suggestion input[type="checkbox"]')
    expect(titleCheckbox, 'title suggestion checkbox').not.toBeNull()
    titleCheckbox!.click()
    await flushPromises()
    buttonByExactText('应用所选建议', dialog!).click()
    await flushPromises()

    const applyCount = () =>
      calls.filter(
        (call) =>
          call.method === 'POST' && call.path === `/api/v1/artifacts/${ARTIFACT}/apply-suggestions`,
      ).length
    expect(applyCount(), 'apply-suggestions POST 恰一次').toBe(1)
    expect(actionPending.length).toBe(1)

    // backdrop @click.self 在 busy 期间不得关闭。
    const overlay = document.querySelector<HTMLElement>('.ai-overlay')
    expect(overlay, 'apply overlay').toBeTruthy()
    overlay!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(applyDialog(), 'busy 期间 backdrop 点击后弹窗仍在').not.toBeNull()

    // 取消按钮 busy 时禁用，真实点击不得关闭。
    buttonByExactText('取消', dialog!).click()
    await flushPromises()
    expect(applyDialog(), 'busy 期间点击取消后弹窗仍在').not.toBeNull()

    // header X 必须禁用且不得关闭。
    const closeButton = dialog!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')
    expect(closeButton, 'header close button').toBeTruthy()
    expect(closeButton!.disabled, 'busy 期间 header X 禁用').toBe(true)
    closeButton!.click()
    await flushPromises()
    expect(applyDialog(), 'busy 期间点击 header X 后弹窗仍在').not.toBeNull()

    // Escape 从当前焦点（弹窗容器）发出：POST 已发出，不得关闭。
    pressKey('Escape')
    await flushPromises()
    expect(applyDialog(), 'busy 期间 Escape 后弹窗仍在').not.toBeNull()
    expect(applyCount(), 'busy 期间不追加请求').toBe(1)

    // 释放 POST：成功后正常关闭，仍只有一次请求。
    actionPending[0].resolve()
    await flushPromises()
    expect(applyDialog(), '成功后弹窗关闭').toBeNull()
    expect(applyCount(), '释放后不追加请求').toBe(1)
    wrapper.unmount()
  })
})

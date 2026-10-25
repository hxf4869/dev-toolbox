// 旧红测试（DT-R48）：ItemDetailView 三个 Teleport 弹窗（敏感揭示 / 编辑元数据 / 移入回收站）的键盘归属。
// 当前生产代码只有 role + v-if，缺少初始 focus、Tab 焦点圈定、Escape 关闭和关闭后回焦；
// 本文件断言修复语义，预期在未修复的生产代码上红。
// 忙状态语义与按钮禁用现状对齐：编辑弹窗取消按钮 busy 时不禁用（Escape 一致，仍允许关闭），
// 回收站弹窗取消按钮 busy 时禁用（Escape 不得关闭）。
// 指针取消（取消 / 关闭按钮）与 Escape 走同一取消回焦路径；busy 使确认按钮失效后弹窗内保持有效焦点。
// DT-R52 增强：DELETE 失败（busy→false）后错误提示可见、按钮恢复启用、焦点安全恢复到「取消」。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import ItemDetailView from './ItemDetailView.vue'

const ITEM_PATH = '/api/v1/items/item-1'

interface RecordedCall {
  method: string
  path: string
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function rawSummary() {
  return {
    id: 'raw-a',
    recordRole: 'primary',
    sourceType: 'web_quick_capture',
    contentKind: 'text',
    contentFormat: 'plain_text',
    declaredSensitivity: 'normal',
    capturedAt: '2026-09-01T08:00:00Z',
    effectiveCapturedAt: '2026-09-01T08:00:00Z',
    sourceTimeQuality: 'trusted',
    createdAt: '2026-09-01T08:00:00Z',
    attachments: [],
    relations: [],
    fragments: [],
  }
}

// 敏感揭示弹窗只在 detail.sensitivity 非 normal 时出现，fixture 参照 raw-race 测试。
function itemDetail(sensitivity: 'normal' | 'sensitive') {
  return {
    id: 'item-1',
    title: '键盘归属验证条目',
    titleOrigin: 'user',
    note: null,
    folder: null,
    tags: [],
    sensitivity,
    favorite: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    rawRecords: [rawSummary()],
    attachments: [],
    artifacts: [],
    availableVersions: [],
  }
}

// Escape 绝不能触发揭示确认；此 fixture 只保证误发请求时响应形状仍有效，
// 用例会同时断言 raw-records 端点从未被调用。
function rawRecordBody() {
  return {
    ...rawSummary(),
    itemId: 'item-1',
    readOnly: true,
    body: '原始正文 raw-a',
    source: { sourceType: 'web_quick_capture', metadata: {} },
  }
}

function installFetchMock(options?: { sensitivity?: 'normal' | 'sensitive'; hangMutations?: boolean }) {
  const calls: RecordedCall[] = []
  // 挂起的变更请求 gate：不触发 fail 即永不 settle（保持 busy）；
  // 需要模拟普通 API 失败时由用例对同一挂起 promise 主动 reject。
  const pendingMutations: Array<{ method: string; fail: (reason?: unknown) => void }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url })
      // beginEdit 打开编辑弹窗前会 await library.loadNavigation()（目录/标签导航端点）。
      if (url === '/api/v1/folders/tree') return Promise.resolve(jsonResponse({ items: [] }))
      if (url === '/api/v1/tags') return Promise.resolve(jsonResponse({ items: [] }))
      if (/^\/api\/v1\/items\/item-1\/raw-records\/[^/]+$/.test(url)) {
        return Promise.resolve(jsonResponse(rawRecordBody()))
      }
      if (url === ITEM_PATH && method === 'GET') {
        return Promise.resolve(jsonResponse(itemDetail(options?.sensitivity ?? 'normal')))
      }
      if (url === ITEM_PATH) {
        // 变更请求（PATCH/DELETE）：hangMutations 时经 gate 挂起（不 fail 即永不 settle），
        // 用真实挂起请求构造 busy；失败恢复用例再对同一 promise reject。
        if (options?.hangMutations) {
          return new Promise<Response>((_, reject) => {
            pendingMutations.push({ method, fail: reject })
          })
        }
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(jsonResponse({}))
    }),
  )
  // 对挂起中的指定变更请求主动 reject；没有对应挂起请求时直接证红，避免静默无操作。
  const failMutation = (method: string, reason?: unknown) => {
    const pending = pendingMutations.find((entry) => entry.method === method)
    expect(pending, `pending ${method} to reject`).toBeTruthy()
    pending!.fail(reason)
  }
  return { calls, failMutation }
}

// 触发按钮与弹窗内按钮必须精确匹配文本，避免 includes 歧义（如「编辑元数据」/「保存元数据」）。
function buttonByExactText(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll('button')].find(
    (entry) => (entry.textContent ?? '').trim() === text,
  )
  expect(button, `button with exact text "${text}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function dialogByLabelledBy(id: string) {
  return document.querySelector<HTMLElement>(`[aria-labelledby="${id}"]`)
}

function focusedElement() {
  const active = document.activeElement
  expect(active, 'document.activeElement should exist').toBeTruthy()
  return active as HTMLElement
}

function pressKey(key: 'Escape' | 'Tab', options: { shiftKey?: boolean; isComposing?: boolean } = {}) {
  focusedElement().dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }),
  )
}

async function mountDetail() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: { template: '<div />' } },
      { path: '/items/:itemId', name: 'item-detail', component: ItemDetailView },
    ],
  })
  await router.push('/')
  const wrapper = mount(ItemDetailView, {
    props: { itemId: 'item-1' },
    attachTo: document.body,
    global: { plugins: [router] },
  })
  await flushPromises()
  return wrapper
}

// 编辑弹窗里 v-model="editTitle" 的标题输入框（label 内 span 文本为「标题」）。
function editTitleInput(dialog: HTMLElement) {
  const label = [...dialog.querySelectorAll('label')].find(
    (entry) => (entry.querySelector('span')?.textContent ?? '').trim() === '标题',
  )
  const input = label?.querySelector<HTMLInputElement>('input')
  expect(input, 'edit title input').toBeTruthy()
  return input as HTMLInputElement
}

// 从真实聚焦的标题输入框键入文本（v-model 监听原生 input 事件）。
function typeInto(input: HTMLInputElement, value: string) {
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ItemDetailView dialog keyboard accessibility', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('敏感揭示弹窗：初焦「取消」、Tab 首尾环绕、Escape 关闭回焦且不发任何请求', async () => {
    const { calls } = installFetchMock({ sensitivity: 'sensitive' })
    const wrapper = await mountDetail()

    const trigger = buttonByExactText('查看原始记录')
    trigger.click()
    await flushPromises()
    const dialog = dialogByLabelledBy('reveal-title')
    expect(dialog, 'reveal alertdialog').toBeTruthy()

    // 危险按钮「确认揭示」不得被自动聚焦，打开后初焦必须是「取消」。
    const confirmButton = buttonByExactText('确认揭示', dialog!)
    const cancelButton = buttonByExactText('取消', dialog!)
    expect(document.activeElement).toBe(cancelButton)

    // Tab / Shift+Tab 在弹窗内首尾互绕，焦点不出弹窗容器。
    confirmButton.focus()
    pressKey('Tab', { shiftKey: true })
    await flushPromises()
    expect(document.activeElement).toBe(cancelButton)
    expect(dialog!.contains(focusedElement())).toBe(true)

    cancelButton.focus()
    pressKey('Tab')
    await flushPromises()
    expect(document.activeElement).toBe(confirmButton)
    expect(dialog!.contains(focusedElement())).toBe(true)

    // Escape 关闭弹窗，不触发揭示（无 raw-records 读取、无任何确认类请求），焦点回到触发按钮。
    pressKey('Escape')
    await flushPromises()
    expect(dialogByLabelledBy('reveal-title')).toBeNull()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    expect(calls.some((call) => call.path.includes('/raw-records/'))).toBe(false)
    expect(document.activeElement).toBe(trigger)

    // 指针路径：重新打开后点击「取消」同样关闭弹窗并回焦触发按钮。
    trigger.click()
    await flushPromises()
    const reopened = dialogByLabelledBy('reveal-title')
    expect(reopened, 'reopen reveal dialog').toBeTruthy()
    buttonByExactText('取消', reopened!).click()
    await flushPromises()
    expect(dialogByLabelledBy('reveal-title')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
  })

  it('回收站弹窗：初焦「取消」、Tab 首尾环绕、Escape 关闭回焦且不发 DELETE', async () => {
    const { calls } = installFetchMock()
    const wrapper = await mountDetail()

    const trigger = document.querySelector<HTMLButtonElement>('button.trash-action')
    expect(trigger, 'trash trigger').toBeTruthy()
    trigger!.click()
    await flushPromises()
    const dialog = dialogByLabelledBy('trash-title')
    expect(dialog, 'trash alertdialog').toBeTruthy()

    // 危险按钮「移入回收站」不得被自动聚焦，打开后初焦必须是「取消」。
    const confirmButton = buttonByExactText('移入回收站', dialog!)
    const cancelButton = buttonByExactText('取消', dialog!)
    expect(document.activeElement).toBe(cancelButton)

    confirmButton.focus()
    pressKey('Tab', { shiftKey: true })
    await flushPromises()
    expect(document.activeElement).toBe(cancelButton)
    expect(dialog!.contains(focusedElement())).toBe(true)

    cancelButton.focus()
    pressKey('Tab')
    await flushPromises()
    expect(document.activeElement).toBe(confirmButton)
    expect(dialog!.contains(focusedElement())).toBe(true)

    // Escape 关闭弹窗，不触发移入回收站（DELETE），焦点回到「移入回收站」触发按钮。
    pressKey('Escape')
    await flushPromises()
    expect(dialogByLabelledBy('trash-title')).toBeNull()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    expect(document.activeElement).toBe(trigger)

    // 指针路径：重新打开后点击「取消」同样关闭弹窗并回焦触发按钮。
    trigger!.click()
    await flushPromises()
    const reopened = dialogByLabelledBy('trash-title')
    expect(reopened, 'reopen trash dialog').toBeTruthy()
    buttonByExactText('取消', reopened!).click()
    await flushPromises()
    expect(dialogByLabelledBy('trash-title')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
  })

  it('编辑弹窗：打开后初焦标题输入框，Tab 在弹窗内首尾环绕', async () => {
    installFetchMock()
    const wrapper = await mountDetail()

    const editTrigger = buttonByExactText('编辑元数据')
    editTrigger.click()
    await flushPromises()
    const dialog = dialogByLabelledBy('edit-title')
    expect(dialog, 'edit dialog').toBeTruthy()

    // 打开后初焦必须是标题输入框（v-model="editTitle"）。
    expect(document.activeElement).toBe(editTitleInput(dialog!))

    const first = dialog!.querySelector<HTMLElement>('button[aria-label="关闭编辑"]')
    const last = buttonByExactText('保存元数据', dialog!)
    expect(first, 'first focusable control').toBeTruthy()

    first!.focus()
    pressKey('Tab', { shiftKey: true })
    await flushPromises()
    expect(document.activeElement).toBe(last)
    expect(dialog!.contains(focusedElement())).toBe(true)

    last.focus()
    pressKey('Tab')
    await flushPromises()
    expect(document.activeElement).toBe(first)
    expect(dialog!.contains(focusedElement())).toBe(true)

    // 指针路径：footer「取消」关闭并回焦到「编辑元数据」触发按钮。
    buttonByExactText('取消', dialog!).click()
    await flushPromises()
    expect(dialogByLabelledBy('edit-title')).toBeNull()
    expect(document.activeElement).toBe(editTrigger)
    wrapper.unmount()
  })

  it('编辑弹窗：非合成的 Escape 关闭并回焦，IME 合成中的 Escape 被忽略', async () => {
    const { calls } = installFetchMock()
    const wrapper = await mountDetail()

    const trigger = buttonByExactText('编辑元数据')
    trigger.click()
    await flushPromises()
    expect(dialogByLabelledBy('edit-title'), 'edit dialog').toBeTruthy()

    // isComposing=true（IME 组合中）的 Escape 不得关闭弹窗。
    pressKey('Escape', { isComposing: true })
    await flushPromises()
    expect(dialogByLabelledBy('edit-title')).not.toBeNull()

    pressKey('Escape')
    await flushPromises()
    expect(dialogByLabelledBy('edit-title')).toBeNull()
    // Escape 全程不触发保存（PATCH）等确认类请求。
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    expect(document.activeElement).toBe(trigger)

    // 指针路径：header「关闭编辑」X 按钮同样关闭并回焦。
    trigger.click()
    await flushPromises()
    const reopened = dialogByLabelledBy('edit-title')
    expect(reopened, 'reopen edit dialog').toBeTruthy()
    reopened!.querySelector<HTMLElement>('button[aria-label="关闭编辑"]')!.click()
    await flushPromises()
    expect(dialogByLabelledBy('edit-title')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
  })

  it('挂起 PATCH 时编辑弹窗 Escape 仍允许关闭，且不再追加保存请求', async () => {
    const { calls } = installFetchMock({ hangMutations: true })
    const wrapper = await mountDetail()

    buttonByExactText('编辑元数据').click()
    await flushPromises()
    const editDialog = dialogByLabelledBy('edit-title')
    expect(editDialog, 'edit dialog').toBeTruthy()
    // R229：无字段变化不再发出 PATCH（改为直接关闭），先真实改标题以保留挂起 PATCH 的 busy 前提。
    typeInto(editTitleInput(editDialog!), '挂起保存验证标题')
    // 真实用户先聚焦保存按钮再点击：busy 置位使按钮失效后，焦点必须回到弹窗内有效控件。
    const saveButton = buttonByExactText('保存元数据')
    saveButton.focus()
    saveButton.click()
    await flushPromises()

    const patchCount = () =>
      calls.filter((call) => call.method === 'PATCH' && call.path === ITEM_PATH).length
    // busy 由真实挂起的 PATCH 驱动：请求已发出且未决。
    expect(patchCount(), 'PATCH 已发出进入 busy 门槛').toBe(1)
    const busyDialog = dialogByLabelledBy('edit-title')
    expect(busyDialog, 'edit dialog stays open while PATCH pending').toBeTruthy()
    const busyActive = focusedElement()
    expect(busyDialog!.contains(busyActive), 'busy 后焦点仍在编辑弹窗内').toBe(true)
    expect(busyActive.matches('button:disabled, input:disabled, select:disabled, textarea:disabled')).toBe(false)

    // 现有取消按钮 busy 时不禁用，Escape 语义一致：仍允许关闭。
    pressKey('Escape')
    await flushPromises()
    expect(dialogByLabelledBy('edit-title')).toBeNull()
    expect(patchCount()).toBe(1)
    wrapper.unmount()
  })

  it('挂起 DELETE 时回收站弹窗 Escape 不关闭；失败恢复后错误可见、焦点回「取消」且可关闭', async () => {
    const { calls, failMutation } = installFetchMock({ hangMutations: true })
    const wrapper = await mountDetail()

    const trigger = document.querySelector<HTMLButtonElement>('button.trash-action')
    expect(trigger, 'trash trigger').toBeTruthy()
    trigger!.click()
    await flushPromises()
    const dialog = dialogByLabelledBy('trash-title')
    expect(dialog, 'trash alertdialog').toBeTruthy()

    // 真实用户先聚焦确认按钮再点击：busy 后两个按钮都禁用，焦点必须落在容器上。
    const confirmButton = buttonByExactText('移入回收站', dialog!)
    const cancelButton = buttonByExactText('取消', dialog!)
    confirmButton.focus()
    confirmButton.click()
    await flushPromises()

    const deleteCount = () =>
      calls.filter((call) => call.method === 'DELETE' && call.path === ITEM_PATH).length
    // busy 由真实挂起的 DELETE 驱动：请求已发出且未决。
    expect(deleteCount(), 'DELETE 已发出进入 busy 门槛').toBe(1)
    // 现有取消按钮 busy 时禁用，Escape 语义一致：不得关闭。
    expect(buttonByExactText('取消', dialog!).disabled).toBe(true)
    expect(document.activeElement).toBe(dialog)
    // Tab / Shift+Tab 都留在 tabindex=-1 的弹窗容器上，不落回背景。
    pressKey('Tab')
    await flushPromises()
    expect(document.activeElement).toBe(dialog)
    pressKey('Tab', { shiftKey: true })
    await flushPromises()
    expect(document.activeElement).toBe(dialog)

    pressKey('Escape')
    await flushPromises()
    expect(dialogByLabelledBy('trash-title')).not.toBeNull()
    expect(deleteCount()).toBe(1)

    // 失败恢复：主动 reject 同一个挂起的 DELETE，模拟普通 API 失败后弹窗恢复可用与焦点安全。
    failMutation('DELETE', new Error('回收站服务暂不可用，请稍后重试'))
    await flushPromises()

    expect(dialog!.isConnected, '失败后回收站弹窗保持打开').toBe(true)
    const errorNotice = dialog!.querySelector<HTMLElement>('.mutation-error[role="alert"]')
    expect(errorNotice, '失败提示 role=alert 可见').toBeTruthy()
    expect(errorNotice!.textContent?.trim()).toBe('回收站服务暂不可用，请稍后重试')

    // busy 解除后两个按钮恢复启用（busy 中确认按钮文本为「正在移动」，必须复用打开时的元素引用）。
    expect(confirmButton.disabled).toBe(false)
    expect(cancelButton.disabled).toBe(false)

    // 焦点安全恢复到「取消」（末按钮）：修复前生产 busy→false 不恢复焦点，本断言曾为预期红点；现由 mutationBusy 焦点恢复实现。
    expect(document.activeElement, '失败后焦点恢复到「取消」').toBe(cancelButton)

    // 从真实焦点继续验证首尾环绕：焦点在「取消」（末）Tab → 「移入回收站」（首，经生产 boundary trap）。
    pressKey('Tab')
    await flushPromises()
    expect(document.activeElement).toBe(confirmButton)
    pressKey('Tab', { shiftKey: true })
    await flushPromises()
    expect(document.activeElement).toBe(cancelButton)

    // 失败恢复后 Escape 关闭弹窗，焦点回触发器，且不追加 DELETE。
    pressKey('Escape')
    await flushPromises()
    expect(dialogByLabelledBy('trash-title')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(deleteCount()).toBe(1)
    wrapper.unmount()
  })
})

import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import QuickCaptureDrawer from './QuickCaptureDrawer.vue'
import WorkspaceView from './WorkspaceView.vue'

interface FetchCall {
  path: string
  init: RequestInit
}
const trashItem = {
  id: 'trash-1',
  title: '已删除的部署备注',
  sensitivity: 'normal',
  favorite: false,
  folderId: null,
  tags: [],
  summary: '已进入回收站的记录',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  deletedAt: '2026-09-02T00:00:00Z',
  effectiveCapturedAt: '2026-09-01T00:00:00Z',
  sourceTimeQuality: 'user',
  rawRecordCount: 1,
  attachmentCount: 0,
  attachments: [],
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 可控的挂起响应：busy 用例需要 DELETE /purge 在断言期间保持未决
function deferredResponse() {
  let settle!: (response: Response) => void
  const promise = new Promise<Response>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle }
}

function installFetchMock(onPurge: () => Promise<Response>) {
  const calls: FetchCall[] = []
  const mock = vi.fn().mockImplementation((path: string, init: RequestInit) => {
    const url = String(path)
    calls.push({ path: url, init })
    if (url.includes('/purge')) return onPurge()
    if (url.startsWith('/api/v1/items?')) return Promise.resolve(jsonResponse({ items: [trashItem], nextCursor: null }))
    if (url.startsWith('/api/v1/folders/tree')) return Promise.resolve(jsonResponse({ items: [] }))
    if (url.startsWith('/api/v1/tags')) return Promise.resolve(jsonResponse({ items: [] }))
    if (url.startsWith('/api/v1/search')) return Promise.resolve(jsonResponse({ sort: 'relevance', total: 0, items: [], nextCursor: null }))
    return Promise.resolve(jsonResponse({}))
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

async function mountTrashWorkspace() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: WorkspaceView },
      { path: '/items/:itemId', name: 'item-detail', component: WorkspaceView },
    ],
  })
  await router.push({ path: '/', query: { view: 'trash' } })
  // jsdom 只允许对已连接到文档的元素生效 focus()，挂载进 body 才能验证真实焦点行为
  const container = document.createElement('div')
  document.body.appendChild(container)
  const wrapper = mount(WorkspaceView, { attachTo: container, global: { plugins: [router] } })
  activeWrapper = wrapper
  await flushPromises()
  const trigger = wrapper
    .findAll('.result-card--trash button')
    .find((button) => button.text().includes('永久删除'))
  if (!trigger) throw new Error('未找到回收站卡片的「永久删除」触发按钮')
  return { wrapper, trigger }
}

function getDialog() {
  return document.querySelector('.purge-overlay section[role="alertdialog"]')
}

// busy 时确认按钮文案会变成「正在永久删除」，因此用「永久删除」子串匹配两种状态
function dialogButton(label: string) {
  const buttons = Array.from(getDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  return buttons.find((button) => (button.textContent ?? '').includes(label)) ?? null
}

function requireDialogButton(label: string) {
  const button = dialogButton(label)
  if (!button) throw new Error(`弹窗内未找到「${label}」按钮`)
  return button
}

async function fireClick(element: Element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await nextTick()
}

// 键盘事件只从当前真实焦点元素派发（无则 body），不替实现兜底入焦，避免掩盖焦点归属缺口
async function pressKey(key: string, options: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))
  await nextTick()
}

// 按 init.method 明确校准为 DELETE /purge，不匹配任意方法的同路径请求
function purgeCalls(calls: FetchCall[]) {
  return calls.filter((call) => call.init.method === 'DELETE' && call.path.includes('/purge'))
}

// 记录当前挂载实例，统一在 afterEach 卸载（成功与失败用例都不残留 window 监听）
let activeWrapper: ReturnType<typeof mount> | null = null

describe('WorkspaceView 回收站永久删除弹窗键盘与焦点', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  afterEach(() => {
    // 旧红断言抛出会跳过用例尾的卸载；统一在此卸载，避免 window 快捷键监听跨用例干扰
    activeWrapper?.unmount()
    activeWrapper = null
  })

  it('打开弹窗后初始焦点在取消按钮，Tab/Shift+Tab 在弹窗内首尾闭环', async () => {
    installFetchMock(() => Promise.resolve(jsonResponse({})))
    const { wrapper, trigger } = await mountTrashWorkspace()
    await trigger.trigger('click')
    await nextTick()

    const dialog = getDialog()
    expect(dialog).not.toBeNull()
    const confirmButton = requireDialogButton('永久删除')
    const cancelButton = requireDialogButton('取消')

    // 打开后初始焦点落在安全的「取消」按钮上
    expect(document.activeElement).toBe(cancelButton)

    // APG alertdialog：aria-describedby 需要实际指向那段物理删除警告说明
    const describedBy = dialog?.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const warning = describedBy ? document.getElementById(describedBy) : null
    expect(warning?.textContent ?? '').toContain(
      '这会物理删除关联的原始记录、附件、缩略图、搜索片段和 AI 版本，无法从回收站恢复。',
    )

    // 弹窗内按 / 不得被背景搜索框抢走焦点
    await pressKey('/')
    expect(document.activeElement).toBe(cancelButton)

    // 弹窗内按 Ctrl+Shift+Enter 不得打开快速记录抽屉
    await pressKey('Enter', { ctrlKey: true, shiftKey: true })
    expect(wrapper.findComponent(QuickCaptureDrawer).props('open')).toBe(false)

    // 只验证首尾边界环绕：取消（末位）Tab 绕回确认（首位）；确认 Shift+Tab 绕回取消。
    // jsdom 没有浏览器默认 Tab 前进，不断言原生遍历，完整 Tab 流转由真实浏览器验收
    await pressKey('Tab')
    expect(document.activeElement).toBe(confirmButton)
    await pressKey('Tab', { shiftKey: true })
    expect(document.activeElement).toBe(cancelButton)
    // 焦点始终没有离开弹窗
    expect(dialog?.contains(document.activeElement)).toBe(true)
  })

  it('Escape 与指针取消关闭弹窗、清除错误并回焦触发按钮，取消路径不发出 purge 请求', async () => {
    const calls = installFetchMock(() => Promise.reject(new Error('永久删除请求失败')))
    const { trigger } = await mountTrashWorkspace()
    await trigger.trigger('click')
    await nextTick()
    expect(getDialog()).not.toBeNull()

    // 先用一次失败的确认让错误文案出现（现有行为），之后才能验证「关闭时清除错误」
    await fireClick(requireDialogButton('永久删除'))
    await flushPromises()
    expect(document.querySelector('.purge-dialog__error')).not.toBeNull()

    // 非 IME Escape：关闭弹窗并把焦点还给该条目真实的「永久删除」触发按钮
    await pressKey('Escape')
    await flushPromises()
    expect(getDialog()).toBeNull()
    expect(document.activeElement).toBe(trigger.element)

    // 重新打开：上次的错误文案已被清除
    await trigger.trigger('click')
    await nextTick()
    expect(getDialog()).not.toBeNull()
    expect(document.querySelector('.purge-dialog__error')).toBeNull()

    // IME 组合中的 Escape 不关闭弹窗
    await pressKey('Escape', { isComposing: true })
    await flushPromises()
    expect(getDialog()).not.toBeNull()

    // 指针点击「取消」与 Escape 同语义：关闭弹窗并回焦
    await fireClick(requireDialogButton('取消'))
    await nextTick()
    expect(getDialog()).toBeNull()
    expect(document.activeElement).toBe(trigger.element)

    // 整条取消路径只应有失败确认那一次 DELETE /purge
    expect(purgeCalls(calls)).toHaveLength(1)

    // 弹窗关闭后背景快捷键保持原有行为：按 / 重新聚焦搜索输入框
    await pressKey('/')
    expect(document.activeElement).toBe(document.getElementById('workspace-search'))
  })

  it('busy 期间按钮禁用、焦点收回弹窗容器且 Tab 不外泄，完成后仅一次 purge 并刷新', async () => {
    const deferred = deferredResponse()
    const calls = installFetchMock(() => deferred.promise)
    const { trigger } = await mountTrashWorkspace()
    await trigger.trigger('click')
    await nextTick()

    const confirmButton = requireDialogButton('永久删除')
    confirmButton.focus()
    expect(document.activeElement).toBe(confirmButton)

    await fireClick(confirmButton)
    await flushPromises()

    // busy：两个按钮都禁用（现有语义）
    expect(requireDialogButton('永久删除').disabled).toBe(true)
    expect(requireDialogButton('取消').disabled).toBe(true)

    // 挂起的 DELETE /purge 已真实进入未决
    expect(purgeCalls(calls)).toHaveLength(1)

    // 焦点收回弹窗容器（tabindex=-1 的 section）
    const dialog = getDialog()
    expect(document.activeElement).toBe(dialog)
    expect(dialog?.getAttribute('tabindex')).toBe('-1')

    // Tab / Shift+Tab 都不把焦点带出弹窗（留在容器上）
    await pressKey('Tab')
    expect(getDialog()?.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(getDialog())
    await pressKey('Tab', { shiftKey: true })
    expect(document.activeElement).toBe(getDialog())

    // busy 中 Escape 不关闭弹窗、不发出第二次 DELETE /purge
    await pressKey('Escape')
    await flushPromises()
    expect(getDialog()).not.toBeNull()
    expect(purgeCalls(calls)).toHaveLength(1)

    // 请求完成后：弹窗关闭，browse 与 loadNavigation 各刷新一次，purge 只发过一次
    const browseCount = calls.filter((call) => call.path.startsWith('/api/v1/items?')).length
    const folderCount = calls.filter((call) => call.path.startsWith('/api/v1/folders/tree')).length
    deferred.resolve(jsonResponse({}))
    await flushPromises()
    expect(getDialog()).toBeNull()
    expect(purgeCalls(calls)).toHaveLength(1)
    expect(calls.filter((call) => call.path.startsWith('/api/v1/items?')).length).toBe(browseCount + 1)
    expect(calls.filter((call) => call.path.startsWith('/api/v1/folders/tree')).length).toBe(folderCount + 1)
  })

  it('保留原有语义：非 busy 时两按钮可聚焦、取消可关闭弹窗，busy 时两按钮禁用', async () => {
    const deferred = deferredResponse()
    installFetchMock(() => deferred.promise)
    const { trigger } = await mountTrashWorkspace()
    await trigger.trigger('click')
    await nextTick()

    const confirmButton = requireDialogButton('永久删除')
    const cancelButton = requireDialogButton('取消')
    confirmButton.focus()
    expect(document.activeElement).toBe(confirmButton)
    cancelButton.focus()
    expect(document.activeElement).toBe(cancelButton)

    // 指针取消可关闭弹窗
    await fireClick(cancelButton)
    await nextTick()
    expect(getDialog()).toBeNull()

    // busy 期间两个按钮都禁用
    await trigger.trigger('click')
    await nextTick()
    await fireClick(requireDialogButton('永久删除'))
    await flushPromises()
    expect(requireDialogButton('永久删除').disabled).toBe(true)
    expect(requireDialogButton('取消').disabled).toBe(true)

    // 结束挂起请求，让组件回到非 busy 状态（卸载统一由 afterEach 处理）
    deferred.resolve(jsonResponse({}))
    await flushPromises()
  })
})

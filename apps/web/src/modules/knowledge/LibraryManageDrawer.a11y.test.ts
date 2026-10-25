// DT-R54 旧红测试：LibraryManageDrawer 结构管理确认层（.manager__confirm）的键盘安全。
// 目标合同：确认层打开初焦「取消」（不得是「确认删除」）、aria-labelledby 标题含条目名、
// aria-describedby 指向层内非空说明文本、Tab 首尾环绕、Escape 关闭确认层并回焦该行「删除」、
// IME 合成中的 Escape 被忽略、DELETE 在途双按钮禁用且焦点圈定在确认容器（tabindex=-1）、
// 失败后层内出现 role=alert、恢复回焦「取消」，取消不重发 DELETE；成功后确认层关闭并回焦
// manager 内第一个 input（创建输入框）。
// 当前生产代码仅「外层抽屉关闭回焦」已满足（见对应用例），其余用例预期在未修复源码上红。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'

import LibraryManageDrawer from './LibraryManageDrawer.vue'
import { type FolderEntry, type TagEntry, useLibraryStore } from './library'

const FOLDER_NAME = '键盘安全目录'
const TAG_NAME = '键盘安全标签'

const folderSeed: FolderEntry[] = [
  { id: 'folder-1', parentId: null, name: FOLDER_NAME, sortOrder: 1, itemCount: 3, children: [] },
]
const tagSeed: TagEntry[] = [{ id: 'tag-1', name: TAG_NAME, itemCount: 2 }]

interface RecordedCall {
  method: string
  path: string
}

interface DeferredResponse {
  resolve: (response: Response) => void
  reject: (reason?: unknown) => void
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// GET /api/v1/folders/tree 与 /api/v1/tags 正常应答（loadNavigation 使用）；
// DELETE 一律挂起为手动 deferred，由用例决定 settle 时机与结果。
// tags 应答可按用例覆盖（第 5 条成功段：服务端刷新后目标 Tag 实际消失）。
function installFetchMock(options: { tags?: TagEntry[] } = {}) {
  const tagsItems = options.tags ?? tagSeed
  const calls: RecordedCall[] = []
  const pendingDeletes: DeferredResponse[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url })
      if (url === '/api/v1/folders/tree') return Promise.resolve(jsonResponse({ items: folderSeed }))
      if (url === '/api/v1/tags') return Promise.resolve(jsonResponse({ items: tagsItems }))
      if (method === 'DELETE') {
        return new Promise<Response>((resolve, reject) => {
          pendingDeletes.push({ resolve, reject })
        })
      }
      return Promise.resolve(jsonResponse({}))
    }),
  )
  return { calls, pendingDeletes }
}

// 按钮按精确可访问文本匹配，避免「删除」误配「确认删除」等子串歧义。
function buttonByExactText(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll('button')].find(
    (entry) => (entry.textContent ?? '').trim() === text,
  )
  expect(button, `button with exact text "${text}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function focusedElement() {
  const active = document.activeElement
  expect(active, 'document.activeElement should exist').toBeTruthy()
  return active as HTMLElement
}

// 键盘事件必须派发在真实 document.activeElement 上；jsdom 构造器若不认 isComposing
// init，则在实例上补设（仍为真实派发）。
function pressKey(key: 'Escape' | 'Tab', options: { shiftKey?: boolean; isComposing?: boolean } = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  if (options.isComposing !== undefined && !event.isComposing) {
    Object.defineProperty(event, 'isComposing', { configurable: true, value: options.isComposing })
  }
  focusedElement().dispatchEvent(event)
}

function confirmLayer() {
  const confirm = document.querySelector<HTMLElement>('.manager__confirm')
  expect(confirm, '.manager__confirm layer').toBeTruthy()
  return confirm!
}

describe('LibraryManageDrawer 结构管理确认框键盘安全（DT-R54）', () => {
  let wrapper: VueWrapper | undefined
  let offsetParentDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    // 生产 Tab 作用域用 offsetParent 做可见性筛选，jsdom 无布局：
    // 仅在本文件 stub 只读 getter 为「已连接节点可见」，afterEach 恢复，不改生产代码。
    offsetParentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.isConnected ? document.body : null
      },
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.innerHTML = ''
    if (offsetParentDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor)
    } else {
      delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
    }
    vi.unstubAllGlobals()
  })

  async function mountClosedDrawer() {
    const library = useLibraryStore()
    library.folders = folderSeed.map((folder) => ({ ...folder, children: [] }))
    library.tags = tagSeed.map((tag) => ({ ...tag }))
    wrapper = mount(LibraryManageDrawer, { attachTo: document.body })
    return library
  }

  async function openManager(library: ReturnType<typeof useLibraryStore>) {
    library.managerOpen = true
    await flushPromises()
    expect(document.querySelector('.manager'), '.manager dialog').toBeTruthy()
  }

  it('目录删除确认层：初焦「取消」、标题含目录名、aria-describedby 非空、Tab 首尾环绕', async () => {
    installFetchMock()
    const library = await mountClosedDrawer()
    await openManager(library)

    const rowDelete = buttonByExactText('删除')
    rowDelete.focus()
    rowDelete.click()
    await flushPromises()

    const confirm = confirmLayer()
    expect(confirm.getAttribute('role')).toBe('alertdialog')

    // 危险按钮「确认删除」不得被自动聚焦，打开后初焦必须是「取消」。
    const confirmButton = buttonByExactText('确认删除', confirm)
    const cancelButton = buttonByExactText('取消', confirm)
    expect(document.activeElement).toBe(cancelButton)
    expect(document.activeElement).not.toBe(confirmButton)

    // aria-labelledby 指向的标题须在确认层内并包含被删条目名称。
    const labelledBy = confirm.getAttribute('aria-labelledby')
    expect(labelledBy, 'aria-labelledby').toBeTruthy()
    const title = labelledBy ? document.getElementById(labelledBy) : null
    expect(title, 'labelledby target').toBeTruthy()
    expect(confirm.contains(title!)).toBe(true)
    expect(title!.textContent ?? '').toContain(FOLDER_NAME)

    // aria-describedby 指向确认层内非空说明文本。
    const describedBy = confirm.getAttribute('aria-describedby')
    expect(describedBy, 'aria-describedby').toBeTruthy()
    const described = describedBy ? document.getElementById(describedBy) : null
    expect(described, 'describedby target').toBeTruthy()
    expect(confirm.contains(described!)).toBe(true)
    expect((described!.textContent ?? '').trim().length).toBeGreaterThan(0)

    // Tab 环绕：焦点在「取消」（末项）→ 首项「确认删除」；Shift+Tab 从首项回末项。
    cancelButton.focus()
    pressKey('Tab')
    await flushPromises()
    expect(document.activeElement).toBe(confirmButton)
    expect(confirm.contains(focusedElement())).toBe(true)

    confirmButton.focus()
    pressKey('Tab', { shiftKey: true })
    await flushPromises()
    expect(document.activeElement).toBe(cancelButton)
    expect(confirm.contains(focusedElement())).toBe(true)
  })

  it('标签入口：Escape 关闭确认层并回焦该行「删除」，外层抽屉保持打开', async () => {
    installFetchMock()
    const library = await mountClosedDrawer()
    await openManager(library)

    buttonByExactText('标签').click()
    await flushPromises()

    const rowDelete = buttonByExactText('删除')
    rowDelete.focus()
    rowDelete.click()
    await flushPromises()
    confirmLayer()

    pressKey('Escape')
    await flushPromises()

    expect(document.querySelector('.manager__confirm')).toBeNull()
    expect(document.activeElement).toBe(rowDelete)
    expect(document.querySelector('.manager'), '外层 manager（role=dialog）仍在文档').toBeTruthy()
  })

  it('IME：合成中的 Escape 不关闭确认层且焦点保持不变', async () => {
    installFetchMock()
    const library = await mountClosedDrawer()
    await openManager(library)

    const rowDelete = buttonByExactText('删除')
    rowDelete.focus()
    rowDelete.click()
    await flushPromises()
    confirmLayer()

    const before = focusedElement()
    pressKey('Escape', { isComposing: true })
    await flushPromises()

    expect(document.querySelector('.manager__confirm'), '合成中的 Escape 不得关闭确认层').toBeTruthy()
    expect(document.activeElement).toBe(before)
  })

  it('外层关闭：header 关闭按钮移除 manager，焦点回到打开前的替代触发按钮', async () => {
    installFetchMock()
    const library = await mountClosedDrawer()

    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.textContent = '替代触发'
    document.body.appendChild(trigger)
    trigger.focus()
    await openManager(library)

    const closeButton = document.querySelector<HTMLButtonElement>('button[aria-label="关闭管理抽屉"]')
    expect(closeButton, 'header close button').toBeTruthy()
    closeButton!.click()
    await flushPromises()

    expect(document.querySelector('.manager')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('DELETE 在途（Tag）：按钮禁用、焦点圈定容器、Escape 不关；失败后层内错误与回焦恢复；取消不重发；成功后目标行消失并回焦创建输入框', async () => {
    // Tag 入口符合真实合同：itemCount>0 的标签可解绑并删除；成功后的 GET /tags
    // 返回不含目标 Tag 的服务端状态，证明原触发行实际消失。
    const { calls, pendingDeletes } = installFetchMock({ tags: tagSeed.filter((tag) => tag.id !== 'tag-1') })
    const library = await mountClosedDrawer()
    await openManager(library)

    buttonByExactText('标签').click()
    await flushPromises()

    const rowDelete = buttonByExactText('删除')
    rowDelete.focus()
    rowDelete.click()
    await flushPromises()
    confirmLayer()

    const deleteCount = () => calls.filter((call) => call.method === 'DELETE').length
    const confirmDeleteButton = buttonByExactText('确认删除', confirmLayer())
    confirmDeleteButton.focus()
    confirmDeleteButton.click()
    await flushPromises()

    // busy 由真实挂起的 DELETE 驱动：请求已发出且未决。
    expect(deleteCount(), 'DELETE 已发出进入 busy 门槛').toBe(1)

    // a) 在途时「确认删除」与「取消」均禁用。
    expect(buttonByExactText('确认删除', confirmLayer()).disabled).toBe(true)
    expect(buttonByExactText('取消', confirmLayer()).disabled).toBe(true)

    // b) 焦点落在确认容器（tabindex=-1）上，而非残留在被禁用按钮。
    expect(document.activeElement).toBe(confirmLayer())

    // c) Tab / Shift+Tab 焦点仍留在确认层内，不逃到外层控件。
    pressKey('Tab')
    await flushPromises()
    expect(confirmLayer().contains(focusedElement())).toBe(true)
    pressKey('Tab', { shiftKey: true })
    await flushPromises()
    expect(confirmLayer().contains(focusedElement())).toBe(true)

    // d) 在途 Escape 不得关闭确认层，也不得连带关闭外层抽屉。
    pressKey('Escape')
    await flushPromises()
    expect(document.querySelector('.manager__confirm')).toBeTruthy()
    expect(document.querySelector('.manager')).toBeTruthy()

    // e) 令同一挂起 DELETE 失败：确认层内出现 role=alert 错误文本、
    //    「取消」恢复可用、焦点恢复到「取消」。
    pendingDeletes[0].reject(new Error('合成网络错误：标签删除请求失败'))
    await flushPromises()
    const errorNotice = confirmLayer().querySelector<HTMLElement>('[role="alert"]')
    expect(errorNotice, '确认层内 role=alert 错误提示').toBeTruthy()
    expect(errorNotice!.textContent ?? '').toContain('合成网络错误：标签删除请求失败')
    const recoveredCancel = buttonByExactText('取消', confirmLayer())
    expect(recoveredCancel.disabled).toBe(false)
    expect(document.activeElement).toBe(recoveredCancel)

    // f) 点击「取消」关闭确认层、焦点回该行「删除」按钮，且不重发 DELETE。
    recoveredCancel.click()
    await flushPromises()
    expect(document.querySelector('.manager__confirm')).toBeNull()
    expect(document.activeElement).toBe(rowDelete)
    expect(deleteCount()).toBe(1)

    // 成功路径（同 case 局部驱动）：重新确认删除并让 DELETE 2xx 落定后，
    // 服务端 GET /tags 少掉目标 Tag → 原触发行实际消失（isConnected=false），
    // 确认层关闭、焦点回 manager 内第一个 input（创建输入框）。
    rowDelete.focus()
    rowDelete.click()
    await flushPromises()
    const successButton = buttonByExactText('确认删除', confirmLayer())
    successButton.focus()
    successButton.click()
    await flushPromises()
    expect(deleteCount()).toBe(2)
    pendingDeletes[1].resolve(new Response(null, { status: 204 }))
    await flushPromises()
    expect(rowDelete.isConnected, '成功删除后原触发行「删除」按钮已从文档移除').toBe(false)
    expect(document.querySelector('.manager__confirm')).toBeNull()
    const firstInput = document.querySelector<HTMLElement>('.manager input')
    expect(firstInput, 'manager 内第一个 input').toBeTruthy()
    expect(document.activeElement).toBe(firstInput)
  })
})

// DT-R57 旧红测试：LibraryManageDrawer 行内编辑（目录/标签）的焦点停靠与 busy 合同。
// 目标合同：打开编辑后焦点落在编辑表单名称 input（aria-label 目录名称/标签名称）；行内
// 「取消」清编辑态并把焦点交还该行重建的「编辑」按钮，saving 期间禁用；「保存」在 saving
// 或名称 trim 后为空时禁用；名称 input 在 saving 期间 readonly，目录编辑的上级 select 在
// saving 期间禁用；saveEdit 在 saving 置位后仅当当前焦点已失效（如停在已禁用的「保存」上）
// 才停靠到名称 input，保存成功后也仅当焦点已失效才回焦该行当前「编辑」，用户已外移到
// Create 输入框等有效焦点时不抢占；顶层 keydown 的 IME guard 覆盖 event.isComposing 与
// event.keyCode === 229 两种形状，编辑中 Escape 不得关闭抽屉。
// 定位只用可见行名 + 该行「编辑」按钮，不依赖生产回焦用的 data-edit-trigger；目录种子带
// 一个前置同级目录，目标目录固定在第二行，用以区分「回该行」与「回首行」，并钉住旧按钮
// 已销毁不得复用。当前生产代码尚未实现行内编辑焦点/禁用管理，预期在未修复源码上红；
// 「在途焦点外移不抢」为现状回归锚点，预期绿。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'

import LibraryManageDrawer from './LibraryManageDrawer.vue'
import { type FolderEntry, type TagEntry, useLibraryStore } from './library'

const PRECEDING_FOLDER_NAME = '前置目录'
const FOLDER_NAME = '行内焦点目录'
const NEW_FOLDER_NAME = '行内焦点目录-新'
const TAG_NAME = '行内焦点标签'
const NEW_TAG_NAME = '行内焦点标签-新'
const CREATE_DRAFT = '待创建标签草稿'

// GET 端点必须读「活」种子：重命名成功后的 loadNavigation 会重新 GET，
// 应答需反映用例中途改写的新名。目标目录固定在第二行（前置同级目录在前）。
function seedFolders(): FolderEntry[] {
  return [
    { id: 'folder-0', parentId: null, name: PRECEDING_FOLDER_NAME, sortOrder: 1, itemCount: 0, children: [] },
    { id: 'folder-1', parentId: null, name: FOLDER_NAME, sortOrder: 2, itemCount: 3, children: [] },
  ]
}
let folderSeed: FolderEntry[] = seedFolders()
let tagSeed: TagEntry[] = [{ id: 'tag-1', name: TAG_NAME, itemCount: 2 }]

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

// PATCH /api/v1/folders/:id 与 /api/v1/tags/:id 一律挂起为手动 deferred，
// 由用例决定 settle 时机与结果；其余端点兜底合法 Response，避免 undefined/TypeError 造红。
function installFetchMock() {
  const calls: RecordedCall[] = []
  const pendingPatches: DeferredResponse[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url })
      if (url === '/api/v1/folders/tree') return Promise.resolve(jsonResponse({ items: folderSeed }))
      if (url === '/api/v1/tags' && method === 'GET') return Promise.resolve(jsonResponse({ items: tagSeed }))
      if (method === 'PATCH') {
        return new Promise<Response>((resolve, reject) => {
          pendingPatches.push({ resolve, reject })
        })
      }
      return Promise.resolve(jsonResponse({}))
    }),
  )
  return { calls, pendingPatches }
}

// 按钮按精确可访问文本匹配，避免「取消」误配「确认删除」等子串歧义。
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

// 键盘事件必须派发在真实 document.activeElement 上；jsdom 构造器若不认
// isComposing/keyCode init，则在实例上补设（仍为真实派发）。
function pressEscape(options: { isComposing?: boolean; keyCode?: number } = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  if (options.isComposing !== undefined && !event.isComposing) {
    Object.defineProperty(event, 'isComposing', { configurable: true, value: options.isComposing })
  }
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { configurable: true, value: options.keyCode })
  }
  focusedElement().dispatchEvent(event)
}

// v-model 文本输入走公开 DOM：赋 value 后派发冒泡 input 事件。
function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function editForm() {
  const form = document.querySelector<HTMLFormElement>('.edit-form')
  expect(form, '.edit-form').toBeTruthy()
  return form!
}

function editNameInput(label: '目录名称' | '标签名称') {
  const input = editForm().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  expect(input, `编辑表单名称 input（aria-label=${label}）`).toBeTruthy()
  return input!
}

// 以可见行名定位列表行，再取该行「编辑」：不依赖生产回焦用的 data-edit-trigger。
function entryRow(name: string) {
  const row = [...document.querySelectorAll<HTMLLIElement>('.entry-list li')].find(
    (li) => (li.querySelector('.entry-list__name strong')?.textContent ?? '').trim() === name,
  )
  expect(row, `entry row "${name}"`).toBeTruthy()
  return row!
}

function rowEditButton(name: string) {
  return buttonByExactText('编辑', entryRow(name))
}

describe('LibraryManageDrawer 行内编辑焦点与 busy 合同（DT-R57）', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    folderSeed = seedFolders()
    tagSeed = [{ id: 'tag-1', name: TAG_NAME, itemCount: 2 }]
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.innerHTML = ''
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

  it('目录编辑：打开初焦名称 input、IME 两种形状 Escape 不关抽屉、空白名禁存、取消回焦该行编辑按钮', async () => {
    installFetchMock()
    const library = await mountClosedDrawer()
    await openManager(library)

    const oldTrigger = rowEditButton(FOLDER_NAME)
    oldTrigger.click()
    await flushPromises()

    const form = editForm()
    const nameInput = editNameInput('目录名称')
    expect(document.activeElement, '打开目录编辑后焦点应落在名称 input').toBe(nameInput)

    // IME guard 两种形状：焦点保持在名称 input 上派发 Escape，均不得关闭 manager。
    nameInput.focus()
    pressEscape({ isComposing: true })
    await flushPromises()
    expect(document.querySelector('.manager'), '合成中的 Escape 不得关闭抽屉').toBeTruthy()

    nameInput.focus()
    pressEscape({ keyCode: 229 })
    await flushPromises()
    expect(document.querySelector('.manager'), 'keyCode=229 的 Escape 不得关闭抽屉').toBeTruthy()

    // 仅空白字符能通过 HTML required，须按 trim 合同禁用「保存」，避免按钮可点而 saveEdit 早退。
    setInputValue(nameInput, '   ')
    await flushPromises()
    expect(buttonByExactText('保存', form).disabled, '空白名「保存」应禁用').toBe(true)

    // 恢复草稿名后「取消」清编辑态并回焦该行（第二行）重建的「编辑」，不得回首行或复用旧按钮。
    setInputValue(nameInput, FOLDER_NAME)
    buttonByExactText('取消', form).click()
    await flushPromises()

    const trigger = rowEditButton(FOLDER_NAME)
    expect(trigger.disabled).toBe(false)
    expect(document.activeElement, '取消后焦点应回到该行当前「编辑」按钮').toBe(trigger)
    expect(trigger).not.toBe(rowEditButton(PRECEDING_FOLDER_NAME))
    expect(oldTrigger.isConnected, '旧「编辑」按钮已随编辑态销毁').toBe(false)
    expect(document.activeElement).not.toBe(oldTrigger)
    expect(document.querySelector('.manager'), '取消不得关闭抽屉').toBeTruthy()
  })

  it('标签编辑：打开初焦名称 input、取消回焦该行编辑按钮', async () => {
    installFetchMock()
    const library = await mountClosedDrawer()
    await openManager(library)

    buttonByExactText('标签').click()
    await flushPromises()

    const oldTrigger = rowEditButton(TAG_NAME)
    oldTrigger.click()
    await flushPromises()

    const form = editForm()
    const nameInput = editNameInput('标签名称')
    expect(document.activeElement, '打开标签编辑后焦点应落在名称 input').toBe(nameInput)

    buttonByExactText('取消', form).click()
    await flushPromises()

    const trigger = rowEditButton(TAG_NAME)
    expect(trigger.disabled).toBe(false)
    expect(document.activeElement, '取消后焦点应回到该行当前「编辑」按钮').toBe(trigger)
    expect(oldTrigger.isConnected, '旧「编辑」按钮已随编辑态销毁').toBe(false)
    expect(document.querySelector('.manager'), '取消不得关闭抽屉').toBeTruthy()
  })

  it('目录保存：从聚焦的「保存」提交后 PATCH 在途焦点停靠 readonly 名称 input、取消与上级 select 禁用；失败恢复字段与按钮；重试成功后行内刷新并回焦该行编辑按钮', async () => {
    const { calls, pendingPatches } = installFetchMock()
    const library = await mountClosedDrawer()
    await openManager(library)

    const oldTrigger = rowEditButton(FOLDER_NAME)
    oldTrigger.click()
    await flushPromises()

    const form = editForm()
    const nameInput = editNameInput('目录名称')
    const parentSelect = form.querySelector<HTMLSelectElement>('select[aria-label="上级目录"]')
    expect(parentSelect, '上级目录 select').toBeTruthy()
    setInputValue(nameInput, NEW_FOLDER_NAME)

    // 从真实聚焦的「保存」提交：提交前它是 activeElement，在途被禁用后焦点才停靠到名称 input。
    const saveButton = buttonByExactText('保存', form)
    saveButton.focus()
    expect(document.activeElement).toBe(saveButton)
    saveButton.click()
    await flushPromises()

    const patchCount = () => calls.filter((call) => call.method === 'PATCH').length
    expect(patchCount(), 'PATCH 已发出并在途').toBe(1)
    expect(document.activeElement, '在途焦点应停靠到名称 input').toBe(nameInput)
    expect(nameInput.readOnly, '在途名称 input 应 readonly').toBe(true)
    expect(parentSelect!.disabled, '在途上级 select 应禁用').toBe(true)
    expect(buttonByExactText('取消', form).disabled, '在途行内「取消」应禁用').toBe(true)

    // 失败：原始错误文本进入 role=alert；字段与按钮全部恢复可编辑/可用，草稿保留以便修正。
    pendingPatches[0].reject(new Error('合成网络错误：目录重命名请求失败'))
    await flushPromises()
    expect(buttonByExactText('保存', form).disabled).toBe(false)
    expect(buttonByExactText('取消', form).disabled).toBe(false)
    expect(nameInput.readOnly, '失败后名称 input 应可编辑').toBe(false)
    expect(parentSelect!.disabled, '失败后上级 select 应可用').toBe(false)
    expect(nameInput.value, '失败后草稿名保留').toBe(NEW_FOLDER_NAME)
    const alert = document.querySelector<HTMLElement>('.manager__error[role="alert"]')
    expect(alert, 'role=alert 错误提示').toBeTruthy()
    expect(alert!.textContent ?? '').toContain('合成网络错误：目录重命名请求失败')

    // 重试同样从聚焦的「保存」提交；成功后服务端（活种子）已改名，行文本刷新、编辑态退出，
    // 焦点回该行（第二行）当前「编辑」，不得回首行或复用旧按钮。
    const retryButton = buttonByExactText('保存', form)
    retryButton.focus()
    expect(document.activeElement).toBe(retryButton)
    retryButton.click()
    await flushPromises()
    expect(patchCount(), '重试发出第二个 PATCH').toBe(2)
    expect(document.activeElement, '重试在途焦点应停靠到名称 input').toBe(nameInput)

    folderSeed = folderSeed.map((folder) =>
      folder.id === 'folder-1' ? { ...folder, name: NEW_FOLDER_NAME } : folder,
    )
    pendingPatches[1].resolve(jsonResponse({ id: 'folder-1', name: NEW_FOLDER_NAME }))
    await flushPromises()

    const rowText = document.querySelector('.entry-list')?.textContent ?? ''
    expect(rowText, '成功后行文本包含新目录名').toContain(NEW_FOLDER_NAME)
    expect(document.querySelector('.edit-form'), '成功后编辑表单退出').toBeNull()

    const trigger = rowEditButton(NEW_FOLDER_NAME)
    expect(trigger.disabled).toBe(false)
    expect(document.activeElement, '成功后焦点回到该行当前「编辑」按钮').toBe(trigger)
    expect(trigger).not.toBe(rowEditButton(PRECEDING_FOLDER_NAME))
    expect(oldTrigger.isConnected, '旧「编辑」按钮已随编辑态销毁').toBe(false)
    expect(document.activeElement).not.toBe(oldTrigger)
    expect(patchCount(), '全程 PATCH 计数').toBe(2)
  })

  it('标签保存在途焦点外移：成功后不抢占 Create 输入框焦点，草稿保留，不发创建请求', async () => {
    const { calls, pendingPatches } = installFetchMock()
    const library = await mountClosedDrawer()
    await openManager(library)

    buttonByExactText('标签').click()
    await flushPromises()

    rowEditButton(TAG_NAME).click()
    await flushPromises()

    const form = editForm()
    const nameInput = editNameInput('标签名称')
    setInputValue(nameInput, NEW_TAG_NAME)
    buttonByExactText('保存', form).click()
    await flushPromises()
    expect(calls.filter((call) => call.method === 'PATCH').length, '标签 PATCH 已发出并在途').toBe(1)

    // 在途把焦点移到外层 Create 输入框并键入另一份草稿（公开 DOM 交互）。
    const createInput = document.querySelector<HTMLInputElement>('.create-form input')
    expect(createInput, 'Create 输入框').toBeTruthy()
    createInput!.focus()
    setInputValue(createInput!, CREATE_DRAFT)

    tagSeed = tagSeed.map((tag) => (tag.id === 'tag-1' ? { ...tag, name: NEW_TAG_NAME } : tag))
    pendingPatches[0].resolve(jsonResponse({ id: 'tag-1', name: NEW_TAG_NAME }))
    await flushPromises()

    expect(document.activeElement, '成功后不得抢占 Create 输入框焦点').toBe(createInput)
    expect(createInput!.value, 'Create 草稿保留').toBe(CREATE_DRAFT)
    const rowText = document.querySelector('.entry-list')?.textContent ?? ''
    expect(rowText, '成功后行文本包含新标签名').toContain(NEW_TAG_NAME)
    expect(
      calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/tags').length,
      '不得发出创建标签请求',
    ).toBe(0)
  })
})

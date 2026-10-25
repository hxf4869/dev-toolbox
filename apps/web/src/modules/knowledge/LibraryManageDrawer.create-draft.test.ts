// DT-R60 合同测试：LibraryManageDrawer Create 表单的在途草稿、快照提交与焦点合同。
// Create 名称输入在创建请求（POST）在途期间保持可编辑（不 readonly、不 disabled）；
// createEntry 在同步段快照提交时的 name/parent 发请求；成功后仅当当前 name 与 parent 仍等于
// 提交快照时才清空 name，任一已变化则保留用户在途键入的下一份草稿（精确值，含首尾空白），
// parent 按原合同不重置；成功后不得自动提交下一份草稿；saving 置位后仅当当前焦点已失效
// （如停在已被禁用的「创建」按钮上）才把焦点停靠到 .create-form input，用户已持有的有效
// 焦点不得被抢占。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'

import LibraryManageDrawer from './LibraryManageDrawer.vue'
import { type FolderEntry, type TagEntry, useLibraryStore } from './library'

const PRECEDING_FOLDER_NAME = '前置目录'
const PRECEDING_TAG_NAME = '前置标签'
const FOLDER_DRAFT_A = '草稿目录-A'
const FOLDER_DRAFT_B = '  草稿目录-B  '
const TAG_DRAFT_A = '草稿标签-A'

// GET 端点必须读「活」种子：创建成功后的 loadNavigation 会重新 GET，
// 应答需反映用例中途推进的新目录/新标签，才能证明行内刷新来自 freshGET。
function seedFolders(): FolderEntry[] {
  return [
    { id: 'folder-0', parentId: null, name: PRECEDING_FOLDER_NAME, sortOrder: 1, itemCount: 0, children: [] },
  ]
}
function seedTags(): TagEntry[] {
  return [{ id: 'tag-0', name: PRECEDING_TAG_NAME, itemCount: 0 }]
}
let folderSeed: FolderEntry[] = seedFolders()
let tagSeed: TagEntry[] = seedTags()

interface RecordedCall {
  method: string
  path: string
  body?: unknown
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

// 只有创建类 POST（/api/v1/folders、/api/v1/tags）挂起为手动 deferred，由用例决定 settle
// 时机与结果；其余端点兜底合法 Response，避免 undefined/TypeError 造红。每次调用都记录
// { method, path, body }（body 对带 JSON 正文的请求做 JSON.parse），用例据此断言快照 payload。
function installFetchMock() {
  const calls: RecordedCall[] = []
  const pendingPosts: DeferredResponse[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      calls.push({
        method,
        path: url,
        ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
      })
      if (url === '/api/v1/folders/tree') return Promise.resolve(jsonResponse({ items: folderSeed }))
      if (url === '/api/v1/tags' && method === 'GET') return Promise.resolve(jsonResponse({ items: tagSeed }))
      if (method === 'POST' && (url === '/api/v1/folders' || url === '/api/v1/tags')) {
        return new Promise<Response>((resolve, reject) => {
          pendingPosts.push({ resolve, reject })
        })
      }
      return Promise.resolve(jsonResponse({}))
    }),
  )
  return { calls, pendingPosts }
}

// 按钮按精确可访问文本匹配，避免子串歧义；「创建」按钮内仅图标 svg 与文本，trim 后为「创建」。
function buttonByExactText(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll('button')].find(
    (entry) => (entry.textContent ?? '').trim() === text,
  )
  expect(button, `button with exact text "${text}"`).toBeTruthy()
  return button as HTMLButtonElement
}

// v-model 文本输入走公开 DOM：赋 value 后派发冒泡 input 事件。
function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('LibraryManageDrawer Create 在途草稿与焦点合同（DT-R60）', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    folderSeed = seedFolders()
    tagSeed = seedTags()
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

  it('目录创建：在途可编辑、快照 payload 精确，成功后保留在途键入的下一份草稿且不自动提交、不抢焦点', async () => {
    const { calls, pendingPosts } = installFetchMock()
    const library = await mountClosedDrawer()
    await openManager(library)

    const createInput = document.querySelector<HTMLInputElement>('.create-form input')
    expect(createInput, 'Create 名称输入').toBeTruthy()
    setInputValue(createInput!, FOLDER_DRAFT_A)
    // 等渲染刷新把初始（空名）禁用的「创建」按钮恢复可用：jsdom 的 click 读取当前 DOM disabled。
    await flushPromises()

    buttonByExactText('创建').click()
    await flushPromises()

    // 在途断言：首份 POST 按同步段快照（A、根目录）发出并挂起；输入保持可编辑。
    const postCalls = () => calls.filter((call) => call.method === 'POST')
    expect(postCalls(), '目录创建 POST 已发出并在途').toHaveLength(1)
    expect(postCalls()[0]!.path).toBe('/api/v1/folders')
    expect(postCalls()[0]!.body).toEqual({ name: FOLDER_DRAFT_A, parentId: null })
    const createButton = buttonByExactText('创建')
    expect(createButton.disabled, '在途「创建」按钮应禁用').toBe(true)
    expect(createInput!.readOnly, '在途名称输入不得 readonly').toBe(false)
    expect(createInput!.disabled, '在途名称输入不得 disabled').toBe(false)

    // 在途公开交互：聚焦名称输入改写为下一份草稿 B，并把上级目录切到 folder-0。
    createInput!.focus()
    setInputValue(createInput!, FOLDER_DRAFT_B)
    const parentSelect = document.querySelector<HTMLSelectElement>('.create-form select')
    expect(parentSelect, '上级目录 select').toBeTruthy()
    parentSelect!.value = 'folder-0'
    parentSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(createInput!.value, '在途草稿 B 精确保留在输入框').toBe(FOLDER_DRAFT_B)
    expect(parentSelect!.value).toBe('folder-0')
    expect(document.activeElement, '用户已聚焦名称输入不得被抢').toBe(createInput)

    // 成功：把 A 推进活种子后放行 POST，成功后的 freshGET 才真含 A。
    folderSeed = [
      ...folderSeed,
      { id: 'folder-new', parentId: null, name: FOLDER_DRAFT_A, sortOrder: 2, itemCount: 0, children: [] },
    ]
    pendingPosts[0]!.resolve(jsonResponse({ id: 'folder-new', name: FOLDER_DRAFT_A, parentId: null }))
    await flushPromises()

    const rowText = document.querySelector('.entry-list')?.textContent ?? ''
    expect(rowText, '成功后行文本包含新目录名 A').toContain(FOLDER_DRAFT_A)
    expect(postCalls(), '不得自动提交下一份草稿').toHaveLength(1)
    expect(postCalls()[0]!.body, '首份 POST payload 保持快照 A/根目录').toEqual({
      name: FOLDER_DRAFT_A,
      parentId: null,
    })
    // B 含首尾空白：草稿已偏离提交快照，成功后须按精确值保留，不得 trim 或清空。
    expect(createInput!.value, '成功后应保留在途键入的下一份草稿 B（精确值）').toBe(FOLDER_DRAFT_B)
    expect(parentSelect!.value, 'parent 按原合同不重置').toBe('folder-0')
    expect(document.activeElement, '成功后焦点仍在名称输入').toBe(createInput)
    expect(buttonByExactText('创建').disabled, '草稿 B 非空且 saving 结束后「创建」应可用').toBe(false)
  })

  it('标签创建：从聚焦的「创建」提交后在途焦点停靠名称输入，成功后清空未变化草稿且不重复提交', async () => {
    const { calls, pendingPosts } = installFetchMock()
    const library = await mountClosedDrawer()
    await openManager(library)

    buttonByExactText('标签').click()
    await flushPromises()

    const createInput = document.querySelector<HTMLInputElement>('.create-form input')
    expect(createInput, 'Create 名称输入').toBeTruthy()
    setInputValue(createInput!, TAG_DRAFT_A)
    // 同上：等待禁用态从 DOM 移除后再聚焦/提交，jsdom 的 focus/click 都会检查 disabled。
    await flushPromises()

    const createButton = buttonByExactText('创建')
    createButton.focus()
    expect(document.activeElement, '提交前焦点在「创建」按钮').toBe(createButton)
    createButton.click()
    await flushPromises()

    // 在途断言：首份 POST 按快照发出并挂起；输入保持可编辑且草稿 A 未被动过。
    const postCalls = () => calls.filter((call) => call.method === 'POST')
    expect(postCalls(), '标签创建 POST 已发出并在途').toHaveLength(1)
    expect(postCalls()[0]!.path).toBe('/api/v1/tags')
    expect(postCalls()[0]!.body).toEqual({ name: TAG_DRAFT_A })
    expect(createButton.disabled, '在途「创建」按钮应禁用').toBe(true)
    expect(createInput!.readOnly, '在途名称输入不得 readonly').toBe(false)
    expect(createInput!.disabled, '在途名称输入不得 disabled').toBe(false)
    expect(createInput!.value, '用户未改动时草稿 A 保留').toBe(TAG_DRAFT_A)
    // 提交后「创建」被禁用使原焦点失效，此时应停靠到仍可编辑的名称输入。
    expect(document.activeElement, '在途焦点应从已禁用的「创建」停靠到名称输入').toBe(createInput)

    // 成功：把 A 推进活种子后放行 POST。
    tagSeed = [...tagSeed, { id: 'tag-new', name: TAG_DRAFT_A, itemCount: 0 }]
    pendingPosts[0]!.resolve(jsonResponse({ id: 'tag-new', name: TAG_DRAFT_A }))
    await flushPromises()

    const rowText = document.querySelector('.entry-list')?.textContent ?? ''
    expect(rowText, '成功后行文本包含新标签名 A').toContain(TAG_DRAFT_A)
    expect(createInput!.value, '草稿未变化时按原合同清空').toBe('')
    expect(document.activeElement, '成功后焦点保持在名称输入不丢失').toBe(createInput)
    expect(buttonByExactText('创建').disabled, '名称已空后「创建」应禁用').toBe(true)
    expect(postCalls(), '全程不得重复提交').toHaveLength(1)
  })
})

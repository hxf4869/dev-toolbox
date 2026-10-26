// DT-R289 集成回归：KnowledgeModuleNav（含 LibraryManageDrawer）在导航读取失败后的恢复
// 合同。共享 navigationError 驱动：初始读取失败不显示假「尚无目录/标签」或无提示旧缓存
// 链接；「重新读取目录与标签」只发读取 GET，成功后恢复正常列表或真实空态，迟到旧错不
// 复活。已确认写入后的读取失败在 Drawer 内准确提示「更改已保存…」并按原成功规则清匹配
// 草稿/收束编辑与删除；rename→move 两步中 rename 成功读失败后 move 真正失败时，草稿与
// 错误保留，只读恢复不得重放写入。只走公开 DOM 与真实 Pinia store，仅伪造外部 HTTP；
// 每例检查焦点与写请求数。未修复源码上各例的「错误语义/重试/草稿保留」断言红。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import KnowledgeModuleNav from './KnowledgeModuleNav.vue'
import { type FolderEntry, type TagEntry } from './library'

const MUTATION_REFRESH_MESSAGE = '更改已保存，但目录与标签未能刷新。请重新读取列表。'
const READ_FAIL_MESSAGE = '读取失败：目录与标签暂不可用'
const MOVE_FAIL_MESSAGE = '移动失败：目标暂不可用'

interface RecordedCall {
  method: string
  path: string
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function failed(message: string): Response {
  return jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message } }, 503)
}

function folder(id: string, name: string): FolderEntry {
  return { id, parentId: null, name, sortOrder: 1, itemCount: 0, children: [] }
}

function tag(id: string, name: string): TagEntry {
  return { id, name, itemCount: 0 }
}

// 用例在 handler 闭包里翻转读/写结果与「活」种子（像真实服务端应用写入后的 fresh GET）；
// 导航 GET 可经门闸返回挂起的 Promise，供「重试在途」段显式放行。
function installFetch(handler: (method: string, path: string) => Response | Promise<Response>) {
  const calls: RecordedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url })
      return Promise.resolve(handler(method, url))
    }),
  )
  return { calls }
}

// 挂起导航 GET 的门闸：重试「在途」段由用例显式放行；放行时按当时快照构造 fresh 应答。
function createNavigationGate(snapshot: () => { tree: Response; tags: Response }) {
  let holding = false
  const pending: Array<{ kind: 'tree' | 'tags'; resolve: (response: Response) => void }> = []
  return {
    enter(kind: 'tree' | 'tags'): Response | Promise<Response> {
      if (!holding) {
        const current = snapshot()
        return kind === 'tree' ? current.tree : current.tags
      }
      return new Promise<Response>((resolve) => pending.push({ kind, resolve }))
    },
    hold() {
      holding = true
    },
    release() {
      holding = false
      const current = snapshot()
      for (const { kind, resolve } of pending.splice(0)) {
        resolve(kind === 'tree' ? current.tree : current.tags)
      }
    },
  }
}

function writeCalls(calls: RecordedCall[]) {
  return calls.filter((call) => call.method !== 'GET')
}

function buttonByExactText(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll('button')].find(
    (entry) => (entry.textContent ?? '').trim() === text,
  )
  expect(button, `button with exact text "${text}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function entryRow(name: string) {
  const row = [...document.querySelectorAll<HTMLLIElement>('.entry-list li')].find(
    (li) => (li.querySelector('.entry-list__name strong')?.textContent ?? '').trim() === name,
  )
  expect(row, `entry row "${name}"`).toBeTruthy()
  return row!
}

function drawerRoot() {
  const manager = document.querySelector<HTMLElement>('.manager')
  expect(manager, '.manager dialog').toBeTruthy()
  return manager!
}

async function openManager() {
  buttonByExactText('管理资料库结构').click()
  await flushPromises()
  drawerRoot()
}

describe('KnowledgeModuleNav 导航读取失败的共享恢复（DT-R289）', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  async function mountNav() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ name: 'workspace', path: '/', component: { template: '<div />' } }],
    })
    router.push('/')
    await router.isReady()
    wrapper = mount(KnowledgeModuleNav, { attachTo: document.body, global: { plugins: [router] } })
    await flushPromises()
  }

  it('初始读取失败：无假空态与旧缓存链接；只读重试在途不复活旧缓存且焦点有效，放行后恢复真实列表', async () => {
    let readOk = false
    const gate = createNavigationGate(() => ({
      tree: jsonResponse({ items: [folder('folder-1', '合成目录')] }),
      tags: jsonResponse({ items: [tag('tag-1', '合成标签')] }),
    }))
    const { calls } = installFetch((method, path) => {
      if (method === 'GET' && path === '/api/v1/folders/tree') {
        return readOk ? gate.enter('tree') : failed(READ_FAIL_MESSAGE)
      }
      if (method === 'GET' && path === '/api/v1/tags') {
        return readOk ? gate.enter('tags') : failed(READ_FAIL_MESSAGE)
      }
      return jsonResponse({})
    })
    await mountNav()

    const errorBlock = document.querySelector<HTMLElement>('.knowledge-nav__error')
    expect(errorBlock, 'Nav 共享读取错误块').toBeTruthy()
    expect(errorBlock!.textContent).toContain(READ_FAIL_MESSAGE)
    expect(document.body.textContent).not.toContain('尚无目录')
    expect(document.body.textContent).not.toContain('尚无标签')
    expect(document.querySelector('a[href*="folderId"]'), '不得显示无提示的旧缓存目录链接').toBeNull()
    expect(document.querySelector('a[href*="tagId"]'), '不得显示无提示的旧缓存标签链接').toBeNull()
    expect(document.body.textContent).toContain('原始收件箱')
    expect(buttonByExactText('管理资料库结构')).toBeTruthy()
    const retry = buttonByExactText('重新读取目录与标签')
    expect(document.activeElement, 'Nav 挂载与失败提示不得抢焦点').toBe(document.body)

    // 只读重试「在途」段：重试 GET 挂起，从真实聚焦的重试按钮发起。
    readOk = true
    gate.hold()
    retry.focus()
    retry.click()
    await flushPromises()

    expect(document.querySelector('a[href*="folderId"]'), '读取在途不得复活旧缓存目录链接').toBeNull()
    expect(document.querySelector('a[href*="tagId"]'), '读取在途不得复活旧缓存标签链接').toBeNull()
    expect(document.body.textContent).not.toContain('尚无目录')
    expect(document.body.textContent).not.toContain('尚无标签')
    const status = document.querySelector<HTMLElement>('.knowledge-nav__status')
    expect(status, '读取在途应有读取提示').toBeTruthy()
    expect(status!.getAttribute('role'), '读取提示应为 status 语义').toBe('status')
    expect(document.activeElement, '重试按钮卸载后焦点不得留在 body').not.toBe(document.body)

    gate.release()
    await flushPromises()

    expect(writeCalls(calls), '全程零写请求').toHaveLength(0)
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(4)
    expect(document.querySelector('.knowledge-nav__error')).toBeNull()
    expect(document.querySelector('a[href*="folderId"]')?.textContent).toContain('合成目录')
    expect(document.querySelector('a[href*="tagId"]')?.textContent).toContain('合成标签')
    expect(document.activeElement, '完成后保持已停靠的有效焦点').toBe(
      buttonByExactText('管理资料库结构'),
    )
  })

  it('目录创建已确认后读取失败：准确提示并清匹配草稿；重试在途草稿可编辑，放行后恢复且不重放写入', async () => {
    let folders: FolderEntry[] = [folder('folder-0', '已有目录')]
    let readOk = true
    const gate = createNavigationGate(() => ({
      tree: jsonResponse({ items: folders }),
      tags: jsonResponse({ items: [] as TagEntry[] }),
    }))
    const { calls } = installFetch((method, path) => {
      if (method === 'GET' && path === '/api/v1/folders/tree') {
        return readOk ? gate.enter('tree') : failed(READ_FAIL_MESSAGE)
      }
      if (method === 'GET' && path === '/api/v1/tags') {
        return readOk ? gate.enter('tags') : jsonResponse({ items: [] as TagEntry[] })
      }
      if (method === 'POST' && path === '/api/v1/folders') {
        folders = [...folders, folder('folder-new', '新目录甲')]
        readOk = false
        return jsonResponse({ id: 'folder-new' }, 201)
      }
      return jsonResponse({})
    })
    await mountNav()
    await openManager()

    const createInput = document.querySelector<HTMLInputElement>('.create-form input')
    expect(createInput, 'Create 名称输入').toBeTruthy()
    setInputValue(createInput!, '新目录甲')
    await flushPromises()
    buttonByExactText('创建').click()
    await flushPromises()

    const drawerError = document.querySelector<HTMLElement>('.manager__nav-error')
    expect(drawerError, 'Drawer 内共享读取错误块').toBeTruthy()
    expect(drawerError!.textContent).toContain(MUTATION_REFRESH_MESSAGE)
    expect(createInput!.value, '已确认创建按原成功规则清匹配草稿').toBe('')
    expect(buttonByExactText('创建').disabled, '列表未知时创建提交禁用').toBe(true)
    expect(document.querySelector('.entry-list'), '列表未知不得显示旧行').toBeNull()
    expect(document.querySelector('.manager__empty'), '列表未知不得显示假空态').toBeNull()
    expect(document.activeElement, '有效焦点保持在创建输入').toBe(createInput)
    expect(document.querySelector('.knowledge-nav__error'), 'Nav 同步显示共享错误').toBeTruthy()
    expect(document.querySelector('a[href*="folderId"]')).toBeNull()
    expect(writeCalls(calls)).toHaveLength(1)

    // 只读重试「在途」段：重试 GET 挂起，从真实聚焦的重试按钮发起；旧行/假空态不复活，
    // 创建字段保持可编辑并接受在途键入的精确新草稿 B，焦点停靠有效输入且不在 body。
    readOk = true
    gate.hold()
    const drawerRetry = buttonByExactText('重新读取目录与标签', drawerRoot())
    drawerRetry.focus()
    drawerRetry.click()
    await flushPromises()

    expect(document.querySelector('.entry-list'), '读取在途不得复活旧行').toBeNull()
    expect(document.querySelector('.manager__empty'), '读取在途不得出现假空态').toBeNull()
    expect(document.querySelector('a[href*="folderId"]'), '读取在途 Nav 旧缓存链接不可用').toBeNull()
    const status = document.querySelector<HTMLElement>('.manager [role="status"]')
    expect(status, 'Drawer 读取在途提示应为 status 语义').toBeTruthy()
    expect(status!.textContent).toContain('正在读取目录与标签…')
    expect(buttonByExactText('创建').disabled, '列表未知（含读取在途）创建提交仍禁用').toBe(true)
    expect(createInput!.readOnly, '读取在途名称输入保持可编辑').toBe(false)
    expect(createInput!.disabled, '读取在途名称输入不得禁用').toBe(false)
    setInputValue(createInput!, '  新草稿乙  ')
    expect(createInput!.value, '在途可继续键入精确草稿 B').toBe('  新草稿乙  ')
    expect(document.activeElement, '重试按钮卸载后焦点停靠创建输入').toBe(createInput)

    gate.release()
    await flushPromises()

    expect(writeCalls(calls), '重试只读，无新增写请求').toHaveLength(1)
    const rowText = document.querySelector('.entry-list')?.textContent ?? ''
    expect(rowText).toContain('新目录甲')
    expect(document.querySelector('.manager__nav-error')).toBeNull()
    expect(createInput!.value, '在途键入的 B 草稿精确保留').toBe('  新草稿乙  ')
    expect(document.activeElement, '完成后不强行抢到其他字段').toBe(createInput)
  })

  it('目录编辑已确认后读取失败：慢读取在途焦点停靠抽屉内，放行后按原规则收束并只读恢复', async () => {
    let folders: FolderEntry[] = [folder('folder-1', '原名目录')]
    let patchConfirmed = false
    let releaseAsFailure = true
    const gate = createNavigationGate(() => ({
      tree: releaseAsFailure ? failed(READ_FAIL_MESSAGE) : jsonResponse({ items: folders }),
      tags: releaseAsFailure ? failed(READ_FAIL_MESSAGE) : jsonResponse({ items: [] as TagEntry[] }),
    }))
    const { calls } = installFetch((method, path) => {
      if (method === 'GET' && path === '/api/v1/folders/tree') {
        return patchConfirmed ? gate.enter('tree') : jsonResponse({ items: folders })
      }
      if (method === 'GET' && path === '/api/v1/tags') {
        return patchConfirmed ? gate.enter('tags') : jsonResponse({ items: [] as TagEntry[] })
      }
      if (method === 'PATCH' && path === '/api/v1/folders/folder-1') {
        folders = folders.map((entry) => (entry.id === 'folder-1' ? { ...entry, name: '新名目录' } : entry))
        patchConfirmed = true
        return jsonResponse({ id: 'folder-1' })
      }
      return jsonResponse({})
    })
    await mountNav()
    await openManager()

    buttonByExactText('编辑', entryRow('原名目录')).click()
    await flushPromises()
    const nameInput = document.querySelector<HTMLInputElement>('.edit-form input[aria-label="目录名称"]')
    expect(nameInput, '编辑名称输入').toBeTruthy()
    setInputValue(nameInput!, '新名目录')

    // PATCH 已确认后的目录刷新是慢读取：挂起两个 GET，验证「在途」窗口的撤下与焦点。
    gate.hold()
    buttonByExactText('保存', document.querySelector('.edit-form')!).click()
    await flushPromises()

    expect(writeCalls(calls)).toHaveLength(1)
    expect(document.querySelector('.edit-form'), '读取在途编辑表单已撤下').toBeNull()
    expect(document.querySelector('.entry-list'), '读取在途不得复活旧行').toBeNull()
    expect(
      document.querySelector('.manager [role="status"]')?.textContent,
      '读取在途应有 status 语义提示',
    ).toContain('正在读取目录与标签…')
    const managerElement = drawerRoot()
    const active = document.activeElement as HTMLElement | null
    expect(active, '读取在途焦点不得落在 body').not.toBe(document.body)
    expect(managerElement.contains(active!), '读取在途焦点仍在 manager 内').toBe(true)
    expect(active!.isConnected, '读取在途焦点有效（已连接）').toBe(true)
    expect(active!.matches(':disabled'), '读取在途焦点不得停在禁用控件').toBe(false)

    // 放行为 503：读取失败按共享错误呈现，编辑按原规则收束，焦点转到有效重试按钮。
    gate.release()
    await flushPromises()

    expect(document.querySelector('.edit-form'), '已确认编辑按原规则收束').toBeNull()
    expect(document.querySelector('.manager__error'), '写入成功不得出现写错误').toBeNull()
    expect(document.querySelector('.manager__nav-error')?.textContent).toContain(MUTATION_REFRESH_MESSAGE)
    expect(document.querySelector('.entry-list')).toBeNull()
    const retry = buttonByExactText('重新读取目录与标签', drawerRoot())
    expect(document.activeElement, '行撤下后焦点落到抽屉内有效重试按钮').toBe(retry)
    expect(writeCalls(calls)).toHaveLength(1)

    releaseAsFailure = false
    retry.click()
    await flushPromises()

    const rowText = document.querySelector('.entry-list')?.textContent ?? ''
    expect(rowText).toContain('新名目录')
    expect(document.querySelector('.manager__nav-error')).toBeNull()
    expect(writeCalls(calls), '重试只读').toHaveLength(1)
    expect(document.activeElement, '重试按钮卸载后回焦抽屉内有效输入').toBe(
      document.querySelector('.manager input'),
    )
  })

  it('标签删除已确认后读取失败：确认层关闭、行撤下；只读恢复后显示真实空态且无多余写请求', async () => {
    let tags: TagEntry[] = [tag('tag-1', '合成标签')]
    let readOk = true
    const { calls } = installFetch((method, path) => {
      if (method === 'GET' && path === '/api/v1/folders/tree') {
        return readOk ? jsonResponse({ items: [] }) : failed(READ_FAIL_MESSAGE)
      }
      if (method === 'GET' && path === '/api/v1/tags') {
        return readOk ? jsonResponse({ items: tags }) : failed(READ_FAIL_MESSAGE)
      }
      if (method === 'DELETE' && path === '/api/v1/tags/tag-1') {
        tags = []
        readOk = false
        return new Response(null, { status: 204 })
      }
      return jsonResponse({})
    })
    await mountNav()
    await openManager()

    buttonByExactText('标签').click()
    await flushPromises()
    const rowDelete = buttonByExactText('删除')
    rowDelete.focus()
    rowDelete.click()
    await flushPromises()
    const confirmDeleteButton = buttonByExactText('确认删除', document.querySelector('.manager__confirm')!)
    confirmDeleteButton.focus()
    confirmDeleteButton.click()
    await flushPromises()

    expect(document.querySelector('.manager__confirm'), '已确认删除按原规则关闭确认层').toBeNull()
    expect(document.querySelector('.manager__nav-error')?.textContent).toContain(MUTATION_REFRESH_MESSAGE)
    expect(document.querySelector('.entry-list')).toBeNull()
    const createInput = document.querySelector<HTMLInputElement>('.create-form input')
    expect(document.activeElement, '删除成功后的创建输入焦点不被读取失败抢走').toBe(createInput)
    expect(writeCalls(calls)).toHaveLength(1)

    readOk = true
    buttonByExactText('重新读取目录与标签', drawerRoot()).click()
    await flushPromises()

    expect(writeCalls(calls), '重试只读，无新增写请求').toHaveLength(1)
    expect(document.querySelector('.manager__nav-error')).toBeNull()
    expect(document.querySelector('.manager__empty')?.textContent).toContain('尚未创建标签')
    expect(document.body.textContent).toContain('尚无标签')
  })

  it('rename 成功读失败后 move 真正失败：草稿与写错误保留，只读恢复不重放写入并回焦编辑表单', async () => {
    let folders: FolderEntry[] = [folder('folder-a', '目录甲'), folder('folder-b', '目录乙')]
    let readOk = true
    const { calls } = installFetch((method, path) => {
      if (method === 'GET' && path === '/api/v1/folders/tree') {
        return readOk ? jsonResponse({ items: folders }) : failed(READ_FAIL_MESSAGE)
      }
      if (method === 'GET' && path === '/api/v1/tags') return jsonResponse({ items: [] })
      if (method === 'PATCH' && path === '/api/v1/folders/folder-a') {
        folders = folders.map((entry) => (entry.id === 'folder-a' ? { ...entry, name: '目录甲改' } : entry))
        readOk = false
        return jsonResponse({ id: 'folder-a' })
      }
      if (method === 'POST' && path === '/api/v1/folders/folder-a/move') {
        return failed(MOVE_FAIL_MESSAGE)
      }
      return jsonResponse({})
    })
    await mountNav()
    await openManager()

    buttonByExactText('编辑', entryRow('目录甲')).click()
    await flushPromises()
    const nameInput = document.querySelector<HTMLInputElement>('.edit-form input[aria-label="目录名称"]')
    const parentSelect = document.querySelector<HTMLSelectElement>('.edit-form select[aria-label="上级目录"]')
    expect(nameInput, '编辑名称输入').toBeTruthy()
    expect(parentSelect, '编辑上级 select').toBeTruthy()
    setInputValue(nameInput!, '目录甲改')
    setSelectValue(parentSelect!, 'folder-b')
    buttonByExactText('保存', document.querySelector('.edit-form')!).click()
    await flushPromises()

    // rename 已确认（PATCH 2xx）但其后读取失败，move 仍执行且真正失败：
    // 名称/上级草稿与该写错误保留在组件状态中，行/表单撤下，焦点停靠重试按钮。
    const writes = writeCalls(calls)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ method: 'PATCH', path: '/api/v1/folders/folder-a' })
    expect(writes[1]).toMatchObject({ method: 'POST', path: '/api/v1/folders/folder-a/move' })
    expect(document.querySelector('.manager__error')?.textContent).toContain(MOVE_FAIL_MESSAGE)
    expect(document.querySelector('.manager__nav-error')?.textContent).toContain(MUTATION_REFRESH_MESSAGE)
    expect(document.querySelector('.edit-form')).toBeNull()
    const retry = buttonByExactText('重新读取目录与标签', drawerRoot())
    expect(document.activeElement).toBe(retry)

    readOk = true
    retry.click()
    await flushPromises()

    // 只读恢复：不重放 rename/move，编辑草稿原样恢复可见，写错误仍呈现（不宣称整次保存成功）。
    expect(writeCalls(calls), '只读恢复不得重放写入').toHaveLength(2)
    const form = document.querySelector<HTMLFormElement>('.edit-form')
    expect(form, '恢复后编辑表单按保留的编辑态重建').toBeTruthy()
    const recoveredInput = form!.querySelector<HTMLInputElement>('input[aria-label="目录名称"]')!
    expect(recoveredInput.value, '名称草稿保留').toBe('目录甲改')
    expect(
      form!.querySelector<HTMLSelectElement>('select[aria-label="上级目录"]')!.value,
      '上级草稿保留',
    ).toBe('folder-b')
    expect(document.querySelector('.manager__error')?.textContent).toContain(MOVE_FAIL_MESSAGE)
    expect(document.querySelector('.manager__nav-error')).toBeNull()
    // 重试在途焦点已停靠创建输入：完成后保持该有效焦点，不强行抢到恢复出的编辑表单字段。
    const parkedInput = document.querySelector<HTMLInputElement>('.manager .create-form input')
    expect(parkedInput).toBeTruthy()
    expect(document.activeElement, '完成后焦点保持有效停靠且不强行移动').toBe(parkedInput)
  })
})

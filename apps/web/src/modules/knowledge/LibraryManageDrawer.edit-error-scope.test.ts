// DT-R283 回归测试：LibraryManageDrawer 行内编辑错误的目标归属。
// 合同：A 的重命名 PATCH 失败（503）后，A 的草稿名与 role=alert 错误保留供用户修正；
// 用户从 B 可见行的「编辑」开始新的编辑意图时，属于 A 的旧错误必须随之清除（与
// openFolderDelete/openTagDelete 开始删除意图时清错误一致），名称 input 显示 B 的原名、
// 焦点落在 B 的名称 input，且不发出新的请求。
// 只走公开 DOM 与真实 Pinia store；目录/标签各一条。未修复源码上「切到 B 后错误应消失」红。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'

import LibraryManageDrawer from './LibraryManageDrawer.vue'
import { type FolderEntry, type TagEntry, useLibraryStore } from './library'

const FOLDER_A = '合成目录A'
const FOLDER_B = '合成目录B'
const TAG_A = '合成标签A'
const TAG_B = '合成标签B'
const SYNTHETIC_503_MESSAGE = '合成 503：结构更新暂不可用'

function seedFolders(): FolderEntry[] {
  return [
    { id: 'folder-a', parentId: null, name: FOLDER_A, sortOrder: 1, itemCount: 1, children: [] },
    { id: 'folder-b', parentId: null, name: FOLDER_B, sortOrder: 2, itemCount: 0, children: [] },
  ]
}
function seedTags(): TagEntry[] {
  return [
    { id: 'tag-a', name: TAG_A, itemCount: 1 },
    { id: 'tag-b', name: TAG_B, itemCount: 0 },
  ]
}

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

// PATCH 一律返回 503 合成错误体（ApiError 取 error.message 作为提示文本）；GET 返回固定种子，
// 其余端点兜底合法 Response。全程不应有任何成功写入。
function installFetchMock() {
  const calls: RecordedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url })
      if (url === '/api/v1/folders/tree') return Promise.resolve(jsonResponse({ items: seedFolders() }))
      if (url === '/api/v1/tags' && method === 'GET') return Promise.resolve(jsonResponse({ items: seedTags() }))
      if (method === 'PATCH') {
        return Promise.resolve(
          jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message: SYNTHETIC_503_MESSAGE } }, 503),
        )
      }
      return Promise.resolve(jsonResponse({}))
    }),
  )
  return { calls }
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

// 以可见行名定位列表行，再取该行「编辑」；处于编辑态的行不渲染行名，因此只能命中非编辑行。
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

function errorAlert() {
  return document.querySelector<HTMLElement>('.manager__error[role="alert"]')
}

interface Scenario {
  kind: '目录' | '标签'
  label: '目录名称' | '标签名称'
  nameA: string
  nameB: string
  patchPath: string
  openTab: () => Promise<void>
}

const scenarios: Scenario[] = [
  {
    kind: '目录',
    label: '目录名称',
    nameA: FOLDER_A,
    nameB: FOLDER_B,
    patchPath: '/api/v1/folders/folder-a',
    openTab: async () => {},
  },
  {
    kind: '标签',
    label: '标签名称',
    nameA: TAG_A,
    nameB: TAG_B,
    patchPath: '/api/v1/tags/tag-a',
    openTab: async () => {
      buttonByExactText('标签').click()
      await flushPromises()
    },
  },
]

describe('LibraryManageDrawer 行内编辑错误的目标归属（DT-R283）', () => {
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

  async function mountOpenDrawer() {
    const library = useLibraryStore()
    library.folders = seedFolders()
    library.tags = seedTags()
    wrapper = mount(LibraryManageDrawer, { attachTo: document.body })
    library.managerOpen = true
    await flushPromises()
    expect(document.querySelector('.manager'), '.manager dialog').toBeTruthy()
  }

  it.each(scenarios)(
    '$kind：A 保存 503 后草稿与错误保留；从 B 行「编辑」开始新编辑时错误清除、名称为 B、焦点在 B 名称 input',
    async ({ label, nameA, nameB, patchPath, openTab }) => {
      const { calls } = installFetchMock()
      await mountOpenDrawer()
      await openTab()

      // 进入 A 编辑：名称 input 初值为 A 且持有焦点。
      rowEditButton(nameA).click()
      await flushPromises()
      const inputA = editNameInput(label)
      expect(inputA.value).toBe(nameA)
      expect(document.activeElement, '进入 A 编辑后焦点在名称 input').toBe(inputA)

      // 改名并提交：PATCH 返回 503。
      const draftA = `${nameA}-改`
      setInputValue(inputA, draftA)
      buttonByExactText('保存', editForm()).click()
      await flushPromises()

      const patchCalls = () => calls.filter((call) => call.method === 'PATCH')
      expect(patchCalls(), 'A 的 PATCH 已发出').toHaveLength(1)
      expect(patchCalls()[0]!.path).toBe(patchPath)

      // 同一 A 请求失败：草稿与错误都保留，A 仍处编辑态，B 行可见。
      const alertAfterFailure = errorAlert()
      expect(alertAfterFailure, 'A 失败后 role=alert 错误应显示').toBeTruthy()
      expect(alertAfterFailure!.textContent ?? '').toContain(SYNTHETIC_503_MESSAGE)
      expect(editNameInput(label).value, 'A 失败后草稿名保留').toBe(draftA)
      expect(editNameInput(label).readOnly).toBe(false)
      expect(entryRow(nameB), 'B 行在 A 编辑态下仍可见').toBeTruthy()

      // 从 B 可见行的「编辑」开始新的编辑意图。
      rowEditButton(nameB).click()
      await flushPromises()

      expect(errorAlert(), '开始编辑 B 后属于 A 的错误应清除').toBeNull()
      const inputB = editNameInput(label)
      expect(inputB.value, '编辑表单名称应为 B 的原名').toBe(nameB)
      expect(document.activeElement, '进入 B 编辑后焦点在 B 的名称 input').toBe(inputB)
      // A 退出编辑态后以原名回到列表（失败未写入），全程仅 A 的一次 PATCH。
      expect(entryRow(nameA), 'A 行以原名恢复可见').toBeTruthy()
      expect(patchCalls(), '开始编辑 B 不得发出请求').toHaveLength(1)
    },
  )
})

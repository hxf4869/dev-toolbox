// DT-R288 回归测试：LibraryManageDrawer 行内编辑「上级目录」候选排除自身子树。
// 合同：编辑目录时，上级 select 的候选不得包含该目录自身及其全部后代（后端 moveFolder
// 对祖先移入子目录返回 422，前端不得提供确定非法的选项）；根目录、原父/祖先、其他分支
// 及其子目录仍可选，原选中父值、排列顺序与缩进、编辑焦点、保存行为保持。切换编辑对象后
// 候选立即按新对象重算，不残留旧排除；行内编辑期间的 Create 上级候选仍是完整树。
// 只走公开 DOM 与真实 Pinia store；仅伪造外部 HTTP（fetch mock 模拟服务端应用移动后的
// fresh GET 种子）。未修复源码上「子树排除」两条红；合法移动保存为原已绿的正向控制。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'

import LibraryManageDrawer from './LibraryManageDrawer.vue'
import { type FolderEntry, useLibraryStore } from './library'

const FOLDER_A = '合成目录A'
const FOLDER_CHILD = '合成子目录'
const FOLDER_GRAND = '合成孙目录'
const FOLDER_B = '合成目录B'
const FOLDER_B_CHILD = '合成B子目录'

// 五节点种子：A → child → grand 三层，B → B-child 两层。
function seedFolders(): FolderEntry[] {
  return [
    {
      id: 'folder-a',
      parentId: null,
      name: FOLDER_A,
      sortOrder: 1,
      itemCount: 0,
      children: [
        {
          id: 'folder-a-child',
          parentId: 'folder-a',
          name: FOLDER_CHILD,
          sortOrder: 1,
          itemCount: 0,
          children: [
            {
              id: 'folder-a-grand',
              parentId: 'folder-a-child',
              name: FOLDER_GRAND,
              sortOrder: 1,
              itemCount: 0,
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: 'folder-b',
      parentId: null,
      name: FOLDER_B,
      sortOrder: 2,
      itemCount: 0,
      children: [
        {
          id: 'folder-b-child',
          parentId: 'folder-b',
          name: FOLDER_B_CHILD,
          sortOrder: 1,
          itemCount: 0,
          children: [],
        },
      ],
    },
  ]
}

interface RecordedCall {
  method: string
  path: string
  body?: unknown
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// GET 端点读「活」种子；POST /folders/folder-a/move 像真实服务端一样应用移动：按
// organization.go moveFolder 的 MAX(sort_order)+1 把 folder-a 整棵子树追加到新父已有
// 子目录之后，再放行，使成功后的 loadNavigation fresh GET 反映移动后的新树；
// 其余端点兜底合法 Response，避免 undefined/TypeError 造红。
function installFetchMock() {
  const calls: RecordedCall[] = []
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
      if (url === '/api/v1/tags' && method === 'GET') return Promise.resolve(jsonResponse({ items: [] }))
      if (method === 'POST' && url === '/api/v1/folders/folder-a/move') {
        const { parentId } = JSON.parse(String(init?.body ?? '{}')) as { parentId: string | null }
        const subtree = folderSeed.find((folder) => folder.id === 'folder-a')
        if (subtree && parentId) {
          folderSeed = folderSeed
            .filter((folder) => folder.id !== 'folder-a')
            .map((folder) =>
              folder.id === parentId
                ? {
                    ...folder,
                    children: [
                      ...folder.children,
                      {
                        ...subtree,
                        parentId,
                        sortOrder: Math.max(0, ...folder.children.map((child) => child.sortOrder)) + 1,
                      },
                    ],
                  }
                : folder,
            )
        }
        return Promise.resolve(jsonResponse({ id: 'folder-a', parentId }))
      }
      return Promise.resolve(jsonResponse({}))
    }),
  )
  return { calls }
}

// 按钮按精确可访问文本匹配，避免「取消」误配「确认删除」等子串歧义。
function buttonByExactText(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll('button')].find(
    (entry) => (entry.textContent ?? '').trim() === text,
  )
  expect(button, `button with exact text "${text}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function editForm() {
  const form = document.querySelector<HTMLFormElement>('.edit-form')
  expect(form, '.edit-form').toBeTruthy()
  return form!
}

function editNameInput() {
  const input = editForm().querySelector<HTMLInputElement>('input[aria-label="目录名称"]')
  expect(input, '编辑表单名称 input（aria-label=目录名称）').toBeTruthy()
  return input!
}

function editParentSelect() {
  const select = editForm().querySelector<HTMLSelectElement>('select[aria-label="上级目录"]')
  expect(select, '编辑表单上级目录 select').toBeTruthy()
  return select!
}

function createParentSelect() {
  const select = document.querySelector<HTMLSelectElement>('.create-form select')
  expect(select, 'Create 表单上级目录 select').toBeTruthy()
  return select!
}

function optionValues(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.value)
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

function setSelectValue(select: HTMLSelectElement, value: string) {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

let folderSeed: FolderEntry[] = seedFolders()

describe('LibraryManageDrawer 编辑上级候选排除自身子树（DT-R288）', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    folderSeed = seedFolders()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  async function mountOpenDrawer() {
    const library = useLibraryStore()
    library.folders = folderSeed.map((folder) => ({ ...folder }))
    library.tags = []
    wrapper = mount(LibraryManageDrawer, { attachTo: document.body })
    library.managerOpen = true
    await flushPromises()
    expect(document.querySelector('.manager'), '.manager dialog').toBeTruthy()
  }

  it('编辑根目录 A：A/子/孙整棵子树不进候选，根/B/B-child 保留且缩进不变，Create 上级仍是完整树', async () => {
    installFetchMock()
    await mountOpenDrawer()

    rowEditButton(FOLDER_A).click()
    await flushPromises()

    // 名称、原父（根）与焦点保持既有合同。
    expect(editNameInput().value).toBe(FOLDER_A)
    expect(editParentSelect().value, 'A 原为根目录，上级初值应为根').toBe('')
    expect(document.activeElement, '进入 A 编辑后焦点在名称 input').toBe(editNameInput())

    // 核心合同：候选 = 根 + B + B-child，A 自身及其全部后代（child/grand）都不可选。
    expect(optionValues(editParentSelect())).toEqual(['', 'folder-b', 'folder-b-child'])
    // 排列与缩进保持：B 为根层无缩进，B-child 前有全角缩进。
    const options = [...editParentSelect().options]
    expect(options[1]!.textContent?.trim()).toBe(FOLDER_B)
    expect(options[2]!.textContent).toContain(`　${FOLDER_B_CHILD}`)

    // 行内编辑期间的 Create 上级候选仍是完整树（含 A 整棵子树）。
    expect(optionValues(createParentSelect())).toEqual([
      '',
      'folder-a',
      'folder-a-child',
      'folder-a-grand',
      'folder-b',
      'folder-b-child',
    ])
  })

  it('编辑嵌套 child：原父 A 保留可选、child/grand 排除；取消后编辑 B：排除 B/B-child 而 A 子树整体恢复', async () => {
    installFetchMock()
    await mountOpenDrawer()

    rowEditButton(FOLDER_CHILD).click()
    await flushPromises()

    expect(editNameInput().value).toBe(FOLDER_CHILD)
    expect(editParentSelect().value, 'child 原父为 A，上级初值应为 A').toBe('folder-a')
    expect(document.activeElement, '进入 child 编辑后焦点在名称 input').toBe(editNameInput())
    // 候选 = 根 + 原父 A + B + B-child；child 自身与其后代 grand 排除。
    expect(optionValues(editParentSelect())).toEqual(['', 'folder-a', 'folder-b', 'folder-b-child'])

    // 取消退出编辑态，焦点回到 child 行的「编辑」按钮。
    buttonByExactText('取消', editForm()).click()
    await flushPromises()
    expect(document.querySelector('.edit-form'), '取消后编辑表单应退出').toBeNull()
    expect(document.activeElement, '取消后焦点回到 child 行「编辑」按钮').toBe(rowEditButton(FOLDER_CHILD))

    // 切换编辑对象：候选立即按 B 重算——排除 B/B-child，A 整棵子树（含 child/grand）恢复可选。
    rowEditButton(FOLDER_B).click()
    await flushPromises()
    expect(editNameInput().value).toBe(FOLDER_B)
    expect(editParentSelect().value, 'B 原为根目录，上级初值应为根').toBe('')
    expect(document.activeElement, '进入 B 编辑后焦点在名称 input').toBe(editNameInput())
    expect(optionValues(editParentSelect())).toEqual([
      '',
      'folder-a',
      'folder-a-child',
      'folder-a-grand',
    ])
  })

  it('正向控制：选合法 B 保存 A 移动，仅一条 move POST 且无 rename PATCH，fresh GET 反映新树且表单正常收束', async () => {
    const { calls } = installFetchMock()
    await mountOpenDrawer()

    rowEditButton(FOLDER_A).click()
    await flushPromises()
    setSelectValue(editParentSelect(), 'folder-b')
    buttonByExactText('保存', editForm()).click()
    await flushPromises()

    // 名称未改动：只有一条 move POST（parentId=B），不得发出 rename PATCH 或其他写请求。
    const writes = calls.filter((call) => call.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.method).toBe('POST')
    expect(writes[0]!.path).toBe('/api/v1/folders/folder-a/move')
    expect(writes[0]!.body).toEqual({ parentId: 'folder-b' })

    // 成功后编辑表单收束、无错误，fresh GET 反映 A 子树整体追加到 B 已有子目录后的新树
    // （MAX(sort_order)+1 追加：B、B-child、A、child、grand）。
    expect(document.querySelector('.edit-form'), '成功后编辑表单应退出').toBeNull()
    expect(document.querySelector('.manager__error[role="alert"]'), '成功后不得出现错误提示').toBeNull()
    const rowNames = [...document.querySelectorAll<HTMLLIElement>('.entry-list li')].map(
      (li) => (li.querySelector('.entry-list__name strong')?.textContent ?? '').trim(),
    )
    expect(rowNames).toEqual([FOLDER_B, FOLDER_B_CHILD, FOLDER_A, FOLDER_CHILD, FOLDER_GRAND])
  })
})

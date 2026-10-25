// DT-R53：ItemDetailView 元数据编辑弹窗的保存生命周期合同测试。
// docs05「弹层关闭回焦触发器」：保存成功后焦点必须回到「重载完成后当前渲染」的「编辑元数据」按钮
// （case1：重载经 loading 重建主内容，须重新 query 当前 DOM，不得复用断连的旧元素）。
// 弹窗归属：busy 期间取消（Escape/取消按钮）是既有允许行为；取消挂起的 A 后重开编辑 B 或打开回收站时，
// 晚到的 A resolve/reject 不得关闭 B、不得自动保存 B、不得把 A 旧错误写进 B 或回收站弹窗（case2-4）。
// case5：A 保存自动关闭后仅剩旧导航 GET 挂起时，已有目录的 B.beginEdit 不再 await 导航、不发新导航请求；
// 晚到导航收尾不得抢 B 焦点。R52 busy 解除 watch 只把丢失焦点救回 first-input（标题），
// 故焦点锚断言在「备注」textarea：一旦被抢，救援落点是标题而非备注，丢失可观测、不被掩盖。
// R229（保存只提交相对打开快照真正变化的字段）：case6 用会反映成功 PATCH 的详情 DTO 重现
// A 成功 + B 改另一字段的第二笔保存，证明 A 的标题不被回退、B 的备注生效；case7 证明显式修改
// 同一字段仍能覆盖；case8 证无变化不发空 PATCH且回焦当前渲染的触发器；case9 证单字段清空
// （note:null / tagIds:[]）保持 docs/03 4.7 的 API 合同。
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

interface PatchGate {
  body: Record<string, unknown>
  resolve: (response: Response) => void
  reject: (reason?: unknown) => void
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

// DTO 形状与组件 ItemDetail 接口的真实消费字段一致（参照 dialog-a11y fixture）。
// overrides 供 applyPatches 用例预置初始备注/标签（清空语义验证）。
function itemDetail(overrides?: { note?: string | null; tags?: Array<{ id: string; name: string }> }) {
  return {
    id: 'item-1',
    title: '元数据编辑生命周期条目',
    titleOrigin: 'user',
    note: overrides?.note ?? null,
    // 显式对象|null联合：applyPatches 的 mock 需按 docs/03 契约把 folderId 应用回该状态。
    folder: null as { id: string; name: string; path: string } | null,
    tags: overrides?.tags ?? [],
    sensitivity: 'normal',
    favorite: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    rawRecords: [rawSummary()],
    attachments: [],
    artifacts: [],
    availableVersions: [],
  }
}

// 1 个合法 FolderEntry（library.ts 公开 shape，children=[]），首导航经真实 beginEdit 填入 store。
function folderEntry() {
  return { id: 'folder-1', parentId: null, name: '合成目录', sortOrder: 0, itemCount: 0, children: [] }
}

// 1 个合法 TagEntry（library.ts 公开 shape），供标签清空语义用例经导航真实渲染复选框。
function tagEntry() {
  return { id: 'tag-9', name: '待移除标签', itemCount: 0 }
}

// 受控 fetch mock：GET 详情/导航端点即时返回正确 DTO 形状；
// gatePatches 时 PATCH 经 deferred gate 挂起，由用例决定晚到 resolve/reject；
// hangSaveNavigation 时首次 folders/tree 即时返回 1 个合法目录，保存阶段的后续 folders/tree 经 gate 挂起（tags 恒即时）。
// applyPatches 时记录每笔 PATCH payload，并在 resolve 时按 docs/03 4.7 契约（缺失字段保持不变）
// 应用到可变详情状态，后续详情 GET 返回应用后的 DTO——经组件可观测地验证每笔保存的实际持久结果。
function installFetchMock(options?: {
  gatePatches?: boolean
  hangSaveNavigation?: boolean
  applyPatches?: boolean
  tags?: Array<{ id: string; name: string; itemCount: number }>
}) {
  const calls: RecordedCall[] = []
  const patchBodies: Array<Record<string, unknown>> = []
  const pendingPatches: PatchGate[] = []
  const pendingNavigationResolvers: Array<(response: Response) => void> = []
  let folderTreeCalls = 0
  let detailState = itemDetail()
  // mock 侧只镜像 docs/03 4.7 已明示的 PATCH 语义，供断言持久结果，不代表真实服务端实现。
  function applyPatchToState(patch: Record<string, unknown>) {
    if ('title' in patch) detailState.title = String(patch.title).trim()
    if ('note' in patch) detailState.note = typeof patch.note === 'string' ? patch.note : null
    if ('folderId' in patch)
      detailState.folder = patch.folderId
        ? { id: String(patch.folderId), name: '合成目录', path: '/合成目录' }
        : null
    if ('tagIds' in patch)
      detailState.tags = (patch.tagIds as string[]).map((id) => ({ id, name: `标签-${id}`, itemCount: 0 }))
    if ('favorite' in patch) detailState.favorite = Boolean(patch.favorite)
    if ('sensitivity' in patch)
      detailState.sensitivity =
        patch.sensitivity === 'sensitive' || patch.sensitivity === 'unknown' ? patch.sensitivity : 'normal'
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url })
      // beginEdit 在目录/标签为空时 await library.loadNavigation()；saveMetadata 成功后也会刷新导航。
      if (url === '/api/v1/folders/tree') {
        folderTreeCalls += 1
        if (options?.hangSaveNavigation && folderTreeCalls >= 2) {
          return new Promise<Response>((resolve) => pendingNavigationResolvers.push(resolve))
        }
        return Promise.resolve(
          jsonResponse({ items: options?.hangSaveNavigation ? [folderEntry()] : [] }),
        )
      }
      if (url === '/api/v1/tags') return Promise.resolve(jsonResponse({ items: options?.tags ?? [] }))
      if (url === ITEM_PATH && method === 'GET')
        return Promise.resolve(jsonResponse(options?.applyPatches ? detailState : itemDetail()))
      if (url === ITEM_PATH && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        patchBodies.push(body)
        if (options?.gatePatches) {
          return new Promise<Response>((resolve, reject) =>
            pendingPatches.push({ body, resolve, reject }),
          )
        }
        if (options?.applyPatches) applyPatchToState(body)
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (url === ITEM_PATH) return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(jsonResponse({}))
    }),
  )
  const takePendingPatch = () => {
    const gate = pendingPatches.shift()
    expect(gate, '应当存在一个挂起中的 PATCH gate').toBeTruthy()
    return gate!
  }
  const takePendingNavigation = () => {
    const resolve = pendingNavigationResolvers.shift()
    expect(resolve, '应当存在一个挂起中的导航 gate').toBeTruthy()
    return resolve!
  }
  return {
    calls,
    patchBodies,
    detailState,
    resolvePendingPatch: () => {
      const gate = takePendingPatch()
      if (options?.applyPatches) applyPatchToState(gate.body)
      gate.resolve(new Response(null, { status: 204 }))
    },
    rejectPendingPatch: (reason: Error) => takePendingPatch().reject(reason),
    resolvePendingNavigation: () => takePendingNavigation()(jsonResponse({ items: [folderEntry()] })),
  }
}

// 触发按钮与弹窗内按钮必须精确匹配文本，避免 includes 歧义（「编辑元数据」/「保存元数据」）。
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

// Escape 必须从真实聚焦元素发出，经冒泡到达弹窗 keydown 归属处理。
function pressEscape() {
  focusedElement().dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
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

let activeWrapper: ReturnType<typeof mount> | null = null

async function mountDetail() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workspace', component: { template: '<div />' } },
      { path: '/items/:itemId', name: 'item-detail', component: ItemDetailView },
    ],
  })
  await router.push('/')
  activeWrapper = mount(ItemDetailView, {
    props: { itemId: 'item-1' },
    attachTo: document.body,
    global: { plugins: [router] },
  })
  await flushPromises()
  return activeWrapper
}

// 真实点击打开编辑弹窗。
async function openEditDialog() {
  buttonByExactText('编辑元数据').click()
  await flushPromises()
  const dialog = dialogByLabelledBy('edit-title')
  expect(dialog, 'edit dialog').toBeTruthy()
  return dialog!
}

// 真实提交保存：先聚焦「保存元数据」再点击，PATCH 经 gate 挂起进入 busy；
// expectedPatchCount 用于同一会话内的第二笔保存（如 A 挂起成功后 B 的提交）。
async function submitPendingSave(
  dialog: HTMLElement,
  calls: RecordedCall[],
  expectedPatchCount = 1,
) {
  const saveButton = buttonByExactText('保存元数据', dialog)
  saveButton.focus()
  saveButton.click()
  await flushPromises()
  const patchCount = calls.filter(
    (call) => call.method === 'PATCH' && call.path === ITEM_PATH,
  ).length
  expect(patchCount, 'PATCH 已发出并挂起').toBe(expectedPatchCount)
}

// 从真实聚焦的标题输入框键入新标题（v-model 监听原生 input 事件）。
function typeInto(input: HTMLInputElement, value: string) {
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

// 从真实聚焦的「备注」textarea 键入（局部定位 helper）：
// R52 busy 解除 watch 只把丢失焦点救回 first-input（标题），锚在备注框才能让抢焦可观测。
function noteTextareaIn(dialog: HTMLElement) {
  const label = [...dialog.querySelectorAll('label')].find(
    (entry) => (entry.querySelector('span')?.textContent ?? '').trim() === '备注',
  )
  const textarea = label?.querySelector('textarea')
  expect(textarea, 'edit note textarea').toBeTruthy()
  return textarea as HTMLTextAreaElement
}

function typeIntoNote(dialog: HTMLElement, value: string) {
  const note = noteTextareaIn(dialog)
  note.focus()
  note.value = value
  note.dispatchEvent(new Event('input', { bubbles: true }))
}

function countCalls(calls: RecordedCall[], method: string) {
  return calls.filter((call) => call.method === method && call.path === ITEM_PATH).length
}

describe('ItemDetailView metadata edit lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = null
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('case1 保存成功后焦点回到重载完成后的「编辑元数据」按钮（而非 BODY）', async () => {
    const { calls } = installFetchMock()
    const wrapper = await mountDetail()

    const dialog = await openEditDialog()
    // R229：无字段变化不再发出 PATCH（改为直接关闭），先真实改标题以保留保存成功路径前提。
    typeInto(editTitleInput(dialog), '保存成功路径的新标题')
    const saveButton = buttonByExactText('保存元数据', dialog)
    saveButton.focus()
    saveButton.click()
    await flushPromises()

    // 弹窗关闭 + 元数据/导航重载确实完成（mount 1 次 + 保存成功后 1 次）。
    expect(dialogByLabelledBy('edit-title'), '保存成功后编辑弹窗关闭').toBeNull()
    expect(countCalls(calls, 'GET'), '保存成功后 loadDetail 重载详情').toBe(2)
    expect(wrapper.emitted('changed'), '保存成功后 emit changed').toBeTruthy()

    // 焦点必须回到「当前渲染」的触发按钮：保存后的 loadDetail 用 loading 分支整体重建过主内容，
    // 必须在重载完成后从当前 DOM 重新 query 该按钮再断言，不得复用打开时已断连的旧元素引用。
    const triggerAfterReload = buttonByExactText('编辑元数据')
    expect(
      document.activeElement,
      'docs05 弹层关闭回触发器：保存成功后焦点回到当前渲染的「编辑元数据」按钮',
    ).toBe(triggerAfterReload)
  })

  it('case2 取消挂起的 A 后打开编辑 B：晚到的 A resolve 不得关闭 B / 自动保存 B', async () => {
    const { calls, resolvePendingPatch } = installFetchMock({ gatePatches: true })
    const wrapper = await mountDetail()

    // 打开 A 并真实提交，使 PATCH A 挂起进入 busy（R229：真实改标题，无变化不再发出 PATCH）。
    const dialogA = await openEditDialog()
    typeInto(editTitleInput(dialogA), 'A 会话的新标题')
    await submitPendingSave(dialogA, calls)

    // busy 期间从真实焦点元素 Escape 取消 A（既有允许行为）。
    pressEscape()
    await flushPromises()
    expect(dialogByLabelledBy('edit-title'), '取消后 A 弹窗关闭').toBeNull()

    // 重新打开编辑 B，并在 B 标题输入框真实键入新草稿。
    const dialogB = await openEditDialog()
    const titleB = editTitleInput(dialogB)
    expect(document.activeElement, 'B 打开后初焦标题输入框').toBe(titleB)
    typeInto(titleB, 'B 会话的新标题草稿')
    await flushPromises()

    // A 的 PATCH 晚到 resolve。
    resolvePendingPatch()
    await flushPromises()

    // A 的成功路径确实完成了详情重载与通知（既有正确行为，如实报绿）。
    expect(countCalls(calls, 'GET'), 'A 晚到成功仍重载详情').toBe(2)
    expect(wrapper.emitted('changed'), 'A 晚到成功仍 emit changed').toBeTruthy()

    // B 不得被 A 的晚到响应关闭；草稿、焦点保持；B 未被自动保存。
    const dialogBAfter = dialogByLabelledBy('edit-title')
    expect(dialogBAfter, '晚到的 A resolve 不得关闭重新打开的 B').toBeTruthy()
    const titleBAfter = editTitleInput(dialogBAfter!)
    expect(titleBAfter.value, 'B 草稿保留').toBe('B 会话的新标题草稿')
    expect(document.activeElement, '焦点仍在 B 的标题输入框').toBe(titleBAfter)
    expect(countCalls(calls, 'PATCH'), 'B 未被自动保存（没有第二次 PATCH）').toBe(1)
  })

  it('case3 同一时序晚到的 A reject：B 不显示 A 的旧错误，草稿与焦点不变', async () => {
    const { calls, rejectPendingPatch } = installFetchMock({ gatePatches: true })
    await mountDetail()

    const dialogA = await openEditDialog()
    typeInto(editTitleInput(dialogA), 'A 会话的新标题')
    await submitPendingSave(dialogA, calls)
    pressEscape()
    await flushPromises()
    expect(dialogByLabelledBy('edit-title'), '取消后 A 弹窗关闭').toBeNull()

    const dialogB = await openEditDialog()
    const titleB = editTitleInput(dialogB)
    typeInto(titleB, 'B 会话的新标题草稿')
    await flushPromises()

    // A 的 PATCH 晚到失败。
    rejectPendingPatch(new Error('A 请求元数据保存失败（模拟网络错误）'))
    await flushPromises()

    const dialogBAfter = dialogByLabelledBy('edit-title')
    expect(dialogBAfter, '晚到的 A reject 不得关闭 B').toBeTruthy()
    expect(
      dialogBAfter!.querySelector('.mutation-error'),
      'B 的错误提示区不得出现 A 的旧 mutationError',
    ).toBeNull()
    expect(editTitleInput(dialogBAfter!).value, 'B 草稿不变').toBe('B 会话的新标题草稿')
    expect(
      document.activeElement,
      '焦点仍在 B 的标题输入框',
    ).toBe(editTitleInput(dialogBAfter!))
  })

  it('case4 同一时序晚到的 A reject：回收站弹窗不显示 A 的元数据错误、不触发 DELETE', async () => {
    const { calls, rejectPendingPatch } = installFetchMock({ gatePatches: true })
    await mountDetail()

    const dialogA = await openEditDialog()
    typeInto(editTitleInput(dialogA), 'A 会话的新标题')
    await submitPendingSave(dialogA, calls)
    pressEscape()
    await flushPromises()
    expect(dialogByLabelledBy('edit-title'), '取消后 A 弹窗关闭').toBeNull()

    // busy 未解除时打开回收站确认：两个按钮均禁用，R52 初焦落弹窗容器。
    const trashTrigger = document.querySelector<HTMLButtonElement>('button.trash-action')
    expect(trashTrigger, 'trash trigger').toBeTruthy()
    trashTrigger!.click()
    await flushPromises()
    const trashDialog = dialogByLabelledBy('trash-title')
    expect(trashDialog, 'trash alertdialog').toBeTruthy()
    expect(document.activeElement, 'busy 中回收站初焦弹窗容器').toBe(trashDialog)

    // A 的 PATCH 晚到失败。
    rejectPendingPatch(new Error('A 请求元数据保存失败（模拟网络错误）'))
    await flushPromises()

    // 回收站弹窗保持打开且未被触发 DELETE。
    expect(trashDialog!.isConnected, '回收站弹窗元素仍连接').toBe(true)
    expect(countCalls(calls, 'DELETE'), '不得触发 DELETE').toBe(0)

    // 回收站不得显示 A 的元数据保存错误。
    expect(
      trashDialog!.querySelector('.mutation-error'),
      '回收站弹窗不得显示 A 的元数据错误',
    ).toBeNull()

    // R52 既有行为：busy 解除后焦点安全回退到「取消」按钮（断言方式参照 dialog-a11y 测试）。
    const cancelButton = buttonByExactText('取消', trashDialog!)
    expect(document.activeElement, 'busy 解除后焦点恢复到「取消」').toBe(cancelButton)
  })

  it('case5 A 保存后仅剩旧导航挂起：B 直接打开不再发导航请求，晚到导航收尾不抢 B 焦点', async () => {
    const { calls, resolvePendingNavigation } = installFetchMock({ hangSaveNavigation: true })
    const wrapper = await mountDetail()
    const folderTreeCallCount = () =>
      calls.filter((call) => call.path === '/api/v1/folders/tree').length

    // 打开 A：store 无目录时 beginEdit await 公开 loadNavigation，首导航填入 1 个合法 FolderEntry。
    const dialogA = await openEditDialog()
    expect(folderTreeCallCount(), 'A 打开阶段首次导航已填入目录').toBe(1)
    // R229：真实改标题再保存，无字段变化不再发出 PATCH。
    typeInto(editTitleInput(dialogA), 'A 会话的新标题')

    // 普通 A 保存：PATCH 立即 204、详情 GET 正常完成，仅保存阶段的旧导航 folders/tree 挂起（tags 即时）。
    const saveButton = buttonByExactText('保存元数据', dialogA)
    saveButton.focus()
    saveButton.click()
    await flushPromises()

    // A 已自动关闭、详情重载已完成、新编辑入口已重新出现、旧导航 gate 确已进入。
    expect(dialogByLabelledBy('edit-title'), 'A 保存成功自动关闭').toBeNull()
    expect(countCalls(calls, 'GET'), '详情重载已完成').toBe(2)
    expect(buttonByExactText('编辑元数据'), '重载后新编辑入口已出现').toBeTruthy()
    expect(folderTreeCallCount(), '保存阶段旧导航已发出并挂起').toBe(2)
    expect(wrapper.emitted('changed'), '导航挂起时 A 收尾未完成（changed 未发）').toBeFalsy()

    // 已有目录时 B 直接打开并键入，不再 await 导航（无第 3 次 folders/tree）。
    const dialogB = await openEditDialog()
    const titleB = editTitleInput(dialogB)
    expect(document.activeElement, 'B 打开后初焦标题输入框').toBe(titleB)
    expect(folderTreeCallCount(), 'B 打开不再发新导航请求').toBe(2)
    typeInto(titleB, 'B 会话的新标题草稿')

    // 焦点经公开 DOM 移到「备注」textarea 并键入备注草稿：R52 busy 解除 watch 只把丢失焦点
    // 救回 first-input（标题），锚在备注框才能让抢焦可观测、不被掩盖。
    typeIntoNote(dialogB, 'B 会话的备注草稿')
    await flushPromises()

    // 旧导航 gate 晚到 resolve 为同一目录的合法响应。
    resolvePendingNavigation()
    await flushPromises()

    // B 仍开；标题与备注草稿都不变；焦点仍是同一个「备注」textarea（而非被救援回的标题框）。
    const dialogBAfter = dialogByLabelledBy('edit-title')
    expect(dialogBAfter, '晚到的旧导航收尾不得关闭 B').toBeTruthy()
    expect(editTitleInput(dialogBAfter!).value, 'B 标题草稿保留').toBe('B 会话的新标题草稿')
    const noteBAfter = noteTextareaIn(dialogBAfter!)
    expect(noteBAfter.value, 'B 备注草稿保留').toBe('B 会话的备注草稿')
    expect(document.activeElement, '晚到收尾不得抢走 B 的备注焦点').toBe(noteBAfter)

    // A 既有收尾仍完成：changed 通知与原刷新完成，且不追加任何请求。
    expect(wrapper.emitted('changed'), 'A 晚到收尾仍 emit changed').toBeTruthy()
    expect(countCalls(calls, 'GET'), '不追加详情重载').toBe(2)
    expect(folderTreeCallCount(), '不追加导航请求').toBe(2)
    expect(countCalls(calls, 'PATCH'), 'PATCH 仍只有 A 的 1 次').toBe(1)
  })

  // R229 核心场景：A 成功后重开的 B 表单仍是打开时的旧值，第二笔保存不得把它当作用户编辑全量提交。
  it('case6 A 成功后重开的 B 只提交相对打开快照变化的字段：A 的标题不被回退、B 的备注生效', async () => {
    const mock = installFetchMock({ gatePatches: true, applyPatches: true })
    const wrapper = await mountDetail()

    // A：真实改标题并提交（挂起），busy 期间 Escape 取消后重开 B 只改备注。
    const dialogA = await openEditDialog()
    typeInto(editTitleInput(dialogA), 'A 会话保存的新标题')
    await submitPendingSave(dialogA, mock.calls)
    pressEscape()
    await flushPromises()

    const dialogB = await openEditDialog()
    typeIntoNote(dialogB, 'B 会话保存的新备注')
    await flushPromises()

    // A 晚到成功：mock 按 docs/03 契约应用 payload，收尾详情 GET 反映 A 的新标题。
    mock.resolvePendingPatch()
    await flushPromises()
    expect(mock.patchBodies[0], 'A 的 PATCH 只含标题').toEqual({ title: 'A 会话保存的新标题' })
    expect(
      document.querySelector('.detail-header h1')?.textContent,
      'A 收尾重载后标题已是 A 的新值',
    ).toBe('A 会话保存的新标题')

    // B 第二笔保存：payload 只含真正变化的备注，不得带上未变的旧标题回退 A 刚保存的结果。
    const dialogBAfter = dialogByLabelledBy('edit-title')
    expect(dialogBAfter, 'B 仍打开').toBeTruthy()
    await submitPendingSave(dialogBAfter!, mock.calls, 2)
    expect(mock.patchBodies[1], 'B 的 PATCH 只含备注，不含未修改的标题').toEqual({
      note: 'B 会话保存的新备注',
    })

    // B 的 PATCH 应用后重载：标题保持 A 的值（第一笔不被回退），备注为 B 的值（第二笔确实生效）。
    mock.resolvePendingPatch()
    await flushPromises()
    expect(
      document.querySelector('.detail-header h1')?.textContent,
      'A 的标题未被 B 的第二笔保存回退',
    ).toBe('A 会话保存的新标题')
    expect(mock.detailState.note, 'B 的备注已持久生效').toBe('B 会话保存的新备注')
    expect(wrapper.emitted('changed')?.length, '两次保存均通知 changed').toBe(2)
  })

  it('case7 B 明确修改同一标题字段：第二笔保存仍覆盖 A 刚保存的标题', async () => {
    const mock = installFetchMock({ gatePatches: true, applyPatches: true })
    await mountDetail()

    const dialogA = await openEditDialog()
    typeInto(editTitleInput(dialogA), 'A 会话保存的标题')
    await submitPendingSave(dialogA, mock.calls)
    pressEscape()
    await flushPromises()

    const dialogB = await openEditDialog()
    typeInto(editTitleInput(dialogB), 'B 会话覆盖的标题')
    await flushPromises()

    mock.resolvePendingPatch()
    await flushPromises()
    expect(document.querySelector('.detail-header h1')?.textContent, 'A 的标题已生效').toBe(
      'A 会话保存的标题',
    )

    // B 显式改了标题：PATCH 带上 B 的标题并生效（打开快照语义不阻碍真正的用户修改）。
    const dialogBAfter = dialogByLabelledBy('edit-title')
    expect(dialogBAfter, 'B 仍打开').toBeTruthy()
    await submitPendingSave(dialogBAfter!, mock.calls, 2)
    expect(mock.patchBodies[1], 'B 的 PATCH 带有显式修改的标题').toEqual({
      title: 'B 会话覆盖的标题',
    })

    mock.resolvePendingPatch()
    await flushPromises()
    expect(
      document.querySelector('.detail-header h1')?.textContent,
      '标题为 B 的覆盖值',
    ).toBe('B 会话覆盖的标题')
  })

  it('case8 无相对打开快照的变化：不发空 PATCH，关闭并回焦当前渲染的编辑触发器', async () => {
    const mock = installFetchMock({ gatePatches: true, applyPatches: true })
    await mountDetail()

    // A：真实改标题提交（挂起）→ Escape 取消 → 重开 B；B 打开后 A 晚到成功，
    // 详情重载重建头部，B.beginEdit 记住的 dialogTrigger 已断连。
    const dialogA = await openEditDialog()
    typeInto(editTitleInput(dialogA), 'A 会话保存的新标题')
    await submitPendingSave(dialogA, mock.calls)
    pressEscape()
    await flushPromises()

    const dialogB = await openEditDialog()
    mock.resolvePendingPatch()
    await flushPromises()
    expect(countCalls(mock.calls, 'GET'), 'A 收尾重载详情').toBe(2)

    // B 未改任何字段直接保存：不得发出后端必拒的空 PATCH。
    const saveButtonB = buttonByExactText('保存元数据', dialogB)
    saveButtonB.focus()
    saveButtonB.click()
    await flushPromises()

    expect(countCalls(mock.calls, 'PATCH'), '无变化不发 PATCH').toBe(1)
    expect(dialogByLabelledBy('edit-title'), '编辑弹窗已关闭').toBeNull()
    // 回焦当前渲染（重载后重建）的编辑触发器，而非 B.beginEdit 记住的已断连旧元素。
    const currentTrigger = buttonByExactText('编辑元数据')
    expect(document.activeElement, '焦点回到当前渲染的编辑触发器').toBe(currentTrigger)
  })

  it('case9 单字段清空保持 API 合同：清备注发 note:null、移除标签发 tagIds:[]，其余字段缺失', async () => {
    const mock = installFetchMock({ gatePatches: true, applyPatches: true, tags: [tagEntry()] })
    mock.detailState.note = '待清空的备注'
    mock.detailState.tags = [{ id: 'tag-9', name: '待移除标签' }]
    await mountDetail()

    // 真实清空备注 textarea、点击取消勾选 tag-9 复选框。
    const dialog = await openEditDialog()
    typeIntoNote(dialog, '')
    const tagCheckbox = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (entry) => entry.value === 'tag-9',
    )
    expect(tagCheckbox, 'tag-9 复选框已随导航渲染').toBeTruthy()
    tagCheckbox!.click()
    await flushPromises()

    await submitPendingSave(dialog, mock.calls)
    expect(mock.patchBodies[0], '只含被清空的两个字段，标题/目录/收藏/敏感缺失').toEqual({
      note: null,
      tagIds: [],
    })

    mock.resolvePendingPatch()
    await flushPromises()
    expect(mock.detailState.note, '备注已清空').toBeNull()
    expect(mock.detailState.tags, '标签已清空').toEqual([])
  })
})

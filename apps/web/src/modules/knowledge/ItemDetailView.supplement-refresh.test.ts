// DT-R65 合同测试：ItemDetailView 补充保存收尾与同实例详情 GET 归属。
// case1：补充保存成功并重载完成后，焦点必须回到「当前渲染」的「添加补充」按钮（docs05 弹层关闭回焦语义，
//        重载经 loading 重建头部，须重新 query 当前 DOM）。R65 baseline（修复前）没有补充收尾回焦，
//        drawer 关闭回焦落在已被卸载的旧按钮上，焦点落 BODY，本断言曾红。
// case2：详情重载挂起期间，组件外部（如 Workspace 搜索框）的有效焦点与草稿不得被补充收尾抢走——既有正确行为，baseline 即绿。
// case3：A 编辑保存被 Escape 取消后，B 补充保存与 A 的收尾详情 GET 在同一组件实例上并发；
//        GET1 属于已取消的 A 保存的收尾（editGeneration 只保护弹窗状态，不保护 detail 归属），
//        GET2 属于 B 补充的 created 收尾，二者同写共享 detail ref——晚到的旧快照 GET1 不得抹掉已完成的最新详情（baseline 曾红）。
// case4：同一并发链上 GET1 晚失败：旧失败不得把页面清成「记录暂时不可用」错误整页、不得提前清掉最新加载的 loading，
//        GET2 成功后页内也不得残留旧错误条（baseline 时错误整页断言曾红，其余断言当时未执行到）。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import ItemDetailView from './ItemDetailView.vue'

const ITEM_PATH = '/api/v1/items/item-1'
const RAW_RECORDS_PATH = '/api/v1/items/item-1/raw-records'

interface RecordedCall {
  method: string
  path: string
}

interface Gate {
  resolve: (response: Response) => void
  reject: (reason?: unknown) => void
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 主记录与补充记录摘要（字段形状参照 raw-race 的 rawSummary；rawB 是晚一天的补充记录）。
// 每次调用都返回全新对象：两份详情快照绝不共享同一 rawRecords 数组或同一记录实例，
// 否则两个快照会同时变成 2 条，乱序归属测试失效。
function rawSummary(id: 'raw-a' | 'raw-b') {
  const primary = id === 'raw-a'
  const capturedAt = primary ? '2026-09-01T08:00:00Z' : '2026-09-02T08:00:00Z'
  return {
    id,
    recordRole: primary ? 'primary' : 'supplement',
    sourceType: 'web_quick_capture',
    contentKind: 'text',
    contentFormat: 'plain_text',
    declaredSensitivity: 'normal',
    capturedAt,
    effectiveCapturedAt: capturedAt,
    sourceTimeQuality: 'trusted',
    createdAt: capturedAt,
    attachments: [],
    relations: [],
    fragments: [],
  }
}

function detailDto(title: string, records: Array<ReturnType<typeof rawSummary>>) {
  return {
    id: 'item-1',
    title,
    titleOrigin: 'user',
    note: null,
    folder: null,
    tags: [],
    sensitivity: 'normal',
    favorite: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    rawRecords: records,
    attachments: [],
    artifacts: [],
    availableVersions: [],
  }
}

// 挂载首笔详情 GET 的初始快照：仅主记录。
function initialDetail() {
  return detailDto('补充收尾与详情归属验证条目', [rawSummary('raw-a')])
}

// case1/case2 的补充后快照：主记录 + 补充记录共 2 条。
function supplementedDetail() {
  return detailDto('补充收尾与详情归属验证条目', [rawSummary('raw-a'), rawSummary('raw-b')])
}

// case3/case4 的 GET1 快照（A 元数据保存后、B 补充前）：新标题，仅主记录。
function editedBeforeSupplementDetail() {
  return detailDto('A 编辑后的新标题', [rawSummary('raw-a')])
}

// case3/case4 的 GET2 快照（B 补充后）：同 A 新标题，主记录 + 补充记录共 2 条。
function supplementedAfterEditDetail() {
  return detailDto('A 编辑后的新标题', [rawSummary('raw-a'), rawSummary('raw-b')])
}

// 受控 fetch mock：挂载首笔详情 GET 即时返回初始快照；之后的详情 GET、PATCH、补充 POST 全部经
// deferred gate 挂起，由用例决定 resolve/reject 顺序。导航 folders/tree 与 tags 恒即时返回空集合。
function installFetchMock() {
  const calls: RecordedCall[] = []
  const pendingPatches: Gate[] = []
  const pendingSupplementPosts: Gate[] = []
  const pendingDetailReloads: Gate[] = []
  let detailGetCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      const url = String(path)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url })
      // beginEdit 与保存收尾的 loadNavigation 都会请求导航端点，空集合即可。
      if (url === '/api/v1/folders/tree' || url === '/api/v1/tags')
        return Promise.resolve(jsonResponse({ items: [] }))
      if (url === RAW_RECORDS_PATH && method === 'POST')
        return new Promise<Response>((resolve, reject) => pendingSupplementPosts.push({ resolve, reject }))
      if (url === ITEM_PATH && method === 'PATCH')
        return new Promise<Response>((resolve, reject) => pendingPatches.push({ resolve, reject }))
      if (url === ITEM_PATH && method === 'GET') {
        detailGetCalls += 1
        if (detailGetCalls === 1) return Promise.resolve(jsonResponse(initialDetail()))
        return new Promise<Response>((resolve, reject) => pendingDetailReloads.push({ resolve, reject }))
      }
      if (url === ITEM_PATH) return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(jsonResponse({}))
    }),
  )
  const gateAt = (queue: Gate[], index: number, label: string) => {
    const gate = queue[index]
    expect(gate, `应当存在第 ${index + 1} 个挂起的${label}`).toBeTruthy()
    return gate!
  }
  return {
    calls,
    detailGetCount: () => calls.filter((call) => call.method === 'GET' && call.path === ITEM_PATH).length,
    pendingDetailReloadCount: () => pendingDetailReloads.length,
    resolvePendingPatch: () => gateAt(pendingPatches, 0, 'PATCH gate').resolve(new Response(null, { status: 204 })),
    // 无附件的补充走 jsonRequest POST；201 + JSON 是合法成功响应（204 亦合法，与 mock 一致即可）。
    resolvePendingSupplementPost: () =>
      gateAt(pendingSupplementPosts, 0, '补充 POST gate').resolve(jsonResponse({ id: 'raw-b' }, 201)),
    // index 按详情 GET 的发出顺序：0 = 第一笔挂起重载（先发出），1 = 第二笔（后发出）。
    resolveDetailReload: (index: number, snapshot: unknown) =>
      gateAt(pendingDetailReloads, index, '详情 GET gate').resolve(jsonResponse(snapshot)),
    rejectDetailReload: (index: number, reason: Error) =>
      gateAt(pendingDetailReloads, index, '详情 GET gate').reject(reason),
  }
}

// 触发按钮与弹窗/抽屉内按钮必须精确匹配文本，避免 includes 歧义（「添加补充」/「保存补充记录」）。
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

// 从真实聚焦的输入控件键入文本（v-model 监听原生 input 事件）。
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
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

// 补充 drawer 根节点（Teleport 到 body，aria-labelledby=supplement-title）。
function supplementDrawerRoot() {
  const root = document.querySelector<HTMLElement>('[aria-labelledby="supplement-title"]')
  expect(root, 'supplement drawer').toBeTruthy()
  return root!
}

// drawer 内唯一的正文 textarea（label span 文本「补充内容」）。
function supplementTextarea() {
  const textarea = supplementDrawerRoot().querySelector('textarea')
  expect(textarea, 'drawer 补充正文 textarea').toBeTruthy()
  return textarea as HTMLTextAreaElement
}

function headerRawCountText() {
  const line = document.querySelector('.detail-header__main p')
  expect(line, 'detail header count line').toBeTruthy()
  return (line!.textContent ?? '').trim()
}

function rawHistoryButtons() {
  return Array.from(document.querySelectorAll('.raw-history button'))
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

// 真实用户路径：聚焦并点击「添加补充」打开 drawer，在正文 textarea 键入内容后 v-model 生效。
async function openSupplementAndFill(body: string) {
  const opener = buttonByExactText('添加补充')
  opener.focus()
  opener.click()
  await flushPromises()
  typeInto(supplementTextarea(), body)
  await flushPromises()
}

// 聚焦「保存补充记录」再真实点击，补充 POST 经 gate 挂起（断言已发出）。
async function submitPendingSupplement(calls: RecordedCall[]) {
  const saveButton = buttonByExactText('保存补充记录', supplementDrawerRoot())
  saveButton.focus()
  saveButton.click()
  await flushPromises()
  const postCount = calls.filter(
    (call) => call.method === 'POST' && call.path === RAW_RECORDS_PATH,
  ).length
  expect(postCount, '补充 POST 已发出并挂起').toBe(1)
}

// 真实点击打开编辑弹窗。
async function openEditDialog() {
  buttonByExactText('编辑元数据').click()
  await flushPromises()
  const dialog = dialogByLabelledBy('edit-title')
  expect(dialog, 'edit dialog').toBeTruthy()
  return dialog!
}

// 真实提交元数据保存：先聚焦「保存元数据」再点击，PATCH 经 gate 挂起进入 busy。
async function submitPendingSave(dialog: HTMLElement, calls: RecordedCall[]) {
  const saveButton = buttonByExactText('保存元数据', dialog)
  saveButton.focus()
  saveButton.click()
  await flushPromises()
  const patchCount = calls.filter(
    (call) => call.method === 'PATCH' && call.path === ITEM_PATH,
  ).length
  expect(patchCount, 'PATCH 已发出并挂起').toBe(1)
}

// case3/case4 共用的并发前置链：A 编辑提交后取消，B 补充提交挂起，PATCH 先 resolve 使 GET1 挂起，
// 再 resolve POST 使 GET2 挂起——两个详情 GET 属同实例并发，同写共享 detail ref。
async function runConcurrentChain(mock: ReturnType<typeof installFetchMock>) {
  const dialog = await openEditDialog()
  typeInto(editTitleInput(dialog), 'A 编辑后的新标题')
  await submitPendingSave(dialog, mock.calls)
  expect(dialogByLabelledBy('edit-title'), 'PATCH 挂起期间编辑弹窗仍在').toBeTruthy()

  // busy 期间从弹窗内真实聚焦元素 Escape 取消 A（R53 允许），弹窗关闭。
  pressEscape()
  await flushPromises()
  expect(dialogByLabelledBy('edit-title'), 'A 弹窗已取消关闭').toBeNull()

  // B 补充：「添加补充」无 disabled，不依赖 mutationBusy；POST 经 gate 挂起。
  await openSupplementAndFill('B 的补充正文')
  await submitPendingSupplement(mock.calls)

  // PATCH 先 resolve：saveMetadata 收尾发出 GET1（挂起）；导航即时返回，Promise.all 仍等 GET1。
  mock.resolvePendingPatch()
  await flushPromises()
  await flushPromises()
  expect(mock.detailGetCount(), 'GET1（A 保存收尾）已发出并挂起').toBe(2)

  // POST 后 resolve：onSupplementCreated 发出 GET2（挂起），drawer 经 emit('close') 关闭。
  mock.resolvePendingSupplementPost()
  await flushPromises()
  await flushPromises()
  expect(mock.detailGetCount(), 'GET2（B 补充收尾）已发出并挂起').toBe(3)
  expect(mock.pendingDetailReloadCount(), '两个详情 GET 同时挂起').toBe(2)
}

describe('ItemDetailView supplement save refresh and detail GET ownership', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    // SupplementDrawer 保存路径依赖 crypto.randomUUID 生成幂等键，固定为确定值（同 saving-keyboard 惯例）。
    vi.stubGlobal('crypto', { randomUUID: () => 'supplement-idempotency-key' })
  })

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = null
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('case1 补充保存成功后焦点回到重载完成后的「添加补充」按钮（而非 BODY）', async () => {
    const mock = installFetchMock()
    await mountDetail()

    const opener = buttonByExactText('添加补充')
    opener.focus()
    opener.click()
    await flushPromises()

    typeInto(supplementTextarea(), '补充的新事实内容')
    await flushPromises()

    const saveButton = buttonByExactText('保存补充记录', supplementDrawerRoot())
    saveButton.focus()
    saveButton.click()
    await flushPromises()
    const postCount = mock.calls.filter(
      (call) => call.method === 'POST' && call.path === RAW_RECORDS_PATH,
    ).length
    expect(postCount, '补充 POST 已发出并挂起').toBe(1)

    // POST 成功（201 合法响应）：emit('created') 已同步启动 loadDetail 并置 loading=true，
    // emit('close') 关闭 drawer。
    mock.resolvePendingSupplementPost()
    await flushPromises()
    await flushPromises()
    // 环境取证：loading 骨架期间旧头部（含 opener）已被整体卸载。
    expect(opener.isConnected, '重载期间旧「添加补充」按钮已断连').toBe(false)
    expect(mock.pendingDetailReloadCount(), '详情 GET 经 gate 挂起中').toBe(1)

    // 详情 GET 晚到 resolve 为补充后快照（2 条原始记录），收尾完成。
    mock.resolveDetailReload(0, supplementedDetail())
    await flushPromises()
    await flushPromises()

    // 环境取证：重载完成后头部已重建，当前「添加补充」按钮是新元素（应绿）。
    const current = buttonByExactText('添加补充')
    expect(current, '重载后「添加补充」按钮重新出现且是新元素').not.toBe(opener)
    expect(opener.isConnected, '旧按钮仍处断连').toBe(false)
    expect(headerRawCountText(), '补充后快照渲染 2 条原始记录').toBe('知识条目 · 2 条原始记录')

    // 核心合同：焦点必须落在当前渲染的「添加补充」按钮上（docs05 弹层关闭回焦语义）。
    // R65 baseline（修复前）drawer 关闭回焦落在已卸载的旧按钮上，焦点落 BODY，曾红。
    expect(
      document.activeElement,
      '补充保存并重载完成后焦点回到当前渲染的「添加补充」按钮',
    ).toBe(current)
  })

  it('case2 详情重载挂起期间外部搜索框的有效焦点与草稿不被补充收尾抢走', async () => {
    const mock = installFetchMock()
    await mountDetail()

    await openSupplementAndFill('外部焦点期间保存的补充内容')
    await submitPendingSupplement(mock.calls)

    mock.resolvePendingSupplementPost()
    await flushPromises()
    await flushPromises()
    // 此刻详情 GET 仍挂起（loading 骨架期间），页面主内容已卸载。
    expect(mock.pendingDetailReloadCount(), '详情 GET 经 gate 挂起中').toBe(1)

    // 模拟生产中 Parent 之外始终存在的 Workspace 搜索框：测试宿主 input 直挂 document.body。
    const host = document.createElement('input')
    document.body.appendChild(host)
    host.focus()
    host.value = '外部搜索草稿'
    host.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.activeElement, '外部搜索框持有有效焦点').toBe(host)

    // 详情 GET 收尾 resolve 为补充后快照。
    mock.resolveDetailReload(0, supplementedDetail())
    await flushPromises()
    await flushPromises()

    // 既有正确行为：收尾只刷新数据，不得抢走组件外的有效焦点、不得清外部草稿。
    expect(document.activeElement, '重载收尾不得抢走外部搜索框焦点').toBe(host)
    expect(host.value, '外部草稿保持').toBe('外部搜索草稿')
    expect(headerRawCountText(), '页面正常渲染 2 条原始记录').toBe('知识条目 · 2 条原始记录')
    expect(rawHistoryButtons(), '原始记录列表 2 条').toHaveLength(2)

    host.remove()
  })

  it('case3 编辑取消与补充保存的真实并发链：晚到的旧详情 GET 不得抹掉最新补充', async () => {
    const mock = installFetchMock()
    await mountDetail()

    await runConcurrentChain(mock)

    // 乱序收尾：先 resolve 后发出的 GET2（补充后快照：2 条原始记录）。
    mock.resolveDetailReload(1, supplementedAfterEditDetail())
    await flushPromises()
    await flushPromises()
    // 环境取证（应绿）：最新快照已渲染。
    expect(headerRawCountText(), 'GET2 后显示 2 条原始记录').toBe('知识条目 · 2 条原始记录')
    expect(rawHistoryButtons(), 'GET2 后原始记录列表 2 条').toHaveLength(2)

    // 再 resolve 先发出的 GET1（A 保存后的旧快照：仅 1 条主记录）。
    mock.resolveDetailReload(0, editedBeforeSupplementDetail())
    await flushPromises()
    await flushPromises()

    // 核心合同：晚到的旧快照不得把最新加载的详情抹掉——仍应显示 2 条原始记录且补充记录仍在。
    // R65 baseline（修复前）loadDetail 无请求代次，旧 GET 直接覆盖共享 detail ref，曾红。
    expect(headerRawCountText(), '晚到旧 GET 不得覆盖最新详情').toBe('知识条目 · 2 条原始记录')
    expect(rawHistoryButtons(), '原始记录列表仍为 2 条').toHaveLength(2)
    expect(
      rawHistoryButtons().some((button) => (button.textContent ?? '').includes('补充记录')),
      '补充记录条目仍在列表中',
    ).toBe(true)
  })

  it('case4 同链 GET1 晚失败：旧失败不得把最新加载清成错误页，resolve 后无旧错误残留', async () => {
    const mock = installFetchMock()
    await mountDetail()

    await runConcurrentChain(mock)

    // GET1（已取消的 A 保存收尾）晚失败。
    mock.rejectDetailReload(0, new Error('旧保存的详情刷新失败（模拟）'))
    await flushPromises()
    await flushPromises()

    // 核心合同 A：旧失败不得把页面清成「记录暂时不可用」错误整页，也不得提前清掉最新加载的 loading。
    // R65 baseline（修复前）GET1 的 catch 会 detail=null + errorMessage 并清 loading，错误整页断言曾红；
    // loading 文案断言当时未执行到。
    expect(
      document.querySelector('.detail-state--error'),
      '晚到的旧失败不得把页面清成错误整页',
    ).toBeNull()
    expect(
      document.querySelector('.detail-state[aria-live="polite"]')?.textContent ?? '',
      'GET2 仍挂起时最新加载的 loading 文案仍在，旧 finally 不得提前清掉',
    ).toContain('正在读取记录元数据…')

    // GET2（B 补充收尾）随后成功，最新快照落地。
    mock.resolveDetailReload(1, supplementedAfterEditDetail())
    await flushPromises()
    await flushPromises()

    // 核心合同 B：页面正常显示 2 条原始记录，且页内错误条不得残留旧失败文本。
    // baseline 时此段未执行到（断言 A 先失败）；修复前 errorMessage 会残留在 .detail-notice。
    expect(headerRawCountText(), '最新快照正常渲染').toBe('知识条目 · 2 条原始记录')
    expect(rawHistoryButtons(), '原始记录列表 2 条').toHaveLength(2)
    expect(
      document.querySelector('.detail-notice[role="alert"]'),
      '旧错误不得残留在页内错误条',
    ).toBeNull()
  })
})

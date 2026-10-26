// DT-R290 集成回归：LibraryManageDrawer 跨尺寸关闭后的有效回焦。
// 抽屉打开期间视口切换会让原触发控件失效：ModuleNav 在 ≤1279（导航关闭）对整棵导航树
// inert/aria-hidden，主区 .mobile-structure 管理入口仅 ≤1099 显示，AppShell 紧凑栏
// 「资料库导航」按钮在 ≤1279 常驻可用。合同：关闭优先回原触发控件；原控件在新尺寸下
// 无法接受焦点时回当前可用的「管理目录与标签」管理入口（导航内与主区两处按文档序）；
// 两个管理入口都不可用时回紧凑栏导航按钮；打开时没有有效控件（BODY）时仍回可用管理
// 入口。只走公开 DOM 与真实 Pinia store，仅伪造外部 HTTP；jsdom 无 CSS/inert 焦点语义，
// 仅对本例中真实浏览器会拒绝聚焦的入口在其自身实例上把 focus 置为 no-op（对应
// inert/隐藏状态已在 DOM 真实呈现），恢复候选自身一律真实聚焦。未修复源码上四例的
// 回焦断言红。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import KnowledgeModuleNav from './KnowledgeModuleNav.vue'
import { useLibraryStore } from './library'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 仅伪造导航读取 GET（folders/tree 与 tags 返回空列表即可完成挂载）。
function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string) => {
      const url = String(path)
      if (url === '/api/v1/folders/tree' || url === '/api/v1/tags') {
        return Promise.resolve(jsonResponse({ items: [] }))
      }
      return Promise.resolve(jsonResponse({}))
    }),
  )
}

// 页面级入口（AppShell/WorkspaceView 生产 DOM 的最小同构）：紧凑栏导航按钮与主区移动
// 管理入口按真实文档顺序（module-nav 之后）追加到 body。
function appendPageEntries() {
  const compactBar = document.createElement('div')
  compactBar.className = 'shell__compact-bar'
  const navButton = document.createElement('button')
  navButton.type = 'button'
  navButton.setAttribute('aria-haspopup', 'dialog')
  const navLabel = document.createElement('span')
  navLabel.textContent = '资料库导航'
  navButton.appendChild(navLabel)
  compactBar.appendChild(navButton)

  const mobileStructure = document.createElement('button')
  mobileStructure.type = 'button'
  mobileStructure.className = 'mobile-structure'
  mobileStructure.setAttribute('aria-label', '管理目录与标签')

  document.body.append(compactBar, mobileStructure)
  return { navButton, mobileStructure }
}

// 模拟 ModuleNav 在 ≤1279 且导航关闭时的真实状态：整棵导航树 inert + aria-hidden。
function collapseNav(host: HTMLElement) {
  host.setAttribute('inert', '')
  host.setAttribute('aria-hidden', 'true')
}

// jsdom 不实现 inert/隐藏元素的焦点拒绝；对本例中真实浏览器会拒绝聚焦的入口，仅在其
// 实例上把 focus 置为 no-op（对应 inert/display:none 状态已在 DOM 真实呈现）。
function refuseFocus(element: HTMLElement) {
  element.focus = () => {}
}

function drawerRoot() {
  const manager = document.querySelector<HTMLElement>('.manager')
  expect(manager, '.manager dialog').toBeTruthy()
  return manager!
}

async function closeManager() {
  const closeButton = document.querySelector<HTMLButtonElement>('button[aria-label="关闭管理抽屉"]')
  expect(closeButton, '抽屉 header 关闭按钮').toBeTruthy()
  closeButton!.click()
  await flushPromises()
}

describe('LibraryManageDrawer 跨尺寸关闭回焦（DT-R290）', () => {
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

  async function mountNavWithPageEntries() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ name: 'workspace', path: '/', component: { template: '<div />' } }],
    })
    router.push('/')
    await router.isReady()
    const host = document.createElement('div')
    document.body.appendChild(host)
    wrapper = mount(KnowledgeModuleNav, { attachTo: host, global: { plugins: [router] } })
    await flushPromises()
    const { navButton, mobileStructure } = appendPageEntries()

    const manageEntry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => (button.textContent ?? '').trim() === '管理资料库结构',
    )
    expect(manageEntry, '导航内「管理资料库结构」入口').toBeTruthy()
    const desktopManageEntry = host.querySelector<HTMLButtonElement>(
      'button[aria-label="管理目录与标签"]',
    )
    expect(desktopManageEntry, '导航内桌面「管理目录与标签」入口').toBeTruthy()
    return {
      host,
      manageEntry: manageEntry!,
      desktopManageEntry: desktopManageEntry!,
      navButton,
      mobileStructure,
    }
  }

  it('宽屏打开→移动尺寸关闭：原入口随导航 inert 失效，回焦主区可见的移动管理入口', async () => {
    installFetchMock()
    const { host, manageEntry, desktopManageEntry, mobileStructure } = await mountNavWithPageEntries()

    // 1440：导航可用，从「管理资料库结构」真实聚焦打开。
    manageEntry.focus()
    manageEntry.click()
    await flushPromises()
    drawerRoot()

    // 收窄到 ≤1279 且导航关闭：整棵导航树 inert/aria-hidden，原入口与桌面管理入口在
    // 真实浏览器中都无法接受焦点；主区移动管理入口（≤1099 显示）可见。
    collapseNav(host)
    refuseFocus(manageEntry)
    refuseFocus(desktopManageEntry)

    await closeManager()

    expect(document.querySelector('.manager')).toBeNull()
    expect(document.activeElement, '回焦主区可见的移动「管理目录与标签」入口').toBe(mobileStructure)
  })

  it('移动尺寸打开→宽屏关闭：原移动入口隐藏失效，回焦导航内可见的桌面管理入口', async () => {
    installFetchMock()
    const { desktopManageEntry, mobileStructure } = await mountNavWithPageEntries()

    // 390：主区移动管理入口可见，聚焦该入口后经真实 store 打开（与生产点击同一状态位）。
    mobileStructure.focus()
    useLibraryStore().managerOpen = true
    await flushPromises()
    drawerRoot()

    // 放宽到 ≥1100：.mobile-structure 回到 display:none，真实浏览器拒绝聚焦。
    mobileStructure.style.display = 'none'
    refuseFocus(mobileStructure)

    await closeManager()

    expect(document.querySelector('.manager')).toBeNull()
    expect(document.activeElement, '回焦导航内可见的桌面「管理目录与标签」入口').toBe(desktopManageEntry)
  })

  it('中间尺寸（1100–1279）关闭：两管理入口均不可聚焦，回焦紧凑栏「资料库导航」按钮', async () => {
    installFetchMock()
    const { host, manageEntry, desktopManageEntry, mobileStructure, navButton } =
      await mountNavWithPageEntries()

    manageEntry.focus()
    manageEntry.click()
    await flushPromises()
    drawerRoot()

    // 1100–1279：导航树 inert（导航关闭）＋ 移动入口 display:none（仅 ≤1099 显示），
    // 原控件与两个管理入口都不可聚焦，现成可用入口只剩紧凑栏导航按钮。
    collapseNav(host)
    mobileStructure.style.display = 'none'
    refuseFocus(manageEntry)
    refuseFocus(desktopManageEntry)
    refuseFocus(mobileStructure)

    await closeManager()

    expect(document.querySelector('.manager')).toBeNull()
    expect(document.activeElement, '回焦紧凑栏「资料库导航」按钮').toBe(navButton)
  })

  it('打开时焦点在 BODY（无有效触发控件）：关闭仍回可用的管理入口', async () => {
    installFetchMock()
    const { desktopManageEntry } = await mountNavWithPageEntries()

    expect(document.activeElement).toBe(document.body)
    useLibraryStore().managerOpen = true
    await flushPromises()
    drawerRoot()

    await closeManager()

    expect(document.querySelector('.manager')).toBeNull()
    expect(document.activeElement, '无有效原控件时仍回焦可用管理入口').toBe(desktopManageEntry)
  })
})

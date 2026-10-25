import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { V2_TOOLS } from '../../modules/tools/toolLinks'
import ModuleNav from './ModuleNav.vue'

const TOOL_GROUP_HEADINGS = [
  'encoding-tools-heading',
  'development-tools-heading',
  'online-tools-heading',
] as const

function installMatchMedia(viewport: 'desktop' | 'compact') {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: viewport === 'compact' && query === '(max-width: 1279px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

async function createToolsRouter(initialPath: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tools', name: 'tools', component: { template: '<div />' }, meta: { module: 'tools' } },
      ...V2_TOOLS.map((tool) => ({
        path: tool.path,
        name: tool.routeName,
        component: { template: '<div />' },
        meta: { module: 'tools' },
      })),
    ],
  })
  await router.push(initialPath)
  await router.isReady()
  return router
}

function mountModuleNav(router: Awaited<ReturnType<typeof createToolsRouter>>, props: { open?: boolean } = {}) {
  return mount(ModuleNav, {
    attachTo: document.body,
    props,
    global: { plugins: [router] },
  })
}

function toolByPath(path: string) {
  const tool = V2_TOOLS.find((entry) => entry.path === path)
  if (!tool) throw new Error(`unknown tool path: ${path}`)
  return tool
}

function groupDetails(wrapper: VueWrapper, headingId: string) {
  const details = wrapper.get(`#${headingId}`).element.closest('details')
  if (!details) throw new Error(`details not found for #${headingId}`)
  return details as HTMLDetailsElement
}

function activeToolLink(wrapper: VueWrapper) {
  return wrapper.get('nav a.active')
}

function detailsOfActiveTool(wrapper: VueWrapper) {
  const details = activeToolLink(wrapper).element.closest('details')
  if (!details) throw new Error('active tool link is not inside a details group')
  return details as HTMLDetailsElement
}

// 模拟用户手动折叠分组：jsdom 支持点击 summary 切换 details，但切换方向取决于分组
// 当前是否展开（修复前“开发辅助”默认折叠，点击反而会展开）。为了让“用户已折叠该组”
// 这一前提在修复前后都成立，这里直接移除 open 属性，语义等同于用户完成了一次折叠操作。
function userCollapseGroup(details: HTMLDetailsElement) {
  details.removeAttribute('open')
}

function waitFor(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe('module nav tools navigation', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.unstubAllGlobals()
  })

  it('expands the group containing the active tool when entering a non-default group directly on desktop', async () => {
    installMatchMedia('desktop')
    const digest = toolByPath('/tools/digest')
    const router = await createToolsRouter(digest.path)
    wrapper = mountModuleNav(router)
    // 初始展开发生在 watcher 的微任务续体里，先让它落定再断言。
    await flushPromises()
    await nextTick()

    const activeLink = activeToolLink(wrapper)
    expect(activeLink.text()).toContain(digest.name)
    expect(activeLink.attributes('aria-current')).toBe('page')
    const developmentDetails = detailsOfActiveTool(wrapper)
    expect(developmentDetails).toBe(groupDetails(wrapper, 'development-tools-heading'))
    expect(developmentDetails.open).toBe(true)

    const translate = toolByPath('/tools/translate')
    await router.push(translate.path)
    await flushPromises()
    await nextTick()

    const onlineActiveLink = activeToolLink(wrapper)
    expect(onlineActiveLink.text()).toContain(translate.name)
    const onlineDetails = detailsOfActiveTool(wrapper)
    expect(onlineDetails).toBe(groupDetails(wrapper, 'online-tools-heading'))
    expect(onlineDetails.open).toBe(true)
  })

  it('re-expands a manually collapsed group when routing to another tool in the same group', async () => {
    installMatchMedia('desktop')
    const router = await createToolsRouter(toolByPath('/tools/digest').path)
    wrapper = mountModuleNav(router)
    // 先让初始展开落定，保证手动折叠发生在初始展开之后、路由跳转之前。
    await flushPromises()
    await nextTick()

    const developmentDetails = groupDetails(wrapper, 'development-tools-heading')
    userCollapseGroup(developmentDetails)
    expect(developmentDetails.open).toBe(false)

    await router.push(toolByPath('/tools/time').path)
    await flushPromises()
    await nextTick()

    expect(detailsOfActiveTool(wrapper)).toBe(developmentDetails)
    expect(developmentDetails.open).toBe(true)
  })

  it('re-expands the active tool group after the search query is cleared', async () => {
    installMatchMedia('desktop')
    const router = await createToolsRouter(toolByPath('/tools/digest').path)
    wrapper = mountModuleNav(router)

    const developmentDetails = groupDetails(wrapper, 'development-tools-heading')
    const search = wrapper.get('.module-nav__search input')

    await search.setValue('base')
    // 前提确认：既有逻辑在查询非空时强制展开三个分组。
    for (const headingId of TOOL_GROUP_HEADINGS) {
      expect(groupDetails(wrapper, headingId).open).toBe(true)
    }

    await search.setValue('')
    await nextTick()

    expect(detailsOfActiveTool(wrapper)).toBe(developmentDetails)
    expect(developmentDetails.open).toBe(true)
  })

  it('keeps a manually collapsed group collapsed while route and query stay unchanged', async () => {
    installMatchMedia('desktop')
    const router = await createToolsRouter(toolByPath('/tools/digest').path)
    wrapper = mountModuleNav(router)
    // 先让初始展开落定，避免手动折叠随后被初始展开续体撤销。
    await flushPromises()
    await nextTick()

    const developmentDetails = groupDetails(wrapper, 'development-tools-heading')
    userCollapseGroup(developmentDetails)

    await flushPromises()
    await nextTick()
    await nextTick()
    await nextTick()

    expect(developmentDetails.open).toBe(false)
  })

  it('moves the compact drawer first focus onto a link outside collapsed groups', async () => {
    installMatchMedia('compact')
    const router = await createToolsRouter(toolByPath('/tools/digest').path)
    wrapper = mountModuleNav(router, { open: false })

    // 编码与数据组默认静态展开；先模拟用户手动折叠它。
    const encodingDetails = groupDetails(wrapper, 'encoding-tools-heading')
    userCollapseGroup(encodingDetails)
    expect(encodingDetails.open).toBe(false)

    await wrapper.setProps({ open: true })
    await flushPromises()
    await nextTick()
    // 等待超过组件内 50ms 的焦点修正定时器结束。
    await waitFor(80)

    const aside = wrapper.get('aside.module-nav')
    const active = document.activeElement
    expect(active, 'drawer should move focus into the nav').not.toBe(document.body)
    expect(aside.element.contains(active)).toBe(true)
    const collapsedGroups = Array.from(aside.element.querySelectorAll('details:not([open])'))
    const offenders = collapsedGroups.filter((group) => group.contains(active))
    expect(
      offenders,
      `focused element <${active?.tagName ?? 'unknown'}> "${active?.textContent?.trim() ?? ''}" is inside a collapsed group`,
    ).toHaveLength(0)
  })
})

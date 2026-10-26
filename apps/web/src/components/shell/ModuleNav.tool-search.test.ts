import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { V2_TOOLS } from '../../modules/tools/toolLinks'
import ModuleNav from './ModuleNav.vue'

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

// 注册导航模板会渲染的全部 RouterLink 目标：工具入口与紧凑抽屉底部的帮助链接，避免路由夹具告警。
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
      { path: '/help', name: 'help', component: { template: '<div />' }, meta: { module: 'help' } },
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

function visibleToolNames(wrapper: VueWrapper) {
  return wrapper.findAll('details nav a').map((link) => link.text())
}

function groupCount(wrapper: VueWrapper, headingId: string) {
  return wrapper.get(`#${headingId} small`).text()
}

async function search(wrapper: VueWrapper, query: string) {
  await wrapper.get('.module-nav__search input').setValue(query)
  await flushPromises()
  await nextTick()
}

describe('module nav tool search by capability name', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.unstubAllGlobals()
  })

  it.each(['SHA-256', 'sha256', 'MD5'])('finds the digest tool when searching the algorithm term %s', async (term) => {
    installMatchMedia('desktop')
    wrapper = mountModuleNav(await createToolsRouter('/tools'))
    const digest = toolByPath('/tools/digest')

    await search(wrapper, term)

    expect(visibleToolNames(wrapper)).toEqual([digest.name])
    expect(groupCount(wrapper, 'development-tools-heading')).toBe('1')
    expect(groupCount(wrapper, 'encoding-tools-heading')).toBe('0')
    expect(groupCount(wrapper, 'online-tools-heading')).toBe('0')
    expect(wrapper.find('.module-nav__empty').exists()).toBe(false)
  })

  it('finds only the JSON workbench when searching JSONPath', async () => {
    installMatchMedia('desktop')
    wrapper = mountModuleNav(await createToolsRouter('/tools'))

    await search(wrapper, 'JSONPath')

    expect(visibleToolNames(wrapper)).toEqual([toolByPath('/tools/json').name])
    expect(groupCount(wrapper, 'encoding-tools-heading')).toBe('1')
    expect(wrapper.find('.module-nav__empty').exists()).toBe(false)
  })

  it('keeps name search, empty, no-match and cleared query semantics', async () => {
    installMatchMedia('desktop')
    wrapper = mountModuleNav(await createToolsRouter('/tools'))
    const allNames = V2_TOOLS.map((tool) => tool.name)

    // 空查询：全部工具可见，没有空态提示。
    expect(visibleToolNames(wrapper)).toEqual(allNames)
    expect(wrapper.find('.module-nav__empty').exists()).toBe(false)

    // 对照：按名称的大小写不敏感子串搜索是既有行为，必须继续生效。
    await search(wrapper, 'BASE')
    expect(visibleToolNames(wrapper)).toEqual([toolByPath('/tools/base64').name])

    // 无匹配：没有入口，显示空态提示。
    await search(wrapper, 'no-such-tool')
    expect(visibleToolNames(wrapper)).toEqual([])
    expect(wrapper.find('.module-nav__empty').exists()).toBe(true)

    // 清空：恢复全部工具并移除提示。
    await search(wrapper, '')
    expect(visibleToolNames(wrapper)).toEqual(allNames)
    expect(wrapper.find('.module-nav__empty').exists()).toBe(false)
  })

  it('lets the compact drawer search sha256, then navigates and closes when the match is clicked', async () => {
    installMatchMedia('compact')
    const router = await createToolsRouter('/tools')
    wrapper = mountModuleNav(router, { open: true })
    await flushPromises()
    await nextTick()
    const digest = toolByPath('/tools/digest')

    const aside = wrapper.get('aside.module-nav')
    expect(aside.classes()).toContain('module-nav--open')
    expect(aside.attributes('inert')).toBeUndefined()

    await search(wrapper, 'sha256')
    expect(visibleToolNames(wrapper)).toEqual([digest.name])

    await wrapper.get('details nav a').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe(digest.path)
    expect(wrapper.emitted('close')?.length ?? 0).toBeGreaterThanOrEqual(1)
  })
})

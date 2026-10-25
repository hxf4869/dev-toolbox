import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

import HomeView from './HomeView.vue'
import { V2_TOOLS } from '../tools/toolLinks'

async function mountHome() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: HomeView },
      { path: '/knowledge', component: { template: '<div />' } },
      { path: '/tools', component: { template: '<div />' } },
      { path: '/tools/:name', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()

  return mount(HomeView, { global: { plugins: [router] } })
}

describe('neutral home', () => {
  it('renders both peer modules without network or browser persistence writes', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch')
    const localStorageSpy = vi.spyOn(Storage.prototype, 'setItem')
    const indexedDBOpen = vi.fn()
    vi.stubGlobal('indexedDB', { open: indexedDBOpen })

    const wrapper = await mountHome()

    expect(wrapper.text()).toContain('知识与记录')
    expect(wrapper.text()).toContain('工具箱')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(localStorageSpy).not.toHaveBeenCalled()
    expect(indexedDBOpen).not.toHaveBeenCalled()
    wrapper.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps every published tool entry linked to its real route', async () => {
    const wrapper = await mountHome()

    const links = wrapper.findAll('.quick-tool')
    expect(links).toHaveLength(V2_TOOLS.length)
    for (const tool of V2_TOOLS) {
      expect(links.some((link) => (link.attributes('href') ?? '').includes(tool.path))).toBe(true)
    }
    wrapper.unmount()
  })

  it('labels each entry from tool processing metadata', async () => {
    const wrapper = await mountHome()

    const links = wrapper.findAll('.quick-tool')
    V2_TOOLS.forEach((tool, index) => {
      expect(links[index].text()).toContain(tool.processing === 'cloud' ? '含云服务' : '默认本地')
    })
    wrapper.unmount()
  })
})

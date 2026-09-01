import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

import HomeView from './HomeView.vue'

describe('neutral home', () => {
  it('renders both peer modules without network or browser persistence writes', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch')
    const localStorageSpy = vi.spyOn(Storage.prototype, 'setItem')
    const indexedDBOpen = vi.fn()
    vi.stubGlobal('indexedDB', { open: indexedDBOpen })
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

    const wrapper = mount(HomeView, { global: { plugins: [router] } })

    expect(wrapper.text()).toContain('知识与记录')
    expect(wrapper.text()).toContain('本地工具')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(localStorageSpy).not.toHaveBeenCalled()
    expect(indexedDBOpen).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

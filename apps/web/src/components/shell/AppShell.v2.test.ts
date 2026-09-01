import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import AppShell from './AppShell.vue'

function installCompactMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query === '(max-width: 1279px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

describe('responsive application shell', () => {
  beforeEach(() => installCompactMatchMedia())

  it('moves focus into the compact module drawer and returns it on Escape', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/tools', name: 'tools', component: { template: '<div>tools</div>' }, meta: { module: 'tools' } },
        { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
      ],
    })
    await router.push('/tools')
    await router.isReady()
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: { plugins: [createPinia(), router] },
    })
    const trigger = wrapper.get('.shell__compact-bar button')
    ;(trigger.element as HTMLElement).focus()
    expect(document.activeElement).toBe(trigger.element)
    await trigger.trigger('click')
    await nextTick()
    await nextTick()

    const dialog = wrapper.get('aside[role="dialog"]')
    expect(dialog.classes()).toContain('module-nav--open')
    expect(document.activeElement).toBe(dialog.element.querySelector('.module-nav__content a'))

    await dialog.trigger('keydown', { key: 'Escape' })
    await nextTick()
    await nextTick()
    await flushPromises()

    expect(dialog.classes()).not.toContain('module-nav--open')
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })
})

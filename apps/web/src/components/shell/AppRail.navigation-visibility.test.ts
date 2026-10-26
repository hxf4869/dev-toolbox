// R297-C 回归：手机（≤720px）全局导航横向滚动时，当前 aria-current 入口在初始挂载、
// 当前入口随路由变化、nav 实际宽度变化导致裁切时被滚入本 nav 可见范围；只改该 nav
// 自身 scrollLeft，不滚动页面/主内容、不抢焦点；入口已完整可见，或同入口下用户手动
// 横向浏览、模块内路由切换时不得强制拉回。
// jsdom 无真实布局：这里只为 nav[aria-label="全局导航"] 与其中链接的测量方法提供局部
// 受控几何夹具，不 mock 全局 DOM 可见性。数字复刻 Root 在 390×844 的实测：nav left=56
// / width=238 / scrollWidth=260，“设置”入口位于滚动坐标 [220,260]（宽 40）。
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import AppRail from './AppRail.vue'

const ITEM_WIDTH = 40
const ITEM_GAP = 4
// 六个条目与 AppRail.links 一一对应；总内容宽 6*40+5*4=260，对齐实测 scrollWidth。
const SCROLL_ITEMS = Array.from({ length: 6 }, (_, index) => ({
  left: index * (ITEM_WIDTH + ITEM_GAP),
  width: ITEM_WIDTH,
}))

interface NavGeometry {
  navLeft: number
  navWidth: number
  scrollWidth: number
  items: Array<{ left: number; width: number }>
}

function installNavGeometry(nav: HTMLElement, links: HTMLElement[], geometry: NavGeometry) {
  let scrollLeft = 0
  const clamp = (value: number) => Math.max(0, Math.min(value, geometry.scrollWidth - geometry.navWidth))

  Object.defineProperty(nav, 'clientWidth', { configurable: true, get: () => geometry.navWidth })
  Object.defineProperty(nav, 'scrollWidth', { configurable: true, get: () => geometry.scrollWidth })
  Object.defineProperty(nav, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = clamp(value)
    },
  })
  Object.defineProperty(nav, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: geometry.navLeft,
      y: 0,
      top: 0,
      left: geometry.navLeft,
      right: geometry.navLeft + geometry.navWidth,
      bottom: 44,
      width: geometry.navWidth,
      height: 44,
    }),
  })
  links.forEach((link, index) => {
    const item = geometry.items[index]
    if (!item) return
    Object.defineProperty(link, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const left = geometry.navLeft + item.left - scrollLeft
        return { x: left, y: 0, top: 0, left, right: left + item.width, bottom: 44, width: item.width, height: 44 }
      },
    })
  })

  return {
    userScrollTo: (value: number) => {
      scrollLeft = clamp(value)
    },
    setNavWidth: (navWidth: number) => {
      geometry.navWidth = navWidth
    },
  }
}

let resizeCallbacks: Array<() => void> = []

class StubResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' }, meta: { module: 'home' } },
      { path: '/knowledge', component: { template: '<div />' }, meta: { module: 'knowledge' } },
      { path: '/assistant', component: { template: '<div />' }, meta: { module: 'assistant' } },
      { path: '/tools', component: { template: '<div />' }, meta: { module: 'tools' } },
      { path: '/ai/tasks', component: { template: '<div />' }, meta: { module: 'ai' } },
      { path: '/help', component: { template: '<div />' }, meta: { module: 'help' } },
      {
        path: '/settings/providers',
        name: 'provider-settings',
        component: { template: '<div />' },
        meta: { module: 'settings' },
      },
      {
        path: '/settings/security',
        name: 'security-settings',
        component: { template: '<div />' },
        meta: { module: 'settings' },
      },
    ],
  })
}

async function mountRail(path: string, options: { navWidth?: number } = {}) {
  const router = createTestRouter()
  await router.push(path)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(AppRail, {
    attachTo: document.body,
    global: { plugins: [pinia, router] },
  })
  const nav = wrapper.get('nav[aria-label="全局导航"]').element as HTMLElement
  const links = wrapper
    .findAll('nav[aria-label="全局导航"] .rail__item')
    .map((link) => link.element as HTMLElement)
  const geometry = installNavGeometry(nav, links, {
    navLeft: 56,
    navWidth: options.navWidth ?? 238,
    scrollWidth: 260,
    items: SCROLL_ITEMS,
  })
  return { wrapper, nav, geometry, router }
}

function expectCurrentEntryVisible(nav: HTMLElement) {
  const navRect = nav.getBoundingClientRect()
  const entryRect = nav.querySelector('a[aria-current="page"]')?.getBoundingClientRect()
  expect(entryRect, '当前入口存在 aria-current="page"').toBeDefined()
  expect(entryRect!.left).toBeGreaterThanOrEqual(navRect.left)
  expect(entryRect!.right).toBeLessThanOrEqual(navRect.right)
}

describe('AppRail 手机全局导航当前入口完整可见', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    resizeCallbacks = []
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('初始路由命中被裁切的“设置”入口时，挂载后把它滚入 nav 可见范围，只滚动该 nav，不滚动页面、不抢焦点', async () => {
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const mounted = await mountRail('/settings/providers')
    wrapper = mounted.wrapper

    await flushPromises()

    expect(mounted.nav.scrollLeft, '设置入口 [220,260] 右缘对齐 238px 可视宽').toBe(22)
    expectCurrentEntryVisible(mounted.nav)
    expect(document.activeElement).toBe(document.body)
    expect(scrollToSpy).not.toHaveBeenCalled()
    expect(window.pageYOffset).toBe(0)
  })

  it('当前入口随路由从工作台切到设置后被滚入可见范围', async () => {
    const mounted = await mountRail('/')
    wrapper = mounted.wrapper
    await flushPromises()
    expect(mounted.nav.scrollLeft, '工作台入口 [0,40] 已完整可见，初始不滚').toBe(0)

    await mounted.router.push('/settings/providers')
    await flushPromises()

    expect(mounted.nav.scrollLeft).toBe(22)
    expectCurrentEntryVisible(mounted.nav)
  })

  it('nav 可视宽度收缩把当前入口裁出后，经宽度变化把它滚回可见范围', async () => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    const mounted = await mountRail('/settings/providers', { navWidth: 260 })
    wrapper = mounted.wrapper
    await flushPromises()
    expect(mounted.nav.scrollLeft, '宽度足够、无裁切时不滚动').toBe(0)

    mounted.geometry.setNavWidth(238)
    resizeCallbacks.forEach((fire) => fire())
    await flushPromises()

    expect(mounted.nav.scrollLeft).toBe(22)
    expectCurrentEntryVisible(mounted.nav)
  })

  it('入口已可见后，同入口手动横向浏览与模块内路由切换都不强制拉回', async () => {
    const mounted = await mountRail('/settings/providers')
    wrapper = mounted.wrapper
    await flushPromises()
    expect(mounted.nav.scrollLeft).toBe(22)

    mounted.geometry.userScrollTo(0)
    await flushPromises()
    expect(mounted.nav.scrollLeft, '同入口下用户手动横向浏览不被拉回').toBe(0)

    await mounted.router.push('/settings/security')
    await flushPromises()
    expect(mounted.nav.scrollLeft, '模块内路由切换不改变当前入口，不拉回').toBe(0)
    expect(document.activeElement).toBe(document.body)
  })
})

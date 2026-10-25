// R280 回归：路由懒加载资源失败（如网关替换后旧 bundle 请求已被移除的 CSS）时，
// 当前页面与未保存输入保持原样，仅显示全局 role=alert 与同源完整加载入口；
// 不自动刷新、不重放导航、不泄露原始错误与资源地址；成功导航清除提示；
// 较早 pending 的失败晚于新成功导航触发时不产生陈旧提示；
// duplicated/被取消导航不误报；卸载移除本组件注册的 router hooks；
// 双斜杠 fullPath 不得经原生 anchor href 逃逸为协议相对的外部地址。
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  createMemoryHistory,
  createRouter,
  isNavigationFailure,
  NavigationFailureType,
  type Router,
  type RouteRecordRaw,
} from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App.vue'
import { useAuthStore } from './auth'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const authenticatedSession = () =>
  jsonResponse(200, {
    status: 'authenticated',
    owner: { id: 'owner-1', username: 'owner' },
    session: { id: 'session-r280', expiresAt: '2099-01-01T00:00:00Z' },
    csrfToken: 'csrf-r280',
  })

function installDesktopMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

// 可控的懒加载 route component：导航触发加载后由测试显式 reject，模拟 preload 失败。
function failingLoader() {
  const rejections: Array<(error: Error) => void> = []
  return {
    rejections,
    component: () =>
      new Promise<never>((_, reject) => {
        rejections.push(reject)
      }),
  }
}

// 可结算的懒加载 route component：导航被取代后旧 import 仍需结束，push 才会
// 以 resolved 的 NavigationFailure(cancelled) 收场（当前 vue-router 5.3.0 实测）。
function resolvableLoader(template: string) {
  let settle!: (value: never) => void
  const component = () =>
    new Promise<never>((resolve) => {
      settle = resolve
    })
  return { component, settle: () => settle({ template } as never) }
}

function buildRouter(routes: RouteRecordRaw[]) {
  return createRouter({ history: createMemoryHistory(), routes })
}

async function mountAuthenticatedApp(router: Router) {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(authenticatedSession()))
  const wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [pinia, router] },
  })
  await flushPromises()
  expect(useAuthStore().isAuthenticated).toBe(true)
  return wrapper
}

describe('App 路由懒加载失败恢复入口', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => installDesktopMatchMedia())

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    window.localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('懒加载失败保留旧页与未保存输入，显示同源 role=alert 恢复链接，不泄露错误细节也不自动导航', async () => {
    const bad = failingLoader()
    const router = buildRouter([
      {
        path: '/form',
        component: { template: '<main><input type="text" aria-label="草稿输入" /></main>' },
        meta: { module: 'home' },
      },
      { path: '/bad', component: bad.component, meta: { module: 'home' } },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
    ])
    await router.push('/form')
    await router.isReady()
    wrapper = await mountAuthenticatedApp(router)

    const input = wrapper.get('input[aria-label="草稿输入"]')
    await input.setValue('未保存的合成草稿')

    const pending = router.push('/bad?draft=1#section')
    pending.catch(() => {})
    await flushPromises()
    expect(bad.rejections.length).toBe(1)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    bad.rejections[0](new Error('Unable to preload CSS for /assets/HelpView-8ac3f2.css'))
    await flushPromises()

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('页面未能打开')
    expect(alert.text()).not.toContain('Unable to preload')
    expect(alert.text()).not.toContain('HelpView')
    expect(alert.text()).not.toContain('.css')

    const link = alert.get('a')
    expect((link.element as HTMLElement).tagName).toBe('A')
    expect(link.attributes('href')).toBe(`${window.location.origin}/bad?draft=1#section`)
    expect(new URL(link.attributes('href') ?? '').origin).toBe(window.location.origin)

    // 失败不产生自动导航或重放：路由与旧页面输入保持原样。
    expect(router.currentRoute.value.fullPath).toBe('/form')
    const keptInput = wrapper.get('input[aria-label="草稿输入"]') as unknown as {
      element: HTMLInputElement
    }
    expect(keptInput.element.value).toBe('未保存的合成草稿')
    await expect(pending).rejects.toBeInstanceOf(Error)
  })

  it('成功导航清除提示，且较早 pending 的失败在新导航成功后触发时不产生陈旧提示', async () => {
    const badImmediate = failingLoader()
    const badStale = failingLoader()
    const router = buildRouter([
      { path: '/form', component: { template: '<main>form-page</main>' }, meta: { module: 'home' } },
      { path: '/bad-immediate', component: badImmediate.component, meta: { module: 'home' } },
      { path: '/bad-stale', component: badStale.component, meta: { module: 'home' } },
      { path: '/ok', component: { template: '<main>ok-page</main>' }, meta: { module: 'home' } },
    ])
    await router.push('/form')
    await router.isReady()
    wrapper = await mountAuthenticatedApp(router)

    const p1 = router.push('/bad-immediate')
    p1.catch(() => {})
    await flushPromises()
    badImmediate.rejections[0](new Error('Unable to preload CSS for /assets/A-1.css'))
    await flushPromises()
    expect(wrapper.get('[role="alert"]').get('a').attributes('href')).toBe(
      `${window.location.origin}/bad-immediate`,
    )

    // 先挂起第二个坏导航，再用成功导航取代它。
    const p2 = router.push('/bad-stale')
    p2.catch(() => {})
    await flushPromises()
    expect(badStale.rejections.length).toBe(1)

    await router.push('/ok')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/ok')
    expect(wrapper.text()).toContain('ok-page')

    // 较早的异步加载此刻才失败：不得复活提示或覆盖新页面。
    badStale.rejections[0](new Error('Unable to preload CSS for /assets/B-2.css'))
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('ok-page')
    expect(router.currentRoute.value.fullPath).toBe('/ok')
  })

  it('首个直接目标在 auth.bootstrap 完成前失败仍被捕获，认证完成后可见恢复提示', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    let releaseSession!: (response: Response) => void
    const sessionGate = new Promise<Response>((resolve) => {
      releaseSession = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => sessionGate))

    const badInitial = failingLoader()
    const history = createMemoryHistory()
    history.replace('/bad-initial')
    const router = createRouter({
      history,
      routes: [
        { path: '/bad-initial', component: badInitial.component, meta: { module: 'home' } },
        { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
      ],
    })

    // 真实首次导航：只预置地址，由 mount 安装 router 时自动发起第一次导航；
    // 此刻 auth.bootstrap 尚未返回，App setup 注册的 hooks 必须已能捕获该失败。
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia, router] } })
    await flushPromises()
    expect(badInitial.rejections.length).toBe(1)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    badInitial.rejections[0](new Error('Unable to preload CSS for /assets/Initial-3.css'))
    await flushPromises()
    // 已捕获（hooks 在 App setup 生效，而非等待认证成功），但壳层未挂载、暂不可见。
    expect(useAuthStore().stage).toBe('checking')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    releaseSession(authenticatedSession())
    await flushPromises()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('页面未能打开')
    expect(alert.get('a').attributes('href')).toBe(`${window.location.origin}/bad-initial`)
    // 首次导航失败后停留在起始位置，没有自动重放或改道。
    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it('duplicated 与被取消导航不误报，卸载移除本组件注册的 router hooks', async () => {
    const slow = resolvableLoader('<main>slow-page</main>')
    const router = buildRouter([
      { path: '/stay', component: { template: '<main>stay-page</main>' }, meta: { module: 'home' } },
      { path: '/next', component: { template: '<main>next-page</main>' }, meta: { module: 'home' } },
      { path: '/slow', component: slow.component, meta: { module: 'home' } },
    ])
    await router.push('/stay')
    await router.isReady()

    // 只观察卸载清理：包装注册方法但仍调用真实实现，仅在返回的移除函数被调用时记录。
    const removedHooks: string[] = []
    for (const kind of ['beforeEach', 'afterEach', 'onError'] as const) {
      const register = (
        router as unknown as Record<string, (guard: never) => () => void>
      )[kind].bind(router)
      ;(router as unknown as Record<string, unknown>)[kind] = (guard: never) => {
        const remove = register(guard)
        return () => {
          removedHooks.push(kind)
          remove()
        }
      }
    }

    wrapper = await mountAuthenticatedApp(router)

    await router.push('/stay')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    const cancelled = router.push('/slow')
    await flushPromises()
    await router.push('/next')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/next')

    // 旧 import 结束后，被取代的导航以 resolved 的 cancelled 失败收场：不是加载错误，不得提示。
    slow.settle()
    const outcome = await cancelled
    expect(isNavigationFailure(outcome)).toBe(true)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/next')

    wrapper.unmount()
    wrapper = undefined
    expect([...removedHooks].sort()).toEqual(['afterEach', 'beforeEach', 'onError'])
    await router.push('/stay')
  })

  it('双斜杠目标的恢复链接仍是同源地址，不会生成外部导航', async () => {
    const catchAll = failingLoader()
    const router = buildRouter([
      { path: '/', component: { template: '<main>home-page</main>' }, meta: { module: 'home' } },
      { path: '/:pathMatch(.*)*', component: catchAll.component, meta: { module: 'not-found' } },
    ])
    await router.push('/')
    await router.isReady()
    wrapper = await mountAuthenticatedApp(router)

    const pending = router.push('//outside.invalid/help')
    pending.catch(() => {})
    await flushPromises()
    expect(catchAll.rejections.length).toBe(1)

    catchAll.rejections[0](
      new Error('Failed to fetch dynamically imported module https://outside.invalid/assets/x.js'),
    )
    await flushPromises()

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).not.toContain('outside.invalid')
    expect(alert.text()).not.toContain('dynamically imported')
    const href = alert.get('a').attributes('href') ?? ''
    expect(href).toBe(`${window.location.origin}//outside.invalid/help`)
    const parsed = new URL(href)
    expect(parsed.origin).toBe(window.location.origin)
    expect(parsed.host).not.toBe('outside.invalid')
    expect(parsed.pathname).toBe('//outside.invalid/help')
    expect(window.location.host).not.toBe('outside.invalid')
    await expect(pending).rejects.toBeInstanceOf(Error)
  })

  it('挂起坏加载期间重复点击当前页（duplicated）不得让随后的失败复活提示；之后真正最新的坏导航仍显示恢复链接', async () => {
    const badHelp = failingLoader()
    const router = buildRouter([
      {
        path: '/form',
        component: { template: '<main><input type="text" aria-label="草稿输入" /></main>' },
        meta: { module: 'home' },
      },
      { path: '/bad-help', component: badHelp.component, meta: { module: 'home' } },
    ])
    await router.push('/form')
    await router.isReady()
    wrapper = await mountAuthenticatedApp(router)
    await wrapper.get('input[aria-label="草稿输入"]').setValue('未保存的合成草稿')

    const pendingHelp = router.push('/bad-help')
    pendingHelp.catch(() => {})
    await flushPromises()
    expect(badHelp.rejections.length).toBe(1)

    // 再点当前页链接：duplicated 由 router 上游结算，不经过 beforeEach。
    const duplicated = await router.push('/form')
    expect(isNavigationFailure(duplicated, NavigationFailureType.duplicated)).toBe(true)

    // 用户已放弃帮助页；它此刻才失败，不得复活指向已放弃页面的提示。
    badHelp.rejections[0](new Error('Unable to preload CSS for /assets/HelpView-dup1.css'))
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/form')
    expect((wrapper.get('input[aria-label="草稿输入"]').element as HTMLInputElement).value).toBe(
      '未保存的合成草稿',
    )
    await expect(pendingHelp).rejects.toBeInstanceOf(Error)

    // 之后真正最新的坏导航仍必须提示：不能靠永久吞掉错误取巧。
    const pendingAgain = router.push('/bad-help')
    pendingAgain.catch(() => {})
    await flushPromises()
    expect(badHelp.rejections.length).toBe(2)
    badHelp.rejections[1](new Error('Unable to preload CSS for /assets/HelpView-dup2.css'))
    await flushPromises()
    expect(wrapper.get('[role="alert"]').get('a').attributes('href')).toBe(
      `${window.location.origin}/bad-help`,
    )
    expect(router.currentRoute.value.fullPath).toBe('/form')
    await expect(pendingAgain).rejects.toBeInstanceOf(Error)
  })
})

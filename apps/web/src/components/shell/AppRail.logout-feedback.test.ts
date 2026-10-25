// R74 回归：顶栏“退出登录”失败（非 401 的 ApiError 与网络 TypeError 两条路径）需要
// 局部可见的 role=alert 反馈、保持当前认证、按钮解锁且不自动重试、支持手动重试，
// 并由组件自身处理错误（不进入 app errorHandler，即不产生未处理的事件处理 rejection）。
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import AppRail from './AppRail.vue'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AppRail 顶栏退出失败反馈', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('退出 POST 返回 503 时显示可读 role=alert、保持登录、按钮解锁且不自动重发；再次手动点击时挂起禁用并清除旧错误，204 后自然清除会话', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    let releaseLogout!: (response: Response) => void
    const logoutGate = new Promise<Response>((resolve) => {
      releaseLogout = resolve
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'owner' },
          session: { id: 'session-a', expiresAt: '2099-09-06T00:00:00Z' },
          csrfToken: 'csrf-a',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(503, { error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' } }),
      )
      .mockImplementationOnce(() => logoutGate)
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    expect(auth.stage).toBe('authenticated')

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: { template: '<div>home</div>' }, meta: { module: 'home' } },
      ],
    })
    await router.push('/')
    await router.isReady()

    const errorHandler = vi.fn()
    wrapper = mount(AppRail, {
      attachTo: document.body,
      global: { plugins: [pinia, router], config: { errorHandler } },
    })

    const logoutButton = wrapper.get('button[aria-label="退出登录"]')
    expect(logoutButton.attributes('disabled')).toBeUndefined()
    expect(logoutButton.text()).toContain('退出登录')

    ;(logoutButton.element as HTMLButtonElement).focus()
    await logoutButton.trigger('click')
    await flushPromises()

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/logout')
    const failure = wrapper.find('[role="alert"]')
    expect(failure.exists()).toBe(true)
    expect(failure.text()).toContain('服务暂时不可用，请稍后重试')
    expect(failure.text()).not.toContain('ApiError')
    expect(failure.text()).not.toContain('SERVICE_UNAVAILABLE')
    expect(auth.stage).toBe('authenticated')
    expect(auth.session?.id).toBe('session-a')
    expect(auth.csrfToken).toBe('csrf-a')
    expect(logoutButton.attributes('disabled')).toBeUndefined()
    expect(logoutButton.text()).toContain('退出登录')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(errorHandler).not.toHaveBeenCalled()

    ;(logoutButton.element as HTMLButtonElement).focus()
    await logoutButton.trigger('click')
    await nextTick()

    expect(logoutButton.attributes('disabled')).toBeDefined()
    expect(logoutButton.text()).toContain('正在退出')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    releaseLogout(new Response(null, { status: 204 }))
    await flushPromises()

    expect(auth.stage).toBe('anonymous')
    expect(auth.session).toBeNull()
    expect(auth.csrfToken).toBe('')
    expect(logoutButton.attributes('disabled')).toBeUndefined()
    expect(errorHandler).not.toHaveBeenCalled()
  })

  it('退出遇到 TypeError 网络失败时显示可理解的本地提示、保持登录、按钮解锁、不自动重试，且错误由组件处理不成为未处理事件 rejection', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'owner' },
          session: { id: 'session-a', expiresAt: '2099-09-06T00:00:00Z' },
          csrfToken: 'csrf-a',
        }),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    expect(auth.stage).toBe('authenticated')

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: { template: '<div>home</div>' }, meta: { module: 'home' } },
      ],
    })
    await router.push('/')
    await router.isReady()

    const errorHandler = vi.fn()
    wrapper = mount(AppRail, {
      attachTo: document.body,
      global: { plugins: [pinia, router], config: { errorHandler } },
    })

    const logoutButton = wrapper.get('button[aria-label="退出登录"]')
    ;(logoutButton.element as HTMLButtonElement).focus()
    await logoutButton.trigger('click')
    await flushPromises()

    const failure = wrapper.find('[role="alert"]')
    expect(failure.exists()).toBe(true)
    expect(failure.text()).not.toContain('Failed to fetch')
    expect(failure.text()).not.toContain('TypeError')
    expect(failure.text()).not.toContain('    at ')
    expect(failure.text()).toMatch(/网络/)
    expect(auth.stage).toBe('authenticated')
    expect(auth.session?.id).toBe('session-a')
    expect(auth.csrfToken).toBe('csrf-a')
    expect(logoutButton.attributes('disabled')).toBeUndefined()
    expect(logoutButton.text()).toContain('退出登录')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(errorHandler).not.toHaveBeenCalled()

    const dismissButton = wrapper.get('button[aria-label="关闭退出失败提示"]')
    ;(dismissButton.element as HTMLButtonElement).focus()
    await dismissButton.trigger('click')
    await nextTick()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(document.activeElement).toBe(logoutButton.element)
    expect(auth.stage).toBe('authenticated')
    expect(auth.session?.id).toBe('session-a')
    expect(auth.csrfToken).toBe('csrf-a')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(errorHandler).not.toHaveBeenCalled()
  })
})

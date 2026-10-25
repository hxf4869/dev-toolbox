import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import AuthView from './AuthView.vue'

const SYNTHETIC_PASSWORD = 'synthetic-owner-password'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

// 提交按钮文案随 busy 切换，按稳定的 primary variant 定位表单主按钮。
function findPrimarySubmit() {
  return document.querySelector<HTMLButtonElement>('form .button--primary')
}

// 等待 v-model 更新渲染进 DOM 后，用真实可用的主按钮原生 click 提交表单。
async function submitFormOfPrimary() {
  await flushPromises()
  const primary = findPrimarySubmit()
  expect(primary).toBeInstanceOf(HTMLButtonElement)
  expect(primary!.disabled).toBe(false)
  primary!.click()
  await flushPromises()
}

// 恢复入口按文案契约定位，再断言 ghost variant 与原生 type。
function findRestartButton() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === '重新输入密码',
  )
}

describe('AuthView MFA「重新输入密码」恢复入口', () => {
  let wrapper: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('challenge 失效后「重新输入密码」回到密码表单并可用新 challenge 完成登录', async () => {
    const challengeA = {
      status: 'mfa_required',
      challengeId: 'challenge-a',
      expiresAt: '2030-01-01T00:05:00Z',
    }
    const challengeB = {
      status: 'mfa_required',
      challengeId: 'challenge-b',
      expiresAt: '2030-02-02T00:05:00Z',
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }))
      .mockResolvedValueOnce(jsonResponse(202, challengeA))
      .mockResolvedValueOnce(
        jsonResponse(401, { error: { code: 'AUTH_INVALID_CREDENTIALS', message: '凭据无效或已过期' } }),
      )
      .mockResolvedValueOnce(jsonResponse(202, challengeB))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'ops-owner' },
          session: { id: 'session-restart-1', expiresAt: '2030-02-02T01:00:00Z' },
          csrfToken: 'csrf-restart',
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    wrapper = mount(AuthView, { attachTo: document.body })
    // AuthView 自身不触发 bootstrap（应用入口职责），由真实 store action 驱动。
    await auth.bootstrap()
    await flushPromises()

    // 用户名从默认 'owner' 改为非默认合成账号，密码为合成值。
    setInputValue(document.querySelector<HTMLInputElement>('input[name="username"]')!, 'ops-owner')
    setInputValue(document.querySelector<HTMLInputElement>('input[name="password"]')!, SYNTHETIC_PASSWORD)
    await submitFormOfPrimary()
    await flushPromises()

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/login')
    const [, loginInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(String(loginInit.body))).toEqual({ username: 'ops-owner', password: SYNTHETIC_PASSWORD })
    expect(document.querySelector('#mfa-title')).not.toBeNull()
    expect(auth.challengeExpiresAt).toBe(challengeA.expiresAt)

    // 第一轮 TOTP 被拒：停留 MFA，challenge 不自动重试或重置。
    setInputValue(document.querySelector<HTMLInputElement>('.code-input')!, '123456')
    await submitFormOfPrimary()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(document.querySelector('.notice--error')?.textContent).toContain('凭据无效或已过期')
    expect(document.querySelector('#mfa-title')).not.toBeNull()
    expect(auth.challengeExpiresAt).toBe(challengeA.expiresAt)

    // 清空验证码后主按钮因 !code 禁用，恢复入口仍可点击。
    setInputValue(document.querySelector<HTMLInputElement>('.code-input')!, '')
    await flushPromises()
    expect(findPrimarySubmit()!.disabled).toBe(true)
    const restart = findRestartButton()
    expect(restart).toBeInstanceOf(HTMLButtonElement)
    expect(restart!.classList.contains('button--ghost')).toBe(true)
    expect(restart!.type).toBe('button')
    restart!.click()
    await flushPromises()

    // 回到密码表单：旧错误与验证码清除、用户名保留、焦点回到密码框，且不发任何新请求。
    const passwordInput = document.querySelector<HTMLInputElement>('input[name="password"]')
    expect(document.querySelector('#login-title')).not.toBeNull()
    expect(passwordInput).not.toBeNull()
    expect(passwordInput!.value).toBe('')
    expect(document.querySelector<HTMLInputElement>('input[name="username"]')!.value).toBe('ops-owner')
    expect(document.querySelector('.notice--error')).toBeNull()
    expect(document.querySelector('.code-input')).toBeNull()
    expect(document.activeElement).toBe(passwordInput)
    expect(auth.challengeExpiresAt).toBe('')
    expect(auth.isAuthenticated).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((url) => url.includes('logout'))).toBe(false)
    expect(urls.filter((url) => url === '/api/v1/auth/session')).toHaveLength(1)

    // 新一轮登录拿到新 challenge，第二次 verify 必须携带新 challengeId 与新验证码。
    setInputValue(passwordInput!, SYNTHETIC_PASSWORD)
    await submitFormOfPrimary()
    await flushPromises()
    expect(auth.challengeExpiresAt).toBe(challengeB.expiresAt)

    setInputValue(document.querySelector<HTMLInputElement>('.code-input')!, '654321')
    await submitFormOfPrimary()
    await flushPromises()

    const [, verifyInit] = fetchMock.mock.calls[4] as [string, RequestInit]
    const verifyBody = JSON.parse(String(verifyInit.body)) as { challengeId: string; code: string }
    expect(verifyBody.challengeId).toBe('challenge-b')
    expect(verifyBody.code).toBe('654321')
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.session?.id).toBe('session-restart-1')
    expect(document.querySelector('#mfa-title')).toBeNull()
    expect(document.querySelector('.code-input')).toBeNull()
  })

  it('busy 期间恢复入口原生 disabled，挂起请求结束后解锁', async () => {
    let releaseVerify!: (response: Response) => void
    const verifyGate = new Promise<Response>((resolve) => {
      releaseVerify = resolve
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }))
      .mockResolvedValueOnce(
        jsonResponse(202, {
          status: 'mfa_required',
          challengeId: 'challenge-a',
          expiresAt: '2030-01-01T00:05:00Z',
        }),
      )
      // verify 响应用受控 gate 挂起，才能观察 busy 期间的真实 DOM 状态。
      .mockImplementationOnce(() => verifyGate)
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    wrapper = mount(AuthView, { attachTo: document.body })
    await auth.bootstrap()
    await flushPromises()

    setInputValue(document.querySelector<HTMLInputElement>('input[name="password"]')!, SYNTHETIC_PASSWORD)
    await submitFormOfPrimary()
    await flushPromises()

    setInputValue(document.querySelector<HTMLInputElement>('.code-input')!, '246813')
    await submitFormOfPrimary()
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const restartDuringBusy = findRestartButton()
    expect(restartDuringBusy).toBeInstanceOf(HTMLButtonElement)
    expect(restartDuringBusy!.classList.contains('button--ghost')).toBe(true)
    expect(restartDuringBusy!.type).toBe('button')
    expect(restartDuringBusy!.disabled).toBe(true)
    // 原生行为：disabled 表单控件的 click 不派发事件。
    restartDuringBusy!.click()
    await flushPromises()

    expect(document.querySelector('#mfa-title')).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(auth.challengeExpiresAt).toBe('2030-01-01T00:05:00Z')

    releaseVerify(
      jsonResponse(401, { error: { code: 'AUTH_INVALID_CREDENTIALS', message: '凭据无效或已过期' } }),
    )
    await flushPromises()

    expect(document.querySelector('.notice--error')?.textContent).toContain('凭据无效或已过期')
    const restartAfterBusy = findRestartButton()
    expect(restartAfterBusy).toBeInstanceOf(HTMLButtonElement)
    expect(restartAfterBusy!.disabled).toBe(false)
  })
})

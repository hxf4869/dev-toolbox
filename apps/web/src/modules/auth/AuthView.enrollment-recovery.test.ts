// 装置复刻 AuthView.mfa-restart.test.ts（R84）：真实 Pinia、attachTo document.body、stubGlobal(fetch) 与原生事件驱动；全部凭据、challenge 与 provisioning 均为合成数据。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import AuthView from './AuthView.vue'

const SYNTHETIC_PASSWORD = 'synthetic-owner-password'

const SYNTHETIC_PROVISIONING = {
  manualKey: 'JBSWY3DPEHPK3PXP',
  provisioningUri: 'otpauth://totp/dev-toolbox:owner?secret=JBSWY3DPEHPK3PXP',
  qrCodeDataUrl: 'data:image/png;base64,c3ludGhldGlj',
}

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

// 操作行按钮按「文案 + ghost class + 原生 type」的公开 DOM 契约定位（复刻 R84 findRestartButton 模式）。
function findGhostButton(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === text,
  )
}

function buttonsByText(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(
    (button) => button.textContent?.trim() === text,
  )
}

describe('AuthView TOTP 绑定加载/失败/失效恢复闭环', () => {
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

  it('初次绑定：setup 挂起释放为 500 后手动重取同一 challenge，confirm 失效后重新输入密码', async () => {
    let releaseSetup!: (response: Response) => void
    const setupGate = new Promise<Response>((resolve) => {
      releaseSetup = resolve
    })
    let setupCallCount = 0
    // 按 URL 分发：初次自动 setup 用受控 gate 挂起并释放为 500，手动重试固定返回 200 provisioning，
    // 使「挂起 → 500 → 手动重试 200」三步与请求顺序解耦、可精确断言；未知 URL 直接抛错。
    const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      switch (url) {
        case '/api/v1/auth/session':
          return Promise.resolve(
            jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }),
          )
        case '/api/v1/auth/login':
          return Promise.resolve(
            jsonResponse(202, {
              status: 'mfa_setup_required',
              challengeId: 'enroll-challenge-1',
              expiresAt: '2030-01-01T00:05:00Z',
            }),
          )
        case '/api/v1/auth/totp/setup':
          setupCallCount += 1
          return setupCallCount === 1
            ? setupGate
            : Promise.resolve(jsonResponse(200, SYNTHETIC_PROVISIONING))
        case '/api/v1/auth/totp/confirm':
          return Promise.resolve(
            jsonResponse(401, { error: { code: 'AUTH_INVALID_CREDENTIALS', message: '凭据无效或已过期' } }),
          )
        default:
          throw new Error(`未预期的请求：${url}`)
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    wrapper = mount(AuthView, { attachTo: document.body })
    await auth.bootstrap()
    await flushPromises()

    // 用户名保留默认 'owner'，密码为合成值；密码登录进入 totp_setup。
    setInputValue(document.querySelector<HTMLInputElement>('input[name="password"]')!, SYNTHETIC_PASSWORD)
    await submitFormOfPrimary()

    // 自动 setup 挂起期间：loading 保持可见（submitLogin finally 不清 busy），操作行按钮渲染但被 busy 锁定。
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(document.querySelector('.enrollment__loading')).not.toBeNull()
    const retryDuringBusy = findGhostButton('重新获取绑定信息')
    expect(retryDuringBusy).toBeInstanceOf(HTMLButtonElement)
    expect(retryDuringBusy!.classList.contains('button--ghost')).toBe(true)
    expect(retryDuringBusy!.type).toBe('button')
    expect(retryDuringBusy!.disabled).toBe(true)
    const restartDuringBusy = findGhostButton('重新输入密码')
    expect(restartDuringBusy).toBeInstanceOf(HTMLButtonElement)
    expect(restartDuringBusy!.classList.contains('button--ghost')).toBe(true)
    expect(restartDuringBusy!.type).toBe('button')
    expect(restartDuringBusy!.disabled).toBe(true)
    // 原生行为：disabled 表单控件的 click 不派发事件。
    retryDuringBusy!.click()
    restartDuringBusy!.click()
    await flushPromises()
    expect(document.querySelector('.enrollment__loading')).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // 释放初次 setup 为 500：显示服务端错误文案、loading 结束、手动重试解锁。
    releaseSetup(jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } }))
    await flushPromises()
    expect(document.querySelector('.notice--error')?.textContent).toContain('服务暂时不可用')
    expect(document.querySelector('.enrollment__loading')).toBeNull()
    const retryButton = findGhostButton('重新获取绑定信息')
    expect(retryButton).toBeInstanceOf(HTMLButtonElement)
    expect(retryButton!.disabled).toBe(false)

    // 显式聚焦后手动重试：第 2 次 setup 携带与初次相同的 challengeId（challengeId 只能从请求 body 提取）。
    retryButton!.focus()
    retryButton!.click()
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const setupCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/auth/totp/setup')
    expect(setupCalls).toHaveLength(2)
    const [, firstSetupInit] = setupCalls[0] as [string, RequestInit]
    const [, secondSetupInit] = setupCalls[1] as [string, RequestInit]
    expect(JSON.parse(String(firstSetupInit.body))).toEqual({ challengeId: 'enroll-challenge-1' })
    expect(JSON.parse(String(secondSetupInit.body))).toEqual({ challengeId: 'enroll-challenge-1' })

    // 重试成功：grid 与 QR 出现、错误清空、重试按钮随 provisioning 消失并把焦点交回标题。
    expect(document.querySelector('.enrollment__grid')).not.toBeNull()
    const qrImage = document.querySelector<HTMLImageElement>('.enrollment__grid img')
    expect(qrImage).not.toBeNull()
    expect(qrImage!.getAttribute('src')).toBe(SYNTHETIC_PROVISIONING.qrCodeDataUrl)
    expect(document.querySelector('.notice--error')).toBeNull()
    expect(findGhostButton('重新获取绑定信息')).toBeUndefined()
    expect(document.activeElement).toBe(document.querySelector('#enrollment-title'))

    // confirm 401 落定：provisioning 保留（grid/QR 不消失）、错误显示、busy 结束后恢复入口解锁。
    setInputValue(document.querySelector<HTMLInputElement>('.code-input')!, '135790')
    await submitFormOfPrimary()
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(document.querySelector('.enrollment__grid')).not.toBeNull()
    expect(document.querySelector('.enrollment__grid img')).not.toBeNull()
    expect(document.querySelector('.notice--error')?.textContent).toContain('凭据无效或已过期')
    const restartButton = findGhostButton('重新输入密码')
    expect(restartButton).toBeInstanceOf(HTMLButtonElement)
    expect(restartButton!.disabled).toBe(false)

    // 重新输入密码：仅本地 clearAuthentication，不发任何请求、不误登出。
    restartButton!.click()
    await flushPromises()
    expect(auth.stage).toBe('anonymous')
    expect(document.querySelector('#login-title')).not.toBeNull()
    const passwordInput = document.querySelector<HTMLInputElement>('input[name="password"]')
    expect(passwordInput).not.toBeNull()
    expect(passwordInput!.value).toBe('')
    expect(document.activeElement).toBe(passwordInput)
    expect(document.querySelector('.code-input')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(5)
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls.some((url) => url.includes('logout'))).toBe(false)
    expect(urls.filter((url) => url === '/api/v1/auth/login')).toHaveLength(1)
  })

  it('重置绑定：setup 失败后「取消重置」恢复原会话且不发出任何登出请求', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'ops-owner' },
          session: { id: 'session-reset-1', expiresAt: '2030-03-03T01:00:00Z' },
          csrfToken: 'csrf-reset-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(202, {
          status: 'mfa_setup_required',
          challengeId: 'reset-challenge-9',
          expiresAt: '2030-03-03T00:10:00Z',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    // 先用真实公开 action 建立已认证会话与重置挑战，保留 session/csrf 供取消恢复。
    await auth.bootstrap()
    expect(auth.stage).toBe('authenticated')
    expect(auth.csrfToken).toBe('csrf-reset-1')
    await auth.beginTOTPReset(SYNTHETIC_PASSWORD, 'totp', '246813')
    const [, resetInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(String(resetInit.body))).toEqual({
      password: SYNTHETIC_PASSWORD,
      method: 'totp',
      code: '246813',
    })
    expect(auth.stage).toBe('totp_setup')
    expect(auth.enrollmentCanCancel).toBe(true)

    // 挂载时 stage 已是 totp_setup，immediate watch 自动加载 setup 并以 500 落定。
    wrapper = mount(AuthView, { attachTo: document.body })
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(document.querySelector('.notice--error')?.textContent).toContain('服务暂时不可用')
    expect(document.querySelector('.enrollment__grid')).toBeNull()
    expect(document.querySelector('.enrollment__loading')).toBeNull()

    // 重置流程的恢复入口是「取消重置」且全文档唯一；不渲染「重新输入密码」。
    const cancelButtons = buttonsByText('取消重置')
    expect(cancelButtons).toHaveLength(1)
    const cancelButton = cancelButtons[0]
    expect(cancelButton).toBeInstanceOf(HTMLButtonElement)
    expect(cancelButton!.classList.contains('button--ghost')).toBe(true)
    expect(cancelButton!.type).toBe('button')
    expect(cancelButton!.disabled).toBe(false)
    expect(findGhostButton('重新输入密码')).toBeUndefined()

    cancelButton!.click()
    await flushPromises()
    expect(auth.stage).toBe('authenticated')
    expect(auth.session?.id).toBe('session-reset-1')
    expect(auth.csrfToken).toBe('csrf-reset-1')
    expect(auth.challengeExpiresAt).toBe('')
    expect(auth.provisioning).toBeNull()
    expect(auth.enrollmentCanCancel).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((url) => url.includes('logout'))).toBe(false)
  })

  it('重置绑定：confirm 挂起期间「取消重置」锁定，401 失效后解锁取消', async () => {
    let releaseConfirm!: (response: Response) => void
    const confirmGate = new Promise<Response>((resolve) => {
      releaseConfirm = resolve
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'ops-owner' },
          session: { id: 'session-reset-2', expiresAt: '2030-04-04T01:00:00Z' },
          csrfToken: 'csrf-reset-2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(202, {
          status: 'mfa_setup_required',
          challengeId: 'reset-challenge-c',
          expiresAt: '2030-04-04T00:10:00Z',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, SYNTHETIC_PROVISIONING))
      // confirm 响应用受控 gate 挂起，才能观察 busy 期间的真实 DOM 与 store 状态。
      .mockImplementationOnce(() => confirmGate)
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    await auth.bootstrap()
    await auth.beginTOTPReset(SYNTHETIC_PASSWORD, 'totp', '246813')

    wrapper = mount(AuthView, { attachTo: document.body })
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(document.querySelector('.enrollment__grid')).not.toBeNull()
    expect(document.querySelector('.enrollment__grid img')).not.toBeNull()

    setInputValue(document.querySelector<HTMLInputElement>('.code-input')!, '135790')
    await submitFormOfPrimary()
    expect(fetchMock).toHaveBeenCalledTimes(4)

    // confirm 挂起期间取消被 busy 锁定；错误未落定前挑战不会被清掉，也没有第 5 次请求。
    const cancelDuringPending = findGhostButton('取消重置')
    expect(cancelDuringPending).toBeInstanceOf(HTMLButtonElement)
    // grid 内不再渲染第二个「取消重置」。
    expect(buttonsByText('取消重置')).toHaveLength(1)
    expect(cancelDuringPending!.disabled).toBe(true)
    cancelDuringPending!.click()
    await flushPromises()
    expect(auth.stage).toBe('totp_setup')
    expect(auth.enrollmentCanCancel).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)

    releaseConfirm(
      jsonResponse(401, { error: { code: 'AUTH_INVALID_CREDENTIALS', message: '凭据无效或已过期' } }),
    )
    await flushPromises()
    expect(document.querySelector('.notice--error')?.textContent).toContain('凭据无效或已过期')
    const cancelButton = findGhostButton('取消重置')
    expect(cancelButton).toBeInstanceOf(HTMLButtonElement)
    expect(cancelButton!.disabled).toBe(false)

    // 取消恢复原会话：本地状态回退，不触发登出或任何新请求。
    cancelButton!.click()
    await flushPromises()
    expect(auth.stage).toBe('authenticated')
    expect(auth.session?.id).toBe('session-reset-2')
    expect(auth.csrfToken).toBe('csrf-reset-2')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((url) => url.includes('logout'))).toBe(false)
  })
})

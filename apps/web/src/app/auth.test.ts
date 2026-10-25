import { createPinia, setActivePinia } from 'pinia'
import { vi } from 'vitest'

import { useAuthStore } from './auth'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps session credentials in memory through first TOTP enrollment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(202, {
          status: 'mfa_setup_required',
          challengeId: 'challenge-1',
          expiresAt: '2026-08-30T00:05:00Z',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          manualKey: 'ABCDEFGHIJKLMNOP',
          provisioningUri: 'otpauth://totp/example',
          qrCodeDataUrl: 'data:image/png;base64,abc',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'owner' },
          session: { id: 'session-1', expiresAt: '2026-09-06T00:00:00Z' },
          csrfToken: 'csrf-in-memory-only',
          recoveryCodes: Array.from({ length: 10 }, (_, index) => `CODE-${index}`),
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    expect(auth.stage).toBe('anonymous')

    await auth.login('owner', 'exact password')
    expect(auth.stage).toBe('totp_setup')
    await auth.loadTOTPProvisioning()
    expect(auth.provisioning?.manualKey).toBe('ABCDEFGHIJKLMNOP')
    await auth.confirmTOTP('123456', true, '测试浏览器')

    expect(auth.stage).toBe('recovery_codes')
    expect(auth.recoveryCodes).toHaveLength(10)
    expect(auth.csrfToken).toBe('csrf-in-memory-only')
    expect(window.localStorage.length).toBe(0)

    auth.acknowledgeRecoveryCodes()
    expect(auth.stage).toBe('authenticated')
    expect(auth.recoveryCodes).toEqual([])
  })

  it('sends CSRF only in the mutation header and clears memory on logout', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'owner' },
          session: { id: 'session-1', expiresAt: '2026-09-06T00:00:00Z' },
          csrfToken: 'csrf-header-value',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    await auth.logout()

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-header-value')
    expect(String(init.body)).not.toContain('csrf-header-value')
    expect(auth.stage).toBe('anonymous')
    expect(auth.csrfToken).toBe('')
    expect(window.localStorage.length).toBe(0)
  })

  it('logout() 收到 401 AUTH_REQUIRED 应回到 anonymous', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'owner' },
          session: { id: 'session-a', expiresAt: '2026-09-06T00:00:00Z' },
          csrfToken: 'csrf-a',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    expect(auth.stage).toBe('authenticated')

    const pending = auth.logout()
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/logout')
    await expect(pending).resolves.toBeUndefined()
    expect(auth.stage).toBe('anonymous')
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.csrfToken).toBe('')
    expect(auth.session).toBeNull()
    expect(auth.owner).toBeNull()
  })

  it('logout(true) 收到 401 AUTH_REQUIRED 应回到 anonymous（/api/v1/auth/logout-all）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'owner' },
          session: { id: 'session-a', expiresAt: '2026-09-06T00:00:00Z' },
          csrfToken: 'csrf-a',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    expect(auth.stage).toBe('authenticated')

    const pending = auth.logout(true)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/logout-all')
    await expect(pending).resolves.toBeUndefined()
    expect(auth.stage).toBe('anonymous')
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.csrfToken).toBe('')
    expect(auth.session).toBeNull()
    expect(auth.owner).toBeNull()
  })

  it('logout() 收到 403 FORBIDDEN 时 reject 且保持当前有效认证', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'owner' },
          session: { id: 'session-a', expiresAt: '2026-09-06T00:00:00Z' },
          csrfToken: 'csrf-a',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(403, { error: { code: 'FORBIDDEN', message: '无权执行该操作' } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    expect(auth.stage).toBe('authenticated')

    await expect(auth.logout()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'FORBIDDEN',
    })
    expect(auth.stage).toBe('authenticated')
    expect(auth.csrfToken).toBe('csrf-a')
    expect(auth.session?.id).toBe('session-a')
  })

  it('logout() 遇到网络错误时 reject 且保持当前有效认证', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-1', username: 'owner' },
          session: { id: 'session-a', expiresAt: '2026-09-06T00:00:00Z' },
          csrfToken: 'csrf-a',
        }),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    expect(auth.stage).toBe('authenticated')

    await expect(auth.logout()).rejects.toBeInstanceOf(TypeError)
    expect(auth.stage).toBe('authenticated')
    expect(auth.csrfToken).toBe('csrf-a')
    expect(auth.session?.id).toBe('session-a')
  })

  it('旧 logout 的迟到 401 不得清掉新登录的会话（归属 guard）', async () => {
    const authenticatedA = {
      status: 'authenticated',
      owner: { id: 'owner-1', username: 'owner' },
      session: { id: 'session-a', expiresAt: '2026-09-06T00:00:00Z' },
      csrfToken: 'csrf-a',
    }
    const authenticatedB = {
      status: 'authenticated',
      owner: { id: 'owner-1', username: 'owner' },
      session: { id: 'session-b', expiresAt: '2026-09-07T00:00:00Z' },
      csrfToken: 'csrf-b',
    }
    let releaseLogout!: (response: Response) => void
    let releaseLogoutAll!: (response: Response) => void
    const logoutGate = new Promise<Response>((resolve) => {
      releaseLogout = resolve
    })
    const logoutAllGate = new Promise<Response>((resolve) => {
      releaseLogoutAll = resolve
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, authenticatedA))
      .mockImplementationOnce(() => logoutGate)
      .mockImplementationOnce(() => logoutAllGate)
      .mockResolvedValueOnce(jsonResponse(200, authenticatedB))
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    expect(auth.stage).toBe('authenticated')

    const p1 = auth.logout()
    const p2 = auth.logout(true)
    p2.then(() => {}, () => {})

    releaseLogout(new Response(null, { status: 204 }))
    await p1
    expect(auth.stage).toBe('anonymous')

    await auth.login('owner', 'exact password')
    expect(auth.stage).toBe('authenticated')
    expect(auth.session?.id).toBe('session-b')

    releaseLogoutAll(
      jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }),
    )
    await Promise.allSettled([p2])

    expect(auth.stage).toBe('authenticated')
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.session?.id).toBe('session-b')
    expect(auth.csrfToken).toBe('csrf-b')
    expect(auth.owner?.id).toBe('owner-1')
  })
})

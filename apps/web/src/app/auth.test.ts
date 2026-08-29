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
})

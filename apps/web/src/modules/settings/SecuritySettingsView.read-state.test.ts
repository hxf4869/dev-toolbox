import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import SecuritySettingsView from './SecuritySettingsView.vue'

const device = {
  id: '44444444-4444-4444-8444-444444444444',
  displayName: 'R284 合成笔记本',
  createdAt: '2026-10-01T00:00:00Z',
  lastUsedAt: '2026-10-20T08:00:00Z',
  expiresAt: '2026-12-29T00:00:00Z',
}

const session = {
  id: '55555555-5555-4555-8555-555555555555',
  createdAt: '2026-10-24T10:00:00Z',
  lastSeenAt: '2026-10-25T09:00:00Z',
  expiresAt: '2026-11-24T10:00:00Z',
  trustedDeviceId: device.id,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  current: true,
}

describe('SecuritySettingsView device/session read state', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('hides fake device/session counts while the initial device read fails and shows the real lists after retry', async () => {
    let deviceReads = 0
    let resolveRetryRead!: (response: Response) => void
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/auth/trusted-devices' && !init?.method) {
        deviceReads += 1
        if (deviceReads === 1) {
          return jsonResponse(
            { error: { code: 'TRUSTED_DEVICES_UNAVAILABLE', message: '可信设备列表当前不可用' } },
            503,
          )
        }
        return new Promise<Response>((resolve) => {
          resolveRetryRead = resolve
        })
      }
      if (path === '/api/v1/auth/sessions' && !init?.method) {
        return jsonResponse({ items: [session] })
      }
      throw new Error('unexpected request: ' + path)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSecurityView()
    try {
      await flushPromises()
      expect(deviceReads).toBe(1)
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('可信设备列表当前不可用')
      expect(document.querySelector('#authentication-title')?.textContent).toBe('登录验证')
      expect(document.querySelector('#devices-title')).toBeNull()
      expect(document.querySelector('#sessions-title')).toBeNull()
      expect(document.querySelector('.settings-context')).toBeNull()
      expect(document.body.textContent).not.toContain('台有效设备')
      expect(document.body.textContent).not.toContain('没有有效的可信设备')
      expect(document.body.textContent).not.toContain('当前会话')

      buttonByText('重试').click()
      await flushPromises()
      expect(deviceReads).toBe(2)
      expect(document.querySelector('.settings-loading')).not.toBeNull()
      expect(document.querySelector('#devices-title')).toBeNull()
      expect(document.querySelector('#sessions-title')).toBeNull()
      expect(document.querySelector('.settings-context')).toBeNull()
      expect(document.body.textContent).not.toContain('台有效设备')
      expect(document.body.textContent).not.toContain('没有有效的可信设备')
      expect(document.body.textContent).not.toContain('当前会话')

      resolveRetryRead(jsonResponse({ items: [device] }))
      await flushPromises()
      expect(document.querySelector('.settings-loading')).toBeNull()
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.querySelector('#devices-title')?.textContent).toBe('可信设备')
      expect(document.querySelector('#sessions-title')?.textContent).toBe('活跃会话')
      expect(document.body.textContent).toContain('1 台有效设备')
      expect(document.body.textContent).toContain(device.displayName)
      expect(document.querySelector('[aria-labelledby="sessions-title"]')?.textContent).toContain('当前会话')
      expect(summaryValue('可信设备')).toBe('1')
      expect(summaryValue('活跃会话')).toBe('1')
      expect(summaryValue('当前会话')).toBe('1')
    } finally {
      resolveRetryRead?.(jsonResponse({ items: [] }))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('keeps known lists through a rename failure, hides the cache when a retry read fails, and shows the legal empty device state after a clean retry', async () => {
    const pendingName = 'R284 改名后的合成笔记本'
    let deviceReads = 0
    let patches = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/auth/trusted-devices/' + device.id && init?.method === 'PATCH') {
        patches += 1
        return jsonResponse({ error: { code: 'DEVICE_RENAME_FAILED', message: '设备改名暂时失败' } }, 503)
      }
      if (path === '/api/v1/auth/trusted-devices') {
        deviceReads += 1
        if (deviceReads === 2) {
          return jsonResponse(
            { error: { code: 'TRUSTED_DEVICES_UNAVAILABLE', message: '重试读取可信设备失败' } },
            503,
          )
        }
        return jsonResponse({ items: deviceReads === 3 ? [] : [device] })
      }
      if (path === '/api/v1/auth/sessions') {
        return jsonResponse({ items: [session] })
      }
      throw new Error('unexpected request: ' + path)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSecurityView()
    try {
      await flushPromises()
      expect(deviceReads).toBe(1)
      expect(document.body.textContent).toContain('1 台有效设备')
      expect(document.body.textContent).toContain(device.displayName)

      buttonByText('改名').click()
      await flushPromises()
      const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')
      expect(nameInput).not.toBeNull()
      await setInput(nameInput!, pendingName)
      buttonByText('保存').click()
      await flushPromises()
      expect(patches).toBe(1)
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('设备改名暂时失败')
      const devicesSection = document.querySelector('[aria-labelledby="devices-title"]')
      expect(devicesSection).not.toBeNull()
      expect(devicesSection?.textContent).toContain('1 台有效设备')
      expect(devicesSection?.querySelectorAll('.security-row')).toHaveLength(1)
      expect(document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')?.value).toBe(pendingName)
      expect(document.querySelector('#sessions-title')).not.toBeNull()
      expect(summaryValue('可信设备')).toBe('1')
      expect(summaryValue('活跃会话')).toBe('1')
      expect(summaryValue('当前会话')).toBe('1')

      buttonByText('重试').click()
      await flushPromises()
      expect(deviceReads).toBe(2)
      expect(patches).toBe(1)
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('重试读取可信设备失败')
      expect(document.querySelector('#devices-title')).toBeNull()
      expect(document.querySelector('#sessions-title')).toBeNull()
      expect(document.querySelector('.settings-context')).toBeNull()
      expect(document.querySelector('input[aria-label="设备名称"]')).toBeNull()
      expect(document.body.textContent).not.toContain('台有效设备')
      expect(document.body.textContent).not.toContain('没有有效的可信设备')
      expect(document.body.textContent).not.toContain('当前会话')

      buttonByText('重试').click()
      await flushPromises()
      expect(deviceReads).toBe(3)
      expect(patches).toBe(1)
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.querySelector('#devices-title')?.textContent).toBe('可信设备')
      expect(document.querySelector('#sessions-title')?.textContent).toBe('活跃会话')
      expect(document.body.textContent).toContain('0 台有效设备')
      expect(document.body.textContent).toContain('没有有效的可信设备')
      expect(summaryValue('可信设备')).toBe('0')
      expect(summaryValue('活跃会话')).toBe('1')
      expect(summaryValue('当前会话')).toBe('1')
      const sessionsSection = document.querySelector('[aria-labelledby="sessions-title"]')
      expect(sessionsSection?.querySelectorAll('.security-row')).toHaveLength(1)
      expect(sessionsSection?.textContent).toContain('Chrome')
      expect(sessionsSection?.textContent).toContain('当前会话')
    } finally {
      wrapper.unmount()
    }
  })
})

describe('SecuritySettingsView device rename lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('keeps the other device draft open when a late rename success arrives, even if the draft text matches the submitted name', async () => {
    const deviceA = {
      id: '66666666-6666-4666-8666-666666666666',
      displayName: 'R285 晚到成功笔记本',
      createdAt: '2026-10-01T00:00:00Z',
      lastUsedAt: '2026-10-20T08:00:00Z',
      expiresAt: '2026-12-29T00:00:00Z',
    }
    const deviceB = {
      id: '77777777-7777-4777-8777-777777777777',
      displayName: 'R285 晚到成功平板',
      createdAt: '2026-10-02T00:00:00Z',
      lastUsedAt: '2026-10-21T08:00:00Z',
      expiresAt: '2026-12-30T00:00:00Z',
    }
    const submittedName = 'R285 A 新名称'
    let patches = 0
    let resolvePatch!: (response: Response) => void
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/auth/trusted-devices/' + deviceA.id && init?.method === 'PATCH') {
        patches += 1
        return new Promise<Response>((resolve) => {
          resolvePatch = resolve
        })
      }
      if (path === '/api/v1/auth/trusted-devices' && !init?.method) {
        return jsonResponse({ items: [deviceA, deviceB] })
      }
      if (path === '/api/v1/auth/sessions' && !init?.method) {
        return jsonResponse({ items: [session] })
      }
      throw new Error('unexpected request: ' + path)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSecurityView()
    try {
      await flushPromises()
      renameButtonFor(deviceA.displayName).click()
      await flushPromises()
      const firstInput = document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')
      await setInput(firstInput!, submittedName)
      buttonByText('保存').click()
      await flushPromises()
      expect(patches).toBe(1)

      renameButtonFor(deviceB.displayName).click()
      await flushPromises()
      const draftInput = document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')
      expect(draftInput?.value).toBe(deviceB.displayName)
      await setInput(draftInput!, submittedName)

      resolvePatch(jsonResponse({}))
      await flushPromises()
      expect(patches).toBe(1)
      const keptInput = document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')
      expect(keptInput).not.toBeNull()
      expect(keptInput!.value).toBe(submittedName)
      const deviceRows = Array.from(document.querySelectorAll('[aria-labelledby="devices-title"] .security-row'))
      const editingRow = deviceRows.find((row) => row.querySelector('form.rename-form'))
      expect(editingRow).toBeDefined()
      expect(editingRow?.querySelector('strong')).toBeNull()
      const displayRow = deviceRows.find((row) => !row.querySelector('form.rename-form'))
      expect(displayRow?.querySelector('strong')?.textContent).toBe(submittedName)
    } finally {
      resolvePatch?.(jsonResponse({}))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('keeps a newer same-device draft when a late rename success arrives, and keeps the submitted value as the saved name', async () => {
    const deviceA = {
      id: '88888888-8888-4888-8888-888888888888',
      displayName: 'R285 同设备改名笔记本',
      createdAt: '2026-10-01T00:00:00Z',
      lastUsedAt: '2026-10-24T08:00:00Z',
      expiresAt: '2026-12-30T00:00:00Z',
    }
    const firstDraft = 'R285 第一稿名称'
    const secondDraft = 'R285 第二稿名称'
    const patchBodies: Array<{ displayName?: string }> = []
    let resolvePatch!: (response: Response) => void
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/auth/trusted-devices/' + deviceA.id && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)))
        return new Promise<Response>((resolve) => {
          resolvePatch = resolve
        })
      }
      if (path === '/api/v1/auth/trusted-devices' && !init?.method) {
        return jsonResponse({ items: [deviceA] })
      }
      if (path === '/api/v1/auth/sessions' && !init?.method) {
        return jsonResponse({ items: [session] })
      }
      throw new Error('unexpected request: ' + path)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSecurityView()
    try {
      await flushPromises()
      buttonByText('改名').click()
      await flushPromises()
      const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')
      expect(nameInput?.value).toBe(deviceA.displayName)
      await setInput(nameInput!, firstDraft)
      buttonByText('保存').click()
      await flushPromises()
      expect(patchBodies).toEqual([{ displayName: firstDraft }])

      const draftInput = document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')
      await setInput(draftInput!, secondDraft)

      resolvePatch(jsonResponse({}))
      await flushPromises()
      const keptInput = document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')
      expect(keptInput).not.toBeNull()
      expect(keptInput!.value).toBe(secondDraft)

      buttonByText('取消').click()
      await flushPromises()
      expect(document.querySelector('input[aria-label="设备名称"]')).toBeNull()
      expect(document.querySelector('[aria-labelledby="devices-title"] strong')?.textContent).toBe(firstDraft)
      expect(patchBodies).toHaveLength(1)
      expect(document.querySelector('[role="alert"]')).toBeNull()
    } finally {
      resolvePatch?.(jsonResponse({}))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('exits editing with the trimmed name saved when the draft is unchanged while a rename succeeds', async () => {
    const deviceA = {
      id: '99999999-9999-4999-8999-999999999999',
      displayName: 'R285 正常改名笔记本',
      createdAt: '2026-10-01T00:00:00Z',
      lastUsedAt: '2026-10-24T08:00:00Z',
      expiresAt: '2026-12-30T00:00:00Z',
    }
    const trimmedName = 'R285 正常保存名称'
    const patchBodies: Array<{ displayName?: string }> = []
    let resolvePatch!: (response: Response) => void
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/auth/trusted-devices/' + deviceA.id && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)))
        return new Promise<Response>((resolve) => {
          resolvePatch = resolve
        })
      }
      if (path === '/api/v1/auth/trusted-devices' && !init?.method) {
        return jsonResponse({ items: [deviceA] })
      }
      if (path === '/api/v1/auth/sessions' && !init?.method) {
        return jsonResponse({ items: [session] })
      }
      throw new Error('unexpected request: ' + path)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSecurityView()
    try {
      await flushPromises()
      buttonByText('改名').click()
      await flushPromises()
      const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')
      await setInput(nameInput!, '  ' + trimmedName + '  ')
      buttonByText('保存').click()
      await flushPromises()
      expect(patchBodies).toEqual([{ displayName: trimmedName }])
      expect(document.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')).not.toBeNull()

      resolvePatch(jsonResponse({}))
      await flushPromises()
      expect(document.querySelector('input[aria-label="设备名称"]')).toBeNull()
      expect(document.querySelector('[aria-labelledby="devices-title"] strong')?.textContent).toBe(trimmedName)
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(patchBodies).toHaveLength(1)
    } finally {
      resolvePatch?.(jsonResponse({}))
      await flushPromises()
      wrapper.unmount()
    }
  })
})

async function mountSecurityView(): Promise<VueWrapper> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test-value'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/settings/security', name: 'security-settings', component: { template: '<div />' } }],
  })
  await router.push('/settings/security')
  await router.isReady()
  return mount(SecuritySettingsView, { attachTo: document.body, global: { plugins: [pinia, router] } })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function buttonByText(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes(text),
  )
  if (!button) throw new Error(`button not found: ${text}`)
  return button as HTMLButtonElement
}

function renameButtonFor(displayName: string) {
  const row = Array.from(document.querySelectorAll('[aria-labelledby="devices-title"] .security-row')).find(
    (entry) => entry.textContent?.includes(displayName),
  )
  if (!row) throw new Error(`device row not found: ${displayName}`)
  const button = Array.from(row.querySelectorAll('button')).find((entry) => entry.textContent?.includes('改名'))
  if (!button) throw new Error(`rename button not found: ${displayName}`)
  return button as HTMLButtonElement
}

async function setInput(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

function summaryValue(term: string) {
  const dt = Array.from(document.querySelectorAll('.settings-context dt')).find(
    (entry) => entry.textContent === term,
  )
  return dt?.nextElementSibling?.textContent ?? undefined
}

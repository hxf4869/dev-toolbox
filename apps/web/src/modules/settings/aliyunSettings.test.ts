import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import AliyunSettingsView from './AliyunSettingsView.vue'
import type { AliyunSettings, AliyunUsage } from './aliyunContracts'

const configuredSettings: AliyunSettings = {
  credentials: { configured: true, accessKeyIdMasked: '****ABCD', credentialVersion: 2 },
  translation: {
    generalMonthlyLimit: 950000,
    professionalMonthlyLimit: 950000,
    autoUseProfessional: true,
    professionalScene: 'title',
  },
  ocr: { monthlyLimit: 190 },
  concurrency: { owner: 1, global: 3 },
  status: {
    lastSuccessAt: '2026-08-30T01:02:03Z',
    lastFailureAt: '2026-08-29T08:00:00Z',
    lastFailureCategory: 'throttled',
  },
}

const unconfiguredSettings: AliyunSettings = {
  credentials: { configured: false, accessKeyIdMasked: null, credentialVersion: 0 },
  translation: {
    generalMonthlyLimit: 950000,
    professionalMonthlyLimit: 950000,
    autoUseProfessional: true,
    professionalScene: null,
  },
  ocr: { monthlyLimit: 190 },
  concurrency: { owner: 1, global: 3 },
  status: { lastSuccessAt: null, lastFailureAt: null, lastFailureCategory: null },
}

const usageCurrent: AliyunUsage = {
  month: '2026-08',
  timezone: 'Asia/Shanghai',
  source: 'dev_toolbox_local_ledger',
  meters: [
    { meter: 'mt_general', limit: 950000, used: 1200, reserved: 0, remaining: 948800 },
    { meter: 'mt_professional', limit: 950000, used: 0, reserved: 0, remaining: 950000 },
    { meter: 'ocr_general', limit: 190, used: 2, reserved: 0, remaining: 188 },
  ],
}

const ALLOWED_REQUESTS = new Set([
  'GET /api/v1/aliyun/settings',
  'GET /api/v1/aliyun/usage/current',
  'PUT /api/v1/aliyun/settings',
  'DELETE /api/v1/aliyun/settings/credentials',
])

interface RecordedCall {
  method: string
  path: string
  body?: unknown
}

function createAliyunFetchMock(
  handlers: {
    settings?: (call: number) => Response
    usage?: () => Response
    put?: (body: Record<string, unknown>) => Response
    deleteCredentials?: () => Response
  } = {},
) {
  let settingsCalls = 0
  const calls: RecordedCall[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    calls.push({ method, path, body })
    if (method === 'GET' && path === '/api/v1/aliyun/settings') {
      settingsCalls += 1
      return handlers.settings?.(settingsCalls) ?? jsonResponse(configuredSettings)
    }
    if (method === 'GET' && path === '/api/v1/aliyun/usage/current') {
      return handlers.usage?.() ?? jsonResponse(usageCurrent)
    }
    if (method === 'PUT' && path === '/api/v1/aliyun/settings') {
      return handlers.put?.(body ?? {}) ?? jsonResponse({})
    }
    if (method === 'DELETE' && path === '/api/v1/aliyun/settings/credentials') {
      return handlers.deleteCredentials?.() ?? new Response(null, { status: 204 })
    }
    throw new Error(`unexpected request: ${method} ${path}`)
  })
  return { fetchMock, calls }
}

function countCalls(calls: RecordedCall[], method: string, path: string) {
  return calls.filter((call) => call.method === method && call.path === path).length
}

function assertOnlyAllowedRequests(calls: RecordedCall[]) {
  for (const call of calls) {
    expect(ALLOWED_REQUESTS.has(`${call.method} ${call.path}`)).toBe(true)
  }
}

function spyOnStorageWrites() {
  return {
    local: vi.spyOn(window.localStorage, 'setItem'),
    session: vi.spyOn(window.sessionStorage, 'setItem'),
  }
}

describe('Aliyun settings view', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loads settings and the current-month local ledger without other requests', async () => {
    const { fetchMock, calls } = createAliyunFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const spies = spyOnStorageWrites()
    const wrapper = await mountAliyunView()
    await flushPromises()

    const requests = calls.map((call) => `${call.method} ${call.path}`).sort()
    expect(requests).toEqual(
      ['GET /api/v1/aliyun/settings', 'GET /api/v1/aliyun/usage/current'].sort(),
    )

    const text = document.body.textContent ?? ''
    expect(text).toContain('****ABCD')
    expect(text).toContain('已配置')
    expect(text).toContain('凭据版本')
    expect(text).toContain('本地保护账本剩余')
    expect(text).toContain('2026-08')
    expect(text).toContain('Asia/Shanghai')
    expect(text).toContain('948,800')
    expect(text).toContain('阿里云机器翻译')
    expect(text).toContain('被限流')
    expect(text).toContain('主账号与 RAM 子账号共享')
    expect(text).not.toContain('测试连接')
    expect(spies.local).not.toHaveBeenCalled()
    expect(spies.session).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('sends the full replacement payload and omits credentials when both fields stay blank', async () => {
    const putBodies: Record<string, unknown>[] = []
    const { fetchMock, calls } = createAliyunFetchMock({
      put: (body) => {
        putBodies.push(body)
        return jsonResponse({})
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    await flushPromises()

    const numbers = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
    expect(numbers).toHaveLength(5)
    await setInput(numbers[0]!, '900000')
    buttonByText('保存设置').click()
    await flushPromises()

    expect(putBodies).toEqual([
      {
        translation: {
          generalMonthlyLimit: 900000,
          professionalMonthlyLimit: 950000,
          autoUseProfessional: true,
          professionalScene: 'title',
        },
        ocr: { monthlyLimit: 190 },
        concurrency: { owner: 1, global: 3 },
      },
    ])
    expect(Object.hasOwn(putBodies[0]!, 'credentials')).toBe(false)
    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)
    assertOnlyAllowedRequests(calls)
    expect(document.querySelector('.aliyun-saved')).not.toBeNull()
    expect(document.querySelector('.aliyun-saved')?.textContent).toContain(
      '保存不调用阿里云，尚未通过真实调用验证',
    )
    wrapper.unmount()
  })

  it('blocks partial credential replacement and first-time empty credentials without any PUT', async () => {
    const { fetchMock, calls } = createAliyunFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    await flushPromises()

    const idInput = document.querySelector<HTMLInputElement>('input[autocomplete="off"]')
    const secretInput = document.querySelector<HTMLInputElement>('input[type="password"]')
    expect(idInput).not.toBeNull()
    expect(secretInput).not.toBeNull()

    await setInput(idInput!, 'LTAI5syntheticPartial')
    buttonByText('保存设置').click()
    await flushPromises()
    expect(document.body.textContent).toContain('必须同时填写')
    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)

    await setInput(idInput!, '')
    await setInput(secretInput!, 'synthetic-secret-only')
    buttonByText('保存设置').click()
    await flushPromises()
    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)
    wrapper.unmount()
  })

  it('requires both credential fields on first save and includes them once provided', async () => {
    const putBodies: Record<string, unknown>[] = []
    const firstSaveSettings: AliyunSettings = {
      ...unconfiguredSettings,
      translation: { ...unconfiguredSettings.translation, professionalScene: 'title' },
    }
    const { fetchMock, calls } = createAliyunFetchMock({
      settings: () => jsonResponse(firstSaveSettings),
      put: (body) => {
        putBodies.push(body)
        return jsonResponse({})
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    await flushPromises()
    expect(document.body.textContent).toContain('未配置')

    buttonByText('保存设置').click()
    await flushPromises()
    expect(document.body.textContent).toContain('首次保存必须同时填写 AccessKey ID 与 AccessKey Secret')
    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)

    await setInput(document.querySelector<HTMLInputElement>('input[autocomplete="off"]')!, ' LTAI5syntheticId ')
    await setInput(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-secret-value')
    buttonByText('保存设置').click()
    await flushPromises()

    expect(putBodies[0]?.credentials).toEqual({
      accessKeyId: 'LTAI5syntheticId',
      accessKeySecret: 'synthetic-secret-value',
    })
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('')
    assertOnlyAllowedRequests(calls)
    wrapper.unmount()
  })

  it('reports concurrency mismatch inline and refuses to submit, then validates ranges', async () => {
    const { fetchMock, calls } = createAliyunFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    await flushPromises()
    expect(calls).toHaveLength(2)

    const numbers = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
    await setInput(numbers[3]!, '2')
    await setInput(numbers[4]!, '1')
    expect(document.body.textContent).toContain('全局并发（1）不能小于 owner 并发（2）')

    buttonByText('保存设置').click()
    await flushPromises()
    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)
    expect(calls).toHaveLength(2)

    await setInput(numbers[4]!, '3')
    await setInput(numbers[2]!, '201')
    buttonByText('保存设置').click()
    await flushPromises()
    expect(document.body.textContent).toContain('OCR 月度上限必须是 1–200 的整数')
    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)

    await setInput(numbers[2]!, '190')
    await setInput(numbers[0]!, '1000001')
    buttonByText('保存设置').click()
    await flushPromises()
    expect(document.body.textContent).toContain('通用版月度硬上限必须是 1–1,000,000 的整数')
    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)
    expect(calls).toHaveLength(2)
    wrapper.unmount()
  })

  it('refuses a limit below the current-month used plus reserved before any request', async () => {
    const { fetchMock, calls } = createAliyunFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    await flushPromises()

    const numbers = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
    await setInput(numbers[0]!, '1000')
    buttonByText('保存设置').click()
    await flushPromises()

    expect(document.body.textContent).toContain('低于当前月已用与预留之和 1,200')
    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)
    expect(calls).toHaveLength(2)
    wrapper.unmount()
  })

  it('blocks saving with auto professional switching enabled but no scene selected', async () => {
    const putBodies: Record<string, unknown>[] = []
    const { fetchMock, calls } = createAliyunFetchMock({
      settings: () => jsonResponse(unconfiguredSettings),
      put: (body) => {
        putBodies.push(body)
        return jsonResponse({})
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    await flushPromises()

    const sceneSelect = document.querySelector<HTMLSelectElement>('select[name="professional-scene"]')
    expect(sceneSelect).not.toBeNull()
    expect(sceneSelect!.value).toBe('')
    await setInput(document.querySelector<HTMLInputElement>('input[autocomplete="off"]')!, 'LTAI5syntheticId')
    await setInput(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-secret-value')

    buttonByText('保存设置').click()
    await flushPromises()
    expect(document.body.textContent).toContain('必须先在六个官方场景中选择一个专业场景')
    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)

    sceneSelect!.value = 'communication'
    sceneSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    expect(sceneSelect!.value).toBe('communication')

    buttonByText('保存设置').click()
    await flushPromises()
    expect(putBodies[0]?.translation).toMatchObject({
      autoUseProfessional: true,
      professionalScene: 'communication',
    })
    assertOnlyAllowedRequests(calls)
    wrapper.unmount()
  })

  it('confirms credential deletion once, focuses cancel by default, and cancels without sending', async () => {
    const { fetchMock, calls } = createAliyunFetchMock({
      settings: (call) => jsonResponse(call === 1 ? configuredSettings : unconfiguredSettings),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    await flushPromises()

    buttonByText('移除凭据').click()
    await flushPromises()
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(document.body.textContent).toContain('云翻译与云 OCR 会立即停止可用')
    expect(document.body.textContent).toContain('本地工具与本地 OCR 不受影响')
    expect(document.activeElement?.textContent).toContain('取消')

    buttonByText('取消').click()
    await flushPromises()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(countCalls(calls, 'DELETE', '/api/v1/aliyun/settings/credentials')).toBe(0)

    buttonByText('移除凭据').click()
    await flushPromises()
    buttonByText('确认删除凭据').click()
    await flushPromises()
    expect(countCalls(calls, 'DELETE', '/api/v1/aliyun/settings/credentials')).toBe(1)
    expect(document.body.textContent).toContain('未配置')
    assertOnlyAllowedRequests(calls)
    wrapper.unmount()
  })

  it('surfaces the stable server rejection when a lower limit is refused with 422', async () => {
    const { fetchMock, calls } = createAliyunFetchMock({
      put: () =>
        jsonResponse(
          {
            error: {
              code: 'INVALID_INPUT',
              message: '通用版月度上限不能低于当前月已用与预留之和',
              requestId: 'req-synthetic-1',
            },
          },
          422,
        ),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    await flushPromises()

    buttonByText('保存设置').click()
    await flushPromises()

    expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)
    const text = document.body.textContent ?? ''
    expect(text).toContain('INVALID_INPUT')
    expect(text).toContain('通用版月度上限不能低于当前月已用与预留之和')
    expect(text).toContain('请按提示修改取值后再保存')
    expect(document.querySelector('.aliyun-saved')).toBeNull()
    wrapper.unmount()
  })

  it('never writes browser storage while saving credentials', async () => {
    const { fetchMock } = createAliyunFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const spies = spyOnStorageWrites()
    const wrapper = await mountAliyunView()
    await flushPromises()

    await setInput(document.querySelector<HTMLInputElement>('input[autocomplete="off"]')!, 'LTAI5syntheticId')
    await setInput(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-secret-value')
    buttonByText('保存设置').click()
    await flushPromises()

    expect(spies.local).not.toHaveBeenCalled()
    expect(spies.session).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
    wrapper.unmount()
  })
})

async function mountAliyunView(): Promise<VueWrapper> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test-value'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/aliyun', name: 'aliyun-settings', component: { template: '<div />' } },
      // SettingsSubnav 会渲染其余设置入口；注册空路由避免 Vue Router 警告。
      ...[
        '/settings/providers',
        '/settings/tokens',
        '/settings/ai-security',
        '/settings/ai-schedule',
        '/settings/security',
        '/settings/appearance',
        '/settings/operations',
      ].map((path) => ({ path, component: { template: '<div />' } })),
    ],
  })
  await router.push('/settings/aliyun')
  await router.isReady()
  return mount(AliyunSettingsView, { attachTo: document.body, global: { plugins: [pinia, router] } })
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

async function setInput(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

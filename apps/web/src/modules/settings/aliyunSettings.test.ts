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

/** 服务端已接受“通用上限 900001”这次提交后的回显；凭据版本 +1 用于确认 credentials 照常刷新。 */
const generalSavedSettings: AliyunSettings = {
  ...configuredSettings,
  credentials: { configured: true, accessKeyIdMasked: '****ABCD', credentialVersion: 3 },
  translation: { ...configuredSettings.translation, generalMonthlyLimit: 900001 },
}

/** 更早发出却更晚到达的那次账本读取结果：通用版 used+reserved=100，不会阻止下方输入的 200。 */
const usageStaleRead: AliyunUsage = {
  ...usageCurrent,
  meters: [
    { meter: 'mt_general', limit: 900000, used: 100, reserved: 0, remaining: 899900 },
    ...usageCurrent.meters.slice(1),
  ],
}

/** 保存后较新一次读取返回的账本：通用版 used+reserved=255，输入 200 必须被本地阻止。 */
const usageLatestRead: AliyunUsage = {
  ...usageCurrent,
  meters: [
    { meter: 'mt_general', limit: 900001, used: 250, reserved: 5, remaining: 899746 },
    ...usageCurrent.meters.slice(1),
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
    settings?: (call: number) => Response | Promise<Response>
    usage?: (call: number) => Response | Promise<Response>
    put?: (body: Record<string, unknown>) => Response | Promise<Response>
    deleteCredentials?: () => Response
  } = {},
) {
  let settingsCalls = 0
  let usageCalls = 0
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
      usageCalls += 1
      return handlers.usage?.(usageCalls) ?? jsonResponse(usageCurrent)
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

  it('hides unconfirmed settings through the pending read, a 503 and the retry, then shows the real values', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const { fetchMock, calls } = createAliyunFetchMock({
      settings: (call) =>
        call <= 2
          ? new Promise<Response>((resolve) => {
              resolvers.push(resolve)
            })
          : jsonResponse(configuredSettings),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      // 读取在途：usage 已成功，但不能冒充 settings 成功。
      expect(countCalls(calls, 'GET', '/api/v1/aliyun/usage/current')).toBe(1)
      expect(document.querySelector('.settings-loading')).not.toBeNull()
      expect(document.querySelector('#aliyun-settings-title')?.textContent).toBe('阿里云服务')
      expect(document.body.textContent).toContain('主账号与 RAM 子账号共享')
      expect(document.querySelector('#aliyun-credentials-title')).toBeNull()
      expect(document.querySelector('#aliyun-usage-title')).toBeNull()
      expect(document.querySelector('.settings-context')).toBeNull()
      expect(buttonByText('保存设置').disabled).toBe(true)
      expect(document.body.textContent).not.toContain('尚未配置凭据')
      expect(document.body.textContent).not.toContain('云能力当前不可用')

      resolvers[0]!(
        jsonResponse(
          { error: { code: 'ALIYUN_SETTINGS_UNAVAILABLE', message: '阿里云服务设置读取失败' } },
          503,
        ),
      )
      await flushPromises()
      // 读取失败：未知状态不得显示为“未配置”或任何断言值，保存保持禁用。
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('阿里云服务设置读取失败')
      expect(document.querySelector('.settings-loading')).toBeNull()
      expect(document.querySelector('#aliyun-credentials-title')).toBeNull()
      expect(document.querySelector('.settings-context')).toBeNull()
      expect(buttonByText('保存设置').disabled).toBe(true)
      expect(document.body.textContent).not.toContain('尚未配置凭据')
      expect(document.body.textContent).not.toContain('云能力当前不可用')
      expect(document.body.textContent).not.toContain('****ABCD')

      buttonByText('重试').click()
      await flushPromises()
      // 重试在途：仍不显示未经确认的值，重试只发 GET。
      expect(countCalls(calls, 'GET', '/api/v1/aliyun/settings')).toBe(2)
      expect(document.querySelector('.settings-loading')).not.toBeNull()
      expect(document.querySelector('#aliyun-credentials-title')).toBeNull()
      expect(document.querySelector('.settings-context')).toBeNull()
      expect(buttonByText('保存设置').disabled).toBe(true)

      resolvers[1]!(jsonResponse(configuredSettings))
      await flushPromises()
      // 成功后只显示真实返回值。
      expect(document.querySelector('.settings-loading')).toBeNull()
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.querySelector('#aliyun-credentials-title')?.textContent).toBe('凭据')
      expect(document.body.textContent).toContain('****ABCD')
      expect(document.querySelector('.settings-context')?.textContent).toContain('云服务摘要')
      expect(buttonByText('保存设置').disabled).toBe(false)
      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)
      expect(countCalls(calls, 'DELETE', '/api/v1/aliyun/settings/credentials')).toBe(0)
      assertOnlyAllowedRequests(calls)
    } finally {
      for (const resolve of resolvers) resolve(jsonResponse(configuredSettings))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('hides the form again when the reread after a confirmed PUT fails, without replaying the write', async () => {
    const { fetchMock, calls } = createAliyunFetchMock({
      settings: (call) =>
        call <= 2
          ? jsonResponse(configuredSettings)
          : jsonResponse(
              { error: { code: 'ALIYUN_SETTINGS_UNAVAILABLE', message: '保存后重读阿里云服务设置失败' } },
              503,
            ),
      put: () => jsonResponse({}),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      expect(document.body.textContent).toContain('****ABCD')

      buttonByText('保存设置').click()
      await flushPromises()

      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)
      expect(countCalls(calls, 'GET', '/api/v1/aliyun/settings')).toBe(3)
      expect(document.body.textContent).toContain('保存后重读阿里云服务设置失败')
      // 成功语义不改写：保存通知保留，但读取失败按同一展示规则隐藏全部断言。
      expect(document.querySelector('.aliyun-saved')).not.toBeNull()
      expect(document.querySelector('#aliyun-credentials-title')).toBeNull()
      expect(document.querySelector('.settings-context')).toBeNull()
      expect(buttonByText('保存设置').disabled).toBe(true)

      await flushPromises()
      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)
      expect(countCalls(calls, 'DELETE', '/api/v1/aliyun/settings/credentials')).toBe(0)
      assertOnlyAllowedRequests(calls)
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps loaded settings editable when only the usage ledger read fails', async () => {
    const { fetchMock, calls } = createAliyunFetchMock({
      usage: () =>
        jsonResponse({ error: { code: 'LEDGER_UNAVAILABLE', message: '本地保护账本暂时不可用' } }, 503),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      expect(document.querySelector('#aliyun-credentials-title')?.textContent).toBe('凭据')
      expect(document.body.textContent).toContain('****ABCD')
      expect(document.body.textContent).toContain('本地保护账本暂时不可用 请重试；表单仍可编辑。')
      expect(document.body.textContent).toContain('当前月账本尚未读取。')
      const usageRetry = Array.from(document.querySelectorAll('button')).find((entry) =>
        entry.textContent?.includes('重试'),
      )
      expect(usageRetry).toBeDefined()
      expect(buttonByText('保存设置').disabled).toBe(false)
      const numbers = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
      await setInput(numbers[0]!, '900000')
      expect(numbers[0]!.value).toBe('900000')
      assertOnlyAllowedRequests(calls)
    } finally {
      wrapper.unmount()
    }
  })

  it('submits the click-time snapshot when a field is edited while the pre-save GET is pending', async () => {
    const putBodies: Record<string, unknown>[] = []
    const settingsResolvers: Array<(response: Response) => void> = []
    const { fetchMock, calls } = createAliyunFetchMock({
      settings: (call) =>
        call === 2
          ? new Promise<Response>((resolve) => {
              settingsResolvers.push(resolve)
            })
          : jsonResponse(call === 1 ? configuredSettings : generalSavedSettings),
      put: (body) => {
        putBodies.push(body)
        return jsonResponse({})
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      const numbers = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
      await setInput(numbers[0]!, '900001')
      buttonByText('保存设置').click()
      await flushPromises()
      // PUT 前 GET 在途：合同保留，PUT 尚未发出，表单仍可编辑下一份草稿。
      expect(countCalls(calls, 'GET', '/api/v1/aliyun/settings')).toBe(2)
      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(0)
      await setInput(numbers[0]!, '900002')

      settingsResolvers[0]!(jsonResponse(configuredSettings))
      await flushPromises()

      // PUT 携带点击保存时的快照 900001，不把 GET 在途期间输入的 900002 偷偷提交。
      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)
      expect(putBodies[0]?.translation).toMatchObject({ generalMonthlyLimit: 900001 })
      // 下一份草稿保留，且不用通用成功反馈暗示它已保存。
      expect(document.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('900002')
      expect(document.querySelector('.aliyun-saved')).toBeNull()
      assertOnlyAllowedRequests(calls)
    } finally {
      for (const resolve of settingsResolvers) resolve(jsonResponse(generalSavedSettings))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('keeps the next draft and its whole credential pair when edited while the PUT is pending', async () => {
    const putBodies: Record<string, unknown>[] = []
    let resolvePut: ((response: Response) => void) | undefined
    const { fetchMock, calls } = createAliyunFetchMock({
      settings: (call) => jsonResponse(call <= 2 ? configuredSettings : generalSavedSettings),
      put: (body) => {
        putBodies.push(body)
        return new Promise<Response>((resolve) => {
          resolvePut = resolve
        })
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      const numbers = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
      await setInput(numbers[0]!, '900001')
      buttonByText('保存设置').click()
      await flushPromises()
      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)

      // PUT 在途期间输入下一份草稿：新额度 + 一整对新凭据。
      await setInput(numbers[0]!, '900002')
      await setInput(document.querySelector<HTMLInputElement>('input[autocomplete="off"]')!, 'LTAI5nextDraft')
      await setInput(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'next-draft-secret')

      resolvePut!(jsonResponse({}))
      await flushPromises()

      // 已提交的是点击快照：900001 且不含凭据。
      expect(putBodies[0]?.translation).toMatchObject({ generalMonthlyLimit: 900001 })
      expect(Object.hasOwn(putBodies[0]!, 'credentials')).toBe(false)
      // 下一份草稿完整保留：额度不被回显覆盖，新凭据对不被清掉也不拆成半对。
      expect(document.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('900002')
      expect(document.querySelector<HTMLInputElement>('input[autocomplete="off"]')?.value).toBe('LTAI5nextDraft')
      expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('next-draft-secret')
      // B 尚未保存：不显示通用成功反馈；credentials/status 仍照常刷新为服务端最新值。
      expect(document.querySelector('.aliyun-saved')).toBeNull()
      expect(document.body.textContent).toContain('凭据版本 v3')
      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)
      assertOnlyAllowedRequests(calls)
    } finally {
      resolvePut?.(jsonResponse({}))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('restores the pending draft after the post-save reread fails and the manual retry succeeds, without replaying the write', async () => {
    let resolvePut: ((response: Response) => void) | undefined
    const { fetchMock, calls } = createAliyunFetchMock({
      settings: (call) => {
        if (call <= 2) return jsonResponse(configuredSettings)
        if (call === 3) {
          return jsonResponse(
            { error: { code: 'ALIYUN_SETTINGS_UNAVAILABLE', message: '保存后重读阿里云服务设置失败' } },
            503,
          )
        }
        return jsonResponse(generalSavedSettings)
      },
      put: () =>
        new Promise<Response>((resolve) => {
          resolvePut = resolve
        }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      const numbers = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
      await setInput(numbers[0]!, '900001')
      buttonByText('保存设置').click()
      await flushPromises()
      await setInput(numbers[0]!, '900002')
      resolvePut!(jsonResponse({}))
      await flushPromises()

      // 保存后重读失败：沿用未知状态（错误 + 只读重试、禁用保存）；PUT 已确认但有新草稿，不显示成功反馈。
      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)
      expect(document.body.textContent).toContain('保存后重读阿里云服务设置失败')
      expect(document.querySelector('#aliyun-credentials-title')).toBeNull()
      expect(buttonByText('保存设置').disabled).toBe(true)
      expect(document.querySelector('.aliyun-saved')).toBeNull()

      buttonByText('重试').click()
      await flushPromises()

      // 手动重试只发 GET：草稿 900002 仍在，不被覆盖为已保存的 900001，也不重放 PUT。
      expect(countCalls(calls, 'GET', '/api/v1/aliyun/settings')).toBe(4)
      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)
      expect(countCalls(calls, 'DELETE', '/api/v1/aliyun/settings/credentials')).toBe(0)
      expect(document.querySelector('.settings-loading')).toBeNull()
      expect(document.querySelector('#aliyun-credentials-title')?.textContent).toBe('凭据')
      expect(document.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('900002')
      expect(document.querySelector('.aliyun-saved')).toBeNull()
      expect(buttonByText('保存设置').disabled).toBe(false)
      assertOnlyAllowedRequests(calls)
    } finally {
      resolvePut?.(jsonResponse({}))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('shows the saved notice for an unedited submit, clears this credential pair, then drops the notice on the next edit', async () => {
    const putBodies: Record<string, unknown>[] = []
    const { fetchMock, calls } = createAliyunFetchMock({
      settings: (call) => jsonResponse(call === 1 ? configuredSettings : generalSavedSettings),
      put: (body) => {
        putBodies.push(body)
        return jsonResponse({})
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      const numbers = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
      await setInput(numbers[0]!, '900001')
      await setInput(document.querySelector<HTMLInputElement>('input[autocomplete="off"]')!, 'LTAI5replacePair')
      await setInput(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'replace-pair-secret')
      buttonByText('保存设置').click()
      await flushPromises()

      // 正常路径：PUT 携带本次凭据对；成功后清掉本次凭据、回显服务端值并显示成功反馈。
      expect(putBodies[0]?.credentials).toEqual({
        accessKeyId: 'LTAI5replacePair',
        accessKeySecret: 'replace-pair-secret',
      })
      expect(document.querySelector<HTMLInputElement>('input[autocomplete="off"]')?.value).toBe('')
      expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('')
      expect(document.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('900001')
      expect(document.body.textContent).toContain('凭据版本 v3')
      expect(document.querySelector('.aliyun-saved')).not.toBeNull()

      // 之后一旦编辑，旧的成功反馈清除，不再暗示当前草稿已保存。
      await setInput(document.querySelector<HTMLInputElement>('input[type="number"]')!, '900000')
      expect(document.querySelector('.aliyun-saved')).toBeNull()
      expect(countCalls(calls, 'PUT', '/api/v1/aliyun/settings')).toBe(1)
      assertOnlyAllowedRequests(calls)
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps the newer ledger when an earlier usage read succeeds late, and validates against the newer values', async () => {
    const usageResolvers: Array<(response: Response) => void> = []
    const { fetchMock, calls } = createAliyunFetchMock({
      usage: (call) =>
        call === 1
          ? new Promise<Response>((resolve) => {
              usageResolvers.push(resolve)
            })
          : jsonResponse(usageLatestRead),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      // 初次账本读取挂起、settings 已成功：保存照常进行，并触发较新的账本读取。
      buttonByText('保存设置').click()
      await flushPromises()
      expect(countCalls(calls, 'GET', '/api/v1/aliyun/usage/current')).toBe(2)
      expect(document.body.textContent).toContain('899,746')

      // 更早发出的读取此时才成功到达：不得覆盖较新结果。
      usageResolvers[0]!(jsonResponse(usageStaleRead))
      await flushPromises()
      expect(document.body.textContent).not.toContain('899,900')
      expect(document.body.textContent).toContain('当前月已用 250、预留 5')

      // 本地额度判断用的是较新账本：200 低于 255 被阻止，不再发任何请求。
      const requestsBefore = calls.length
      await setInput(document.querySelector<HTMLInputElement>('input[type="number"]')!, '200')
      buttonByText('保存设置').click()
      await flushPromises()
      expect(document.body.textContent).toContain('低于当前月已用与预留之和 255')
      expect(calls).toHaveLength(requestsBefore)
    } finally {
      for (const resolve of usageResolvers) resolve(jsonResponse(usageStaleRead))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('ignores a late failure from an earlier usage read after a newer read already succeeded', async () => {
    const usageResolvers: Array<(response: Response) => void> = []
    const { fetchMock, calls } = createAliyunFetchMock({
      usage: (call) =>
        call === 1
          ? new Promise<Response>((resolve) => {
              usageResolvers.push(resolve)
            })
          : jsonResponse(usageLatestRead),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      buttonByText('保存设置').click()
      await flushPromises()
      expect(countCalls(calls, 'GET', '/api/v1/aliyun/usage/current')).toBe(2)
      expect(document.body.textContent).toContain('899,746')

      // 更早发出的读取以 503 迟到：既不清空较新账本，也不显示它的错误。
      usageResolvers[0]!(
        jsonResponse({ error: { code: 'LEDGER_UNAVAILABLE', message: '本地保护账本暂时不可用' } }, 503),
      )
      await flushPromises()
      expect(document.body.textContent).toContain('899,746')
      expect(document.body.textContent).not.toContain('本地保护账本暂时不可用')
      expect(document.body.textContent).toContain('当前月已用 250、预留 5')
    } finally {
      for (const resolve of usageResolvers) resolve(jsonResponse(usageLatestRead))
      await flushPromises()
      wrapper.unmount()
    }
  })

  it('hides the previous ledger while the current read is pending, then shows the pending state again during the read-only retry', async () => {
    const usageResolvers: Array<(response: Response) => void> = []
    const { fetchMock, calls } = createAliyunFetchMock({
      usage: (call) =>
        call === 1
          ? jsonResponse(usageCurrent)
          : new Promise<Response>((resolve) => {
              usageResolvers.push(resolve)
            }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountAliyunView()
    try {
      await flushPromises()
      expect(document.body.textContent).toContain('948,800')

      // 保存后账本重新读取在途：旧用量与旧校验提示都不再显示，改为读取中。
      buttonByText('保存设置').click()
      await flushPromises()
      expect(document.body.textContent).not.toContain('948,800')
      expect(document.body.textContent).toContain('正在读取本月账本')
      expect(document.body.textContent).not.toContain('当前月已用')

      // 当前读取真失败：显示错误与只读重试。
      usageResolvers[0]!(
        jsonResponse({ error: { code: 'LEDGER_UNAVAILABLE', message: '本地保护账本暂时不可用' } }, 503),
      )
      await flushPromises()
      expect(document.body.textContent).toContain('本地保护账本暂时不可用')

      // 失败后继续编辑草稿，再点只读重试：重试在途同样显示读取中。
      await setInput(document.querySelector<HTMLInputElement>('input[type="number"]')!, '900002')
      buttonByText('重试').click()
      await flushPromises()
      expect(document.body.textContent).toContain('正在读取本月账本')

      usageResolvers[1]!(jsonResponse(usageCurrent))
      await flushPromises()
      // 重试成功：账本恢复显示，草稿保留，只有 usage GET 增加。
      expect(document.body.textContent).toContain('948,800')
      expect(document.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('900002')
      expect([
        countCalls(calls, 'GET', '/api/v1/aliyun/settings'),
        countCalls(calls, 'PUT', '/api/v1/aliyun/settings'),
        countCalls(calls, 'GET', '/api/v1/aliyun/usage/current'),
      ]).toEqual([3, 1, 3])
    } finally {
      for (const resolve of usageResolvers) resolve(jsonResponse(usageCurrent))
      await flushPromises()
      wrapper.unmount()
    }
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

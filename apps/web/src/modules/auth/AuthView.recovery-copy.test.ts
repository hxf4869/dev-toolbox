// 装置沿用相邻 AuthView 用例：真实 Pinia、attachTo document.body、stubGlobal(fetch) 与原生事件驱动；全部凭据与恢复码均为合成数据。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import AuthView from './AuthView.vue'

const SYNTHETIC_PASSWORD = 'synthetic-owner-password'
const SYNTHETIC_TOTP_CODE = '123456'
const SYNTHETIC_RECOVERY_CODES = Array.from({ length: 10 }, (_, index) =>
  `R88TEST-0000-${String(index + 1).padStart(4, '0')}`,
)

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 复制按钮根节点是原生 button（UiButton），图标不产生文本；按「文案包含」在公开 DOM 中定位可用按钮。
function findEnabledButton(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => !button.disabled && (button.textContent ?? '').includes(text),
  )
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

describe('AuthView 恢复码复制失败反馈与重试', () => {
  let wrapper: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('剪贴板拒绝后以 role=alert 提示手动复制且恢复码页保持可用，重试成功后显示已复制且不新增请求', async () => {
    // apiRequest 依赖 fetch 响应的 status/ok/json()；两次调用依次对应 session 引导与恢复码重生成。
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'authenticated',
          owner: { id: 'owner-r88', username: 'ops-owner' },
          session: { id: 'session-r88-1', expiresAt: '2030-05-05T01:00:00Z' },
          csrfToken: 'csrf-r88-1',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { recoveryCodes: SYNTHETIC_RECOVERY_CODES }))
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.bootstrap()
    await auth.regenerateRecoveryCodes(SYNTHETIC_PASSWORD, 'totp', SYNTHETIC_TOTP_CODE)
    expect(auth.stage).toBe('recovery_codes')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 复制操作只读会话状态；快照深拷贝，避免原对象被就地修改时误判相等。
    const sessionSnapshot = {
      csrfToken: auth.csrfToken,
      owner: JSON.parse(JSON.stringify(auth.owner)),
      session: JSON.parse(JSON.stringify(auth.session)),
    }

    wrapper = mount(AuthView, { attachTo: document.body })
    await flushPromises()

    // 整体替换 navigator.clipboard，测试不触真实系统剪贴板；第一次写入拒绝、第二次成功。
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await flushPromises()
    const copyButton = findEnabledButton('全部复制')
    expect(copyButton).toBeInstanceOf(HTMLButtonElement)

    // 第一次复制被剪贴板权限拒绝：本地给出手动复制指引，恢复码页状态与请求均不受影响。
    copyButton!.click()
    await flushPromises()
    await flushPromises()

    const alert = document.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('剪贴板')
    expect(alert!.textContent).toContain('手动')
    const renderedCodes = Array.from(document.querySelectorAll('.recovery__codes code')).map(
      (element) => element.textContent,
    )
    expect(renderedCodes).toEqual(SYNTHETIC_RECOVERY_CODES)
    expect(auth.stage).toBe('recovery_codes')
    const downloadButton = findEnabledButton('下载备份')
    const continueButton = findEnabledButton('我已保存并继续')
    expect(downloadButton).toBeInstanceOf(HTMLButtonElement)
    expect(continueButton).toBeInstanceOf(HTMLButtonElement)
    expect(downloadButton!.disabled).toBe(false)
    expect(continueButton!.disabled).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 第二次点击重试成功：错误提示消失、按钮显示已复制；写入文本是 10 码以真实换行符连接的全文。
    copyButton!.click()
    await flushPromises()
    await flushPromises()

    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(copyButton!.textContent).toContain('已复制')
    expect(writeText).toHaveBeenCalledTimes(2)
    const copiedText = String(writeText.mock.lastCall![0])
    expect(copiedText).toBe(SYNTHETIC_RECOVERY_CODES.join('\n'))
    expect(copiedText.split('\n')).toEqual(SYNTHETIC_RECOVERY_CODES)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.csrfToken).toBe(sessionSnapshot.csrfToken)
    expect(auth.owner).toEqual(sessionSnapshot.owner)
    expect(auth.session).toEqual(sessionSnapshot.session)
  })
})

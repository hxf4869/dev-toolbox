import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CopyButton from './CopyButton.vue'

const TEXT = 'copy-button-sample-text'
const LABEL = '复制识别文字'
const FEEDBACK_MS = 1600

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

type WriteTextMock = ReturnType<typeof vi.fn>

function installClipboard(writeText: WriteTextMock) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

async function flushCopyWork() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard
  }
  vi.useRealTimers()
})

describe('CopyButton copy feedback and error recovery', () => {
  it('shows a retryable role=alert error after rejection, clears stale copied state on a later rejection, and fully recovers on success', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn()
      .mockRejectedValueOnce(new DOMException('Clipboard write was blocked', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('Clipboard write was blocked', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)

    const wrapper = mount(CopyButton, { props: { text: TEXT, label: LABEL } })
    const button = wrapper.get('button')

    // 拒绝：可见 role=alert 错误区写明原因（剪贴板）与下一步（手动），按钮仍可重试。
    await button.trigger('click')
    await flushCopyWork()

    const firstAlert = wrapper.find('[role="alert"]')
    expect(firstAlert.exists()).toBe(true)
    expect(firstAlert.text()).toContain('剪贴板')
    expect(firstAlert.text()).toContain('手动')
    expect(button.attributes('disabled')).toBeUndefined()

    // 拒绝后重试成功：显示“已复制”。
    await button.trigger('click')
    await flushCopyWork()

    expect(button.text()).toContain('已复制')

    // 成功后再次拒绝（反馈计时器未到期）：不得残留“已复制”，错误区再次可见。
    await button.trigger('click')
    await flushCopyWork()

    expect(button.text()).not.toContain('已复制')
    const secondAlert = wrapper.get('[role="alert"]')
    expect(secondAlert.text()).toContain('剪贴板')
    expect(secondAlert.text()).toContain('手动')

    // 之后再次成功：错误区消失，显示“已复制”，以原始 text 调用，反馈到期后退回原 label。
    await button.trigger('click')
    await flushCopyWork()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(button.text()).toContain('已复制')
    expect(writeText).toHaveBeenCalledTimes(4)
    expect(writeText).toHaveBeenLastCalledWith(TEXT)

    await vi.advanceTimersByTimeAsync(FEEDBACK_MS)

    expect(button.text()).not.toContain('已复制')
    expect(button.text()).toContain(LABEL)
    wrapper.unmount()
  })

  it('disables the button when text is empty', () => {
    const wrapper = mount(CopyButton, { props: { text: '' } })

    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('renders a custom label', () => {
    const wrapper = mount(CopyButton, { props: { text: TEXT, label: LABEL } })

    expect(wrapper.get('button').text()).toContain(LABEL)
    expect(wrapper.get('button').text()).not.toContain('已复制')
    wrapper.unmount()
  })

  it('shows copied feedback on success and reverts after the feedback window', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)

    const wrapper = mount(CopyButton, { props: { text: TEXT } })
    const button = wrapper.get('button')
    expect(button.text()).toContain('复制')

    await button.trigger('click')
    await flushCopyWork()

    expect(button.text()).toContain('已复制')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(writeText).toHaveBeenLastCalledWith(TEXT)

    await vi.advanceTimersByTimeAsync(FEEDBACK_MS)

    expect(button.text()).not.toContain('已复制')
    expect(button.text()).toContain('复制')
    wrapper.unmount()
  })

  it('clears copied and error feedback synchronously when the text prop changes to a new text', async () => {
    vi.useFakeTimers()
    const A = 'dt-copy-first-text'
    const B = 'dt-copy-second-text'
    const C = 'dt-copy-third-text'
    const writeText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('Clipboard write was blocked', 'NotAllowedError'))
    installClipboard(writeText)

    const wrapper = mount(CopyButton, { props: { text: A, label: LABEL } })
    try {
      const button = wrapper.get('button')
      const clickNativeButton = () => {
        const element = button.element
        expect(element instanceof HTMLButtonElement).toBe(true)
        const nativeButton = element as HTMLButtonElement
        expect(nativeButton.disabled).toBe(false)
        nativeButton.click()
      }

      // A 复制成功：显示“已复制”。
      clickNativeButton()
      await flushCopyWork()

      expect(button.text()).toContain('已复制')

      // text 变为 B：成功反馈立即清除，恢复原 label，不残留错误区。
      await wrapper.setProps({ text: B })

      expect(button.text()).not.toContain('已复制')
      expect(button.text()).toContain(LABEL)
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)

      // B 复制拒绝：出现含“剪贴板”的 role=alert 错误。
      clickNativeButton()
      await flushCopyWork()

      expect(wrapper.get('[role="alert"]').text()).toContain('剪贴板')

      // text 变为 C：错误反馈同步清除，恢复原 label，按钮仍 enabled。
      await wrapper.setProps({ text: C })

      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(button.text()).toContain(LABEL)
      expect(button.text()).not.toContain('已复制')
      expect(button.attributes('disabled')).toBeUndefined()

      expect(writeText).toHaveBeenNthCalledWith(1, A)
      expect(writeText).toHaveBeenNthCalledWith(2, B)
    } finally {
      wrapper.unmount()
    }
  })

  it('ignores late-settling stale copy promises so feedback only reflects the new text', async () => {
    vi.useFakeTimers()
    const A = 'dt-late-first-text'
    const B = 'dt-late-second-text'
    const C = 'dt-late-third-text'

    let resolveA: () => void = () => {}
    let resolveB: () => void = () => {}
    let rejectB: (reason?: unknown) => void = () => {}
    let settledA = false
    let settledB = false
    const gateA = new Promise<void>((resolve) => {
      resolveA = resolve
    })
    const gateB = new Promise<void>((resolve, reject) => {
      resolveB = resolve
      rejectB = reject
    })
    const writeText = vi.fn()
      .mockReturnValueOnce(gateA)
      .mockReturnValueOnce(gateB)
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)

    const wrapper = mount(CopyButton, { props: { text: A } })
    try {
      const button = wrapper.get('button')
      const clickNativeButton = () => {
        const element = button.element
        expect(element instanceof HTMLButtonElement).toBe(true)
        const nativeButton = element as HTMLButtonElement
        expect(nativeButton.disabled).toBe(false)
        nativeButton.click()
      }

      // A 的写入 promise 挂起时切换到 B；A 晚到的成功不得把“已复制”挂到 B 上。
      clickNativeButton()
      await flushCopyWork()

      await wrapper.setProps({ text: B })
      settledA = true
      resolveA()
      await flushCopyWork()

      expect(button.text()).not.toContain('已复制')
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)

      // B 的写入 promise 挂起时切换到 C；B 晚到的拒绝不得在 C 上报错或 emit error。
      clickNativeButton()
      await flushCopyWork()

      await wrapper.setProps({ text: C })
      settledB = true
      rejectB(new DOMException('Clipboard write was blocked', 'NotAllowedError'))
      await flushCopyWork()

      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(wrapper.emitted('error')).toBeUndefined()

      // C 复制成功：恢复“已复制”。
      clickNativeButton()
      await flushCopyWork()

      expect(button.text()).toContain('已复制')

      expect(writeText).toHaveBeenNthCalledWith(1, A)
      expect(writeText).toHaveBeenNthCalledWith(2, B)
      expect(writeText).toHaveBeenNthCalledWith(3, C)
    } finally {
      if (!settledA) resolveA()
      if (!settledB) resolveB()
      wrapper.unmount()
    }
  })
})

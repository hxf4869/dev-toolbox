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

function deferred() {
  let resolve: () => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function blockedClipboardError() {
  return new DOMException('Clipboard write was blocked', 'NotAllowedError')
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

describe('CopyButton attributes feedback to the latest copy request', () => {
  it('keeps the newer success when an older same-text request fails late', async () => {
    vi.useFakeTimers()
    const older = deferred()
    const newer = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    installClipboard(writeText)

    const wrapper = mount(CopyButton, { props: { text: TEXT, label: LABEL } })
    try {
      const button = wrapper.get('button')

      // 同一文本连续点击两次，两次写入都挂起。
      await button.trigger('click')
      await button.trigger('click')
      await flushCopyWork()

      expect(writeText).toHaveBeenCalledTimes(2)

      // 较新的第二次先成功：显示“已复制”。
      newer.resolve()
      await flushCopyWork()

      expect(button.text()).toContain('已复制')

      // 较旧的第一次随后失败：不得清掉“已复制”、不得出现错误区、不得 emit error。
      older.reject(blockedClipboardError())
      await flushCopyWork()

      expect(button.text()).toContain('已复制')
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(wrapper.emitted('error')).toBeUndefined()

      // 反馈窗口仍归属当前成功：到期后退回原 label。
      await vi.advanceTimersByTimeAsync(FEEDBACK_MS)

      expect(button.text()).not.toContain('已复制')
      expect(button.text()).toContain(LABEL)
    } finally {
      older.resolve()
      newer.resolve()
      wrapper.unmount()
    }
  })

  it('keeps the newer failure when an older same-text request succeeds late', async () => {
    vi.useFakeTimers()
    const older = deferred()
    const newer = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    installClipboard(writeText)

    const wrapper = mount(CopyButton, { props: { text: TEXT, label: LABEL } })
    try {
      const button = wrapper.get('button')

      await button.trigger('click')
      await button.trigger('click')
      await flushCopyWork()

      // 较新的第二次先失败：出现 role=alert 错误并 emit 一次 error。
      newer.reject(blockedClipboardError())
      await flushCopyWork()

      expect(wrapper.get('[role="alert"]').text()).toContain('剪贴板')
      expect(wrapper.emitted('error')).toHaveLength(1)

      // 较旧的第一次随后成功：错误区必须保留，不得显示“已复制”，error 既不重复也不被撤销。
      older.resolve()
      await flushCopyWork()

      expect(wrapper.get('[role="alert"]').text()).toContain('剪贴板')
      expect(button.text()).not.toContain('已复制')
      expect(button.text()).toContain(LABEL)
      expect(wrapper.emitted('error')).toHaveLength(1)
    } finally {
      older.resolve()
      newer.resolve()
      wrapper.unmount()
    }
  })

  it('ignores a stale request after the text changes away and back to the same value', async () => {
    vi.useFakeTimers()
    const A = 'dt-roundtrip-first-text'
    const B = 'dt-roundtrip-second-text'
    const lateSuccess = deferred()
    const lateFailure = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(lateSuccess.promise)
      .mockReturnValueOnce(lateFailure.promise)
    installClipboard(writeText)

    const wrapper = mount(CopyButton, { props: { text: A, label: LABEL } })
    try {
      const button = wrapper.get('button')

      // A 的写入挂起时 A→B→A：晚到的成功不得显示“已复制”。
      await button.trigger('click')
      await flushCopyWork()
      await wrapper.setProps({ text: B })
      await wrapper.setProps({ text: A })
      lateSuccess.resolve()
      await flushCopyWork()

      expect(button.text()).not.toContain('已复制')
      expect(button.text()).toContain(LABEL)

      // 再次点击 A 后 A→B→A：晚到的拒绝不得报错，也不得 emit error。
      await button.trigger('click')
      await flushCopyWork()
      await wrapper.setProps({ text: B })
      await wrapper.setProps({ text: A })
      lateFailure.reject(blockedClipboardError())
      await flushCopyWork()

      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(wrapper.emitted('error')).toBeUndefined()
      expect(writeText).toHaveBeenNthCalledWith(1, A)
      expect(writeText).toHaveBeenNthCalledWith(2, A)
    } finally {
      lateSuccess.resolve()
      lateFailure.resolve()
      wrapper.unmount()
    }
  })

  it('discards requests that settle after unmount without scheduling feedback or emitting error', async () => {
    vi.useFakeTimers()
    const lateSuccess = deferred()
    const lateFailure = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(lateSuccess.promise)
      .mockReturnValueOnce(lateFailure.promise)
    installClipboard(writeText)
    const onError = vi.fn()

    const wrapper = mount(CopyButton, { props: { text: TEXT }, attrs: { onError } })
    try {
      const button = wrapper.get('button')

      // 两次写入都挂起时卸载（对应 JSON 结果区 v-if 切走）。
      await button.trigger('click')
      await button.trigger('click')
      await flushCopyWork()
      wrapper.unmount()

      expect(writeText).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)

      // 晚到的成功不得在已卸载组件上再排 1600ms 反馈计时器。
      lateSuccess.resolve()
      await flushCopyWork()

      expect(vi.getTimerCount()).toBe(0)

      // 晚到的失败不得再向父组件 emit error。
      lateFailure.reject(blockedClipboardError())
      await flushCopyWork()

      expect(onError).not.toHaveBeenCalled()
    } finally {
      lateSuccess.resolve()
      lateFailure.resolve()
    }
  })
})

describe('CopyButton live text opt-in', () => {
  it('keeps success feedback attributed to the click when text changes while liveText is enabled, then copies the new text on the next click', async () => {
    vi.useFakeTimers()
    const A = 'dt-live-first-text'
    const B = 'dt-live-second-text'
    const gate = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)

    const wrapper = mount(CopyButton, { props: { text: A, label: LABEL, liveText: true } })
    try {
      const button = wrapper.get('button')

      await button.trigger('click')
      await flushCopyWork()
      expect(writeText).toHaveBeenCalledTimes(1)

      // text 自然更新为 B：live 值更新不作废在途复制、不清除反馈。
      await wrapper.setProps({ text: B })
      gate.resolve()
      await flushCopyWork()

      expect(button.text()).toContain('已复制')

      await vi.advanceTimersByTimeAsync(FEEDBACK_MS)

      expect(button.text()).not.toContain('已复制')
      expect(button.text()).toContain(LABEL)

      // 下一次点击复制当时最新 text。
      await button.trigger('click')
      await flushCopyWork()

      expect(button.text()).toContain('已复制')
      expect(writeText).toHaveBeenNthCalledWith(2, B)
    } finally {
      gate.resolve()
      wrapper.unmount()
    }
  })

  it('keeps a retryable local failure when text changes while liveText is enabled', async () => {
    vi.useFakeTimers()
    const A = 'dt-live-fail-first'
    const B = 'dt-live-fail-second'
    const gate = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)

    const wrapper = mount(CopyButton, { props: { text: A, label: LABEL, liveText: true } })
    try {
      const button = wrapper.get('button')

      await button.trigger('click')
      await flushCopyWork()

      await wrapper.setProps({ text: B })
      gate.reject(blockedClipboardError())
      await flushCopyWork()

      const alert = wrapper.get('[role="alert"]')
      expect(alert.text()).toContain('剪贴板')
      expect(button.attributes('disabled')).toBeUndefined()

      await button.trigger('click')
      await flushCopyWork()

      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(button.text()).toContain('已复制')
      expect(writeText).toHaveBeenNthCalledWith(2, B)
    } finally {
      gate.resolve()
      wrapper.unmount()
    }
  })
})

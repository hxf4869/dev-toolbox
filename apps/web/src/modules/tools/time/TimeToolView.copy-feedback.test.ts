import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { currentTime, type TimeSnapshot } from './time'
import TimeToolView from './TimeToolView.vue'

// 仅控制 currentTime 边界：用受控快照驱动 1000ms 时钟刷新；其余时间换算保留真实实现。
vi.mock('./time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./time')>()
  return { ...actual, currentTime: vi.fn(actual.currentTime) }
})

// 预热 @js-temporal/polyfill 的首次动态导入：测试内启用 fake timers 后只依赖微任务推进。
beforeAll(async () => {
  await currentTime('UTC')
})

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

type WriteTextMock = ReturnType<typeof vi.fn>

function installClipboard(writeText: WriteTextMock) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

async function flushWork() {
  for (let round = 0; round < 6; round += 1) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

function blockedClipboardError() {
  return new DOMException('Clipboard write was blocked', 'NotAllowedError')
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

function mountView(onError: (error: unknown) => void) {
  return mount(TimeToolView, { global: { config: { errorHandler: onError } } })
}

function clockCopyButton(wrapper: VueWrapper) {
  return wrapper.get('.clock-card button')
}

function conversionPrimaryButton(wrapper: VueWrapper) {
  const button = wrapper.findAll('button.button--primary').find((item) => item.text() === '转换时间')
  expect(button).toBeDefined()
  return button!
}

function resultRow(wrapper: VueWrapper, fragment: string) {
  const row = wrapper.findAll('.result-list > div').find((item) => item.text().includes(fragment))
  expect(row).toBeDefined()
  return row!
}

afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard
  }
  vi.useRealTimers()
})

describe('TimeToolView copy feedback', () => {
  it('shows a local retryable alert on clipboard rejection for the current time copy without reaching the app errorHandler, then visible feedback on retry', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const writeText = vi.fn()
      .mockRejectedValueOnce(blockedClipboardError())
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)

    const wrapper = mountView(onError)
    await flushWork()

    expect(clockCopyButton(wrapper).text()).toContain('复制当前时间')
    const clockBefore = wrapper.get('.clock-card strong').text()

    // 拒绝：错误在按钮旁本地可见、写明剪贴板原因与手动复制下一步，按钮仍可重试，且不冒泡到 app errorHandler。
    await clockCopyButton(wrapper).trigger('click')
    await flushWork()

    const alert = wrapper.find('.clock-card [role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('剪贴板')
    expect(alert.text()).toContain('手动')
    expect(clockCopyButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(onError).not.toHaveBeenCalled()

    // 重试成功：反馈直接显示在按钮上（可见），时钟展示保留，不再依赖 sr-only 通道。
    await clockCopyButton(wrapper).trigger('click')
    await flushWork()

    expect(clockCopyButton(wrapper).text()).toContain('已复制')
    expect(wrapper.get('.clock-card strong').text()).toBe(clockBefore)
    expect(wrapper.find('.sr-only[aria-live="polite"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('discards an in-flight result row copy when the conversion input changes and shows visible feedback for the new result', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const gate = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)

    const wrapper = mountView(onError)
    await flushWork()

    await wrapper.get('#conversion-kind').setValue('unix_seconds')
    await wrapper.get('#conversion-input').setValue('0')
    await conversionPrimaryButton(wrapper).trigger('click')
    await flushWork()

    expect(wrapper.get('.result-list').text()).toContain('1970-01-01T00:00:00Z')

    // ISO 行复制在途：输入变化同时移除整张结果卡（结果卸载路径），晚到的写入不得再反馈。
    await resultRow(wrapper, '1970-01-01T00:00:00Z').get('button').trigger('click')
    await flushWork()
    expect(writeText).toHaveBeenCalledTimes(1)

    await wrapper.get('#conversion-input').setValue('1')
    expect(wrapper.find('.result-list').exists()).toBe(false)

    gate.resolve()
    await flushWork()

    expect(wrapper.text()).not.toContain('已复制')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(onError).not.toHaveBeenCalled()

    // 新结果出现新的复制入口：成功反馈可见在按钮上，结果内容保留。
    await conversionPrimaryButton(wrapper).trigger('click')
    await flushWork()
    expect(wrapper.get('.result-list').text()).toContain('1970-01-01T00:00:01Z')

    await resultRow(wrapper, '1970-01-01T00:00:01Z').get('button').trigger('click')
    await flushWork()

    expect(resultRow(wrapper, '1970-01-01T00:00:01Z').get('button').text()).toContain('已复制')
    expect(wrapper.get('.result-list').text()).toContain('1970-01-01T00:00:01Z')
    expect(onError).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

function clockSnapshot(zoned: string): TimeSnapshot {
  return {
    unixSeconds: '1780868800',
    unixMilliseconds: '1780868800000',
    iso: '2026-06-08T02:26:40Z',
    utc: '2026-06-08T02:26:40+00:00[UTC]',
    local: '2026-06-08T02:26:40+00:00[UTC]',
    zoned,
    offset: '+08:00',
    timeZone: 'Asia/Shanghai',
  }
}

describe('TimeToolView current time copy across clock ticks', () => {
  const CLOCK_A = clockSnapshot('2026-06-08T10:26:40+08:00[Asia/Shanghai]')
  const CLOCK_B = clockSnapshot('2026-06-08T10:26:41+08:00[Asia/Shanghai]')

  beforeEach(() => {
    vi.mocked(currentTime).mockClear()
  })

  it('keeps in-flight copy feedback attributed to the click snapshot after the clock ticks, then copies the latest value on the next click', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const gate = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)
    vi.mocked(currentTime)
      .mockReturnValueOnce(Promise.resolve(CLOCK_A))
      .mockReturnValueOnce(Promise.resolve(CLOCK_B))

    const wrapper = mountView(onError)
    await flushWork()

    expect(wrapper.get('.clock-card strong').text()).toContain(CLOCK_A.zoned)

    await clockCopyButton(wrapper).trigger('click')
    await flushWork()
    expect(writeText).toHaveBeenCalledTimes(1)

    // 实际触发 1000ms 时钟刷新：受控快照确保屏上时钟值真实从 A 变为 B。
    await vi.advanceTimersByTimeAsync(1000)
    await flushWork()
    const clockText = wrapper.get('.clock-card strong').text()
    expect(clockText).toContain(CLOCK_B.zoned)
    expect(clockText).not.toContain(CLOCK_A.zoned)

    // tick 之后在途写入才成功：反馈仍归属点击快照并可见，不进 app errorHandler。
    gate.resolve()
    await flushWork()

    expect(clockCopyButton(wrapper).text()).toContain('已复制')
    expect(wrapper.get('.clock-card strong').text()).toContain(CLOCK_B.zoned)
    expect(onError).not.toHaveBeenCalled()

    // 下一次点击复制当时最新值 B，而不是点击快照之外的旧 A。
    await clockCopyButton(wrapper).trigger('click')
    await flushWork()

    expect(writeText).toHaveBeenNthCalledWith(1, CLOCK_A.zoned)
    expect(writeText).toHaveBeenNthCalledWith(2, CLOCK_B.zoned)
    expect(clockCopyButton(wrapper).text()).toContain('已复制')
    wrapper.unmount()
  })

  it('keeps a local retryable failure after the clock ticks and recovers by copying the latest value', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const gate = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)
    vi.mocked(currentTime)
      .mockReturnValueOnce(Promise.resolve(CLOCK_A))
      .mockReturnValueOnce(Promise.resolve(CLOCK_B))

    const wrapper = mountView(onError)
    await flushWork()
    expect(wrapper.get('.clock-card strong').text()).toContain(CLOCK_A.zoned)

    await clockCopyButton(wrapper).trigger('click')
    await flushWork()

    await vi.advanceTimersByTimeAsync(1000)
    await flushWork()
    expect(wrapper.get('.clock-card strong').text()).toContain(CLOCK_B.zoned)

    // tick 之后在途写入被拒绝：失败反馈仍归属点击快照，本地 alert 可见、按钮可重试、不进 app errorHandler。
    gate.reject(blockedClipboardError())
    await flushWork()

    const alert = wrapper.find('.clock-card [role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('剪贴板')
    expect(clockCopyButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(onError).not.toHaveBeenCalled()

    // 重试复制当时最新值 B 并恢复成功。
    await clockCopyButton(wrapper).trigger('click')
    await flushWork()

    expect(writeText).toHaveBeenNthCalledWith(2, CLOCK_B.zoned)
    expect(clockCopyButton(wrapper).text()).toContain('已复制')
    expect(wrapper.find('.clock-card [role="alert"]').exists()).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

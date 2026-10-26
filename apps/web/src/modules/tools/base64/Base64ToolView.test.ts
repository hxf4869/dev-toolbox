import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { transformBase64 } from './base64'
import Base64ToolView from './Base64ToolView.vue'

const ORIGINAL_TEXT = '开发百宝箱🔧'
const ENCODED_STANDARD = transformBase64(ORIGINAL_TEXT, 'encode', 'standard')

let activeWrapper: VueWrapper | undefined

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = undefined
  delete (navigator as { clipboard?: unknown }).clipboard
})

describe('Base64ToolView 输入与模式变更的显式失效合同', () => {
  it('手动编辑输入后旧结果被清空，需再次显式执行才得到新结果', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    expect(resultValue(wrapper)).toBe(ENCODED_STANDARD)

    await wrapper.get('#base64-input').setValue(`${ORIGINAL_TEXT}A`)

    expect(resultValue(wrapper)).toBe('')
    expect(
      wrapper.get('textarea[aria-label="Base64 转换结果"]').attributes('placeholder'),
    ).toBe('执行后在此显示')
    expect(isDisabled(wrapper, '交换输入/结果')).toBe(true)
    expect(isDisabled(wrapper, '复制结果')).toBe(true)

    await findButton(wrapper, '执行编码').trigger('click')

    expect(resultValue(wrapper)).toBe(transformBase64(`${ORIGINAL_TEXT}A`, 'encode', 'standard'))
  })

  it('手动编辑输入后清除旧的复制反馈', async () => {
    installClipboard()
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    await findButton(wrapper, '复制结果').trigger('click')
    await flushPromises()
    expect(wrapper.get('span.copy-status').text()).toBe('结果已复制')

    await wrapper.get('#base64-input').setValue(`${ORIGINAL_TEXT}B`)

    expect(wrapper.get('span.copy-status').text()).toBe('')
  })

  it('手动编辑输入后清除旧错误并恢复 aria-invalid，再显式执行得到当前结果', async () => {
    const wrapper = mountTool()
    await wrapper.get('input[value="decode"]').setValue()
    await wrapper.get('#base64-input').setValue('aGVsbG8-d29ybGQ')
    await findButton(wrapper, '执行解码').trigger('click')

    expect(wrapper.get('[role="alert"]').text()).toContain('不匹配')
    expect(wrapper.get('#base64-input').attributes('aria-invalid')).toBe('true')

    await wrapper.get('#base64-input').setValue(ENCODED_STANDARD)

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('#base64-input').attributes('aria-invalid')).not.toBe('true')

    await findButton(wrapper, '执行解码').trigger('click')

    expect(resultValue(wrapper)).toBe(ORIGINAL_TEXT)
  })

  it('显式切换操作或变体后旧结果清空且不自动执行', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    expect(resultValue(wrapper)).toBe(ENCODED_STANDARD)

    await wrapper.get('input[value="decode"]').setValue()
    expect(resultValue(wrapper)).toBe('')
    expect(isDisabled(wrapper, '交换输入/结果')).toBe(true)

    await wrapper.get('input[value="encode"]').setValue()
    await findButton(wrapper, '执行编码').trigger('click')
    expect(resultValue(wrapper)).toBe(ENCODED_STANDARD)

    await wrapper.get('input[value="url"]').setValue()
    expect(resultValue(wrapper)).toBe('')
    expect(isDisabled(wrapper, '复制结果')).toBe(true)
  })

  it('粘贴成功后输入更新为剪贴板内容且旧结果清空', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    expect(resultValue(wrapper)).toBe(ENCODED_STANDARD)

    installClipboard({ readText: vi.fn().mockResolvedValue('从剪贴板粘贴的新文本') })
    await findButton(wrapper, '粘贴').trigger('click')
    await flushPromises()

    expect(inputValue(wrapper)).toBe('从剪贴板粘贴的新文本')
    expect(resultValue(wrapper)).toBe('')
    expect(isDisabled(wrapper, '复制结果')).toBe(true)
  })
})

describe('Base64ToolView 现有行为守卫', () => {
  it('粘贴失败时显示剪贴板错误且输入与旧结果保持不变', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)

    installClipboard({ readText: vi.fn().mockRejectedValue(new Error('clipboard denied')) })
    await findButton(wrapper, '粘贴').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('剪贴板')
    expect(inputValue(wrapper)).toBe(ORIGINAL_TEXT)
    expect(resultValue(wrapper)).toBe(ENCODED_STANDARD)
  })

  it('交换输入/结果后双方互换且不自动再次执行', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)

    await findButton(wrapper, '交换输入/结果').trigger('click')

    expect(inputValue(wrapper)).toBe(ENCODED_STANDARD)
    expect(resultValue(wrapper)).toBe(ORIGINAL_TEXT)
    expect((wrapper.get('input[value="encode"]').element as HTMLInputElement).checked).toBe(true)
    expect((wrapper.get('input[value="standard"]').element as HTMLInputElement).checked).toBe(true)
    expect(isDisabled(wrapper, '复制结果')).toBe(false)
    expect(resultValue(wrapper)).not.toBe(transformBase64(ENCODED_STANDARD, 'encode', 'standard'))
  })

  it('显式切换到解码再执行可往返还原 UTF-8 文本', async () => {
    const wrapper = mountTool()
    await wrapper.get('#base64-input').setValue(ENCODED_STANDARD)
    await wrapper.get('input[value="decode"]').setValue()
    await findButton(wrapper, '执行解码').trigger('click')

    expect(resultValue(wrapper)).toBe(ORIGINAL_TEXT)
  })

  it('清空同时清除输入、结果与错误', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    installClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    await findButton(wrapper, '复制结果').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('复制未成功')

    await findButton(wrapper, '清空').trigger('click')

    expect(inputValue(wrapper)).toBe('')
    expect(resultValue(wrapper)).toBe('')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
})

describe('Base64ToolView 迟到粘贴只在仍属于当前输入上下文时生效', () => {
  it('粘贴等待期间手动编辑并执行后，迟到的粘贴成功不覆盖新输入与新结果', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    const clipboard = deferredClipboardRead()
    clipboard.install()
    await findButton(wrapper, '粘贴').trigger('click')

    await wrapper.get('#base64-input').setValue('等待期间手动输入')
    await findButton(wrapper, '执行编码').trigger('click')
    const manualResult = transformBase64('等待期间手动输入', 'encode', 'standard')
    expect(resultValue(wrapper)).toBe(manualResult)

    await clipboard.resolve('迟到的剪贴板内容')

    expect(inputValue(wrapper)).toBe('等待期间手动输入')
    expect(resultValue(wrapper)).toBe(manualResult)
    expect(isDisabled(wrapper, '复制结果')).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('粘贴等待期间清空后，迟到的粘贴成功不回填输入', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    const clipboard = deferredClipboardRead()
    clipboard.install()
    await findButton(wrapper, '粘贴').trigger('click')

    await findButton(wrapper, '清空').trigger('click')
    expect(inputValue(wrapper)).toBe('')

    await clipboard.resolve('迟到的剪贴板内容')

    expect(inputValue(wrapper)).toBe('')
    expect(resultValue(wrapper)).toBe('')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('粘贴等待期间得到新结果后，迟到的粘贴失败不回写过期错误', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    const clipboard = deferredClipboardRead()
    clipboard.install()
    await findButton(wrapper, '粘贴').trigger('click')

    await wrapper.get('#base64-input').setValue(ENCODED_STANDARD)
    await wrapper.get('input[value="decode"]').setValue()
    await findButton(wrapper, '执行解码').trigger('click')
    expect(resultValue(wrapper)).toBe(ORIGINAL_TEXT)

    await clipboard.reject(new Error('clipboard denied'))

    expect(inputValue(wrapper)).toBe(ENCODED_STANDARD)
    expect(resultValue(wrapper)).toBe(ORIGINAL_TEXT)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('#base64-input').attributes('aria-invalid')).not.toBe('true')
  })

  it('连续粘贴乱序完成时，后发起的粘贴优先且较早的不再覆盖', async () => {
    const wrapper = mountTool()
    const earlier = deferredClipboardRead()
    const later = deferredClipboardRead()
    earlier.install()
    await findButton(wrapper, '粘贴').trigger('click')
    later.install()
    await findButton(wrapper, '粘贴').trigger('click')

    await later.resolve('后发起粘贴的内容')
    expect(inputValue(wrapper)).toBe('后发起粘贴的内容')

    await earlier.resolve('较早粘贴的内容')

    expect(inputValue(wrapper)).toBe('后发起粘贴的内容')
    expect(resultValue(wrapper)).toBe('')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('粘贴等待期间仅切换操作（不改文本、不执行）后，迟到的粘贴成功不回填输入', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    const clipboard = deferredClipboardRead()
    clipboard.install()
    await findButton(wrapper, '粘贴').trigger('click')

    await wrapper.get('input[value="decode"]').setValue()
    expect(resultValue(wrapper)).toBe('')

    await clipboard.resolve('迟到的剪贴板内容')

    expect(inputValue(wrapper)).toBe(ORIGINAL_TEXT)
    expect(resultValue(wrapper)).toBe('')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('对照：等待期间没有其他操作时，延迟完成的粘贴照常生效并清空旧结果', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)
    const clipboard = deferredClipboardRead()
    clipboard.install()
    await findButton(wrapper, '粘贴').trigger('click')
    expect(resultValue(wrapper)).toBe(ENCODED_STANDARD)

    await clipboard.resolve('正常粘贴的内容')

    expect(inputValue(wrapper)).toBe('正常粘贴的内容')
    expect(resultValue(wrapper)).toBe('')
    expect(isDisabled(wrapper, '复制结果')).toBe(true)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
})

describe('Base64ToolView 复制反馈的归属与错误恢复', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('复制失败显示重试提示且不标记输入非法，重试成功后清除该提示', async () => {
    vi.useFakeTimers()
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)

    const failing = deferredClipboardWrite()
    failing.install()
    await findButton(wrapper, '复制结果').trigger('click')
    await failing.reject(new Error('denied'))

    expect(wrapper.get('[role="alert"]').text()).toContain('复制未成功')
    expect(wrapper.get('#base64-input').attributes('aria-invalid')).not.toBe('true')
    expect(wrapper.get('span.copy-status').text()).toBe('')

    const succeeding = deferredClipboardWrite()
    succeeding.install()
    await findButton(wrapper, '复制结果').trigger('click')
    await succeeding.resolve()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('span.copy-status').text()).toBe('结果已复制')
  })

  it('复制等待期间编辑或清空后，迟到的成功与失败都不再回写反馈', async () => {
    vi.useFakeTimers()
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)

    const earlier = deferredClipboardWrite()
    earlier.install()
    await findButton(wrapper, '复制结果').trigger('click')
    await wrapper.get('#base64-input').setValue(`${ORIGINAL_TEXT}C`)

    await earlier.resolve()
    expect(wrapper.get('span.copy-status').text()).toBe('')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    await findButton(wrapper, '执行编码').trigger('click')
    const later = deferredClipboardWrite()
    later.install()
    await findButton(wrapper, '复制结果').trigger('click')
    await findButton(wrapper, '清空').trigger('click')

    await later.reject(new Error('denied'))
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('span.copy-status').text()).toBe('')
  })

  it('连续复制乱序完成时，较早调用的迟到失败不覆盖后发起的成功反馈', async () => {
    vi.useFakeTimers()
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)

    const earlier = deferredClipboardWrite()
    const later = deferredClipboardWrite()
    earlier.install()
    await findButton(wrapper, '复制结果').trigger('click')
    later.install()
    await findButton(wrapper, '复制结果').trigger('click')

    await later.resolve()
    expect(wrapper.get('span.copy-status').text()).toBe('结果已复制')

    await earlier.reject(new Error('denied'))
    expect(wrapper.get('span.copy-status').text()).toBe('结果已复制')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('复制成功提示被新的复制成功重置计时，旧计时不再提早清除新反馈', async () => {
    vi.useFakeTimers()
    installClipboard()
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)

    await findButton(wrapper, '复制结果').trigger('click')
    await vi.advanceTimersByTimeAsync(1000)

    await findButton(wrapper, '复制结果').trigger('click')
    await vi.advanceTimersByTimeAsync(700)
    expect(wrapper.get('span.copy-status').text()).toBe('结果已复制')

    await vi.advanceTimersByTimeAsync(900)
    expect(wrapper.get('span.copy-status').text()).toBe('')
  })
})

describe('DT-R298-B S1 卸载在途复制与复制错误优先呈现', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('复制挂起时卸载组件，迟到的成功不再新建清除提示的计时器', async () => {
    vi.useFakeTimers()
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)

    const clipboard = deferredClipboardWrite()
    clipboard.install()
    await findButton(wrapper, '复制结果').trigger('click')

    wrapper.unmount()
    await clipboard.resolve()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('粘贴读取错误保留结果时，复制失败优先呈现当前复制错误，重试成功后读取错误再次可见', async () => {
    vi.useFakeTimers()
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)

    installClipboard({ readText: vi.fn().mockRejectedValue(new Error('read denied')) })
    await findButton(wrapper, '粘贴').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.get('[role="alert"]').text()).toContain('剪贴板')
    expect(resultValue(wrapper)).toBe(ENCODED_STANDARD)

    const failing = deferredClipboardWrite()
    failing.install()
    await findButton(wrapper, '复制结果').trigger('click')
    await failing.reject(new Error('write denied'))

    expect(wrapper.get('[role="alert"]').text()).toContain('复制未成功')
    expect(wrapper.get('#base64-input').attributes('aria-invalid')).toBe('true')

    const succeeding = deferredClipboardWrite()
    succeeding.install()
    await findButton(wrapper, '复制结果').trigger('click')
    await succeeding.resolve()

    expect(wrapper.get('[role="alert"]').text()).toContain('剪贴板')
    expect(wrapper.get('[role="alert"]').text()).not.toContain('复制未成功')
    expect(wrapper.get('span.copy-status').text()).toBe('结果已复制')
    expect(resultValue(wrapper)).toBe(ENCODED_STANDARD)
  })
})

describe('DT-R303 收尾：复制失败后的粘贴失败不被旧复制错误遮蔽', () => {
  it('复制失败后再粘贴失败，提示切换为剪贴板读取错误且不含旧复制错误，输入与结果保留', async () => {
    const wrapper = mountTool()
    await runEncode(wrapper, ORIGINAL_TEXT)

    installClipboard({ writeText: vi.fn().mockRejectedValue(new Error('write denied')) })
    await findButton(wrapper, '复制结果').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('复制未成功')

    installClipboard({ readText: vi.fn().mockRejectedValue(new Error('read denied')) })
    await findButton(wrapper, '粘贴').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('浏览器未允许读取剪贴板，请使用系统粘贴快捷键。')
    expect(wrapper.get('[role="alert"]').text()).not.toContain('复制未成功')
    expect(inputValue(wrapper)).toBe(ORIGINAL_TEXT)
    expect(resultValue(wrapper)).toBe(ENCODED_STANDARD)
  })
})

function mountTool(): VueWrapper {
  activeWrapper = mount(Base64ToolView)
  return activeWrapper
}

async function runEncode(wrapper: VueWrapper, value: string) {
  await wrapper.get('#base64-input').setValue(value)
  await findButton(wrapper, '执行编码').trigger('click')
}

function findButton(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text() === text)
  if (!button) throw new Error(`未找到按钮：「${text}」`)
  return button
}

function isDisabled(wrapper: VueWrapper, text: string): boolean {
  return (findButton(wrapper, text).element as HTMLButtonElement).disabled
}

function inputValue(wrapper: VueWrapper): string {
  return (wrapper.get('#base64-input').element as HTMLTextAreaElement).value
}

function resultValue(wrapper: VueWrapper): string {
  return (wrapper.get('textarea[aria-label="Base64 转换结果"]').element as HTMLTextAreaElement).value
}

function installClipboard(
  overrides: { readText?: () => Promise<string>; writeText?: () => Promise<void> } = {},
) {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      readText: overrides.readText ?? vi.fn().mockResolvedValue(''),
      writeText: overrides.writeText ?? vi.fn().mockResolvedValue(undefined),
    },
    configurable: true,
  })
}

function deferredClipboardRead() {
  let resolveText!: (text: string) => void
  let rejectText!: (error: Error) => void
  const pending = new Promise<string>((resolve, reject) => {
    resolveText = resolve
    rejectText = reject
  })
  return {
    install: () => installClipboard({ readText: () => pending }),
    resolve: async (text: string) => {
      resolveText(text)
      await flushPromises()
    },
    reject: async (error: Error) => {
      rejectText(error)
      await flushPromises()
    },
  }
}

function deferredClipboardWrite() {
  let settleWrite!: () => void
  let failWrite!: (error: Error) => void
  const pending = new Promise<void>((resolve, reject) => {
    settleWrite = resolve
    failWrite = reject
  })
  return {
    install: () => installClipboard({ writeText: () => pending }),
    resolve: async () => {
      settleWrite()
      await vi.advanceTimersByTimeAsync(0)
    },
    reject: async (error: Error) => {
      failWrite(error)
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

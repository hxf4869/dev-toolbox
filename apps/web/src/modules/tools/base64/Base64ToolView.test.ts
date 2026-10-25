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

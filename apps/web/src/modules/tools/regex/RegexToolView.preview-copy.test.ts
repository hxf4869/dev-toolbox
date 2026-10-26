import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { REGEX_MATCH_DISPLAY_LIMIT, type RegexRunResult } from './contracts'

const run = vi.hoisted(() => vi.fn())

vi.mock('./regexRunner', () => ({
  RegexRunner: class {
    run = run
    cancel() {}
    dispose() {}
  },
}))

import RegexToolView from './RegexToolView.vue'

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

const PREVIEW = '[ERROR] connection failed\n[WARNING] retry scheduled'
const ORIGINAL_TEXT = 'error: connection failed\nwarning: retry scheduled'

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

function finishedResult(preview: string): RegexRunResult {
  return {
    matches: [{ number: 1, start: 0, end: 5, value: 'error', groups: [], namedGroups: {} }],
    matchLimitReached: false,
    replacementPreview: preview,
  }
}

function limitedResult(): RegexRunResult {
  return {
    matches: Array.from({ length: REGEX_MATCH_DISPLAY_LIMIT + 1 }, (_, index) => ({
      number: index + 1,
      start: index,
      end: index + 1,
      value: 'a',
      groups: [],
      namedGroups: {},
    })),
    matchLimitReached: true,
    replacementPreview: null,
  }
}

describe('RegexToolView replacement preview copy', () => {
  afterEach(() => {
    run.mockReset()
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('copies the exact replacement preview without re-running or rewriting the source text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    run.mockResolvedValueOnce(finishedResult(PREVIEW))
    const wrapper = mount(RegexToolView)

    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()

    const copyButton = wrapper.get('.preview-heading button')
    expect(copyButton.text()).toContain('复制替换预览')

    await copyButton.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(PREVIEW)
    expect(wrapper.get('.preview-heading button').text()).toContain('已复制')
    expect((wrapper.get('#regex-text').element as HTMLTextAreaElement).value).toBe(ORIGINAL_TEXT)
    expect(run).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('shows a retryable visible error after clipboard rejection and recovers on retry', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new DOMException('Clipboard write was blocked', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)
    run.mockResolvedValueOnce(finishedResult(PREVIEW))
    const wrapper = mount(RegexToolView)

    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()

    const copyButton = wrapper.get('.preview-heading button')
    await copyButton.trigger('click')
    await flushPromises()

    const alert = wrapper.get('.preview-heading [role="alert"]')
    expect(alert.text()).toContain('剪贴板')
    expect(alert.text()).toContain('手动')
    expect(wrapper.get('.preview-heading button').attributes('disabled')).toBeUndefined()

    await copyButton.trigger('click')
    await flushPromises()

    expect(wrapper.find('.preview-heading [role="alert"]').exists()).toBe(false)
    expect(wrapper.get('.preview-heading button').text()).toContain('已复制')
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(writeText).toHaveBeenNthCalledWith(1, PREVIEW)
    expect(writeText).toHaveBeenNthCalledWith(2, PREVIEW)
    wrapper.unmount()
  })

  it('provides no copy entry when the replacement preview is omitted by the match limit', async () => {
    run.mockResolvedValueOnce(limitedResult())
    const wrapper = mount(RegexToolView)

    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()

    expect(wrapper.get('h3').text()).toContain('替换预览')
    expect(wrapper.find('.preview-heading button').exists()).toBe(false)
    expect(wrapper.find('.replacement-preview').exists()).toBe(false)
    expect(wrapper.get('.preview-omitted').text()).toContain('结果规模过大，本次未生成替换预览')
    expect(wrapper.text()).not.toContain('复制替换预览')
    wrapper.unmount()
  })
})

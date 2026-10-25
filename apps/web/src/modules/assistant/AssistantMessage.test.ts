import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AssistantMessage from './AssistantMessage.vue'
import { assistantMessageFixture } from './assistantMocks'
import type { AssistantMessageViewModel } from './assistantStore'

const FEEDBACK_MS = 1600

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

function streamingMessage(
  content: string,
  citations = assistantMessageFixture.citations,
): AssistantMessageViewModel {
  return {
    id: assistantMessageFixture.id,
    role: 'assistant',
    content,
    reasoningContent: null,
    reasoningDurationMs: null,
    status: 'streaming',
    citations,
    run: assistantMessageFixture.currentRun,
    temporaryRuntime: null,
    temporary: false,
  }
}

function findCopyButton(wrapper: VueWrapper) {
  return wrapper.findAll('button').find((button) => button.text().includes('复制'))!
}

async function flushCopyWork() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

describe('AssistantMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('copies only recognized citation markers away and emits the owning message identity', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const message = {
      id: assistantMessageFixture.id,
      role: 'assistant' as const,
      content: '已知 [[C1]]，未知 [[C2]]，非规范 [[C01]]。',
      reasoningContent: null,
      reasoningDurationMs: null,
      status: 'complete' as const,
      citations: assistantMessageFixture.citations,
      run: assistantMessageFixture.currentRun,
      temporaryRuntime: null,
      temporary: false,
    }
    const wrapper = mount(AssistantMessage, { props: { message } })

    await wrapper.get('button[data-citation-number="1"]').trigger('click')
    expect(wrapper.emitted('citation')?.[0]).toEqual([
      { citation: assistantMessageFixture.citations[0], messageId: assistantMessageFixture.id },
    ])

    const copy = wrapper.findAll('button').find((button) => button.text().includes('复制'))!
    await copy.trigger('click')
    expect(writeText).toHaveBeenCalledWith('已知 ，未知 [[C2]]，非规范 [[C01]]。')
  })

  it('clears success and failure copy feedback once the streamed answer text changes', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('Clipboard write was blocked', 'NotAllowedError'))
    installClipboard(writeText)
    const wrapper = mount(AssistantMessage, { props: { message: streamingMessage('第一段回答') } })
    const copy = findCopyButton(wrapper)

    await copy.trigger('click')
    await flushCopyWork()
    expect(copy.attributes('aria-label')).toBe('回答已复制')

    await wrapper.setProps({ message: streamingMessage('第一段回答，继续生成') })
    expect(copy.attributes('aria-label')).toBe('复制回答')

    await copy.trigger('click')
    await flushCopyWork()
    expect(copy.attributes('aria-label')).toBe('复制失败，请重试')

    await wrapper.setProps({ message: streamingMessage('重试后替换的回答') })
    expect(copy.attributes('aria-label')).toBe('复制回答')
    wrapper.unmount()
  })

  it('ignores late copy results of replaced answer text and still copies the current text', async () => {
    vi.useFakeTimers()
    let resolveFirst: () => void = () => {}
    let rejectSecond: (reason?: unknown) => void = () => {}
    const writeText = vi.fn()
      .mockReturnValueOnce(new Promise<void>((resolve) => { resolveFirst = resolve }))
      .mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectSecond = reject }))
      .mockResolvedValueOnce(undefined)
    installClipboard(writeText)
    const wrapper = mount(AssistantMessage, { props: { message: streamingMessage('回答 A') } })
    const copy = findCopyButton(wrapper)

    await copy.trigger('click')
    await wrapper.setProps({ message: streamingMessage('回答 B') })
    await copy.trigger('click')
    await wrapper.setProps({ message: streamingMessage('回答 C') })

    resolveFirst()
    await flushCopyWork()
    expect(copy.attributes('aria-label')).toBe('复制回答')

    rejectSecond(new DOMException('Clipboard write was blocked', 'NotAllowedError'))
    await flushCopyWork()
    expect(copy.attributes('aria-label')).toBe('复制回答')

    await copy.trigger('click')
    await flushCopyWork()
    expect(copy.attributes('aria-label')).toBe('回答已复制')
    expect(writeText).toHaveBeenNthCalledWith(1, '回答 A')
    expect(writeText).toHaveBeenNthCalledWith(2, '回答 B')
    expect(writeText).toHaveBeenNthCalledWith(3, '回答 C')
    wrapper.unmount()
  })

  it('treats a citation membership change as new copy text and clears stale feedback', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    const content = '已知 [[C1]]，稍后识别 [[C2]]。'
    const primary = assistantMessageFixture.citations[0]
    const secondary = { ...primary, sourceOrdinal: 2, citationNumber: 2, title: '磁盘迁移摘要' }
    const wrapper = mount(AssistantMessage, { props: { message: streamingMessage(content, [primary]) } })
    const copy = findCopyButton(wrapper)

    await copy.trigger('click')
    await flushCopyWork()
    expect(writeText).toHaveBeenLastCalledWith('已知 ，稍后识别 [[C2]]。')
    expect(copy.attributes('aria-label')).toBe('回答已复制')

    await wrapper.setProps({ message: streamingMessage(content, [primary, secondary]) })
    expect(copy.attributes('aria-label')).toBe('复制回答')

    await copy.trigger('click')
    await flushCopyWork()
    expect(writeText).toHaveBeenLastCalledWith('已知 ，稍后识别 。')
    expect(copy.attributes('aria-label')).toBe('回答已复制')
    wrapper.unmount()
  })

  it('lets a repeated copy of the same answer keep its own full feedback window', async () => {
    vi.useFakeTimers()
    installClipboard(vi.fn().mockResolvedValue(undefined))
    const wrapper = mount(AssistantMessage, { props: { message: streamingMessage('同一段回答') } })
    const copy = findCopyButton(wrapper)

    await copy.trigger('click')
    await flushCopyWork()
    expect(copy.attributes('aria-label')).toBe('回答已复制')

    await vi.advanceTimersByTimeAsync(1000)
    await copy.trigger('click')
    await flushCopyWork()

    // t=1700ms: the first copy's 1600ms timer must not have reset the second copy's feedback.
    await vi.advanceTimersByTimeAsync(700)
    expect(copy.attributes('aria-label')).toBe('回答已复制')

    // t=2600ms: the second copy's own window expires.
    await vi.advanceTimersByTimeAsync(FEEDBACK_MS - 700)
    expect(copy.attributes('aria-label')).toBe('复制回答')
    wrapper.unmount()
  })
})

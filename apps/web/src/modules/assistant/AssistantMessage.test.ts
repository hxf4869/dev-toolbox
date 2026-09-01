import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AssistantMessage from './AssistantMessage.vue'
import { assistantMessageFixture } from './assistantMocks'

describe('AssistantMessage', () => {
  afterEach(() => vi.restoreAllMocks())

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
})

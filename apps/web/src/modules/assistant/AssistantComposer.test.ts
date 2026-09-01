import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { assistantModelFixture } from './assistantMocks'
import AssistantComposer from './AssistantComposer.vue'

const baseProps = {
  models: [assistantModelFixture],
  modelId: assistantModelFixture.id,
  reasoning: 'medium' as const,
  draft: '准备发送',
  activeRun: false,
  canStop: false,
  stopRequested: false,
  sending: false,
  error: '',
  selectionRequired: false,
  temporary: false,
}

describe('AssistantComposer', () => {
  it('sends with Enter but not Shift+Enter or an IME composition Enter', async () => {
    const wrapper = mount(AssistantComposer, { props: baseProps })
    const textarea = wrapper.get('textarea')

    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)

    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toHaveLength(1)

    await textarea.trigger('compositionstart')
    await textarea.trigger('keydown', { key: 'Enter' })
    await textarea.trigger('compositionend')
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('keeps the next draft editable and replaces send with a stop action during a run', async () => {
    const wrapper = mount(AssistantComposer, {
      props: { ...baseProps, activeRun: true, canStop: true },
    })

    expect(wrapper.text()).toContain('下一条消息生效')
    expect(wrapper.text()).toContain('停止')
    await wrapper.get('textarea').setValue('运行期间的新草稿')
    expect(wrapper.emitted('update:draft')?.at(-1)).toEqual(['运行期间的新草稿'])

    await wrapper.get('button[aria-label="停止当前回答"]').trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
  })

  it('caps textarea growth and switches to internal scrolling', async () => {
    const wrapper = mount(AssistantComposer, { props: baseProps })
    const textarea = wrapper.get('textarea').element as HTMLTextAreaElement
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 260 })

    await wrapper.get('textarea').trigger('input')
    expect(textarea.style.height).toBe('184px')
    expect(textarea.style.overflowY).toBe('auto')
  })
})

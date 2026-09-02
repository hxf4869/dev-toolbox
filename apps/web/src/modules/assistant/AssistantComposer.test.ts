import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { AssistantRunDTO } from './assistantContracts'
import { assistantModelFixture, runFixtures } from './assistantMocks'
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
  contextRun: null,
}

describe('AssistantComposer', () => {
  it('shows complete measured input against the run model window, separately from draft characters', async () => {
    const wrapper = mount(AssistantComposer, {
      props: { ...baseProps, contextRun: runFixtures.succeeded },
    })
    const context = () => wrapper.get('.assistant-composer__context')
    expect(context().text()).toBe('上下文 18.4K / 128K · 14.4%')
    expect(context().attributes('title')).toContain('完整输入 18,400 token')
    expect(wrapper.text()).toContain('字符 4 / 32,768')

    await wrapper.setProps({ draft: '下一条消息', modelId: 'next-model', models: [{ ...assistantModelFixture, id: 'next-model', contextWindow: 1000000 }] })
    expect(context().text()).toBe('上次请求上下文 18.4K / 128K · 14.4%')
    expect(context().attributes('title')).toContain(assistantModelFixture.displayName)
    expect(wrapper.text()).toContain('字符 5 / 32,768')

    await wrapper.setProps({ modelId: assistantModelFixture.id, activeRun: true })
    expect(context().text()).toBe('上次请求上下文 18.4K / 128K · 14.4%')
  })

  it('does not manufacture usage or a percentage for an empty conversation or legacy records', async () => {
    const wrapper = mount(AssistantComposer, { props: baseProps })
    const context = () => wrapper.get('.assistant-composer__context').text()
    expect(context()).toBe('上下文 待请求 / 128K')
    await wrapper.setProps({ activeRun: true })
    expect(context()).toBe('上下文 待返回 / 128K')

    const legacyRun: AssistantRunDTO = structuredClone(runFixtures.succeeded)
    legacyRun.usage.answerContextTokens = null
    await wrapper.setProps({ activeRun: false, contextRun: legacyRun })
    expect(context()).toBe('上下文 未提供 / 128K')
    Reflect.deleteProperty(legacyRun.usage, 'answerContextTokens')
    await wrapper.setProps({ contextRun: { ...legacyRun } })
    expect(context()).not.toContain('%')
    expect(context()).toContain('未提供')
  })

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

import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import CitationDrawer from './CitationDrawer.vue'
import ReasoningPanel from './ReasoningPanel.vue'
import { sourceFixtures } from './assistantMocks'

describe('assistant interaction details', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="citation-trigger">引用 1</button>'
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('expands reasoning while it streams and collapses on the first answer', async () => {
    const wrapper = mount(ReasoningPanel, {
      attachTo: document.body,
      props: {
        content: '正在核对来源',
        durationMs: null,
        streaming: true,
        answerStarted: false,
      },
    })

    expect(wrapper.get('button').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.reasoning-panel__content').isVisible()).toBe(true)

    await wrapper.setProps({ answerStarted: true })
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('.reasoning-panel__content').isVisible()).toBe(false)
  })

  it('opens the citation drawer in a focus trap and restores focus after Escape', async () => {
    const trigger = document.querySelector<HTMLButtonElement>('#citation-trigger')!
    trigger.focus()
    const wrapper = mount(CitationDrawer, {
      attachTo: document.body,
      props: {
        open: false,
        source: sourceFixtures.available,
        loading: false,
        error: '',
        citationNumber: 1,
      },
    })

    await wrapper.setProps({ open: true })
    await nextTick()
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="关闭来源详情"]')!
    expect(document.activeElement).toBe(close)
    expect(document.body.textContent).toContain('当前笔记标题已变更')

    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.setProps({ open: false })
    await nextTick()
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
  })

  it('keeps deleted and AI-derived source states explicit', async () => {
    const wrapper = mount(CitationDrawer, {
      attachTo: document.body,
      props: {
        open: true,
        source: sourceFixtures.deleted,
        loading: false,
        error: '',
        citationNumber: 1,
      },
    })
    expect(document.body.textContent).toContain('历史回答保持不变')

    await wrapper.setProps({ source: sourceFixtures.aiDerived, citationNumber: 2 })
    expect(document.body.textContent).toContain('AI 派生，未人工验证')
    wrapper.unmount()
  })

  it('keeps keyboard focus on the close button while a retry reloads the source', async () => {
    const trigger = document.querySelector<HTMLButtonElement>('#citation-trigger')!
    trigger.focus()
    const wrapper = mount(CitationDrawer, {
      attachTo: document.body,
      props: {
        open: false,
        source: null,
        loading: false,
        error: '来源暂时无法读取',
        citationNumber: 1,
      },
    })

    await wrapper.setProps({ open: true })
    await nextTick()
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="关闭来源详情"]')!
    const retry = document.querySelector<HTMLButtonElement>('button.button')!
    retry.focus()
    expect(document.activeElement).toBe(retry)

    retry.click()
    expect(wrapper.emitted('retry')).toHaveLength(1)

    await wrapper.setProps({ loading: true, error: '' })
    await nextTick()
    expect(document.activeElement).toBe(close)

    await wrapper.setProps({ loading: false, source: sourceFixtures.available })
    await nextTick()
    expect(document.activeElement).toBe(close)

    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.setProps({ open: false })
    await nextTick()
    expect(document.activeElement).toBe(trigger)
    expect(wrapper.emitted('retry')).toHaveLength(1)
    wrapper.unmount()
  })
})

import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sourceFixtures } from './assistantMocks'
import AssistantMarkdown from './AssistantMarkdown.vue'

describe('AssistantMarkdown', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('escapes raw HTML and only turns known canonical citations into buttons', async () => {
    const wrapper = mount(AssistantMarkdown, {
      attachTo: document.body,
      props: {
        source:
          '<img src=x onerror="window.compromised=true"> 已知 [[C1]]，未知 [[C2]]，非规范 [[C01]]，[链接中的 [[C1]]](https://example.com)。',
        citations: [sourceFixtures.available],
      },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror="window.compromised=true">')
    expect(wrapper.text()).toContain('未知 [[C2]]')
    expect(wrapper.text()).toContain('非规范 [[C01]]')
    expect(wrapper.findAll('button[data-citation-number="1"]')).toHaveLength(1)
    expect(wrapper.find('a').attributes()).toMatchObject({
      href: 'https://example.com',
      target: '_blank',
      rel: 'noopener noreferrer',
    })

    await wrapper.find('button[data-citation-number="1"]').trigger('click')
    expect(wrapper.emitted('citation')).toEqual([[1]])
    wrapper.unmount()
  })

  it('copies fenced code exactly and labels model-generated commands as unverified', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(AssistantMarkdown, {
      attachTo: document.body,
      props: {
        source: '```bash\nprintf "hello"\n```',
        citations: [],
      },
    })

    expect(wrapper.text()).toContain('模型生成，未验证')
    const copyButton = wrapper.get<HTMLButtonElement>('button[data-code-index="0"]')
    copyButton.element.focus()
    await copyButton.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledWith('printf "hello"\n')
    expect(wrapper.text()).toContain('已复制')
    expect(document.activeElement).toBe(wrapper.get('button[data-code-index="0"]').element)
    await vi.advanceTimersByTimeAsync(1600)
    expect(document.activeElement).toBe(wrapper.get('button[data-code-index="0"]').element)
    wrapper.unmount()
  })

  it('toggles wrapping per block without losing keyboard focus or altering code', async () => {
    const wrapper = mount(AssistantMarkdown, {
      attachTo: document.body,
      props: { source: '```sh\nfirst line\n```\n\n```sh\nsecond line\n```', citations: [] },
    })
    const toggle = wrapper.get<HTMLButtonElement>('button[data-wrap-index="0"]')
    toggle.element.focus()
    await toggle.trigger('click')
    expect(wrapper.get('button[data-wrap-index="0"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('pre')[0]?.classes()).toContain('is-wrapped')
    expect(wrapper.findAll('pre')[1]?.classes()).not.toContain('is-wrapped')
    expect(wrapper.findAll('code')[0]?.text()).toBe('first line')
    expect(document.activeElement).toBe(wrapper.get('button[data-wrap-index="0"]').element)
    await wrapper.get('button[data-wrap-index="0"]').trigger('click')
    expect(wrapper.get('button[data-wrap-index="0"]').attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })
})

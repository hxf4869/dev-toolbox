import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sourceFixtures } from './assistantMocks'
import AssistantMarkdown from './AssistantMarkdown.vue'

describe('AssistantMarkdown', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
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
    await wrapper.find('button[data-code-index="0"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('printf "hello"\n')
    expect(wrapper.text()).toContain('已复制')
    wrapper.unmount()
  })
})

import { mount } from '@vue/test-utils'
import { vi } from 'vitest'

import RawDocument from './RawDocument.vue'
import SafeMarkdown from './SafeMarkdown.vue'

describe('RawDocument', () => {
  it('keeps ordinary plain text as one copy-all document without command heuristics', () => {
    const wrapper = mount(RawDocument, {
      props: { body: 'lsblk\nmount /dev/sdb1 /data\necho done', contentFormat: 'plain_text' },
    })

    expect(wrapper.find('pre.plain-raw').text()).toContain('mount /dev/sdb1 /data')
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.findComponent(SafeMarkdown).exists()).toBe(false)
  })

  it('copies fenced Markdown code exactly without UI labels', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const wrapper = mount(RawDocument, {
      props: {
        body: "前文\n\n```sh\nprintf 'x'\nmount /dev/sdb1 /data\n```\n\n后文",
        contentFormat: 'markdown',
      },
    })

    await wrapper.find('button[data-code-index="0"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith("printf 'x'\nmount /dev/sdb1 /data\n")
    expect(String(writeText.mock.calls[0]?.[0])).not.toContain('复制代码块')
    expect(wrapper.find('button[data-code-index="0"]').text()).toBe('已复制')
    expect(wrapper.find('pre').attributes('tabindex')).toBe('0')
  })

  it('opens external Markdown links with an isolated browsing context', () => {
    const wrapper = mount(RawDocument, {
      props: {
        body: '[官方文档](https://example.com/docs) <script>alert(1)</script>',
        contentFormat: 'markdown',
      },
    })

    const link = wrapper.find('a')
    expect(link.attributes()).toMatchObject({
      href: 'https://example.com/docs',
      target: '_blank',
      rel: 'noopener noreferrer',
    })
    expect(wrapper.find('script').exists()).toBe(false)
  })
})

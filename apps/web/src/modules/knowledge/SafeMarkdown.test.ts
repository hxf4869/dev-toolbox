import { mount } from '@vue/test-utils'

import SafeMarkdown from './SafeMarkdown.vue'

describe('SafeMarkdown', () => {
  it('renders fenced code but never executes or mounts raw HTML', () => {
    const wrapper = mount(SafeMarkdown, {
      props: {
        source: '# 标题\n\n<script>window.compromised = true</script>\n\n```sh\nlsblk\n```',
      },
    })

    expect(wrapper.find('h1').text()).toBe('标题')
    expect(wrapper.find('pre code').text()).toBe('lsblk')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain("<script>window.compromised = true</script>")
    expect(wrapper.find('.safe-code-block header span').text()).toContain('来自原始记录')
  })

  it('lets AI-derived usage relabel the fenced code origin', () => {
    const wrapper = mount(SafeMarkdown, {
      props: { source: '```sh\nlsblk\n```', origin: '模型整理' },
    })

    expect(wrapper.find('.safe-code-block header span').text()).toContain('模型整理')
    expect(wrapper.find('.safe-code-block header span').text()).not.toContain('来自原始记录')
  })

  it('escapes the origin label so it can never inject markup into the code header', () => {
    const wrapper = mount(SafeMarkdown, {
      props: { source: '```sh\nlsblk\n```', origin: '<img src=x>' },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.html()).toContain('&lt;img src=x&gt;')
  })
})

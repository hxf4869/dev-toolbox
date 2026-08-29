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
  })
})

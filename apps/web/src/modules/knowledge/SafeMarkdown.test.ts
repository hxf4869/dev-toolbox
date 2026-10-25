import { mount } from '@vue/test-utils'
import { afterEach, vi } from 'vitest'

import SafeMarkdown from './SafeMarkdown.vue'

describe('SafeMarkdown', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

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

  it('toggles wrapping per fenced block independently without losing keyboard focus', async () => {
    const wrapper = mount(SafeMarkdown, {
      attachTo: document.body,
      props: {
        source: '```sh\nfirst line\n```\n\n<script>alert(1)</script>\n\n```sh\nsecond line\n```',
      },
    })
    expect(wrapper.find('script').exists()).toBe(false)

    const toggleFirst = wrapper.get<HTMLButtonElement>('button[data-wrap-index="0"]')
    toggleFirst.element.focus()
    await toggleFirst.trigger('click')
    expect(wrapper.get('button[data-wrap-index="0"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('pre')[0]?.classes()).toContain('is-wrapped')
    expect(wrapper.findAll('pre')[1]?.classes()).not.toContain('is-wrapped')
    expect(wrapper.findAll('code')[0]?.text()).toBe('first line')
    expect(document.activeElement).toBe(wrapper.get('button[data-wrap-index="0"]').element)

    const toggleSecond = wrapper.get<HTMLButtonElement>('button[data-wrap-index="1"]')
    toggleSecond.element.focus()
    await toggleSecond.trigger('click')
    expect(wrapper.get('button[data-wrap-index="1"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('button[data-wrap-index="0"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('pre')[0]?.classes()).toContain('is-wrapped')
    expect(wrapper.findAll('pre')[1]?.classes()).toContain('is-wrapped')
    expect(document.activeElement).toBe(wrapper.get('button[data-wrap-index="1"]').element)

    await wrapper.get('button[data-wrap-index="0"]').trigger('click')
    expect(wrapper.get('button[data-wrap-index="0"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.findAll('pre')[0]?.classes()).not.toContain('is-wrapped')
    expect(wrapper.findAll('pre')[1]?.classes()).toContain('is-wrapped')
    expect(wrapper.findAll('code')[0]?.text()).toBe('first line')
    wrapper.unmount()
  })

  it('copies the exact token content even after wrap toggling and keeps focus through feedback', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(SafeMarkdown, {
      attachTo: document.body,
      props: { source: '```bash\nprintf "hello"\nlong ---- line ----\n```' },
    })

    await wrapper.get('button[data-wrap-index="0"]').trigger('click')
    const copyButton = wrapper.get<HTMLButtonElement>('button[data-code-index="0"]')
    copyButton.element.focus()
    await copyButton.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('printf "hello"\nlong ---- line ----\n')
    expect(wrapper.text()).toContain('已复制')
    expect(wrapper.findAll('pre')[0]?.classes()).toContain('is-wrapped')
    expect(wrapper.findAll('code')[0]?.text()).toBe('printf "hello"\nlong ---- line ----')
    expect(document.activeElement).toBe(wrapper.get('button[data-code-index="0"]').element)

    await vi.advanceTimersByTimeAsync(1600)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain('已复制')
    expect(wrapper.findAll('pre')[0]?.classes()).toContain('is-wrapped')
    expect(document.activeElement).toBe(wrapper.get('button[data-code-index="0"]').element)
    wrapper.unmount()
  })

  it('keeps focus on a code pre inside markdown when copy feedback expires', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(SafeMarkdown, {
      attachTo: document.body,
      props: { source: '```bash\nprintf "hello"\nlong ---- line ----\n```' },
    })

    const copyButton = wrapper.get<HTMLButtonElement>('button[data-code-index="0"]')
    copyButton.element.focus()
    await copyButton.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('已复制')

    const preBefore = wrapper.get<HTMLPreElement>('pre').element
    preBefore.focus()
    await vi.advanceTimersByTimeAsync(1600)
    expect(wrapper.text()).not.toContain('已复制')
    expect(preBefore.isConnected).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('pre').element)
    wrapper.unmount()
  })

  it('keeps focus on a markdown link when copy feedback expires', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(SafeMarkdown, {
      attachTo: document.body,
      props: { source: '```sh\nlsblk\n```\n\n参考 [官方文档](https://example.com/docs) 继续。' },
    })

    const copyButton = wrapper.get<HTMLButtonElement>('button[data-code-index="0"]')
    copyButton.element.focus()
    await copyButton.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('已复制')

    const linkBefore = wrapper.get<HTMLAnchorElement>('a').element
    linkBefore.focus()
    await vi.advanceTimersByTimeAsync(1600)
    expect(wrapper.text()).not.toContain('已复制')
    expect(linkBefore.isConnected).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('a').element)
    wrapper.unmount()
  })

  it('does not steal focus from outside the markdown when copy feedback expires', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(SafeMarkdown, {
      attachTo: document.body,
      props: { source: '```sh\nlsblk\n```' },
    })
    const outsideButton = document.createElement('button')
    outsideButton.type = 'button'
    document.body.appendChild(outsideButton)

    const copyButton = wrapper.get<HTMLButtonElement>('button[data-code-index="0"]')
    copyButton.element.focus()
    await copyButton.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('已复制')

    outsideButton.focus()
    await vi.advanceTimersByTimeAsync(1600)
    expect(wrapper.text()).not.toContain('已复制')
    expect(document.activeElement).toBe(outsideButton)
    wrapper.unmount()
    outsideButton.remove()
  })
})

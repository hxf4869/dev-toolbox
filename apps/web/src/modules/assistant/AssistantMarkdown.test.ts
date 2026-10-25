import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import { sourceFixtures } from './assistantMocks'
import AssistantMarkdown from './AssistantMarkdown.vue'
import CitationDrawer from './CitationDrawer.vue'

function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
}

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

  it('keeps the original nodes and focus when copy feedback expires after focus moved to pre or link', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const wrapper = mount(AssistantMarkdown, {
      attachTo: document.body,
      props: { source: '[文档](https://example.com/primer)\n\n```sh\nkeep node\n```', citations: [] },
    })
    const copyButton = () => wrapper.get<HTMLButtonElement>('button[data-code-index="0"]')

    await copyButton().trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('已复制')
    const buttonAfterCopy = copyButton().element
    const pre = wrapper.get('pre').element
    pre.focus()
    expect(document.activeElement).toBe(pre)

    await vi.advanceTimersByTimeAsync(1600)
    expect(pre.isConnected).toBe(true)
    expect(document.activeElement).toBe(pre)
    expect(copyButton().element).toBe(buttonAfterCopy)
    expect(copyButton().text()).toBe('复制代码块')

    await copyButton().trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    const link = wrapper.get('a').element
    link.focus()
    await vi.advanceTimersByTimeAsync(1600)
    expect(link.isConnected).toBe(true)
    expect(document.activeElement).toBe(link)
    wrapper.unmount()
  })

  it('returns focus to the connected citation opener after feedback expires while the drawer is open', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const open = ref(false)
    const activeCitation = ref<number | null>(null)
    const host = defineComponent({
      render: () =>
        h('div', [
          h(AssistantMarkdown, {
            source: '```sh\npersist\n```\n\n来自 [[C1]] 的步骤。',
            citations: [sourceFixtures.available],
            onCitation: (citationNumber: number) => {
              activeCitation.value = citationNumber
              open.value = true
            },
          }),
          h(CitationDrawer, {
            open: open.value,
            source: null,
            loading: false,
            error: '',
            citationNumber: activeCitation.value,
            onClose: () => {
              open.value = false
            },
          }),
        ]),
    })
    const wrapper = mount(host, { attachTo: document.body })

    await wrapper.get('button[data-code-index="0"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('已复制')

    const opener = wrapper.get<HTMLButtonElement>('button[data-citation-number="1"]').element
    opener.focus()
    await wrapper.get('button[data-citation-number="1"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    const drawerClose = document.querySelector<HTMLButtonElement>('button[aria-label="关闭来源详情"]')
    expect(drawerClose).not.toBeNull()
    expect(document.activeElement).toBe(drawerClose)

    await vi.advanceTimersByTimeAsync(1600)
    expect(document.activeElement).toBe(drawerClose)

    drawerClose?.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(opener.isConnected).toBe(true)
    expect(document.activeElement).toBe(opener)
    wrapper.unmount()
  })

  it('ignores stale copy outcomes after source swaps and keeps exact retry semantics', async () => {
    vi.useFakeTimers()
    const pendingWrites: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = []
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          pendingWrites.push({ resolve, reject })
        }),
    )
    stubClipboard(writeText)
    const wrapper = mount(AssistantMarkdown, {
      attachTo: document.body,
      props: { source: '```sh\nversion A\n```', citations: [] },
    })
    const copyButton = () => wrapper.get<HTMLButtonElement>('button[data-code-index="0"]')

    // A→B：点击 A 后 source 换成 B，旧的复制成功不得污染新代码块。
    await copyButton().trigger('click')
    await wrapper.setProps({ source: '```sh\nversion B\n```' })
    pendingWrites[0]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).not.toContain('已复制')
    expect(wrapper.text()).not.toContain('复制失败')
    expect(copyButton().text()).toBe('复制代码块')

    // B→C：点击 B 后 source 换成 C，旧的复制失败同样忽略。
    await copyButton().trigger('click')
    await wrapper.setProps({ source: '```sh\nversion C\n```' })
    pendingWrites[1]?.reject(new Error('clipboard denied'))
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).not.toContain('复制失败')
    expect(copyButton().text()).toBe('复制代码块')

    // 当前 C 的失败仍然生效，并可通过显式重试成功，复制文本精确含末尾换行。
    await copyButton().trigger('click')
    pendingWrites[2]?.reject(new Error('clipboard denied'))
    await vi.advanceTimersByTimeAsync(0)
    expect(copyButton().text()).toBe('复制失败，重试')
    expect(wrapper.get('.sr-only').text()).toContain('复制失败，请重试')

    await copyButton().trigger('click')
    pendingWrites[3]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(copyButton().text()).toBe('已复制')
    expect(writeText).toHaveBeenNthCalledWith(4, 'version C\n')
    wrapper.unmount()
  })

  it('keeps feedback while the code text is unchanged, clears it on code changes, and gives the latest copy the full window', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const wrapper = mount(AssistantMarkdown, {
      attachTo: document.body,
      props: { source: '```sh\nstable\n```', citations: [] },
    })
    const copyButton = () => wrapper.get<HTMLButtonElement>('button[data-code-index="0"]')
    const statusText = () => wrapper.get('.sr-only').text()

    await copyButton().trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(copyButton().text()).toBe('已复制')

    // 代码文本不变、只追加普通正文：反馈继续有效。
    await wrapper.setProps({ source: '```sh\nstable\n```\n\n后来追加的说明。' })
    expect(copyButton().text()).toBe('已复制')

    // 同一代码块 800ms 后再次复制：前一个计时器不得提前清掉后一次的反馈。
    await vi.advanceTimersByTimeAsync(800)
    await copyButton().trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(799)
    expect(copyButton().text()).toBe('已复制')
    await vi.advanceTimersByTimeAsync(1)
    expect(copyButton().text()).toBe('已复制')
    await vi.advanceTimersByTimeAsync(800)
    expect(copyButton().text()).toBe('复制代码块')
    expect(statusText()).not.toContain('代码块已精确复制')

    // 代码文本被替换：反馈与计时器一并清除。
    await copyButton().trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(copyButton().text()).toBe('已复制')
    await wrapper.setProps({ source: '```sh\nchanged\n```' })
    expect(copyButton().text()).toBe('复制代码块')
    expect(statusText()).not.toContain('代码块已精确复制')

    // 代码块整体删除：反馈不得残留在状态文本里。
    await copyButton().trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(statusText()).toContain('代码块已精确复制')
    await wrapper.setProps({ source: '只剩普通正文，没有代码块。' })
    expect(wrapper.find('button[data-code-index="0"]').exists()).toBe(false)
    expect(statusText()).not.toContain('代码块已精确复制')
    wrapper.unmount()
  })
})

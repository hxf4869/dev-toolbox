import { mount } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'
import { nextTick } from 'vue'

import ArtifactBlocks from './ArtifactBlocks.vue'
import type { ArtifactContent } from './contracts'

const fragmentID = '11111111-1111-4111-8111-111111111111'
const imageID = '22222222-2222-4222-8222-222222222222'
const fileID = '33333333-3333-4333-8333-333333333333'

describe('ArtifactBlocks', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders every v1 block with safe fixed components and preserves an unknown-version fallback', async () => {
    const wrapper = mount(ArtifactBlocks, {
      props: {
        content: artifactContent(),
        attachments: [
          {
            id: imageID,
            kind: 'image',
            originalName: 'screen.png',
            displayName: 'screen.png',
            mediaType: 'image/png',
            sizeBytes: 100,
            previewAllowed: true,
            contentUrl: `/api/v1/attachments/${imageID}/content`,
            thumbnailUrl: `/api/v1/attachments/${imageID}/thumbnail`,
            createdAt: '2026-08-30T01:00:00Z',
          },
          {
            id: fileID,
            kind: 'file',
            originalName: 'notes.txt',
            displayName: 'notes.txt',
            mediaType: 'text/plain',
            sizeBytes: 80,
            previewAllowed: false,
            contentUrl: `/api/v1/attachments/${fileID}/content`,
            createdAt: '2026-08-30T01:00:00Z',
          },
        ],
      },
    })

    expect(wrapper.text()).toContain('AI 派生标题')
    expect(wrapper.text()).toContain('echo safe')
    expect(wrapper.text()).toContain('步骤一')
    expect(wrapper.text()).toContain('访问令牌')
    expect(wrapper.text()).toContain('列一')
    expect(wrapper.text()).toContain('人工核对')
    expect(wrapper.text()).toContain('提醒')
    expect(wrapper.text()).toContain('screen.png')
    expect(wrapper.text()).toContain('notes.txt')
    expect(wrapper.text()).toContain('暂不支持的 Artifact 区块')
    expect(wrapper.text()).toContain('future_chart')
    expect(wrapper.text()).toContain('模型整理，执行前请核对原文')
    expect(wrapper.text()).toContain('模型审阅完成')
    expect(wrapper.text()).toContain('根据原始片段')
    expect(wrapper.text()).toContain('根据模型知识')
    expect(wrapper.text()).toContain('不确定')

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.html()).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')

    const commandSection = wrapper.findAll('.artifact-block').find((entry) =>
      entry.text().includes('bash · 命令'),
    )
    await commandSection?.find('button').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('echo safe')

    await wrapper.find('.source-links button').trigger('click')
    expect(wrapper.emitted('source')?.[0]).toEqual([fragmentID])
  })

  it('asks to fill command placeholders before copying and never auto-executes', async () => {
    const wrapper = mount(ArtifactBlocks, {
      props: { content: artifactContent(), attachments: [] },
      attachTo: document.body,
    })

    const section = wrapper.findAll('.artifact-block').find((entry) =>
      entry.text().includes('带占位符'),
    )
    await section?.find('button').trigger('click')

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    const dialog = document.querySelector<HTMLElement>('.fill-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.textContent).toContain('<database-url>')

    const input = dialog?.querySelector('input') as HTMLInputElement
    input.value = 'postgres://localhost:5432/db'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent?.includes('复制已填写命令'))
      ?.click()
    await flushPromises()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'psql "postgres://localhost:5432/db" -c "select 1"',
    )
    expect(document.querySelector('.fill-dialog')).toBeNull()
    wrapper.unmount()
  })

  it('copies the raw command as-is when the user declines placeholder filling', async () => {
    const wrapper = mount(ArtifactBlocks, {
      props: { content: artifactContent(), attachments: [] },
      attachTo: document.body,
    })

    const section = wrapper.findAll('.artifact-block').find((entry) =>
      entry.text().includes('带占位符'),
    )
    await section?.find('button').trigger('click')
    Array.from(document.querySelectorAll<HTMLButtonElement>('.fill-dialog button'))
      .find((button) => button.textContent?.includes('按原样复制'))
      ?.click()
    await flushPromises()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('psql "<database-url>" -c "select 1"')
    expect(document.querySelector('.fill-dialog')).toBeNull()
    wrapper.unmount()
  })

  it('marks fenced code inside AI markdown as model-derived, not raw record', async () => {
    const wrapper = mount(ArtifactBlocks, {
      props: { content: artifactContent(), attachments: [] },
    })

    const header = wrapper.find('.safe-markdown .safe-code-block header span')
    expect(header.text()).toContain('模型整理')
    expect(header.text()).not.toContain('来自原始记录')
    wrapper.unmount()
  })

  it('does not mistake shell redirection or brace expansion for placeholders', async () => {
    const wrapper = mount(ArtifactBlocks, {
      props: { content: shellSyntaxContent(), attachments: [] },
      attachTo: document.body,
    })

    const sortSection = wrapper.findAll('.artifact-block').find((entry) =>
      entry.text().includes('排序重定向'),
    )
    await sortSection?.find('button').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sort < in.txt > out.txt')
    expect(document.querySelector('.fill-dialog')).toBeNull()

    const braceSection = wrapper.findAll('.artifact-block').find((entry) =>
      entry.text().includes('备份扩展'),
    )
    await braceSection?.find('button').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('cp file{.bak,}')
    expect(document.querySelector('.fill-dialog')).toBeNull()
    wrapper.unmount()
  })

  it('still asks to fill conventional placeholders after tightening the pattern', async () => {
    const wrapper = mount(ArtifactBlocks, {
      props: { content: shellSyntaxContent(), attachments: [] },
      attachTo: document.body,
    })

    const section = wrapper.findAll('.artifact-block').find((entry) =>
      entry.text().includes('常规占位符'),
    )
    await section?.find('button').trigger('click')

    const dialog = document.querySelector<HTMLElement>('.fill-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('<name>')
    expect(dialog?.textContent).toContain('{placeholder}')
    expect(dialog?.textContent).toContain('<output_path>')
    wrapper.unmount()
  })

  it('traps focus in the fill dialog, ignores IME escapes, and returns focus to the triggering button', async () => {
    const wrapper = mount(ArtifactBlocks, {
      props: { content: artifactContent(), attachments: [] },
      attachTo: document.body,
    })
    const trigger = blockCopyButton(wrapper, '带占位符')
    trigger.element.focus()
    await trigger.trigger('click')
    await flushPromises()

    // 打开后焦点落在首个参数输入上。
    const input = dialogInput()
    expect(document.activeElement).toBe(input)

    // Tab 双向环绕：末尾按钮 Tab 回首输入，首输入 Shift+Tab 到末尾按钮。
    const last = dialogButton('复制已填写命令')
    last.focus()
    pressKey(last, { key: 'Tab' })
    expect(document.activeElement).toBe(input)
    pressKey(input, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    // 输入法组合中的 Escape（isComposing，或 Safari 的 keyCode 229）不关闭弹窗、不丢输入。
    input.focus()
    await typeInto(input, 'ime-draft')
    pressKey(input, { key: 'Escape', isComposing: true })
    await flushPromises()
    expect(fillDialog()).not.toBeNull()
    expect(dialogInput().value).toBe('ime-draft')
    pressKey(input, { key: 'Escape', isComposing: false, keyCode: 229 })
    await flushPromises()
    expect(fillDialog()).not.toBeNull()
    expect(dialogInput().value).toBe('ime-draft')

    // 普通 Escape 关闭并把焦点交还原按钮，且没有任何剪贴板写入。
    pressKey(input, { key: 'Escape' })
    await flushPromises()
    expect(fillDialog()).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()

    // 取消按钮同样回焦原按钮。
    await trigger.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(dialogInput())
    const cancel = dialogButton('取消')
    cancel.focus()
    cancel.click()
    await flushPromises()
    expect(fillDialog()).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()

    // 嵌套 command_steps 的复制按钮作为触发器时同样回焦。
    const nested = mount(ArtifactBlocks, {
      props: { content: nestedPlaceholderContent(), attachments: [] },
      attachTo: document.body,
    })
    const nestedTrigger = nested.find<HTMLButtonElement>('.nested-command button')
    nestedTrigger.element.focus()
    await nestedTrigger.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(dialogInput())
    pressKey(dialogInput(), { key: 'Escape' })
    await flushPromises()
    expect(fillDialog()).toBeNull()
    expect(document.activeElement).toBe(nestedTrigger.element)
    nested.unmount()
  })

  it('binds deferred fill-copy results to the dialog and preview they were started from', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const wrapper = mount(ArtifactBlocks, {
      props: { content: artifactContent(), attachments: [] },
      attachTo: document.body,
    })
    const trigger = blockCopyButton(wrapper, '带占位符')

    // 旧成功：挂起期间取消并重开、输入新值后才到达，不得关闭新弹窗。
    const first = deferred()
    writeText.mockImplementationOnce(() => first.promise)
    trigger.element.focus()
    await trigger.trigger('click')
    await flushPromises()
    await typeInto(dialogInput(), 'v1')
    await clickButton(dialogButton('复制已填写命令'))
    expect(writeText).toHaveBeenLastCalledWith('psql "v1" -c "select 1"')
    await clickButton(dialogButton('取消'))
    await flushPromises()
    expect(fillDialog()).toBeNull()
    await trigger.trigger('click')
    await flushPromises()
    await typeInto(dialogInput(), 'v2')
    first.resolve()
    await flushPromises()
    expect(fillDialog()).not.toBeNull()
    expect(dialogInput().value).toBe('v2')
    expect(document.querySelector('.fill-error')).toBeNull()

    // 旧失败：同样不得进入重开后的新弹窗。
    const second = deferred()
    writeText.mockImplementationOnce(() => second.promise)
    await clickButton(dialogButton('复制已填写命令'))
    expect(writeText).toHaveBeenLastCalledWith('psql "v2" -c "select 1"')
    await clickButton(dialogButton('取消'))
    await flushPromises()
    await trigger.trigger('click')
    await flushPromises()
    await typeInto(dialogInput(), 'v3')
    second.reject(new Error('denied'))
    await flushPromises()
    expect(fillDialog()).not.toBeNull()
    expect(document.querySelector('.fill-error')).toBeNull()
    expect(dialogInput().value).toBe('v3')

    // 等待期间改了参数：旧成功既不关闭弹窗，也不丢弃新值。
    const third = deferred()
    writeText.mockImplementationOnce(() => third.promise)
    await clickButton(dialogButton('复制已填写命令'))
    expect(writeText).toHaveBeenLastCalledWith('psql "v3" -c "select 1"')
    await typeInto(dialogInput(), 'v4')
    third.resolve()
    await flushPromises()
    expect(fillDialog()).not.toBeNull()
    expect(dialogInput().value).toBe('v4')
    expect(document.querySelector('.fill-preview')?.textContent).toBe('psql "v4" -c "select 1"')

    // 当前弹窗的失败可显式重试；成功后关闭并回焦原按钮。
    writeText.mockRejectedValueOnce(new Error('denied'))
    await clickButton(dialogButton('复制已填写命令'))
    await flushPromises()
    expect(document.querySelector('.fill-error')?.textContent).toBe('复制失败，请重试。')
    expect(dialogInput().value).toBe('v4')
    await clickButton(dialogButton('复制已填写命令'))
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith('psql "v4" -c "select 1"')
    expect(fillDialog()).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
    expect(trigger.text()).toBe('已复制')
    wrapper.unmount()
  })

  it('does not resurface an as-is copy failure after a later filled copy of the same command succeeds', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const wrapper = mount(ArtifactBlocks, {
      props: { content: artifactContent(), attachments: [] },
      attachTo: document.body,
    })
    const trigger = blockCopyButton(wrapper, '带占位符')
    // SafeMarkdown 自带同名 status；只读 ArtifactBlocks 直接子级的那一个。
    const status = () => wrapper.get('.artifact-document > [role="status"]').text()

    writeText.mockRejectedValueOnce(new Error('denied'))
    trigger.element.focus()
    await trigger.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await clickButton(dialogButton('按原样复制'))
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenLastCalledWith('psql "<database-url>" -c "select 1"')
    expect(fillDialog()).toBeNull()
    expect(trigger.text()).toBe('复制失败，重试')
    expect(status()).toBe('复制失败，请重试')

    await trigger.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await typeInto(dialogInput(), 'postgres://db')
    await clickButton(dialogButton('复制已填写命令'))
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenLastCalledWith('psql "postgres://db" -c "select 1"')
    expect(fillDialog()).toBeNull()
    expect(trigger.text()).toBe('已复制')
    expect(status()).toBe('内容已精确复制')

    // 成功反馈到期后回到普通“复制”，旧的失败不得重新出现。
    await vi.advanceTimersByTimeAsync(1600)
    expect(trigger.text()).toBe('复制')
    expect(status()).toBe('')
    wrapper.unmount()
  })

  it('gives a repeated copy of the same code block a full fresh feedback window', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const wrapper = mount(ArtifactBlocks, {
      props: { content: artifactContent(), attachments: [] },
      attachTo: document.body,
    })
    const copyButton = blockCopyButton(wrapper, 'ts · 示例')

    copyButton.element.focus()
    await copyButton.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenLastCalledWith('const ok = true')
    expect(copyButton.text()).toBe('已复制')

    await vi.advanceTimersByTimeAsync(1000)
    await copyButton.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(copyButton.text()).toBe('已复制')

    // 第一次反馈的 1600ms 到期点不得清掉第二次反馈。
    await vi.advanceTimersByTimeAsync(600)
    expect(copyButton.text()).toBe('已复制')
    // 第二次反馈自身满 1600ms 后才复位。
    await vi.advanceTimersByTimeAsync(1000)
    expect(copyButton.text()).toBe('复制')
    wrapper.unmount()
  })
})

// keyCode 直接放进 init 在本仓库 jsdom 下可用（同 SupplementDrawer.saving-keyboard.test.ts）。
function pressKey(target: Element, init: KeyboardEventInit & { keyCode?: number }) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

// 浏览器点击会先把焦点交给按钮；原生 click 前显式聚焦以模拟这一步。
async function clickButton(button: HTMLElement) {
  button.focus()
  button.click()
  await nextTick()
}

async function typeInto(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function blockCopyButton(wrapper: VueWrapper, description: string) {
  const section = wrapper.findAll('.artifact-block').find((entry) => entry.text().includes(description))
  if (!section) throw new Error(`missing artifact block: ${description}`)
  return section.find<HTMLButtonElement>('button')
}

function fillDialog() {
  return document.querySelector<HTMLElement>('.fill-dialog')
}

function dialogInput() {
  const input = document.querySelector<HTMLInputElement>('.fill-dialog input')
  if (!input) throw new Error('fill dialog input missing')
  return input
}

function dialogButton(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.fill-dialog button')).find(
    (entry) => entry.textContent?.trim() === label,
  )
  if (!button) throw new Error(`missing fill dialog button: ${label}`)
  return button
}

function nestedPlaceholderContent(): ArtifactContent {
  return {
    ...artifactContent(),
    warnings: [],
    blocks: [
      {
        id: 'nested',
        type: 'command_steps',
        title: '嵌套占位符',
        steps: [{ title: '连接主机', commands: [{ shell: 'bash', command: 'ssh <host>' }], sourceFragmentIds: [] }],
        sourceFragmentIds: [],
      },
    ],
  }
}

function shellSyntaxContent(): ArtifactContent {
  return {
    ...artifactContent(),
    warnings: [],
    blocks: [
      { id: 'cmd-sort', type: 'command', shell: 'bash', command: 'sort < in.txt > out.txt', description: '排序重定向', sourceFragmentIds: [] },
      { id: 'cmd-brace', type: 'command', shell: 'bash', command: 'cp file{.bak,}', description: '备份扩展', sourceFragmentIds: [] },
      { id: 'cmd-ph', type: 'command', shell: 'bash', command: 'render <name> --out {placeholder} <output_path>', description: '常规占位符', sourceFragmentIds: [] },
    ],
  }
}

function artifactContent(): ArtifactContent {
  return {
    schemaVersion: '1.0',
    artifactType: 'organized_record',
    title: 'AI 派生标题',
    summary: '派生摘要',
    classification: {
      contentType: 'development',
      suggestedFolderPath: ['开发'],
      suggestedTags: ['测试'],
      sensitivitySuggestion: 'normal',
    },
    sourceFragmentIds: [fragmentID],
    warnings: [
      {
        severity: 'warning',
        title: '来自原文的提醒',
        message: '需要核对。',
        basis: 'source_evidence',
        sourceFragmentIds: [fragmentID],
      },
      {
        severity: 'info',
        title: '模型知识提醒',
        message: '版本可能变化。',
        basis: 'model_knowledge',
        sourceFragmentIds: [],
      },
    ],
    blocks: [
      { id: 'markdown', type: 'markdown', markdown: '# 安全 Markdown\n<img src=x onerror=alert(1)>\n\n```sh\necho derived\n```', sourceFragmentIds: [fragmentID] },
      { id: 'code', type: 'code', language: 'ts', code: 'const ok = true', caption: '示例', sourceFragmentIds: [fragmentID] },
      { id: 'command', type: 'command', shell: 'bash', command: 'echo safe', description: '只展示', sourceFragmentIds: [fragmentID] },
      { id: 'command-ph', type: 'command', shell: 'bash', command: 'psql "<database-url>" -c "select 1"', description: '带占位符', sourceFragmentIds: [fragmentID] },
      {
        id: 'steps',
        type: 'command_steps',
        title: '操作步骤',
        steps: [{ title: '步骤一', instruction: '先核对', commands: [{ shell: 'bash', command: 'pwd' }], notes: ['不要直接执行'], sourceFragmentIds: [fragmentID] }],
        sourceFragmentIds: [fragmentID],
      },
      { id: 'kv', type: 'key_value', title: '参数', entries: [{ key: '访问令牌', value: 'secret', sensitive: true }], sourceFragmentIds: [fragmentID] },
      { id: 'table', type: 'table', title: '表格', columns: ['列一'], rows: [['值一']], sourceFragmentIds: [fragmentID] },
      { id: 'checklist', type: 'checklist', title: '清单', items: [{ label: '人工核对', sourceFragmentIds: [fragmentID] }], sourceFragmentIds: [fragmentID] },
      { id: 'callout', type: 'callout', tone: 'warning', title: '提醒', body: '谨慎处理', sourceFragmentIds: [fragmentID] },
      { id: 'image', type: 'image_reference', attachmentId: imageID, caption: '截图', extractedText: '文字', sourceFragmentIds: [] },
      { id: 'file', type: 'attachment_reference', attachmentId: fileID, caption: '说明文件', sourceFragmentIds: [] },
      { id: 'future', type: 'future_chart', values: [1, 2, 3], sourceFragmentIds: [] },
    ],
    review: { status: 'model_reviewed', limitations: ['需要人工确认'] },
  }
}

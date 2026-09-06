import { mount } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { vi } from 'vitest'

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
})

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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { loadArtifactContract, type ArtifactContract } from './artifact-schema.js'
import { ProviderGatewayError } from './model-gateway.js'
import { PromptStore } from './prompts.js'
import type { ClaimedTask, SafeTaskEvent } from './task-client.js'
import { TaskClientError } from './task-client.js'
import { TaskRunner, type TaskApi } from './task-runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '../../..')
const fragmentId = '7484e4f8-6ebc-51c1-9e42-8b4cecff2b4f'
const recordId = '21e2705b-8bd8-43ea-b155-945a2ace1357'
const imageId = 'ad75cf86-90ee-43ac-a329-c35e8cfc47ea'
let contract: ArtifactContract
let organizedArtifact: Record<string, unknown>
const egressServers: Array<ReturnType<typeof createServer>> = []

beforeAll(async () => {
  contract = await loadArtifactContract(resolve(repositoryRoot, 'docs/contracts/ai-artifact.schema.json'))
  organizedArtifact = JSON.parse(await readFile(
    resolve(repositoryRoot, 'tests/fixtures/ai-artifact/valid-organized.json'),
    'utf8',
  )) as Record<string, unknown>
})

afterEach(async () => {
  await Promise.all(
    egressServers.splice(0).map(
      (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    ),
  )
})

describe('bounded task runner', () => {
  it('materializes the same valid Artifact from the v2 tool and exact-JSON channels', async () => {
    const toolApi = new FakeTaskApi()
    const jsonApi = new FakeTaskApi()
    const draft = organizedDraft()
    const base = taskClaim()
    const toolClaim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
    }
    const jsonClaim: ClaimedTask = {
      ...toolClaim,
      provider: { ...toolClaim.provider, supportsTools: false },
    }
    const toolMessages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('candidate', 'emit_artifact_draft', draft)]),
    ]
    const toolRunner = createRunner(toolApi, async (request) => {
      const schemaText = JSON.stringify(request.context.tools?.at(-1)?.parameters)
      expect(schemaText).not.toContain('$defs')
      expect(schemaText).not.toContain('oneOf')
      return { message: toolMessages.shift()!, attempts: 1 }
    })
    const jsonRunner = createRunner(jsonApi, async (request) => {
      expect(request.context.tools).toBeUndefined()
      const directContext = request.context.messages[0]?.content
      expect(typeof directContext === 'string' ? directContext : '').toContain('"ref":"S1"')
      expect(typeof directContext === 'string' ? directContext : '').not.toContain(fragmentId)
      return { message: assistant([{ type: 'text', text: JSON.stringify(draft) }]), attempts: 1 }
    })

    await toolRunner.run(toolClaim)
    await jsonRunner.run(jsonClaim)

    expect(toolApi.failures).toEqual([])
    expect(jsonApi.failures).toEqual([])
    expect(toolApi.completed).toHaveLength(1)
    expect(jsonApi.completed).toEqual(toolApi.completed)
    expect(contract.validate(toolApi.completed[0])).toBe(true)
    expect(toolApi.completed[0]).toMatchObject({
      schemaVersion: '1.0',
      artifactType: 'organized_record',
      sourceFragmentIds: [fragmentId],
      review: { status: 'model_reviewed' },
      blocks: [{ id: 'block_1', sourceFragmentIds: [fragmentId] }],
    })
  })

  it('falls back from an ignored v2 tool channel to exact JSON without capability detection', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
    }
    let calls = 0
    const runner = createRunner(api, async (request) => {
      calls += 1
      if (calls === 1) {
        expect(request.context.tools?.length).toBeGreaterThan(0)
        return { message: assistant([{ type: 'text', text: '我无法调用工具。' }]), attempts: 1 }
      }
      expect(request.context.tools).toBeUndefined()
      const directContext = request.context.messages[0]?.content
      expect(typeof directContext === 'string' ? directContext : '').toContain('"ref":"S1"')
      return { message: assistant([{ type: 'text', text: JSON.stringify(organizedDraft()) }]), attempts: 1 }
    })

    await runner.run(claim)

    expect(calls).toBe(2)
    expect(api.completed).toHaveLength(1)
    expect(api.failures).toEqual([])
  })

  it('falls back once when a v2 Provider rejects the tool protocol', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
    }
    let calls = 0
    const runner = createRunner(api, async (request) => {
      calls += 1
      if (calls === 1) throw new ProviderGatewayError('protocol_error')
      expect(request.context.tools).toBeUndefined()
      return { message: assistant([{ type: 'text', text: JSON.stringify(organizedDraft()) }]), attempts: 1 }
    })

    await runner.run(claim)

    expect(calls).toBe(2)
    expect(api.completed).toHaveLength(1)
    expect(api.failures).toEqual([])
  })

  it('injects authorized images into the v2 JSON channel and maps A# references', async () => {
    const api = new FakeTaskApi()
    api.attachmentBytes = new Uint8Array([1, 2, 3])
    const base = taskClaim({
      attachments: [{
        id: imageId, kind: 'image', mediaType: 'image/png', sizeBytes: 3,
        width: 1, height: 1,
      }],
    })
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, type: 'analyze_image', promptVersion: 'image-v2' },
      provider: { ...base.provider, supportsTools: false, supportsVision: true },
    }
    const draft = {
      ...organizedDraft(),
      classification: {
        contentType: 'image', suggestedFolderPath: ['图片'], suggestedTags: ['截图'],
        sensitivitySuggestion: 'normal',
      },
      blocks: [{
        type: 'image_reference', attachmentRef: 'A1', caption: '截图内容', sourceRefs: [],
      }],
    }
    const runner = createRunner(api, async (request) => {
      expect(request.context.tools).toBeUndefined()
      const content = request.context.messages[0]?.content
      expect(Array.isArray(content) ? content.filter((part) => part.type === 'image') : []).toHaveLength(1)
      const contextText = Array.isArray(content) ? content.find((part) => part.type === 'text')?.text ?? '' : ''
      expect(contextText).toContain('"ref":"A1"')
      expect(contextText).not.toContain(imageId)
      return { message: assistant([{ type: 'text', text: JSON.stringify(draft) }]), attempts: 1 }
    })

    await runner.run(claim)

    expect(api.attachmentReads).toEqual([imageId])
    expect(api.failures).toEqual([])
    expect(api.completed[0]).toMatchObject({
      artifactType: 'image_analysis',
      blocks: [{ type: 'image_reference', attachmentId: imageId }],
    })
  })

  it('returns a precise v2 Draft error once and accepts the repaired JSON', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const invalid = organizedDraft()
    ;(invalid.blocks as Array<Record<string, unknown>>)[0]!.sourceRefs = ['S99']
    let calls = 0
    const runner = createRunner(api, async (request) => {
      calls += 1
      if (calls === 1) return { message: assistant([{ type: 'text', text: JSON.stringify(invalid) }]), attempts: 1 }
      const repairMessage = request.context.messages.at(-1)
      expect(JSON.stringify(repairMessage)).toContain('/blocks/0/sourceRefs')
      expect(JSON.stringify(repairMessage)).toContain('S99')
      return { message: assistant([{ type: 'text', text: JSON.stringify(organizedDraft()) }]), attempts: 1 }
    })

    await runner.run(claim)

    expect(calls).toBe(2)
    expect(api.completed).toHaveLength(1)
    expect(api.failures).toEqual([])
  })

  it('merges a partial v2 repair over the immediately preceding invalid Draft', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const invalid = organizedDraft()
    ;(invalid.blocks as Array<Record<string, unknown>>)[0]!.sourceRefs = ['S99']
    const repairedBlocks = organizedDraft().blocks
    let calls = 0
    const runner = createRunner(api, async () => {
      calls += 1
      const response = calls === 1 ? invalid : { blocks: repairedBlocks }
      return { message: assistant([{ type: 'text', text: JSON.stringify(response) }]), attempts: 1 }
    })

    await runner.run(claim)

    expect(calls).toBe(2)
    expect(api.failures).toEqual([])
    expect(api.completed).toHaveLength(1)
    expect(api.completed[0]).toMatchObject({
      title: organizedDraft().title,
      summary: organizedDraft().summary,
      blocks: [{ sourceFragmentIds: [fragmentId] }],
    })
  })

  it('merges a warning-only repair only when one invalid warning is uniquely identified', async () => {
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const invalid = organizedDraft() as Record<string, any>
    invalid.warnings = [{ severity: 'warning', title: '配置风险', sourceRefs: ['S1'] }]
    let calls = 0
    const api = new FakeTaskApi()
    const runner = createRunner(api, async () => {
      calls += 1
      const response = calls === 1
        ? invalid
        : { message: '部署前核对配置。', basis: 'source_evidence', sourceRefs: ['S1'] }
      return { message: assistant([{ type: 'text', text: JSON.stringify(response) }]), attempts: 1 }
    })

    await runner.run(claim)

    expect(calls).toBe(2)
    expect(api.failures).toEqual([])
    expect(api.completed[0]).toMatchObject({
      warnings: [{
        severity: 'warning', title: '配置风险', message: '部署前核对配置。',
        basis: 'source_evidence', sourceFragmentIds: [fragmentId],
      }],
    })

    const ambiguous = organizedDraft() as Record<string, any>
    ambiguous.warnings = [
      { severity: 'warning', title: '风险一', sourceRefs: ['S1'] },
      { severity: 'warning', title: '风险二', sourceRefs: ['S1'] },
    ]
    let ambiguousCalls = 0
    const ambiguousApi = new FakeTaskApi()
    const ambiguousRunner = createRunner(ambiguousApi, async () => {
      ambiguousCalls += 1
      const response = ambiguousCalls === 1
        ? ambiguous
        : { message: '无法确定应修复哪一项。', basis: 'source_evidence', sourceRefs: ['S1'] }
      return { message: assistant([{ type: 'text', text: JSON.stringify(response) }]), attempts: 1 }
    })

    await ambiguousRunner.run(claim)

    expect(ambiguousApi.completed).toEqual([])
    expect(ambiguousApi.failures.at(-1)?.detail).toContain('不允许字段 message')

    let titledCalls = 0
    const titledApi = new FakeTaskApi()
    const titledRunner = createRunner(titledApi, async () => {
      titledCalls += 1
      const response = titledCalls === 1
        ? invalid
        : { title: '根标题或 warning 标题不明确', message: '部署前核对配置。', basis: 'source_evidence', sourceRefs: ['S1'] }
      return { message: assistant([{ type: 'text', text: JSON.stringify(response) }]), attempts: 1 }
    })

    await titledRunner.run(claim)

    expect(titledApi.completed).toEqual([])
    expect(titledApi.failures.at(-1)?.detail).toContain('不允许字段 message')
  })

  it('normalizes bounded v2 provider variations without weakening the final contract', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
    }
    const draft = organizedDraft() as Record<string, any>
    draft.classification.suggestedFolderPath = '服务器运维/磁盘'
    draft.classification.suggestedTags = 'Linux'
    draft.blocks = [
      { type: 'section', content: '查看 <disk> 并挂载新磁盘。', sourceRefs: 'S1' },
      {
        steps: [{
          title: '查看磁盘',
          commands: [{ command: 'lsblk', sourceRefs: ['S1'] }],
        }],
      },
      {
        table: {
          title: '挂载参数',
          columns: ['参数', '说明'],
          rows: [['设备', '/dev/vdb']],
        },
        sourceRefs: ['S1'],
      },
    ]
    draft.warnings = [{
      severity: 'warning', title: '先核对设备名', message: '设备名可能因环境而不同。',
      sourceRefs: ['S1'], recommend: '先运行 lsblk。', module: '磁盘',
    }]
    draft.limitations = '模型没有连接目标服务器验证命令。'
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('candidate', 'emit_artifact_draft', { draft })]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(claim)

    expect(api.failures).toEqual([])
    expect(api.completed).toHaveLength(1)
    expect(contract.validate(api.completed[0])).toBe(true)
    expect(api.completed[0]).toMatchObject({
      classification: {
        suggestedFolderPath: ['服务器运维/磁盘'],
        suggestedTags: ['Linux'],
      },
      blocks: [
        { type: 'markdown', markdown: '查看 &lt;disk&gt; 并挂载新磁盘。', sourceFragmentIds: [fragmentId] },
        {
          type: 'command_steps', title: '查看磁盘', sourceFragmentIds: [fragmentId],
          steps: [{
            sourceFragmentIds: [fragmentId],
            commands: [{ shell: 'other', command: 'lsblk' }],
          }],
        },
        {
          type: 'table', title: '挂载参数', columns: ['参数', '说明'],
          rows: [['设备', '/dev/vdb']], sourceFragmentIds: [fragmentId],
        },
      ],
      warnings: [{
        basis: 'source_evidence', recommendation: '先运行 lsblk。',
        sourceFragmentIds: [fragmentId],
      }],
    })
  })

  it('normalizes misplaced metadata, nested command steps, and source-less supporting blocks', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    const classification = draft.classification
    delete draft.classification
    delete draft.limitations
    draft.blocks = [
      {
        command_steps: {
          title: '查看磁盘',
          steps: [{
            title: '执行检查',
            instructions: ['先确认设备名。'],
            commands: [{ wrapper: { shell: 'bash', command: 'lsblk', sourceRefs: ['S1'] } }],
          }],
        },
      },
      { type: 'markdown', markdown: '这是未单独关联来源的辅助说明。' },
      {
        type: 'table', columns: ['字段', '说明'], rows: [['device', '磁盘设备']], sourceRefs: ['S1'],
        columns_note: '表格列由原始笔记归纳。', limitations: '表格内容需要人工复核。',
        summary: '挂载参数摘要。', warnings: ['表格来源需要人工复核。'],
      },
      { type: 'code', code: 'lsblk', class: 'bash', sourceRefs: ['S1'] },
      {
        type: 'command', shell: 'bash', call: 'lsblk', summary: '列出块设备。',
        warnings: [{ title: '执行提醒', message: '先确认当前主机。' }], sourceRefs: ['S1'],
      },
      { classification },
    ]
    draft.warnings = [{
      severity: 'warning', title: '人工核对', message: '执行前核对设备名。',
      basis: 'source_evidence', sourceRefs: ['S1'],
      limitations: '模型没有连接目标服务器验证命令。',
    }]
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.failures).toEqual([])
    expect(api.completed).toHaveLength(1)
    expect(contract.validate(api.completed[0])).toBe(true)
    expect(api.completed[0]).toMatchObject({
      classification,
      blocks: [
        {
          type: 'command_steps', title: '查看磁盘', sourceFragmentIds: [fragmentId],
          steps: [{
            instruction: '先确认设备名。', sourceFragmentIds: [fragmentId],
            commands: [{ shell: 'bash', command: 'lsblk' }],
          }],
        },
        { type: 'markdown', sourceFragmentIds: [] },
        { type: 'table', columns: ['字段', '说明'], rows: [['device', '磁盘设备']] },
        { type: 'code', language: 'bash', code: 'lsblk' },
        { type: 'command', shell: 'bash', command: 'lsblk', description: '列出块设备。' },
      ],
      warnings: [{ sourceFragmentIds: [fragmentId] }],
      review: {
        limitations: expect.arrayContaining([
          '表格列由原始笔记归纳。',
          '表格内容需要人工复核。',
          '表格来源需要人工复核。',
          '执行提醒：先确认当前主机。',
          '模型没有连接目标服务器验证命令。',
        ]),
      },
    })
  })

  it('normalizes the bounded misplaced fields and source-ref list seen in migration output', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    const limitation = '多段命令源自原始 Notion 页面文本，尚未在实际服务器上验证执行结果，仅作记录归档。'
    draft[limitation] = true
    const classification = draft.classification as Record<string, unknown>
    const blocks = draft.blocks as Array<Record<string, unknown>>
    blocks[0]!.sourceRefs = ['S1，S1']
    const classificationBlock: Record<string, unknown> = { sourceRefs: ['S1', 'S1', 'not-a-source-ref'] }
    for (const field of ['suggestedFolderPath', 'suggestedTags', 'sensitivitySuggestion'] as const) {
      classificationBlock[field] = classification[field]
      delete classification[field]
    }
    classificationBlock.sensitivityReason = '原文包含部署命令，需要人工确认。'
    blocks.push(classificationBlock)
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.failures).toEqual([])
    expect(api.completed).toHaveLength(1)
    expect(contract.validate(api.completed[0])).toBe(true)
    expect(api.completed[0]).toMatchObject({
      classification: {
        suggestedFolderPath: ['服务器运维', '磁盘'],
        suggestedTags: ['Linux', 'ext4'],
        sensitivitySuggestion: 'normal',
        sensitivityReason: '原文包含部署命令，需要人工确认。',
      },
      blocks: [{ sourceFragmentIds: [fragmentId] }],
      review: { limitations: expect.arrayContaining([limitation]) },
    })
  })

  it('normalizes a sourceTRefs typo and a titled top-level commands block', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    draft.blocks = [{
      title: '启动服务', commands: [{ shell: 'bash', command: 'docker compose up -d' }],
      instruction: '先核对 compose 文件。', sourceTRefs: ['S1'],
    }]
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.failures).toEqual([])
    expect(api.completed).toHaveLength(1)
    expect(contract.validate(api.completed[0])).toBe(true)
    expect(api.completed[0]).toMatchObject({
      blocks: [{
        type: 'command_steps', title: '启动服务', sourceFragmentIds: [fragmentId],
        steps: [{
          title: '启动服务', instruction: '先核对 compose 文件。',
          commands: [{ shell: 'bash', command: 'docker compose up -d' }],
          sourceFragmentIds: [fragmentId],
        }],
      }],
    })
  })

  it('normalizes singular S# source aliases without consuming prose references', async () => {
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    draft.blocks = [{ type: 'markdown', markdown: '部署说明。', sourceRef: 'S1' }]
    draft.warnings = [{
      severity: 'warning', title: '核对配置', message: '部署前检查参数。',
      basis: 'source_evidence', sourceRef: 'S1', reference: 'S1',
    }]
    const api = new FakeTaskApi()
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.failures).toEqual([])
    expect(api.completed[0]).toMatchObject({
      blocks: [{ sourceFragmentIds: [fragmentId] }],
      warnings: [{ sourceFragmentIds: [fragmentId] }],
    })

    const proseReferenceDraft = organizedDraft() as Record<string, any>
    proseReferenceDraft.warnings = [{
      severity: 'warning', title: '核对配置', message: '部署前检查参数。',
      basis: 'model_knowledge', sourceRefs: [], reference: '官方部署文档',
    }]
    const proseReferenceApi = new FakeTaskApi()
    const proseReferenceRunner = createRunner(proseReferenceApi, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(proseReferenceDraft) }]),
      attempts: 1,
    }))

    await proseReferenceRunner.run(claim)

    expect(proseReferenceApi.completed).toEqual([])
    expect(proseReferenceApi.failures.at(-1)?.detail).toContain('reference')
  })

  it('normalizes a bash field used as a typed body without hiding conflicts', async () => {
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    draft.blocks = [{ type: 'code', bash: 'docker compose up -d', sourceRefs: ['S1'] }]
    const api = new FakeTaskApi()
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.failures).toEqual([])
    expect(api.completed).toHaveLength(1)
    expect(api.completed[0]).toMatchObject({
      blocks: [{ type: 'code', language: 'bash', code: 'docker compose up -d' }],
    })

    const commandDraft = organizedDraft() as Record<string, any>
    commandDraft.blocks = [{ type: 'command', bash: 'docker compose ps', sourceRefs: ['S1'] }]
    const commandApi = new FakeTaskApi()
    const commandRunner = createRunner(commandApi, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(commandDraft) }]),
      attempts: 1,
    }))

    await commandRunner.run(claim)

    expect(commandApi.failures).toEqual([])
    expect(commandApi.completed[0]).toMatchObject({
      blocks: [{ type: 'command', shell: 'bash', command: 'docker compose ps' }],
    })

    const conflictingDraft = organizedDraft() as Record<string, any>
    conflictingDraft.blocks = [{
      type: 'code', language: 'bash', code: 'docker compose up -d', bash: 'docker compose down',
      sourceRefs: ['S1'],
    }]
    const conflictingApi = new FakeTaskApi()
    const conflictingRunner = createRunner(conflictingApi, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(conflictingDraft) }]),
      attempts: 1,
    }))

    await conflictingRunner.run(claim)

    expect(conflictingApi.completed).toEqual([])
    expect(conflictingApi.failures.at(-1)?.detail).toContain('bash')
  })

  it('normalizes an error warning alias and defaults its severity without hiding conflicts', async () => {
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    draft.warnings = [{
      title: '配置风险', error: '部署前需要替换占位符。', basis: 'source_evidence', sourceRefs: ['S1'],
    }]
    const api = new FakeTaskApi()
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.failures).toEqual([])
    expect(api.completed[0]).toMatchObject({
      warnings: [{ severity: 'warning', title: '配置风险', message: '部署前需要替换占位符。' }],
    })

    const conflictingDraft = organizedDraft() as Record<string, any>
    conflictingDraft.warnings = [{
      title: '配置风险', message: '保留现有说明。', error: '不同的错误说明。',
      basis: 'source_evidence', sourceRefs: ['S1'],
    }]
    const conflictingApi = new FakeTaskApi()
    const conflictingRunner = createRunner(conflictingApi, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(conflictingDraft) }]),
      attempts: 1,
    }))

    await conflictingRunner.run(claim)

    expect(conflictingApi.completed).toEqual([])
    expect(conflictingApi.failures.at(-1)?.detail).toContain('error')
  })

  it('preserves or omits empty code blocks with an explicit review limitation', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    ;(draft.blocks as Array<Record<string, unknown>>).push(
      {
        type: 'code', language: 'yaml', summary: '该配置片段只返回了说明。',
        sourceRefs: ['S1'],
      },
      { type: 'code', language: 'yaml', sourceRefs: ['S1'] },
    )
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.failures).toEqual([])
    expect(api.completed).toHaveLength(1)
    expect(contract.validate(api.completed[0])).toBe(true)
    expect(api.completed[0]).toMatchObject({
      blocks: [{ type: 'command_steps' }],
      review: {
        limitations: expect.arrayContaining([
          '模型第 2 个 code block 未提供代码正文，当前版本已忽略该 block；原说明：该配置片段只返回了说明。',
          '模型第 3 个 code block 未提供代码正文或说明，当前版本已忽略该空 block。',
        ]),
      },
    })
  })

  it('keeps strict validation for empty code blocks with unknown fields', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    ;(draft.blocks as Array<Record<string, unknown>>).push({
      type: 'code', language: 'yaml', sourceRefs: ['S1'], providerPayload: true,
    })
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.completed).toEqual([])
    expect(api.failures).toHaveLength(1)
    expect(api.failures[0]?.detail).toContain('providerPayload')
  })

  it('does not create an Artifact when every block is empty', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    draft.blocks = [{ type: 'code', language: 'yaml', sourceRefs: ['S1'] }]
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.completed).toEqual([])
    expect(api.failures).toHaveLength(1)
    expect(api.failures[0]?.detail).toContain('/blocks')
  })

  it('caps aggregate source references at the result-contract limit and records the limitation', async () => {
    const fragments = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      rawRecordId: recordId,
      sourceKind: 'raw_text' as const,
      ordinal: index,
      content: `source ${index + 1}`,
    }))
    const base = taskClaim({ fragments })
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    draft.blocks = [
      {
        type: 'markdown', markdown: '前一百个来源。',
        sourceRefs: Array.from({ length: 100 }, (_, index) => `S${index + 1}`),
      },
      { type: 'markdown', markdown: '第一百零一个来源。', sourceRefs: ['S101'] },
    ]
    const api = new FakeTaskApi()
    const runner = createRunner(api, async () => ({
      message: assistant([{ type: 'text', text: JSON.stringify(draft) }]),
      attempts: 1,
    }))

    await runner.run(claim)

    expect(api.failures).toEqual([])
    expect(api.completed).toHaveLength(1)
    expect(contract.validate(api.completed[0])).toBe(true)
    expect(api.completed[0]?.sourceFragmentIds).toHaveLength(100)
    expect((api.completed[0]?.blocks as Record<string, unknown>[])[1]?.sourceFragmentIds).toEqual([])
    expect((api.completed[0]?.review as Record<string, unknown>).limitations).toContain(
      '来源引用超过结果契约上限，当前版本仅保留前 100 个唯一来源片段的引用。',
    )
  })

  it('accepts an exact single JSON code fence but not prose around JSON', async () => {
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const fencedApi = new FakeTaskApi()
    const fencedRunner = createRunner(fencedApi, async () => ({
      message: assistant([{ type: 'text', text: `\`\`\`json\n${JSON.stringify(organizedDraft())}\n\`\`\`` }]),
      attempts: 1,
    }))

    await fencedRunner.run(claim)

    expect(fencedApi.failures).toEqual([])
    expect(fencedApi.completed).toHaveLength(1)

    const proseApi = new FakeTaskApi()
    let proseCalls = 0
    const proseRunner = createRunner(proseApi, async () => {
      proseCalls += 1
      return {
        message: assistant([{
          type: 'text',
          text: `整理结果如下：\n\`\`\`json\n${JSON.stringify(organizedDraft())}\n\`\`\``,
        }]),
        attempts: 1,
      }
    })

    await proseRunner.run(claim)

    expect(proseCalls).toBe(2)
    expect(proseApi.completed).toEqual([])
    expect(proseApi.failures.at(-1)?.code).toBe('AI_ARTIFACT_SCHEMA_INVALID')
  })

  it('does not invent a missing source reference during Draft normalization', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, promptVersion: 'organize-v2' },
      provider: { ...base.provider, supportsTools: false },
    }
    const draft = organizedDraft() as Record<string, any>
    draft.blocks = [{ type: 'markdown', markdown: '没有来源引用的内容。' }]
    let calls = 0
    const runner = createRunner(api, async () => {
      calls += 1
      return { message: assistant([{ type: 'text', text: JSON.stringify(draft) }]), attempts: 1 }
    })

    await runner.run(claim)

    expect(calls).toBe(2)
    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_ARTIFACT_SCHEMA_INVALID')
    expect(api.failures.at(-1)?.detail).toContain('sourceRefs')
  })

  it('completes a valid candidate after reading the controlled context', async () => {
    const api = new FakeTaskApi()
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('candidate', 'emit_candidate_artifact', { artifact: organizedArtifact })]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim())

    expect(api.completed).toHaveLength(1)
    expect(api.failures).toEqual([])
    expect(api.completed[0]).toEqual(organizedArtifact)
  })

  it('creates a correctness review candidate without changing the source contract', async () => {
    const api = new FakeTaskApi()
    const artifact = { ...organizedArtifact, artifactType: 'correctness_review' }
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('candidate', 'emit_candidate_artifact', { artifact })]),
    ]
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, type: 'review_record', promptVersion: 'review-v1' },
    }
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(claim)

    expect(api.completed).toHaveLength(1)
    expect(api.completed[0]?.artifactType).toBe('correctness_review')
  })

  it('reads every authorized image before accepting an image analysis candidate', async () => {
    const api = new FakeTaskApi()
    api.attachmentBytes = new Uint8Array([1, 2, 3])
    const artifact = {
      ...organizedArtifact,
      artifactType: 'image_analysis',
      classification: {
        contentType: 'image', suggestedFolderPath: ['图片'], suggestedTags: ['截图'],
        sensitivitySuggestion: 'normal',
      },
      blocks: [{
        id: 'image', type: 'image_reference', attachmentId: imageId,
        caption: '截图内容', sourceFragmentIds: [],
      }],
      sourceFragmentIds: [],
    }
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('image', 'get_attachment', { attachmentId: imageId })]),
      assistant([toolCall('candidate', 'emit_candidate_artifact', { artifact })]),
    ]
    const base = taskClaim({
      attachments: [{
        id: imageId, kind: 'image', mediaType: 'image/png', sizeBytes: 3,
        width: 1, height: 1,
      }],
    })
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, type: 'analyze_image', promptVersion: 'image-v1' },
      provider: { ...base.provider, supportsVision: true },
    }
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(claim)

    expect(api.attachmentReads).toEqual([imageId])
    expect(api.completed).toHaveLength(1)
    expect(api.completed[0]?.artifactType).toBe('image_analysis')
  })

  it('allows only one format repair and never parses natural-language JSON', async () => {
    const api = new FakeTaskApi()
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([{ type: 'text', text: `Here is JSON: ${JSON.stringify(organizedArtifact)}` }]),
      assistant([{ type: 'text', text: JSON.stringify(organizedArtifact) }]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim())

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_ARTIFACT_SCHEMA_INVALID')
  })

  it.each([
    ['wrong artifact type', (artifact: Record<string, any>) => { artifact.artifactType = 'correctness_review' }],
    ['text artifact without sources', (artifact: Record<string, any>) => {
      artifact.sourceFragmentIds = []
      artifact.blocks[0].sourceFragmentIds = []
      artifact.blocks[0].steps[0].sourceFragmentIds = []
    }],
    ['duplicate block IDs', (artifact: Record<string, any>) => { artifact.blocks.push(structuredClone(artifact.blocks[0])) }],
    ['nested source outside the top-level set', (artifact: Record<string, any>) => {
      artifact.blocks[0].steps[0].sourceFragmentIds = ['00000000-0000-4000-8000-000000000001']
    }],
    ['table row/column mismatch', (artifact: Record<string, any>) => {
      artifact.blocks = [{
        id: 'table', type: 'table', columns: ['a', 'b'], rows: [['only-one']],
        sourceFragmentIds: [fragmentId],
      }]
    }],
    ['case-folded duplicate tags', (artifact: Record<string, any>) => {
      artifact.classification.suggestedTags = ['Go', 'go']
    }],
    ['raw HTML in Markdown', (artifact: Record<string, any>) => {
      artifact.blocks = [{
        id: 'markdown', type: 'markdown', markdown: '<script>alert(1)</script>',
        sourceFragmentIds: [fragmentId],
      }]
    }],
  ])('rejects %s after one bounded repair', async (_name, mutate) => {
    const api = new FakeTaskApi()
    const artifact = structuredClone(organizedArtifact) as Record<string, any>
    mutate(artifact)
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('invalid-one', 'emit_candidate_artifact', { artifact })]),
      assistant([toolCall('invalid-two', 'emit_candidate_artifact', { artifact })]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim())

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_ARTIFACT_SCHEMA_INVALID')
  })

  it('rejects undeclared tools without executing them', async () => {
    const api = new FakeTaskApi()
    const runner = createRunner(api, async () => ({
      message: assistant([toolCall('shell', 'run_shell', { command: 'id' })]), attempts: 1,
    }))

    await runner.run(taskClaim())

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_TOOL_INVALID')
  })

  it('rejects a repeated domain tool call', async () => {
    const api = new FakeTaskApi()
    const runner = createRunner(api, async () => ({
      message: assistant([
        toolCall('context-1', 'get_record_context', {}),
        toolCall('context-2', 'get_record_context', {}),
      ]),
      attempts: 1,
    }))

    await runner.run(taskClaim())

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_TOOL_INVALID')
  })

  it('stops at eight domain tool calls', async () => {
    const api = new FakeTaskApi()
    const related = Array.from({ length: 10 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      title: `related ${index}`,
      summary: `summary ${index}`,
    }))
    const claim = taskClaim({ relatedRecords: related })
    const searches = Array.from({ length: 8 }, (_, index) =>
      toolCall(`search-${index}`, 'search_related_records', { query: `q${index}`, limit: 1 }))
    const messages = [assistant([toolCall('context', 'get_record_context', {})]), assistant(searches)]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(claim)

    expect(api.failures.at(-1)?.code).toBe('AI_TOOL_LIMIT')
  })

  it('stops after four model turns without a candidate', async () => {
    const api = new FakeTaskApi()
    const relatedRecords = [{
      id: '00000000-0000-4000-8000-000000000001',
      title: 'related record',
      summary: 'alpha beta gamma',
    }]
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('search-1', 'search_related_records', { query: 'alpha', limit: 1 })]),
      assistant([toolCall('search-2', 'search_related_records', { query: 'beta', limit: 1 })]),
      assistant([toolCall('search-3', 'search_related_records', { query: 'gamma', limit: 1 })]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim({ relatedRecords }))

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_TURN_LIMIT')
  })

  it('stops at the task deadline between provider and tool boundaries', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: {
        ...base.task,
        limits: { ...base.task.limits, deadlineAt: new Date(Date.now() + 50).toISOString() },
      },
    }
    const runner = createRunner(api, async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80))
      return { message: assistant([toolCall('context', 'get_record_context', {})]), attempts: 1 }
    })

    await runner.run(claim)

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_TASK_DEADLINE_EXCEEDED')
  })

  it('checks cancellation before the first provider request', async () => {
    const api = new FakeTaskApi()
    api.cancelOnHeartbeat = true
    let providerCalls = 0
    const runner = createRunner(api, async () => {
      providerCalls += 1
      return { message: assistant([]), attempts: 1 }
    })

    await runner.run(taskClaim())

    expect(providerCalls).toBe(0)
    expect(api.failures.at(-1)?.code).toBe('AI_TASK_CANCELLED')
  })

  it('makes zero provider requests for a sensitive block claim', async () => {
    const api = new FakeTaskApi()
    let providerCalls = 0
    const runner = createRunner(api, async () => {
      providerCalls += 1
      return { message: assistant([]), attempts: 1 }
    })
    const claim = taskClaim({ sensitivity: 'sensitive', sensitivePolicy: 'block' })

    await runner.run(claim)

    expect(providerCalls).toBe(0)
    expect(api.failures.at(-1)?.code).toBe('AI_SENSITIVE_BLOCKED')
  })

  it.each([
    { policy: 'redact' as const, body: 'password=<PASSWORD_1>', secretVisible: false },
    { policy: 'allow' as const, body: 'password=UltraSecret-2026', secretVisible: true },
  ])('enforces $policy at the real Provider network boundary', async ({ policy, body, secretVisible }) => {
    const api = new FakeTaskApi()
    const network = await startEgressSpy()
    const base = taskClaim({
      sensitivity: 'sensitive',
      sensitivePolicy: policy,
      rawRecords: [{ id: recordId, recordRole: 'primary', contentFormat: 'plain_text', body }],
      fragments: [{ id: fragmentId, rawRecordId: recordId, sourceKind: 'raw_text', ordinal: 0, content: body }],
    })
    const claim: ClaimedTask = {
      ...base,
      provider: { ...base.provider, baseUrl: `${network.baseUrl}/gateway/v1/` },
    }
    const runner = new TaskRunner(
      api,
      new PromptStore(resolve(repositoryRoot, 'apps/ai-worker/prompts')),
      contract,
      true,
    )

    await runner.run(claim)

    expect(api.completed).toHaveLength(1)
    expect(network.bodies).toHaveLength(2)
    const outbound = network.bodies.join('\n')
    expect(outbound.includes('UltraSecret-2026')).toBe(secretVisible)
    if (policy === 'redact') expect(outbound).toContain('<PASSWORD_1>')
  })

  it('keeps sensitive block at zero requests at the real Provider network boundary', async () => {
    const api = new FakeTaskApi()
    const network = await startEgressSpy()
    const base = taskClaim({
      sensitivity: 'sensitive',
      sensitivePolicy: 'block',
      rawRecords: [{ id: recordId, recordRole: 'primary', contentFormat: 'plain_text', body: 'password=BlockedSecret' }],
    })
    const claim: ClaimedTask = {
      ...base,
      provider: { ...base.provider, baseUrl: `${network.baseUrl}/gateway/v1/` },
    }
    const runner = new TaskRunner(
      api,
      new PromptStore(resolve(repositoryRoot, 'apps/ai-worker/prompts')),
      contract,
      true,
    )

    await runner.run(claim)

    expect(network.bodies).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_SENSITIVE_BLOCKED')
  })

  it('uses complete idempotency retry only for a transport failure', async () => {
    const api = new FakeTaskApi()
    api.completeTransportFailures = 1
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('candidate', 'emit_candidate_artifact', { artifact: organizedArtifact })]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim())

    expect(api.completeAttempts).toBe(2)
    expect(api.completed).toHaveLength(1)
    expect(api.failures).toEqual([])
  })
})

class FakeTaskApi implements TaskApi {
  readonly completed: Record<string, unknown>[] = []
  readonly failures: Array<{ code: string; detail: string }> = []
  readonly taskEvents: SafeTaskEvent[] = []
  cancelOnHeartbeat = false
  completeTransportFailures = 0
  completeAttempts = 0
  attachmentBytes: Uint8Array | null = null
  readonly attachmentReads: string[] = []

  async heartbeat(): Promise<{ readonly cancelRequested: boolean }> {
    return { cancelRequested: this.cancelOnHeartbeat }
  }

  async events(_claim: ClaimedTask, events: readonly SafeTaskEvent[]): Promise<void> {
    const allowedDetailKeys = new Set([
      'turn', 'tool', 'durationMs', 'inputTokens', 'outputTokens',
      'attempt', 'failureCategory', 'toolCalls',
    ])
    if (events.some((event) => Object.keys(event.details).some((key) => !allowedDetailKeys.has(key)))) {
      throw new TaskClientError(422, 'VALIDATION_FAILED')
    }
    this.taskEvents.push(...events)
  }

  async attachment(_claim: ClaimedTask, attachment: ClaimedTask['input']['attachments'][number]): Promise<Uint8Array> {
    if (this.attachmentBytes === null) throw new Error('unexpected attachment read')
    this.attachmentReads.push(attachment.id)
    return this.attachmentBytes
  }

  async complete(_claim: ClaimedTask, artifact: Record<string, unknown>): Promise<unknown> {
    this.completeAttempts += 1
    if (this.completeTransportFailures > 0) {
      this.completeTransportFailures -= 1
      throw new TaskClientError(0, 'API_UNAVAILABLE')
    }
    this.completed.push(artifact)
    return { id: 'artifact' }
  }

  async fail(_claim: ClaimedTask, code: string, detail: string): Promise<void> {
    this.failures.push({ code, detail })
  }
}

function createRunner(api: TaskApi, providerTurn: ConstructorParameters<typeof TaskRunner>[4]): TaskRunner {
  return new TaskRunner(
    api,
    new PromptStore(resolve(repositoryRoot, 'apps/ai-worker/prompts')),
    contract,
    true,
    providerTurn,
  )
}

function taskClaim(overrides: Partial<ClaimedTask['input']> = {}): ClaimedTask {
  return {
    task: {
      id: '79191f32-e265-4f0f-aa13-6ba279491583',
      type: 'organize_record',
      leaseVersion: 1,
      promptVersion: 'organize-v1',
      schemaVersion: '1.0',
      limits: { maxTurns: 4, maxToolCalls: 8, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    },
    input: {
      itemId: '99807597-3f7b-4d19-a0f7-c33be4b2b80d',
      sensitivity: 'normal',
      sensitivePolicy: 'block',
      rawRecords: [{ id: recordId, recordRole: 'primary', contentFormat: 'plain_text', body: 'lsblk' }],
      fragments: [{ id: fragmentId, rawRecordId: recordId, sourceKind: 'raw_text', ordinal: 0, content: 'lsblk' }],
      attachments: [],
      relatedRecords: [],
      ...overrides,
    },
    provider: {
      protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key',
      modelId: 'test-model', modelName: 'Test', contextWindow: 8192, maxOutputTokens: 1024,
      supportsTools: true, supportsVision: false,
    },
  }
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'dev-toolbox-custom',
    model: 'test-model', usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  }
}

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown>): ToolCall {
  return { type: 'toolCall', id, name, arguments: argumentsValue }
}

function organizedDraft(): Record<string, unknown> {
  return {
    title: 'Linux 新磁盘挂载',
    summary: '记录新磁盘分区、格式化与挂载步骤。',
    classification: {
      contentType: 'operations_guide',
      suggestedFolderPath: ['服务器运维', '磁盘'],
      suggestedTags: ['Linux', 'ext4'],
      sensitivitySuggestion: 'normal',
    },
    blocks: [{
      type: 'command_steps',
      title: '挂载步骤',
      steps: [{
        title: '查看磁盘',
        commands: [{ shell: 'bash', command: 'lsblk' }],
        sourceRefs: ['S1'],
      }],
      sourceRefs: ['S1'],
    }],
    warnings: [],
    limitations: ['模型没有连接目标服务器验证命令。'],
  }
}

async function startEgressSpy(): Promise<{ baseUrl: string; bodies: string[] }> {
  const bodies: string[] = []
  const server = createServer(async (request, response) => {
    bodies.push(await readRequestBody(request))
    const turn = bodies.length
    if (turn === 1) {
      respondOpenAITool(response, 'get_record_context', {})
      return
    }
    respondOpenAITool(response, 'emit_candidate_artifact', { artifact: organizedArtifact })
  })
  egressServers.push(server)
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('egress spy failed to bind')
  return { baseUrl: `http://127.0.0.1:${address.port}`, bodies }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function respondOpenAITool(
  response: ServerResponse,
  name: string,
  argumentsValue: Record<string, unknown>,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl_sensitive',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: `call_${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(argumentsValue) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl_sensitive',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

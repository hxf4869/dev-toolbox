import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'

import type { ArtifactContract } from './artifact-schema.js'
import type { ClaimedTask } from './task-client.js'

const blockTypes = [
  'markdown',
  'code',
  'command',
  'command_steps',
  'key_value',
  'table',
  'checklist',
  'callout',
  'image_reference',
  'attachment_reference',
] as const

const shellTypes = ['bash', 'sh', 'zsh', 'powershell', 'cmd', 'sql', 'docker', 'yaml', 'text', 'other'] as const

const sourceRefsSchema = {
  type: 'array',
  maxItems: 100,
  uniqueItems: true,
  items: { type: 'string', pattern: '^S[1-9][0-9]*$' },
} as const

const shortTextSchema = { type: 'string', minLength: 1, maxLength: 200 } as const

/**
 * Deliberately uses a flat, draft-07-compatible subset: no $ref, oneOf, allOf,
 * if/then, const, or formats. Several OpenAI-compatible gateways only support
 * this common subset for function parameters.
 */
export const artifactDraftSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'classification', 'blocks', 'warnings', 'limitations'],
  properties: {
    title: shortTextSchema,
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    classification: {
      type: 'object',
      additionalProperties: false,
      required: ['contentType', 'suggestedFolderPath', 'suggestedTags', 'sensitivitySuggestion'],
      properties: {
        contentType: {
          type: 'string',
          enum: [
            'operations_guide', 'command_snippet', 'credential_related', 'deployment', 'database',
            'development', 'reference', 'image', 'file', 'mixed', 'other',
          ],
        },
        suggestedFolderPath: {
          type: 'array', maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 80 },
        },
        suggestedTags: {
          type: 'array', maxItems: 12, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 40 },
        },
        sensitivitySuggestion: { type: 'string', enum: ['normal', 'sensitive', 'unknown'] },
        sensitivityReason: { type: 'string', maxLength: 500 },
      },
    },
    blocks: {
      type: 'array', minItems: 1, maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'sourceRefs'],
        properties: {
          type: { type: 'string', enum: blockTypes },
          sourceRefs: sourceRefsSchema,
          title: shortTextSchema,
          markdown: { type: 'string', minLength: 1, maxLength: 20000 },
          language: { type: 'string', maxLength: 40 },
          code: { type: 'string', minLength: 1, maxLength: 50000 },
          caption: { type: 'string', maxLength: 1000 },
          wrapByDefault: { type: 'boolean' },
          shell: { type: 'string', enum: shellTypes },
          command: { type: 'string', minLength: 1, maxLength: 20000 },
          description: { type: 'string', maxLength: 1000 },
          steps: {
            type: 'array', minItems: 1, maxItems: 30,
            items: {
              type: 'object', additionalProperties: false,
              required: ['title', 'commands', 'sourceRefs'],
              properties: {
                title: shortTextSchema,
                instruction: { type: 'string', maxLength: 2000 },
                commands: {
                  type: 'array', maxItems: 12,
                  items: {
                    type: 'object', additionalProperties: false, required: ['shell', 'command'],
                    properties: {
                      shell: { type: 'string', enum: shellTypes },
                      command: { type: 'string', minLength: 1, maxLength: 20000 },
                      description: { type: 'string', maxLength: 1000 },
                    },
                  },
                },
                notes: {
                  type: 'array', maxItems: 10,
                  items: { type: 'string', maxLength: 1000 },
                },
                sourceRefs: sourceRefsSchema,
              },
            },
          },
          entries: {
            type: 'array', minItems: 1, maxItems: 50,
            items: {
              type: 'object', additionalProperties: false, required: ['key', 'value', 'sensitive'],
              properties: {
                key: { type: 'string', minLength: 1, maxLength: 120 },
                value: { type: 'string', maxLength: 4000 },
                sensitive: { type: 'boolean' },
              },
            },
          },
          columns: {
            type: 'array', minItems: 1, maxItems: 12,
            items: { type: 'string', minLength: 1, maxLength: 120 },
          },
          rows: {
            type: 'array', maxItems: 100,
            items: {
              type: 'array', maxItems: 12,
              items: { type: 'string', maxLength: 2000 },
            },
          },
          items: {
            type: 'array', minItems: 1, maxItems: 50,
            items: {
              type: 'object', additionalProperties: false, required: ['label', 'sourceRefs'],
              properties: {
                label: { type: 'string', minLength: 1, maxLength: 1000 },
                sourceRefs: sourceRefsSchema,
              },
            },
          },
          tone: { type: 'string', enum: ['info', 'tip', 'warning', 'danger'] },
          body: { type: 'string', minLength: 1, maxLength: 4000 },
          attachmentRef: { type: 'string', pattern: '^A[1-9][0-9]*$' },
          extractedText: { type: 'string', maxLength: 10000 },
        },
      },
    },
    warnings: {
      type: 'array', maxItems: 50,
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'title', 'message', 'basis', 'sourceRefs'],
        properties: {
          severity: { type: 'string', enum: ['info', 'warning', 'danger'] },
          title: shortTextSchema,
          message: { type: 'string', minLength: 1, maxLength: 4000 },
          basis: { type: 'string', enum: ['source_evidence', 'model_knowledge'] },
          sourceRefs: sourceRefsSchema,
          recommendation: { type: 'string', maxLength: 4000 },
        },
      },
    },
    limitations: {
      type: 'array', minItems: 1, maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  },
}

export interface ModelTaskContext {
  readonly records: readonly Record<string, unknown>[]
  readonly sources: readonly Record<string, unknown>[]
  readonly attachments: readonly Record<string, unknown>[]
  readonly relatedRecords: readonly Record<string, unknown>[]
}

export interface DraftMaterialization {
  readonly artifact?: Record<string, unknown>
  readonly error?: string
}

const draftValidator = createDraftValidator()

export function createModelTaskContext(claim: ClaimedTask): ModelTaskContext {
  const recordRefs = new Map(claim.input.rawRecords.map((record, index) => [record.id, `R${index + 1}`]))
  return {
    records: claim.input.rawRecords.map((record, index) => ({
      ref: `R${index + 1}`,
      role: record.recordRole,
      format: record.contentFormat,
      body: record.body,
    })),
    sources: claim.input.fragments.map((fragment, index) => ({
      ref: `S${index + 1}`,
      recordRef: recordRefs.get(fragment.rawRecordId) ?? null,
      kind: fragment.sourceKind,
      ordinal: fragment.ordinal,
      content: fragment.content,
    })),
    attachments: claim.input.attachments.map((attachment, index) => ({
      ref: `A${index + 1}`,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      width: attachment.width,
      height: attachment.height,
    })),
    relatedRecords: claim.input.relatedRecords.map((record) => ({
      title: record.title,
      summary: record.summary,
    })),
  }
}

export function materializeArtifactDraft(
  draft: unknown,
  claim: ClaimedTask,
  contract: ArtifactContract,
  readAttachmentIds: ReadonlySet<string>,
): DraftMaterialization {
  if (!draftValidator(draft)) return { error: formatDraftErrors(draftValidator.errors) }
  const value = draft as Record<string, unknown>
  const sourceMap = new Map(claim.input.fragments.map((fragment, index) => [`S${index + 1}`, fragment.id]))
  const attachmentMap = new Map(claim.input.attachments.map((attachment, index) => [`A${index + 1}`, attachment]))
  const usedSources = new Set<string>()

  try {
    const blocks = (value.blocks as Record<string, unknown>[]).map((block, index) =>
      materializeBlock(block, index, sourceMap, attachmentMap, usedSources))
    const warnings = (value.warnings as Record<string, unknown>[]).map((warning, index) => {
      const sourceFragmentIds = resolveSourceRefs(
        warning.sourceRefs,
        `/warnings/${index}/sourceRefs`,
        sourceMap,
        usedSources,
      )
      if (warning.basis === 'source_evidence' && sourceFragmentIds.length === 0) {
        throw new DraftError(`/warnings/${index}/sourceRefs 在 basis=source_evidence 时不能为空`)
      }
      return definedObject({
        severity: warning.severity,
        title: warning.title,
        message: warning.message,
        basis: warning.basis,
        sourceFragmentIds,
        recommendation: warning.recommendation,
      })
    })
    if (claim.task.type !== 'analyze_image' && usedSources.size === 0) {
      throw new DraftError('文本任务至少要在 block 或 warning 中引用一个 S# 来源')
    }
    const artifact: Record<string, unknown> = {
      schemaVersion: claim.task.schemaVersion,
      artifactType: artifactTypeFor(claim.task.type),
      title: value.title,
      summary: value.summary,
      classification: value.classification,
      blocks,
      warnings,
      sourceFragmentIds: [...usedSources],
      review: { status: 'model_reviewed', limitations: value.limitations },
    }
    const semanticError = validateMaterializedArtifact(contract, artifact, claim, readAttachmentIds)
    return semanticError === null ? { artifact } : { error: semanticError }
  } catch (error) {
    return { error: error instanceof DraftError ? error.message : 'Draft 转换失败' }
  }
}

function materializeBlock(
  block: Record<string, unknown>,
  index: number,
  sourceMap: ReadonlyMap<string, string>,
  attachmentMap: ReadonlyMap<string, ClaimedTask['input']['attachments'][number]>,
  usedSources: Set<string>,
): Record<string, unknown> {
  const path = `/blocks/${index}`
  const sourceFragmentIds = resolveSourceRefs(block.sourceRefs, `${path}/sourceRefs`, sourceMap, usedSources)
  const base = { id: `block_${index + 1}`, type: block.type, sourceFragmentIds }
  switch (block.type) {
    case 'markdown':
      requireDraftFields(block, path, ['markdown'])
      return { ...base, markdown: block.markdown }
    case 'code':
      requireDraftFields(block, path, ['language', 'code'])
      return definedObject({ ...base, language: block.language, code: block.code, caption: block.caption, wrapByDefault: block.wrapByDefault })
    case 'command':
      requireDraftFields(block, path, ['shell', 'command'])
      return definedObject({ ...base, shell: block.shell, command: block.command, description: block.description })
    case 'command_steps': {
      requireDraftFields(block, path, ['title', 'steps'])
      const steps = (block.steps as Record<string, unknown>[]).map((step, stepIndex) => definedObject({
        title: step.title,
        instruction: step.instruction,
        commands: step.commands,
        notes: step.notes,
        sourceFragmentIds: resolveSourceRefs(
          step.sourceRefs,
          `${path}/steps/${stepIndex}/sourceRefs`,
          sourceMap,
          usedSources,
        ),
      }))
      return { ...base, title: block.title, steps }
    }
    case 'key_value':
      requireDraftFields(block, path, ['entries'])
      return definedObject({ ...base, title: block.title, entries: block.entries })
    case 'table':
      requireDraftFields(block, path, ['columns', 'rows'])
      return definedObject({ ...base, title: block.title, columns: block.columns, rows: block.rows })
    case 'checklist': {
      requireDraftFields(block, path, ['title', 'items'])
      const items = (block.items as Record<string, unknown>[]).map((item, itemIndex) => ({
        label: item.label,
        sourceFragmentIds: resolveSourceRefs(
          item.sourceRefs,
          `${path}/items/${itemIndex}/sourceRefs`,
          sourceMap,
          usedSources,
        ),
      }))
      return { ...base, title: block.title, items }
    }
    case 'callout':
      requireDraftFields(block, path, ['tone', 'body'])
      return definedObject({ ...base, tone: block.tone, title: block.title, body: block.body })
    case 'image_reference': {
      requireDraftFields(block, path, ['attachmentRef'])
      const attachment = resolveAttachment(block.attachmentRef, `${path}/attachmentRef`, attachmentMap, 'image')
      return definedObject({
        ...base,
        attachmentId: attachment.id,
        caption: block.caption,
        extractedText: block.extractedText,
      })
    }
    case 'attachment_reference': {
      requireDraftFields(block, path, ['attachmentRef'])
      const attachment = resolveAttachment(block.attachmentRef, `${path}/attachmentRef`, attachmentMap, 'file')
      return definedObject({ ...base, attachmentId: attachment.id, caption: block.caption })
    }
    default:
      throw new DraftError(`${path}/type 不受支持`)
  }
}

function validateMaterializedArtifact(
  contract: ArtifactContract,
  artifact: Record<string, unknown>,
  claim: ClaimedTask,
  readAttachmentIds: ReadonlySet<string>,
): string | null {
  let encoded: string
  try {
    encoded = JSON.stringify(artifact)
  } catch {
    return 'Draft 无法序列化为 JSON'
  }
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) return 'Draft 转换结果超过 2 MiB'
  if (!contract.validate(artifact)) return `Draft 字段不符合结果契约：${formatFinalErrors(contract.validate.errors)}`

  const blocks = artifact.blocks as Record<string, unknown>[]
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    if (block.type === 'markdown' && typeof block.markdown === 'string' && containsRawHtml(block.markdown)) {
      return `/blocks/${index}/markdown 不允许包含 HTML`
    }
    if (block.type === 'table') {
      const columns = block.columns as unknown[]
      const rows = block.rows as unknown[][]
      if (rows.some((row) => row.length !== columns.length)) return `/blocks/${index}/rows 每行列数必须与 columns 一致`
    }
  }
  const classification = artifact.classification as Record<string, unknown>
  if (!caseFoldedUnique(classification.suggestedTags)) return '/classification/suggestedTags 去重后仍有重复或空标签'
  if (claim.task.type === 'analyze_image') {
    const authorizedImages = claim.input.attachments.filter((entry) => entry.kind === 'image').map((entry) => entry.id)
    const referencedImages = new Set(
      blocks.filter((block) => block.type === 'image_reference').map((block) => block.attachmentId as string),
    )
    if (
      readAttachmentIds.size !== authorizedImages.length ||
      referencedImages.size !== authorizedImages.length ||
      authorizedImages.some((id) => !readAttachmentIds.has(id) || !referencedImages.has(id))
    ) {
      return '图片分析必须读取并各引用一次所有 A# 图片'
    }
  }
  return null
}

function resolveSourceRefs(
  raw: unknown,
  path: string,
  sourceMap: ReadonlyMap<string, string>,
  usedSources: Set<string>,
): string[] {
  const result: string[] = []
  for (const ref of raw as string[]) {
    const id = sourceMap.get(ref)
    if (id === undefined) throw new DraftError(`${path} 包含当前上下文不存在的 ${ref}`)
    result.push(id)
    usedSources.add(id)
  }
  return result
}

function resolveAttachment(
  raw: unknown,
  path: string,
  attachmentMap: ReadonlyMap<string, ClaimedTask['input']['attachments'][number]>,
  expectedKind: 'image' | 'file',
): ClaimedTask['input']['attachments'][number] {
  const attachment = attachmentMap.get(raw as string)
  if (attachment === undefined) throw new DraftError(`${path} 引用了当前上下文不存在的 ${String(raw)}`)
  if (attachment.kind !== expectedKind) throw new DraftError(`${path} 必须引用 ${expectedKind === 'image' ? '图片' : '文件'}附件`)
  return attachment
}

function requireDraftFields(value: Record<string, unknown>, path: string, fields: readonly string[]): void {
  const missing = fields.filter((field) => value[field] === undefined)
  if (missing.length > 0) throw new DraftError(`${path} 在 type=${String(value.type)} 时缺少 ${missing.join(', ')}`)
}

function formatDraftErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'Draft 不是合法对象'
  return `Draft JSON 不符合简化契约：${errors.slice(0, 6).map(formatAjvError).join('；')}`
}

function formatFinalErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return '未知字段错误'
  return errors.slice(0, 4).map(formatAjvError).join('；')
}

function formatAjvError(error: ErrorObject): string {
  const path = error.instancePath || '/'
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') {
    return `${path} 缺少 ${error.params.missingProperty}`
  }
  if (error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string') {
    return `${path} 不允许字段 ${error.params.additionalProperty}`
  }
  return `${path} ${error.message ?? error.keyword}`
}

function createDraftValidator(): ValidateFunction<unknown> {
  return new Ajv2020({ allErrors: true, strict: true }).compile(artifactDraftSchema)
}

function definedObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function artifactTypeFor(taskType: ClaimedTask['task']['type']): string {
  if (taskType === 'organize_record') return 'organized_record'
  if (taskType === 'review_record') return 'correctness_review'
  return 'image_analysis'
}

function caseFoldedUnique(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') return false
    const normalized = entry.trim().toLocaleLowerCase()
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
  }
  return true
}

function containsRawHtml(value: string): boolean {
  return /<(?:\/?[A-Za-z][^>]*|!--|!doctype\b|\?xml\b)[^>]*>/iu.test(value)
}

class DraftError extends Error {}

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

const blockTypeAliases: Readonly<Record<string, typeof blockTypes[number]>> = {
  text: 'markdown',
  paragraph: 'markdown',
  section: 'markdown',
  markdown_block: 'markdown',
  code_block: 'code',
  shell_command: 'command',
  command_step: 'command_steps',
  steps: 'command_steps',
  step_list: 'command_steps',
  keyvalue: 'key_value',
  key_value_list: 'key_value',
  bullet_list: 'checklist',
  task_list: 'checklist',
  notice: 'callout',
  note: 'callout',
  image: 'image_reference',
  file: 'attachment_reference',
  attachment: 'attachment_reference',
}

const allowedBlockTypes = new Set<string>(blockTypes)
const allowedDraftFields = new Set([
  'title', 'summary', 'classification', 'blocks', 'warnings', 'limitations',
])
const warningRepairFields = new Set([
  'severity', 'message', 'basis', 'sourceRefs', 'recommendation',
  'error', 'recommend', 'sourceTRefs', 'sourceRef', 'reference', 'module',
])
const classificationFields = [
  'contentType', 'suggestedFolderPath', 'suggestedTags', 'sensitivitySuggestion', 'sensitivityReason',
] as const
const maximumArtifactSourceRefs = 100
const missingLimitationsFallback = '模型未明确给出局限，请人工核对原文与目标环境。'
const sourceLimitLimitation = '来源引用超过结果契约上限，当前版本仅保留前 100 个唯一来源片段的引用。'
const sourceRefPattern = /^S[1-9][0-9]*$/u
const compositeSourceRefsPattern = /^S[1-9][0-9]*(?:\s*[,，、;/|]\s*S[1-9][0-9]*)+$/u
const limitationKeyPattern = /(?:未|尚未|无法|不能|不可|仅供|仅作|需要|需).{0,120}(?:验证|核验|确认|检查|执行|使用|参考|归档)|(?:局限|限制|风险|注意)/u

/**
 * Normalizes only bounded, representation-equivalent model variations. The
 * strict Draft and final Artifact validators remain authoritative, and this
 * function never creates a source reference that the model did not provide at
 * the same block, parent, or child level.
 */
export function normalizeArtifactDraft(raw: unknown): unknown {
  const value = unwrapDraftEnvelope(raw)
  if (!isRecord(value)) return value

  const normalized: Record<string, unknown> = { ...value }
  const rawBlocks = Array.isArray(normalized.blocks) ? normalized.blocks : undefined
  const classification: Record<string, unknown> = isRecord(normalized.classification)
    ? { ...normalized.classification }
    : {}
  for (const rawBlock of rawBlocks ?? []) {
    if (!isRecord(rawBlock)) continue
    if (isRecord(rawBlock.classification)) {
      for (const field of classificationFields) {
        if (classification[field] === undefined && rawBlock.classification[field] !== undefined) {
          classification[field] = rawBlock.classification[field]
        }
      }
    }
    for (const field of classificationFields) {
      if (classification[field] === undefined && rawBlock[field] !== undefined) {
        classification[field] = rawBlock[field]
      }
    }
  }
  if (Object.keys(classification).length > 0) {
    if (typeof classification.suggestedFolderPath === 'string') {
      classification.suggestedFolderPath = [classification.suggestedFolderPath]
    }
    if (typeof classification.suggestedTags === 'string') {
      classification.suggestedTags = [classification.suggestedTags]
    }
    normalized.classification = classification
  }
  const rootKeyLimitations = extractRootKeyLimitations(normalized)
  const blockNormalizationLimitations: string[] = []
  if (rawBlocks !== undefined) {
    normalized.blocks = rawBlocks
      .map((block, index) => isClassificationWrapperBlock(block)
        ? undefined
        : normalizeBlock(block, index, blockNormalizationLimitations))
      .filter((block) => block !== undefined)
  }
  const misplacedLimitations = [
    ...rootKeyLimitations,
    ...(rawBlocks ?? []).flatMap((block) => {
      if (!isRecord(block)) return []
      return [
        ...(readLimitations(block.limitations) ?? []),
        ...(readLimitations(block.columns_note) ?? []),
        ...readMisplacedWarnings(block.warnings),
      ]
    }),
    ...(Array.isArray(normalized.warnings)
      ? normalized.warnings.flatMap(
        (warning) => isRecord(warning) ? readLimitations(warning.limitations) ?? [] : [],
      )
      : []),
    ...blockNormalizationLimitations,
  ]
  if (Array.isArray(normalized.warnings)) {
    normalized.warnings = normalized.warnings.map(normalizeWarning)
  } else if (normalized.warnings === undefined) {
    normalized.warnings = []
  }
  const limitations = readLimitations(normalized.limitations)
  if (limitations !== undefined) {
    const combined = [...new Set([...limitations, ...misplacedLimitations])]
    normalized.limitations = combined.length > 0 ? combined.slice(0, 20) : [missingLimitationsFallback]
  } else if (normalized.limitations === undefined) {
    normalized.limitations = misplacedLimitations.length > 0
      ? misplacedLimitations.slice(0, 20)
      : [missingLimitationsFallback]
  }
  return normalized
}

/**
 * Models sometimes answer a concrete repair request with only the corrected
 * top-level fields. Merge that patch over the immediately preceding Draft;
 * arrays still replace as a whole, and the strict validators remain the final
 * authority.
 */
export function mergeArtifactDraftRepair(previous: unknown, repair: unknown): unknown {
  const base = normalizeArtifactDraft(previous)
  const patch = unwrapDraftEnvelope(repair)
  if (!isRecord(base) || !isRecord(patch)) return normalizeArtifactDraft(repair)

  const warningRepair = mergeUniqueInvalidWarning(base, patch)
  const merged: Record<string, unknown> = warningRepair ?? { ...base, ...patch }
  if (isRecord(base.classification) && isRecord(patch.classification)) {
    merged.classification = { ...base.classification, ...patch.classification }
  }
  return normalizeArtifactDraft(merged)
}

function mergeUniqueInvalidWarning(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const patchKeys = Object.keys(patch)
  if (patchKeys.length === 0 || patchKeys.some((key) => !warningRepairFields.has(key))) return undefined
  draftValidator(base)
  const invalidIndices = new Set<number>()
  for (const error of draftValidator.errors ?? []) {
    const match = /^\/warnings\/([0-9]+)(?:\/|$)/u.exec(error.instancePath)
    if (match !== null) invalidIndices.add(Number(match[1]))
  }
  if (invalidIndices.size !== 1 || !Array.isArray(base.warnings)) return undefined
  const index = [...invalidIndices][0]!
  const previousWarning = base.warnings[index]
  if (!isRecord(previousWarning)) return undefined
  const warnings = [...base.warnings]
  warnings[index] = { ...previousWarning, ...patch }
  return { ...base, warnings }
}

function unwrapDraftEnvelope(raw: unknown): unknown {
  let value = raw
  for (let depth = 0; depth < 2; depth += 1) {
    if (!isRecord(value)) return value
    const keys = Object.keys(value)
    if (keys.length !== 1 || (keys[0] !== 'draft' && keys[0] !== 'artifact')) break
    const nested = value[keys[0]!]
    if (!isRecord(nested)) break
    value = nested
  }
  return value
}

function normalizeBlock(raw: unknown, index: number, limitations: string[]): unknown {
  if (!isRecord(raw)) return raw
  const block: Record<string, unknown> = { ...raw }
  flattenCommandSteps(block)
  flattenBlockCall(block)
  flattenTopLevelCommands(block)
  if (
    block.language === undefined && typeof block.class === 'string' &&
    (block.type === 'code' || typeof block.code === 'string')
  ) {
    block.language = block.class
  }
  delete block.classification
  delete block.class
  delete block.columns_note
  delete block.limitations
  delete block.warnings
  for (const field of classificationFields) delete block[field]
  normalizeSourceRefs(block)
  const type = normalizeBlockType(block)
  if (type !== undefined) block.type = type

  switch (block.type) {
    case 'markdown':
      moveStringAlias(block, 'markdown', ['content', 'text', 'body', 'summary'])
      if (typeof block.markdown === 'string' && containsRawHtml(block.markdown)) {
        block.markdown = block.markdown.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      }
      break
    case 'code':
      normalizeBashBodyAlias(block, 'code')
      moveStringAlias(block, 'code', ['content', 'text'])
      moveStringAlias(block, 'caption', ['summary'])
      if (block.language === undefined) block.language = 'text'
      break
    case 'command':
      normalizeBashBodyAlias(block, 'command')
      moveStringAlias(block, 'command', ['content', 'text'])
      moveStringAlias(block, 'description', ['summary'])
      if (block.shell === undefined) block.shell = 'other'
      break
    case 'command_steps':
      normalizeCommandSteps(block)
      break
    case 'table':
      normalizeTable(block)
      break
    case 'checklist':
      normalizeChecklist(block)
      break
    case 'callout':
      moveStringAlias(block, 'body', ['content', 'text', 'message', 'summary'])
      break
    case 'image_reference':
      moveStringAlias(block, 'caption', ['summary'])
      break
  }
  moveShortSummaryToTitle(block)
  delete block.summary
  if (block.sourceRefs === undefined) block.sourceRefs = []
  if (block.type === 'code' && (typeof block.code !== 'string' || !block.code.trim())) {
    const allowedKeys = new Set([
      'type', 'sourceRefs', 'title', 'language', 'code', 'caption', 'wrapByDefault',
    ])
    if (Object.keys(block).some((key) => !allowedKeys.has(key))) return block
    const fallback = [block.caption, block.title].find(
      (value): value is string => typeof value === 'string' && Boolean(value.trim()),
    )
    if (fallback !== undefined) {
      const limitation = `模型第 ${index + 1} 个 code block 未提供代码正文，当前版本已忽略该 block；原说明：${fallback}`
      if (limitation.length > 1000) return block
      limitations.push(limitation)
      return undefined
    }
    limitations.push(`模型第 ${index + 1} 个 code block 未提供代码正文或说明，当前版本已忽略该空 block。`)
    return undefined
  }
  return block
}

function flattenCommandSteps(block: Record<string, unknown>): void {
  const nested = block.command_steps
  if (Array.isArray(nested)) {
    if (block.steps === undefined) block.steps = nested
  } else if (isRecord(nested)) {
    for (const key of ['title', 'steps', 'sourceRefs'] as const) {
      if (block[key] === undefined && nested[key] !== undefined) block[key] = nested[key]
    }
  } else if (nested !== undefined) {
    return
  }
  delete block.command_steps
}

function flattenBlockCall(block: Record<string, unknown>): void {
  const nested = block.call
  if (block.command === undefined && (block.type === undefined || block.type === 'command')) {
    if (typeof nested === 'string') {
      block.command = nested
    } else if (isRecord(nested)) {
      for (const key of ['shell', 'command', 'description', 'content', 'text', 'sourceRefs'] as const) {
        if (block[key] === undefined && nested[key] !== undefined) block[key] = nested[key]
      }
    }
  }
  delete block.call
}

function flattenTopLevelCommands(block: Record<string, unknown>): void {
  if (
    block.steps !== undefined || !Array.isArray(block.commands) ||
    typeof block.title !== 'string' || !block.title.trim() ||
    (block.type !== undefined && block.type !== 'command_steps')
  ) {
    return
  }
  const step: Record<string, unknown> = {
    title: block.title,
    commands: block.commands,
    sourceRefs: block.sourceRefs,
  }
  if (block.instruction !== undefined) step.instruction = block.instruction
  if (block.notes !== undefined) step.notes = block.notes
  block.type = 'command_steps'
  block.steps = [step]
  delete block.commands
  delete block.instruction
  delete block.notes
}

function normalizeBashBodyAlias(block: Record<string, unknown>, type: 'code' | 'command'): void {
  if (typeof block.bash !== 'string' || !block.bash.trim()) return
  const target = type === 'code' ? 'code' : 'command'
  const discriminator = type === 'code' ? 'language' : 'shell'
  if (
    (typeof block[target] === 'string' && block[target] !== block.bash) ||
    (block[target] !== undefined && typeof block[target] !== 'string') ||
    (block[discriminator] !== undefined && block[discriminator] !== 'bash') ||
    ['content', 'text'].some((key) => block[key] !== undefined && block[key] !== block.bash)
  ) {
    return
  }
  block[target] = block.bash
  if (block[discriminator] === undefined) block[discriminator] = 'bash'
  delete block.bash
}

function isClassificationWrapperBlock(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  if (isRecord(raw.classification)) {
    return Object.keys(raw).every((key) => key === 'classification' || key === 'sourceRefs')
  }
  const keys = Object.keys(raw)
  return classificationFields.some((field) => raw[field] !== undefined) &&
    keys.every((key) => key === 'sourceRefs' || classificationFields.some((field) => field === key))
}

function normalizeBlockType(block: Readonly<Record<string, unknown>>): typeof blockTypes[number] | undefined {
  const rawType = typeof block.type === 'string' ? block.type.trim() : ''
  if (allowedBlockTypes.has(rawType)) return rawType as typeof blockTypes[number]
  const alias = blockTypeAliases[rawType.toLocaleLowerCase().replace(/[\s-]+/gu, '_')]
  if (alias !== undefined) return alias
  if (Array.isArray(block.steps)) return 'command_steps'
  if (Array.isArray(block.entries)) return 'key_value'
  if (Array.isArray(block.columns) && Array.isArray(block.rows)) return 'table'
  if (isRecord(block.table) && Array.isArray(block.table.columns) && Array.isArray(block.table.rows)) return 'table'
  if (Array.isArray(block.items)) return 'checklist'
  if (typeof block.command === 'string') return 'command'
  if (typeof block.code === 'string') return 'code'
  if (typeof block.markdown === 'string' || typeof block.content === 'string' || typeof block.text === 'string') {
    return 'markdown'
  }
  if (typeof block.tone === 'string' && (typeof block.body === 'string' || typeof block.message === 'string')) {
    return 'callout'
  }
  return undefined
}

function normalizeCommandSteps(block: Record<string, unknown>): void {
  if (!Array.isArray(block.steps)) return
  const parentRefs = readSourceRefs(block.sourceRefs)
  const childRefs: string[] = []
  const steps = block.steps.map((rawStep) => {
    if (!isRecord(rawStep)) return rawStep
    const step: Record<string, unknown> = { ...rawStep }
    if (step.instruction === undefined) {
      if (typeof step.instructions === 'string') {
        step.instruction = step.instructions
      } else if (Array.isArray(step.instructions) && step.instructions.every((entry) => typeof entry === 'string')) {
        step.instruction = step.instructions.join('\n')
      }
    }
    delete step.instructions
    let stepRefs = normalizeSourceRefs(step) ?? []
    if (Array.isArray(step.commands)) {
      const commandRefs: string[] = []
      step.commands = step.commands.map((rawCommand) => {
        if (!isRecord(rawCommand)) return rawCommand
        const command: Record<string, unknown> = { ...rawCommand }
        flattenCommandWrapper(command)
        commandRefs.push(...(normalizeSourceRefs(command) ?? []))
        delete command.sourceRefs
        if (command.type === 'command') delete command.type
        moveStringAlias(command, 'command', ['content', 'text'])
        if (command.shell === undefined) command.shell = 'other'
        return command
      })
      stepRefs = uniqueRefs([...stepRefs, ...commandRefs])
    }
    if (stepRefs.length === 0 && parentRefs.length > 0) stepRefs = parentRefs
    if (step.sourceRefs === undefined || stepRefs.length > 0) step.sourceRefs = stepRefs
    childRefs.push(...stepRefs)
    return step
  })
  block.steps = steps
  if (parentRefs.length === 0) {
    const derived = uniqueRefs(childRefs)
    if (derived.length > 0) block.sourceRefs = derived
  }
  if (typeof block.title !== 'string' || !block.title.trim()) {
    const firstTitledStep = steps.find((step) =>
      isRecord(step) && typeof step.title === 'string' && step.title.trim())
    if (isRecord(firstTitledStep)) block.title = firstTitledStep.title
  }
}

function flattenCommandWrapper(command: Record<string, unknown>): void {
  const nested = command.wrapper
  if (typeof nested === 'string') {
    if (command.command === undefined) command.command = nested
  } else if (isRecord(nested)) {
    for (const key of ['shell', 'command', 'description', 'content', 'text', 'sourceRefs'] as const) {
      if (command[key] === undefined && nested[key] !== undefined) command[key] = nested[key]
    }
  } else if (nested !== undefined) {
    return
  }
  delete command.wrapper
}

function normalizeTable(block: Record<string, unknown>): void {
  if (!isRecord(block.table)) return
  for (const key of ['title', 'columns', 'rows'] as const) {
    if (block[key] === undefined && block.table[key] !== undefined) block[key] = block.table[key]
  }
  delete block.table
}

function normalizeChecklist(block: Record<string, unknown>): void {
  if (!Array.isArray(block.items)) return
  const parentRefs = readSourceRefs(block.sourceRefs)
  const childRefs: string[] = []
  block.items = block.items.map((rawItem) => {
    if (!isRecord(rawItem)) return rawItem
    const item: Record<string, unknown> = { ...rawItem }
    let refs = normalizeSourceRefs(item) ?? []
    if (refs.length === 0 && parentRefs.length > 0) refs = parentRefs
    if (item.sourceRefs === undefined || refs.length > 0) item.sourceRefs = refs
    childRefs.push(...refs)
    return item
  })
  if (parentRefs.length === 0) {
    const derived = uniqueRefs(childRefs)
    if (derived.length > 0) block.sourceRefs = derived
  }
}

function normalizeWarning(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const warning: Record<string, unknown> = { ...raw }
  delete warning.limitations
  const refs = normalizeSourceRefs(warning)
  if (
    typeof warning.error === 'string' && warning.error.trim() &&
    (warning.message === undefined || warning.message === warning.error)
  ) {
    warning.message = warning.error
    delete warning.error
    if (warning.severity === undefined) warning.severity = 'warning'
  }
  if (warning.recommendation === undefined && typeof warning.recommend === 'string') {
    warning.recommendation = warning.recommend
  }
  delete warning.recommend
  if (typeof warning.module === 'string') delete warning.module
  if (warning.basis === undefined) {
    warning.basis = refs !== undefined && refs.length > 0 ? 'source_evidence' : 'model_knowledge'
  }
  if (warning.sourceRefs === undefined && warning.basis === 'model_knowledge') warning.sourceRefs = []
  return warning
}

function normalizeSourceRefs(value: Record<string, unknown>): string[] | undefined {
  for (const aliasKey of ['sourceTRefs', 'sourceRef', 'reference'] as const) {
    const alias = value[aliasKey]
    if (!validSourceRefsInput(alias)) continue
    const aliasRefs = readSourceRefs(alias)
    if (
      aliasKey !== 'sourceTRefs' &&
      (aliasRefs.length === 0 || aliasRefs.some((ref) => !sourceRefPattern.test(ref)))
    ) {
      continue
    }
    if (value.sourceRefs === undefined) {
      value.sourceRefs = alias
      delete value[aliasKey]
    } else if (
      validSourceRefsInput(value.sourceRefs) &&
      sameStrings(readSourceRefs(value.sourceRefs), aliasRefs)
    ) {
      delete value[aliasKey]
    }
  }
  const raw = value.sourceRefs
  if (typeof raw !== 'string' && (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string'))) {
    return undefined
  }
  const refs = readSourceRefs(raw)
  value.sourceRefs = refs
  return refs
}

function validSourceRefsInput(value: unknown): value is string | string[] {
  return typeof value === 'string' || Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function readSourceRefs(raw: unknown): string[] {
  const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
  if (values.some((entry) => typeof entry !== 'string')) return []
  return uniqueRefs((values as string[]).flatMap((entry) => {
    const trimmed = entry.trim()
    if (!compositeSourceRefsPattern.test(trimmed)) return [trimmed]
    return trimmed.split(/\s*[,，、;/|]\s*/u).filter((ref) => sourceRefPattern.test(ref))
  }))
}

function uniqueRefs(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function readLimitations(raw: unknown): string[] | undefined {
  const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : undefined
  if (values === undefined || values.some((entry) => typeof entry !== 'string')) return undefined
  return [...new Set((values as string[]).map((entry) => entry.trim()).filter(Boolean))]
}

function readMisplacedWarnings(raw: unknown): string[] {
  const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
  const warnings = values.flatMap((value) => {
    if (typeof value === 'string') return [value]
    if (!isRecord(value)) return []
    const title = typeof value.title === 'string' ? value.title.trim() : ''
    const message = typeof value.message === 'string' ? value.message.trim() : ''
    if (title && message && title !== message) return [`${title}：${message}`]
    return [message || title].filter(Boolean)
  })
  return [...new Set(warnings.map((value) => value.trim()).filter(Boolean))]
}

function extractRootKeyLimitations(value: Record<string, unknown>): string[] {
  const limitations: string[] = []
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (allowedDraftFields.has(rawKey) || limitations.length >= 5) continue
    const key = rawKey.trim()
    if (key.length < 8 || key.length > 1000 || !limitationKeyPattern.test(key)) continue
    let limitation = key
    if (typeof rawValue === 'string') {
      const detail = rawValue.trim()
      if (detail && detail !== key && detail !== 'true') limitation = `${key}：${detail}`
    } else if (rawValue !== null && typeof rawValue !== 'boolean' && typeof rawValue !== 'number') {
      continue
    }
    if (limitation.length > 1000) continue
    limitations.push(limitation)
    delete value[rawKey]
  }
  return limitations
}

function moveShortSummaryToTitle(block: Record<string, unknown>): void {
  if (
    (typeof block.title !== 'string' || !block.title.trim()) &&
    typeof block.summary === 'string' && block.summary.trim().length <= 200
  ) {
    block.title = block.summary
  }
}

function moveStringAlias(value: Record<string, unknown>, target: string, aliases: readonly string[]): void {
  if (typeof value[target] !== 'string' || !(value[target] as string).trim()) {
    const alias = aliases.find((key) => typeof value[key] === 'string' && (value[key] as string).trim())
    if (alias !== undefined) value[target] = value[alias]
  }
  for (const alias of aliases) if (alias !== target) delete value[alias]
}

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
  const sourceRefs: SourceRefTracker = { used: new Set<string>(), truncated: false }

  try {
    const blocks = (value.blocks as Record<string, unknown>[]).map((block, index) =>
      materializeBlock(block, index, sourceMap, attachmentMap, sourceRefs))
    const warnings = (value.warnings as Record<string, unknown>[]).map((warning, index) => {
      const sourceFragmentIds = resolveSourceRefs(
        warning.sourceRefs,
        `/warnings/${index}/sourceRefs`,
        sourceMap,
        sourceRefs,
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
    if (claim.task.type !== 'analyze_image' && sourceRefs.used.size === 0) {
      throw new DraftError('文本任务至少要在 block 或 warning 的 sourceRefs 中引用一个 S# 来源')
    }
    const limitations = value.limitations as string[]
    const reviewLimitations = sourceRefs.truncated && !limitations.includes(sourceLimitLimitation)
      ? [...limitations.slice(0, 19), sourceLimitLimitation]
      : limitations
    const artifact: Record<string, unknown> = {
      schemaVersion: claim.task.schemaVersion,
      artifactType: artifactTypeFor(claim.task.type),
      title: value.title,
      summary: value.summary,
      classification: value.classification,
      blocks,
      warnings,
      sourceFragmentIds: [...sourceRefs.used],
      review: { status: 'model_reviewed', limitations: reviewLimitations },
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
  sourceRefs: SourceRefTracker,
): Record<string, unknown> {
  const path = `/blocks/${index}`
  const sourceFragmentIds = resolveSourceRefs(block.sourceRefs, `${path}/sourceRefs`, sourceMap, sourceRefs)
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
          sourceRefs,
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
          sourceRefs,
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
  tracker: SourceRefTracker,
): string[] {
  const result: string[] = []
  for (const ref of raw as string[]) {
    const id = sourceMap.get(ref)
    if (id === undefined) throw new DraftError(`${path} 包含当前上下文不存在的 ${ref}`)
    if (!tracker.used.has(id) && tracker.used.size >= maximumArtifactSourceRefs) {
      tracker.truncated = true
      continue
    }
    result.push(id)
    tracker.used.add(id)
  }
  return result
}

interface SourceRefTracker {
  readonly used: Set<string>
  truncated: boolean
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class DraftError extends Error {}

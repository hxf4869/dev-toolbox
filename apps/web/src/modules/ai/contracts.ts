import type { AttachmentEntry, LibraryItem } from '../knowledge/library'

export type SensitivePolicy = 'block' | 'redact' | 'allow'
export type TaskType = 'organize_record' | 'review_record' | 'analyze_image' | 'batch_organize'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type ArtifactType = 'organized_record' | 'correctness_review' | 'image_analysis'

export interface ProviderModel {
  id: string
  displayName: string
  modelId: string
  contextWindow: number | null
  maxOutputTokens: number | null
  supportsTools: boolean
  supportsVision: boolean
  enabled: boolean
}

export interface ProviderEntry {
  id: string
  displayName: string
  enabled: boolean
  models: ProviderModel[]
}

export interface ModelOption {
  id: string
  label: string
  supportsVision: boolean
}

export interface AISettings {
  sensitiveDisplayMode: 'masked'
  sensitiveAiPolicy: SensitivePolicy
  defaultOrganizeModelId: string | null
  defaultReviewModelId: string | null
  defaultVisionModelId: string | null
  autoActivateOrganized?: boolean
}

export interface TaskEvent {
  id: number
  type: string
  summary: string | null
  details: Record<string, unknown>
  createdAt: string
}

export interface BatchSummary {
  selectedItems: number
  createdChildren: number
  childStatusCounts: Record<TaskStatus, number>
  skipped: {
    total: number
    byReason: {
      already_covered: number
      already_queued_or_running: number
      no_supported_content: number
      vision_model_unavailable: number
      sensitive_blocked: number
      sensitive_image_redaction_unsupported: number
    }
  }
}

export interface AITask {
  id: string
  taskType: TaskType
  itemId: string | null
  parentTaskId: string | null
  triggerType: 'manual' | 'scheduled' | 'external'
  modelId: string | null
  status: TaskStatus
  sensitivePolicy: SensitivePolicy
  promptVersion: string
  schemaVersion: string
  retryOfTaskId: string | null
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  cancelRequestedAt: string | null
  cancelRequested: boolean
  errorCode: string | null
  errorDetail: string | null
  batchSummary?: BatchSummary | null
  inputTokens: number | null
  outputTokens: number | null
  events?: TaskEvent[]
}

export interface ArtifactSummary {
  id: string
  itemId?: string
  taskRunId?: string
  artifactType: ArtifactType
  versionNumber: number
  schemaVersion: string
  generator: 'builtin_worker' | 'external_agent'
  modelName: string | null
  promptVersion: string | null
  createdAt: string
  invalidatedAt: string | null
  active: boolean
  isStale: boolean
}

interface ArtifactBlockBase {
  id: string
  type: string
  sourceFragmentIds: string[]
}

export interface MarkdownBlock extends ArtifactBlockBase {
  type: 'markdown'
  markdown: string
}

export interface CodeBlock extends ArtifactBlockBase {
  type: 'code'
  language: string
  code: string
  caption?: string
  wrapByDefault?: boolean
}

export interface CommandBlock extends ArtifactBlockBase {
  type: 'command'
  shell: string
  command: string
  description?: string
}

export interface CommandStepsBlock extends ArtifactBlockBase {
  type: 'command_steps'
  title: string
  steps: Array<{
    title: string
    instruction?: string
    commands: Array<{ shell: string; command: string; description?: string }>
    notes?: string[]
    sourceFragmentIds: string[]
  }>
}

export interface KeyValueBlock extends ArtifactBlockBase {
  type: 'key_value'
  title?: string
  entries: Array<{ key: string; value: string; sensitive: boolean }>
}

export interface TableBlock extends ArtifactBlockBase {
  type: 'table'
  title?: string
  columns: string[]
  rows: string[][]
}

export interface ChecklistBlock extends ArtifactBlockBase {
  type: 'checklist'
  title: string
  items: Array<{ label: string; sourceFragmentIds: string[] }>
}

export interface CalloutBlock extends ArtifactBlockBase {
  type: 'callout'
  tone: 'info' | 'tip' | 'warning' | 'danger'
  title?: string
  body: string
}

export interface ImageReferenceBlock extends ArtifactBlockBase {
  type: 'image_reference'
  attachmentId: string
  caption?: string
  extractedText?: string
}

export interface AttachmentReferenceBlock extends ArtifactBlockBase {
  type: 'attachment_reference'
  attachmentId: string
  caption?: string
}

export type KnownArtifactBlock =
  | MarkdownBlock
  | CodeBlock
  | CommandBlock
  | CommandStepsBlock
  | KeyValueBlock
  | TableBlock
  | ChecklistBlock
  | CalloutBlock
  | ImageReferenceBlock
  | AttachmentReferenceBlock

export type ArtifactBlock = KnownArtifactBlock | (ArtifactBlockBase & Record<string, unknown>)

export interface ArtifactWarning {
  severity: 'info' | 'warning' | 'danger'
  title: string
  message: string
  basis: 'source_evidence' | 'model_knowledge'
  sourceFragmentIds: string[]
  recommendation?: string
}

export interface ArtifactContent {
  schemaVersion: '1.0'
  artifactType: ArtifactType
  title: string
  summary: string
  classification: {
    contentType: string
    suggestedFolderPath: string[]
    suggestedTags: string[]
    sensitivitySuggestion: 'normal' | 'sensitive' | 'unknown'
    sensitivityReason?: string
  }
  blocks: ArtifactBlock[]
  warnings: ArtifactWarning[]
  sourceFragmentIds: string[]
  review: {
    status: 'model_reviewed'
    limitations: string[]
  }
}

export interface ArtifactDetail extends ArtifactSummary {
  itemId: string
  taskRunId: string
  content: ArtifactContent
}

export interface AISchedule {
  frequency: 'off' | 'daily' | 'weekly'
  timezone: string
  localTime: string
  weekday: number
  organizeModelId: string | null
  visionModelId: string | null
  sensitivePolicy: SensitivePolicy
}

export interface ArtifactViewItem {
  attachments: AttachmentEntry[]
  item: LibraryItem
}

export const taskTypeLabels: Record<TaskType, string> = {
  organize_record: '记录整理',
  review_record: '正确性审阅',
  analyze_image: '图片分析',
  batch_organize: '批量整理',
}

export const artifactTypeLabels: Record<ArtifactType, string> = {
  organized_record: '整理版本',
  correctness_review: '审阅版本',
  image_analysis: '图片分析',
}

export const taskStatusLabels: Record<TaskStatus, string> = {
  queued: '等待中',
  running: '运行中',
  succeeded: '模型审阅完成',
  failed: '失败',
  cancelled: '已取消',
}

export function availableModels(providers: ProviderEntry[], visionOnly = false): ModelOption[] {
  return providers.flatMap((provider) =>
    provider.enabled
      ? provider.models
          .filter(
            (model) =>
              model.enabled &&
              model.contextWindow !== null &&
              model.maxOutputTokens !== null &&
              (!visionOnly || model.supportsVision),
          )
          .map((model) => ({
            id: model.id,
            label: `${provider.displayName} · ${model.displayName} · ${model.modelId}`,
            supportsVision: model.supportsVision,
          }))
      : [],
  )
}

export function policiesWithin(globalPolicy: SensitivePolicy): SensitivePolicy[] {
  if (globalPolicy === 'allow') return ['block', 'redact', 'allow']
  if (globalPolicy === 'redact') return ['block', 'redact']
  return ['block']
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

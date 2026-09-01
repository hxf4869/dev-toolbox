export interface RetrievalSourcePayload {
  readonly ordinal: number
  readonly fragmentId: string | null
  readonly itemId: string | null
  readonly sourceKind: string
  readonly sourceClass: 'primary' | 'ai_derived'
  readonly title: string
  readonly content: string
  readonly sensitivity: string
}

export interface SourceSnapshotInput {
  readonly ordinal: number
  readonly fragmentId: string | null
  readonly itemId: string | null
  readonly sourceKind: string
  readonly sourceClass: 'primary' | 'ai_derived'
  readonly title: string
  readonly content: string
  readonly sensitivity: string
}

export type { AssistantRunnerOptions } from './index.js'

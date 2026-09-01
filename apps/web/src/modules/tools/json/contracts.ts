export const STRUCTURED_TEXT_LIMIT_BYTES = 5 * 1024 * 1024

export type JsonLocalLanguage = 'typescript' | 'java' | 'go' | 'kotlin'

export type JsonWorkerRequest =
  | { operation: 'format'; text: string; compact: boolean }
  | { operation: 'repair'; text: string }
  | { operation: 'jsonpath'; text: string; expression: string }
  | { operation: 'diff'; left: string; right: string; mode: 'text' | 'structure'; identityField?: string }
  | { operation: 'schema-validate'; text: string; schemaText: string }
  | { operation: 'schema-generate'; text: string }
  | { operation: 'type-generate'; text: string; language: JsonLocalLanguage }

export interface PositionedIssue {
  code: string
  message: string
  line?: number
  column?: number
  position?: number
}

export interface JsonPathMatch {
  path: string
  value: string
}

export interface StructuralDifference {
  path: string
  kind: 'added' | 'removed' | 'changed'
  before?: string
  after?: string
}

export type JsonWorkerResult =
  | { operation: 'format'; output: string }
  | { operation: 'repair'; candidate: string; diff: string; changed: boolean }
  | { operation: 'jsonpath'; matches: JsonPathMatch[] }
  | { operation: 'diff'; summary: string; differences: StructuralDifference[] }
  | {
      operation: 'schema-validate'
      schemaValid: true
      status: 'valid' | 'invalid' | 'not_run_precision_guard'
      issues: PositionedIssue[]
    }
  | { operation: 'schema-generate'; output: string }
  | { operation: 'type-generate'; language: JsonLocalLanguage; output: string }

export interface StructuredToolErrorShape {
  code: string
  message: string
  position?: number
  line?: number
  column?: number
}

export class StructuredToolError extends Error {
  readonly code: string
  readonly position?: number
  readonly line?: number
  readonly column?: number

  constructor(shape: StructuredToolErrorShape) {
    super(shape.message)
    this.name = 'StructuredToolError'
    this.code = shape.code
    this.position = shape.position
    this.line = shape.line
    this.column = shape.column
  }
}

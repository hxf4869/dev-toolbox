import {
  isLosslessNumber,
  isSafeNumber,
  LosslessNumber,
  parse,
  stringify,
  toSafeNumberOrThrow,
} from 'lossless-json'

import { STRUCTURED_TEXT_LIMIT_BYTES, StructuredToolError } from './contracts'

export type LosslessJsonValue =
  | null
  | boolean
  | string
  | LosslessNumber
  | LosslessJsonValue[]
  | { [key: string]: LosslessJsonValue }

const encoder = new TextEncoder()

export function utf8Size(text: string): number {
  return encoder.encode(text).byteLength
}

export function assertStructuredTextLimit(text: string): void {
  const bytes = utf8Size(text)
  if (bytes > STRUCTURED_TEXT_LIMIT_BYTES) {
    throw new StructuredToolError({
      code: 'INPUT_TOO_LARGE',
      message: `输入为 ${bytes} 字节，超过 5 MiB（${STRUCTURED_TEXT_LIMIT_BYTES} 字节）上限。`,
    })
  }
}

export function parseLosslessJson(text: string): LosslessJsonValue {
  assertStructuredTextLimit(text)
  try {
    return parse(text) as LosslessJsonValue
  } catch (error) {
    throw normalizeJsonSyntaxError(error, text)
  }
}

export function stringifyLossless(value: LosslessJsonValue, space: number | string = 2): string {
  return stringify(value, null, space) ?? ''
}

export function normalizeJsonSyntaxError(error: unknown, source: string): StructuredToolError {
  const message = error instanceof Error ? error.message : 'JSON 语法无效。'
  const positionMatch = /(?:position|at)\s+(\d+)/i.exec(message)
  const position = positionMatch ? Number(positionMatch[1]) : undefined
  const location = position === undefined ? {} : positionToLocation(source, position)
  return new StructuredToolError({
    code: 'JSON_SYNTAX_ERROR',
    message,
    position,
    ...location,
  })
}

export function positionToLocation(source: string, position: number): { line: number; column: number } {
  const prefix = source.slice(0, Math.max(0, position))
  const lines = prefix.split('\n')
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

export function containsUnsafeNumber(value: LosslessJsonValue): boolean {
  if (isLosslessNumber(value)) return !isSafeNumber(value.value)
  if (Array.isArray(value)) return value.some(containsUnsafeNumber)
  if (isObject(value)) return Object.values(value).some(containsUnsafeNumber)
  return false
}

export function toSafeShadow(value: LosslessJsonValue): unknown {
  if (isLosslessNumber(value)) return toSafeNumberOrThrow(value.value)
  if (Array.isArray(value)) return value.map(toSafeShadow)
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toSafeShadow(child)]))
  }
  return value
}

export function cloneLossless(value: LosslessJsonValue): LosslessJsonValue {
  if (isLosslessNumber(value)) return new LosslessNumber(value.value)
  if (Array.isArray(value)) return value.map(cloneLossless)
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneLossless(child)]))
  }
  return value
}

export function isObject(value: LosslessJsonValue): value is Record<string, LosslessJsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isLosslessNumber(value)
}

export function displayLossless(value: LosslessJsonValue): string {
  return stringifyLossless(value, 0)
}

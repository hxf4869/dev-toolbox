import Ajv2020 from 'ajv/dist/2020'
import { JSONPath } from 'jsonpath-plus'

import type {
  JsonPathMatch,
  JsonWorkerRequest,
  JsonWorkerResult,
  PositionedIssue,
  StructuralDifference,
} from './contracts'
import { StructuredToolError } from './contracts'
import {
  assertStructuredTextLimit,
  containsUnsafeNumber,
  displayLossless,
  isObject,
  type LosslessJsonValue,
  parseLosslessJson,
  stringifyLossless,
  toSafeShadow,
} from './lossless'
import { createLimitedRepair } from './repair'
import { generateLocalTypes } from './typeGeneration'

export async function runJsonOperation(request: JsonWorkerRequest): Promise<JsonWorkerResult> {
  switch (request.operation) {
    case 'format': {
      const value = parseLosslessJson(request.text)
      return { operation: 'format', output: stringifyLossless(value, request.compact ? 0 : 2) }
    }
    case 'repair': return { operation: 'repair', ...createLimitedRepair(request.text) }
    case 'jsonpath': return {
      operation: 'jsonpath',
      matches: queryJsonPath(parseLosslessJson(request.text), request.expression),
    }
    case 'diff': return diffJson(request.left, request.right, request.mode, request.identityField)
    case 'schema-validate': return validateSchema(request.text, request.schemaText)
    case 'schema-generate': return {
      operation: 'schema-generate',
      output: stringifyLossless(generateSchema(parseLosslessJson(request.text)), 2),
    }
    case 'type-generate': return {
      operation: 'type-generate',
      language: request.language,
      output: generateLocalTypes(parseLosslessJson(request.text), request.language),
    }
  }
}

export function queryJsonPath(root: LosslessJsonValue, expression: string): JsonPathMatch[] {
  validateJsonPathSubset(expression)
  try {
    const matches = expandQuotedPropertyUnions(expression).flatMap((expandedExpression) => (
      JSONPath({
        path: expandedExpression,
        json: root as object,
        resultType: 'all',
        eval: false,
        wrap: true,
      }) as Array<{ path: string; value: LosslessJsonValue }>
    ))
    return matches.map((match) => ({ path: match.path, value: displayLossless(match.value) }))
  } catch (error) {
    throw new StructuredToolError({
      code: 'JSONPATH_SYNTAX_ERROR',
      message: error instanceof Error ? error.message : 'JSONPath 表达式无效。',
    })
  }
}

interface QuotedPropertyUnion {
  start: number
  end: number
  members: string[]
}

function expandQuotedPropertyUnions(expression: string): string[] {
  const unions: QuotedPropertyUnion[] = []
  let cursor = 0
  while (cursor < expression.length) {
    if (expression[cursor] !== '[') {
      cursor += 1
      continue
    }
    const end = findBracketEnd(expression, cursor)
    if (end < 0) break
    const members = parseQuotedUnionMembers(expression.slice(cursor + 1, end))
    if (members) unions.push({ start: cursor, end: end + 1, members })
    cursor = end + 1
  }

  if (unions.length === 0) return [expression]
  let variants = ['']
  cursor = 0
  for (const union of unions) {
    const prefix = expression.slice(cursor, union.start)
    variants = variants.flatMap((variant) => union.members.map((member) => (
      `${variant}${prefix}[${JSON.stringify(`\`${member}`)}]`
    )))
    cursor = union.end
  }
  const suffix = expression.slice(cursor)
  return variants.map((variant) => `${variant}${suffix}`)
}

function findBracketEnd(expression: string, start: number): number {
  let quote = ''
  for (let index = start + 1; index < expression.length; index += 1) {
    const char = expression[index]!
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === ']') return index
  }
  return -1
}

function parseQuotedUnionMembers(source: string): string[] | null {
  const members: string[] = []
  let cursor = 0
  const skipWhitespace = () => {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
  }

  skipWhitespace()
  while (cursor < source.length) {
    const quote = source[cursor]
    if (quote !== '"' && quote !== "'") return null
    const tokenStart = cursor
    cursor += 1
    let closed = false
    while (cursor < source.length) {
      const char = source[cursor]!
      if (char === quote) {
        cursor += 1
        closed = true
        break
      }
      if (char === '\\') {
        if (source[cursor + 1] === undefined) return null
        cursor += 2
        continue
      }
      cursor += 1
    }
    if (!closed) return null
    const rawToken = source.slice(tokenStart, cursor)
    let member: string
    try {
      member = quote === '"'
        ? JSON.parse(rawToken) as string
        : rawToken.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    } catch {
      return null
    }
    members.push(member)
    skipWhitespace()
    if (cursor === source.length) break
    if (source[cursor] !== ',') return null
    cursor += 1
    skipWhitespace()
    if (cursor === source.length) return null
  }
  return members.length >= 2 ? members : null
}

export function validateJsonPathSubset(expression: string): void {
  if (!expression.startsWith('$')) {
    throw new StructuredToolError({ code: 'JSONPATH_SYNTAX_ERROR', message: 'JSONPath 必须从根符号 $ 开始。', position: 0 })
  }
  const forbidden = findOutsideQuoted(expression, /[?@()^~`]/)
  if (forbidden >= 0) {
    throw new StructuredToolError({
      code: 'JSONPATH_SCRIPT_DISABLED',
      message: '仅支持根、属性/索引、通配、递归、数组切片和并集；脚本过滤与表达式执行已禁用。',
      position: forbidden,
    })
  }
  const invalid = findOutsideQuoted(expression, /[^A-Za-z0-9_$.*\[\],'"\s:\-]/)
  if (invalid >= 0) {
    throw new StructuredToolError({ code: 'JSONPATH_SYNTAX_ERROR', message: `JSONPath 在位置 ${invalid + 1} 包含不支持的字符。`, position: invalid })
  }
}

function findOutsideQuoted(text: string, pattern: RegExp): number {
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (pattern.test(char)) return index
  }
  return -1
}

export function diffJson(
  leftText: string,
  rightText: string,
  mode: 'text' | 'structure',
  identityField?: string,
): JsonWorkerResult {
  if (mode === 'text') {
    assertStructuredTextLimit(leftText)
    assertStructuredTextLimit(rightText)
    const differences = textDifferences(leftText, rightText)
    return { operation: 'diff', summary: `${differences.length} 处行差异`, differences }
  }
  const left = parseLosslessJson(leftText)
  const right = parseLosslessJson(rightText)
  const differences: StructuralDifference[] = []
  compareStructure(left, right, '$', differences, identityField?.trim() || undefined)
  return { operation: 'diff', summary: `${differences.length} 处结构差异`, differences }
}

function textDifferences(left: string, right: string): StructuralDifference[] {
  const before = left.split('\n')
  const after = right.split('\n')
  const output: StructuralDifference[] = []
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (before[index] === after[index]) continue
    output.push({
      path: `第 ${index + 1} 行`,
      kind: before[index] === undefined ? 'added' : after[index] === undefined ? 'removed' : 'changed',
      before: before[index],
      after: after[index],
    })
  }
  return output
}

function compareStructure(
  left: LosslessJsonValue | undefined,
  right: LosslessJsonValue | undefined,
  path: string,
  output: StructuralDifference[],
  identityField?: string,
): void {
  if (left === undefined || right === undefined) {
    output.push({
      path,
      kind: left === undefined ? 'added' : 'removed',
      before: left === undefined ? undefined : displayLossless(left),
      after: right === undefined ? undefined : displayLossless(right),
    })
    return
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (identityField) {
      const leftMap = indexIdentity(left, identityField, path)
      const rightMap = indexIdentity(right, identityField, path)
      const identities = [...leftMap.keys(), ...[...rightMap.keys()].filter((key) => !leftMap.has(key))]
      for (const identity of identities) {
        compareStructure(leftMap.get(identity), rightMap.get(identity), `${path}[${JSON.stringify(identity)}]`, output, identityField)
      }
      return
    }
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      compareStructure(left[index], right[index], `${path}[${index}]`, output, identityField)
    }
    return
  }
  if (isObject(left) && isObject(right)) {
    const keys = [...Object.keys(left), ...Object.keys(right).filter((key) => !(key in left))]
    for (const key of keys) compareStructure(left[key], right[key], canonicalChildPath(path, key), output, identityField)
    return
  }
  if (displayLossless(left) !== displayLossless(right)) {
    output.push({ path, kind: 'changed', before: displayLossless(left), after: displayLossless(right) })
  }
}

function indexIdentity(values: LosslessJsonValue[], field: string, path: string): Map<string, LosslessJsonValue> {
  const output = new Map<string, LosslessJsonValue>()
  for (const value of values) {
    if (!isObject(value) || !(field in value)) {
      throw new StructuredToolError({
        code: 'DIFF_IDENTITY_MISSING',
        message: `${path} 中有数组元素缺少显式身份字段 ${JSON.stringify(field)}。`,
      })
    }
    const identity = value[field]!
    if (isObject(identity) || Array.isArray(identity) || identity === null) {
      throw new StructuredToolError({ code: 'DIFF_IDENTITY_INVALID', message: '身份字段必须是非 null 标量。' })
    }
    const key = displayLossless(identity)
    if (output.has(key)) {
      throw new StructuredToolError({
        code: 'DIFF_IDENTITY_DUPLICATE',
        message: `身份字段 ${JSON.stringify(field)} 出现重复值 ${key}，未合并重复元素。`,
      })
    }
    output.set(key, value)
  }
  return output
}

function canonicalChildPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

export function validateSchema(instanceText: string, schemaText: string): JsonWorkerResult {
  const instance = parseLosslessJson(instanceText)
  const schemaLossless = parseLosslessJson(schemaText)
  if (containsUnsafeNumber(schemaLossless)) {
    throw new StructuredToolError({
      code: 'SCHEMA_UNSAFE_NUMBER',
      message: 'Schema 自身包含无法安全映射的数值关键字，已拒绝编译。',
    })
  }
  rejectRemoteReferences(schemaLossless)
  const schema = toSafeShadow(schemaLossless) as object
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true })
  let validate: ReturnType<typeof ajv.compile>
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    throw new StructuredToolError({
      code: 'SCHEMA_INVALID',
      message: error instanceof Error ? error.message : 'Schema 无法通过 Draft 2020-12 编译。',
    })
  }
  if (containsUnsafeNumber(instance)) {
    return { operation: 'schema-validate', schemaValid: true, status: 'not_run_precision_guard', issues: [] }
  }
  const valid = validate(toSafeShadow(instance))
  const issues: PositionedIssue[] = (validate.errors ?? []).map((issue) => ({
    code: issue.keyword,
    message: `${issue.instancePath || '$'} ${issue.message ?? '不符合 Schema'}`,
  }))
  return { operation: 'schema-validate', schemaValid: true, status: valid ? 'valid' : 'invalid', issues }
}

function rejectRemoteReferences(value: LosslessJsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(rejectRemoteReferences)
    return
  }
  if (!isObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && !child.startsWith('#')) {
      throw new StructuredToolError({
        code: 'SCHEMA_REMOTE_REF_DISABLED',
        message: `远程 $ref ${JSON.stringify(child)} 已禁用；只支持当前文档内 # 引用。`,
      })
    }
    rejectRemoteReferences(child)
  }
}

export function generateSchema(value: LosslessJsonValue): LosslessJsonValue {
  if (value === null) return { type: 'null' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (typeof value === 'string') return { type: 'string' }
  if (Array.isArray(value)) {
    const itemSchemas = value.map(generateSchema)
    const unique = uniqueSchemas(itemSchemas)
    return {
      type: 'array',
      items: unique.length === 0 ? {} : unique.length === 1 ? unique[0]! : { anyOf: unique },
    }
  }
  if (isObject(value)) {
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, generateSchema(child)])),
      required: Object.keys(value),
      additionalProperties: true,
    }
  }
  return { type: /^-?\d+$/.test(value.value) ? 'integer' : 'number' }
}

function uniqueSchemas(values: LosslessJsonValue[]): LosslessJsonValue[] {
  const output: LosslessJsonValue[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const key = stringifyLossless(value, 0)
    if (!seen.has(key)) {
      seen.add(key)
      output.push(value)
    }
  }
  return output
}

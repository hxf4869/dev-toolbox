import {
  removeUriSchemePlugin,
  RetrievalError,
  UnsupportedUriSchemeError,
  value as browserValue,
  type Browser,
} from '@hyperjump/browser'
import { Reference } from '@hyperjump/browser/jref'
import {
  getAllRegisteredSchemaUris,
  InvalidSchemaError,
  registerSchema,
  setMetaSchemaOutputFormat,
  unregisterSchema,
} from '@hyperjump/json-schema/draft-2020-12'
import type { SchemaObject } from '@hyperjump/json-schema/draft-2020-12'
import {
  BASIC,
  compile,
  getKeywordId,
  getSchema,
  interpret,
  type CompiledSchema,
  type SchemaDocument,
} from '@hyperjump/json-schema/experimental'
import { fromJs } from '@hyperjump/json-schema/instance/experimental'
import { JSONPath } from 'jsonpath-plus'

import type {
  JsonPathMatch,
  JsonWorkerRequest,
  JsonWorkerResult,
  PositionedIssue,
  StructuralDifference,
} from './contracts'
import { DIFF_DISPLAY_LIMIT, StructuredToolError } from './contracts'
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

// InvalidSchemaError.output 默认 FLAG；设为 BASIC 以在 SCHEMA_INVALID 消息中带出首个元错误位置。
setMetaSchemaOutputFormat(BASIC)

// 此模块只由 JSON Worker 加载。移除默认取数插件，让编译期间的文档外取数在 SDK 边界失败；
// 浏览器只注册 http/https，file 在浏览器为 no-op，在 Node 测试中同样禁止读取文件。
for (const scheme of ['http', 'https', 'file']) removeUriSchemePlugin(scheme)

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
    const state = textDifferences(leftText, rightText)
    return { operation: 'diff', summary: diffSummary(state, '行'), differences: state.differences, truncated: state.truncated }
  }
  const left = parseLosslessJson(leftText)
  const right = parseLosslessJson(rightText)
  const state: DiffCollection = { differences: [], truncated: false }
  compareStructure(left, right, '$', state, identityField?.trim() || undefined)
  return { operation: 'diff', summary: diffSummary(state, '结构'), differences: state.differences, truncated: state.truncated }
}

interface DiffCollection {
  differences: StructuralDifference[]
  truncated: boolean
}

function diffSummary(state: DiffCollection, kind: '行' | '结构'): string {
  // 截断时不得把上限数量写成真实总数。
  return state.truncated
    ? `${DIFF_DISPLAY_LIMIT}+ 处${kind}差异（已截断，仅显示前 ${DIFF_DISPLAY_LIMIT} 处）`
    : `${state.differences.length} 处${kind}差异`
}

// 收集一条差异：已收集满上限时，这条就是确认存在的第 501 条——只据此标记
// 截断，不收集也不继续统计。恰好第 500 条收集完不触发截断。
function collectDifference(output: DiffCollection, difference: StructuralDifference): void {
  if (output.differences.length >= DIFF_DISPLAY_LIMIT) {
    output.truncated = true
    return
  }
  output.differences.push(difference)
}

function textDifferences(left: string, right: string): DiffCollection {
  const before = left.split('\n')
  const after = right.split('\n')
  const state: DiffCollection = { differences: [], truncated: false }
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (before[index] === after[index]) continue
    if (state.differences.length >= DIFF_DISPLAY_LIMIT) {
      // 达到上限后只确认仍存在更多差异，不继续收集或统计总数。
      state.truncated = true
      break
    }
    state.differences.push({
      path: `第 ${index + 1} 行`,
      kind: before[index] === undefined ? 'added' : after[index] === undefined ? 'removed' : 'changed',
      before: before[index],
      after: after[index],
    })
  }
  return state
}

function compareStructure(
  left: LosslessJsonValue | undefined,
  right: LosslessJsonValue | undefined,
  path: string,
  output: DiffCollection,
  identityField?: string,
): void {
  if (output.truncated) return
  if (left === undefined || right === undefined) {
    collectDifference(output, {
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
        if (output.truncated) return
        compareStructure(leftMap.get(identity), rightMap.get(identity), `${path}[${JSON.stringify(identity)}]`, output, identityField)
      }
      return
    }
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      if (output.truncated) return
      compareStructure(left[index], right[index], `${path}[${index}]`, output, identityField)
    }
    return
  }
  if (isObject(left) && isObject(right)) {
    const keys = [...Object.keys(left), ...Object.keys(right).filter((key) => !Object.hasOwn(left, key))]
    for (const key of keys) {
      if (output.truncated) return
      compareStructure(
        Object.hasOwn(left, key) ? left[key] : undefined,
        Object.hasOwn(right, key) ? right[key] : undefined,
        canonicalChildPath(path, key), output, identityField,
      )
    }
    return
  }
  if (displayLossless(left) !== displayLossless(right)) {
    collectDifference(output, { path, kind: 'changed', before: displayLossless(left), after: displayLossless(right) })
  }
}

function indexIdentity(values: LosslessJsonValue[], field: string, path: string): Map<string, LosslessJsonValue> {
  const output = new Map<string, LosslessJsonValue>()
  for (const value of values) {
    if (!isObject(value) || !Object.hasOwn(value, field)) {
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

const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const LOCAL_SCHEMA_URI_PREFIX = 'urn:dev-toolbox:json-tool:local-'
let localSchemaUriSequence = 0

function keywordName(keyword: string): string {
  const match = /[#/]([^/#]+)$/.exec(keyword)
  return match?.[1] ?? keyword
}

function instancePathOf(instanceLocation: string): string {
  const pointer = instanceLocation.startsWith('#') ? instanceLocation.slice(1) : instanceLocation
  try {
    return decodeURIComponent(pointer) || '$'
  } catch {
    return pointer
  }
}

function schemaInvalidMessage(error: InvalidSchemaError): string {
  const first = error.output?.errors?.[0]
  if (!first) return 'Schema 无法通过 Draft 2020-12 校验。'
  return `Schema 无法通过 Draft 2020-12 校验：${first.absoluteKeywordLocation ?? first.instanceLocation} ${keywordName(first.keyword)}。`
}

export async function validateSchema(instanceText: string, schemaText: string): Promise<JsonWorkerResult> {
  const instance = parseLosslessJson(instanceText)
  const schemaLossless = parseLosslessJson(schemaText)
  if (containsUnsafeNumber(schemaLossless)) {
    throw new StructuredToolError({
      code: 'SCHEMA_UNSAFE_NUMBER',
      message: 'Schema 自身包含无法安全映射的数值关键字，已拒绝编译。',
    })
  }
  if (!isObject(schemaLossless) && typeof schemaLossless !== 'boolean') {
    throw new StructuredToolError({
      code: 'SCHEMA_INVALID',
      message: 'Schema 必须是 JSON 对象或布尔值 true/false。',
    })
  }
  // data 中的 ref 字面量参与普通值比较；被本地引用提升为 Schema 后的非 # 引用，
  // 由编译结果检查拒绝。Schema 位置的非 # 声明与资源安全限制仍在此处检查。
  rejectUnsupportedSchemaFeatures(schemaLossless, true, 'schema')
  const schema = toSafeShadow(schemaLossless) as SchemaObject | boolean
  // 解释式校验器使用进程级注册表，且 worker 长驻：按次注册新 URI 并在 finally 差异清理，
  // 避免用户 Schema 的 $id 或方言条目跨请求残留（含 R208 实测的 loadDialect 窗口）。
  const registryBaseline = new Set(getAllRegisteredSchemaUris())
  localSchemaUriSequence += 1
  const retrievalUri = `${LOCAL_SCHEMA_URI_PREFIX}${localSchemaUriSequence}`
  try {
    registerSchema(schema, retrievalUri, JSON_SCHEMA_DIALECT)
    // 编译即完成元校验：即使实例不安全，Schema 本身也先被证明有效（docs/09 Schema 节）。
    const root = await getSchema(retrievalUri)
    const compiled = await compile(root)
    await rejectCompiledRemoteReferences(compiled, root, registryBaseline)
    if (containsUnsafeNumber(instance)) {
      return { operation: 'schema-validate', schemaValid: true, status: 'not_run_precision_guard', issues: [] }
    }
    const output = interpret(compiled, fromJs(toSafeShadow(instance) as Parameters<typeof fromJs>[0]), BASIC)
    const issues: PositionedIssue[] = output.valid ? [] : (output.errors ?? []).map((issue) => ({
      code: keywordName(issue.keyword),
      message: `${instancePathOf(issue.instanceLocation)} 不符合 ${keywordName(issue.keyword)} 约束`,
    }))
    return { operation: 'schema-validate', schemaValid: true, status: output.valid ? 'valid' : 'invalid', issues }
  } catch (error) {
    if (error instanceof InvalidSchemaError) {
      throw new StructuredToolError({ code: 'SCHEMA_INVALID', message: schemaInvalidMessage(error) })
    }
    if (error instanceof RetrievalError && error.cause instanceof UnsupportedUriSchemeError) {
      throw new StructuredToolError({
        code: 'SCHEMA_REMOTE_REF_DISABLED',
        message: '文档外引用取数已禁用；只支持当前文档内 # 引用。',
      })
    }
    throw error
  } finally {
    for (const uri of getAllRegisteredSchemaUris()) {
      if (!registryBaseline.has(uri)) unregisterSchema(uri)
    }
  }
}

// SDK 可将 data 中的 ref 提升为 Schema，并在取数插件之前命中注册缓存。
// 只检查公开 AST 中实际编译的引用原字面值；内置元 Schema 继续由 SDK 自身维护。
async function rejectCompiledRemoteReferences(
  compiled: CompiledSchema,
  root: Browser<SchemaDocument>,
  registryBaseline: ReadonlySet<string>,
): Promise<void> {
  const referenceKeywords = new Map([
    [getKeywordId('$ref', JSON_SCHEMA_DIALECT), '$ref'],
    [getKeywordId('$dynamicRef', JSON_SCHEMA_DIALECT), '$dynamicRef'],
  ])
  for (const nodes of Object.values(compiled.ast)) {
    if (!Array.isArray(nodes)) continue
    for (const [keywordId, keywordUri] of nodes) {
      const field = referenceKeywords.get(keywordId)
      if (!field) continue
      const parentUri = keywordUri.slice(0, keywordUri.lastIndexOf('/'))
      const parent = await getSchema(parentUri, root)
      if (registryBaseline.has(parent.document.baseUri)) continue
      const raw = browserValue<Record<string, unknown>>(parent)[field]
      const literal = raw instanceof Reference ? raw.href : raw
      if (typeof literal === 'string' && !literal.startsWith('#')) {
        throw new StructuredToolError({
          code: 'SCHEMA_REMOTE_REF_DISABLED',
          message: '远程 ' + field + ' ' + JSON.stringify(literal) + ' 已禁用；只支持当前文档内 # 引用。',
        })
      }
    }
  }
}

type SchemaFeaturePosition = 'schema' | 'schemaMap' | 'data'

// 纯位置分类：schema 节点的 const/enum/default/examples 值是惰性数据；五类映射关键字的值是
// "名称 → Schema"映射，其中任意 key 都是属性名而非关键字（properties.const 是真 Schema）。
function childSchemaPosition(position: SchemaFeaturePosition, key: string): SchemaFeaturePosition {
  if (position === 'data') return 'data'
  if (position === 'schemaMap') return 'schema'
  if (key === 'const' || key === 'enum' || key === 'default' || key === 'examples') return 'data'
  if (key === 'properties' || key === 'patternProperties' || key === 'dependentSchemas' || key === '$defs' || key === 'definitions') return 'schemaMap'
  return 'schema'
}

function rejectUnsupportedSchemaFeatures(
  value: LosslessJsonValue,
  isResource: boolean,
  position: SchemaFeaturePosition,
): void {
  if (Array.isArray(value)) {
    value.forEach((child) => rejectUnsupportedSchemaFeatures(
      child,
      isObject(child) && typeof child.$id === 'string',
      position,
    ))
    return
  }
  if (!isObject(value)) return
  const dialect = value.$schema
  if (typeof dialect === 'string' && dialect !== JSON_SCHEMA_DIALECT) {
    throw new StructuredToolError({
      code: 'SCHEMA_DIALECT_UNSUPPORTED',
      message: `仅支持 JSON Schema Draft 2020-12，已拒绝 $schema ${JSON.stringify(dialect)}。`,
    })
  }
  // $vocabulary 只会被资源级节点（根或带字符串 $id 的子 Schema；lib/schema.js 的 processSchema
  // 对后者同样执行 buildSchemaDocument）处理并触发 loadDialect，R208 实测该路径可在查重前
  // 重建内置方言，因此资源级自定义 $vocabulary 一律拒绝。
  if (isResource && isObject(value.$vocabulary)) {
    throw new StructuredToolError({
      code: 'SCHEMA_VOCABULARY_UNSUPPORTED',
      message: '仅支持内置 Draft 2020-12 词汇表，已拒绝自定义 $vocabulary。',
    })
  }
  // 资源限制仍遍历全部子树（含 data）。非 # 引用声明只在 Schema 位置拒绝；
  // data 中的普通字面值放行，提升为 Schema 后的引用另按公开编译结果检查。
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === '$ref' || key === '$dynamicRef') && typeof child === 'string' && !child.startsWith('#')
      && position !== 'data'
    ) {
      throw new StructuredToolError({
        code: 'SCHEMA_REMOTE_REF_DISABLED',
        message: `远程 ${key} ${JSON.stringify(child)} 已禁用；只支持当前文档内 # 引用。`,
      })
    }
    rejectUnsupportedSchemaFeatures(child, isObject(child) && typeof child.$id === 'string', childSchemaPosition(position, key))
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

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Node,
  type Pair,
  type Scalar,
} from 'yaml'
import { isNumber, LosslessNumber } from 'lossless-json'

import { StructuredToolError } from '../json/contracts'
import {
  assertStructuredTextLimit,
  isObject,
  type LosslessJsonValue,
  parseLosslessJson,
  stringifyLossless,
} from '../json/lossless'
import type { YamlWorkerRequest, YamlWorkerResult } from './contracts'

const ALLOWED_YAML_12_CORE_TAGS = new Set([
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:map',
])

export function runYamlOperation(request: YamlWorkerRequest): YamlWorkerResult {
  switch (request.operation) {
    case 'format': {
      const documents = parseYamlDocuments(request.text)
      return {
        operation: 'format',
        output: documents
          .map((document) => document.toString({ lineWidth: 0, directives: false }))
          .join('---\n'),
        documentCount: documents.length,
      }
    }
    case 'to-json': {
      const documents = parseYamlDocuments(request.text)
      const values = documents.map((document) => yamlNodeToLossless(document.contents, document))
      const outputValue: LosslessJsonValue = values.length === 1 ? values[0]! : values
      return {
        operation: 'to-json',
        output: stringifyLossless(outputValue, 2),
        documentCount: values.length,
        outputForm: values.length === 1 ? 'single' : 'array',
      }
    }
    case 'from-json': return {
      operation: 'from-json',
      output: emitYaml(parseLosslessJson(request.text)),
    }
  }
}

export function parseYamlDocuments(text: string): Document.Parsed[] {
  assertStructuredTextLimit(text)
  if (/^\s*%TAG\b/m.test(text)) {
    throw new StructuredToolError({ code: 'YAML_TAG_DIRECTIVE_DISABLED', message: '%TAG 自定义指令已禁用。' })
  }
  const documents = parseAllDocuments(text, {
    version: '1.2',
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    customTags: [],
    merge: false,
    resolveKnownTags: false,
    intAsBigInt: true,
    keepSourceTokens: true,
    prettyErrors: true,
  }) as Document.Parsed[]
  if (documents.length === 0) {
    throw new StructuredToolError({ code: 'YAML_EMPTY', message: '请输入至少一个 YAML 文档。' })
  }
  for (const document of documents) {
    const issue = document.errors[0]
    if (issue) {
      throw new StructuredToolError({
        code: issue.code === 'DUPLICATE_KEY' ? 'YAML_DUPLICATE_KEY' : 'YAML_SYNTAX_ERROR',
        message: issue.message,
        position: issue.pos?.[0],
        line: issue.linePos?.[0]?.line,
        column: issue.linePos?.[0]?.col,
      })
    }
    inspectYamlNode(document.contents)
    try {
      document.toJS({ maxAliasCount: 100 })
    } catch (error) {
      throw new StructuredToolError({
        code: 'YAML_ALIAS_LIMIT',
        message: error instanceof Error ? error.message : 'alias 展开超过 100 次上限。',
      })
    }
  }
  return documents
}

function inspectYamlNode(node: Node | null): void {
  if (!node) return
  if ('tag' in node && typeof node.tag === 'string' && !ALLOWED_YAML_12_CORE_TAGS.has(node.tag)) {
    throw new StructuredToolError({
      code: 'YAML_CUSTOM_TAG_DISABLED',
      message: `自定义 tag ${JSON.stringify(node.tag)} 已禁用。`,
    })
  }
  if (isMap(node)) {
    for (const pair of node.items as Pair[]) {
      if (isScalar(pair.key) && pair.key.value === '<<') {
        throw new StructuredToolError({ code: 'YAML_MERGE_KEY_DISABLED', message: 'YAML merge key（<<）已禁用。' })
      }
      inspectYamlNode(pair.key as Node)
      inspectYamlNode(pair.value as Node | null)
    }
  } else if (isSeq(node)) {
    node.items.forEach((item) => inspectYamlNode(item as Node | null))
  }
}

function yamlNodeToLossless(node: Node | null, document: Document.Parsed): LosslessJsonValue {
  if (!node) return null
  if (isAlias(node)) {
    const resolved = node.resolve(document)
    if (!resolved) throw new StructuredToolError({ code: 'YAML_ALIAS_UNRESOLVED', message: `alias *${node.source} 无法解析。` })
    return yamlNodeToLossless(resolved, document)
  }
  if (isScalar(node)) return yamlScalarToLossless(node)
  if (isSeq(node)) return node.items.map((item) => yamlNodeToLossless(item as Node | null, document))
  if (isMap(node)) {
    const output: Record<string, LosslessJsonValue> = {}
    for (const pair of node.items as Pair[]) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        throw new StructuredToolError({ code: 'YAML_KEY_UNSUPPORTED', message: 'YAML→JSON 只支持字符串 mapping key。' })
      }
      output[pair.key.value] = yamlNodeToLossless(pair.value as Node | null, document)
    }
    return output
  }
  throw new StructuredToolError({ code: 'YAML_NODE_UNSUPPORTED', message: 'YAML 包含无法转换为 JSON 的节点。' })
}

function yamlScalarToLossless(node: Scalar): LosslessJsonValue {
  if (typeof node.value === 'bigint') return new LosslessNumber(node.value.toString())
  if (typeof node.value === 'number') {
    if (!Number.isFinite(node.value)) {
      throw new StructuredToolError({ code: 'YAML_NON_JSON_NUMBER', message: 'NaN 和 Infinity 不能转换为 JSON 数值。' })
    }
    const source = node.source ?? node.value.toString()
    if (isNumber(source)) return new LosslessNumber(source)
    return new LosslessNumber(node.value.toString())
  }
  if (node.value === null || typeof node.value === 'boolean' || typeof node.value === 'string') return node.value
  throw new StructuredToolError({ code: 'YAML_SCALAR_UNSUPPORTED', message: 'YAML 标量无法安全转换为 JSON。' })
}

export function emitYaml(value: LosslessJsonValue): string {
  return `${emitYamlValue(value, 0, false)}\n`
}

function emitYamlValue(value: LosslessJsonValue, depth: number, inline: boolean): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if ('isLosslessNumber' in Object(value)) return (value as LosslessNumber).value
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value.map((item) => {
      const prefix = `${'  '.repeat(depth)}-`
      if (isObject(item) || Array.isArray(item)) return `${prefix}\n${emitYamlValue(item, depth + 1, false)}`
      return `${prefix} ${emitYamlValue(item, depth + 1, true)}`
    }).join('\n')
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  return entries.map(([key, child]) => {
    const keyText = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key)
    const prefix = `${'  '.repeat(depth)}${keyText}:`
    if (isObject(child) || Array.isArray(child)) return `${prefix}\n${emitYamlValue(child, depth + 1, false)}`
    return `${prefix} ${emitYamlValue(child, depth + 1, true)}`
  }).join('\n')
}

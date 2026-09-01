import { isInteger, isLosslessNumber } from 'lossless-json'

import type { JsonLocalLanguage } from './contracts'
import { StructuredToolError } from './contracts'
import { isObject, type LosslessJsonValue } from './lossless'

type PrimitiveKind = 'null' | 'boolean' | 'string' | 'integer' | 'number' | 'unknown'

interface PrimitiveShape {
  kind: PrimitiveKind
}

interface FieldShape {
  jsonKey: string
  shape: Shape
  optional: boolean
  nullable: boolean
}

interface ObjectShape {
  kind: 'object'
  name: string
  fields: FieldShape[]
}

interface ArrayShape {
  kind: 'array'
  element: Shape
}

type Shape = PrimitiveShape | ObjectShape | ArrayShape

const javaKeywords = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally',
  'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface',
  'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short',
  'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient',
  'try', 'void', 'volatile', 'while', 'record', 'sealed', 'permits', 'var', 'yield',
])
const kotlinKeywords = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in',
  'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true',
  'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while', 'by', 'catch', 'constructor',
  'delegate', 'dynamic', 'field', 'file', 'finally', 'get', 'import', 'init', 'param', 'property',
  'receiver', 'set', 'setparam', 'where',
])

export function generateLocalTypes(root: LosslessJsonValue, language: JsonLocalLanguage): string {
  if (!isObject(root) && !Array.isArray(root)) {
    throw new StructuredToolError({
      code: 'TYPE_ROOT_UNSUPPORTED',
      message: '本地类型生成只支持 object 或 array 根值。',
    })
  }
  const shape = inferShape(root, ['Root'])
  assignObjectTypeNames(shape)
  switch (language) {
    case 'typescript': return renderTypeScript(shape)
    case 'java': return renderJava(shape)
    case 'go': return renderGo(shape)
    case 'kotlin': return renderKotlin(shape)
  }
}

function inferShape(value: LosslessJsonValue, path: string[]): Shape {
  if (value === null) return { kind: 'null' }
  if (typeof value === 'boolean') return { kind: 'boolean' }
  if (typeof value === 'string') return { kind: 'string' }
  if (isLosslessNumber(value)) return { kind: isInteger(value.value) ? 'integer' : 'number' }
  if (Array.isArray(value)) return inferArray(value, path)
  return {
    kind: 'object',
    name: typeName(path),
    fields: Object.entries(value).map(([jsonKey, child]) => ({
      jsonKey,
      shape: inferShape(child, [...path, jsonKey]),
      optional: false,
      nullable: child === null,
    })),
  }
}

function inferArray(values: LosslessJsonValue[], path: string[]): ArrayShape {
  if (values.length === 0) return { kind: 'array', element: { kind: 'unknown' } }
  const nonNull = values.filter((value) => value !== null)
  if (nonNull.length === 0) return { kind: 'array', element: { kind: 'null' } }
  let merged = inferShape(nonNull[0]!, [...path, 'Item'])
  for (const value of nonNull.slice(1)) {
    merged = mergeShapes(merged, inferShape(value, [...path, 'Item']))
    if (merged.kind === 'unknown') break
  }
  if (values.some((value) => value === null) && merged.kind !== 'unknown') {
    // Element nullability is represented by a union/nullable element in renderers.
    return { kind: 'array', element: { kind: 'unknown' } }
  }
  return { kind: 'array', element: merged }
}

function mergeShapes(left: Shape, right: Shape): Shape {
  if (left.kind !== right.kind) return { kind: 'unknown' }
  if (left.kind === 'object' && right.kind === 'object') {
    const rightFields = new Map(right.fields.map((field) => [field.jsonKey, field]))
    const leftKeys = new Set(left.fields.map((field) => field.jsonKey))
    const fields: FieldShape[] = left.fields.map((field) => {
      const match = rightFields.get(field.jsonKey)
      if (!match) return { ...field, optional: true }
      const onlyOneNull = field.shape.kind === 'null' !== (match.shape.kind === 'null')
      const nonNullShape = field.shape.kind === 'null' ? match.shape : match.shape.kind === 'null' ? field.shape : null
      return {
        jsonKey: field.jsonKey,
        shape: nonNullShape ?? mergeShapes(field.shape, match.shape),
        optional: field.optional || match.optional,
        nullable: field.nullable || match.nullable || onlyOneNull,
      }
    })
    for (const field of right.fields) {
      if (!leftKeys.has(field.jsonKey)) fields.push({ ...field, optional: true })
    }
    return { kind: 'object', name: left.name, fields }
  }
  if (left.kind === 'array' && right.kind === 'array') {
    return { kind: 'array', element: mergeShapes(left.element, right.element) }
  }
  return left
}

function collectObjects(shape: Shape, output: ObjectShape[] = [], seen = new Set<string>()): ObjectShape[] {
  if (shape.kind === 'object') {
    if (seen.has(shape.name)) return output
    seen.add(shape.name)
    output.push(shape)
    for (const field of shape.fields) collectObjects(field.shape, output, seen)
  } else if (shape.kind === 'array') collectObjects(shape.element, output, seen)
  return output
}

function renderTypeScript(root: Shape): string {
  const blocks = collectObjects(root).map((object) => {
    const names = assignNames(object.fields, 'typescript')
    const fields = object.fields.map((field, index) => {
      const property = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field.jsonKey)
        ? field.jsonKey
        : JSON.stringify(field.jsonKey)
      return `  ${property}${field.optional ? '?' : ''}: ${tsType(field.shape)}${field.nullable && field.shape.kind !== 'null' ? ' | null' : ''};`
    })
    void names
    return `export interface ${object.name} {\n${fields.join('\n')}\n}`
  })
  if (root.kind === 'array') blocks.unshift(`export type Root = ${tsType(root)};`)
  return blocks.join('\n\n')
}

function tsType(shape: Shape): string {
  switch (shape.kind) {
    case 'null': return 'null'
    case 'boolean': return 'boolean'
    case 'string': return 'string'
    case 'integer':
    case 'number': return 'number'
    case 'unknown': return 'unknown'
    case 'object': return shape.name
    case 'array': return `Array<${tsType(shape.element)}>`
  }
}

function renderJava(root: Shape): string {
  const needsInteger = hasKind(root, 'integer')
  const needsDecimal = hasKind(root, 'number')
  const imports = [
    ...(hasArray(root) ? ['import java.util.ArrayList;'] : []),
    ...(needsInteger ? ['import java.math.BigInteger;'] : []),
    ...(needsDecimal ? ['import java.math.BigDecimal;'] : []),
  ]
  const blocks = collectObjects(root).map((object) => {
    const names = assignNames(object.fields, 'java')
    const fields = object.fields.flatMap((field, index) => {
      const name = names[index]!
      const comments = []
      if (name !== field.jsonKey) comments.push(`    // JSON key: ${JSON.stringify(field.jsonKey)}`)
      if (field.optional) comments.push('    // Optional in the observed array sample.')
      comments.push(`    public ${javaType(field.shape)} ${name};`)
      return comments
    })
    return `${object.name === 'Root' ? 'public ' : ''}class ${object.name} {\n${fields.join('\n')}\n}`
  })
  if (root.kind === 'array') blocks.unshift(`public class Root extends ArrayList<${javaType(root.element)}> {\n}`)
  return [...imports, imports.length ? '' : [], ...blocks].flat().join('\n\n').replace(/\n{3,}/g, '\n\n')
}

function javaType(shape: Shape): string {
  switch (shape.kind) {
    case 'null':
    case 'unknown': return 'Object'
    case 'boolean': return 'Boolean'
    case 'string': return 'String'
    case 'integer': return 'BigInteger'
    case 'number': return 'BigDecimal'
    case 'object': return shape.name
    case 'array': return `ArrayList<${javaType(shape.element)}>`
  }
}

function renderGo(root: Shape): string {
  const needsJson = hasKind(root, 'integer') || hasKind(root, 'number')
  const blocks: string[] = []
  if (root.kind === 'array') blocks.push(`type Root []${goType(root.element)}`)
  for (const object of collectObjects(root)) {
    const names = assignNames(object.fields, 'go')
    const fields = object.fields.map((field, index) => {
      let type = goType(field.shape)
      if ((field.optional || field.nullable) && canPointerGo(field.shape)) type = `*${type}`
      return `\t${names[index]} ${type} \`json:${JSON.stringify(field.jsonKey)}\``
    })
    blocks.push(`type ${object.name} struct {\n${fields.join('\n')}\n}`)
  }
  return `${needsJson ? 'import "encoding/json"\n\n' : ''}${blocks.join('\n\n')}`
}

function goType(shape: Shape): string {
  switch (shape.kind) {
    case 'null':
    case 'unknown': return 'any'
    case 'boolean': return 'bool'
    case 'string': return 'string'
    case 'integer':
    case 'number': return 'json.Number'
    case 'object': return shape.name
    case 'array': return `[]${goType(shape.element)}`
  }
}

function canPointerGo(shape: Shape): boolean {
  return shape.kind !== 'unknown' && shape.kind !== 'null' && shape.kind !== 'array'
}

function renderKotlin(root: Shape): string {
  const needsInteger = hasKind(root, 'integer')
  const needsDecimal = hasKind(root, 'number')
  const imports = [
    ...(needsInteger ? ['import java.math.BigInteger'] : []),
    ...(needsDecimal ? ['import java.math.BigDecimal'] : []),
  ]
  const blocks = collectObjects(root).map((object) => {
    const names = assignNames(object.fields, 'kotlin')
    const fields = object.fields.flatMap((field, index) => {
      const name = names[index]!
      const lines = name === field.jsonKey ? [] : [`    // JSON key: ${JSON.stringify(field.jsonKey)}`]
      const nullable = field.optional || field.nullable
      const renderedType = kotlinType(field.shape)
      const nullableSuffix = nullable && !renderedType.endsWith('?') ? '?' : ''
      lines.push(`    val ${name}: ${renderedType}${nullableSuffix}${field.optional ? ' = null' : ''}`)
      return lines
    })
    return `data class ${object.name}(\n${fields.map((line, index) => {
      const isField = line.trimStart().startsWith('val ')
      if (!isField) return line
      const remainingFields = fields.slice(index + 1).some((entry) => entry.trimStart().startsWith('val '))
      return `${line}${remainingFields ? ',' : ''}`
    }).join('\n')}\n)`
  })
  if (root.kind === 'array') blocks.unshift(`typealias Root = List<${kotlinType(root.element)}>`)
  return [...imports, imports.length ? '' : [], ...blocks].flat().join('\n\n').replace(/\n{3,}/g, '\n\n')
}

function kotlinType(shape: Shape): string {
  switch (shape.kind) {
    case 'null':
    case 'unknown': return 'Any?'
    case 'boolean': return 'Boolean'
    case 'string': return 'String'
    case 'integer': return 'BigInteger'
    case 'number': return 'BigDecimal'
    case 'object': return shape.name
    case 'array': return `List<${kotlinType(shape.element)}>`
  }
}

function hasKind(shape: Shape, kind: PrimitiveKind): boolean {
  if (shape.kind === kind) return true
  if (shape.kind === 'array') return hasKind(shape.element, kind)
  if (shape.kind === 'object') return shape.fields.some((field) => hasKind(field.shape, kind))
  return false
}

function hasArray(shape: Shape): boolean {
  if (shape.kind === 'array') return true
  return shape.kind === 'object' && shape.fields.some((field) => hasArray(field.shape))
}

function assignObjectTypeNames(shape: Shape): void {
  const used = new Map<string, number>()
  const visit = (current: Shape) => {
    if (current.kind === 'array') {
      visit(current.element)
      return
    }
    if (current.kind !== 'object') return
    const count = (used.get(current.name) ?? 0) + 1
    used.set(current.name, count)
    if (count > 1) current.name = `${current.name}_${count}`
    current.fields.forEach((field) => visit(field.shape))
  }
  visit(shape)
}

function assignNames(fields: FieldShape[], language: JsonLocalLanguage): string[] {
  if (language === 'typescript') return fields.map((field) => field.jsonKey)
  const used = new Map<string, number>()
  return fields.map((field) => {
    const base = language === 'go'
      ? exportedName(field.jsonKey)
      : lowerCamelName(field.jsonKey, language)
    const count = (used.get(base) ?? 0) + 1
    used.set(base, count)
    return count === 1 ? base : `${base}_${count}`
  })
}

function typeName(path: string[]): string {
  const joined = path.map(exportedName).join('')
  return joined || 'Root'
}

function exportedName(value: string): string {
  const parts = value.normalize('NFKD').split(/[^A-Za-z0-9]+/).filter(Boolean)
  let name = parts.map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join('')
  if (!name) name = 'Field'
  if (/^\d/.test(name)) name = `Field${name}`
  return name
}

function lowerCamelName(value: string, language: 'java' | 'kotlin'): string {
  const exported = exportedName(value)
  let name = `${exported[0]?.toLowerCase() ?? 'f'}${exported.slice(1)}`
  const keywords = language === 'java' ? javaKeywords : kotlinKeywords
  if (keywords.has(name)) name = `_${name}`
  return name
}

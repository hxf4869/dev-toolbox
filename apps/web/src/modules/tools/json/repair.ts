import { parseLosslessJson, positionToLocation } from './lossless'
import { StructuredToolError } from './contracts'

const forbiddenWord = /^(?:undefined|NaN|Infinity|function|new)\b/
const bareKey = /^[A-Za-z_][A-Za-z0-9_-]*/

export function createLimitedRepair(text: string): { candidate: string; diff: string; changed: boolean } {
  let output = ''
  let index = 0
  let expectsKey = false

  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]

    if (char === '"') {
      const token = readDoubleQuoted(text, index)
      output += token.value
      index = token.end
      expectsKey = false
      continue
    }
    if (char === "'") {
      const token = readSingleQuoted(text, index)
      output += JSON.stringify(token.value)
      index = token.end
      expectsKey = false
      continue
    }
    if (char === '/' && next === '/') {
      index += 2
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end < 0) throw errorAt('JSON_REPAIR_UNSUPPORTED', '块注释没有结束。', text, index)
      index = end + 2
      continue
    }
    if (char === '/' || text.slice(index).startsWith('=>')) {
      throw errorAt('JSON_REPAIR_UNSUPPORTED', '正则、函数或其他 JavaScript 表达式不能修复为 JSON。', text, index)
    }
    const forbidden = forbiddenWord.exec(text.slice(index))
    if (forbidden) {
      throw errorAt('JSON_REPAIR_UNSUPPORTED', `${forbidden[0].trim()} 不是 JSON 值，已拒绝自动修复。`, text, index)
    }
    if (char === '{' || char === ',') {
      output += char
      expectsKey = true
      index += 1
      continue
    }
    if (char === ':') {
      output += char
      expectsKey = false
      index += 1
      continue
    }
    if (expectsKey && /[A-Za-z_]/.test(char)) {
      const match = bareKey.exec(text.slice(index))
      if (!match) throw errorAt('JSON_REPAIR_UNSUPPORTED', '未加引号的键不在受支持范围内。', text, index)
      let lookahead = index + match[0].length
      while (/\s/.test(text[lookahead] ?? '')) lookahead += 1
      if (text[lookahead] !== ':') {
        throw errorAt('JSON_REPAIR_UNSUPPORTED', '只允许修复对象中的普通未加引号键。', text, index)
      }
      output += JSON.stringify(match[0])
      index += match[0].length
      expectsKey = false
      continue
    }
    if (char === ',') {
      output += char
      index += 1
      continue
    }
    output += char
    index += 1
  }

  const candidate = removeTrailingCommas(output)
  parseLosslessJson(candidate)
  return { candidate, diff: createLineDiff(text, candidate), changed: candidate !== text }
}

function readDoubleQuoted(text: string, start: number): { value: string; end: number } {
  let index = start + 1
  while (index < text.length) {
    if (text[index] === '\\') index += 2
    else if (text[index] === '"') return { value: text.slice(start, index + 1), end: index + 1 }
    else index += 1
  }
  throw errorAt('JSON_REPAIR_UNSUPPORTED', '字符串没有结束。', text, start)
}

function readSingleQuoted(text: string, start: number): { value: string; end: number } {
  let value = ''
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === "'") return { value, end: index + 1 }
    if (char === '\n' || char === '\r') {
      throw errorAt('JSON_REPAIR_UNSUPPORTED', '单引号字符串不能包含未转义换行。', text, index)
    }
    if (char !== '\\') {
      value += char
      index += 1
      continue
    }
    const escaped = text[index + 1]
    if (escaped === "'") value += "'"
    else if (escaped === '"') value += '"'
    else if (escaped === '\\') value += '\\'
    else if (escaped === 'n') value += '\n'
    else if (escaped === 'r') value += '\r'
    else if (escaped === 't') value += '\t'
    else if (escaped === 'b') value += '\b'
    else if (escaped === 'f') value += '\f'
    else if (escaped === 'u') {
      const hex = text.slice(index + 2, index + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw errorAt('JSON_REPAIR_UNSUPPORTED', '单引号字符串包含无效 Unicode 转义。', text, index)
      }
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 4
    } else {
      throw errorAt('JSON_REPAIR_UNSUPPORTED', `不支持的单引号字符串转义：\\${escaped ?? ''}`, text, index)
    }
    index += 2
  }
  throw errorAt('JSON_REPAIR_UNSUPPORTED', '单引号字符串没有结束。', text, start)
}

function removeTrailingCommas(text: string): string {
  let output = ''
  let index = 0
  let quote = false
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      quote = !quote
      output += char
      index += 1
      continue
    }
    if (quote && char === '\\') {
      output += text.slice(index, index + 2)
      index += 2
      continue
    }
    if (!quote && char === ',') {
      let cursor = index + 1
      while (/\s/.test(text[cursor] ?? '')) cursor += 1
      if (text[cursor] === '}' || text[cursor] === ']') {
        index += 1
        continue
      }
    }
    output += char
    index += 1
  }
  return output
}

function createLineDiff(before: string, after: string): string {
  if (before === after) return '没有需要修复的差异。'
  const left = before.split('\n')
  const right = after.split('\n')
  const lines = ['--- 原输入', '+++ 修复候选']
  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    if (left[index] === right[index]) lines.push(`  ${left[index] ?? ''}`)
    else {
      if (left[index] !== undefined) lines.push(`- ${left[index]}`)
      if (right[index] !== undefined) lines.push(`+ ${right[index]}`)
    }
  }
  return lines.join('\n')
}

function errorAt(code: string, message: string, source: string, position: number): StructuredToolError {
  return new StructuredToolError({ code, message, position, ...positionToLocation(source, position) })
}

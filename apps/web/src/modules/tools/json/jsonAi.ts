import { isInteger, isLosslessNumber } from 'lossless-json'

import { StructuredToolError } from './contracts'
import {
  isObject,
  type LosslessJsonValue,
  parseLosslessJson,
  stringifyLossless,
  utf8Size,
} from './lossless'

export const JSON_AI_PUBLIC_REQUEST_LIMIT_BYTES = 256 * 1024

export type JsonAISendMode = 'structure' | 'full'

export interface JsonAIRequestDraft {
  body: string
  inputPreview: string
  inputBytes: number
  requestBytes: number
  mode: JsonAISendMode
}

type JsonAIStructure =
  | { kind: 'null' | 'boolean' | 'string' | 'integer' | 'number' }
  | { kind: 'array'; items: JsonAIStructure[] }
  | { kind: 'object'; properties: Record<string, JsonAIStructure> }

export function buildJsonAIStructure(source: string): JsonAIStructure {
  return describeValue(parseLosslessJson(source))
}

export function buildJsonAIRequestDraft(options: {
  providerId: string
  modelId: string
  targetLanguage: string
  mode: JsonAISendMode
  source: string
}): JsonAIRequestDraft {
  if (!isVisibleTargetLanguage(options.targetLanguage)) {
    throw new StructuredToolError({
      code: 'AI_TARGET_LANGUAGE_INVALID',
      message: '目标语言必须是 1–50 个可见字符，且首尾不能有空白。',
    })
  }
  if (!options.providerId || !options.modelId) {
    throw new StructuredToolError({
      code: 'AI_MODEL_REQUIRED',
      message: '请选择已启用且配置完整的 Provider 和模型。',
    })
  }

  let inputPreview: string
  if (options.mode === 'structure') {
    inputPreview = stringifyLossless(buildJsonAIStructure(options.source) as LosslessJsonValue, 0)
  } else {
    // Parsing validates strict JSON without converting number tokens to JavaScript number.
    parseLosslessJson(options.source)
    inputPreview = options.source
  }

  const body = [
    '{"providerId":', JSON.stringify(options.providerId),
    ',"modelId":', JSON.stringify(options.modelId),
    ',"targetLanguage":', JSON.stringify(options.targetLanguage),
    ',"mode":', JSON.stringify(options.mode),
    ',"input":', inputPreview,
    '}',
  ].join('')
  const requestBytes = utf8Size(body)
  if (requestBytes > JSON_AI_PUBLIC_REQUEST_LIMIT_BYTES) {
    throw new StructuredToolError({
      code: 'AI_PAYLOAD_TOO_LARGE',
      message: `发送请求为 ${requestBytes} 字节，超过 256 KiB 上限；请缩小样本，内容不会被截断。`,
    })
  }

  return {
    body,
    inputPreview,
    inputBytes: utf8Size(inputPreview),
    requestBytes,
    mode: options.mode,
  }
}

export function isVisibleTargetLanguage(value: string): boolean {
  const characters = Array.from(value)
  return value.trim() === value && characters.length >= 1 && characters.length <= 50 &&
    characters.every((character) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character))
}

function describeValue(value: LosslessJsonValue): JsonAIStructure {
  if (value === null) return { kind: 'null' }
  if (typeof value === 'boolean') return { kind: 'boolean' }
  if (typeof value === 'string') return { kind: 'string' }
  if (isLosslessNumber(value)) return { kind: isInteger(value.value) ? 'integer' : 'number' }
  if (Array.isArray(value)) {
    const unique = new Map<string, JsonAIStructure>()
    for (const item of value) {
      const structure = describeValue(item)
      const key = JSON.stringify(structure)
      if (!unique.has(key)) unique.set(key, structure)
    }
    return { kind: 'array', items: [...unique.values()] }
  }
  if (isObject(value)) {
    return {
      kind: 'object',
      properties: Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, describeValue(child)]),
      ),
    }
  }
  return { kind: 'null' }
}

export const MAX_BASE64_INPUT_BYTES = 5 * 1024 * 1024

export type Base64Variant = 'standard' | 'url'
export type Base64Operation = 'encode' | 'decode'

export class Base64InputError extends Error {
  constructor(
    readonly code:
      | 'BASE64_INPUT_TOO_LARGE'
      | 'BASE64_INVALID_CHARACTER'
      | 'BASE64_INVALID_LENGTH'
      | 'BASE64_MODE_MISMATCH'
      | 'BASE64_INVALID_UTF8',
    message: string,
    readonly position?: number,
  ) {
    super(message)
    this.name = 'Base64InputError'
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function assertBase64InputLimit(value: string): number {
  const bytes = utf8ByteLength(value)
  if (bytes > MAX_BASE64_INPUT_BYTES) {
    throw new Base64InputError(
      'BASE64_INPUT_TOO_LARGE',
      `输入为 ${formatBytes(bytes)}，超过 5 MiB 上限。请缩小文本后重试。`,
    )
  }
  return bytes
}

export function encodeBase64Text(value: string, variant: Base64Variant): string {
  assertBase64InputLimit(value)
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  const encoded = btoa(binary)
  return variant === 'url'
    ? encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    : encoded
}

export function decodeBase64Text(value: string, variant: Base64Variant): string {
  assertBase64InputLimit(value)
  const { compact, originalPositions } = removeAsciiWhitespace(value)
  if (!compact) return ''

  validateAlphabet(compact, originalPositions, variant)
  const normalized = normalizePadding(compact, variant)
  let binary: string
  try {
    binary = atob(
      variant === 'url'
        ? normalized.replaceAll('-', '+').replaceAll('_', '/')
        : normalized,
    )
  } catch {
    throw new Base64InputError(
      'BASE64_INVALID_LENGTH',
      'Base64 长度或尾部 padding 不合法，请检查最后一组字符。',
    )
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Base64InputError(
      'BASE64_INVALID_UTF8',
      '解码后的字节不是有效 UTF-8 文本。本工具不会把任意二进制强制转换成文本。',
    )
  }
}

export function transformBase64(
  value: string,
  operation: Base64Operation,
  variant: Base64Variant,
): string {
  return operation === 'encode' ? encodeBase64Text(value, variant) : decodeBase64Text(value, variant)
}

function removeAsciiWhitespace(value: string) {
  let compact = ''
  const originalPositions: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (/^[\t\n\v\f\r ]$/u.test(character)) continue
    compact += character
    originalPositions.push(index)
  }
  return { compact, originalPositions }
}

function validateAlphabet(
  compact: string,
  originalPositions: number[],
  variant: Base64Variant,
) {
  const mismatchPattern = variant === 'standard' ? /[-_]/u : /[+/]/u
  const mismatch = compact.search(mismatchPattern)
  if (mismatch >= 0) {
    const expected = variant === 'standard' ? '标准 Base64（+ 和 /）' : 'Base64URL（- 和 _）'
    throw new Base64InputError(
      'BASE64_MODE_MISMATCH',
      `第 ${originalPositions[mismatch]! + 1} 个字符与当前变体不匹配；当前选择的是${expected}。`,
      originalPositions[mismatch],
    )
  }

  const alphabet = variant === 'standard' ? /[A-Za-z0-9+/=]/u : /[A-Za-z0-9_\-=]/u
  for (let index = 0; index < compact.length; index += 1) {
    if (!alphabet.test(compact[index]!)) {
      throw new Base64InputError(
        'BASE64_INVALID_CHARACTER',
        `第 ${originalPositions[index]! + 1} 个字符不是当前 Base64 变体允许的字符。`,
        originalPositions[index],
      )
    }
  }

  const firstPadding = compact.indexOf('=')
  if (firstPadding >= 0) {
    const padding = compact.slice(firstPadding)
    if (!/^={1,2}$/u.test(padding)) {
      throw new Base64InputError(
        'BASE64_INVALID_LENGTH',
        `第 ${originalPositions[firstPadding]! + 1} 个字符后的 padding 位置或数量不合法。`,
        originalPositions[firstPadding],
      )
    }
  }
}

function normalizePadding(value: string, variant: Base64Variant): string {
  if (variant === 'standard') {
    if (value.length % 4 !== 0) {
      throw new Base64InputError(
        'BASE64_INVALID_LENGTH',
        '标准 Base64 长度必须是 4 的倍数；请检查是否缺少尾部 padding。',
      )
    }
    return value
  }

  const withoutPadding = value.replace(/=+$/u, '')
  const remainder = withoutPadding.length % 4
  if (remainder === 1) {
    throw new Base64InputError(
      'BASE64_INVALID_LENGTH',
      'Base64URL 有效字符数除以 4 不能余 1，请检查输入是否缺失字符。',
    )
  }
  const requiredPadding = remainder === 0 ? 0 : 4 - remainder
  const suppliedPadding = value.length - withoutPadding.length
  if (suppliedPadding > 0 && suppliedPadding !== requiredPadding) {
    throw new Base64InputError(
      'BASE64_INVALID_LENGTH',
      'Base64URL 尾部 padding 数量与内容长度不匹配。',
    )
  }
  return withoutPadding + '='.repeat(requiredPadding)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

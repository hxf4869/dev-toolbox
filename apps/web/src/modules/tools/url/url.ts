export const MAX_URL_INPUT_BYTES = 1024 * 1024

export type UrlOperation = 'encode' | 'decode'
export type UrlScope = 'url' | 'component'

export interface QueryRow {
  key: string
  value: string
  hasEquals: boolean
}

export interface ParsedUrl {
  original: string
  scheme: string
  host: string
  port: string
  path: string
  query: string
  fragment: string
  queryRows: QueryRow[]
  prefixBeforeQuery: string
  hasQuery: boolean
  hasFragment: boolean
}

export class UrlInputError extends Error {
  constructor(
    readonly code:
      | 'URL_INPUT_TOO_LARGE'
      | 'URL_INVALID_PERCENT_ESCAPE'
      | 'URL_INVALID_UTF8'
      | 'URL_INVALID_TEXT',
    message: string,
    readonly position?: number,
  ) {
    super(message)
    this.name = 'UrlInputError'
  }
}

export function urlUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function assertUrlInputLimit(value: string): number {
  const bytes = urlUtf8ByteLength(value)
  if (bytes > MAX_URL_INPUT_BYTES) {
    throw new UrlInputError(
      'URL_INPUT_TOO_LARGE',
      `输入为 ${formatUrlBytes(bytes)}，超过 1 MiB 上限。请缩小文本后重试。`,
    )
  }
  return bytes
}

export function transformUrlText(value: string, operation: UrlOperation, scope: UrlScope): string {
  assertUrlInputLimit(value)
  try {
    if (operation === 'encode') {
      return scope === 'url' ? encodeURI(value) : encodeURIComponent(value)
    }
    validatePercentEscapes(value)
    return scope === 'url' ? decodeURI(value) : decodeURIComponent(value)
  } catch (error) {
    if (error instanceof UrlInputError) throw error
    if (operation === 'decode') {
      throw new UrlInputError(
        'URL_INVALID_UTF8',
        '百分号字节序列不是有效 UTF-8，无法按当前模式解码。请检查相邻的 % 转义。',
        firstPercentPosition(value),
      )
    }
    throw new UrlInputError(
      'URL_INVALID_TEXT',
      '输入包含无法进行 URL 编码的孤立 UTF-16 代理字符，请修正原文。',
    )
  }
}

export function validatePercentEscapes(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue
    const pair = value.slice(index + 1, index + 3)
    if (!/^[0-9A-Fa-f]{2}$/u.test(pair)) {
      throw new UrlInputError(
        'URL_INVALID_PERCENT_ESCAPE',
        `第 ${index + 1} 个字符处的 % 转义不完整；% 后必须紧跟两个十六进制字符。`,
        index,
      )
    }
    index += 2
  }
}

export function parseUrlPreserving(value: string): ParsedUrl {
  assertUrlInputLimit(value)
  validatePercentEscapes(value)
  const fragmentIndex = value.indexOf('#')
  const hasFragment = fragmentIndex >= 0
  const beforeFragment = hasFragment ? value.slice(0, fragmentIndex) : value
  const fragment = hasFragment ? value.slice(fragmentIndex + 1) : ''
  const queryIndex = beforeFragment.indexOf('?')
  const hasQuery = queryIndex >= 0
  const prefixBeforeQuery = hasQuery ? beforeFragment.slice(0, queryIndex) : beforeFragment
  const query = hasQuery ? beforeFragment.slice(queryIndex + 1) : ''

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(prefixBeforeQuery)
  const scheme = schemeMatch?.[1] ?? ''
  let remaining = schemeMatch ? prefixBeforeQuery.slice(schemeMatch[0].length) : prefixBeforeQuery
  let authority = ''
  let path = remaining
  if (remaining.startsWith('//')) {
    remaining = remaining.slice(2)
    const pathIndex = remaining.search(/\//u)
    authority = pathIndex >= 0 ? remaining.slice(0, pathIndex) : remaining
    path = pathIndex >= 0 ? remaining.slice(pathIndex) : ''
  }

  const authorityWithoutUserInfo = authority.slice(authority.lastIndexOf('@') + 1)
  const { host, port } = splitHostPort(authorityWithoutUserInfo)
  return {
    original: value,
    scheme,
    host,
    port,
    path,
    query,
    fragment,
    queryRows: parseQueryRows(query, hasQuery),
    prefixBeforeQuery,
    hasQuery,
    hasFragment,
  }
}

export function parseQueryRows(query: string, hasQuery = true): QueryRow[] {
  if (!hasQuery || query === '') return []
  return query.split('&').map((entry) => {
    const equals = entry.indexOf('=')
    return equals < 0
      ? { key: entry, value: '', hasEquals: false }
      : { key: entry.slice(0, equals), value: entry.slice(equals + 1), hasEquals: true }
  })
}

export function serializeQueryRows(rows: QueryRow[]): string {
  return rows
    .map((row) => (row.hasEquals ? `${row.key}=${row.value}` : row.key))
    .join('&')
}

export function rebuildUrl(parsed: ParsedUrl, rows: QueryRow[]): string {
  const includeQuery = parsed.hasQuery || rows.length > 0
  const queryPart = includeQuery ? `?${serializeQueryRows(rows)}` : ''
  const fragmentPart = parsed.hasFragment ? `#${parsed.fragment}` : ''
  const rebuilt = `${parsed.prefixBeforeQuery}${queryPart}${fragmentPart}`
  assertUrlInputLimit(rebuilt)
  validatePercentEscapes(rebuilt)
  return rebuilt
}

function splitHostPort(authority: string): { host: string; port: string } {
  if (authority.startsWith('[')) {
    const closing = authority.indexOf(']')
    if (closing >= 0) {
      return {
        host: authority.slice(0, closing + 1),
        port: authority[closing + 1] === ':' ? authority.slice(closing + 2) : '',
      }
    }
  }
  const lastColon = authority.lastIndexOf(':')
  if (lastColon >= 0 && authority.indexOf(':') === lastColon) {
    return { host: authority.slice(0, lastColon), port: authority.slice(lastColon + 1) }
  }
  return { host: authority, port: '' }
}

function firstPercentPosition(value: string): number | undefined {
  const position = value.indexOf('%')
  return position >= 0 ? position : undefined
}

export function formatUrlBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

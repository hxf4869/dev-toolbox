/**
 * 技术内容保护与占位符还原（浏览器本地，docs/09 §8.4、docs/11 §10.2）。
 *
 * 只把自然语言片段发给阿里云机器翻译；围栏代码、内联代码、URL、路径、
 * 命令行和 Markdown 结构性标记替换为带本次运行随机标识的占位符。
 * 还原前必须校验占位符的数量、标识与顺序；失败时该片段保留原文并返回
 * 客户端状态 PLACEHOLDER_RESTORE_FAILED，不用 AI 猜测恢复。
 */

export const PLACEHOLDER_PREFIX = '__DT_'
export const PLACEHOLDER_SUFFIX = '__'

/** 匹配任意 DT 占位符形状（包括用户原文里碰巧出现的同形字符串）。 */
const PLACEHOLDER_SHAPE = /__DT_[A-Za-z0-9]+_\d+__/g

export interface PlaceholderSpan {
  start: number
  end: number
}

export interface ProtectionResult {
  runId: string
  /** 替换后的完整文本，占位符已就位。 */
  text: string
  /** 占位符在 text 中的区间（升序），分块时视为不可切割的原子。 */
  placeholderSpans: PlaceholderSpan[]
  /** 占位符 → 被保护的原始内容。 */
  segmentMap: Map<string, string>
}

export type RestoreFailureReason =
  | 'placeholder-missing'
  | 'placeholder-unknown'
  | 'placeholder-order-changed'
  | 'placeholder-duplicated'

export interface RestoreSuccess {
  ok: true
  text: string
}

export interface RestoreFailure {
  ok: false
  reason: RestoreFailureReason
  code: 'PLACEHOLDER_RESTORE_FAILED'
  /** 校验失败时保守返回的该片段原文（按本地账本逐字重建）。 */
  text: string
}

export type RestoreResult = RestoreSuccess | RestoreFailure

type RandomIdentifier = (length: number) => string

function defaultRandomIdentifier(length: number): string {
  const bytes = new Uint8Array(length)
  const crypto = globalThis.crypto
  if (crypto && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  let value = ''
  for (const byte of bytes) value += (byte % 16).toString(16).toUpperCase()
  return value
}

/**
 * 生成占位符随机标识，并保证 `__DT_<id>_` 前缀不出现在用户原文中，
 * 因此真实占位符不会与原文里的同形字符串碰撞。
 */
export function createRunIdentifier(
  existingText?: string,
  random: RandomIdentifier = defaultRandomIdentifier,
): string {
  let identifier = random(6)
  if (!existingText) return identifier
  while (existingText.includes(`${PLACEHOLDER_PREFIX}${identifier}_`)) {
    identifier = `${identifier}${random(1)}`
  }
  return identifier
}

/**
 * 单遍扫描原文，按优先级识别技术片段。关键点：所有匹配都在“原始文本”上
 * 一次性完成，插入占位符后不再重扫，因此 `__` 等标记规则不会误伤占位符。
 */
const TECHNICAL_CONTENT_PATTERN = new RegExp(
  [
    // 1. 围栏代码块（含未闭合时保护到文末）。
    '(?<fence>(?:```+|~~~+)[^\\n]*\\n[\\s\\S]*?(?:```+|~~~+)|(?:```+|~~~+)[^\\n]*\\n[\\s\\S]*$)',
    // 2. 内联代码。
    '(?<inlineCode>`+[^`\\n]*`+)',
    // 3. URL（排除空白、引号、括号与 CJK 字符，收尾标点在扫描后剥离）。
    '(?<url>https?://[^\\s<>"\'`()\\[\\]{}\\u3000-\\u9fff\\uff00-\\uffef]+)',
    // 4. Windows 路径。
    '(?<windowsPath>[A-Za-z]:[\\\\/][A-Za-z0-9._~+@%\\\\/-]*)',
    // 5. 家目录路径（~/…）。
    '(?<homePath>~/[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*/?)',
    // 6. Unix 绝对路径（至少两段，避免把单个 /word 当路径）。
    '(?<unixPath>(?:/[A-Za-z0-9._+-]+){2,}/?)',
    // 7. 相对路径（./…、../…）。
    '(?<relativePath>\\.{1,2}/[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*/?)',
    // 8. 命令行：行首 $ 提示符或常见命令开头的整行。
    '(?<command>^[ \\t]*[$]\\s[^\\n]*|^[ \\t]*(?:npm|pnpm|yarn|npx|git|docker|docker-compose|kubectl|helm|go|cargo|rustup|pip|pip3|python|python3|node|deno|bun|curl|wget|make|cmake|gcc|clang|java|mvn|gradle|dotnet|php|ruby|brew|apt|apt-get|yum|dnf|pacman|systemctl|service|ssh|scp|rsync|tar|unzip|gzip|chmod|chown|mkdir|rmdir|rm|cp|mv|ln|touch|cat|less|head|tail|grep|awk|sed|find|xargs|export|source|sudo|cd|ls|pwd|which|whereis|env|printenv|ffmpeg|openssl|psql|mysql|redis-cli|seq|date|echo)\\b[^\\n]*)',
    // 9. Markdown 标题标记。
    '(?<heading>^#{1,6}(?=\\s))',
    // 10. 列表标记（含有序列表）。
    '(?<listMarker>^[ \\t]*(?:[-*+]|\\d{1,9}[.)])(?=\\s))',
    // 11. 引用标记。
    '(?<blockquote>^[ \\t]*>(?=[ \\t]|$))',
    // 12. 主题分隔线整行。
    '(?<thematicBreak>^ {0,3}(?:-{3,}|\\*{3,}|_{3,})[ \\t]*$)',
    // 13. 粗体分隔符（成对的 ** / __，单字符斜体不保护以免误伤 snake_case）。
    '(?<boldAsterisk>\\*{2,})',
    '(?<boldUnderscore>_{2,})',
  ].join('|'),
  'gm',
)

const URL_TRAILING_PUNCTUATION = '.,;:!?)]}>,，。；：！？）】》」』”’'

export function protectTechnicalContent(source: string, runId: string): ProtectionResult {
  const segmentMap = new Map<string, string>()
  const placeholderSpans: PlaceholderSpan[] = []
  let output = ''
  let sequence = 0
  let cursor = 0

  for (const match of source.matchAll(TECHNICAL_CONTENT_PATTERN)) {
    const groups = match.groups ?? {}
    let start = match.index
    let end = start + match[0].length
    if (groups.url) {
      while (end > start && URL_TRAILING_PUNCTUATION.includes(source[end - 1])) end -= 1
    }
    if (end <= start) continue

    output += source.slice(cursor, start)
    const placeholder = formatPlaceholder(runId, sequence)
    sequence += 1
    segmentMap.set(placeholder, source.slice(start, end))
    placeholderSpans.push({ start: output.length, end: output.length + placeholder.length })
    output += placeholder
    cursor = end
  }
  output += source.slice(cursor)

  return { runId, text: output, placeholderSpans, segmentMap }
}

export function formatPlaceholder(runId: string, sequence: number): string {
  return `${PLACEHOLDER_PREFIX}${runId}_${String(sequence).padStart(3, '0')}${PLACEHOLDER_SUFFIX}`
}

function listPlaceholderShapedTokens(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_SHAPE)].map((match) => match[0])
}

/**
 * 还原单个片段。校验规则：译文中的占位符形状 token 必须与发送前
 * SourceText 中的 token 完全一致（数量、标识、顺序、无重复、无改写）。
 * 用户原文里自带的同形字符串会同时出现在两侧，因此不会误判。
 */
export function restoreTranslatedChunk(options: {
  sourceChunk: string
  translatedChunk: string
  runId: string
  segmentMap: Map<string, string>
}): RestoreResult {
  const { sourceChunk, translatedChunk, runId, segmentMap } = options
  const expected = listPlaceholderShapedTokens(sourceChunk)
  const actual = listPlaceholderShapedTokens(translatedChunk)

  if (actual.length < expected.length) {
    return failure('placeholder-missing', sourceChunk, runId, segmentMap)
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] === expected[index]) continue
    // token 被改写为未知标识，或在正确集合内但顺序/数量变化（含重复）。
    const reason = expected.includes(actual[index])
      ? 'placeholder-order-changed'
      : 'placeholder-unknown'
    if (reason === 'placeholder-order-changed' && actual.indexOf(actual[index]) !== index) {
      return failure('placeholder-duplicated', sourceChunk, runId, segmentMap)
    }
    return failure(reason, sourceChunk, runId, segmentMap)
  }

  const restored = translatedChunk.replace(PLACEHOLDER_SHAPE, (token) => {
    const original = segmentMap.get(token)
    return original === undefined ? token : original
  })
  return { ok: true, text: restored }
}

/**
 * 用本地账本把保护后的片段逐字重建为原文（不依赖上游返回）。
 * 用于还原失败时“保留原文”。
 */
export function reconstructOriginalChunk(
  protectedChunk: string,
  segmentMap: Map<string, string>,
): string {
  return protectedChunk.replace(PLACEHOLDER_SHAPE, (token) => {
    const original = segmentMap.get(token)
    return original === undefined ? token : original
  })
}

function failure(
  reason: RestoreFailureReason,
  sourceChunk: string,
  runId: string,
  segmentMap: Map<string, string>,
): RestoreFailure {
  return {
    ok: false,
    reason,
    code: 'PLACEHOLDER_RESTORE_FAILED',
    text: reconstructOriginalChunk(sourceChunk, segmentMap),
  }
}

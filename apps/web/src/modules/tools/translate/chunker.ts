/**
 * UTF-16 分块与运行上限（docs/09 §8.1、docs/11 §10.1）。
 *
 * 先保护再分块：占位符是不可切割的原子；边界优先取句末/段末安全位置，
 * 相邻短段在 4999 units 内尽量合并；无安全边界时使用硬边界，但绝不从
 * surrogate pair 中间或占位符内部切断。超限在 preflight 前整体拒绝，
 * 不截断、不拆第二次运行。
 */

import type { PlaceholderSpan } from './protection'

export const MAX_CHUNK_UTF16_UNITS = 4999
export const MAX_RUN_UTF16_UNITS = 950_000
export const MAX_RUN_CHUNKS = 191

export type RunLimitViolation =
  | { code: 'ORIGINAL_TOO_LONG'; actual: number; limit: number }
  | { code: 'PAYLOAD_TOO_LARGE'; actual: number; limit: number }
  | { code: 'TOO_MANY_CHUNKS'; actual: number; limit: number }

/** 句末安全边界字符：其后允许切块。 */
const SENTENCE_TERMINATORS = new Set(['。', '！', '？', '；', '!', '?', ';'])

function isHighSurrogate(codeUnit: string | undefined): boolean {
  return codeUnit !== undefined && codeUnit >= '\uD800' && codeUnit <= '\uDBFF'
}

function isLowSurrogate(codeUnit: string | undefined): boolean {
  return codeUnit !== undefined && codeUnit >= '\uDC00' && codeUnit <= '\uDFFF'
}

interface BoundaryContext {
  text: string
  spans: readonly PlaceholderSpan[]
}

/** 位置 p 处切块是否合法：不在占位符内部、不在 surrogate pair 中间。 */
function canSplitAt(context: BoundaryContext, position: number): boolean {
  if (position <= 0 || position >= context.text.length) return false
  for (const span of context.spans) {
    if (position > span.start && position < span.end) return false
    if (span.start >= position) break
  }
  return !(isHighSurrogate(context.text[position - 1]) && isLowSurrogate(context.text[position]))
}

/** 单遍扫描收集安全边界位置（升序、去重）。占位符内部不产生边界。 */
function collectSafeBoundaries(text: string, spans: readonly PlaceholderSpan[]): number[] {
  const boundaries: number[] = []
  let spanIndex = 0
  let index = 0
  while (index < text.length) {
    const span = spans[spanIndex]
    if (span && index >= span.start) {
      index = span.end
      spanIndex += 1
      continue
    }
    const codeUnit = text[index]
    if (
      SENTENCE_TERMINATORS.has(codeUnit) ||
      codeUnit === '\n' ||
      (codeUnit === '.' && isSentencePeriod(text, index + 1))
    ) {
      const boundary = index + 1
      if (boundaries.at(-1) !== boundary) boundaries.push(boundary)
    }
    index += 1
  }
  return boundaries
}

/** 句点后跟空白/换行/结尾才算句边界，避免缩写与版本号被切开。 */
function isSentencePeriod(text: string, next: number): boolean {
  if (next >= text.length) return true
  const codeUnit = text[next]
  return codeUnit === ' ' || codeUnit === '\n' || codeUnit === '\t' || codeUnit === '\r'
}

/** 在 (start, start + limit] 内找最大的合法硬边界。 */
function findHardBoundary(context: BoundaryContext, start: number, limit: number): number {
  for (let position = Math.min(start + limit, context.text.length); position > start; position -= 1) {
    if (canSplitAt(context, position)) return position
  }
  return -1
}

/**
 * 把保护后的文本切成 1–4999 UTF-16 units 的非空片段。
 * 空白-only 片段（空段落）被跳过。
 */
export function chunkProtectedText(text: string, spans: readonly PlaceholderSpan[]): string[] {
  if (text.length === 0) return []

  const context: BoundaryContext = { text, spans }
  const boundaries = collectSafeBoundaries(text, spans)
  const chunks: string[] = []
  let start = 0
  let boundaryCursor = 0
  // base 只前进不回退：boundaries[base] 之前必然 <= start，避免长文本回退扫描退化。
  let base = 0

  while (start < text.length) {
    if (text.length - start <= MAX_CHUNK_UTF16_UNITS) {
      pushChunk(chunks, text.slice(start))
      break
    }
    while (base < boundaries.length && boundaries[base] <= start) base += 1
    boundaryCursor = Math.max(boundaryCursor, base)
    while (boundaryCursor < boundaries.length && boundaries[boundaryCursor] <= start + MAX_CHUNK_UTF16_UNITS) {
      boundaryCursor += 1
    }
    let end = -1
    // 取 limit 内最大的安全边界（boundaries 升序，回退扫描被 base 截断）。
    for (let index = boundaryCursor - 1; index >= base; index -= 1) {
      if (boundaries[index] > start) {
        end = boundaries[index]
        // 回退 cursor，让该边界可以被重新消费为 chunk 终点。
        boundaryCursor = index
        break
      }
    }
    if (end <= start) {
      end = findHardBoundary(context, start, MAX_CHUNK_UTF16_UNITS)
    }
    if (end <= start) {
      // 理论不可达：占位符长度远小于 4999，总能找到合法硬边界。
      pushChunk(chunks, text.slice(start))
      break
    }
    pushChunk(chunks, text.slice(start, end))
    start = end
  }

  return chunks.filter((chunk) => chunk.trim().length > 0)
}

function pushChunk(chunks: string[], candidate: string): void {
  if (candidate.length > 0) chunks.push(candidate)
}

/** 逐项校验单次运行上限；返回空数组表示可以进入 preflight。 */
export function checkRunLimits(
  originalUnits: number,
  chunks: readonly string[],
): RunLimitViolation[] {
  const violations: RunLimitViolation[] = []
  if (originalUnits > MAX_RUN_UTF16_UNITS) {
    violations.push({ code: 'ORIGINAL_TOO_LONG', actual: originalUnits, limit: MAX_RUN_UTF16_UNITS })
  }
  const totalUnits = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  if (totalUnits > MAX_RUN_UTF16_UNITS) {
    violations.push({ code: 'PAYLOAD_TOO_LARGE', actual: totalUnits, limit: MAX_RUN_UTF16_UNITS })
  }
  if (chunks.length > MAX_RUN_CHUNKS) {
    violations.push({ code: 'TOO_MANY_CHUNKS', actual: chunks.length, limit: MAX_RUN_CHUNKS })
  }
  return violations
}

export function countChunkUnits(chunks: readonly string[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0)
}

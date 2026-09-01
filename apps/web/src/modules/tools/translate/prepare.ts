/**
 * 翻译运行准备管线：先保护技术片段，再按 UTF-16 分块并校验单次运行上限
 * （docs/09 §8.1 第 2–3 步、docs/11 §10.1）。
 *
 * 该函数是同步纯函数：调用方负责用防抖/代际标记避免在每次按键上重复执行
 * 大输入计算（TranslateView 的有界主线程实现，见其说明）。
 */

import { checkRunLimits, chunkProtectedText, type RunLimitViolation } from './chunker'
import { createRunIdentifier, protectTechnicalContent, type PlaceholderSpan } from './protection'

export interface PreparedChunkSeed {
  index: number
  units: number
  sourceText: string
}

export interface PreparedTranslationRun {
  /** 本次运行的占位符随机标识；保护关闭时为空字符串。 */
  runId: string
  protectionEnabled: boolean
  /** 保护后的完整文本（占位符已就位），仅用于发送范围预览，不直接发送。 */
  protectedText: string
  placeholderSpans: PlaceholderSpan[]
  segmentMap: Map<string, string>
  chunks: PreparedChunkSeed[]
  /** 用户原文的 UTF-16 units（保护前）。 */
  originalUnits: number
  /** 最终 payload（保护后 SourceText 总和）的 UTF-16 units，即预计计费数。 */
  payloadUnits: number
  violations: RunLimitViolation[]
}

export function prepareTranslationRun(
  source: string,
  protectionEnabled: boolean,
): PreparedTranslationRun {
  const originalUnits = source.length
  if (!protectionEnabled) {
    const chunks = chunkProtectedText(source, [])
    return {
      runId: '',
      protectionEnabled: false,
      protectedText: source,
      placeholderSpans: [],
      segmentMap: new Map<string, string>(),
      chunks: chunks.map((sourceText, index) => ({ index, units: sourceText.length, sourceText })),
      originalUnits,
      payloadUnits: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      violations: checkRunLimits(originalUnits, chunks),
    }
  }

  const runId = createRunIdentifier(source)
  const protection = protectTechnicalContent(source, runId)
  const chunks = chunkProtectedText(protection.text, protection.placeholderSpans)
  return {
    runId,
    protectionEnabled: true,
    protectedText: protection.text,
    placeholderSpans: protection.placeholderSpans,
    segmentMap: protection.segmentMap,
    chunks: chunks.map((sourceText, index) => ({ index, units: sourceText.length, sourceText })),
    originalUnits,
    payloadUnits: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    violations: checkRunLimits(originalUnits, chunks),
  }
}

/** 违规 → 用户可读文案（超限在 preflight 前整体拒绝，不截断）。 */
export function describeRunViolation(violation: RunLimitViolation): string {
  if (violation.code === 'ORIGINAL_TOO_LONG') {
    return `原文 ${violation.actual.toLocaleString('zh-Hans-CN')} UTF-16 units，超过单次运行上限 ${violation.limit.toLocaleString('zh-Hans-CN')}；不会截断，也不会拆成第二次运行。`
  }
  if (violation.code === 'PAYLOAD_TOO_LARGE') {
    return `保护后预计计费 ${violation.actual.toLocaleString('zh-Hans-CN')} UTF-16 units，超过单次运行上限 ${violation.limit.toLocaleString('zh-Hans-CN')}；请减少技术片段或缩短文本。`
  }
  return `合并短段后仍为 ${violation.actual} 个片段，超过单次运行上限 ${violation.limit} 个；请拆成多次显式运行。`
}

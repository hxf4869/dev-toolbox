import { describe, expect, it } from 'vitest'

import {
  checkRunLimits,
  chunkProtectedText,
  countChunkUnits,
  MAX_RUN_CHUNKS,
  MAX_RUN_UTF16_UNITS,
} from './chunker'
import { protectTechnicalContent } from './protection'
import { prepareTranslationRun } from './prepare'

function isHighSurrogate(unit: string | undefined): boolean {
  return unit !== undefined && unit >= '\uD800' && unit <= '\uDBFF'
}

function isLowSurrogate(unit: string | undefined): boolean {
  return unit !== undefined && unit >= '\uDC00' && unit <= '\uDFFF'
}

/** 拼回后必须与原文一致，且任何相邻 chunk 的边界都不落在 surrogate pair 中间。 */
function expectSafeChunks(text: string, chunks: string[]): void {
  expect(chunks.join('')).toBe(text)
  for (const chunk of chunks) {
    expect(chunk.length).toBeGreaterThan(0)
    expect(chunk.length).toBeLessThanOrEqual(4999)
    expect(isHighSurrogate(chunk.at(-1))).toBe(false)
    expect(isLowSurrogate(chunk.at(0))).toBe(false)
  }
}

describe('UTF-16 分块边界', () => {
  it('4999 units 文本保持单片段', () => {
    const text = 'a'.repeat(4999)
    expect(chunkProtectedText(text, [])).toEqual([text])
  })

  it('5000 units 文本按硬边界拆为两个不超过 4999 的片段', () => {
    const chunks = chunkProtectedText('a'.repeat(5000), [])
    expect(chunks).toHaveLength(2)
    expect(chunks.map((chunk) => chunk.length)).toEqual([4999, 1])
  })

  it('绝不从 surrogate pair 中间切断', () => {
    const text = '𝐀'.repeat(2500) // 5000 UTF-16 units，全部是代理对
    const chunks = chunkProtectedText(text, [])
    expectSafeChunks(text, chunks)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('长 emoji 文本与 CJK 混排拼回后逐字一致', () => {
    const text = `第一段😀😀😀。${'好'.repeat(6000)}第二段🎉结尾。`
    expectSafeChunks(text, chunkProtectedText(text, []))
  })

  it('相邻短段在 4999 units 内尽量合并', () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `第${index}段内容。`).join('\n')
    const chunks = chunkProtectedText(paragraphs, [])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(paragraphs)
  })

  it('空段落（纯空白片段）被跳过', () => {
    const text = `${'x'.repeat(4999)}\n\n\n${'y'.repeat(4999)}`
    const chunks = chunkProtectedText(text, [])
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('x'.repeat(4999))
    expect(chunks[1]).toBe('y'.repeat(4999))
  })

  it('占位符不会被从中间切断', () => {
    const source = `${'前'.repeat(4000)} \`npm run build\` ${'后'.repeat(4000)}`
    const protection = protectTechnicalContent(source, 'A7F3C2')
    expect(protection.text.length).toBeGreaterThan(4999)
    const chunks = chunkProtectedText(protection.text, protection.placeholderSpans)
    expectSafeChunks(protection.text, chunks)
    for (const placeholder of protection.segmentMap.keys()) {
      expect(chunks.some((chunk) => chunk.includes(placeholder))).toBe(true)
    }
  })
})

describe('单次运行上限（preflight 前拒绝）', () => {
  it('原文与 payload 各恰为 950,000 units 时通过', () => {
    const chunks = ['a'.repeat(4999), 'b'.repeat(1)]
    const filler = 'c'.repeat(950_000 - countChunkUnits(chunks))
    const all = [...chunks, filler]
    expect(countChunkUnits(all)).toBe(950_000)
    expect(checkRunLimits(950_000, all)).toEqual([])
  })

  it('原文超过 950,000 units 时报 ORIGINAL_TOO_LONG（不截断）', () => {
    const violations = checkRunLimits(950_001, ['a'.repeat(4999)])
    expect(violations).toContainEqual(
      expect.objectContaining({ code: 'ORIGINAL_TOO_LONG', actual: 950_001, limit: 950_000 }),
    )
  })

  it('保护后 payload 超过 950,000 units 时报 PAYLOAD_TOO_LARGE，即使原文未超', () => {
    // 每个 URL 13 units 被替换为 17 units 占位符：原文远小于上限，保护后超限。
    const line = 'https://a.io\n'
    const source = line.repeat(60_000) // 840,000 units 原文
    const prepared = prepareTranslationRun(source, true)
    expect(prepared.originalUnits).toBeLessThanOrEqual(MAX_RUN_UTF16_UNITS)
    expect(prepared.violations).toContainEqual(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }))
  })

  it('保护关闭时 payload 等于原文 units', () => {
    const source = 'https://a.io\n'.repeat(10)
    const prepared = prepareTranslationRun(source, false)
    expect(prepared.payloadUnits).toBe(source.length)
    expect(prepared.runId).toBe('')
    expect(prepared.violations).toEqual([])
  })

  it('合并短段后仍为 191 个片段时通过；192 个时报 TOO_MANY_CHUNKS', () => {
    const block = (units: number) => 'a'.repeat(units - 1) + '\n'
    const atLimit = Array.from({ length: 191 }, () => block(4973)) // 191 × 4973 = 949,843
    const preparedAt = prepareTranslationRun(atLimit.join(''), true)
    expect(preparedAt.chunks).toHaveLength(MAX_RUN_CHUNKS)
    expect(preparedAt.violations).toEqual([])

    const overLimit = Array.from({ length: 192 }, () => block(2600)) // 192 片段，units 499,200
    const preparedOver = prepareTranslationRun(overLimit.join(''), true)
    expect(preparedOver.chunks.length).toBeGreaterThan(MAX_RUN_CHUNKS)
    expect(preparedOver.violations).toContainEqual(
      expect.objectContaining({ code: 'TOO_MANY_CHUNKS', limit: 191 }),
    )
  })
})

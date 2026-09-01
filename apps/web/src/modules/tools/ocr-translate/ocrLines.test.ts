import { describe, expect, it } from 'vitest'

import { extractOcrLines, isLowConfidenceLine, LOW_CONFIDENCE_THRESHOLD } from './ocrLines'

describe('extractOcrLines（blocks 结构化提取）', () => {
  it('从 blocks/paragraphs/lines 提取行与置信度', () => {
    const page = {
      text: 'a\nb',
      blocks: [
        {
          paragraphs: [
            { lines: [{ text: 'Graphite Workbench', confidence: 92 }] },
            { lines: [{ text: 'D3veloper Tools', confidence: 41 }] },
          ],
        },
      ],
    }
    expect(extractOcrLines(page)).toEqual([
      { text: 'Graphite Workbench', confidence: 92 },
      { text: 'D3veloper Tools', confidence: 41 },
    ])
  })

  it('blocks 缺失时退回按整段文本折行且置信度为 null', () => {
    const lines = extractOcrLines({ text: '第一行\n第二行' })
    expect(lines).toEqual([
      { text: '第一行', confidence: null },
      { text: '第二行', confidence: null },
    ])
  })
})

describe('isLowConfidenceLine（阈值与 null 处理）', () => {
  it('置信度低于阈值标记为低置信度', () => {
    expect(isLowConfidenceLine({ text: 'x', confidence: LOW_CONFIDENCE_THRESHOLD - 1 })).toBe(true)
    expect(isLowConfidenceLine({ text: 'x', confidence: LOW_CONFIDENCE_THRESHOLD })).toBe(false)
    expect(isLowConfidenceLine({ text: 'x', confidence: 99 })).toBe(false)
  })

  it('置信度未知（null）不参与低置信度判定', () => {
    expect(isLowConfidenceLine({ text: 'x', confidence: null })).toBe(false)
  })
})

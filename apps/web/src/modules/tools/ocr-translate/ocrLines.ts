/**
 * OCR 识别结果行与低置信度标注（docs/09 §9.2、docs/12 §8）。
 *
 * Tesseract 7 默认输出不含 blocks，调用方需以 { text: true, blocks: true } 显式
 * 请求；本模块只做结构化提取，不改动识别文本。
 */

export const LOW_CONFIDENCE_THRESHOLD = 60

export interface OcrLine {
  text: string
  /** 行置信度（0–100）；无法取得时为 null，不参与低置信度判定。 */
  confidence: number | null
}

interface OcrPageLike {
  text: string
  blocks?: {
    paragraphs?: {
      lines?: { text: string; confidence: number }[]
    }[]
  }[] | null
}

/** 从识别结果提取行列表；blocks 缺失时退回按整段文本折行（无置信度）。 */
export function extractOcrLines(page: OcrPageLike): OcrLine[] {
  const lines: OcrLine[] = []
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        lines.push({
          text: line.text,
          confidence: typeof line.confidence === 'number' ? line.confidence : null,
        })
      }
    }
  }
  if (lines.length > 0) return lines
  return page.text.split('\n').map((text) => ({ text, confidence: null }))
}

export function isLowConfidenceLine(line: OcrLine): boolean {
  return line.confidence !== null && line.confidence < LOW_CONFIDENCE_THRESHOLD
}

import { describe, expect, it } from 'vitest'

import { CitationParser } from './citation-parser.js'

// Redact-all helper: run a stream through the parser in one chunk.
function parseOnce(text: string, maxOrdinal = 8): { text: string; citations: number[]; invalid: string | null } {
  const parser = new CitationParser(maxOrdinal)
  const textParts: string[] = []
  const citations: number[] = []
  let invalid: string | null = null
  for (const result of parser.push(text)) {
    if (result.kind === 'text') textParts.push(result.text)
    else if (result.kind === 'citation') citations.push(result.ordinal)
    else invalid = result.reason
  }
  for (const result of parser.flush()) {
    if (result.kind === 'text') textParts.push(result.text)
    else if (result.kind === 'citation') citations.push(result.ordinal)
    else invalid = result.reason
  }
  return { text: textParts.join(''), citations, invalid }
}

describe('CitationParser', () => {
  it('extracts valid markers and preserves surrounding text', () => {
    const result = parseOnce('根据 [[S1]] 的说法，以及 [[S3]]。')
    expect(result.invalid).toBeNull()
    expect(result.citations).toEqual([1, 3])
    expect(result.text).toBe('根据  的说法，以及 。')
  })

  it('survives markers split at every byte boundary', () => {
    const full = '前缀 [[S2]] 后缀 [[S8]] 结束'
    const reference = parseOnce(full)
    for (let split = 0; split <= full.length; split++) {
      const parser = new CitationParser(8)
      const textParts: string[] = []
      const citations: number[] = []
      let invalid: string | null = null
      for (const result of [...parser.push(full.slice(0, split)), ...parser.push(full.slice(split))]) {
        if (result.kind === 'text') textParts.push(result.text)
        else if (result.kind === 'citation') citations.push(result.ordinal)
        else invalid = result.reason
      }
      for (const result of parser.flush()) {
        if (result.kind === 'text') textParts.push(result.text)
        else if (result.kind === 'citation') citations.push(result.ordinal)
        else invalid = result.reason
      }
      expect({ text: textParts.join(''), citations, invalid }).toEqual(reference)
    }
  })

  it('rejects ordinals outside the run', () => {
    expect(parseOnce('[[S9]]', 8).invalid).not.toBeNull()
    expect(parseOnce('[[S3]]', 2).invalid).not.toBeNull()
  })

  it('fails on forged canonical tokens even when the number matches', () => {
    expect(parseOnce('伪造 [[C1]]', 8).invalid).not.toBeNull()
    expect(parseOnce('伪造 [[C]]', 8).invalid).not.toBeNull()
  })

  it('fails on malformed reserved prefixes', () => {
    expect(parseOnce('[[Sx]]', 8).invalid).not.toBeNull()
    expect(parseOnce('[[S', 8).invalid).not.toBeNull()
    expect(parseOnce('[[S12]]', 8).invalid).not.toBeNull()
  })

  it('passes through ordinary bracket text', () => {
    const result = parseOnce('参见 [[wiki]] 与 [1] 与 [[]]')
    expect(result.invalid).toBeNull()
    expect(result.text).toBe('参见 [[wiki]] 与 [1] 与 [[]]')
  })

  it('keeps citation and text ordering', () => {
    const parser = new CitationParser(8)
    const events = [...parser.push('a[[S1]]b[[S1]]c'), ...parser.flush()]
    expect(events.map((event) => event.kind)).toEqual([
      'text', 'citation', 'text', 'citation', 'text',
    ])
  })
})

import { describe, expect, it } from 'vitest'

import { CitationParser } from './citation-parser.js'
import { StreamRedactor } from './stream-redactor.js'

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

  it('maps observed single-bracket citations to the same source ordinals', () => {
    const result = parseOnce('版本 [S4]，配置 [[S1]][S4]。')
    expect(result.invalid).toBeNull()
    expect(result.citations).toEqual([4, 1, 4])
    expect(result.text).toBe('版本 ，配置 。')
  })

  it.each([
    '前缀 [[S2]] 后缀 [[S8]] 结束',
    '前缀 [S2] 后缀 [[S8]][S2] 结束',
  ])('survives markers split at every byte boundary: %s', (full) => {
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
    expect(parseOnce('[S9]', 8).invalid).not.toBeNull()
    expect(parseOnce('[S0]', 8).invalid).not.toBeNull()
    expect(parseOnce('[S3]', 2).invalid).not.toBeNull()
    expect(parseOnce('[S1]', 0).invalid).not.toBeNull()
  })

  it('fails on forged canonical tokens even when the number matches', () => {
    expect(parseOnce('伪造 [[C1]]', 8).invalid).not.toBeNull()
    expect(parseOnce('伪造 [[C]]', 8).invalid).not.toBeNull()
  })

  it('does not accept a forged canonical token after a valid single-bracket citation', () => {
    const result = parseOnce('依据 [S1]，伪造 [[C1]]', 1)
    expect(result.citations).toEqual([1])
    expect(result.invalid).not.toBeNull()
    expect(result.text).not.toContain('[[C1]]')
  })

  it('fails on malformed reserved prefixes', () => {
    expect(parseOnce('[[Sx]]', 8).invalid).not.toBeNull()
    expect(parseOnce('[[S', 8).invalid).not.toBeNull()
    expect(parseOnce('[[S12]]', 8).invalid).not.toBeNull()
    expect(parseOnce('[S12]', 8).invalid).not.toBeNull()
    expect(parseOnce('[S1x]', 8).invalid).not.toBeNull()
    expect(parseOnce('[S1', 8).invalid).not.toBeNull()
  })

  it('passes through ordinary bracket text', () => {
    const text = '参见 [[wiki]] 与 [1] 与 [[]] 与 [SQL] 与 [Source] 与 [S] 与 [S'
    const result = parseOnce(text)
    expect(result.invalid).toBeNull()
    expect(result.text).toBe(text)
  })

  it('keeps citation and text ordering', () => {
    const parser = new CitationParser(8)
    const events = [...parser.push('a[[S1]]b[[S1]]c'), ...parser.flush()]
    expect(events.map((event) => event.kind)).toEqual([
      'text', 'citation', 'text', 'citation', 'text',
    ])
  })

  it('rejects a forged token held entirely in the redactor tail', () => {
    const redactor = new StreamRedactor()
    const parser = new CitationParser(1)
    expect(parser.push(redactor.push('前缀 [[C1]]'))).toEqual([])
    const results = [...parser.push(redactor.flush()), ...parser.flush()]
    expect(results.some((result) => result.kind === 'invalid')).toBe(true)
  })

  it('parses a single-bracket citation held entirely in the redactor tail', () => {
    const redactor = new StreamRedactor()
    const parser = new CitationParser(1)
    expect(parser.push(redactor.push('依据 [S1]'))).toEqual([])
    const results = [...parser.push(redactor.flush()), ...parser.flush()]
    expect(results.filter((result) => result.kind === 'citation')).toEqual([{ kind: 'citation', ordinal: 1 }])
    expect(results.some((result) => result.kind === 'invalid')).toBe(false)
  })
})

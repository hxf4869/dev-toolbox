import { describe, expect, it } from 'vitest'

import { StructuredToolError } from './contracts'
import {
  buildJsonAIRequestDraft,
  buildJsonAIStructure,
  JSON_AI_PUBLIC_REQUEST_LIMIT_BYTES,
} from './jsonAi'

const identifiers = {
  providerId: '11111111-1111-4111-8111-111111111111',
  modelId: '22222222-2222-4222-8222-222222222222',
  targetLanguage: 'Rust',
}

describe('JSON AI browser confirmation contract', () => {
  it('builds a deterministic structure payload containing no source values', () => {
    const source = JSON.stringify({
      secret: 'do-not-send',
      count: 9007199254740993n.toString(),
      rows: [{ id: 1, active: true }, { id: 2, active: false }],
    })
    const structure = buildJsonAIStructure(source)
    const draft = buildJsonAIRequestDraft({ ...identifiers, mode: 'structure', source })

    expect(structure).toEqual({
      kind: 'object',
      properties: {
        secret: { kind: 'string' },
        count: { kind: 'string' },
        rows: {
          kind: 'array',
          items: [{
            kind: 'object',
            properties: { id: { kind: 'integer' }, active: { kind: 'boolean' } },
          }],
        },
      },
    })
    expect(draft.inputPreview).not.toContain('do-not-send')
    expect(draft.inputPreview).not.toContain('9007199254740993')
    expect(JSON.parse(draft.body)).toMatchObject({ mode: 'structure', input: structure })
  })

  it('embeds and previews the full JSON source exactly without number conversion', () => {
    const source = ` {\n  "big": 9007199254740993,\n  "decimal": 1.2300,\n  "huge": 1e1000,\n  "negativeZero": -0\n} `
    const draft = buildJsonAIRequestDraft({ ...identifiers, mode: 'full', source })

    expect(draft.inputPreview).toBe(source)
    expect(draft.body).toContain(`,"input":${source}}`)
    expect(draft.body).toContain('9007199254740993')
    expect(draft.body).toContain('1.2300')
    expect(draft.body).toContain('1e1000')
    expect(draft.body).toContain('-0')
  })

  it('rejects the full public body above 256 KiB without truncation', () => {
    const source = JSON.stringify({ sample: 'x'.repeat(JSON_AI_PUBLIC_REQUEST_LIMIT_BYTES) })
    expect(() => buildJsonAIRequestDraft({ ...identifiers, mode: 'full', source }))
      .toThrow(expect.objectContaining<Partial<StructuredToolError>>({ code: 'AI_PAYLOAD_TOO_LARGE' }))
  })

  it('rejects invisible or padded target language text', () => {
    for (const targetLanguage of ['', ' Rust', 'Rust ', 'Rust\nignore', 'Ru\u200bst']) {
      expect(() => buildJsonAIRequestDraft({
        ...identifiers,
        targetLanguage,
        mode: 'structure',
        source: '{}',
      })).toThrow(expect.objectContaining<Partial<StructuredToolError>>({ code: 'AI_TARGET_LANGUAGE_INVALID' }))
    }
  })
})

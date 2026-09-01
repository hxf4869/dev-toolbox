import { describe, expect, it } from 'vitest'

import { StructuredToolError } from './contracts'
import { parseLosslessJson } from './lossless'
import { generateLocalTypes } from './typeGeneration'

const sample = `{
  "user-profile": {"createdAt":"2026-08-31","big":9007199254740993,"ratio":1.2300},
  "items": [{"a-b":1,"a_b":"x","nullable":null},{"a-b":2,"extra":true}],
  "mixed": [1,"two"],
  "empty": []
}`

describe('deterministic local type generation', () => {
  it.each(['typescript', 'java', 'go', 'kotlin'] as const)('is byte-stable for %s', (language) => {
    const value = parseLosslessJson(sample)
    expect(generateLocalTypes(value, language)).toBe(generateLocalTypes(value, language))
  })

  it('keeps original TypeScript keys and observed optional/nullability only', () => {
    const output = generateLocalTypes(parseLosslessJson(sample), 'typescript')
    expect(output).toContain('"user-profile": RootUserProfile;')
    expect(output).toContain('extra?: boolean;')
    expect(output).toContain('nullable?: null;')
    expect(output).toContain('mixed: Array<unknown>;')
    expect(output).toContain('createdAt: string;')
  })

  it('uses exact JSON tags and collision suffixes in Go', () => {
    const output = generateLocalTypes(parseLosslessJson(sample), 'go')
    expect(output).toContain('AB json.Number `json:"a-b"`')
    expect(output).toContain('AB_2 *string `json:"a_b"`')
    expect(output).toContain('import "encoding/json"')
  })

  it('maps Java and Kotlin integer/decimal types without third-party runtime', () => {
    const java = generateLocalTypes(parseLosslessJson(sample), 'java')
    const kotlin = generateLocalTypes(parseLosslessJson(sample), 'kotlin')
    expect(java).toContain('import java.math.BigInteger;')
    expect(java).toContain('import java.math.BigDecimal;')
    expect(java).toContain('// JSON key: "user-profile"')
    expect(kotlin).toContain('import java.math.BigInteger')
    expect(kotlin).toContain('import java.math.BigDecimal')
  })

  it.each([
    ['typescript', 'export type Root = Array<unknown>;'],
    ['java', 'public class Root extends ArrayList<Object>'],
    ['go', 'type Root []any'],
    ['kotlin', 'typealias Root = List<Any?>'],
  ] as const)('supports root arrays for %s', (language, marker) => {
    expect(generateLocalTypes(parseLosslessJson('[]'), language)).toContain(marker)
  })

  it('uses nullable Kotlin universal element type for incompatible and null-mixed arrays', () => {
    expect(generateLocalTypes(parseLosslessJson('[1,null]'), 'kotlin')).toContain('typealias Root = List<Any?>')
    expect(generateLocalTypes(parseLosslessJson('[1,"two"]'), 'kotlin')).toContain('typealias Root = List<Any?>')
    expect(generateLocalTypes(parseLosslessJson('[{"value":1},{"value":"two"},{"value":null}]'), 'kotlin')).toContain('val value: Any?')
  })

  it('rejects scalar roots with the stable code', () => {
    try {
      generateLocalTypes(parseLosslessJson('1'), 'typescript')
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredToolError)
      expect((error as StructuredToolError).code).toBe('TYPE_ROOT_UNSUPPORTED')
    }
  })
})

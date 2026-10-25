import { getAllRegisteredSchemaUris } from '@hyperjump/json-schema/draft-2020-12'
import { describe, expect, it, vi } from 'vitest'

import { STRUCTURED_TEXT_LIMIT_BYTES, StructuredToolError } from './contracts'
import { diffJson, queryJsonPath, runJsonOperation, validateSchema } from './operations'
import { parseLosslessJson } from './lossless'
import { createLimitedRepair } from './repair'

function expectCode(run: () => unknown, code: string) {
  try {
    run()
    throw new Error('Expected operation to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(StructuredToolError)
    expect((error as StructuredToolError).code).toBe(code)
  }
}

describe('JSON lossless operations', () => {
  it('preserves every frozen numeric lexical form when formatting and compacting', async () => {
    const source = '{"large":9007199254740993,"decimal":1.2300,"overflow":1e1000,"negativeZero":-0}'
    const pretty = await runJsonOperation({ operation: 'format', text: source, compact: false })
    const compact = await runJsonOperation({ operation: 'format', text: source, compact: true })
    expect(pretty.operation).toBe('format')
    expect(pretty).toMatchObject({ output: expect.stringContaining('9007199254740993') })
    expect(pretty).toMatchObject({ output: expect.stringContaining('1.2300') })
    expect(pretty).toMatchObject({ output: expect.stringContaining('1e1000') })
    expect(pretty).toMatchObject({ output: expect.stringContaining('-0') })
    expect(compact).toEqual({ operation: 'format', output: source })
  })

  it('rejects text beyond the 5 MiB UTF-8 limit before parsing', () => {
    expectCode(() => parseLosslessJson(`"${'a'.repeat(STRUCTURED_TEXT_LIMIT_BYTES)}"`), 'INPUT_TOO_LARGE')
  })
})

describe('limited JSON repair', () => {
  it('only returns a candidate for comments, trailing commas, single quotes and ordinary bare keys', () => {
    const input = `{// comment\nplain_key: 'value',\nitems: [1, 2,],\n}`
    const result = createLimitedRepair(input)
    expect(result.changed).toBe(true)
    expect(result.candidate).toContain('"plain_key": "value"')
    expect(result.candidate).not.toContain('// comment')
    expect(result.diff).toContain('修复候选')
    expect(input).toContain('// comment')
  })

  it.each([
    ['{"x": NaN}', 'JSON_REPAIR_UNSUPPORTED'],
    ['{"x": undefined}', 'JSON_REPAIR_UNSUPPORTED'],
    ['{"x": function(){}}', 'JSON_REPAIR_UNSUPPORTED'],
    ['{"x": /abc/}', 'JSON_REPAIR_UNSUPPORTED'],
  ])('rejects unsupported JavaScript value %s', (input, code) => {
    expectCode(() => createLimitedRepair(input), code)
  })
})

describe('JSONPath subset', () => {
  const value = parseLosslessJson('{"store":{"books":[{"title":"A","price":1},{"title":"B","price":2}]},"other":3}')

  it.each([
    ['$', 1],
    ['$.store.books[0].title', 1],
    ['$.store.books[*].title', 2],
    ['$..price', 2],
    ['$.store.books[0:2].title', 2],
    ["$['store','other']", 2],
  ])('supports %s and returns canonical paths', (expression, count) => {
    const matches = queryJsonPath(value, expression)
    expect(matches).toHaveLength(count)
    expect(matches.every((match) => match.path.startsWith('$'))).toBe(true)
  })

  it('disables script filters with a distinct error', () => {
    expectCode(() => queryJsonPath(value, '$.store.books[?(@.price > 1)]'), 'JSONPATH_SCRIPT_DISABLED')
  })

  it('keeps commas inside quoted property union members and preserves union order', () => {
    const commaValue = parseLosslessJson('{"a,b":{"value":1},"c":{"value":2}}')
    expect(queryJsonPath(commaValue, "$['a,b','c'].value")).toEqual([
      { path: "$['a,b']['value']", value: '1' },
      { path: "$['c']['value']", value: '2' },
    ])
  })

  it('decodes JSON escapes in double-quoted union members before querying', () => {
    const commaValue = parseLosslessJson('{"a,b":{"value":1},"c":{"value":2}}')
    expect(queryJsonPath(commaValue, '$["\\u0061,b","c"].value')).toEqual([
      { path: "$['a,b']['value']", value: '1' },
      { path: "$['c']['value']", value: '2' },
    ])
  })

  it('does not silently normalize a quoted property union with a trailing comma', () => {
    const unionValue = parseLosslessJson('{"a":1,"b":2}')
    expect(queryJsonPath(unionValue, "$['a','b',]")).toEqual([])
  })
})

describe('JSON diff', () => {
  it('ignores object key order in structural mode and keeps text mode literal', () => {
    const structure = diffJson('{"a":1,"b":2}', '{"b":2,"a":1}', 'structure')
    const text = diffJson('{"a":1,"b":2}', '{"b":2,"a":1}', 'text')
    expect(structure).toMatchObject({ differences: [] })
    expect(text).toMatchObject({ differences: expect.any(Array) })
    if (text.operation === 'diff') expect(text.differences.length).toBeGreaterThan(0)
  })

  it('uses array indexes by default and an explicit unique identity when provided', () => {
    const indexed = diffJson('[{"id":1,"v":"a"},{"id":2,"v":"b"}]', '[{"id":2,"v":"B"},{"id":1,"v":"a"}]', 'structure')
    const identified = diffJson('[{"id":1,"v":"a"},{"id":2,"v":"b"}]', '[{"id":2,"v":"B"},{"id":1,"v":"a"}]', 'structure', 'id')
    if (indexed.operation === 'diff' && identified.operation === 'diff') {
      expect(indexed.differences.length).toBeGreaterThan(identified.differences.length)
      expect(identified.differences).toHaveLength(1)
    }
  })

  it('refuses to merge duplicate explicit identities', () => {
    expectCode(() => diffJson('[{"id":1},{"id":1}]', '[{"id":1}]', 'structure', 'id'), 'DIFF_IDENTITY_DUPLICATE')
  })

  it('accepts exactly 5 MiB per text editor and rejects either editor above its UTF-8 limit', () => {
    const exact = 'a'.repeat(STRUCTURED_TEXT_LIMIT_BYTES)
    expect(diffJson(exact, exact, 'text')).toMatchObject({ operation: 'diff', differences: [] })

    const utf8Overflow = `${'a'.repeat(STRUCTURED_TEXT_LIMIT_BYTES - 2)}你`
    expectCode(() => diffJson(utf8Overflow, exact, 'text'), 'INPUT_TOO_LARGE')
    expectCode(() => diffJson(exact, utf8Overflow, 'text'), 'INPUT_TOO_LARGE')
  })
})

describe('Draft 2020-12 schema', () => {
  const schema = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { item: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    $ref: '#/$defs/item',
  })

  it('validates safe instances and current-document refs', async () => {
    expect(await validateSchema('{"name":"ok"}', schema)).toMatchObject({ status: 'valid', schemaValid: true })
    expect(await validateSchema('{"name":2}', schema)).toMatchObject({ status: 'invalid', schemaValid: true })
  })

  it('compiles schema but skips the entire unsafe instance without partial pass', async () => {
    const combinedSchema = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { n: { type: 'integer', minimum: 1 } },
      type: 'object',
      properties: { n: { oneOf: [{ $ref: '#/$defs/n' }, { type: 'string' }] } },
      required: ['n'],
    })
    expect(await validateSchema('{"n":9007199254740993}', combinedSchema)).toEqual({
      operation: 'schema-validate', schemaValid: true, status: 'not_run_precision_guard', issues: [],
    })
  })

  it('still rejects an invalid schema when the instance is precision-unsafe', async () => {
    await expect(validateSchema('{"n":9007199254740993}', '{"type":"object","required":"n"}'))
      .rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('rejects remote refs and remote dynamic refs', async () => {
    await expect(validateSchema('{}', '{"$ref":"https://example.com/schema"}'))
      .rejects.toMatchObject({ code: 'SCHEMA_REMOTE_REF_DISABLED' })
    await expect(validateSchema('{}', '{"$dynamicRef":"https://example.invalid/dyn#node"}'))
      .rejects.toMatchObject({ code: 'SCHEMA_REMOTE_REF_DISABLED' })
  })

  it('treats $ref literals inside const/enum data values as inert without network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Schema validation must stay offline'))
    try {
      const constRef = JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        const: { $ref: 'https://example.invalid/const' },
      })
      expect(await validateSchema('{"$ref":"https://example.invalid/const"}', constRef)).toMatchObject({ status: 'valid' })
      expect(await validateSchema('{"$ref":"https://example.invalid/other"}', constRef)).toMatchObject({ status: 'invalid' })
      const enumRef = JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        enum: [{ $dynamicRef: 'https://example.invalid/dyn' }, 'literal'],
      })
      expect(await validateSchema('{"$dynamicRef":"https://example.invalid/dyn"}', enumRef)).toMatchObject({ status: 'valid' })
      expect(await validateSchema('"other"', enumRef)).toMatchObject({ status: 'invalid' })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps blocking remote refs in real schemas under schema maps', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Schema validation must stay offline'))
    try {
      const constNamedProperty = JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { const: { $ref: 'https://example.invalid/x' } },
      })
      await expect(validateSchema('{"const":1}', constNamedProperty))
        .rejects.toMatchObject({ code: 'SCHEMA_REMOTE_REF_DISABLED' })
      const refNamedProperty = JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { $ref: 'https://example.invalid/x' },
      })
      await expect(validateSchema('{}', refNamedProperty))
        .rejects.toMatchObject({ code: 'SCHEMA_REMOTE_REF_DISABLED' })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('rejects external fetch activated through a local ref into data at the SDK boundary', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Schema validation must stay offline'))
    try {
      const localIntoData = JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $ref: '#/enum/1',
        enum: [0, { $ref: 'https://example.invalid/x' }],
      })
      await expect(validateSchema('0', localIntoData)).rejects.toMatchObject({
        code: 'SCHEMA_REMOTE_REF_DISABLED',
        message: expect.stringContaining('禁用'),
      })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await validateSchema('0', '{"type":"integer"}')).toMatchObject({ status: 'valid' })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it.each(['$ref', '$dynamicRef'] as const)('rejects an activated %s pointing to a cached external meta resource', async (field) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Schema validation must stay offline'))
    try {
      const dialect = 'https://json-schema.org/draft/2020-12/schema'
      const reference = field === '$dynamicRef' ? dialect + '#meta' : dialect
      const schema = JSON.stringify({ $schema: dialect, $ref: '#/enum/1', enum: [0, { [field]: reference }] })
      await expect(validateSchema('0', schema)).rejects.toMatchObject({ code: 'SCHEMA_REMOTE_REF_DISABLED' })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await validateSchema('0', '{"type":"integer"}')).toMatchObject({ status: 'valid' })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps dialect and vocabulary guards active inside data subtrees', async () => {
    const dataDialect = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      const: { $schema: 'http://json-schema.org/draft-07/schema#' },
    })
    await expect(validateSchema('1', dataDialect)).rejects.toMatchObject({ code: 'SCHEMA_DIALECT_UNSUPPORTED' })
    const dataVocabulary = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      const: {
        $id: 'https://json-schema.org/draft/2020-12/schema',
        $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true },
        type: 'object',
      },
    })
    await expect(validateSchema('{}', dataVocabulary)).rejects.toMatchObject({ code: 'SCHEMA_VOCABULARY_UNSUPPORTED' })
  })

  it('allows lazy data ref literals to coexist with local schema refs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Schema validation must stay offline'))
    try {
      const mixed = JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: { item: { type: 'string' } },
        properties: {
          kind: { const: { $ref: 'https://example.invalid/y' } },
          name: { $ref: '#/$defs/item' },
        },
      })
      expect(await validateSchema('{"kind":{"$ref":"https://example.invalid/y"},"name":"ok"}', mixed))
        .toMatchObject({ status: 'valid' })
      expect(await validateSchema('{"kind":{"$ref":"https://example.invalid/other"},"name":"ok"}', mixed))
        .toMatchObject({ status: 'invalid' })
      expect(await validateSchema('{"kind":{"$ref":"https://example.invalid/y"},"name":2}', mixed))
        .toMatchObject({ status: 'invalid' })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('supports local recursive $dynamicRef', async () => {
    const dynamicSchema = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $dynamicAnchor: 'node',
      type: 'object',
      properties: { value: { type: 'integer' }, next: { $dynamicRef: '#node' } },
      required: ['value'],
      additionalProperties: false,
    })
    expect(await validateSchema('{"value":1,"next":{"value":2}}', dynamicSchema)).toMatchObject({ status: 'valid' })
    expect(await validateSchema('{"value":1,"next":{"value":"x"}}', dynamicSchema)).toMatchObject({ status: 'invalid' })
  })

  it('rejects schemas declaring a non-2020-12 dialect', async () => {
    await expect(validateSchema('"x"', '{"$schema":"http://json-schema.org/draft-07/schema#","type":"string"}'))
      .rejects.toMatchObject({ code: 'SCHEMA_DIALECT_UNSUPPORTED' })
  })

  it('rejects a custom $vocabulary on the root or a nested resource with $id', async () => {
    const rootVocabulary = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true },
      type: 'object',
    })
    await expect(validateSchema('{}', rootVocabulary)).rejects.toMatchObject({ code: 'SCHEMA_VOCABULARY_UNSUPPORTED' })
    const nestedVocabulary = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        inner: {
          $id: 'https://example.invalid/inner',
          $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true },
          type: 'string',
        },
      },
    })
    await expect(validateSchema('{}', nestedVocabulary)).rejects.toMatchObject({ code: 'SCHEMA_VOCABULARY_UNSUPPORTED' })
  })

  it('rejects an invalid schema and recovers on the next validation', async () => {
    await expect(validateSchema('{}', '{"type":"object","required":"name"}')).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    expect(await validateSchema('{"name":"ok"}', schema)).toMatchObject({ status: 'valid' })
  })

  it('treats format and unknown keywords as Draft 2020-12 annotations', async () => {
    const formatSchema = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { v: { type: 'string', format: 'email' } },
      required: ['v'],
      'x-vendor': { note: 'annotation' },
    })
    expect(await validateSchema('{"v":"not-an-email"}', formatSchema)).toMatchObject({ status: 'valid' })
  })

  it('supports boolean schemas and identifies root validation issues', async () => {
    expect(await validateSchema('42', 'true')).toMatchObject({ status: 'valid' })
    expect(await validateSchema('42', 'false')).toMatchObject({ status: 'invalid' })
    expect(await validateSchema('42', '{"type":"string"}')).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'type', message: expect.stringContaining('$') }],
    })
  })

  it('rejects non-schema root values with a schema error', async () => {
    for (const schemaText of ['null', '[]', '42', '"schema"']) {
      await expect(validateSchema('{}', schemaText)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    }
    expect(await validateSchema('{"name":"ok"}', schema)).toMatchObject({ status: 'valid' })
  })

  it('rejects vocabulary resources nested in schema arrays', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Schema validation must stay offline'))
    try {
      const arrayVocabulary = JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        allOf: [{
          $id: 'https://json-schema.org/draft/2020-12/schema',
          $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true },
          type: 'object',
        }],
      })
      await expect(validateSchema('{}', arrayVocabulary)).rejects.toMatchObject({ code: 'SCHEMA_VOCABULARY_UNSUPPORTED' })
      expect(await validateSchema('{"name":"ok"}', schema)).toMatchObject({ status: 'valid' })
      expect(await validateSchema('{"name":2}', schema)).toMatchObject({ status: 'invalid' })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps the validator registry clean across repeated validations', async () => {
    const baseline = new Set(getAllRegisteredSchemaUris())
    const withOwnId = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.invalid/repeat',
      type: 'string',
    })
    expect(await validateSchema('"a"', withOwnId)).toMatchObject({ status: 'valid' })
    expect(await validateSchema('"b"', withOwnId)).toMatchObject({ status: 'valid' })
    expect(await validateSchema('{"name":"ok"}', schema)).toMatchObject({ status: 'valid' })
    expect(getAllRegisteredSchemaUris().filter((uri) => !baseline.has(uri))).toEqual([])
  })
})

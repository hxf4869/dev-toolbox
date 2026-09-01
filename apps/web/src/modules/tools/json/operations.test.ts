import { describe, expect, it } from 'vitest'

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

  it('validates safe instances and current-document refs', () => {
    expect(validateSchema('{"name":"ok"}', schema)).toMatchObject({ status: 'valid', schemaValid: true })
    expect(validateSchema('{"name":2}', schema)).toMatchObject({ status: 'invalid', schemaValid: true })
  })

  it('compiles schema but skips the entire unsafe instance without partial pass', () => {
    const combinedSchema = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { n: { type: 'integer', minimum: 1 } },
      type: 'object',
      properties: { n: { oneOf: [{ $ref: '#/$defs/n' }, { type: 'string' }] } },
      required: ['n'],
    })
    expect(validateSchema('{"n":9007199254740993}', combinedSchema)).toEqual({
      operation: 'schema-validate', schemaValid: true, status: 'not_run_precision_guard', issues: [],
    })
  })

  it('rejects remote refs', () => {
    expectCode(() => validateSchema('{}', '{"$ref":"https://example.com/schema"}'), 'SCHEMA_REMOTE_REF_DISABLED')
  })
})

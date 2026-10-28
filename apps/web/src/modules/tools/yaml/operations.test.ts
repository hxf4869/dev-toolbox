import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { StructuredToolError } from '../json/contracts'
import { runYamlOperation } from './operations'

function expectCode(run: () => unknown, code: string) {
  try {
    run()
    throw new Error('Expected operation to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(StructuredToolError)
    expect((error as StructuredToolError).code).toBe(code)
  }
}

describe('YAML 1.2 workbench', () => {
  it.each([false, true])('preserves ordinary isLosslessNumber=%s fields in nested objects', (flag) => {
    const value = { isLosslessNumber: flag, value: 'fixture', other: 1 }
    const source = { nested: value, items: [value] }
    const result = runYamlOperation({ operation: 'from-json', text: JSON.stringify(source) })
    expect(parse(result.output)).toEqual(source)
  })

  it('round-trips nested empty containers in objects and arrays', () => {
    const source = '{"list":[],"nested":{},"items":[{},[],{"child":[]} ]}'
    const yaml = runYamlOperation({ operation: 'from-json', text: source })
    const json = runYamlOperation({ operation: 'to-json', text: yaml.output })
    expect(JSON.parse(json.output)).toEqual(JSON.parse(source))
  })

  it('keeps a __proto__ mapping as an own JSON property', () => {
    const result = runYamlOperation({ operation: 'to-json', text: '__proto__:\n  test: value\nnormal: ok\n' })
    const parsed = JSON.parse(result.output)
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true)
    expect(parsed.__proto__).toEqual({ test: 'value' })
    expect(parsed.normal).toBe('ok')
  })

  it('formats multi-document YAML and preserves comments best effort', () => {
    const result = runYamlOperation({
      operation: 'format',
      text: '# first\na: 1\n---\n# second\nb: 2\n---\n# third\nc: 3\n',
    })
    expect(result).toMatchObject({ operation: 'format', documentCount: 3 })
    if (result.operation === 'format') {
      expect(result.output.match(/^---$/gm)).toHaveLength(2)
      expect(result.output).not.toContain('---\n---')
      expect(result.output).toContain('# first')
      expect(result.output).toContain('# second')
      expect(result.output).toContain('# third')

      const reparsed = runYamlOperation({ operation: 'to-json', text: result.output })
      expect(reparsed).toMatchObject({ operation: 'to-json', documentCount: 3, outputForm: 'array' })
      if (reparsed.operation === 'to-json') {
        expect(reparsed.output.indexOf('"a": 1')).toBeLessThan(reparsed.output.indexOf('"b": 2'))
        expect(reparsed.output.indexOf('"b": 2')).toBeLessThan(reparsed.output.indexOf('"c": 3'))
      }
    }
  })

  it('converts multiple documents to an ordered array and preserves numbers/timestamps', () => {
    const result = runYamlOperation({
      operation: 'to-json',
      text: 'large: 9007199254740993\ndecimal: 1.2300\ndate: 2026-08-31\n---\nnegative: -0\n',
    })
    expect(result).toMatchObject({ operation: 'to-json', documentCount: 2, outputForm: 'array' })
    if (result.operation === 'to-json') {
      expect(result.output).toContain('9007199254740993')
      expect(result.output).toContain('1.2300')
      expect(result.output).toContain('"2026-08-31"')
      expect(result.output).toContain('"negative": -0')
    }
  })

  it('canonicalizes non-JSON integer lexemes to decimal', () => {
    const result = runYamlOperation({ operation: 'to-json', text: 'hex: 0x1F\noctal: 0o17\n' })
    if (result.operation === 'to-json') {
      expect(result.output).toContain('"hex": 31')
      expect(result.output).toContain('"octal": 15')
    }
  })

  it('supports ordinary anchors and aliases', () => {
    const result = runYamlOperation({ operation: 'to-json', text: 'base: &base\n  name: toolbox\ncopy: *base\n' })
    if (result.operation === 'to-json') {
      expect(result.output.match(/"name": "toolbox"/g)).toHaveLength(2)
    }
  })

  it('rejects alias expansion beyond maxAliasCount 100', () => {
    const source = 'a: &a [1, 2]\nb: &b [*a, *a]\nc: &c [*b, *b]\nd: &d [*c, *c]\ne: &e [*d, *d]\nout: *e\n'
    expectCode(() => runYamlOperation({ operation: 'to-json', text: source }), 'YAML_ALIAS_LIMIT')
  })

  it.each([
    ['a: 1\na: 2\n', 'YAML_DUPLICATE_KEY'],
    ['base: &base {a: 1}\nmerged:\n  <<: *base\n', 'YAML_MERGE_KEY_DISABLED'],
    ['%TAG !e! tag:example.com,2026:\n---\na: !e!thing value\n', 'YAML_TAG_DIRECTIVE_DISABLED'],
    ['a: !thing value\n', 'YAML_CUSTOM_TAG_DISABLED'],
    ['a: !!js/function function () { return 1 }\n', 'YAML_CUSTOM_TAG_DISABLED'],
    ['a: !!python/object module.Class\n', 'YAML_CUSTOM_TAG_DISABLED'],
    ['a: !!timestamp 2026-08-31\n', 'YAML_CUSTOM_TAG_DISABLED'],
  ])('rejects unsafe YAML feature with %s', (source, code) => {
    expectCode(() => runYamlOperation({ operation: 'to-json', text: source }), code)
  })

  it('keeps explicit YAML 1.2 core tags available', () => {
    const result = runYamlOperation({
      operation: 'to-json',
      text: 'text: !!str 1\nnumber: !!int 2\nlist: !!seq [true, null]\nobject: !!map {key: value}\n',
    })
    if (result.operation === 'to-json') {
      expect(result.output).toContain('"text": "1"')
      expect(result.output).toContain('"number": 2')
      expect(result.output).toContain('"list"')
      expect(result.output).toContain('"object"')
    }
  })

  it('converts lossless JSON to YAML without changing number tokens', () => {
    const result = runYamlOperation({ operation: 'from-json', text: '{"large":9007199254740993,"decimal":1.2300,"overflow":1e1000}' })
    if (result.operation === 'from-json') {
      expect(result.output).toContain('9007199254740993')
      expect(result.output).toContain('1.2300')
      expect(result.output).toContain('1e1000')
    }
  })
})

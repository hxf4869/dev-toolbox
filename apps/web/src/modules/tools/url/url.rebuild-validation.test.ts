import {
  MAX_URL_INPUT_BYTES,
  parseUrlPreserving,
  rebuildUrl,
  urlUtf8ByteLength,
  type QueryRow,
} from './url'

const SOURCE_URL = 'https://example.com/a?x=1&x=2&flag#part'

function draftRows(source: string): QueryRow[] {
  return parseUrlPreserving(source).queryRows.map((row) => ({ ...row }))
}

describe('URL rebuild reuses the parse input validation', () => {
  it.each([
    { field: 'value', row: 0, draft: '%', rebuilt: 'https://example.com/a?x=%&x=2&flag#part' },
    { field: 'key', row: 0, draft: 'x%2G', rebuilt: 'https://example.com/a?x%2G=1&x=2&flag#part' },
    { field: 'value', row: 1, draft: '2%z1', rebuilt: 'https://example.com/a?x=1&x=2%z1&flag#part' },
    { field: 'key', row: 2, draft: 'flag%A', rebuilt: 'https://example.com/a?x=1&x=2&flag%A#part' },
    { field: 'value', row: 0, draft: '%41%', rebuilt: 'https://example.com/a?x=%41%&x=2&flag#part' },
  ] as const)(
    'rejects an incomplete percent escape edited into a query $field (row $row)',
    ({ field, row, draft, rebuilt }) => {
      const parsed = parseUrlPreserving(SOURCE_URL)
      const rows = draftRows(SOURCE_URL)
      rows[row]![field] = draft
      // SOURCE_URL carries no %, so the offending escape is always the last % of the rebuilt text.
      expect(() => rebuildUrl(parsed, rows)).toThrowError(
        expect.objectContaining({
          code: 'URL_INVALID_PERCENT_ESCAPE',
          position: rebuilt.lastIndexOf('%'),
        }),
      )
    },
  )

  it('applies the 1 MiB limit to the final rebuilt text reached through query edits', () => {
    const source = 'https://e.test/?a='
    const parsed = parseUrlPreserving(source)
    const fill = 'b'.repeat(MAX_URL_INPUT_BYTES - urlUtf8ByteLength(source))

    expect(rebuildUrl(parsed, [{ key: 'a', value: fill, hasEquals: true }])).toHaveLength(
      MAX_URL_INPUT_BYTES,
    )
    expect(() =>
      rebuildUrl(parsed, [{ key: 'a', value: `${fill}b`, hasEquals: true }]),
    ).toThrowError(expect.objectContaining({ code: 'URL_INPUT_TOO_LARGE' }))
  })

  it('keeps valid raw escapes, duplicate keys, flags and the fragment byte-for-byte', () => {
    const source = 'https://example.com/a?x=%41&x=2&flag#part%2f'
    const parsed = parseUrlPreserving(source)
    expect(rebuildUrl(parsed, parsed.queryRows)).toBe(source)

    const rows = draftRows(source)
    rows[0]!.value = '%41%42 c'
    expect(rebuildUrl(parsed, rows)).toBe('https://example.com/a?x=%41%42 c&x=2&flag#part%2f')
  })
})

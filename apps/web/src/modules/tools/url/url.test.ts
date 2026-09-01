import { mount } from '@vue/test-utils'

import UrlToolView from './UrlToolView.vue'
import {
  MAX_URL_INPUT_BYTES,
  parseUrlPreserving,
  rebuildUrl,
  transformUrlText,
} from './url'

describe('URL local tool', () => {
  it('uses explicit whole URL and component semantics', () => {
    const source = 'https://example.test/a path?q=中文#片段'
    const encodedUrl = transformUrlText(source, 'encode', 'url')
    expect(encodedUrl).toBe('https://example.test/a%20path?q=%E4%B8%AD%E6%96%87#%E7%89%87%E6%AE%B5')
    expect(transformUrlText(encodedUrl, 'decode', 'url')).toBe(source)
    expect(transformUrlText('a/b?c=d', 'encode', 'component')).toBe('a%2Fb%3Fc%3Dd')
  })

  it('locates malformed percent escapes and does not repeatedly decode', () => {
    expect(() => transformUrlText('abc%2G', 'decode', 'component')).toThrowError(
      expect.objectContaining({ code: 'URL_INVALID_PERCENT_ESCAPE', position: 3 }),
    )
    expect(transformUrlText('%252F', 'decode', 'component')).toBe('%2F')
    expect(() => parseUrlPreserving('https://example.test/a%2G')).toThrowError(
      expect.objectContaining({ code: 'URL_INVALID_PERCENT_ESCAPE', position: 22 }),
    )
  })

  it('parses without URL normalization and preserves repeated query rows', () => {
    const source = 'HTTP://example.test:8080/a/../b?a=1&a=2&b=#frag%2f'
    const parsed = parseUrlPreserving(source)
    expect(parsed).toMatchObject({
      scheme: 'HTTP',
      host: 'example.test',
      port: '8080',
      path: '/a/../b',
      fragment: 'frag%2f',
    })
    expect(parsed.queryRows).toEqual([
      { key: 'a', value: '1', hasEquals: true },
      { key: 'a', value: '2', hasEquals: true },
      { key: 'b', value: '', hasEquals: true },
    ])
    expect(rebuildUrl(parsed, parsed.queryRows)).toBe(source)
  })

  it('retains empty query and fragment delimiters', () => {
    const parsed = parseUrlPreserving('https://example.test/path?#')
    expect(rebuildUrl(parsed, [])).toBe('https://example.test/path?#')
  })

  it('rejects above the 1 MiB boundary before processing', () => {
    expect(transformUrlText('a'.repeat(MAX_URL_INPUT_BYTES), 'encode', 'component')).toHaveLength(
      MAX_URL_INPUT_BYTES,
    )
    expect(() => transformUrlText('a'.repeat(MAX_URL_INPUT_BYTES + 1), 'encode', 'url')).toThrowError(
      expect.objectContaining({ code: 'URL_INPUT_TOO_LARGE' }),
    )
  })

  it('does not fetch, navigate, or persist while parsing and rebuilding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const openSpy = vi.spyOn(window, 'open')
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')
    const indexedDBOpen = window.indexedDB ? vi.spyOn(window.indexedDB, 'open') : undefined
    const wrapper = mount(UrlToolView)
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await wrapper.get('#url-input').setValue('https://example.test/?a=1&a=2')
    await wrapper.get('button.button--primary').trigger('click')
    expect(wrapper.text()).toContain('example.test')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()
    expect(storageSpy).not.toHaveBeenCalled()
    if (indexedDBOpen) expect(indexedDBOpen).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

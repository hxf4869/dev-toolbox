import { mount } from '@vue/test-utils'

import Base64ToolView from './Base64ToolView.vue'
import {
  Base64InputError,
  MAX_BASE64_INPUT_BYTES,
  decodeBase64Text,
  encodeBase64Text,
} from './base64'

describe('Base64 local tool', () => {
  it('round-trips UTF-8 text in both variants', () => {
    const source = '中文🙂'
    expect(decodeBase64Text(encodeBase64Text(source, 'standard'), 'standard')).toBe(source)
    const url = encodeBase64Text(source, 'url')
    expect(url).not.toContain('=')
    expect(decodeBase64Text(url, 'url')).toBe(source)
  })

  it('ignores ASCII copy whitespace but does not guess the variant', () => {
    expect(decodeBase64Text('5Lit \n 5paH 8J+Zgg==', 'standard')).toBe('中文🙂')
    expect(() => decodeBase64Text('-w==', 'standard')).toThrowError(
      expect.objectContaining({ code: 'BASE64_MODE_MISMATCH', position: 0 }),
    )
  })

  it('reports invalid characters, length and decoded UTF-8 separately', () => {
    expect(() => decodeBase64Text('YWJ$', 'standard')).toThrowError(
      expect.objectContaining({ code: 'BASE64_INVALID_CHARACTER', position: 3 }),
    )
    expect(() => decodeBase64Text('YQ', 'standard')).toThrowError(
      expect.objectContaining({ code: 'BASE64_INVALID_LENGTH' }),
    )
    expect(() => decodeBase64Text('/w==', 'standard')).toThrowError(
      expect.objectContaining({ code: 'BASE64_INVALID_UTF8' }),
    )
  })

  it('accepts the 5 MiB boundary and rejects the next UTF-8 byte', () => {
    const boundary = 'a'.repeat(MAX_BASE64_INPUT_BYTES)
    expect(encodeBase64Text(boundary, 'url')).toHaveLength(Math.ceil(MAX_BASE64_INPUT_BYTES / 3) * 4 - 1)
    expect(() => encodeBase64Text(`${boundary}a`, 'standard')).toThrowError(
      expect.objectContaining({ code: 'BASE64_INPUT_TOO_LARGE' }),
    )
  })

  it('keeps processing local and does not persist content', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const setLocal = vi.spyOn(Storage.prototype, 'setItem')
    const indexedDBOpen = window.indexedDB ? vi.spyOn(window.indexedDB, 'open') : undefined
    const clipboard = { readText: vi.fn(), writeText: vi.fn() }
    vi.stubGlobal('navigator', { ...navigator, clipboard })
    const wrapper = mount(Base64ToolView)
    await wrapper.get('textarea:not([readonly])').setValue('hello')
    await wrapper.get('button.button--primary').trigger('click')
    expect((wrapper.get('textarea[readonly]').element as HTMLTextAreaElement).value).toBe('aGVsbG8=')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(setLocal).not.toHaveBeenCalled()
    if (indexedDBOpen) expect(indexedDBOpen).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

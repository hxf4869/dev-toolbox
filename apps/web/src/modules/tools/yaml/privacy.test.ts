import { afterEach, describe, expect, it, vi } from 'vitest'

import { runYamlOperation } from './operations'

describe('YAML deterministic privacy boundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not call fetch or browser persistence', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')
    const indexedDBOpen = window.indexedDB ? vi.spyOn(window.indexedDB, 'open') : undefined
    runYamlOperation({ operation: 'to-json', text: 'value: 1\n' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(storageSpy).not.toHaveBeenCalled()
    if (indexedDBOpen) expect(indexedDBOpen).not.toHaveBeenCalled()
  })
})

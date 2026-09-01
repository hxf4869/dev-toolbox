import { afterEach, describe, expect, it, vi } from 'vitest'

import { runJsonOperation } from './operations'

describe('JSON deterministic privacy boundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not call fetch or browser persistence for local operations', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const localSpy = vi.spyOn(Storage.prototype, 'setItem')
    const indexedDBOpen = window.indexedDB ? vi.spyOn(window.indexedDB, 'open') : undefined
    await runJsonOperation({ operation: 'format', text: '{"value":1}', compact: false })
    await runJsonOperation({ operation: 'type-generate', text: '{"value":1}', language: 'typescript' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(localSpy).not.toHaveBeenCalled()
    if (indexedDBOpen) expect(indexedDBOpen).not.toHaveBeenCalled()
  })
})

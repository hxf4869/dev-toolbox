import { createPinia, setActivePinia } from 'pinia'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import { resolveLibraryView, useLibraryStore } from './library'

describe('library browse view', () => {
  it('does not combine inbox with a folder or tag scope', () => {
    expect(resolveLibraryView(undefined, 'folder-1', undefined)).toBe('')
    expect(resolveLibraryView(undefined, undefined, 'tag-1')).toBe('')
    expect(resolveLibraryView(undefined, undefined, undefined)).toBe('inbox')
    expect(resolveLibraryView('favorites', 'folder-1', undefined)).toBe('favorites')
  })
})

describe('library search privacy', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('sends sensitive queries only in the POST body and keeps them out of browser storage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sort: 'relevance',
          total: 1,
          items: [
            {
              itemId: 'item-1',
              title: '敏感记录',
              snippetParts: [{ text: '敏感内容已遮挡；打开记录后可按需揭示。', highlighted: false }],
              matchedSource: 'raw_text',
              matchedFragmentId: 'fragment-1',
              effectiveCapturedAt: '2026-08-30T00:00:00Z',
              sensitivity: 'sensitive',
              artifactIsStale: null,
            },
          ],
          nextCursor: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-memory-only'
    const library = useLibraryStore()
    library.query = 'Bearer synthetic-secret-token'

    await library.search({
      folderId: 'folder-1',
      sort: 'updated_desc',
      contentKinds: ['text', 'mixed'],
      sensitivity: ['sensitive'],
      from: '2026-08-01T00:00:00Z',
      to: '2026-08-31T23:59:59Z',
    })

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/v1/search')
    expect(path).not.toContain('synthetic-secret-token')
    expect(JSON.parse(String(init.body))).toMatchObject({
      q: 'Bearer synthetic-secret-token',
      folderId: 'folder-1',
      sort: 'relevance',
      contentKinds: ['text', 'mixed'],
      sensitivity: ['sensitive'],
      from: '2026-08-01T00:00:00Z',
      to: '2026-08-31T23:59:59Z',
    })
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
    expect(library.results[0]?.item).not.toHaveProperty('body')
  })

  it('cancels an obsolete search before applying the latest response', async () => {
    const requests: AbortSignal[] = []
    const fetchMock = vi.fn().mockImplementation((_path: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      requests.push(signal)
      if (requests.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      return Promise.resolve(
        new Response(JSON.stringify({ sort: 'relevance', total: 0, items: [], nextCursor: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const library = useLibraryStore()
    library.query = '旧查询'
    const obsolete = library.search({ sort: 'updated_desc' })
    library.query = '新查询'
    await library.search({ sort: 'updated_desc' })
    await obsolete

    expect(requests[0]?.aborted).toBe(true)
    expect(library.error).toBe('')
    expect(library.results).toEqual([])
  })
})

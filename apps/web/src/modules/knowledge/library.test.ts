import { createPinia, setActivePinia } from 'pinia'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import { type FolderEntry, resolveLibraryView, type TagEntry, useLibraryStore } from './library'

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

describe('library stale failure isolation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // 旧请求的 fetch 已收到 500 响应但 body 未读完：body 读取会因新查询的 abort
  // 以 AbortError 结束，apiRequest 会把它吞成空 body 后按 500 抛 ApiError。
  function installStaleFailureThenSuccessFetch(successBody: string) {
    const encoder = new TextEncoder()
    const signals: AbortSignal[] = []
    let markStaleBodyRead: () => void
    const staleBodyRead = new Promise<void>((resolve) => {
      markStaleBodyRead = resolve
    })
    const fetchMock = vi.fn().mockImplementation((_path: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      signals.push(signal)
      if (signals.length > 1) {
        return Promise.resolve(
          new Response(successBody, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('{"error":{"code":"INTERNAL_ERROR","message":"旧失败"}}'),
          )
          signal.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          )
        },
        pull() {
          markStaleBodyRead()
        },
      })
      return Promise.resolve(
        new Response(body, {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    return { staleBodyRead, staleSignal: () => signals[0] }
  }

  it('ignores a stale browse failure body after a newer search succeeds', async () => {
    const searchItem = {
      itemId: 'item-new',
      title: '新结果',
      snippetParts: [{ text: '新结果', highlighted: true }],
      matchedSource: 'raw_text',
      matchedFragmentId: 'fragment-new',
      effectiveCapturedAt: '2026-09-01T00:00:00Z',
      sensitivity: 'normal',
      contentKind: 'text',
      artifactIsStale: null,
    }
    const { staleBodyRead, staleSignal } = installStaleFailureThenSuccessFetch(
      JSON.stringify({ total: 1, items: [searchItem], nextCursor: null }),
    )
    const library = useLibraryStore()

    const stale = library.browse({ view: 'inbox' })
    await staleBodyRead
    library.query = '新查询'
    await library.search({ sort: 'effective_desc' })
    await stale

    expect(staleSignal()?.aborted).toBe(true)
    expect(library.mode).toBe('search')
    expect(library.results).toHaveLength(1)
    expect(library.results[0]).toMatchObject({ kind: 'search', item: { itemId: 'item-new' } })
    expect(library.loading).toBe(false)
    expect(library.error).toBe('')
  })

  it('ignores a stale search failure body after a newer browse succeeds', async () => {
    const { staleBodyRead, staleSignal } = installStaleFailureThenSuccessFetch(
      JSON.stringify({ items: [{ id: 'item-fresh', title: '最新收录' }], nextCursor: null }),
    )
    const library = useLibraryStore()
    library.query = '旧查询'

    const stale = library.search({ sort: 'effective_desc' })
    await staleBodyRead
    library.query = ''
    await library.browse({ view: 'inbox' })
    await stale

    expect(staleSignal()?.aborted).toBe(true)
    expect(library.mode).toBe('browse')
    expect(library.results).toHaveLength(1)
    expect(library.results[0]).toMatchObject({ kind: 'library', item: { id: 'item-fresh' } })
    expect(library.loading).toBe(false)
    expect(library.error).toBe('')
  })

  it('keeps the specific error message for the latest failed request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '后端维护中，请稍后再试' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const library = useLibraryStore()

    await library.browse({ view: 'inbox' })

    expect(library.error).toBe('后端维护中，请稍后再试')
    expect(library.loading).toBe(false)
    expect(library.results).toEqual([])
  })
})

describe('library navigation stale response ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function folderEntry(id: string, name: string): FolderEntry {
    return { id, parentId: null, name, sortOrder: 0, itemCount: 0, children: [] }
  }

  function tagEntry(id: string, name: string): TagEntry {
    return { id, name, itemCount: 0 }
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 初始 loadNavigation 的 folders/tree 与 tags 两个 GET 挂起，由测试显式放行；
  // mutation 后新刷新的导航 GET 立即按 newSnapshot 返回。
  function installDeferredNavigationFetch(newSnapshot: {
    folders: FolderEntry[]
    tags: TagEntry[]
  }) {
    let sawInitialTree = false
    let sawInitialTags = false
    let releaseInitialTree!: (response: Response) => void
    let releaseInitialTags!: (response: Response) => void
    const initialTree = new Promise<Response>((resolve) => {
      releaseInitialTree = resolve
    })
    const initialTags = new Promise<Response>((resolve) => {
      releaseInitialTags = resolve
    })
    const fetchMock = vi.fn().mockImplementation((path: string, init: RequestInit = {}) => {
      if (path === '/api/v1/folders' && init.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'folder-new' }, 201))
      }
      if (path === '/api/v1/tags' && init.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'tag-new' }, 201))
      }
      if (path === '/api/v1/folders/tree') {
        if (!sawInitialTree) {
          sawInitialTree = true
          return initialTree
        }
        return Promise.resolve(jsonResponse({ items: newSnapshot.folders }))
      }
      if (path === '/api/v1/tags') {
        if (!sawInitialTags) {
          sawInitialTags = true
          return initialTags
        }
        return Promise.resolve(jsonResponse({ items: newSnapshot.tags }))
      }
      throw new Error(`unexpected fetch: ${String(init.method)} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return { releaseInitialTree, releaseInitialTags }
  }

  it('keeps a folder created while the initial navigation response is still pending', async () => {
    const keptFolder = folderEntry('folder-existing', '已有目录')
    const createdFolder = folderEntry('folder-new', '新目录')
    const keptTag = tagEntry('tag-1', '已有标签')
    const { releaseInitialTree, releaseInitialTags } = installDeferredNavigationFetch({
      folders: [keptFolder, createdFolder],
      tags: [keptTag],
    })
    const library = useLibraryStore()

    const initial = library.loadNavigation()
    await library.createFolder('新目录', null)

    releaseInitialTree(jsonResponse({ items: [keptFolder] }))
    releaseInitialTags(jsonResponse({ items: [] }))
    await initial

    expect(library.folders.map((folder) => folder.id)).toEqual(['folder-existing', 'folder-new'])
    expect(library.tags.map((tag) => tag.id)).toEqual(['tag-1'])
    expect(library.navigationLoading).toBe(false)
  })

  it('ignores a stale initial navigation failure after a newer refresh succeeds', async () => {
    const createdTag = tagEntry('tag-new', '新标签')
    const { releaseInitialTree, releaseInitialTags } = installDeferredNavigationFetch({
      folders: [],
      tags: [createdTag],
    })
    const library = useLibraryStore()

    const initial = library.loadNavigation()
    const initialOutcome = initial.then(
      () => 'resolved' as const,
      (error) => `rejected:${error instanceof Error ? error.message : String(error)}`,
    )
    await library.createTag('新标签')

    releaseInitialTree(
      jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '旧导航失败' } }, 500),
    )
    releaseInitialTags(jsonResponse({ items: [] }))
    await expect(initialOutcome).resolves.toBe('resolved')

    expect(library.tags.map((tag) => tag.id)).toEqual(['tag-new'])
    expect(library.navigationLoading).toBe(false)
    expect(library.navigationError, '迟到旧错不得复活为共享导航错误').toBe('')
  })

  it('still rejects with the specific error for the latest navigation failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '目录暂时不可用' } }, 500),
        ),
      ),
    )
    const library = useLibraryStore()

    await expect(library.loadNavigation()).rejects.toThrow('目录暂时不可用')
    expect(library.navigationLoading).toBe(false)
    expect(library.navigationError, '最新读取失败记录共享导航错误').toBe('目录暂时不可用')
  })
})

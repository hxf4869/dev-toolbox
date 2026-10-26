// DT-R289 回归测试：library store 七个结构 mutations 的「已确认写入」与「目录刷新读取」
// 分开恢复。合同：写请求 2xx 后的 loadNavigation 刷新失败不得把已确认写入误报为失败——
// mutation 仍 resolve，共享 navigationError 记录「更改已保存，但目录与标签未能刷新。请重新
// 读取列表。」；真正写失败仍 reject 且不发出任何后续读取 GET，navigationError 不误报已保存。
// 读取开始清旧错、迟到旧错不复活由 library.test.ts 既有用例继续保护。
import { createPinia, setActivePinia } from 'pinia'
import { vi } from 'vitest'

import { useLibraryStore } from './library'

const MUTATION_REFRESH_MESSAGE = '更改已保存，但目录与标签未能刷新。请重新读取列表。'

interface RecordedCall {
  method: string
  path: string
}

interface MutationCase {
  name: string
  invoke: (library: ReturnType<typeof useLibraryStore>) => Promise<void>
  method: string
  path: string
}

const mutationCases: MutationCase[] = [
  {
    name: 'createFolder',
    invoke: (library) => library.createFolder('新目录', null),
    method: 'POST',
    path: '/api/v1/folders',
  },
  {
    name: 'renameFolder',
    invoke: (library) => library.renameFolder('folder-1', '改名目录'),
    method: 'PATCH',
    path: '/api/v1/folders/folder-1',
  },
  {
    name: 'moveFolder',
    invoke: (library) => library.moveFolder('folder-1', null),
    method: 'POST',
    path: '/api/v1/folders/folder-1/move',
  },
  {
    name: 'deleteFolder',
    invoke: (library) => library.deleteFolder('folder-1'),
    method: 'DELETE',
    path: '/api/v1/folders/folder-1',
  },
  {
    name: 'createTag',
    invoke: (library) => library.createTag('新标签'),
    method: 'POST',
    path: '/api/v1/tags',
  },
  {
    name: 'renameTag',
    invoke: (library) => library.renameTag('tag-1', '改名标签'),
    method: 'PATCH',
    path: '/api/v1/tags/tag-1',
  },
  {
    name: 'deleteTag',
    invoke: (library) => library.deleteTag('tag-1'),
    method: 'DELETE',
    path: '/api/v1/tags/tag-1',
  },
]

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function unavailable(message: string): Response {
  return jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message } }, 503)
}

// 写请求（非 GET）按 writeSucceeds 应答 204/503；导航读取 GET 一律按 readSucceeds 应答，
// 用例据 calls 断言「写后读」与「写失败零读」的请求顺序与计数。
function installFetch(options: { writeSucceeds: boolean; readSucceeds: boolean }) {
  const calls: RecordedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      calls.push({ method, path })
      if (method === 'GET') {
        return Promise.resolve(
          options.readSucceeds ? jsonResponse({ items: [] }) : unavailable('目录暂时不可用'),
        )
      }
      return Promise.resolve(
        options.writeSucceeds ? new Response(null, { status: 204 }) : unavailable('写入失败'),
      )
    }),
  )
  return { calls }
}

describe('library mutation 刷新失败与写入失败分离（DT-R289）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(mutationCases)(
    '$name：写 2xx 后刷新读取失败仍 resolve，共享错误说明已保存待刷新',
    async ({ invoke, method, path }) => {
      const { calls } = installFetch({ writeSucceeds: true, readSucceeds: false })
      const library = useLibraryStore()

      await expect(invoke(library)).resolves.toBeUndefined()

      const writes = calls.filter((call) => call.method !== 'GET')
      expect(writes).toHaveLength(1)
      expect(writes[0]).toMatchObject({ method, path })
      expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2)
      expect(library.navigationError).toBe(MUTATION_REFRESH_MESSAGE)
      expect(library.navigationLoading).toBe(false)
    },
  )

  it('真正写失败仍 reject，不发后续读取 GET，navigationError 不误报已保存', async () => {
    const { calls } = installFetch({ writeSucceeds: false, readSucceeds: true })
    const library = useLibraryStore()

    await expect(library.createFolder('新目录', null)).rejects.toThrow('写入失败')

    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(0)
    expect(library.navigationError).toBe('')
    expect(library.navigationLoading).toBe(false)
  })
})

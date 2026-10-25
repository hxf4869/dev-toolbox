import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../lib/api'
import type { AssistantApi } from './assistantApi'
import {
  assistantModelFixture,
  assistantMessageFixture,
  bootstrapFixtures,
  conversationFixture,
  runFixtures,
  runStartFixture,
  userMessageFixture,
} from './assistantMocks'
import { useAssistantStore } from './assistantStore'

describe('assistant store auth-expired observation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') })
  })

  it('stops retrying on 401 AUTH_REQUIRED with a login-expired notice while keeping data', async () => {
    vi.useFakeTimers()
    try {
      const streamPersistentRun = vi.fn(async function* () {
        yield {
          type: 'snapshot',
          data: {
            lastSequence: 0,
            run: structuredClone(runFixtures.running),
            assistantMessage: {
              ...structuredClone(runStartFixture.assistantMessage),
              currentRun: structuredClone(runFixtures.running),
            },
          },
        }
        yield { type: 'answer.delta', data: { sequence: 1, delta: '断线前。' } }
        throw new ApiError(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } })
      })
      const store = useAssistantStore()
      store.setApi(createApi({ streamPersistentRun }))
      await store.initialize()
      store.draft = '测试登录失效'

      await store.send()
      await flushPromises()

      expect(streamPersistentRun).toHaveBeenCalledTimes(1)
      expect(store.reconnecting).toBe(false)
      expect(store.streamMessage).toContain('登录已失效')
      // 已收到的回答与流式状态保留：不伪造 Run 失败或取消。
      expect(store.displayMessages.at(-1)?.content).toBe('断线前。')
      expect(store.displayMessages.at(-1)?.status).toBe('streaming')
      expect(store.activeConversation?.id).toBe(conversationFixture.id)
      expect(store.selectedModelId).toBe(assistantModelFixture.id)

      store.draft = '重新登录后继续'
      await vi.advanceTimersByTimeAsync(2000)
      await flushPromises()

      expect(streamPersistentRun).toHaveBeenCalledTimes(1)
      expect(store.reconnecting).toBe(false)
      expect(store.streamMessage).toContain('登录已失效')
      expect(store.draft).toBe('重新登录后继续')
    } finally {
      vi.useRealTimers()
    }
  })

  it('observes again after re-selecting the conversation once re-authenticated', async () => {
    vi.useFakeTimers()
    try {
      let connection = 0
      const streamPersistentRun = vi.fn(async function* () {
        connection += 1
        if (connection === 1) {
          yield {
            type: 'snapshot',
            data: {
              lastSequence: 0,
              run: structuredClone(runFixtures.running),
              assistantMessage: {
                ...structuredClone(runStartFixture.assistantMessage),
                currentRun: structuredClone(runFixtures.running),
              },
            },
          }
          yield { type: 'answer.delta', data: { sequence: 1, delta: '断线前。' } }
          throw new ApiError(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } })
        }
        yield {
          type: 'snapshot',
          data: {
            lastSequence: 1,
            run: structuredClone(runFixtures.running),
            assistantMessage: {
              ...structuredClone(assistantMessageFixture),
              content: '断线前。',
              status: 'streaming',
              currentRun: structuredClone(runFixtures.running),
            },
          },
        }
        yield {
          type: 'run.completed',
          data: { sequence: 2, run: { ...structuredClone(runFixtures.succeeded), lastSequence: 2 } },
        }
      })
      const getMessages = vi.fn().mockResolvedValue({
        items: [
          structuredClone(userMessageFixture),
          {
            ...structuredClone(assistantMessageFixture),
            content: '',
            status: 'streaming',
            currentRun: structuredClone(runFixtures.running),
          },
        ],
        nextCursor: null,
      })
      const store = useAssistantStore()
      store.setApi(createApi({ streamPersistentRun, getMessages }))
      await store.initialize()
      store.draft = '测试登录失效'

      await store.send()
      await flushPromises()
      expect(streamPersistentRun).toHaveBeenCalledTimes(1)

      await store.selectConversation(conversationFixture)
      await flushPromises()

      expect(streamPersistentRun).toHaveBeenCalledTimes(2)
      expect(store.reconnecting).toBe(false)
      expect(store.streamMessage).toBe('')
      expect(store.displayMessages.at(-1)?.status).toBe('complete')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps reconnecting on 401 with a different error code', async () => {
    vi.useFakeTimers()
    try {
      let connection = 0
      const streamPersistentRun = vi.fn(async function* () {
        connection += 1
        if (connection === 1) {
          yield {
            type: 'snapshot',
            data: {
              lastSequence: 0,
              run: structuredClone(runFixtures.running),
              assistantMessage: {
                ...structuredClone(runStartFixture.assistantMessage),
                currentRun: structuredClone(runFixtures.running),
              },
            },
          }
          throw new ApiError(401, {
            error: { code: 'AUTH_INVALID_CREDENTIALS', message: '用户名或密码不正确' },
          })
        }
        yield {
          type: 'snapshot',
          data: {
            lastSequence: 0,
            run: structuredClone(runFixtures.running),
            assistantMessage: {
              ...structuredClone(runStartFixture.assistantMessage),
              currentRun: structuredClone(runFixtures.running),
            },
          },
        }
        yield {
          type: 'run.completed',
          data: { sequence: 1, run: { ...structuredClone(runFixtures.succeeded), lastSequence: 1 } },
        }
      })
      const store = useAssistantStore()
      store.setApi(createApi({ streamPersistentRun }))
      await store.initialize()
      store.draft = '测试其他 401'

      await store.send()
      await flushPromises()

      expect(store.reconnecting).toBe(true)
      expect(store.streamMessage).toContain('连接暂时中断')

      await vi.advanceTimersByTimeAsync(600)
      await flushPromises()

      expect(streamPersistentRun).toHaveBeenCalledTimes(2)
      expect(store.reconnecting).toBe(false)
      expect(store.streamMessage).toBe('')
      expect(store.displayMessages.at(-1)?.status).toBe('complete')
    } finally {
      vi.useRealTimers()
    }
  })
})

function createApi(overrides: Partial<AssistantApi> = {}): AssistantApi {
  const defaults: AssistantApi = {
    getBootstrap: vi.fn().mockResolvedValue(structuredClone(bootstrapFixtures.ready)),
    getEmbeddingSettings: vi.fn(),
    putEmbeddingSettings: vi.fn(),
    deleteEmbeddingSettings: vi.fn(),
    testEmbeddingSettings: vi.fn(),
    getIndexStatus: vi.fn(),
    getIndexFailures: vi.fn(),
    retryIndexFailure: vi.fn(),
    getFolders: vi.fn().mockResolvedValue({ items: [] }),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    getConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getConversation: vi.fn().mockResolvedValue(structuredClone(conversationFixture)),
    patchConversation: vi.fn(),
    deleteConversation: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    startRun: vi.fn().mockResolvedValue(structuredClone(runStartFixture)),
    getRun: vi.fn(),
    stopRun: vi.fn(),
    retryRun: vi.fn(),
    getSource: vi.fn(),
    streamPersistentRun: async function* () {},
    streamTemporaryRun: async function* () {},
  }
  return { ...defaults, ...overrides }
}

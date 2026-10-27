import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../lib/api'
import type { AssistantApi } from './assistantApi'
import type { AssistantConversationDTO, TemporarySourceDTO } from './assistantContracts'
import {
  assistantModelFixture,
  bootstrapFixtures,
  conversationFixture,
  folderFixture,
  persistentStreamFixtures,
  runFixtures,
  runStartFixture,
  sourceFixtures,
} from './assistantMocks'
import { useAssistantStore } from './assistantStore'

describe('assistant store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') })
  })

  it('never silently selects the first model for first use or an unavailable recent model', async () => {
    for (const bootstrap of [bootstrapFixtures.firstUse, bootstrapFixtures.lastModelUnavailable]) {
      setActivePinia(createPinia())
      const store = useAssistantStore()
      store.setApi(createApi({ getBootstrap: vi.fn().mockResolvedValue(bootstrap) }))
      await store.initialize()

      expect(store.models).toHaveLength(1)
      expect(store.selectedModelId).toBeNull()
      expect(store.selectionRequired).toBe(true)
    }
  })

  it('restores the last actual reasoning for each model when switching', async () => {
    const secondModel = {
      ...assistantModelFixture,
      id: '22222222-2222-4222-8222-222222222223',
      displayName: '快速模型',
      lastReasoning: 'off' as const,
    }
    const bootstrap = {
      ...bootstrapFixtures.ready,
      models: [assistantModelFixture, secondModel],
    }
    const store = useAssistantStore()
    store.setApi(createApi({ getBootstrap: vi.fn().mockResolvedValue(bootstrap) }))
    await store.initialize()

    expect(store.selectedReasoning).toBe('medium')
    store.chooseReasoning('high')
    store.chooseModel(secondModel.id)
    expect(store.selectedReasoning).toBe('off')
    store.chooseModel(assistantModelFixture.id)
    expect(store.selectedReasoning).toBe('high')
  })

  it('keeps persistent drafts per conversation in sessionStorage and temporary drafts in memory', async () => {
    sessionStorage.setItem(`dev-toolbox:assistant:draft:${conversationFixture.id}`, '会话草稿')
    const store = useAssistantStore()
    store.setApi(createApi())
    await store.initialize()

    store.draft = '新会话草稿'
    expect(sessionStorage.getItem('dev-toolbox:assistant:draft:new')).toBe('新会话草稿')

    await store.selectConversation(conversationFixture)
    expect(store.draft).toBe('会话草稿')
    store.startTemporaryConversation()
    store.draft = '临时草稿'
    expect(sessionStorage.getItem('dev-toolbox:assistant:draft:new')).toBe('新会话草稿')
    expect(sessionStorage.getItem(`dev-toolbox:assistant:draft:${conversationFixture.id}`)).toBe('会话草稿')

    store.resetTemporaryConversation()
    expect(store.draft).toBe('')
  })

  it('retains the draft when run creation fails', async () => {
    const store = useAssistantStore()
    store.setApi(
      createApi({
        startRun: vi.fn().mockRejectedValue(new Error('网络不可用')),
      }),
    )
    await store.initialize()
    store.draft = '不要丢失这条消息'

    await store.send()

    expect(store.draft).toBe('不要丢失这条消息')
    expect(store.actionError).toBe('网络不可用')
    expect(store.displayMessages).toHaveLength(0)
  })

  it('applies a stream snapshot and reaches terminal state', async () => {
    const streamPersistentRun = vi.fn(async function* () {
      for (const event of persistentStreamFixtures.reasoningAndCitation) yield structuredClone(event)
    })
    const store = useAssistantStore()
    store.setApi(createApi({ streamPersistentRun }))
    await store.initialize()
    store.draft = '如何迁移 Docker 数据目录？'

    await store.send()
    await flushPromises()

    const answer = store.displayMessages.find((message) => message.role === 'assistant')
    expect(answer?.content).toBe('先停止 Docker 服务。[[C1]]')
    expect(answer?.reasoningContent).toBe('正在核对来源。')
    expect(answer?.status).toBe('complete')
    expect(store.hasActiveRun).toBe(false)
  })

  it('reconnects a persistent run from the last sequence without cancelling it', async () => {
    vi.useFakeTimers()
    try {
      let connection = 0
      const streamPersistentRun = vi.fn(async function* (
        _runId: string,
        _options: { afterSequence?: number; signal: AbortSignal },
      ) {
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
          throw new Error('连接断开')
        }
        yield {
          type: 'snapshot',
          data: {
            lastSequence: 1,
            run: structuredClone(runFixtures.running),
            assistantMessage: {
              ...structuredClone(runStartFixture.assistantMessage),
              content: '断线前。',
              currentRun: structuredClone(runFixtures.running),
            },
          },
        }
        yield { type: 'answer.delta', data: { sequence: 2, delta: '恢复后。' } }
        yield {
          type: 'run.completed',
          data: { sequence: 3, run: { ...structuredClone(runFixtures.succeeded), lastSequence: 3 } },
        }
      })
      const store = useAssistantStore()
      store.setApi(createApi({ streamPersistentRun }))
      await store.initialize()
      store.draft = '测试续流'

      await store.send()
      await flushPromises()
      expect(store.reconnecting).toBe(true)
      expect(store.displayMessages.at(-1)?.content).toBe('断线前。')

      await vi.advanceTimersByTimeAsync(600)
      await flushPromises()
      expect(streamPersistentRun).toHaveBeenCalledTimes(2)
      expect(streamPersistentRun.mock.calls[1]?.[1]).toMatchObject({ afterSequence: 1 })
      expect(store.displayMessages.at(-1)?.content).toBe('断线前。恢复后。')
      expect(store.reconnecting).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends observation with cleared reconnect state when the run is gone (404)', async () => {
    vi.useFakeTimers()
    try {
      const streamPersistentRun = vi.fn(async function* (
        _runId: string,
        _options: { afterSequence?: number; signal: AbortSignal },
      ) {
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
        yield { type: 'answer.delta', data: { sequence: 1, delta: '被删除前。' } }
        throw new ApiError(404, {
          error: { code: 'NOT_FOUND', message: '会话不存在或已被清理', requestId: 'req-404' },
        })
      })
      const store = useAssistantStore()
      store.setApi(createApi({ streamPersistentRun }))
      await store.initialize()
      store.draft = '测试 404 清理'

      await store.send()
      await flushPromises()
      // 重连徽标与“正在恢复回答”文案必须清掉，错误反馈保留。
      expect(store.reconnecting).toBe(false)
      expect(store.streamMessage).toBe('')
      expect(store.actionError).toBe('会话不存在或已被清理')
      // 已收到的消息保留，Run 未被伪造为 failed/cancelled。
      expect(store.displayMessages.at(-1)?.content).toBe('被删除前。')
      const observedRuns = store.messages
        .filter((message) => message.currentRun)
        .map((message) => message.currentRun?.status)
      expect(observedRuns).toContain('running')
      // 不再重连：推进多个重连间隔后连接次数不变。
      const callsAfter404 = streamPersistentRun.mock.calls.length
      await vi.advanceTimersByTimeAsync(6_000)
      await flushPromises()
      expect(streamPersistentRun.mock.calls.length).toBe(callsAfter404)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards both explicit folder deletion behaviors without inventing a default', async () => {
    const deleteFolder = vi.fn().mockResolvedValue(undefined)
    const store = useAssistantStore()
    store.setApi(createApi({ deleteFolder }))
    await store.initialize()

    await store.deleteFolder(folderFixture.id, 'unfile')
    await store.deleteFolder(folderFixture.id, 'delete')

    expect(deleteFolder.mock.calls).toEqual([
      [folderFixture.id, 'unfile'],
      [folderFixture.id, 'delete'],
    ])
  })

  it('resolves temporary citations within the message that emitted them', async () => {
    const store = useAssistantStore()
    const { runId: _firstRunId, ...firstSource } = sourceFixtures.available
    const { runId: _secondRunId, ...derivedSource } = sourceFixtures.aiDerived
    const secondSource = {
      ...derivedSource,
      citationNumber: 1,
      title: '第二条回答的来源',
    }
    const message = (id: string, source: TemporarySourceDTO) => ({
      id,
      role: 'assistant' as const,
      content: '[[C1]]',
      reasoningContent: null,
      reasoningDurationMs: null,
      status: 'complete' as const,
      citations: [{
        sourceOrdinal: source.sourceOrdinal,
        citationNumber: source.citationNumber,
        sourceKind: source.sourceKind,
        sourceClass: source.sourceClass,
        title: source.title,
        availability: source.availability,
      }],
      run: null,
      temporaryRuntime: null,
      temporary: true,
      sources: { 1: source },
    })
    store.temporaryMessages.push(message('temporary-1', firstSource))
    store.temporaryMessages.push(message('temporary-2', secondSource))

    const resolved = await store.getSource(message('unused', secondSource).citations[0]!, 'temporary-2')
    expect(resolved.title).toBe('第二条回答的来源')
  })

  it('re-confirms a persistent source on every open so the current title is shown', async () => {
    const store = useAssistantStore()
    const getSource = vi
      .fn()
      .mockResolvedValueOnce(structuredClone(sourceFixtures.available))
      .mockResolvedValueOnce({
        ...structuredClone(sourceFixtures.available),
        currentTitle: '已重命名的数据目录',
        titleChanged: true,
      })
    store.setApi(createApi({ getSource }))

    const first = await store.getSource(sourceFixtures.available)
    const second = await store.getSource(sourceFixtures.available)

    expect(first.currentTitle).toBe('Docker 数据迁移与校验')
    expect(second.currentTitle).toBe('已重命名的数据目录')
    expect(second.title).toBe('Docker 数据目录迁移记录')
  })

  it('re-checks deletion on reopen instead of replaying the first cached source', async () => {
    const store = useAssistantStore()
    const getSource = vi
      .fn()
      .mockResolvedValueOnce(structuredClone(sourceFixtures.available))
      .mockResolvedValueOnce(structuredClone(sourceFixtures.deleted))
    store.setApi(createApi({ getSource }))

    const first = await store.getSource(sourceFixtures.available)
    const second = await store.getSource(sourceFixtures.available)

    expect(first.availability).toBe('available')
    expect(second.availability).toBe('unavailable')
    expect(second.excerpt).toBeNull()
    expect(second.locator).toBeNull()
    expect(second.currentTitle).toBeNull()
  })

  it('propagates the old-run NOT_FOUND error instead of returning the cached source', async () => {
    const store = useAssistantStore()
    const superseded = new ApiError(404, {
      error: { code: 'NOT_FOUND', message: '资源不存在', requestId: 'req-1' },
    })
    const getSource = vi
      .fn()
      .mockResolvedValueOnce(structuredClone(sourceFixtures.available))
      .mockRejectedValueOnce(superseded)
    store.setApi(createApi({ getSource }))

    const first = await store.getSource(sourceFixtures.available)
    await expect(store.getSource(sourceFixtures.available)).rejects.toBe(superseded)
    expect(first.title).toBe('Docker 数据目录迁移记录')
  })

  describe('navigation scope ownership', () => {
    const OTHER_FOLDER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    function conversationVariant(id: string, title: string, folderId: string) {
      return {
        ...structuredClone(conversationFixture),
        id,
        title,
        folderId,
      }
    }

    it('supersedes a pending scope load and drops its late response and busy unlock', async () => {
      const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 会话', folderFixture.id)
      const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话', OTHER_FOLDER_ID)
      const loadA = deferred<ConversationPage>()
      const loadB = deferred<ConversationPage>()
      const getConversations = vi
        .fn()
        .mockResolvedValueOnce({ items: [structuredClone(conversationFixture)], nextCursor: null })
        .mockImplementationOnce(() => loadA.promise)
        .mockImplementationOnce(() => loadB.promise)
      const store = useAssistantStore()
      store.setApi(createApi({ getConversations }))
      await store.initialize()
      expect(getConversations).toHaveBeenCalledTimes(1)

      void store.setFolderFilter(folderFixture.id)
      expect(store.conversations).toEqual([])
      expect(store.conversationNextCursor).toBeNull()
      void store.setFolderFilter(OTHER_FOLDER_ID)
      expect(store.navigationLoading).toBe(true)

      loadA.resolve({ items: [convA], nextCursor: 'a1' })
      await flushPromises()
      expect(store.conversations).toEqual([])
      expect(store.navigationLoading).toBe(true)

      loadB.resolve({ items: [convB], nextCursor: 'b1' })
      await flushPromises()
      expect(store.conversations.map((entry) => entry.id)).toEqual([convB.id])
      expect(store.conversationNextCursor).toBe('b1')
      expect(store.navigationLoading).toBe(false)
    })

    it('keeps the newest scope result when the superseded load rejects late', async () => {
      const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话', OTHER_FOLDER_ID)
      const loadA = deferred<ConversationPage>()
      const loadB = deferred<ConversationPage>()
      const getConversations = vi
        .fn()
        .mockResolvedValueOnce({ items: [structuredClone(conversationFixture)], nextCursor: null })
        .mockImplementationOnce(() => loadA.promise)
        .mockImplementationOnce(() => loadB.promise)
      const store = useAssistantStore()
      store.setApi(createApi({ getConversations }))
      await store.initialize()

      void store.setFolderFilter(folderFixture.id)
      void store.setFolderFilter(OTHER_FOLDER_ID)

      loadB.resolve({ items: [convB], nextCursor: null })
      await flushPromises()
      expect(store.conversations.map((entry) => entry.id)).toEqual([convB.id])

      loadA.reject(new Error('旧请求失败'))
      await flushPromises()
      expect(store.actionError).toBe('')
      expect(store.conversations.map((entry) => entry.id)).toEqual([convB.id])
      expect(store.navigationLoading).toBe(false)
    })

    it('does not merge a stale append response into a newer scope', async () => {
      const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 追加会话', folderFixture.id)
      const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话', OTHER_FOLDER_ID)
      const appendLoad = deferred<ConversationPage>()
      const scopeLoad = deferred<ConversationPage>()
      const getConversations = vi
        .fn()
        .mockResolvedValueOnce({ items: [structuredClone(conversationFixture)], nextCursor: 'page-1' })
        .mockImplementationOnce(() => appendLoad.promise)
        .mockImplementationOnce(() => scopeLoad.promise)
      const store = useAssistantStore()
      store.setApi(createApi({ getConversations }))
      await store.initialize()
      expect(store.conversationNextCursor).toBe('page-1')

      void store.loadNavigation(true)
      expect(getConversations.mock.calls[1]?.[0]).toMatchObject({ cursor: 'page-1' })
      void store.setFolderFilter(OTHER_FOLDER_ID)

      scopeLoad.resolve({ items: [convB], nextCursor: null })
      await flushPromises()
      appendLoad.resolve({ items: [convA], nextCursor: null })
      await flushPromises()

      expect(store.conversations.map((entry) => entry.id)).toEqual([convB.id])
      expect(store.conversationNextCursor).toBeNull()
    })

    it('invalidates pending navigation on dispose and allows navigation on the next mount', async () => {
      const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 会话', folderFixture.id)
      const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话', OTHER_FOLDER_ID)
      const staleLoad = deferred<ConversationPage>()
      const nextLoad = deferred<ConversationPage>()
      const getConversations = vi
        .fn()
        .mockResolvedValueOnce({ items: [structuredClone(conversationFixture)], nextCursor: null })
        .mockImplementationOnce(() => staleLoad.promise)
        .mockImplementationOnce(() => nextLoad.promise)
      const store = useAssistantStore()
      store.setApi(createApi({ getConversations }))
      await store.initialize()

      void store.setFolderFilter(folderFixture.id)
      store.disposeView()
      expect(store.navigationLoading).toBe(false)

      staleLoad.resolve({ items: [convA], nextCursor: 'a1' })
      await flushPromises()
      expect(store.conversations).toEqual([])
      expect(store.conversationNextCursor).toBeNull()

      void store.setFolderFilter(OTHER_FOLDER_ID)
      nextLoad.resolve({ items: [convB], nextCursor: null })
      await flushPromises()
      expect(store.conversations.map((entry) => entry.id)).toEqual([convB.id])
      expect(store.navigationLoading).toBe(false)
    })
  })
})

interface ConversationPage {
  items: AssistantConversationDTO[]
  nextCursor: string | null
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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
    getFolders: vi.fn().mockResolvedValue({ items: [structuredClone(folderFixture)] }),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn().mockResolvedValue(undefined),
    getConversations: vi.fn().mockResolvedValue({
      items: [structuredClone(conversationFixture)],
      nextCursor: null,
    }),
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

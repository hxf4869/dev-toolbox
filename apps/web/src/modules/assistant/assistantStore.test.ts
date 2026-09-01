import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantApi } from './assistantApi'
import type { TemporarySourceDTO } from './assistantContracts'
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

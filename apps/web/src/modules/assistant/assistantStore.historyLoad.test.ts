import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantApi } from './assistantApi'
import type {
  AssistantConversationDTO,
  AssistantMessageDTO,
  AssistantRunDTO,
} from './assistantContracts'
import type { SseEnvelope } from './assistantSse'
import {
  assistantMessageFixture,
  bootstrapFixtures,
  conversationFixture,
  persistentStreamFixtures,
  runFixtures,
  runStartFixture,
  userMessageFixture,
} from './assistantMocks'
import { useAssistantStore } from './assistantStore'

// DT-R115：初次历史选择（selectConversation 的 getMessages）迟到返回时，等待期
// 间的新对话/临时对话/新会话点击不得被忙时守卫吞掉，也不得把旧历史落进当前上
// 下文、启动旧观察、冒错误或提前解除当前正在进行的加载。deferred getMessages
// 模拟响应在切换之后才回来。
describe('assistant store history load ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') })
  })

  it('does not drop a late history response into a new conversation started while loading', async () => {
    const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话')
    const loadB = deferred<MessagePage>()
    const streamPersistentRun = vi.fn(async function* () {})
    const getMessages = vi.fn().mockImplementationOnce(() => loadB.promise)
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages, streamPersistentRun }))
    await store.initialize()

    void store.selectConversation(convB)
    store.startNewConversation()
    expect(store.activeConversation).toBeNull()

    // B 的历史里带一条 running run：迟到写入还会试图恢复旧观察。
    loadB.resolve({
      items: [historyMessage(convB.id, 1), runningAssistantMessage(convB.id, 2)],
      nextCursor: 'b-cursor',
    })
    await flushPromises()

    expect(store.messages).toHaveLength(0)
    expect(store.messageNextCursor).toBeNull()
    expect(streamPersistentRun).not.toHaveBeenCalled()
    expect(store.conversationLoading).toBe(false)
  })

  it('lets the newest conversation click win and drops the out-of-order older response', async () => {
    const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 会话')
    const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话')
    const loadB = deferred<MessagePage>()
    const loadA = deferred<MessagePage>()
    const streamPersistentRun = vi.fn(async function* () {})
    const getMessages = vi
      .fn()
      .mockImplementationOnce(() => loadB.promise)
      .mockImplementationOnce(() => loadA.promise)
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages, streamPersistentRun }))
    await store.initialize()

    void store.selectConversation(convB)
    void store.selectConversation(convA)
    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(store.activeConversation?.id).toBe(convA.id)

    const messageA = historyMessage(convA.id, 1)
    loadA.resolve({ items: [messageA], nextCursor: 'a-cursor' })
    await flushPromises()
    expect(store.messages.map((message) => message.id)).toEqual([messageA.id])
    expect(store.conversationLoading).toBe(false)

    loadB.resolve({
      items: [historyMessage(convB.id, 1), runningAssistantMessage(convB.id, 2)],
      nextCursor: 'b-cursor',
    })
    await flushPromises()

    expect(store.messages.map((message) => message.id)).toEqual([messageA.id])
    expect(store.messageNextCursor).toBe('a-cursor')
    expect(streamPersistentRun).not.toHaveBeenCalled()
    expect(store.conversationLoading).toBe(false)
  })

  it('keeps the newest load running and its context clean when the superseded load rejects late', async () => {
    const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 会话')
    const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话')
    const loadB = deferred<MessagePage>()
    const loadA = deferred<MessagePage>()
    const getMessages = vi
      .fn()
      .mockImplementationOnce(() => loadB.promise)
      .mockImplementationOnce(() => loadA.promise)
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages }))
    await store.initialize()

    void store.selectConversation(convB)
    void store.selectConversation(convA)

    loadB.reject(new Error('B 会话历史读取失败'))
    await flushPromises()
    expect(store.actionError).toBe('')
    expect(store.conversationLoading).toBe(true)

    const messageA = historyMessage(convA.id, 1)
    loadA.resolve({ items: [messageA], nextCursor: null })
    await flushPromises()
    expect(store.messages.map((message) => message.id)).toEqual([messageA.id])
    expect(store.conversationLoading).toBe(false)
  })

  it('does not surface a late history failure after switching to a temporary conversation', async () => {
    const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话')
    const loadB = deferred<MessagePage>()
    const getMessages = vi.fn().mockImplementationOnce(() => loadB.promise)
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages }))
    await store.initialize()

    void store.selectConversation(convB)
    store.startTemporaryConversation()
    expect(store.temporaryMode).toBe(true)

    loadB.reject(new Error('B 会话历史读取失败'))
    await flushPromises()

    expect(store.actionError).toBe('')
    expect(store.messages).toHaveLength(0)
    expect(store.conversationLoading).toBe(false)
  })

  it('drops a late older-messages page after leaving the conversation', async () => {
    const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 会话')
    const olderLoad = deferred<MessagePage>()
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [historyMessage(convA.id, 2)], nextCursor: 'cursor-1' })
      .mockImplementationOnce(() => olderLoad.promise)
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages }))
    await store.initialize()
    await store.selectConversation(convA)
    expect(store.messageNextCursor).toBe('cursor-1')

    void store.loadOlderMessages()
    store.startNewConversation()
    olderLoad.resolve({ items: [historyMessage(convA.id, 1)], nextCursor: null })
    await flushPromises()

    expect(store.messages).toHaveLength(0)
    expect(store.messageNextCursor).toBeNull()
    expect(store.conversationLoading).toBe(false)
  })

  it('serves the conversation clicked during a pending older page and drops that page', async () => {
    const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 会话')
    const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话')
    const olderLoad = deferred<MessagePage>()
    const messageB = historyMessage(convB.id, 1)
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [historyMessage(convA.id, 2)], nextCursor: 'cursor-1' })
      .mockImplementationOnce(() => olderLoad.promise)
      .mockResolvedValueOnce({ items: [messageB], nextCursor: null })
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages }))
    await store.initialize()
    await store.selectConversation(convA)
    expect(store.messageNextCursor).toBe('cursor-1')

    void store.loadOlderMessages()
    void store.selectConversation(convB)
    expect(getMessages).toHaveBeenCalledTimes(3)
    expect(store.activeConversation?.id).toBe(convB.id)

    olderLoad.resolve({ items: [historyMessage(convA.id, 1)], nextCursor: 'a-older' })
    await flushPromises()

    expect(store.messages.map((message) => message.id)).toEqual([messageB.id])
    expect(store.messageNextCursor).toBeNull()
    expect(store.conversationLoading).toBe(false)
  })

  it('clears the previous conversation history immediately when selecting another one', async () => {
    const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 会话')
    const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话')
    sessionStorage.setItem(`dev-toolbox:assistant:draft:${convB.id}`, '给B的草稿')
    const loadB = deferred<MessagePage>()
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [historyMessage(convA.id, 1)], nextCursor: 'a-cursor' })
      .mockImplementationOnce(() => loadB.promise)
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages }))
    await store.initialize()
    await store.selectConversation(convA)
    expect(store.messages).toHaveLength(1)
    expect(store.messageNextCursor).toBe('a-cursor')

    // B 读取延迟期间：B 标题下不能挂着 A 的历史（读取态要求 messages 为空）。
    void store.selectConversation(convB)
    expect(store.activeConversation?.id).toBe(convB.id)
    expect(store.messages).toHaveLength(0)
    expect(store.messageNextCursor).toBeNull()

    loadB.reject(new Error('B 会话历史读取失败'))
    await flushPromises()

    // 读取失败后同样不留 A 历史；B 的草稿/模型与可操作的错误提示保留。
    expect(store.messages).toHaveLength(0)
    expect(store.messageNextCursor).toBeNull()
    expect(store.actionError).toBe('B 会话历史读取失败')
    expect(store.draft).toBe('给B的草稿')
    expect(store.selectedModelId).toBe(convB.modelId)
    expect(store.conversationLoading).toBe(false)
  })

  it('keeps the sent pair and streamed content when the delayed history page arrives late', async () => {
    const pendingHistory = deferred<MessagePage>()
    const streamPersistentRun = vi.fn(async function* () {
      for (const envelope of persistentStreamFixtures.reasoningAndCitation) yield structuredClone(envelope)
    })
    const getMessages = vi.fn().mockImplementationOnce(() => pendingHistory.promise)
    const startRun = vi.fn().mockResolvedValue(structuredClone(runStartFixture))
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages, startRun, streamPersistentRun }))
    await store.initialize()

    // 历史读取在途：会话与草稿已就位，允许直接发送（startRun 先返回）。
    void store.selectConversation(conversationFixture)
    store.draft = '给A的问题'
    void store.send()
    await flushPromises()
    expect(store.displayMessages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(store.displayMessages.find((message) => message.role === 'assistant')?.status).toBe('complete')

    store.draft = '紧接着再问一条'
    const older = historyMessage(conversationFixture.id, 0)
    pendingHistory.resolve({ items: [older], nextCursor: 'a-cursor' })
    await flushPromises()

    const user = store.displayMessages.find((message) => message.role === 'user')
    expect(user?.content).toBe(userMessageFixture.content)
    const answer = store.displayMessages.find((message) => message.role === 'assistant')
    expect(answer?.content).toBe('先停止 Docker 服务。[[C1]]')
    expect(answer?.status).toBe('complete')
    expect(store.messages.map((message) => message.id)).toContain(older.id)
    expect(store.draft).toBe('紧接着再问一条')
    expect(store.hasActiveRun).toBe(false)
    expect(store.messageNextCursor).toBe('a-cursor')
  })

  it('keeps observing the newest run when a stale page carries an older running run', async () => {
    const pendingHistory = deferred<MessagePage>()
    const continueStream = deferred<void>()
    const newRunId = runStartFixture.run.id
    const streamPersistentRun = vi.fn(async function* (runId: string) {
      // 旧 Run 不应被观察：一旦被调用即以空流返回（由调用次数断言暴露）。
      if (runId !== newRunId) return
      yield streamSnapshot(structuredClone(runFixtures.running), streamingAssistant(''), 0)
      yield streamEvent('answer.delta', { sequence: 1, delta: '第一段。' })
      await continueStream.promise
      yield streamEvent('answer.delta', { sequence: 2, delta: '第二段。' })
      yield streamEvent('run.completed', { sequence: 3, run: structuredClone(runFixtures.succeeded) })
    })
    const getMessages = vi.fn().mockImplementationOnce(() => pendingHistory.promise)
    const startRun = vi.fn().mockResolvedValue(structuredClone(runStartFixture))
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages, startRun, streamPersistentRun }))
    await store.initialize()

    void store.selectConversation(conversationFixture)
    store.draft = '给A的问题'
    void store.send()
    await flushPromises()
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)
    expect(streamPersistentRun.mock.calls[0]?.[0]).toBe(newRunId)
    expect(store.displayMessages.at(-1)?.content).toBe('第一段。')

    // 旧页：较早消息携带 running 旧 Run（服务器上已结束），不含新 pair。
    const olderRun: AssistantRunDTO = { ...structuredClone(runFixtures.running), id: 'older-run' }
    const oldAssistant: AssistantMessageDTO = {
      ...structuredClone(assistantMessageFixture),
      id: 'old-assistant',
      conversationId: conversationFixture.id,
      sequence: 1,
      currentRun: olderRun,
    }
    pendingHistory.resolve({ items: [oldAssistant], nextCursor: null })
    await flushPromises()

    // 未退回旧 Run、未重启观察（重启会先停掉当前观察、中断流式推进）。
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)
    expect(store.hasActiveRun).toBe(true)
    expect(store.displayMessages.at(-1)?.id).toBe(assistantMessageFixture.id)

    continueStream.resolve()
    await flushPromises()

    const answer = store.displayMessages.find(
      (message) => message.role === 'assistant' && message.id === assistantMessageFixture.id,
    )
    expect(answer?.content).toBe('第一段。第二段。')
    expect(answer?.status).toBe('complete')
    // 新 Run 完成后，过期旧 running 不被当作当前运行（发送能力恢复）。
    expect(store.hasActiveRun).toBe(false)
  })

  it('does not resume an older running run after the newest run finished', async () => {
    const pendingHistory = deferred<MessagePage>()
    const newRunId = runStartFixture.run.id
    const streamPersistentRun = vi.fn(async function* (runId: string) {
      expect(runId).toBe(newRunId)
      yield streamSnapshot(structuredClone(runFixtures.running), streamingAssistant(''), 0)
      yield streamEvent('answer.delta', { sequence: 1, delta: '一段。' })
      yield streamEvent('run.completed', { sequence: 2, run: structuredClone(runFixtures.succeeded) })
    })
    const getMessages = vi.fn().mockImplementationOnce(() => pendingHistory.promise)
    const startRun = vi.fn().mockResolvedValue(structuredClone(runStartFixture))
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages, startRun, streamPersistentRun }))
    await store.initialize()

    void store.selectConversation(conversationFixture)
    store.draft = '给A的问题'
    void store.send()
    await flushPromises()
    expect(store.hasActiveRun).toBe(false)

    // 旧页携带较早消息与 running 旧 Run（服务器上已结束），新 Run 已完成。
    const olderRun: AssistantRunDTO = { ...structuredClone(runFixtures.running), id: 'older-run' }
    const oldAssistant: AssistantMessageDTO = {
      ...structuredClone(assistantMessageFixture),
      id: 'old-assistant',
      conversationId: conversationFixture.id,
      sequence: 1,
      currentRun: olderRun,
    }
    pendingHistory.resolve({ items: [oldAssistant], nextCursor: null })
    await flushPromises()

    expect(streamPersistentRun).toHaveBeenCalledTimes(1)
    expect(store.hasActiveRun).toBe(false)
    // 旧消息保留服务器返回的真实状态，不伪造成终态。
    const mergedOld = store.messages.find((message) => message.id === oldAssistant.id)
    expect(mergedOld?.currentRun?.status).toBe('running')
  })

  it('does not re-observe the newest run before its first snapshot arrives', async () => {
    const pendingHistory = deferred<MessagePage>()
    const snapshotGate = deferred<void>()
    const newRunId = runStartFixture.run.id
    const streamSignals: AbortSignal[] = []
    const streamPersistentRun = vi.fn(async function* (
      runId: string,
      options: { afterSequence?: number; signal: AbortSignal },
    ) {
      expect(runId).toBe(newRunId)
      streamSignals.push(options.signal)
      // 首个 snapshot 尚未到达：观察已建立，但流入口仍挂起。
      await snapshotGate.promise
      yield streamSnapshot(structuredClone(runFixtures.running), streamingAssistant(''), 0)
      yield streamEvent('answer.delta', { sequence: 1, delta: '一段。' })
      yield streamEvent('run.completed', { sequence: 2, run: structuredClone(runFixtures.succeeded) })
    })
    const getMessages = vi.fn().mockImplementationOnce(() => pendingHistory.promise)
    const startRun = vi.fn().mockResolvedValue(structuredClone(runStartFixture))
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages, startRun, streamPersistentRun }))
    await store.initialize()

    void store.selectConversation(conversationFixture)
    store.draft = '给A的问题'
    void store.send()
    await flushPromises()
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)

    // 首个 snapshot 前迟到历史页放行：不得重复观察同一最新 Run。
    pendingHistory.resolve({ items: [historyMessage(conversationFixture.id, 0)], nextCursor: null })
    await flushPromises()
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)
    expect(streamSignals[0]?.aborted).toBe(false)

    snapshotGate.resolve()
    await flushPromises()
    const answer = store.displayMessages.find(
      (message) => message.role === 'assistant' && message.id === assistantMessageFixture.id,
    )
    expect(answer?.content).toBe('一段。')
    expect(answer?.status).toBe('complete')
    expect(store.hasActiveRun).toBe(false)
  })

  it('clears the pagination cursor when switching from a conversation to temporary mode', async () => {
    const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 会话')
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [historyMessage(convA.id, 1)], nextCursor: 'a-cursor' })
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages }))
    await store.initialize()
    await store.selectConversation(convA)
    expect(store.messages).toHaveLength(1)
    expect(store.messageNextCursor).toBe('a-cursor')

    store.startTemporaryConversation()
    expect(store.temporaryMode).toBe(true)
    // 旧会话分页入口不再残留（“加载更早消息”只看 cursor，且临时模式无会话可分页）。
    expect(store.messageNextCursor).toBeNull()
    expect(store.messages).toHaveLength(0)
    store.draft = '临时草稿'
    expect(store.draft).toBe('临时草稿')
  })

  it('releases the loading flag on dispose and serves the next selection', async () => {
    const convA = conversationVariant('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'A 会话')
    const convB = conversationVariant('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'B 会话')
    const loadB = deferred<MessagePage>()
    const getMessages = vi
      .fn()
      .mockImplementationOnce(() => loadB.promise)
      .mockResolvedValueOnce({ items: [historyMessage(convA.id, 1)], nextCursor: null })
    const store = useAssistantStore()
    store.setApi(createApi({ getMessages }))
    await store.initialize()

    void store.selectConversation(convB)
    store.disposeView()
    expect(store.conversationLoading).toBe(false)

    loadB.resolve({ items: [historyMessage(convB.id, 1)], nextCursor: 'b-cursor' })
    await flushPromises()
    expect(store.messages).toHaveLength(0)
    expect(store.messageNextCursor).toBeNull()

    await store.selectConversation(convA)
    expect(store.activeConversation?.id).toBe(convA.id)
    expect(store.messages).toHaveLength(1)
    expect(store.conversationLoading).toBe(false)
  })
})

interface MessagePage {
  items: AssistantMessageDTO[]
  nextCursor: string | null
}

function conversationVariant(id: string, title: string): AssistantConversationDTO {
  return { ...structuredClone(conversationFixture), id, title }
}

function historyMessage(conversationId: string, sequence: number): AssistantMessageDTO {
  const message = structuredClone(userMessageFixture)
  message.id = `${conversationId}-msg-${sequence}`
  message.conversationId = conversationId
  message.sequence = sequence
  return message
}

function runningAssistantMessage(conversationId: string, sequence: number): AssistantMessageDTO {
  const message = structuredClone(assistantMessageFixture)
  message.conversationId = conversationId
  message.sequence = sequence
  message.currentRun = structuredClone(runFixtures.running)
  return message
}

function streamingAssistant(content: string): AssistantMessageDTO {
  return {
    ...structuredClone(assistantMessageFixture),
    content,
    status: 'streaming',
    currentRun: structuredClone(runFixtures.running),
    completedAt: null,
  }
}

function streamSnapshot(
  runValue: AssistantRunDTO,
  assistantMessage: AssistantMessageDTO,
  lastSequence: number,
): SseEnvelope {
  return { type: 'snapshot', data: { lastSequence, run: runValue, assistantMessage } }
}

function streamEvent(type: string, data: object): SseEnvelope {
  const sequence = (data as { sequence?: number }).sequence
  return { type, data, ...(sequence === undefined ? {} : { id: String(sequence) }) }
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
    getFolders: vi.fn().mockResolvedValue({ items: [structuredClone(conversationFixture)] }),
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

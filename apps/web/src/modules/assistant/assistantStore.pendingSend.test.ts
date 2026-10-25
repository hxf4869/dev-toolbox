import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantApi } from './assistantApi'
import type {
  AssistantConversationDTO,
  AssistantMessageDTO,
  AssistantMessageListDTO,
  AssistantRunDTO,
  RunStartResponseDTO,
  UUID,
} from './assistantContracts'
import {
  assistantMessageFixture,
  bootstrapFixtures,
  conversationFixture,
  MOCK_IDS,
  persistentStreamFixtures,
  runFixtures,
  runStartFixture,
  userMessageFixture,
} from './assistantMocks'
import type { SseEnvelope } from './assistantSse'
import { useAssistantStore } from './assistantStore'

// DT-R113：startRun 响应迟到时，等待期间用户的新草稿、上下文切换与当前
// 错误提示不得被旧响应覆盖、混入或清空。deferred startRun 模拟请求在
// 发送后才返回；textarea 与导航在等待期间保持可用。
describe('assistant store pending send', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') })
  })

  it('keeps a draft edited in the same conversation while its start request is pending', async () => {
    const pending = deferred<RunStartResponseDTO>()
    const store = useAssistantStore()
    store.setApi(createApi({ startRun: vi.fn().mockImplementation(() => pending.promise) }))
    await store.initialize()
    await store.selectConversation(conversationFixture)
    store.draft = '继续追问'
    void store.send()
    await flushPromises()

    store.draft = '继续追问，另外补充一点'
    pending.resolve(structuredClone(runStartFixture))
    await flushPromises()

    expect(store.draft).toBe('继续追问，另外补充一点')
    expect(sessionStorage.getItem(`dev-toolbox:assistant:draft:${conversationFixture.id}`)).toBe(
      '继续追问，另外补充一点',
    )
  })

  it('migrates an edited new-conversation draft from the new key to the created conversation', async () => {
    const pending = deferred<RunStartResponseDTO>()
    const store = useAssistantStore()
    store.setApi(createApi({ startRun: vi.fn().mockImplementation(() => pending.promise) }))
    await store.initialize()
    store.draft = '第一条'
    void store.send()
    await flushPromises()

    store.draft = '第一条，再补充'
    pending.resolve(structuredClone(runStartFixture))
    await flushPromises()

    expect(store.draft).toBe('第一条，再补充')
    expect(sessionStorage.getItem('dev-toolbox:assistant:draft:new')).toBeNull()
    expect(
      sessionStorage.getItem(`dev-toolbox:assistant:draft:${runStartFixture.conversation.id}`),
    ).toBe('第一条，再补充')

    // 迁移后的草稿跟随新会话键：新对话页不再读出已发送内容，切回新会话可继续编辑。
    store.startNewConversation()
    expect(store.draft).toBe('')
    await store.selectConversation(runStartFixture.conversation)
    expect(store.draft).toBe('第一条，再补充')
  })

  it('does not let a late success steal the view or merge messages after switching conversations', async () => {
    const otherConversation: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
    }
    sessionStorage.setItem('dev-toolbox:assistant:draft:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '给B的草稿')
    const pending = deferred<RunStartResponseDTO>()
    const streamPersistentRun = vi.fn(async function* () {})
    const store = useAssistantStore()
    store.setApi(
      createApi({
        startRun: vi.fn().mockImplementation(() => pending.promise),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    store.draft = '给A的问题'
    void store.send()
    await flushPromises()

    await store.selectConversation(otherConversation)
    pending.resolve(structuredClone(runStartFixture))
    await flushPromises()

    expect(store.activeConversation?.id).toBe(otherConversation.id)
    expect(store.messages).toHaveLength(0)
    expect(store.draft).toBe('给B的草稿')
    expect(
      sessionStorage.getItem('dev-toolbox:assistant:draft:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
    ).toBe('给B的草稿')
    // 已发送内容残留在旧会话键上的清理仍然生效，未发送的新草稿（B 键）不受影响。
    expect(sessionStorage.getItem(`dev-toolbox:assistant:draft:${conversationFixture.id}`)).toBeNull()
    expect(streamPersistentRun).not.toHaveBeenCalled()
    expect(store.sending).toBe(false)
  })

  it('does not let a late success pollute a temporary conversation started while pending', async () => {
    const pending = deferred<RunStartResponseDTO>()
    const store = useAssistantStore()
    store.setApi(createApi({ startRun: vi.fn().mockImplementation(() => pending.promise) }))
    await store.initialize()
    store.draft = '要发的消息'
    void store.send()
    await flushPromises()

    store.startTemporaryConversation()
    store.draft = '临时草稿'
    pending.resolve(structuredClone(runStartFixture))
    await flushPromises()

    expect(store.temporaryMode).toBe(true)
    expect(store.activeConversation).toBeNull()
    expect(store.messages).toHaveLength(0)
    expect(store.temporaryMessages).toHaveLength(0)
    expect(store.draft).toBe('临时草稿')
    expect(sessionStorage.getItem('dev-toolbox:assistant:draft:new')).toBeNull()
  })

  it('does not surface a late failure in an unrelated current context', async () => {
    const otherConversation: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
    }
    const pending = deferred<RunStartResponseDTO>()
    const store = useAssistantStore()
    store.setApi(createApi({ startRun: vi.fn().mockImplementation(() => pending.promise) }))
    await store.initialize()
    await store.selectConversation(conversationFixture)
    store.draft = '给A的问题'
    void store.send()
    await flushPromises()

    await store.selectConversation(otherConversation)
    pending.reject(new Error('Provider 超时'))
    await flushPromises()

    expect(store.actionError).toBe('')
    // 失败内容留在原会话键上，用户切回 A 仍可从草稿重试。
    expect(sessionStorage.getItem(`dev-toolbox:assistant:draft:${conversationFixture.id}`)).toBe('给A的问题')
    expect(store.sending).toBe(false)
  })

  it('clears the sent draft, shows the answer and observes when the view stayed', async () => {
    const streamPersistentRun = vi.fn(async function* () {
      for (const envelope of persistentStreamFixtures.reasoningAndCitation) yield structuredClone(envelope)
    })
    const store = useAssistantStore()
    store.setApi(createApi({ streamPersistentRun }))
    await store.initialize()
    store.draft = '如何迁移 Docker 数据目录？'
    await store.send()
    await flushPromises()

    expect(store.draft).toBe('')
    expect(sessionStorage.getItem('dev-toolbox:assistant:draft:new')).toBeNull()
    expect(
      sessionStorage.getItem(`dev-toolbox:assistant:draft:${runStartFixture.conversation.id}`),
    ).toBeNull()
    expect(store.activeConversation?.id).toBe(runStartFixture.conversation.id)
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)
    const answer = store.displayMessages.find((message) => message.role === 'assistant')
    expect(answer?.content).toBe('先停止 Docker 服务。[[C1]]')
    expect(answer?.status).toBe('complete')
  })
  it('recovers the run and pair when the user returns to the sending conversation before the late response', async () => {
    const otherConversation: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
    }
    const pending = deferred<RunStartResponseDTO>()
    const streamPersistentRun = vi.fn(async function* () {
      for (const envelope of persistentStreamFixtures.reasoningAndCitation) yield structuredClone(envelope)
    })
    const getMessages = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    const store = useAssistantStore()
    store.setApi(
      createApi({
        startRun: vi.fn().mockImplementation(() => pending.promise),
        streamPersistentRun,
        getMessages,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    store.draft = '给A的问题'
    void store.send()
    await flushPromises()

    // A→B→A：回切时服务器尚未创建本次 Run，getMessages 只拿到旧消息、无 activeRun。
    expect(getMessages).toHaveBeenCalledTimes(1)
    await store.selectConversation(otherConversation)
    await store.selectConversation(conversationFixture)
    expect(getMessages).toHaveBeenCalledTimes(3)
    pending.resolve(structuredClone(runStartFixture))
    await flushPromises()

    expect(store.activeConversation?.id).toBe(conversationFixture.id)
    expect(store.displayMessages.filter((message) => message.role === 'user')).toHaveLength(1)
    const answer = store.displayMessages.find((message) => message.role === 'assistant')
    expect(answer?.status).toBe('complete')
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)
    // 已发送内容不再以草稿形式残留（键与内存一致清空），sending 释放后不会重复提交。
    expect(store.draft).toBe('')
    expect(sessionStorage.getItem(`dev-toolbox:assistant:draft:${conversationFixture.id}`)).toBeNull()
    expect(store.sending).toBe(false)
  })

  it('clears the in-memory sent draft when returning to the new-conversation page before a late success', async () => {
    const otherConversation: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
    }
    const pending = deferred<RunStartResponseDTO>()
    const store = useAssistantStore()
    store.setApi(createApi({ startRun: vi.fn().mockImplementation(() => pending.promise) }))
    await store.initialize()
    store.draft = '要发的消息'
    void store.send()
    await flushPromises()

    await store.selectConversation(otherConversation)
    store.startNewConversation()
    pending.resolve(structuredClone(runStartFixture))
    await flushPromises()

    // 新对话页不抢入已创建的会话；已发送内容也不能留在内存草稿里等待重复提交。
    expect(store.activeConversation).toBeNull()
    expect(store.messages).toHaveLength(0)
    expect(store.draft).toBe('')
    expect(sessionStorage.getItem('dev-toolbox:assistant:draft:new')).toBeNull()
    expect(store.sending).toBe(false)
  })
})

// DT-R269：持久回答的重试/停止响应迟到时，等待期间的上下文切换（别的会话、
// 新对话、临时模式、视图销毁）与同一助手位置被新 Run 取代，都不得被旧响应
// 抢回视图、混入消息、接管或中止观察、或在别人的上下文里冒错；回到原会话时
// 仍要按 docs/16 §11.3 接纳新 Run（复用原助手消息位置并切换 current_run_id）。
describe('assistant store pending retry and stop attribution', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') })
  })

  it('does not let a late retry success steal the view or observe after switching conversations', async () => {
    const otherConversation: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
    }
    sessionStorage.setItem(
      'dev-toolbox:assistant:draft:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '给B的草稿',
    )
    const pending = deferred<RunStartResponseDTO>()
    const signals: AbortSignal[] = []
    const streamPersistentRun = parkedPersistentStream(signals)
    const store = useAssistantStore()
    store.setApi(
      createApi({
        retryRun: vi.fn().mockImplementation(() => pending.promise),
        getMessages: vi
          .fn()
          .mockResolvedValueOnce({
            items: [structuredClone(userMessageFixture), failedAssistantMessage()],
            nextCursor: null,
          })
          .mockResolvedValueOnce({ items: [], nextCursor: null }),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    void store.retryLastAnswer(MOCK_IDS.run)
    await flushPromises()

    await store.selectConversation(otherConversation)
    pending.resolve(retryResponseFixture())
    await flushPromises()

    expect(store.activeConversation?.id).toBe(otherConversation.id)
    expect(store.messages).toHaveLength(0)
    expect(store.draft).toBe('给B的草稿')
    expect(store.actionError).toBe('')
    expect(streamPersistentRun).not.toHaveBeenCalled()
    expect(store.sending).toBe(false)
  })

  it('does not surface a late retry failure on the new-conversation page', async () => {
    const pending = deferred<RunStartResponseDTO>()
    const store = useAssistantStore()
    store.setApi(
      createApi({
        retryRun: vi.fn().mockImplementation(() => pending.promise),
        getMessages: vi.fn().mockResolvedValue({
          items: [structuredClone(userMessageFixture), failedAssistantMessage()],
          nextCursor: null,
        }),
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    void store.retryLastAnswer(MOCK_IDS.run)
    await flushPromises()

    store.startNewConversation()
    store.draft = '新对话的草稿'
    pending.reject(new Error('资源不存在'))
    await flushPromises()

    expect(store.activeConversation).toBeNull()
    expect(store.actionError).toBe('')
    expect(store.draft).toBe('新对话的草稿')
    expect(store.messages).toHaveLength(0)
    expect(store.sending).toBe(false)
  })

  it('does not let a late retry success pollute a temporary conversation started while pending', async () => {
    const pending = deferred<RunStartResponseDTO>()
    const signals: AbortSignal[] = []
    const streamPersistentRun = parkedPersistentStream(signals)
    const store = useAssistantStore()
    store.setApi(
      createApi({
        retryRun: vi.fn().mockImplementation(() => pending.promise),
        getMessages: vi.fn().mockResolvedValue({
          items: [structuredClone(userMessageFixture), failedAssistantMessage()],
          nextCursor: null,
        }),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    void store.retryLastAnswer(MOCK_IDS.run)
    await flushPromises()

    store.startTemporaryConversation()
    store.draft = '临时草稿'
    pending.resolve(retryResponseFixture())
    await flushPromises()

    expect(store.temporaryMode).toBe(true)
    expect(store.activeConversation).toBeNull()
    expect(store.messages).toHaveLength(0)
    expect(store.temporaryMessages).toHaveLength(0)
    expect(store.draft).toBe('临时草稿')
    expect(streamPersistentRun).not.toHaveBeenCalled()
  })

  it('does not revive observation for a late retry success after the view is disposed', async () => {
    const pending = deferred<RunStartResponseDTO>()
    const signals: AbortSignal[] = []
    const streamPersistentRun = parkedPersistentStream(signals)
    const store = useAssistantStore()
    store.setApi(
      createApi({
        retryRun: vi.fn().mockImplementation(() => pending.promise),
        getMessages: vi.fn().mockResolvedValue({
          items: [structuredClone(userMessageFixture), failedAssistantMessage()],
          nextCursor: null,
        }),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    void store.retryLastAnswer(MOCK_IDS.run)
    await flushPromises()

    store.disposeView()
    pending.resolve(retryResponseFixture())
    await flushPromises()

    expect(streamPersistentRun).not.toHaveBeenCalled()
    expect(store.actionError).toBe('')
    expect(store.sending).toBe(false)
  })

  it('accepts the retry run on return without overwriting streamed content or restarting observation', async () => {
    const otherConversation: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
    }
    const pending = deferred<RunStartResponseDTO>()
    const signals: AbortSignal[] = []
    const retryRun = retryRunFixture('running')
    const streamPersistentRun = parkedPersistentStream(signals, [
      sseEnvelope('snapshot', {
        lastSequence: 1,
        run: retryRun,
        assistantMessage: retryAssistantMessage('', retryRun),
      }),
      sseEnvelope('answer.delta', { sequence: 2, delta: '流式正文' }),
    ])
    const store = useAssistantStore()
    store.setApi(
      createApi({
        retryRun: vi.fn().mockImplementation(() => pending.promise),
        getMessages: vi
          .fn()
          .mockResolvedValueOnce({
            items: [structuredClone(userMessageFixture), failedAssistantMessage()],
            nextCursor: null,
          })
          .mockResolvedValueOnce({ items: [], nextCursor: null })
          .mockResolvedValueOnce({
            items: [structuredClone(userMessageFixture), retryAssistantMessage('', retryRun)],
            nextCursor: null,
          }),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    void store.retryLastAnswer(MOCK_IDS.run)
    await flushPromises()

    await store.selectConversation(otherConversation)
    // 回切时服务器已提交重试：历史拿到同一新 Run 并恢复观察，SSE 已推进正文。
    await store.selectConversation(conversationFixture)
    await flushPromises()
    expect(
      store.messages.find((message) => message.role === 'assistant')?.content,
    ).toBe('流式正文')

    pending.resolve(retryResponseFixture())
    await flushPromises()

    // 迟到 202 的空快照不覆写已推进正文，也不重启（重启会 abort 同一 Run 观察）。
    const answer = store.messages.find((message) => message.role === 'assistant')
    expect(answer?.content).toBe('流式正文')
    expect(answer?.status).toBe('streaming')
    expect(answer?.currentRun?.id).toBe(RETRY_RUN_ID)
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)
    expect(signals[0].aborted).toBe(false)
    expect(store.actionError).toBe('')
    expect(store.sending).toBe(false)
  })

  it('keeps the retry run placeholder when returning while the history fetch is still pending', async () => {
    const otherConversation: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
    }
    const pending = deferred<RunStartResponseDTO>()
    const historyPending = deferred<AssistantMessageListDTO>()
    const signals: AbortSignal[] = []
    const streamPersistentRun = parkedPersistentStream(signals)
    const store = useAssistantStore()
    store.setApi(
      createApi({
        retryRun: vi.fn().mockImplementation(() => pending.promise),
        getMessages: vi
          .fn()
          .mockResolvedValueOnce({
            items: [structuredClone(userMessageFixture), failedAssistantMessage()],
            nextCursor: null,
          })
          .mockResolvedValueOnce({ items: [], nextCursor: null })
          .mockImplementationOnce(() => historyPending.promise),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    void store.retryLastAnswer(MOCK_IDS.run)
    await flushPromises()

    await store.selectConversation(otherConversation)
    const backSelect = store.selectConversation(conversationFixture)
    await flushPromises()
    // 回切读取在途：messages 仍为空时迟到 202 到达。
    expect(store.messages).toHaveLength(0)
    pending.resolve(retryResponseFixture())
    await flushPromises()
    // 迟到 202 携带的原 user 消息与助手占位立即都在并按 sequence 排序，不等
    // 慢速/失败的回切历史读取才补出原问题。
    expect(store.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(
      store.messages.find((message) => message.role === 'assistant')?.currentRun?.id,
    ).toBe(RETRY_RUN_ID)
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)

    // 更早发起的读取返回重试提交前的旧快照：按 id 并入，本地较新（新 Run）优先。
    historyPending.resolve({
      items: [structuredClone(userMessageFixture), failedAssistantMessage()],
      nextCursor: null,
    })
    await backSelect
    await flushPromises()
    const answer = store.messages.find((message) => message.role === 'assistant')
    expect(answer?.currentRun?.id).toBe(RETRY_RUN_ID)
    expect(answer?.status).toBe('streaming')
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)
    expect(store.activeConversation?.id).toBe(conversationFixture.id)
    expect(store.sending).toBe(false)
  })

  it('sends only one retry request when clicked again while pending', async () => {
    const pending = deferred<RunStartResponseDTO>()
    const signals: AbortSignal[] = []
    const streamPersistentRun = parkedPersistentStream(signals)
    const retryRun = vi.fn().mockImplementation(() => pending.promise)
    const store = useAssistantStore()
    store.setApi(
      createApi({
        retryRun,
        getMessages: vi.fn().mockResolvedValue({
          items: [structuredClone(userMessageFixture), failedAssistantMessage()],
          nextCursor: null,
        }),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)

    void store.retryLastAnswer(MOCK_IDS.run)
    await flushPromises()
    void store.retryLastAnswer(MOCK_IDS.run)
    await flushPromises()

    expect(retryRun).toHaveBeenCalledTimes(1)
    expect(store.sending).toBe(true)

    pending.resolve(retryResponseFixture())
    await flushPromises()
    // 正常接纳路径不受影响：原助手位置切到新 Run 并建立观察。
    expect(
      store.messages.find((message) => message.role === 'assistant')?.currentRun?.id,
    ).toBe(RETRY_RUN_ID)
    expect(streamPersistentRun).toHaveBeenCalledTimes(1)
    expect(store.sending).toBe(false)
  })

  it('does not abort another conversation observation for a late stop response', async () => {
    const otherConversation: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
    }
    const bRunId = '77777777-7777-4777-8777-777777777788'
    const bAssistantMessage: AssistantMessageDTO = {
      ...structuredClone(assistantMessageFixture),
      id: '66666666-6666-4666-8666-666666666688',
      conversationId: otherConversation.id,
      content: '',
      status: 'streaming',
      currentRun: {
        ...structuredClone(runFixtures.running),
        id: bRunId,
        conversationId: otherConversation.id,
        outputMessageId: '66666666-6666-4666-8666-666666666688',
      },
    }
    const pending = deferred<AssistantRunDTO>()
    const signals: AbortSignal[] = []
    const streamPersistentRun = parkedPersistentStream(signals)
    const store = useAssistantStore()
    store.setApi(
      createApi({
        stopRun: vi.fn().mockImplementation(() => pending.promise),
        getMessages: vi
          .fn()
          .mockResolvedValueOnce({
            items: [structuredClone(userMessageFixture), runningAssistantMessage()],
            nextCursor: null,
          })
          .mockResolvedValueOnce({ items: [bAssistantMessage], nextCursor: null }),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    const stopPromise = store.stopActiveRun()
    await flushPromises()

    await store.selectConversation(otherConversation)
    await flushPromises()
    expect(signals).toHaveLength(2)

    pending.resolve(structuredClone(runFixtures.stopped))
    await stopPromise
    await flushPromises()

    // B 的观察与消息不被旧停止响应中止或改写。
    expect(signals[1].aborted).toBe(false)
    expect(streamPersistentRun).toHaveBeenCalledTimes(2)
    expect(
      store.messages.find((message) => message.role === 'assistant')?.currentRun?.id,
    ).toBe(bRunId)
    expect(store.hasActiveRun).toBe(true)
    expect(store.actionError).toBe('')
  })

  it('does not surface a late stop failure in another conversation', async () => {
    const otherConversation: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
    }
    const pending = deferred<AssistantRunDTO>()
    const store = useAssistantStore()
    store.setApi(
      createApi({
        stopRun: vi.fn().mockImplementation(() => pending.promise),
        getMessages: vi
          .fn()
          .mockResolvedValueOnce({
            items: [structuredClone(userMessageFixture), runningAssistantMessage()],
            nextCursor: null,
          })
          .mockResolvedValueOnce({ items: [], nextCursor: null }),
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    const stopPromise = store.stopActiveRun()
    await flushPromises()

    await store.selectConversation(otherConversation)
    pending.reject(new Error('停止请求失败'))
    await stopPromise
    await flushPromises()

    expect(store.actionError).toBe('')
  })

  it('still stops the run and its observation for the same conversation', async () => {
    const signals: AbortSignal[] = []
    const streamPersistentRun = parkedPersistentStream(signals)
    const store = useAssistantStore()
    store.setApi(
      createApi({
        stopRun: vi.fn().mockResolvedValue(structuredClone(runFixtures.stopped)),
        getMessages: vi.fn().mockResolvedValue({
          items: [structuredClone(userMessageFixture), runningAssistantMessage()],
          nextCursor: null,
        }),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    await flushPromises()
    expect(signals).toHaveLength(1)

    await store.stopActiveRun()
    await flushPromises()

    const answer = store.messages.find((message) => message.role === 'assistant')
    expect(answer?.status).toBe('stopped')
    expect(answer?.currentRun?.status).toBe('stopped')
    expect(signals[0].aborted).toBe(true)
    expect(store.hasActiveRun).toBe(false)
    expect(store.actionError).toBe('')
  })

  it('still surfaces a genuine stop failure and keeps observing for the same running run', async () => {
    const signals: AbortSignal[] = []
    const streamPersistentRun = parkedPersistentStream(signals)
    const store = useAssistantStore()
    store.setApi(
      createApi({
        stopRun: vi.fn().mockRejectedValue(new Error('停止请求失败')),
        getMessages: vi.fn().mockResolvedValue({
          items: [structuredClone(userMessageFixture), runningAssistantMessage()],
          nextCursor: null,
        }),
        streamPersistentRun,
      }),
    )
    await store.initialize()
    await store.selectConversation(conversationFixture)
    await flushPromises()
    expect(signals).toHaveLength(1)

    await store.stopActiveRun()
    await flushPromises()

    // 同一 Run 仍在运行时的真实停止失败：错误照常显示，观察不被中止。
    expect(store.actionError).toBe('停止请求失败')
    expect(signals[0].aborted).toBe(false)
    expect(store.hasActiveRun).toBe(true)
    expect(store.messages.find((message) => message.role === 'assistant')?.status).toBe('streaming')
  })

  it('does not let a late stop response overwrite a retry run that replaced it', async () => {
    const { store, signals, stopPending, stopPromise, streamPersistentRun } =
      await setupStoppedRunReplacedByRetry()
    expect(
      store.messages.find((message) => message.role === 'assistant')?.currentRun?.id,
    ).toBe(RETRY_RUN_ID)

    stopPending.resolve(structuredClone(runFixtures.stopped))
    await stopPromise
    await flushPromises()

    // 旧 Run 的迟到停止响应不得覆盖同一位置的新重试 Run，也不得中止其观察。
    const answer = store.messages.find((message) => message.role === 'assistant')
    expect(answer?.currentRun?.id).toBe(RETRY_RUN_ID)
    expect(answer?.status).toBe('streaming')
    expect(signals[1].aborted).toBe(false)
    expect(store.hasActiveRun).toBe(true)
    expect(streamPersistentRun).toHaveBeenCalledTimes(2)
  })

  it('does not surface a late stop failure after a retry run replaced it in the same conversation', async () => {
    const { store, signals, stopPending, stopPromise } = await setupStoppedRunReplacedByRetry()

    stopPending.reject(new Error('停止请求失败'))
    await stopPromise
    await flushPromises()

    // 同一会话（上下文序号未变）但活动 Run 已是新重试 Run：旧停止失败不冒给
    // 新 Run，观察不受影响。
    const answer = store.messages.find((message) => message.role === 'assistant')
    expect(store.actionError).toBe('')
    expect(answer?.currentRun?.id).toBe(RETRY_RUN_ID)
    expect(answer?.status).toBe('streaming')
    expect(signals[1].aborted).toBe(false)
    expect(store.hasActiveRun).toBe(true)
  })
})

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
    getFolders: vi.fn().mockResolvedValue({ items: [] }),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn().mockResolvedValue(undefined),
    getConversations: vi.fn().mockResolvedValue({ items: [structuredClone(conversationFixture)], nextCursor: null }),
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

const RETRY_RUN_ID = '77777777-7777-4777-8777-777777777799'

function failedAssistantMessage(): AssistantMessageDTO {
  return {
    ...structuredClone(assistantMessageFixture),
    content: '失败前的部分内容',
    reasoningContent: null,
    reasoningDurationMs: null,
    status: 'failed',
    currentRun: structuredClone(runFixtures.failedPartial),
    citations: [],
  }
}

function runningAssistantMessage(): AssistantMessageDTO {
  return {
    ...structuredClone(assistantMessageFixture),
    content: '',
    reasoningContent: null,
    reasoningDurationMs: null,
    status: 'streaming',
    completedAt: null,
    currentRun: structuredClone(runFixtures.running),
    citations: [],
  }
}

function retryRunFixture(status: 'queued' | 'running'): AssistantRunDTO {
  const base = status === 'running' ? runFixtures.running : runFixtures.queued
  return { ...structuredClone(base), id: RETRY_RUN_ID, retryOfRunId: MOCK_IDS.run }
}

function retryAssistantMessage(content: string, run: AssistantRunDTO): AssistantMessageDTO {
  return {
    ...structuredClone(assistantMessageFixture),
    content,
    reasoningContent: null,
    reasoningDurationMs: null,
    status: 'streaming',
    completedAt: null,
    currentRun: structuredClone(run),
    citations: [],
  }
}

function retryResponseFixture(): RunStartResponseDTO {
  const run = retryRunFixture('queued')
  return {
    conversation: structuredClone(conversationFixture),
    userMessage: structuredClone(userMessageFixture),
    assistantMessage: retryAssistantMessage('', run),
    run: structuredClone(run),
    idempotentReplay: false,
  }
}

function sseEnvelope(type: string, data: unknown): SseEnvelope {
  const sequence = (data as { sequence?: number }).sequence
  return { type, data, ...(sequence === undefined ? {} : { id: String(sequence) }) }
}

// 停在真实 AbortSignal 上的持久流：记录传给观察循环的信号、先吐出给定事件，
// 然后挂起直到被 abort，用于断言迟到动作是否错误中止了别人的观察。
function parkedPersistentStream(signals: AbortSignal[], envelopes: SseEnvelope[] = []) {
  return vi.fn(async function* (_runId: UUID, options: { signal: AbortSignal }) {
    signals.push(options.signal)
    for (const envelope of envelopes) yield structuredClone(envelope)
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) return resolve()
      options.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  })
}

// 同一会话内“旧停止在途 → SSE 先 stopped → 重试成新 Run → 停止响应才迟到”
// 的共用流程：走到重试已接管为止，停止响应的成功/失败结果由调用方决定。
async function setupStoppedRunReplacedByRetry() {
  const stopPending = deferred<AssistantRunDTO>()
  const signals: AbortSignal[] = []
  let releaseStopped!: () => void
  const stoppedGate = new Promise<void>((resolve) => {
    releaseStopped = resolve
  })
  const aRunningMessage = runningAssistantMessage()
  const streamPersistentRun = vi.fn(
    async function* (runId: UUID, options: { signal: AbortSignal }) {
      signals.push(options.signal)
      if (runId === MOCK_IDS.run) {
        yield sseEnvelope('snapshot', {
          lastSequence: 0,
          run: structuredClone(runFixtures.running),
          assistantMessage: structuredClone(aRunningMessage),
        })
        // 停止已在服务端生效、SSE 送达 run.stopped 之后，HTTP 停止响应才迟到返回。
        await stoppedGate
        yield sseEnvelope('run.stopped', { sequence: 1, run: structuredClone(runFixtures.stopped) })
        return
      }
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) return resolve()
        options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  )
  const store = useAssistantStore()
  store.setApi(
    createApi({
      stopRun: vi.fn().mockImplementation(() => stopPending.promise),
      retryRun: vi.fn().mockResolvedValue(retryResponseFixture()),
      getMessages: vi.fn().mockResolvedValue({
        items: [structuredClone(userMessageFixture), aRunningMessage],
        nextCursor: null,
      }),
      streamPersistentRun,
    }),
  )
  await store.initialize()
  await store.selectConversation(conversationFixture)
  await flushPromises()
  const stopPromise = store.stopActiveRun()
  await flushPromises()

  releaseStopped()
  await flushPromises()
  await store.retryLastAnswer(MOCK_IDS.run)
  await flushPromises()
  return { store, signals, stopPending, stopPromise, streamPersistentRun }
}

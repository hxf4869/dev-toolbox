import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../lib/api'
import type { AssistantApi } from './assistantApi'
import type {
  TemporaryHistoryMessageDTO,
  TemporaryStreamRequestDTO,
  TemporarySummaryDTO,
} from './assistantContracts'
import type { SseEnvelope } from './assistantSse'
import { bootstrapFixtures, conversationFixture, runFixtures } from './assistantMocks'
import { useAssistantStore } from './assistantStore'

describe('assistant store temporary sessions', () => {
  let uuidCounter = 0

  beforeEach(() => {
    uuidCounter = 0
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(
        () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
      ),
    })
  })

  it('excludes a failed pair so later temporary requests keep an even alternating history', async () => {
    const streamTemporaryRun = vi.fn(queueStreams([
      successStream('第一个答案'),
      failedStream(),
      successStream('第三个答案'),
    ]))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    store.draft = '第一问'
    await store.send()
    store.draft = '第二问'
    await store.send()
    store.draft = '第三问'
    await store.send()
    await flushPromises()

    expect(streamTemporaryRun).toHaveBeenCalledTimes(3)
    const retryRequest = requestOf(streamTemporaryRun, 2)
    expect(retryRequest.messages).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一个答案' },
    ])
    expectAlternatingHistory(retryRequest.messages)
    const failedPair = store.temporaryMessages.filter(
      (message) => message.content === '第二问' || message.status === 'failed',
    )
    expect(failedPair).toHaveLength(2)
    expect(store.displayMessages.at(-1)?.status).toBe('complete')
    expect(store.sending).toBe(false)
  })

  it('excludes a stopped pair so the next temporary request starts from an empty even history', async () => {
    const streamTemporaryRun = vi.fn(queueStreams([
      stoppableStream('停止前的部分'),
      successStream('第二答'),
    ]))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    store.draft = '第一问'
    const firstSend = store.send()
    await flushPromises()
    await store.stopActiveRun()
    await firstSend
    expect(store.temporaryMessages.at(-1)?.status).toBe('stopped')
    expect(store.temporaryMessages.at(-1)?.content).toBe('停止前的部分')

    store.draft = '第二问'
    await store.send()

    expect(streamTemporaryRun).toHaveBeenCalledTimes(2)
    const nextRequest = requestOf(streamTemporaryRun, 1)
    expect(nextRequest.messages).toEqual([])
    expectAlternatingHistory(nextRequest.messages)
    expect(store.displayMessages.at(-1)?.status).toBe('complete')
    expect(store.sending).toBe(false)
  })

  it('keeps successful user content verbatim and strips citation tokens only from assistant history', async () => {
    const streamTemporaryRun = vi.fn(queueStreams([
      successStream('引用 [[C1]] 与正文'),
      successStream('第二答'),
    ]))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    store.draft = '帮我看看 [[C1]] 标记'
    await store.send()
    store.draft = '下一问'
    await store.send()

    const secondRequest = requestOf(streamTemporaryRun, 1)
    expect(secondRequest.messages).toEqual([
      { role: 'user', content: '帮我看看 [[C1]] 标记' },
      { role: 'assistant', content: '引用  与正文' },
    ])
    expect(store.temporaryMessages[0]?.content).toBe('帮我看看 [[C1]] 标记')
    expect(store.temporaryMessages[1]?.content).toBe('引用 [[C1]] 与正文')
  })

  it('cancels the in-flight temporary run when switching to a persistent conversation', async () => {
    const release = deferred<void>()
    const streamTemporaryRun = vi.fn(async function* (
      _request: TemporaryStreamRequestDTO,
      signal: AbortSignal,
    ) {
      yield statusEvent(1)
      await release.promise
      throw abortError(signal)
    })
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    store.draft = '临时问题'
    const temporarySend = store.send()
    await flushPromises()
    expect(store.hasActiveRun).toBe(true)

    await store.selectConversation(conversationFixture)

    const signal = signalOf(streamTemporaryRun, 0)
    expect(signal.aborted).toBe(true)
    expect(store.temporaryMode).toBe(false)
    expect(store.temporaryMessages.at(-1)?.status).toBe('stopped')
    expect(store.sending).toBe(false)
    store.draft = '持久消息'
    expect(store.canSend).toBe(true)

    release.resolve()
    await temporarySend
    await flushPromises()
    expect(store.sending).toBe(false)
    expect(store.actionError).toBe('')
    expect(store.canSend).toBe(true)
  })

  it('cancels the in-flight temporary run when starting a new conversation', async () => {
    const release = deferred<void>()
    const streamTemporaryRun = vi.fn(async function* (
      _request: TemporaryStreamRequestDTO,
      signal: AbortSignal,
    ) {
      yield statusEvent(1)
      await release.promise
      throw abortError(signal)
    })
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    store.draft = '临时问题'
    const temporarySend = store.send()
    await flushPromises()

    store.startNewConversation()

    expect(signalOf(streamTemporaryRun, 0).aborted).toBe(true)
    expect(store.temporaryMode).toBe(false)
    expect(store.temporaryMessages.at(-1)?.status).toBe('stopped')
    expect(store.sending).toBe(false)
    store.draft = '新会话消息'
    expect(store.canSend).toBe(true)

    release.resolve()
    await temporarySend
    expect(store.sending).toBe(false)
    expect(store.actionError).toBe('')
  })

  it('does not cancel an ongoing temporary generation when the temporary nav is clicked again', async () => {
    const release = deferred<void>()
    const streamTemporaryRun = vi.fn(async function* (
      _request: TemporaryStreamRequestDTO,
      signal: AbortSignal,
    ) {
      yield statusEvent(1)
      yield answerDelta(2, '生成中的部分')
      await release.promise
      yield completedEvent(3)
    })
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    store.draft = '临时问题'
    const temporarySend = store.send()
    await flushPromises()

    store.startTemporaryConversation()

    expect(signalOf(streamTemporaryRun, 0).aborted).toBe(false)
    expect(store.temporaryMessages.at(-1)?.status).toBe('streaming')
    expect(store.hasActiveRun).toBe(true)

    release.resolve()
    await temporarySend
    expect(store.temporaryMessages.at(-1)?.status).toBe('complete')
  })

  it('a late envelope or finally from the cancelled stream does not pollute the next run', async () => {
    const releaseOld = deferred<void>()
    const releaseNext = deferred<void>()
    const oldStream = async function* (
      _request: TemporaryStreamRequestDTO,
      _signal: AbortSignal,
    ) {
      yield statusEvent(1)
      await releaseOld.promise
      yield answerDelta(2, '晚到内容')
      throw new DOMException('Aborted', 'AbortError')
    }
    const nextStream = async function* (
      _request: TemporaryStreamRequestDTO,
      _signal: AbortSignal,
    ) {
      yield statusEvent(1)
      await releaseNext.promise
      yield answerDelta(2, '新回答正文')
      yield completedEvent(3)
    }
    const streamTemporaryRun = vi.fn(queueStreams([oldStream, nextStream]))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    store.draft = '旧问题'
    const oldSend = store.send()
    await flushPromises()

    await store.selectConversation(conversationFixture)
    store.startTemporaryConversation()
    store.draft = '新问题'
    const nextSend = store.send()
    await flushPromises()
    expect(streamTemporaryRun).toHaveBeenCalledTimes(2)
    expect(store.sending).toBe(true)

    releaseOld.resolve()
    await oldSend
    await flushPromises()

    expect(store.sending).toBe(true)
    const stoppedAnswer = store.temporaryMessages.find((message) => message.status === 'stopped')
    expect(stoppedAnswer?.role).toBe('assistant')
    expect(stoppedAnswer?.content).not.toContain('晚到内容')

    releaseNext.resolve()
    await nextSend
    expect(store.sending).toBe(false)
    expect(store.actionError).toBe('')
    expect(store.temporaryMode).toBe(true)
    const answers = store.temporaryMessages.filter((message) => message.role === 'assistant')
    expect(answers.at(-1)?.status).toBe('complete')
    expect(answers.at(-1)?.content).toBe('新回答正文')
  })

  it('releases the temporary sending lock when the view is disposed mid-run', async () => {
    const releaseOld = deferred<void>()
    const releaseNext = deferred<void>()
    const oldStream = async function* (
      _request: TemporaryStreamRequestDTO,
      _signal: AbortSignal,
    ) {
      yield statusEvent(1)
      yield answerDelta(2, '销毁前的部分')
      await releaseOld.promise
      yield answerDelta(3, '晚到内容')
      throw new DOMException('Aborted', 'AbortError')
    }
    const nextStream = async function* (
      _request: TemporaryStreamRequestDTO,
      _signal: AbortSignal,
    ) {
      yield statusEvent(1)
      await releaseNext.promise
      yield answerDelta(2, '新回答正文')
      yield completedEvent(3)
    }
    const streamTemporaryRun = vi.fn(queueStreams([oldStream, nextStream]))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    store.draft = '临时问题'
    const oldSend = store.send()
    await flushPromises()
    expect(store.hasActiveRun).toBe(true)
    expect(store.sending).toBe(true)

    store.disposeView()

    expect(signalOf(streamTemporaryRun, 0).aborted).toBe(true)
    expect(store.temporaryMessages).toHaveLength(0)
    expect(store.draft).toBe('')
    expect(store.sending).toBe(false)

    await store.initialize()
    store.draft = '路由重进后的消息'
    expect(store.sending).toBe(false)
    expect(store.canSend).toBe(true)

    store.startTemporaryConversation()
    store.draft = '新问题'
    const nextSend = store.send()
    await flushPromises()
    expect(streamTemporaryRun).toHaveBeenCalledTimes(2)
    expect(store.sending).toBe(true)

    releaseOld.resolve()
    await oldSend
    await flushPromises()

    expect(store.sending).toBe(true)
    expect(store.temporaryMessages.map((message) => message.content)).not.toContain('晚到内容')
    expect(store.actionError).toBe('')

    releaseNext.resolve()
    await nextSend
    expect(store.sending).toBe(false)
    expect(store.temporaryMessages.at(-1)?.status).toBe('complete')
    expect(store.temporaryMessages.at(-1)?.content).toBe('新回答正文')
  })

  it('advances the temporary watermark exactly to the covered prefix when a summary arrives', async () => {
    const streamTemporaryRun = vi.fn(queueStreams([
      successStream('答1'),
      successStream('答2'),
      successStream('答3'),
      successStream('答4'),
      successStream('答5'),
      failedStream(),
      successStream('答7'),
      successStream('答8'),
      successStream('答9'),
      successStream('答10'),
      successStream('答11'),
      successStreamWithSummary('答12', summaryPayload()),
      successStream('答13'),
    ]))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    for (const draft of ['问1', '问2', '问3', '问4', '问5', '问6', '问7', '问8', '问9', '问10', '问11', '问12', '问13']) {
      store.draft = draft
      await store.send()
    }

    const summaryRoundRequest = requestOf(streamTemporaryRun, 11)
    expect(summaryRoundRequest.summary).toBeNull()
    expect(summaryRoundRequest.messages.map((message) => message.content)).toEqual([
      '问1', '答1', '问2', '答2', '问3', '答3', '问4', '答4', '问5', '答5',
      '问7', '答7', '问8', '答8', '问9', '答9', '问10', '答10', '问11', '答11',
    ])
    expectAlternatingHistory(summaryRoundRequest.messages)

    const nextRequest = requestOf(streamTemporaryRun, 12)
    expect(nextRequest.summary).toEqual(summaryPayload())
    expect(nextRequest.messages.map((message) => message.content)).toEqual([
      '问3', '答3', '问4', '答4', '问5', '答5',
      '问7', '答7', '问8', '答8', '问9', '答9', '问10', '答10', '问11', '答11',
      '问12', '答12',
    ])
    expectAlternatingHistory(nextRequest.messages)
    expect(store.sending).toBe(false)
  })

  it('keeps the summary and watermark untouched when the succeeded terminal has no summary', async () => {
    const streamTemporaryRun = vi.fn(queueStreams([
      ...Array.from({ length: 11 }, (_, index) => successStream(`答${index + 1}`)),
      successStream('答12'),
      successStream('答13'),
    ]))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    for (let index = 1; index <= 13; index += 1) {
      store.draft = `问${index}`
      await store.send()
    }

    expect(requestOf(streamTemporaryRun, 10).messages).toHaveLength(20)
    expect(requestOf(streamTemporaryRun, 11).messages).toHaveLength(22)
    const nextRequest = requestOf(streamTemporaryRun, 12)
    expect(nextRequest.summary).toBeNull()
    const expected: TemporaryHistoryMessageDTO[] = []
    for (let index = 1; index <= 12; index += 1) {
      expected.push({ role: 'user', content: `问${index}` })
      expected.push({ role: 'assistant', content: `答${index}` })
    }
    expect(nextRequest.messages).toEqual(expected)
  })

  it('does not let the watermark skip uncovered successful messages around failed and stopped pairs', async () => {
    const streamTemporaryRun = vi.fn(queueStreams([
      successStream('答1'),
      successStream('答2'),
      successStream('答3'),
      successStream('答4'),
      successStream('答5'),
      failedStream(),
      successStream('答7'),
      successStream('答8'),
      successStream('答9'),
      successStream('答10'),
      stoppableStream('答11的部分'),
      successStreamWithSummary('答12', summaryPayload()),
      successStream('答13'),
    ]))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    for (const draft of ['问1', '问2', '问3', '问4', '问5', '问6', '问7', '问8', '问9', '问10']) {
      store.draft = draft
      await store.send()
    }
    store.draft = '问11'
    const stoppedSend = store.send()
    await flushPromises()
    await store.stopActiveRun()
    await stoppedSend
    expect(store.temporaryMessages.filter((message) => message.status === 'stopped')).toHaveLength(1)

    store.draft = '问12'
    await store.send()
    store.draft = '问13'
    await store.send()

    expect(requestOf(streamTemporaryRun, 11).messages).toHaveLength(18)
    const nextRequest = requestOf(streamTemporaryRun, 12)
    expect(nextRequest.messages.map((message) => message.content)).toEqual([
      '问2', '答2', '问3', '答3', '问4', '答4', '问5', '答5',
      '问7', '答7', '问8', '答8', '问9', '答9', '问10', '答10',
      '问12', '答12',
    ])
    expectAlternatingHistory(nextRequest.messages)
  })

  it('blocks the send locally when the unsummarized temporary history exceeds 32 messages', async () => {
    const streamTemporaryRun = vi.fn(queueStreams(
      Array.from({ length: 17 }, (_, index) => successStream(`答${index + 1}`)),
    ))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    for (let index = 1; index <= 17; index += 1) {
      store.draft = `问${index}`
      await store.send()
    }
    expect(requestOf(streamTemporaryRun, 16).messages).toHaveLength(32)

    store.draft = '问18'
    await store.send()

    expect(streamTemporaryRun).toHaveBeenCalledTimes(17)
    expect(store.actionError).toBe('临时会话未摘要的历史已达上限；如需保留内容请先复制，刷新页面后重新开始临时会话。')
    expect(store.draft).toBe('问18')
    expect(store.temporaryMessages).toHaveLength(34)
    expect(store.sending).toBe(false)
    expect(store.hasActiveRun).toBe(false)
  })

  it('keeps the optimistic pair removed and the draft intact when the server rejects oversized context', async () => {
    const streamTemporaryRun = vi.fn(queueStreams([
      successStream('答1'),
      async function* () {
        throw new ApiError(422, {
          error: { code: 'ASSISTANT_CONTEXT_TOO_LARGE', message: '临时上下文超出合同上限' },
        })
      },
    ]))
    const store = useAssistantStore()
    store.setApi(createApi({ streamTemporaryRun }))
    await store.initialize()

    store.startTemporaryConversation()
    store.draft = '问1'
    await store.send()
    store.draft = '问2'
    await store.send()

    expect(streamTemporaryRun).toHaveBeenCalledTimes(2)
    expect(store.actionError).toBe('上下文过长，请缩短本轮内容后重试。')
    expect(store.temporaryMessages).toHaveLength(2)
    expect(store.draft).toBe('问2')
    expect(store.sending).toBe(false)
  })
})

function queueStreams(
  streams: Array<
    (request: TemporaryStreamRequestDTO, signal: AbortSignal) => AsyncGenerator<SseEnvelope>
  >,
) {
  return (request: TemporaryStreamRequestDTO, signal: AbortSignal) => {
    const stream = streams.shift()
    if (!stream) throw new Error('没有更多预置的临时流。')
    return stream(request, signal)
  }
}

function successStream(answer: string) {
  return async function* (_request: TemporaryStreamRequestDTO, _signal: AbortSignal) {
    yield statusEvent(1)
    yield answerDelta(2, answer)
    yield completedEvent(3)
  }
}

function successStreamWithSummary(answer: string, summary: TemporarySummaryDTO) {
  return async function* (_request: TemporaryStreamRequestDTO, _signal: AbortSignal) {
    yield statusEvent(1)
    yield answerDelta(2, answer)
    yield completedEvent(3, summary)
  }
}

function summaryPayload(): TemporarySummaryDTO {
  return {
    confirmedFacts: ['第一轮确认的事实'],
    corrections: [],
    rejectedHypotheses: ['已否定的猜测'],
    unresolvedQuestions: ['尚未解决的问题'],
  }
}

function failedStream() {
  return async function* (_request: TemporaryStreamRequestDTO, _signal: AbortSignal) {
    yield statusEvent(1)
    yield answerDelta(2, '即将失败的部分')
    yield {
      type: 'run.failed',
      data: {
        sequence: 3,
        status: 'failed',
        usage: terminalUsage(),
        timings: terminalTimings(),
        error: { code: 'ASSISTANT_PROVIDER_UNAVAILABLE', message: 'Provider 暂时不可用' },
        temporarySummary: null,
      },
      id: '3',
    }
  }
}

function stoppableStream(partial: string) {
  return async function* (_request: TemporaryStreamRequestDTO, signal: AbortSignal) {
    yield statusEvent(1)
    yield answerDelta(2, partial)
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    throw new DOMException('Aborted', 'AbortError')
  }
}

function abortError(signal: AbortSignal) {
  if (!signal.aborted) throw new Error('预期此错误只应发生在 signal 已中止之后。')
  return new DOMException('Aborted', 'AbortError')
}

function statusEvent(sequence: number): SseEnvelope {
  return {
    type: 'run.status',
    data: { sequence, status: 'running', phase: 'answer' },
    id: String(sequence),
  }
}

function answerDelta(sequence: number, delta: string): SseEnvelope {
  return { type: 'answer.delta', data: { sequence, delta }, id: String(sequence) }
}

function completedEvent(
  sequence: number,
  temporarySummary: TemporarySummaryDTO | null = null,
): SseEnvelope {
  return {
    type: 'run.completed',
    data: {
      sequence,
      status: 'succeeded',
      usage: terminalUsage(),
      timings: terminalTimings(),
      error: null,
      temporarySummary,
    },
    id: String(sequence),
  }
}

function terminalUsage() {
  return { ...runFixtures.succeeded.usage }
}

function terminalTimings() {
  return { ...runFixtures.succeeded.timings }
}

function requestOf(mock: { mock: { calls: unknown[][] } }, index: number) {
  return mock.mock.calls[index]?.[0] as TemporaryStreamRequestDTO
}

function signalOf(mock: { mock: { calls: unknown[][] } }, index: number) {
  return mock.mock.calls[index]?.[1] as AbortSignal
}

function expectAlternatingHistory(messages: TemporaryHistoryMessageDTO[]) {
  expect(messages.length % 2).toBe(0)
  for (const [index, message] of messages.entries()) {
    expect(message.role).toBe(index % 2 === 0 ? 'user' : 'assistant')
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
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
    startRun: vi.fn(),
    getRun: vi.fn(),
    stopRun: vi.fn(),
    retryRun: vi.fn(),
    getSource: vi.fn(),
    streamPersistentRun: async function* () {},
    streamTemporaryRun: async function* () {},
  }
  return { ...defaults, ...overrides }
}

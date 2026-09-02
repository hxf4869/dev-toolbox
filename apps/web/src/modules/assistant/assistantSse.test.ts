import { describe, expect, it } from 'vitest'

import {
  assistantMessageFixture,
  persistentStreamFixtures,
  runFixtures,
  sourceFixtures,
  temporaryFixture,
} from './assistantMocks'
import {
  createPersistentStreamState,
  createTemporaryStreamState,
  parseSseStream,
  reducePersistentEvent,
  reduceTemporaryEvent,
  type SseEnvelope,
} from './assistantSse'

describe('persistent assistant SSE reducer', () => {
  it('uses snapshot as the authoritative waterline and ignores duplicate sequences', () => {
    let state = createPersistentStreamState()
    const [snapshot, duplicate, next] = persistentStreamFixtures.duplicateSequence

    state = reducePersistentEvent(state, clone(snapshot!)).state
    expect(state.appliedSequence).toBe(2)
    expect(state.assistantMessage?.content).toBe('')

    const ignored = reducePersistentEvent(state, clone(duplicate!))
    expect(ignored.outcome).toBe('ignored')
    expect(ignored.state.assistantMessage?.content).toBe('')

    const applied = reducePersistentEvent(ignored.state, clone(next!))
    expect(applied.state.assistantMessage?.content).toBe('只追加一次')
    expect(applied.state.appliedSequence).toBe(3)
  })

  it('requests a fresh snapshot when the first event or sequence continuity is invalid', () => {
    const firstDelta = reducePersistentEvent(createPersistentStreamState(), {
      type: 'answer.delta',
      data: { sequence: 1, delta: '不应应用' },
    })
    expect(firstDelta.outcome).toBe('needs_snapshot')
    expect(firstDelta.state.assistantMessage).toBeNull()

    let state = reducePersistentEvent(createPersistentStreamState(), {
      type: 'snapshot',
      data: { lastSequence: 2, run: runFixtures.running, assistantMessage: streamMessage() },
    }).state
    const gap = reducePersistentEvent(state, {
      type: 'answer.delta',
      data: { sequence: 4, delta: '存在缺口' },
    })
    expect(gap.outcome).toBe('needs_snapshot')
    expect(gap.state.appliedSequence).toBe(2)
    expect(gap.state.diagnostics.at(-1)).toContain('期望 3')
  })

  it('advances unknown events without executing their payload', () => {
    let state = reducePersistentEvent(createPersistentStreamState(), {
      type: 'snapshot',
      data: { lastSequence: 0, run: runFixtures.running, assistantMessage: streamMessage() },
    }).state
    const result = reducePersistentEvent(state, {
      type: 'future.execute-html',
      data: { sequence: 1, html: '<script>window.compromised=true</script>' },
    })

    expect(result.outcome).toBe('applied')
    expect(result.state.appliedSequence).toBe(1)
    expect(result.state.assistantMessage?.content).toBe('')
    expect(result.diagnostic).toBe('忽略未知 SSE 事件“future.execute-html”（sequence 1）')
  })

  it('streams reasoning, answer and canonical citations exactly once', () => {
    let state = createPersistentStreamState()
    for (const envelope of persistentStreamFixtures.reasoningAndCitation) {
      state = reducePersistentEvent(state, clone(envelope)).state
    }

    expect(state.assistantMessage?.reasoningContent).toBe('正在核对来源。')
    expect(state.assistantMessage?.reasoningDurationMs).toBe(820)
    expect(state.assistantMessage?.content).toBe('先停止 Docker 服务。[[C1]]')
    expect(state.assistantMessage?.citations).toHaveLength(1)
    expect(state.sources[1]).toEqual(sourceFixtures.available)
    expect(state.run?.status).toBe('succeeded')
    expect(state.terminal).toBe(true)
  })

  it('applies the persisted query-rewrite fallback trace', () => {
    let state = reducePersistentEvent(createPersistentStreamState(), {
      type: 'snapshot',
      data: { lastSequence: 0, run: runFixtures.running, assistantMessage: streamMessage() },
    }).state
    state = reducePersistentEvent(state, {
      type: 'sources.ready',
      data: {
        sequence: 1,
        knowledgeState: 'ready',
        evidenceState: 'not_found',
        providedSourceCount: 0,
        rewriteFallback: true,
      },
    }).state

    expect(state.run?.rewriteFallback).toBe(true)
    expect(state.assistantMessage?.currentRun?.rewriteFallback).toBe(true)
  })

  it('keeps partial content visibly failed and terminal events never append body text', () => {
    let state = createPersistentStreamState()
    for (const envelope of persistentStreamFixtures.failedPartial) {
      state = reducePersistentEvent(state, clone(envelope)).state
    }

    expect(state.assistantMessage?.content).toBe('已生成的安全部分')
    expect(state.assistantMessage?.status).toBe('failed')
    expect(state.run?.error?.code).toBe('ASSISTANT_PROVIDER_UNAVAILABLE')
  })

  it('rejects a citation token that does not match its canonical number', () => {
    let state = reducePersistentEvent(createPersistentStreamState(), {
      type: 'snapshot',
      data: { lastSequence: 0, run: runFixtures.running, assistantMessage: streamMessage() },
    }).state
    const result = reducePersistentEvent(state, {
      type: 'answer.citation',
      data: {
        sequence: 1,
        citationNumber: 1,
        token: '[[C2]]',
        source: sourceFixtures.available,
      },
    })

    expect(result.state.assistantMessage?.content).toBe('')
    expect(result.state.assistantMessage?.citations).toHaveLength(0)
    expect(result.diagnostic).toContain('无效 citation')
  })
})

describe('temporary assistant SSE reducer', () => {
  it('uses in-memory sequence state and accepts no snapshot', () => {
    let state = createTemporaryStreamState()
    for (const envelope of temporaryFixture.events) {
      state = reduceTemporaryEvent(state, clone(envelope)).state
    }

    expect(state.status).toBe('succeeded')
    expect(state.content).toBe('不会保存到 Dev Toolbox。')
    expect(state.terminal).toBe(true)
    expect(state.appliedSequence).toBe(4)
    expect(state.promptVersion).toBe('assistant-answer-v1')
    expect(state.retrievalVersion).toBe('hybrid-rrf-v1')
    expect(state.rewriteFallback).toBe(true)
  })
})

describe('SSE stream parser', () => {
  it('parses CRLF, comments, split JSON and named unknown events', async () => {
    const chunks = [
      ': heartbeat\r\nevent: snapshot\r\ndata: {"lastSequence":',
      '0,"run":{},"assistantMessage":{}}\r\n\r\nevent: future.event\n',
      'id: 1\ndata: {"sequence":1}\n\n',
    ]
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })

    const events: SseEnvelope[] = []
    for await (const event of parseSseStream(stream)) events.push(event)

    expect(events).toEqual([
      {
        type: 'snapshot',
        data: { lastSequence: 0, run: {}, assistantMessage: {} },
      },
      { type: 'future.event', id: '1', data: { sequence: 1 } },
    ])
  })

  it('accepts lone CR framing without misreading a CRLF split across chunks', async () => {
    const chunks = [
      'event: answer.delta\rdata: {"sequence":1,"delta":"A"}\r\r',
      'event: answer.delta\r',
      '\ndata: {"sequence":2,"delta":"B"}\r\n\r\n',
    ]
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })

    const events: SseEnvelope[] = []
    for await (const event of parseSseStream(stream)) events.push(event)

    expect(events).toEqual([
      { type: 'answer.delta', data: { sequence: 1, delta: 'A' } },
      { type: 'answer.delta', data: { sequence: 2, delta: 'B' } },
    ])
  })
})

function streamMessage() {
  return {
    ...assistantMessageFixture,
    content: '',
    reasoningContent: null,
    reasoningDurationMs: null,
    status: 'streaming' as const,
    currentRun: runFixtures.running,
    citations: [],
    completedAt: null,
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

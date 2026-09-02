import type {
  AnswerCitationEvent,
  AnswerDeltaEvent,
  AssistantMessageDTO,
  AssistantRunDTO,
  AssistantSourceDTO,
  CitationRefDTO,
  ReasoningCompletedEvent,
  ReasoningDeltaEvent,
  RunStatusEvent,
  SnapshotEvent,
  SourcesReadyEvent,
  TemporaryAnswerCitationEvent,
  TemporarySourcesReadyEvent,
  TemporarySourceDTO,
  TemporarySummaryDTO,
  TemporaryTerminalEvent,
  TerminalEvent,
  UsageUpdatedEvent,
} from './assistantContracts'

export interface SseEnvelope {
  type: string
  data: unknown
  id?: string
}

export interface PersistentStreamState {
  appliedSequence: number
  awaitingSnapshot: boolean
  terminal: boolean
  run: AssistantRunDTO | null
  assistantMessage: AssistantMessageDTO | null
  sources: Record<number, AssistantSourceDTO>
  diagnostics: string[]
}

export type ReduceOutcome = 'applied' | 'ignored' | 'needs_snapshot' | 'terminal'

export interface ReduceResult<T> {
  state: T
  outcome: ReduceOutcome
  diagnostic?: string
}

export interface TemporaryStreamState {
  appliedSequence: number
  terminal: boolean
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'stopped'
  phase: AssistantRunDTO['phase']
  knowledgeState: 'ready' | 'unavailable' | null
  evidenceState: AssistantRunDTO['evidenceState']
  providedSourceCount: number
  promptVersion: string | null
  retrievalVersion: string | null
  rewriteFallback: boolean
  reasoningContent: string
  reasoningDurationMs: number | null
  content: string
  citations: Array<Omit<CitationRefDTO, 'runId'>>
  sources: Record<number, TemporarySourceDTO>
  usage: AssistantRunDTO['usage']
  timings: AssistantRunDTO['timings']
  error: TemporaryTerminalEvent['error']
  summary: TemporarySummaryDTO | null
  diagnostics: string[]
}

const KNOWN_PERSISTENT_EVENTS = new Set([
  'run.status',
  'sources.ready',
  'reasoning.delta',
  'reasoning.completed',
  'answer.delta',
  'answer.citation',
  'usage.updated',
  'run.completed',
  'run.failed',
  'run.stopped',
])

const KNOWN_TEMPORARY_EVENTS = new Set([
  'run.status',
  'sources.ready',
  'reasoning.delta',
  'reasoning.completed',
  'answer.delta',
  'answer.citation',
  'usage.updated',
  'run.completed',
  'run.failed',
  'run.stopped',
])

export function createPersistentStreamState(): PersistentStreamState {
  return {
    appliedSequence: 0,
    awaitingSnapshot: true,
    terminal: false,
    run: null,
    assistantMessage: null,
    sources: {},
    diagnostics: [],
  }
}

export function createTemporaryStreamState(): TemporaryStreamState {
  return {
    appliedSequence: 0,
    terminal: false,
    status: 'idle',
    phase: null,
    knowledgeState: null,
    evidenceState: null,
    providedSourceCount: 0,
    promptVersion: null,
    retrievalVersion: null,
    rewriteFallback: false,
    reasoningContent: '',
    reasoningDurationMs: null,
    content: '',
    citations: [],
    sources: {},
    usage: emptyUsage(),
    timings: emptyTimings(),
    error: null,
    summary: null,
    diagnostics: [],
  }
}

export function reducePersistentEvent(
  current: PersistentStreamState,
  envelope: SseEnvelope,
): ReduceResult<PersistentStreamState> {
  if (envelope.type === 'snapshot') {
    if (!isSnapshot(envelope.data)) {
      return needsSnapshot(current, 'snapshot payload 无效')
    }
    const previousRunId = current.run?.id
    const next = {
      ...current,
      appliedSequence: envelope.data.lastSequence,
      awaitingSnapshot: false,
      terminal: isTerminalRun(envelope.data.run),
      run: envelope.data.run,
      assistantMessage: envelope.data.assistantMessage,
      sources: previousRunId === envelope.data.run.id ? current.sources : {},
    }
    return { state: next, outcome: next.terminal ? 'terminal' : 'applied' }
  }

  if (current.awaitingSnapshot) {
    return needsSnapshot(current, `首事件不是 snapshot：${safeEventName(envelope.type)}`)
  }

  const sequence = readSequence(envelope.data)
  if (sequence === null) {
    return needsSnapshot(current, `${safeEventName(envelope.type)} 缺少有效 sequence`)
  }
  if (sequence <= current.appliedSequence) return { state: current, outcome: 'ignored' }
  if (sequence > current.appliedSequence + 1) {
    return needsSnapshot(
      current,
      `SSE sequence 缺口：期望 ${current.appliedSequence + 1}，收到 ${sequence}`,
    )
  }

  const next = clonePersistentState(current)
  next.appliedSequence = sequence

  if (!KNOWN_PERSISTENT_EVENTS.has(envelope.type)) {
    const diagnostic = `忽略未知 SSE 事件“${safeEventName(envelope.type)}”（sequence ${sequence}）`
    next.diagnostics = appendDiagnostic(next.diagnostics, diagnostic)
    return { state: next, outcome: 'applied', diagnostic }
  }

  if (!next.run || !next.assistantMessage) {
    return needsSnapshot(current, 'snapshot 未提供 Run 或 assistantMessage')
  }

  switch (envelope.type) {
    case 'run.status': {
      const payload = envelope.data as RunStatusEvent
      next.run = {
        ...next.run,
        status: payload.status,
        phase: payload.phase,
        stopRequested: payload.stopRequested,
      }
      syncMessageRun(next)
      break
    }
    case 'sources.ready': {
      const payload = envelope.data as SourcesReadyEvent
      next.run = {
        ...next.run,
        knowledgeState: payload.knowledgeState,
        evidenceState: payload.evidenceState,
        providedSourceCount: payload.providedSourceCount,
        rewriteFallback: payload.rewriteFallback === true,
      }
      syncMessageRun(next)
      break
    }
    case 'reasoning.delta': {
      const payload = envelope.data as ReasoningDeltaEvent
      if (typeof payload.delta === 'string' && payload.delta.length > 0) {
        next.assistantMessage.reasoningContent =
          (next.assistantMessage.reasoningContent ?? '') + payload.delta
      }
      break
    }
    case 'reasoning.completed': {
      const payload = envelope.data as ReasoningCompletedEvent
      if (Number.isFinite(payload.durationMs) && payload.durationMs >= 0) {
        next.assistantMessage.reasoningDurationMs = payload.durationMs
      }
      break
    }
    case 'answer.delta': {
      const payload = envelope.data as AnswerDeltaEvent
      if (typeof payload.delta === 'string' && payload.delta.length > 0) {
        next.assistantMessage.content += payload.delta
      }
      break
    }
    case 'answer.citation': {
      const payload = envelope.data as AnswerCitationEvent
      const expectedToken = `[[C${payload.citationNumber}]]`
      if (
        Number.isSafeInteger(payload.citationNumber) &&
        payload.citationNumber >= 1 &&
        payload.citationNumber <= 8 &&
        payload.token === expectedToken &&
        payload.source?.citationNumber === payload.citationNumber &&
        Number.isSafeInteger(payload.source.sourceOrdinal) &&
        payload.source.sourceOrdinal >= 1 &&
        payload.source.sourceOrdinal <= 8 &&
        payload.source?.runId === next.run.id
      ) {
        next.assistantMessage.content += payload.token
        if (
          !next.assistantMessage.citations.some(
            (citation) => citation.citationNumber === payload.citationNumber,
          )
        ) {
          next.assistantMessage.citations.push(citationRef(payload.source))
          next.assistantMessage.citations.sort(
            (left, right) => left.citationNumber - right.citationNumber,
          )
        }
        next.sources[payload.citationNumber] = payload.source
      } else {
        const diagnostic = `忽略无效 citation 事件（sequence ${sequence}）`
        next.diagnostics = appendDiagnostic(next.diagnostics, diagnostic)
        return { state: next, outcome: 'applied', diagnostic }
      }
      break
    }
    case 'usage.updated': {
      const payload = envelope.data as UsageUpdatedEvent
      next.run = { ...next.run, usage: payload.usage }
      syncMessageRun(next)
      break
    }
    case 'run.completed':
    case 'run.failed':
    case 'run.stopped': {
      const payload = envelope.data as TerminalEvent
      next.run = payload.run
      next.assistantMessage.currentRun = payload.run
      next.assistantMessage.status = payload.run.status === 'succeeded'
        ? 'complete'
        : payload.run.status === 'stopped'
          ? 'stopped'
          : 'failed'
      next.assistantMessage.completedAt = payload.run.finishedAt
      next.terminal = true
      return { state: next, outcome: 'terminal' }
    }
  }

  return { state: next, outcome: 'applied' }
}

export function reduceTemporaryEvent(
  current: TemporaryStreamState,
  envelope: SseEnvelope,
): ReduceResult<TemporaryStreamState> {
  if (envelope.type === 'snapshot') {
    return {
      state: addTemporaryDiagnostic(current, '临时流忽略不允许的 snapshot'),
      outcome: 'needs_snapshot',
    }
  }
  const sequence = readSequence(envelope.data)
  if (sequence === null) {
    return {
      state: addTemporaryDiagnostic(current, `${safeEventName(envelope.type)} 缺少有效 sequence`),
      outcome: 'needs_snapshot',
    }
  }
  if (sequence <= current.appliedSequence) return { state: current, outcome: 'ignored' }
  if (sequence !== current.appliedSequence + 1) {
    return {
      state: addTemporaryDiagnostic(
        current,
        `临时流 sequence 缺口：期望 ${current.appliedSequence + 1}，收到 ${sequence}`,
      ),
      outcome: 'needs_snapshot',
    }
  }

  const next = cloneTemporaryState(current)
  next.appliedSequence = sequence
  if (!KNOWN_TEMPORARY_EVENTS.has(envelope.type)) {
    const diagnostic = `忽略未知临时 SSE 事件“${safeEventName(envelope.type)}”（sequence ${sequence}）`
    next.diagnostics = appendDiagnostic(next.diagnostics, diagnostic)
    return { state: next, outcome: 'applied', diagnostic }
  }

  switch (envelope.type) {
    case 'run.status': {
      const payload = envelope.data as { status: 'running'; phase: AssistantRunDTO['phase'] }
      next.status = payload.status
      next.phase = payload.phase
      break
    }
    case 'sources.ready': {
      const payload = envelope.data as TemporarySourcesReadyEvent
      next.knowledgeState = payload.knowledgeState
      next.evidenceState = payload.evidenceState
      next.providedSourceCount = payload.providedSourceCount
      next.promptVersion = payload.promptVersion
      next.retrievalVersion = payload.retrievalVersion
      next.rewriteFallback = payload.rewriteFallback === true
      break
    }
    case 'reasoning.delta': {
      const payload = envelope.data as ReasoningDeltaEvent
      if (typeof payload.delta === 'string' && payload.delta.length > 0) {
        next.reasoningContent += payload.delta
      }
      break
    }
    case 'reasoning.completed': {
      const payload = envelope.data as ReasoningCompletedEvent
      if (Number.isFinite(payload.durationMs) && payload.durationMs >= 0) {
        next.reasoningDurationMs = payload.durationMs
      }
      break
    }
    case 'answer.delta': {
      const payload = envelope.data as AnswerDeltaEvent
      if (typeof payload.delta === 'string' && payload.delta.length > 0) {
        next.content += payload.delta
      }
      break
    }
    case 'answer.citation': {
      const payload = envelope.data as TemporaryAnswerCitationEvent
      const expectedToken = `[[C${payload.citationNumber}]]`
      if (
        Number.isSafeInteger(payload.citationNumber) &&
        payload.citationNumber >= 1 &&
        payload.citationNumber <= 8 &&
        payload.token === expectedToken &&
        payload.source?.citationNumber === payload.citationNumber &&
        Number.isSafeInteger(payload.source.sourceOrdinal) &&
        payload.source.sourceOrdinal >= 1 &&
        payload.source.sourceOrdinal <= 8
      ) {
        next.content += payload.token
        if (!next.citations.some((entry) => entry.citationNumber === payload.citationNumber)) {
          next.citations.push(temporaryCitationRef(payload.source))
          next.citations.sort((left, right) => left.citationNumber - right.citationNumber)
        }
        next.sources[payload.citationNumber] = payload.source
      } else {
        const diagnostic = `忽略无效临时 citation 事件（sequence ${sequence}）`
        next.diagnostics = appendDiagnostic(next.diagnostics, diagnostic)
        return { state: next, outcome: 'applied', diagnostic }
      }
      break
    }
    case 'usage.updated': {
      const payload = envelope.data as UsageUpdatedEvent
      next.usage = payload.usage
      break
    }
    case 'run.completed':
    case 'run.failed':
    case 'run.stopped': {
      const payload = envelope.data as TemporaryTerminalEvent
      next.status = payload.status
      next.phase = null
      next.usage = payload.usage
      next.timings = payload.timings
      next.error = payload.error
      if (payload.status === 'succeeded' && payload.temporarySummary !== null) {
        next.summary = payload.temporarySummary
      }
      next.terminal = true
      return { state: next, outcome: 'terminal' }
    }
  }

  return { state: next, outcome: 'applied' }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEnvelope> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let eventId: string | undefined
  let dataLines: string[] = []

  const dispatch = (): SseEnvelope | null => {
    if (dataLines.length === 0) {
      eventName = 'message'
      eventId = undefined
      return null
    }
    const rawData = dataLines.join('\n')
    const result = {
      type: eventName,
      data: JSON.parse(rawData) as unknown,
      ...(eventId === undefined ? {} : { id: eventId }),
    }
    eventName = 'message'
    eventId = undefined
    dataLines = []
    return result
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary = nextLineBoundary(buffer, done)
      while (boundary) {
        const line = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        if (line === '') {
          const emitted = dispatch()
          if (emitted) yield emitted
        } else if (!line.startsWith(':')) {
          const separator = line.indexOf(':')
          const field = separator < 0 ? line : line.slice(0, separator)
          let fieldValue = separator < 0 ? '' : line.slice(separator + 1)
          if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
          if (field === 'event') eventName = fieldValue
          else if (field === 'id') eventId = fieldValue
          else if (field === 'data') dataLines.push(fieldValue)
        }
        boundary = nextLineBoundary(buffer, done)
      }
      if (done) break
    }
    if (buffer.length > 0 && !buffer.startsWith(':')) {
      const separator = buffer.indexOf(':')
      const field = separator < 0 ? buffer : buffer.slice(0, separator)
      let fieldValue = separator < 0 ? '' : buffer.slice(separator + 1)
      if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
      if (field === 'event') eventName = fieldValue
      else if (field === 'id') eventId = fieldValue
      else if (field === 'data') dataLines.push(fieldValue)
    }
    const emitted = dispatch()
    if (emitted) yield emitted
  } finally {
    reader.releaseLock()
  }
}

function nextLineBoundary(value: string, endOfStream: boolean) {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\n') return { index, length: 1 }
    if (character !== '\r') continue
    if (index + 1 < value.length) {
      return { index, length: value[index + 1] === '\n' ? 2 : 1 }
    }
    if (endOfStream) return { index, length: 1 }
    return null
  }
  return null
}

function clonePersistentState(current: PersistentStreamState): PersistentStreamState {
  return {
    ...current,
    run: current.run ? { ...current.run, usage: { ...current.run.usage } } : null,
    assistantMessage: current.assistantMessage
      ? {
          ...current.assistantMessage,
          citations: [...current.assistantMessage.citations],
          currentRun: current.assistantMessage.currentRun
            ? { ...current.assistantMessage.currentRun }
            : null,
        }
      : null,
    sources: { ...current.sources },
    diagnostics: [...current.diagnostics],
  }
}

function cloneTemporaryState(current: TemporaryStreamState): TemporaryStreamState {
  return {
    ...current,
    citations: [...current.citations],
    sources: { ...current.sources },
    usage: { ...current.usage },
    timings: { ...current.timings },
    diagnostics: [...current.diagnostics],
  }
}

function syncMessageRun(state: PersistentStreamState) {
  if (state.assistantMessage && state.run) state.assistantMessage.currentRun = state.run
}

function citationRef(source: AssistantSourceDTO): CitationRefDTO {
  return {
    runId: source.runId,
    sourceOrdinal: source.sourceOrdinal,
    citationNumber: source.citationNumber,
    sourceKind: source.sourceKind,
    sourceClass: source.sourceClass,
    title: source.title,
    availability: source.availability,
  }
}

function temporaryCitationRef(
  source: TemporarySourceDTO,
): Omit<CitationRefDTO, 'runId'> {
  return {
    sourceOrdinal: source.sourceOrdinal,
    citationNumber: source.citationNumber,
    sourceKind: source.sourceKind,
    sourceClass: source.sourceClass,
    title: source.title,
    availability: source.availability,
  }
}

function readSequence(value: unknown): number | null {
  if (!isRecord(value)) return null
  const sequence = value.sequence
  return Number.isSafeInteger(sequence) && Number(sequence) >= 0 ? Number(sequence) : null
}

function isSnapshot(value: unknown): value is SnapshotEvent {
  if (!isRecord(value)) return false
  return (
    Number.isSafeInteger(value.lastSequence) &&
    Number(value.lastSequence) >= 0 &&
    isRecord(value.run) &&
    isRecord(value.assistantMessage)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTerminalRun(run: AssistantRunDTO) {
  return run.status === 'succeeded' || run.status === 'failed' || run.status === 'stopped'
}

function needsSnapshot(
  current: PersistentStreamState,
  diagnostic: string,
): ReduceResult<PersistentStreamState> {
  return {
    state: {
      ...current,
      awaitingSnapshot: true,
      diagnostics: appendDiagnostic(current.diagnostics, diagnostic),
    },
    outcome: 'needs_snapshot',
    diagnostic,
  }
}

function addTemporaryDiagnostic(
  state: TemporaryStreamState,
  diagnostic: string,
): TemporaryStreamState {
  return { ...state, diagnostics: appendDiagnostic(state.diagnostics, diagnostic) }
}

function appendDiagnostic(existing: string[], diagnostic: string) {
  return [...existing.slice(-19), diagnostic]
}

function safeEventName(value: string) {
  return value.replace(/[^a-z0-9._-]/giu, '?').slice(0, 80)
}

function emptyUsage(): AssistantRunDTO['usage'] {
  return {
    rewriteInputTokens: null,
    rewriteOutputTokens: null,
    answerInputTokens: null,
    answerOutputTokens: null,
  }
}

function emptyTimings(): AssistantRunDTO['timings'] {
  return {
    rewriteMs: null,
    embeddingMs: null,
    retrievalMs: null,
    reasoningMs: null,
    answerMs: null,
    totalMs: null,
  }
}

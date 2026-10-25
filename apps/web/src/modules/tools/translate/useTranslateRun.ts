/**
 * 预检后的翻译运行编排（docs/10 §6.1、docs/11 §9–§10、docs/12 §7.3）。
 *
 * 一次运行持有一个队列 ticket：创建 → 轮询 waiting（显示位置与到期，可取消）
 * → claim 获取 permitToken（只存内存）→ 顺序发送片段。绝不自动重试、绝不
 * 自动换引擎；PREFLIGHT_CHANGED 停止发送，并把剩余片段交还调用方重新 preflight。
 *
 * V2.2 OCR 翻译复用本 composable：调用方提供已保护分块的片段与有效的
 * preflight 计划，通过 onReplanRequired 接收重新预检通知。
 */

import { computed, ref } from 'vue'

import type {
  PreflightPlan,
  TranslateChunkRuntime,
  TranslateRunPhase,
  TranslationChunkResponse,
} from './contracts'
import { restoreTranslatedChunk } from './protection'
import {
  claimQueueTicket,
  createIdempotencyKey,
  createQueueTicket,
  deleteQueueTicket,
  getQueueTicket,
  postTranslationChunk,
  TranslateApiError,
} from './translateClient'

export interface TranslateChunkSeed {
  index: number
  units: number
  sourceText: string
}

export interface TranslateRunStartInput {
  chunks: TranslateChunkSeed[]
  plan: PreflightPlan
  sourceLanguage: string
  targetLanguage: string
  /** runId + 占位符账本，用于还原校验。 */
  runId: string
  segmentMap: Map<string, string>
  /** 关闭技术内容保护时没有占位符，译文直接采用，不做还原校验。 */
  protectionEnabled: boolean
}

export interface TranslateRunOptions {
  pollIntervalMs?: number
  onReplanRequired?: (remaining: TranslateChunkSeed[]) => void
}

export interface CancelBreakdown {
  notSent: number
  sent: number
  uncertain: number
}

const DEFAULT_POLL_INTERVAL_MS = 1500

/** 单次运行上下文：代际计数用于让被新运行覆盖的旧异步循环立即失效。 */
interface RunContext {
  input: TranslateRunStartInput
  generation: number
}

export function useTranslateRun(options: TranslateRunOptions = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const phase = ref<TranslateRunPhase>('idle')
  const chunks = ref<TranslateChunkRuntime[]>([])
  const ticketId = ref('')
  const queuePosition = ref<number | null>(null)
  const ticketExpiresAt = ref('')
  const currentChunkIndex = ref<number | null>(null)
  const detectedLanguage = ref<string | null>(null)
  const enginesUsed = ref<string[]>([])
  const runError = ref<{ code: string; status: number; message: string } | null>(null)
  const cancelBreakdown = ref<CancelBreakdown | null>(null)

  /** permitToken 只存在闭包内存，不进入响应式状态或任何持久化。 */
  let permitToken: string | null = null
  let activeTicket = ''
  let csrfTokenSource: () => string = () => ''
  let cancelRequested = false
  let pollTimer: number | undefined
  let sleepResolve: (() => void) | null = null
  let inFlightAbort: AbortController | null = null
  let startInput: TranslateRunStartInput | null = null
  let generation = 0
  let disposed = false
  let pendingTicketRelease: Promise<void> = Promise.resolve()

  const completedCount = computed(() =>
    chunks.value.filter((chunk) => chunk.status === 'success' || chunk.status === 'restore-failed').length,
  )
  const failedChunks = computed(() =>
    chunks.value.filter((chunk) => chunk.status === 'failed' || chunk.status === 'uncertain'),
  )
  const hasUncertainChunks = computed(() =>
    chunks.value.some((chunk) => chunk.status === 'uncertain'),
  )
  const isBusy = computed(() =>
    ['queueing', 'waiting', 'claiming', 'running'].includes(phase.value),
  )

  function isStale(run: RunContext): boolean {
    return run.generation !== generation || cancelRequested
  }

  function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      sleepResolve = resolve
      pollTimer = window.setTimeout(() => {
        sleepResolve = null
        resolve()
      }, milliseconds)
    })
  }

  /** 取消/被覆盖时立即唤醒轮询等待，让旧的 start() 循环尽快返回。 */
  function interruptSleep(): void {
    window.clearTimeout(pollTimer)
    const resolve = sleepResolve
    sleepResolve = null
    resolve?.()
  }

  function upsertRuntime(seed: TranslateChunkSeed, expectedEngine: string): TranslateChunkRuntime {
    const existing = chunks.value.find((entry) => entry.index === seed.index)
    if (existing) {
      existing.units = seed.units
      existing.sourceText = seed.sourceText
      existing.expectedEngine = expectedEngine === 'professional' ? 'professional' : 'general'
      existing.status = 'pending'
      existing.errorCode = undefined
      existing.errorMessage = undefined
      return existing
    }
    const entry: TranslateChunkRuntime = {
      index: seed.index,
      units: seed.units,
      sourceText: seed.sourceText,
      expectedEngine: expectedEngine === 'professional' ? 'professional' : 'general',
      status: 'pending',
      resultText: '',
    }
    chunks.value.push(entry)
    chunks.value.sort((left, right) => left.index - right.index)
    return entry
  }

  /** preflight 计划就绪后调用；PREFLIGHT_CHANGED 取得新计划后也走这里。 */
  async function start(input: TranslateRunStartInput, csrf: () => string): Promise<void> {
    if (disposed || isBusy.value) return
    // 先预留本次启动的代次：等待旧清理期间新输入会递增代次作废该启动，
    // 晚到的续体不得再接管状态并创建新队列。
    const pendingGeneration = generation + 1
    generation = pendingGeneration
    await supersedeActiveRun()
    if (disposed || generation !== pendingGeneration) return
    csrfTokenSource = csrf
    startInput = input
    cancelRequested = false
    runError.value = null
    cancelBreakdown.value = null
    for (const [position, seed] of input.chunks.entries()) {
      const item = input.plan.items[position]
      upsertRuntime(seed, item?.engine ?? 'general')
    }
    await acquirePermitAndRun({ input, generation: pendingGeneration })
  }

  async function acquirePermitAndRun(run: RunContext): Promise<void> {
    const { input } = run
    phase.value = 'queueing'
    try {
      const ticket = await createQueueTicket(csrfTokenSource())
      if (isStale(run)) {
        // 取消发生在创建返回之前：尽力删除已创建的 ticket，不进入排队。
        void deleteQueueTicket(ticket.ticketId, csrfTokenSource()).catch(() => undefined)
        return
      }
      activeTicket = ticket.ticketId
      ticketId.value = ticket.ticketId
      queuePosition.value = ticket.position ?? null
      ticketExpiresAt.value = ticket.expiresAt ?? ''
      if (ticket.status === 'waiting') {
        phase.value = 'waiting'
        const becameReady = await waitForReady(run, ticket.ticketId)
        if (!becameReady) return
      }
      if (isStale(run)) return
      phase.value = 'claiming'
      const claim = await claimQueueTicket(ticket.ticketId, csrfTokenSource())
      if (isStale(run)) {
        void deleteQueueTicket(ticket.ticketId, csrfTokenSource()).catch(() => undefined)
        return
      }
      permitToken = claim.permitToken
      phase.value = 'running'
      await sendPendingChunks(run, input)
    } catch (error) {
      if (isStale(run)) return
      await handleTransportError(error)
    }
  }

  async function waitForReady(run: RunContext, id: string): Promise<boolean> {
    for (;;) {
      if (isStale(run) || id !== activeTicket) return false
      await sleep(pollIntervalMs)
      if (isStale(run) || id !== activeTicket) return false
      const snapshot = await getQueueTicket(id)
      if (isStale(run) || id !== activeTicket) return false
      if (snapshot.status === 'ready' || snapshot.status === 'active') return true
      if (snapshot.status === 'waiting') {
        queuePosition.value = snapshot.position ?? queuePosition.value
        ticketExpiresAt.value = snapshot.expiresAt ?? ticketExpiresAt.value
        continue
      }
      runError.value = {
        code: snapshot.status === 'cancelled' ? 'QUEUE_TICKET_CANCELLED' : 'QUEUE_TICKET_EXPIRED',
        status: 410,
        message: snapshot.status === 'cancelled'
          ? '排队已被取消；需要你重新发起才会再次排队。'
          : '排队等待超过 2 分钟到期；需要你重新排队。',
      }
      phase.value = 'paused'
      releaseTicketLocally()
      return false
    }
  }

  async function sendPendingChunks(run: RunContext, input: TranslateRunStartInput): Promise<void> {
    const targets = chunks.value.filter(
      (chunk) =>
        chunk.status === 'pending' &&
        input.chunks.some((seed) => seed.index === chunk.index),
    )
    for (const chunk of targets) {
      if (isStale(run)) return
      chunk.status = 'sending'
      chunk.requestKey = createIdempotencyKey()
      currentChunkIndex.value = chunk.index
      const controller = new AbortController()
      inFlightAbort = controller
      try {
        const response = await postTranslationChunk({
          ticketId: activeTicket,
          permitToken: permitToken ?? '',
          csrfToken: csrfTokenSource(),
          idempotencyKey: chunk.requestKey,
          sourceText: chunk.sourceText,
          sourceLanguage: input.sourceLanguage,
          targetLanguage: input.targetLanguage,
          expectedEngine: chunk.expectedEngine,
          signal: controller.signal,
        })
        if (isStale(run)) return
        consumeChunkSuccess(chunk, response)
      } catch (error) {
        inFlightAbort = null
        if (controller.signal.aborted || cancelRequested) {
          chunk.status = 'uncertain'
          chunk.errorCode = 'CLIENT_CANCELLED'
          chunk.errorMessage = '请求中断，无法确认上游是否受理。'
          if (run.generation === generation) finishWithCancelledState()
          return
        }
        if (isStale(run)) return
        const handled = await handleChunkError(run, chunk, error, input)
        if (handled === 'stop') return
        continue
      }
      inFlightAbort = null
    }
    currentChunkIndex.value = null
    if (run.generation === generation && !cancelRequested) {
      await releaseActiveTicket()
      phase.value = 'finished'
    }
  }

  function consumeChunkSuccess(chunk: TranslateChunkRuntime, response: TranslationChunkResponse): void {
    chunk.engine = response.engine
    chunk.scene = response.scene
    if (!detectedLanguage.value && response.detectedLanguage) {
      detectedLanguage.value = response.detectedLanguage
    }
    if (!enginesUsed.value.includes(response.engine)) enginesUsed.value.push(response.engine)
    const restored = startInput?.protectionEnabled === false
      ? ({ ok: true, text: response.translatedText } as const)
      : restoreTranslatedChunk({
        sourceChunk: chunk.sourceText,
        translatedChunk: response.translatedText,
        runId: startInput?.runId ?? '',
        segmentMap: startInput?.segmentMap ?? new Map<string, string>(),
      })
    if (restored.ok) {
      chunk.status = 'success'
      chunk.resultText = restored.text
      return
    }
    // 云额度已消耗，但占位符校验失败：保留原文并显示客户端状态。
    chunk.status = 'restore-failed'
    chunk.resultText = restored.text
    chunk.errorCode = restored.code
    chunk.errorMessage =
      '译文中的技术片段占位符校验失败（数量、标识或顺序变化）；该片段保留原文，本次云额度已经使用。'
  }

  async function handleChunkError(
    run: RunContext,
    chunk: TranslateChunkRuntime,
    error: unknown,
    input: TranslateRunStartInput,
  ): Promise<'stop' | 'continue'> {
    if (!(error instanceof TranslateApiError)) {
      chunk.status = 'uncertain'
      chunk.errorCode = 'NETWORK_ERROR'
      chunk.errorMessage = error instanceof Error ? error.message : '网络错误，无法确认上游是否受理。'
      runError.value = { code: 'NETWORK_ERROR', status: 0, message: chunk.errorMessage }
      await releaseActiveTicket()
      phase.value = 'paused'
      return 'stop'
    }

    if (error.code === 'PREFLIGHT_CHANGED') {
      chunk.status = 'pending'
      chunk.requestKey = undefined
      await releaseActiveTicket()
      // DELETE 在途期间用户取消或离页：晚到的续程不得再触发重新规划回调。
      if (isStale(run)) return 'stop'
      phase.value = 'replan'
      const remainingSeeds = input.chunks
        .filter((seed) => {
          const runtime = chunks.value.find((entry) => entry.index === seed.index)
          return runtime !== undefined && runtime.status === 'pending'
        })
      options.onReplanRequired?.(remainingSeeds)
      return 'stop'
    }

    chunk.status = error.code === 'UPSTREAM_RESULT_UNCERTAIN' ? 'uncertain' : 'failed'
    chunk.errorCode = error.code
    chunk.errorMessage = error.message
    runError.value = { code: error.code, status: error.status, message: error.message }
    await releaseActiveTicket()
    phase.value = 'paused'
    return 'stop'
  }

  async function handleTransportError(error: unknown): Promise<void> {
    if (error instanceof TranslateApiError) {
      runError.value = { code: error.code, status: error.status, message: error.message }
    } else {
      runError.value = {
        code: 'NETWORK_ERROR',
        status: 0,
        message: error instanceof Error ? error.message : '网络错误，无法确认是否已受理。',
      }
    }
    await releaseActiveTicket()
    phase.value = 'paused'
  }

  /** 从失败/结果不确定片段继续：使用新的幂等键，不重跑已成功片段。 */
  async function continueFromFailure(): Promise<void> {
    if (disposed || phase.value !== 'paused' || !startInput) return
    const resumeSeeds = startInput.chunks.filter((seed) => {
      const runtime = chunks.value.find((entry) => entry.index === seed.index)
      return (
        runtime !== undefined &&
        (runtime.status === 'failed' || runtime.status === 'uncertain' || runtime.status === 'pending')
      )
    })
    if (resumeSeeds.length === 0) return
    await supersedeActiveRun()
    generation += 1
    cancelRequested = false
    runError.value = null
    cancelBreakdown.value = null
    for (const seed of resumeSeeds) {
      const runtime = chunks.value.find((entry) => entry.index === seed.index)
      if (runtime && (runtime.status === 'failed' || runtime.status === 'uncertain')) {
        runtime.status = 'pending'
        runtime.errorCode = undefined
        runtime.errorMessage = undefined
      }
    }
    const run: RunContext = { input: { ...startInput, chunks: resumeSeeds }, generation }
    await acquirePermitAndRun(run)
  }

  /** 取消：排队中删除 ticket；已 claim 后删除 ticket 并区分未发送/已发送/结果不确定。 */
  async function cancel(): Promise<void> {
    if (!isBusy.value && phase.value !== 'paused') return
    cancelRequested = true
    inFlightAbort?.abort()
    interruptSleep()
    await releaseActiveTicket()
    finishWithCancelledState()
  }

  function finishWithCancelledState(): void {
    phase.value = 'cancelled'
    currentChunkIndex.value = null
    cancelBreakdown.value = {
      notSent: chunks.value.filter((chunk) => chunk.status === 'pending').length,
      sent: chunks.value.filter((chunk) => chunk.status === 'success' || chunk.status === 'restore-failed').length,
      // 在途被中止的片段无法确认上游是否受理，按结果不确定保守呈现。
      uncertain: chunks.value.filter((chunk) => chunk.status === 'uncertain' || chunk.status === 'sending').length,
    }
  }

  function releaseActiveTicket(options: { keepalive?: boolean } = {}): Promise<void> {
    const id = activeTicket
    const csrf = csrfTokenSource()
    releaseTicketLocally()
    if (!id) return pendingTicketRelease
    pendingTicketRelease = pendingTicketRelease.then(async () => {
      try {
        await deleteQueueTicket(id, csrf, options)
      } catch {
        // 释放是尽力而为；失败时由服务端到期回收，绝不自动重试。
      }
    })
    return pendingTicketRelease
  }

  function releaseTicketLocally(): void {
    activeTicket = ''
    ticketId.value = ''
    permitToken = null
    queuePosition.value = null
    ticketExpiresAt.value = ''
  }

  async function supersedeActiveRun(): Promise<void> {
    cancelRequested = true
    interruptSleep()
    inFlightAbort?.abort()
    inFlightAbort = null
    await releaseActiveTicket()
  }

  /**
   * 页面卸载：停止轮询、中止在途请求并尽力释放 ticket。dispose 是本实例终态，
   * 同时作废等待旧清理的启动与之后（如晚到 preflight 回包触发的）一切新准入；
   * resetForNewRun 的输入代次只作废等待中的启动，同一活实例仍可显式新发。
   */
  function dispose(): void {
    disposed = true
    cancelRequested = true
    interruptSleep()
    inFlightAbort?.abort()
    inFlightAbort = null
    void releaseActiveTicket({ keepalive: true })
  }

  /** 新的预览/新输入开始前清空片段与状态；作废等待旧清理的启动。 */
  function resetForNewRun(): void {
    generation += 1
    void supersedeActiveRun()
    chunks.value = []
    detectedLanguage.value = null
    enginesUsed.value = []
    runError.value = null
    cancelBreakdown.value = null
    currentChunkIndex.value = null
    phase.value = 'idle'
  }

  return {
    phase,
    chunks,
    ticketId,
    queuePosition,
    ticketExpiresAt,
    currentChunkIndex,
    detectedLanguage,
    enginesUsed,
    runError,
    cancelBreakdown,
    completedCount,
    failedChunks,
    hasUncertainChunks,
    isBusy,
    start,
    continueFromFailure,
    cancel,
    dispose,
    resetForNewRun,
  }
}

export type TranslateRunComposable = ReturnType<typeof useTranslateRun>

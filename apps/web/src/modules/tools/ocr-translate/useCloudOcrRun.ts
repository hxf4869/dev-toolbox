/**
 * 云端重识别运行编排（docs/09 §9.3、docs/10 §6.2、docs/11 §9/§11、docs/12 §8）。
 *
 * 页面先完成不含图片的 preflight 并让用户确认；本模块只在确认后执行：排队 ticket →
 * 轮询 waiting（显示位置与到期，可取消）→ claim 获取 permitToken（只存内存）
 * → multipart 上传当前图片。绝不自动重试；结果不确定按已保守计量呈现。
 * 取消语义与 V2.1 翻译一致：排队中 DELETE ticket；运行中标记取消并按
 * “结果不确定”保守呈现。
 */

import { computed, ref } from 'vue'

import type { LoadedImage } from './imageInput'
import { TranslateApiError } from '../translate/translateClient'
import {
  claimOcrQueueTicket,
  createIdempotencyKey,
  createOcrQueueTicket,
  deleteOcrQueueTicket,
  getOcrQueueTicket,
  postCloudOcr,
} from './ocrClient'

export type CloudOcrPhase =
  | 'idle'
  | 'preflighting'
  | 'queueing'
  | 'waiting'
  | 'claiming'
  | 'running'
  | 'finished'
  | 'paused'
  | 'cancelled'

const DEFAULT_POLL_INTERVAL_MS = 1500

/** 单次运行上下文：代际计数让被取消/覆盖的旧异步循环立即失效。 */
interface RunContext {
  image: LoadedImage
  generation: number
}

export function useCloudOcrRun(options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const phase = ref<CloudOcrPhase>('idle')
  const queuePosition = ref<number | null>(null)
  const ticketExpiresAt = ref('')
  const resultText = ref('')
  const remainingAfter = ref<number | null>(null)
  const error = ref<{ code: string; status: number; message: string; details?: Record<string, unknown> } | null>(null)
  /** 运行中被用户取消：无法确认上游是否受理，按结果不确定保守呈现。 */
  const cancelledInFlight = ref(false)

  /** permitToken 只存在闭包内存，不进入响应式状态或任何持久化。 */
  let permitToken: string | null = null
  let activeTicket = ''
  let csrfTokenSource: () => string = () => ''
  let cancelRequested = false
  let pollTimer: number | undefined
  let sleepResolve: (() => void) | null = null
  let inFlightAbort: AbortController | null = null
  let generation = 0
  let disposed = false
  let pendingTicketRelease: Promise<void> = Promise.resolve()

  const isBusy = computed(() =>
    ['preflighting', 'queueing', 'waiting', 'claiming', 'running'].includes(phase.value),
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

  function interruptSleep(): void {
    window.clearTimeout(pollTimer)
    const resolve = sleepResolve
    sleepResolve = null
    resolve?.()
  }

  function releaseTicketLocally(): void {
    activeTicket = ''
    permitToken = null
    queuePosition.value = null
    ticketExpiresAt.value = ''
  }

  function releaseActiveTicket(options: { keepalive?: boolean } = {}): Promise<void> {
    const id = activeTicket
    const csrf = csrfTokenSource()
    releaseTicketLocally()
    if (!id) return pendingTicketRelease
    pendingTicketRelease = pendingTicketRelease.then(async () => {
      try {
        await deleteOcrQueueTicket(id, csrf, options)
      } catch {
        // 释放是尽力而为；失败时由服务端到期回收，绝不自动重试。
      }
    })
    return pendingTicketRelease
  }

  /** 用户确认后启动；手动重试同样走这里，内部生成新的幂等键。 */
  async function start(image: LoadedImage, csrf: () => string): Promise<void> {
    if (disposed || isBusy.value) return
    const pendingGeneration = ++generation
    await supersedeActiveRun()
    if (disposed || generation !== pendingGeneration) return
    csrfTokenSource = csrf
    const run: RunContext = { image, generation: pendingGeneration }
    cancelRequested = false
    error.value = null
    resultText.value = ''
    remainingAfter.value = null
    cancelledInFlight.value = false
    phase.value = 'queueing'
    try {
      const ticket = await createOcrQueueTicket(csrfTokenSource())
      if (isStale(run)) {
        void deleteOcrQueueTicket(ticket.ticketId, csrfTokenSource()).catch(() => undefined)
        return
      }
      activeTicket = ticket.ticketId
      queuePosition.value = ticket.position ?? null
      ticketExpiresAt.value = ticket.expiresAt ?? ''
      if (ticket.status === 'waiting') {
        phase.value = 'waiting'
        const becameReady = await waitForReady(run, ticket.ticketId)
        if (!becameReady) return
      }
      if (isStale(run)) return
      phase.value = 'claiming'
      const claim = await claimOcrQueueTicket(ticket.ticketId, csrfTokenSource())
      if (isStale(run)) {
        void deleteOcrQueueTicket(ticket.ticketId, csrfTokenSource()).catch(() => undefined)
        return
      }
      const token = claim.permitToken
      permitToken = token
      phase.value = 'running'
      const controller = new AbortController()
      inFlightAbort = controller
      const response = await postCloudOcr({
        blob: image.blob,
        fileName: image.fileName,
        permitToken: token,
        csrfToken: csrfTokenSource(),
        idempotencyKey: createIdempotencyKey(),
        signal: controller.signal,
      })
      if (isStale(run)) return
      resultText.value = response.text
      remainingAfter.value = response.quota?.remaining ?? null
      await releaseActiveTicket()
      phase.value = 'finished'
    } catch (caught) {
      const aborted = inFlightAbort?.signal.aborted === true && cancelRequested
      inFlightAbort = null
      if (aborted) {
        if (run.generation === generation) finishCancelledInFlight()
        return
      }
      if (isStale(run)) return
      if (caught instanceof TranslateApiError) {
        error.value = { code: caught.code, status: caught.status, message: caught.message, details: caught.details }
        if (typeof caught.details.remaining === 'number') remainingAfter.value = caught.details.remaining
      } else {
        error.value = {
          code: 'NETWORK_ERROR',
          status: 0,
          message: caught instanceof Error ? caught.message : '网络错误，无法确认是否已受理。',
        }
      }
      await releaseActiveTicket()
      phase.value = 'paused'
    }
  }

  async function waitForReady(run: RunContext, ticketId: string): Promise<boolean> {
    for (;;) {
      if (isStale(run) || ticketId !== activeTicket) return false
      await sleep(pollIntervalMs)
      if (isStale(run) || ticketId !== activeTicket) return false
      const snapshot = await getOcrQueueTicket(ticketId)
      if (isStale(run) || ticketId !== activeTicket) return false
      if (snapshot.status === 'ready' || snapshot.status === 'active') return true
      if (snapshot.status === 'waiting') {
        queuePosition.value = snapshot.position ?? queuePosition.value
        ticketExpiresAt.value = snapshot.expiresAt ?? ticketExpiresAt.value
        continue
      }
      error.value = {
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

  function finishCancelledInFlight(): void {
    phase.value = 'cancelled'
    cancelledInFlight.value = true
    releaseTicketLocally()
  }

  /** 取消：排队中删除 ticket；运行中中止上传并按结果不确定保守呈现。 */
  async function cancel(): Promise<void> {
    if (!isBusy.value) return
    cancelRequested = true
    inFlightAbort?.abort()
    interruptSleep()
    await releaseActiveTicket()
    phase.value = 'cancelled'
  }

  async function supersedeActiveRun(): Promise<void> {
    cancelRequested = true
    interruptSleep()
    inFlightAbort?.abort()
    inFlightAbort = null
    await releaseActiveTicket()
  }

  /** 页面卸载：中止在途请求并尽力释放 ticket。 */
  function dispose(): void {
    disposed = true
    generation += 1
    cancelRequested = true
    interruptSleep()
    inFlightAbort?.abort()
    inFlightAbort = null
    void releaseActiveTicket({ keepalive: true })
  }

  /** 换图等场景：丢弃旧运行状态。 */
  function reset(): void {
    generation += 1
    void supersedeActiveRun()
    resultText.value = ''
    remainingAfter.value = null
    error.value = null
    cancelledInFlight.value = false
    phase.value = 'idle'
  }

  return {
    phase,
    queuePosition,
    ticketExpiresAt,
    resultText,
    remainingAfter,
    error,
    cancelledInFlight,
    isBusy,
    start,
    cancel,
    dispose,
    reset,
  }
}

export type CloudOcrRunComposable = ReturnType<typeof useCloudOcrRun>

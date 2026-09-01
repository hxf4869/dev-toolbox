import { isWorkerOutputEnvelope } from './protocol'
import type { WorkerCancelEnvelope, WorkerRequestEnvelope } from './protocol'

export interface WorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  terminate(): void
}

export interface WorkerRequestOptions {
  signal?: AbortSignal
  transfer?: Transferable[]
  supersede?: string
}

export interface WorkerRequest<TResult> {
  readonly requestId: string
  readonly promise: Promise<TResult>
  cancel(): void
}

export interface WorkerRequestClientOptions {
  /**
   * Long synchronous parsing cannot receive a cancel message until it returns.
   * Keep this enabled for JSON/YAML jobs so cancellation also terminates that Worker.
   */
  terminateOnCancel?: boolean
}

interface PendingRequest<TResult> {
  resolve(value: TResult): void
  reject(reason: unknown): void
  supersede?: string
  removeAbortListener(): void
}

export class WorkerRequestCancelledError extends Error {
  constructor(message = 'Worker request was cancelled') {
    super(message)
    this.name = 'WorkerRequestCancelledError'
  }
}

export class WorkerRemoteError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkerRemoteError'
    this.code = code
  }
}

export class WorkerRequestClient<TPayload, TResult> {
  private worker: WorkerPort | null = null
  private sequence = 0
  private disposed = false
  private readonly pending = new Map<string, PendingRequest<TResult>>()
  private readonly superseded = new Map<string, string>()
  private readonly terminateOnCancel: boolean

  constructor(
    private readonly createWorker: () => WorkerPort,
    options: WorkerRequestClientOptions = {},
  ) {
    this.terminateOnCancel = options.terminateOnCancel ?? true
  }

  request(payload: TPayload, options: WorkerRequestOptions = {}): WorkerRequest<TResult> {
    if (this.disposed) throw new Error('Worker request client is disposed')
    if (options.signal?.aborted) {
      const requestId = this.nextRequestId()
      return {
        requestId,
        promise: Promise.reject(new WorkerRequestCancelledError()),
        cancel() {},
      }
    }

    if (options.supersede) {
      const obsoleteRequestId = this.superseded.get(options.supersede)
      if (obsoleteRequestId) this.cancel(obsoleteRequestId)
    }

    const requestId = this.nextRequestId()
    const worker = this.ensureWorker()
    let resolvePromise!: (value: TResult) => void
    let rejectPromise!: (reason: unknown) => void
    const promise = new Promise<TResult>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const onAbort = () => this.cancel(requestId)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    this.pending.set(requestId, {
      resolve: resolvePromise,
      reject: rejectPromise,
      supersede: options.supersede,
      removeAbortListener: () => options.signal?.removeEventListener('abort', onAbort),
    })
    if (options.supersede) this.superseded.set(options.supersede, requestId)

    const envelope: WorkerRequestEnvelope<TPayload> = { type: 'request', requestId, payload }
    worker.postMessage(envelope, options.transfer)

    return {
      requestId,
      promise,
      cancel: () => this.cancel(requestId),
    }
  }

  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    const envelope: WorkerCancelEnvelope = { type: 'cancel', requestId }
    this.worker?.postMessage(envelope)
    this.finish(requestId)
    pending.reject(new WorkerRequestCancelledError())

    if (this.terminateOnCancel) this.terminateWorker('Worker was restarted after cancellation')
    return true
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.terminateWorker('Worker request client was disposed')
  }

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    if (!isWorkerOutputEnvelope<TResult>(event.data)) return
    const pending = this.pending.get(event.data.requestId)
    if (!pending) return

    this.finish(event.data.requestId)
    if (event.data.type === 'result') {
      pending.resolve(event.data.result)
      return
    }
    pending.reject(new WorkerRemoteError(event.data.error.code, event.data.error.message))
  }

  private ensureWorker() {
    if (this.worker) return this.worker
    const worker = this.createWorker()
    worker.addEventListener('message', this.onMessage)
    this.worker = worker
    return worker
  }

  private terminateWorker(message: string) {
    if (this.worker) {
      this.worker.removeEventListener('message', this.onMessage)
      this.worker.terminate()
      this.worker = null
    }
    const error = new WorkerRequestCancelledError(message)
    for (const [requestId, pending] of this.pending) {
      this.finish(requestId)
      pending.reject(error)
    }
  }

  private finish(requestId: string) {
    const pending = this.pending.get(requestId)
    if (!pending) return
    pending.removeAbortListener()
    if (pending.supersede && this.superseded.get(pending.supersede) === requestId) {
      this.superseded.delete(pending.supersede)
    }
    this.pending.delete(requestId)
  }

  private nextRequestId() {
    this.sequence += 1
    return `request-${this.sequence}`
  }
}

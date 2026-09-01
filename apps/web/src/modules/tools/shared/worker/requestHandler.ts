import type {
  WorkerErrorEnvelope,
  WorkerInputEnvelope,
  WorkerResultEnvelope,
} from './protocol'

export interface WorkerHandlerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
}

export type WorkerRequestHandler<TPayload, TResult> = (
  payload: TPayload,
  context: { requestId: string; signal: AbortSignal },
) => Promise<TResult> | TResult

export function attachWorkerRequestHandler<TPayload, TResult>(
  scope: WorkerHandlerScope,
  handler: WorkerRequestHandler<TPayload, TResult>,
) {
  const active = new Map<string, AbortController>()
  let disposed = false

  const onMessage = async (event: MessageEvent<unknown>) => {
    const envelope = event.data as Partial<WorkerInputEnvelope<TPayload>>
    if (!envelope || typeof envelope !== 'object' || typeof envelope.requestId !== 'string') return
    if (envelope.type === 'cancel') {
      active.get(envelope.requestId)?.abort()
      active.delete(envelope.requestId)
      return
    }
    if (envelope.type !== 'request' || !('payload' in envelope)) return

    const controller = new AbortController()
    active.set(envelope.requestId, controller)
    try {
      const result = await handler(envelope.payload as TPayload, {
        requestId: envelope.requestId,
        signal: controller.signal,
      })
      if (disposed || controller.signal.aborted || active.get(envelope.requestId) !== controller) return
      const resultEnvelope: WorkerResultEnvelope<TResult> = {
        type: 'result',
        requestId: envelope.requestId,
        result,
      }
      scope.postMessage(resultEnvelope)
    } catch (error) {
      if (disposed || controller.signal.aborted || active.get(envelope.requestId) !== controller) return
      const resultEnvelope: WorkerErrorEnvelope = {
        type: 'error',
        requestId: envelope.requestId,
        error: {
          code: 'WORKER_OPERATION_FAILED',
          message: error instanceof Error ? error.message : 'Worker operation failed',
        },
      }
      scope.postMessage(resultEnvelope)
    } finally {
      if (active.get(envelope.requestId) === controller) active.delete(envelope.requestId)
    }
  }

  scope.addEventListener('message', onMessage)
  return () => {
    if (disposed) return
    disposed = true
    scope.removeEventListener('message', onMessage)
    for (const controller of active.values()) controller.abort()
    active.clear()
  }
}

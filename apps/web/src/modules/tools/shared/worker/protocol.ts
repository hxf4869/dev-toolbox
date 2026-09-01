export interface WorkerRequestEnvelope<TPayload> {
  type: 'request'
  requestId: string
  payload: TPayload
}

export interface WorkerCancelEnvelope {
  type: 'cancel'
  requestId: string
}

export interface WorkerResultEnvelope<TResult> {
  type: 'result'
  requestId: string
  result: TResult
}

export interface WorkerErrorEnvelope {
  type: 'error'
  requestId: string
  error: {
    code: string
    message: string
  }
}

export type WorkerInputEnvelope<TPayload> = WorkerRequestEnvelope<TPayload> | WorkerCancelEnvelope
export type WorkerOutputEnvelope<TResult> = WorkerResultEnvelope<TResult> | WorkerErrorEnvelope

export function isWorkerOutputEnvelope<TResult>(value: unknown): value is WorkerOutputEnvelope<TResult> {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkerOutputEnvelope<TResult>>
  return (
    (candidate.type === 'result' || candidate.type === 'error') &&
    typeof candidate.requestId === 'string'
  )
}

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface JsonTypeGenerationHttpLifecycle {
  readonly signal: AbortSignal
  readonly canWriteResponse: () => boolean
  readonly dispose: () => void
}

export function observeJsonTypeGenerationHttpLifecycle(
  request: IncomingMessage,
  response: ServerResponse,
): JsonTypeGenerationHttpLifecycle {
  const controller = new AbortController()
  const abortProviderRequest = () => {
    if (!controller.signal.aborted) controller.abort(new Error('JSON AI caller disconnected'))
  }
  const handleResponseClose = () => {
    if (!response.writableEnded) abortProviderRequest()
  }

  request.once('aborted', abortProviderRequest)
  response.once('close', handleResponseClose)

  return {
    signal: controller.signal,
    canWriteResponse: () => !controller.signal.aborted && !response.destroyed,
    dispose: () => {
      request.removeListener('aborted', abortProviderRequest)
      response.removeListener('close', handleResponseClose)
    },
  }
}

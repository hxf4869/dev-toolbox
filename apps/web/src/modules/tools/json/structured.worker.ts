import { attachWorkerRequestHandler } from '../shared/worker'

import type { JsonWorkerRequest, JsonWorkerResult } from './contracts'
import { runJsonOperation } from './operations'

const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
}

attachWorkerRequestHandler<JsonWorkerRequest, JsonWorkerResult>(workerScope, async (request, { signal }) => {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  const result = await runJsonOperation(request)
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  return result
})

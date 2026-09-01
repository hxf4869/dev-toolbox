import { attachWorkerRequestHandler } from '../shared/worker'

import type { YamlWorkerRequest, YamlWorkerResult } from './contracts'
import { runYamlOperation } from './operations'

const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
}

attachWorkerRequestHandler<YamlWorkerRequest, YamlWorkerResult>(workerScope, (request, { signal }) => {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  const result = runYamlOperation(request)
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  return result
})

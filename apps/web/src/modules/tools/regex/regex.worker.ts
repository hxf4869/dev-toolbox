import type { RegexRunRequest, RegexWorkerResponse } from './contracts'
import { executeRegex } from './engine'

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<RegexRunRequest>) => void) | null
  postMessage(message: RegexWorkerResponse): void
}

worker.onmessage = (event: MessageEvent<RegexRunRequest>) => {
  const request = event.data
  try {
    worker.postMessage({
      id: request.id,
      type: 'result',
      result: executeRegex(request.pattern, request.flags, request.text, request.replacement),
    } satisfies RegexWorkerResponse)
  } catch (error) {
    worker.postMessage({ id: request.id, type: 'error', message: error instanceof Error ? error.message : '正则执行失败' } satisfies RegexWorkerResponse)
  }
}

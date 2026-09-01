import type { DigestWorkerRequest, DigestWorkerResponse } from './contracts'
import { hashBlob, hashBytes } from './hashCore'

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<DigestWorkerRequest>) => void) | null
  postMessage(message: DigestWorkerResponse): void
}

worker.onmessage = (event: MessageEvent<DigestWorkerRequest>) => {
  const request = event.data
  void run(request)
}

async function run(request: DigestWorkerRequest) {
  try {
    const reportProgress = (progress: Omit<Extract<DigestWorkerResponse, { type: 'progress' }>, 'id' | 'type'>) => {
      worker.postMessage({ id: request.id, type: 'progress', ...progress } satisfies DigestWorkerResponse)
    }
    const totalBytes = request.kind === 'text'
      ? new TextEncoder().encode(request.text).byteLength
      : request.file.size
    const digest = request.kind === 'text'
      ? await hashBytes(new TextEncoder().encode(request.text), request.algorithm, reportProgress)
      : await hashBlob(request.file, request.algorithm, reportProgress)
    worker.postMessage({ id: request.id, type: 'result', digest, totalBytes } satisfies DigestWorkerResponse)
  } catch (error) {
    worker.postMessage({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : '摘要计算失败',
    } satisfies DigestWorkerResponse)
  }
}

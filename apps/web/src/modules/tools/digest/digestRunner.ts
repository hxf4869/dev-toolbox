import type {
  DigestAlgorithm,
  DigestProgress,
  DigestWorkerRequest,
  DigestWorkerResponse,
} from './contracts'

interface WorkerLike {
  onmessage: ((event: MessageEvent<DigestWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: DigestWorkerRequest): void
  terminate(): void
}

type WorkerFactory = () => WorkerLike

export type DigestInput =
  | { kind: 'text'; text: string; algorithm: DigestAlgorithm }
  | { kind: 'file'; file: File; algorithm: DigestAlgorithm }

export interface DigestRunResult {
  digest: string
  totalBytes: number
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./digest.worker.ts', import.meta.url), { type: 'module' })
}

export class DigestRunner {
  private sequence = 0
  private active?: {
    id: number
    worker: WorkerLike
    reject: (reason: Error) => void
  }

  constructor(private readonly workerFactory: WorkerFactory = defaultWorkerFactory) {}

  run(input: DigestInput, onProgress?: (progress: DigestProgress) => void): Promise<DigestRunResult> {
    this.cancel('新计算已替代旧计算')
    const id = ++this.sequence
    const worker = this.workerFactory()
    return new Promise<DigestRunResult>((resolve, reject) => {
      this.active = { id, worker, reject }
      worker.onmessage = (event) => {
        if (this.active?.id !== id || event.data.id !== id) return
        if (event.data.type === 'progress') {
          onProgress?.({
            processedBytes: event.data.processedBytes,
            totalBytes: event.data.totalBytes,
            rateBytesPerSecond: event.data.rateBytesPerSecond,
          })
          return
        }
        worker.terminate()
        this.active = undefined
        if (event.data.type === 'result') resolve({ digest: event.data.digest, totalBytes: event.data.totalBytes })
        else reject(new Error(event.data.message))
      }
      worker.onerror = () => {
        if (this.active?.id !== id) return
        worker.terminate()
        this.active = undefined
        reject(new Error('摘要 Worker 运行失败'))
      }
      const request: DigestWorkerRequest = input.kind === 'text'
        ? { id, kind: 'text', text: input.text, algorithm: input.algorithm }
        : { id, kind: 'file', file: input.file, algorithm: input.algorithm }
      worker.postMessage(request)
    })
  }

  cancel(message = '操作已取消'): void {
    const active = this.active
    if (!active) return
    this.active = undefined
    active.worker.terminate()
    active.reject(new DOMException(message, 'AbortError'))
  }

  dispose(): void {
    this.cancel('页面已离开')
  }
}

export function normalizeExpectedDigest(value: string): string {
  return value.trim().replace(/^0x/i, '').replace(/[\t\n\f\r ]+/g, '').toLowerCase()
}

export function compareDigest(
  actual: string,
  expected: string,
  algorithm: DigestAlgorithm,
): { status: 'empty' | 'match' | 'mismatch' | 'invalid'; normalized: string; message: string } {
  const normalized = normalizeExpectedDigest(expected)
  if (!normalized) return { status: 'empty', normalized, message: '尚未输入期望校验值' }
  const expectedLength = { md5: 32, sha1: 40, sha256: 64, sha384: 96, sha512: 128 }[algorithm]
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== expectedLength) {
    return { status: 'invalid', normalized, message: `期望值必须是 ${expectedLength} 位十六进制 ${algorithm.toUpperCase()} 摘要` }
  }
  return normalized === actual.toLowerCase()
    ? { status: 'match', normalized, message: '校验值相同' }
    : { status: 'mismatch', normalized, message: '校验值不同' }
}

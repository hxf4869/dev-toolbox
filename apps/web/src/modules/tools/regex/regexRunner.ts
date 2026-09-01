import type { RegexRunRequest, RegexRunResult, RegexWorkerResponse } from './contracts'

interface WorkerLike {
  onmessage: ((event: MessageEvent<RegexWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: RegexRunRequest): void
  terminate(): void
}

type WorkerFactory = () => WorkerLike

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./regex.worker.ts', import.meta.url), { type: 'module' })
}

export class RegexRunError extends Error {
  constructor(public readonly code: 'timeout' | 'worker', message: string) {
    super(message)
    this.name = 'RegexRunError'
  }
}

export class RegexRunner {
  private sequence = 0
  private active?: {
    id: number
    worker: WorkerLike
    timer: number
    reject: (reason: Error) => void
  }

  constructor(
    private readonly workerFactory: WorkerFactory = defaultWorkerFactory,
    private readonly timeoutMs = 500,
  ) {}

  run(input: Omit<RegexRunRequest, 'id'>): Promise<RegexRunResult> {
    this.cancel('新运行已替代旧运行')
    const id = ++this.sequence
    const worker = this.workerFactory()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.active?.id !== id) return
        worker.terminate()
        this.active = undefined
        reject(new RegexRunError('timeout', '表达式运行超时，Worker 已终止'))
      }, this.timeoutMs)
      this.active = { id, worker, timer, reject }
      worker.onmessage = (event) => {
        if (this.active?.id !== id || event.data.id !== id) return
        window.clearTimeout(timer)
        worker.terminate()
        this.active = undefined
        if (event.data.type === 'result') resolve(event.data.result)
        else reject(new RegexRunError('worker', `JavaScript RegExp 错误：${event.data.message}`))
      }
      worker.onerror = () => {
        if (this.active?.id !== id) return
        window.clearTimeout(timer)
        worker.terminate()
        this.active = undefined
        reject(new RegexRunError('worker', '正则 Worker 运行失败'))
      }
      worker.postMessage({ ...input, id })
    })
  }

  cancel(message = '运行已取消'): void {
    const active = this.active
    if (!active) return
    this.active = undefined
    window.clearTimeout(active.timer)
    active.worker.terminate()
    active.reject(new DOMException(message, 'AbortError'))
  }

  dispose(): void {
    this.cancel('页面已离开')
  }
}

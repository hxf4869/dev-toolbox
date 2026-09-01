import { vi } from 'vitest'

import { WorkerRequestCancelledError, WorkerRequestClient } from './requestClient'

class FakeWorker {
  readonly posted: unknown[] = []
  readonly terminate = vi.fn()
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()

  postMessage(message: unknown) {
    this.posted.push(message)
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.delete(listener)
  }

  emit(data: unknown) {
    for (const listener of this.listeners) listener(new MessageEvent('message', { data }))
  }
}

describe('WorkerRequestClient', () => {
  it('correlates results by request id', async () => {
    const worker = new FakeWorker()
    const client = new WorkerRequestClient<{ text: string }, { length: number }>(() => worker)
    const request = client.request({ text: '中文' })

    expect(worker.posted).toEqual([
      { type: 'request', requestId: 'request-1', payload: { text: '中文' } },
    ])
    worker.emit({ type: 'result', requestId: request.requestId, result: { length: 2 } })

    await expect(request.promise).resolves.toEqual({ length: 2 })
    client.dispose()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('posts cancellation, terminates a synchronous worker, and discards its late result', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkerRequestClient<string, string>(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })
    const obsolete = client.request('obsolete')
    const obsoleteOutcome = obsolete.promise.catch((error: unknown) => error)

    obsolete.cancel()
    expect(workers[0]?.posted.at(-1)).toEqual({ type: 'cancel', requestId: obsolete.requestId })
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    workers[0]?.emit({ type: 'result', requestId: obsolete.requestId, result: 'late' })
    expect(await obsoleteOutcome).toBeInstanceOf(WorkerRequestCancelledError)

    const current = client.request('current')
    expect(workers).toHaveLength(2)
    workers[1]?.emit({ type: 'result', requestId: current.requestId, result: 'fresh' })
    await expect(current.promise).resolves.toBe('fresh')
    client.dispose()
  })

  it('supersedes the previous scoped request and aborts all work on dispose', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkerRequestClient<string, string>(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })
    const first = client.request('first', { supersede: 'format' })
    const firstOutcome = first.promise.catch((error: unknown) => error)
    const second = client.request('second', { supersede: 'format' })
    const secondOutcome = second.promise.catch((error: unknown) => error)

    expect(await firstOutcome).toBeInstanceOf(WorkerRequestCancelledError)
    client.dispose()
    expect(await secondOutcome).toBeInstanceOf(WorkerRequestCancelledError)
    expect(() => client.request('after dispose')).toThrow('disposed')
  })
})

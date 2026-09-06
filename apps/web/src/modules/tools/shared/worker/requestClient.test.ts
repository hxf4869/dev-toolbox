import { vi } from 'vitest'

import {
  WorkerRequestCancelledError,
  WorkerRequestClient,
  WorkerRequestFailedError,
} from './requestClient'
import type { WorkerPortEventType } from './requestClient'

class FakeWorker {
  readonly posted: unknown[] = []
  readonly terminate = vi.fn()
  postMessageError: unknown = null
  private readonly listeners = new Map<WorkerPortEventType, Set<(event: MessageEvent<unknown>) => void>>()

  postMessage(message: unknown) {
    if (this.postMessageError !== null) throw this.postMessageError
    this.posted.push(message)
  }

  addEventListener(type: WorkerPortEventType, listener: (event: MessageEvent<unknown>) => void) {
    let group = this.listeners.get(type)
    if (!group) {
      group = new Set()
      this.listeners.set(type, group)
    }
    group.add(listener)
  }

  removeEventListener(type: WorkerPortEventType, listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  listenerCount(type: WorkerPortEventType) {
    return this.listeners.get(type)?.size ?? 0
  }

  emit(type: WorkerPortEventType, data: unknown = null) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }))
    }
  }
}

function createFactory(workers: FakeWorker[]) {
  return () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  }
}

describe('WorkerRequestClient', () => {
  it('correlates results by request id', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkerRequestClient<{ text: string }, { length: number }>(createFactory(workers))
    const request = client.request({ text: '中文' })

    expect(workers[0]?.posted).toEqual([
      { type: 'request', requestId: 'request-1', payload: { text: '中文' } },
    ])
    workers[0]?.emit('message', { type: 'result', requestId: request.requestId, result: { length: 2 } })

    await expect(request.promise).resolves.toEqual({ length: 2 })
    client.dispose()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('posts cancellation, terminates a synchronous worker, and discards its late result', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkerRequestClient<string, string>(createFactory(workers))
    const obsolete = client.request('obsolete')
    const obsoleteOutcome = obsolete.promise.catch((error: unknown) => error)

    obsolete.cancel()
    expect(workers[0]?.posted.at(-1)).toEqual({ type: 'cancel', requestId: obsolete.requestId })
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    workers[0]?.emit('message', { type: 'result', requestId: obsolete.requestId, result: 'late' })
    expect(await obsoleteOutcome).toBeInstanceOf(WorkerRequestCancelledError)

    const current = client.request('current')
    expect(workers).toHaveLength(2)
    workers[1]?.emit('message', { type: 'result', requestId: current.requestId, result: 'fresh' })
    await expect(current.promise).resolves.toBe('fresh')
    client.dispose()
  })

  it('supersedes the previous scoped request and aborts all work on dispose', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkerRequestClient<string, string>(createFactory(workers))
    const first = client.request('first', { supersede: 'format' })
    const firstOutcome = first.promise.catch((error: unknown) => error)
    const second = client.request('second', { supersede: 'format' })
    const secondOutcome = second.promise.catch((error: unknown) => error)

    expect(await firstOutcome).toBeInstanceOf(WorkerRequestCancelledError)
    client.dispose()
    expect(await secondOutcome).toBeInstanceOf(WorkerRequestCancelledError)
    expect(() => client.request('after dispose')).toThrow('disposed')
  })

  it('settles every pending request when the worker fails to load or errors (T37)', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkerRequestClient<string, string>(createFactory(workers))
    const first = client.request('first')
    const second = client.request('second', { supersede: 'json' })
    const outcomes = Promise.all([
      first.promise.catch((error: unknown) => error),
      second.promise.catch((error: unknown) => error),
    ])

    expect(workers).toHaveLength(1)
    workers[0]?.emit('error', new Error('script failed to load'))

    const [firstError, secondError] = await outcomes
    expect(firstError).toBeInstanceOf(WorkerRequestFailedError)
    expect(secondError).toBeInstanceOf(WorkerRequestFailedError)
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    expect(workers[0]?.listenerCount('message')).toBe(0)

    // The next request lazily creates a fresh worker and works normally.
    const third = client.request('third')
    expect(workers).toHaveLength(2)
    workers[1]?.emit('message', { type: 'result', requestId: third.requestId, result: 'ok' })
    await expect(third.promise).resolves.toBe('ok')
    client.dispose()
  })

  it('treats messageerror as fatal for all pending requests (T37)', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkerRequestClient<string, string>(createFactory(workers))
    const request = client.request('payload')
    const outcome = request.promise.catch((error: unknown) => error)

    workers[0]?.emit('messageerror')

    expect(await outcome).toBeInstanceOf(WorkerRequestFailedError)
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('releases pending, supersede, and abort state when postMessage throws (T38)', async () => {
    const worker = new FakeWorker()
    worker.postMessageError = new TypeError('could not be cloned')
    const client = new WorkerRequestClient<{ blob: unknown }, string>(() => worker)

    const controller = new AbortController()
    const failed = client.request({ blob: Symbol('uncloneable') }, { signal: controller.signal, supersede: 'json' })
    const outcome = failed.promise.catch((error: unknown) => error)

    expect(await outcome).toMatchObject({ name: 'WorkerRequestFailedError' })
    // Pending was released: a later cancel is a no-op and aborting cannot re-settle.
    expect(failed.cancel()).toBe(false)
    expect(() => controller.abort()).not.toThrow()
    // The supersede registration was cleaned, so the next scoped request is the live one.
    worker.postMessageError = null
    const next = client.request({ blob: 'ok' }, { supersede: 'json' })
    expect(next.requestId).toBe('request-2')
    worker.emit('message', { type: 'result', requestId: next.requestId, result: 'ok' })
    await expect(next.promise).resolves.toBe('ok')
    client.dispose()
  })

  it('still settles the request and rebuilds the worker when the cancel message fails to send (T39)', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkerRequestClient<string, string>(createFactory(workers))
    const request = client.request('work')
    const outcome = request.promise.catch((error: unknown) => error)

    workers[0]!.postMessageError = new Error('port detached')
    expect(request.cancel()).toBe(true)

    expect(await outcome).toBeInstanceOf(WorkerRequestCancelledError)
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    const next = client.request('work again')
    expect(workers).toHaveLength(2)
    workers[1]?.emit('message', { type: 'result', requestId: next.requestId, result: 'ok' })
    await expect(next.promise).resolves.toBe('ok')
    client.dispose()
  })

  it('settles a request exactly once across dispose, late result, and abort races (T40)', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkerRequestClient<string, string>(createFactory(workers))
    const controller = new AbortController()
    const request = client.request('race', { signal: controller.signal })
    let settlements = 0
    const observe = request.promise.then(
      () => settlements += 1,
      () => settlements += 1,
    )

    client.dispose()
    controller.abort()
    workers[0]?.emit('message', { type: 'result', requestId: request.requestId, result: 'late' })
    workers[0]?.emit('error')

    await observe
    expect(settlements).toBe(1)
    expect(await request.promise.catch((error: unknown) => error)).toBeInstanceOf(WorkerRequestCancelledError)
    expect(request.cancel()).toBe(false)
  })
})

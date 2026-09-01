import { vi } from 'vitest'

import { attachWorkerRequestHandler } from './requestHandler'

class FakeScope {
  readonly posted: unknown[] = []
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
    for (const listener of this.listeners) void listener(new MessageEvent('message', { data }))
  }
}

describe('attachWorkerRequestHandler', () => {
  it('does not publish a result after a request is cancelled', async () => {
    const scope = new FakeScope()
    let finish!: () => void
    const handler = vi.fn(
      (_payload: string, context: { signal: AbortSignal }) =>
        new Promise<string>((resolve) => {
          finish = () => resolve(context.signal.aborted ? 'cancelled' : 'completed')
        }),
    )
    const dispose = attachWorkerRequestHandler(scope, handler)

    scope.emit({ type: 'request', requestId: 'request-1', payload: 'input' })
    scope.emit({ type: 'cancel', requestId: 'request-1' })
    finish()
    await Promise.resolve()

    expect(scope.posted).toEqual([])
    dispose()
  })
})

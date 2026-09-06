import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWorkerShutdown } from './lifecycle.js'

const servers: Server[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
  )
})

function listeningServer(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer()
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function settleMacrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('createWorkerShutdown', () => {
  it('waits for lanes and the server before exiting with the requested code', async () => {
    const server = await listeningServer()
    let resolveLanes!: () => void
    const lanesSettled = new Promise<void>((resolve) => {
      resolveLanes = resolve
    })
    const exit = vi.fn()
    const shutdown = createWorkerShutdown({
      server,
      stopLanes: () => {},
      lanesSettled: () => lanesSettled,
      exit,
    })

    shutdown('test lane death', 1)
    await settleMacrotasks()
    expect(exit).not.toHaveBeenCalled()

    resolveLanes()
    await settleMacrotasks()
    await settleMacrotasks()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
    expect(server.listening).toBe(false)
  })

  it('is idempotent: repeated triggers stop lanes once and exit once', async () => {
    const server = await listeningServer()
    const stopLanes = vi.fn()
    const exit = vi.fn()
    const shutdown = createWorkerShutdown({
      server,
      stopLanes,
      lanesSettled: () => Promise.resolve(),
      exit,
    })

    shutdown('task lane died unexpectedly', 1)
    shutdown('index assistant lane died unexpectedly', 1)
    await settleMacrotasks()
    await settleMacrotasks()

    expect(stopLanes).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('force-exits within the bounded budget when a lane never settles', async () => {
    vi.useFakeTimers()
    const server = await listeningServer()
    const exit = vi.fn()
    const shutdown = createWorkerShutdown({
      server,
      stopLanes: () => {},
      lanesSettled: () => new Promise<void>(() => {}),
      forceExitMs: 15_000,
      exit,
    })

    shutdown('SIGTERM', 0)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })
})

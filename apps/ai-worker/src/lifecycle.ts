import type { Server } from 'node:http'

import { log } from './logger.js'

export interface WorkerShutdownOptions {
  readonly server: Server
  // Called exactly once per shutdown: abort lane controllers so background
  // loops stop claiming and finish their current unit of work.
  readonly stopLanes: () => void
  // Resolves when every background lane has settled. Must never reject.
  readonly lanesSettled: () => Promise<unknown>
  // Bounded budget before the process force-exits even if a lane hangs.
  readonly forceExitMs?: number
  // Injectable for tests; defaults to process.exit.
  readonly exit?: (code: number) => void
}

export type WorkerShutdown = (reason: string, exitCode: number) => void

// Creates the single, idempotent shutdown entry for the worker process.
// It stops accepting new work, waits a bounded time for lanes and the HTTP
// server to wind down, and then exits with the requested code. Whatever the
// database recorded before exit is whatever was actually acknowledged; a
// forced exit never fabricates completed state.
export function createWorkerShutdown(options: WorkerShutdownOptions): WorkerShutdown {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const forceExitMs = options.forceExitMs ?? 15_000
  let initiated = false
  return (reason, exitCode) => {
    if (initiated) return
    initiated = true
    log('info', 'worker_stopping', { reason })
    options.stopLanes()
    const serverClosed = new Promise<void>((resolve) => {
      options.server.closeIdleConnections()
      options.server.close(() => resolve())
    })
    const budget = setTimeout(() => {
      log('error', 'worker_shutdown_timeout', { reason })
      exit(exitCode)
    }, forceExitMs)
    void Promise.allSettled([options.lanesSettled(), serverClosed]).then(() => {
      clearTimeout(budget)
      log('info', 'worker_stopped', { reason, exitCode })
      exit(exitCode)
    })
  }
}

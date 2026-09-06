import { afterEach, describe, expect, it, vi } from 'vitest'

import { runTaskLoop, type TaskRunner } from './task-runner.js'
import { TaskClientError, type ClaimedTask, type TaskClient } from './task-client.js'

const claim = { task: { id: 'synthetic-task' } } as unknown as ClaimedTask

afterEach(() => {
  vi.useRealTimers()
})

describe('runTaskLoop lane survival', () => {
  it('keeps claiming after a transient API failure while reporting a task (T25)', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const claims: (ClaimedTask | null)[] = [claim, null]
    const client = {
      claim: vi.fn(async () => claims.shift() ?? null),
    } as unknown as TaskClient
    const runner = {
      run: vi.fn(async () => {
        throw new TaskClientError(503, 'API_REQUEST_FAILED')
      }),
    } as unknown as TaskRunner

    const loop = runTaskLoop(client, runner, controller.signal)
    const settled = loop.then(() => 'settled', () => 'failed')

    await vi.advanceTimersByTimeAsync(0)
    expect(client.claim).toHaveBeenCalledTimes(1)
    expect(runner.run).toHaveBeenCalledTimes(1)

    // Bounded single wait, then the lane claims again instead of dying.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.claim).toHaveBeenCalledTimes(2)

    controller.abort()
    expect(await settled).toBe('settled')
  })

  it('surfaces an unexpected runner defect so the process can exit (T25)', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const client = {
      claim: vi.fn(async () => claim),
    } as unknown as TaskClient
    const runner = {
      run: vi.fn(async () => {
        throw new TypeError('synthetic runner defect')
      }),
    } as unknown as TaskRunner

    const loop = runTaskLoop(client, runner, controller.signal)
    const rejection = expect(loop).rejects.toThrow(TypeError)

    await vi.advanceTimersByTimeAsync(0)
    await rejection
    expect(client.claim).toHaveBeenCalledTimes(1)
  })
})

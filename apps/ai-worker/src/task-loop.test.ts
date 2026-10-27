import { afterEach, describe, expect, it, vi } from 'vitest'

import { log } from './logger.js'
import { runTaskLoop, type TaskRunner } from './task-runner.js'
import { TaskClientError, type ClaimedTask, type TaskClient } from './task-client.js'

vi.mock('./logger.js', () => ({ log: vi.fn() }))

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

describe('runTaskLoop claim failure classification', () => {
  afterEach(() => {
    vi.mocked(log).mockClear()
  })

  it('retries transient claim failures with throttled logs and recovers', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let claimCalls = 0
    const client = {
      claim: vi.fn(async () => {
        claimCalls += 1
        if (claimCalls === 1) throw new TaskClientError(0, 'API_UNAVAILABLE')
        if (claimCalls === 2) throw new TaskClientError(429, 'API_RATE_LIMITED')
        if (claimCalls === 3) throw new TaskClientError(503, 'API_REQUEST_FAILED')
        return null
      }),
    } as unknown as TaskClient
    const runner = { run: vi.fn() } as unknown as TaskRunner

    const loop = runTaskLoop(client, runner, controller.signal)
    const settled = loop.then(() => 'settled', () => 'failed')

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    // 三次瞬时失败（网络、429、5xx）后恢复安静轮询。
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.claim).toHaveBeenCalledTimes(4)
    expect(runner.run).not.toHaveBeenCalled()
    const claimRetries = vi.mocked(log).mock.calls.filter(([, event]) => event === 'task_claim_retrying')
    expect(claimRetries).toHaveLength(1)
    expect(claimRetries[0]![2]).toMatchObject({ status: 0, consecutiveFailures: 1 })

    controller.abort()
    expect(await settled).toBe('settled')
  })

  it('re-logs a persistently failing claim every 30 consecutive attempts', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const client = {
      claim: vi.fn(async () => {
        throw new TaskClientError(503, 'API_REQUEST_FAILED')
      }),
    } as unknown as TaskClient
    const runner = { run: vi.fn() } as unknown as TaskRunner

    const loop = runTaskLoop(client, runner, controller.signal)
    const settled = loop.then(() => 'settled', () => 'failed')
    for (let attempt = 0; attempt < 30; attempt++) {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    const claimRetries = vi.mocked(log).mock.calls.filter(([, event]) => event === 'task_claim_retrying')
    expect(claimRetries).toHaveLength(2)
    expect(claimRetries[1]![2]).toMatchObject({ consecutiveFailures: 30 })

    controller.abort()
    expect(await settled).toBe('settled')
  })

  it('treats 401 claim failures as fatal so the lane failure handler can exit the process', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const client = {
      claim: vi.fn(async () => {
        throw new TaskClientError(401, 'AUTH_REQUIRED')
      }),
    } as unknown as TaskClient
    const runner = { run: vi.fn() } as unknown as TaskRunner

    const loop = runTaskLoop(client, runner, controller.signal)
    const outcome = loop.then(() => 'settled', (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)

    const error = await outcome as TaskClientError
    expect(error).toBeInstanceOf(TaskClientError)
    expect(error.status).toBe(401)
    expect(client.claim).toHaveBeenCalledTimes(1)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('treats unknown claim defects as fatal, not as an empty queue', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const client = {
      claim: vi.fn(async () => {
        throw new TypeError('synthetic claim defect')
      }),
    } as unknown as TaskClient
    const runner = { run: vi.fn() } as unknown as TaskRunner

    const loop = runTaskLoop(client, runner, controller.signal)
    const outcome = loop.then(() => 'settled', (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)

    expect(await outcome).toBeInstanceOf(TypeError)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EventFlusher } from './runner.js'
import type { AssistantEvent } from './client.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('EventFlusher', () => {
  it('keeps tiny deltas within the Go API limit of 50 events per batch', async () => {
    vi.useFakeTimers()
    const batches: (readonly AssistantEvent[])[] = []
    const flusher = new EventFlusher(async (events) => { batches.push(events) })
    for (let i = 0; i < 121; i++) await flusher.push('answer.delta', { delta: '字' })
    await flusher.drain()
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 21])
    expect(batches.flat().map((event) => event.payload['delta']).join('')).toBe('字'.repeat(121))
  })

  it('waits for a timer-started submission before final drain resolves', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const submitted = new Promise<void>((resolve) => {
      release = resolve
    })
    const flusher = new EventFlusher(async () => submitted)

    await flusher.push('answer.delta', { delta: 'a' })
    await vi.advanceTimersByTimeAsync(150)

    let settled = false
    const draining = flusher.drain().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()
    await draining
    expect(settled).toBe(true)
  })

  it('surfaces a timer-started submission failure on final drain', async () => {
    vi.useFakeTimers()
    const flusher = new EventFlusher(async () => {
      throw new Error('submit failed')
    })

    await flusher.push('answer.delta', { delta: 'a' })
    await vi.advanceTimersByTimeAsync(150)

    await expect(flusher.drain()).rejects.toThrow('submit failed')
  })
})

import { describe, expect, it, vi } from 'vitest'

import { REGEX_MATCH_DISPLAY_LIMIT, type RegexRunRequest, type RegexWorkerResponse } from './contracts'
import { executeRegex } from './engine'
import { RegexRunner } from './regexRunner'

describe('JavaScript RegExp engine', () => {
  it('returns global ranges, capture groups, named groups, and replacement preview', () => {
    const result = executeRegex('(?<level>error|warning):\\s+(.+)', 'gmi', 'error: One\nWARNING: Two', '[$<level>] $2')
    expect(result.matches).toEqual([
      expect.objectContaining({ number: 1, start: 0, end: 10, value: 'error: One', groups: ['error', 'One'], namedGroups: { level: 'error' } }),
      expect.objectContaining({ number: 2, start: 11, end: 23, value: 'WARNING: Two', groups: ['WARNING', 'Two'], namedGroups: { level: 'WARNING' } }),
    ])
    expect(result.replacementPreview).toBe('[error] One\n[WARNING] Two')
    expect(result.matchLimitReached).toBe(false)
  })

  it('advances zero-length Unicode global matches without looping', () => {
    const result = executeRegex('(?=.)', 'gu', '🙂a', '')
    expect(result.matches.map((match) => match.start)).toEqual([0, 2])
  })

  it('does not interpret a replacement as callback source', () => {
    const result = executeRegex('x', 'g', 'xx', '() => globalThis.compromised = true')
    expect(result.replacementPreview).toBe('() => globalThis.compromised = true() => globalThis.compromised = true')
    expect((globalThis as typeof globalThis & { compromised?: boolean }).compromised).toBeUndefined()
  })

  it('stops at the 501st zero-width match and omits the full replacement preview', () => {
    const result = executeRegex('(?=.)', 'gu', 'a'.repeat(1024 * 1024), 'x')

    expect(result.matches).toHaveLength(REGEX_MATCH_DISPLAY_LIMIT)
    expect(result.matches.at(-1)).toMatchObject({ number: REGEX_MATCH_DISPLAY_LIMIT, start: REGEX_MATCH_DISPLAY_LIMIT - 1 })
    expect(result.matchLimitReached).toBe(true)
    expect(result.replacementPreview).toBeNull()
  })
})

class FakeWorker {
  onmessage: ((event: MessageEvent<RegexWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request?: RegexRunRequest
  terminated = false
  postMessage(message: RegexRunRequest) { this.request = message }
  terminate() { this.terminated = true }
  emit(message: RegexWorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<RegexWorkerResponse>) }
}

describe('RegexRunner timeout, cancellation, and late results', () => {
  it('terminates the one-shot worker after 500 ms', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const runner = new RegexRunner(() => worker, 500)
    const promise = runner.run({ pattern: '(a+)+$', flags: '', text: 'a'.repeat(1000), replacement: '' })
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(500)
    await assertion
    expect(worker.terminated).toBe(true)
    vi.useRealTimers()
  })

  it('cancels an obsolete run and drops its late result', async () => {
    const workers: FakeWorker[] = []
    const runner = new RegexRunner(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })
    const obsolete = runner.run({ pattern: 'old', flags: '', text: 'old', replacement: '' })
    const obsoleteAssertion = expect(obsolete).rejects.toMatchObject({ name: 'AbortError' })
    const latest = runner.run({ pattern: 'new', flags: '', text: 'new', replacement: '' })
    workers[0]?.emit({ id: workers[0].request!.id, type: 'result', result: { matches: [], matchLimitReached: false, replacementPreview: 'obsolete' } })
    workers[1]?.emit({ id: workers[1].request!.id, type: 'result', result: { matches: [], matchLimitReached: false, replacementPreview: 'latest' } })
    await obsoleteAssertion
    await expect(latest).resolves.toMatchObject({ replacementPreview: 'latest' })
    expect(workers[0]?.terminated).toBe(true)
  })
})

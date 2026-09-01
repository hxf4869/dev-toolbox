import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DigestToolView from '../digest/DigestToolView.vue'
import type { DigestWorkerRequest, DigestWorkerResponse } from '../digest/contracts'
import RegexToolView from '../regex/RegexToolView.vue'
import type { RegexRunRequest, RegexWorkerResponse } from '../regex/contracts'
import TimeToolView from './TimeToolView.vue'

class ImmediateWorker {
  onmessage: ((event: MessageEvent<DigestWorkerResponse | RegexWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(message: DigestWorkerRequest | RegexRunRequest) {
    queueMicrotask(() => {
      if ('kind' in message) {
        this.onmessage?.({ data: { id: message.id, type: 'result', digest: 'a'.repeat(64), totalBytes: 3 } } as unknown as MessageEvent<DigestWorkerResponse>)
      } else {
        this.onmessage?.({ data: { id: message.id, type: 'result', result: { matches: [], matchLimitReached: false, replacementPreview: message.text } } } as unknown as MessageEvent<RegexWorkerResponse>)
      }
    })
  }
  terminate() {}
}

describe('deterministic compute tool privacy', () => {
  const fetchMock = vi.fn()
  let localSet: ReturnType<typeof vi.spyOn>
  let sessionSet: ReturnType<typeof vi.spyOn>
  let indexedDBOpen: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('Worker', ImmediateWorker)
    localSet = vi.spyOn(window.localStorage, 'setItem')
    sessionSet = vi.spyOn(window.sessionStorage, 'setItem')
    indexedDBOpen = window.indexedDB ? vi.spyOn(window.indexedDB, 'open') : undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('runs time, digest, and regex interactions without business API or browser storage writes', async () => {
    const time = mount(TimeToolView)
    expect(time.findAll('.tool-tabs button').map((button) => button.text())).toEqual(['时间转换', '日期计算', '工作日', 'Cron', '自然语言'])
    await time.get('button.button--primary').trigger('click')
    await flushPromises()
    expect(time.text()).toContain('Unix 秒')
    time.unmount()

    const digest = mount(DigestToolView)
    await digest.get('textarea#digest-text').setValue('abc')
    await digest.get('button.button--primary').trigger('click')
    await flushPromises()
    expect(digest.text()).toContain('aaaaaaaa')
    digest.unmount()

    const regex = mount(RegexToolView)
    await regex.get('button.button--primary').trigger('click')
    await flushPromises()
    expect(regex.text()).toContain('共 0 个匹配')
    regex.unmount()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(localSet).not.toHaveBeenCalled()
    expect(sessionSet).not.toHaveBeenCalled()
    if (indexedDBOpen) expect(indexedDBOpen).not.toHaveBeenCalled()
    const localValues = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.getItem(window.localStorage.key(index) ?? '')).join(' ')
    const sessionValues = Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.getItem(window.sessionStorage.key(index) ?? '')).join(' ')
    expect(localValues).not.toContain('connection failed')
    expect(localValues).not.toContain('abc')
    expect(sessionValues).not.toContain('connection failed')
    expect(sessionValues).not.toContain('abc')
  })
})

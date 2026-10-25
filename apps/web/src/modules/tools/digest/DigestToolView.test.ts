import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DigestWorkerRequest, DigestWorkerResponse } from './contracts'

import DigestToolView from './DigestToolView.vue'

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const SHA256_ABCD = '88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589'

const workers: FakeWorker[] = []

class FakeWorker {
  onmessage: ((event: MessageEvent<DigestWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request?: DigestWorkerRequest
  terminated = false
  constructor() { workers.push(this) }
  postMessage(message: DigestWorkerRequest) { this.request = message }
  terminate() { this.terminated = true }
  emit(message: DigestWorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<DigestWorkerResponse>) }
}

beforeEach(() => {
  workers.length = 0
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DigestToolView text input invalidation', () => {
  it('invalidates the stale digest, comparison conclusion and copy button once the text changes', async () => {
    const wrapper = mount(DigestToolView)
    await wrapper.get('#digest-text').setValue('abc')
    await runButton(wrapper).trigger('click')
    const worker = lastWorker()
    expect(worker.request).toMatchObject({ kind: 'text', text: 'abc', algorithm: 'sha256' })
    emitResult(worker, SHA256_ABC, 3)
    await flushPromises()

    expect(wrapper.text()).toContain(SHA256_ABC)
    expect(wrapper.text()).toContain('SHA-256 · 3 B')

    await wrapper.get('#expected-digest').setValue(SHA256_ABC)
    expect(wrapper.text()).toContain('校验值相同')

    await wrapper.get('#digest-text').setValue('abcd')

    expect(wrapper.text()).toContain('执行后在此显示')
    expect(wrapper.text()).not.toContain(SHA256_ABC)
    expect(wrapper.text()).not.toContain('校验值相同')
    expect(copyButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('shows the new digest and byte label only after an explicit rerun', async () => {
    const wrapper = mount(DigestToolView)
    await wrapper.get('#digest-text').setValue('abc')
    await runButton(wrapper).trigger('click')
    emitResult(lastWorker(), SHA256_ABC, 3)
    await flushPromises()
    await wrapper.get('#expected-digest').setValue(SHA256_ABC)
    expect(wrapper.text()).toContain('校验值相同')

    await wrapper.get('#digest-text').setValue('abcd')
    await runButton(wrapper).trigger('click')
    const worker = lastWorker()
    expect(worker.request).toMatchObject({ kind: 'text', text: 'abcd', algorithm: 'sha256' })
    emitResult(worker, SHA256_ABCD, 4)
    await flushPromises()

    expect(wrapper.text()).toContain(SHA256_ABCD)
    expect(wrapper.text()).toContain('SHA-256 · 4 B')
    expect(wrapper.text()).not.toContain('3 B')
    expect(wrapper.text()).not.toContain('校验值相同')

    await wrapper.get('#expected-digest').setValue(SHA256_ABCD)
    expect(wrapper.text()).toContain('校验值相同')
    wrapper.unmount()
  })
})

describe('DigestToolView existing reset contracts', () => {
  it('invalidates the text result when switching the mode radio to single file', async () => {
    const wrapper = mount(DigestToolView)
    await computeText(wrapper, 'abc', SHA256_ABC, 3)
    expect(wrapper.text()).toContain(SHA256_ABC)

    await checkFileMode(wrapper)

    expect(wrapper.text()).toContain('执行后在此显示')
    expect(wrapper.text()).not.toContain(SHA256_ABC)
    expect(copyButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('invalidates the text result when the algorithm select changes', async () => {
    const wrapper = mount(DigestToolView)
    await computeText(wrapper, 'abc', SHA256_ABC, 3)
    expect(wrapper.text()).toContain(SHA256_ABC)

    await wrapper.get('#digest-algorithm').setValue('sha512')

    expect(wrapper.text()).toContain('执行后在此显示')
    expect(wrapper.text()).not.toContain(SHA256_ABC)
    expect(copyButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('invalidates the file result when the selected file changes', async () => {
    const wrapper = mount(DigestToolView)
    await checkFileMode(wrapper)
    await pickFile(wrapper, new File(['abc'], 'a.txt', { type: 'text/plain' }))
    await runButton(wrapper).trigger('click')
    const worker = lastWorker()
    expect(worker.request).toMatchObject({ kind: 'file', algorithm: 'sha256' })
    emitResult(worker, SHA256_ABC, 3)
    await flushPromises()
    expect(wrapper.text()).toContain(SHA256_ABC)

    await pickFile(wrapper, new File(['abcd'], 'b.txt', { type: 'text/plain' }))

    expect(wrapper.text()).toContain('执行后在此显示')
    expect(wrapper.text()).not.toContain(SHA256_ABC)
    expect(wrapper.text()).toContain('b.txt')
    expect(copyButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('ignores a late worker result after canceling a running computation', async () => {
    const wrapper = mount(DigestToolView)
    await wrapper.get('#digest-text').setValue('abc')
    await runButton(wrapper).trigger('click')
    const worker = lastWorker()

    await wrapper.findAll('button').find((button) => button.text() === '取消计算')!.trigger('click')
    await flushPromises()

    expect(worker.terminated).toBe(true)
    expect(wrapper.text()).toContain('计算已取消，晚到的 Worker 结果不会覆盖当前页面。')
    worker.emit({ id: worker.request!.id, type: 'result', digest: SHA256_ABC, totalBytes: 3 })
    await flushPromises()

    expect(wrapper.text()).not.toContain(SHA256_ABC)
    expect(wrapper.text()).toContain('执行后在此显示')
    wrapper.unmount()
  })

  it('shows the empty state with the local privacy hint before any run', async () => {
    const wrapper = mount(DigestToolView)
    await flushPromises()

    expect(wrapper.text()).toContain('执行后在此显示')
    expect(wrapper.text()).toContain('结果只保留在当前页面内存中')
    expect(copyButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

describe('DigestToolView copy failure recovery', () => {
  it('shows the manual-copy recovery hint when the browser rejects copying and recovers on a successful retry', async () => {
    const handlerErrors: unknown[] = []
    const wrapper = mount(DigestToolView, { global: { config: { errorHandler: (error: unknown) => { handlerErrors.push(error) } } } })
    await computeText(wrapper, 'abc', SHA256_ABC, 3)
    const writeText = vi.fn().mockRejectedValue(new DOMException('Clipboard write was blocked', 'NotAllowedError'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await copyButton(wrapper).trigger('click')
    await flushPromises()

    expect(handlerErrors).toEqual([])
    expect(wrapper.get('[role="alert"]').text()).toContain('复制未成功，请选中结果后手动复制。')
    expect(wrapper.text()).toContain(SHA256_ABC)
    expect(wrapper.get('.sr-only').text()).not.toContain('摘要已复制')
    expect(copyButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(writeText).toHaveBeenCalledTimes(1)

    writeText.mockResolvedValue(undefined)
    await copyButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('.sr-only').text()).toContain('摘要已复制')
    expect(handlerErrors).toEqual([])
    expect(writeText).toHaveBeenNthCalledWith(2, SHA256_ABC)
    wrapper.unmount()
  })
})

function lastWorker(): FakeWorker {
  return workers.at(-1)!
}

function runButton(wrapper: VueWrapper) {
  return wrapper.findAll('button').find((button) => button.text() === '计算摘要')!
}

function copyButton(wrapper: VueWrapper) {
  return wrapper.findAll('button').find((button) => button.text() === '复制摘要')!
}

function emitResult(worker: FakeWorker, digest: string, totalBytes: number) {
  worker.emit({ id: worker.request!.id, type: 'result', digest, totalBytes })
}

async function computeText(wrapper: VueWrapper, text: string, digest: string, totalBytes: number) {
  await wrapper.get('#digest-text').setValue(text)
  await runButton(wrapper).trigger('click')
  emitResult(lastWorker(), digest, totalBytes)
  await flushPromises()
}

async function checkFileMode(wrapper: VueWrapper) {
  const radio = wrapper.findAll('input[type="radio"]').find((input) => (input.element as HTMLInputElement).value === 'file')!
  ;(radio.element as HTMLInputElement).checked = true
  await radio.trigger('change')
}

async function pickFile(wrapper: VueWrapper, file: File) {
  const input = wrapper.get('#digest-file')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
}

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DigestWorkerRequest, DigestWorkerResponse } from './contracts'

import DigestToolView from './DigestToolView.vue'

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

const workers: FakeWorker[] = []
const mounted: VueWrapper[] = []

// 不自动回包的 Worker 替身：由用例决定何时完成、失败或被终止，保留真实 Worker 的 running 窗口。
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
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

// 键盘 Enter 在原生 button 上最终派发 click，而 jsdom 不会从 keydown 合成 click，
// 因此用例先聚焦按钮再直接派发 click；组件必须挂到真实 document 才能观察 activeElement。
describe('DigestToolView keeps keyboard focus on the compute/cancel button', () => {
  it('keeps the same focused button through a completed run and unlocks the inputs', async () => {
    const wrapper = mountAttached()
    await wrapper.get('#digest-text').setValue('abc')
    const button = actionButton(wrapper).element
    button.focus()
    expect(document.activeElement).toBe(button)

    await actionButton(wrapper).trigger('click')

    expect(actionButton(wrapper).element).toBe(button)
    expect(actionButton(wrapper).text()).toBe('取消计算')
    expect(document.activeElement).toBe(button)
    expect(textInput(wrapper).disabled).toBe(true)

    emitResult(lastWorker(), SHA256_ABC, 3)
    await flushPromises()

    expect(wrapper.text()).toContain(SHA256_ABC)
    expect(actionButton(wrapper).element).toBe(button)
    expect(actionButton(wrapper).text()).toBe('计算摘要')
    expect(document.activeElement).toBe(button)
    expect(textInput(wrapper).disabled).toBe(false)
  })

  it('keeps the same focused button and unlocks the inputs after the worker reports a failure', async () => {
    const handlerErrors: unknown[] = []
    const wrapper = mountAttached((error: unknown) => { handlerErrors.push(error) })
    await wrapper.get('#digest-text').setValue('abc')
    const button = actionButton(wrapper).element
    button.focus()
    await actionButton(wrapper).trigger('click')
    const worker = lastWorker()
    expect(document.activeElement).toBe(button)

    worker.emit({ id: worker.request!.id, type: 'error', message: '摘要 Worker 内部失败' })
    await flushPromises()

    expect(handlerErrors).toEqual([])
    expect(wrapper.get('[role="alert"]').text()).toBe('摘要 Worker 内部失败')
    expect(wrapper.text()).toContain('执行后在此显示')
    expect(actionButton(wrapper).element).toBe(button)
    expect(actionButton(wrapper).text()).toBe('计算摘要')
    expect(document.activeElement).toBe(button)
    expect(textInput(wrapper).disabled).toBe(false)
  })

  it('lets the same focused button cancel the run and keeps focus beside the cancel notice', async () => {
    const wrapper = mountAttached()
    await wrapper.get('#digest-text').setValue('abc')
    const button = actionButton(wrapper).element
    button.focus()
    await actionButton(wrapper).trigger('click')
    const worker = lastWorker()
    expect(actionButton(wrapper).element).toBe(button)
    expect(actionButton(wrapper).text()).toBe('取消计算')
    expect(document.activeElement).toBe(button)

    await actionButton(wrapper).trigger('click')
    await flushPromises()

    expect(worker.terminated).toBe(true)
    expect(wrapper.text()).toContain('计算已取消，晚到的 Worker 结果不会覆盖当前页面。')
    expect(wrapper.text()).toContain('执行后在此显示')
    expect(actionButton(wrapper).element).toBe(button)
    expect(actionButton(wrapper).text()).toBe('计算摘要')
    expect(document.activeElement).toBe(button)
    expect(textInput(wrapper).disabled).toBe(false)
  })

  it('does not pull focus back when the user moved it elsewhere during the run', async () => {
    const elsewhere = document.createElement('button')
    elsewhere.textContent = '页面其他控件'
    document.body.append(elsewhere)
    const wrapper = mountAttached()
    await wrapper.get('#digest-text').setValue('abc')
    actionButton(wrapper).element.focus()
    await actionButton(wrapper).trigger('click')

    elsewhere.focus()
    expect(document.activeElement).toBe(elsewhere)

    emitResult(lastWorker(), SHA256_ABC, 3)
    await flushPromises()

    expect(wrapper.text()).toContain(SHA256_ABC)
    expect(actionButton(wrapper).text()).toBe('计算摘要')
    expect(textInput(wrapper).disabled).toBe(false)
    expect(document.activeElement).toBe(elsewhere)
  })
})

function mountAttached(errorHandler?: (error: unknown) => void) {
  const wrapper = mount(DigestToolView, { attachTo: document.body, global: { config: { errorHandler } } })
  mounted.push(wrapper)
  return wrapper
}

function lastWorker(): FakeWorker {
  return workers.at(-1)!
}

function actionButton(wrapper: VueWrapper) {
  return wrapper.get<HTMLButtonElement>('.primary-actions button')
}

function textInput(wrapper: VueWrapper) {
  return wrapper.get<HTMLTextAreaElement>('#digest-text').element
}

function emitResult(worker: FakeWorker, digest: string, totalBytes: number) {
  worker.emit({ id: worker.request!.id, type: 'result', digest, totalBytes })
}

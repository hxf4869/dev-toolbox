import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import YamlView from './YamlView.vue'

const editorDrivers = vi.hoisted(() => [] as Array<{ getValue: () => string; typeInto(next: string): void }>)

vi.mock('../shared/editor', () => ({
  createAdaptiveEditor(options: { value?: string; onChange?: (value: string) => void }) {
    let value = options.value ?? ''
    const driver = {
      kind: 'codemirror',
      ready: Promise.resolve(),
      getValue: () => value,
      setValue: (next: string) => { value = next },
      setLanguage: vi.fn(async () => {}),
      setAriaLabel: vi.fn(),
      setReadOnly: vi.fn(),
      refresh: vi.fn(async () => {}),
      dispose: vi.fn(),
      typeInto(next: string) {
        value = next
        options.onChange?.(next)
      },
    }
    editorDrivers.push(driver)
    return driver
  },
}))

describe('YAML workbench stale result guard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('hides the apply action and the stale status after the input is edited', async () => {
    editorDrivers.length = 0
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountView()

    await button(wrapper, '格式化并校验').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    worker.emitResult(request.requestId, { operation: 'format', output: 'name: old\nvalue: 1\n', documentCount: 1 })
    await flushPromises()
    expect(button(wrapper, '应用格式化')).toBeTruthy()

    editorDrivers[0]!.typeInto('name: new\nvalue: 999\nkeep: 新增内容\n')
    await flushPromises()

    expect(findButton(wrapper, '应用格式化')).toBeUndefined()
    expect(editorDrivers[0]!.getValue()).toBe('name: new\nvalue: 999\nkeep: 新增内容\n')
    expect(wrapper.text()).not.toContain('已校验')
    wrapper.unmount()
  })

  it('cancels the pending request on edit and drops its late result without polluting state', async () => {
    editorDrivers.length = 0
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountView()

    await button(wrapper, '格式化并校验').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    expect(button(wrapper, '取消')).toBeTruthy()

    editorDrivers[0]!.typeInto('name: new\nvalue: 999\n')
    await flushPromises()

    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: request.requestId })
    expect(findButton(wrapper, '取消')).toBeUndefined()

    worker.emitResult(request.requestId, { operation: 'format', output: 'name: old\nvalue: 1\n', documentCount: 1 })
    await flushPromises()

    expect(findButton(wrapper, '应用格式化')).toBeUndefined()
    expect(wrapper.find('.message.error').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('已校验')
    wrapper.unmount()
  })

  it('clears a stale error message after the input is edited', async () => {
    editorDrivers.length = 0
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountView()

    await button(wrapper, '格式化并校验').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    worker.emitError(request.requestId, '第 2 行存在重复的键')
    await flushPromises()
    expect(wrapper.find('.message.error').text()).toContain('重复的键')

    editorDrivers[0]!.typeInto('name: fixed\n')
    await flushPromises()

    expect(wrapper.find('.message.error').exists()).toBe(false)
    wrapper.unmount()
  })

  it('applies the formatted output when the input is unchanged', async () => {
    editorDrivers.length = 0
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountView()

    await button(wrapper, '格式化并校验').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    worker.emitResult(request.requestId, { operation: 'format', output: 'name: old\nvalue: 1\n', documentCount: 1 })
    await flushPromises()

    await button(wrapper, '应用格式化').trigger('click')
    await flushPromises()

    expect(editorDrivers[0]!.getValue()).toBe('name: old\nvalue: 1\n')
    expect(wrapper.text()).toContain('格式化结果已应用到输入。')

    await button(wrapper, '格式化并校验').trigger('click')
    const rerun = worker.messages.filter((message) => message.type === 'request')[1]!
    await button(wrapper, '应用格式化').trigger('click')
    await flushPromises()

    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: rerun.requestId })
    worker.emitResult(rerun.requestId, { operation: 'format', output: 'stale: late\n', documentCount: 1 })
    await flushPromises()

    expect(editorDrivers[0]!.getValue()).toBe('name: old\nvalue: 1\n')
    expect(editorDrivers[1]!.getValue()).toBe('name: old\nvalue: 1\n')
    expect(wrapper.text()).toContain('格式化结果已应用到输入。')
    expect(wrapper.text()).not.toContain('已校验')
    expect(wrapper.find('.message.error').exists()).toBe(false)
    wrapper.unmount()
  })
})

class DelayedWorker {
  static instances: DelayedWorker[] = []
  readonly messages: Array<{ type: string; requestId: string }> = []
  readonly listeners = new Map<string, Set<(event: MessageEvent<unknown>) => void>>()
  terminated = false

  constructor() {
    DelayedWorker.instances.push(this)
  }

  static reset() {
    DelayedWorker.instances = []
  }

  postMessage(message: { type: string; requestId: string }) {
    this.messages.push(message)
  }

  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
    let group = this.listeners.get(type)
    if (!group) {
      group = new Set<(event: MessageEvent<unknown>) => void>()
      this.listeners.set(type, group)
    }
    group.add(listener)
  }

  removeEventListener() {
    // Deliberately keep the listener to simulate a result already queued by the browser.
  }

  terminate() {
    this.terminated = true
  }

  emitResult(requestId: string, result: unknown) {
    this.emit({ type: 'result', requestId, result })
  }

  emitError(requestId: string, message: string) {
    this.emit({ type: 'error', requestId, error: { code: 'yaml_invalid', message } })
  }

  private emit(data: { type: string; requestId: string; [key: string]: unknown }) {
    const event = new MessageEvent('message', { data })
    for (const listener of this.listeners.get('message') ?? []) listener(event)
  }
}

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tools', component: { template: '<div />' } },
      { path: '/tools/yaml', component: { template: '<div />' } },
    ],
  })
  await router.push('/tools/yaml')
  await router.isReady()
  const wrapper = mount(YamlView, { attachTo: document.body, global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

function findButton(wrapper: VueWrapper, label: string) {
  return wrapper.findAll('button').find((entry) => entry.text().trim() === label)
}

function button(wrapper: VueWrapper, label: string) {
  const target = findButton(wrapper, label)
  if (!target) throw new Error(`button not found: ${label}`)
  return target
}

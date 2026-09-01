import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import YamlView from './YamlView.vue'

const editorDrivers = vi.hoisted(() => [] as Array<{ setAriaLabel: ReturnType<typeof vi.fn> }>)

vi.mock('../shared/editor', () => ({
  createAdaptiveEditor(options: { value?: string }) {
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
    }
    editorDrivers.push(driver)
    return driver
  },
}))

describe('YAML workbench request lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('cancels the current Worker request on mode change and drops a late result', async () => {
    editorDrivers.length = 0
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
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

    await button(wrapper, '格式化并校验').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    await button(wrapper, 'YAML→JSON').trigger('click')
    await flushPromises()

    expect(editorDrivers[0]?.setAriaLabel).toHaveBeenCalledWith('YAML 输入编辑器')
    expect(editorDrivers[1]?.setAriaLabel).toHaveBeenCalledWith('JSON 结果编辑器')
    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: request.requestId })
    expect(worker.terminated).toBe(true)
    worker.emit(request.requestId, { operation: 'format', output: 'late: true\n', documentCount: 1 })
    await flushPromises()
    expect(button(wrapper, '复制').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

class DelayedWorker {
  static instances: DelayedWorker[] = []
  readonly messages: Array<{ type: string; requestId: string }> = []
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()
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

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.add(listener)
  }

  removeEventListener() {
    // Deliberately keep the listener to simulate a result already queued by the browser.
  }

  terminate() {
    this.terminated = true
  }

  emit(requestId: string, result: unknown) {
    const event = new MessageEvent('message', { data: { type: 'result', requestId, result } })
    for (const listener of this.listeners) listener(event)
  }
}

function button(wrapper: VueWrapper, label: string) {
  const target = wrapper.findAll('button').find((entry) => entry.text().trim() === label)
  if (!target) throw new Error(`button not found: ${label}`)
  return target
}

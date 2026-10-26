import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import YamlView from './YamlView.vue'

vi.mock('../shared/editor', () => ({
  createAdaptiveEditor(options: { value?: string }) {
    let value = options.value ?? ''
    return {
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
  },
}))

// 运行入口与取消入口必须是同一个聚焦控件；组件必须挂到真实 document 才能观察 activeElement。
// Worker 替身不自动回包，由用例决定何时完成、失败或被取消，保留真实的 running 窗口。
describe('YAML workbench keeps keyboard focus on the run/cancel button', () => {
  const mounted: VueWrapper[] = []

  beforeEach(() => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
  })

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('turns the focused run button into an enabled cancel while the Worker is waiting', async () => {
    const wrapper = await mountView(mounted)
    const element = actionButton(wrapper).element
    element.focus()
    expect(document.activeElement).toBe(element)

    await actionButton(wrapper).trigger('click')

    expect(actionButton(wrapper).element).toBe(element)
    expect(actionButton(wrapper).text()).toBe('取消')
    expect(actionButton(wrapper).element.disabled).toBe(false)
    expect(document.activeElement).toBe(element)
  })

  it('restores the action label and focus on the same control after completion and after failure', async () => {
    const wrapper = await mountView(mounted)
    const element = actionButton(wrapper).element
    element.focus()

    await actionButton(wrapper).trigger('click')
    const worker = DelayedWorker.instances[0]!
    const first = worker.messages.find((message) => message.type === 'request')!
    worker.emitResult(first.requestId, { operation: 'format', output: 'name: old\nvalue: 1\n', documentCount: 1 })
    await flushPromises()

    expect(wrapper.text()).toContain('已校验 1 个 YAML 1.2 文档')
    expect(actionButton(wrapper).element).toBe(element)
    expect(actionButton(wrapper).text()).toBe('格式化并校验')
    expect(document.activeElement).toBe(element)

    await actionButton(wrapper).trigger('click')
    const second = worker.messages.filter((message) => message.type === 'request')[1]!
    worker.emitError(second.requestId, '第 2 行存在重复的键')
    await flushPromises()

    expect(wrapper.get('.message.error').text()).toContain('重复的键')
    expect(actionButton(wrapper).element).toBe(element)
    expect(actionButton(wrapper).text()).toBe('格式化并校验')
    expect(document.activeElement).toBe(element)
  })

  it('cancels the waiting request by clicking the same control and keeps focus', async () => {
    const wrapper = await mountView(mounted)
    const element = actionButton(wrapper).element
    element.focus()
    await actionButton(wrapper).trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    expect(actionButton(wrapper).text()).toBe('取消')

    await actionButton(wrapper).trigger('click')
    await flushPromises()

    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: request.requestId })
    expect(worker.messages.filter((message) => message.type === 'request')).toHaveLength(1)
    expect(worker.terminated).toBe(true)
    expect(wrapper.find('.message.error').exists()).toBe(false)
    expect(actionButton(wrapper).element).toBe(element)
    expect(actionButton(wrapper).text()).toBe('格式化并校验')
    expect(document.activeElement).toBe(element)
  })

  it('does not pull focus back when the user moved elsewhere during the run', async () => {
    const elsewhere = document.createElement('button')
    elsewhere.textContent = '页面其他控件'
    document.body.append(elsewhere)
    const wrapper = await mountView(mounted)
    actionButton(wrapper).element.focus()
    await actionButton(wrapper).trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!

    elsewhere.focus()
    expect(document.activeElement).toBe(elsewhere)

    worker.emitResult(request.requestId, { operation: 'format', output: 'name: done\n', documentCount: 1 })
    await flushPromises()

    expect(wrapper.text()).toContain('已校验 1 个 YAML 1.2 文档')
    expect(actionButton(wrapper).text()).toBe('格式化并校验')
    expect(document.activeElement).toBe(elsewhere)
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

async function mountView(mounted: VueWrapper[]) {
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
  mounted.push(wrapper)
  return wrapper
}

function actionButton(wrapper: VueWrapper) {
  return wrapper.get<HTMLButtonElement>('#yaml-actions button')
}

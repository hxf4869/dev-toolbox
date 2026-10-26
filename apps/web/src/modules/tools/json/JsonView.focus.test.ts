import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../../app/auth'
import JsonView from './JsonView.vue'

const editorDrivers = vi.hoisted(() => [] as Array<{
  getValue(): string
  change(value: string): void
}>)

vi.mock('../shared/editor', () => ({
  createAdaptiveEditor(options: { value?: string; onChange?(value: string): void }) {
    let value = options.value ?? ''
    const driver = {
      kind: 'codemirror',
      ready: Promise.resolve(),
      getValue: () => value,
      setValue: (next: string) => { value = next },
      change: (next: string) => { value = next; options.onChange?.(next) },
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

// 本地运行入口与取消入口必须是同一个聚焦控件；组件必须挂到真实 document 才能观察 activeElement。
// Worker 替身不自动回包，由用例决定何时完成、失败或被取消，保留真实的 running 窗口。
// AI 分支不在本文件重复覆盖：其 aria-disabled 主按钮与单独取消按钮的合同由 JsonView.ai.test.ts 验证。
describe('JSON workbench keeps keyboard focus on the local run/cancel button', () => {
  const mounted: VueWrapper[] = []

  beforeEach(() => {
    editorDrivers.length = 0
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
  })

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('turns the focused run button into the only enabled cancel while the Worker is waiting', async () => {
    const wrapper = await mountJsonView(mounted)
    const element = actionButton(wrapper).element
    element.focus()
    expect(document.activeElement).toBe(element)

    await actionButton(wrapper).trigger('click')

    expect(actionButton(wrapper).element).toBe(element)
    expect(actionButton(wrapper).text()).toBe('取消')
    expect(actionButton(wrapper).element.disabled).toBe(false)
    expect(cancelButtons(wrapper)).toHaveLength(1)
    expect(document.activeElement).toBe(element)
  })

  it('restores the action label and focus on the same control after completion, failure, and clearing the input', async () => {
    const wrapper = await mountJsonView(mounted)
    const element = actionButton(wrapper).element
    element.focus()

    await actionButton(wrapper).trigger('click')
    const worker = DelayedWorker.instances[0]!
    const first = worker.messages.find((message) => message.type === 'request')!
    worker.emit(first.requestId, { operation: 'format', output: '{\n  "project": "dev-toolbox"\n}' })
    await flushPromises()

    expect(copyButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(actionButton(wrapper).element).toBe(element)
    expect(actionButton(wrapper).text()).toBe('格式化')
    expect(document.activeElement).toBe(element)

    await actionButton(wrapper).trigger('click')
    const second = worker.messages.filter((message) => message.type === 'request')[1]!
    worker.emitError(second.requestId, { code: 'JSON_PARSE_FAILED', message: '第 2 行存在意外字符' })
    await flushPromises()

    expect(wrapper.get('#json-errors').text()).toContain('第 2 行存在意外字符')
    expect(actionButton(wrapper).element).toBe(element)
    expect(actionButton(wrapper).text()).toBe('格式化')
    expect(document.activeElement).toBe(element)

    editorDrivers[0]!.change('')
    await flushPromises()

    expect(actionButton(wrapper).element).toBe(element)
    expect(actionButton(wrapper).text()).toBe('格式化')
    expect(actionButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('cancels the waiting local request by clicking the same control and keeps focus', async () => {
    const wrapper = await mountJsonView(mounted)
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
    expect(wrapper.find('#json-errors').exists()).toBe(false)
    expect(actionButton(wrapper).element).toBe(element)
    expect(actionButton(wrapper).text()).toBe('格式化')
    expect(actionButton(wrapper).element.disabled).toBe(false)
    expect(document.activeElement).toBe(element)
  })

  it('does not pull focus back when the user moved elsewhere during the run', async () => {
    const elsewhere = document.createElement('button')
    elsewhere.textContent = '页面其他控件'
    document.body.append(elsewhere)
    const wrapper = await mountJsonView(mounted)
    actionButton(wrapper).element.focus()
    await actionButton(wrapper).trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!

    elsewhere.focus()
    expect(document.activeElement).toBe(elsewhere)

    worker.emit(request.requestId, { operation: 'format', output: '{\n  "project": "dev-toolbox"\n}' })
    await flushPromises()

    expect(copyButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(actionButton(wrapper).text()).toBe('格式化')
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

  emit(requestId: string, result: unknown) {
    this.dispatch({ type: 'result', requestId, result })
  }

  emitError(requestId: string, error: { code: string; message: string }) {
    this.dispatch({ type: 'error', requestId, error })
  }

  private dispatch(data: unknown) {
    const event = new MessageEvent('message', { data })
    for (const listener of this.listeners.get('message') ?? []) listener(event)
  }
}

async function mountJsonView(mounted: VueWrapper[]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-json-focus'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tools', component: { template: '<div />' } },
      { path: '/tools/json', component: { template: '<div />' } },
    ],
  })
  await router.push('/tools/json')
  await router.isReady()
  const wrapper = mount(JsonView, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  mounted.push(wrapper)
  return wrapper
}

// 本地运行中主按钮切换为 danger 取消态，其余状态为 primary；两种变体选择器都指向同一控件。
function actionButton(wrapper: VueWrapper) {
  return wrapper.get<HTMLButtonElement>('#json-actions button.button--primary, #json-actions button.button--danger')
}

function cancelButtons(wrapper: VueWrapper) {
  return wrapper.findAll('button').filter((entry) => entry.text().trim() === '取消')
}

function copyButton(wrapper: VueWrapper) {
  const target = wrapper.findAll('button').find((entry) => entry.text().trim() === '复制')
  if (!target) throw new Error('button not found: 复制')
  return target
}

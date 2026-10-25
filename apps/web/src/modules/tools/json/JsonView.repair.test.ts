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

const examples = `{
  "project": "dev-toolbox",
  "version": 2,
  "features": ["json", "yaml"]
}`
const candidateText = `{
  "project": "dev-toolbox",
  "version": 2,
  "features": ["json"],
  "repaired": true
}`
const repairDiffText = '- "features": ["json", "yaml"]\n+ "features": ["json"]'

describe('JSON restricted repair candidate lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    editorDrivers.length = 0
    vi.restoreAllMocks()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('applies a candidate through the explicit flow and updates the input editor', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()

    await button(wrapper, '检查受限修复').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    expect(request.payload).toEqual({ operation: 'repair', text: examples })

    worker.emit(request.requestId, {
      operation: 'repair', candidate: candidateText, diff: repairDiffText, changed: true,
    })
    await flushPromises()

    expect(wrapper.find('.repair').exists()).toBe(true)
    expect(wrapper.get('.repair pre').text()).toContain('+ "features": ["json"]')
    await button(wrapper, '应用修复').trigger('click')
    await flushPromises()

    expect(editorDrivers[0]!.getValue()).toBe(candidateText)
    expect(wrapper.find('.repair').exists()).toBe(false)
    expect(hasButton(wrapper, '应用修复')).toBe(false)
    expect(wrapper.text()).toContain('修复候选已应用到输入。')
    wrapper.unmount()
  })

  it('discards the candidate as soon as the input editor changes after generation', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()
    await proposeRepairCandidate(wrapper)

    const edited = '{\n  "edited": true\n}'
    editorDrivers[0]!.change(edited)
    await flushPromises()

    expect(wrapper.find('.repair').exists()).toBe(false)
    expect(hasButton(wrapper, '应用修复')).toBe(false)
    expect(editorDrivers[0]!.getValue()).toBe(edited)
    expect(wrapper.text()).not.toContain('已生成受限修复候选')
    wrapper.unmount()
  })

  it('ignores a repair result computed for an older input edited during the request', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()

    await button(wrapper, '检查受限修复').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    const editedDuringRun = '{\n  "editedDuringRun": true\n}'
    editorDrivers[0]!.change(editedDuringRun)

    worker.emit(request.requestId, {
      operation: 'repair', candidate: candidateText, diff: repairDiffText, changed: true,
    })
    await flushPromises()

    expect(wrapper.find('.repair').exists()).toBe(false)
    expect(hasButton(wrapper, '应用修复')).toBe(false)
    expect(editorDrivers[0]!.getValue()).toBe(editedDuringRun)
    expect(wrapper.text()).not.toContain('已生成受限修复候选')
    wrapper.unmount()
  })

  it('clears the candidate when switching tabs and when starting another operation', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()
    await proposeRepairCandidate(wrapper)

    await tabButton(wrapper, 'JSONPath').trigger('click')
    await flushPromises()
    expect(wrapper.find('.repair').exists()).toBe(false)

    await tabButton(wrapper, '格式化').trigger('click')
    await flushPromises()
    await proposeRepairCandidate(wrapper)

    await wrapper.get('#json-actions button.button--primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('.repair').exists()).toBe(false)
    wrapper.unmount()
  })
})

class DelayedWorker {
  static instances: DelayedWorker[] = []
  readonly messages: Array<{ type: string; requestId: string; payload?: unknown }> = []
  readonly listeners = new Map<string, Set<(event: MessageEvent<unknown>) => void>>()
  terminated = false

  constructor() {
    DelayedWorker.instances.push(this)
  }

  static reset() {
    DelayedWorker.instances = []
  }

  postMessage(message: { type: string; requestId: string; payload?: unknown }) {
    this.messages.push(message)
  }

  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
    let group = this.listeners.get(type)
    if (!group) {
      group = new Set()
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
    const event = new MessageEvent('message', { data: { type: 'result', requestId, result } })
    for (const listener of this.listeners.get('message') ?? []) listener(event)
  }
}

async function proposeRepairCandidate(wrapper: VueWrapper) {
  await button(wrapper, '检查受限修复').trigger('click')
  const worker = DelayedWorker.instances[0]!
  const request = worker.messages.filter((message) => message.type === 'request').at(-1)!
  worker.emit(request.requestId, {
    operation: 'repair', candidate: candidateText, diff: repairDiffText, changed: true,
  })
  await flushPromises()
  expect(wrapper.find('.repair').exists()).toBe(true)
}

async function mountJsonView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-json-repair'
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
  return wrapper
}

function button(wrapper: VueWrapper, label: string) {
  const target = wrapper.findAll('button').find((entry) => entry.text().trim() === label)
  if (!target) throw new Error(`button not found: ${label}`)
  return target
}

function hasButton(wrapper: VueWrapper, label: string) {
  return wrapper.findAll('button').some((entry) => entry.text().trim() === label)
}

function tabButton(wrapper: VueWrapper, label: string) {
  const target = wrapper.get('nav.tabs').findAll('button').find((entry) => entry.text().trim() === label)
  if (!target) throw new Error(`tab not found: ${label}`)
  return target
}

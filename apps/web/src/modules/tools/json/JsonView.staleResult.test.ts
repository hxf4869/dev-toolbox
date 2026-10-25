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

const providerId = '11111111-1111-4111-8111-111111111111'
const modelId = '22222222-2222-4222-8222-222222222222'

describe('JSON stale result invalidation', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    editorDrivers.length = 0
    vi.restoreAllMocks()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('clears a completed format result and disables copy once the input editor changes', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()

    await wrapper.get('#json-actions button.button--primary').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    worker.emit(request.requestId, { operation: 'format', output: '{\n  "project": "dev-toolbox"\n}' })
    await flushPromises()
    expect(editorDrivers[1]!.getValue()).toContain('dev-toolbox')
    expect(button(wrapper, '复制').attributes('disabled')).toBeUndefined()

    editorDrivers[0]!.change('{"changed":true}')
    await flushPromises()

    expect(button(wrapper, '复制').attributes('disabled')).toBeDefined()
    expect(editorDrivers[1]!.getValue()).toBe('')
    wrapper.unmount()
  })

  it('cancels an in-flight format request when the input changes and drops its late success', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()

    await wrapper.get('#json-actions button.button--primary').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    editorDrivers[0]!.change('{"changedDuringRun":true}')

    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: request.requestId })
    worker.emit(request.requestId, { operation: 'format', output: '{"late":true}' })
    await flushPromises()

    expect(button(wrapper, '复制').attributes('disabled')).toBeDefined()
    expect(editorDrivers[1]!.getValue()).toBe('')
    expect(wrapper.get('#json-actions button.button--primary').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('drops a late worker error after the input changed during the request', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()

    await wrapper.get('#json-actions button.button--primary').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    editorDrivers[0]!.change('{"changedDuringRun":true}')

    worker.emitError(request.requestId, { code: 'JSON_PARSE_FAILED', message: 'Unexpected token in JSON' })
    await flushPromises()

    expect(wrapper.find('#json-errors').exists()).toBe(false)
    expect(wrapper.get('#json-actions button.button--primary').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('invalidates a zero-match JSONPath summary when the expression changes', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()
    await tabButton(wrapper, 'JSONPath').trigger('click')
    await flushPromises()

    await button(wrapper, '运行查询').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.filter((message) => message.type === 'request').at(-1)!
    worker.emit(request.requestId, { operation: 'jsonpath', matches: [] })
    await flushPromises()
    expect(wrapper.text()).toContain('共 0 个匹配')

    await wrapper.get('#json-actions input').setValue('$.version')
    await flushPromises()

    expect(wrapper.text()).not.toContain('共 0 个匹配')
    wrapper.unmount()
  })

  it('clears a diff result when input B is edited in the result editor', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()
    await tabButton(wrapper, '对比').trigger('click')
    await flushPromises()

    await wrapper.get('#json-actions button.button--primary').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.filter((message) => message.type === 'request').at(-1)!
    worker.emit(request.requestId, {
      operation: 'diff',
      summary: '2 处结构差异',
      differences: [{ kind: 'add', path: '$.b', before: null, after: 1 }],
    })
    await flushPromises()
    expect(wrapper.text()).toContain('2 处结构差异')
    expect(wrapper.find('.inline-result').exists()).toBe(true)

    editorDrivers[1]!.change('{"project":"dev-toolbox","b":1}')
    await flushPromises()

    expect(wrapper.text()).not.toContain('2 处结构差异')
    expect(wrapper.find('.inline-result').exists()).toBe(false)
    wrapper.unmount()
  })

  it('drops a late AI success after the input changes and keeps structure mode free of source values', async () => {
    const posts: RequestInit[] = []
    let settlePost!: (response: Promise<Response>) => void
    const postDeferred = new Promise<Response>((resolve) => { settlePost = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/tools/json/type-generation/ai' && init?.method === 'POST') {
        posts.push(init!)
        return postDeferred
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountJsonView()
    await button(wrapper, '类型生成').trigger('click')
    await button(wrapper, '使用 AI').trigger('click')
    await flushPromises()
    await button(wrapper, '预览并确认发送').trigger('click')
    await flushPromises()
    await button(wrapper, '确认发送并生成').trigger('click')
    await flushPromises()

    editorDrivers[0]!.change('{"changedDuringAI":true}')
    settlePost(jsonResponse({
      code: 'type ChangedRoot struct {}', language: 'Rust',
      promptVersion: 'json-type-generation-v1', usage: null,
    }))
    await flushPromises()

    expect(wrapper.text()).toContain('已丢弃')
    expect(editorDrivers[1]!.getValue()).toBe('')
    expect(button(wrapper, '复制').attributes('disabled')).toBeDefined()
    expect(String(posts[0]?.body)).not.toContain('dev-toolbox')
    expect(String(posts[0]?.body)).not.toContain('changedDuringAI')
    wrapper.unmount()
  })

  it('drops a late non-cancelled AI error after the input changes', async () => {
    let failPost: (reason: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/tools/json/type-generation/ai' && init?.method === 'POST') {
        return new Promise<Response>((_resolve, reject) => { failPost = reject })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountJsonView()
    await button(wrapper, '类型生成').trigger('click')
    await button(wrapper, '使用 AI').trigger('click')
    await flushPromises()
    await button(wrapper, '预览并确认发送').trigger('click')
    await flushPromises()
    await button(wrapper, '确认发送并生成').trigger('click')
    await flushPromises()

    editorDrivers[0]!.change('{"changedDuringAI":true}')
    failPost(new Error('network down'))
    await flushPromises()

    expect(wrapper.text()).toContain('已丢弃')
    expect(wrapper.find('#json-errors').exists()).toBe(false)
    wrapper.unmount()
  })
  it('invalidates AI output when the target language changes or the generation source switches', async () => {
    const posts: RequestInit[] = []
    const settlePosts: Array<(response: Promise<Response>) => void> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/tools/json/type-generation/ai' && init?.method === 'POST') {
        posts.push(init!)
        return new Promise<Response>((resolve) => { settlePosts.push(resolve) })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountJsonView()
    await button(wrapper, '类型生成').trigger('click')
    await button(wrapper, '使用 AI').trigger('click')
    await flushPromises()
    await button(wrapper, '预览并确认发送').trigger('click')
    await flushPromises()
    await button(wrapper, '确认发送并生成').trigger('click')
    settlePosts[0]!(jsonResponse({
      code: 'struct RustRoot {}', language: 'Rust',
      promptVersion: 'json-type-generation-v1', usage: null,
    }))
    await flushPromises()
    expect(editorDrivers[1]!.getValue()).toContain('RustRoot')
    expect(button(wrapper, '复制').attributes('disabled')).toBeUndefined()

    await wrapper.get('#json-actions input').setValue('Go')
    await flushPromises()
    expect(button(wrapper, '复制').attributes('disabled')).toBeDefined()
    expect(editorDrivers[1]!.getValue()).toBe('')

    await button(wrapper, '预览并确认发送').trigger('click')
    await flushPromises()
    await button(wrapper, '确认发送并生成').trigger('click')
    settlePosts[1]!(jsonResponse({
      code: 'type GoRoot struct {}', language: 'Go',
      promptVersion: 'json-type-generation-v1', usage: null,
    }))
    await flushPromises()
    expect(editorDrivers[1]!.getValue()).toContain('GoRoot')
    expect(button(wrapper, '复制').attributes('disabled')).toBeUndefined()
    expect(JSON.parse(String(posts[1]?.body))).toMatchObject({ targetLanguage: 'Go' })

    await button(wrapper, '本地确定性').trigger('click')
    await flushPromises()
    expect(button(wrapper, '复制').attributes('disabled')).toBeDefined()
    expect(editorDrivers[1]!.getValue()).toBe('')
    wrapper.unmount()
  })
  it('drops a late AI success when only the target language changed during the pending request', async () => {
    let settlePost!: (response: Promise<Response>) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/tools/json/type-generation/ai' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => { settlePost = resolve })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountJsonView()
    await button(wrapper, '类型生成').trigger('click')
    await button(wrapper, '使用 AI').trigger('click')
    await flushPromises()
    await button(wrapper, '预览并确认发送').trigger('click')
    await flushPromises()
    await button(wrapper, '确认发送并生成').trigger('click')
    await flushPromises()

    await wrapper.get('#json-actions input').setValue('Go')
    settlePost(jsonResponse({
      code: 'struct RustRoot {}', language: 'Rust',
      promptVersion: 'json-type-generation-v1', usage: null,
    }))
    await flushPromises()

    expect(wrapper.text()).toContain('已丢弃')
    expect(editorDrivers[1]!.getValue()).toBe('')
    expect(button(wrapper, '复制').attributes('disabled')).toBeDefined()
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

async function mountJsonView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-json-stale'
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

function tabButton(wrapper: VueWrapper, label: string) {
  const target = wrapper.get('nav.tabs').findAll('button').find((entry) => entry.text().trim() === label)
  if (!target) throw new Error(`tab not found: ${label}`)
  return target
}

function provider() {
  return {
    id: providerId,
    displayName: 'Synthetic Provider',
    hasApiKey: true,
    enabled: true,
    models: [{
      id: modelId,
      displayName: 'Synthetic Model',
      modelId: 'synthetic-model',
      contextWindow: 8192,
      maxOutputTokens: 1024,
      enabled: true,
    }],
  }
}

function jsonResponse(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

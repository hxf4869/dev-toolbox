import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../../app/auth'
import JsonView from './JsonView.vue'

const editorDrivers = vi.hoisted(() => [] as Array<{
  getValue(): string
  change(value: string): void
  setAriaLabel: ReturnType<typeof vi.fn>
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

describe('JSON AI explicit send flow', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    editorDrivers.length = 0
    vi.restoreAllMocks()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('keeps structure values local and sends only after explicit confirmation', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      requests.push({ path, init })
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/tools/json/type-generation/ai' && init?.method === 'POST') {
        return jsonResponse({
          code: 'type Root struct {}', language: 'Rust',
          promptVersion: 'json-type-generation-v1', usage: null,
        })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountJsonView()

    await button(wrapper, '类型生成').trigger('click')
    await button(wrapper, '使用 AI').trigger('click')
    await flushPromises()
    expect(requests.map((request) => request.path)).toEqual(['/api/v1/ai/providers'])

    const trigger = button(wrapper, '预览并确认发送')
    await trigger.trigger('click')
    await flushPromises()
    expect(document.activeElement?.textContent?.trim()).toBe('取消，不发送')
    const preview = wrapper.get('[data-testid="json-ai-preview"]').text()
    expect(preview).toContain('"kind":"object"')
    expect(preview).not.toContain('dev-toolbox')
    expect(preview).not.toContain('"json"')
    expect(requests).toHaveLength(1)

    await button(wrapper, '确认发送并生成').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(trigger.element)
    const post = requests.find((request) => request.init?.method === 'POST')
    expect(post).toBeDefined()
    expect((post?.init?.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-json-ai')
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      providerId,
      modelId,
      targetLanguage: 'Rust',
      mode: 'structure',
    })
    expect(wrapper.text()).toContain('结果未执行、未编译、未保存，也未创建 Artifact')
    wrapper.unmount()
  })

  it('requires a second acknowledgement for full JSON and cancel sends zero requests', async () => {
    const posts: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/ai/providers') return jsonResponse({ items: [provider()] })
      if (path === '/api/v1/tools/json/type-generation/ai' && init?.method === 'POST') {
        posts.push(init)
        return jsonResponse({
          code: 'record Root {}', language: 'Rust',
          promptVersion: 'json-type-generation-v1', usage: { inputTokens: 10, outputTokens: 5 },
        })
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const wrapper = await mountJsonView()
    await button(wrapper, '类型生成').trigger('click')
    await button(wrapper, '使用 AI').trigger('click')
    await flushPromises()
    const sendMode = wrapper.findAll('select').find((select) => select.find('option[value="full"]').exists())
    expect(sendMode).toBeDefined()
    await sendMode!.setValue('full')

    const fullTrigger = button(wrapper, '预览并确认发送')
    await fullTrigger.trigger('click')
    await flushPromises()
    expect(document.activeElement?.textContent?.trim()).toBe('取消，不发送')
    expect(wrapper.get('[role="dialog"]').element.contains(document.activeElement)).toBe(true)
    const source = `{
  "project": "dev-toolbox",
  "version": 2,
  "features": ["json", "yaml"]
}`
    expect(wrapper.get('[data-testid="json-ai-preview"]').text()).toBe(source)
    expect(button(wrapper, '确认发送并生成').attributes('disabled')).toBeDefined()
    await button(wrapper, '取消，不发送').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(fullTrigger.element)
    expect(posts).toHaveLength(0)

    await fullTrigger.trigger('click')
    await wrapper.get('.full-acknowledgement input').setValue(true)
    await button(wrapper, '确认发送并生成').trigger('click')
    await flushPromises()
    expect(posts).toHaveLength(1)
    expect(String(posts[0]?.body)).toContain(`,"input":${source}}`)
    wrapper.unmount()
  })

  it('cancels a local Worker request before clearing and ignores a late result', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()

    await wrapper.get('#json-actions button.button--primary').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const request = worker.messages.find((message) => message.type === 'request')!
    await button(wrapper, '清空').trigger('click')
    await flushPromises()

    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: request.requestId })
    expect(worker.terminated).toBe(true)
    worker.emit(request.requestId, { operation: 'format', output: '{"late":true}' })
    await flushPromises()
    expect(button(wrapper, '复制').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('does not run Schema generation post-processing after cancellation', async () => {
    DelayedWorker.reset()
    vi.stubGlobal('Worker', DelayedWorker)
    const wrapper = await mountJsonView()
    await button(wrapper, 'Schema').trigger('click')
    await button(wrapper, '从样本生成初始 Schema').trigger('click')
    const worker = DelayedWorker.instances[0]!
    const first = worker.messages.find((message) => message.type === 'request')!
    worker.emit(first.requestId, { operation: 'schema-generate', output: '{"type":"object"}' })
    await flushPromises()

    const resultEditor = editorDrivers[1]!
    expect(resultEditor.setAriaLabel).toHaveBeenCalledWith('JSON Schema 编辑器')
    resultEditor.change('{"manual":true}')
    await button(wrapper, '从样本生成初始 Schema').trigger('click')
    const second = worker.messages.filter((message) => message.type === 'request').at(-1)!
    await button(wrapper, '取消').trigger('click')
    await flushPromises()

    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: second.requestId })
    expect(resultEditor.getValue()).toBe('{"manual":true}')
    worker.emit(second.requestId, { operation: 'schema-generate', output: '{"late":true}' })
    await flushPromises()
    expect(resultEditor.getValue()).toBe('{"manual":true}')
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

async function mountJsonView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-json-ai'
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

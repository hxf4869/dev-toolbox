import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../../app/auth'
import JsonView from './JsonView.vue'

// 编辑器故障反馈独立于业务错误：页签切换（watch(activeTab) 清 errorMessage）
// 不得移除重试入口；两个编辑器都恢复成功后才清除故障提示。
let refreshShouldFail = false

vi.mock('../shared/editor', () => ({
  createAdaptiveEditor: () => ({
    kind: null,
    ready: Promise.reject(new Error('chunk load failed')),
    getValue: () => '',
    setValue: vi.fn(),
    setLanguage: vi.fn(async () => {}),
    setAriaLabel: vi.fn(),
    setReadOnly: vi.fn(),
    refresh: vi.fn(async () => {
      if (refreshShouldFail) throw new Error('chunk load failed again')
    }),
    dispose: vi.fn(),
  }),
}))

class StubWorker {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function failureNotice(wrapper: VueWrapper) {
  return wrapper.findAll('#json-feedback .message--error').find((entry) => entry.text().includes('编辑器组件加载失败'))
}

function retryButton(wrapper: VueWrapper) {
  return wrapper.findAll('#json-feedback button').find((entry) => entry.text() === '重试加载编辑器')
}

describe('JSON workbench editor load failure recovery', () => {
  const mounted: VueWrapper[] = []

  beforeEach(() => {
    vi.stubGlobal('Worker', StubWorker)
  })

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    refreshShouldFail = false
  })

  async function mountView(): Promise<VueWrapper> {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-json-retry'
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

  it('keeps the retry entry through tab switches and clears it only after both editors recover', async () => {
    const wrapper = await mountView()

    expect(failureNotice(wrapper)).toBeTruthy()
    expect(retryButton(wrapper)).toBeTruthy()

    // 切换页签会清空业务反馈（watch(activeTab) 清 errorMessage），重试入口必须保留。
    const tabs = wrapper.findAll('nav.tabs button')
    expect(tabs.length).toBeGreaterThan(1)
    await tabs[1]!.trigger('click')
    await flushPromises()
    expect(failureNotice(wrapper)).toBeTruthy()
    expect(retryButton(wrapper)).toBeTruthy()

    // 重试失败：提示与入口保留。
    refreshShouldFail = true
    await retryButton(wrapper)!.trigger('click')
    await flushPromises()
    expect(failureNotice(wrapper)).toBeTruthy()
    expect(retryButton(wrapper)).toBeTruthy()

    // 两个编辑器都恢复成功后，故障提示与重试入口一并清除。
    refreshShouldFail = false
    await retryButton(wrapper)!.trigger('click')
    await flushPromises()
    expect(failureNotice(wrapper)).toBeFalsy()
    expect(retryButton(wrapper)).toBeFalsy()
  })
})

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import YamlView from './YamlView.vue'

// 编辑器故障反馈必须与业务错误（errorMessage）的清理语义分开：模式切换会
// 清空业务反馈，但只要编辑器仍处于加载失败状态，重试入口就不得消失；相关
// 编辑器全部恢复成功后才清除故障提示。Worker 不会被触达，只需可构造的替身。
class StubWorker {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

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

function failureNotice(wrapper: VueWrapper) {
  return wrapper.findAll('#yaml-feedback .message.error').find((entry) => entry.text().includes('编辑器组件加载失败'))
}

function retryButton(wrapper: VueWrapper) {
  return wrapper.findAll('#yaml-feedback button').find((entry) => entry.text() === '重试加载编辑器')
}

describe('YAML workbench editor load failure recovery', () => {
  const mounted: VueWrapper[] = []

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    refreshShouldFail = false
  })

  async function mountView(): Promise<VueWrapper> {
    vi.stubGlobal('Worker', StubWorker)
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

  it('keeps the retry entry through mode switches and clears it only after a successful retry', async () => {
    const wrapper = await mountView()

    expect(failureNotice(wrapper)).toBeTruthy()
    expect(retryButton(wrapper)).toBeTruthy()

    // 切换模式会清空业务反馈（watch(mode) 清 errorMessage），重试入口必须保留。
    await wrapper.findAll('button').find((entry) => entry.text() === 'YAML→JSON')!.trigger('click')
    await flushPromises()
    expect(failureNotice(wrapper)).toBeTruthy()
    expect(retryButton(wrapper)).toBeTruthy()

    // 重试本身失败：故障提示与重试入口保留。
    refreshShouldFail = true
    await retryButton(wrapper)!.trigger('click')
    await flushPromises()
    expect(failureNotice(wrapper)).toBeTruthy()
    expect(retryButton(wrapper)).toBeTruthy()

    // 相关编辑器全部恢复成功后，故障提示与重试入口一并清除。
    refreshShouldFail = false
    await retryButton(wrapper)!.trigger('click')
    await flushPromises()
    expect(failureNotice(wrapper)).toBeFalsy()
    expect(retryButton(wrapper)).toBeFalsy()
  })
})

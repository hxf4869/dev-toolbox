import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantApi } from './assistantApi'
import AssistantView from './AssistantView.vue'
import {
  bootstrapFixtures,
  conversationFixture,
  folderFixture,
} from './assistantMocks'
import { useAssistantStore } from './assistantStore'

describe('AssistantView bootstrap states', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('shows configuration guidance instead of an empty chat when no model is available', async () => {
    const store = useAssistantStore()
    store.setApi(createApi({ getBootstrap: vi.fn().mockResolvedValue(bootstrapFixtures.noModels) }))
    const wrapper = mount(AssistantView, {
      attachTo: document.body,
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('还没有可用的聊天模型')
    expect(wrapper.text()).toContain('前往 Provider 与模型设置')
    expect(wrapper.find('textarea').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps general chat available while the knowledge index is unavailable', async () => {
    const store = useAssistantStore()
    store.setApi(createApi({
      getBootstrap: vi.fn().mockResolvedValue(bootstrapFixtures.indexing),
      getConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    }))
    const wrapper = mount(AssistantView, {
      attachTo: document.body,
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('知识库索引中')
    expect(wrapper.text()).toContain('已完成 10，待处理 11，运行中 3')
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('预计')
    wrapper.unmount()
  })
})

function createApi(overrides: Partial<AssistantApi> = {}): AssistantApi {
  const defaults: AssistantApi = {
    getBootstrap: vi.fn().mockResolvedValue(structuredClone(bootstrapFixtures.ready)),
    getEmbeddingSettings: vi.fn(),
    putEmbeddingSettings: vi.fn(),
    deleteEmbeddingSettings: vi.fn(),
    testEmbeddingSettings: vi.fn(),
    getIndexStatus: vi.fn(),
    getIndexFailures: vi.fn(),
    retryIndexFailure: vi.fn(),
    getFolders: vi.fn().mockResolvedValue({ items: [structuredClone(folderFixture)] }),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    getConversations: vi.fn().mockResolvedValue({ items: [structuredClone(conversationFixture)], nextCursor: null }),
    getConversation: vi.fn(),
    patchConversation: vi.fn(),
    deleteConversation: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    startRun: vi.fn(),
    getRun: vi.fn(),
    stopRun: vi.fn(),
    retryRun: vi.fn(),
    getSource: vi.fn(),
    streamPersistentRun: async function* () {},
    streamTemporaryRun: async function* () {},
  }
  return { ...defaults, ...overrides }
}

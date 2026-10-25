import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantApi } from './assistantApi'
import type { AssistantBootstrapDTO, KnowledgeIndexStatusDTO } from './assistantContracts'
import AssistantView from './AssistantView.vue'
import {
  bootstrapFixtures,
  conversationFixture,
  folderFixture,
  knowledgeFixtures,
} from './assistantMocks'
import { useAssistantStore } from './assistantStore'

// fake timers 会拦下 @vue/test-utils flushPromises 依赖的 setTimeout(0)；
// 用纯微任务排空等待 Promise 链与渲染，不推进虚拟时钟。
async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

function mountView() {
  return mount(AssistantView, {
    attachTo: document.body,
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })
}

describe('assistant knowledge index refresh', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.useFakeTimers()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('polls index status to ready while mounted without reloading bootstrap or losing session state', async () => {
    const getBootstrap = vi.fn().mockResolvedValue(structuredClone(bootstrapFixtures.indexing))
    const getIndexStatus = vi.fn().mockResolvedValue(structuredClone(knowledgeFixtures.ready))
    const store = useAssistantStore()
    store.setApi(createApi({ getBootstrap, getIndexStatus }))
    const wrapper = mountView()
    await settle()

    expect(wrapper.text()).toContain('知识库索引中')
    expect(wrapper.text()).toContain('已完成 10，待处理 11，运行中 3')

    await store.selectConversation(structuredClone(conversationFixture))
    store.draft = '等待索引时写下的草稿'
    store.chooseReasoning('high')
    await settle()

    await vi.advanceTimersByTimeAsync(2000)
    await settle()

    expect(getBootstrap).toHaveBeenCalledTimes(1)
    expect(getIndexStatus).toHaveBeenCalledTimes(1)
    expect(store.bootstrap?.knowledge.status).toBe('ready')
    expect(store.bootstrap?.knowledge.counts.ready).toBe(24)
    expect(store.draft).toBe('等待索引时写下的草稿')
    expect(sessionStorage.getItem(`dev-toolbox:assistant:draft:${conversationFixture.id}`)).toBe(
      '等待索引时写下的草稿',
    )
    expect(store.selectedReasoning).toBe('high')
    expect(store.activeConversation?.id).toBe(conversationFixture.id)
    expect(wrapper.text()).toContain('知识库可用')
    expect(wrapper.text()).not.toContain('知识库索引中')
    expect(wrapper.text()).not.toContain('知识库正在建立索引')

    await vi.advanceTimersByTimeAsync(6000)
    expect(getIndexStatus).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('stops polling on unmount, ignores late responses, and does not pollute a fresh mount', async () => {
    // 第二次 bootstrap 携带不同 generation/计数：若旧视图的迟到响应写入，
    // 新视图会退回旧 generation 的数据，据此能检出污染。
    const reindexedBootstrap = structuredClone(bootstrapFixtures.indexing)
    reindexedBootstrap.knowledge = {
      ...reindexedBootstrap.knowledge,
      generation: 5,
      counts: { ...reindexedBootstrap.knowledge.counts, ready: 14, pending: 10, running: 0 },
    }
    const getBootstrap = vi.fn()
      .mockResolvedValueOnce(structuredClone(bootstrapFixtures.indexing))
      .mockResolvedValue(reindexedBootstrap)
    let resolveFirstStatus!: (status: KnowledgeIndexStatusDTO) => void
    const firstStatus = new Promise<KnowledgeIndexStatusDTO>((resolve) => {
      resolveFirstStatus = resolve
    })
    const getIndexStatus = vi.fn()
      .mockReturnValueOnce(firstStatus)
      .mockResolvedValue(structuredClone(knowledgeFixtures.ready))
    const store = useAssistantStore()
    store.setApi(createApi({ getBootstrap, getIndexStatus }))
    const first = mountView()
    await settle()
    expect(store.bootstrap?.knowledge.status).toBe('indexing')

    await vi.advanceTimersByTimeAsync(2000)
    expect(getIndexStatus).toHaveBeenCalledTimes(1)

    first.unmount()
    const second = mountView()
    await settle()
    expect(getBootstrap).toHaveBeenCalledTimes(2)
    expect(store.bootstrap?.knowledge.generation).toBe(5)
    expect(store.bootstrap?.knowledge.counts.ready).toBe(14)

    resolveFirstStatus(structuredClone(knowledgeFixtures.ready))
    await settle()
    expect(store.bootstrap?.knowledge.generation).toBe(5)
    expect(store.bootstrap?.knowledge.counts.ready).toBe(14)
    expect(getIndexStatus).toHaveBeenCalledTimes(1)

    // 新视图自己的轮询照常工作，旧响应的到达既不写入也不复活为额外请求。
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(getIndexStatus).toHaveBeenCalledTimes(2)
    expect(store.bootstrap?.knowledge.status).toBe('ready')
    second.unmount()
  })

  it('keeps the last known status on refresh failure and recovers through the explicit retry', async () => {
    const getIndexStatus = vi.fn()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValue(structuredClone(knowledgeFixtures.ready))
    const store = useAssistantStore()
    store.setApi(
      createApi({
        getBootstrap: vi.fn().mockResolvedValue(structuredClone(bootstrapFixtures.indexing)),
        getIndexStatus,
      }),
    )
    const wrapper = mountView()
    await settle()

    await vi.advanceTimersByTimeAsync(2000)
    await settle()

    expect(store.bootstrap?.knowledge.status).toBe('indexing')
    expect(store.bootstrap?.knowledge.counts.ready).toBe(10)
    expect(store.knowledgePollError).toBe('网络中断')
    const alert = wrapper.find('.assistant-thread__knowledge-alert')
    expect(alert.exists()).toBe(true)
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toContain('索引状态自动刷新失败')
    expect(wrapper.find('textarea').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(6000)
    expect(getIndexStatus).toHaveBeenCalledTimes(1)

    store.draft = '失败提示不阻塞输入'
    expect(store.draft).toBe('失败提示不阻塞输入')

    await alert.find('button').trigger('click')
    await settle()

    expect(store.knowledgePollError).toBe('')
    expect(store.bootstrap?.knowledge.status).toBe('ready')
    expect(getIndexStatus).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('does not poll when the bootstrap knowledge status is already terminal', async () => {
    const getIndexStatus = vi.fn().mockResolvedValue(structuredClone(knowledgeFixtures.ready))
    const store = useAssistantStore()
    store.setApi(createApi({ getIndexStatus }))
    const wrapper = mountView()
    await settle()

    await vi.advanceTimersByTimeAsync(6000)

    expect(store.bootstrap?.knowledge.status).toBe('ready')
    expect(getIndexStatus).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not poll after a failed bootstrap and starts polling after an explicit retry', async () => {
    const getBootstrap = vi.fn()
      .mockRejectedValueOnce(new Error('服务暂不可用'))
      .mockResolvedValue(structuredClone(bootstrapFixtures.indexing))
    const getIndexStatus = vi.fn().mockResolvedValue(structuredClone(knowledgeFixtures.ready))
    const store = useAssistantStore()
    store.setApi(createApi({ getBootstrap, getIndexStatus }))
    const wrapper = mountView()
    await settle()

    expect(store.pageError).toBe('服务暂不可用')
    expect(store.bootstrap).toBeNull()

    await vi.advanceTimersByTimeAsync(6000)
    expect(getIndexStatus).not.toHaveBeenCalled()

    await wrapper.find('button').trigger('click')
    await settle()
    expect(store.bootstrap?.knowledge.status).toBe('indexing')

    await vi.advanceTimersByTimeAsync(2000)
    await settle()

    expect(getIndexStatus).toHaveBeenCalledTimes(1)
    expect(store.bootstrap?.knowledge.status).toBe('ready')
    wrapper.unmount()
  })

  it('ignores a late bootstrap from an unmounted view and keeps the fresh initialize active', async () => {
    const gen5Bootstrap = structuredClone(bootstrapFixtures.indexing)
    gen5Bootstrap.knowledge = {
      ...gen5Bootstrap.knowledge,
      generation: 5,
      counts: { ...gen5Bootstrap.knowledge.counts, ready: 14, pending: 10, running: 0 },
    }
    let resolveFirstBootstrap!: (value: AssistantBootstrapDTO) => void
    let resolveSecondBootstrap!: (value: AssistantBootstrapDTO) => void
    const getBootstrap = vi.fn()
      .mockReturnValueOnce(
        new Promise<AssistantBootstrapDTO>((resolve) => {
          resolveFirstBootstrap = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise<AssistantBootstrapDTO>((resolve) => {
          resolveSecondBootstrap = resolve
        }),
      )
    const getIndexStatus = vi.fn().mockResolvedValue(structuredClone(knowledgeFixtures.ready))
    const store = useAssistantStore()
    store.setApi(createApi({ getBootstrap, getIndexStatus }))
    const first = mountView()
    await settle()
    expect(store.loading).toBe(true)
    expect(getBootstrap).toHaveBeenCalledTimes(1)

    first.unmount()
    const second = mountView()
    await settle()
    expect(getBootstrap).toHaveBeenCalledTimes(2)
    expect(store.loading).toBe(true)

    resolveFirstBootstrap(structuredClone(bootstrapFixtures.indexing))
    await settle()
    expect(store.bootstrap).toBeNull()
    expect(store.loading).toBe(true)
    expect(getIndexStatus).not.toHaveBeenCalled()

    resolveSecondBootstrap(gen5Bootstrap)
    await settle()
    expect(store.loading).toBe(false)
    expect(store.bootstrap?.knowledge.generation).toBe(5)
    expect(store.bootstrap?.knowledge.counts.ready).toBe(14)

    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(getIndexStatus).toHaveBeenCalledTimes(1)
    expect(store.bootstrap?.knowledge.status).toBe('ready')
    second.unmount()
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
    getConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
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

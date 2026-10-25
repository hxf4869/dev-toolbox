import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantApi } from './assistantApi'
import type { AssistantConversationDTO } from './assistantContracts'
import AssistantModuleNav from './AssistantModuleNav.vue'
import {
  archivedConversationFixture,
  bootstrapFixtures,
  conversationFixture,
  folderFixture,
} from './assistantMocks'
import { useAssistantStore } from './assistantStore'

describe('AssistantModuleNav', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('requires an explicit folder conversation action and a second confirmation for permanent deletion', async () => {
    const deleteFolder = vi.fn().mockResolvedValue(undefined)
    const store = useAssistantStore()
    store.setApi(createApi({ deleteFolder }))
    const wrapper = mount(AssistantModuleNav, { attachTo: document.body })
    await flushPromises()

    await openFolderDelete()
    const unfile = document.querySelector<HTMLInputElement>('input[value="unfile"]')!
    const permanent = document.querySelector<HTMLInputElement>('input[value="delete"]')!
    expect(unfile.checked).toBe(false)
    expect(permanent.checked).toBe(false)
    expect(deleteFolder).not.toHaveBeenCalled()

    unfile.click()
    await flushPromises()
    clickButton('删除并移到未分类')
    await flushPromises()
    expect(deleteFolder).toHaveBeenLastCalledWith(folderFixture.id, 'unfile')

    await openFolderDelete()
    document.querySelector<HTMLInputElement>('input[value="delete"]')!.click()
    await flushPromises()
    clickButton('继续')
    await flushPromises()
    expect(deleteFolder).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('无法撤销')

    clickButton('永久删除')
    await flushPromises()
    expect(deleteFolder).toHaveBeenLastCalledWith(folderFixture.id, 'delete')
    wrapper.unmount()
  })

  it('exposes rename, move, pin, archive and delete actions without applying them implicitly', async () => {
    const patchConversation = vi.fn().mockResolvedValue({ ...conversationFixture, pinned: false })
    const store = useAssistantStore()
    store.setApi(createApi({ patchConversation }))
    const wrapper = mount(AssistantModuleNav, { attachTo: document.body })
    await flushPromises()

    document
      .querySelector<HTMLButtonElement>(`button[aria-label="${conversationFixture.title}的更多操作"]`)!
      .click()
    await flushPromises()
    clickButton('取消置顶')
    await flushPromises()
    expect(patchConversation).toHaveBeenCalledWith(conversationFixture.id, { pinned: false })
    wrapper.unmount()
  })

  it('keeps the newest folder scope when a pending switch away from archived is superseded', async () => {
    const folderB = {
      ...structuredClone(folderFixture),
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: '数据库巡检',
      conversationCount: 1,
    }
    const convA: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      title: 'A 会话',
      pinned: false,
    }
    const convB: AssistantConversationDTO = {
      ...structuredClone(conversationFixture),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'B 会话',
      pinned: false,
      folderId: folderB.id,
    }
    const archivedLoad = deferred<ConversationPage>()
    const folderALoad = deferred<ConversationPage>()
    const folderBLoad = deferred<ConversationPage>()
    const getConversations = vi
      .fn()
      .mockResolvedValueOnce({ items: [structuredClone(conversationFixture)], nextCursor: null })
      .mockImplementationOnce(() => archivedLoad.promise)
      .mockImplementationOnce(() => folderALoad.promise)
      .mockImplementationOnce(() => folderBLoad.promise)
    const getFolders = vi.fn().mockResolvedValue({ items: [structuredClone(folderFixture), folderB] })
    const store = useAssistantStore()
    store.setApi(createApi({ getConversations, getFolders }))
    const wrapper = mount(AssistantModuleNav, { attachTo: document.body })
    await flushPromises()
    expect(getConversations).toHaveBeenCalledTimes(1)

    clickButton('已归档')
    await flushPromises()
    expect(store.conversationView).toBe('archived')

    clickScope(folderFixture.name)
    await flushPromises()
    expect(store.conversationView).toBe('active')
    expect(store.folderFilter).toBe(folderFixture.id)
    expect(store.conversations).toEqual([])

    clickScope(folderB.name)
    await flushPromises()
    expect(store.folderFilter).toBe(folderB.id)

    folderBLoad.resolve({ items: [convB], nextCursor: null })
    await flushPromises()
    expect(document.body.textContent).toContain('B 会话')

    folderALoad.resolve({ items: [convA], nextCursor: null })
    archivedLoad.resolve({ items: [structuredClone(archivedConversationFixture)], nextCursor: null })
    await flushPromises()
    expect(document.body.textContent).not.toContain('A 会话')
    expect(document.body.textContent).toContain('B 会话')
    wrapper.unmount()
  })
})

async function openFolderDelete() {
  document
    .querySelector<HTMLButtonElement>(`button[aria-label="${folderFixture.name}文件夹操作"]`)!
    .click()
  await flushPromises()
  clickButton('删除文件夹')
  await flushPromises()
}

function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (entry) => entry.textContent?.trim() === text,
  )
  if (!button) throw new Error(`button not found: ${text}`)
  button.click()
}

function clickScope(name: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.assistant-nav__scope')).find(
    (entry) => entry.textContent?.includes(name),
  )
  if (!button) throw new Error(`scope button not found: ${name}`)
  button.click()
}

interface ConversationPage {
  items: AssistantConversationDTO[]
  nextCursor: string | null
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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
    deleteFolder: vi.fn().mockResolvedValue(undefined),
    getConversations: vi.fn().mockResolvedValue({
      items: [structuredClone(conversationFixture)],
      nextCursor: null,
    }),
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

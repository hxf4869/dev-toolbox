import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantApi } from './assistantApi'
import AssistantModuleNav from './AssistantModuleNav.vue'
import {
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

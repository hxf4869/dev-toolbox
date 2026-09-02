import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantRunDTO } from './assistantContracts'
import { assistantMessageFixture, assistantModelFixture, bootstrapFixtures, runFixtures } from './assistantMocks'
import { useAssistantStore } from './assistantStore'
import AssistantThread from './AssistantThread.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})
afterEach(() => vi.restoreAllMocks())

describe('AssistantThread context measurement', () => {
  it.each([false, true])('keeps the last finished request while streaming (temporary=%s)', async (temporary) => {
    const store = useAssistantStore()
    store.bootstrap = structuredClone(bootstrapFixtures.ready)
    store.selectedModelId = assistantModelFixture.id
    store.temporaryMode = temporary

    function showRuns(runs: AssistantRunDTO[]) {
      if (temporary) {
        store.temporaryMessages = runs.map((run, index) => ({
          id: String(index), role: 'assistant', content: '合成测试回答',
          reasoningContent: null, reasoningDurationMs: null,
          status: run.status === 'running' ? 'streaming' : run.status === 'failed' ? 'failed' : 'complete',
          citations: [], run: null, temporary: true, sources: {},
          temporaryRuntime: { ...run, status: run.status === 'queued' ? 'running' : run.status },
        }))
      } else {
        store.messages = runs.map((run, index) => ({
          ...assistantMessageFixture, id: String(index), currentRun: run,
        }))
      }
    }

    showRuns([runFixtures.succeeded, runFixtures.running])
    const wrapper = mount(AssistantThread, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    const context = () => wrapper.get('.assistant-composer__context').text()
    expect(context()).toBe('上次请求上下文 18.4K / 128K · 14.4%')

    showRuns([runFixtures.succeeded, {
      ...runFixtures.succeeded,
      usage: { ...runFixtures.succeeded.usage, answerContextTokens: 32000 },
      model: { ...runFixtures.succeeded.model, contextWindow: 64000 },
    }])
    await nextTick()
    expect(context()).toBe('上下文 32K / 64K · 50.0%')

    showRuns([runFixtures.succeeded, runFixtures.failedPartial])
    await nextTick()
    expect(context()).toBe('上下文 未提供 / 128K')
    wrapper.unmount()
  })
})

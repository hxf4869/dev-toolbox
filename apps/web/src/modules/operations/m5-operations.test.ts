import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import HelpView from '../help/HelpView.vue'
import OperationsStatusView from './OperationsStatusView.vue'
import type { OperationsStatus } from './contracts'

describe('M5 operations and help', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders real degraded states and keeps backup and restore controls read-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(statusFixture())))
    const wrapper = await mountWithRouter(OperationsStatusView, '/settings/operations')
    await flushPromises()

    expect(document.body.textContent).toContain('部分降级')
    expect(document.body.textContent).toContain('AI Worker')
    expect(document.body.textContent).toContain('不可达；核心记录功能仍可用')
    expect(document.body.textContent).toContain('BACKUP_FAILED')
    expect(document.body.textContent).toContain('原始数据与附件')
    expect(document.body.textContent).toContain('本页只读')
    expect(document.body.textContent).not.toContain('开始恢复')
    expect(document.body.textContent).not.toContain('执行 Shell')
    wrapper.unmount()
  })

  it('shows an explainable error and can retry the status read', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1
      if (attempts === 1) return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '状态暂时不可用' } }, 503)
      return jsonResponse(statusFixture())
    }))
    const wrapper = await mountWithRouter(OperationsStatusView, '/settings/operations')
    await flushPromises()
    expect(document.body.textContent).toContain('状态暂时不可用')

    buttonByText('重新读取').click()
    await flushPromises()
    expect(attempts).toBe(2)
    expect(document.body.textContent).toContain('系统状态概览')
    wrapper.unmount()
  })

  it('documents the v1 boundaries without advertising deferred capabilities', async () => {
    const wrapper = await mountWithRouter(HelpView, '/help')
    await flushPromises()

    expect(document.body.textContent).toContain('原始事实 · 不覆盖')
    expect(document.body.textContent).toContain('SHA-256')
    expect(document.body.textContent).toContain('不执行 Shell、SSH、SQL')
    expect(document.body.textContent).toContain('不提供向量语义搜索')
    expect(document.body.textContent).not.toContain('OAuth')
    expect(document.body.textContent).not.toContain('MD5')
    wrapper.unmount()
  })
})

async function mountWithRouter(component: object, path: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.stage = 'authenticated'
  auth.csrfToken = 'csrf-test'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/operations', name: 'operations-settings', component: { template: '<div />' } },
      { path: '/help', name: 'help', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  return mount(component, { attachTo: document.body, global: { plugins: [pinia, router] } })
}

function statusFixture(): OperationsStatus {
  return {
    checkedAt: '2026-08-30T01:00:00Z', version: 'v1.0.0', schemaVersion: 6,
    overall: 'degraded', coreAvailable: true,
    components: [
      { id: 'api', label: 'API', status: 'healthy', summary: '进程正在响应' },
      { id: 'postgres', label: 'PostgreSQL', status: 'healthy', summary: 'Schema 已应用' },
      { id: 'ai-worker', label: 'AI Worker', status: 'degraded', summary: '不可达；核心记录功能仍可用' },
      { id: 'attachments', label: '附件存储', status: 'healthy', summary: '原始附件卷可读写' },
    ],
    providers: [{ id: 'provider-1', displayName: '本地 Mock', status: 'healthy', lastTestedAt: '2026-08-30T00:50:00Z', latencyMs: 12, failureCategory: null }],
    queue: { queued: 2, running: 0, oldestQueuedAt: '2026-08-30T00:55:00Z', lastHeartbeatAt: null },
    storage: { attachmentCount: 12, attachmentBytes: 4096, capacityBytes: 100_000, availableBytes: 80_000, writable: true },
    backup: { state: 'failed', lastAttemptAt: '2026-08-30T00:30:00Z', lastSuccessAt: null, snapshotId: '', targetLabel: '测试仓库', resticCheckAt: null, errorCode: 'BACKUP_FAILED' },
    restore: { state: 'not_run', verifiedAt: null, snapshotId: '', referencedAttachments: 0, verifiedAttachments: 0, orphanAttachments: 0, errorCode: '' },
    release: {
      candidateVersion: 'v1.0.0', generatedAt: '2026-08-30T00:40:00Z',
      checks: [
        { id: 'data_integrity', label: '原始数据与附件', status: 'passed', summary: '完整性检查通过', checkedAt: '2026-08-30T00:40:00Z' },
        { id: 'browser_accessibility', label: '浏览器与可访问性', status: 'not_run', summary: '等待浏览器矩阵', checkedAt: null },
      ],
    },
  }
}

function buttonByText(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent?.trim().includes(text))
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

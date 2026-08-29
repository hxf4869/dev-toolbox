import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import QuickCaptureDrawer from './QuickCaptureDrawer.vue'

describe('QuickCaptureDrawer', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => 'capture-idempotency-key' })
  })

  it('preserves exact text and reuses the same idempotency key after a network failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            item: {
              id: 'item-1',
              title: '敏感记录 · 08-30 10:00',
              sensitivity: 'sensitive',
              createdAt: '2026-08-30T02:00:00Z',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-value'

    const wrapper = mount(QuickCaptureDrawer, {
      props: { open: true },
      attachTo: document.body,
    })
    await flushPromises()

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = '  keep exact whitespace\n<script>raw</script>  '
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const sensitivity = document.querySelector('input[role="switch"]') as HTMLInputElement
    sensitivity.click()
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    )
    await flushPromises()

    const retry = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重试'),
    ) as HTMLButtonElement
    retry.click()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    const firstPayload = JSON.parse(String(firstInit.body)) as {
      body: string
      sensitivity: string
    }
    expect(firstPayload.body).toBe('  keep exact whitespace\n<script>raw</script>  ')
    expect(firstPayload.sensitivity).toBe('sensitive')
    expect(new Headers(firstInit.headers).get('Idempotency-Key')).toBe(
      'capture-idempotency-key',
    )
    expect(new Headers(secondInit.headers).get('Idempotency-Key')).toBe(
      'capture-idempotency-key',
    )
    expect(wrapper.emitted('created')).toHaveLength(1)

    wrapper.unmount()
  })
})

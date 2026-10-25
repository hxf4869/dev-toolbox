import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import QuickCaptureDrawer from './QuickCaptureDrawer.vue'
import { useLibraryStore } from './library'

// '脉' is 3 bytes in UTF-8: 349,526 chars -> 1,048,578 bytes (over 1 MiB),
// 349,525 chars -> 1,048,575 bytes (within the 1 MiB contract limit).
const OVER_LIMIT_CHARS = 349_526
const WITHIN_LIMIT_CHARS = 349_525

function setBody(value: string) {
  const textarea = document.querySelector('textarea') as HTMLTextAreaElement
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

function findSaveButton() {
  return Array.from(document.querySelectorAll('.capture-drawer__footer button')).find((button) =>
    button.textContent?.includes('保存记录'),
  ) as HTMLButtonElement
}

describe('QuickCaptureDrawer body byte limit', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => 'capture-idempotency-key' })
  })

  it('disables submit and shows byte usage when a multi-byte body exceeds 1 MiB, then recovers after trimming', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-value'

    const wrapper = mount(QuickCaptureDrawer, {
      props: { open: true },
      attachTo: document.body,
    })
    await flushPromises()

    setBody('脉'.repeat(OVER_LIMIT_CHARS))
    await flushPromises()

    const saveButton = findSaveButton()
    expect(saveButton.disabled).toBe(true)

    const hint = document.querySelector('.body-limit-warning')
    expect(hint?.getAttribute('role')).toBe('alert')
    expect(hint?.textContent).toContain('1,048,578')
    expect(hint?.textContent).toContain('1,048,576')

    // The keyboard shortcut must not bypass the disabled submit either.
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    )
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()

    // Trim within the limit: submit is re-enabled and the content is kept whole.
    const trimmed = '脉'.repeat(WITHIN_LIMIT_CHARS)
    setBody(trimmed)
    await flushPromises()
    expect(document.querySelector('.body-limit-warning')).toBeNull()

    expect(findSaveButton().disabled).toBe(false)
    findSaveButton().click()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const payload = JSON.parse(String(init.body)) as { body: string }
    expect(payload.body).toBe(trimmed)
    expect(payload.body.length).toBe(WITHIN_LIMIT_CHARS)

    wrapper.unmount()
  })

  it('warns that a custom title of a sensitive record appears verbatim in list and search', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-value'

    const wrapper = mount(QuickCaptureDrawer, {
      props: { open: true },
      attachTo: document.body,
    })
    await flushPromises()

    const sensitivity = document.querySelector('input[role="switch"]') as HTMLInputElement
    sensitivity.click()
    await flushPromises()
    expect(document.querySelector('.sensitive-banner')?.textContent).toContain('安全标题')
    expect(document.querySelector('.sensitive-banner')?.textContent).not.toContain('自定义标题')

    const titleInput = document.querySelector('.capture-options input') as HTMLInputElement
    titleInput.value = '生产数据库密码'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const banner = document.querySelector('.sensitive-banner')
    expect(banner?.textContent).toContain('自定义标题会以原文出现在列表与搜索结果中')

    titleInput.value = ''
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('.sensitive-banner')?.textContent).toContain('安全标题')
    expect(document.querySelector('.sensitive-banner')?.textContent).not.toContain('自定义标题')

    wrapper.unmount()
  })
})

describe('QuickCaptureDrawer saving lock gate', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => 'capture-idempotency-key' })
  })

  function findFooterSaveButton() {
    // While saving the footer label switches to “正在保存”, so the
    // text-matching findSaveButton() helper cannot locate it mid-flight;
    // select the same button by its stable primary variant class instead.
    return document.querySelector<HTMLButtonElement>('.capture-drawer__footer .button--primary')
  }

  it('locks every input while saving, drops pasted files, and unlocks after success', async () => {
    let resolvePost!: (value: Response) => void
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolvePost = resolve
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-value'
    useLibraryStore().tags = [{ id: 'tag-1', name: '标签一', itemCount: 0 }]

    const wrapper = mount(QuickCaptureDrawer, {
      props: { open: true },
      attachTo: document.body,
    })
    await flushPromises()

    setBody('保存中锁输入')

    const file = new File(['sync-fixture'], 'gate-notes.txt', { type: 'text/plain' })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    findSaveButton().click()
    await flushPromises()

    // In flight: exactly one request under the saving overlay.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.saving-state')).not.toBeNull()
    expect(findFooterSaveButton()?.disabled).toBe(true)

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    const titleInput = document.querySelector<HTMLInputElement>(
      '.capture-options input[maxlength="200"]',
    )
    const formatButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.capture-toolbar button'),
    )
    expect(formatButtons).toHaveLength(2)
    expect(textarea.readOnly).toBe(true)
    expect(titleInput?.readOnly).toBe(true)
    expect(document.querySelector<HTMLSelectElement>('.capture-options select')?.disabled).toBe(true)
    expect(document.querySelector<HTMLInputElement>('input[role="switch"]')?.disabled).toBe(true)
    expect(formatButtons.map((button) => button.disabled)).toEqual([true, true])
    expect(document.querySelector<HTMLButtonElement>('.attachments header button')?.disabled).toBe(
      true,
    )
    expect(document.querySelector<HTMLButtonElement>('.attachments li button')?.disabled).toBe(true)
    expect(document.querySelector<HTMLInputElement>('.capture-tag input')?.disabled).toBe(true)

    // Pasting a new file mid-save must not join the in-flight submission.
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [new File(['paste'], 'paste-attempt.txt', { type: 'text/plain' })] },
    })
    textarea.dispatchEvent(pasteEvent)
    await flushPromises()

    expect(document.querySelectorAll('.attachments li')).toHaveLength(1)
    expect(document.querySelector('.attachments')?.textContent).not.toContain('paste-attempt')

    resolvePost(
      new Response(
        JSON.stringify({
          item: {
            id: 'item-gate',
            title: 'gate 标题',
            sensitivity: 'normal',
            createdAt: '2026-10-22T00:00:00Z',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    await flushPromises()

    // Success: everything unlocks and the form clears per the existing contract.
    expect(document.querySelector('.saving-state')).toBeNull()
    expect((document.querySelector('textarea') as HTMLTextAreaElement).readOnly).toBe(false)
    expect(
      document.querySelector<HTMLInputElement>('.capture-options input[maxlength="200"]')?.readOnly,
    ).toBe(false)
    expect(document.querySelector<HTMLSelectElement>('.capture-options select')?.disabled).toBe(
      false,
    )
    expect(document.querySelector<HTMLInputElement>('input[role="switch"]')?.disabled).toBe(false)
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.capture-toolbar button')).map(
        (button) => button.disabled,
      ),
    ).toEqual([false, false])
    expect(document.querySelector<HTMLButtonElement>('.attachments header button')?.disabled).toBe(
      false,
    )
    expect(document.querySelector<HTMLInputElement>('.capture-tag input')?.disabled).toBe(false)
    expect(document.querySelector('.attachments li button')).toBeNull()
    const successState = document.querySelector('.capture-state--success')
    expect(successState?.textContent).toContain('已保存')
    expect(successState?.textContent).toContain('可以继续录入下一条')
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')
    expect(document.querySelectorAll('.attachments li')).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The drawer is ready for the next record without a remount.
    setBody('下一条')
    await flushPromises()
    expect(findSaveButton().disabled).toBe(false)

    wrapper.unmount()
  })

  it('unlocks and keeps the body verbatim after a network failure, with retry available but not auto-resent', async () => {
    let rejectPost!: (reason?: unknown) => void
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((_, reject) => {
        rejectPost = reject
      }),
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

    const originalBody = '  keep exact whitespace\nsecond line  '
    setBody(originalBody)
    await flushPromises()

    findSaveButton().click()
    await flushPromises()

    expect(document.querySelector('.saving-state')).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    rejectPost(new TypeError('network disconnected'))
    await flushPromises()

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(document.querySelector('.saving-state')).toBeNull()
    expect(textarea.readOnly).toBe(false)
    expect(
      document.querySelector<HTMLInputElement>('.capture-options input[maxlength="200"]')?.readOnly,
    ).toBe(false)
    expect(document.querySelector<HTMLSelectElement>('.capture-options select')?.disabled).toBe(
      false,
    )
    expect(document.querySelector<HTMLInputElement>('input[role="switch"]')?.disabled).toBe(false)
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.capture-toolbar button')).map(
        (button) => button.disabled,
      ),
    ).toEqual([false, false])
    expect(textarea.value).toBe(originalBody)
    const errorState = document.querySelector('.capture-state--error')
    expect(errorState?.textContent).toContain('网络连接中断，内容已保留')
    const retryButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.capture-state--error button'),
    ).find((button) => button.textContent?.includes('重试'))
    expect(retryButton).toBeDefined()
    expect(retryButton?.disabled).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })
})

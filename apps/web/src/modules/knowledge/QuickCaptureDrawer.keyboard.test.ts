import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import QuickCaptureDrawer from './QuickCaptureDrawer.vue'

const DRAFT = '  keyboard draft\nsecond line  '

function setBody(value: string) {
  const textarea = document.querySelector('textarea') as HTMLTextAreaElement
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

// While saving the footer label switches to “正在保存”, so locate the
// submit button by its stable primary variant class instead of its text.
function findFooterSaveButton() {
  return document.querySelector<HTMLButtonElement>('.capture-drawer__footer .button--primary')
}

function activeElement() {
  return document.activeElement as HTMLElement
}

function pressKey(target: Element, init: KeyboardEventInit & { keyCode?: number }) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

describe('QuickCaptureDrawer keyboard cancel, IME and busy focus', () => {
  let wrapper: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => 'capture-idempotency-key' })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.unstubAllGlobals()
  })

  async function openDrawer(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-value'
    const mounted = mount(QuickCaptureDrawer, {
      props: { open: false },
      attachTo: document.body,
    })
    wrapper = mounted
    await mounted.setProps({ open: true })
    await flushPromises()
  }

  it('opens the discard confirm on Escape and returns to the editor on a second Escape from the focused keep-editing button', async () => {
    const fetchMock = vi.fn()
    await openDrawer(fetchMock)

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    setBody(DRAFT)
    await flushPromises()
    expect(findFooterSaveButton()?.disabled).toBe(false)
    expect(document.activeElement).toBe(textarea)

    // First Escape from the editor opens the discard confirmation.
    pressKey(activeElement(), { key: 'Escape' })
    await flushPromises()

    expect(document.querySelector('.discard-state')).not.toBeNull()
    const keepEditing = activeElement()
    expect(keepEditing.textContent).toContain('继续编辑')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper?.emitted('close')).toBeUndefined()

    // Second Escape from the focused “继续编辑” must close the topmost
    // (inner) confirm and hand focus back to the editor, still without
    // closing the drawer or submitting anything.
    pressKey(activeElement(), { key: 'Escape' })
    await flushPromises()

    expect(document.querySelector('.discard-state')).toBeNull()
    expect(document.activeElement).toBe(textarea)
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(DRAFT)
    expect(wrapper?.emitted('close')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a composing Escape in the editor without opening the discard confirm or losing the draft', async () => {
    const fetchMock = vi.fn()
    await openDrawer(fetchMock)

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    setBody(DRAFT)
    await flushPromises()
    expect(document.activeElement).toBe(textarea)

    // Escape while an IME composition is in progress must be left to the
    // IME itself: no confirm, no close, no content loss, no request.
    pressKey(activeElement(), { key: 'Escape', isComposing: true })
    await flushPromises()

    expect(document.querySelector('.discard-state')).toBeNull()
    expect(wrapper?.emitted('close')).toBeUndefined()
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(DRAFT)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a composing Ctrl+Enter while the plain shortcut still submits exactly once', async () => {
    // A fully valid 201 from the start: if the IME guard regresses, a stray
    // POST takes the normal success path instead of throwing on undefined,
    // so the zero-call assertions stay the real evidence.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          item: {
            id: 'item-kb',
            title: 'kb 标题',
            sensitivity: 'normal',
            createdAt: '2026-10-22T00:00:00Z',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    await openDrawer(fetchMock)

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    setBody(DRAFT)
    await flushPromises()
    expect(document.activeElement).toBe(textarea)

    // Ctrl+Enter during IME composition must not trigger a save request.
    pressKey(activeElement(), { key: 'Enter', ctrlKey: true, isComposing: true })
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(0)
    expect(textarea.value).toBe(DRAFT)

    // Safari's composition-confirm keydown arrives as keyCode 229 with
    // isComposing=false (WebKit bug 324380); this shape must not save either.
    pressKey(activeElement(), { key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 229 })
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(0)
    expect(textarea.value).toBe(DRAFT)

    // The same shortcut outside composition must keep working and save once.
    pressKey(activeElement(), { key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 13 })
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(wrapper?.emitted('created')).toHaveLength(1)
  })

  it('keeps focus on the readonly body while saving and does not auto-resend after a rejection', async () => {
    let rejectPost!: (reason?: unknown) => void
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((_, reject) => {
        rejectPost = reject
      }),
    )
    await openDrawer(fetchMock)

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    setBody(DRAFT)
    await flushPromises()

    const saveButton = findFooterSaveButton() as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    saveButton.focus()
    saveButton.click()
    await flushPromises()

    // In flight: exactly one request under the saving overlay.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.saving-state')).not.toBeNull()

    await flushPromises()
    // Busy focus must land on the readonly body, not stay on the now
    // disabled submit button and not fall back to document.body.
    expect(document.activeElement).toBe(textarea)
    expect((activeElement() as HTMLTextAreaElement).readOnly).toBe(true)
    expect(document.activeElement).not.toBe(document.body)

    // Escape during the save must neither close the drawer nor open the
    // discard confirmation on top of the saving overlay.
    pressKey(activeElement(), { key: 'Escape' })
    await flushPromises()

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('.discard-state')).toBeNull()
    expect(wrapper?.emitted('close')).toBeUndefined()

    rejectPost(new TypeError('network disconnected'))
    await flushPromises()

    // Unlocked after failure: content verbatim, focus still on the usable
    // editor inside the drawer, and no automatic retry request.
    expect(document.querySelector('.saving-state')).toBeNull()
    const bodyAfter = document.querySelector('textarea') as HTMLTextAreaElement
    expect(bodyAfter.readOnly).toBe(false)
    expect(bodyAfter.value).toBe(DRAFT)
    expect(document.activeElement).toBe(bodyAfter)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

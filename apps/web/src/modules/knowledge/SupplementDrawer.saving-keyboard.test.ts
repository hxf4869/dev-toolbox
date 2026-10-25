import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import SupplementDrawer from './SupplementDrawer.vue'

// 抽屉在保存挂起期间必须进入“只读快照”状态：正文 textarea 只读但仍可聚焦，
// 全部 select 与附件、关闭、取消控件禁用；请求负载以发起保存那一刻为准，
// 挂起期间再合成的附件选择不得改写已提交内容。失败后草稿逐字保留并解锁，
// 不自动重发。Escape 在 IME 组合期间属于输入法，不得触发放弃确认。
const baseProps = {
  itemId: 'item-1',
  rawRecords: [
    { id: 'raw-1', recordRole: 'primary', effectiveCapturedAt: '2026-08-30T02:00:00Z' },
    { id: 'raw-2', recordRole: 'supplement', effectiveCapturedAt: '2026-08-30T03:30:00Z' },
  ],
  currentSensitivity: 'normal' as const,
}

function setBody(value: string) {
  const textarea = document.querySelector('.supplement-drawer textarea') as HTMLTextAreaElement
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

function setSelect(select: HTMLSelectElement, value: string) {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

// keyCode 直接放进 init 在本仓库 jsdom 下可用（同 QuickCaptureDrawer.keyboard.test.ts）。
function pressKey(target: Element, init: KeyboardEventInit & { keyCode?: number }) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

function activeElement() {
  return document.activeElement as HTMLElement
}

function findTextarea() {
  return document.querySelector<HTMLTextAreaElement>('.supplement-drawer textarea')
}

// 文档顺序：[0] 格式、[1] 敏感状态、[2] 关系、[3] 目标原始记录。
function findSelects() {
  return Array.from(document.querySelectorAll<HTMLSelectElement>('.supplement-drawer select'))
}

// 保存按钮文案在保存期间切换为“正在保存”，必须用稳定的 primary 变体类定位。
function findSaveButton() {
  return document.querySelector<HTMLButtonElement>('.supplement-drawer > footer .button--primary')
}

function findCancelButton() {
  return document.querySelector<HTMLButtonElement>('.supplement-drawer > footer .button--ghost')
}

function findCloseButton() {
  return document.querySelector<HTMLButtonElement>('.supplement-drawer > header button')
}

function findChooseFilesButton() {
  return document.querySelector<HTMLButtonElement>('.supplement-files .button--secondary')
}

function findFileInput() {
  return document.querySelector<HTMLInputElement>('.supplement-files input[type="file"]')
}

function selectFileViaInput(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('SupplementDrawer saving draft protection and IME cancel', () => {
  let wrapper: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => 'supplement-idempotency-key' })
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
    const mounted = mount(SupplementDrawer, {
      props: { open: false, ...baseProps },
      attachTo: document.body,
    })
    wrapper = mounted
    await mounted.setProps({ open: true })
    await flushPromises()
  }

  it('locks every native control on a frozen snapshot while a multipart save is pending and unlocks after success', async () => {
    let resolvePost!: (value: Response) => void
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolvePost = resolve
      }),
    )
    await openDrawer(fetchMock)

    setBody('multipart 正文')
    const selects = findSelects()
    setSelect(selects[0] as HTMLSelectElement, 'markdown')
    setSelect(selects[1] as HTMLSelectElement, 'sensitive')
    setSelect(selects[2] as HTMLSelectElement, 'supersedes')
    setSelect(selects[3] as HTMLSelectElement, 'raw-2')
    selectFileViaInput(
      findFileInput() as HTMLInputElement,
      new File(['内容'], 'a.txt', { type: 'text/plain' }),
    )
    await flushPromises()

    const saveButton = findSaveButton() as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    saveButton.focus()
    saveButton.click()
    await flushPromises()

    // 挂起期间只发起一次 multipart 请求，负载是点击那一刻的快照。
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/items/item-1/raw-records:multipart')
    const form = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as FormData
    const metadata = JSON.parse(String(form.get('metadata'))) as {
      body: string
      contentFormat: string
      sensitivity: string
      relation: { type: string; targetRawRecordId: string }
    }
    expect(metadata.body).toBe('multipart 正文')
    expect(metadata.contentFormat).toBe('markdown')
    expect(metadata.sensitivity).toBe('sensitive')
    expect(metadata.relation).toEqual({ type: 'supersedes', targetRawRecordId: 'raw-2' })
    expect(form.getAll('files[]')).toHaveLength(1)
    expect((form.getAll('files[]')[0] as File).name).toBe('a.txt')

    // 正文只读且仍可聚焦（焦点由组件修复到它自身），四个 select 全部禁用。
    const textarea = findTextarea() as HTMLTextAreaElement
    expect(textarea.readOnly).toBe(true)
    const pendingSelects = findSelects()
    expect(pendingSelects).toHaveLength(4)
    expect(pendingSelects[0]?.disabled).toBe(true)
    expect(pendingSelects[1]?.disabled).toBe(true)
    expect(pendingSelects[2]?.disabled).toBe(true)
    expect(pendingSelects[3]?.disabled).toBe(true)
    // 附件选择入口、隐藏 input、移除按钮、header 关闭与底部取消全部禁用。
    expect(findChooseFilesButton()?.disabled).toBe(true)
    expect(findFileInput()?.disabled).toBe(true)
    expect(
      document.querySelector<HTMLButtonElement>('.supplement-files li button')?.disabled,
    ).toBe(true)
    expect(findCloseButton()?.disabled).toBe(true)
    expect(findCancelButton()?.disabled).toBe(true)
    // 保存按钮已禁用，焦点必须落在只读正文上而不是停留在禁用按钮或 body。
    expect(document.activeElement).toBe(textarea)

    // 挂起期间再合成一次文件选择，不得替换快照里已提交的附件，也不得报错。
    selectFileViaInput(
      findFileInput() as HTMLInputElement,
      new File(['second'], 'b.txt', { type: 'text/plain' }),
    )
    await flushPromises()
    expect(document.querySelector('.supplement-files li span')?.textContent).toBe('a.txt')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.supplement-error')).toBeNull()

    resolvePost(
      new Response(JSON.stringify({}), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await flushPromises()

    // 成功后表单复位、created/close 各发出一次，全部锁解除。
    expect(findTextarea()?.value).toBe('')
    expect(document.querySelector('.supplement-files ul')).toBeNull()
    expect(wrapper?.emitted('created')).toHaveLength(1)
    expect(wrapper?.emitted('close')).toHaveLength(1)
    expect(findTextarea()?.readOnly).toBe(false)
    for (const select of findSelects()) expect(select.disabled).toBe(false)
    expect(findChooseFilesButton()?.disabled).toBe(false)
    expect(findFileInput()?.disabled).toBe(false)
    expect(findCloseButton()?.disabled).toBe(false)
    expect(findCancelButton()?.disabled).toBe(false)
  })

  it('keeps the draft verbatim and unlocks every control after a JSON save is rejected', async () => {
    let rejectPost!: (reason?: unknown) => void
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((_, reject) => {
        rejectPost = reject
      }),
    )
    await openDrawer(fetchMock)

    const draft = '  saving draft\nsecond line  '
    setBody(draft)
    const selects = findSelects()
    setSelect(selects[0] as HTMLSelectElement, 'markdown')
    setSelect(selects[1] as HTMLSelectElement, 'sensitive')
    setSelect(selects[2] as HTMLSelectElement, 'supersedes')
    setSelect(selects[3] as HTMLSelectElement, 'raw-2')
    await flushPromises()

    const saveButton = findSaveButton() as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    saveButton.click()
    await flushPromises()

    // 无附件时必须走普通 JSON 端点，并同样进入挂起锁。
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/items/item-1/raw-records')
    expect(findTextarea()?.readOnly).toBe(true)
    expect(findSelects()[0]?.disabled).toBe(true)

    rejectPost(new TypeError('network disconnected'))
    await flushPromises()

    // 网络层失败：错误提示出现；草稿逐字保留（含首尾空格与内部换行），全部
    // 选项保持原值并解锁，不自动重发请求。
    expect(document.querySelector('.supplement-error')).not.toBeNull()
    expect(findTextarea()?.value).toBe(draft)
    const keptSelects = findSelects()
    expect(keptSelects.map((select) => select.value)).toEqual([
      'markdown',
      'sensitive',
      'supersedes',
      'raw-2',
    ])
    for (const select of keptSelects) expect(select.disabled).toBe(false)
    expect(findTextarea()?.readOnly).toBe(false)
    expect(findChooseFilesButton()?.disabled).toBe(false)
    expect(findCloseButton()?.disabled).toBe(false)
    expect(findCancelButton()?.disabled).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ignores a composing Escape while the plain Escape flow keeps opening and closing the discard confirm', async () => {
    const fetchMock = vi.fn()
    await openDrawer(fetchMock)

    const draft = '  keyboard draft\nsecond line  '
    const textarea = findTextarea() as HTMLTextAreaElement
    setBody(draft)
    await flushPromises()
    expect(findSaveButton()?.disabled).toBe(false)
    expect(document.activeElement).toBe(textarea)

    // (a) 组合中的 Escape 属于输入法，不得打开放弃确认，也不得关闭或提交。
    pressKey(activeElement(), { key: 'Escape', isComposing: true })
    await flushPromises()
    expect(document.querySelector('.supplement-discard')).toBeNull()
    expect(wrapper?.emitted('close')).toBeUndefined()
    expect(textarea.value).toBe(draft)
    expect(fetchMock).not.toHaveBeenCalled()

    // (b) Safari 的组合确认形态（keyCode 229 且 isComposing=false）同样放行给输入法。
    pressKey(activeElement(), { key: 'Escape', isComposing: false, keyCode: 229 })
    await flushPromises()
    expect(document.querySelector('.supplement-discard')).toBeNull()
    expect(wrapper?.emitted('close')).toBeUndefined()
    expect(textarea.value).toBe(draft)
    expect(fetchMock).not.toHaveBeenCalled()

    // (c) 普通 Escape：打开放弃确认，焦点移入其中的“继续编辑”按钮，草稿保留。
    pressKey(activeElement(), { key: 'Escape' })
    await flushPromises()
    const discard = document.querySelector('.supplement-discard')
    expect(discard).not.toBeNull()
    const keepEditing = activeElement()
    expect(discard?.contains(keepEditing)).toBe(true)
    expect(keepEditing.textContent).toContain('继续编辑')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper?.emitted('close')).toBeUndefined()
    expect(textarea.value).toBe(draft)

    // (d) 第二次 Escape 只关闭内层确认，焦点回到正文，草稿与关闭状态不变。
    pressKey(activeElement(), { key: 'Escape' })
    await flushPromises()
    expect(document.querySelector('.supplement-discard')).toBeNull()
    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe(draft)
    expect(wrapper?.emitted('close')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

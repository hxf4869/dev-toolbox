import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { vi } from 'vitest'

import { useAuthStore } from '../../app/auth'
import SupplementDrawer from './SupplementDrawer.vue'

// '脉' is 3 bytes in UTF-8: 349,526 chars -> 1,048,578 bytes (over 1 MiB),
// 349,525 chars -> 1,048,575 bytes (within the 1 MiB contract limit).
const OVER_LIMIT_CHARS = 349_526
const WITHIN_LIMIT_CHARS = 349_525

const baseProps = {
  itemId: 'item-1',
  rawRecords: [{ id: 'raw-1', recordRole: 'primary', effectiveCapturedAt: '2026-08-30T02:00:00Z' }],
  currentSensitivity: 'normal' as const,
}

function setBody(value: string) {
  const textarea = document.querySelector('.supplement-drawer textarea') as HTMLTextAreaElement
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

function findSaveButton() {
  return Array.from(document.querySelectorAll('.supplement-drawer > footer button')).find(
    (button) => button.textContent?.includes('保存补充记录'),
  ) as HTMLButtonElement
}

function findFileInput() {
  return document.querySelector<HTMLInputElement>('.supplement-files input[type="file"]')
}

function selectFilesViaInput(input: HTMLInputElement, selected: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: selected })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function listedFileNames() {
  return Array.from(document.querySelectorAll('.supplement-files li span')).map(
    (span) => span.textContent,
  )
}

// 用虚假 size 模拟大文件边界，避免测试真实分配 20–100 MiB 内存。
function fileOfSize(name: string, size: number) {
  const file = new File(['x'], name, { type: 'application/octet-stream' })
  Object.defineProperty(file, 'size', { configurable: true, value: size })
  return file
}

describe('SupplementDrawer boundary and retry', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('disables submit and shows byte usage when a multi-byte body exceeds 1 MiB, then recovers after trimming', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', { randomUUID: () => 'supplement-idempotency-key' })
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-value'

    const wrapper = mount(SupplementDrawer, {
      props: { open: true, ...baseProps },
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

  it('shows a Chinese network error, keeps the input, and retries with the same idempotency key', async () => {
    let uuidCalls = 0
    vi.stubGlobal('crypto', { randomUUID: () => `supplement-key-${++uuidCalls}` })
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-value'

    const wrapper = mount(SupplementDrawer, {
      props: { open: true, ...baseProps },
      attachTo: document.body,
    })
    await flushPromises()

    setBody('磁盘实际为 /dev/vdb')
    await flushPromises()
    findSaveButton().click()
    await flushPromises()

    const error = document.querySelector('.supplement-error')
    expect(error?.textContent).toContain('网络连接中断')
    expect(error?.textContent).toContain('内容已保留')
    expect(error?.textContent).not.toContain('Failed to fetch')

    const textarea = document.querySelector('.supplement-drawer textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('磁盘实际为 /dev/vdb')

    const retry = error?.querySelector('button')
    expect(retry?.textContent).toContain('重试')
    retry?.click()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstKey = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get(
      'Idempotency-Key',
    )
    const secondKey = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).get(
      'Idempotency-Key',
    )
    expect(firstKey).toBe('supplement-key-1')
    expect(secondKey).toBe('supplement-key-1')
    expect(wrapper.emitted('created')).toHaveLength(1)

    wrapper.unmount()
  })
})

describe('SupplementDrawer consecutive attachment selection', () => {
  let wrapper: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.stage = 'authenticated'
    auth.csrfToken = 'csrf-value'
    wrapper = mount(SupplementDrawer, {
      props: { open: true, ...baseProps },
      attachTo: document.body,
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('accumulates files across consecutive selections instead of replacing the earlier batch', async () => {
    const input = findFileInput() as HTMLInputElement
    selectFilesViaInput(input, [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ])
    await flushPromises()
    expect(listedFileNames()).toEqual(['a.txt', 'b.txt'])

    selectFilesViaInput(input, [new File(['c'], 'c.txt', { type: 'text/plain' })])
    await flushPromises()
    expect(listedFileNames()).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(document.querySelector('.supplement-drawer > footer > span')?.textContent).toContain(
      '3 个文件',
    )
  })

  it('keeps the accepted files when a later selection is empty or entirely rejected', async () => {
    const input = findFileInput() as HTMLInputElement
    selectFilesViaInput(input, [new File(['a'], 'a.txt', { type: 'text/plain' })])
    await flushPromises()

    selectFilesViaInput(input, [])
    await flushPromises()
    expect(listedFileNames()).toEqual(['a.txt'])

    selectFilesViaInput(input, [fileOfSize('big.bin', 21 * 1024 * 1024)])
    await flushPromises()
    expect(listedFileNames()).toEqual(['a.txt'])
    const error = document.querySelector('.supplement-error')
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain('“big.bin”超过 20 MiB')
  })

  it('enforces the cumulative count cap and keeps the earlier files while dropping only the overflow', async () => {
    const input = findFileInput() as HTMLInputElement
    selectFilesViaInput(
      input,
      Array.from({ length: 9 }, (_, index) => new File(['x'], `a${index}.txt`)),
    )
    await flushPromises()
    expect(listedFileNames()).toHaveLength(9)

    selectFilesViaInput(input, [
      new File(['y'], 'b1.txt'),
      new File(['z'], 'b2.txt'),
    ])
    await flushPromises()
    expect(listedFileNames()).toEqual([
      ...Array.from({ length: 9 }, (_, index) => `a${index}.txt`),
      'b1.txt',
    ])
    expect(document.querySelector('.supplement-error')?.textContent).toContain(
      '单次最多上传 10 个附件。',
    )
  })

  it('rejects a batch that would exceed the cumulative 100 MiB total without dropping earlier files', async () => {
    const input = findFileInput() as HTMLInputElement
    selectFilesViaInput(
      input,
      Array.from({ length: 5 }, (_, index) => fileOfSize(`large-${index}.bin`, 19 * 1024 * 1024)),
    )
    await flushPromises()
    expect(listedFileNames()).toHaveLength(5)
    expect(document.querySelector('.supplement-drawer > footer > span')?.textContent).toContain(
      '95.0 MiB',
    )

    selectFilesViaInput(input, [fileOfSize('overflow.bin', 6 * 1024 * 1024)])
    await flushPromises()
    expect(listedFileNames()).toHaveLength(5)
    expect(document.querySelector('.supplement-error')?.textContent).toContain(
      '本次附件实际总字节不能超过 100 MiB。',
    )
    expect(document.querySelector('.supplement-drawer > footer > span')?.textContent).toContain(
      '95.0 MiB',
    )
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import UrlToolView from './UrlToolView.vue'

function stubClipboard() {
  const clipboard = { readText: vi.fn(), writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('navigator', { ...navigator, clipboard })
  return clipboard
}

function createClipboardRead() {
  let resolve!: (text: string) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text() === text)
  expect(button, `expected to find button ${text}`).toBeTruthy()
  return button!
}

function inputArea(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('#url-input').element as HTMLTextAreaElement
}

function transformOutput(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('textarea[aria-label="URL 转换结果"]').element as HTMLTextAreaElement
}

function queryRowInputs(wrapper: ReturnType<typeof mount>) {
  return wrapper
    .findAll('.query-row')
    .filter((row) => !row.classes().includes('query-row--header'))
    .map((row) => row.findAll('input'))
}

describe('URL tool paste context freshness', () => {
  it('keeps the typed input and its transform result when a deferred paste lands late', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    const paste = createClipboardRead()
    clipboard.readText.mockReturnValueOnce(paste.promise)
    await findButton(wrapper, '粘贴').trigger('click')

    await wrapper.get('#url-input').setValue('a b')
    await findButton(wrapper, '执行编码').trigger('click')
    expect(transformOutput(wrapper).value).toBe('a%20b')

    paste.resolve('https://late.test/pasted')
    await flushPromises()
    await nextTick()
    expect(inputArea(wrapper).value).toBe('a b')
    expect(transformOutput(wrapper).value).toBe('a%20b')
    wrapper.unmount()
  })

  it('does not surface a clipboard error after clearing while a paste is pending on empty input', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    const paste = createClipboardRead()
    clipboard.readText.mockReturnValueOnce(paste.promise)
    await findButton(wrapper, '粘贴').trigger('click')

    await findButton(wrapper, '清空').trigger('click')
    paste.reject(new Error('clipboard denied'))
    await flushPromises()
    await nextTick()
    expect(inputArea(wrapper).value).toBe('')
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps query row drafts when a deferred paste lands late', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await wrapper.get('#url-input').setValue('https://example.test/p?a=1')
    await findButton(wrapper, '解析 URL').trigger('click')

    const paste = createClipboardRead()
    clipboard.readText.mockReturnValueOnce(paste.promise)
    await findButton(wrapper, '粘贴').trigger('click')

    await queryRowInputs(wrapper)[0]![1]!.setValue('9')
    paste.resolve('https://late.test/p?z=2')
    await flushPromises()
    await nextTick()

    expect(inputArea(wrapper).value).toBe('https://example.test/p?a=1')
    expect(wrapper.find('.parts-panel').exists()).toBe(true)
    expect((queryRowInputs(wrapper)[0]![1]!.element as HTMLInputElement).value).toBe('9')
    wrapper.unmount()
  })

  it('applies the newer paste when two pastes overlap', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    const first = createClipboardRead()
    const second = createClipboardRead()
    clipboard.readText.mockReturnValueOnce(first.promise)
    await findButton(wrapper, '粘贴').trigger('click')
    clipboard.readText.mockReturnValueOnce(second.promise)
    await findButton(wrapper, '粘贴').trigger('click')

    second.resolve('https://second.test/b')
    await flushPromises()
    await nextTick()
    first.resolve('https://first.test/a')
    await flushPromises()
    await nextTick()

    expect(inputArea(wrapper).value).toBe('https://second.test/b')
    wrapper.unmount()
  })

  it('applies a paste when nothing else changes afterwards', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.get('#url-input').setValue('old')
    await findButton(wrapper, '执行编码').trigger('click')
    expect(transformOutput(wrapper).value).toBe('old')

    clipboard.readText.mockResolvedValueOnce('https://normal.test/p?a=1')
    await findButton(wrapper, '粘贴').trigger('click')
    await flushPromises()
    await nextTick()

    expect(inputArea(wrapper).value).toBe('https://normal.test/p?a=1')
    expect(transformOutput(wrapper).value).toBe('')
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    wrapper.unmount()
  })

  it('drops a pending paste after a real mode or operation change', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    const modePaste = createClipboardRead()
    clipboard.readText.mockReturnValueOnce(modePaste.promise)
    await findButton(wrapper, '粘贴').trigger('click')
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    modePaste.resolve('https://late-mode.test/x')
    await flushPromises()
    await nextTick()
    expect(inputArea(wrapper).value).toBe('')

    const operationPaste = createClipboardRead()
    clipboard.readText.mockReturnValueOnce(operationPaste.promise)
    await wrapper.findAll('[role="tab"]')[0]!.trigger('click')
    await findButton(wrapper, '粘贴').trigger('click')
    await wrapper.findAll('input[type="radio"]')[1]!.setValue(true)
    operationPaste.resolve('https://late-operation.test/y')
    await flushPromises()
    await nextTick()
    expect(inputArea(wrapper).value).toBe('')
    wrapper.unmount()
  })
})

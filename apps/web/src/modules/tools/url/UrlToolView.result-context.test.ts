import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import UrlToolView from './UrlToolView.vue'

const SOURCE_URL = 'https://example.test/路径?a=一&a=二#片'
const STABLE_URL = 'https://example.test/a?b=1#c'

function stubClipboard() {
  const clipboard = { readText: vi.fn(), writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('navigator', { ...navigator, clipboard })
  return clipboard
}

function createDeferred() {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((res, rej) => {
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

function findButtonByAria(wrapper: ReturnType<typeof mount>, label: string) {
  const button = wrapper
    .findAll('button')
    .find((candidate) => candidate.attributes('aria-label') === label)
  expect(button, `expected to find button ${label}`).toBeTruthy()
  return button!
}

function transformOutput(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('textarea[aria-label="URL 转换结果"]').element as HTMLTextAreaElement
}

function rebuildOutput(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('textarea[aria-label="重新构建的 URL"]').element as HTMLTextAreaElement
}

function queryRowInputs(wrapper: ReturnType<typeof mount>) {
  return wrapper
    .findAll('.query-row')
    .filter((row) => !row.classes().includes('query-row--header'))
    .map((row) => row.findAll('input'))
}

describe('URL tool result context freshness', () => {
  it('clears the transform result and disables copying when the input changes', async () => {
    stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.get('#url-input').setValue('a b')
    await findButton(wrapper, '执行编码').trigger('click')
    expect(transformOutput(wrapper).value).toBe('a%20b')

    await wrapper.get('#url-input').setValue('c d')
    expect(transformOutput(wrapper).value).toBe('')
    expect((findButton(wrapper, '复制结果').element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('clears the transform result when operation or scope changes', async () => {
    stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.get('#url-input').setValue('a b?c=d')
    await findButton(wrapper, '执行编码').trigger('click')
    expect(transformOutput(wrapper).value).toBe('a%20b?c=d')

    const radios = wrapper.findAll('input[type="radio"]')
    await radios[1]!.setValue(true)
    expect(transformOutput(wrapper).value).toBe('')

    await findButton(wrapper, '执行解码').trigger('click')
    expect(transformOutput(wrapper).value).toBe('a b?c=d')

    await radios[3]!.setValue(true)
    expect(transformOutput(wrapper).value).toBe('')
    wrapper.unmount()
  })

  it('keeps inspect results valid when transform options change with the same input', async () => {
    stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await wrapper.get('#url-input').setValue(SOURCE_URL)
    await findButton(wrapper, '解析 URL').trigger('click')
    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe(SOURCE_URL)

    await wrapper.findAll('[role="tab"]')[0]!.trigger('click')
    await wrapper.findAll('input[type="radio"]')[1]!.setValue(true)
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    expect(wrapper.find('.parts-panel').exists()).toBe(true)
    expect(wrapper.get('.parts-panel').text()).toContain('example.test')
    expect(rebuildOutput(wrapper).value).toBe(SOURCE_URL)
    wrapper.unmount()
  })

  it('invalidates the stale parse when the source input changes', async () => {
    stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await wrapper.get('#url-input').setValue('https://old.test/p?a=1')
    await findButton(wrapper, '解析 URL').trigger('click')
    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://old.test/p?a=1')

    await wrapper.get('#url-input').setValue('https://new.test/q?b=2')
    expect(wrapper.find('.parts-panel').exists()).toBe(false)

    await findButton(wrapper, '解析 URL').trigger('click')
    expect(wrapper.get('.parts-panel').text()).toContain('new.test')
    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://new.test/q?b=2')
    wrapper.unmount()
  })

  it('clears the stale rebuild on query row edits while keeping drafts, duplicates and order', async () => {
    stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await wrapper.get('#url-input').setValue('https://example.test/p?a=1&a=2&flag')
    await findButton(wrapper, '解析 URL').trigger('click')
    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://example.test/p?a=1&a=2&flag')

    const rows = () => queryRowInputs(wrapper)
    await rows()[0]![1]!.setValue('9')
    expect(rebuildOutput(wrapper).value).toBe('')
    expect((rows()[0]![1]!.element as HTMLInputElement).value).toBe('9')
    expect(wrapper.get('.live-status').text()).not.toContain('重新构建')

    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://example.test/p?a=9&a=2&flag')

    await rows()[1]![2]!.setValue(false)
    expect(rebuildOutput(wrapper).value).toBe('')
    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://example.test/p?a=9&a&flag')

    await findButton(wrapper, '新增一行').trigger('click')
    await rows()[3]![0]!.setValue('z')
    await rows()[3]![1]!.setValue('3')
    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://example.test/p?a=9&a&flag&z=3')

    await findButtonByAria(wrapper, '删除第 2 行').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('')
    expect((rows()[0]![1]!.element as HTMLInputElement).value).toBe('9')

    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://example.test/p?a=9&flag&z=3')
    wrapper.unmount()
  })

  it('does not revive copy feedback after a mode switch even with identical result texts', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await wrapper.get('#url-input').setValue(STABLE_URL)
    await findButton(wrapper, '解析 URL').trigger('click')
    await findButton(wrapper, '重新构建').trigger('click')

    await wrapper.findAll('[role="tab"]')[0]!.trigger('click')
    await findButton(wrapper, '执行编码').trigger('click')
    expect(transformOutput(wrapper).value).toBe(STABLE_URL)

    const copy = createDeferred()
    clipboard.writeText.mockReturnValueOnce(copy.promise)
    await findButton(wrapper, '复制结果').trigger('click')

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    expect(rebuildOutput(wrapper).value).toBe(STABLE_URL)

    copy.resolve()
    await flushPromises()
    await nextTick()
    expect(wrapper.get('.live-status').text()).not.toContain('结果已复制')
    wrapper.unmount()
  })

  it('does not surface a deferred copy error after the input changes', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.get('#url-input').setValue('a b')
    await findButton(wrapper, '执行编码').trigger('click')

    const copy = createDeferred()
    clipboard.writeText.mockReturnValueOnce(copy.promise)
    await findButton(wrapper, '复制结果').trigger('click')

    await wrapper.get('#url-input').setValue('totally different input')
    copy.reject(new Error('clipboard denied'))
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    wrapper.unmount()
  })

  it('recovers from a copy failure on a successful retry while keeping the result', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.get('#url-input').setValue('a b')
    await findButton(wrapper, '执行编码').trigger('click')
    clipboard.writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    await findButton(wrapper, '复制结果').trigger('click')
    await flushPromises()
    expect(wrapper.find('.error-summary').text()).toContain('复制未成功')
    expect(transformOutput(wrapper).value).toBe('a%20b')
    expect(wrapper.get('.live-status').text()).not.toContain('结果已复制')

    await findButton(wrapper, '复制结果').trigger('click')
    await flushPromises()
    await nextTick()
    expect(clipboard.writeText).toHaveBeenLastCalledWith('a%20b')
    expect(wrapper.get('.live-status').text()).toContain('结果已复制')
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the parse error visible until a valid source is reparsed', async () => {
    stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await wrapper.get('#url-input').setValue('https://example.test/p?x=%2G')
    await findButton(wrapper, '解析 URL').trigger('click')
    expect(wrapper.find('.error-summary').exists()).toBe(true)
    expect(wrapper.get('.error-summary').text()).toContain('转义不完整')
    expect(wrapper.get('#url-input').attributes('aria-invalid')).toBe('true')
    expect((wrapper.get('#url-input').element as HTMLTextAreaElement).value).toBe(
      'https://example.test/p?x=%2G',
    )
    expect(wrapper.find('.parts-panel').exists()).toBe(false)
    expect(wrapper.find('.query-panel').exists()).toBe(false)

    await wrapper.get('#url-input').setValue('https://example.test/p?x=1')
    expect(wrapper.find('.error-summary').exists()).toBe(false)

    await findButton(wrapper, '解析 URL').trigger('click')
    expect(wrapper.get('.parts-panel').text()).toContain('example.test')
    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://example.test/p?x=1')
    wrapper.unmount()
  })
})

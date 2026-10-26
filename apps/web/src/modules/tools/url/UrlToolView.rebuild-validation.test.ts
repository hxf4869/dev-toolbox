import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import UrlToolView from './UrlToolView.vue'

const SOURCE_URL = 'https://example.com/a?x=1&x=2&flag#part'

function stubClipboard() {
  const clipboard = { readText: vi.fn(), writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('navigator', { ...navigator, clipboard })
  return clipboard
}

function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text() === text)
  expect(button, `expected to find button ${text}`).toBeTruthy()
  return button!
}

function inputArea(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('#url-input').element as HTMLTextAreaElement
}

function rebuildOutput(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('textarea[aria-label="重新构建的 URL"]').element as HTMLTextAreaElement
}

function copyButton(wrapper: ReturnType<typeof mount>) {
  return findButton(wrapper, '复制结果').element as HTMLButtonElement
}

function partsField(wrapper: ReturnType<typeof mount>, name: string) {
  const field = wrapper
    .findAll('.parts-panel dl div')
    .find((entry) => entry.get('dt').text() === name)
  expect(field, `expected to find parts field ${name}`).toBeTruthy()
  return field!.get('dd').text()
}

function queryRowInputs(wrapper: ReturnType<typeof mount>) {
  return wrapper
    .findAll('.query-row')
    .filter((row) => !row.classes().includes('query-row--header'))
    .map((row) => row.findAll('input'))
}

function queryDrafts(wrapper: ReturnType<typeof mount>) {
  return queryRowInputs(wrapper).map((inputs) => ({
    key: (inputs[0]!.element as HTMLInputElement).value,
    value: (inputs[1]!.element as HTMLInputElement).value,
    hasEquals: (inputs[2]!.element as HTMLInputElement).checked,
  }))
}

async function mountParsed() {
  const clipboard = stubClipboard()
  const wrapper = mount(UrlToolView)
  await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
  await wrapper.get('#url-input').setValue(SOURCE_URL)
  await findButton(wrapper, '解析 URL').trigger('click')
  return { wrapper, clipboard }
}

describe('URL tool rebuild validation', () => {
  it('rejects an invalid percent escape in a query value, keeps every draft, and recovers after the fix', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { wrapper, clipboard } = await mountParsed()
    const rows = () => queryRowInputs(wrapper)

    await rows()[0]![1]!.setValue('%')
    await findButton(wrapper, '重新构建').trigger('click')

    expect(wrapper.get('.error-summary').text()).toContain('转义不完整')
    expect(wrapper.find('.query-panel .error-summary').exists()).toBe(true)
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1)
    expect(rebuildOutput(wrapper).value).toBe('')
    expect(copyButton(wrapper).disabled).toBe(true)
    expect(wrapper.get('.live-status').text()).not.toContain('重新构建')
    expect(inputArea(wrapper).value).toBe(SOURCE_URL)
    expect(wrapper.get('#url-input').attributes('aria-invalid')).toBe('false')
    expect(partsField(wrapper, 'host')).toBe('example.com')
    expect(partsField(wrapper, 'query')).toBe('x=1&x=2&flag')
    expect(partsField(wrapper, 'fragment')).toBe('part')
    expect(queryDrafts(wrapper)).toEqual([
      { key: 'x', value: '%', hasEquals: true },
      { key: 'x', value: '2', hasEquals: true },
      { key: 'flag', value: '', hasEquals: false },
    ])
    expect(consoleError).not.toHaveBeenCalled()

    await rows()[0]![1]!.setValue('%41')
    expect(wrapper.find('.error-summary').exists()).toBe(false)

    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://example.com/a?x=%41&x=2&flag#part')
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    expect(copyButton(wrapper).disabled).toBe(false)
    expect(wrapper.get('.live-status').text()).toContain('重新构建')

    await findButton(wrapper, '复制结果').trigger('click')
    await flushPromises()
    await nextTick()
    expect(clipboard.writeText).toHaveBeenLastCalledWith('https://example.com/a?x=%41&x=2&flag#part')
    expect(wrapper.get('.live-status').text()).toContain('结果已复制')
    consoleError.mockRestore()
    wrapper.unmount()
  })

  it('rejects an invalid percent escape in a flag key without marking the valid source input invalid', async () => {
    const { wrapper } = await mountParsed()
    const rows = () => queryRowInputs(wrapper)

    await rows()[2]![0]!.setValue('flag%A')
    await findButton(wrapper, '重新构建').trigger('click')

    expect(wrapper.get('.error-summary').text()).toContain('转义不完整')
    expect(wrapper.find('.query-panel .error-summary').exists()).toBe(true)
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1)
    expect(rebuildOutput(wrapper).value).toBe('')
    expect(copyButton(wrapper).disabled).toBe(true)
    expect(wrapper.get('#url-input').attributes('aria-invalid')).toBe('false')
    expect(inputArea(wrapper).value).toBe(SOURCE_URL)
    expect(queryDrafts(wrapper)[2]).toEqual({ key: 'flag%A', value: '', hasEquals: false })

    await rows()[2]![0]!.setValue('flag%41')
    await findButton(wrapper, '重新构建').trigger('click')
    expect(rebuildOutput(wrapper).value).toBe('https://example.com/a?x=1&x=2&flag%41#part')
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    expect(copyButton(wrapper).disabled).toBe(false)
    wrapper.unmount()
  })
})

import { mount } from '@vue/test-utils'

import UrlToolView from './UrlToolView.vue'

const SOURCE_URL = 'https://example.test/路径?a=一&a=二#片'
const ENCODED_URL = 'https://example.test/%E8%B7%AF%E5%BE%84?a=%E4%B8%80&a=%E4%BA%8C#%E7%89%87'

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

async function mountParsedAndRebuilt(wrapper: ReturnType<typeof mount>) {
  await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
  await wrapper.get('#url-input').setValue(SOURCE_URL)
  await findButton(wrapper, '解析 URL').trigger('click')
  await findButton(wrapper, '重新构建').trigger('click')
}

describe('URL tool mode result isolation', () => {
  it('shows and copies the rebuild result, not the encoded text, after switching modes', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    await mountParsedAndRebuilt(wrapper)
    const rebuildOutput = wrapper.get('textarea[aria-label="重新构建的 URL"]')
    expect((rebuildOutput.element as HTMLTextAreaElement).value).toBe(SOURCE_URL)

    await wrapper.findAll('[role="tab"]')[0]!.trigger('click')
    await findButton(wrapper, '执行编码').trigger('click')
    expect((wrapper.get('textarea[aria-label="URL 转换结果"]').element as HTMLTextAreaElement).value).toBe(
      ENCODED_URL,
    )

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    expect((wrapper.get('textarea[aria-label="重新构建的 URL"]').element as HTMLTextAreaElement).value).toBe(
      SOURCE_URL,
    )
    await findButton(wrapper, '复制结果').trigger('click')
    expect(clipboard.writeText).toHaveBeenLastCalledWith(SOURCE_URL)
    wrapper.unmount()
  })

  it('copies the transform result while staying in the transform mode', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.get('#url-input').setValue('a b/中文')
    await wrapper.get('button.button--primary').trigger('click')
    await findButton(wrapper, '复制结果').trigger('click')
    expect(clipboard.writeText).toHaveBeenLastCalledWith('a%20b/%E4%B8%AD%E6%96%87')
    expect(wrapper.get('.live-status').text()).toContain('结果已复制')
    wrapper.unmount()
  })

  it('does not show a transform error while in the inspect mode', async () => {
    stubClipboard()
    const wrapper = mount(UrlToolView)

    await wrapper.get('#url-input').setValue('%2G')
    await wrapper.findAll('input[type="radio"]')[1]!.setValue(true)
    await wrapper.get('button.button--primary').trigger('click')
    expect(wrapper.find('.error-summary').exists()).toBe(true)

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    expect(wrapper.get('#url-input').attributes('aria-invalid')).toBe('false')
    wrapper.unmount()
  })
})

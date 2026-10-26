import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

import JwtToolView from './JwtToolView.vue'

function stubClipboard() {
  const clipboard = { readText: vi.fn(), writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('navigator', { ...navigator, clipboard })
  return clipboard
}

function deferred() {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function findButton(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text() === text)
  expect(button, `expected to find button ${text}`).toBeTruthy()
  return button!
}

async function decodeOnly(wrapper: VueWrapper, token: string) {
  await wrapper.get('#jwt-token').setValue(token)
  await wrapper.get('button.button--primary').trigger('click')
  await flushPromises()
}

function tokenFor(subject: string): string {
  return `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ sub: subject }))}.c2lnbmF0dXJl`
}

function base64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

describe('JwtToolView copy feedback ownership', () => {
  it('clears the copy feedback immediately when the token changes, keeping the draft', async () => {
    stubClipboard()
    const wrapper = mount(JwtToolView)

    await decodeOnly(wrapper, tokenFor('DT-R287-first'))
    await findButton(wrapper, '复制 Payload').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.get('.live-status').text()).toContain('Payload 已复制')

    const secondToken = tokenFor('DT-R287-second')
    await wrapper.get('#jwt-token').setValue(secondToken)

    expect(wrapper.get('.live-status').text()).not.toContain('已复制')
    expect(wrapper.text()).not.toContain('Header（已解码）')
    expect((wrapper.get('#jwt-token').element as HTMLTextAreaElement).value).toBe(secondToken)
    wrapper.unmount()
  })

  it('does not revive a late Header copy after the token changed, even with identical Header text', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)

    const firstToken = tokenFor('DT-R287-first')
    const secondToken = tokenFor('DT-R287-second')
    expect(firstToken.split('.')[0]).toBe(secondToken.split('.')[0])

    await decodeOnly(wrapper, firstToken)
    const copy = deferred()
    clipboard.writeText.mockReturnValueOnce(copy.promise)
    await findButton(wrapper, '复制 Header').trigger('click')

    await decodeOnly(wrapper, secondToken)
    expect(wrapper.text()).toContain('DT-R287-second')

    copy.resolve()
    await flushPromises()
    await nextTick()
    expect(wrapper.get('.live-status').text()).not.toContain('已复制')
    wrapper.unmount()
  })

  it('does not surface a late copy failure after everything is cleared', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)

    await decodeOnly(wrapper, tokenFor('DT-R287-clear'))
    const copy = deferred()
    clipboard.writeText.mockReturnValueOnce(copy.promise)
    await findButton(wrapper, '复制 Payload').trigger('click')

    await findButton(wrapper, '清空全部').trigger('click')
    copy.reject(new Error('clipboard denied'))
    await flushPromises()
    await nextTick()

    expect(wrapper.find('.error-summary').exists()).toBe(false)
    expect(wrapper.get('.live-status').text()).not.toContain('已复制')
    expect((wrapper.get('#jwt-token').element as HTMLTextAreaElement).value).toBe('')
    wrapper.unmount()
  })

  it('recovers from a copy failure on a successful retry while keeping the decoded result', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)

    await decodeOnly(wrapper, tokenFor('DT-R287-retry'))
    clipboard.writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    await findButton(wrapper, '复制 Payload').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.get('.error-summary').text()).toContain('复制未成功')
    expect(wrapper.text()).toContain('Header（已解码）')
    const retryButton = findButton(wrapper, '复制 Payload')
    expect((retryButton.element as HTMLButtonElement).disabled).toBe(false)
    expect(wrapper.get('.live-status').text()).not.toContain('已复制')

    await retryButton.trigger('click')
    await flushPromises()
    await nextTick()
    expect(clipboard.writeText).toHaveBeenLastCalledWith(JSON.stringify({ sub: 'DT-R287-retry' }, null, 2))
    expect(wrapper.get('.live-status').text()).toContain('Payload 已复制')
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    wrapper.unmount()
  })

  it('completes an in-flight Header copy when the key or expected claims change after decoding', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)

    await wrapper.get('select').setValue('secret')
    await wrapper.get('#jwt-token').setValue(tokenFor('DT-R287-stable'))
    await wrapper.get('#jwt-key').setValue('first-secret')
    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Header（已解码）')

    const copy = deferred()
    clipboard.writeText.mockReturnValueOnce(copy.promise)
    await findButton(wrapper, '复制 Header').trigger('click')

    await wrapper.get('#jwt-key').setValue('second-secret')
    await wrapper.findAll('.field-grid input')[1]!.setValue('https://other-issuer.example')
    await flushPromises()
    expect(wrapper.text()).toContain('Header（已解码）')
    expect(wrapper.text()).toContain('DT-R287-stable')

    copy.resolve()
    await flushPromises()
    await nextTick()
    expect(clipboard.writeText).toHaveBeenLastCalledWith(JSON.stringify({ alg: 'HS256', typ: 'JWT' }, null, 2))
    expect(wrapper.get('.live-status').text()).toContain('Header 已复制')
    wrapper.unmount()
  })
})

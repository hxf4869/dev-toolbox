import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import JwtToolView from './JwtToolView.vue'

interface Deferred {
  promise: Promise<string>
  resolve: (value: string) => void
  reject: (reason?: unknown) => void
}

function stubClipboard() {
  const clipboard = { readText: vi.fn(), writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('navigator', { ...navigator, clipboard })
  return clipboard
}

function deferred(): Deferred {
  let resolve!: (value: string) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<string>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function findButton(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text() === text)
  expect(button, `expected to find button ${text}`).toBeTruthy()
  return button!
}

function textareaValue(wrapper: VueWrapper, selector: string) {
  return (wrapper.get(selector).element as HTMLTextAreaElement).value
}

function tokenFor(subject: string): string {
  return `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ sub: subject }))}.c2lnbmF0dXJl`
}

function base64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

describe('JwtToolView paste ownership', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps later manual token input over a late clipboard read', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)
    const read = deferred()
    clipboard.readText.mockReturnValueOnce(read.promise)

    await findButton(wrapper, '粘贴 Token').trigger('click')
    await wrapper.get('#jwt-token').setValue(tokenFor('manual-token'))

    read.resolve(tokenFor('clipped-token'))
    await flushPromises()

    expect(textareaValue(wrapper, '#jwt-token')).toBe(tokenFor('manual-token'))
    wrapper.unmount()
  })

  it('keeps later manual key input over a late clipboard read', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)
    await wrapper.get('select').setValue('secret')
    const read = deferred()
    clipboard.readText.mockReturnValueOnce(read.promise)

    await findButton(wrapper, '粘贴密钥').trigger('click')
    await wrapper.get('#jwt-key').setValue('typed-secret')

    read.resolve('clipped-secret')
    await flushPromises()

    expect(textareaValue(wrapper, '#jwt-key')).toBe('typed-secret')
    wrapper.unmount()
  })

  it('invalidates pending paste success and failure after clear-all', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)
    await wrapper.get('select').setValue('secret')
    const tokenRead = deferred()
    const keyRead = deferred()
    clipboard.readText.mockReturnValueOnce(tokenRead.promise).mockReturnValueOnce(keyRead.promise)

    await findButton(wrapper, '粘贴 Token').trigger('click')
    await findButton(wrapper, '粘贴密钥').trigger('click')
    await findButton(wrapper, '清空全部').trigger('click')

    tokenRead.resolve(tokenFor('cleared-late'))
    keyRead.reject(new Error('clipboard denied'))
    await flushPromises()

    expect(textareaValue(wrapper, '#jwt-token')).toBe('')
    expect(textareaValue(wrapper, '#jwt-key')).toBe('')
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not let an old key paste backfill a newly selected key mode', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)
    await wrapper.get('select').setValue('secret')
    const read = deferred()
    clipboard.readText.mockReturnValueOnce(read.promise)

    await findButton(wrapper, '粘贴密钥').trigger('click')
    await wrapper.get('select').setValue('pem')

    read.resolve('old-secret')
    await flushPromises()

    expect(textareaValue(wrapper, '#jwt-key')).toBe('')
    wrapper.unmount()
  })

  it('keeps explicit run and claims-only conclusions over a previously pending read', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)
    const explicitToken = tokenFor('explicit-run')
    await wrapper.get('#jwt-token').setValue(explicitToken)
    const read = deferred()
    clipboard.readText.mockReturnValueOnce(read.promise)

    await findButton(wrapper, '粘贴 Token').trigger('click')
    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()
    await findButton(wrapper, '仅检查 Claims（不验证签名）').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已按当前时间、容差与填写的期望值检查。')

    read.resolve(tokenFor('stale-clipboard'))
    await flushPromises()

    expect(textareaValue(wrapper, '#jwt-token')).toBe(explicitToken)
    expect(wrapper.text()).toContain('Header（已解码）')
    expect(wrapper.text()).toContain('explicit-run')
    expect(wrapper.text()).toContain('已按当前时间、容差与填写的期望值检查。')
    expect(wrapper.text()).not.toContain('stale-clipboard')
    wrapper.unmount()
  })

  it('lets a later paste to the same target win over an earlier pending one', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)
    const firstRead = deferred()
    const secondRead = deferred()
    clipboard.readText.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise)

    await findButton(wrapper, '粘贴 Token').trigger('click')
    await findButton(wrapper, '粘贴 Token').trigger('click')

    secondRead.resolve(tokenFor('second-clip'))
    await flushPromises()
    expect(textareaValue(wrapper, '#jwt-token')).toBe(tokenFor('second-clip'))

    firstRead.resolve(tokenFor('first-clip'))
    await flushPromises()
    expect(textareaValue(wrapper, '#jwt-token')).toBe(tokenFor('second-clip'))
    wrapper.unmount()
  })

  it('completes token and key pastes independently of key edits and in parallel', async () => {
    const clipboard = stubClipboard()
    const wrapper = mount(JwtToolView)
    await wrapper.get('select').setValue('secret')

    const tokenRead = deferred()
    clipboard.readText.mockReturnValueOnce(tokenRead.promise)
    await findButton(wrapper, '粘贴 Token').trigger('click')
    await wrapper.get('#jwt-key').setValue('typed-secret')

    const pastedToken = tokenFor('cross-target')
    tokenRead.resolve(pastedToken)
    await flushPromises()
    expect(textareaValue(wrapper, '#jwt-token')).toBe(pastedToken)

    const parallelTokenRead = deferred()
    const parallelKeyRead = deferred()
    clipboard.readText.mockReturnValueOnce(parallelTokenRead.promise).mockReturnValueOnce(parallelKeyRead.promise)
    await findButton(wrapper, '粘贴 Token').trigger('click')
    await findButton(wrapper, '粘贴密钥').trigger('click')
    parallelTokenRead.resolve(tokenFor('parallel-token'))
    parallelKeyRead.resolve('parallel-secret')
    await flushPromises()

    expect(textareaValue(wrapper, '#jwt-token')).toBe(tokenFor('parallel-token'))
    expect(textareaValue(wrapper, '#jwt-key')).toBe('parallel-secret')
    wrapper.unmount()
  })
})

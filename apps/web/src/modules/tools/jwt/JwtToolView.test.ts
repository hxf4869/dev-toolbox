import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SignatureCheck } from './jwt'

const verifyJwtSignature = vi.hoisted(() => vi.fn())

vi.mock('./jwt', async (importOriginal) => ({
  ...await importOriginal<typeof import('./jwt')>(),
  verifyJwtSignature,
}))

import JwtToolView from './JwtToolView.vue'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

describe('JwtToolView async verification isolation', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the newer failed result when an older success arrives late', async () => {
    const first = deferred<SignatureCheck>()
    const second = deferred<SignatureCheck>()
    verifyJwtSignature.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = await mountVerifier()

    await startRun(wrapper, tokenFor('first'), 'first-secret')
    await startRun(wrapper, tokenFor('second'), 'second-secret')
    second.resolve({ status: 'failed', code: 'JWT_SIGNATURE_INVALID', message: '第二次验签失败' })
    await flushPromises()
    first.resolve({ status: 'passed', message: '第一次验签通过' })
    await flushPromises()

    expect(wrapper.text()).toContain('第二次验签失败')
    expect(wrapper.text()).not.toContain('第一次验签通过')
    expect(verifyJwtSignature.mock.calls[0]?.[1]).toEqual({ kind: 'secret', value: 'first-secret' })
    expect(verifyJwtSignature.mock.calls[1]?.[1]).toEqual({ kind: 'secret', value: 'second-secret' })
    wrapper.unmount()
  })

  it('keeps the newer success when an older run rejects late', async () => {
    const first = deferred<SignatureCheck>()
    const second = deferred<SignatureCheck>()
    verifyJwtSignature.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = await mountVerifier()

    await startRun(wrapper, tokenFor('first'), 'first-secret')
    await startRun(wrapper, tokenFor('second'), 'second-secret')
    second.resolve({ status: 'passed', message: '第二次验签通过' })
    await flushPromises()
    first.reject(new Error('第一次晚到失败'))
    await flushPromises()

    expect(wrapper.text()).toContain('第二次验签通过')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('invalidates pending verification when cleared or unmounted', async () => {
    const afterClear = deferred<SignatureCheck>()
    const afterUnmount = deferred<SignatureCheck>()
    verifyJwtSignature.mockReturnValueOnce(afterClear.promise).mockReturnValueOnce(afterUnmount.promise)
    const wrapper = await mountVerifier()

    await startRun(wrapper, tokenFor('clear'), 'clear-secret')
    await wrapper.findAll('button').find((button) => button.text() === '清空全部')!.trigger('click')
    afterClear.resolve({ status: 'passed', message: '清空后不应写回' })
    await flushPromises()
    expect(wrapper.text()).not.toContain('清空后不应写回')
    expect(wrapper.get<HTMLTextAreaElement>('#jwt-token').element.value).toBe('')

    await startRun(wrapper, tokenFor('unmount'), 'unmount-secret')
    wrapper.unmount()
    afterUnmount.reject(new Error('卸载后的晚到失败'))
    await expect(afterUnmount.promise).rejects.toThrow('卸载后的晚到失败')
  })
})

async function mountVerifier(): Promise<VueWrapper> {
  const wrapper = mount(JwtToolView)
  await wrapper.get('select').setValue('secret')
  return wrapper
}

async function startRun(wrapper: VueWrapper, token: string, secret: string) {
  await wrapper.get('#jwt-token').setValue(token)
  await wrapper.get('#jwt-key').setValue(secret)
  void wrapper.get('button.button--primary').trigger('click')
  await vi.waitFor(() => expect(verifyJwtSignature).toHaveBeenCalled())
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function tokenFor(subject: string): string {
  return `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ sub: subject }))}.signature`
}

function base64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

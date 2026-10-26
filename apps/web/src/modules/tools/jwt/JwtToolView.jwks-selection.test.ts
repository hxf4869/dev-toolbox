import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const verifyJwtSignature = vi.hoisted(() => vi.fn())

vi.mock('./jwt', async (importOriginal) => ({
  ...await importOriginal<typeof import('./jwt')>(),
  verifyJwtSignature,
}))

import JwtToolView from './JwtToolView.vue'

const notVerified = { status: 'not_verified', message: '未验证：解码不代表可信。' }

describe('JwtToolView JWKS manual selection after the key set changes', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns to the placeholder and requires a new choice after the whole JWKS is replaced', async () => {
    verifyJwtSignature
      .mockResolvedValueOnce(notVerified)
      .mockResolvedValueOnce({ status: 'passed', message: '首次手选验签通过' })
    const wrapper = mount(JwtToolView)
    await wrapper.get('select').setValue('jwks')
    const token = tokenFor('jwks-replaced')
    await wrapper.get('#jwt-token').setValue(token)
    await wrapper.get('#jwt-key').setValue(jwksOf('public-demo-a', 'public-demo-b'))
    await runPrimary(wrapper)
    await wrapper.get('.key-select select').setValue('0')
    await runPrimary(wrapper)
    expect(verifyJwtSignature).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: 'jwks', selectedIndex: 0 }))
    expect(wrapper.text()).toContain('首次手选验签通过')

    const replacement = jwksOf('public-demo-c', 'public-demo-d')
    await wrapper.get('#jwt-key').setValue(replacement)

    expect(wrapper.find('.key-select select').exists()).toBe(true)
    expect(selectedKeyLabel(wrapper)).toBe('请选择')
    expect(wrapper.text()).toContain('Header（已解码）')
    expect(wrapper.text()).toContain('未验证')
    expect(wrapper.text()).not.toContain('首次手选验签通过')
    expect((wrapper.get('#jwt-token').element as HTMLTextAreaElement).value).toBe(token)
    expect((wrapper.get('#jwt-key').element as HTMLTextAreaElement).value).toBe(replacement)

    verifyJwtSignature.mockResolvedValueOnce({
      status: 'not_verified',
      code: 'JWT_JWKS_SELECTION_REQUIRED',
      message: 'Header 未提供 kid，请明确选择一个 key；本工具不会逐个尝试。',
    })
    await runPrimary(wrapper)
    expect(verifyJwtSignature).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: 'jwks', selectedIndex: undefined }))
    expect(wrapper.text()).toContain('请明确选择一个 key')
    wrapper.unmount()
  })

  it('does not inherit the previous index when the JWKS is cleared and refilled or reordered', async () => {
    verifyJwtSignature.mockResolvedValue(notVerified)
    const wrapper = mount(JwtToolView)
    await wrapper.get('select').setValue('jwks')
    await wrapper.get('#jwt-token').setValue(tokenFor('jwks-refill'))
    const original = jwksOf('public-demo-a', 'public-demo-b')
    await wrapper.get('#jwt-key').setValue(original)
    await runPrimary(wrapper)
    await wrapper.get('.key-select select').setValue('1')

    await wrapper.get('#jwt-key').setValue('')
    await wrapper.get('#jwt-key').setValue(original)
    expect(wrapper.find('.key-select select').exists()).toBe(true)
    expect(selectedKeyLabel(wrapper)).toBe('请选择')

    await wrapper.get('.key-select select').setValue('0')
    await wrapper.get('#jwt-key').setValue(jwksOf('public-demo-b', 'public-demo-a'))
    expect(wrapper.find('.key-select select').exists()).toBe(true)
    expect(selectedKeyLabel(wrapper)).toBe('请选择')
    wrapper.unmount()
  })

  it('keeps a manual selection while the JWKS text is unchanged and verifies a unique kid without selection', async () => {
    verifyJwtSignature
      .mockResolvedValueOnce(notVerified)
      .mockResolvedValue({ status: 'passed', message: '手选 key 的验签通过' })
    const wrapper = mount(JwtToolView)
    await wrapper.get('select').setValue('jwks')
    await wrapper.get('#jwt-token').setValue(tokenFor('jwks-stable'))
    await wrapper.get('#jwt-key').setValue(jwksOf('public-demo-a', 'public-demo-b'))
    await runPrimary(wrapper)
    await wrapper.get('.key-select select').setValue('0')
    await runPrimary(wrapper)
    expect(verifyJwtSignature).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: 'jwks', selectedIndex: 0 }))
    expect(wrapper.text()).toContain('手选 key 的验签通过')
    expect(selectedKeyLabel(wrapper)).toContain('public-demo-a')
    wrapper.unmount()

    const uniqueKid = mount(JwtToolView)
    await uniqueKid.get('select').setValue('jwks')
    await uniqueKid.get('#jwt-token').setValue(tokenFor('jwks-unique', 'public-demo-a'))
    await uniqueKid.get('#jwt-key').setValue(jwksOf('public-demo-a'))
    await runPrimary(uniqueKid)
    expect(uniqueKid.find('.key-select select').exists()).toBe(true)
    expect(selectedKeyLabel(uniqueKid)).toBe('请选择')
    expect(verifyJwtSignature).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: 'jwks', selectedIndex: undefined }))
    expect(uniqueKid.text()).toContain('手选 key 的验签通过')
    uniqueKid.unmount()
  })
})

async function runPrimary(wrapper: VueWrapper) {
  await wrapper.get('button.button--primary').trigger('click')
  await flushPromises()
}

function selectedKeyLabel(wrapper: VueWrapper): string {
  const select = wrapper.get('.key-select select').element as HTMLSelectElement
  return select.selectedOptions[0]?.textContent?.trim() ?? ''
}

function tokenFor(subject: string, kid?: string): string {
  const header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }
  if (kid !== undefined) header.kid = kid
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify({ sub: subject }))}.c2lnbmF0dXJl`
}

function jwksOf(...kids: string[]): string {
  return JSON.stringify({ keys: kids.map((kid) => ({ kty: 'oct', kid })) })
}

function base64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

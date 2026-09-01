import { mount } from '@vue/test-utils'
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from 'jose'

import JwtToolView from './JwtToolView.vue'
import {
  MAX_JWT_INPUT_BYTES,
  SUPPORTED_JWT_ALGORITHMS,
  checkJwtClaims,
  decodeJwt,
  describeJwtNumericDate,
  listJwksCandidates,
  verifyJwtSignature,
  type JwtKeyInput,
  type SupportedJwtAlgorithm,
} from './jwt'

describe('JWT local tool', () => {
  it('rejects none, EdDSA, malformed segments and oversized token input explicitly', () => {
    expect(() => decodeJwt(unsignedToken('none'))).toThrowError(expect.objectContaining({ code: 'JWT_ALG_NONE_REJECTED' }))
    expect(() => decodeJwt(unsignedToken('EdDSA'))).toThrowError(expect.objectContaining({ code: 'JWT_ALG_EDDSA_UNSUPPORTED' }))
    expect(() => decodeJwt('abc.def')).toThrowError(expect.objectContaining({ code: 'JWT_FORMAT_INVALID' }))
    expect(() => decodeJwt('a'.repeat(MAX_JWT_INPUT_BYTES + 1))).toThrowError(expect.objectContaining({ code: 'JWT_INPUT_TOO_LARGE' }))
  })

  it.each(SUPPORTED_JWT_ALGORITHMS)('verifies a valid %s signature and rejects a changed signature', async (algorithm) => {
    const fixture = await signedFixture(algorithm)
    const decoded = decodeJwt(fixture.token)
    await expect(verifyJwtSignature(decoded, fixture.input)).resolves.toMatchObject({ status: 'passed' })
    const changed = `${fixture.token.slice(0, -3)}${fixture.token.at(-3) === 'A' ? 'B' : 'A'}${fixture.token.slice(-2)}`
    await expect(verifyJwtSignature(decodeJwt(changed), fixture.input)).resolves.toMatchObject({ status: 'failed' })
  }, 30_000)

  it('keeps signature and claims results independent', async () => {
    const fixture = await signedFixture('HS256', { exp: 100, nbf: 10 })
    const signature = await verifyJwtSignature(decodeJwt(fixture.token), fixture.input)
    const claims = checkJwtClaims(decodeJwt(fixture.token).payload, { clockToleranceSeconds: 60, nowSeconds: 200 })
    expect(signature.status).toBe('passed')
    expect(claims.status).toBe('expired')
  })

  it('applies NumericDate tolerance, optional expectations, and format checks', () => {
    expect(checkJwtClaims({ exp: 100, nbf: 220 }, { clockToleranceSeconds: 60, nowSeconds: 160 }).status).toBe('expired')
    expect(checkJwtClaims({ nbf: 221 }, { clockToleranceSeconds: 60, nowSeconds: 160 }).status).toBe('not_yet_valid')
    expect(checkJwtClaims({ exp: 'tomorrow' }, { clockToleranceSeconds: 60, nowSeconds: 160 }).status).toBe('format_error')
    expect(checkJwtClaims({ aud: 7 }, { clockToleranceSeconds: 60, nowSeconds: 160 }).status).toBe('format_error')
    expect(checkJwtClaims(
      { iss: 'actual', aud: ['mobile', 'web'], sub: 'owner' },
      { issuer: 'expected', audience: 'web', subject: 'owner', clockToleranceSeconds: 60, nowSeconds: 160 },
    ).status).toBe('expected_mismatch')
    expect(checkJwtClaims({}, { clockToleranceSeconds: 60, nowSeconds: 160 })).toMatchObject({ status: 'passed', issues: [] })
    expect(describeJwtNumericDate({ exp: 1_700_000_000 }, 'exp')).toContain('2023-11-14')
    expect(describeJwtNumericDate({ iat: 'now' }, 'iat')).toContain('格式非法')
  })

  it('requires manual JWKS selection without kid or with duplicate exact kid', async () => {
    const fixture = await signedFixture('RS256', {}, '')
    const publicJwk = await publicJwkFor(fixture)
    const duplicate = { ...publicJwk, kid: 'same' }
    const noKidToken = decodeJwt(fixture.token)
    const noKidJwks = JSON.stringify({ keys: [publicJwk] })
    expect(listJwksCandidates(noKidToken.header, noKidJwks)).toHaveLength(1)
    await expect(verifyJwtSignature(noKidToken, { kind: 'jwks', value: noKidJwks })).resolves.toMatchObject({
      status: 'not_verified', code: 'JWT_JWKS_SELECTION_REQUIRED',
    })
    await expect(verifyJwtSignature(noKidToken, { kind: 'jwks', value: noKidJwks, selectedIndex: 0 })).resolves.toMatchObject({ status: 'passed' })
    await expect(verifyJwtSignature(noKidToken, { kind: 'jwk', value: JSON.stringify(publicJwk) })).resolves.toMatchObject({ status: 'passed' })

    const withKid = decodeJwt(await resignFixture(fixture, 'RS256', { kid: 'same' }))
    const duplicateJwks = JSON.stringify({ keys: [duplicate, duplicate] })
    await expect(verifyJwtSignature(withKid, { kind: 'jwks', value: duplicateJwks })).resolves.toMatchObject({
      status: 'not_verified', code: 'JWT_JWKS_SELECTION_REQUIRED',
    })
    await expect(verifyJwtSignature(withKid, { kind: 'jwks', value: JSON.stringify({ keys: [{ ...duplicate, kid: 'other' }] }) })).resolves.toMatchObject({
      status: 'failed', code: 'JWT_JWKS_KID_NOT_FOUND',
    })
    await expect(verifyJwtSignature(noKidToken, { kind: 'jwk', value: JSON.stringify({ ...publicJwk, alg: 'RS512' }) })).resolves.toMatchObject({
      status: 'failed', code: 'JWT_KEY_ALG_MISMATCH',
    })
  })

  it('rejects oversized key material before WebCrypto verification', async () => {
    const fixture = await signedFixture('HS256')
    await expect(verifyJwtSignature(decodeJwt(fixture.token), {
      kind: 'secret', value: 's'.repeat(MAX_JWT_INPUT_BYTES + 1),
    })).resolves.toMatchObject({ status: 'failed', code: 'JWT_INPUT_TOO_LARGE' })
  })

  it('does not fetch or persist while decoding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')
    const indexedDBOpen = window.indexedDB ? vi.spyOn(window.indexedDB, 'open') : undefined
    const wrapper = mount(JwtToolView)
    await wrapper.get('#jwt-token').setValue(unsignedToken('HS256', 'signature'))
    await wrapper.get('button.button--primary').trigger('click')
    expect(wrapper.text()).toContain('未验证：解码不代表可信')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(storageSpy).not.toHaveBeenCalled()
    if (indexedDBOpen) expect(indexedDBOpen).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(wrapper.exists()).toBe(false)
  })
})

interface SignedFixture {
  token: string
  input: JwtKeyInput
  privateKey?: CryptoKey
  publicKey?: CryptoKey
}

async function signedFixture(
  algorithm: SupportedJwtAlgorithm,
  payload: Record<string, unknown> = { sub: 'owner' },
  kid: string | undefined = 'fixture-key',
): Promise<SignedFixture> {
  const protectedHeader = kid ? { alg: algorithm, kid } : { alg: algorithm }
  if (algorithm.startsWith('HS')) {
    const secret = `synthetic-${algorithm}-secret-with-enough-bytes-for-tests`
    const secretJwk = { kty: 'oct', alg: algorithm, k: base64url(secret) }
    return {
      token: await new SignJWT(payload).setProtectedHeader(protectedHeader).sign(secretJwk),
      input: { kind: 'secret', value: secret },
    }
  }
  const { privateKey, publicKey } = await generateKeyPair(algorithm, { extractable: true })
  return {
    token: await new SignJWT(payload).setProtectedHeader(protectedHeader).sign(privateKey),
    input: { kind: 'pem', value: await exportSPKI(publicKey) },
    privateKey,
    publicKey,
  }
}

async function publicJwkFor(fixture: SignedFixture) {
  if (!fixture.publicKey) throw new Error('asymmetric fixture required')
  return exportJWK(fixture.publicKey)
}

async function resignFixture(
  fixture: SignedFixture,
  algorithm: SupportedJwtAlgorithm,
  header: { kid: string },
) {
  if (!fixture.privateKey) throw new Error('asymmetric fixture required')
  return new SignJWT({ sub: 'owner' }).setProtectedHeader({ alg: algorithm, ...header }).sign(fixture.privateKey)
}

function unsignedToken(algorithm: string, signature = '') {
  return `${base64url(JSON.stringify({ alg: algorithm, typ: 'JWT' }))}.${base64url(JSON.stringify({ sub: 'owner' }))}.${signature}`
}

function base64url(value: string) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

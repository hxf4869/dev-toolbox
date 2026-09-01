import {
  compactVerify,
  importJWK,
  importSPKI,
  type JWK,
} from 'jose'

export const MAX_JWT_INPUT_BYTES = 1024 * 1024
export const SUPPORTED_JWT_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
] as const

export type SupportedJwtAlgorithm = (typeof SUPPORTED_JWT_ALGORITHMS)[number]

export interface JwtHeader extends Record<string, unknown> {
  alg: SupportedJwtAlgorithm
  kid?: string
}

export interface JwtPayload extends Record<string, unknown> {
  exp?: unknown
  nbf?: unknown
  iat?: unknown
  iss?: unknown
  aud?: unknown
  sub?: unknown
}

export interface DecodedJwt {
  token: string
  header: JwtHeader
  payload: JwtPayload
  headerSegment: string
  payloadSegment: string
  signatureSegment: string
}

export type JwtKeyInput =
  | { kind: 'secret'; value: string }
  | { kind: 'pem'; value: string }
  | { kind: 'jwk'; value: string }
  | { kind: 'jwks'; value: string; selectedIndex?: number }

export interface SignatureCheck {
  status: 'not_verified' | 'passed' | 'failed'
  code?: string
  message: string
  selectedKeyIndex?: number
}

export interface ClaimExpectation {
  issuer?: string
  audience?: string
  subject?: string
  clockToleranceSeconds: number
  nowSeconds?: number
}

export interface ClaimIssue {
  claim: 'exp' | 'nbf' | 'iat' | 'iss' | 'aud' | 'sub' | 'clockTolerance'
  code: string
  message: string
}

export interface ClaimsCheck {
  status: 'passed' | 'expired' | 'not_yet_valid' | 'expected_mismatch' | 'format_error'
  issues: ClaimIssue[]
  times: {
    exp?: string
    nbf?: string
    iat?: string
  }
}

export interface JwksCandidate {
  index: number
  kid?: string
  kty?: string
  alg?: string
  label: string
}

export class JwtInputError extends Error {
  constructor(
    readonly code:
      | 'JWT_INPUT_TOO_LARGE'
      | 'JWT_FORMAT_INVALID'
      | 'JWT_JSON_INVALID'
      | 'JWT_ALG_NONE_REJECTED'
      | 'JWT_ALG_EDDSA_UNSUPPORTED'
      | 'JWT_ALG_UNSUPPORTED'
      | 'JWT_KEY_FORMAT_INVALID'
      | 'JWT_KEY_TYPE_MISMATCH'
      | 'JWT_KEY_ALG_MISMATCH'
      | 'JWT_JWKS_KID_NOT_FOUND'
      | 'JWT_JWKS_SELECTION_REQUIRED',
    message: string,
  ) {
    super(message)
    this.name = 'JwtInputError'
  }
}

export function jwtUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function assertJwtInputLimit(value: string, label: string): number {
  const bytes = jwtUtf8ByteLength(value)
  if (bytes > MAX_JWT_INPUT_BYTES) {
    throw new JwtInputError(
      'JWT_INPUT_TOO_LARGE',
      `${label}为 ${formatJwtBytes(bytes)}，超过 1 MiB 上限。请缩小内容后重试。`,
    )
  }
  return bytes
}

export function decodeJwt(token: string): DecodedJwt {
  assertJwtInputLimit(token, 'Token ')
  const segments = token.split('.')
  if (segments.length !== 3 || !segments[0] || !segments[1]) {
    throw new JwtInputError('JWT_FORMAT_INVALID', 'JWT 必须包含 Header、Payload 和签名三个点分段。')
  }

  const header = decodeJsonSegment(segments[0], 'Header')
  const payload = decodeJsonSegment(segments[1], 'Payload')
  if (!isRecord(header) || typeof header.alg !== 'string') {
    throw new JwtInputError('JWT_FORMAT_INVALID', 'JWT Header 必须是对象并包含字符串 alg。')
  }
  if (!isRecord(payload)) {
    throw new JwtInputError('JWT_FORMAT_INVALID', 'JWT Payload 必须是 JSON 对象。')
  }
  assertSupportedAlgorithm(header.alg)
  if (!segments[2]) {
    throw new JwtInputError('JWT_FORMAT_INVALID', '当前算法的 JWT 必须包含非空签名段。')
  }
  if ('kid' in header && typeof header.kid !== 'string') {
    throw new JwtInputError('JWT_FORMAT_INVALID', 'JWT Header 的 kid 如存在必须是字符串。')
  }
  return {
    token,
    header: header as JwtHeader,
    payload,
    headerSegment: segments[0],
    payloadSegment: segments[1],
    signatureSegment: segments[2],
  }
}

export async function verifyJwtSignature(
  decoded: DecodedJwt,
  keyInput: JwtKeyInput,
): Promise<SignatureCheck> {
  try {
    const { key, selectedKeyIndex } = await resolveVerificationKey(decoded.header, keyInput)
    await compactVerify(decoded.token, key, { algorithms: [decoded.header.alg] })
    return {
      status: 'passed',
      message: `签名已使用 ${decoded.header.alg} 在浏览器本地验证。`,
      selectedKeyIndex,
    }
  } catch (error) {
    if (error instanceof JwtInputError) {
      const needsSelection = error.code === 'JWT_JWKS_SELECTION_REQUIRED'
      return {
        status: needsSelection ? 'not_verified' : 'failed',
        code: error.code,
        message: error.message,
      }
    }
    return {
      status: 'failed',
      code: 'JWT_SIGNATURE_INVALID',
      message: '签名验证失败。请检查 Token、算法与本地密钥是否匹配。',
    }
  }
}

export function checkJwtClaims(payload: JwtPayload, expectation: ClaimExpectation): ClaimsCheck {
  const issues: ClaimIssue[] = []
  const times: ClaimsCheck['times'] = {}
  const tolerance = expectation.clockToleranceSeconds
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 300) {
    issues.push({
      claim: 'clockTolerance',
      code: 'CLOCK_TOLERANCE_INVALID',
      message: '时钟容差必须是 0–300 秒之间的整数。',
    })
  }
  const now = expectation.nowSeconds ?? Date.now() / 1000
  for (const claim of ['exp', 'nbf', 'iat'] as const) {
    if (!(claim in payload)) continue
    const value = payload[claim]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({
        claim,
        code: 'CLAIM_NUMERIC_DATE_INVALID',
        message: `${claim} 如存在必须是有限数字 NumericDate。`,
      })
      continue
    }
    times[claim] = formatNumericDate(value)
  }

  for (const claim of ['iss', 'sub'] as const) {
    if (claim in payload && typeof payload[claim] !== 'string') {
      issues.push({
        claim,
        code: 'CLAIM_STRING_INVALID',
        message: `${claim} 如存在必须是字符串。`,
      })
    }
  }
  if (
    'aud' in payload &&
    typeof payload.aud !== 'string' &&
    !(Array.isArray(payload.aud) && payload.aud.every((entry) => typeof entry === 'string'))
  ) {
    issues.push({
      claim: 'aud',
      code: 'CLAIM_AUDIENCE_FORMAT_INVALID',
      message: 'aud 如存在必须是字符串或字符串数组。',
    })
  }

  if (!issues.some((issue) => issue.claim === 'clockTolerance')) {
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp) && now >= payload.exp + tolerance) {
      issues.push({ claim: 'exp', code: 'CLAIM_EXPIRED', message: 'Token 已超过 exp 与时钟容差。' })
    }
    if (typeof payload.nbf === 'number' && Number.isFinite(payload.nbf) && now + tolerance < payload.nbf) {
      issues.push({ claim: 'nbf', code: 'CLAIM_NOT_YET_VALID', message: 'Token 尚未到 nbf 生效时间。' })
    }
  }

  checkExpectedString(payload, 'iss', expectation.issuer, issues)
  checkExpectedAudience(payload.aud, expectation.audience, issues)
  checkExpectedString(payload, 'sub', expectation.subject, issues)

  const formatIssue = issues.find((issue) =>
    ['CLAIM_NUMERIC_DATE_INVALID', 'CLOCK_TOLERANCE_INVALID', 'CLAIM_AUDIENCE_FORMAT_INVALID', 'CLAIM_STRING_INVALID'].includes(
      issue.code,
    ),
  )
  const status: ClaimsCheck['status'] = formatIssue
    ? 'format_error'
    : issues.some((issue) => issue.code === 'CLAIM_EXPIRED')
      ? 'expired'
      : issues.some((issue) => issue.code === 'CLAIM_NOT_YET_VALID')
        ? 'not_yet_valid'
        : issues.some((issue) => issue.code === 'CLAIM_EXPECTED_MISMATCH')
          ? 'expected_mismatch'
          : 'passed'
  return { status, issues, times }
}

export function describeJwtNumericDate(payload: JwtPayload, claim: 'exp' | 'nbf' | 'iat'): string {
  if (!(claim in payload)) return '未提供'
  const value = payload[claim]
  if (typeof value !== 'number' || !Number.isFinite(value)) return '格式非法：必须是有限数字 NumericDate'
  return `${value} · ${formatNumericDate(value)}`
}

export function listJwksCandidates(header: JwtHeader, jwksText: string): JwksCandidate[] {
  const keys = parseJwks(jwksText)
  const matching = typeof header.kid === 'string'
    ? keys.map((key, index) => ({ key, index })).filter(({ key }) => key.kid === header.kid)
    : keys.map((key, index) => ({ key, index }))
  return matching.map(({ key, index }) => ({
    index,
    kid: typeof key.kid === 'string' ? key.kid : undefined,
    kty: typeof key.kty === 'string' ? key.kty : undefined,
    alg: typeof key.alg === 'string' ? key.alg : undefined,
    label: `#${index + 1} · kid ${typeof key.kid === 'string' ? key.kid : '未提供'} · ${key.kty ?? '未知 kty'} · ${key.alg ?? '未声明 alg'}`,
  }))
}

async function resolveVerificationKey(
  header: JwtHeader,
  keyInput: JwtKeyInput,
): Promise<{ key: CryptoKey | Uint8Array | JWK; selectedKeyIndex?: number }> {
  assertJwtInputLimit(keyInput.value, keyLabel(keyInput.kind))
  if (keyInput.kind === 'secret') {
    if (!header.alg.startsWith('HS')) {
      throw new JwtInputError('JWT_KEY_TYPE_MISMATCH', `${header.alg} 需要非对称公钥，不能使用共享 secret。`)
    }
    if (!keyInput.value) {
      throw new JwtInputError('JWT_KEY_FORMAT_INVALID', '共享 secret 不能为空。')
    }
    return {
      key: {
        kty: 'oct',
        alg: header.alg,
        k: encodeBase64Url(new TextEncoder().encode(keyInput.value)),
      },
    }
  }
  if (keyInput.kind === 'pem') {
    if (header.alg.startsWith('HS')) {
      throw new JwtInputError('JWT_KEY_TYPE_MISMATCH', `${header.alg} 需要共享 secret 或 oct JWK，不能使用 PEM。`)
    }
    try {
      return { key: await importSPKI(keyInput.value.trim(), header.alg) }
    } catch {
      throw new JwtInputError(
        'JWT_KEY_FORMAT_INVALID',
        'PEM 公钥无法解析或与当前算法不兼容；请粘贴 BEGIN PUBLIC KEY 格式。',
      )
    }
  }
  if (keyInput.kind === 'jwk') {
    const jwk = parseJwk(keyInput.value)
    return { key: await importValidatedJwk(jwk, header.alg) }
  }

  const keys = parseJwks(keyInput.value)
  const selected = selectJwksKey(keys, header, keyInput.selectedIndex)
  return {
    key: await importValidatedJwk(selected.key, header.alg),
    selectedKeyIndex: selected.index,
  }
}

function selectJwksKey(keys: JWK[], header: JwtHeader, selectedIndex?: number) {
  const matches = typeof header.kid === 'string'
    ? keys.map((key, index) => ({ key, index })).filter(({ key }) => key.kid === header.kid)
    : keys.map((key, index) => ({ key, index }))
  if (typeof header.kid === 'string' && matches.length === 0) {
    throw new JwtInputError(
      'JWT_JWKS_KID_NOT_FOUND',
      `JWKS 中没有 kid 精确等于“${header.kid}”的 key；不会尝试其他 key。`,
    )
  }
  if (typeof header.kid === 'string' && matches.length === 1) return matches[0]!
  if (selectedIndex === undefined || !matches.some((candidate) => candidate.index === selectedIndex)) {
    const reason = typeof header.kid === 'string' ? '有多个 key 使用相同 kid' : 'Header 未提供 kid'
    throw new JwtInputError(
      'JWT_JWKS_SELECTION_REQUIRED',
      `${reason}，请明确选择一个 key；本工具不会逐个尝试。`,
    )
  }
  return matches.find((candidate) => candidate.index === selectedIndex)!
}

async function importValidatedJwk(jwk: JWK, algorithm: SupportedJwtAlgorithm) {
  validateJwkForAlgorithm(jwk, algorithm)
  try {
    return await importJWK(jwk, algorithm)
  } catch {
    throw new JwtInputError('JWT_KEY_FORMAT_INVALID', 'JWK 缺少必要字段，或密钥材料无法被 WebCrypto 导入。')
  }
}

export function validateJwkForAlgorithm(jwk: JWK, algorithm: SupportedJwtAlgorithm): void {
  const expectedKty = algorithm.startsWith('HS') ? 'oct' : algorithm.startsWith('ES') ? 'EC' : 'RSA'
  if (jwk.kty !== expectedKty) {
    throw new JwtInputError(
      'JWT_KEY_TYPE_MISMATCH',
      `${algorithm} 需要 ${expectedKty} key，但当前 JWK 的 kty 是 ${jwk.kty ?? '未提供'}。`,
    )
  }
  if (jwk.alg && jwk.alg !== algorithm) {
    throw new JwtInputError(
      'JWT_KEY_ALG_MISMATCH',
      `JWK 声明的 alg=${jwk.alg} 与 Token 的 alg=${algorithm} 不一致。`,
    )
  }
  if (jwk.use && jwk.use !== 'sig') {
    throw new JwtInputError('JWT_KEY_TYPE_MISMATCH', 'JWK 的 use 不是 sig，不能用于签名验证。')
  }
  if (jwk.key_ops && !jwk.key_ops.includes('verify')) {
    throw new JwtInputError('JWT_KEY_TYPE_MISMATCH', 'JWK 的 key_ops 不允许 verify。')
  }
  if (algorithm.startsWith('ES')) {
    const curves: Partial<Record<SupportedJwtAlgorithm, string>> = {
      ES256: 'P-256',
      ES384: 'P-384',
      ES512: 'P-521',
    }
    const expectedCurve = curves[algorithm]
    if (jwk.crv !== expectedCurve) {
      throw new JwtInputError(
        'JWT_KEY_TYPE_MISMATCH',
        `${algorithm} 需要 ${expectedCurve}，当前 JWK 的 crv 是 ${jwk.crv ?? '未提供'}。`,
      )
    }
  }
}

function parseJwk(value: string): JWK {
  const parsed = parseKeyJson(value, 'JWK')
  if (!isRecord(parsed) || typeof parsed.kty !== 'string') {
    throw new JwtInputError('JWT_KEY_FORMAT_INVALID', 'JWK 必须是包含字符串 kty 的 JSON 对象。')
  }
  return parsed as JWK
}

function parseJwks(value: string): JWK[] {
  const parsed = parseKeyJson(value, 'JWKS')
  if (!isRecord(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new JwtInputError('JWT_KEY_FORMAT_INVALID', 'JWKS 必须是包含非空 keys 数组的 JSON 对象。')
  }
  if (!parsed.keys.every((key) => isRecord(key) && typeof key.kty === 'string')) {
    throw new JwtInputError('JWT_KEY_FORMAT_INVALID', 'JWKS 的每个 key 都必须是包含字符串 kty 的对象。')
  }
  return parsed.keys as JWK[]
}

function parseKeyJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new JwtInputError('JWT_KEY_FORMAT_INVALID', `${label} 不是有效 JSON。`)
  }
}

function decodeJsonSegment(segment: string, label: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment) || segment.length % 4 === 1) {
    throw new JwtInputError('JWT_FORMAT_INVALID', `${label} 不是合法 Base64URL 分段。`)
  }
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (segment.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new JwtInputError('JWT_FORMAT_INVALID', `${label} 不是合法 Base64URL 分段。`)
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new JwtInputError('JWT_JSON_INVALID', `${label} 解码后不是有效 UTF-8。`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new JwtInputError('JWT_JSON_INVALID', `${label} 解码后不是有效 JSON。`)
  }
}

function assertSupportedAlgorithm(algorithm: string): asserts algorithm is SupportedJwtAlgorithm {
  if (algorithm.toLowerCase() === 'none') {
    throw new JwtInputError('JWT_ALG_NONE_REJECTED', '明确拒绝 alg: none：它没有可验证的签名。')
  }
  if (algorithm === 'EdDSA') {
    throw new JwtInputError('JWT_ALG_EDDSA_UNSUPPORTED', 'V2.0 不支持 EdDSA；不会尝试其他算法。')
  }
  if (!SUPPORTED_JWT_ALGORITHMS.includes(algorithm as SupportedJwtAlgorithm)) {
    throw new JwtInputError(
      'JWT_ALG_UNSUPPORTED',
      `不支持算法 ${algorithm}；不会猜测或替换 Header 中的 alg。`,
    )
  }
}

function checkExpectedString(
  payload: JwtPayload,
  claim: 'iss' | 'sub',
  expected: string | undefined,
  issues: ClaimIssue[],
) {
  if (!expected) return
  if (claim in payload && typeof payload[claim] !== 'string') return
  if (payload[claim] !== expected) {
    issues.push({
      claim,
      code: 'CLAIM_EXPECTED_MISMATCH',
      message: `${claim} 与填写的期望值不匹配。`,
    })
  }
}

function checkExpectedAudience(actual: unknown, expected: string | undefined, issues: ClaimIssue[]) {
  if (!expected) return
  if (
    actual !== undefined &&
    typeof actual !== 'string' &&
    !(Array.isArray(actual) && actual.every((entry) => typeof entry === 'string'))
  ) {
    return
  }
  const matches = typeof actual === 'string' ? actual === expected : Array.isArray(actual) && actual.includes(expected)
  if (!matches) {
    issues.push({ claim: 'aud', code: 'CLAIM_EXPECTED_MISMATCH', message: 'aud 不包含填写的期望值。' })
  }
}

function formatNumericDate(value: number): string {
  try {
    return new Date(value * 1000).toISOString()
  } catch {
    return '超出可显示日期范围'
  }
}

function keyLabel(kind: JwtKeyInput['kind']) {
  return { secret: '共享 secret ', pem: 'PEM ', jwk: 'JWK ', jwks: 'JWKS ' }[kind]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function formatJwtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

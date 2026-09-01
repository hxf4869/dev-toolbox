<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import UiButton from '../../../components/ui/UiButton.vue'
import {
  JwtInputError,
  checkJwtClaims,
  decodeJwt,
  describeJwtNumericDate,
  formatJwtBytes,
  jwtUtf8ByteLength,
  listJwksCandidates,
  verifyJwtSignature,
  type ClaimsCheck,
  type DecodedJwt,
  type JwtKeyInput,
  type JwksCandidate,
  type SignatureCheck,
} from './jwt'

type KeyMode = 'none' | JwtKeyInput['kind']

interface JwtRunSnapshot {
  token: string
  keyMode: KeyMode
  keyValue: string
  selectedKeyIndex: number | undefined
  issuer: string | undefined
  audience: string | undefined
  subject: string | undefined
  clockToleranceSeconds: number
}

const token = ref('')
const keyMode = ref<KeyMode>('none')
const keyValue = ref('')
const selectedKeyIndex = ref<number | undefined>()
const expectedIssuer = ref('')
const expectedAudience = ref('')
const expectedSubject = ref('')
const clockTolerance = ref(60)
const decoded = ref<DecodedJwt | null>(null)
const signature = ref<SignatureCheck>({ status: 'not_verified', message: '未验证：解码不代表可信。' })
const claims = ref<ClaimsCheck | null>(null)
const errorMessage = ref('')
const liveMessage = ref('')
let latestRunId = 0

const tokenBytes = computed(() => jwtUtf8ByteLength(token.value))
const keyBytes = computed(() => jwtUtf8ByteLength(keyValue.value))
const keyLabel = computed(() => ({ secret: '共享 secret', pem: 'PEM 公钥', jwk: 'JWK', jwks: 'JWKS' })[keyMode.value as Exclude<KeyMode, 'none'>] ?? '')
const jwksCandidates = computed<JwksCandidate[]>(() => {
  if (keyMode.value !== 'jwks' || !decoded.value || !keyValue.value) return []
  try {
    return listJwksCandidates(decoded.value.header, keyValue.value)
  } catch {
    return []
  }
})
const decodedTimes = computed(() => decoded.value
  ? {
      exp: describeJwtNumericDate(decoded.value.payload, 'exp'),
      nbf: describeJwtNumericDate(decoded.value.payload, 'nbf'),
      iat: describeJwtNumericDate(decoded.value.payload, 'iat'),
    }
  : null)

async function run() {
  const runId = ++latestRunId
  const snapshot = createRunSnapshot()
  errorMessage.value = ''
  liveMessage.value = ''
  signature.value = { status: 'not_verified', message: '未验证：解码不代表可信。' }
  claims.value = null
  try {
    const nextDecoded = decodeJwt(snapshot.token)
    decoded.value = nextDecoded
    if (snapshot.keyMode === 'none') return
    claims.value = checkJwtClaims(nextDecoded.payload, snapshot)
    const nextSignature = await verifyJwtSignature(nextDecoded, buildKeyInput(snapshot))
    if (runId !== latestRunId) return
    signature.value = nextSignature
  } catch (error) {
    if (runId !== latestRunId) return
    decoded.value = null
    errorMessage.value = error instanceof JwtInputError ? error.message : 'JWT 处理未完成，请检查输入。'
  }
}

function createRunSnapshot(): JwtRunSnapshot {
  return {
    token: token.value,
    keyMode: keyMode.value,
    keyValue: keyValue.value,
    selectedKeyIndex: selectedKeyIndex.value,
    issuer: expectedIssuer.value.trim() || undefined,
    audience: expectedAudience.value.trim() || undefined,
    subject: expectedSubject.value.trim() || undefined,
    clockToleranceSeconds: Number(clockTolerance.value),
  }
}

function checkClaimsOnly() {
  if (!decoded.value) return
  claims.value = checkJwtClaims(decoded.value.payload, {
    issuer: expectedIssuer.value.trim() || undefined,
    audience: expectedAudience.value.trim() || undefined,
    subject: expectedSubject.value.trim() || undefined,
    clockToleranceSeconds: Number(clockTolerance.value),
  })
}

function buildKeyInput(snapshot: JwtRunSnapshot): JwtKeyInput {
  if (snapshot.keyMode === 'none') throw new Error('key mode is required')
  return snapshot.keyMode === 'jwks'
    ? { kind: 'jwks', value: snapshot.keyValue, selectedIndex: snapshot.selectedKeyIndex }
    : { kind: snapshot.keyMode, value: snapshot.keyValue } as JwtKeyInput
}

async function paste(target: 'token' | 'key') {
  errorMessage.value = ''
  try {
    const value = await navigator.clipboard.readText()
    if (target === 'token') token.value = value
    else keyValue.value = value
  } catch {
    errorMessage.value = '浏览器未允许读取剪贴板，请使用系统粘贴快捷键。'
  }
}

async function copyJson(value: unknown, label: string) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
    liveMessage.value = `${label} 已复制`
  } catch {
    errorMessage.value = '复制未成功，请手动选择内容。'
  }
}

function clearSensitiveState() {
  latestRunId += 1
  token.value = ''
  keyValue.value = ''
  selectedKeyIndex.value = undefined
  expectedIssuer.value = ''
  expectedAudience.value = ''
  expectedSubject.value = ''
  decoded.value = null
  claims.value = null
  signature.value = { status: 'not_verified', message: '未验证：解码不代表可信。' }
  errorMessage.value = ''
  liveMessage.value = ''
}

function claimStatusLabel(status: ClaimsCheck['status']) {
  return {
    passed: '通过', expired: '已过期', not_yet_valid: '尚未生效',
    expected_mismatch: '期望值不匹配', format_error: '格式错误',
  }[status]
}

function signatureStatusLabel(status: SignatureCheck['status']) {
  return { not_verified: '未验证', passed: '通过', failed: '失败' }[status]
}

onBeforeUnmount(clearSensitiveState)
</script>

<template>
  <main class="tool-page" aria-labelledby="jwt-title">
    <header class="tool-header">
      <div>
        <p class="breadcrumb">工具箱 / 编码与数据</p>
        <h1 id="jwt-title">JWT 查看与校验</h1>
        <p>本地解码 JWT，并按需使用临时密钥分别检查签名与 Claims。</p>
      </div>
      <span class="local-badge">浏览器本地处理</span>
    </header>
    <p class="privacy-note">Token 和密钥只存在于当前页面内存，不联网获取 JWKS、不保存历史。每项输入上限 1 MiB UTF-8。</p>
    <p class="trust-warning">能解码只表示内容可读取，不表示来源可信、登录有效或签名已经验证。</p>

    <p v-if="errorMessage" class="error-summary" role="alert">{{ errorMessage }}</p>

    <section class="input-panel">
      <div class="panel-header"><label for="jwt-token">JWT Token</label><span>{{ token.length }} 字符 · {{ formatJwtBytes(tokenBytes) }}</span></div>
      <textarea id="jwt-token" v-model="token" rows="7" spellcheck="false" autocomplete="off" placeholder="粘贴三段式 JWT" />
      <div class="row-actions"><UiButton variant="ghost" @click="paste('token')">粘贴 Token</UiButton><UiButton variant="ghost" @click="clearSensitiveState">清空全部</UiButton></div>
    </section>

    <section class="verify-panel">
      <div class="field-grid">
        <label><span>校验方式</span><select v-model="keyMode" @change="selectedKeyIndex = undefined"><option value="none">仅解码</option><option value="secret">共享 secret</option><option value="pem">PEM 公钥</option><option value="jwk">JWK</option><option value="jwks">JWKS</option></select></label>
        <label><span>时钟容差（秒）</span><input v-model.number="clockTolerance" type="number" min="0" max="300" step="1" /></label>
        <label><span>期望 iss（可选）</span><input v-model="expectedIssuer" /></label>
        <label><span>期望 aud（可选）</span><input v-model="expectedAudience" /></label>
        <label><span>期望 sub（可选）</span><input v-model="expectedSubject" /></label>
      </div>
      <template v-if="keyMode !== 'none'">
        <div class="panel-header key-header"><label for="jwt-key">{{ keyLabel }}</label><span>{{ formatJwtBytes(keyBytes) }}</span></div>
        <textarea id="jwt-key" v-model="keyValue" rows="7" spellcheck="false" autocomplete="off" :placeholder="keyMode === 'secret' ? '输入共享 secret' : `粘贴 ${keyLabel}`" />
        <div class="row-actions"><UiButton variant="ghost" @click="paste('key')">粘贴密钥</UiButton></div>
        <label v-if="keyMode === 'jwks' && jwksCandidates.length" class="key-select"><span>手动选择 JWKS key（Header 无 kid 或 kid 重复时必选）</span><select v-model="selectedKeyIndex"><option :value="undefined">请选择</option><option v-for="candidate in jwksCandidates" :key="candidate.index" :value="candidate.index">{{ candidate.label }}</option></select></label>
      </template>
      <div class="primary-action"><UiButton variant="primary" :disabled="!token.trim() || (keyMode !== 'none' && !keyValue)" @click="run">{{ keyMode === 'none' ? '解码 JWT' : '验证签名并检查 Claims' }}</UiButton></div>
    </section>

    <template v-if="decoded">
      <section class="status-grid" aria-label="JWT 校验状态">
        <article class="status-card" :data-status="signature.status"><span>签名</span><strong>{{ signatureStatusLabel(signature.status) }}</strong><p>{{ signature.message }}</p></article>
        <article class="status-card" :data-status="claims?.status ?? 'unchecked'"><span>Claims</span><strong>{{ claims ? claimStatusLabel(claims.status) : '未检查' }}</strong><p v-if="!claims">仅解码时不会自动检查时间与期望值。</p><ul v-else-if="claims.issues.length"><li v-for="issue in claims.issues" :key="`${issue.claim}-${issue.code}`">{{ issue.message }}</li></ul><p v-else>已按当前时间、容差与填写的期望值检查。</p></article>
      </section>

      <div v-if="keyMode === 'none'" class="claims-action"><UiButton @click="checkClaimsOnly">仅检查 Claims（不验证签名）</UiButton></div>

      <section class="decoded-grid">
        <article class="json-card"><div class="panel-header"><h2>Header（已解码）</h2><UiButton variant="ghost" @click="copyJson(decoded.header, 'Header')">复制 Header</UiButton></div><pre>{{ JSON.stringify(decoded.header, null, 2) }}</pre><p class="signature-meta">签名段：{{ decoded.signatureSegment.length }} 个 Base64URL 字符。内容只用于本地验签。</p></article>
        <article class="json-card"><div class="panel-header"><h2>Payload（已解码，不可信）</h2><UiButton variant="ghost" @click="copyJson(decoded.payload, 'Payload')">复制 Payload</UiButton></div><pre>{{ JSON.stringify(decoded.payload, null, 2) }}</pre></article>
      </section>

      <section class="time-card">
        <h2>NumericDate 查看</h2>
        <dl>
          <div><dt>exp</dt><dd>{{ decodedTimes?.exp }}</dd></div>
          <div><dt>nbf</dt><dd>{{ decodedTimes?.nbf }}</dd></div>
          <div><dt>iat</dt><dd>{{ decodedTimes?.iat }}</dd></div>
        </dl>
      </section>
    </template>
    <span class="live-status" aria-live="polite">{{ liveMessage }}</span>
  </main>
</template>

<style scoped>
.tool-page { width: 100%; max-width: 1440px; margin: 0 auto; padding: var(--space-6); }
.tool-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); }
.tool-header h1 { margin: var(--space-1) 0; font-size: 26px; }
.tool-header p { margin: 0; color: var(--text-secondary); }
.breadcrumb { color: var(--text-muted) !important; font-size: 12px; }
.local-badge { flex: none; padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--success) 55%, var(--border-subtle)); border-radius: 999px; color: var(--success); font-size: 12px; font-weight: 700; }
.privacy-note, .trust-warning { padding: var(--space-3); background: var(--bg-surface); color: var(--text-secondary); }
.privacy-note { border-left: 3px solid var(--accent); }
.trust-warning { border-left: 3px solid var(--warning); }
.input-panel, .verify-panel, .json-card, .time-card { margin-top: var(--space-4); padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-surface); }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2); }
.panel-header span { color: var(--text-muted); font-size: 12px; }
.key-header { margin-top: var(--space-4); }
textarea { width: 100%; resize: vertical; padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); font-family: var(--font-mono); line-height: 1.55; }
.row-actions, .primary-action, .claims-action { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
.field-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
.field-grid label, .key-select { display: grid; gap: var(--space-1); color: var(--text-secondary); font-weight: 650; }
input, select { width: 100%; min-height: 40px; padding: 0 var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
.key-select { margin-top: var(--space-3); }
.error-summary { padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--danger) 55%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--danger); }
.status-grid, .decoded-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); margin-top: var(--space-4); }
.status-card { padding: var(--space-4); border: 1px solid var(--border-subtle); border-left: 4px solid var(--text-muted); border-radius: var(--radius-card); background: var(--bg-surface); }
.status-card[data-status='passed'] { border-left-color: var(--success); }
.status-card[data-status='failed'], .status-card[data-status='expired'], .status-card[data-status='format_error'] { border-left-color: var(--danger); }
.status-card[data-status='not_yet_valid'], .status-card[data-status='expected_mismatch'] { border-left-color: var(--warning); }
.status-card span { color: var(--text-muted); }
.status-card strong { display: block; margin-top: var(--space-1); font-size: 18px; }
.status-card p, .status-card ul { margin: var(--space-2) 0 0; color: var(--text-secondary); }
.json-card { min-width: 0; margin-top: 0; }
h2 { margin: 0; font-size: 17px; }
pre { max-height: 360px; overflow: auto; margin: 0; padding: var(--space-3); background: var(--bg-code); color: var(--text-secondary); font-family: var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.signature-meta { margin: var(--space-2) 0 0; color: var(--text-muted); font-size: 12px; }
dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); margin: var(--space-3) 0 0; }
dl div { padding: var(--space-3); background: var(--bg-elevated); }
dt { color: var(--text-muted); font-family: var(--font-mono); }
dd { margin: var(--space-1) 0 0; overflow-wrap: anywhere; }
.live-status { display: block; min-height: 24px; margin-top: var(--space-2); color: var(--success); }
@media (max-width: 767px) {
  .tool-page { padding: var(--space-4); }
  .tool-header { flex-direction: column; }
  .field-grid, .status-grid, .decoded-grid, dl { grid-template-columns: 1fr; }
  .row-actions, .primary-action, .claims-action { flex-wrap: wrap; }
  .row-actions :deep(button), .primary-action :deep(button), .claims-action :deep(button) { min-height: 44px; }
  textarea { min-height: 180px; }
}
</style>

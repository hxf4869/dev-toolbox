<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'

const auth = useAuthStore()
const username = ref('owner')
const password = ref('')
const code = ref('')
const method = ref<'totp' | 'recovery_code'>('totp')
const trustDevice = ref(false)
const deviceName = ref('当前浏览器')
const busy = ref(false)
const errorMessage = ref('')
const copied = ref(false)
const codeInput = ref<HTMLInputElement | null>(null)

const isEnrollment = computed(() => auth.stage === 'totp_setup')
const challengeExpiredLabel = computed(() => {
  if (!auth.challengeExpiresAt) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(auth.challengeExpiresAt),
  )
})

watch(
  () => auth.stage,
  async (stage) => {
    errorMessage.value = ''
    code.value = ''
    if (stage === 'totp_setup' && !auth.provisioning) {
      busy.value = true
      try {
        await auth.loadTOTPProvisioning()
      } catch (error) {
        errorMessage.value = messageFor(error)
      } finally {
        busy.value = false
      }
    }
    if (stage === 'mfa_required') await nextTick(() => codeInput.value?.focus())
  },
  { immediate: true },
)

async function submitLogin() {
  errorMessage.value = ''
  busy.value = true
  try {
    await auth.login(username.value, password.value)
    password.value = ''
  } catch (error) {
    errorMessage.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

async function submitMFA() {
  errorMessage.value = ''
  busy.value = true
  try {
    await auth.verifySecondFactor({
      method: method.value,
      code: code.value,
      trustDevice: trustDevice.value,
      deviceName: deviceName.value,
    })
  } catch (error) {
    errorMessage.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

async function submitEnrollment() {
  errorMessage.value = ''
  busy.value = true
  try {
    await auth.confirmTOTP(code.value, trustDevice.value, deviceName.value)
  } catch (error) {
    errorMessage.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function changeMethod(next: 'totp' | 'recovery_code') {
  method.value = next
  code.value = ''
  errorMessage.value = ''
  void nextTick(() => codeInput.value?.focus())
}

function normalizeCode() {
  if (method.value === 'totp' || isEnrollment.value) {
    code.value = code.value.replace(/\D/g, '').slice(0, 6)
  } else {
    code.value = code.value.toUpperCase().slice(0, 32)
  }
}

async function copyRecoveryCodes() {
  await navigator.clipboard.writeText(auth.recoveryCodes.join('\n'))
  copied.value = true
  window.setTimeout(() => (copied.value = false), 1600)
}

function downloadRecoveryCodes() {
  const blob = new Blob(
    [
      `开发百宝箱恢复码\n生成时间：${new Date().toLocaleString('zh-CN')}\n\n${auth.recoveryCodes.join('\n')}\n`,
    ],
    { type: 'text/plain;charset=utf-8' },
  )
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(blob)
  anchor.download = 'dev-toolbox-recovery-codes.txt'
  anchor.click()
  URL.revokeObjectURL(anchor.href)
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : '请求未成功，请稍后重试'
}
</script>

<template>
  <main class="auth-page">
    <header class="auth-brand" aria-label="开发百宝箱">
      <span class="auth-brand__mark"><UiIcon name="wrench" :size="19" /></span>
      <strong>开发百宝箱</strong>
      <span>v1.0</span>
    </header>

    <section v-if="auth.stage === 'checking'" class="auth-card auth-card--loading" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <h1>正在确认会话</h1>
      <p>只从安全 Cookie 恢复登录状态。</p>
    </section>

    <section v-else-if="auth.stage === 'anonymous'" class="auth-card" aria-labelledby="login-title">
      <div class="auth-card__icon"><UiIcon name="lock-keyhole" /></div>
      <p class="eyebrow">OWNER ACCESS</p>
      <h1 id="login-title">登录开发百宝箱</h1>
      <p class="intro">单用户实例不提供网页注册。请输入由主机管理员初始化的凭据。</p>

      <div v-if="auth.bootstrapError" class="notice notice--warning" role="status">
        <UiIcon name="triangle-alert" />
        <span>{{ auth.bootstrapError }}</span>
      </div>
      <div v-if="errorMessage" class="notice notice--error" role="alert">
        <UiIcon name="triangle-alert" />
        <span>{{ errorMessage }}</span>
      </div>

      <form class="auth-form" @submit.prevent="submitLogin">
        <label>
          <span>账号</span>
          <input v-model="username" name="username" autocomplete="username" required maxlength="120" />
        </label>
        <label>
          <span>密码</span>
          <input
            v-model="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            maxlength="1024"
          />
        </label>
        <UiButton type="submit" variant="primary" :disabled="busy || !username || !password">
          <span v-if="busy" class="spinner spinner--small" aria-hidden="true" />
          {{ busy ? '正在验证' : '继续' }}
        </UiButton>
      </form>
    </section>

    <section v-else-if="auth.stage === 'mfa_required'" class="auth-card" aria-labelledby="mfa-title">
      <div class="auth-card__icon"><UiIcon :name="method === 'totp' ? 'shield-check' : 'key-round'" /></div>
      <p class="eyebrow">SECOND FACTOR</p>
      <h1 id="mfa-title">{{ method === 'totp' ? '两步验证' : '恢复码登录' }}</h1>
      <p class="intro">
        {{ method === 'totp' ? '输入身份验证器中的 6 位动态验证码。' : '每个恢复码只能使用一次。' }}
        <span v-if="challengeExpiredLabel">本次验证于 {{ challengeExpiredLabel }} 前有效。</span>
      </p>

      <div v-if="errorMessage" class="notice notice--error" role="alert">
        <UiIcon name="triangle-alert" />
        <span>{{ errorMessage }}</span>
      </div>

      <form class="auth-form" @submit.prevent="submitMFA">
        <label>
          <span>{{ method === 'totp' ? '验证码' : '恢复码' }}</span>
          <input
            ref="codeInput"
            v-model="code"
            :class="{ 'code-input': method === 'totp' }"
            :inputmode="method === 'totp' ? 'numeric' : 'text'"
            :autocomplete="method === 'totp' ? 'one-time-code' : 'off'"
            :placeholder="method === 'totp' ? '000000' : 'XXXX-XXXX-XXXX-XXXX'"
            required
            @input="normalizeCode"
          />
        </label>
        <label class="trust-control">
          <input v-model="trustDevice" type="checkbox" />
          <span>
            <strong>信任此设备 90 天</strong>
            <small>仍然需要密码；仅在密码正确后跳过 TOTP。</small>
          </span>
        </label>
        <label v-if="trustDevice">
          <span>设备名称</span>
          <input v-model="deviceName" maxlength="120" />
        </label>
        <UiButton type="submit" variant="primary" :disabled="busy || !code">
          {{ busy ? '正在验证' : '验证并登录' }}
        </UiButton>
      </form>
      <button
        class="text-action"
        type="button"
        @click="changeMethod(method === 'totp' ? 'recovery_code' : 'totp')"
      >
        {{ method === 'totp' ? '改用恢复码' : '返回动态验证码' }}
      </button>
    </section>

    <section v-else-if="auth.stage === 'totp_setup'" class="enrollment" aria-labelledby="enrollment-title">
      <header class="enrollment__header">
        <div>
          <p class="eyebrow">SECURITY SETUP</p>
          <h1 id="enrollment-title">绑定身份验证器（TOTP）</h1>
          <p>密钥只在本次绑定挑战中显示，确认后即进入双因素登录。</p>
        </div>
        <span class="status-chip"><UiIcon name="shield-check" /> 必需</span>
      </header>

      <div v-if="errorMessage" class="notice notice--error" role="alert">
        <UiIcon name="triangle-alert" />
        <span>{{ errorMessage }}</span>
      </div>

      <div v-if="busy && !auth.provisioning" class="enrollment__loading" aria-live="polite">
        <span class="spinner" aria-hidden="true" /> 正在生成本地二维码…
      </div>
      <div v-else-if="auth.provisioning" class="enrollment__grid">
        <div class="setup-step">
          <span class="step-number">1</span>
          <div>
            <h2>扫描二维码或输入密钥</h2>
            <p>可使用任意兼容 TOTP 的身份验证器。</p>
            <div class="provisioning">
              <img :src="auth.provisioning.qrCodeDataUrl" alt="TOTP 绑定二维码" width="220" height="220" />
              <div>
                <span>手动输入密钥</span>
                <code>{{ auth.provisioning.manualKey }}</code>
                <small>发行方：开发百宝箱 · 账号：{{ auth.owner?.username ?? username }}</small>
              </div>
            </div>
          </div>
        </div>

        <form class="setup-step" @submit.prevent="submitEnrollment">
          <span class="step-number">2</span>
          <div>
            <h2>输入动态验证码</h2>
            <p>输入当前 6 位验证码，确认扫码成功。</p>
            <input
              ref="codeInput"
              v-model="code"
              class="code-input"
              inputmode="numeric"
              autocomplete="one-time-code"
              placeholder="000000"
              required
              @input="normalizeCode"
            />
            <label class="trust-control trust-control--setup">
              <input v-model="trustDevice" type="checkbox" />
              <span>
                <strong>信任此设备 90 天</strong>
                <small>仅跳过后续 TOTP，不跳过密码。</small>
              </span>
            </label>
            <label v-if="trustDevice" class="field-block">
              <span>设备名称</span>
              <input v-model="deviceName" maxlength="120" />
            </label>
            <div class="setup-actions">
              <UiButton v-if="auth.enrollmentCanCancel" type="button" variant="ghost" @click="auth.cancelEnrollment">
                取消重置
              </UiButton>
              <UiButton type="submit" variant="primary" :disabled="busy || code.length !== 6">
                {{ busy ? '正在确认' : '确认并启用' }}
              </UiButton>
            </div>
          </div>
        </form>
      </div>
    </section>

    <section v-else-if="auth.stage === 'recovery_codes'" class="recovery" aria-labelledby="recovery-title">
      <div class="recovery__success"><UiIcon name="shield-check" :size="22" /></div>
      <p class="eyebrow">ONE-TIME RECOVERY</p>
      <h1 id="recovery-title">身份验证已启用</h1>
      <p>请立即保存下面 10 个恢复码。每个只能使用一次，离开后不会再次显示。</p>
      <div class="notice notice--warning">
        <UiIcon name="triangle-alert" />
        <span>恢复码相当于第二因素，请离线保存在安全位置，不要存入本应用记录。</span>
      </div>
      <ol class="recovery__codes" aria-label="一次性恢复码">
        <li v-for="recoveryCode in auth.recoveryCodes" :key="recoveryCode"><code>{{ recoveryCode }}</code></li>
      </ol>
      <div class="recovery__actions">
        <UiButton variant="secondary" @click="copyRecoveryCodes">
          <UiIcon name="copy" /> {{ copied ? '已复制' : '全部复制' }}
        </UiButton>
        <UiButton variant="secondary" @click="downloadRecoveryCodes">
          <UiIcon name="download" /> 下载备份
        </UiButton>
        <UiButton variant="primary" @click="auth.acknowledgeRecoveryCodes">我已保存并继续</UiButton>
      </div>
    </section>
  </main>
</template>

<style scoped>
.auth-page {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: 76px var(--space-5) var(--space-8);
  background:
    radial-gradient(circle at 50% -20%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 42%),
    var(--bg-app);
}

.auth-brand {
  position: absolute;
  top: var(--space-5);
  left: var(--space-6);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-primary);
}

.auth-brand > span:last-child {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.auth-brand__mark,
.auth-card__icon,
.recovery__success {
  display: inline-flex;
  width: 38px;
  height: 38px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--accent);
}

.auth-brand__mark {
  width: 32px;
  height: 32px;
}

.auth-card,
.recovery {
  width: min(100%, 390px);
  padding: var(--space-6);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-dialog);
  background: var(--bg-surface);
  box-shadow: var(--shadow-overlay);
}

.auth-card--loading {
  text-align: center;
}

.auth-card--loading .spinner {
  margin-inline: auto;
}

.auth-card__icon {
  margin-bottom: var(--space-5);
}

.eyebrow {
  margin: 0 0 var(--space-2);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: var(--space-2);
  font-size: clamp(21px, 4vw, 27px);
  line-height: 1.22;
}

h2 {
  margin-bottom: var(--space-1);
  font-size: 16px;
}

.intro,
.enrollment__header p,
.setup-step p,
.recovery > p {
  color: var(--text-secondary);
}

.intro span {
  display: block;
  margin-top: var(--space-2);
  color: var(--text-muted);
  font-size: 12px;
}

.auth-form {
  display: grid;
  gap: var(--space-4);
  margin-top: var(--space-5);
}

label,
.field-block {
  display: grid;
  gap: var(--space-2);
}

label > span,
.field-block > span {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}

input {
  width: 100%;
  min-height: 42px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-primary);
}

.code-input {
  font-family: var(--font-mono);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.34em;
  text-align: center;
}

.trust-control {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  cursor: pointer;
}

.trust-control input {
  width: 18px;
  min-height: 18px;
  margin-top: 2px;
  accent-color: var(--accent);
}

.trust-control span,
.trust-control small {
  display: block;
}

.trust-control small {
  margin-top: 2px;
  color: var(--text-muted);
  font-weight: 400;
}

.text-action {
  display: block;
  margin: var(--space-4) auto 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
}

.text-action:hover {
  color: var(--accent);
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-4) 0;
  padding: var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 13px;
}

.notice--error {
  border-color: color-mix(in srgb, var(--danger) 65%, var(--border-subtle));
  background: color-mix(in srgb, var(--danger) 10%, var(--bg-elevated));
  color: var(--danger);
}

.notice--warning {
  border-color: color-mix(in srgb, var(--warning) 55%, var(--border-subtle));
}

.spinner {
  display: block;
  width: 26px;
  height: 26px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner--small {
  width: 16px;
  height: 16px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.enrollment {
  width: min(100%, 940px);
  padding: var(--space-6);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-dialog);
  background: var(--bg-surface);
  box-shadow: var(--shadow-overlay);
}

.enrollment__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
}

.enrollment__header p {
  margin-bottom: 0;
}

.status-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: 999px;
  background: color-mix(in srgb, var(--success) 14%, var(--bg-elevated));
  color: var(--success);
  font-size: 12px;
  font-weight: 700;
}

.enrollment__grid {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr;
  gap: var(--space-6);
  padding-top: var(--space-6);
}

.enrollment__loading {
  display: flex;
  min-height: 280px;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  color: var(--text-secondary);
}

.setup-step {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-content: start;
  gap: var(--space-3);
  padding: var(--space-5);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--bg-elevated);
}

.step-number {
  display: inline-grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
}

.provisioning {
  display: grid;
  grid-template-columns: 178px minmax(0, 1fr);
  gap: var(--space-4);
  margin-top: var(--space-5);
}

.provisioning img {
  width: 178px;
  height: 178px;
  padding: var(--space-2);
  border-radius: var(--radius-control);
  background: white;
}

.provisioning span,
.provisioning small,
.provisioning code {
  display: block;
}

.provisioning code {
  margin: var(--space-2) 0 var(--space-3);
  overflow-wrap: anywhere;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.7;
}

.provisioning small {
  color: var(--text-muted);
}

.trust-control--setup {
  margin-top: var(--space-4);
}

.field-block {
  margin-top: var(--space-3);
}

.setup-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-5);
}

.recovery {
  width: min(100%, 580px);
}

.recovery__success {
  margin-bottom: var(--space-4);
  border-color: color-mix(in srgb, var(--success) 55%, var(--border-subtle));
  color: var(--success);
}

.recovery__codes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) var(--space-6);
  margin: var(--space-5) 0;
  padding: var(--space-5) var(--space-5) var(--space-5) 48px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--bg-code);
}

.recovery__codes code {
  color: var(--text-primary);
  font-family: var(--font-mono);
}

.recovery__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.recovery__actions :last-child {
  margin-left: auto;
}

@media (max-width: 720px) {
  .auth-page {
    display: block;
    padding: 72px var(--space-3) var(--space-4);
  }

  .auth-brand {
    top: var(--space-4);
    left: var(--space-4);
  }

  .auth-card,
  .enrollment,
  .recovery {
    width: 100%;
    padding: var(--space-5);
  }

  .enrollment__grid,
  .provisioning {
    grid-template-columns: 1fr;
  }

  .provisioning img {
    width: 164px;
    height: 164px;
  }

  .recovery__codes {
    grid-template-columns: 1fr;
  }

  .recovery__actions > * {
    width: 100%;
  }

  .recovery__actions :last-child {
    margin-left: 0;
  }
}
</style>

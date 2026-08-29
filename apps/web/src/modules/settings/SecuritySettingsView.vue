<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
import SettingsSubnav from './SettingsSubnav.vue'

interface TrustedDevice {
  id: string
  displayName: string
  createdAt: string
  lastUsedAt: string
  expiresAt: string
}

interface AuthSession {
  id: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  trustedDeviceId?: string | null
  userAgent?: string | null
  current: boolean
}

type SensitiveAction = 'password' | 'totp' | 'recovery'

const auth = useAuthStore()
const devices = ref<TrustedDevice[]>([])
const sessions = ref<AuthSession[]>([])
const loading = ref(true)
const pageError = ref('')
const action = ref<SensitiveAction | null>(null)
const actionError = ref('')
const busy = ref(false)
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const method = ref<'totp' | 'recovery_code'>('totp')
const code = ref('')
const editingDeviceID = ref('')
const deviceName = ref('')
const pendingRevoke = ref<{ kind: 'device' | 'session'; id: string } | null>(null)
const actionDialog = ref<HTMLElement | null>(null)
const confirmDialog = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)

const actionTitle = computed(() => {
  if (action.value === 'password') return '修改登录密码'
  if (action.value === 'totp') return '重置身份验证器'
  return '重新生成恢复码'
})

watch(
  () => Boolean(action.value || pendingRevoke.value),
  async (open, wasOpen) => {
    if (open && !wasOpen) previousFocus.value = document.activeElement as HTMLElement | null
    if (open) {
      await nextTick()
      const dialog = pendingRevoke.value ? confirmDialog.value : actionDialog.value
      dialog?.querySelector<HTMLElement>('[autofocus], button:not([disabled]), input:not([disabled])')?.focus()
      return
    }
    if (wasOpen) {
      await nextTick()
      previousFocus.value?.focus()
      previousFocus.value = null
    }
  },
)

onMounted(() => void loadSecurityState())

async function loadSecurityState() {
  loading.value = true
  pageError.value = ''
  try {
    const [deviceResponse, sessionResponse] = await Promise.all([
      apiRequest<{ items: TrustedDevice[] }>('/api/v1/auth/trusted-devices'),
      apiRequest<{ items: AuthSession[] }>('/api/v1/auth/sessions'),
    ])
    devices.value = deviceResponse.items
    sessions.value = sessionResponse.items
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    loading.value = false
  }
}

function openAction(next: SensitiveAction) {
  action.value = next
  actionError.value = ''
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  method.value = 'totp'
  code.value = ''
}

function closeAction() {
  if (busy.value) return
  action.value = null
  actionError.value = ''
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  code.value = ''
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !busy.value) {
    event.preventDefault()
    if (pendingRevoke.value) pendingRevoke.value = null
    else closeAction()
    return
  }
  if (event.key !== 'Tab') return
  const dialog = event.currentTarget as HTMLElement
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.offsetParent !== null)
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function submitSensitiveAction() {
  if (!action.value) return
  actionError.value = ''
  if (action.value === 'password') {
    if (newPassword.value.length < 12) {
      actionError.value = '新密码至少需要 12 个字符。'
      return
    }
    if (newPassword.value !== confirmPassword.value) {
      actionError.value = '两次输入的新密码不一致。'
      return
    }
  }
  busy.value = true
  try {
    if (action.value === 'password') {
      await apiRequest<void>(
        '/api/v1/auth/password/change',
        jsonRequest(
          'POST',
          {
            currentPassword: currentPassword.value,
            newPassword: newPassword.value,
            method: method.value,
            code: code.value,
          },
          auth.csrfToken,
        ),
      )
      auth.clearAuthentication()
      return
    }
    if (action.value === 'totp') {
      await auth.beginTOTPReset(currentPassword.value, method.value, code.value)
      return
    }
    await auth.regenerateRecoveryCodes(currentPassword.value, method.value, code.value)
  } catch (error) {
    actionError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function editDevice(device: TrustedDevice) {
  editingDeviceID.value = device.id
  deviceName.value = device.displayName
}

async function saveDeviceName(device: TrustedDevice) {
  const normalized = deviceName.value.trim()
  if (!normalized) return
  try {
    await apiRequest(`/api/v1/auth/trusted-devices/${device.id}`, jsonRequest('PATCH', { displayName: normalized }, auth.csrfToken))
    device.displayName = normalized
    editingDeviceID.value = ''
  } catch (error) {
    pageError.value = messageFor(error)
  }
}

async function confirmRevoke() {
  if (!pendingRevoke.value) return
  const target = pendingRevoke.value
  busy.value = true
  pageError.value = ''
  try {
    await apiRequest<void>(
      target.kind === 'device'
        ? `/api/v1/auth/trusted-devices/${target.id}`
        : `/api/v1/auth/sessions/${target.id}`,
      { method: 'DELETE', headers: { 'X-CSRF-Token': auth.csrfToken } },
    )
    if (target.kind === 'device') {
      devices.value = devices.value.filter((device) => device.id !== target.id)
    } else {
      const wasCurrent = sessions.value.some((session) => session.id === target.id && session.current)
      sessions.value = sessions.value.filter((session) => session.id !== target.id)
      if (wasCurrent) auth.clearAuthentication()
    }
    pendingRevoke.value = null
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

async function logoutAll() {
  busy.value = true
  pageError.value = ''
  try {
    await auth.logout(true)
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function normalizeCode() {
  if (method.value === 'totp') code.value = code.value.replace(/\D/g, '').slice(0, 6)
  else code.value = code.value.toUpperCase().slice(0, 32)
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function relativeExpiry(value: string) {
  const days = Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000))
  return `${days} 天后到期`
}

function summarizeAgent(value?: string | null) {
  if (!value) return '未知浏览器'
  if (value.includes('Firefox')) return 'Firefox'
  if (value.includes('Edg/')) return 'Microsoft Edge'
  if (value.includes('Chrome')) return 'Chrome'
  if (value.includes('Safari')) return 'Safari'
  return value.slice(0, 80)
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : '请求未成功，请稍后重试'
}
</script>

<template>
  <section class="security" aria-labelledby="security-title">
    <SettingsSubnav />
    <header class="security__header">
      <div>
        <p>设置 · 登录安全</p>
        <h2 id="security-title">安全与会话</h2>
        <span>管理双因素认证、可信设备与当前登录会话。</span>
      </div>
      <span class="security-status"><UiIcon name="shield-check" /> TOTP 已启用</span>
    </header>

    <div v-if="pageError" class="page-notice" role="alert">
      <UiIcon name="triangle-alert" />
      <span>{{ pageError }}</span>
      <button type="button" @click="loadSecurityState">重试</button>
    </div>

    <div v-if="loading" class="security__loading" aria-live="polite">
      <span class="spinner" aria-hidden="true" /> 正在读取安全状态…
    </div>

    <template v-else>
      <section class="security-card" aria-labelledby="authentication-title">
        <header>
          <div>
            <p>LOGIN AUTHENTICATION</p>
            <h3 id="authentication-title">登录验证</h3>
          </div>
        </header>
        <div class="security-row">
          <span class="security-row__icon"><UiIcon name="shield-check" /></span>
          <span><strong>双重认证（TOTP）</strong><small>已启用 · 登录时需要密码和第二因素</small></span>
          <UiButton variant="secondary" @click="openAction('totp')">重置 TOTP</UiButton>
        </div>
        <div class="security-row">
          <span class="security-row__icon"><UiIcon name="key-round" /></span>
          <span><strong>恢复码</strong><small>重新生成会立即使旧恢复码失效</small></span>
          <UiButton variant="secondary" @click="openAction('recovery')">重新生成</UiButton>
        </div>
        <div class="security-row">
          <span class="security-row__icon"><UiIcon name="lock-keyhole" /></span>
          <span><strong>登录密码</strong><small>修改后撤销所有会话与可信设备</small></span>
          <UiButton variant="secondary" @click="openAction('password')">修改密码</UiButton>
        </div>
      </section>

      <section class="security-card" aria-labelledby="devices-title">
        <header>
          <div><p>TRUSTED DEVICES</p><h3 id="devices-title">可信设备</h3></div>
          <span>{{ devices.length }} 台有效设备</span>
        </header>
        <div v-if="devices.length === 0" class="empty-row">没有有效的可信设备；下次登录仍需 TOTP。</div>
        <div v-for="device in devices" :key="device.id" class="security-row">
          <span class="security-row__icon"><UiIcon name="monitor" /></span>
          <span v-if="editingDeviceID !== device.id">
            <strong>{{ device.displayName }}</strong>
            <small>最近使用 {{ formatTime(device.lastUsedAt) }} · {{ relativeExpiry(device.expiresAt) }}</small>
          </span>
          <form v-else class="rename-form" @submit.prevent="saveDeviceName(device)">
            <input v-model="deviceName" maxlength="120" aria-label="设备名称" />
            <button type="submit">保存</button>
            <button type="button" @click="editingDeviceID = ''">取消</button>
          </form>
          <div class="row-actions">
            <button type="button" @click="editDevice(device)">改名</button>
            <button type="button" class="danger" @click="pendingRevoke = { kind: 'device', id: device.id }">撤销</button>
          </div>
        </div>
      </section>

      <section class="security-card" aria-labelledby="sessions-title">
        <header>
          <div><p>ACTIVE SESSIONS</p><h3 id="sessions-title">活跃会话</h3></div>
          <UiButton variant="danger" :disabled="busy" @click="logoutAll">退出全部设备</UiButton>
        </header>
        <div v-for="session in sessions" :key="session.id" class="security-row">
          <span class="security-row__icon"><UiIcon :name="session.userAgent?.includes('Mobile') ? 'smartphone' : 'monitor'" /></span>
          <span>
            <strong>{{ summarizeAgent(session.userAgent) }} <em v-if="session.current">当前会话</em></strong>
            <small>最近活动 {{ formatTime(session.lastSeenAt) }} · 到期 {{ formatTime(session.expiresAt) }}</small>
          </span>
          <button class="row-revoke" type="button" @click="pendingRevoke = { kind: 'session', id: session.id }">
            {{ session.current ? '退出当前' : '撤销会话' }}
          </button>
        </div>
      </section>
    </template>
  </section>

  <Teleport to="body">
    <div v-if="action" class="action-overlay" @click.self="closeAction">
      <section ref="actionDialog" class="action-drawer" role="dialog" aria-modal="true" aria-labelledby="action-title" @keydown="onDialogKeydown">
        <header>
          <div><p>RE-AUTHENTICATION</p><h2 id="action-title">{{ actionTitle }}</h2></div>
          <button type="button" aria-label="关闭" @click="closeAction"><UiIcon name="x" /></button>
        </header>
        <div class="action-drawer__body">
          <div class="reauth-warning">
            <UiIcon name="triangle-alert" />
            <span><strong>需要重新验证</strong>此操作会改变登录安全状态，请输入当前密码和第二因素。</span>
          </div>
          <form id="sensitive-action-form" @submit.prevent="submitSensitiveAction">
            <label><span>当前密码</span><input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" autofocus /></label>
            <template v-if="action === 'password'">
              <label><span>新密码</span><input v-model="newPassword" type="password" autocomplete="new-password" required maxlength="1024" /></label>
              <label><span>确认新密码</span><input v-model="confirmPassword" type="password" autocomplete="new-password" required maxlength="1024" /></label>
            </template>
            <fieldset>
              <legend>第二因素</legend>
              <label><input v-model="method" type="radio" value="totp" /> 动态验证码</label>
              <label><input v-model="method" type="radio" value="recovery_code" /> 恢复码</label>
            </fieldset>
            <label>
              <span>{{ method === 'totp' ? '6 位验证码' : '一次性恢复码' }}</span>
              <input v-model="code" :class="{ 'code-input': method === 'totp' }" :inputmode="method === 'totp' ? 'numeric' : 'text'" required @input="normalizeCode" />
            </label>
            <div v-if="actionError" class="action-error" role="alert"><UiIcon name="triangle-alert" /> {{ actionError }}</div>
          </form>
        </div>
        <footer>
          <UiButton variant="ghost" @click="closeAction">取消</UiButton>
          <UiButton form="sensitive-action-form" type="submit" :variant="action === 'password' ? 'danger' : 'primary'" :disabled="busy || !currentPassword || !code">
            {{ busy ? '正在验证' : action === 'password' ? '修改并退出全部设备' : '验证并继续' }}
          </UiButton>
        </footer>
      </section>
    </div>

    <div v-if="pendingRevoke" class="confirm-overlay" role="alertdialog" aria-modal="true" aria-labelledby="revoke-title">
      <div ref="confirmDialog" @keydown="onDialogKeydown">
        <h2 id="revoke-title">确认撤销？</h2>
        <p>{{ pendingRevoke.kind === 'device' ? '该设备下次登录将重新要求 TOTP。' : '该会话会立即失效。' }}</p>
        <UiButton variant="danger" :disabled="busy" autofocus @click="confirmRevoke">确认撤销</UiButton>
        <UiButton variant="ghost" :disabled="busy" @click="pendingRevoke = null">取消</UiButton>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.security { width: min(100%, 900px); min-height: 100dvh; padding: var(--space-6); }
.security__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); padding-bottom: var(--space-5); border-bottom: 1px solid var(--border-subtle); }
.security__header p, .security__header h2, .security__header span { margin: 0; }
.security__header p, .security-card header p { color: var(--text-muted); font-family: var(--font-mono); font-size: 10px; letter-spacing: .06em; }
.security__header h2 { font-size: 22px; }
.security__header > div > span { color: var(--text-secondary); }
.security-status { display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-radius: 999px; background: color-mix(in srgb, var(--success) 12%, var(--bg-elevated)); color: var(--success); font-size: 12px; font-weight: 700; }
.page-notice { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-4); padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); }
.page-notice button { margin-left: auto; border: 0; background: transparent; color: inherit; cursor: pointer; }
.security__loading { display: flex; min-height: 320px; align-items: center; justify-content: center; gap: var(--space-3); color: var(--text-secondary); }
.spinner { width: 26px; height: 26px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.security-card { margin-top: var(--space-5); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); overflow: hidden; }
.security-card > header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.security-card header p, .security-card header h3 { margin: 0; }
.security-card header h3 { font-size: 15px; }
.security-card header > span { color: var(--text-muted); font-size: 11px; }
.security-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 68px; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.security-row:last-child { border-bottom: 0; }
.security-row__icon { display: inline-grid; width: 36px; height: 36px; place-items: center; border-radius: var(--radius-control); background: var(--bg-code); color: var(--accent); }
.security-row > span, .security-row small { display: block; min-width: 0; }
.security-row strong { display: block; }
.security-row small { color: var(--text-muted); }
.security-row em { padding: 2px 5px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 9px; font-style: normal; }
.row-actions { display: flex; gap: var(--space-2); }
.row-actions button, .row-revoke { border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 12px; }
.row-actions button:hover, .row-revoke:hover, .row-actions .danger { color: var(--danger); }
.rename-form { display: flex; min-width: 0; gap: var(--space-1); }
.rename-form input { min-width: 0; padding: var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
.rename-form button { border: 0; background: transparent; color: var(--accent); cursor: pointer; }
.empty-row { padding: var(--space-5); color: var(--text-muted); text-align: center; }
.action-overlay, .confirm-overlay { position: fixed; z-index: var(--layer-overlay); inset: 0; background: var(--scrim); }
.action-drawer { position: absolute; top: 0; right: 0; display: grid; width: min(430px, 100vw); height: 100dvh; grid-template-rows: auto minmax(0, 1fr) auto; border-left: 1px solid var(--border-strong); background: var(--bg-surface); box-shadow: var(--shadow-overlay); }
.action-drawer > header, .action-drawer > footer { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.action-drawer > header p, .action-drawer > header h2 { margin: 0; }
.action-drawer > header p { color: var(--text-muted); font-family: var(--font-mono); font-size: 10px; }
.action-drawer > header h2 { font-size: 17px; }
.action-drawer > header button { border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; }
.action-drawer__body { overflow-y: auto; padding: var(--space-4); }
.action-drawer > footer { justify-content: flex-end; border-top: 1px solid var(--border-subtle); border-bottom: 0; }
.reauth-warning { display: flex; gap: var(--space-2); margin-bottom: var(--space-5); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--danger) 60%, var(--border-subtle)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--danger) 9%, var(--bg-elevated)); color: var(--danger); }
.reauth-warning strong, .reauth-warning span { display: block; }
#sensitive-action-form { display: grid; gap: var(--space-4); }
#sensitive-action-form > label { display: grid; gap: var(--space-2); }
#sensitive-action-form label > span, fieldset legend { color: var(--text-secondary); font-size: 12px; font-weight: 700; }
#sensitive-action-form > label input { min-height: 42px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
fieldset { display: flex; gap: var(--space-4); margin: 0; padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
fieldset label { color: var(--text-secondary); }
.code-input { font-family: var(--font-mono); font-size: 18px; letter-spacing: .3em; text-align: center; }
.action-error { display: flex; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); }
.confirm-overlay { display: grid; z-index: calc(var(--layer-overlay) + 2); place-content: center; padding: var(--space-4); }
.confirm-overlay > div { width: min(100vw - 32px, 360px); padding: var(--space-5); border: 1px solid var(--border-strong); border-radius: var(--radius-dialog); background: var(--bg-elevated); box-shadow: var(--shadow-overlay); }
.confirm-overlay h2 { margin: 0 0 var(--space-2); font-size: 18px; }
.confirm-overlay p { margin: 0 0 var(--space-5); color: var(--text-secondary); }
.confirm-overlay button { width: 100%; margin-top: var(--space-2); }
@media (max-width: 599px) {
  .security { padding: var(--space-4); }
  .security__header { display: block; }
  .security-status { margin-top: var(--space-3); }
  .security-row { grid-template-columns: auto minmax(0, 1fr); }
  .security-row > button, .row-actions { grid-column: 2; justify-self: start; }
  .action-drawer { width: 100vw; border-left: 0; }
}
</style>

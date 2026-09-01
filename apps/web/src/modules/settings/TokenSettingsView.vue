<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
import SettingsPageShell from './SettingsPageShell.vue'

type TokenScope =
  | 'records:read'
  | 'records:write'
  | 'attachments:read'
  | 'artifacts:write'
  | 'tasks:run'
  | 'sensitive:read'

interface TokenEntry {
  id: string
  name: string
  tokenPrefix: string
  scopes: TokenScope[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

interface IssuedToken {
  id: string
  name: string
  tokenPrefix: string
  scopes: TokenScope[]
  createdAt: string
  expiresAt: string | null
  token: string
}

const scopeOptions: Array<{ value: TokenScope; label: string; detail: string; sensitive?: boolean }> = [
  { value: 'records:read', label: '读取记录', detail: '列表、搜索与 normal 原文。' },
  { value: 'records:write', label: '新增原始记录', detail: '新建 item 或追加 supplement，不能修改既有事实。' },
  { value: 'attachments:read', label: '读取附件', detail: '还必须同时具备 records:read。' },
  { value: 'artifacts:write', label: '提交候选 Artifact', detail: '只创建候选版本，不会自动激活。' },
  { value: 'tasks:run', label: '发起内置 AI 任务', detail: '外发仍受实例敏感策略约束。' },
  { value: 'sensitive:read', label: '读取敏感内容', detail: '独立附加门槛，不会单独赋予读取权限。', sensitive: true },
]

const auth = useAuthStore()
const tokens = ref<TokenEntry[]>([])
const loading = ref(true)
const pageError = ref('')
const actionError = ref('')
const busy = ref(false)
const createOpen = ref(false)
const revokeTarget = ref<TokenEntry | null>(null)
const issuedToken = ref<IssuedToken | null>(null)
const name = ref('')
const expiresAt = ref('')
const selectedScopes = ref<TokenScope[]>(['records:read'])
const copied = ref(false)
const dialogRoot = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)

const activeCount = computed(
  () => tokens.value.filter((token) => !token.revokedAt && (!token.expiresAt || new Date(token.expiresAt) > new Date())).length,
)

watch(
  () => createOpen.value || Boolean(revokeTarget.value) || Boolean(issuedToken.value),
  async (open, wasOpen) => {
    if (open && !wasOpen) previousFocus.value = document.activeElement as HTMLElement | null
    if (open) {
      await nextTick()
      dialogRoot.value
        ?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])')
        ?.focus()
    } else if (wasOpen) {
      await nextTick()
      previousFocus.value?.focus()
      previousFocus.value = null
    }
  },
)

onMounted(() => void loadTokens())

async function loadTokens() {
  loading.value = true
  pageError.value = ''
  try {
    tokens.value = (await apiRequest<{ items: TokenEntry[] }>('/api/v1/tokens')).items
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  name.value = ''
  expiresAt.value = ''
  selectedScopes.value = ['records:read']
  actionError.value = ''
  copied.value = false
  createOpen.value = true
}

function closeCreate() {
  if (busy.value) return
  createOpen.value = false
  actionError.value = ''
}

async function createToken() {
  actionError.value = ''
  if (!name.value.trim() || selectedScopes.value.length === 0) {
    actionError.value = '请填写名称并至少选择一个 scope。'
    return
  }
  let expiry: string | null = null
  if (expiresAt.value) {
    const parsed = new Date(expiresAt.value)
    if (!Number.isFinite(parsed.getTime()) || parsed <= new Date()) {
      actionError.value = '到期时间必须晚于当前时间。'
      return
    }
    expiry = parsed.toISOString()
  }
  busy.value = true
  try {
    const response = await apiRequest<IssuedToken>(
      '/api/v1/tokens',
      jsonRequest(
        'POST',
        { name: name.value.trim(), scopes: selectedScopes.value, expiresAt: expiry },
        auth.csrfToken,
      ),
    )
    createOpen.value = false
    issuedToken.value = response
    await loadTokens()
  } catch (error) {
    actionError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

async function copyIssuedToken() {
  if (!issuedToken.value) return
  try {
    await navigator.clipboard.writeText(issuedToken.value.token)
    copied.value = true
  } catch {
    actionError.value = '浏览器未允许复制，请手动选择并复制 Token。'
  }
}

function closeIssuedToken() {
  if (busy.value) return
  issuedToken.value = null
  copied.value = false
  actionError.value = ''
}

async function revokeToken() {
  if (!revokeTarget.value) return
  busy.value = true
  actionError.value = ''
  try {
    await apiRequest<void>(`/api/v1/tokens/${revokeTarget.value.id}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': auth.csrfToken },
    })
    revokeTarget.value = null
    await loadTokens()
  } catch (error) {
    actionError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function tokenStatus(token: TokenEntry) {
  if (token.revokedAt) return { label: '已撤销', className: 'settings-status--danger' }
  if (token.expiresAt && new Date(token.expiresAt) <= new Date()) {
    return { label: '已过期', className: 'settings-status--warning' }
  }
  return { label: '有效', className: 'settings-status--success' }
}

function formatTime(value: string | null) {
  if (!value) return '从未使用'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function scopeLabel(scope: TokenScope) {
  return scopeOptions.find((option) => option.value === scope)?.label ?? scope
}

function onDialogKeydown(event: KeyboardEvent, close: () => void) {
  if (event.key === 'Escape' && !busy.value) {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const root = event.currentTarget as HTMLElement
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null)
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

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : '请求未成功，请稍后重试'
}
</script>

<template>
  <SettingsPageShell
    title-id="token-title"
    title="Personal Access Token"
    description="为脚本或外部工具创建和撤销访问令牌；明文只显示一次。"
    :show-aside="!loading"
    :surface="false"
  >
    <template #actions>
      <UiButton variant="primary" @click="openCreate"><UiIcon name="plus" /> 创建 Token</UiButton>
    </template>

    <template #notices>
      <div class="settings-notice" role="note">
        <UiIcon name="shield-check" />
        <span><strong>固定边界：</strong>PAT 不能修改既有原文、标题、目录、标签或敏感状态，也不能管理 Provider 与登录安全。</span>
      </div>
      <div v-if="pageError" class="settings-notice settings-notice--danger" role="alert">
        <UiIcon name="triangle-alert" /><span>{{ pageError }}</span><button type="button" @click="loadTokens">重试</button>
      </div>
    </template>

    <div class="settings-toolbar"><p>{{ activeCount }} 个有效 Token · {{ tokens.length }} 个历史记录</p></div>
    <div v-if="loading" class="settings-loading" aria-live="polite"><span class="settings-spinner" aria-hidden="true" />正在读取 Token…</div>
    <div v-else-if="tokens.length === 0" class="settings-card settings-empty">
      <div><UiIcon name="key-round" :size="28" /><h3>尚无 Personal Access Token</h3><p>按外部 Agent 的实际操作选择 scope，不要共享同一 Token。</p></div>
    </div>

    <div v-else class="token-list">
      <article v-for="token in tokens" :key="token.id" class="settings-card token-card">
        <header class="settings-card__header">
          <div><p class="settings-kicker">{{ token.tokenPrefix }}…</p><h3>{{ token.name }}</h3><p>创建于 {{ formatTime(token.createdAt) }}</p></div>
          <span class="settings-status" :class="tokenStatus(token).className">{{ tokenStatus(token).label }}</span>
        </header>
        <div class="settings-card__body token-card__body">
          <dl><div><dt>最后使用</dt><dd>{{ formatTime(token.lastUsedAt) }}</dd></div><div><dt>到期时间</dt><dd>{{ token.expiresAt ? formatTime(token.expiresAt) : '永不过期' }}</dd></div></dl>
          <div class="scope-list" role="list" aria-label="Token scopes"><span v-for="scope in token.scopes" :key="scope" role="listitem" :class="{ sensitive: scope === 'sensitive:read' }">{{ scopeLabel(scope) }}<code>{{ scope }}</code></span></div>
        </div>
        <footer><UiButton variant="danger" :disabled="Boolean(token.revokedAt)" @click="revokeTarget = token">{{ token.revokedAt ? '已撤销' : '撤销 Token' }}</UiButton></footer>
      </article>
    </div>

    <template #aside>
      <section>
        <h3>访问边界摘要</h3>
        <dl class="settings-context__list">
          <div><dt>有效 Token</dt><dd>{{ activeCount }}</dd></div>
          <div><dt>历史记录</dt><dd>{{ tokens.length }}</dd></div>
          <div><dt>可选 Scope</dt><dd>{{ scopeOptions.length }}</dd></div>
          <div><dt>明文回显</dt><dd>仅创建时一次</dd></div>
        </dl>
      </section>
      <section class="settings-context__notice settings-context__notice--success">
        <UiIcon name="shield-check" />
        <div>
          <strong>最小权限优先</strong>
          <p>为每个脚本或 Agent 单独创建 Token，用完即撤销；不要跨用途共享。</p>
        </div>
      </section>
      <p class="settings-context__footnote">读取敏感内容需要普通读取 scope 与 `sensitive:read` 同时满足，后者不会单独赋予读取能力。</p>
    </template>
  </SettingsPageShell>

  <Teleport to="body">
    <div v-if="createOpen" class="settings-overlay" @click.self="closeCreate">
      <section ref="dialogRoot" class="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="token-create-title" @keydown="onDialogKeydown($event, closeCreate)">
        <header><div><h2 id="token-create-title">创建 Personal Access Token</h2></div><button class="settings-icon-button" type="button" aria-label="关闭" @click="closeCreate"><UiIcon name="x" /></button></header>
        <div class="settings-drawer__body">
          <form id="token-form" class="settings-form" @submit.prevent="createToken">
            <label class="settings-field"><span>Token 名称</span><input v-model="name" required maxlength="120" autocomplete="off" placeholder="例如：Notion 一次性迁移" /></label>
            <label class="settings-field"><span>到期时间（可选）</span><input v-model="expiresAt" type="datetime-local" /><small>一次性迁移建议设置较短到期时间，并在完成后立即撤销。</small></label>
            <fieldset class="settings-fieldset scope-fieldset">
              <legend>Scopes</legend>
              <label v-for="scope in scopeOptions" :key="scope.value" class="settings-check" :class="{ 'scope-sensitive': scope.sensitive }">
                <input v-model="selectedScopes" type="checkbox" :value="scope.value" />
                <span><strong>{{ scope.label }}</strong><code>{{ scope.value }}</code><small>{{ scope.detail }}</small></span>
              </label>
            </fieldset>
            <div v-if="selectedScopes.includes('sensitive:read')" class="settings-notice settings-notice--warning"><UiIcon name="triangle-alert" /><span>`sensitive:read` 会允许符合其他读取 scope 的敏感原文或附件被外部进程读取；请确认确有需要。</span></div>
            <div v-if="actionError" class="settings-notice settings-notice--danger" role="alert"><UiIcon name="triangle-alert" />{{ actionError }}</div>
          </form>
        </div>
        <footer><UiButton variant="ghost" @click="closeCreate">取消</UiButton><UiButton type="submit" form="token-form" variant="primary" :disabled="busy">{{ busy ? '正在创建…' : '创建并显示一次' }}</UiButton></footer>
      </section>
    </div>

    <div v-if="issuedToken" class="settings-overlay settings-dialog-shell" role="dialog" aria-modal="true" aria-labelledby="issued-token-title">
      <section ref="dialogRoot" class="settings-dialog issued-dialog" @keydown="onDialogKeydown($event, closeIssuedToken)">
        <span class="issued-icon"><UiIcon name="key-round" :size="24" /></span>
        <h2 id="issued-token-title">立即保存这个 Token</h2>
        <p>关闭后服务端不会再次返回明文。请把它放入受控 Secret 或环境变量，不要保存到浏览器存储或仓库。</p>
        <label class="settings-field token-value"><span>{{ issuedToken.name }}</span><input :value="issuedToken.token" readonly spellcheck="false" autocomplete="off" @focus="($event.target as HTMLInputElement).select()" /></label>
        <div v-if="actionError" class="settings-notice settings-notice--danger" role="alert">{{ actionError }}</div>
        <div class="settings-actions"><UiButton variant="secondary" @click="copyIssuedToken"><UiIcon :name="copied ? 'check' : 'copy'" />{{ copied ? '已复制' : '复制 Token' }}</UiButton><UiButton variant="primary" @click="closeIssuedToken">我已安全保存</UiButton></div>
      </section>
    </div>

    <div v-if="revokeTarget" class="settings-overlay settings-dialog-shell" role="alertdialog" aria-modal="true" aria-labelledby="revoke-token-title">
      <section ref="dialogRoot" class="settings-dialog" @keydown="onDialogKeydown($event, () => (revokeTarget = null))">
        <h2 id="revoke-token-title">立即撤销 “{{ revokeTarget.name }}”？</h2>
        <p>撤销后所有使用该 Token 的请求会立即失败，且不能恢复。</p>
        <div v-if="actionError" class="settings-notice settings-notice--danger" role="alert">{{ actionError }}</div>
        <div class="settings-actions"><UiButton variant="ghost" :disabled="busy" @click="revokeTarget = null">取消</UiButton><UiButton variant="danger" :disabled="busy" @click="revokeToken">{{ busy ? '正在撤销…' : '确认撤销' }}</UiButton></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.token-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.token-card { display: grid; grid-template-rows: auto 1fr auto; }
.token-card__body { display: grid; gap: var(--space-4); }
.token-card dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); margin: 0; }
.token-card dl div { padding: var(--space-3); border-radius: var(--radius-control); background: var(--bg-code); }
.token-card dt { color: var(--text-muted); font-size: 10px; text-transform: uppercase; }
.token-card dd { margin: var(--space-1) 0 0; color: var(--text-secondary); }
.scope-list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.scope-list > span { padding: 5px 8px; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--text-secondary); font-size: 11px; }
.scope-list > span.sensitive { border-color: color-mix(in srgb, var(--sensitive) 55%, var(--border-subtle)); color: var(--sensitive); }
.scope-list code { display: block; margin-top: 1px; color: var(--text-muted); font-family: var(--font-mono); font-size: 9px; }
.token-card > footer { display: flex; justify-content: flex-end; padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-subtle); }
.scope-fieldset { gap: var(--space-1); }
.scope-fieldset .settings-check { padding: var(--space-3); border-radius: var(--radius-control); }
.scope-fieldset .settings-check:hover { background: var(--bg-code); }
.scope-fieldset .settings-check > span, .scope-fieldset strong, .scope-fieldset code, .scope-fieldset small { display: block; }
.scope-fieldset code { color: var(--accent); font-family: var(--font-mono); font-size: 10px; }
.scope-fieldset small { margin-top: 2px; }
.scope-sensitive { color: var(--sensitive); }
.issued-dialog { border-color: color-mix(in srgb, var(--warning) 55%, var(--border-strong)); }
.issued-icon { display: grid; width: 48px; height: 48px; margin-bottom: var(--space-3); place-items: center; border-radius: var(--radius-card); background: color-mix(in srgb, var(--warning) 14%, var(--bg-code)); color: var(--warning); }
.token-value { margin-top: var(--space-5); }
.token-value input { font-family: var(--font-mono); }
@media (max-width: 799px) { .token-list { grid-template-columns: 1fr; } }
@media (max-width: 599px) { .token-card dl { grid-template-columns: 1fr; } }
</style>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
import SettingsPageShell from './SettingsPageShell.vue'

type SensitivePolicy = 'block' | 'redact' | 'allow'

interface ProviderModel {
  id: string
  displayName: string
  modelId: string
  contextWindow: number | null
  maxOutputTokens: number | null
  supportsTools: boolean
  supportsVision: boolean
  enabled: boolean
}

interface ProviderEntry {
  id: string
  displayName: string
  enabled: boolean
  models: ProviderModel[]
}

interface AISettings {
  sensitiveDisplayMode: 'masked'
  sensitiveAiPolicy: SensitivePolicy
  defaultOrganizeModelId: string | null
  defaultReviewModelId: string | null
  defaultVisionModelId: string | null
}

const policies: Array<{
  value: SensitivePolicy
  label: string
  detail: string
  badge: string
}> = [
  { value: 'block', label: '阻止外发', detail: '敏感或未知条目不允许创建内置 AI 任务。', badge: '最严格' },
  { value: 'redact', label: '遮挡后外发', detail: '文本使用本次任务内存中的占位副本；图片无法可靠遮挡时仍阻止。', badge: '默认' },
  { value: 'allow', label: '允许原文外发', detail: '把敏感原文或图片发送给所选 Provider，适合明确受控的模型环境。', badge: '高风险' },
]

const auth = useAuthStore()
const providers = ref<ProviderEntry[]>([])
const settings = ref<AISettings | null>(null)
const policy = ref<SensitivePolicy>('redact')
const organizeModelID = ref('')
const reviewModelID = ref('')
const visionModelID = ref('')
const loading = ref(true)
const busy = ref(false)
const pageError = ref('')
const saved = ref(false)
const confirmAllowOpen = ref(false)
const allowConfirmed = ref(false)
const dialogRoot = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)

const taskModels = computed(() => flattenModels(false))
const visionModels = computed(() => flattenModels(true))
const selectedPolicy = computed(() => policies.find((choice) => choice.value === policy.value) ?? policies[1]!)
const configuredDefaultCount = computed(() =>
  [organizeModelID.value, reviewModelID.value, visionModelID.value].filter(Boolean).length,
)
const pendingChangeCount = computed(() => {
  if (!settings.value) return 0
  return [
    settings.value.sensitiveAiPolicy !== policy.value,
    (settings.value.defaultOrganizeModelId ?? '') !== organizeModelID.value,
    (settings.value.defaultReviewModelId ?? '') !== reviewModelID.value,
    (settings.value.defaultVisionModelId ?? '') !== visionModelID.value,
  ].filter(Boolean).length
})

watch(policy, (next) => {
  saved.value = false
  if (next !== 'allow') allowConfirmed.value = false
})

watch(confirmAllowOpen, async (open, wasOpen) => {
  if (open && !wasOpen) previousFocus.value = document.activeElement as HTMLElement | null
  if (open) {
    await nextTick()
    dialogRoot.value?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  } else if (wasOpen) {
    await nextTick()
    previousFocus.value?.focus()
    previousFocus.value = null
  }
})

onMounted(() => void loadState())

async function loadState() {
  loading.value = true
  pageError.value = ''
  saved.value = false
  try {
    const [providerResponse, settingsResponse] = await Promise.all([
      apiRequest<{ items: ProviderEntry[] }>('/api/v1/ai/providers'),
      apiRequest<AISettings>('/api/v1/ai/settings'),
    ])
    providers.value = providerResponse.items
    settings.value = settingsResponse
    policy.value = settingsResponse.sensitiveAiPolicy
    organizeModelID.value = settingsResponse.defaultOrganizeModelId ?? ''
    reviewModelID.value = settingsResponse.defaultReviewModelId ?? ''
    visionModelID.value = settingsResponse.defaultVisionModelId ?? ''
    allowConfirmed.value = settingsResponse.sensitiveAiPolicy === 'allow'
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    loading.value = false
  }
}

function flattenModels(vision: boolean) {
  return providers.value.flatMap((provider) =>
    provider.enabled
      ? provider.models
          .filter(
            (model) =>
              model.enabled &&
              (!vision || model.supportsVision) &&
              model.contextWindow !== null &&
              model.maxOutputTokens !== null,
          )
          .map((model) => ({
            id: model.id,
            label: `${provider.displayName} · ${model.displayName}`,
            detail: model.modelId,
          }))
      : [],
  )
}

async function requestSave() {
  saved.value = false
  if (policy.value === 'allow' && !allowConfirmed.value) {
    confirmAllowOpen.value = true
    return
  }
  await persistSettings()
}

async function confirmAllow() {
  allowConfirmed.value = true
  confirmAllowOpen.value = false
  await persistSettings()
}

async function persistSettings() {
  busy.value = true
  pageError.value = ''
  saved.value = false
  try {
    const response = await apiRequest<AISettings>(
      '/api/v1/ai/settings',
      jsonRequest(
        'PUT',
        {
          sensitiveAiPolicy: policy.value,
          defaultOrganizeModelId: organizeModelID.value,
          defaultReviewModelId: reviewModelID.value,
          defaultVisionModelId: visionModelID.value,
          confirmSensitiveAllow: policy.value === 'allow' && allowConfirmed.value,
        },
        auth.csrfToken,
      ),
    )
    settings.value = response
    saved.value = true
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !busy.value) {
    event.preventDefault()
    confirmAllowOpen.value = false
    return
  }
  if (event.key !== 'Tab') return
  const root = event.currentTarget as HTMLElement
  const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])')).filter(
    (element) => element.offsetParent !== null,
  )
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
    title-id="ai-security-title"
    title="AI 与敏感数据"
    description="设置敏感内容的显示方式，以及它能否发送给 AI 服务。"
    :show-aside="!loading"
  >
    <template #actions>
      <UiButton variant="primary" :disabled="loading || busy" @click="requestSave"><UiIcon name="save" />{{ busy ? '正在保存…' : '保存策略' }}</UiButton>
    </template>

    <template #notices>
      <div v-if="pageError" class="settings-notice settings-notice--danger" role="alert">
        <UiIcon name="triangle-alert" /><span>{{ pageError }}</span><button type="button" @click="loadState">重新读取</button>
      </div>
      <div v-if="saved" class="settings-notice policy-saved" role="status"><UiIcon name="check" />策略与默认模型已保存。</div>
    </template>

    <div v-if="loading" class="settings-loading" aria-live="polite"><span class="settings-spinner" aria-hidden="true" />正在读取 AI 安全设置…</div>

    <template v-else>
        <section class="settings-card" aria-labelledby="display-mode-title">
        <header class="settings-card__header"><div><h3 id="display-mode-title">敏感内容展示</h3><p>默认遮挡，明确打开后再读取。</p></div><span class="settings-status settings-status--success">固定为遮挡</span></header>
        <div class="settings-card__body display-policy">
          <span class="masked-preview"><UiIcon name="eye-off" /><code>••••••••••••</code></span>
          <div><strong>默认不请求、也不显示敏感原文</strong><p>列表和搜索不会返回原文；主动揭示时才读取。访问令牌还需具备敏感内容读取权限。</p></div>
        </div>
        </section>

        <section class="settings-card" aria-labelledby="ai-policy-title">
        <header class="settings-card__header"><div><h3 id="ai-policy-title">敏感内容 AI 策略</h3><p>设置所有任务都不能放宽的上限。</p></div></header>
        <div class="settings-card__body policy-grid">
          <label v-for="choice in policies" :key="choice.value" class="policy-choice" :class="[`policy-choice--${choice.value}`, { selected: policy === choice.value }]">
            <input v-model="policy" type="radio" name="sensitive-policy" :value="choice.value" />
            <span><strong>{{ choice.label }}<em>{{ choice.badge }}</em></strong><small>{{ choice.detail }}</small></span>
          </label>
        </div>
        <div v-if="policy === 'allow'" class="allow-warning" role="alert"><UiIcon name="triangle-alert" /><span><strong>高风险模式</strong>敏感原文可能离开本机并进入所选 Provider。系统仍不会执行模型返回的 Shell、SSH、SQL、任意 HTTP 或高权限工具。</span></div>
        </section>

        <section class="settings-card" aria-labelledby="default-models-title">
        <header class="settings-card__header"><div><h3 id="default-models-title">默认模型</h3><p>只显示可用且能力匹配的模型。</p></div></header>
        <div class="settings-card__body settings-form">
          <label class="settings-field"><span>记录整理</span><select v-model="organizeModelID"><option value="">未设置</option><option v-for="model in taskModels" :key="model.id" :value="model.id">{{ model.label }} · {{ model.detail }}</option></select><small>需要工具调用；未设置时手动任务必须显式选择模型。</small></label>
          <label class="settings-field"><span>正确性审查</span><select v-model="reviewModelID"><option value="">未设置</option><option v-for="model in taskModels" :key="model.id" :value="model.id">{{ model.label }} · {{ model.detail }}</option></select></label>
          <label class="settings-field"><span>图片分析</span><select v-model="visionModelID"><option value="">未设置</option><option v-for="model in visionModels" :key="model.id" :value="model.id">{{ model.label }} · {{ model.detail }}</option></select><small>必须同时声明工具调用和视觉输入能力。</small></label>
          <p v-if="taskModels.length === 0" class="model-guidance"><UiIcon name="circle-help" />还没有可用模型。先到 “Provider 与模型” 配置模型限制与工具能力；这不会影响录入、检索和附件。</p>
        </div>
        </section>
    </template>

    <template #aside>
        <section>
          <h3 id="policy-summary-title">当前策略摘要</h3>
          <dl class="settings-context__list">
            <div><dt>浏览器展示</dt><dd>默认遮挡</dd></div>
            <div><dt>AI 外发</dt><dd :class="{ 'summary-danger': policy === 'allow' }">{{ selectedPolicy.label }}</dd></div>
            <div><dt>默认模型</dt><dd>{{ configuredDefaultCount }} / 3 已设置</dd></div>
            <div><dt>待保存变更</dt><dd>{{ pendingChangeCount }}</dd></div>
          </dl>
        </section>
        <section
          class="settings-context__notice"
          :class="policy === 'allow' ? 'settings-context__notice--danger' : 'settings-context__notice--success'"
        >
          <UiIcon :name="policy === 'allow' ? 'triangle-alert' : 'shield-check'" />
          <div>
            <strong>{{ policy === 'allow' ? '原文可能离开本机' : '外发边界受控' }}</strong>
            <p>{{ policy === 'allow' ? '保存前请确认所选 Provider 的数据保留、训练和合规条款。' : '单次任务只能沿用当前策略或选择更严格的边界。' }}</p>
          </div>
        </section>
        <p class="settings-context__footnote">保存只更新实例策略与默认模型，不修改已有记录，也不会授予命令执行能力。</p>
    </template>
  </SettingsPageShell>

  <Teleport to="body">
    <div v-if="confirmAllowOpen" class="settings-overlay settings-dialog-shell" role="alertdialog" aria-modal="true" aria-labelledby="allow-confirm-title">
      <section ref="dialogRoot" class="settings-dialog allow-dialog" @keydown="onDialogKeydown">
        <span class="allow-dialog__icon"><UiIcon name="shield-alert" :size="26" /></span>
        <h2 id="allow-confirm-title">确认允许敏感原文外发？</h2>
        <p>启用后，选择 “allow” 的任务可把敏感/未知文本或图片发送到已配置 Provider。Provider 的数据保留、训练与合规行为由其自身条款决定。</p>
        <div class="settings-notice settings-notice--warning"><UiIcon name="triangle-alert" />该设置不授予任何命令执行能力，也不会修改原始记录；但会扩大数据外发范围。</div>
        <div class="settings-actions"><UiButton variant="ghost" :disabled="busy" @click="confirmAllowOpen = false">保持更严格策略</UiButton><UiButton variant="danger" :disabled="busy" @click="confirmAllow">确认允许并保存</UiButton></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.policy-saved { border-color: color-mix(in srgb, var(--success) 55%, var(--border-subtle)); color: var(--success); }
.summary-danger { color: var(--danger) !important; }
.display-policy { display: grid; grid-template-columns: 180px minmax(0, 1fr); align-items: center; gap: var(--space-5); }
.display-policy p { margin: var(--space-1) 0 0; color: var(--text-secondary); }
.masked-preview { display: flex; min-height: 88px; align-items: center; justify-content: center; gap: var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-code); color: var(--sensitive); }
.masked-preview code { color: var(--text-muted); font-family: var(--font-mono); letter-spacing: .12em; }
.policy-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
.policy-choice { position: relative; display: flex; min-height: 150px; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); cursor: pointer; background: var(--bg-code); }
.policy-choice.selected { border-color: var(--accent); }
.policy-choice--allow.selected { border-color: var(--danger); }
.policy-choice input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--accent); }
.policy-choice span, .policy-choice strong, .policy-choice small { display: block; }
.policy-choice strong { color: var(--text-primary); }
.policy-choice em { display: inline-block; margin-left: var(--space-2); padding: 2px 5px; border-radius: 999px; background: var(--bg-elevated); color: var(--text-muted); font-size: 9px; font-style: normal; }
.policy-choice small { margin-top: var(--space-2); color: var(--text-secondary); }
.allow-warning { display: flex; gap: var(--space-2); margin: 0 var(--space-4) var(--space-4); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--danger) 60%, var(--border-subtle)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--danger) 8%, var(--bg-elevated)); color: var(--danger); }
.allow-warning strong, .allow-warning span { display: block; }
.model-guidance { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; padding: var(--space-3); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-muted); }
.allow-dialog { border-color: color-mix(in srgb, var(--danger) 60%, var(--border-strong)); }
.allow-dialog__icon { display: grid; width: 52px; height: 52px; margin-bottom: var(--space-3); place-items: center; border-radius: var(--radius-card); background: color-mix(in srgb, var(--danger) 12%, var(--bg-code)); color: var(--danger); }
@media (max-width: 799px) { .policy-grid { grid-template-columns: 1fr; } .policy-choice { min-height: auto; } }
@media (max-width: 599px) { .display-policy { grid-template-columns: 1fr; } }
</style>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { ApiError, apiRequest, jsonRequest } from '../../lib/api'
import SettingsSubnav from './SettingsSubnav.vue'

type ProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

interface ProviderModel {
  id: string
  providerId: string
  modelId: string
  displayName: string
  contextWindow: number | null
  maxOutputTokens: number | null
  supportsTools: boolean
  supportsVision: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface ProviderEntry {
  id: string
  providerKey: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl: string
  hasApiKey: boolean
  apiKeyMask: string | null
  enabled: boolean
  models: ProviderModel[]
  createdAt: string
  updatedAt: string
}

interface ProviderDraft {
  id: string
  providerKey: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
  enabled: boolean
}

interface ModelDraft {
  id: string
  modelId: string
  displayName: string
  contextWindow: number | null | ''
  maxOutputTokens: number | null | ''
  supportsTools: boolean
  supportsVision: boolean
  enabled: boolean
}

type TestState = {
  kind: 'testing' | 'success' | 'credentials' | 'unavailable'
  message: string
}

const auth = useAuthStore()
const providers = ref<ProviderEntry[]>([])
const allowInsecureHttp = ref(false)
const loading = ref(true)
const pageError = ref('')
const actionError = ref('')
const busy = ref(false)
const providerEditorOpen = ref(false)
const modelEditorOpen = ref(false)
const modelOwnerID = ref('')
const providerDraft = ref<ProviderDraft>(emptyProvider())
const modelDraft = ref<ModelDraft>(emptyModel())
const selectedModels = ref<Record<string, string>>({})
const testStates = ref<Record<string, TestState>>({})
const pendingDelete = ref<{ kind: 'provider' | 'model'; id: string; label: string } | null>(null)
const dialogRoot = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)

const editingProvider = computed(() => Boolean(providerDraft.value.id))
const editingModel = computed(() => Boolean(modelDraft.value.id))
const modelOwner = computed(() => providers.value.find((provider) => provider.id === modelOwnerID.value))

watch(
  () => providerEditorOpen.value || modelEditorOpen.value || Boolean(pendingDelete.value),
  async (open, wasOpen) => {
    if (open && !wasOpen) previousFocus.value = document.activeElement as HTMLElement | null
    if (open) {
      await nextTick()
      dialogRoot.value
        ?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled])')
        ?.focus()
    } else if (wasOpen) {
      await nextTick()
      previousFocus.value?.focus()
      previousFocus.value = null
    }
  },
)

onMounted(() => void loadProviders())

function emptyProvider(): ProviderDraft {
  return {
    id: '',
    providerKey: '',
    displayName: '',
    protocol: 'openai-completions',
    baseUrl: '',
    apiKey: '',
    enabled: true,
  }
}

function emptyModel(): ModelDraft {
  return {
    id: '',
    modelId: '',
    displayName: '',
    contextWindow: null,
    maxOutputTokens: null,
    supportsTools: false,
    supportsVision: false,
    enabled: true,
  }
}

async function loadProviders() {
  loading.value = true
  pageError.value = ''
  try {
    const response = await apiRequest<{ items: ProviderEntry[]; allowInsecureHttp: boolean }>(
      '/api/v1/ai/providers',
    )
    providers.value = response.items
    allowInsecureHttp.value = response.allowInsecureHttp
    const nextSelections: Record<string, string> = {}
    for (const provider of response.items) {
      const current = selectedModels.value[provider.id]
      nextSelections[provider.id] = provider.models.some((model) => model.id === current)
        ? current
        : provider.models.find((model) => model.enabled)?.id ?? ''
    }
    selectedModels.value = nextSelections
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    loading.value = false
  }
}

function openCreateProvider() {
  providerDraft.value = emptyProvider()
  actionError.value = ''
  providerEditorOpen.value = true
}

function openEditProvider(provider: ProviderEntry) {
  providerDraft.value = {
    id: provider.id,
    providerKey: provider.providerKey,
    displayName: provider.displayName,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: '',
    enabled: provider.enabled,
  }
  actionError.value = ''
  providerEditorOpen.value = true
}

function closeProviderEditor() {
  if (busy.value) return
  providerEditorOpen.value = false
  actionError.value = ''
}

async function saveProvider() {
  actionError.value = ''
  const draft = providerDraft.value
  if (!draft.displayName.trim() || !draft.baseUrl.trim() || (!editingProvider.value && !draft.apiKey)) {
    actionError.value = '请填写显示名、Base URL 和创建所需的 API Key。'
    return
  }
  busy.value = true
  try {
    if (editingProvider.value) {
      const payload: Record<string, unknown> = {
        displayName: draft.displayName.trim(),
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim(),
        enabled: draft.enabled,
      }
      if (draft.apiKey) payload.apiKey = draft.apiKey
      await apiRequest<ProviderEntry>(
        `/api/v1/ai/providers/${draft.id}`,
        jsonRequest('PATCH', payload, auth.csrfToken),
      )
    } else {
      await apiRequest<ProviderEntry>(
        '/api/v1/ai/providers',
        jsonRequest(
          'POST',
          {
            providerKey: draft.providerKey.trim(),
            displayName: draft.displayName.trim(),
            protocol: draft.protocol,
            baseUrl: draft.baseUrl.trim(),
            apiKey: draft.apiKey,
            enabled: draft.enabled,
            models: [],
          },
          auth.csrfToken,
        ),
      )
    }
    providerEditorOpen.value = false
    providerDraft.value = emptyProvider()
    await loadProviders()
  } catch (error) {
    actionError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function openCreateModel(provider: ProviderEntry) {
  modelOwnerID.value = provider.id
  modelDraft.value = emptyModel()
  actionError.value = ''
  modelEditorOpen.value = true
}

function openEditModel(provider: ProviderEntry, model: ProviderModel) {
  modelOwnerID.value = provider.id
  modelDraft.value = {
    id: model.id,
    modelId: model.modelId,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    enabled: model.enabled,
  }
  actionError.value = ''
  modelEditorOpen.value = true
}

function closeModelEditor() {
  if (busy.value) return
  modelEditorOpen.value = false
  actionError.value = ''
}

async function saveModel() {
  actionError.value = ''
  const draft = modelDraft.value
  if (!draft.modelId.trim() || !draft.displayName.trim()) {
    actionError.value = '模型 ID 和显示名不能为空。'
    return
  }
  const contextWindow = normalizeOptionalLimit(draft.contextWindow)
  const maxOutputTokens = normalizeOptionalLimit(draft.maxOutputTokens)
  if (Number.isNaN(contextWindow) || Number.isNaN(maxOutputTokens)) {
    actionError.value = '模型限制必须是正整数，或留空表示待配置。'
    return
  }
  if (contextWindow !== null && maxOutputTokens !== null && maxOutputTokens >= contextWindow) {
    actionError.value = '最大输出 Token 必须小于上下文窗口。'
    return
  }
  busy.value = true
  try {
    const payload = {
      modelId: draft.modelId.trim(),
      displayName: draft.displayName.trim(),
      contextWindow,
      maxOutputTokens,
      supportsTools: draft.supportsTools,
      supportsVision: draft.supportsVision,
      enabled: draft.enabled,
    }
    if (editingModel.value) {
      await apiRequest<ProviderModel>(
        `/api/v1/ai/models/${draft.id}`,
        jsonRequest('PATCH', payload, auth.csrfToken),
      )
    } else {
      await apiRequest<ProviderModel>(
        `/api/v1/ai/providers/${modelOwnerID.value}/models`,
        jsonRequest('POST', payload, auth.csrfToken),
      )
    }
    modelEditorOpen.value = false
    await loadProviders()
  } catch (error) {
    actionError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function normalizeOptionalLimit(value: number | null | ''): number | null {
  if (value === '' || value === null) return null
  return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN
}

async function testProvider(provider: ProviderEntry) {
  const modelID = selectedModels.value[provider.id]
  if (!modelID) return
  testStates.value = {
    ...testStates.value,
    [provider.id]: { kind: 'testing', message: '正在执行一次最小 Provider 请求…' },
  }
  try {
    const result = await apiRequest<{
      status: 'ok'
      latencyMs: number
      usage: { inputTokens: number; outputTokens: number } | null
    }>(
      `/api/v1/ai/providers/${provider.id}/test`,
      jsonRequest('POST', { modelId: modelID }, auth.csrfToken),
    )
    const usage = result.usage
      ? ` · ${result.usage.inputTokens}/${result.usage.outputTokens} tokens`
      : ''
    testStates.value = {
      ...testStates.value,
      [provider.id]: {
        kind: 'success',
        message: `连接成功 · ${result.latencyMs} ms${usage}`,
      },
    }
  } catch (error) {
    const credentials = error instanceof ApiError && error.code === 'AI_PROVIDER_CREDENTIALS_INVALID'
    testStates.value = {
      ...testStates.value,
      [provider.id]: {
        kind: credentials ? 'credentials' : 'unavailable',
        message: credentials ? '凭据被 Provider 拒绝，请替换 API Key。' : 'Provider 暂时不可用，请检查地址或稍后重试。',
      },
    }
  }
}

async function confirmDelete() {
  if (!pendingDelete.value) return
  busy.value = true
  actionError.value = ''
  try {
    const path =
      pendingDelete.value.kind === 'provider'
        ? `/api/v1/ai/providers/${pendingDelete.value.id}`
        : `/api/v1/ai/models/${pendingDelete.value.id}`
    await apiRequest<void>(path, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': auth.csrfToken },
    })
    pendingDelete.value = null
    await loadProviders()
  } catch (error) {
    actionError.value = messageFor(error)
  } finally {
    busy.value = false
  }
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
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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

function protocolLabel(protocol: ProviderProtocol) {
  if (protocol === 'openai-responses') return 'OpenAI Responses'
  if (protocol === 'anthropic-messages') return 'Anthropic Messages'
  return 'OpenAI Chat Completions'
}

function formatLimit(value: number | null) {
  return value === null ? '待配置' : new Intl.NumberFormat('zh-CN').format(value)
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : '请求未成功，请稍后重试'
}
</script>

<template>
  <section class="settings-page" aria-labelledby="provider-title">
    <SettingsSubnav />
    <header class="settings-page__header">
      <div>
        <p class="settings-kicker">SETTINGS · MODEL GATEWAY</p>
        <h2 id="provider-title">Provider 与模型</h2>
        <p>配置受控协议、模型能力与连接状态；密钥保存后只显示末尾掩码。</p>
      </div>
      <UiButton variant="primary" @click="openCreateProvider"><UiIcon name="plus" /> 新增 Provider</UiButton>
    </header>

    <div v-if="allowInsecureHttp" class="settings-notice settings-notice--warning" role="status">
      <UiIcon name="triangle-alert" />
      <span>部署者已允许 HTTP Provider。未加密连接可能泄露 API Key，仅用于明确配置的内网网关。</span>
    </div>
    <div v-if="pageError" class="settings-notice settings-notice--danger" role="alert">
      <UiIcon name="triangle-alert" /><span>{{ pageError }}</span><button type="button" @click="loadProviders">重试</button>
    </div>

    <div v-if="loading" class="settings-loading" aria-live="polite">
      <span class="settings-spinner" aria-hidden="true" />正在读取 Provider 配置…
    </div>
    <div v-else-if="providers.length === 0" class="settings-card settings-empty">
      <div><UiIcon name="boxes" :size="28" /><h3>尚未配置 Provider</h3><p>核心录入与检索不依赖 AI；需要时再添加本地或远程模型。</p></div>
    </div>

    <article v-for="provider in providers" v-else :key="provider.id" class="settings-card provider-card">
      <header class="settings-card__header">
        <div>
          <p class="settings-kicker">{{ provider.providerKey }}</p>
          <h3>{{ provider.displayName }}</h3>
          <p>{{ protocolLabel(provider.protocol) }} · {{ provider.baseUrl }}</p>
        </div>
        <span class="settings-status" :class="provider.enabled ? 'settings-status--success' : ''">
          {{ provider.enabled ? '已启用' : '已停用' }}
        </span>
      </header>

      <div class="settings-card__body provider-card__body">
        <div class="provider-secret">
          <span><UiIcon name="key-round" /> API Key</span>
          <code>{{ provider.apiKeyMask || '未配置' }}</code>
          <span>{{ provider.hasApiKey ? '加密保存' : '不可用' }}</span>
        </div>

        <div class="model-heading">
          <div><strong>模型目录</strong><small>{{ provider.models.length }} 个手工模型</small></div>
          <UiButton variant="secondary" @click="openCreateModel(provider)"><UiIcon name="plus" /> 添加模型</UiButton>
        </div>
        <div v-if="provider.models.length" class="model-table-wrap">
          <table class="model-table">
            <thead><tr><th>模型</th><th>限制</th><th>能力</th><th><span class="sr-only">操作</span></th></tr></thead>
            <tbody>
              <tr v-for="model in provider.models" :key="model.id">
                <td><strong>{{ model.displayName }}</strong><code>{{ model.modelId }}</code></td>
                <td>{{ formatLimit(model.contextWindow) }} / {{ formatLimit(model.maxOutputTokens) }}</td>
                <td>
                  <span :class="{ muted: !model.supportsTools }">工具</span>
                  <span :class="{ muted: !model.supportsVision }">视觉</span>
                  <span v-if="!model.enabled" class="muted">停用</span>
                </td>
                <td class="model-actions">
                  <button type="button" aria-label="编辑模型" @click="openEditModel(provider, model)"><UiIcon name="pencil" :size="16" /></button>
                  <button type="button" aria-label="删除模型" @click="pendingDelete = { kind: 'model', id: model.id, label: model.displayName }"><UiIcon name="trash-2" :size="16" /></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="model-empty">尚无模型；Provider 不会被 AI 任务使用。</p>

        <section class="connection-test" aria-label="Provider 连接测试">
          <div>
            <strong>连接测试</strong>
            <small>会向所选模型发送一次最小请求，可能产生 Provider 调用费用。</small>
          </div>
          <select v-model="selectedModels[provider.id]" :disabled="!provider.enabled || provider.models.length === 0" :aria-label="`${provider.displayName} 测试模型`">
            <option value="">选择模型</option>
            <option v-for="model in provider.models.filter((item) => item.enabled)" :key="model.id" :value="model.id">{{ model.displayName }}</option>
          </select>
          <UiButton :disabled="!selectedModels[provider.id] || testStates[provider.id]?.kind === 'testing'" @click="testProvider(provider)">
            {{ testStates[provider.id]?.kind === 'testing' ? '测试中…' : '测试连接' }}
          </UiButton>
          <p
            v-if="testStates[provider.id]"
            class="connection-result"
            :class="`connection-result--${testStates[provider.id]?.kind}`"
            role="status"
          >
            <UiIcon :name="testStates[provider.id]?.kind === 'success' ? 'check' : testStates[provider.id]?.kind === 'testing' ? 'clock' : 'wifi-off'" />
            {{ testStates[provider.id]?.message }}
          </p>
        </section>
      </div>

      <footer class="provider-card__footer">
        <UiButton variant="secondary" @click="openEditProvider(provider)"><UiIcon name="pencil" /> 编辑与替换密钥</UiButton>
        <UiButton variant="danger" @click="pendingDelete = { kind: 'provider', id: provider.id, label: provider.displayName }">删除 Provider</UiButton>
      </footer>
    </article>
  </section>

  <Teleport to="body">
    <div v-if="providerEditorOpen" class="settings-overlay" @click.self="closeProviderEditor">
      <section ref="dialogRoot" class="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="provider-editor-title" @keydown="onDialogKeydown($event, closeProviderEditor)">
        <header>
          <div><p class="settings-kicker">PROVIDER CONFIGURATION</p><h2 id="provider-editor-title">{{ editingProvider ? '编辑 Provider' : '新增 Provider' }}</h2></div>
          <button class="settings-icon-button" type="button" aria-label="关闭" @click="closeProviderEditor"><UiIcon name="x" /></button>
        </header>
        <div class="settings-drawer__body">
          <form id="provider-form" class="settings-form" @submit.prevent="saveProvider">
            <label class="settings-field"><span>稳定 Provider Key</span><input v-model="providerDraft.providerKey" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]*" :disabled="editingProvider" autocomplete="off" /><small>创建后不可修改，用于稳定标识历史配置。</small></label>
            <label class="settings-field"><span>显示名</span><input v-model="providerDraft.displayName" required maxlength="120" /></label>
            <label class="settings-field"><span>协议</span><select v-model="providerDraft.protocol"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
            <label class="settings-field"><span>Base URL</span><input v-model="providerDraft.baseUrl" required maxlength="2048" inputmode="url" placeholder="https://provider.example/v1" /><small>填写协议根地址；系统只拼接固定 endpoint，且不跟随重定向。</small></label>
            <label class="settings-field"><span>{{ editingProvider ? '替换 API Key（留空则保持）' : 'API Key' }}</span><input v-model="providerDraft.apiKey" type="password" :required="!editingProvider" maxlength="8192" autocomplete="new-password" /><small>保存后不可再次读取明文。</small></label>
            <label class="settings-check"><input v-model="providerDraft.enabled" type="checkbox" /><span>允许该 Provider 接受连接测试与新任务</span></label>
            <div v-if="actionError" class="settings-notice settings-notice--danger" role="alert"><UiIcon name="triangle-alert" />{{ actionError }}</div>
          </form>
        </div>
        <footer><UiButton variant="ghost" @click="closeProviderEditor">取消</UiButton><UiButton type="submit" form="provider-form" variant="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存 Provider' }}</UiButton></footer>
      </section>
    </div>

    <div v-if="modelEditorOpen" class="settings-overlay" @click.self="closeModelEditor">
      <section ref="dialogRoot" class="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="model-editor-title" @keydown="onDialogKeydown($event, closeModelEditor)">
        <header>
          <div><p class="settings-kicker">{{ modelOwner?.displayName }}</p><h2 id="model-editor-title">{{ editingModel ? '编辑模型' : '添加模型' }}</h2></div>
          <button class="settings-icon-button" type="button" aria-label="关闭" @click="closeModelEditor"><UiIcon name="x" /></button>
        </header>
        <div class="settings-drawer__body">
          <form id="model-form" class="settings-form" @submit.prevent="saveModel">
            <label class="settings-field"><span>上游模型 ID</span><input v-model="modelDraft.modelId" required maxlength="200" autocomplete="off" /></label>
            <label class="settings-field"><span>显示名</span><input v-model="modelDraft.displayName" required maxlength="120" /></label>
            <div class="settings-field-row">
              <label class="settings-field"><span>上下文窗口</span><input v-model.number="modelDraft.contextWindow" type="number" min="1" placeholder="待配置" /></label>
              <label class="settings-field"><span>最大输出 Token</span><input v-model.number="modelDraft.maxOutputTokens" type="number" min="1" placeholder="待配置" /></label>
            </div>
            <fieldset class="settings-fieldset"><legend>模型能力</legend><label class="settings-check"><input v-model="modelDraft.supportsTools" type="checkbox" /><span>支持工具调用（可选；不可用时改用 JSON）</span></label><label class="settings-check"><input v-model="modelDraft.supportsVision" type="checkbox" /><span>支持图片输入</span></label><label class="settings-check"><input v-model="modelDraft.enabled" type="checkbox" /><span>启用模型</span></label></fieldset>
            <div v-if="actionError" class="settings-notice settings-notice--danger" role="alert"><UiIcon name="triangle-alert" />{{ actionError }}</div>
          </form>
        </div>
        <footer><UiButton variant="ghost" @click="closeModelEditor">取消</UiButton><UiButton type="submit" form="model-form" variant="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存模型' }}</UiButton></footer>
      </section>
    </div>

    <div v-if="pendingDelete" class="settings-overlay settings-dialog-shell" role="alertdialog" aria-modal="true" aria-labelledby="provider-delete-title">
      <section ref="dialogRoot" class="settings-dialog" @keydown="onDialogKeydown($event, () => (pendingDelete = null))">
        <h2 id="provider-delete-title">删除 {{ pendingDelete.kind === 'provider' ? 'Provider' : '模型' }}？</h2>
        <p>“{{ pendingDelete.label }}”将被停用并从普通列表隐藏。历史任务仍保留；若有运行中任务，服务端会拒绝删除。</p>
        <div v-if="actionError" class="settings-notice settings-notice--danger" role="alert">{{ actionError }}</div>
        <div class="settings-actions"><UiButton variant="ghost" :disabled="busy" @click="pendingDelete = null">取消</UiButton><UiButton variant="danger" :disabled="busy" @click="confirmDelete">{{ busy ? '正在删除…' : '确认删除' }}</UiButton></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.provider-card__body { display: grid; min-width: 0; gap: var(--space-4); }
.provider-secret { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.provider-secret > span:first-child { display: flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); font-weight: 700; }
.provider-secret code, .model-table code { overflow: hidden; color: var(--text-primary); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.provider-secret > span:last-child { color: var(--success); font-size: 11px; }
.model-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.model-heading div, .model-heading small { display: block; }
.model-heading small { color: var(--text-muted); }
.model-table-wrap { max-width: 100%; min-width: 0; overflow-x: auto; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
.model-table { width: 100%; min-width: 640px; border-collapse: collapse; }
.model-table th, .model-table td { padding: var(--space-3); border-bottom: 1px solid var(--border-subtle); text-align: left; }
.model-table tr:last-child td { border-bottom: 0; }
.model-table th { color: var(--text-muted); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
.model-table td:first-child strong, .model-table td:first-child code { display: block; }
.model-table td:first-child code { margin-top: 2px; color: var(--text-muted); font-size: 11px; }
.model-table td:nth-child(2) { color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px; }
.model-table td:nth-child(3) span { display: inline-block; margin-right: var(--space-1); padding: 2px 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 10px; }
.model-table td:nth-child(3) .muted { background: var(--bg-code); color: var(--text-muted); text-decoration: line-through; }
.model-actions { white-space: nowrap; }
.model-actions button { border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; }
.model-actions button:last-child:hover { color: var(--danger); }
.model-empty { margin: 0; padding: var(--space-4); border: 1px dashed var(--border-strong); border-radius: var(--radius-control); color: var(--text-muted); text-align: center; }
.connection-test { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(180px, .7fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.connection-test strong, .connection-test small { display: block; }
.connection-test small { color: var(--text-muted); }
.connection-test select { min-height: 40px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-elevated); color: var(--text-primary); }
.connection-result { display: flex; grid-column: 1 / -1; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-secondary); }
.connection-result--success { color: var(--success); }
.connection-result--credentials, .connection-result--unavailable { color: var(--danger); }
.provider-card__footer { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-subtle); }
@media (max-width: 799px) { .connection-test { grid-template-columns: 1fr; } .connection-result { grid-column: auto; } }
@media (max-width: 599px) {
  .provider-secret { grid-template-columns: 1fr; }
  .model-heading, .provider-card__footer { align-items: stretch; flex-direction: column; }
  .model-heading .button, .provider-card__footer .button { width: 100%; }
  .model-table { min-width: 0; }
  .model-table thead { display: none; }
  .model-table tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2) var(--space-3); padding: var(--space-3); }
  .model-table td { padding: 0; border: 0; }
  .model-table td:nth-child(2), .model-table td:nth-child(3) { grid-column: 1; }
  .model-actions { grid-column: 2; grid-row: 1 / span 3; align-self: center; }
}
</style>

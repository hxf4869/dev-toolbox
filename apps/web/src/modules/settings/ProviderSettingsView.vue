<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { ApiError, apiRequest, jsonRequest } from '../../lib/api'
import type {
  ConfiguredReasoning,
  ConfiguredReasoningOptionDTO,
  EmbeddingSettingsDTO,
  IndexFailureDTO,
  IndexFailureListDTO,
  KnowledgeIndexStatusDTO,
  PutEmbeddingSettingsRequestDTO,
  TestEmbeddingSettingsResponseDTO,
} from '../assistant/assistantContracts'
import SettingsPageShell from './SettingsPageShell.vue'

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
  reasoningOptions: ConfiguredReasoningOptionDTO[]
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
  reasoningOptions: ReasoningOptionDraft[]
}

interface ReasoningOptionDraft {
  key: number
  displayName: string
  reasoning: ConfiguredReasoning
}

interface EmbeddingDraft {
  displayName: string
  baseUrl: string
  apiKey: string
  modelId: string
  dimensions: number | ''
  enabled: boolean
}

type TestState = {
  version: number
  modelId: string
  kind: 'testing' | 'success' | 'credentials' | 'unavailable'
  message: string
}

const auth = useAuthStore()
const reasoningValues: Array<{ value: ConfiguredReasoning; label: string }> = [
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
]
let reasoningRowKey = 0
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
const providerTestVersions = ref<Record<string, number>>({})
const pendingDelete = ref<{ kind: 'provider' | 'model'; id: string; label: string } | null>(null)
const embeddingSettings = ref<EmbeddingSettingsDTO | null>(null)
const indexStatus = ref<KnowledgeIndexStatusDTO | null>(null)
const indexFailures = ref<IndexFailureDTO[]>([])
const indexFailureNextCursor = ref<string | null>(null)
const embeddingDraft = ref<EmbeddingDraft>(emptyEmbedding())
const embeddingLoading = ref(true)
const embeddingError = ref('')
const embeddingActionError = ref('')
const embeddingBusy = ref(false)
const embeddingTesting = ref(false)
const embeddingTestResult = ref<TestEmbeddingSettingsResponseDTO | null>(null)
const embeddingTestError = ref('')
const failureLoading = ref(false)
const retryingFailures = ref<Record<string, boolean>>({})
const indexPollError = ref('')
const indexFailuresStale = ref(false)
const pendingReindex = ref<PutEmbeddingSettingsRequestDTO | null>(null)
const embeddingDeleteOpen = ref(false)
const dialogRoot = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)

const INDEX_POLL_INTERVAL_MS = 2000
const FAILURE_PAGE_SIZE = 50
let indexPollTimer = 0
let providerReadSeq = 0
let indexRefreshSeq = 0
let indexFailureListSeq = 0
let embeddingConnectionVersion = 0

const editingProvider = computed(() => Boolean(providerDraft.value.id))
const editingModel = computed(() => Boolean(modelDraft.value.id))
const modelOwner = computed(() => providers.value.find((provider) => provider.id === modelOwnerID.value))
const enabledProviderCount = computed(() => providers.value.filter((provider) => provider.enabled).length)
const modelCount = computed(() => providers.value.reduce((total, provider) => total + provider.models.length, 0))
const enabledModelCount = computed(() =>
  providers.value.reduce(
    (total, provider) => total + provider.models.filter((model) => model.enabled).length,
    0,
  ),
)
const configuredKeyCount = computed(() => providers.value.filter((provider) => provider.hasApiKey).length)
const embeddingDimensionMatches = computed(
  () =>
    !embeddingTestResult.value ||
    embeddingTestResult.value.actualDimensions === Number(embeddingDraft.value.dimensions),
)

watch(
  () =>
    providerEditorOpen.value ||
    modelEditorOpen.value ||
    Boolean(pendingDelete.value) ||
    Boolean(pendingReindex.value) ||
    embeddingDeleteOpen.value,
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

watch(
  () => [
    embeddingDraft.value.baseUrl,
    embeddingDraft.value.apiKey,
    embeddingDraft.value.modelId,
    embeddingDraft.value.dimensions,
  ],
  () => {
    embeddingConnectionVersion += 1
    embeddingTestResult.value = null
    embeddingTestError.value = ''
  },
  { flush: 'sync' },
)

onMounted(() => {
  void loadProviders()
  void loadEmbeddingSection()
})

onBeforeUnmount(() => {
  window.clearTimeout(indexPollTimer)
  indexPollTimer = 0
  indexRefreshSeq += 1
})

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
    reasoningOptions: [],
  }
}

function emptyEmbedding(): EmbeddingDraft {
  return {
    displayName: '',
    baseUrl: '',
    apiKey: '',
    modelId: '',
    dimensions: '',
    enabled: false,
  }
}

async function loadProviders() {
  const readSeq = ++providerReadSeq
  loading.value = true
  pageError.value = ''
  try {
    const response = await apiRequest<{ items: ProviderEntry[]; allowInsecureHttp: boolean }>(
      '/api/v1/ai/providers',
    )
    if (readSeq !== providerReadSeq) return
    providers.value = response.items
    allowInsecureHttp.value = response.allowInsecureHttp
    const nextSelections: Record<string, string> = {}
    for (const provider of response.items) {
      const current = selectedModels.value[provider.id]
      nextSelections[provider.id] = provider.models.some((model) => model.id === current && model.enabled)
        ? current
        : provider.models.find((model) => model.enabled)?.id ?? ''
    }
    selectedModels.value = nextSelections
  } catch (error) {
    if (readSeq !== providerReadSeq) return
    pageError.value = messageFor(error)
  } finally {
    if (readSeq === providerReadSeq) loading.value = false
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

function refocusDrawerIfFocusLost() {
  void nextTick(() => {
    const root = dialogRoot.value
    if (!root) return
    const active = document.activeElement
    if (active instanceof HTMLElement && root.contains(active) && !active.matches(':disabled')) return
    root.querySelector<HTMLElement>('input:not([disabled])')?.focus()
  })
}

function refocusEditTriggerIfFocusLost(kind: 'provider' | 'model', id: string) {
  void nextTick(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && active.isConnected && !active.matches(':disabled')) return
    document.querySelector<HTMLElement>(`[data-edit-${kind}="${id}"]`)?.focus()
  })
}

async function saveProvider() {
  actionError.value = ''
  const draft = providerDraft.value
  // 提交时的目标 id；保存成功后草稿会被重置，await 之后不能再依赖 draft/editingProvider。
  const editingId = draft.id
  if (!draft.displayName.trim() || !draft.baseUrl.trim() || (!editingProvider.value && !draft.apiKey)) {
    actionError.value = '请填写显示名、Base URL 和创建所需的 API Key。'
    return
  }
  busy.value = true
  refocusDrawerIfFocusLost()
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
    if (editingId) invalidateProviderTest(editingId)
    providerEditorOpen.value = false
    providerDraft.value = emptyProvider()
    await loadProviders()
    if (editingId) refocusEditTriggerIfFocusLost('provider', editingId)
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
    reasoningOptions: [...(model.reasoningOptions ?? [])]
      .sort((left, right) => left.sortOrder - right.sortOrder || left.reasoning.localeCompare(right.reasoning))
      .map((option) => ({
        key: ++reasoningRowKey,
        displayName: option.displayName,
        reasoning: option.reasoning,
      })),
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
  const editingId = draft.id
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
  const reasoningOptions = normalizedReasoningOptions()
  if (!reasoningOptions) return
  busy.value = true
  refocusDrawerIfFocusLost()
  try {
    const payload = {
      modelId: draft.modelId.trim(),
      displayName: draft.displayName.trim(),
      contextWindow,
      maxOutputTokens,
      supportsTools: draft.supportsTools,
      supportsVision: draft.supportsVision,
      enabled: draft.enabled,
      reasoningOptions,
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
    if (editingId) invalidateProviderTest(modelOwnerID.value, editingId)
    modelEditorOpen.value = false
    await loadProviders()
    if (editingId) refocusEditTriggerIfFocusLost('model', editingId)
  } catch (error) {
    actionError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function addReasoningOption() {
  actionError.value = ''
  if (modelDraft.value.reasoningOptions.length >= 6) {
    actionError.value = '每个模型最多配置 6 个思考档位。'
    return
  }
  const configured = new Set(modelDraft.value.reasoningOptions.map((option) => option.reasoning))
  const next = reasoningValues.find((option) => !configured.has(option.value))
  if (!next) return
  const rowKey = ++reasoningRowKey
  modelDraft.value.reasoningOptions.push({
    key: rowKey,
    displayName: next.label,
    reasoning: next.value,
  })
  focusReasoningRowInput(rowKey)
}

function moveReasoningOption(index: number, offset: -1 | 1) {
  const target = index + offset
  if (target < 0 || target >= modelDraft.value.reasoningOptions.length) return
  const [option] = modelDraft.value.reasoningOptions.splice(index, 1)
  if (!option) return
  modelDraft.value.reasoningOptions.splice(target, 0, option)
  focusReasoningRowAfterMove(option.key, offset)
}

function removeReasoningOption(index: number) {
  const options = modelDraft.value.reasoningOptions
  const [removed] = options.splice(index, 1)
  if (!removed) return
  const neighbor = options[Math.min(index, options.length - 1)]
  if (neighbor) focusReasoningRowInput(neighbor.key)
  else focusReasoningAddButton()
}

// 档位行的增删改会禁用或卸载触发按钮本身，浏览器会把焦点抛回 body，
// Escape 因此不再经过 dialog keydown；这里在渲染后主动把焦点归还给行内有效控件。
function reasoningRowElement(key: number): HTMLElement | null {
  return (
    dialogRoot.value?.querySelector<HTMLElement>(`.reasoning-editor__row[data-reasoning-key="${key}"]`) ?? null
  )
}

function focusReasoningRowInput(key: number) {
  void nextTick(() => {
    reasoningRowElement(key)?.querySelector<HTMLElement>('input:not([disabled])')?.focus()
  })
}

function focusReasoningRowAfterMove(key: number, offset: -1 | 1) {
  void nextTick(() => {
    const row = reasoningRowElement(key)
    if (!row) return
    const directionButton = row.querySelectorAll<HTMLButtonElement>('.reasoning-editor__actions button')[
      offset === -1 ? 0 : 1
    ]
    if (directionButton && !directionButton.disabled) {
      directionButton.focus()
      return
    }
    row.querySelector<HTMLElement>('input:not([disabled])')?.focus()
  })
}

function focusReasoningAddButton() {
  void nextTick(() => {
    dialogRoot.value?.querySelector<HTMLElement>('.reasoning-editor > button:not([disabled])')?.focus()
  })
}

function normalizedReasoningOptions(): ConfiguredReasoningOptionDTO[] | null {
  const options = modelDraft.value.reasoningOptions
  if (options.length > 6) {
    actionError.value = '每个模型最多配置 6 个思考档位。'
    return null
  }
  const names = new Set<string>()
  const reasonings = new Set<ConfiguredReasoning>()
  const result: ConfiguredReasoningOptionDTO[] = []
  for (const [index, option] of options.entries()) {
    const displayName = option.displayName.trim()
    const normalizedName = displayName.toLocaleLowerCase()
    if (!displayName || displayName.length > 40) {
      actionError.value = `第 ${index + 1} 个思考档位的显示名需为 1–40 个字符。`
      return null
    }
    if (!reasoningValues.some((entry) => entry.value === option.reasoning)) {
      actionError.value = `第 ${index + 1} 个思考档位值无效。`
      return null
    }
    if (names.has(normalizedName)) {
      actionError.value = '思考档位显示名不能重复（忽略大小写）。'
      return null
    }
    if (reasonings.has(option.reasoning)) {
      actionError.value = '同一个思考档位值不能重复。'
      return null
    }
    names.add(normalizedName)
    reasonings.add(option.reasoning)
    result.push({ displayName, reasoning: option.reasoning, sortOrder: index * 10 })
  }
  return result
}

async function loadEmbeddingSection() {
  const seq = ++indexRefreshSeq
  embeddingLoading.value = true
  embeddingError.value = ''
  try {
    const [settings, status, failures] = await Promise.all([
      apiRequest<EmbeddingSettingsDTO>('/api/v1/assistant/embedding-settings'),
      apiRequest<KnowledgeIndexStatusDTO>('/api/v1/assistant/index-status'),
      apiRequest<IndexFailureListDTO>('/api/v1/assistant/index-failures?limit=50'),
    ])
    if (seq !== indexRefreshSeq) return
    setEmbeddingSettings(settings)
    indexStatus.value = status
    indexFailures.value = failures.items
    indexFailureNextCursor.value = failures.nextCursor
    indexFailureListSeq += 1
    indexFailuresStale.value = false
    scheduleIndexPolling()
  } catch (error) {
    if (seq === indexRefreshSeq) embeddingError.value = messageFor(error)
  } finally {
    embeddingLoading.value = false
  }
}

function setEmbeddingSettings(settings: EmbeddingSettingsDTO) {
  embeddingSettings.value = settings
  embeddingDraft.value = {
    displayName: settings.displayName ?? '',
    baseUrl: settings.baseUrl ?? '',
    apiKey: '',
    modelId: settings.modelId ?? '',
    dimensions: settings.dimensions ?? '',
    enabled: settings.enabled,
  }
}

function embeddingPayload(confirmReindex: boolean): PutEmbeddingSettingsRequestDTO | null {
  const draft = embeddingDraft.value
  const dimensions = Number(draft.dimensions)
  if (!draft.displayName.trim() || !draft.baseUrl.trim() || !draft.modelId.trim()) {
    embeddingActionError.value = '请填写显示名、Base URL 和上游 Embedding 模型 ID。'
    return null
  }
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16000) {
    embeddingActionError.value = '向量维度必须是 1–16000 的整数。'
    return null
  }
  if (!embeddingSettings.value?.apiKeyConfigured && !draft.apiKey) {
    embeddingActionError.value = '首次配置需要填写独立的 Embedding API Key。'
    return null
  }
  return {
    displayName: draft.displayName.trim(),
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey || null,
    modelId: draft.modelId.trim(),
    dimensions,
    enabled: draft.enabled,
    confirmReindex,
  }
}

async function testEmbedding() {
  embeddingActionError.value = ''
  embeddingTestError.value = ''
  embeddingTestResult.value = null
  const payload = embeddingConnectionPayload()
  if (!payload) return
  const connectionVersion = embeddingConnectionVersion
  embeddingTesting.value = true
  try {
    const result = await apiRequest<TestEmbeddingSettingsResponseDTO>(
      '/api/v1/assistant/embedding-settings/test',
      jsonRequest(
        'POST',
        {
          baseUrl: payload.baseUrl,
          apiKey: payload.apiKey,
          modelId: payload.modelId,
          dimensions: payload.dimensions,
        },
        auth.csrfToken,
      ),
    )
    if (connectionVersion === embeddingConnectionVersion) embeddingTestResult.value = result
  } catch (error) {
    if (connectionVersion === embeddingConnectionVersion) embeddingTestError.value = messageFor(error)
  } finally {
    embeddingTesting.value = false
  }
}

function embeddingConnectionPayload() {
  const draft = embeddingDraft.value
  const dimensions = Number(draft.dimensions)
  if (!draft.baseUrl.trim() || !draft.modelId.trim()) {
    embeddingActionError.value = '测试前请填写 Base URL 和上游 Embedding 模型 ID。'
    return null
  }
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16000) {
    embeddingActionError.value = '向量维度必须是 1–16000 的整数。'
    return null
  }
  if (!embeddingSettings.value?.apiKeyConfigured && !draft.apiKey) {
    embeddingActionError.value = '首次测试需要填写独立的 Embedding API Key。'
    return null
  }
  return {
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey || null,
    modelId: draft.modelId.trim(),
    dimensions,
  }
}

async function saveEmbedding() {
  embeddingActionError.value = ''
  const payload = embeddingPayload(false)
  if (!payload) return
  embeddingBusy.value = true
  try {
    const settings = await apiRequest<EmbeddingSettingsDTO>(
      '/api/v1/assistant/embedding-settings',
      jsonRequest('PUT', payload, auth.csrfToken),
    )
    setEmbeddingSettings(settings)
    await refreshIndexData()
  } catch (error) {
    if (error instanceof ApiError && error.code === 'EMBEDDING_REINDEX_CONFIRMATION_REQUIRED') {
      if (await refreshIndexData()) pendingReindex.value = payload
    } else {
      embeddingActionError.value = messageFor(error)
    }
  } finally {
    embeddingBusy.value = false
  }
}

async function confirmEmbeddingReindex() {
  if (!pendingReindex.value) return
  embeddingActionError.value = ''
  embeddingBusy.value = true
  try {
    const settings = await apiRequest<EmbeddingSettingsDTO>(
      '/api/v1/assistant/embedding-settings',
      jsonRequest('PUT', { ...pendingReindex.value, confirmReindex: true }, auth.csrfToken),
    )
    pendingReindex.value = null
    setEmbeddingSettings(settings)
    await refreshIndexData()
  } catch (error) {
    embeddingActionError.value = messageFor(error)
  } finally {
    embeddingBusy.value = false
  }
}

async function confirmDeleteEmbedding() {
  embeddingActionError.value = ''
  embeddingBusy.value = true
  try {
    await apiRequest<void>('/api/v1/assistant/embedding-settings', {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': auth.csrfToken },
    })
    embeddingDeleteOpen.value = false
    await loadEmbeddingSection()
  } catch (error) {
    embeddingActionError.value = messageFor(error)
  } finally {
    embeddingBusy.value = false
  }
}

function openEmbeddingDelete() {
  embeddingActionError.value = ''
  embeddingDeleteOpen.value = true
}

async function refreshIndexData(preserveExpandedFailures = false): Promise<boolean> {
  const seq = ++indexRefreshSeq
  try {
    let status: KnowledgeIndexStatusDTO
    let failures: IndexFailureListDTO | null = null
    if (preserveExpandedFailures) {
      status = await apiRequest<KnowledgeIndexStatusDTO>('/api/v1/assistant/index-status')
      if (seq !== indexRefreshSeq) return false
      const listResetNeeded =
        indexStatus.value?.generation !== status.generation || indexFailures.value.length <= FAILURE_PAGE_SIZE
      if (listResetNeeded) {
        failures = await apiRequest<IndexFailureListDTO>('/api/v1/assistant/index-failures?limit=50')
      } else if (status.counts.failed > (indexStatus.value?.counts.failed ?? 0)) {
        // indexStatus 此时仍是上次成功应用的状态；中间页的 counts.failed 本就大于已加载长度，只能按计数增长判断新失败。
        indexFailuresStale.value = true
      }
    } else {
      ;[status, failures] = await Promise.all([
        apiRequest<KnowledgeIndexStatusDTO>('/api/v1/assistant/index-status'),
        apiRequest<IndexFailureListDTO>('/api/v1/assistant/index-failures?limit=50'),
      ])
    }
    if (seq !== indexRefreshSeq) return false
    indexStatus.value = status
    if (failures) {
      indexFailures.value = failures.items
      indexFailureNextCursor.value = failures.nextCursor
      indexFailureListSeq += 1
      indexFailuresStale.value = false
    }
    indexPollError.value = ''
    scheduleIndexPolling()
    return true
  } catch (error) {
    if (seq === indexRefreshSeq) indexPollError.value = messageFor(error)
    return false
  }
}

function scheduleIndexPolling() {
  window.clearTimeout(indexPollTimer)
  indexPollTimer = 0
  if (!indexStatus.value || !indexHasPendingWork(indexStatus.value)) return
  const seq = indexRefreshSeq
  indexPollTimer = window.setTimeout(() => {
    indexPollTimer = 0
    if (seq !== indexRefreshSeq) return
    void refreshIndexData(true)
  }, INDEX_POLL_INTERVAL_MS)
}

function indexHasPendingWork(status: KnowledgeIndexStatusDTO) {
  if (status.status === 'disabled' || status.status === 'unconfigured') return false
  return status.status === 'indexing' || status.counts.pending > 0 || status.counts.running > 0
}

async function refreshIndexAfterError() {
  indexPollError.value = ''
  await refreshIndexData()
}

async function refreshIndexFailures() {
  indexFailuresStale.value = false
  await refreshIndexData()
}

async function loadMoreIndexFailures() {
  if (!indexFailureNextCursor.value || failureLoading.value) return
  const listSeq = indexFailureListSeq
  failureLoading.value = true
  embeddingActionError.value = ''
  try {
    const query = new URLSearchParams({ cursor: indexFailureNextCursor.value, limit: '50' })
    const response = await apiRequest<IndexFailureListDTO>(
      `/api/v1/assistant/index-failures?${query.toString()}`,
    )
    if (listSeq !== indexFailureListSeq) return
    const existing = new Set(indexFailures.value.map((failure) => failure.fragmentId))
    indexFailures.value.push(...response.items.filter((failure) => !existing.has(failure.fragmentId)))
    indexFailureNextCursor.value = response.nextCursor
  } catch (error) {
    if (listSeq === indexFailureListSeq) embeddingActionError.value = messageFor(error)
  } finally {
    failureLoading.value = false
  }
}

async function retryIndexFailure(failure: IndexFailureDTO) {
  retryingFailures.value = { ...retryingFailures.value, [failure.fragmentId]: true }
  embeddingActionError.value = ''
  try {
    await apiRequest<{ fragmentId: string; state: 'pending' }>(
      `/api/v1/assistant/index-failures/${failure.fragmentId}/retry`,
      { method: 'POST', headers: { 'X-CSRF-Token': auth.csrfToken } },
    )
    await refreshIndexData()
  } catch (error) {
    embeddingActionError.value = messageFor(error)
  } finally {
    retryingFailures.value = { ...retryingFailures.value, [failure.fragmentId]: false }
  }
}

function indexStatusLabel(status: KnowledgeIndexStatusDTO['status'] | undefined) {
  if (status === 'ready') return '可检索'
  if (status === 'indexing') return '重建中'
  if (status === 'failed') return '存在失败项'
  if (status === 'disabled') return '已禁用'
  return '未配置'
}

function sensitivePolicyLabel(policy: KnowledgeIndexStatusDTO['sensitivePolicy'] | undefined) {
  if (policy === 'allow') return '允许'
  if (policy === 'redact') return '脱敏'
  return '阻止'
}

function sourceKindLabel(sourceKind: IndexFailureDTO['sourceKind']) {
  const labels: Record<IndexFailureDTO['sourceKind'], string> = {
    title: '标题',
    metadata: '元数据',
    raw_text: '原始文本',
    code: '代码',
    ai_text: 'AI 文本',
    image_text: '图片文字',
  }
  return labels[sourceKind]
}

function normalizeOptionalLimit(value: number | null | ''): number | null {
  if (value === '' || value === null) return null
  return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN
}

function invalidateProviderTest(providerID: string, modelID?: string) {
  if (modelID && testStates.value[providerID]?.modelId !== modelID) return
  providerTestVersions.value[providerID] = (providerTestVersions.value[providerID] ?? 0) + 1
}

async function testProvider(provider: ProviderEntry) {
  const modelID = selectedModels.value[provider.id]
  if (!modelID) return
  const version = providerTestVersions.value[provider.id] ?? 0
  testStates.value = {
    ...testStates.value,
    [provider.id]: { version, modelId: modelID, kind: 'testing', message: '正在执行一次最小 Provider 请求…' },
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
        version,
        modelId: modelID,
        kind: 'success',
        message: `连接成功 · ${result.latencyMs} ms${usage}`,
      },
    }
  } catch (error) {
    const credentials = error instanceof ApiError && error.code === 'AI_PROVIDER_CREDENTIALS_INVALID'
    testStates.value = {
      ...testStates.value,
      [provider.id]: {
        version,
        modelId: modelID,
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
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && !busy.value && !embeddingBusy.value) {
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
  <SettingsPageShell
    title-id="provider-title"
    title="Provider 与模型"
    description="管理 AI 服务、连接凭据和可用模型。"
    :show-aside="!loading"
    :surface="false"
  >
    <template #actions>
      <UiButton variant="primary" @click="openCreateProvider"><UiIcon name="plus" /> 新增 Provider</UiButton>
    </template>

    <template #notices>
      <div v-if="allowInsecureHttp" class="settings-notice settings-notice--warning" role="status">
        <UiIcon name="triangle-alert" />
        <span>部署者已允许 HTTP Provider。未加密连接可能泄露 API Key，仅用于明确配置的内网网关。</span>
      </div>
      <div v-if="pageError" class="settings-notice settings-notice--danger" role="alert">
        <UiIcon name="triangle-alert" /><span>{{ pageError }}</span><button type="button" @click="loadProviders">重试</button>
      </div>
    </template>

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
                  <span :class="{ muted: !model.supportsTools }">工具：{{ model.supportsTools ? '支持' : '不支持' }}</span>
                  <span :class="{ muted: !model.supportsVision }">视觉：{{ model.supportsVision ? '支持' : '不支持' }}</span>
                  <span v-if="model.reasoningOptions?.length">思考 {{ model.reasoningOptions.length }}</span>
                  <span v-if="!model.enabled" class="muted">停用</span>
                </td>
                <td class="model-actions">
                  <button type="button" aria-label="编辑模型" :data-edit-model="model.id" @click="openEditModel(provider, model)"><UiIcon name="pencil" :size="16" /></button>
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
          <UiButton :disabled="!provider.enabled || !selectedModels[provider.id] || testStates[provider.id]?.kind === 'testing'" @click="testProvider(provider)">
            {{ testStates[provider.id]?.kind === 'testing' ? '测试中…' : '测试连接' }}
          </UiButton>
          <p
            v-if="testStates[provider.id] && testStates[provider.id]?.modelId === selectedModels[provider.id] && testStates[provider.id]?.version === (providerTestVersions[provider.id] ?? 0)"
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
        <UiButton variant="secondary" :data-edit-provider="provider.id" @click="openEditProvider(provider)"><UiIcon name="pencil" /> 编辑与替换密钥</UiButton>
        <UiButton variant="danger" @click="pendingDelete = { kind: 'provider', id: provider.id, label: provider.displayName }">删除 Provider</UiButton>
      </footer>
    </article>

    <article class="settings-card embedding-card" aria-labelledby="embedding-settings-title">
      <header class="settings-card__header">
        <div>
          <p class="settings-kicker">独立检索配置</p>
          <h3 id="embedding-settings-title">知识库 Embedding</h3>
          <p>用于把合格笔记建立为可检索向量；不属于聊天 Provider，也不随会话模型切换。</p>
        </div>
        <span class="settings-status" :class="{ 'settings-status--success': indexStatus?.status === 'ready' }">
          {{ indexStatusLabel(indexStatus?.status) }}
        </span>
      </header>

      <div v-if="embeddingLoading" class="settings-card__body settings-loading" role="status">
        <span class="settings-spinner" aria-hidden="true" />正在读取 Embedding 与索引状态…
      </div>

      <div v-else-if="embeddingError" class="settings-card__body">
        <div class="settings-notice settings-notice--danger" role="alert">
          <UiIcon name="triangle-alert" /><span>{{ embeddingError }}</span><button type="button" @click="loadEmbeddingSection">重试</button>
        </div>
      </div>

      <div v-else class="settings-card__body embedding-card__body">
        <form id="embedding-form" class="settings-form embedding-form" @submit.prevent="saveEmbedding">
          <div class="settings-field-row">
            <label class="settings-field">
              <span>显示名</span>
              <input v-model="embeddingDraft.displayName" required maxlength="120" placeholder="团队知识向量" :readonly="embeddingBusy" />
            </label>
            <label class="settings-field">
              <span>上游 Embedding 模型 ID</span>
              <input v-model="embeddingDraft.modelId" required maxlength="200" autocomplete="off" placeholder="text-embedding-3-small" :readonly="embeddingBusy" />
            </label>
          </div>
          <label class="settings-field">
            <span>OpenAI-compatible Base URL</span>
            <input v-model="embeddingDraft.baseUrl" required maxlength="2048" inputmode="url" placeholder="https://provider.example/v1" :readonly="embeddingBusy" />
            <small>系统固定调用 /embeddings，不跟随重定向。</small>
          </label>
          <div class="settings-field-row">
            <label class="settings-field">
              <span>{{ embeddingSettings?.apiKeyConfigured ? '替换独立 API Key（留空则保持）' : '独立 API Key' }}</span>
              <input v-model="embeddingDraft.apiKey" type="password" :required="!embeddingSettings?.apiKeyConfigured" maxlength="8192" autocomplete="new-password" :readonly="embeddingBusy" />
              <small v-if="embeddingSettings?.apiKeyConfigured">已保存密钥末尾：••••{{ embeddingSettings.apiKeyTail || '未知' }}；页面不会回显明文。</small>
              <small v-else>与聊天 Provider 密钥分开保存，保存后不可再次读取明文。</small>
            </label>
            <label class="settings-field">
              <span>向量维度</span>
              <input v-model.number="embeddingDraft.dimensions" required type="number" min="1" max="16000" step="1" inputmode="numeric" :readonly="embeddingBusy" />
              <small>请求维度与 Provider 实际返回必须完全一致。</small>
            </label>
          </div>
          <label class="settings-check embedding-form__enabled">
            <input v-model="embeddingDraft.enabled" type="checkbox" :disabled="embeddingBusy" />
            <span>启用知识库 Embedding 和持续索引</span>
          </label>
          <div v-if="embeddingDraft.enabled" class="embedding-consent" role="note">
            <UiIcon name="info" :size="17" />
            <p>保存并启用后，之后新增或更新的合格笔记会自动发送给此 Embedding Provider，直到你禁用或删除配置。</p>
          </div>
          <div v-else-if="embeddingSettings?.configured" class="embedding-consent embedding-consent--warning" role="note">
            <UiIcon name="triangle-alert" :size="17" />
            <p>保存为禁用会让知识库立即不可用并停止新索引，但仍保留加密密钥。删除配置才会清空密钥和派生向量。</p>
          </div>

          <div class="embedding-actions">
            <div>
              <strong>测试会发起 1 次外部调用</strong>
              <small>只发送固定的非用户探针；不保存设置、不自动重试，可能产生费用。</small>
            </div>
            <UiButton :disabled="embeddingTesting || embeddingBusy" @click="testEmbedding">
              {{ embeddingTesting ? '测试中…' : '测试连接' }}
            </UiButton>
            <UiButton type="submit" form="embedding-form" variant="primary" :disabled="embeddingBusy || embeddingTesting">
              {{ embeddingBusy ? '正在保存…' : '保存 Embedding' }}
            </UiButton>
          </div>

          <div v-if="embeddingTestResult" class="embedding-test-result" :class="{ 'embedding-test-result--warning': !embeddingDimensionMatches }" role="status">
            <UiIcon :name="embeddingDimensionMatches ? 'check-circle-2' : 'triangle-alert'" :size="18" />
            <p>
              <strong>{{ embeddingDimensionMatches ? '连接成功' : '连接成功，但维度不一致' }} · {{ embeddingTestResult.latencyMs }} ms · 实际 {{ embeddingTestResult.actualDimensions }} 维</strong>
              <small>
                {{ embeddingDimensionMatches ? '' : `当前请求 ${embeddingDraft.dimensions} 维；请修正后再保存。` }}
                用量：{{ embeddingTestResult.usage ? `${embeddingTestResult.usage.inputTokens ?? '未提供'} / ${embeddingTestResult.usage.totalTokens ?? '未提供'} tokens` : 'Provider 未返回' }}
              </small>
            </p>
          </div>
          <div v-if="embeddingTestError" class="settings-notice settings-notice--danger" role="alert"><UiIcon name="wifi-off" />{{ embeddingTestError }}</div>
          <div v-if="embeddingActionError" class="settings-notice settings-notice--danger" role="alert"><UiIcon name="triangle-alert" />{{ embeddingActionError }}</div>
        </form>

        <section v-if="indexStatus" class="index-status" aria-labelledby="index-status-heading">
          <header>
            <div><h4 id="index-status-heading">索引状态</h4><p>Generation {{ indexStatus.generation ?? '—' }} · 敏感策略：{{ sensitivePolicyLabel(indexStatus.sensitivePolicy) }}</p></div>
            <span :data-status="indexStatus.status">{{ indexStatusLabel(indexStatus.status) }}</span>
          </header>
          <dl class="index-counts">
            <div><dt>活跃片段</dt><dd>{{ indexStatus.counts.active }}</dd></div>
            <div><dt>可检索</dt><dd>{{ indexStatus.counts.ready }}</dd></div>
            <div><dt>待处理</dt><dd>{{ indexStatus.counts.pending }}</dd></div>
            <div><dt>运行中</dt><dd>{{ indexStatus.counts.running }}</dd></div>
            <div><dt>失败</dt><dd>{{ indexStatus.counts.failed }}</dd></div>
            <div><dt>已排除</dt><dd>{{ indexStatus.counts.excluded }}</dd></div>
          </dl>
          <p v-if="indexStatus.lastErrorCode" class="index-status__error">最近错误：<code>{{ indexStatus.lastErrorCode }}</code></p>
          <div v-if="indexPollError" class="settings-notice settings-notice--danger index-status__poll-error" role="alert">
            <UiIcon name="triangle-alert" />
            <span>自动刷新索引状态失败：{{ indexPollError }}</span>
            <UiButton variant="secondary" @click="refreshIndexAfterError">刷新索引状态</UiButton>
          </div>
          <p v-if="indexStatus.status !== 'ready'" class="index-status__boundary">知识库当前不可用；知识助手仍可进行一般交流，但不会把零来源描述为“没有相关资料”。</p>
        </section>

        <section v-if="indexFailures.length" class="index-failures" aria-labelledby="index-failures-heading">
          <header>
            <div><h4 id="index-failures-heading">失败片段</h4><p>只重试明确失败的片段，不提供手动全库重建。</p></div>
            <UiButton v-if="indexFailuresStale" variant="ghost" title="存在未展示的新失败片段，刷新后显示最新列表" @click="refreshIndexFailures">
              有新失败 · 刷新列表
            </UiButton>
          </header>
          <ul>
            <li v-for="failure in indexFailures" :key="failure.fragmentId">
              <div>
                <strong>{{ failure.itemTitle }}</strong>
                <small>{{ sourceKindLabel(failure.sourceKind) }} · 第 {{ failure.attempt }} 次 · <code>{{ failure.errorCode }}</code></small>
              </div>
              <UiButton :disabled="retryingFailures[failure.fragmentId]" @click="retryIndexFailure(failure)">
                {{ retryingFailures[failure.fragmentId] ? '正在提交…' : '重试' }}
              </UiButton>
            </li>
          </ul>
          <UiButton v-if="indexFailureNextCursor" variant="ghost" :disabled="failureLoading" @click="loadMoreIndexFailures">
            {{ failureLoading ? '正在读取…' : '加载更多失败项' }}
          </UiButton>
        </section>
      </div>

      <footer v-if="embeddingSettings?.configured" class="provider-card__footer embedding-card__footer">
        <p>删除会清空独立密钥和全部派生向量；这与暂时禁用不同。</p>
        <UiButton variant="danger" @click="openEmbeddingDelete">删除 Embedding 配置</UiButton>
      </footer>
    </article>

    <template #aside>
      <section>
        <h3>配置摘要</h3>
        <dl class="settings-context__list">
          <div><dt>已启用 Provider</dt><dd>{{ enabledProviderCount }} / {{ providers.length }}</dd></div>
          <div><dt>已启用模型</dt><dd>{{ enabledModelCount }} / {{ modelCount }}</dd></div>
          <div><dt>聊天 Provider 密钥</dt><dd>{{ configuredKeyCount }}</dd></div>
          <div><dt>知识索引</dt><dd>{{ embeddingLoading ? '读取中' : indexStatusLabel(indexStatus?.status) }}</dd></div>
          <div><dt>HTTP Provider</dt><dd>{{ allowInsecureHttp ? '部署者已允许' : '禁止' }}</dd></div>
        </dl>
      </section>
      <section
        class="settings-context__notice"
        :class="allowInsecureHttp ? 'settings-context__notice--warning' : 'settings-context__notice--success'"
      >
        <UiIcon :name="allowInsecureHttp ? 'triangle-alert' : 'shield-check'" />
        <div>
          <strong>{{ allowInsecureHttp ? '存在明文传输风险' : '密钥边界受控' }}</strong>
          <p>{{ allowInsecureHttp ? '只在你确认的内网网关使用 HTTP，公网 Provider 应保持 HTTPS。' : 'API Key 加密保存，页面只读取掩码；明文不会再次返回。' }}</p>
        </div>
      </section>
      <p class="settings-context__footnote">连接测试只在你点击后发送一次最小请求，可能产生所选 Provider 的调用费用。</p>
    </template>
  </SettingsPageShell>

  <Teleport to="body">
    <div v-if="providerEditorOpen" class="settings-overlay" @click.self="closeProviderEditor">
      <section ref="dialogRoot" class="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="provider-editor-title" @keydown="onDialogKeydown($event, closeProviderEditor)">
        <header>
          <div><h2 id="provider-editor-title">{{ editingProvider ? '编辑 Provider' : '新增 Provider' }}</h2></div>
          <button class="settings-icon-button" type="button" aria-label="关闭" :disabled="busy" @click="closeProviderEditor"><UiIcon name="x" /></button>
        </header>
        <div class="settings-drawer__body">
          <form id="provider-form" class="settings-form" @submit.prevent="saveProvider">
            <label class="settings-field"><span>稳定 Provider Key</span><input v-model="providerDraft.providerKey" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]*" :disabled="editingProvider" :readonly="busy" autocomplete="off" /><small>创建后不可修改，用于稳定标识历史配置。</small></label>
            <label class="settings-field"><span>显示名</span><input v-model="providerDraft.displayName" required maxlength="120" :readonly="busy" /></label>
            <label class="settings-field"><span>协议</span><select v-model="providerDraft.protocol" :disabled="busy"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
            <label class="settings-field"><span>Base URL</span><input v-model="providerDraft.baseUrl" required maxlength="2048" inputmode="url" placeholder="https://provider.example/v1" :readonly="busy" /><small>填写协议根地址；系统只拼接固定 endpoint，且不跟随重定向。</small></label>
            <label class="settings-field"><span>{{ editingProvider ? '替换 API Key（留空则保持）' : 'API Key' }}</span><input v-model="providerDraft.apiKey" type="password" :required="!editingProvider" maxlength="8192" autocomplete="new-password" :readonly="busy" /><small>保存后不可再次读取明文。</small></label>
            <label class="settings-check"><input v-model="providerDraft.enabled" type="checkbox" :disabled="busy" /><span>允许该 Provider 接受连接测试与新任务</span></label>
            <div v-if="actionError" class="settings-notice settings-notice--danger" role="alert"><UiIcon name="triangle-alert" />{{ actionError }}</div>
          </form>
        </div>
        <footer><UiButton variant="ghost" :disabled="busy" @click="closeProviderEditor">取消</UiButton><UiButton type="submit" form="provider-form" variant="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存 Provider' }}</UiButton></footer>
      </section>
    </div>

    <div v-if="modelEditorOpen" class="settings-overlay" @click.self="closeModelEditor">
      <section ref="dialogRoot" class="settings-drawer settings-drawer--model" role="dialog" aria-modal="true" aria-labelledby="model-editor-title" @keydown="onDialogKeydown($event, closeModelEditor)">
        <header>
          <div><p class="settings-kicker">{{ modelOwner?.displayName }}</p><h2 id="model-editor-title">{{ editingModel ? '编辑模型' : '添加模型' }}</h2></div>
          <button class="settings-icon-button" type="button" aria-label="关闭" :disabled="busy" @click="closeModelEditor"><UiIcon name="x" /></button>
        </header>
        <div class="settings-drawer__body">
          <form id="model-form" class="settings-form" @submit.prevent="saveModel">
            <label class="settings-field"><span>上游模型 ID</span><input v-model="modelDraft.modelId" required maxlength="200" autocomplete="off" :readonly="busy" /></label>
            <label class="settings-field"><span>显示名</span><input v-model="modelDraft.displayName" required maxlength="120" :readonly="busy" /></label>
            <div class="settings-field-row">
              <label class="settings-field"><span>上下文窗口</span><input v-model.number="modelDraft.contextWindow" type="number" min="1" placeholder="待配置" :readonly="busy" /></label>
              <label class="settings-field"><span>最大输出 Token</span><input v-model.number="modelDraft.maxOutputTokens" type="number" min="1" placeholder="待配置" :readonly="busy" /></label>
            </div>
            <fieldset class="settings-fieldset reasoning-editor">
              <legend>知识助手思考档位</legend>
              <p>“不思考”由系统固定提供；这里只配置模型实际支持的附加档位，顺序会用于选择器。</p>
              <div v-if="modelDraft.reasoningOptions.length" class="reasoning-editor__rows">
                <div v-for="(option, index) in modelDraft.reasoningOptions" :key="option.key" :data-reasoning-key="option.key" class="reasoning-editor__row">
                  <label class="settings-field">
                    <span>显示名称</span>
                    <input v-model="option.displayName" maxlength="40" autocomplete="off" :readonly="busy" />
                  </label>
                  <label class="settings-field">
                    <span>档位值</span>
                    <select v-model="option.reasoning" :disabled="busy">
                      <option v-for="entry in reasoningValues" :key="entry.value" :value="entry.value">{{ entry.label }}</option>
                    </select>
                  </label>
                  <div class="reasoning-editor__actions" aria-label="调整档位顺序">
                    <button type="button" :disabled="busy || index === 0" :aria-label="`上移${option.displayName || '思考档位'}`" title="上移" @click="moveReasoningOption(index, -1)"><UiIcon name="chevron-left" :size="16" /></button>
                    <button type="button" :disabled="busy || index === modelDraft.reasoningOptions.length - 1" :aria-label="`下移${option.displayName || '思考档位'}`" title="下移" @click="moveReasoningOption(index, 1)"><UiIcon name="chevron-right" :size="16" /></button>
                    <button type="button" :disabled="busy" :aria-label="`删除${option.displayName || '思考档位'}`" title="删除档位" @click="removeReasoningOption(index)"><UiIcon name="trash-2" :size="16" /></button>
                  </div>
                </div>
              </div>
              <p v-else class="reasoning-editor__empty">未配置附加思考档位；知识助手只显示“不思考”。</p>
              <UiButton variant="secondary" :disabled="busy || modelDraft.reasoningOptions.length >= 6" @click="addReasoningOption"><UiIcon name="plus" :size="16" />添加思考档位</UiButton>
            </fieldset>
            <fieldset class="settings-fieldset"><legend>模型能力</legend><label class="settings-check"><input v-model="modelDraft.supportsTools" type="checkbox" :disabled="busy" /><span>支持工具调用（可选；不可用时改用 JSON）</span></label><label class="settings-check"><input v-model="modelDraft.supportsVision" type="checkbox" :disabled="busy" /><span>支持图片输入</span></label><label class="settings-check"><input v-model="modelDraft.enabled" type="checkbox" :disabled="busy" /><span>启用模型</span></label></fieldset>
            <div v-if="actionError" class="settings-notice settings-notice--danger" role="alert"><UiIcon name="triangle-alert" />{{ actionError }}</div>
          </form>
        </div>
        <footer><UiButton variant="ghost" :disabled="busy" @click="closeModelEditor">取消</UiButton><UiButton type="submit" form="model-form" variant="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存模型' }}</UiButton></footer>
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

    <div v-if="pendingReindex" class="settings-overlay settings-dialog-shell">
      <section ref="dialogRoot" class="settings-dialog embedding-confirm" role="alertdialog" aria-modal="true" aria-labelledby="embedding-reindex-title" @keydown="onDialogKeydown($event, () => (pendingReindex = null))">
        <p class="settings-kicker">需要当次授权</p>
        <h2 id="embedding-reindex-title">{{ pendingReindex.enabled ? '确认全量重建知识索引？' : '确认禁用知识索引？' }}</h2>
        <p>{{ pendingReindex.enabled ? '这次配置变化会使旧向量立即停止召回，并重新发送当前全部合格片段。' : '禁用会使旧向量立即停止召回并终止持续索引；加密密钥仍会保留。' }}</p>
        <dl>
          <div><dt>{{ pendingReindex.enabled ? '将重新发送' : '受影响' }}</dt><dd>{{ indexStatus?.counts.active ?? embeddingSettings?.activeFragmentCount ?? 0 }} 个活跃片段</dd></div>
          <div><dt>敏感策略</dt><dd>{{ sensitivePolicyLabel(indexStatus?.sensitivePolicy) }}</dd></div>
          <div v-if="pendingReindex.enabled"><dt>单批上限</dt><dd>最多 16 个片段</dd></div>
        </dl>
        <div v-if="pendingReindex.enabled" class="settings-notice settings-notice--warning"><UiIcon name="triangle-alert" /><span>重建会产生多次外部 Embedding 调用，可能产生 Provider 费用。只有本次确认会授权这些调用。</span></div>
        <div v-else class="settings-notice settings-notice--warning"><UiIcon name="triangle-alert" /><span>禁用本身不会重新发送片段；知识助手将只能进行一般交流，直到你再次启用并确认重建。</span></div>
        <div v-if="embeddingActionError" class="settings-notice settings-notice--danger" role="alert">{{ embeddingActionError }}</div>
        <div class="settings-actions">
          <UiButton variant="ghost" :disabled="embeddingBusy" @click="pendingReindex = null">取消</UiButton>
          <UiButton variant="primary" :disabled="embeddingBusy" @click="confirmEmbeddingReindex">{{ embeddingBusy ? '正在保存…' : pendingReindex.enabled ? '确认重建并保存' : '确认禁用并保存' }}</UiButton>
        </div>
      </section>
    </div>

    <div v-if="embeddingDeleteOpen" class="settings-overlay settings-dialog-shell">
      <section ref="dialogRoot" class="settings-dialog" role="alertdialog" aria-modal="true" aria-labelledby="embedding-delete-title" @keydown="onDialogKeydown($event, () => (embeddingDeleteOpen = false))">
        <h2 id="embedding-delete-title">删除 Embedding 配置？</h2>
        <p>独立 API Key、配置和全部派生向量会被清空，知识库立即不可用。原始笔记不会删除。</p>
        <p>如果只是暂时停用，请取消并关闭“启用知识库 Embedding”，再保存配置。</p>
        <div v-if="embeddingActionError" class="settings-notice settings-notice--danger" role="alert">{{ embeddingActionError }}</div>
        <div class="settings-actions">
          <UiButton variant="ghost" :disabled="embeddingBusy" @click="embeddingDeleteOpen = false">取消</UiButton>
          <UiButton variant="danger" :disabled="embeddingBusy" @click="confirmDeleteEmbedding">{{ embeddingBusy ? '正在删除…' : '确认删除配置' }}</UiButton>
        </div>
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
.model-table td:nth-child(3) .muted { background: var(--bg-code); color: var(--text-muted); }
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
.settings-drawer--model { width: min(700px, 100vw); }
.reasoning-editor { gap: var(--space-3); }
.reasoning-editor > p { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.55; }
.reasoning-editor__rows { display: grid; gap: var(--space-2); }
.reasoning-editor__row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(120px, .8fr) auto; align-items: end; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.reasoning-editor__actions { display: flex; gap: 2px; padding-bottom: 5px; }
.reasoning-editor__actions button { display: grid; width: 32px; height: 32px; place-items: center; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.reasoning-editor__actions button:hover:not(:disabled) { border-color: var(--border-subtle); background: var(--bg-elevated); color: var(--text-primary); }
.reasoning-editor__actions button:disabled { cursor: not-allowed; opacity: .35; }
.reasoning-editor__actions button:first-child :deep(svg),
.reasoning-editor__actions button:nth-child(2) :deep(svg) { transform: rotate(90deg); }
.reasoning-editor__actions button:last-child:hover { color: var(--danger); }
.reasoning-editor__empty { padding: var(--space-3); border: 1px dashed var(--border-subtle); border-radius: var(--radius-control); text-align: center; }
.embedding-card { margin-top: var(--space-8); border-color: var(--border-strong); }
.embedding-card__body { display: grid; gap: var(--space-5); }
.embedding-form { min-width: 0; }
.embedding-form__enabled { padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.embedding-consent { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border-subtle)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--accent) 9%, var(--bg-code)); color: var(--accent); }
.embedding-consent--warning { border-color: color-mix(in srgb, var(--warning) 52%, var(--border-subtle)); background: color-mix(in srgb, var(--warning) 8%, var(--bg-code)); color: var(--warning); }
.embedding-consent p { margin: 0; color: var(--text-secondary); line-height: 1.55; }
.embedding-actions { display: grid; grid-template-columns: minmax(220px, 1fr) auto auto; align-items: center; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.embedding-actions strong,
.embedding-actions small { display: block; }
.embedding-actions small { margin-top: 2px; color: var(--text-muted); }
.embedding-test-result { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--success) 48%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--success); }
.embedding-test-result p,
.embedding-test-result small { margin: 0; }
.embedding-test-result small { display: block; margin-top: 2px; color: var(--text-secondary); }
.embedding-test-result--warning { border-color: color-mix(in srgb, var(--warning) 52%, var(--border-subtle)); color: var(--warning); }
.index-status,
.index-failures { min-width: 0; padding-top: var(--space-5); border-top: 1px solid var(--border-subtle); }
.index-status > header,
.index-failures > header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.index-status h4,
.index-status p,
.index-failures h4,
.index-failures p { margin: 0; }
.index-status h4,
.index-failures h4 { font-size: 15px; }
.index-status header p,
.index-failures header p { margin-top: 2px; color: var(--text-muted); font-size: 12px; }
.index-status header > span { flex: 0 0 auto; padding: 4px 8px; border-radius: 999px; background: var(--bg-code); color: var(--text-secondary); font-size: 11px; font-weight: 700; }
.index-status header > span[data-status='ready'] { color: var(--success); }
.index-status header > span[data-status='indexing'] { color: var(--warning); }
.index-status header > span[data-status='failed'] { color: var(--danger); }
.index-counts { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--space-2); margin: var(--space-4) 0 0; }
.index-counts > div { min-width: 0; padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.index-counts dt { color: var(--text-muted); font-size: 10px; }
.index-counts dd { margin: var(--space-1) 0 0; color: var(--text-primary); font-family: var(--font-mono); font-size: 18px; }
.index-status__error { margin-top: var(--space-3) !important; color: var(--danger); font-size: 12px; }
.index-status__poll-error { flex-wrap: wrap; margin-top: var(--space-3); }
.index-status__boundary { margin-top: var(--space-3) !important; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--warning) 48%, var(--border-subtle)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--warning) 8%, transparent); color: var(--text-secondary); line-height: 1.55; }
.index-failures ul { display: grid; gap: var(--space-2); margin: var(--space-4) 0 var(--space-3); padding: 0; list-style: none; }
.index-failures li { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.index-failures li > div { min-width: 0; }
.index-failures strong,
.index-failures small { display: block; }
.index-failures strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.index-failures small { margin-top: 2px; color: var(--text-muted); }
.embedding-card__footer { align-items: center; justify-content: space-between; }
.embedding-card__footer p { max-width: 62ch; margin: 0; color: var(--text-muted); font-size: 12px; }
.embedding-confirm dl { display: grid; gap: var(--space-2); margin: var(--space-4) 0 0; }
.embedding-confirm dl > div { display: flex; justify-content: space-between; gap: var(--space-3); padding-bottom: var(--space-2); border-bottom: 1px solid var(--border-subtle); }
.embedding-confirm dt { color: var(--text-muted); }
.embedding-confirm dd { margin: 0; color: var(--text-primary); font-weight: 700; text-align: right; }
@media (max-width: 799px) {
  .connection-test { grid-template-columns: 1fr; }
  .connection-result { grid-column: auto; }
  .index-counts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
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
  .reasoning-editor__row { grid-template-columns: 1fr; }
  .reasoning-editor__actions { justify-content: flex-end; padding-bottom: 0; }
  .embedding-actions { grid-template-columns: 1fr; }
  .embedding-actions .button { width: 100%; }
  .index-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .index-status__poll-error { align-items: stretch; flex-direction: column; }
  .index-status__poll-error .button { width: 100%; margin-left: 0; }
  .index-status > header,
  .index-failures > header,
  .index-failures li,
  .embedding-card__footer { align-items: stretch; flex-direction: column; }
  .embedding-card__footer .button { width: 100%; }
}
</style>

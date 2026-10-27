<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useAuthStore } from '../../../app/auth'
import UiButton from '../../../components/ui/UiButton.vue'
import { ApiError, apiRequest } from '../../../lib/api'
import CopyButton from '../shared/ui/CopyButton.vue'
import ToolPageHeader from '../shared/ui/ToolPageHeader.vue'
import { createAdaptiveEditor, type AdaptiveEditor } from '../shared/editor'
import {
  WorkerRequestCancelledError,
  WorkerRequestClient,
  type WorkerRequest,
} from '../shared/worker'
import type { JsonLocalLanguage, JsonWorkerRequest, JsonWorkerResult } from './contracts'
import {
  buildJsonAIRequestDraft,
  type JsonAIRequestDraft,
  type JsonAISendMode,
} from './jsonAi'

interface AIProviderModel {
  id: string
  displayName: string
  modelId: string
  contextWindow: number | null
  maxOutputTokens: number | null
  enabled: boolean
}

interface AIProvider {
  id: string
  displayName: string
  hasApiKey: boolean
  enabled: boolean
  models: AIProviderModel[]
}

interface AIConfirmation extends JsonAIRequestDraft {
  providerLabel: string
  modelLabel: string
  targetLanguage: string
  /** 组件内私有快照：仅用于返回后核对输入与选项是否已变化，绝不进入 HTTP body。 */
  sourceSnapshot: string
  providerId: string
  modelId: string
}

interface JsonAIResponse {
  code: string
  language: string
  promptVersion: 'json-type-generation-v1'
  usage: { inputTokens: number; outputTokens: number } | null
}

type Tab = 'format' | 'jsonpath' | 'diff' | 'schema' | 'types'

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'format', label: '格式化' },
  { id: 'jsonpath', label: 'JSONPath' },
  { id: 'diff', label: '对比' },
  { id: 'schema', label: 'Schema' },
  { id: 'types', label: '类型生成' },
]
const examples = `{
  "project": "dev-toolbox",
  "version": 2,
  "features": ["json", "yaml"]
}`

const auth = useAuthStore()
const input = ref(examples)
const output = ref('')
const secondaryText = ref('{\n  "project": "dev-toolbox",\n  "version": 2\n}')
const schemaText = ref('{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "type": "object"\n}')
const activeTab = ref<Tab>('format')
const formatMode = ref<'pretty' | 'compact'>('pretty')
const jsonPath = ref('$.features[*]')
const diffMode = ref<'structure' | 'text'>('structure')
const identityField = ref('')
const language = ref<JsonLocalLanguage>('typescript')
const generationSource = ref<'local' | 'ai'>('local')
const aiProviders = ref<AIProvider[]>([])
const aiProviderId = ref('')
const aiModelId = ref('')
const aiTargetLanguage = ref('Rust')
const aiSendMode = ref<JsonAISendMode>('structure')
const aiOptionsLoaded = ref(false)
const aiOptionsLoading = ref(false)
const aiUnavailable = ref(false)
const aiRunning = ref(false)
const aiFailed = ref(false)
const aiConfirmation = ref<AIConfirmation | null>(null)
const fullSendAcknowledged = ref(false)
const mobilePane = ref<'input' | 'result'>('input')
const summary = ref('')
const issues = ref<string[]>([])
const errorMessage = ref('')
const editorFailed = ref(false)
const repairCandidate = ref('')
const repairDiff = ref('')
const running = ref(false)
const showProgress = ref(false)
const inputHost = ref<HTMLElement | null>(null)
const resultHost = ref<HTMLElement | null>(null)
const editorsRoot = ref<HTMLElement | null>(null)
const confirmationDialog = ref<HTMLElement | null>(null)
const editorSplit = ref(50)

let inputEditor: AdaptiveEditor | null = null
let resultEditor: AdaptiveEditor | null = null
let activeRequest: WorkerRequest<JsonWorkerResult> | null = null
let repairSource = ''
let progressTimer: number | undefined
let aiAbortController: AbortController | null = null
let confirmationPreviousFocus: HTMLElement | null = null
let stopEditorResize: (() => void) | null = null

const workerClient = new WorkerRequestClient<JsonWorkerRequest, JsonWorkerResult>(
  () => new Worker(new URL('./structured.worker.ts', import.meta.url), { type: 'module' }),
)

const availableAIProviders = computed(() => aiProviders.value
  .filter((provider) => provider.enabled && provider.hasApiKey)
  .map((provider) => ({
    ...provider,
    models: provider.models.filter((model) =>
      model.enabled &&
      Number.isInteger(model.contextWindow) && Number(model.contextWindow) > 0 &&
      Number.isInteger(model.maxOutputTokens) && Number(model.maxOutputTokens) > 0,
    ),
  }))
  .filter((provider) => provider.models.length > 0))

const selectedAIProvider = computed(() =>
  availableAIProviders.value.find((provider) => provider.id === aiProviderId.value) ?? null,
)
const availableAIModels = computed(() => selectedAIProvider.value?.models ?? [])
const selectedAIModel = computed(() =>
  availableAIModels.value.find((model) => model.id === aiModelId.value) ?? null,
)
const isBusy = computed(() => running.value || aiRunning.value)
// 本地 running 时主按钮由模板切换为可用取消，禁用判断只描述非运行态。
const primaryDisabled = computed(() => {
  if (!input.value) return true
  if (activeTab.value !== 'types' || generationSource.value === 'local') return false
  return aiOptionsLoading.value || !selectedAIProvider.value || !selectedAIModel.value || !aiTargetLanguage.value
})
const editorGridStyle = computed(() => ({
  gridTemplateColumns: `minmax(280px, ${editorSplit.value}fr) 8px minmax(280px, ${100 - editorSplit.value}fr)`,
}))

const rightText = computed(() => {
  if (activeTab.value === 'diff') return secondaryText.value
  if (activeTab.value === 'schema') return schemaText.value
  return output.value
})

const actionLabel = computed(() => {
  if (activeTab.value === 'format') return formatMode.value === 'pretty' ? '格式化' : '压缩'
  if (activeTab.value === 'jsonpath') return '运行查询'
  if (activeTab.value === 'diff') return '开始对比'
  if (activeTab.value === 'schema') return '校验实例'
  return generationSource.value === 'ai' ? '预览并确认发送' : '生成本地类型'
})

const editorLoadFailedMessage = '编辑器组件加载失败，已输入内容不会丢失；可重试加载。'

onMounted(async () => {
  if (!inputHost.value || !resultHost.value) return
  inputEditor = createAdaptiveEditor({
    host: inputHost.value,
    ariaLabel: 'JSON 输入编辑器',
    language: 'json',
    value: input.value,
    onChange(value) {
      invalidateStaleResults()
      input.value = value
    },
    onMigrationError() {
      editorFailed.value = true
    },
  })
  resultEditor = createAdaptiveEditor({
    host: resultHost.value,
    ariaLabel: 'JSON 结果编辑器',
    language: 'json',
    value: rightText.value,
    readOnly: true,
    onChange(value) {
      if (activeTab.value === 'diff') {
        invalidateStaleResults()
        secondaryText.value = value
      } else if (activeTab.value === 'schema') {
        invalidateStaleResults()
        schemaText.value = value
      }
    },
    onMigrationError() {
      editorFailed.value = true
    },
  })
  try {
    await Promise.all([inputEditor.ready, resultEditor.ready])
  } catch {
    editorFailed.value = true
  }
})

async function retryEditorLoad() {
  if (!inputEditor || !resultEditor) return
  try {
    await Promise.all([inputEditor.refresh(), resultEditor.refresh()])
    editorFailed.value = false
  } catch {
    editorFailed.value = true
  }
}

watch(input, (value) => {
  if (repairCandidate.value && value !== repairSource) {
    clearRepairState()
    summary.value = '输入已修改，修复候选已失效。'
  }
  if (inputEditor?.getValue() !== value) inputEditor?.setValue(value)
})
watch(rightText, (value) => {
  if (resultEditor?.getValue() !== value) resultEditor?.setValue(value)
})
watch(activeTab, async (tab) => {
  cancelLocalRequest()
  clearRepairState()
  if (tab !== 'types') {
    cancelAIRequest()
    closeAIConfirmation()
  }
  resultEditor?.setAriaLabel(
    tab === 'diff' ? 'JSON 输入 B 编辑器' : tab === 'schema' ? 'JSON Schema 编辑器' : 'JSON 结果编辑器',
  )
  resultEditor?.setReadOnly(tab !== 'diff' && tab !== 'schema')
  await resultEditor?.setLanguage(tab === 'types' ? 'plaintext' : 'json')
  resultEditor?.setValue(rightText.value)
  output.value = ''
  summary.value = ''
  issues.value = []
  errorMessage.value = ''
  mobilePane.value = 'input'
  await nextTick()
})
watch(
  [formatMode, jsonPath, diffMode, identityField, language, aiTargetLanguage, aiSendMode, aiProviderId, aiModelId],
  () => {
    invalidateStaleResults()
  },
)
watch(aiProviderId, () => {
  if (!availableAIModels.value.some((model) => model.id === aiModelId.value)) {
    aiModelId.value = availableAIModels.value[0]?.id ?? ''
  }
})

onBeforeUnmount(() => {
  stopEditorResize?.()
  cancelLocalRequest()
  aiAbortController?.abort()
  workerClient.dispose()
  inputEditor?.dispose()
  resultEditor?.dispose()
})

function startEditorResize(event: PointerEvent) {
  if (event.button !== 0 || !editorsRoot.value) return
  event.preventDefault()
  const root = editorsRoot.value
  const update = (moveEvent: PointerEvent) => {
    const bounds = root.getBoundingClientRect()
    if (!bounds.width) return
    const next = ((moveEvent.clientX - bounds.left) / bounds.width) * 100
    editorSplit.value = Math.min(70, Math.max(30, Math.round(next)))
  }
  const stop = () => {
    window.removeEventListener('pointermove', update)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    stopEditorResize = null
  }
  stopEditorResize?.()
  stopEditorResize = stop
  window.addEventListener('pointermove', update)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}

function adjustEditorSplit(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  if (event.key === 'Home') editorSplit.value = 30
  else if (event.key === 'End') editorSplit.value = 70
  else editorSplit.value = Math.min(70, Math.max(30, editorSplit.value + (event.key === 'ArrowLeft' ? -5 : 5)))
}

async function runPrimary(event?: Event) {
  if (isBusy.value) return
  if (activeTab.value === 'types' && generationSource.value === 'ai') {
    const trigger = event?.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    await prepareAIConfirmation(trigger)
    return
  }
  const request = buildRequest()
  if (!request) return
  await execute(request)
}

function buildRequest(): JsonWorkerRequest | null {
  if (activeTab.value === 'format') return { operation: 'format', text: input.value, compact: formatMode.value === 'compact' }
  if (activeTab.value === 'jsonpath') return { operation: 'jsonpath', text: input.value, expression: jsonPath.value }
  if (activeTab.value === 'diff') return {
    operation: 'diff',
    left: input.value,
    right: secondaryText.value,
    mode: diffMode.value,
    identityField: identityField.value,
  }
  if (activeTab.value === 'schema') return { operation: 'schema-validate', text: input.value, schemaText: schemaText.value }
  return { operation: 'type-generate', text: input.value, language: language.value }
}

async function execute(request: JsonWorkerRequest): Promise<JsonWorkerResult | null> {
  errorMessage.value = ''
  summary.value = ''
  issues.value = []
  clearRepairState()
  running.value = true
  showProgress.value = false
  window.clearTimeout(progressTimer)
  progressTimer = window.setTimeout(() => { showProgress.value = true }, 300)
  const pending = workerClient.request(request, { supersede: 'json-workbench' })
  activeRequest = pending
  try {
    const result = await pending.promise
    if (activeRequest !== pending) return null
    consumeResult(result)
    mobilePane.value = 'result'
    return result
  } catch (error) {
    if (activeRequest === pending && !(error instanceof WorkerRequestCancelledError)) {
      errorMessage.value = error instanceof Error ? error.message : 'JSON 操作失败。'
    }
    return null
  } finally {
    if (activeRequest === pending) {
      activeRequest = null
      running.value = false
      showProgress.value = false
      window.clearTimeout(progressTimer)
    }
  }
}

function consumeResult(result: JsonWorkerResult) {
  if (result.operation === 'format' || result.operation === 'schema-generate' || result.operation === 'type-generate') {
    output.value = result.output
    if (result.operation === 'type-generate') {
      summary.value = '已在浏览器本地生成类型骨架；结果未编译、未运行、未保存。'
    }
    return
  }
  if (result.operation === 'jsonpath') {
    summary.value = `共 ${result.matches.length} 个匹配`
    output.value = result.matches.map((match) => `${match.path}\n${match.value}`).join('\n\n')
    return
  }
  if (result.operation === 'diff') {
    summary.value = result.summary
    output.value = result.differences.map((item) => `${item.kind.toUpperCase()} ${item.path}\n- ${item.before ?? ''}\n+ ${item.after ?? ''}`).join('\n\n')
    return
  }
  if (result.operation === 'schema-validate') {
    summary.value = result.status === 'valid'
      ? '实例符合 Schema'
      : result.status === 'invalid'
        ? '实例不符合 Schema'
        : '未执行：数值精度保护'
    issues.value = result.status === 'not_run_precision_guard'
      ? ['实例包含无法安全映射到 JavaScript number 的数值；Schema 本身有效，但整份实例校验未执行。']
      : result.issues.map((issue) => issue.message)
    output.value = `${summary.value}${issues.value.length ? `\n\n${issues.value.join('\n')}` : ''}`
    return
  }
}

function invalidateStaleResults() {
  cancelLocalRequest()
  output.value = ''
  summary.value = ''
  issues.value = []
  errorMessage.value = ''
  aiFailed.value = false
}

function clearRepairState() {
  repairCandidate.value = ''
  repairDiff.value = ''
  repairSource = ''
}

async function proposeRepair() {
  const source = input.value
  const result = await execute({ operation: 'repair', text: source })
  if (result?.operation !== 'repair') return
  if (input.value !== source) {
    clearRepairState()
    summary.value = '输入已修改，本次修复候选已丢弃。'
    mobilePane.value = 'input'
    return
  }
  repairCandidate.value = result.candidate
  repairDiff.value = result.diff
  repairSource = source
  summary.value = result.changed ? '已生成受限修复候选，确认前未修改输入。' : '输入已经是严格 JSON。'
}

function applyRepair() {
  const candidate = repairCandidate.value
  if (!candidate) return
  if (repairSource !== input.value) {
    clearRepairState()
    summary.value = '修复候选已失效，未应用到输入。'
    return
  }
  clearRepairState()
  invalidateStaleResults()
  input.value = candidate
  summary.value = '修复候选已应用到输入。'
}

async function generateSchema() {
  const result = await execute({ operation: 'schema-generate', text: input.value })
  if (result?.operation === 'schema-generate') {
    schemaText.value = result.output
    resultEditor?.setValue(schemaText.value)
    mobilePane.value = 'result'
  }
}

function clearAll() {
  cancelLocalRequest()
  cancelAIRequest()
  closeAIConfirmation()
  input.value = ''
  output.value = ''
  summary.value = ''
  issues.value = []
  errorMessage.value = ''
  clearRepairState()
  aiFailed.value = false
}

function cancelRunning() {
  cancelLocalRequest()
  cancelAIRequest()
}

function cancelLocalRequest() {
  const pending = activeRequest
  if (!pending) return
  activeRequest = null
  pending.cancel()
  running.value = false
  showProgress.value = false
  window.clearTimeout(progressTimer)
}

async function selectGenerationSource(source: 'local' | 'ai') {
  if (source === 'local') {
    if (generationSource.value !== 'local') invalidateStaleResults()
    cancelAIRequest()
    closeAIConfirmation()
    generationSource.value = 'local'
    aiFailed.value = false
    return
  }
  if (aiUnavailable.value) return
  if (generationSource.value !== 'ai') invalidateStaleResults()
  generationSource.value = 'ai'
  await loadAIOptions()
}

async function loadAIOptions() {
  if (aiOptionsLoaded.value || aiOptionsLoading.value) return
  aiOptionsLoading.value = true
  errorMessage.value = ''
  try {
    const response = await apiRequest<{ items: AIProvider[] }>('/api/v1/ai/providers')
    aiProviders.value = response.items
    aiOptionsLoaded.value = true
    const firstProvider = availableAIProviders.value[0]
    if (!firstProvider) {
      aiUnavailable.value = true
      generationSource.value = 'local'
      errorMessage.value = '没有已启用且配置完整的 AI Provider/模型；本地四语言生成仍可使用。'
      return
    }
    aiProviderId.value = firstProvider.id
    aiModelId.value = firstProvider.models[0]?.id ?? ''
  } catch (error) {
    generationSource.value = 'local'
    errorMessage.value = error instanceof Error ? error.message : '无法读取 AI Provider；本地生成不受影响。'
  } finally {
    aiOptionsLoading.value = false
  }
}

async function prepareAIConfirmation(trigger: HTMLElement | null) {
  const provider = selectedAIProvider.value
  const model = selectedAIModel.value
  if (!provider || !model) return
  errorMessage.value = ''
  aiFailed.value = false
  try {
    const draft = buildJsonAIRequestDraft({
      providerId: provider.id,
      modelId: model.id,
      targetLanguage: aiTargetLanguage.value,
      mode: aiSendMode.value,
      source: input.value,
    })
    confirmationPreviousFocus = trigger
    fullSendAcknowledged.value = false
    aiConfirmation.value = {
      ...draft,
      providerLabel: provider.displayName,
      modelLabel: `${model.displayName} · ${model.modelId}`,
      targetLanguage: aiTargetLanguage.value,
      sourceSnapshot: input.value,
      providerId: provider.id,
      modelId: model.id,
    }
    await nextTick()
    confirmationDialog.value?.querySelector<HTMLElement>('footer button:first-of-type')?.focus()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法准备 AI 发送内容。'
  }
}

async function confirmAIRequest() {
  const confirmation = aiConfirmation.value
  if (!confirmation || confirmation.mode === 'full' && !fullSendAcknowledged.value) return
  closeAIConfirmation()
  aiAbortController?.abort()
  const controller = new AbortController()
  aiAbortController = controller
  aiRunning.value = true
  aiFailed.value = false
  errorMessage.value = ''
  summary.value = '正在等待所选 AI Provider 返回普通代码文本…'
  try {
    const result = await apiRequest<JsonAIResponse>('/api/v1/tools/json/type-generation/ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': auth.csrfToken,
      },
      body: confirmation.body,
      signal: controller.signal,
    })
    if (!aiConfirmationStillCurrent(confirmation)) {
      summary.value = '输入或选项已修改，本次 AI 返回结果已丢弃；请重新确认发送。'
      return
    }
    output.value = result.code
    summary.value = 'AI 已返回普通代码文本；结果未执行、未编译、未保存，也未创建 Artifact。'
    mobilePane.value = 'result'
  } catch (error) {
    if (controller.signal.aborted) {
      summary.value = '已取消本次 AI 请求；输入仍保留在当前页面。'
      return
    }
    if (!aiConfirmationStillCurrent(confirmation)) {
      summary.value = '输入或选项已修改，本次 AI 请求反馈已丢弃；请重新确认发送。'
      return
    }
    aiFailed.value = true
    errorMessage.value = describeAIError(error)
  } finally {
    if (aiAbortController === controller) aiAbortController = null
    aiRunning.value = false
  }
}

function cancelAIRequest() {
  aiAbortController?.abort()
}

function closeAIConfirmation(restoreFocus = true) {
  if (!aiConfirmation.value) return
  const returnTarget = confirmationPreviousFocus
  aiConfirmation.value = null
  fullSendAcknowledged.value = false
  if (restoreFocus) {
    void nextTick(() => returnTarget?.focus())
  }
  confirmationPreviousFocus = null
}

function handleConfirmationKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeAIConfirmation()
    return
  }
  if (event.key !== 'Tab' || !confirmationDialog.value) return
  const focusable = [...confirmationDialog.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]',
  )]
  if (focusable.length === 0) return
  const first = focusable[0]!
  const last = focusable.at(-1)!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function aiConfirmationStillCurrent(confirmation: AIConfirmation): boolean {
  return activeTab.value === 'types' &&
    generationSource.value === 'ai' &&
    input.value === confirmation.sourceSnapshot &&
    aiProviderId.value === confirmation.providerId &&
    aiModelId.value === confirmation.modelId &&
    aiTargetLanguage.value === confirmation.targetLanguage &&
    aiSendMode.value === confirmation.mode
}

function describeAIError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'AI 类型生成失败。'
  if (error.code === 'AI_MODEL_UNAVAILABLE') return '所选模型已不可用；请选择其他模型或返回本地生成。'
  if (error.code === 'AI_CONTEXT_TOO_LARGE') return '当前模型容量不足；请选择更大模型、结构模式或返回本地生成。'
  if (error.code === 'MUTATION_NOT_ALLOWED') return '当前会话不能发送该请求，请刷新登录状态后重试。'
  if (error.code === 'UPSTREAM_THROTTLED') return 'Provider 当前限流；不会自动重试或切换模型。'
  return `${error.message}（${error.code}）`
}
</script>

<template>
  <section class="workbench">
    <ToolPageHeader
      title="JSON 工作台"
      description="格式化、查询、对比、Schema 与确定性类型生成；AI 只在显式选择并确认后发送。"
      limit="单个编辑面最多 5 MiB；本地操作内容只存在于当前页面内存。"
      processing="optional-ai"
    >
      <template #actions><UiButton variant="ghost" @click="clearAll">清空</UiButton></template>
    </ToolPageHeader>

    <nav class="tabs" aria-label="JSON 操作">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >{{ tab.label }}</button>
    </nav>

    <div class="mobile-switch" aria-label="编辑面">
      <button type="button" :class="{ active: mobilePane === 'input' }" @click="mobilePane = 'input'">输入</button>
      <button type="button" :class="{ active: mobilePane === 'result' }" @click="mobilePane = 'result'">结果</button>
    </div>

    <div
      id="json-actions"
      class="controls"
      :class="{ 'controls--types': activeTab === 'types', 'controls--ai': activeTab === 'types' && generationSource === 'ai' }"
    >
      <template v-if="activeTab === 'format'">
        <label>输出模式
          <select v-model="formatMode"><option value="pretty">格式化</option><option value="compact">压缩</option></select>
        </label>
        <UiButton variant="secondary" :disabled="running" @click="proposeRepair">检查受限修复</UiButton>
      </template>
      <label v-else-if="activeTab === 'jsonpath'" class="grow">JSONPath 表达式
        <input v-model="jsonPath" spellcheck="false" />
        <span>支持根、属性/索引、通配、递归、切片和并集；不执行脚本过滤。</span>
      </label>
      <template v-else-if="activeTab === 'diff'">
        <label>对比模式
          <select v-model="diffMode"><option value="structure">结构</option><option value="text">文本</option></select>
        </label>
        <label>数组身份字段（可选）<input v-model="identityField" placeholder="不默认猜测 id" /></label>
      </template>
      <template v-else-if="activeTab === 'schema'">
        <UiButton variant="secondary" :disabled="running" @click="generateSchema">从样本生成初始 Schema</UiButton>
        <span class="hint">仅 Draft 2020-12；只允许当前文档内 $ref/$dynamicRef；format 为注解，不检查邮箱等格式。</span>
      </template>
      <template v-else>
        <fieldset class="source-switch">
          <legend>生成方式</legend>
          <div>
            <button type="button" :class="{ active: generationSource === 'local' }" @click="selectGenerationSource('local')">本地确定性</button>
            <button type="button" :class="{ active: generationSource === 'ai' }" :disabled="aiUnavailable" @click="selectGenerationSource('ai')">使用 AI</button>
          </div>
        </fieldset>
        <label v-if="generationSource === 'local'">本地语言
          <select v-model="language">
            <option value="typescript">TypeScript</option><option value="java">Java</option>
            <option value="go">Go</option><option value="kotlin">Kotlin</option>
          </select>
          <span>类型骨架，请按项目序列化框架调整。</span>
        </label>
        <template v-else>
          <label>Provider
            <select v-model="aiProviderId" :disabled="aiOptionsLoading">
              <option v-for="provider in availableAIProviders" :key="provider.id" :value="provider.id">{{ provider.displayName }}</option>
            </select>
          </label>
          <label>模型
            <select v-model="aiModelId" :disabled="aiOptionsLoading">
              <option v-for="model in availableAIModels" :key="model.id" :value="model.id">{{ model.displayName }} · {{ model.modelId }}</option>
            </select>
          </label>
          <label>目标语言
            <input v-model="aiTargetLanguage" maxlength="50" autocomplete="off" />
          </label>
          <label>发送模式
            <select v-model="aiSendMode">
              <option value="structure">结构模式（默认，不含字段值）</option>
              <option value="full">发送完整 JSON（二次确认）</option>
            </select>
          </label>
          <span class="ai-scope">只发送当前 JSON 的确认快照；不发送历史、附件或知识条目。</span>
        </template>
      </template>
      <UiButton
        :variant="running ? 'danger' : 'primary'"
        :disabled="!running && primaryDisabled"
        :aria-disabled="aiRunning ? 'true' : undefined"
        @click="running ? cancelRunning() : runPrimary($event)"
      >{{ running ? '取消' : actionLabel }}</UiButton>
      <UiButton v-if="aiRunning" variant="secondary" @click="cancelRunning">取消</UiButton>
    </div>

    <div id="json-feedback" tabindex="-1">
      <p v-if="showProgress" class="progress" role="status">正在浏览器 Worker 中处理…</p>
      <p v-else-if="aiRunning" class="progress" role="status">已按确认内容发送，正在等待所选 Provider；可取消当前 HTTP 请求。</p>
      <div v-if="editorFailed" class="message message--error" role="alert">
        <span>{{ editorLoadFailedMessage }}</span>
        <UiButton variant="secondary" @click="retryEditorLoad">重试加载编辑器</UiButton>
      </div>
      <div v-if="errorMessage" id="json-errors" class="message message--error" role="alert">
        <span>{{ errorMessage }}</span>
        <UiButton v-if="aiFailed" variant="secondary" @click="selectGenerationSource('local')">返回本地生成</UiButton>
      </div>
      <div v-else-if="summary" class="message" role="status">{{ summary }}</div>
      <ul v-if="issues.length" class="issues" aria-label="错误列表"><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul>
    </div>
    <div v-if="repairDiff" class="repair">
      <div><strong>修复差异</strong><UiButton variant="secondary" @click="applyRepair">应用修复</UiButton></div>
      <pre>{{ repairDiff }}</pre>
    </div>

    <div ref="editorsRoot" class="editors" :style="editorGridStyle">
      <section class="editor-pane" :class="{ 'mobile-hidden': mobilePane !== 'input' }">
        <div class="pane-heading"><span>JSON 输入</span><nav class="editor-shortcuts" aria-label="JSON 输入编辑器快捷跳转"><a href="#json-actions">跳到操作区</a><a href="#json-feedback">跳到错误列表</a></nav></div>
        <div id="json-input-host" ref="inputHost" class="editor-host" />
        <nav class="editor-shortcuts editor-shortcuts--after" aria-label="JSON 输入编辑器后快捷跳转"><a href="#json-actions">跳到操作区</a><a href="#json-feedback">跳到错误列表</a></nav>
      </section>
      <button
        class="editor-divider"
        type="button"
        role="separator"
        aria-label="调整输入与结果区域宽度"
        aria-orientation="vertical"
        aria-valuemin="30"
        aria-valuemax="70"
        :aria-valuenow="editorSplit"
        @pointerdown="startEditorResize"
        @keydown="adjustEditorSplit"
      ><span /></button>
      <section class="editor-pane" :class="{ 'mobile-hidden': mobilePane !== 'result' }">
        <div class="pane-heading">
          <span>{{ activeTab === 'diff' ? 'JSON 输入 B' : activeTab === 'schema' ? 'JSON Schema' : '结果' }}</span>
          <div class="pane-actions">
            <CopyButton v-if="activeTab !== 'diff' && activeTab !== 'schema'" :text="output" />
            <nav class="editor-shortcuts" aria-label="JSON 结果编辑器快捷跳转"><a href="#json-actions">跳到操作区</a><a href="#json-feedback">跳到错误列表</a></nav>
          </div>
        </div>
        <div id="json-result-host" ref="resultHost" class="editor-host" />
        <nav class="editor-shortcuts editor-shortcuts--after" aria-label="JSON 结果编辑器后快捷跳转"><a href="#json-actions">跳到操作区</a><a href="#json-feedback">跳到错误列表</a></nav>
        <pre v-if="(activeTab === 'diff' || activeTab === 'schema') && output" class="inline-result">{{ output }}</pre>
      </section>
    </div>

    <div v-if="aiConfirmation" class="confirmation-backdrop" @mousedown.self="closeAIConfirmation()">
      <section
        ref="confirmationDialog"
        class="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="json-ai-confirm-title"
        @keydown="handleConfirmationKeydown"
      >
        <header>
          <p>EXPLICIT SEND CONFIRMATION</p>
          <h2 id="json-ai-confirm-title">确认发送范围</h2>
          <span>只有点击“确认发送并生成”才会调用窄 JSON AI 接口。</span>
        </header>
        <dl>
          <div><dt>实际接收方</dt><dd>{{ aiConfirmation.providerLabel }} · {{ aiConfirmation.modelLabel }}</dd></div>
          <div><dt>目标语言</dt><dd>{{ aiConfirmation.targetLanguage }}</dd></div>
          <div><dt>发送模式</dt><dd>{{ aiConfirmation.mode === 'structure' ? '结构模式：字段名、容器关系和原始类型，不含值' : '完整 JSON：包含下方逐字内容' }}</dd></div>
          <div><dt>UTF-8 大小</dt><dd>input {{ aiConfirmation.inputBytes }} 字节 · 完整请求 {{ aiConfirmation.requestBytes }} / 262144 字节</dd></div>
        </dl>
        <label class="confirmation-preview-label" for="json-ai-preview">将作为 input 发送的准确内容</label>
        <pre id="json-ai-preview" data-testid="json-ai-preview">{{ aiConfirmation.inputPreview }}</pre>
        <label v-if="aiConfirmation.mode === 'full'" class="full-acknowledgement">
          <input v-model="fullSendAcknowledged" type="checkbox" />
          我已逐字检查以上完整 JSON，并确认将其发送给所选 Provider。
        </label>
        <footer>
          <UiButton variant="secondary" @click="closeAIConfirmation()">取消，不发送</UiButton>
          <UiButton
            variant="primary"
            :disabled="aiConfirmation.mode === 'full' && !fullSendAcknowledged"
            @click="confirmAIRequest"
          >确认发送并生成</UiButton>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.workbench { display: flex; min-width: 0; min-height: 100%; flex-direction: column; background: var(--bg-app); }
.tabs { display: flex; gap: var(--space-1); padding: 0 var(--page-gutter); overflow-x: auto; border-bottom: 1px solid var(--border-subtle); }
.tabs button, .mobile-switch button { min-height: 44px; padding: 0 var(--space-3); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-secondary); cursor: pointer; white-space: nowrap; }
.tabs button.active, .mobile-switch button.active { border-color: var(--accent); color: var(--text-primary); }
.controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3); padding: var(--space-4) var(--page-gutter); border-bottom: 1px solid var(--border-subtle); background: var(--bg-surface); }
.controls label { display: grid; min-width: min(100%, 180px); flex: 1 1 200px; gap: var(--space-1); color: var(--text-secondary); font-size: 12px; }
.controls label.grow { flex: 1; }
.controls input, .controls select { min-height: 40px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-app); color: var(--text-primary); }
.controls .button[aria-disabled='true'] { cursor: not-allowed; opacity: .45; }
.controls span, .hint { color: var(--text-muted); font-size: 12px; }
.source-switch { display: grid; gap: var(--space-1); margin: 0; padding: 0; border: 0; color: var(--text-secondary); font-size: 12px; }
.source-switch > div { display: grid; grid-template-columns: 1fr 1fr; min-height: 40px; padding: 3px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-app); }
.source-switch button { padding: 0 var(--space-3); border: 0; border-radius: calc(var(--radius-control) - 3px); background: transparent; color: var(--text-secondary); cursor: pointer; }
.source-switch button.active { background: var(--accent-soft); color: var(--accent); font-weight: 700; }
.source-switch button:disabled { cursor: not-allowed; opacity: .5; }
.ai-scope { max-width: 220px; align-self: center; }
.message, .progress, .issues { margin: var(--space-3) var(--page-gutter) 0; padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-surface); }
.message { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.message--error { border-color: color-mix(in srgb, var(--danger) 50%, var(--border-subtle)); color: var(--danger); }
.issues { color: var(--danger); }
.repair { margin: var(--space-3) var(--page-gutter) 0; padding: var(--space-3); border: 1px solid var(--warning); border-radius: var(--radius-card); background: var(--bg-surface); }
.repair > div, .pane-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.repair pre, .inline-result { overflow: auto; max-height: 240px; padding: var(--space-3); background: var(--bg-code); font-family: var(--font-mono); white-space: pre; }
.editors { display: grid; min-height: max(520px, calc(100dvh - var(--global-header-height) - 330px)); flex: 1; margin: var(--space-4) var(--page-gutter) var(--space-8); overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--border-subtle); }
.editor-pane { display: flex; min-width: 0; min-height: 0; flex-direction: column; padding: var(--space-3); background: var(--bg-surface); }
.pane-heading { min-height: 40px; color: var(--text-secondary); font-weight: 600; }
.pane-actions, .editor-shortcuts { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-3); }
.editor-shortcuts { font-size: 12px; font-weight: 500; }
.editor-shortcuts a { color: var(--text-muted); }
.editor-shortcuts--after { min-height: 32px; align-items: center; padding-top: var(--space-2); }
.editor-host { min-height: 0; flex: 1; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.editor-divider { position: relative; width: 8px; min-height: 100%; padding: 0; border: 0; background: var(--border-subtle); cursor: col-resize; touch-action: none; }
.editor-divider span { position: absolute; top: 50%; left: 50%; width: 2px; height: 48px; transform: translate(-50%, -50%); border-radius: 2px; background: var(--text-muted); opacity: .55; }
.editor-divider:hover, .editor-divider:focus-visible { background: var(--accent-soft); }
.editor-divider:hover span, .editor-divider:focus-visible span { background: var(--accent); opacity: 1; }
.mobile-switch { display: none; }
.confirmation-backdrop { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: var(--space-5); background: rgb(15 23 42 / 62%); }
.confirmation-dialog { width: min(760px, 100%); max-height: min(820px, calc(100vh - 40px)); overflow: auto; border: 1px solid var(--border-strong); border-radius: var(--radius-card); background: var(--bg-surface); box-shadow: var(--shadow-overlay); }
.confirmation-dialog header, .confirmation-dialog dl, .confirmation-dialog > label, .confirmation-dialog > pre, .confirmation-dialog footer { margin-right: var(--space-6); margin-left: var(--space-6); }
.confirmation-dialog header { padding-top: var(--space-6); }
.confirmation-dialog header p { margin: 0 0 var(--space-1); color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .12em; }
.confirmation-dialog header h2 { margin: 0; color: var(--text-primary); font-size: 22px; }
.confirmation-dialog header span { display: block; margin-top: var(--space-2); color: var(--text-secondary); }
.confirmation-dialog dl { display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
.confirmation-dialog dl > div { display: grid; grid-template-columns: 108px 1fr; gap: var(--space-3); }
.confirmation-dialog dt { color: var(--text-muted); }
.confirmation-dialog dd { margin: 0; overflow-wrap: anywhere; color: var(--text-primary); }
.confirmation-preview-label { display: block; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.confirmation-dialog > pre { max-height: 300px; overflow: auto; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); font-family: var(--font-mono); font-size: 12px; white-space: pre; }
.full-acknowledgement { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--warning); border-radius: var(--radius-control); color: var(--text-primary); }
.full-acknowledgement input { width: 18px; height: 18px; margin: 1px 0 0; flex: 0 0 auto; }
.confirmation-dialog footer { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-5) 0 var(--space-6); }
@media (min-width: 768px) {
  .controls--types .source-switch { min-width: 176px; flex: 0 0 176px; }
  .controls--types > label { min-width: 160px; flex: 1 1 180px; }
  .controls--types > .button { flex: 0 0 auto; white-space: nowrap; }
  .controls--ai .ai-scope { max-width: none; flex: 1 1 360px; }
}
@media (max-width: 899px) {
  .tabs { padding: 0 var(--space-4); }
  .mobile-switch { display: grid; grid-template-columns: 1fr 1fr; margin: var(--space-3) var(--space-4) 0; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
  .controls { align-items: stretch; flex-direction: column; padding: var(--space-4); }
  .controls label { width: 100%; min-width: 0; flex: 0 0 auto; }
  .source-switch { width: 100%; }
  .ai-scope { max-width: none; }
  .message, .progress, .issues, .repair { margin-right: var(--space-4); margin-left: var(--space-4); }
  .editors { display: block; min-height: 0; margin: var(--space-4); overflow: visible; }
  .editor-divider { display: none; }
  .editor-pane.mobile-hidden { display: none; }
  .editor-host { min-height: clamp(420px, 58dvh, 760px); }
  .confirmation-backdrop { align-items: end; padding: 0; }
  .confirmation-dialog { max-height: 92vh; border-radius: var(--radius-card) var(--radius-card) 0 0; }
  .confirmation-dialog header, .confirmation-dialog dl, .confirmation-dialog > label, .confirmation-dialog > pre, .confirmation-dialog footer { margin-right: var(--space-4); margin-left: var(--space-4); }
  .confirmation-dialog dl > div { grid-template-columns: 1fr; gap: 2px; }
  .confirmation-dialog footer { flex-direction: column-reverse; }
}
</style>

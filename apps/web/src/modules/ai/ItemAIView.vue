<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
import type { AttachmentEntry, Sensitivity } from '../knowledge/library'
import ArtifactBlocks from './ArtifactBlocks.vue'
import {
  type AISettings,
  type AITask,
  type ArtifactDetail,
  type ArtifactSummary,
  type ProviderEntry,
  type SensitivePolicy,
  type TaskType,
  artifactTypeLabels,
  availableModels,
  formatDateTime,
  policiesWithin,
  taskStatusLabels,
  taskTypeLabels,
} from './contracts'

const props = defineProps<{
  itemId: string
  sensitivity: Sensitivity
  attachments: AttachmentEntry[]
  initialArtifacts: ArtifactSummary[]
}>()
const emit = defineEmits<{ source: [fragmentId: string]; changed: [] }>()
const auth = useAuthStore()
const providers = ref<ProviderEntry[]>([])
const settings = ref<AISettings | null>(null)
const artifacts = ref<ArtifactSummary[]>([...props.initialArtifacts])
const selectedArtifactID = ref('')
const selectedArtifact = ref<ArtifactDetail | null>(null)
const tasks = ref<AITask[]>([])
const taskType = ref<Exclude<TaskType, 'batch_organize'>>('organize_record')
const modelID = ref('')
const taskPolicy = ref<SensitivePolicy>('block')
const includeRelated = ref(false)
const loading = ref(true)
const artifactLoading = ref(false)
const artifactError = ref('')
const busy = ref(false)
const pageError = ref('')
const successMessage = ref('')
const confirmAction = ref<'activate' | 'invalidate' | null>(null)
const applyOpen = ref(false)
const applyTitle = ref(false)
const applyFolder = ref(false)
const applyTags = ref<string[]>([])
const actionDialog = ref<HTMLElement | null>(null)
const versionSelect = ref<HTMLSelectElement | null>(null)
let pollingTimer: number | undefined
let dialogTrigger: HTMLElement | null = null
// 离页标记：置位后晚到的响应直接丢弃，不再写界面状态、排轮询或补发读取；后端已提交的任务照常执行。
let unmounted = false

const allModels = computed(() => availableModels(providers.value))
const visionModels = computed(() => availableModels(providers.value, true))
const compatibleModels = computed(() =>
  taskType.value === 'analyze_image' ? visionModels.value : allModels.value,
)
const allowedPolicies = computed(() => policiesWithin(settings.value?.sensitiveAiPolicy ?? 'block'))
const canAnalyzeImage = computed(() => props.attachments.some((entry) => entry.kind === 'image'))
const hasActiveTask = computed(() => tasks.value.some((task) => task.status === 'queued' || task.status === 'running'))
const selectedSummary = computed(() =>
  artifacts.value.find((artifact) => artifact.id === selectedArtifactID.value) ?? null,
)
const selectedClassification = computed(() => selectedArtifact.value?.content.classification)
const canApply = computed(() => applyTitle.value || applyFolder.value || applyTags.value.length > 0)

watch(
  () => props.initialArtifacts,
  (next) => {
    if (!artifacts.value.length) artifacts.value = [...next]
  },
  { deep: true },
)

watch(taskType, () => chooseDefaultModel())
// busy 会禁用弹窗内当前聚焦的按钮，浏览器随之把焦点挤到 body；拉回弹窗内可聚焦处。
watch(busy, async (value) => {
  if (!value || (!applyOpen.value && !confirmAction.value)) return
  await nextTick()
  void focusDialog()
})
watch(selectedArtifactID, (id) => {
  if (confirmAction.value) closeConfirmDialog()
  if (applyOpen.value) closeApplyDialog()
  selectedArtifact.value = null
  void loadArtifact(id)
})

onMounted(() => void loadState())
onBeforeUnmount(() => {
  unmounted = true
  window.clearTimeout(pollingTimer)
  invalidateArtifactFetch()
})

async function loadState() {
  loading.value = true
  pageError.value = ''
  try {
    const [providerResponse, settingsResponse] = await Promise.all([
      apiRequest<{ items: ProviderEntry[] }>('/api/v1/ai/providers'),
      apiRequest<AISettings>('/api/v1/ai/settings'),
      loadArtifacts(),
      loadTasks(),
    ])
    providers.value = providerResponse.items
    settings.value = settingsResponse
    taskPolicy.value = settingsResponse.sensitiveAiPolicy
    chooseDefaultModel()
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    loading.value = false
  }
}

function chooseDefaultModel() {
  const defaultID =
    taskType.value === 'organize_record'
      ? settings.value?.defaultOrganizeModelId
      : taskType.value === 'review_record'
        ? settings.value?.defaultReviewModelId
        : settings.value?.defaultVisionModelId
  const options = compatibleModels.value
  if (defaultID && options.some((model) => model.id === defaultID)) modelID.value = defaultID
  else if (!options.some((model) => model.id === modelID.value)) modelID.value = options[0]?.id ?? ''
}

async function loadArtifacts(preferLatest = false) {
  const response = await apiRequest<{ items: ArtifactSummary[] }>(
    `/api/v1/items/${props.itemId}/artifacts`,
  )
  if (unmounted) return
  artifacts.value = response.items
  const current = artifacts.value.find((artifact) => artifact.id === selectedArtifactID.value)
  if (preferLatest || !current) {
    selectedArtifactID.value =
      artifacts.value.find((artifact) => artifact.active && !artifact.invalidatedAt)?.id ??
      artifacts.value[0]?.id ??
      ''
  } else if (selectedArtifactID.value) {
    await loadArtifact(selectedArtifactID.value)
  }
}

// Only the latest artifact request may write detail, error or loading state;
// switching versions, reloading the list and unmounting abort stale ones.
let artifactFetchController: AbortController | null = null

function invalidateArtifactFetch() {
  artifactFetchController?.abort()
  artifactFetchController = null
  artifactLoading.value = false
}

async function loadArtifact(id: string) {
  invalidateArtifactFetch()
  artifactError.value = ''
  if (!id) {
    selectedArtifact.value = null
    return
  }
  const controller = new AbortController()
  artifactFetchController = controller
  artifactLoading.value = true
  pageError.value = ''
  try {
    const detail = await apiRequest<ArtifactDetail>(`/api/v1/artifacts/${id}`, {
      signal: controller.signal,
    })
    if (controller.signal.aborted) return
    selectedArtifact.value = detail
  } catch (error) {
    if (controller.signal.aborted) return
    selectedArtifact.value = null
    // 详情读取失败只归版本详情区，与任务/全局错误分开，避免被顶部通知加“暂无版本”空态误导。
    artifactError.value = messageFor(error)
  } finally {
    if (!controller.signal.aborted) artifactLoading.value = false
  }
}

function reloadArtifact() {
  if (!selectedArtifactID.value || artifactLoading.value) return
  void loadArtifact(selectedArtifactID.value)
}

async function loadTasks() {
  // create/retry 的 800ms 轮询会覆盖仍在等待的 2500ms 句柄，卸载只清得走最新句柄；旧句柄触发时在此止步。
  if (unmounted) return
  window.clearTimeout(pollingTimer)
  try {
    const response = await apiRequest<{ items: AITask[] }>(
      `/api/v1/ai/tasks?itemId=${encodeURIComponent(props.itemId)}&limit=20`,
    )
    if (unmounted) return
    const hadActive = hasActiveTask.value
    tasks.value = response.items
    if (hadActive && !hasActiveTask.value) await loadArtifacts(true)
    // 嵌套读取期间重试/创建可能写入 queued 任务使 hasActiveTask 复真；离页后不再重排轮询。
    if (unmounted) return
    if (hasActiveTask.value) pollingTimer = window.setTimeout(() => void loadTasks(), 2500)
  } catch (error) {
    pageError.value = messageFor(error)
  }
}

async function createTask() {
  if (!modelID.value || busy.value) return
  if (taskType.value === 'analyze_image' && !canAnalyzeImage.value) return
  busy.value = true
  pageError.value = ''
  successMessage.value = ''
  try {
    const task = await apiRequest<AITask>(
      '/api/v1/ai/tasks',
      jsonRequest(
        'POST',
        {
          taskType: taskType.value,
          itemId: props.itemId,
          modelId: modelID.value,
          sensitivePolicy: taskPolicy.value,
          options: { includeRelatedRecords: taskType.value === 'organize_record' && includeRelated.value },
        },
        auth.csrfToken,
      ),
    )
    if (unmounted) return
    tasks.value = [task, ...tasks.value.filter((entry) => entry.id !== task.id)]
    successMessage.value = '任务已进入队列；原始记录与现有 AI 版本不会被覆盖。'
    pollingTimer = window.setTimeout(() => void loadTasks(), 800)
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

async function cancelTask(task: AITask) {
  busy.value = true
  pageError.value = ''
  try {
    await apiRequest(
      `/api/v1/ai/tasks/${task.id}/cancel`,
      jsonRequest('POST', {}, auth.csrfToken),
    )
    if (unmounted) return
    await loadTasks()
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

async function retryTask(task: AITask) {
  busy.value = true
  pageError.value = ''
  try {
    const retry = await apiRequest<AITask>(
      `/api/v1/ai/tasks/${task.id}/retry`,
      jsonRequest('POST', {}, auth.csrfToken),
    )
    if (unmounted) return
    tasks.value = [retry, ...tasks.value]
    pollingTimer = window.setTimeout(() => void loadTasks(), 800)
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function openApply(event: Event) {
  if (!selectedArtifact.value) return
  applyTitle.value = false
  applyFolder.value = false
  applyTags.value = []
  rememberDialogTrigger(event)
  applyOpen.value = true
  void focusDialog()
}

function requestAction(action: 'activate' | 'invalidate', event: Event) {
  rememberDialogTrigger(event)
  confirmAction.value = action
  void focusDialog()
}

function rememberDialogTrigger(event: Event) {
  dialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
}

// busy 守卫只放在模板里的用户 dismiss 入口（backdrop、header X）；版本切换清理复用这两个函数，不加 busy 早退。
function closeApplyDialog() {
  if (!applyOpen.value) return
  applyOpen.value = false
  returnFocusToTrigger()
}

function closeConfirmDialog() {
  if (!confirmAction.value) return
  confirmAction.value = null
  returnFocusToTrigger()
}

async function returnFocusToTrigger() {
  const trigger = dialogTrigger
  dialogTrigger = null
  await nextTick()
  if (trigger?.isConnected) {
    trigger.focus()
    return
  }
  // 触发器已随旧版本详情移除（版本切换）时，焦点只回到仍在组件中的版本选择器。
  if (versionSelect.value?.isConnected) versionSelect.value.focus()
}

async function focusDialog() {
  await nextTick()
  const dialog = actionDialog.value
  if (!dialog) return
  const target = dialog.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')
  if (target) target.focus()
  else dialog.focus()
}

// Escape 只撤销未提交的确认：busy 时 POST 已发出，关闭也不代表撤回。
function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !busy.value) {
    event.preventDefault()
    if (applyOpen.value) closeApplyDialog()
    else closeConfirmDialog()
    return
  }
  if (event.key !== 'Tab') return
  const dialog = event.currentTarget as HTMLElement
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  )
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) {
    // busy 期间按钮全部禁用时没有可环绕项，Tab 必须留在弹窗容器上。
    event.preventDefault()
    dialog.focus()
    return
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function confirmArtifactAction() {
  if (!selectedArtifact.value || !confirmAction.value) return
  const action = confirmAction.value
  busy.value = true
  pageError.value = ''
  try {
    await apiRequest(
      `/api/v1/artifacts/${selectedArtifact.value.id}/${action}`,
      jsonRequest('POST', {}, auth.csrfToken),
    )
    if (unmounted) return
    confirmAction.value = null
    successMessage.value = action === 'activate' ? '当前派生视图已切换，原始记录未改变。' : '该版本已作废；系统没有自动回退到旧版本。'
    await loadArtifacts()
    emit('changed')
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

async function applySuggestions() {
  if (!selectedArtifact.value || !canApply.value) return
  busy.value = true
  pageError.value = ''
  try {
    await apiRequest(
      `/api/v1/artifacts/${selectedArtifact.value.id}/apply-suggestions`,
      jsonRequest(
        'POST',
        { title: applyTitle.value, folder: applyFolder.value, tags: applyTags.value },
        auth.csrfToken,
      ),
    )
    applyOpen.value = false
    successMessage.value = '所选建议已写入人工元数据；原始记录、附件和 Artifact 均未改变。'
    emit('changed')
  } catch (error) {
    pageError.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function prepareRegeneration() {
  const artifactType = selectedArtifact.value?.artifactType
  taskType.value =
    artifactType === 'correctness_review'
      ? 'review_record'
      : artifactType === 'image_analysis'
        ? 'analyze_image'
        : 'organize_record'
  chooseDefaultModel()
  successMessage.value = '已按当前版本类型准备新任务；确认模型与敏感策略后开始。新结果会创建新版本。'
}

function taskPhase(task: AITask) {
  if (task.cancelRequested && task.status === 'running') return '已请求取消，正在等待下一个安全边界'
  return task.events?.at(-1)?.summary || taskStatusLabels[task.status]
}

function generatorLabel(artifact: ArtifactSummary) {
  return artifact.generator === 'external_agent' ? '外部 Agent' : artifact.modelName || '内置 Worker'
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : '请求未成功，请稍后重试'
}
</script>

<template>
  <section class="item-ai" aria-labelledby="item-ai-title">
    <header class="item-ai__header">
      <div><p>AI TASKS · DERIVED ONLY</p><h2 id="item-ai-title">AI 版本与任务</h2><span>模型结果始终是派生版本，不会覆盖原始记录或附件。</span></div>
      <RouterLink :to="{ name: 'task-center', query: { itemId } }"><UiIcon name="sparkles" /> 打开任务中心</RouterLink>
    </header>

    <p v-if="pageError" class="ai-notice ai-notice--error" role="alert"><UiIcon name="triangle-alert" />{{ pageError }}</p>
    <p v-if="successMessage" class="ai-notice" role="status"><UiIcon name="check" />{{ successMessage }}</p>

    <section class="task-launcher" aria-labelledby="task-launch-title">
      <header><div><p>NEW TASK</p><h3 id="task-launch-title">生成新候选版本</h3></div><span v-if="hasActiveTask" class="live-dot">有任务运行中</span></header>
      <div v-if="loading" class="ai-loading"><span class="ai-spinner" />正在读取任务配置…</div>
      <div v-else class="task-form">
        <label><span>任务</span><select v-model="taskType"><option value="organize_record">记录整理</option><option value="review_record">正确性审阅</option><option value="analyze_image" :disabled="!canAnalyzeImage">图片分析{{ canAnalyzeImage ? '' : '（无图片）' }}</option></select></label>
        <label><span>模型</span><select v-model="modelID"><option value="">选择可用模型</option><option v-for="model in compatibleModels" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
        <label><span>敏感策略</span><select v-model="taskPolicy"><option v-for="policy in allowedPolicies" :key="policy" :value="policy">{{ policy === 'block' ? '阻止外发' : policy === 'redact' ? '遮挡后外发' : '允许原文外发' }}</option></select></label>
        <label v-if="taskType === 'organize_record'" class="related-check"><input v-model="includeRelated" type="checkbox" />允许读取至多 10 条相关记录</label>
        <p v-if="sensitivity !== 'normal'" class="sensitive-note"><UiIcon name="shield-alert" />当前条目为{{ sensitivity === 'sensitive' ? '敏感' : '待确认' }}；`block` 不会产生外部请求，图片在 `redact` 下也会阻止外发。</p>
        <p v-if="compatibleModels.length === 0" class="empty-model"><UiIcon name="circle-help" />没有满足任务能力和上下文限制的模型。请先配置 Provider 与模型。</p>
        <UiButton variant="primary" :disabled="busy || !modelID || (taskType === 'analyze_image' && !canAnalyzeImage)" @click="createTask"><UiIcon name="sparkles" />{{ busy ? '正在提交…' : '开始任务' }}</UiButton>
      </div>
    </section>

    <section v-if="tasks.length" class="recent-tasks" aria-labelledby="recent-tasks-title">
      <header><h3 id="recent-tasks-title">本条记录的最近任务</h3><RouterLink :to="{ name: 'task-center', query: { itemId } }">查看全部</RouterLink></header>
      <article v-for="task in tasks.slice(0, 4)" :key="task.id" class="task-row">
        <span class="task-status" :class="`task-status--${task.status}`">{{ taskStatusLabels[task.status] }}</span>
        <div><strong>{{ taskTypeLabels[task.taskType] }}</strong><p>{{ taskPhase(task) }}</p><small>{{ formatDateTime(task.queuedAt) }} · {{ task.triggerType === 'scheduled' ? '定期' : '手动' }}</small></div>
        <UiButton v-if="task.status === 'queued' || task.status === 'running'" variant="ghost" :disabled="busy || task.cancelRequested" @click="cancelTask(task)">{{ task.cancelRequested ? '取消处理中' : '取消' }}</UiButton>
        <UiButton v-else-if="task.status === 'failed' || task.status === 'cancelled'" variant="ghost" :disabled="busy" @click="retryTask(task)"><UiIcon name="rotate-ccw" />重试</UiButton>
      </article>
    </section>

    <section class="artifact-workspace" aria-labelledby="artifact-workspace-title">
      <header><div><p>VERSION HISTORY</p><h3 id="artifact-workspace-title">派生版本</h3></div><span>{{ artifacts.length }} 个版本</span></header>
      <div v-if="artifacts.length" class="artifact-toolbar">
        <label><span>查看版本</span><select v-model="selectedArtifactID" ref="versionSelect"><option v-for="artifact in artifacts" :key="artifact.id" :value="artifact.id">{{ artifactTypeLabels[artifact.artifactType] }} · v{{ artifact.versionNumber }}{{ artifact.active ? ' · 当前' : '' }}{{ artifact.invalidatedAt ? ' · 已作废' : '' }}{{ artifact.isStale ? ' · 未覆盖最新原文' : '' }}</option></select></label>
        <div v-if="selectedSummary" class="artifact-badges"><span v-if="selectedSummary.active" class="badge badge--active">当前版本</span><span v-if="selectedSummary.isStale" class="badge badge--stale">未覆盖最新原始记录</span><span v-if="selectedSummary.invalidatedAt" class="badge badge--invalid">已作废</span></div>
      </div>

      <div v-if="artifactLoading" class="ai-loading"><span class="ai-spinner" />正在读取版本内容…</div>
      <div v-else-if="selectedArtifact" class="artifact-selected">
        <aside v-if="selectedArtifact.isStale" class="stale-warning"><UiIcon name="triangle-alert" /><div><strong>此 AI 版本未覆盖最新原始记录</strong><p>它仍可查看，若未作废也可激活或应用建议；执行动作前请先核对新增原文。</p></div></aside>
        <header class="artifact-meta"><div><strong>{{ artifactTypeLabels[selectedArtifact.artifactType] }} · v{{ selectedArtifact.versionNumber }}</strong><span>{{ generatorLabel(selectedArtifact) }} · Prompt {{ selectedArtifact.promptVersion || '未记录' }} · {{ formatDateTime(selectedArtifact.createdAt) }}</span></div><div class="artifact-actions"><UiButton v-if="!selectedArtifact.active && !selectedArtifact.invalidatedAt" variant="secondary" :disabled="busy" @click="requestAction('activate', $event)">设为当前版本</UiButton><UiButton v-if="!selectedArtifact.invalidatedAt" variant="secondary" :disabled="busy" @click="openApply">应用建议</UiButton><UiButton variant="secondary" :disabled="busy" @click="prepareRegeneration"><UiIcon name="rotate-ccw" />重新生成</UiButton><UiButton v-if="!selectedArtifact.invalidatedAt" variant="danger" :disabled="busy" @click="requestAction('invalidate', $event)">作废版本</UiButton></div></header>
        <ArtifactBlocks :content="selectedArtifact.content" :attachments="attachments" @source="emit('source', $event)" />
      </div>

      <div v-else-if="artifactError" class="artifact-load-error" role="alert">
        <UiIcon name="triangle-alert" />
        <div>
          <strong>版本内容读取失败</strong>
          <p>{{ artifactError }}</p>
          <p>该版本已生成，列表未受影响；重新加载只重新读取该版本内容，不会创建新任务。</p>
        </div>
        <UiButton variant="secondary" :disabled="artifactLoading" @click="reloadArtifact"><UiIcon name="rotate-ccw" />重新加载</UiButton>
      </div>

      <div v-else class="artifact-empty"><UiIcon name="sparkles" :size="30" /><h3>暂无 AI 派生版本</h3><p>你仍可完整使用原始记录、附件和人工元数据。配置可用模型后，可从上方创建候选版本。</p></div>
    </section>
  </section>

  <Teleport to="body">
    <div v-if="confirmAction && selectedArtifact" class="ai-overlay" @click.self="!busy && closeConfirmDialog()">
      <section ref="actionDialog" class="ai-dialog" role="alertdialog" aria-modal="true" aria-labelledby="artifact-action-title" tabindex="-1" @keydown="onDialogKeydown">
        <UiIcon :name="confirmAction === 'invalidate' ? 'triangle-alert' : 'sparkles'" :size="26" />
        <h2 id="artifact-action-title">{{ confirmAction === 'activate' ? '设为当前派生版本？' : '作废这个版本？' }}</h2>
        <p v-if="selectedArtifact.isStale" class="dialog-warning">此 AI 版本未覆盖最新原始记录。继续前请确认你已核对新增原文。</p>
        <p>{{ confirmAction === 'activate' ? '只会切换参与普通搜索和默认展示的派生版本；不会覆盖原文、人工标题、目录或正式标签。' : '作废后该版本只能查看，不能再次激活或应用建议；系统不会自动回退到旧版本。' }}</p>
        <div class="dialog-actions"><UiButton variant="ghost" :disabled="busy" @click="closeConfirmDialog()">取消</UiButton><UiButton :variant="confirmAction === 'invalidate' ? 'danger' : 'primary'" :disabled="busy" @click="confirmArtifactAction">{{ busy ? '正在处理…' : '确认' }}</UiButton></div>
      </section>
    </div>

    <div v-if="applyOpen && selectedArtifact && selectedClassification" class="ai-overlay" @click.self="!busy && closeApplyDialog()">
      <section ref="actionDialog" class="ai-dialog apply-dialog" role="dialog" aria-modal="true" aria-labelledby="apply-suggestions-title" tabindex="-1" @keydown="onDialogKeydown">
        <header><div><p>SELECTIVE APPLY</p><h2 id="apply-suggestions-title">选择要应用的建议</h2></div><button type="button" aria-label="关闭" :disabled="busy" @click="closeApplyDialog()"><UiIcon name="x" /></button></header>
        <p v-if="selectedArtifact.isStale" class="dialog-warning">此 AI 版本未覆盖最新原始记录。应用前请核对建议是否仍适用。</p>
        <p>只修改你勾选的人工元数据；原始记录、附件、敏感状态与该 Artifact 不会改变。</p>
        <label class="suggestion"><input v-model="applyTitle" type="checkbox" /><span><strong>标题</strong><small>{{ selectedArtifact.content.title }}</small></span></label>
        <label class="suggestion"><input v-model="applyFolder" type="checkbox" /><span><strong>目录</strong><small>{{ selectedClassification.suggestedFolderPath.join(' / ') || '收件箱' }}</small></span></label>
        <fieldset><legend>标签（只会应用所选建议）</legend><label v-for="tag in selectedClassification.suggestedTags" :key="tag" class="tag-suggestion"><input v-model="applyTags" type="checkbox" :value="tag" />{{ tag }}</label><p v-if="!selectedClassification.suggestedTags.length">这个版本没有标签建议。</p></fieldset>
        <aside class="sensitivity-suggestion"><UiIcon name="shield-alert" /><span><strong>敏感状态建议：{{ selectedClassification.sensitivitySuggestion }}</strong>{{ selectedClassification.sensitivityReason || '未提供理由' }}。一期不会从此处自动应用敏感状态。</span></aside>
        <div class="dialog-actions"><UiButton variant="ghost" :disabled="busy" @click="closeApplyDialog()">取消</UiButton><UiButton variant="primary" :disabled="busy || !canApply" @click="applySuggestions">{{ busy ? '正在应用…' : '应用所选建议' }}</UiButton></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.item-ai { display: grid; gap: var(--space-4); padding-top: var(--space-4); }
.item-ai__header, .task-launcher > header, .recent-tasks > header, .artifact-workspace > header, .artifact-meta { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.item-ai__header p, .item-ai__header h2, .item-ai__header span, .task-launcher header p, .task-launcher header h3, .artifact-workspace header p, .artifact-workspace header h3 { margin: 0; }
.item-ai__header p, .task-launcher header p, .artifact-workspace header p, .apply-dialog header p { color: var(--text-muted); font-size: 10px; font-weight: 700; letter-spacing: .06em; }
.item-ai__header h2 { font-size: 18px; }
.item-ai__header span { color: var(--text-secondary); }
.item-ai__header > a { display: inline-flex; flex: none; align-items: center; gap: var(--space-2); text-decoration: none; }
.ai-notice { display: flex; align-items: center; gap: var(--space-2); margin: 0; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--success) 50%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--success); }
.ai-notice--error { border-color: color-mix(in srgb, var(--danger) 60%, var(--border-subtle)); color: var(--danger); }
.task-launcher, .recent-tasks, .artifact-workspace { padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); }
.live-dot { color: var(--accent); font-size: 11px; }
.live-dot::before { display: inline-block; width: 7px; height: 7px; margin-right: var(--space-1); border-radius: 50%; background: var(--accent); content: ''; animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.task-form { display: grid; grid-template-columns: repeat(3, minmax(150px, 1fr)) auto; align-items: end; gap: var(--space-3); margin-top: var(--space-3); }
.task-form > label:not(.related-check) { display: grid; gap: var(--space-1); color: var(--text-muted); font-size: 11px; }
.task-form select, .artifact-toolbar select { width: 100%; min-height: 40px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
.related-check { grid-column: 1 / -1; display: inline-flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); }
.sensitive-note, .empty-model { grid-column: 1 / -1; display: flex; align-items: center; gap: var(--space-2); margin: 0; padding: var(--space-2) var(--space-3); border-left: 3px solid var(--sensitive); background: color-mix(in srgb, var(--sensitive) 8%, transparent); color: var(--text-secondary); }
.recent-tasks { display: grid; gap: var(--space-2); }
.recent-tasks > header h3 { margin: 0; font-size: 14px; }
.task-row { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-3); border-top: 1px solid var(--border-subtle); }
.task-row p, .task-row small { margin: 0; color: var(--text-muted); }
.task-row strong { font-size: 12px; }
.task-status { display: inline-flex; min-height: 25px; align-items: center; justify-content: center; padding: 0 var(--space-2); border-radius: 999px; background: var(--bg-code); color: var(--text-secondary); font-size: 10px; }
.task-status--running, .task-status--queued { background: var(--accent-soft); color: var(--accent); }
.task-status--succeeded { color: var(--success); }
.task-status--failed { color: var(--danger); }
.artifact-workspace { display: grid; gap: var(--space-4); }
.artifact-workspace > header > span { color: var(--text-muted); }
.artifact-toolbar { display: flex; align-items: end; justify-content: space-between; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-control); background: var(--bg-code); }
.artifact-toolbar label { display: grid; min-width: min(520px, 70%); gap: var(--space-1); color: var(--text-muted); font-size: 10px; }
.artifact-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-1); }
.badge { padding: 3px var(--space-2); border-radius: 999px; background: var(--bg-elevated); color: var(--text-muted); font-size: 10px; }
.badge--active { color: var(--success); }
.badge--stale { color: var(--warning); }
.badge--invalid { color: var(--danger); }
.artifact-selected { display: grid; gap: var(--space-4); }
.artifact-load-error { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-4); border: 1px solid color-mix(in srgb, var(--danger) 60%, var(--border-subtle)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-secondary); }
.artifact-load-error > svg { color: var(--danger); }
.artifact-load-error strong { color: var(--text-primary); }
.artifact-load-error p { margin: 0; }
.stale-warning { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--warning) 60%, var(--border-subtle)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--warning) 8%, transparent); }
.stale-warning > svg { color: var(--warning); }
.stale-warning p { margin: 0; color: var(--text-secondary); }
.artifact-meta { align-items: flex-start; }
.artifact-meta > div:first-child { display: grid; }
.artifact-meta span { color: var(--text-muted); font-size: 11px; }
.artifact-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
.artifact-empty { display: grid; min-height: 260px; place-content: center; justify-items: center; color: var(--text-muted); text-align: center; }
.artifact-empty h3 { margin: var(--space-3) 0 var(--space-1); color: var(--text-primary); }
.artifact-empty p { max-width: 48ch; margin: 0; }
.ai-loading { display: flex; min-height: 80px; align-items: center; justify-content: center; gap: var(--space-2); color: var(--text-muted); }
.ai-spinner { width: 18px; height: 18px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.ai-overlay { position: fixed; z-index: var(--layer-overlay); inset: 0; display: grid; place-content: center; padding: var(--space-4); background: var(--scrim); }
.ai-dialog { width: min(500px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: var(--space-5); border: 1px solid var(--border-strong); border-radius: var(--radius-dialog); background: var(--bg-elevated); box-shadow: var(--shadow-overlay); }
.ai-dialog > h2 { margin: var(--space-3) 0 var(--space-2); }
.ai-dialog > p { color: var(--text-secondary); }
.dialog-warning { padding: var(--space-3); border-left: 3px solid var(--warning); background: color-mix(in srgb, var(--warning) 9%, transparent); color: var(--warning) !important; }
.dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4); }
.apply-dialog { width: min(620px, calc(100vw - 32px)); }
.apply-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; }
.apply-dialog header h2, .apply-dialog header p { margin: 0; }
.apply-dialog header button { display: inline-flex; width: 44px; height: 44px; align-items: center; justify-content: center; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.apply-dialog header button:disabled { cursor: not-allowed; opacity: .45; }
.suggestion { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2); margin-top: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
.suggestion span { display: grid; }
.suggestion small { color: var(--text-muted); }
.apply-dialog fieldset { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
.apply-dialog fieldset legend { color: var(--text-muted); font-size: 11px; }
.tag-suggestion { display: inline-flex; align-items: center; gap: var(--space-1); padding: var(--space-1) var(--space-2); border-radius: 999px; background: var(--bg-code); }
.sensitivity-suggestion { display: flex; gap: var(--space-2); margin-top: var(--space-3); color: var(--text-secondary); }
.sensitivity-suggestion span { display: grid; }
@media (max-width: 900px) { .task-form { grid-template-columns: 1fr 1fr; } .artifact-meta { display: grid; } .artifact-actions { justify-content: flex-start; } }
@media (max-width: 600px) { .item-ai__header { align-items: flex-start; } .task-form { grid-template-columns: 1fr; } .task-form > *, .related-check, .sensitive-note, .empty-model { grid-column: 1; } .task-row { grid-template-columns: 1fr; } .artifact-toolbar { align-items: stretch; flex-direction: column; } .artifact-toolbar label { min-width: 0; } .artifact-badges { justify-content: flex-start; } .artifact-actions > * { flex: 1 1 auto; } .artifact-load-error { grid-template-columns: 1fr; justify-items: start; } }
</style>

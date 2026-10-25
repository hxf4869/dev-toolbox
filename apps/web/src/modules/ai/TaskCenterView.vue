<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
import type { LibraryItem } from '../knowledge/library'
import {
  type AISettings,
  type AITask,
  type BatchSummary,
  type ProviderEntry,
  type SensitivePolicy,
  type TaskStatus,
  availableModels,
  formatDateTime,
  policiesWithin,
  taskStatusLabels,
  taskTypeLabels,
} from './contracts'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const tasks = ref<AITask[]>([])
const selectedTask = ref<AITask | null>(null)
const providers = ref<ProviderEntry[]>([])
const providersLoaded = ref(false)
const settings = ref<AISettings | null>(null)
const libraryItems = ref<LibraryItem[]>([])
const statusFilter = ref<'' | TaskStatus>(parseStatus(route.query.status))
const loading = ref(true)
const scopeLoading = ref(false)
const detailLoading = ref(false)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')
const batchOpen = ref(false)
const batchSelection = ref<string[]>([])
const organizeModelID = ref('')
const visionModelID = ref('')
const batchPolicy = ref<SensitivePolicy>('block')
const batchPanelEl = ref<HTMLElement | null>(null)
const online = ref(navigator.onLine)
let pollTimer: number | undefined
let disposed = false
let loadSeq = 0
let detailSeq = 0
let selectionIntent = ''
let detailInFlightId = ''

const itemFilter = computed(() =>
  typeof route.query.itemId === 'string' ? route.query.itemId : '',
)
const modelOptions = computed(() => availableModels(providers.value))
const batchModelMissing = computed(() => providersLoaded.value && !modelOptions.value.length)
const visionOptions = computed(() => availableModels(providers.value, true))
const allowedPolicies = computed(() => policiesWithin(settings.value?.sensitiveAiPolicy ?? 'block'))
const activeVisibleTasks = computed(() =>
  tasks.value.some((task) => task.status === 'queued' || task.status === 'running'),
)
const displayedTasks = computed(() =>
  statusFilter.value ? tasks.value.filter((task) => task.status === statusFilter.value) : tasks.value,
)
const itemByID = computed(() => new Map(libraryItems.value.map((item) => [item.id, item])))
const taskCounts = computed(() => {
  const counts: Record<TaskStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 }
  for (const task of tasks.value) counts[task.status] += 1
  return counts
})

watch(statusFilter, () => void loadTasks(true))
watch(
  () => route.query.status,
  (value) => {
    statusFilter.value = parseStatus(value)
  },
)
watch(itemFilter, () => {
  detailSeq += 1
  detailInFlightId = ''
  detailLoading.value = false
  tasks.value = []
  selectedTask.value = null
  errorMessage.value = ''
  notice.value = ''
  scopeLoading.value = true
  void loadTasks(true, true)
})
watch(
  () => route.query.taskId,
  (value) => {
    selectionIntent = typeof value === 'string' ? value : ''
    if (typeof value !== 'string' || !value || detailInFlightId === value) return
    if (displayedTasks.value.some((task) => task.id === value)) {
      if (selectedTask.value?.id !== value) selectedTask.value = null
      void selectTask(value, false)
      return
    }
    void recoverRouteTask(value)
  },
)

onMounted(() => {
  window.addEventListener('online', updateOnline)
  window.addEventListener('offline', updateOnline)
  void loadState()
})
onBeforeUnmount(() => {
  disposed = true
  window.clearTimeout(pollTimer)
  window.removeEventListener('online', updateOnline)
  window.removeEventListener('offline', updateOnline)
})

function updateOnline() {
  online.value = navigator.onLine
  if (online.value) void loadTasks(false, true)
}

async function loadState() {
  loading.value = true
  errorMessage.value = ''
  providersLoaded.value = false
  try {
    const [providerResponse, settingsResponse, itemResponse] = await Promise.all([
      apiRequest<{ items: ProviderEntry[] }>('/api/v1/ai/providers'),
      apiRequest<AISettings>('/api/v1/ai/settings'),
      apiRequest<{ items: LibraryItem[] }>('/api/v1/items?view=recent&sort=effective_desc&limit=100'),
    ])
    providers.value = providerResponse.items
    providersLoaded.value = true
    settings.value = settingsResponse
    libraryItems.value = itemResponse.items
    organizeModelID.value =
      settingsResponse.defaultOrganizeModelId &&
      availableModels(providerResponse.items).some((model) => model.id === settingsResponse.defaultOrganizeModelId)
        ? settingsResponse.defaultOrganizeModelId
        : availableModels(providerResponse.items)[0]?.id ?? ''
    visionModelID.value =
      settingsResponse.defaultVisionModelId &&
      availableModels(providerResponse.items, true).some((model) => model.id === settingsResponse.defaultVisionModelId)
        ? settingsResponse.defaultVisionModelId
        : ''
    batchPolicy.value = settingsResponse.sensitiveAiPolicy
    await loadTasks(true, true)
  } catch (error) {
    errorMessage.value = messageFor(error)
  } finally {
    loading.value = false
  }
}

async function loadTasks(selectFirst = false, recoverRouteIntent = false) {
  const seq = ++loadSeq
  window.clearTimeout(pollTimer)
  try {
    if (disposed || !online.value) return
    const query = new URLSearchParams({ limit: '100' })
    if (itemFilter.value) query.set('itemId', itemFilter.value)
    const response = await apiRequest<{ items: AITask[] }>(`/api/v1/ai/tasks?${query}`)
    if (disposed || seq !== loadSeq) return
    tasks.value = response.items
    const queryTaskID = typeof route.query.taskId === 'string' ? route.query.taskId : ''
    const desired =
      selectionIntent || queryTaskID || selectedTask.value?.id || (selectFirst ? displayedTasks.value[0]?.id : '')
    if (desired && displayedTasks.value.some((task) => task.id === desired)) {
      if (detailInFlightId !== desired) await selectTask(desired, false)
    } else if (recoverRouteIntent && desired) await recoverRouteTask(desired)
    else if (selectFirst && displayedTasks.value[0]) await selectTask(displayedTasks.value[0].id, false)
    else if (!displayedTasks.value.length) selectedTask.value = null
    if (disposed || seq !== loadSeq) return
    schedulePoll()
  } catch (error) {
    if (disposed || seq !== loadSeq) return
    errorMessage.value = messageFor(error)
  } finally {
    if (seq === loadSeq) scopeLoading.value = false
  }
}

function schedulePoll() {
  window.clearTimeout(pollTimer)
  if (disposed || !online.value) return
  const selected = selectedTask.value
  const selectedActive = !!selected && (selected.status === 'queued' || selected.status === 'running')
  if (!activeVisibleTasks.value && !selectedActive) return
  pollTimer = window.setTimeout(() => void loadTasks(false, true), 2500)
}

async function selectTask(id: string, updateURL = true, requireItemId = '') {
  if (disposed) return
  const seq = ++detailSeq
  selectionIntent = id
  detailInFlightId = id
  detailLoading.value = true
  errorMessage.value = ''
  try {
    const task = await apiRequest<AITask>(`/api/v1/ai/tasks/${id}`)
    if (disposed || seq !== detailSeq) return
    if (requireItemId && (task.itemId ?? '').toLowerCase() !== requireItemId.toLowerCase()) {
      errorMessage.value = '链接指向的任务不属于当前记录，清除记录筛选后可查看。'
      return
    }
    selectedTask.value = task
    if (updateURL) await router.replace({ query: { ...route.query, taskId: id } })
    schedulePoll()
  } catch (error) {
    if (disposed || seq !== detailSeq) return
    errorMessage.value = messageFor(error)
  } finally {
    if (seq === detailSeq) {
      detailInFlightId = ''
      detailLoading.value = false
    }
  }
}

async function recoverRouteTask(id: string) {
  if (detailInFlightId === id) return
  if (selectedTask.value?.id === id) {
    if (detailInFlightId) {
      detailSeq += 1
      detailInFlightId = ''
      detailLoading.value = false
    } else if (selectedTask.value.status === 'queued' || selectedTask.value.status === 'running') {
      await selectTask(id, false)
    }
    schedulePoll()
    return
  }
  if (!isCanonicalTaskID(id)) {
    detailSeq += 1
    detailInFlightId = ''
    detailLoading.value = false
    selectedTask.value = null
    errorMessage.value = '链接中的任务标识无效，请从任务列表重新打开。'
    return
  }
  selectedTask.value = null
  await selectTask(id, false, tasks.value.some((task) => task.id === id) ? '' : itemFilter.value)
}

function stillOwnsSelection(selection: string, filter: '' | TaskStatus, item: string) {
  return !disposed && selectionIntent === selection && statusFilter.value === filter && itemFilter.value === item
}

async function cancelTask(task: AITask) {
  busy.value = true
  errorMessage.value = ''
  notice.value = ''
  const intentSelection = task.id
  const intentFilter: '' | TaskStatus = statusFilter.value
  const intentItem = itemFilter.value
  try {
    const updated = await apiRequest<AITask>(
      `/api/v1/ai/tasks/${task.id}/cancel`,
      jsonRequest('POST', {}, auth.csrfToken),
    )
    if (stillOwnsSelection(intentSelection, intentFilter, intentItem)) {
      notice.value =
        updated.status === 'running'
          ? '取消请求已记录，将在下一个 Provider 或领域工具边界生效。'
          : '任务已取消，未完成的候选不会保存为 Artifact。'
    }
    await loadTasks(false)
    if (stillOwnsSelection(intentSelection, intentFilter, intentItem)) await selectTask(task.id, false)
  } catch (error) {
    if (stillOwnsSelection(intentSelection, intentFilter, intentItem)) errorMessage.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

async function retryTask(task: AITask) {
  busy.value = true
  errorMessage.value = ''
  notice.value = ''
  const intentSelection = task.id
  let intentFilter: '' | TaskStatus = statusFilter.value
  const intentItem = itemFilter.value
  try {
    const retry = await apiRequest<AITask>(
      `/api/v1/ai/tasks/${task.id}/retry`,
      jsonRequest('POST', {}, auth.csrfToken),
    )
    if (stillOwnsSelection(intentSelection, intentFilter, intentItem)) {
      notice.value = '已创建新的重试任务；旧任务历史保持不变。'
      statusFilter.value = ''
      intentFilter = ''
      await router.replace({ query: { ...route.query, status: undefined } })
    }
    await loadTasks(false)
    if (!stillOwnsSelection(intentSelection, intentFilter, intentItem)) return
    await selectTask(retry.id)
  } catch (error) {
    if (stillOwnsSelection(intentSelection, intentFilter, intentItem)) errorMessage.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

async function createBatch() {
  if (!batchSelection.value.length || !organizeModelID.value || busy.value) return
  busy.value = true
  errorMessage.value = ''
  notice.value = ''
  const intentPanel = batchPanelEl.value
  const intentItemIds = [...batchSelection.value]
  const intentOrganize = organizeModelID.value
  const intentVision = visionModelID.value
  const intentPolicy = batchPolicy.value
  let intentFilter: '' | TaskStatus = statusFilter.value
  const intentItem = itemFilter.value
  const intentDetail = selectionIntent
  const ownsDraft = () =>
    batchOpen.value &&
    batchPanelEl.value === intentPanel &&
    batchSelection.value.length === intentItemIds.length &&
    intentItemIds.every((id, index) => batchSelection.value[index] === id) &&
    organizeModelID.value === intentOrganize &&
    visionModelID.value === intentVision &&
    batchPolicy.value === intentPolicy
  try {
    const task = await apiRequest<AITask>(
      '/api/v1/ai/tasks',
      jsonRequest(
        'POST',
        {
          taskType: 'batch_organize',
          itemIds: intentItemIds,
          organizeModelId: intentOrganize,
          visionModelId: intentVision,
          sensitivePolicy: intentPolicy,
        },
        auth.csrfToken,
      ),
    )
    let ownedOutcome = false
    if (ownsDraft() && stillOwnsSelection(intentDetail, intentFilter, intentItem)) {
      ownedOutcome = true
      batchOpen.value = false
      batchSelection.value = []
      statusFilter.value = ''
      intentFilter = ''
      await router.replace({ query: { ...route.query, status: undefined } })
      notice.value = '批量任务已建立。每条记录独立处理，跳过项会保留明确原因。'
    }
    await loadTasks(false)
    if (!ownedOutcome || !stillOwnsSelection(intentDetail, intentFilter, intentItem)) return
    await selectTask(task.id)
  } catch (error) {
    if (ownsDraft() && stillOwnsSelection(intentDetail, intentFilter, intentItem)) errorMessage.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function taskTitle(task: AITask) {
  if (task.taskType === 'batch_organize') return taskTypeLabels.batch_organize
  return itemByID.value.get(task.itemId || '')?.title || taskTypeLabels[task.taskType]
}

function taskSubtitle(task: AITask) {
  const label = taskTypeLabels[task.taskType]
  if (!task.itemId) return `${label} · ${task.triggerType === 'scheduled' ? '定期' : '手动'}`
  return `${label} · 记录 ${task.itemId.slice(0, 8)} · ${task.triggerType === 'scheduled' ? '定期' : '手动'}`
}

function phase(task: AITask) {
  if (task.cancelRequested && task.status === 'running') return '已请求取消，等待安全边界'
  return task.events?.at(-1)?.summary || taskStatusLabels[task.status]
}

function skipEntries(summary: BatchSummary) {
  const labels: Record<keyof BatchSummary['skipped']['byReason'], string> = {
    already_covered: '已有版本覆盖当前输入',
    already_queued_or_running: '同类任务已在队列或运行',
    no_supported_content: '没有受支持的正文或图片',
    vision_model_unavailable: '未配置视觉模型',
    sensitive_blocked: '敏感策略阻止外发',
    sensitive_image_redaction_unsupported: '敏感图片无法可靠遮挡',
  }
  return Object.entries(summary.skipped.byReason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ label: labels[reason as keyof typeof labels], count }))
}

function clearItemFilter() {
  void router.replace({
    query: {
      ...(typeof route.query.taskId === 'string' ? { taskId: route.query.taskId } : {}),
      ...(statusFilter.value ? { status: statusFilter.value } : {}),
    },
  })
}

function chooseStatus(status: '' | TaskStatus) {
  statusFilter.value = status
  void router.replace({ query: { ...route.query, status: status || undefined } })
}

function parseStatus(value: unknown): '' | TaskStatus {
  return typeof value === 'string' && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value)
    ? (value as TaskStatus)
    : ''
}

function isCanonicalTaskID(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : '请求未成功，请稍后重试'
}
</script>

<template>
  <section class="task-center" aria-labelledby="task-center-title">
    <header class="task-center__header">
      <div><h1 id="task-center-title">AI 任务中心</h1><span>查看任务进度、结果和失败原因。</span></div>
      <div><UiButton variant="secondary" @click="batchOpen = !batchOpen"><UiIcon name="boxes" />批量整理</UiButton><RouterLink class="schedule-link" to="/settings/ai-schedule"><UiIcon name="settings" />自动整理设置</RouterLink></div>
    </header>

    <p v-if="!online" class="center-notice center-notice--warning" role="status"><UiIcon name="wifi-off" />当前离线，任务状态暂时无法更新；重新联网后自动刷新。</p>
    <p v-if="errorMessage" class="center-notice center-notice--error" role="alert"><UiIcon name="triangle-alert" />{{ errorMessage }}<button type="button" @click="loadState">重新读取</button></p>
    <p v-if="notice" class="center-notice" role="status"><UiIcon name="check" />{{ notice }}</p>

    <section v-if="batchOpen" ref="batchPanelEl" class="batch-panel" aria-labelledby="batch-title">
      <header><div><h2 id="batch-title">选择要整理的记录</h2><span>最多选择 100 条；单条失败不会影响其他记录。</span></div><button type="button" aria-label="关闭批量整理" @click="batchOpen = false"><UiIcon name="x" /></button></header>
      <p v-if="batchModelMissing" class="center-notice center-notice--warning" role="status"><UiIcon name="triangle-alert" /><span>当前没有可用模型。请前往 Provider 与模型设置完成配置或启用。</span><RouterLink class="batch-model-link" to="/settings/providers">配置 Provider 与模型</RouterLink></p>
      <div class="batch-config">
        <label><span>正文整理模型</span><select v-model="organizeModelID"><option value="">选择模型</option><option v-for="model in modelOptions" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
        <label><span>视觉模型（可选）</span><select v-model="visionModelID"><option value="">未配置，图片将跳过</option><option v-for="model in visionOptions" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
        <label><span>敏感策略</span><select v-model="batchPolicy"><option v-for="policy in allowedPolicies" :key="policy" :value="policy">{{ policy === 'block' ? '阻止外发' : policy === 'redact' ? '遮挡后外发' : '允许原文外发' }}</option></select></label>
      </div>
      <div class="batch-list" role="group" aria-label="批量记录选择">
        <label v-for="item in libraryItems" :key="item.id"><input v-model="batchSelection" type="checkbox" :value="item.id" :disabled="batchSelection.length >= 100 && !batchSelection.includes(item.id)" /><span><strong>{{ item.title }}</strong><small>{{ item.rawRecordCount }} 条原始记录 · {{ item.attachmentCount }} 个附件 · {{ item.sensitivity === 'normal' ? '普通' : item.sensitivity === 'sensitive' ? '敏感' : '待确认' }}</small></span></label>
        <p v-if="!libraryItems.length">资料库中还没有可选择的记录。</p>
      </div>
      <footer><span>已选择 {{ batchSelection.length }} / 100 条</span><UiButton variant="primary" :disabled="busy || !batchSelection.length || !organizeModelID" @click="createBatch">{{ busy ? '正在建立批次…' : '开始批量整理' }}</UiButton></footer>
    </section>

    <nav class="status-tabs" aria-label="任务状态筛选">
      <button type="button" :aria-current="statusFilter === '' ? 'page' : undefined" @click="chooseStatus('')">全部 <span>{{ tasks.length }}</span></button>
      <button v-for="status in (['queued', 'running', 'succeeded', 'failed', 'cancelled'] as TaskStatus[])" :key="status" type="button" :aria-current="statusFilter === status ? 'page' : undefined" @click="chooseStatus(status)">{{ taskStatusLabels[status] }} <span>{{ taskCounts[status] }}</span></button>
    </nav>

    <aside v-if="itemFilter" class="filter-chip"><span>仅显示记录 {{ itemByID.get(itemFilter)?.title || itemFilter.slice(0, 8) }}</span><button type="button" @click="clearItemFilter"><UiIcon name="x" :size="14" />清除</button></aside>

    <div v-if="loading || scopeLoading" class="center-loading"><span class="center-spinner" />正在读取任务队列…</div>
    <div v-else class="task-layout">
      <section class="task-list" aria-label="任务列表">
        <button v-for="task in displayedTasks" :key="task.id" type="button" :class="{ active: selectedTask?.id === task.id }" @click="selectTask(task.id)">
          <span class="status-mark" :class="`status-mark--${task.status}`" />
          <span class="task-list__body"><strong>{{ taskTitle(task) }}</strong><small>{{ taskSubtitle(task) }}</small><em>{{ phase(task) }}</em></span>
          <span class="task-list__meta"><strong>{{ taskStatusLabels[task.status] }}</strong><small>{{ formatDateTime(task.queuedAt) }}</small></span>
        </button>
        <div v-if="!displayedTasks.length && !errorMessage" class="center-empty"><UiIcon name="sparkles" :size="28" /><h2>{{ online ? '没有符合条件的任务' : '离线中，暂时无法读取当前范围的任务' }}</h2><p>{{ online ? '可从记录详情创建单条任务，或在本页开始批量整理。' : '重新联网后会自动刷新列表。' }}</p></div>
      </section>

      <aside class="task-detail" aria-live="polite">
        <div v-if="detailLoading" class="center-loading"><span class="center-spinner" />读取任务事件…</div>
        <template v-else-if="selectedTask">
          <header><div><p>TASK {{ selectedTask.id.slice(0, 8) }}</p><h2>{{ taskTitle(selectedTask) }}</h2><span>{{ taskSubtitle(selectedTask) }}</span></div><span class="detail-status" :class="`detail-status--${selectedTask.status}`">{{ taskStatusLabels[selectedTask.status] }}</span></header>
          <p v-if="selectedTask.cancelRequested && selectedTask.status === 'running'" class="cancel-pending"><UiIcon name="clock" />取消已请求；候选若尚未提交会被丢弃。</p>
          <dl><div><dt>排队</dt><dd>{{ formatDateTime(selectedTask.queuedAt) }}</dd></div><div><dt>开始</dt><dd>{{ formatDateTime(selectedTask.startedAt) }}</dd></div><div><dt>结束</dt><dd>{{ formatDateTime(selectedTask.finishedAt) }}</dd></div><div><dt>敏感策略</dt><dd>{{ selectedTask.sensitivePolicy }}</dd></div><div><dt>Prompt / Schema</dt><dd>{{ selectedTask.promptVersion }} / {{ selectedTask.schemaVersion }}</dd></div><div><dt>Token 用量</dt><dd>{{ selectedTask.inputTokens ?? '—' }} / {{ selectedTask.outputTokens ?? '—' }}</dd></div></dl>
          <div class="detail-actions"><UiButton v-if="selectedTask.status === 'queued' || selectedTask.status === 'running'" variant="danger" :disabled="busy || selectedTask.cancelRequested" @click="cancelTask(selectedTask)">{{ selectedTask.cancelRequested ? '取消处理中' : '取消任务' }}</UiButton><UiButton v-if="selectedTask.status === 'failed' || selectedTask.status === 'cancelled'" variant="secondary" :disabled="busy" @click="retryTask(selectedTask)"><UiIcon name="rotate-ccw" />创建重试任务</UiButton><RouterLink v-if="selectedTask.itemId" :to="{ name: 'item-detail', params: { itemId: selectedTask.itemId } }">打开记录</RouterLink></div>
          <section v-if="selectedTask.errorCode" class="failure-detail"><UiIcon name="triangle-alert" /><div><strong>{{ selectedTask.errorCode }}</strong><p>{{ selectedTask.errorDetail || '任务没有保存候选 Artifact，可按错误原因调整后重试。' }}</p></div></section>

          <section v-if="selectedTask.batchSummary" class="batch-summary" aria-labelledby="batch-summary-title">
            <h3 id="batch-summary-title">批次汇总</h3>
            <div class="summary-metrics"><article><strong>{{ selectedTask.batchSummary.selectedItems }}</strong><span>选择记录</span></article><article><strong>{{ selectedTask.batchSummary.createdChildren }}</strong><span>创建子任务</span></article><article><strong>{{ selectedTask.batchSummary.skipped.total }}</strong><span>跳过分支</span></article></div>
            <p>子任务：等待 {{ selectedTask.batchSummary.childStatusCounts.queued }} · 运行 {{ selectedTask.batchSummary.childStatusCounts.running }} · 模型审阅完成 {{ selectedTask.batchSummary.childStatusCounts.succeeded }} · 失败 {{ selectedTask.batchSummary.childStatusCounts.failed }} · 取消 {{ selectedTask.batchSummary.childStatusCounts.cancelled }}</p>
            <ul v-if="selectedTask.batchSummary.skipped.total"><li v-for="entry in skipEntries(selectedTask.batchSummary)" :key="entry.label"><span>{{ entry.label }}</span><strong>{{ entry.count }}</strong></li></ul>
          </section>

          <section class="event-timeline" aria-labelledby="events-title"><h3 id="events-title">运行事件</h3><ol><li v-for="event in selectedTask.events || []" :key="event.id"><span /><div><strong>{{ event.summary || event.type }}</strong><small>{{ event.type }} · {{ formatDateTime(event.createdAt) }}</small></div></li></ol><p v-if="!selectedTask.events?.length">尚无阶段事件；任务可能仍在等待 Worker。</p></section>
          <p v-if="selectedTask.retryOfTaskId" class="retry-link">这是任务 <button type="button" @click="selectTask(selectedTask.retryOfTaskId!)">{{ selectedTask.retryOfTaskId.slice(0, 8) }}</button> 的重试，旧历史未被改写。</p>
        </template>
        <div v-else class="center-empty"><UiIcon name="file-text" :size="26" /><p>选择一个任务查看阶段、错误与事件。</p></div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.task-center { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; padding: var(--space-5) var(--page-gutter); background: var(--bg-surface); }
.task-center__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); width: 100%; margin: 0 0 var(--space-5); }
.task-center__header p, .task-center__header h1, .task-center__header span { margin: 0; }
.task-detail header p { color: var(--text-muted); font-size: 10px; font-weight: 700; letter-spacing: .07em; }
.task-center__header h1 { font-size: 25px; }
.task-center__header span { display: block; max-width: 75ch; color: var(--text-secondary); }
.task-center__header > div:last-child { display: flex; flex: none; gap: var(--space-2); }
.schedule-link { display: inline-flex; min-height: 40px; align-items: center; gap: var(--space-2); padding: 0 var(--space-4); border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text-primary); text-decoration: none; }
.center-notice, .filter-chip { display: flex; width: 100%; align-items: center; gap: var(--space-2); margin: 0 0 var(--space-3); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--success) 55%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--success); }
.center-notice--warning { border-color: var(--warning); color: var(--warning); }
.center-notice--error { border-color: var(--danger); color: var(--danger); }
.center-notice button { margin-left: auto; border: 0; background: transparent; color: inherit; cursor: pointer; text-decoration: underline; }
.batch-model-link { display: inline-flex; min-height: 40px; flex: none; align-items: center; margin-left: auto; padding: 0 var(--space-3); border-radius: var(--radius-control); text-decoration: underline; }
.batch-panel { width: 100%; max-height: min(460px, 55dvh); flex: none; margin: 0 0 var(--space-4); overflow-y: auto; padding: var(--space-4); border: 1px solid var(--border-strong); border-radius: var(--radius-card); background: var(--bg-elevated); box-shadow: var(--shadow-overlay); overscroll-behavior: contain; }
.batch-panel > header { display: flex; align-items: flex-start; justify-content: space-between; }
.batch-panel header p, .batch-panel header h2, .batch-panel header span { margin: 0; }
.batch-panel header h2 { font-size: 18px; }
.batch-panel header span { color: var(--text-secondary); }
.batch-panel > header button { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.batch-config { display: grid; grid-template-columns: 1fr 1fr .7fr; gap: var(--space-3); margin: var(--space-4) 0; }
.batch-config label { display: grid; gap: var(--space-1); color: var(--text-muted); font-size: 11px; }
.batch-config select { min-height: 40px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
.batch-list { display: grid; max-height: min(220px, 26dvh); grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); overflow-y: auto; padding: var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
.batch-list label { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--space-2); padding: var(--space-2); border-radius: var(--radius-control); background: var(--bg-code); cursor: pointer; }
.batch-list label span { display: grid; min-width: 0; }
.batch-list strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-list small { color: var(--text-muted); }
.batch-panel > footer { display: flex; align-items: center; justify-content: space-between; margin-top: var(--space-3); color: var(--text-muted); }
.status-tabs { display: flex; width: 100%; gap: 2px; margin: 0; overflow-x: auto; border-bottom: 1px solid var(--border-subtle); }
.status-tabs button { display: inline-flex; min-height: 44px; flex: none; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-muted); cursor: pointer; }
.status-tabs button[aria-current='page'] { border-color: var(--accent); color: var(--text-primary); }
.status-tabs button span { min-width: 22px; padding: 1px var(--space-1); border-radius: 999px; background: var(--bg-elevated); font-size: 10px; }
.filter-chip { justify-content: space-between; margin-top: var(--space-3); border-color: var(--accent); color: var(--text-secondary); }
.filter-chip button { display: inline-flex; align-items: center; gap: var(--space-1); border: 0; background: transparent; color: var(--accent); cursor: pointer; }
.task-layout { display: grid; width: 100%; min-height: 0; flex: 1; grid-template-columns: minmax(340px, clamp(380px, 32%, 620px)) minmax(440px, 1fr); margin: var(--space-4) 0 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); }
.task-list { min-height: 0; overflow-y: auto; border-right: 1px solid var(--border-subtle); overscroll-behavior: contain; scrollbar-color: var(--border-strong) transparent; }
.task-list > button { display: grid; width: 100%; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-3); padding: var(--space-3); border: 0; border-bottom: 1px solid var(--border-subtle); background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }
.task-list > button:hover, .task-list > button.active { background: var(--accent-soft); }
.task-list > button.active { box-shadow: inset 3px 0 0 var(--accent); }
.status-mark { width: 9px; height: 9px; margin-top: 5px; border-radius: 50%; background: var(--text-muted); }
.status-mark--queued, .status-mark--running { background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.status-mark--succeeded { background: var(--success); }
.status-mark--failed { background: var(--danger); }
.task-list__body, .task-list__meta { display: grid; min-width: 0; }
.task-list__body strong { display: -webkit-box; overflow: hidden; line-height: 1.4; white-space: normal; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.task-list__body small, .task-list__body em, .task-list__meta small { color: var(--text-muted); font-size: 10px; font-style: normal; }
.task-list__body em { margin-top: var(--space-1); color: var(--text-secondary); }
.task-list__meta { justify-items: end; }
.task-list__meta strong { color: var(--text-secondary); font-size: 10px; }
.task-detail { min-width: 0; min-height: 0; padding: clamp(var(--space-4), 1.5vw, var(--space-6)); overflow-y: auto; overscroll-behavior: contain; scrollbar-color: var(--border-strong) transparent; }
.task-detail > header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); padding-bottom: var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.task-detail header p, .task-detail header h2, .task-detail header span { margin: 0; }
.task-detail header h2 { overflow-wrap: anywhere; font-size: 19px; }
.task-detail header span { color: var(--text-muted); }
.detail-status { flex: none; padding: var(--space-1) var(--space-2); border-radius: 999px; background: var(--bg-code); font-size: 10px; }
.detail-status--running, .detail-status--queued { color: var(--accent) !important; }
.detail-status--succeeded { color: var(--success) !important; }
.detail-status--failed { color: var(--danger) !important; }
.cancel-pending { display: flex; gap: var(--space-2); padding: var(--space-2); border-left: 3px solid var(--warning); color: var(--warning); }
.task-detail dl { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin: var(--space-4) 0; }
.task-detail dl div { display: grid; }
.task-detail dt { color: var(--text-muted); font-size: 10px; }
.task-detail dd { margin: 0; color: var(--text-secondary); overflow-wrap: anywhere; }
.detail-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.detail-actions > a { padding: var(--space-2); text-decoration: none; }
.failure-detail { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2); margin-top: var(--space-4); padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); }
.failure-detail p { margin: 0; color: var(--text-secondary); }
.batch-summary, .event-timeline { margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border-subtle); }
.batch-summary h3, .event-timeline h3 { margin: 0 0 var(--space-3); font-size: 13px; }
.summary-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2); }
.summary-metrics article { display: grid; padding: var(--space-3); border-radius: var(--radius-control); background: var(--bg-code); }
.summary-metrics strong { font-size: 20px; }
.summary-metrics span { color: var(--text-muted); font-size: 10px; }
.batch-summary > p { color: var(--text-secondary); }
.batch-summary ul { display: grid; gap: 1px; padding: 0; list-style: none; }
.batch-summary li { display: flex; justify-content: space-between; padding: var(--space-2); background: var(--bg-code); color: var(--text-secondary); }
.event-timeline ol { display: grid; gap: var(--space-3); padding: 0; list-style: none; }
.event-timeline li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2); }
.event-timeline li > span { width: 9px; height: 9px; margin-top: 4px; border: 2px solid var(--accent); border-radius: 50%; }
.event-timeline li div { display: grid; }
.event-timeline small, .event-timeline > p { color: var(--text-muted); }
.retry-link { color: var(--text-muted); }
.retry-link button { border: 0; background: transparent; color: var(--accent); cursor: pointer; }
.center-loading, .center-empty { display: grid; min-height: 240px; place-content: center; justify-items: center; gap: var(--space-2); color: var(--text-muted); text-align: center; }
.center-loading { display: flex; width: 100%; flex: 1; margin: 0; }
.center-spinner { width: 22px; height: 22px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.center-empty h2, .center-empty p { margin: 0; }
@media (max-width: 1000px) { .task-center { display: block; height: auto; min-height: 100%; overflow: visible; padding: var(--space-4); } .batch-panel { max-height: none; overflow: visible; } .task-layout { height: auto; min-height: 0; grid-template-columns: 1fr; } .task-list { max-height: min(480px, 52dvh); border-right: 0; border-bottom: 1px solid var(--border-subtle); } .task-detail { overflow: visible; } .batch-config { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .task-center { padding: var(--space-3); } .task-center__header { display: grid; } .task-center__header > div:last-child { flex-wrap: wrap; } .batch-list { grid-template-columns: 1fr; } .task-list > button { grid-template-columns: auto minmax(0, 1fr); } .task-list__meta { grid-column: 2; justify-items: start; } .task-detail { padding: var(--space-3); } .task-detail dl { grid-template-columns: 1fr; } }
</style>

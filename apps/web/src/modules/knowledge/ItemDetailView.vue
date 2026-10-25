<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance, type Ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
import ItemAIView from '../ai/ItemAIView.vue'
import type { ArtifactSummary } from '../ai/contracts'
import RawDocument from './RawDocument.vue'
import SupplementDrawer from './SupplementDrawer.vue'
import { type AttachmentEntry, type Sensitivity, type TagEntry, useLibraryStore } from './library'

interface RawRelation {
  direction: 'incoming' | 'outgoing'
  type: 'supplements' | 'supersedes' | 'migration_duplicate'
  relatedRawRecordId: string
  relatedItemId: string
  origin: string
  confirmed: boolean
  createdAt: string
}

interface RawRecordSummary {
  id: string
  recordRole: string
  sourceType: string
  contentKind: string
  contentFormat: 'plain_text' | 'markdown'
  declaredSensitivity: Sensitivity
  capturedAt: string
  effectiveCapturedAt: string
  sourceTimeQuality: string
  createdAt: string
  attachments: AttachmentEntry[]
  relations: RawRelation[]
  fragments: RawFragment[]
}

interface RawFragment {
  id: string
  sourceKind: 'raw_text' | 'code'
  ordinal: number
  startByte: number
  endByte: number
}

interface ItemDetail {
  id: string
  title: string
  titleOrigin: string
  note?: string | null
  folder?: { id: string; name: string; path: string } | null
  tags: TagEntry[]
  sensitivity: Sensitivity
  favorite: boolean
  createdAt: string
  updatedAt: string
  rawRecords: RawRecordSummary[]
  attachments: AttachmentEntry[]
  artifacts: ArtifactSummary[]
  availableVersions: ArtifactSummary[]
}

interface RawRecord extends RawRecordSummary {
  itemId: string
  readOnly: true
  body: string
  source: {
    sourceType: string
    externalId?: string | null
    path?: string | null
    createdAt?: string | null
    updatedAt?: string | null
    metadata: Record<string, unknown>
  }
}

// 编辑弹窗本次打开的起点快照（docs/03 4.7：PATCH 缺失字段保持不变）。
interface EditSnapshot {
  title: string
  note: string | null
  folderId: string | null
  tagIds: string[]
  favorite: boolean
  sensitivity: Sensitivity
}

const props = withDefaults(defineProps<{ itemId: string; embedded?: boolean }>(), { embedded: false })
const emit = defineEmits<{ changed: []; deleted: [] }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const library = useLibraryStore()
const loading = ref(true)
const errorMessage = ref('')
const detail = ref<ItemDetail | null>(null)
const heading = ref<HTMLElement | null>(null)
const matchAnchor = ref<HTMLElement | null>(null)
const rawContent = ref<HTMLElement | null>(null)
const editTrigger = ref<ComponentPublicInstance | null>(null)
const supplementTrigger = ref<ComponentPublicInstance | null>(null)
const selectedRawID = ref('')
const rawRecord = ref<RawRecord | null>(null)
const rawLoading = ref(false)
const copied = ref(false)
const copyError = ref(false)
const activeTab = ref<'raw' | 'attachments' | 'history' | 'ai'>('raw')
const revealConfirm = ref(false)
const sensitiveRevealed = ref(false)
const supplementOpen = ref(false)
const editOpen = ref(false)
const deleteConfirm = ref(false)
const revealDialog = ref<HTMLElement | null>(null)
const editDialog = ref<HTMLElement | null>(null)
const deleteDialog = ref<HTMLElement | null>(null)
const mutationBusy = ref(false)
const mutationError = ref('')
const editTitle = ref('')
const editNote = ref('')
const editFolderID = ref('')
const editTagIDs = ref<string[]>([])
const editFavorite = ref(false)
const editSensitivity = ref<Sensitivity>('normal')
// DT-R229：保存只提交相对打开快照真正变化的字段。A 保存成功会重载 detail，取消后重开的
// B 表单仍是旧值，全字段 PATCH 会用旧标题回退 A 刚保存的结果；缺省标题也让敏感升级时
// 后端保留 generated 标题的脱敏替换语义，不用旧标题冒充用户编辑。
let editSnapshot: EditSnapshot | null = null
const matchedFragmentID = ref('')
// DT-R197：附件缩略图失败态与显式重试。失败以附件 id 记录，只随当前详情生命周期存在
//（loadDetail 整体重置，切换/重载不串到别的附件）；重试一次点击清除失败记录，v-if 随之
// 重新挂载 img 对同一 URL 发起一次新加载，不加缓存参数、不自动轮询；未揭示或静态
// 不可预览的附件不进入该状态。
const failedPreviews = ref<Record<string, boolean>>({})

const selectedSummary = computed(() =>
  detail.value?.rawRecords.find((record) => record.id === selectedRawID.value),
)
const contentKindLabels: Record<string, string> = { text: '文本', image: '图片', file: '文件', mixed: '混合' }
const selectedContentKindLabel = computed(() => contentKindLabels[selectedSummary.value?.contentKind ?? ''] ?? '原始内容')
const flatFolders = computed(() => flattenFolders(library.folders))
const matchedFragment = computed(() =>
  rawRecord.value?.fragments.find((fragment) => fragment.id === matchedFragmentID.value),
)
const matchedFragmentText = computed(() => {
  if (!rawRecord.value || !matchedFragment.value) return ''
  const encoded = new TextEncoder().encode(rawRecord.value.body)
  return new TextDecoder().decode(encoded.slice(matchedFragment.value.startByte, matchedFragment.value.endByte))
})

watch(
  () => props.itemId,
  () => void loadDetail(),
)
watch(
  () => route.query.hit,
  () => void applyMatchedFragment(),
)
onMounted(() => void loadDetail())
onBeforeUnmount(() => {
  invalidateRawFetch()
  clearCopyFeedback()
})

// Only the latest raw-record request may write body, error or loading state;
// switching raw records, reloading metadata and unmounting abort stale ones.
let rawFetchController: AbortController | null = null

function invalidateRawFetch() {
  rawFetchController?.abort()
  rawFetchController = null
  rawLoading.value = false
}

// 同一实例上详情重载会并发：已取消保存的晚到收尾与补充 created 收尾各发一次 GET，
// 只有最新一次请求可以写 detail、错误与 loading，旧请求的结果与失败整体丢弃。
let detailRequest = 0

async function loadDetail() {
  const request = ++detailRequest
  loading.value = true
  errorMessage.value = ''
  invalidateRawFetch()
  rawRecord.value = null
  clearCopyFeedback()
  sensitiveRevealed.value = false
  failedPreviews.value = {}
  try {
    const loaded = await apiRequest<ItemDetail>(`/api/v1/items/${props.itemId}`)
    if (request !== detailRequest) return
    detail.value = loaded
    matchedFragmentID.value = typeof route.query.hit === 'string' ? route.query.hit : ''
    selectedRawID.value =
      loaded.rawRecords.find((record) =>
        record.fragments.some((fragment) => fragment.id === matchedFragmentID.value),
      )?.id ?? loaded.rawRecords[0]?.id ?? ''
    await nextTick()
    if (request === detailRequest) heading.value?.focus({ preventScroll: true })
  } catch (error) {
    if (request !== detailRequest) return
    detail.value = null
    errorMessage.value = error instanceof Error ? error.message : '详情暂时不可用'
  } finally {
    if (request === detailRequest) loading.value = false
  }
}

async function applyMatchedFragment() {
  matchedFragmentID.value = typeof route.query.hit === 'string' ? route.query.hit : ''
  if (!detail.value || !matchedFragmentID.value) return
  const targetRawID = detail.value.rawRecords.find((record) =>
    record.fragments.some((fragment) => fragment.id === matchedFragmentID.value),
  )?.id
  if (!targetRawID) return
  if (selectedRawID.value !== targetRawID) {
    selectRawRecord(targetRawID)
    return
  }
  await nextTick()
  if (matchedFragment.value) matchAnchor.value?.scrollIntoView({ block: 'center' })
}

// 三个详情弹窗共用的键盘归属：记录触发器，打开即入焦，Tab 环绕，Escape / 指针取消并回焦。
let dialogTrigger: HTMLElement | null = null

// 编辑弹窗的归属代次：取消（含 Escape）与新开编辑都推进代次。挂起保存的晚到收尾
// 只对同代弹窗生效，不得关闭或抢焦重新打开的编辑弹窗，也不得把旧错误写进它或回收站弹窗。
let editGeneration = 0

const dialogFocusableSelector =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

function rememberDialogTrigger(event: Event) {
  dialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
}

async function returnFocusToTrigger() {
  const trigger = dialogTrigger
  dialogTrigger = null
  await nextTick()
  if (trigger?.isConnected) trigger.focus()
}

// 编辑弹窗初焦标题输入框（缺输入控件时退到可见的关闭按钮）；
// 两个确认弹窗初焦取消按钮，避免自动落在「确认揭示 / 移入回收站」上。
async function focusDialogTarget(dialog: Ref<HTMLElement | null>, prefer: 'first-input' | 'last-button') {
  await nextTick()
  const root = dialog.value
  if (!root) return
  const input = prefer === 'first-input' ? root.querySelector<HTMLInputElement>('input:not([disabled])') : null
  const buttons = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'))
  const target = input ?? (prefer === 'last-button' ? buttons[buttons.length - 1] : buttons[0])
  if (target) target.focus()
  else root.focus()
}

function effectiveFocusIn(root: HTMLElement) {
  const active = document.activeElement
  return active instanceof HTMLElement && root.contains(active) && active.matches(dialogFocusableSelector)
}

// 指针取消与 Escape 共用同一关闭路径：关弹窗、回焦触发器。
function closeRevealDialog() {
  if (!revealConfirm.value) return
  revealConfirm.value = false
  void returnFocusToTrigger()
}

function closeEditDialog() {
  if (!editOpen.value) return
  editGeneration += 1
  editOpen.value = false
  void returnFocusToTrigger()
}

function closeTrashDialog() {
  // 移入进行中与取消按钮的 disabled=mutationBusy 语义一致，取消不得关闭；
  // 编辑的取消在保存中不禁用，Escape 与其同语义。
  if (!deleteConfirm.value || mutationBusy.value) return
  deleteConfirm.value = false
  void returnFocusToTrigger()
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    // IME 组合中的 Escape 属于输入法行为，不当作弹窗取消。
    if (event.isComposing) return
    event.preventDefault()
    const dialog = event.currentTarget as HTMLElement
    if (dialog === deleteDialog.value) closeTrashDialog()
    else if (dialog === editDialog.value) closeEditDialog()
    else closeRevealDialog()
    return
  }
  if (event.key !== 'Tab') return
  const dialog = event.currentTarget as HTMLElement
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector))
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

// busy 使已聚焦的确认按钮失效后，浏览器会把焦点还给 viewport（jsdom 则停在已禁用控件上）；
// 置位与解除（如 DELETE 失败后按钮恢复、焦点仍停在容器）都在弹窗仍打开时恢复有效焦点：
// 编辑退到标题输入，回收站置位期间落容器、解除后落取消按钮。已有效不重置，成功路径弹窗已关不触焦。
watch(mutationBusy, async () => {
  await nextTick()
  if (editOpen.value) {
    if (editDialog.value && !effectiveFocusIn(editDialog.value)) void focusDialogTarget(editDialog, 'first-input')
  } else if (deleteConfirm.value) {
    if (deleteDialog.value && !effectiveFocusIn(deleteDialog.value)) void focusDialogTarget(deleteDialog, 'last-button')
  }
})

function requestReveal(event: Event) {
  if (detail.value?.sensitivity === 'normal') {
    void revealRawRecord()
  } else {
    rememberDialogTrigger(event)
    revealConfirm.value = true
    void focusDialogTarget(revealDialog, 'last-button')
  }
}

async function confirmReveal() {
  sensitiveRevealed.value = true
  revealConfirm.value = false
  await revealRawRecord()
}

async function revealRawRecord() {
  if (!selectedRawID.value || !detail.value) return
  invalidateRawFetch()
  const controller = new AbortController()
  rawFetchController = controller
  rawLoading.value = true
  errorMessage.value = ''
  try {
    const record = await apiRequest<RawRecord>(
      `/api/v1/items/${detail.value.id}/raw-records/${selectedRawID.value}`,
      { signal: controller.signal },
    )
    if (controller.signal.aborted) return
    rawRecord.value = record
    await nextTick()
    if (matchedFragment.value) {
      matchAnchor.value?.scrollIntoView({ block: 'center' })
      matchAnchor.value?.focus()
    } else {
      // 触发按钮随 reveal 占位被 v-if 卸载，焦点会掉到 BODY；只在焦点确实无效（BODY、缺失、断连或已禁用）
      // 时落到正文容器。用户已移到资料库搜索框等仍连接可用的焦点属于其当前位置，不得抢走。
      const active = document.activeElement
      const focusValid =
        active instanceof HTMLElement &&
        active !== document.body &&
        active.isConnected &&
        !active.hasAttribute('disabled')
      if (!focusValid) rawContent.value?.focus()
    }
  } catch (error) {
    if (controller.signal.aborted) return
    errorMessage.value = error instanceof Error ? error.message : '原始记录暂时不可用'
  } finally {
    if (!controller.signal.aborted) rawLoading.value = false
  }
}

function selectRawRecord(id: string) {
  if (id === selectedRawID.value) return
  invalidateRawFetch()
  selectedRawID.value = id
  rawRecord.value = null
  clearCopyFeedback()
}

// DT-R273：复制反馈只属于触发复制时展示的那条原始记录；writeText 晚到的成功/失败
// 按捕获对象的同一性失效，不写回切换或重载后的新记录。1600ms 收尾共用唯一 timer，
// 有效成功前替换旧 timer，切换、重载与卸载时统一清理。
let copyTimer: number | null = null

function clearCopyFeedback() {
  if (copyTimer !== null) {
    window.clearTimeout(copyTimer)
    copyTimer = null
  }
  copied.value = false
  copyError.value = false
}

async function copyAll() {
  const record = rawRecord.value
  if (!record) return
  copyError.value = false
  try {
    await navigator.clipboard.writeText(record.body)
    if (rawRecord.value !== record) return
    copied.value = true
    if (copyTimer !== null) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copied.value = false), 1600)
  } catch {
    if (rawRecord.value !== record) return
    copied.value = false
    copyError.value = true
  }
}

// previewGate：附件缩略图的渲染门控（允许预览、有缩略端点且敏感内容已揭示）。
// 失败态与重试入口只出现在该门通过后的加载失败，未揭示内容不得为重试提前请求。
function previewGate(attachment: AttachmentEntry) {
  return Boolean(
    attachment.previewAllowed &&
      attachment.thumbnailUrl &&
      (detail.value?.sensitivity === 'normal' || sensitiveRevealed.value),
  )
}

function onPreviewError(attachmentId: string) {
  failedPreviews.value[attachmentId] = true
}

// 一次显式点击只做一次新加载：清除失败记录后 v-if 重建 img（src 不变），
// 由浏览器对同一 URL 重新发起请求；成败交给新的 load/error，无自动重试。
function retryPreview(attachmentId: string) {
  delete failedPreviews.value[attachmentId]
}

async function beginEdit(event: Event) {
  if (!detail.value) return
  // 触发元素必须在 loadNavigation 的 await 之前捕获，事件对象的 currentTarget 之后会失效。
  rememberDialogTrigger(event)
  // 新开编辑即新会话：在 await 导航前推进代次，旧保存的晚到收尾（如仅剩导航挂起时）不得作用于本弹窗。
  editGeneration += 1
  if (!library.folders.length && !library.tags.length) {
    try {
      await library.loadNavigation()
    } catch {
      // The editor still supports title, note, favorite and sensitivity.
    }
  }
  editTitle.value = detail.value.title
  editNote.value = detail.value.note ?? ''
  editFolderID.value = detail.value.folder?.id ?? ''
  editTagIDs.value = detail.value.tags.map((tag) => tag.id)
  editFavorite.value = detail.value.favorite
  editSensitivity.value = detail.value.sensitivity
  // 打开快照与表单在同一次填充时建立（按服务端 trim/null 语义归一化）；
  // save 不得把此刻可能已被晚到重载刷新的 detail 当作编辑起点。
  editSnapshot = {
    title: detail.value.title.trim(),
    note: detail.value.note?.trim() || null,
    folderId: detail.value.folder?.id ?? null,
    tagIds: detail.value.tags.map((tag) => tag.id),
    favorite: detail.value.favorite,
    sensitivity: detail.value.sensitivity,
  }
  mutationError.value = ''
  editOpen.value = true
  void focusDialogTarget(editDialog, 'first-input')
}

async function saveMetadata() {
  if (!detail.value || !editSnapshot || !editTitle.value.trim()) return
  // 只提交相对本次打开快照真正变化的字段；payload 形状保持既有契约：
  // title/note 传原始表单值由服务端 trim，空备注传 null 清空，tagIds 按实际集合比较。
  const snapshot = editSnapshot
  const trimmedTitle = editTitle.value.trim()
  const trimmedNote = editNote.value.trim()
  const folderId = editFolderID.value || null
  const tagIds = editTagIDs.value
  const patch: Record<string, unknown> = {}
  if (trimmedTitle !== snapshot.title) patch.title = editTitle.value
  if ((trimmedNote || null) !== snapshot.note) patch.note = trimmedNote ? editNote.value : null
  if (folderId !== snapshot.folderId) patch.folderId = folderId
  if (
    tagIds.length !== snapshot.tagIds.length ||
    !tagIds.every((id) => snapshot.tagIds.includes(id))
  ) {
    patch.tagIds = tagIds
  }
  if (editFavorite.value !== snapshot.favorite) patch.favorite = editFavorite.value
  if (editSensitivity.value !== snapshot.sensitivity) patch.sensitivity = editSensitivity.value

  if (!Object.keys(patch).length) {
    // 无变化不发后端必拒的空 PATCH：直接关闭，并按成功路径回焦当前渲染的编辑触发器
    //（此前的详情重载可能已重建头部，beginEdit 记住的 dialogTrigger 可能已断连）。
    editOpen.value = false
    await nextTick()
    const trigger = editTrigger.value?.$el
    if (trigger instanceof HTMLElement) trigger.focus()
    return
  }

  mutationBusy.value = true
  mutationError.value = ''
  const generation = editGeneration
  try {
    await apiRequest(
      `/api/v1/items/${detail.value.id}`,
      jsonRequest('PATCH', patch, auth.csrfToken),
    )
    // 用户取消后重新打开的编辑弹窗属于新一代，晚到收尾不得关闭它；
    // 已提交的写入仍完成既有的元数据/导航刷新与 changed 通知。
    if (editGeneration === generation) editOpen.value = false
    await Promise.all([loadDetail(), library.loadNavigation()])
    emit('changed')
    // 刷新经 loading 重建头部，回焦必须等当前 DOM 就绪后落到当前渲染的触发按钮；
    // 已换代时新弹窗正被使用，同样不得抢焦。
    if (editGeneration === generation) {
      await nextTick()
      const trigger = editTrigger.value?.$el
      if (trigger instanceof HTMLElement) trigger.focus()
    }
  } catch (error) {
    // 晚到的失败只写回仍属于本次保存的弹窗，避免旧错误串入新编辑或回收站弹窗。
    if (editGeneration === generation) {
      mutationError.value = error instanceof Error ? error.message : '元数据保存失败'
    }
  } finally {
    mutationBusy.value = false
  }
}

async function toggleFavorite() {
  if (!detail.value || mutationBusy.value) return
  mutationBusy.value = true
  try {
    await apiRequest(
      `/api/v1/items/${detail.value.id}`,
      jsonRequest('PATCH', { favorite: !detail.value.favorite }, auth.csrfToken),
    )
    await loadDetail()
    emit('changed')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '收藏状态保存失败'
  } finally {
    mutationBusy.value = false
  }
}

function openDeleteConfirm(event: Event) {
  rememberDialogTrigger(event)
  deleteConfirm.value = true
  void focusDialogTarget(deleteDialog, 'last-button')
}

async function trashItem() {
  if (!detail.value) return
  mutationBusy.value = true
  mutationError.value = ''
  try {
    await apiRequest(
      `/api/v1/items/${detail.value.id}`,
      jsonRequest('DELETE', {}, auth.csrfToken),
    )
    deleteConfirm.value = false
    emit('deleted')
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : '移入回收站失败'
  } finally {
    mutationBusy.value = false
  }
}

async function onSupplementCreated() {
  await loadDetail()
  emit('changed')
  // 补充 drawer 的关闭回焦指向被 loading 重建销毁的旧「添加补充」按钮，会落空到 BODY；
  // 重载完成后只在焦点确实无效（BODY、断连或已禁用）时补焦当前渲染的按钮。
  // 用户已移到资料库搜索框等仍连接可用的焦点属于其当前位置，不得抢走。
  await nextTick()
  const active = document.activeElement
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    active.isConnected &&
    !active.hasAttribute('disabled')
  ) {
    return
  }
  const trigger = supplementTrigger.value?.$el
  if (trigger instanceof HTMLElement) trigger.focus()
}

async function locateAISource(fragmentID: string) {
  activeTab.value = 'raw'
  await router.replace({ query: { ...route.query, hit: fragmentID } })
  await applyMatchedFragment()
}

async function onAIChanged() {
  await loadDetail()
  emit('changed')
}

function flattenFolders(entries: typeof library.folders, depth = 0): Array<{ id: string; name: string; depth: number }> {
  return entries.flatMap((entry) => [
    { id: entry.id, name: entry.name, depth },
    ...flattenFolders(entry.children, depth + 1),
  ])
}

function relationLabel(relation: RawRelation) {
  const type = { supplements: '补充', supersedes: '替代', migration_duplicate: '迁移重复' }[
    relation.type
  ]
  return `${relation.direction === 'outgoing' ? '指向' : '来自'} · ${type}`
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
</script>

<template>
  <section class="detail-page" :class="{ 'detail-page--embedded': embedded }">
    <div v-if="loading" class="detail-state" aria-live="polite"><span class="spinner" aria-hidden="true" /><p>正在读取记录元数据…</p></div>
    <div v-else-if="!detail" class="detail-state detail-state--error" role="alert"><UiIcon name="triangle-alert" :size="26" /><h1>记录暂时不可用</h1><p>{{ errorMessage }}</p><RouterLink :to="{ name: 'workspace', query: route.query }">返回资料库</RouterLink></div>

    <template v-else>
      <header class="detail-header">
        <RouterLink class="back-link" :to="{ name: 'workspace', query: route.query }"><UiIcon name="chevron-left" /> 返回资料库</RouterLink>
        <div class="detail-header__main">
          <span class="detail-header__icon" :class="{ sensitive: detail.sensitivity !== 'normal' }"><UiIcon :name="detail.sensitivity === 'normal' ? 'file-text' : 'shield-alert'" /></span>
          <div><p>知识条目 · {{ detail.rawRecords.length }} 条原始记录</p><h1 ref="heading" tabindex="-1">{{ detail.title }}</h1></div>
          <button type="button" class="favorite" :aria-label="detail.favorite ? '取消收藏' : '收藏记录'" :disabled="mutationBusy" @click="toggleFavorite"><UiIcon name="star" :class="{ filled: detail.favorite }" /></button>
        </div>
        <div class="detail-actions">
          <UiButton ref="supplementTrigger" variant="secondary" @click="supplementOpen = true"><UiIcon name="plus" /> 添加补充</UiButton>
          <UiButton ref="editTrigger" variant="secondary" @click="beginEdit"><UiIcon name="pencil" /> 编辑元数据</UiButton>
          <button type="button" class="trash-action" aria-label="移入回收站" @click="openDeleteConfirm"><UiIcon name="trash-2" /></button>
        </div>
        <dl>
          <div><dt>目录</dt><dd>{{ detail.folder?.path || '收件箱' }}</dd></div>
          <div><dt>标签</dt><dd>{{ detail.tags.map((tag) => tag.name).join(' · ') || '无' }}</dd></div>
          <div><dt>敏感状态</dt><dd>{{ detail.sensitivity === 'normal' ? '普通' : detail.sensitivity === 'unknown' ? '待确认' : '敏感' }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ formatTime(detail.updatedAt) }}</dd></div>
        </dl>
      </header>

      <p v-if="errorMessage" class="detail-notice" role="alert"><UiIcon name="triangle-alert" /> {{ errorMessage }}</p>

      <nav class="detail-tabs" aria-label="详情区域">
        <button type="button" :aria-current="activeTab === 'raw' ? 'page' : undefined" @click="activeTab = 'raw'"><UiIcon name="file-text" /> 原始记录</button>
        <button type="button" :aria-current="activeTab === 'attachments' ? 'page' : undefined" @click="activeTab = 'attachments'"><UiIcon name="paperclip" /> 附件 <span>{{ detail.attachments.length }}</span></button>
        <button type="button" :aria-current="activeTab === 'history' ? 'page' : undefined" @click="activeTab = 'history'"><UiIcon name="history" /> 历史与来源</button>
        <button type="button" :aria-current="activeTab === 'ai' ? 'page' : undefined" @click="activeTab = 'ai'"><UiIcon name="sparkles" /> AI 版本</button>
      </nav>

      <div v-if="activeTab === 'raw'" class="raw-layout">
        <aside class="raw-history" aria-label="原始记录列表">
          <button v-for="record in detail.rawRecords" :key="record.id" type="button" :class="{ active: selectedRawID === record.id }" @click="selectRawRecord(record.id)">
            <span>{{ record.recordRole === 'primary' ? '主记录' : record.recordRole === 'migration_copy' ? '迁移副本' : '补充记录' }}</span>
            <strong>{{ formatTime(record.effectiveCapturedAt) }}</strong>
            <small>{{ record.sourceType }} · {{ record.sourceTimeQuality }}</small>
          </button>
        </aside>
        <main class="raw-panel">
          <header><div><p>原始记录 · 只读</p><h2>{{ selectedContentKindLabel }}</h2></div><UiButton v-if="rawRecord" variant="secondary" @click="copyAll"><UiIcon name="copy" /> {{ copied ? '已复制全部' : copyError ? '复制失败，重试' : '复制全部原文' }}</UiButton></header>
          <span class="sr-only" role="status">{{ copied ? '原始记录已精确复制' : copyError ? '复制失败，请重试' : '' }}</span>
          <div v-if="!rawRecord" class="reveal-state" :class="{ sensitive: detail.sensitivity !== 'normal' }">
            <UiIcon :name="detail.sensitivity === 'normal' ? 'eye' : 'shield-alert'" :size="25" />
            <h3>{{ detail.sensitivity === 'normal' ? '按需读取原始记录' : '敏感原文尚未读取' }}</h3>
            <p>{{ detail.sensitivity === 'normal' ? '详情只包含元数据；打开后从只读端点读取完整原文。' : '页面没有预载敏感正文或图片。明确揭示只在当前页面生效。' }}</p>
            <UiButton variant="primary" :disabled="rawLoading" @click="requestReveal"><UiIcon name="eye" /> {{ rawLoading ? '正在读取' : '查看原始记录' }}</UiButton>
          </div>
          <template v-else>
            <aside v-if="matchedFragmentText" ref="matchAnchor" class="matched-fragment" tabindex="-1">
              <strong><UiIcon name="search" :size="15" /> 搜索命中定位</strong>
              <pre>{{ matchedFragmentText }}</pre>
            </aside>
            <article ref="rawContent" class="raw-content" tabindex="-1"><RawDocument :body="rawRecord.body" :content-format="rawRecord.contentFormat" /></article>
          </template>
          <section v-if="selectedSummary?.attachments.length" class="raw-attachments"><h3>本条原始记录的附件</h3><ul><li v-for="attachment in selectedSummary.attachments" :key="attachment.id"><UiIcon :name="attachment.kind === 'image' ? 'image' : 'file-text'" /><span><strong>{{ attachment.displayName }}</strong><small>{{ attachment.mediaType }} · {{ formatBytes(attachment.sizeBytes) }}</small></span><a v-if="detail.sensitivity === 'normal' || sensitiveRevealed" :href="attachment.contentUrl" download><UiIcon name="download" /> 下载原件</a><button v-else type="button" @click="requestReveal"><UiIcon name="eye" /> 揭示后下载</button></li></ul></section>
        </main>
      </div>

      <section v-else-if="activeTab === 'attachments'" class="attachments-panel">
        <div v-if="detail.attachments.length" class="attachment-grid">
          <article v-for="attachment in detail.attachments" :key="attachment.id">
            <div class="attachment-preview">
              <img v-if="previewGate(attachment) && !failedPreviews[attachment.id]" :src="attachment.thumbnailUrl ?? undefined" :alt="attachment.displayName" @error="onPreviewError(attachment.id)" />
              <template v-else-if="previewGate(attachment)"><UiIcon class="preview-failed-icon" name="triangle-alert" :size="28" /><span>预览加载失败</span><button type="button" class="preview-retry" @click="retryPreview(attachment.id)"><UiIcon name="rotate-ccw" :size="14" /> 重试预览</button></template>
              <template v-else><UiIcon :name="attachment.kind === 'image' ? detail.sensitivity === 'normal' ? 'image' : 'shield-alert' : 'file-text'" :size="28" /><span v-if="attachment.kind === 'image' && detail.sensitivity !== 'normal' && !sensitiveRevealed">敏感图片未请求</span><span v-else-if="attachment.kind === 'image'">安全预览不可用</span></template>
            </div>
            <h3>{{ attachment.displayName }}</h3><p>{{ attachment.mediaType }} · {{ formatBytes(attachment.sizeBytes) }}<template v-if="attachment.width && attachment.height"> · {{ attachment.width }}×{{ attachment.height }}</template></p>
            <a v-if="detail.sensitivity === 'normal' || sensitiveRevealed" :href="attachment.contentUrl" download><UiIcon name="download" /> 下载原件</a><UiButton v-else variant="secondary" @click="requestReveal"><UiIcon name="eye" /> 揭示附件</UiButton>
          </article>
        </div>
        <div v-else class="tab-empty"><UiIcon name="paperclip" :size="28" /><h2>没有附件</h2><p>附件只能随新建或补充原始记录加入，不会覆盖旧附件。</p></div>
      </section>

      <section v-else-if="activeTab === 'history'" class="history-panel">
        <article v-for="record in detail.rawRecords" :key="record.id">
          <span class="history-panel__dot" /><div><p>{{ record.recordRole === 'primary' ? '创建主原始记录' : '添加补充原始记录' }}</p><h3>{{ formatTime(record.effectiveCapturedAt) }}</h3><small>来源 {{ record.sourceType }} · 时间可信度 {{ record.sourceTimeQuality }} · 声明敏感状态 {{ record.declaredSensitivity }}</small><ul v-if="record.relations.length"><li v-for="relation in record.relations" :key="`${relation.direction}-${relation.relatedRawRecordId}-${relation.type}`"><strong>{{ relationLabel(relation) }}</strong><span>原始记录 {{ relation.relatedRawRecordId.slice(0, 8) }}…</span></li></ul></div>
        </article>
      </section>

      <ItemAIView
        v-else
        :item-id="detail.id"
        :sensitivity="detail.sensitivity"
        :attachments="detail.attachments"
        :initial-artifacts="detail.availableVersions.length ? detail.availableVersions : detail.artifacts"
        @source="locateAISource"
        @changed="onAIChanged"
      />
    </template>
  </section>

  <SupplementDrawer v-if="detail" :open="supplementOpen" :item-id="detail.id" :raw-records="detail.rawRecords" :current-sensitivity="detail.sensitivity" @close="supplementOpen = false" @created="onSupplementCreated" />

  <Teleport to="body">
    <div v-if="revealConfirm" class="dialog-overlay"><section ref="revealDialog" class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reveal-title" tabindex="-1" @keydown="onDialogKeydown"><UiIcon name="shield-alert" :size="28" /><h2 id="reveal-title">揭示敏感原文与附件？</h2><p>内容将在当前页面内读取和显示。请确认周围环境安全，复制后也需自行保护剪贴板。</p><UiButton variant="primary" @click="confirmReveal"><UiIcon name="eye" /> 确认揭示</UiButton><UiButton variant="ghost" @click="closeRevealDialog">取消</UiButton></section></div>
    <div v-if="editOpen && detail" class="dialog-overlay"><section ref="editDialog" class="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title" tabindex="-1" @keydown="onDialogKeydown"><header><h2 id="edit-title">编辑人工元数据</h2><button type="button" aria-label="关闭编辑" @click="closeEditDialog"><UiIcon name="x" /></button></header><label><span>标题</span><input v-model="editTitle" maxlength="200" required /></label><label><span>备注</span><textarea v-model="editNote" maxlength="2000" rows="4" /></label><div class="edit-dialog__row"><label><span>目录</span><select v-model="editFolderID"><option value="">收件箱</option><option v-for="folder in flatFolders" :key="folder.id" :value="folder.id">{{ '　'.repeat(folder.depth) }}{{ folder.name }}</option></select></label><label><span>敏感状态</span><select v-model="editSensitivity"><option value="normal">普通</option><option value="unknown">待确认</option><option value="sensitive">敏感</option></select></label></div><fieldset><legend>标签（最多 30 个）</legend><label v-for="tag in library.tags" :key="tag.id" class="tag-check"><input v-model="editTagIDs" type="checkbox" :value="tag.id" /> {{ tag.name }}</label><span v-if="!library.tags.length">尚无标签，可从资料库结构管理器创建。</span></fieldset><label class="favorite-check"><input v-model="editFavorite" type="checkbox" /> 收藏这条记录</label><p class="edit-dialog__notice">修改敏感状态只改变当前访问与外发策略，不会改写历史原始记录的声明。</p><p v-if="mutationError" class="mutation-error" role="alert">{{ mutationError }}</p><footer><UiButton variant="ghost" @click="closeEditDialog">取消</UiButton><UiButton variant="primary" :disabled="mutationBusy || !editTitle.trim()" @click="saveMetadata">{{ mutationBusy ? '正在保存' : '保存元数据' }}</UiButton></footer></section></div>
    <div v-if="deleteConfirm && detail" class="dialog-overlay"><section ref="deleteDialog" class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="trash-title" tabindex="-1" @keydown="onDialogKeydown"><UiIcon name="trash-2" :size="28" /><h2 id="trash-title">移入回收站？</h2><p>原始记录和附件会保留，但条目将从普通视图与搜索中消失。你仍可在回收站恢复。</p><p v-if="mutationError" class="mutation-error" role="alert">{{ mutationError }}</p><UiButton variant="danger" :disabled="mutationBusy" @click="trashItem">{{ mutationBusy ? '正在移动' : '移入回收站' }}</UiButton><UiButton variant="ghost" :disabled="mutationBusy" @click="closeTrashDialog">取消</UiButton></section></div>
  </Teleport>
</template>

<style scoped>
.detail-page { min-height: calc(100dvh - 79px); padding: var(--space-5); }
.detail-page--embedded { min-height: 0; }
.detail-state { display: grid; min-height: 60dvh; place-content: center; justify-items: center; color: var(--text-secondary); text-align: center; }
.detail-state--error > svg { color: var(--danger); }
.spinner { width: 28px; height: 28px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.detail-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); padding-bottom: var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.back-link { grid-column: 1 / -1; display: inline-flex; align-items: center; gap: var(--space-1); color: var(--text-secondary); text-decoration: none; }
.detail-header__main { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); }
.detail-header__main > div { min-width: 0; }
.detail-header__icon { display: grid; width: 44px; height: 44px; place-items: center; border-radius: var(--radius-control); background: var(--accent-soft); color: var(--accent); }
.detail-header__icon.sensitive { background: color-mix(in srgb, var(--sensitive) 12%, var(--bg-code)); color: var(--sensitive); }
.detail-header__main p, .detail-header__main h1 { margin: 0; }
.detail-header__main p { color: var(--text-muted); font-size: 11px; }
.detail-header__main h1 { overflow-wrap: anywhere; font-size: 21px; line-height: 1.3; }
.favorite, .trash-action { display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: transparent; color: var(--text-muted); cursor: pointer; }
.favorite .filled { fill: var(--warning); color: var(--warning); }
.detail-actions { display: flex; align-items: center; gap: var(--space-2); }
.detail-page--embedded .detail-header { grid-template-columns: minmax(0, 1fr); }
.detail-page--embedded .detail-actions { grid-column: 1; flex-wrap: wrap; margin-left: 56px; }
.trash-action { color: var(--danger); }
dl { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: var(--space-5); margin: var(--space-2) 0 0 56px; }
dl div { display: grid; gap: 1px; } dt { color: var(--text-muted); font-size: 10px; } dd { margin: 0; color: var(--text-secondary); font-size: 11px; }
.detail-notice { display: flex; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); }
.detail-tabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--border-subtle); }
.detail-tabs button { display: inline-flex; min-height: 48px; flex: none; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-muted); cursor: pointer; }
.detail-tabs button[aria-current='page'] { border-color: var(--accent); color: var(--text-primary); }
.detail-tabs button span { min-width: 20px; padding: 1px 5px; border-radius: 999px; background: var(--bg-elevated); font-size: 10px; }
.raw-layout { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: var(--space-4); padding-top: var(--space-4); }
.raw-history { padding-right: var(--space-3); border-right: 1px solid var(--border-subtle); }
.raw-history button { display: grid; width: 100%; gap: 2px; margin-bottom: var(--space-1); padding: var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }
.raw-history button.active { border-color: var(--border-strong); background: var(--bg-elevated); box-shadow: inset 2px 0 0 var(--accent); }
.raw-history span, .raw-history small { color: var(--text-muted); font-size: 10px; } .raw-history strong { font-size: 11px; }
.raw-panel { min-width: 0; }
.raw-panel > header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding-bottom: var(--space-3); }
.raw-panel header p, .raw-panel header h2 { margin: 0; } .raw-panel header p { color: var(--text-muted); font-size: 10px; } .raw-panel header h2 { font-size: 15px; }
.reveal-state { display: grid; min-height: 300px; place-content: center; justify-items: center; padding: var(--space-6); border: 1px dashed var(--border-strong); border-radius: var(--radius-card); color: var(--text-secondary); text-align: center; }
.reveal-state.sensitive { border-color: color-mix(in srgb, var(--sensitive) 60%, var(--border-subtle)); background: color-mix(in srgb, var(--sensitive) 7%, transparent); }
.reveal-state h3 { margin: var(--space-3) 0 var(--space-1); color: var(--text-primary); } .reveal-state p { max-width: 48ch; margin: 0 0 var(--space-4); color: var(--text-muted); }
.matched-fragment { margin-bottom: var(--space-3); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--accent) 60%, var(--border-subtle)); border-radius: var(--radius-control); background: var(--accent-soft); }
.matched-fragment strong { display: flex; align-items: center; gap: var(--space-1); color: var(--accent); font-size: 11px; }
.matched-fragment pre { max-height: 180px; margin: var(--space-2) 0 0; overflow: auto; color: var(--text-primary); font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; }
.raw-content { padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); }
.raw-attachments { margin-top: var(--space-4); } .raw-attachments h3 { font-size: 13px; }
.raw-attachments ul { display: grid; gap: var(--space-2); padding: 0; list-style: none; }
.raw-attachments li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-elevated); }
.raw-attachments li span, .raw-attachments li small { display: grid; min-width: 0; } .raw-attachments li strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .raw-attachments li small { color: var(--text-muted); }
.raw-attachments a, .raw-attachments li > button { display: inline-flex; align-items: center; gap: var(--space-1); border: 0; background: transparent; color: var(--accent); cursor: pointer; text-decoration: none; }
.attachments-panel, .history-panel { padding-top: var(--space-4); }
.attachment-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3); }
.attachment-grid article { min-width: 0; padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); }
.attachment-preview { display: grid; aspect-ratio: 16/10; place-content: center; justify-items: center; overflow: hidden; border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-muted); }
.attachment-preview img { width: 100%; height: 100%; object-fit: cover; } .attachment-preview span { margin-top: var(--space-2); font-size: 11px; }
.attachment-preview .preview-failed-icon { color: var(--danger); }
.attachment-preview .preview-retry { display: inline-flex; align-items: center; gap: var(--space-1); margin-top: var(--space-2); padding: 5px var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-elevated); color: var(--text-primary); font-size: 11px; cursor: pointer; }
.attachment-preview .preview-retry:hover { background: var(--accent-soft); }
.attachment-grid h3 { overflow: hidden; margin: var(--space-3) 0 0; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; } .attachment-grid p { margin: 2px 0 var(--space-3); color: var(--text-muted); font-size: 11px; }
.attachment-grid a { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--accent); text-decoration: none; }
.history-panel article { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); padding-bottom: var(--space-5); }
.history-panel__dot { width: 10px; height: 10px; margin-top: 5px; border: 2px solid var(--accent); border-radius: 50%; box-shadow: 0 0 0 5px var(--accent-soft); }
.history-panel p, .history-panel h3 { margin: 0; } .history-panel p { color: var(--text-muted); font-size: 10px; } .history-panel h3 { font-size: 14px; } .history-panel small { color: var(--text-secondary); }
.history-panel ul { display: grid; gap: var(--space-1); padding: 0; list-style: none; } .history-panel li { display: flex; gap: var(--space-2); color: var(--text-muted); font-size: 11px; }
.tab-empty { display: grid; min-height: 400px; place-content: center; justify-items: center; color: var(--text-muted); text-align: center; } .tab-empty h2 { margin: var(--space-3) 0 var(--space-1); color: var(--text-primary); font-size: 16px; } .tab-empty p { max-width: 46ch; margin: 0; }
.dialog-overlay { position: fixed; z-index: var(--layer-overlay); inset: 0; display: grid; place-content: center; padding: var(--space-4); background: var(--scrim); }
.confirm-dialog, .edit-dialog { width: min(440px, calc(100vw - 32px)); padding: var(--space-5); border: 1px solid var(--border-strong); border-radius: var(--radius-dialog); background: var(--bg-elevated); box-shadow: var(--shadow-overlay); }
.confirm-dialog > svg { color: var(--sensitive); } .confirm-dialog h2 { margin: var(--space-3) 0 var(--space-2); font-size: 19px; } .confirm-dialog p { color: var(--text-secondary); } .confirm-dialog button { width: 100%; margin-top: var(--space-2); }
.edit-dialog { width: min(600px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; }
.edit-dialog > header { display: flex; align-items: center; justify-content: space-between; } .edit-dialog header h2 { margin: 0; } .edit-dialog header button { display: grid; width: 44px; height: 44px; place-items: center; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.edit-dialog > label, .edit-dialog__row label { display: grid; gap: var(--space-1); margin-top: var(--space-3); color: var(--text-secondary); font-size: 11px; font-weight: 700; }
.edit-dialog input, .edit-dialog textarea, .edit-dialog select { width: 100%; padding: var(--space-2) var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
.edit-dialog__row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.edit-dialog fieldset { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); } .edit-dialog legend { color: var(--text-muted); font-size: 11px; } .tag-check, .favorite-check { display: inline-flex !important; align-items: center; gap: var(--space-1); font-weight: 400 !important; } .tag-check input, .favorite-check input { width: auto; }
.edit-dialog__notice { padding: var(--space-2); background: var(--accent-soft); color: var(--text-secondary); font-size: 11px; } .edit-dialog footer { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4); }
.mutation-error { color: var(--danger) !important; }
@media (max-width: 720px) { .detail-page { min-height: auto; padding: var(--space-3); } .detail-header { grid-template-columns: 1fr; } .detail-actions, .detail-page--embedded .detail-actions { flex-wrap: wrap; margin-left: 0; } .detail-actions button { flex: 1; } dl { margin-left: 0; } .raw-layout { grid-template-columns: 1fr; } .raw-history { display: flex; overflow-x: auto; gap: var(--space-2); padding: 0 0 var(--space-3); border-right: 0; border-bottom: 1px solid var(--border-subtle); } .raw-history button { min-width: 160px; margin: 0; } .edit-dialog__row { grid-template-columns: 1fr; } .confirm-dialog button, .edit-dialog footer button { min-height: 44px; } }
</style>

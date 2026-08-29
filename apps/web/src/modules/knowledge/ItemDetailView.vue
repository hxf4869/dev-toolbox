<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
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
  artifacts: unknown[]
  availableVersions: unknown[]
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

const props = withDefaults(defineProps<{ itemId: string; embedded?: boolean }>(), { embedded: false })
const emit = defineEmits<{ changed: []; deleted: [] }>()
const route = useRoute()
const auth = useAuthStore()
const library = useLibraryStore()
const loading = ref(true)
const errorMessage = ref('')
const detail = ref<ItemDetail | null>(null)
const heading = ref<HTMLElement | null>(null)
const matchAnchor = ref<HTMLElement | null>(null)
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
const mutationBusy = ref(false)
const mutationError = ref('')
const editTitle = ref('')
const editNote = ref('')
const editFolderID = ref('')
const editTagIDs = ref<string[]>([])
const editFavorite = ref(false)
const editSensitivity = ref<Sensitivity>('normal')
const matchedFragmentID = ref('')

const selectedSummary = computed(() =>
  detail.value?.rawRecords.find((record) => record.id === selectedRawID.value),
)
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

async function loadDetail() {
  loading.value = true
  errorMessage.value = ''
  rawRecord.value = null
  copied.value = false
  copyError.value = false
  sensitiveRevealed.value = false
  try {
    detail.value = await apiRequest<ItemDetail>(`/api/v1/items/${props.itemId}`)
    matchedFragmentID.value = typeof route.query.hit === 'string' ? route.query.hit : ''
    selectedRawID.value =
      detail.value.rawRecords.find((record) =>
        record.fragments.some((fragment) => fragment.id === matchedFragmentID.value),
      )?.id ?? detail.value.rawRecords[0]?.id ?? ''
    await nextTick()
    heading.value?.focus({ preventScroll: true })
  } catch (error) {
    detail.value = null
    errorMessage.value = error instanceof Error ? error.message : '详情暂时不可用'
  } finally {
    loading.value = false
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
    selectedRawID.value = targetRawID
    rawRecord.value = null
    copied.value = false
    copyError.value = false
    return
  }
  await nextTick()
  if (matchedFragment.value) matchAnchor.value?.scrollIntoView({ block: 'center' })
}

function requestReveal() {
  if (detail.value?.sensitivity === 'normal') {
    void revealRawRecord()
  } else {
    revealConfirm.value = true
  }
}

async function confirmReveal() {
  sensitiveRevealed.value = true
  revealConfirm.value = false
  await revealRawRecord()
}

async function revealRawRecord() {
  if (!selectedRawID.value || !detail.value) return
  rawLoading.value = true
  errorMessage.value = ''
  try {
    rawRecord.value = await apiRequest<RawRecord>(
      `/api/v1/items/${detail.value.id}/raw-records/${selectedRawID.value}`,
    )
    await nextTick()
    if (matchedFragment.value) {
      matchAnchor.value?.scrollIntoView({ block: 'center' })
      matchAnchor.value?.focus()
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '原始记录暂时不可用'
  } finally {
    rawLoading.value = false
  }
}

function selectRawRecord(id: string) {
  if (id === selectedRawID.value) return
  selectedRawID.value = id
  rawRecord.value = null
  copied.value = false
  copyError.value = false
}

async function copyAll() {
  if (!rawRecord.value) return
  copyError.value = false
  try {
    await navigator.clipboard.writeText(rawRecord.value.body)
    copied.value = true
    window.setTimeout(() => (copied.value = false), 1600)
  } catch {
    copied.value = false
    copyError.value = true
  }
}

async function beginEdit() {
  if (!detail.value) return
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
  mutationError.value = ''
  editOpen.value = true
}

async function saveMetadata() {
  if (!detail.value || !editTitle.value.trim()) return
  mutationBusy.value = true
  mutationError.value = ''
  try {
    await apiRequest(
      `/api/v1/items/${detail.value.id}`,
      jsonRequest(
        'PATCH',
        {
          title: editTitle.value,
          note: editNote.value.trim() ? editNote.value : null,
          folderId: editFolderID.value || null,
          tagIds: editTagIDs.value,
          favorite: editFavorite.value,
          sensitivity: editSensitivity.value,
        },
        auth.csrfToken,
      ),
    )
    editOpen.value = false
    await Promise.all([loadDetail(), library.loadNavigation()])
    emit('changed')
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : '元数据保存失败'
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
          <UiButton variant="secondary" @click="supplementOpen = true"><UiIcon name="plus" /> 添加补充</UiButton>
          <UiButton variant="secondary" @click="beginEdit"><UiIcon name="pencil" /> 编辑元数据</UiButton>
          <button type="button" class="trash-action" aria-label="移入回收站" @click="deleteConfirm = true"><UiIcon name="trash-2" /></button>
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
          <header><div><p>原始记录 · 只读</p><h2>{{ selectedSummary?.contentKind ?? '原始内容' }}</h2></div><UiButton v-if="rawRecord" variant="secondary" @click="copyAll"><UiIcon name="copy" /> {{ copied ? '已复制全部' : copyError ? '复制失败，重试' : '复制全部原文' }}</UiButton></header>
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
            <article class="raw-content"><RawDocument :body="rawRecord.body" :content-format="rawRecord.contentFormat" /></article>
          </template>
          <section v-if="selectedSummary?.attachments.length" class="raw-attachments"><h3>本条原始记录的附件</h3><ul><li v-for="attachment in selectedSummary.attachments" :key="attachment.id"><UiIcon :name="attachment.kind === 'image' ? 'image' : 'file-text'" /><span><strong>{{ attachment.displayName }}</strong><small>{{ attachment.mediaType }} · {{ formatBytes(attachment.sizeBytes) }}</small></span><a v-if="detail.sensitivity === 'normal' || sensitiveRevealed" :href="attachment.contentUrl" download><UiIcon name="download" /> 下载原件</a><button v-else type="button" @click="requestReveal"><UiIcon name="eye" /> 揭示后下载</button></li></ul></section>
        </main>
      </div>

      <section v-else-if="activeTab === 'attachments'" class="attachments-panel">
        <div v-if="detail.attachments.length" class="attachment-grid">
          <article v-for="attachment in detail.attachments" :key="attachment.id">
            <div class="attachment-preview">
              <img v-if="attachment.previewAllowed && attachment.thumbnailUrl && (detail.sensitivity === 'normal' || sensitiveRevealed)" :src="attachment.thumbnailUrl" :alt="attachment.displayName" />
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

      <section v-else class="tab-empty"><UiIcon name="sparkles" :size="30" /><h2>暂无 AI 派生版本</h2><p>原始记录、附件和人工元数据仍可完整使用；AI 结果不会覆盖事实层。</p></section>
    </template>
  </section>

  <SupplementDrawer v-if="detail" :open="supplementOpen" :item-id="detail.id" :raw-records="detail.rawRecords" :current-sensitivity="detail.sensitivity" @close="supplementOpen = false" @created="onSupplementCreated" />

  <Teleport to="body">
    <div v-if="revealConfirm" class="dialog-overlay"><section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reveal-title"><UiIcon name="shield-alert" :size="28" /><h2 id="reveal-title">揭示敏感原文与附件？</h2><p>内容将在当前页面内读取和显示。请确认周围环境安全，复制后也需自行保护剪贴板。</p><UiButton variant="primary" @click="confirmReveal"><UiIcon name="eye" /> 确认揭示</UiButton><UiButton variant="ghost" @click="revealConfirm = false">取消</UiButton></section></div>
    <div v-if="editOpen && detail" class="dialog-overlay"><section class="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title"><header><h2 id="edit-title">编辑人工元数据</h2><button type="button" aria-label="关闭编辑" @click="editOpen = false"><UiIcon name="x" /></button></header><label><span>标题</span><input v-model="editTitle" maxlength="200" required /></label><label><span>备注</span><textarea v-model="editNote" maxlength="2000" rows="4" /></label><div class="edit-dialog__row"><label><span>目录</span><select v-model="editFolderID"><option value="">收件箱</option><option v-for="folder in flatFolders" :key="folder.id" :value="folder.id">{{ '　'.repeat(folder.depth) }}{{ folder.name }}</option></select></label><label><span>敏感状态</span><select v-model="editSensitivity"><option value="normal">普通</option><option value="unknown">待确认</option><option value="sensitive">敏感</option></select></label></div><fieldset><legend>标签（最多 30 个）</legend><label v-for="tag in library.tags" :key="tag.id" class="tag-check"><input v-model="editTagIDs" type="checkbox" :value="tag.id" /> {{ tag.name }}</label><span v-if="!library.tags.length">尚无标签，可从资料库结构管理器创建。</span></fieldset><label class="favorite-check"><input v-model="editFavorite" type="checkbox" /> 收藏这条记录</label><p class="edit-dialog__notice">修改敏感状态只改变当前访问与外发策略，不会改写历史原始记录的声明。</p><p v-if="mutationError" class="mutation-error" role="alert">{{ mutationError }}</p><footer><UiButton variant="ghost" @click="editOpen = false">取消</UiButton><UiButton variant="primary" :disabled="mutationBusy || !editTitle.trim()" @click="saveMetadata">{{ mutationBusy ? '正在保存' : '保存元数据' }}</UiButton></footer></section></div>
    <div v-if="deleteConfirm && detail" class="dialog-overlay"><section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="trash-title"><UiIcon name="trash-2" :size="28" /><h2 id="trash-title">移入回收站？</h2><p>原始记录和附件会保留，但条目将从普通视图与搜索中消失。你仍可在回收站恢复。</p><p v-if="mutationError" class="mutation-error" role="alert">{{ mutationError }}</p><UiButton variant="danger" :disabled="mutationBusy" @click="trashItem">{{ mutationBusy ? '正在移动' : '移入回收站' }}</UiButton><UiButton variant="ghost" :disabled="mutationBusy" @click="deleteConfirm = false">取消</UiButton></section></div>
  </Teleport>
</template>

<style scoped>
.detail-page { min-height: calc(100dvh - 79px); padding: var(--space-5); }
.detail-state { display: grid; min-height: 60dvh; place-content: center; justify-items: center; color: var(--text-secondary); text-align: center; }
.detail-state--error > svg { color: var(--danger); }
.spinner { width: 28px; height: 28px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.detail-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); padding-bottom: var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.back-link { grid-column: 1 / -1; display: inline-flex; align-items: center; gap: var(--space-1); color: var(--text-secondary); text-decoration: none; }
.detail-header__main { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); }
.detail-header__icon { display: grid; width: 44px; height: 44px; place-items: center; border-radius: var(--radius-control); background: var(--accent-soft); color: var(--accent); }
.detail-header__icon.sensitive { background: color-mix(in srgb, var(--sensitive) 12%, var(--bg-code)); color: var(--sensitive); }
.detail-header__main p, .detail-header__main h1 { margin: 0; }
.detail-header__main p { color: var(--text-muted); font-size: 11px; }
.detail-header__main h1 { overflow-wrap: anywhere; font-size: 21px; line-height: 1.3; }
.favorite, .trash-action { display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: transparent; color: var(--text-muted); cursor: pointer; }
.favorite .filled { fill: var(--warning); color: var(--warning); }
.detail-actions { display: flex; align-items: center; gap: var(--space-2); }
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
.edit-dialog > header { display: flex; align-items: center; justify-content: space-between; } .edit-dialog header h2 { margin: 0; } .edit-dialog header button { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.edit-dialog > label, .edit-dialog__row label { display: grid; gap: var(--space-1); margin-top: var(--space-3); color: var(--text-secondary); font-size: 11px; font-weight: 700; }
.edit-dialog input, .edit-dialog textarea, .edit-dialog select { width: 100%; padding: var(--space-2) var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
.edit-dialog__row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.edit-dialog fieldset { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); } .edit-dialog legend { color: var(--text-muted); font-size: 11px; } .tag-check, .favorite-check { display: inline-flex !important; align-items: center; gap: var(--space-1); font-weight: 400 !important; } .tag-check input, .favorite-check input { width: auto; }
.edit-dialog__notice { padding: var(--space-2); background: var(--accent-soft); color: var(--text-secondary); font-size: 11px; } .edit-dialog footer { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4); }
.mutation-error { color: var(--danger) !important; }
@media (max-width: 720px) { .detail-page { min-height: auto; padding: var(--space-3); } .detail-header { grid-template-columns: 1fr; } .detail-actions { flex-wrap: wrap; } .detail-actions button { flex: 1; } dl { margin-left: 0; } .raw-layout { grid-template-columns: 1fr; } .raw-history { display: flex; overflow-x: auto; gap: var(--space-2); padding: 0 0 var(--space-3); border-right: 0; border-bottom: 1px solid var(--border-subtle); } .raw-history button { min-width: 160px; margin: 0; } .edit-dialog__row { grid-template-columns: 1fr; } }
</style>

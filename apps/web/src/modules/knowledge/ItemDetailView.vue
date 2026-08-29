<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest } from '../../lib/api'
import SafeMarkdown from './SafeMarkdown.vue'

interface Attachment {
  id: string
  kind: 'image' | 'file'
  displayName: string
  mediaType: string
  sizeBytes: number
  width?: number | null
  height?: number | null
  createdAt: string
}

interface RawRecordSummary {
  id: string
  recordRole: string
  sourceType: string
  contentKind: string
  contentFormat: 'plain_text' | 'markdown'
  declaredSensitivity: 'normal' | 'sensitive' | 'unknown'
  capturedAt: string
  effectiveCapturedAt: string
  sourceTimeQuality: string
  createdAt: string
  attachments: Attachment[]
}

interface ItemDetail {
  id: string
  title: string
  titleOrigin: string
  note?: string | null
  sensitivity: 'normal' | 'sensitive' | 'unknown'
  favorite: boolean
  createdAt: string
  updatedAt: string
  rawRecords: RawRecordSummary[]
  attachments: Attachment[]
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

const route = useRoute()
const loading = ref(true)
const errorMessage = ref('')
const detail = ref<ItemDetail | null>(null)
const selectedRawID = ref('')
const rawRecord = ref<RawRecord | null>(null)
const rawLoading = ref(false)
const copied = ref(false)

const selectedSummary = computed(() =>
  detail.value?.rawRecords.find((record) => record.id === selectedRawID.value),
)

onMounted(() => void loadDetail())

async function loadDetail() {
  loading.value = true
  errorMessage.value = ''
  try {
    detail.value = await apiRequest<ItemDetail>(`/api/v1/items/${String(route.params.itemId)}`)
    selectedRawID.value = detail.value.rawRecords[0]?.id ?? ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '详情暂时不可用'
  } finally {
    loading.value = false
  }
}

async function revealRawRecord() {
  if (!selectedRawID.value || !detail.value) return
  rawLoading.value = true
  errorMessage.value = ''
  try {
    rawRecord.value = await apiRequest<RawRecord>(
      `/api/v1/items/${detail.value.id}/raw-records/${selectedRawID.value}`,
    )
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
}

async function copyAll() {
  if (!rawRecord.value) return
  await navigator.clipboard.writeText(rawRecord.value.body)
  copied.value = true
  window.setTimeout(() => (copied.value = false), 1600)
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
  <section class="detail-page">
    <div v-if="loading" class="detail-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>正在读取记录元数据…</p>
    </div>

    <div v-else-if="!detail" class="detail-state detail-state--error" role="alert">
      <UiIcon name="triangle-alert" :size="26" />
      <h1>记录暂时不可用</h1>
      <p>{{ errorMessage }}</p>
      <RouterLink to="/">返回收件箱</RouterLink>
    </div>

    <template v-else>
      <header class="detail-header">
        <RouterLink class="back-link" to="/"><UiIcon name="chevron-left" /> 返回收件箱</RouterLink>
        <div class="detail-header__title">
          <span class="detail-header__icon" :class="{ sensitive: detail.sensitivity !== 'normal' }">
            <UiIcon :name="detail.sensitivity === 'normal' ? 'file-text' : 'shield-alert'" />
          </span>
          <div>
            <p>知识条目 · {{ detail.rawRecords.length }} 条原始记录</p>
            <h1>{{ detail.title }}</h1>
          </div>
          <span v-if="detail.sensitivity !== 'normal'" class="sensitivity-label">敏感</span>
        </div>
        <dl>
          <div><dt>创建时间</dt><dd>{{ formatTime(detail.createdAt) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ formatTime(detail.updatedAt) }}</dd></div>
          <div><dt>标题来源</dt><dd>{{ detail.titleOrigin === 'generated' ? '系统确定性生成' : '用户设置' }}</dd></div>
        </dl>
      </header>

      <div v-if="errorMessage" class="detail-notice detail-notice--error" role="alert">
        <UiIcon name="triangle-alert" /> {{ errorMessage }}
      </div>

      <div class="detail-layout">
        <aside class="history" aria-label="原始记录历史">
          <h2>来源与历史</h2>
          <button
            v-for="record in detail.rawRecords"
            :key="record.id"
            type="button"
            :class="{ active: selectedRawID === record.id }"
            @click="selectRawRecord(record.id)"
          >
            <span>{{ record.recordRole === 'primary' ? '主记录' : '补充记录' }}</span>
            <strong>{{ formatTime(record.effectiveCapturedAt) }}</strong>
            <small>{{ record.sourceType }} · {{ record.sourceTimeQuality }}</small>
          </button>
        </aside>

        <main class="raw-panel">
          <header>
            <div>
              <p>原始记录 · 只读</p>
              <h2>{{ selectedSummary?.contentKind ?? '原始内容' }}</h2>
            </div>
            <UiButton v-if="rawRecord" variant="secondary" @click="copyAll">
              <UiIcon name="copy" /> {{ copied ? '已复制' : '复制全部' }}
            </UiButton>
          </header>

          <div v-if="!rawRecord" class="reveal-state" :class="{ sensitive: detail.sensitivity !== 'normal' }">
            <UiIcon :name="detail.sensitivity === 'normal' ? 'eye' : 'shield-alert'" :size="25" />
            <h3>{{ detail.sensitivity === 'normal' ? '按需读取原始记录' : '敏感原文尚未读取' }}</h3>
            <p>
              {{
                detail.sensitivity === 'normal'
                  ? '详情元数据不携带正文。打开后将从只读端点获取完整原文。'
                  : '列表与当前页面未预载敏感正文；仅在你明确操作后读取。'
              }}
            </p>
            <UiButton variant="primary" :disabled="rawLoading" @click="revealRawRecord">
              <UiIcon name="eye" /> {{ rawLoading ? '正在读取' : '查看原始记录' }}
            </UiButton>
          </div>

          <article v-else class="raw-content">
            <SafeMarkdown v-if="rawRecord.contentFormat === 'markdown'" :source="rawRecord.body" />
            <pre v-else>{{ rawRecord.body }}</pre>
          </article>

          <section v-if="selectedSummary?.attachments.length" class="detail-attachments" aria-labelledby="detail-attachments-title">
            <h3 id="detail-attachments-title">原始附件</h3>
            <ul>
              <li v-for="attachment in selectedSummary.attachments" :key="attachment.id">
                <UiIcon :name="attachment.kind === 'image' ? 'image' : 'file-text'" />
                <span><strong>{{ attachment.displayName }}</strong><small>{{ attachment.mediaType }} · {{ formatBytes(attachment.sizeBytes) }}</small></span>
                <a :href="`/api/v1/attachments/${attachment.id}/content`" download>
                  <UiIcon name="download" /> 下载原件
                </a>
              </li>
            </ul>
          </section>
        </main>
      </div>
    </template>
  </section>
</template>

<style scoped>
.detail-page { width: min(100%, var(--content-max)); min-height: 100dvh; padding: var(--space-6); }
.detail-state { display: grid; min-height: 70dvh; place-content: center; justify-items: center; color: var(--text-secondary); text-align: center; }
.detail-state--error > svg { color: var(--danger); }
.spinner { width: 28px; height: 28px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.detail-header { padding-bottom: var(--space-5); border-bottom: 1px solid var(--border-subtle); }
.back-link { display: inline-flex; align-items: center; gap: var(--space-1); margin-bottom: var(--space-5); color: var(--text-secondary); text-decoration: none; }
.detail-header__title { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); }
.detail-header__icon { display: inline-grid; width: 44px; height: 44px; place-items: center; border-radius: var(--radius-control); background: var(--accent-soft); color: var(--accent); }
.detail-header__icon.sensitive { background: color-mix(in srgb, var(--sensitive) 12%, var(--bg-code)); color: var(--sensitive); }
.detail-header p, .detail-header h1 { margin: 0; }
.detail-header p { color: var(--text-muted); font-size: 12px; }
.detail-header h1 { margin-top: 2px; font-size: 23px; overflow-wrap: anywhere; }
.sensitivity-label { padding: 4px var(--space-2); border-radius: 999px; background: color-mix(in srgb, var(--sensitive) 12%, var(--bg-code)); color: var(--sensitive); font-size: 11px; font-weight: 700; }
dl { display: flex; flex-wrap: wrap; gap: var(--space-5); margin: var(--space-5) 0 0 56px; }
dl div { display: grid; gap: 2px; }
dt { color: var(--text-muted); font-size: 11px; }
dd { margin: 0; color: var(--text-secondary); font-size: 12px; }
.detail-notice { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-4); padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); }
.detail-notice--error { border-color: var(--danger); color: var(--danger); }
.detail-layout { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: var(--space-5); margin-top: var(--space-5); }
.history { padding-right: var(--space-4); border-right: 1px solid var(--border-subtle); }
.history h2 { margin: 0 0 var(--space-3); color: var(--text-muted); font-size: 12px; text-transform: uppercase; }
.history button { display: grid; width: 100%; gap: 2px; margin-bottom: var(--space-2); padding: var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }
.history button.active { border-color: var(--border-strong); background: var(--bg-elevated); box-shadow: inset 2px 0 0 var(--accent); }
.history button span, .history button small { color: var(--text-muted); font-size: 10px; }
.history button strong { font-size: 12px; }
.raw-panel { min-width: 0; }
.raw-panel > header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding-bottom: var(--space-3); }
.raw-panel header p, .raw-panel header h2 { margin: 0; }
.raw-panel header p { color: var(--text-muted); font-size: 11px; }
.raw-panel header h2 { font-size: 16px; text-transform: capitalize; }
.reveal-state { display: grid; min-height: 300px; place-content: center; justify-items: center; padding: var(--space-8); border: 1px dashed var(--border-strong); border-radius: var(--radius-card); color: var(--text-secondary); text-align: center; }
.reveal-state.sensitive { border-color: color-mix(in srgb, var(--sensitive) 60%, var(--border-subtle)); background: color-mix(in srgb, var(--sensitive) 7%, transparent); }
.reveal-state h3 { margin: var(--space-3) 0 var(--space-2); color: var(--text-primary); }
.reveal-state p { max-width: 48ch; margin: 0 0 var(--space-4); color: var(--text-muted); }
.raw-content { padding: var(--space-5); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); }
.raw-content > pre { max-width: 100%; margin: 0; overflow-x: auto; color: var(--text-primary); font-family: var(--font-mono); font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.detail-attachments { margin-top: var(--space-5); }
.detail-attachments h3 { margin: 0 0 var(--space-3); font-size: 14px; }
.detail-attachments ul { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.detail-attachments li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-elevated); }
.detail-attachments li span, .detail-attachments li small { display: block; min-width: 0; }
.detail-attachments li strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-attachments li small { color: var(--text-muted); }
.detail-attachments a { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--accent); text-decoration: none; }
@media (max-width: 760px) {
  .detail-page { padding: var(--space-4); }
  .detail-layout { grid-template-columns: 1fr; }
  .history { display: flex; overflow-x: auto; gap: var(--space-2); padding: 0 0 var(--space-3); border-right: 0; border-bottom: 1px solid var(--border-subtle); }
  .history h2 { display: none; }
  .history button { min-width: 160px; margin: 0; }
  dl { margin-left: 0; }
  .detail-header__title { grid-template-columns: auto minmax(0, 1fr); }
  .sensitivity-label { display: none; }
  .raw-content { padding: var(--space-3); }
  .detail-attachments li { grid-template-columns: auto minmax(0, 1fr); }
  .detail-attachments a { grid-column: 2; }
}
</style>

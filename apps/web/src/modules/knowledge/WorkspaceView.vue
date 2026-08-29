<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest } from '../../lib/api'
import QuickCaptureDrawer from './QuickCaptureDrawer.vue'

interface Item {
  id: string
  title: string
  sensitivity: 'normal' | 'sensitive' | 'unknown'
  favorite?: boolean
  createdAt: string
  updatedAt?: string
  effectiveCapturedAt?: string
  rawRecordCount?: number
  attachmentCount?: number
}

const captureOpen = ref(false)
const loading = ref(true)
const loadError = ref('')
const items = ref<Item[]>([])

onMounted(() => {
  window.addEventListener('keydown', onGlobalShortcut)
  void loadItems()
})

onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalShortcut))

async function loadItems() {
  loading.value = true
  loadError.value = ''
  try {
    const response = await apiRequest<{ items: Item[] }>('/api/v1/items?view=inbox&limit=30')
    items.value = response.items
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '列表暂时不可用'
  } finally {
    loading.value = false
  }
}

function onGlobalShortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Enter') {
    event.preventDefault()
    captureOpen.value = true
  }
}

function onCreated(item: Item) {
  items.value = [item, ...items.value.filter((existing) => existing.id !== item.id)]
}

function formatTime(value?: string) {
  if (!value) return '刚刚'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
</script>

<template>
  <section class="workspace" aria-labelledby="workspace-heading">
    <header class="workspace__header">
      <div>
        <p class="workspace__eyebrow">知识与记录</p>
        <h2 id="workspace-heading">原始收件箱</h2>
      </div>
      <UiButton
        variant="primary"
        aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter"
        @click="captureOpen = true"
      >
        <UiIcon name="plus" />
        快速记录
      </UiButton>
    </header>

    <div v-if="loading" class="workspace__state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <h3>正在读取原始收件箱</h3>
      <p>列表不会加载完整原文。</p>
    </div>

    <div v-else-if="loadError" class="workspace__state workspace__state--error" role="alert">
      <UiIcon name="triangle-alert" :size="24" />
      <h3>暂时无法读取记录</h3>
      <p>{{ loadError }}</p>
      <UiButton variant="secondary" @click="loadItems"><UiIcon name="rotate-ccw" /> 重试</UiButton>
    </div>

    <div v-else-if="items.length === 0" class="workspace__state">
      <UiIcon name="inbox" :size="26" />
      <h3>从第一条原始记录开始</h3>
      <p>粘贴命令、排查过程或添加附件；保存不依赖 Provider 与 AI worker。</p>
      <UiButton variant="primary" @click="captureOpen = true"><UiIcon name="plus" /> 新建记录</UiButton>
    </div>

    <ol v-else class="record-list" aria-label="原始收件箱记录">
      <li v-for="item in items" :key="item.id">
        <RouterLink :to="`/items/${item.id}`">
          <span class="record-list__icon" :class="{ sensitive: item.sensitivity !== 'normal' }">
            <UiIcon :name="item.sensitivity === 'normal' ? 'file-text' : 'shield-alert'" />
          </span>
          <span class="record-list__content">
            <strong>{{ item.title }}</strong>
            <small>
              {{ formatTime(item.effectiveCapturedAt || item.createdAt) }}
              <template v-if="item.attachmentCount"> · {{ item.attachmentCount }} 个附件</template>
              · 原始记录只读
            </small>
          </span>
          <span v-if="item.sensitivity !== 'normal'" class="sensitivity-label">敏感</span>
          <UiIcon name="chevron-right" />
        </RouterLink>
      </li>
    </ol>

    <p class="workspace__shortcut"><kbd>⌘/Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Enter</kbd> 随时快速记录</p>
  </section>

  <QuickCaptureDrawer :open="captureOpen" @close="captureOpen = false" @created="onCreated" />
</template>

<style scoped>
.workspace { width: min(100%, var(--content-max)); min-height: 100dvh; padding: var(--space-6); }
.workspace__header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding-bottom: var(--space-5); border-bottom: 1px solid var(--border-subtle); }
.workspace__eyebrow { margin: 0 0 var(--space-1); color: var(--text-muted); font-size: 12px; }
h2, h3, p { margin-top: 0; }
h2 { margin-bottom: 0; font-size: 20px; line-height: 1.3; }
.workspace__state { display: grid; min-height: 360px; place-content: center; justify-items: center; padding: var(--space-8); color: var(--text-secondary); text-align: center; }
.workspace__state h3 { margin: var(--space-4) 0 var(--space-2); color: var(--text-primary); font-size: 16px; }
.workspace__state p { max-width: 50ch; color: var(--text-muted); }
.workspace__state--error > svg { color: var(--danger); }
.spinner { width: 26px; height: 26px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.record-list { display: grid; gap: var(--space-2); margin: var(--space-5) 0; padding: 0; list-style: none; }
.record-list a { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); min-height: 68px; padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); color: var(--text-primary); text-decoration: none; }
.record-list a:hover { border-color: var(--border-strong); background: color-mix(in srgb, var(--accent-soft) 55%, var(--bg-elevated)); }
.record-list__icon { display: inline-grid; width: 38px; height: 38px; place-items: center; border-radius: var(--radius-control); background: var(--accent-soft); color: var(--accent); }
.record-list__icon.sensitive { background: color-mix(in srgb, var(--sensitive) 12%, var(--bg-code)); color: var(--sensitive); }
.record-list__content, .record-list__content small { display: block; min-width: 0; }
.record-list__content strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.record-list__content small { margin-top: 3px; color: var(--text-muted); }
.sensitivity-label { padding: 3px var(--space-2); border-radius: 999px; background: color-mix(in srgb, var(--sensitive) 12%, var(--bg-code)); color: var(--sensitive); font-size: 11px; font-weight: 700; }
.workspace__shortcut { color: var(--text-muted); font-size: 11px; text-align: right; }
kbd { padding: 2px 5px; border: 1px solid var(--border-strong); border-radius: 3px; background: var(--bg-code); font-family: var(--font-mono); }
@media (max-width: 599px) {
  .workspace { min-height: auto; padding: var(--space-4); }
  .workspace__header { align-items: flex-start; }
  .workspace__header button { min-width: 42px; padding-inline: var(--space-3); }
  .record-list a { grid-template-columns: auto minmax(0, 1fr) auto; }
  .sensitivity-label, .workspace__shortcut { display: none; }
}
</style>

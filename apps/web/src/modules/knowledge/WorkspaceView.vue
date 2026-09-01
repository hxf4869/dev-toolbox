<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
import ItemDetailView from './ItemDetailView.vue'
import QuickCaptureDrawer from './QuickCaptureDrawer.vue'
import {
  type LibraryFilters,
  type LibraryItem,
  resolveLibraryView,
  type SearchItem,
  useLibraryStore,
} from './library'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const library = useLibraryStore()
const captureOpen = ref(false)
const online = ref(navigator.onLine)
const searchInput = ref<HTMLInputElement | null>(null)
const resultList = ref<HTMLOListElement | null>(null)
const filtersOpen = ref(false)
const purgeTarget = ref<{ id: string; title: string } | null>(null)
const destructiveBusy = ref(false)
const destructiveError = ref('')
const contentKindOptions = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'file', label: '文件' },
  { value: 'mixed', label: '混合' },
] as const
const sensitivityOptions = [
  { value: 'normal', label: '普通' },
  { value: 'unknown', label: '待确认' },
  { value: 'sensitive', label: '敏感' },
] as const

const selectedItemID = computed(() =>
  route.name === 'item-detail' ? String(route.params.itemId ?? '') : '',
)
const filters = computed<LibraryFilters>(() => ({
  view: resolveLibraryView(route.query.view, route.query.folderId, route.query.tagId),
  folderId: typeof route.query.folderId === 'string' ? route.query.folderId : undefined,
  tagId: typeof route.query.tagId === 'string' ? route.query.tagId : undefined,
  sort:
    route.query.sort === 'effective_desc' || route.query.sort === 'updated_desc'
      ? route.query.sort
      : route.query.view === 'recent'
        ? 'effective_desc'
        : 'updated_desc',
  contentKinds: queryValues(route.query.kind).filter(isContentKind),
  sensitivity: queryValues(route.query.sensitivity).filter(isSensitivity),
  from: dateBoundary(route.query.from, false),
  to: dateBoundary(route.query.to, true),
}))
const viewTitle = computed(() => {
  if (filters.value.folderId) {
    return findFolderName(library.folders, filters.value.folderId) ?? '目录'
  }
  if (filters.value.tagId) {
    return library.tags.find((tag) => tag.id === filters.value.tagId)?.name ?? '标签'
  }
  return (
    {
      inbox: '原始收件箱',
      recent: '最近记录',
      favorites: '收藏',
      sensitive: '敏感记录',
      images: '图片',
      files: '文件',
      trash: '回收站',
    }[filters.value.view ?? 'inbox'] ?? '资料库'
  )
})
const isTrash = computed(() => filters.value.view === 'trash')
const activeFilterChips = computed(() => {
  const chips: Array<{ key: string; value: string; label: string }> = []
  if (filters.value.folderId) {
    chips.push({ key: 'folderId', value: filters.value.folderId, label: `目录：${findFolderName(library.folders, filters.value.folderId) ?? '已选择'}` })
  }
  if (filters.value.tagId) {
    chips.push({ key: 'tagId', value: filters.value.tagId, label: `标签：${library.tags.find((tag) => tag.id === filters.value.tagId)?.name ?? '已选择'}` })
  }
  const kindLabels = { text: '文本', image: '图片', file: '文件', mixed: '混合' }
  for (const kind of filters.value.contentKinds ?? []) chips.push({ key: 'kind', value: kind, label: `类型：${kindLabels[kind]}` })
  const sensitivityLabels = { normal: '普通', unknown: '待确认', sensitive: '敏感' }
  for (const value of filters.value.sensitivity ?? []) chips.push({ key: 'sensitivity', value, label: `敏感状态：${sensitivityLabels[value]}` })
  if (typeof route.query.from === 'string') chips.push({ key: 'from', value: route.query.from, label: `起始：${route.query.from}` })
  if (typeof route.query.to === 'string') chips.push({ key: 'to', value: route.query.to, label: `截止：${route.query.to}` })
  return chips
})
let debounceTimer: number | undefined

watch(
  () => JSON.stringify(route.query),
  () => void refreshResults(),
  { immediate: true },
)

watch(
  () => library.query,
  () => {
    window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => void refreshResults(), 200)
  },
)

onMounted(() => {
  window.addEventListener('keydown', onGlobalShortcut)
  window.addEventListener('online', updateOnline)
  window.addEventListener('offline', updateOnline)
})

onBeforeUnmount(() => {
  window.clearTimeout(debounceTimer)
  window.removeEventListener('keydown', onGlobalShortcut)
  window.removeEventListener('online', updateOnline)
  window.removeEventListener('offline', updateOnline)
})

function updateOnline() {
  online.value = navigator.onLine
}

function onGlobalShortcut(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  const editable = target?.matches('input, textarea, select, [contenteditable="true"]')
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !editable) {
    event.preventDefault()
    searchInput.value?.focus()
    return
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Enter') {
    event.preventDefault()
    captureOpen.value = true
  }
}

async function submitSearch() {
  window.clearTimeout(debounceTimer)
  await refreshResults()
}

function clearSearch() {
  library.clearSearch()
  searchInput.value?.focus()
}

async function refreshResults() {
  if (library.query.trim()) await library.search(filters.value)
  else await library.browse(filters.value)
}

async function changeSort(event: Event) {
  const sort = (event.target as HTMLSelectElement).value
  await router.replace({
    query: { ...route.query, sort: sort === 'effective_desc' ? 'effective_desc' : 'updated_desc' },
  })
}

function detailLocation(entry: (typeof library.results)[number]) {
  const matchedFragmentId = searchEntry(entry)?.matchedFragmentId
  return {
    name: 'item-detail',
    params: { itemId: entryID(entry) },
    query: { ...route.query, hit: matchedFragmentId ?? undefined },
  }
}

function entryID(entry: (typeof library.results)[number]) {
  return entry.kind === 'library' ? entry.item.id : entry.item.itemId
}

function entryTitle(entry: (typeof library.results)[number]) {
  return entry.item.title
}

function entrySensitivity(entry: (typeof library.results)[number]) {
  return entry.item.sensitivity
}

function entryTime(entry: (typeof library.results)[number]) {
  return entry.item.effectiveCapturedAt
}

function libraryEntry(entry: (typeof library.results)[number]): LibraryItem | null {
  return entry.kind === 'library' ? entry.item : null
}

function searchEntry(entry: (typeof library.results)[number]): SearchItem | null {
  return entry.kind === 'search' ? entry.item : null
}

async function loadMore() {
  if (!library.nextCursor) return
  if (library.mode === 'search') await library.search(filters.value, library.nextCursor)
  else await library.browse(filters.value, library.nextCursor)
}

async function restoreItem(id: string) {
  destructiveBusy.value = true
  destructiveError.value = ''
  try {
    await apiRequest(`/api/v1/items/${id}/restore`, jsonRequest('POST', {}, auth.csrfToken))
    await Promise.all([library.browse(filters.value), library.loadNavigation()])
  } catch (error) {
    destructiveError.value = error instanceof Error ? error.message : '恢复失败'
  } finally {
    destructiveBusy.value = false
  }
}

async function purgeItem() {
  if (!purgeTarget.value) return
  destructiveBusy.value = true
  destructiveError.value = ''
  try {
    const target = purgeTarget.value
    await apiRequest(
      `/api/v1/items/${target.id}/purge`,
      jsonRequest('DELETE', { confirmItemId: target.id }, auth.csrfToken),
    )
    purgeTarget.value = null
    await Promise.all([library.browse(filters.value), library.loadNavigation()])
  } catch (error) {
    destructiveError.value = error instanceof Error ? error.message : '永久删除失败'
  } finally {
    destructiveBusy.value = false
  }
}

async function onCreated() {
  await Promise.all([refreshResults(), library.loadNavigation()])
}

async function onDetailChanged() {
  await Promise.all([refreshResults(), library.loadNavigation()])
}

async function onDetailDeleted() {
  await router.push({ name: 'workspace', query: route.query })
  await onDetailChanged()
}

function findFolderName(entries: typeof library.folders, id: string): string | null {
  for (const entry of entries) {
    if (entry.id === id) return entry.name
    const nested = findFolderName(entry.children, id)
    if (nested) return nested
  }
  return null
}

function queryValues(value: unknown): string[] {
  if (typeof value === 'string') return value.split(',').filter(Boolean)
  if (Array.isArray(value)) return value.flatMap((entry) => String(entry).split(',')).filter(Boolean)
  return []
}

function isContentKind(value: string): value is NonNullable<LibraryFilters['contentKinds']>[number] {
  return ['text', 'image', 'file', 'mixed'].includes(value)
}

function isSensitivity(value: string): value is NonNullable<LibraryFilters['sensitivity']>[number] {
  return ['normal', 'unknown', 'sensitive'].includes(value)
}

function dateBoundary(value: unknown, endOfDay: boolean): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`)
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString()
}

async function toggleFilter(key: 'kind' | 'sensitivity', value: string) {
  const values = queryValues(route.query[key])
  const next = values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
  await router.replace({ query: { ...route.query, [key]: next.length ? next.join(',') : undefined } })
}

async function setDateFilter(key: 'from' | 'to', event: Event) {
  const value = (event.target as HTMLInputElement).value
  await router.replace({ query: { ...route.query, [key]: value || undefined } })
}

async function removeFilter(key: string, value: string) {
  if (key === 'kind' || key === 'sensitivity') {
    const values = queryValues(route.query[key]).filter((entry) => entry !== value)
    await router.replace({ query: { ...route.query, [key]: values.length ? values.join(',') : undefined } })
    return
  }
  await router.replace({ query: { ...route.query, [key]: undefined } })
}

async function clearFilters() {
  await router.replace({
    query: {
      ...route.query,
      folderId: undefined,
      tagId: undefined,
      kind: undefined,
      sensitivity: undefined,
      from: undefined,
      to: undefined,
    },
  })
}

function onResultKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const links = Array.from(resultList.value?.querySelectorAll<HTMLElement>('a.result-card') ?? [])
  if (!links.length) return
  const current = links.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'ArrowDown' ? Math.min(current + 1, links.length - 1) : Math.max(current - 1, 0)
  event.preventDefault()
  links[next]?.focus()
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
</script>

<template>
  <section class="knowledge-workspace" :class="{ 'knowledge-workspace--selected': selectedItemID }" aria-labelledby="workspace-heading">
    <header class="workspace-header">
      <div class="workspace-header__identity">
        <p>知识与记录</p>
        <h2 id="workspace-heading">{{ library.mode === 'search' ? '搜索结果' : viewTitle }}</h2>
      </div>
      <form class="search-box" role="search" @submit.prevent="submitSearch">
        <UiIcon name="search" />
        <label class="sr-only" for="workspace-search">搜索原文、标题、目录、标签与文件名</label>
        <input
          id="workspace-search"
          ref="searchInput"
          v-model="library.query"
          type="search"
          maxlength="500"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="搜索命令、路径、标题、目录或文件名"
          aria-keyshortcuts="/"
        />
        <kbd v-if="!library.query">/</kbd>
        <button v-else type="button" aria-label="清除搜索" @click="clearSearch"><UiIcon name="x" :size="16" /></button>
      </form>
      <button class="mobile-structure" type="button" aria-label="管理目录与标签" @click="library.managerOpen = true"><UiIcon name="sliders-horizontal" /></button>
      <UiButton variant="primary" @click="captureOpen = true"><UiIcon name="plus" /> 快速记录</UiButton>
    </header>

    <section class="results-pane" aria-label="资料库结果">
      <header class="results-pane__header">
        <div>
          <strong>{{ library.mode === 'search' ? `“${library.query.trim()}”` : viewTitle }}</strong>
          <small v-if="library.mode === 'search' && library.total !== null">{{ library.total }} 条结果</small>
          <small v-else>列表不预载完整原文</small>
        </div>
        <label>
          <span class="sr-only">排序</span>
          <select :value="filters.sort" @change="changeSort">
            <option value="updated_desc">{{ library.mode === 'search' ? '相关性' : '最近更新' }}</option>
            <option value="effective_desc">有效采集时间</option>
          </select>
        </label>
        <button
          type="button"
          class="filter-trigger"
          :aria-expanded="filtersOpen"
          aria-controls="search-filters"
          :disabled="!library.query.trim()"
          @click="filtersOpen = !filtersOpen"
        >
          <UiIcon name="sliders-horizontal" :size="16" /> 筛选
          <span v-if="activeFilterChips.length">{{ activeFilterChips.length }}</span>
        </button>
      </header>

      <section v-if="filtersOpen && library.query.trim()" id="search-filters" class="search-filters" aria-label="搜索筛选器">
        <fieldset>
          <legend>内容类型</legend>
          <label v-for="option in contentKindOptions" :key="option.value">
            <input type="checkbox" :checked="filters.contentKinds?.includes(option.value)" @change="toggleFilter('kind', option.value)" />
            {{ option.label }}
          </label>
        </fieldset>
        <fieldset>
          <legend>敏感状态</legend>
          <label v-for="option in sensitivityOptions" :key="option.value">
            <input type="checkbox" :checked="filters.sensitivity?.includes(option.value)" @change="toggleFilter('sensitivity', option.value)" />
            {{ option.label }}
          </label>
        </fieldset>
        <div class="search-filters__dates">
          <label><span>起始日期</span><input type="date" :value="route.query.from" @change="setDateFilter('from', $event)" /></label>
          <label><span>截止日期</span><input type="date" :value="route.query.to" @change="setDateFilter('to', $event)" /></label>
        </div>
        <UiButton variant="ghost" :disabled="activeFilterChips.length === 0" @click="clearFilters">清除全部筛选</UiButton>
      </section>

      <div v-if="activeFilterChips.length" class="filter-chips" role="group" aria-label="当前筛选条件">
        <button v-for="chip in activeFilterChips" :key="`${chip.key}-${chip.value}`" type="button" @click="removeFilter(chip.key, chip.value)">
          {{ chip.label }} <UiIcon name="x" :size="13" />
        </button>
      </div>

      <div v-if="!online" class="result-state result-state--offline" role="status">
        <UiIcon name="wifi-off" :size="25" />
        <h3>当前处于离线状态</h3>
        <p>开发百宝箱不会缓存原文供离线读取。恢复连接后再试。</p>
        <UiButton variant="secondary" @click="library.retry"><UiIcon name="rotate-ccw" /> 重新连接</UiButton>
      </div>

      <div v-else-if="library.loading && library.results.length === 0" class="result-state" aria-live="polite">
        <span class="spinner" aria-hidden="true" />
        <h3>{{ library.mode === 'search' ? '正在搜索资料库' : `正在读取${viewTitle}` }}</h3>
        <p>只加载安全摘要和元数据。</p>
      </div>

      <div v-else-if="library.error" class="result-state result-state--error" role="alert">
        <UiIcon name="triangle-alert" :size="25" />
        <h3>{{ library.mode === 'search' ? '搜索暂时不可用' : '资料库暂时不可用' }}</h3>
        <p>{{ library.error }}</p>
        <UiButton variant="secondary" @click="library.retry"><UiIcon name="rotate-ccw" /> 重试</UiButton>
      </div>

      <div v-else-if="library.results.length === 0" class="result-state">
        <UiIcon :name="library.mode === 'search' ? 'search' : isTrash ? 'trash-2' : 'inbox'" :size="26" />
        <h3>{{ library.mode === 'search' ? '没有符合当前条件的记录' : isTrash ? '回收站是空的' : '这里还没有记录' }}</h3>
        <p v-if="library.mode === 'search'">换一个字面词，或清除目录与标签过滤。搜索不会解释布尔语法。</p>
        <p v-else-if="isTrash">移入回收站的条目会保留原文与附件，直到你明确永久删除。</p>
        <p v-else>快速记录不依赖 Provider 或 AI worker。</p>
        <UiButton v-if="library.mode === 'search'" variant="secondary" @click="clearSearch">清除搜索</UiButton>
        <UiButton v-else-if="!isTrash" variant="primary" @click="captureOpen = true"><UiIcon name="plus" /> 新建记录</UiButton>
      </div>

      <ol v-else ref="resultList" class="result-list" @keydown="onResultKeydown">
        <li v-for="entry in library.results" :key="entryID(entry)" :class="{ active: selectedItemID === entryID(entry) }">
          <RouterLink v-if="!isTrash" :to="detailLocation(entry)" class="result-card">
            <span class="result-card__icon" :class="{ sensitive: entrySensitivity(entry) !== 'normal' }">
              <UiIcon :name="entrySensitivity(entry) === 'normal' ? 'file-text' : 'shield-alert'" />
            </span>
            <span class="result-card__body">
              <span class="result-card__title"><strong>{{ entryTitle(entry) }}</strong><UiIcon v-if="libraryEntry(entry)?.favorite" name="star" :size="14" /></span>
              <span v-if="searchEntry(entry)" class="result-card__summary">
                <template v-for="(part, index) in searchEntry(entry)?.snippetParts" :key="index"><mark v-if="part.highlighted">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
              </span>
              <span v-else class="result-card__summary">{{ libraryEntry(entry)?.summary || '仅包含附件或暂无文本摘要' }}</span>
              <small>{{ formatTime(entryTime(entry)) }} · {{ searchEntry(entry)?.matchedSource || `${libraryEntry(entry)?.rawRecordCount ?? 0} 条原始记录` }}</small>
            </span>
            <span v-if="entrySensitivity(entry) !== 'normal'" class="sensitivity-label">已遮挡</span>
            <UiIcon name="chevron-right" />
          </RouterLink>

          <div v-else class="result-card result-card--trash">
            <span class="result-card__icon"><UiIcon name="trash-2" /></span>
            <span class="result-card__body"><strong>{{ entryTitle(entry) }}</strong><small>删除于 {{ formatTime(libraryEntry(entry)?.updatedAt ?? entryTime(entry)) }}</small></span>
            <UiButton variant="secondary" :disabled="destructiveBusy" @click="restoreItem(entryID(entry))">恢复</UiButton>
            <UiButton variant="danger" :disabled="destructiveBusy" @click="purgeTarget = { id: entryID(entry), title: entryTitle(entry) }">永久删除</UiButton>
          </div>
        </li>
      </ol>

      <footer v-if="library.nextCursor" class="results-pane__footer">
        <UiButton variant="secondary" :disabled="library.loading" @click="loadMore">{{ library.loading ? '正在加载' : '加载更多' }}</UiButton>
      </footer>
    </section>

    <section class="detail-pane" aria-label="记录详情">
      <ItemDetailView v-if="selectedItemID" :key="selectedItemID" :item-id="selectedItemID" embedded @changed="onDetailChanged" @deleted="onDetailDeleted" />
      <div v-else class="detail-placeholder">
        <UiIcon name="book-open" :size="30" />
        <h3>选择一条记录查看详情</h3>
        <p>原始正文、敏感附件和来源链都只在明确打开后读取。</p>
      </div>
    </section>
  </section>

  <QuickCaptureDrawer :open="captureOpen" @close="captureOpen = false" @created="onCreated" />

  <Teleport to="body">
    <div v-if="purgeTarget" class="purge-overlay">
      <section role="alertdialog" aria-modal="true" aria-labelledby="purge-title" class="purge-dialog">
        <UiIcon name="triangle-alert" :size="28" />
        <h2 id="purge-title">永久删除“{{ purgeTarget.title }}”？</h2>
        <p>这会物理删除关联的原始记录、附件、缩略图、搜索片段和 AI 版本，无法从回收站恢复。</p>
        <p v-if="destructiveError" class="purge-dialog__error" role="alert">{{ destructiveError }}</p>
        <UiButton variant="danger" :disabled="destructiveBusy" @click="purgeItem">{{ destructiveBusy ? '正在永久删除' : '确认永久删除' }}</UiButton>
        <UiButton variant="ghost" :disabled="destructiveBusy" @click="purgeTarget = null; destructiveError = ''">取消</UiButton>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.knowledge-workspace { display: grid; width: 100%; height: 100%; min-height: 0; grid-template-columns: minmax(360px, 440px) minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: var(--bg-surface); }
.workspace-header { display: grid; grid-column: 1 / -1; grid-template-columns: auto minmax(240px, 680px) auto auto; align-items: center; gap: var(--space-3); min-height: 78px; padding: var(--space-3) var(--space-5); border-bottom: 1px solid var(--border-subtle); }
.workspace-header__identity p, .workspace-header__identity h2 { margin: 0; }
.workspace-header__identity p { color: var(--text-muted); font-size: 11px; }
.workspace-header__identity h2 { font-size: 18px; white-space: nowrap; }
.search-box { display: grid; min-height: 44px; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); }
.search-box:focus-within { border-color: var(--focus-ring); box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 18%, transparent); }
.search-box input { min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); }
.search-box kbd { padding: 1px 6px; border: 1px solid var(--border-strong); border-radius: 3px; color: var(--text-muted); font-family: var(--font-mono); }
.search-box button { display: grid; width: 28px; height: 28px; place-items: center; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.mobile-structure { display: none; width: 40px; height: 40px; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-elevated); color: var(--text-secondary); cursor: pointer; }
.results-pane { min-width: 0; min-height: 0; overflow-y: auto; border-right: 1px solid var(--border-subtle); background: var(--bg-nav); overscroll-behavior: contain; scrollbar-color: var(--border-strong) transparent; }
.results-pane__header { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.results-pane__header div, .results-pane__header small { display: grid; }
.results-pane__header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.results-pane__header small { color: var(--text-muted); font-size: 10px; }
.results-pane__header select { min-height: 34px; padding: 0 var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-elevated); color: var(--text-secondary); font-size: 11px; }
.filter-trigger { display: inline-flex; min-height: 34px; align-items: center; gap: var(--space-1); padding: 0 var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-elevated); color: var(--text-secondary); cursor: pointer; font-size: 11px; }
.filter-trigger:disabled { cursor: not-allowed; opacity: .5; }
.filter-trigger > span { min-width: 18px; padding: 1px 5px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); text-align: center; }
.search-filters { display: grid; grid-template-columns: 1fr 1fr minmax(210px, 1fr) auto; align-items: end; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-subtle); background: var(--bg-elevated); }
.search-filters fieldset { display: flex; flex-wrap: wrap; gap: var(--space-2); min-width: 0; margin: 0; padding: 0; border: 0; }
.search-filters legend, .search-filters__dates span { display: block; width: 100%; margin-bottom: var(--space-1); color: var(--text-muted); font-size: 10px; font-weight: 700; }
.search-filters fieldset label { display: inline-flex; align-items: center; gap: 4px; color: var(--text-secondary); font-size: 11px; }
.search-filters__dates { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.search-filters__dates label { min-width: 0; }
.search-filters__dates input { width: 100%; min-height: 34px; padding: 0 var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-secondary); font-size: 11px; }
.filter-chips { display: flex; flex-wrap: wrap; gap: var(--space-1); padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.filter-chips button { display: inline-flex; min-height: 28px; align-items: center; gap: var(--space-1); padding: 0 var(--space-2); border: 1px solid var(--border-subtle); border-radius: 999px; background: var(--accent-soft); color: var(--accent); cursor: pointer; font-size: 10px; }
.result-state { display: grid; min-height: 430px; place-content: center; justify-items: center; padding: var(--space-6); color: var(--text-secondary); text-align: center; }
.result-state h3 { margin: var(--space-3) 0 var(--space-1); color: var(--text-primary); font-size: 15px; }
.result-state p { max-width: 42ch; margin: 0 0 var(--space-4); color: var(--text-muted); }
.result-state--error > svg { color: var(--danger); }
.result-state--offline > svg { color: var(--warning); }
.spinner { width: 26px; height: 26px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.result-list { margin: 0; padding: var(--space-2); list-style: none; }
.result-list li { margin-bottom: 2px; }
.result-card { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); min-height: 86px; padding: var(--space-3); border: 1px solid transparent; border-radius: var(--radius-card); color: var(--text-primary); text-decoration: none; }
.result-card:hover, .result-list li.active .result-card { border-color: var(--border-subtle); background: var(--bg-elevated); }
.result-list li.active .result-card { box-shadow: inset 2px 0 0 var(--accent); }
.result-card__icon { display: grid; width: 36px; height: 36px; place-items: center; border-radius: var(--radius-control); background: var(--accent-soft); color: var(--accent); }
.result-card__icon.sensitive { background: color-mix(in srgb, var(--sensitive) 12%, var(--bg-code)); color: var(--sensitive); }
.result-card__body { display: grid; min-width: 0; gap: 3px; }
.result-card__title { display: flex; min-width: 0; align-items: center; gap: var(--space-1); }
.result-card__title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-card__title svg { flex: none; color: var(--warning); }
.result-card__summary { display: block; overflow: hidden; color: var(--text-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.result-card__summary mark { border-radius: 2px; background: color-mix(in srgb, var(--warning) 30%, transparent); color: var(--text-primary); }
.result-card__body small { color: var(--text-muted); font-size: 10px; }
.sensitivity-label { padding: 3px var(--space-2); border: 1px solid color-mix(in srgb, var(--sensitive) 42%, var(--border-subtle)); border-radius: 999px; background: var(--bg-code); color: var(--sensitive); font-size: 10px; font-weight: 700; }
.result-card--trash { grid-template-columns: auto minmax(0, 1fr) auto auto; border-color: var(--border-subtle); background: var(--bg-elevated); }
.results-pane__footer { display: flex; justify-content: center; padding: var(--space-4); }
.detail-pane { min-width: 0; min-height: 0; overflow-y: auto; background: var(--bg-surface); overscroll-behavior: contain; scrollbar-color: var(--border-strong) transparent; }
.detail-placeholder { display: grid; min-height: 100%; place-content: center; justify-items: center; padding: var(--space-8); color: var(--text-muted); text-align: center; }
.detail-placeholder h3 { margin: var(--space-4) 0 var(--space-1); color: var(--text-secondary); }
.detail-placeholder p { max-width: 44ch; margin: 0; }
.purge-overlay { position: fixed; z-index: var(--layer-overlay); inset: 0; display: grid; place-content: center; padding: var(--space-4); background: var(--scrim); }
.purge-dialog { width: min(440px, 100%); padding: var(--space-6); border: 1px solid color-mix(in srgb, var(--danger) 60%, var(--border-strong)); border-radius: var(--radius-dialog); background: var(--bg-elevated); box-shadow: var(--shadow-overlay); }
.purge-dialog > svg { color: var(--danger); }
.purge-dialog h2 { margin: var(--space-3) 0 var(--space-2); font-size: 19px; }
.purge-dialog p { color: var(--text-secondary); }
.purge-dialog button { width: 100%; margin-top: var(--space-2); }
.purge-dialog__error { color: var(--danger) !important; }
@media (max-width: 1099px) { .mobile-structure { display: grid; } }
@media (max-width: 1200px) { .search-filters { grid-template-columns: 1fr 1fr; } }
@media (max-width: 1000px) {
  .knowledge-workspace { height: auto; min-height: 100%; overflow: visible; }
  .results-pane, .detail-pane { overflow: visible; }
}
@media (max-width: 820px) {
  .knowledge-workspace { display: block; }
  .workspace-header { grid-template-columns: minmax(0, 1fr) auto auto; min-height: auto; padding: var(--space-3); }
  .workspace-header__identity { display: none; }
  .workspace-header .search-box { grid-column: 1 / -1; grid-row: 2; }
  .workspace-header > button:last-child { font-size: 0; }
  .workspace-header > button:last-child svg { margin: 0; }
  .results-pane { min-height: calc(100dvh - 106px); border-right: 0; }
  .detail-pane { display: none; }
  .knowledge-workspace--selected .results-pane { display: none; }
  .knowledge-workspace--selected .detail-pane { display: block; }
  .result-card { grid-template-columns: auto minmax(0, 1fr) auto; }
  .sensitivity-label { display: none; }
  .result-card--trash { grid-template-columns: auto minmax(0, 1fr); }
  .result-card--trash button { grid-column: 2; }
  .search-filters { grid-template-columns: 1fr; }
  .results-pane__header { flex-wrap: wrap; }
}
</style>

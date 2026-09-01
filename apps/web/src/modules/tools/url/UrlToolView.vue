<script setup lang="ts">
import { computed, ref } from 'vue'

import UiButton from '../../../components/ui/UiButton.vue'
import {
  UrlInputError,
  formatUrlBytes,
  parseUrlPreserving,
  rebuildUrl,
  transformUrlText,
  urlUtf8ByteLength,
  type ParsedUrl,
  type QueryRow,
  type UrlOperation,
  type UrlScope,
} from './url'

const activeMode = ref<'transform' | 'inspect'>('transform')
const operation = ref<UrlOperation>('encode')
const scope = ref<UrlScope>('url')
const input = ref('')
const result = ref('')
const parsed = ref<ParsedUrl | null>(null)
const queryRows = ref<QueryRow[]>([])
const errorMessage = ref('')
const liveMessage = ref('')
const inputBytes = computed(() => urlUtf8ByteLength(input.value))

function runTransform() {
  resetError()
  try {
    result.value = transformUrlText(input.value, operation.value, scope.value)
  } catch (error) {
    result.value = ''
    showError(error)
  }
}

function inspectUrl() {
  resetError()
  try {
    parsed.value = parseUrlPreserving(input.value)
    queryRows.value = parsed.value.queryRows.map((row) => ({ ...row }))
    result.value = ''
  } catch (error) {
    parsed.value = null
    queryRows.value = []
    showError(error)
  }
}

function rebuild() {
  if (!parsed.value) return
  result.value = rebuildUrl(parsed.value, queryRows.value)
  liveMessage.value = '已按当前行顺序重新构建；地址不会被打开。'
}

function addQueryRow() {
  queryRows.value.push({ key: '', value: '', hasEquals: true })
}

function removeQueryRow(index: number) {
  queryRows.value.splice(index, 1)
}

async function pasteInput() {
  resetError()
  try {
    input.value = await navigator.clipboard.readText()
  } catch {
    errorMessage.value = '浏览器未允许读取剪贴板，请使用系统粘贴快捷键。'
  }
}

async function copyResult() {
  try {
    await navigator.clipboard.writeText(result.value)
    liveMessage.value = '结果已复制'
  } catch {
    errorMessage.value = '复制未成功，请选中结果后手动复制。'
  }
}

function clearAll() {
  input.value = ''
  result.value = ''
  parsed.value = null
  queryRows.value = []
  resetError()
}

function resetError() {
  errorMessage.value = ''
  liveMessage.value = ''
}

function showError(error: unknown) {
  errorMessage.value =
    error instanceof UrlInputError ? error.message : '处理未完成，请检查输入后重试。'
}
</script>

<template>
  <main class="tool-page" aria-labelledby="url-title">
    <header class="tool-header">
      <div>
        <p class="breadcrumb">工具箱 / 编码与数据</p>
        <h1 id="url-title">URL 编解码</h1>
        <p>明确转换完整 URL 或 URL 组件，也可保序查看和编辑 Query 行。</p>
      </div>
      <span class="local-badge">浏览器本地处理</span>
    </header>
    <p class="privacy-note">输入只保留在当前页面内存，不发起网络请求，也不会自动打开解析出的地址。上限 1 MiB UTF-8。</p>

    <div class="tabs" role="tablist" aria-label="URL 工具模式">
      <button :aria-selected="activeMode === 'transform'" role="tab" @click="activeMode = 'transform'">百分号编解码</button>
      <button :aria-selected="activeMode === 'inspect'" role="tab" @click="activeMode = 'inspect'">解析与 Query</button>
    </div>

    <section v-if="activeMode === 'transform'" class="mode-bar" aria-label="转换选项">
      <fieldset>
        <legend>操作</legend>
        <label><input v-model="operation" type="radio" value="encode" /> 编码</label>
        <label><input v-model="operation" type="radio" value="decode" /> 解码</label>
      </fieldset>
      <fieldset>
        <legend>范围</legend>
        <label><input v-model="scope" type="radio" value="url" /> 完整 URL</label>
        <label><input v-model="scope" type="radio" value="component" /> URL 组件</label>
      </fieldset>
    </section>

    <p v-if="errorMessage" class="error-summary" role="alert">{{ errorMessage }}</p>

    <section class="input-panel">
      <div class="panel-header">
        <label for="url-input">{{ activeMode === 'transform' ? '输入文本' : '待解析 URL' }}</label>
        <span>{{ input.length }} 字符 · {{ formatUrlBytes(inputBytes) }}</span>
      </div>
      <textarea id="url-input" v-model="input" rows="7" spellcheck="false" :aria-invalid="Boolean(errorMessage)" />
      <div class="actions">
        <UiButton variant="ghost" @click="pasteInput">粘贴</UiButton>
        <UiButton variant="ghost" @click="clearAll">清空</UiButton>
        <UiButton v-if="activeMode === 'transform'" variant="primary" @click="runTransform">
          {{ operation === 'encode' ? '执行编码' : '执行解码' }}
        </UiButton>
        <UiButton v-else variant="primary" @click="inspectUrl">解析 URL</UiButton>
      </div>
    </section>

    <section v-if="activeMode === 'transform'" class="result-panel">
      <div class="panel-header"><strong>结果</strong><UiButton :disabled="!result" @click="copyResult">复制结果</UiButton></div>
      <textarea :value="result" rows="7" readonly aria-label="URL 转换结果" placeholder="执行后在此显示" />
    </section>

    <template v-else-if="parsed">
      <section class="parts-panel" aria-labelledby="parts-title">
        <h2 id="parts-title">URL 字段</h2>
        <dl>
          <div><dt>scheme</dt><dd>{{ parsed.scheme || '—' }}</dd></div>
          <div><dt>host</dt><dd>{{ parsed.host || '—' }}</dd></div>
          <div><dt>port</dt><dd>{{ parsed.port || '—' }}</dd></div>
          <div><dt>path</dt><dd>{{ parsed.path || '—' }}</dd></div>
          <div><dt>query</dt><dd>{{ parsed.query || '—' }}</dd></div>
          <div><dt>fragment</dt><dd>{{ parsed.fragment || '—' }}</dd></div>
        </dl>
      </section>

      <section class="query-panel" aria-labelledby="query-title">
        <div class="panel-header">
          <div><h2 id="query-title">Query 参数</h2><p>键和值按 URL 中的原始百分号编码显示；重复项和顺序会保留。</p></div>
          <UiButton variant="ghost" @click="addQueryRow">新增一行</UiButton>
        </div>
        <div class="query-table" role="table" aria-label="Query 参数保序行表">
          <div class="query-row query-row--header" role="row"><span>键</span><span>值</span><span>等号</span><span>操作</span></div>
          <p v-if="!queryRows.length" class="empty-result">当前 URL 没有 Query 参数。</p>
          <div v-for="(row, index) in queryRows" :key="index" class="query-row" role="row">
            <label><span class="sr-only">第 {{ index + 1 }} 行键</span><input v-model="row.key" /></label>
            <label><span class="sr-only">第 {{ index + 1 }} 行值</span><input v-model="row.value" :disabled="!row.hasEquals" /></label>
            <label class="equals-toggle"><input v-model="row.hasEquals" type="checkbox" /> 保留 =</label>
            <UiButton variant="ghost" :aria-label="`删除第 ${index + 1} 行`" @click="removeQueryRow(index)">删除</UiButton>
          </div>
        </div>
        <div class="actions"><UiButton variant="primary" @click="rebuild">重新构建</UiButton></div>
      </section>

      <section class="result-panel">
        <div class="panel-header"><strong>重新构建结果</strong><UiButton :disabled="!result" @click="copyResult">复制结果</UiButton></div>
        <textarea :value="result" rows="5" readonly aria-label="重新构建的 URL" placeholder="重新构建后在此显示" />
      </section>
    </template>
    <span class="live-status" aria-live="polite">{{ liveMessage }}</span>
  </main>
</template>

<style scoped>
.tool-page { width: 100%; max-width: 1440px; margin: 0 auto; padding: var(--space-6); }
.tool-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); }
.tool-header h1 { margin: var(--space-1) 0; font-size: 26px; }
.tool-header p, .query-panel p { margin: 0; color: var(--text-secondary); }
.breadcrumb { color: var(--text-muted) !important; font-size: 12px; }
.local-badge { flex: none; padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--success) 55%, var(--border-subtle)); border-radius: 999px; color: var(--success); font-size: 12px; font-weight: 700; }
.privacy-note { padding: var(--space-3); border-left: 3px solid var(--accent); background: var(--bg-surface); color: var(--text-secondary); }
.tabs { display: flex; border-bottom: 1px solid var(--border-subtle); }
.tabs button { min-height: 44px; padding: 0 var(--space-4); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-secondary); cursor: pointer; }
.tabs button[aria-selected='true'] { border-bottom-color: var(--accent); color: var(--text-primary); font-weight: 700; }
.mode-bar { display: flex; gap: var(--space-6); margin-top: var(--space-4); padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-surface); }
fieldset { display: flex; gap: var(--space-4); padding: 0; border: 0; margin: 0; }
legend { float: left; margin-right: var(--space-3); color: var(--text-secondary); font-weight: 700; }
.input-panel, .result-panel, .parts-panel, .query-panel { margin-top: var(--space-4); padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-surface); }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2); }
.panel-header span { color: var(--text-muted); font-size: 12px; }
textarea { width: 100%; resize: vertical; padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); font-family: var(--font-mono); line-height: 1.55; }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
.error-summary { padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--danger) 55%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--danger); }
h2 { margin: 0 0 var(--space-3); font-size: 17px; }
dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); margin: 0; }
dl div { min-width: 0; padding: var(--space-3); background: var(--bg-elevated); }
dt { color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; }
dd { overflow-wrap: anywhere; margin: var(--space-1) 0 0; font-family: var(--font-mono); }
.query-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 110px 72px; gap: var(--space-2); align-items: center; padding: var(--space-2) 0; border-bottom: 1px solid var(--border-subtle); }
.query-row--header { color: var(--text-muted); font-size: 12px; font-weight: 700; }
.query-row input:not([type='checkbox']) { width: 100%; min-height: 40px; padding: 0 var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); font-family: var(--font-mono); }
.equals-toggle { color: var(--text-secondary); font-size: 12px; }
.empty-result { padding: var(--space-4); text-align: center; }
.live-status { display: block; min-height: 24px; margin-top: var(--space-2); color: var(--success); }
@media (max-width: 767px) {
  .tool-page { padding: var(--space-4); }
  .tool-header, .mode-bar, fieldset { flex-direction: column; }
  fieldset { gap: var(--space-2); }
  legend { float: none; }
  dl { grid-template-columns: 1fr; }
  .query-row--header { display: none; }
  .query-row { grid-template-columns: 1fr; padding: var(--space-3) 0; }
  .query-row :deep(button), .actions :deep(button) { min-height: 44px; }
  .panel-header { align-items: flex-start; }
}
</style>

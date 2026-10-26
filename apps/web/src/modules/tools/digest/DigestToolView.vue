<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import UiButton from '../../../components/ui/UiButton.vue'
import ProcessingBadge from '../shared/ui/ProcessingBadge.vue'
import { digestLabels, type DigestAlgorithm, type DigestProgress } from './contracts'
import { compareDigest, DigestRunner } from './digestRunner'

const mode = ref<'text' | 'file'>('text')
const algorithm = ref<DigestAlgorithm>('sha256')
const textInput = ref('')
const selectedFile = ref<File | null>(null)
const fileInput = ref<HTMLInputElement>()
const expected = ref('')
const digest = ref('')
const totalBytes = ref(0)
const progress = ref<DigestProgress>({ processedBytes: 0, totalBytes: 0, rateBytesPerSecond: 0 })
const running = ref(false)
const showProgress = ref(false)
const errorMessage = ref('')
const canceled = ref(false)
const copyStatus = ref('')
const runner = new DigestRunner()
let progressTimer: number | undefined
let copyTimer: number | undefined
let copyRequest = 0

const insecureAlgorithm = computed(() => algorithm.value === 'md5' || algorithm.value === 'sha1')
const comparison = computed(() => compareDigest(digest.value, expected.value, algorithm.value))
const progressPercent = computed(() => progress.value.totalBytes === 0 ? 0 : Math.min(100, progress.value.processedBytes / progress.value.totalBytes * 100))
const textBytes = computed(() => new TextEncoder().encode(textInput.value).byteLength)

onBeforeUnmount(() => {
  clearProgressTimer()
  invalidateCopyFeedback()
  runner.dispose()
  selectedFile.value = null
})

function selectFile(event: Event) {
  const input = event.target as HTMLInputElement
  selectedFile.value = input.files?.[0] ?? null
  resetResult()
}

function resetResult() {
  digest.value = ''
  errorMessage.value = ''
  canceled.value = false
  expected.value = ''
  progress.value = { processedBytes: 0, totalBytes: 0, rateBytesPerSecond: 0 }
  invalidateCopyFeedback()
}

function clearAll() {
  runner.cancel()
  textInput.value = ''
  selectedFile.value = null
  if (fileInput.value) fileInput.value.value = ''
  resetResult()
}

function clearProgressTimer() {
  if (progressTimer !== undefined) window.clearTimeout(progressTimer)
  progressTimer = undefined
}

// 复制反馈按发起序号归属：同一文本重算会得到相同摘要字符串，不能用摘要值判断迟到回包是否仍属于当前结果。
function invalidateCopyFeedback() {
  copyRequest += 1
  if (copyTimer !== undefined) window.clearTimeout(copyTimer)
  copyTimer = undefined
  copyStatus.value = ''
}

async function runDigest() {
  errorMessage.value = ''
  canceled.value = false
  digest.value = ''
  invalidateCopyFeedback()
  progress.value = { processedBytes: 0, totalBytes: mode.value === 'file' ? selectedFile.value?.size ?? 0 : new TextEncoder().encode(textInput.value).byteLength, rateBytesPerSecond: 0 }
  if (mode.value === 'file' && !selectedFile.value) {
    errorMessage.value = '请选择一个本地文件'
    return
  }
  running.value = true
  showProgress.value = false
  clearProgressTimer()
  progressTimer = window.setTimeout(() => { showProgress.value = true }, 300)
  try {
    const result = mode.value === 'text'
      ? await runner.run({ kind: 'text', text: textInput.value, algorithm: algorithm.value }, updateProgress)
      : await runner.run({ kind: 'file', file: selectedFile.value!, algorithm: algorithm.value }, updateProgress)
    digest.value = result.digest
    totalBytes.value = result.totalBytes
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') canceled.value = true
    else errorMessage.value = error instanceof Error ? error.message : '摘要计算失败'
  } finally {
    clearProgressTimer()
    running.value = false
    showProgress.value = false
  }
}

function updateProgress(value: DigestProgress) {
  progress.value = value
}

function cancelDigest() {
  runner.cancel()
}

async function copyDigest() {
  if (!digest.value) return
  invalidateCopyFeedback()
  errorMessage.value = ''
  const request = copyRequest
  try {
    await navigator.clipboard.writeText(digest.value)
    if (request !== copyRequest) return
    copyStatus.value = '摘要已复制'
    copyTimer = window.setTimeout(() => { copyStatus.value = '' }, 1600)
  } catch {
    if (request !== copyRequest) return
    errorMessage.value = '复制未成功，请选中结果后手动复制。'
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`
}
</script>

<template>
  <section class="tool-page" aria-labelledby="digest-title">
    <header class="tool-header">
      <div><p class="breadcrumb">工具箱 / 开发辅助</p><div class="title-line"><h1 id="digest-title">哈希摘要与校验和</h1><ProcessingBadge /></div><p>计算文本或单个本地文件的摘要；文件固定按 4 MiB 分块读取，不上传、不整体载入内存。</p></div>
      <UiButton variant="secondary" :disabled="running" @click="clearAll">清空</UiButton>
    </header>

    <p v-if="errorMessage" class="notice danger" role="alert">{{ errorMessage }}</p>
    <p v-if="canceled" class="notice" role="status">计算已取消，晚到的 Worker 结果不会覆盖当前页面。</p>
    <p class="sr-only" aria-live="polite">{{ copyStatus }}</p>

    <div class="workspace-grid">
      <section class="tool-card input-card">
        <fieldset class="segmented"><legend>输入类型</legend><label><input v-model="mode" type="radio" value="text" :disabled="running" @change="resetResult"><span>文本</span></label><label><input v-model="mode" type="radio" value="file" :disabled="running" @change="resetResult"><span>单个文件</span></label></fieldset>

        <label for="digest-algorithm">摘要算法</label>
        <select id="digest-algorithm" v-model="algorithm" :disabled="running" @change="resetResult">
          <option value="sha256">SHA-256</option><option value="sha384">SHA-384</option><option value="sha512">SHA-512</option><option value="md5">MD5（不安全，仅兼容）</option><option value="sha1">SHA-1（不安全，仅兼容）</option>
        </select>
        <p v-if="insecureAlgorithm" class="unsafe-warning" role="note">{{ digestLabels[algorithm] }} 仅用于旧校验和兼容，不安全；不要用于密码、签名或安全决策。</p>

        <template v-if="mode === 'text'">
          <label for="digest-text">文本内容</label><textarea id="digest-text" v-model="textInput" rows="13" :disabled="running" placeholder="输入或粘贴待计算文本" @input="resetResult" />
          <p class="hint">UTF-8 · {{ formatBytes(textBytes) }}</p>
        </template>
        <template v-else>
          <label class="file-picker" for="digest-file"><strong>选择本地文件</strong><span>单文件 best effort，受当前设备资源和浏览器 File API 限制</span></label>
          <input id="digest-file" ref="fileInput" class="file-input" type="file" :disabled="running" @change="selectFile">
          <dl v-if="selectedFile" class="file-meta"><div><dt>文件名</dt><dd>{{ selectedFile.name }}</dd></div><div><dt>大小</dt><dd>{{ formatBytes(selectedFile.size) }}</dd></div><div><dt>算法</dt><dd>{{ digestLabels[algorithm] }}</dd></div></dl>
        </template>

        <div class="primary-actions"><UiButton :variant="running ? 'danger' : 'primary'" @click="running ? cancelDigest() : runDigest()">{{ running ? '取消计算' : '计算摘要' }}</UiButton></div>

        <div v-if="running && showProgress" class="progress-box" role="status" aria-live="polite">
          <div><span>已处理 {{ formatBytes(progress.processedBytes) }} / {{ formatBytes(progress.totalBytes) }}</span><strong>{{ progressPercent.toFixed(1) }}%</strong></div>
          <progress :value="progress.processedBytes" :max="Math.max(progress.totalBytes, 1)" />
          <small>速率 {{ formatBytes(progress.rateBytesPerSecond) }}/s · 每块最多 4 MiB</small>
        </div>
      </section>

      <section class="tool-card result-card">
        <header><h2>摘要结果</h2><UiButton variant="secondary" :disabled="!digest" @click="copyDigest">{{ copyStatus ? '已复制' : '复制摘要' }}</UiButton></header>
        <template v-if="digest">
          <p class="algorithm-label">{{ digestLabels[algorithm] }} · {{ formatBytes(totalBytes) }}</p>
          <output class="digest-output">{{ digest }}</output>
          <label for="expected-digest">期望校验值</label><textarea id="expected-digest" v-model="expected" rows="4" placeholder="可含 0x 前缀、ASCII 空白或大小写差异" />
          <p v-if="comparison.status !== 'empty'" class="comparison" :class="comparison.status" role="status"><strong>{{ comparison.message }}</strong><span>算法：{{ digestLabels[algorithm] }}；规范化后仍进行精确比较。</span></p>
        </template>
        <div v-else class="empty-result"><strong>执行后在此显示</strong><span>结果只保留在当前页面内存中。</span></div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.tool-page { width: min(100%, 1180px); padding: var(--space-6); }
.tool-header, .title-line, .tool-card > header, .progress-box > div { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.tool-header { align-items: flex-start; }
.breadcrumb { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: 12px; }
h1, h2, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: 26px; }
h2 { margin-bottom: 0; font-size: 16px; }
.tool-header > div > p:last-child { margin: var(--space-2) 0 0; color: var(--text-secondary); }
.workspace-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); margin-top: var(--space-5); }
.tool-card { min-width: 0; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-surface); }
label { display: block; margin-top: var(--space-4); color: var(--text-secondary); font-size: 12px; font-weight: 600; }
select, textarea { width: 100%; min-height: 40px; margin-top: var(--space-1); padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
textarea { resize: vertical; font-family: var(--font-mono); }
.segmented { display: flex; width: max-content; gap: 2px; padding: 3px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); }
.segmented legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
.segmented label { margin: 0; cursor: pointer; }
.segmented input { position: absolute; opacity: 0; }
.segmented span { display: block; padding: 7px 16px; border-radius: 4px; }
.segmented input:checked + span { background: var(--accent-soft); color: var(--text-primary); }
.unsafe-warning { margin: var(--space-3) 0 0; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--warning) 55%, var(--border-subtle)); color: var(--warning); }
.hint { margin: 4px 0 0; color: var(--text-muted); font-size: 11px; }
.file-picker { display: grid; min-height: 160px; place-content: center; gap: var(--space-2); padding: var(--space-5); border: 1px dashed var(--border-strong); border-radius: var(--radius-card); text-align: center; cursor: pointer; }
.file-picker span { max-width: 440px; color: var(--text-muted); font-weight: 400; }
.file-input { margin-top: var(--space-2); }
.file-meta { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: var(--space-3); }
.file-meta dt { color: var(--text-muted); font-size: 11px; }
.file-meta dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.primary-actions { margin-top: var(--space-4); }
.progress-box { display: grid; gap: var(--space-2); margin-top: var(--space-4); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.progress-box progress { width: 100%; accent-color: var(--accent); }
.progress-box small { color: var(--text-muted); }
.notice { margin: var(--space-4) 0 0; padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text-secondary); }
.notice.danger { border-color: color-mix(in srgb, var(--danger) 55%, var(--border-subtle)); color: var(--danger); }
.algorithm-label { margin: var(--space-5) 0 var(--space-2); color: var(--text-muted); font-size: 12px; }
.digest-output { display: block; min-height: 88px; padding: var(--space-3); overflow-wrap: anywhere; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); color: var(--accent); font-family: var(--font-mono); }
.comparison { display: grid; gap: 2px; margin-top: var(--space-4); padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); }
.comparison span { color: var(--text-muted); font-size: 11px; }
.comparison.match { border-color: color-mix(in srgb, var(--success) 55%, var(--border-subtle)); color: var(--success); }
.comparison.mismatch, .comparison.invalid { border-color: color-mix(in srgb, var(--danger) 55%, var(--border-subtle)); color: var(--danger); }
.empty-result { display: grid; min-height: 320px; place-content: center; gap: var(--space-2); color: var(--text-muted); text-align: center; }
@media (max-width: 720px) { .tool-page { padding: var(--space-4); } .tool-header { flex-direction: column; } .workspace-grid { grid-template-columns: 1fr; } .tool-card > header { align-items: flex-start; flex-direction: column; } .file-meta { grid-template-columns: 1fr; } }
</style>

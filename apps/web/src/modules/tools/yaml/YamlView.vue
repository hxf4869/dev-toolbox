<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import UiButton from '../../../components/ui/UiButton.vue'
import CopyButton from '../shared/ui/CopyButton.vue'
import ToolPageHeader from '../shared/ui/ToolPageHeader.vue'
import { createAdaptiveEditor, type AdaptiveEditor } from '../shared/editor'
import { WorkerRequestCancelledError, WorkerRequestClient, type WorkerRequest } from '../shared/worker'
import type { YamlWorkerRequest, YamlWorkerResult } from './contracts'

type Mode = 'format' | 'to-json' | 'from-json'
const mode = ref<Mode>('format')
const input = ref('project: dev-toolbox\nversion: 2\nfeatures:\n  - json\n  - yaml\n')
const output = ref('')
const mobilePane = ref<'input' | 'result'>('input')
const status = ref('')
const errorMessage = ref('')
const running = ref(false)
const showProgress = ref(false)
const inputHost = ref<HTMLElement | null>(null)
const outputHost = ref<HTMLElement | null>(null)
let inputEditor: AdaptiveEditor | null = null
let outputEditor: AdaptiveEditor | null = null
let activeRequest: WorkerRequest<YamlWorkerResult> | null = null
// 当前 output/status 对应的输入文本；null 表示没有可信结果。applyFormatted 自身回写输入时会先更新它。
let outputSourceInput: string | null = null
let progressTimer: number | undefined

const workerClient = new WorkerRequestClient<YamlWorkerRequest, YamlWorkerResult>(
  () => new Worker(new URL('./structured.worker.ts', import.meta.url), { type: 'module' }),
)
const inputLanguage = computed(() => mode.value === 'from-json' ? 'json' : 'yaml')
const outputLanguage = computed(() => mode.value === 'to-json' ? 'json' : 'yaml')
const actionLabel = computed(() => mode.value === 'format' ? '格式化并校验' : mode.value === 'to-json' ? '转换为 JSON' : '转换为 YAML')

onMounted(async () => {
  if (!inputHost.value || !outputHost.value) return
  inputEditor = createAdaptiveEditor({ host: inputHost.value, ariaLabel: 'YAML 输入编辑器', language: inputLanguage.value, value: input.value, onChange(value) { input.value = value } })
  outputEditor = createAdaptiveEditor({ host: outputHost.value, ariaLabel: 'YAML 结果编辑器', language: outputLanguage.value, value: '', readOnly: true })
  await Promise.all([inputEditor.ready, outputEditor.ready])
})
watch(input, (value) => {
  if (inputEditor?.getValue() !== value) inputEditor?.setValue(value)
  if (value === outputSourceInput) return
  cancelLocalRequest()
  outputSourceInput = null
  output.value = ''
  status.value = ''
  errorMessage.value = ''
})
watch(output, (value) => { if (outputEditor?.getValue() !== value) outputEditor?.setValue(value) })
watch(mode, async () => {
  cancelLocalRequest()
  output.value = ''
  outputSourceInput = null
  status.value = ''
  errorMessage.value = ''
  inputEditor?.setAriaLabel(mode.value === 'from-json' ? 'JSON 输入编辑器' : 'YAML 输入编辑器')
  outputEditor?.setAriaLabel(mode.value === 'to-json' ? 'JSON 结果编辑器' : 'YAML 结果编辑器')
  await inputEditor?.setLanguage(inputLanguage.value)
  await outputEditor?.setLanguage(outputLanguage.value)
})
onBeforeUnmount(() => {
  cancelLocalRequest()
  workerClient.dispose()
  inputEditor?.dispose()
  outputEditor?.dispose()
})

async function run() {
  const request: YamlWorkerRequest = mode.value === 'format'
    ? { operation: 'format', text: input.value }
    : mode.value === 'to-json'
      ? { operation: 'to-json', text: input.value }
      : { operation: 'from-json', text: input.value }
  errorMessage.value = ''
  status.value = ''
  running.value = true
  showProgress.value = false
  progressTimer = window.setTimeout(() => { showProgress.value = true }, 300)
  const pending = workerClient.request(request, { supersede: 'yaml-workbench' })
  activeRequest = pending
  try {
    const result = await pending.promise
    if (activeRequest !== pending) return
    output.value = result.output
    outputSourceInput = request.text
    status.value = result.operation === 'to-json'
      ? result.documentCount === 1 ? '已输出单个 JSON 值。注释不会进入 JSON，之后无法从 JSON 恢复。' : `已将 ${result.documentCount} 个文档按顺序输出为 JSON 数组；注释不会进入 JSON。`
      : result.operation === 'format'
        ? `已校验 ${result.documentCount} 个 YAML 1.2 文档；格式化会尽力保留注释，但位置可能调整。`
        : '已转换为 YAML 1.2；JSON 原文不包含可恢复的注释。'
    mobilePane.value = 'result'
  } catch (error) {
    if (activeRequest === pending && !(error instanceof WorkerRequestCancelledError)) errorMessage.value = error instanceof Error ? error.message : 'YAML 操作失败。'
  } finally {
    if (activeRequest === pending) {
      activeRequest = null
      running.value = false
      showProgress.value = false
      window.clearTimeout(progressTimer)
    }
  }
}

function applyFormatted() {
  if (mode.value !== 'format' || !output.value) return
  if (outputSourceInput === null || input.value !== outputSourceInput) return
  // 回写输入会使 watch 因快照相等而不触发取消，必须先作废在途请求，避免晚到结果覆盖已应用状态。
  cancelLocalRequest()
  outputSourceInput = output.value
  input.value = output.value
  status.value = '格式化结果已应用到输入。'
  mobilePane.value = 'input'
}

function cancelRunning() {
  cancelLocalRequest()
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
</script>

<template>
  <section class="workbench">
    <ToolPageHeader
      title="YAML 工作台"
      description="YAML 1.2 格式化、校验与无损 JSON 转换。"
      limit="单个编辑面最多 5 MiB；普通 alias 上限 100；内容默认只存在于页面内存。"
    />
    <nav class="tabs" aria-label="YAML 操作">
      <button type="button" :class="{ active: mode === 'format' }" @click="mode = 'format'">格式化/校验</button>
      <button type="button" :class="{ active: mode === 'to-json' }" @click="mode = 'to-json'">YAML→JSON</button>
      <button type="button" :class="{ active: mode === 'from-json' }" @click="mode = 'from-json'">JSON→YAML</button>
    </nav>
    <div class="mobile-switch">
      <button type="button" :class="{ active: mobilePane === 'input' }" @click="mobilePane = 'input'">输入</button>
      <button type="button" :class="{ active: mobilePane === 'result' }" @click="mobilePane = 'result'">结果</button>
    </div>
    <div id="yaml-actions" class="actions">
      <p>格式化会尽力保留注释，但注释位置可能调整；只有点击应用后才改写输入。</p>
      <UiButton variant="primary" :disabled="running || !input" @click="run">{{ actionLabel }}</UiButton>
      <UiButton v-if="running" variant="secondary" @click="cancelRunning">取消</UiButton>
      <UiButton v-if="mode === 'format' && output" variant="secondary" @click="applyFormatted">应用格式化</UiButton>
    </div>
    <div id="yaml-feedback" tabindex="-1">
      <p v-if="showProgress" class="message" role="status">正在浏览器 Worker 中处理…</p>
      <p v-if="errorMessage" class="message error" role="alert">{{ errorMessage }}</p>
      <p v-else-if="status" class="message" role="status">{{ status }}</p>
    </div>
    <div class="editors">
      <section class="pane" :class="{ hidden: mobilePane !== 'input' }">
        <div class="heading"><span>{{ mode === 'from-json' ? 'JSON 输入' : 'YAML 输入' }}</span><nav class="editor-shortcuts" aria-label="YAML 输入编辑器快捷跳转"><a href="#yaml-actions">跳到操作区</a><a href="#yaml-feedback">跳到错误列表</a></nav></div>
        <div id="yaml-input" ref="inputHost" class="editor-host" />
        <nav class="editor-shortcuts editor-shortcuts--after" aria-label="YAML 输入编辑器后快捷跳转"><a href="#yaml-actions">跳到操作区</a><a href="#yaml-feedback">跳到错误列表</a></nav>
      </section>
      <section class="pane" :class="{ hidden: mobilePane !== 'result' }">
        <div class="heading"><span>{{ mode === 'to-json' ? 'JSON 结果' : 'YAML 结果' }}</span><div class="pane-actions"><CopyButton :text="output" /><nav class="editor-shortcuts" aria-label="YAML 结果编辑器快捷跳转"><a href="#yaml-actions">跳到操作区</a><a href="#yaml-feedback">跳到错误列表</a></nav></div></div>
        <div id="yaml-output" ref="outputHost" class="editor-host" />
        <nav class="editor-shortcuts editor-shortcuts--after" aria-label="YAML 结果编辑器后快捷跳转"><a href="#yaml-actions">跳到操作区</a><a href="#yaml-feedback">跳到错误列表</a></nav>
      </section>
    </div>
    <aside class="boundary">
      拒绝重复 mapping key、merge key、%TAG 与自定义 tag。时间戳保持字符串；不提供 Kubernetes Schema、Helm 或远程 Schema。
    </aside>
  </section>
</template>

<style scoped>
.workbench { min-width: 0; min-height: 100%; background: var(--bg-app); }
.tabs { display: flex; gap: var(--space-1); padding: 0 var(--space-8); overflow-x: auto; border-bottom: 1px solid var(--border-subtle); }
.tabs button, .mobile-switch button { min-height: 44px; padding: 0 var(--space-3); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-secondary); cursor: pointer; }
.tabs button.active, .mobile-switch button.active { border-color: var(--accent); color: var(--text-primary); }
.actions { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4) var(--space-8); border-bottom: 1px solid var(--border-subtle); background: var(--bg-surface); }
.actions p { flex: 1; margin: 0; color: var(--text-muted); font-size: 12px; }
.message { margin: var(--space-3) var(--space-8) 0; padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-surface); }
.message.error { border-color: color-mix(in srgb, var(--danger) 50%, var(--border-subtle)); color: var(--danger); }
.editors { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1px; min-height: 520px; margin: var(--space-4) var(--space-8); background: var(--border-subtle); }
.pane { display: flex; min-width: 0; flex-direction: column; padding: var(--space-3); background: var(--bg-surface); }
.heading { display: flex; min-height: 40px; align-items: center; justify-content: space-between; gap: var(--space-3); color: var(--text-secondary); font-weight: 600; }
/* 窄屏下右侧复制反馈与快捷跳转到达最小宽度后，压力只能落到标题上；标题不收缩，改由 pane-actions 自身换行吸收。 */
.heading > span { flex-shrink: 0; }
.pane-actions, .editor-shortcuts { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-3); }
.editor-shortcuts { font-size: 12px; font-weight: 500; }
.editor-shortcuts a { color: var(--text-muted); }
.editor-shortcuts--after { min-height: 32px; padding-top: var(--space-2); }
.editor-host { min-height: 450px; flex: 1; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.boundary { margin: 0 var(--space-8) var(--space-8); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--text-muted); }
.mobile-switch { display: none; }
@media (max-width: 767px) {
  .tabs { padding: 0 var(--space-4); }
  .mobile-switch { display: grid; grid-template-columns: 1fr 1fr; margin: var(--space-3) var(--space-4) 0; border: 1px solid var(--border-subtle); }
  .actions { align-items: stretch; flex-direction: column; padding: var(--space-4); }
  .message, .boundary { margin-right: var(--space-4); margin-left: var(--space-4); }
  .editors { display: block; min-height: 500px; margin: var(--space-4); }
  .pane.hidden { display: none; }
  .editor-host { min-height: 420px; }
}
</style>

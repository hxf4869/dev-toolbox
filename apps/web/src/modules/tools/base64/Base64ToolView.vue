<script setup lang="ts">
import { computed, ref } from 'vue'

import UiButton from '../../../components/ui/UiButton.vue'
import {
  Base64InputError,
  formatBytes,
  transformBase64,
  utf8ByteLength,
  type Base64Operation,
  type Base64Variant,
} from './base64'

const operation = ref<Base64Operation>('encode')
const variant = ref<Base64Variant>('standard')
const input = ref('')
const result = ref('')
const errorMessage = ref('')
const copyMessage = ref('')

const inputBytes = computed(() => utf8ByteLength(input.value))
const resultBytes = computed(() => utf8ByteLength(result.value))

function invalidateResult() {
  result.value = ''
  errorMessage.value = ''
  copyMessage.value = ''
}

function run() {
  errorMessage.value = ''
  copyMessage.value = ''
  try {
    result.value = transformBase64(input.value, operation.value, variant.value)
  } catch (error) {
    result.value = ''
    errorMessage.value =
      error instanceof Base64InputError ? error.message : '处理未完成，请检查输入后重试。'
  }
}

async function pasteInput() {
  errorMessage.value = ''
  try {
    input.value = await navigator.clipboard.readText()
    invalidateResult()
  } catch {
    errorMessage.value = '浏览器未允许读取剪贴板，请使用系统粘贴快捷键。'
  }
}

async function copyResult() {
  try {
    await navigator.clipboard.writeText(result.value)
    copyMessage.value = '结果已复制'
    window.setTimeout(() => (copyMessage.value = ''), 1600)
  } catch {
    errorMessage.value = '复制未成功，请选中结果后手动复制。'
  }
}

function clearAll() {
  input.value = ''
  result.value = ''
  errorMessage.value = ''
  copyMessage.value = ''
}

function swapValues() {
  const previousInput = input.value
  input.value = result.value
  result.value = previousInput
  errorMessage.value = ''
  copyMessage.value = ''
}
</script>

<template>
  <main class="tool-page" aria-labelledby="base64-title">
    <header class="tool-header">
      <div>
        <p class="breadcrumb">工具箱 / 编码与数据</p>
        <h1 id="base64-title">Base64 编码/解码</h1>
        <p>在 UTF-8 文本与标准 Base64 或 Base64URL 之间进行一次明确转换。</p>
      </div>
      <span class="local-badge">浏览器本地处理</span>
    </header>

    <p class="privacy-note">输入和结果只保留在当前页面内存，不上传、不保存。单次输入上限 5 MiB UTF-8。</p>

    <section class="mode-bar" aria-label="转换选项">
      <fieldset @change="invalidateResult">
        <legend>操作</legend>
        <label><input v-model="operation" type="radio" value="encode" /> 编码</label>
        <label><input v-model="operation" type="radio" value="decode" /> 解码</label>
      </fieldset>
      <fieldset @change="invalidateResult">
        <legend>变体</legend>
        <label><input v-model="variant" type="radio" value="standard" /> Base64</label>
        <label><input v-model="variant" type="radio" value="url" /> Base64URL</label>
      </fieldset>
    </section>

    <p v-if="errorMessage" class="error-summary" role="alert">{{ errorMessage }}</p>

    <div class="converter-grid">
      <section class="panel">
        <div class="panel__header">
          <label for="base64-input">输入文本</label>
          <span>{{ input.length }} 字符 · {{ formatBytes(inputBytes) }}</span>
        </div>
        <textarea
          id="base64-input"
          v-model="input"
          rows="16"
          spellcheck="false"
          :aria-invalid="Boolean(errorMessage)"
          :aria-describedby="errorMessage ? 'base64-input-help' : undefined"
          placeholder="粘贴 UTF-8 文本或 Base64 内容"
          @input="invalidateResult"
        />
        <span id="base64-input-help" class="sr-only">{{ errorMessage }}</span>
        <div class="actions">
          <UiButton variant="ghost" @click="pasteInput">粘贴</UiButton>
          <UiButton variant="ghost" @click="clearAll">清空</UiButton>
          <UiButton variant="primary" @click="run">
            {{ operation === 'encode' ? '执行编码' : '执行解码' }}
          </UiButton>
        </div>
      </section>

      <section class="panel" aria-labelledby="base64-result-title">
        <div class="panel__header">
          <strong id="base64-result-title">结果</strong>
          <span>{{ result.length }} 字符 · {{ formatBytes(resultBytes) }}</span>
        </div>
        <textarea
          :value="result"
          rows="16"
          readonly
          spellcheck="false"
          aria-label="Base64 转换结果"
          placeholder="执行后在此显示"
        />
        <div class="actions actions--result">
          <UiButton variant="ghost" :disabled="!result" @click="swapValues">交换输入/结果</UiButton>
          <UiButton :disabled="!result" @click="copyResult">复制结果</UiButton>
        </div>
        <span class="copy-status" aria-live="polite">{{ copyMessage }}</span>
      </section>
    </div>
  </main>
</template>

<style scoped>
.tool-page { width: 100%; max-width: 1440px; margin: 0 auto; padding: var(--space-6); }
.tool-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); margin-bottom: var(--space-4); }
.tool-header h1 { margin: var(--space-1) 0; font-size: 26px; }
.tool-header p { margin: 0; color: var(--text-secondary); }
.breadcrumb { color: var(--text-muted) !important; font-size: 12px; }
.local-badge { flex: none; padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--success) 55%, var(--border-subtle)); border-radius: 999px; color: var(--success); font-size: 12px; font-weight: 700; }
.privacy-note { margin: 0 0 var(--space-4); padding: var(--space-3); border-left: 3px solid var(--accent); background: var(--bg-surface); color: var(--text-secondary); }
.mode-bar { display: flex; gap: var(--space-6); padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-surface); }
fieldset { display: flex; gap: var(--space-4); padding: 0; border: 0; margin: 0; }
legend { float: left; margin-right: var(--space-3); color: var(--text-secondary); font-weight: 700; }
label { font-weight: 650; }
.error-summary { margin: var(--space-4) 0 0; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--danger) 55%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--danger); }
.converter-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-4); margin-top: var(--space-4); }
.panel { min-width: 0; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-surface); }
.panel__header { display: flex; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2); }
.panel__header span { color: var(--text-muted); font-size: 12px; }
textarea { width: 100%; min-height: 320px; resize: vertical; padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); font-family: var(--font-mono); line-height: 1.55; }
textarea[readonly] { color: var(--text-secondary); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
.actions--result { justify-content: space-between; }
.copy-status { display: block; min-height: 22px; margin-top: var(--space-1); color: var(--success); text-align: right; }
@media (max-width: 767px) {
  .tool-page { padding: var(--space-4); }
  .tool-header { flex-direction: column; }
  .mode-bar, fieldset { flex-direction: column; gap: var(--space-2); }
  legend { float: none; margin: 0 0 var(--space-1); }
  .converter-grid { grid-template-columns: 1fr; }
  textarea { min-height: 220px; }
  .actions { flex-wrap: wrap; }
  .actions :deep(button) { min-height: 44px; }
}
</style>

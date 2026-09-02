<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import type { AssistantModelDTO, AssistantRunDTO, Reasoning } from './assistantContracts'
import ModelReasoningBar from './ModelReasoningBar.vue'

const props = defineProps<{
  models: AssistantModelDTO[]
  modelId: string | null
  reasoning: Reasoning
  draft: string
  activeRun: boolean
  canStop: boolean
  stopRequested: boolean
  sending: boolean
  error: string
  selectionRequired: boolean
  temporary: boolean
  contextRun: Pick<AssistantRunDTO, 'model' | 'usage'> | null
}>()

const emit = defineEmits<{
  'update:draft': [value: string]
  model: [modelId: string | null]
  reasoning: [reasoning: Reasoning]
  send: []
  stop: []
}>()

const textarea = ref<HTMLTextAreaElement | null>(null)
const composing = ref(false)
const contextWindow = computed(() => props.contextRun
  ? props.contextRun.model.contextWindow
  : props.models.find((model) => model.id === props.modelId)?.contextWindow)
const contextTokens = computed(() => props.contextRun?.usage.answerContextTokens)
const contextLabel = computed(() => props.contextRun && (
  props.activeRun || props.sending || props.contextRun.model.id !== props.modelId
) ? '上次请求上下文' : '上下文')
const contextUsage = computed(() => {
  if (!props.contextRun) return props.activeRun || props.sending ? '待返回' : '待请求'
  return contextTokens.value == null ? '未提供' : compactTokens(contextTokens.value)
})
const contextPercentage = computed(() => {
  if (contextTokens.value == null || !contextWindow.value) return null
  const percentage = contextTokens.value / contextWindow.value * 100
  return percentage > 0 && percentage < 0.1 ? '< 0.1%' : `${percentage.toFixed(1)}%`
})
const contextDetails = computed(() => {
  const model = props.contextRun?.model
  const measurement = contextTokens.value == null
    ? '完整输入用量未提供；旧记录可能缺少缓存计量。'
    : `完整输入 ${contextTokens.value.toLocaleString('zh-CN')} token。`
  const capacity = contextWindow.value
    ? `模型窗口 ${contextWindow.value.toLocaleString('zh-CN')} token。`
    : '模型窗口未提供。'
  return `${model ? `统计所属模型：${model.displayName} · ${model.providerDisplayName}。` : ''}${props.contextRun ? measurement : '发送并完成请求后显示实测用量。'}${capacity}包含系统提示、摘要、随请求发送的历史和检索内容（含缓存）；不含当前草稿、回答输出或查询改写。不是下一条消息的预估值。`
})

function compactTokens(value: number) {
  const unit = value >= 1_000_000 ? 1_000_000 : value >= 1_000 ? 1_000 : 1
  return `${(value / unit).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}${unit === 1_000_000 ? 'M' : unit === 1_000 ? 'K' : ''}`
}

const canSubmit = computed(
  () =>
    !props.activeRun &&
    !props.sending &&
    Boolean(props.modelId) &&
    props.draft.trim().length > 0,
)

watch(
  () => props.draft,
  () => void nextTick(resize),
)

function onInput(event: Event) {
  emit('update:draft', (event.target as HTMLTextAreaElement).value)
  resize()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || composing.value || event.isComposing) return
  event.preventDefault()
  if (canSubmit.value) emit('send')
}

function resize() {
  if (!textarea.value) return
  textarea.value.style.height = 'auto'
  const maxHeight = 184
  textarea.value.style.height = `${Math.min(textarea.value.scrollHeight, maxHeight)}px`
  textarea.value.style.overflowY = textarea.value.scrollHeight > maxHeight ? 'auto' : 'hidden'
}

function focus() {
  textarea.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <footer class="assistant-composer">
    <div class="assistant-composer__inner">
      <ModelReasoningBar
        :models="models"
        :model-id="modelId"
        :reasoning="reasoning"
        :active-run="activeRun"
        :required="selectionRequired"
        @model="emit('model', $event)"
        @reasoning="emit('reasoning', $event)"
      />

      <p v-if="temporary" class="assistant-composer__temporary">
        <UiIcon name="history" :size="16" />
        <span>Dev Toolbox 不保存本会话；消息和检索片段仍会发送给所选 Provider，并受其数据保留政策约束。</span>
      </p>

      <div class="assistant-composer__box" :class="{ 'assistant-composer__box--error': error }">
        <label class="sr-only" for="assistant-message-input">发送给知识助手</label>
        <textarea
          id="assistant-message-input"
          ref="textarea"
          data-assistant-composer
          :value="draft"
          rows="1"
          maxlength="32768"
          :placeholder="activeRun ? '可以继续编辑下一条消息…' : '询问笔记内容，或进行一般交流…'"
          :aria-describedby="error ? 'assistant-composer-error' : 'assistant-composer-help'"
          @input="onInput"
          @keydown="onKeydown"
          @compositionstart="composing = true"
          @compositionend="composing = false"
        />
        <UiButton
          v-if="activeRun"
          variant="danger"
          :disabled="!canStop"
          :title="stopRequested ? '已请求停止当前回答' : '停止当前回答'"
          :aria-label="stopRequested ? '已请求停止当前回答' : '停止当前回答'"
          @click="emit('stop')"
        >
          <UiIcon name="square" :size="17" />
          <span>{{ stopRequested ? '正在停止…' : '停止' }}</span>
        </UiButton>
        <UiButton
          v-else
          variant="primary"
          :disabled="!canSubmit"
          :title="modelId ? '发送消息' : '请先选择模型'"
          @click="emit('send')"
        >
          <UiIcon name="play" :size="17" />
          <span>{{ sending ? '发送中…' : '发送' }}</span>
        </UiButton>
      </div>

      <div class="assistant-composer__meta">
        <p v-if="error" id="assistant-composer-error" class="assistant-composer__error" role="alert">
          <UiIcon name="triangle-alert" :size="15" />{{ error }}
        </p>
        <p v-else id="assistant-composer-help">Enter 发送 · Shift+Enter 换行</p>
        <div class="assistant-composer__counts">
          <span class="assistant-composer__context" :title="contextDetails" aria-live="polite">
            {{ contextLabel }} {{ contextUsage }}<template v-if="contextWindow"> / {{ compactTokens(contextWindow) }}</template><template v-if="contextPercentage"> · {{ contextPercentage }}</template>
          </span>
          <span>字符 {{ draft.length.toLocaleString('zh-CN') }} / 32,768</span>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.assistant-composer {
  position: relative;
  z-index: 4;
  padding: var(--space-3) var(--page-gutter) var(--space-4);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.assistant-composer__inner {
  display: grid;
  width: min(100%, 860px);
  margin: 0 auto;
  gap: var(--space-2);
}

.assistant-composer__temporary {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  color: var(--warning);
  font-size: 12px;
}

.assistant-composer__box {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-card);
  background: var(--bg-elevated);
  transition: border-color var(--motion-fast) var(--ease-standard);
}

.assistant-composer__box:focus-within { border-color: var(--focus-ring); }
.assistant-composer__box--error { border-color: var(--danger); }

.assistant-composer textarea {
  width: 100%;
  min-height: 44px;
  max-height: 184px;
  padding: 10px var(--space-2);
  resize: none;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  caret-color: var(--accent);
  font-size: 15px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  scrollbar-color: var(--border-strong) transparent;
}

.assistant-composer textarea::placeholder { color: var(--text-muted); }
.assistant-composer__box :deep(.button) { min-width: 92px; min-height: 44px; }

.assistant-composer__meta {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--text-muted);
  font-size: 11px;
}

.assistant-composer__meta p { margin: 0; }
.assistant-composer__counts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-1) var(--space-3); margin-left: auto; font-variant-numeric: tabular-nums; }
.assistant-composer__counts > span { white-space: nowrap; }
.assistant-composer__error { display: flex; align-items: flex-start; gap: var(--space-1); color: var(--danger); }

@media (max-width: 599px) {
  .assistant-composer { padding: var(--space-2) var(--space-3) max(var(--space-3), env(safe-area-inset-bottom)); }
  .assistant-composer textarea { font-size: 16px; }
  .assistant-composer__box :deep(.button) { min-width: 48px; padding-inline: var(--space-3); }
  .assistant-composer__box :deep(.button span) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .assistant-composer__meta { font-size: 12px; }
}
</style>

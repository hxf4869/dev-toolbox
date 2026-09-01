<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import type { AssistantModelDTO, Reasoning } from './assistantContracts'
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
        <span>{{ draft.length.toLocaleString('zh-CN') }} / 32,768</span>
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
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--text-muted);
  font-size: 11px;
}

.assistant-composer__meta p { margin: 0; }
.assistant-composer__meta > span { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.assistant-composer__error { display: flex; align-items: flex-start; gap: var(--space-1); color: var(--danger); }

@media (max-width: 599px) {
  .assistant-composer { padding: var(--space-2) var(--space-3) max(var(--space-3), env(safe-area-inset-bottom)); }
  .assistant-composer textarea { font-size: 16px; }
  .assistant-composer__box :deep(.button) { min-width: 48px; padding-inline: var(--space-3); }
  .assistant-composer__box :deep(.button span) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .assistant-composer__meta { font-size: 12px; }
}
</style>

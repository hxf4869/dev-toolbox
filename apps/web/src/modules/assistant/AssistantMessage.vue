<script setup lang="ts">
import { computed, ref } from 'vue'

import UiIcon from '../../components/ui/UiIcon.vue'
import AssistantMarkdown from './AssistantMarkdown.vue'
import ReasoningPanel from './ReasoningPanel.vue'
import RuntimeInfo from './RuntimeInfo.vue'
import type { AssistantCitationSelection, AssistantMessageViewModel } from './assistantStore'

const props = defineProps<{ message: AssistantMessageViewModel }>()
const emit = defineEmits<{
  citation: [selection: AssistantCitationSelection]
  retry: [runId: string]
}>()

const copyState = ref<'idle' | 'success' | 'error'>('idle')
const answerStarted = computed(() => props.message.content.length > 0)
const streaming = computed(() => props.message.status === 'streaming')

function openCitation(number: number) {
  const citation = props.message.citations.find((entry) => entry.citationNumber === number)
  if (citation) emit('citation', { citation, messageId: props.message.id })
}

async function copyAnswer() {
  if (!props.message.content) return
  try {
    let copy = props.message.content
    for (const citation of props.message.citations) {
      copy = copy.replaceAll(`[[C${citation.citationNumber}]]`, '')
    }
    await navigator.clipboard.writeText(copy)
    copyState.value = 'success'
  } catch {
    copyState.value = 'error'
  }
  window.setTimeout(() => {
    copyState.value = 'idle'
  }, 1600)
}

function statusText() {
  if (props.message.status === 'failed') {
    return props.message.run?.error?.message ?? props.message.temporaryRuntime?.error?.message ?? '回答失败'
  }
  if (props.message.status === 'stopped') return '回答已停止，以上内容可能不完整。'
  if (props.message.status === 'streaming' && !props.message.content) return '正在生成回答…'
  return ''
}
</script>

<template>
  <article
    class="assistant-message"
    :class="[
      `assistant-message--${message.role}`,
      { 'assistant-message--partial': message.status === 'failed' || message.status === 'stopped' },
    ]"
    :aria-label="message.role === 'user' ? '你的消息' : '知识助手回答'"
  >
    <div v-if="message.role === 'user'" class="assistant-message__user-text">{{ message.content }}</div>

    <div v-else class="assistant-message__answer">
      <ReasoningPanel
        v-if="message.reasoningContent"
        :content="message.reasoningContent"
        :duration-ms="message.reasoningDurationMs"
        :streaming="streaming"
        :answer-started="answerStarted"
      />

      <AssistantMarkdown
        v-if="message.content"
        :source="message.content"
        :citations="message.citations"
        @citation="openCitation"
      />

      <p v-if="statusText()" class="assistant-message__status" :class="`assistant-message__status--${message.status}`" role="status">
        <UiIcon :name="message.status === 'failed' ? 'x-circle' : message.status === 'stopped' ? 'square' : 'clock'" :size="16" />
        <span>{{ statusText() }}</span>
      </p>

      <div v-if="message.content || message.run?.canRetry" class="assistant-message__actions">
        <button
          v-if="message.content"
          type="button"
          :aria-label="copyState === 'success' ? '回答已复制' : copyState === 'error' ? '复制失败，请重试' : '复制回答'"
          :title="copyState === 'success' ? '已复制' : copyState === 'error' ? '复制失败，请重试' : '复制回答'"
          @click="copyAnswer"
        >
          <UiIcon :name="copyState === 'success' ? 'check' : 'copy'" :size="16" />
          <span>{{ copyState === 'success' ? '已复制' : copyState === 'error' ? '复制失败' : '复制' }}</span>
        </button>
        <button
          v-if="message.run?.canRetry"
          type="button"
          title="使用当前选择的模型和思考档位重试"
          @click="emit('retry', message.run.id)"
        >
          <UiIcon name="rotate-ccw" :size="16" />
          <span>重试</span>
        </button>
      </div>

      <RuntimeInfo :run="message.run" :temporary-runtime="message.temporaryRuntime" />
    </div>
  </article>
</template>

<style scoped>
.assistant-message {
  width: min(100%, 860px);
  min-width: 0;
  margin: 0 auto;
  padding-inline: var(--space-4);
}

.assistant-message--user { display: flex; justify-content: flex-end; }

.assistant-message__user-text {
  max-width: min(76%, 680px);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.assistant-message__answer { min-width: 0; }

.assistant-message--partial .assistant-message__answer {
  padding-bottom: var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--warning) 55%, var(--border-subtle));
}

.assistant-message__status {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  color: var(--text-muted);
  font-size: 12px;
}

.assistant-message__status--failed { color: var(--danger); }
.assistant-message__status--stopped { color: var(--warning); }

.assistant-message__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.assistant-message__actions button {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.assistant-message__actions button:hover {
  border-color: var(--border-subtle);
  background: var(--bg-code);
  color: var(--text-primary);
}

@media (max-width: 599px) {
  .assistant-message { padding-inline: var(--space-3); }
  .assistant-message__user-text { max-width: 88%; font-size: 16px; }
  .assistant-message__actions button { min-height: 40px; }
}
</style>

<script setup lang="ts">
import { ref, watch } from 'vue'

import UiIcon from '../../components/ui/UiIcon.vue'

const props = defineProps<{
  content: string
  durationMs: number | null
  streaming: boolean
  answerStarted: boolean
}>()

const expanded = ref(props.streaming && Boolean(props.content) && !props.answerStarted)

watch(
  () => props.content,
  (content) => {
    if (props.streaming && content && !props.answerStarted) expanded.value = true
  },
)

watch(
  () => props.answerStarted,
  (started, wasStarted) => {
    if (started && !wasStarted) expanded.value = false
  },
)

function durationLabel() {
  if (props.streaming && !props.answerStarted) return '正在思考'
  if (props.durationMs === null) return '思考过程'
  const seconds = Math.max(0, Math.round(props.durationMs / 1000))
  return `思考约 ${seconds} 秒`
}
</script>

<template>
  <section class="reasoning-panel">
    <button
      class="reasoning-panel__toggle"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <UiIcon name="sparkles" :size="16" />
      <span>{{ durationLabel() }}</span>
      <UiIcon class="reasoning-panel__chevron" name="chevron-down" :size="16" />
    </button>
    <div v-show="expanded" class="reasoning-panel__content">
      <p>{{ content }}</p>
    </div>
  </section>
</template>

<style scoped>
.reasoning-panel {
  margin-bottom: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}

.reasoning-panel__toggle {
  display: flex;
  width: 100%;
  min-height: 40px;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
}

.reasoning-panel__toggle:hover { color: var(--text-primary); }
.reasoning-panel__toggle span { flex: 1; }
.reasoning-panel__chevron { transition: transform var(--motion-fast) var(--ease-standard); }
.reasoning-panel__toggle[aria-expanded='true'] .reasoning-panel__chevron { transform: rotate(180deg); }

.reasoning-panel__content {
  padding: 0 var(--space-3) var(--space-3);
  border-top: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}

.reasoning-panel__content p {
  margin: var(--space-3) 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

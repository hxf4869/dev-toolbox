<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    mode?: 'local' | 'optional-ai' | 'cloud'
  }>(),
  { mode: 'local' },
)

const label = computed(() => ({
  local: '浏览器本地处理',
  'optional-ai': '可选 AI 外发',
  cloud: '云服务',
})[props.mode])
</script>

<template>
  <span class="processing-badge" :class="`processing-badge--${mode}`">
    <span aria-hidden="true" />{{ label }}
  </span>
</template>

<style scoped>
.processing-badge {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg-code);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
}

.processing-badge > span {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--success);
}

.processing-badge--optional-ai > span { background: var(--warning); }
.processing-badge--cloud > span { background: var(--accent); }
</style>

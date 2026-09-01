<script setup lang="ts">
import { RouterLink } from 'vue-router'

import UiIcon from '../../../../components/ui/UiIcon.vue'
import ProcessingBadge from './ProcessingBadge.vue'

withDefaults(
  defineProps<{
    title: string
    description: string
    limit?: string
    processing?: 'local' | 'optional-ai' | 'cloud'
  }>(),
  { limit: '', processing: 'local' },
)
</script>

<template>
  <header class="tool-page-header">
    <div class="tool-page-header__copy">
      <RouterLink class="tool-page-header__back" to="/tools">
        <UiIcon name="chevron-left" :size="16" /> 返回工具箱
      </RouterLink>
      <div class="tool-page-header__title-row">
        <div>
          <h1>{{ title }}</h1>
          <p>{{ description }}</p>
        </div>
        <ProcessingBadge :mode="processing" />
      </div>
      <p v-if="limit" class="tool-page-header__limit">{{ limit }}</p>
    </div>
    <div v-if="$slots.actions" class="tool-page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.tool-page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-6);
  padding: var(--space-6) var(--page-gutter) var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-app);
}

.tool-page-header__copy { min-width: 0; flex: 1; }

.tool-page-header__back {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
  color: var(--text-muted);
  font-size: 12px;
  text-decoration: none;
}

.tool-page-header__back:hover { color: var(--accent); }

.tool-page-header__title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

h1 { margin: 0; font-size: clamp(22px, 2vw, 30px); line-height: 1.2; letter-spacing: -0.02em; }
p { max-width: 75ch; margin: var(--space-2) 0 0; color: var(--text-secondary); }
.tool-page-header__limit { color: var(--text-muted); font-size: 12px; }
.tool-page-header__actions { display: flex; align-items: center; gap: var(--space-2); }

@media (max-width: 767px) {
  .tool-page-header { padding: var(--space-4); }
  .tool-page-header__title-row { align-items: flex-start; flex-direction: column; }
  .tool-page-header__actions { align-self: flex-end; }
}
</style>

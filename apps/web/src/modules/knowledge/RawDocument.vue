<script setup lang="ts">
import SafeMarkdown from './SafeMarkdown.vue'

defineProps<{ body: string; contentFormat: 'plain_text' | 'markdown' }>()
</script>

<template>
  <SafeMarkdown v-if="contentFormat === 'markdown'" :source="body" />
  <pre v-else class="plain-raw" tabindex="0">{{ body }}</pre>
</template>

<style scoped>
.plain-raw {
  max-width: 100%;
  margin: 0;
  overflow-x: auto;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

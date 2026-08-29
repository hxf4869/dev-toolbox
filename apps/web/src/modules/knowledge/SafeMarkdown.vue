<script setup lang="ts">
import MarkdownIt from 'markdown-it'
import { computed } from 'vue'

const props = defineProps<{ source: string }>()
const renderer = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: true,
})

const rendered = computed(() => renderer.render(props.source))
</script>

<template>
  <!-- markdown-it escapes raw HTML because html=false. -->
  <div class="safe-markdown" v-html="rendered" />
</template>

<style scoped>
.safe-markdown {
  color: var(--text-primary);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.safe-markdown :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  font-family: var(--font-mono);
  font-size: 13px;
  white-space: pre;
}

.safe-markdown :deep(code) {
  padding: 2px 4px;
  border-radius: 3px;
  background: var(--bg-code);
  font-family: var(--font-mono);
}

.safe-markdown :deep(pre code) {
  padding: 0;
  background: transparent;
}

.safe-markdown :deep(a) {
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

.safe-markdown :deep(blockquote) {
  margin-inline: 0;
  padding-left: var(--space-4);
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
}
</style>

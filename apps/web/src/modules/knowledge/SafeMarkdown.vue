<script setup lang="ts">
import MarkdownIt from 'markdown-it'
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{ source: string; origin?: string }>(), {
  // Raw records are the default origin; AI-derived usage passes its own label
  // so copies never blur the fact/derived boundary.
  origin: '来自原始记录',
})
const copiedIndex = ref<number | null>(null)
const copyErrorIndex = ref<number | null>(null)

const rendered = computed(() => {
  const codeBlocks: string[] = []
  const renderer = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: true,
  })
  const defaultLinkOpen = renderer.renderer.rules.link_open ?? ((tokens, index, options, _environment, self) => self.renderToken(tokens, index, options))
  renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
    const href = String(tokens[index]?.attrGet('href') ?? '')
    if (/^https?:\/\//iu.test(href)) {
      tokens[index]?.attrSet('target', '_blank')
      tokens[index]?.attrSet('rel', 'noopener noreferrer')
    }
    return defaultLinkOpen(tokens, index, options, environment, self)
  }
  renderer.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]
    const blockIndex = codeBlocks.push(token.content) - 1
    const language = renderer.utils.escapeHtml(token.info.trim().split(/\s+/u)[0] ?? '')
    const className = language ? ` class="language-${language}"` : ''
    const copyLabel = copiedIndex.value === blockIndex ? '已复制' : copyErrorIndex.value === blockIndex ? '复制失败，重试' : '复制代码块'
    return `<section class="safe-code-block"><header><span>${language || '代码'} · ${renderer.utils.escapeHtml(props.origin)}</span><button type="button" data-code-index="${blockIndex}">${copyLabel}</button></header><pre tabindex="0"><code${className}>${renderer.utils.escapeHtml(token.content)}</code></pre></section>`
  }
  return { html: renderer.render(props.source), codeBlocks }
})

async function onContentClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const button = target?.closest<HTMLButtonElement>('button[data-code-index]')
  if (!button) return
  const index = Number(button.dataset.codeIndex)
  const content = rendered.value.codeBlocks[index]
  if (content === undefined) return
  copyErrorIndex.value = null
  try {
    await navigator.clipboard.writeText(content)
    copiedIndex.value = index
    window.setTimeout(() => {
      if (copiedIndex.value === index) copiedIndex.value = null
    }, 1600)
  } catch {
    copiedIndex.value = null
    copyErrorIndex.value = index
  }
}
</script>

<template>
  <!-- markdown-it escapes raw HTML because html=false. -->
  <div class="safe-markdown" @click="onContentClick" v-html="rendered.html" />
  <span class="sr-only" role="status">{{ copiedIndex !== null ? '代码块已精确复制' : copyErrorIndex !== null ? '复制失败，请重试' : '' }}</span>
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

.safe-markdown :deep(.safe-code-block) {
  margin: var(--space-4) 0;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}

.safe-markdown :deep(.safe-code-block > header) {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 11px;
}

.safe-markdown :deep(.safe-code-block button) {
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}

.safe-markdown :deep(.safe-code-block pre) {
  margin: 0;
  border: 0;
  border-radius: 0;
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

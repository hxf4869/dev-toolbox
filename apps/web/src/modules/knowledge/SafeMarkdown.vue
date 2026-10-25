<script setup lang="ts">
import MarkdownIt from 'markdown-it'
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'

const props = withDefaults(defineProps<{ source: string; origin?: string }>(), {
  // Raw records are the default origin; AI-derived usage passes its own label
  // so copies never blur the fact/derived boundary.
  origin: '来自原始记录',
})
const copiedIndex = ref<number | null>(null)
const copyErrorIndex = ref<number | null>(null)
const wrappedIndices = ref(new Set<number>())
const markdownElement = ref<HTMLElement | null>(null)
// html=false leaves exactly these focusable kinds inside the rendered markdown.
const FOCUSABLE = 'a[href], button, pre[tabindex]'
let feedbackTimer: number | undefined

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
    const wrapped = wrappedIndices.value.has(blockIndex)
    return `<section class="safe-code-block"><header><span>${language || '代码'} · ${renderer.utils.escapeHtml(props.origin)}</span><div class="safe-code-actions"><button type="button" data-wrap-index="${blockIndex}" aria-pressed="${wrapped}" title="切换代码自动换行">自动换行</button><button type="button" data-code-index="${blockIndex}" title="复制这个代码块">${copyLabel}</button></div></header><pre tabindex="0"${wrapped ? ' class="is-wrapped"' : ''}><code${className}>${renderer.utils.escapeHtml(token.content)}</code></pre></section>`
  }
  return { html: renderer.render(props.source), codeBlocks }
})

async function onContentClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const wrapButton = target?.closest<HTMLButtonElement>('button[data-wrap-index]')
  if (wrapButton) {
    const index = Number(wrapButton.dataset.wrapIndex)
    await updatePreservingFocus(() => {
      if (wrappedIndices.value.has(index)) wrappedIndices.value.delete(index)
      else wrappedIndices.value.add(index)
    })
    return
  }

  const copyButton = target?.closest<HTMLButtonElement>('button[data-code-index]')
  if (!copyButton) return
  const index = Number(copyButton.dataset.codeIndex)
  const content = rendered.value.codeBlocks[index]
  if (content === undefined) return
  let copied = false
  try {
    await navigator.clipboard.writeText(content)
    copied = true
  } catch {
    // Keep the failed action available for an explicit retry.
  }
  window.clearTimeout(feedbackTimer)
  await updatePreservingFocus(() => {
    copiedIndex.value = copied ? index : null
    copyErrorIndex.value = copied ? null : index
  })
  if (copied) {
    feedbackTimer = window.setTimeout(() => {
      feedbackTimer = undefined
      if (copiedIndex.value !== index) return
      void updatePreservingFocus(() => {
        copiedIndex.value = null
      })
    }, 1600)
  }
}

// v-html replaces every node on re-render, so the focused element only survives as
// "the Nth focusable inside this markdown"; our own state changes never add, remove
// or reorder focusables. Restore only while it is still the same root and source and
// focus merely fell to body (or stayed put); anything else means someone moved it on purpose.
async function updatePreservingFocus(update: () => void) {
  const root = markdownElement.value
  const source = props.source
  const active = document.activeElement
  const focusableBefore = root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)) : []
  const focusedAt = active instanceof HTMLElement ? focusableBefore.indexOf(active) : -1
  update()
  await nextTick()
  if (!root || focusedAt < 0 || markdownElement.value !== root || props.source !== source) return
  const current = document.activeElement
  if (current !== document.body && current !== active) return
  root.querySelectorAll<HTMLElement>(FOCUSABLE).item(focusedAt)?.focus({ preventScroll: true })
}

onBeforeUnmount(() => window.clearTimeout(feedbackTimer))
</script>

<template>
  <!-- markdown-it escapes raw HTML because html=false. -->
  <div ref="markdownElement" class="safe-markdown" @click="onContentClick" v-html="rendered.html" />
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
  gap: var(--space-3);
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 11px;
}

.safe-markdown :deep(.safe-code-block button) {
  min-height: 40px;
  min-width: 40px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}

.safe-markdown :deep(.safe-code-block button:hover) { background: var(--accent-soft); }
.safe-markdown :deep(.safe-code-actions) { display: flex; flex-shrink: 0; gap: var(--space-1); }
.safe-markdown :deep(.safe-code-block button[aria-pressed="true"]) { background: var(--accent-soft); }

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

.safe-markdown :deep(pre.is-wrapped) { white-space: pre-wrap; overflow-wrap: anywhere; }

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

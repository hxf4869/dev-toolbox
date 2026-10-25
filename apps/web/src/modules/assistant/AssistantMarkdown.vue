<script setup lang="ts">
import MarkdownIt from 'markdown-it'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import type { CitationRefDTO } from './assistantContracts'

const props = defineProps<{
  source: string
  citations: Array<CitationRefDTO | Omit<CitationRefDTO, 'runId'>>
}>()

const emit = defineEmits<{ citation: [number: number] }>()
const copiedIndex = ref<number | null>(null)
const copyErrorIndex = ref<number | null>(null)
const wrappedIndices = ref(new Set<number>())
const markdownElement = ref<HTMLElement | null>(null)
// Feedback records the code text it belongs to, so a source update can tell
// "same block, appended prose" from a swap at the same index.
let copiedCodeText: string | null = null
let erroredCodeText: string | null = null
let copyFeedbackTimer: number | undefined

const rendered = computed(() => {
  const codeBlocks: string[] = []
  const citations = new Map(props.citations.map((citation) => [citation.citationNumber, citation]))
  const renderer = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: true,
  })
  const defaultLinkOpen =
    renderer.renderer.rules.link_open ??
    ((tokens, index, options, _environment, self) => self.renderToken(tokens, index, options))

  renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
    const href = String(tokens[index]?.attrGet('href') ?? '')
    if (/^https?:\/\//iu.test(href)) {
      tokens[index]?.attrSet('target', '_blank')
      tokens[index]?.attrSet('rel', 'noopener noreferrer')
    }
    return defaultLinkOpen(tokens, index, options, environment, self)
  }

  renderer.renderer.rules.text = (tokens, index) => {
    const content = renderer.utils.escapeHtml(tokens[index]?.content ?? '')
    if (insideLink(tokens, index)) return content
    return content.replace(/\[\[C(\d+)\]\]/gu, (token, rawNumber: string) => {
      const citationNumber = Number(rawNumber)
      const citation = citations.get(citationNumber)
      if (!citation || token !== `[[C${citationNumber}]]`) return token
      const title = renderer.utils.escapeHtml(citation.title)
      return `<button class="assistant-citation" type="button" data-citation-number="${citationNumber}" aria-label="查看引用 ${citationNumber}：${title}" title="查看来源：${title}">[${citationNumber}]</button>`
    })
  }

  renderer.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]
    const blockIndex = codeBlocks.push(token?.content ?? '') - 1
    const language = renderer.utils.escapeHtml(token?.info.trim().split(/\s+/u)[0] ?? '')
    const className = language ? ` class="language-${language}"` : ''
    const wrapped = wrappedIndices.value.has(blockIndex)
    return `<section class="assistant-code-block"><header><span>${language || '代码'} · 模型生成，未验证</span><div class="assistant-code-actions"><button type="button" data-wrap-index="${blockIndex}" aria-pressed="${wrapped}" title="切换代码自动换行">自动换行</button><button type="button" data-code-index="${blockIndex}" title="复制这个代码块">复制代码块</button></div></header><pre tabindex="0"${wrapped ? ' class="is-wrapped"' : ''}><code${className}>${renderer.utils.escapeHtml(token?.content ?? '')}</code></pre></section>`
  }

  return { html: renderer.render(props.source), codeBlocks }
})

// Copy feedback must never re-enter rendered.html: v-html keeps its nodes, so focus,
// citation openers and drawer ownership survive feedback changes. The watcher only
// relabels buttons this component generated, and clears feedback whose code is gone.
watch(
  [() => rendered.value.html, copiedIndex, copyErrorIndex],
  () => {
    const codeBlocks = rendered.value.codeBlocks
    if (copiedIndex.value !== null && codeBlocks[copiedIndex.value] !== copiedCodeText) clearCopyFeedback()
    if (copyErrorIndex.value !== null && codeBlocks[copyErrorIndex.value] !== erroredCodeText) clearCopyFeedback()
    for (const button of markdownElement.value?.querySelectorAll<HTMLButtonElement>('button[data-code-index]') ?? []) {
      const index = Number(button.dataset.codeIndex)
      button.textContent =
        copiedIndex.value === index ? '已复制' : copyErrorIndex.value === index ? '复制失败，重试' : '复制代码块'
    }
  },
  { flush: 'post' },
)

function clearCopyFeedback() {
  copiedIndex.value = null
  copyErrorIndex.value = null
  window.clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = undefined
}

async function onContentClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const citationButton = target?.closest<HTMLButtonElement>('button[data-citation-number]')
  if (citationButton) {
    const citationNumber = Number(citationButton.dataset.citationNumber)
    if (Number.isSafeInteger(citationNumber)) emit('citation', citationNumber)
    return
  }

  const wrapButton = target?.closest<HTMLButtonElement>('button[data-wrap-index]')
  if (wrapButton) {
    const index = Number(wrapButton.dataset.wrapIndex)
    const restoreFocus = wrapButton === document.activeElement
    if (wrappedIndices.value.has(index)) wrappedIndices.value.delete(index)
    else wrappedIndices.value.add(index)
    await restoreCodeFocus('wrap', index, restoreFocus)
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
  // The block may have been swapped at the same index while the clipboard promise
  // was pending; a stale outcome must not label the new code.
  if (rendered.value.codeBlocks[index] !== content) return
  window.clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = undefined
  copiedCodeText = content
  erroredCodeText = content
  const restoreFocus = copyButton === document.activeElement
  copiedIndex.value = copied ? index : null
  copyErrorIndex.value = copied ? null : index
  await restoreCodeFocus('code', index, restoreFocus)
  if (copied) {
    // One shared timer so an earlier copy cannot cut short a newer one's window.
    copyFeedbackTimer = window.setTimeout(async () => {
      copyFeedbackTimer = undefined
      const focused = markdownElement.value?.querySelector(`button[data-code-index="${index}"]`) === document.activeElement
      if (copiedIndex.value === index) copiedIndex.value = null
      await restoreCodeFocus('code', index, focused)
    }, 1600)
  }
}

async function restoreCodeFocus(action: 'code' | 'wrap', index: number, shouldRestore: boolean) {
  await nextTick()
  if (shouldRestore) markdownElement.value?.querySelector<HTMLButtonElement>(`button[data-${action}-index="${index}"]`)?.focus({ preventScroll: true })
}

function insideLink(tokens: Array<{ type: string }>, index: number) {
  let depth = 0
  for (let tokenIndex = 0; tokenIndex < index; tokenIndex += 1) {
    if (tokens[tokenIndex]?.type === 'link_open') depth += 1
    if (tokens[tokenIndex]?.type === 'link_close') depth = Math.max(0, depth - 1)
  }
  return depth > 0
}

onBeforeUnmount(() => window.clearTimeout(copyFeedbackTimer))
</script>

<template>
  <!-- markdown-it escapes raw HTML because html=false; delegated clicks only accept generated data attributes. -->
  <div ref="markdownElement" class="assistant-markdown" @click="onContentClick" v-html="rendered.html" />
  <span class="sr-only" role="status">
    {{ copiedIndex !== null ? '代码块已精确复制' : copyErrorIndex !== null ? '复制失败，请重试' : '' }}
  </span>
</template>

<style scoped>
.assistant-markdown {
  min-width: 0;
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.72;
  overflow-wrap: anywhere;
}

.assistant-markdown :deep(> :first-child) { margin-top: 0; }
.assistant-markdown :deep(> :last-child) { margin-bottom: 0; }
.assistant-markdown :deep(p),
.assistant-markdown :deep(ul),
.assistant-markdown :deep(ol),
.assistant-markdown :deep(blockquote),
.assistant-markdown :deep(table) { margin-block: var(--space-3); }

.assistant-markdown :deep(h1),
.assistant-markdown :deep(h2),
.assistant-markdown :deep(h3),
.assistant-markdown :deep(h4) {
  margin: var(--space-6) 0 var(--space-2);
  line-height: 1.35;
  text-wrap: balance;
}

.assistant-markdown :deep(h1) { font-size: 24px; }
.assistant-markdown :deep(h2) { font-size: 20px; }
.assistant-markdown :deep(h3) { font-size: 17px; }

.assistant-markdown :deep(ul),
.assistant-markdown :deep(ol) { padding-left: var(--space-6); }

.assistant-markdown :deep(li + li) { margin-top: var(--space-1); }

.assistant-markdown :deep(.assistant-code-block) {
  max-width: 100%;
  margin: var(--space-4) 0;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}

.assistant-markdown :deep(.assistant-code-block > header) {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 11px;
}

.assistant-markdown :deep(.assistant-code-block button) {
  min-height: 32px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}

.assistant-markdown :deep(.assistant-code-block button:hover) { background: var(--accent-soft); }
.assistant-markdown :deep(.assistant-code-actions) { display: flex; flex-shrink: 0; gap: var(--space-1); }
.assistant-markdown :deep(.assistant-code-block button[aria-pressed="true"]) { background: var(--accent-soft); }

.assistant-markdown :deep(pre) {
  max-width: 100%;
  margin: 0;
  overflow-x: auto;
  padding: var(--space-4);
  background: var(--bg-code);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.65;
  scrollbar-color: var(--border-strong) transparent;
  white-space: pre;
}

.assistant-markdown :deep(code) {
  padding: 2px 4px;
  border-radius: 3px;
  background: var(--bg-code);
  font-family: var(--font-mono);
  font-size: .92em;
}

.assistant-markdown :deep(pre code) { padding: 0; background: transparent; }
.assistant-markdown :deep(pre.is-wrapped) { white-space: pre-wrap; overflow-wrap: anywhere; }

.assistant-markdown :deep(a) {
  color: var(--accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

.assistant-markdown :deep(blockquote) {
  margin-inline: 0;
  padding-left: var(--space-4);
  border-left: 1px solid var(--border-strong);
  color: var(--text-secondary);
}

.assistant-markdown :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  scrollbar-color: var(--border-strong) transparent;
}

.assistant-markdown :deep(th),
.assistant-markdown :deep(td) {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  text-align: left;
  vertical-align: top;
}

.assistant-markdown :deep(th) { background: var(--bg-code); }

.assistant-markdown :deep(.assistant-citation) {
  display: inline-flex;
  min-width: 28px;
  min-height: 28px;
  align-items: center;
  justify-content: center;
  margin-inline: 2px;
  padding: 0 var(--space-1);
  border: 1px solid color-mix(in srgb, var(--accent) 52%, var(--border-subtle));
  border-radius: var(--radius-control);
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  font-weight: 750;
  line-height: 1;
  vertical-align: .08em;
}

.assistant-markdown :deep(.assistant-citation:hover) {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, var(--bg-elevated));
}

@media (max-width: 599px) {
  .assistant-markdown { font-size: 16px; }
  .assistant-markdown :deep(.assistant-citation) { min-width: 36px; min-height: 36px; }
}
</style>

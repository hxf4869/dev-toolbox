<script setup lang="ts">
import { ref } from 'vue'

import UiIcon from '../../components/ui/UiIcon.vue'
import SafeMarkdown from '../knowledge/SafeMarkdown.vue'
import type { AttachmentEntry } from '../knowledge/library'
import type {
  ArtifactBlock,
  ArtifactContent,
  KnownArtifactBlock,
} from './contracts'

const props = defineProps<{ content: ArtifactContent; attachments: AttachmentEntry[] }>()
const emit = defineEmits<{ source: [fragmentId: string] }>()
const copiedKey = ref('')
const copyErrorKey = ref('')
const revealedValues = ref(new Set<string>())

function isBlock<T extends KnownArtifactBlock['type']>(
  block: ArtifactBlock,
  type: T,
): block is Extract<KnownArtifactBlock, { type: T }> {
  return block.type === type
}

function attachment(id: string) {
  return props.attachments.find((entry) => entry.id === id)
}

async function copyExact(key: string, value: string) {
  copyErrorKey.value = ''
  try {
    await navigator.clipboard.writeText(value)
    copiedKey.value = key
    window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = ''
    }, 1600)
  } catch {
    copiedKey.value = ''
    copyErrorKey.value = key
  }
}

function copyLabel(key: string) {
  if (copiedKey.value === key) return '已复制'
  if (copyErrorKey.value === key) return '复制失败，重试'
  return '复制'
}

function toggleSensitive(key: string) {
  const next = new Set(revealedValues.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  revealedValues.value = next
}

function unknownType(block: ArtifactBlock) {
  return typeof block.type === 'string' && block.type ? block.type : '未命名类型'
}
</script>

<template>
  <section class="artifact-document" aria-label="AI 派生内容">
    <header class="artifact-document__intro">
      <p>AI 派生内容 · Schema {{ content.schemaVersion }}</p>
      <h3>{{ content.title }}</h3>
      <p>{{ content.summary }}</p>
    </header>

    <section v-if="content.warnings.length" class="warning-list" aria-labelledby="artifact-warnings-title">
      <h4 id="artifact-warnings-title">审阅提醒</h4>
      <article v-for="(warning, index) in content.warnings" :key="`${warning.title}-${index}`" :class="`warning warning--${warning.severity}`">
        <UiIcon :name="warning.severity === 'danger' ? 'shield-alert' : 'triangle-alert'" />
        <div>
          <header><strong>{{ warning.title }}</strong><span>{{ warning.basis === 'source_evidence' ? '根据原始片段' : '根据模型知识' }}</span></header>
          <p>{{ warning.message }}</p>
          <p v-if="warning.recommendation"><strong>建议：</strong>{{ warning.recommendation }}</p>
          <div v-if="warning.sourceFragmentIds.length" class="source-links">
            <button v-for="source in warning.sourceFragmentIds" :key="source" type="button" @click="emit('source', source)"><UiIcon name="file-text" :size="14" /> 查看原始来源 {{ source.slice(0, 8) }}</button>
          </div>
          <p v-else class="uncertain">未关联原始片段，结论不确定，请人工核对。</p>
        </div>
      </article>
    </section>

    <div class="artifact-blocks">
      <article v-for="block in content.blocks" :key="block.id" class="artifact-block">
        <template v-if="isBlock(block, 'markdown')">
          <SafeMarkdown :source="block.markdown" />
        </template>

        <template v-else-if="isBlock(block, 'code')">
          <header class="code-header"><span>{{ block.language || 'text' }} · {{ block.caption || '模型整理' }}</span><button type="button" @click="copyExact(block.id, block.code)"><UiIcon name="copy" :size="14" /> {{ copyLabel(block.id) }}</button></header>
          <pre class="code-content" :class="{ wrap: block.wrapByDefault }" tabindex="0"><code>{{ block.code }}</code></pre>
          <p class="model-caution">模型整理，执行前请核对原文。</p>
        </template>

        <template v-else-if="isBlock(block, 'command')">
          <header class="code-header"><span>{{ block.shell }} · 命令</span><button type="button" @click="copyExact(block.id, block.command)"><UiIcon name="copy" :size="14" /> {{ copyLabel(block.id) }}</button></header>
          <p v-if="block.description" class="block-description">{{ block.description }}</p>
          <pre class="code-content" tabindex="0"><code>{{ block.command }}</code></pre>
          <p class="model-caution">模型整理，执行前请核对原文。</p>
        </template>

        <template v-else-if="isBlock(block, 'command_steps')">
          <h4>{{ block.title }}</h4>
          <ol class="command-steps">
            <li v-for="(step, stepIndex) in block.steps" :key="`${block.id}-${stepIndex}`">
              <h5>{{ step.title }}</h5>
              <p v-if="step.instruction">{{ step.instruction }}</p>
              <section v-for="(command, commandIndex) in step.commands" :key="`${block.id}-${stepIndex}-${commandIndex}`" class="nested-command">
                <header class="code-header"><span>{{ command.shell }}</span><button type="button" @click="copyExact(`${block.id}-${stepIndex}-${commandIndex}`, command.command)"><UiIcon name="copy" :size="14" /> {{ copyLabel(`${block.id}-${stepIndex}-${commandIndex}`) }}</button></header>
                <p v-if="command.description" class="block-description">{{ command.description }}</p>
                <pre class="code-content" tabindex="0"><code>{{ command.command }}</code></pre>
              </section>
              <ul v-if="step.notes?.length" class="notes"><li v-for="note in step.notes" :key="note">{{ note }}</li></ul>
            </li>
          </ol>
          <p class="model-caution">模型整理，执行前请核对原文。</p>
        </template>

        <template v-else-if="isBlock(block, 'key_value')">
          <h4 v-if="block.title">{{ block.title }}</h4>
          <dl class="key-values">
            <div v-for="(entry, entryIndex) in block.entries" :key="`${entry.key}-${entryIndex}`">
              <dt>{{ entry.key }}</dt>
              <dd>
                <code>{{ entry.sensitive && !revealedValues.has(`${block.id}-${entryIndex}`) ? '••••••••' : entry.value }}</code>
                <button v-if="entry.sensitive" type="button" @click="toggleSensitive(`${block.id}-${entryIndex}`)"><UiIcon :name="revealedValues.has(`${block.id}-${entryIndex}`) ? 'eye-off' : 'eye'" :size="14" />{{ revealedValues.has(`${block.id}-${entryIndex}`) ? '隐藏' : '揭示' }}</button>
              </dd>
            </div>
          </dl>
        </template>

        <template v-else-if="isBlock(block, 'table')">
          <h4 v-if="block.title">{{ block.title }}</h4>
          <div class="table-scroll" tabindex="0"><table><thead><tr><th v-for="column in block.columns" :key="column">{{ column }}</th></tr></thead><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td></tr></tbody></table></div>
        </template>

        <template v-else-if="isBlock(block, 'checklist')">
          <h4>{{ block.title }}</h4>
          <ul class="checklist"><li v-for="(item, itemIndex) in block.items" :key="`${item.label}-${itemIndex}`"><span aria-hidden="true" /><p>{{ item.label }}</p><button v-if="item.sourceFragmentIds[0]" type="button" @click="emit('source', item.sourceFragmentIds[0])">来源</button></li></ul>
        </template>

        <template v-else-if="isBlock(block, 'callout')">
          <section class="callout" :class="`callout--${block.tone}`"><UiIcon :name="block.tone === 'danger' ? 'shield-alert' : block.tone === 'warning' ? 'triangle-alert' : 'circle-help'" /><div><h4 v-if="block.title">{{ block.title }}</h4><p>{{ block.body }}</p></div></section>
        </template>

        <template v-else-if="isBlock(block, 'image_reference')">
          <section class="attachment-reference"><UiIcon name="image" :size="24" /><div><h4>{{ attachment(block.attachmentId)?.displayName || '图片附件' }}</h4><p>{{ block.caption || '来自任务输入的图片引用' }}</p><p v-if="block.extractedText"><strong>识别文本：</strong>{{ block.extractedText }}</p></div><a v-if="attachment(block.attachmentId)" :href="attachment(block.attachmentId)?.contentUrl" download>按需下载原图</a><span v-else>附件当前不可用</span></section>
        </template>

        <template v-else-if="isBlock(block, 'attachment_reference')">
          <section class="attachment-reference"><UiIcon name="paperclip" :size="24" /><div><h4>{{ attachment(block.attachmentId)?.displayName || '文件附件' }}</h4><p>{{ block.caption || '来自任务输入的附件引用' }}</p></div><a v-if="attachment(block.attachmentId)" :href="attachment(block.attachmentId)?.contentUrl" download>下载附件</a><span v-else>附件当前不可用</span></section>
        </template>

        <section v-else class="unknown-block" role="note"><UiIcon name="circle-help" /><div><strong>暂不支持的 Artifact 区块</strong><p>类型 “{{ unknownType(block) }}” 来自更新版本。为避免不安全渲染，本页仅保留占位；可升级应用后查看。</p></div></section>

        <footer v-if="block.sourceFragmentIds?.length" class="source-links block-sources">
          <button v-for="source in block.sourceFragmentIds" :key="source" type="button" @click="emit('source', source)"><UiIcon name="file-text" :size="14" /> 原始来源 {{ source.slice(0, 8) }}</button>
        </footer>
      </article>
    </div>

    <footer class="artifact-review">
      <strong>模型审阅完成</strong>
      <p>模型输出未经过目标环境核验；命令只能在人工核对原文和影响后决定是否执行。局限：</p>
      <ul><li v-for="limitation in content.review.limitations" :key="limitation">{{ limitation }}</li></ul>
    </footer>
    <span class="sr-only" role="status">{{ copiedKey ? '内容已精确复制' : copyErrorKey ? '复制失败，请重试' : '' }}</span>
  </section>
</template>

<style scoped>
.artifact-document { display: grid; gap: var(--space-4); }
.artifact-document__intro { padding-bottom: var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.artifact-document__intro p, .artifact-document__intro h3 { margin: 0; }
.artifact-document__intro > p:first-child { color: var(--text-muted); font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.artifact-document__intro h3 { margin-top: var(--space-1); font-size: 20px; }
.artifact-document__intro > p:last-child { margin-top: var(--space-2); color: var(--text-secondary); }
.warning-list, .artifact-blocks { display: grid; gap: var(--space-3); }
.warning-list > h4 { margin: 0; font-size: 13px; }
.warning { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-subtle); border-left: 3px solid var(--warning); border-radius: var(--radius-control); background: var(--bg-elevated); }
.warning--danger { border-left-color: var(--danger); }
.warning--info { border-left-color: var(--accent); }
.warning > svg { margin-top: 2px; color: var(--warning); }
.warning--danger > svg { color: var(--danger); }
.warning--info > svg { color: var(--accent); }
.warning header { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.warning header span { padding: 2px var(--space-2); border-radius: 999px; background: var(--bg-code); color: var(--text-muted); font-size: 10px; }
.warning p { margin: var(--space-1) 0 0; color: var(--text-secondary); }
.warning .uncertain { color: var(--warning); font-size: 11px; }
.artifact-block { min-width: 0; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); }
.artifact-block > h4 { margin: 0 0 var(--space-3); font-size: 15px; }
.code-header { display: flex; min-height: 34px; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 0 var(--space-3); border: 1px solid var(--border-subtle); border-bottom: 0; border-radius: var(--radius-control) var(--radius-control) 0 0; background: var(--bg-code); color: var(--text-muted); font-size: 11px; }
.code-header button, .source-links button, .key-values button, .checklist button { display: inline-flex; align-items: center; gap: var(--space-1); border: 0; background: transparent; color: var(--accent); cursor: pointer; }
.code-content { max-width: 100%; margin: 0; overflow-x: auto; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: 0 0 var(--radius-control) var(--radius-control); background: var(--bg-code); color: var(--text-primary); font-family: var(--font-mono); font-size: 12px; white-space: pre; }
.code-content.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.model-caution { margin: var(--space-2) 0 0; color: var(--warning); font-size: 11px; }
.block-description { margin: 0 0 var(--space-2); color: var(--text-secondary); }
.command-steps { display: grid; gap: var(--space-4); margin: 0; padding-left: var(--space-5); }
.command-steps h5 { margin: 0 0 var(--space-1); font-size: 13px; }
.command-steps p { color: var(--text-secondary); }
.nested-command { margin-top: var(--space-2); }
.notes { color: var(--text-secondary); }
.key-values { display: grid; gap: 1px; margin: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
.key-values > div { display: grid; grid-template-columns: minmax(100px, .35fr) minmax(0, 1fr); background: var(--border-subtle); gap: 1px; }
.key-values dt, .key-values dd { margin: 0; padding: var(--space-2) var(--space-3); background: var(--bg-code); }
.key-values dt { color: var(--text-muted); }
.key-values dd { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: var(--space-2); }
.key-values code { overflow-wrap: anywhere; }
.table-scroll { max-width: 100%; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle); text-align: left; vertical-align: top; }
th { background: var(--bg-code); color: var(--text-secondary); font-size: 11px; }
.checklist { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.checklist li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-2); }
.checklist li > span { width: 15px; height: 15px; margin-top: 3px; border: 1px solid var(--border-strong); border-radius: 3px; }
.checklist p { margin: 0; }
.callout, .attachment-reference, .unknown-block { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-subtle); border-left: 3px solid var(--accent); border-radius: var(--radius-control); background: var(--accent-soft); }
.callout--warning { border-left-color: var(--warning); }
.callout--danger { border-left-color: var(--danger); }
.callout h4, .callout p, .attachment-reference h4, .attachment-reference p, .unknown-block p { margin: 0; }
.callout p, .attachment-reference p, .unknown-block p { color: var(--text-secondary); }
.attachment-reference { grid-template-columns: auto minmax(0, 1fr) auto; background: var(--bg-code); }
.attachment-reference a { align-self: center; }
.unknown-block { background: var(--bg-code); color: var(--text-muted); }
.source-links { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
.source-links button { padding: var(--space-1) var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); font-size: 10px; }
.block-sources { padding-top: var(--space-3); border-top: 1px solid var(--border-subtle); }
.artifact-review { padding: var(--space-4); border: 1px solid color-mix(in srgb, var(--success) 55%, var(--border-subtle)); border-radius: var(--radius-card); background: color-mix(in srgb, var(--success) 8%, var(--bg-elevated)); }
.artifact-review > strong { color: var(--success); }
.artifact-review p { margin: var(--space-1) 0; color: var(--text-secondary); }
.artifact-review ul { margin: var(--space-2) 0 0; padding-left: var(--space-5); }
@media (max-width: 600px) { .artifact-block { padding: var(--space-3); } .key-values > div { grid-template-columns: 1fr; } .attachment-reference { grid-template-columns: auto minmax(0, 1fr); } .attachment-reference a, .attachment-reference > span { grid-column: 2; } }
</style>

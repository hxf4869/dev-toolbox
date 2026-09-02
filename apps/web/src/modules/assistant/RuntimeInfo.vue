<script setup lang="ts">
import { computed } from 'vue'

import type { AssistantRunDTO } from './assistantContracts'
import type { TemporaryRuntimeInfo } from './assistantStore'

const props = defineProps<{
  run: AssistantRunDTO | null
  temporaryRuntime: TemporaryRuntimeInfo | null
}>()

const runtime = computed(() => {
  if (props.run) {
    return {
      status: props.run.status,
      phase: props.run.phase,
      model: props.run.model,
      reasoning: props.run.reasoning,
      promptVersion: props.run.promptVersion,
      retrievalVersion: props.run.retrievalVersion,
      rewriteFallback: props.run.rewriteFallback,
      knowledgeState: props.run.knowledgeState,
      evidenceState: props.run.evidenceState,
      usage: props.run.usage,
      timings: props.run.timings,
      providedSourceCount: props.run.providedSourceCount,
      citationCount: props.run.citationCount,
      error: props.run.error,
    }
  }
  return props.temporaryRuntime
})

function duration(value: number | null) {
  if (value === null) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`
}

function tokenPair(input: number | null, output: number | null) {
  if (input === null && output === null) return 'Provider 未返回'
  const formatter = new Intl.NumberFormat('zh-CN')
  return `${input === null ? 'Provider 未返回' : formatter.format(input)} / ${output === null ? 'Provider 未返回' : formatter.format(output)}`
}

function statusLabel(value: string) {
  return ({
    queued: '排队中',
    running: '生成中',
    succeeded: '已完成',
    failed: '失败',
    stopped: '已停止',
  } as Record<string, string>)[value] ?? value
}

function knowledgeLabel(value: string) {
  return value === 'ready' ? '知识库可用' : '知识库不可用'
}

function evidenceLabel(value: string | null) {
  if (value === 'matched') return '已匹配来源'
  if (value === 'not_found') return '未找到足够依据'
  if (value === 'unavailable') return '知识不可用'
  return '尚未判定'
}
</script>

<template>
  <details v-if="runtime" class="runtime-info">
    <summary>运行信息</summary>
    <div class="runtime-info__body">
      <dl>
        <div><dt>状态</dt><dd>{{ statusLabel(runtime.status) }}</dd></div>
        <div><dt>实际模型</dt><dd>{{ runtime.model.displayName }}</dd></div>
        <div><dt>Provider</dt><dd>{{ runtime.model.providerDisplayName }}</dd></div>
        <div><dt>上游模型 ID</dt><dd><code>{{ runtime.model.upstreamModelId }}</code></dd></div>
        <div><dt>实际思考档位</dt><dd>{{ runtime.reasoning.displayName }}</dd></div>
        <div><dt>Prompt 版本</dt><dd><code>{{ runtime.promptVersion ?? '—' }}</code></dd></div>
        <div><dt>检索版本</dt><dd><code>{{ runtime.retrievalVersion ?? '—' }}</code></dd></div>
        <div><dt>改写回退</dt><dd>{{ runtime.rewriteFallback ? '是' : '否' }}</dd></div>
        <div><dt>知识状态</dt><dd>{{ knowledgeLabel(runtime.knowledgeState) }}</dd></div>
        <div><dt>证据状态</dt><dd>{{ evidenceLabel(runtime.evidenceState) }}</dd></div>
        <div><dt>提供给模型的来源</dt><dd>{{ runtime.providedSourceCount }}</dd></div>
        <div><dt>实际引用</dt><dd>{{ runtime.citationCount }}</dd></div>
      </dl>

      <section aria-labelledby="runtime-timings">
        <h4 id="runtime-timings">耗时</h4>
        <dl>
          <div><dt>总耗时</dt><dd>{{ duration(runtime.timings.totalMs) }}</dd></div>
          <div><dt>查询改写</dt><dd>{{ duration(runtime.timings.rewriteMs) }}</dd></div>
          <div><dt>Embedding</dt><dd>{{ duration(runtime.timings.embeddingMs) }}</dd></div>
          <div><dt>检索</dt><dd>{{ duration(runtime.timings.retrievalMs) }}</dd></div>
          <div><dt>思考</dt><dd>{{ duration(runtime.timings.reasoningMs) }}</dd></div>
          <div><dt>回答</dt><dd>{{ duration(runtime.timings.answerMs) }}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="runtime-usage">
        <h4 id="runtime-usage">Token 用量（输入 / 输出）</h4>
        <dl>
          <div><dt>查询改写</dt><dd>{{ tokenPair(runtime.usage.rewriteInputTokens, runtime.usage.rewriteOutputTokens) }}</dd></div>
          <div><dt>回答</dt><dd>{{ tokenPair(runtime.usage.answerInputTokens, runtime.usage.answerOutputTokens) }}</dd></div>
        </dl>
      </section>

      <p v-if="runtime.error" class="runtime-info__error">
        {{ runtime.error.code }} · {{ runtime.error.message }}
      </p>
    </div>
  </details>
</template>

<style scoped>
.runtime-info {
  margin-top: var(--space-3);
  color: var(--text-secondary);
  font-size: 12px;
}

.runtime-info > summary {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  border-radius: var(--radius-control);
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

.runtime-info > summary:hover { color: var(--text-primary); }

.runtime-info__body {
  display: grid;
  gap: var(--space-4);
  margin-top: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}

.runtime-info__body section { min-width: 0; }
.runtime-info__body h4 { margin: 0 0 var(--space-2); color: var(--text-primary); font-size: 12px; }
.runtime-info dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2) var(--space-5); margin: 0; }
.runtime-info dl > div { display: flex; min-width: 0; justify-content: space-between; gap: var(--space-3); }
.runtime-info dt { color: var(--text-muted); }
.runtime-info dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--text-primary); font-variant-numeric: tabular-nums; text-align: right; }
.runtime-info code { font-family: var(--font-mono); font-size: 11px; }
.runtime-info__error { margin: 0; color: var(--danger); overflow-wrap: anywhere; }

@media (max-width: 599px) {
  .runtime-info { font-size: 13px; }
  .runtime-info dl { grid-template-columns: 1fr; }
}
</style>

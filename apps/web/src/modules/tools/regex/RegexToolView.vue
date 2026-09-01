<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'

import UiButton from '../../../components/ui/UiButton.vue'
import ProcessingBadge from '../shared/ui/ProcessingBadge.vue'
import { REGEX_MATCH_DISPLAY_LIMIT, REGEX_TEXT_LIMIT, type RegexRunResult } from './contracts'
import { RegexRunner } from './regexRunner'

const pattern = ref('(error|warning):\\s+(.+)')
const text = ref('error: connection failed\nwarning: retry scheduled')
const replacement = ref('[$1] $2')
const flags = reactive({ g: true, i: false, m: true, s: false, u: true, y: false })
const result = ref<RegexRunResult | null>(null)
const running = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const runner = new RegexRunner()

const flagString = computed(() => Object.entries(flags).filter(([, enabled]) => enabled).map(([flag]) => flag).join(''))
const textBytes = computed(() => new TextEncoder().encode(text.value).byteLength)
const visibleMatches = computed(() => result.value?.matches.slice(0, REGEX_MATCH_DISPLAY_LIMIT) ?? [])

onBeforeUnmount(() => runner.dispose())

async function runRegex() {
  errorMessage.value = ''
  statusMessage.value = ''
  result.value = null
  const patternBytes = new TextEncoder().encode(pattern.value).byteLength
  const replacementBytes = new TextEncoder().encode(replacement.value).byteLength
  if (textBytes.value > REGEX_TEXT_LIMIT || patternBytes > REGEX_TEXT_LIMIT || replacementBytes > REGEX_TEXT_LIMIT) {
    errorMessage.value = `表达式、测试文本和替换模板单项均不得超过 1 MiB；当前测试文本为 ${formatBytes(textBytes.value)}`
    return
  }
  running.value = true
  try {
    result.value = await runner.run({ pattern: pattern.value, flags: flagString.value, text: text.value, replacement: replacement.value })
    statusMessage.value = result.value.matchLimitReached
      ? `匹配至少 ${REGEX_MATCH_DISPLAY_LIMIT + 1} 次，仅显示前 ${REGEX_MATCH_DISPLAY_LIMIT} 条`
      : `完成：${result.value.matches.length} 个匹配`
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') statusMessage.value = '运行已取消，晚到结果已丢弃'
    else errorMessage.value = error instanceof Error ? error.message : '正则运行失败'
  } finally {
    running.value = false
  }
}

function cancelRun() {
  runner.cancel()
}

function clearAll() {
  runner.cancel()
  pattern.value = ''
  text.value = ''
  replacement.value = ''
  result.value = null
  errorMessage.value = ''
  statusMessage.value = ''
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(2)} MiB`
}
</script>

<template>
  <section class="tool-page" aria-labelledby="regex-title">
    <header class="tool-header">
      <div><p class="breadcrumb">工具箱 / 开发辅助</p><div class="title-line"><h1 id="regex-title">正则测试</h1><span class="engine-badge">JavaScript RegExp</span><ProcessingBadge /></div><p>显式运行浏览器 JavaScript 正则，查看范围、捕获组与替换预览；不会执行函数或回调源码。</p></div>
      <UiButton :disabled="running" @click="clearAll">清空</UiButton>
    </header>

    <p class="safety-note">每次运行使用一次性 Worker；主线程约 500 ms 到期后会终止它。浏览器调度无法保证对所有灾难性表达式实现绝对精确的终止时刻。</p>
    <p v-if="errorMessage" class="notice danger" role="alert">{{ errorMessage }}</p>
    <p v-if="statusMessage" class="notice" role="status">{{ statusMessage }}</p>

    <div class="workspace-grid">
      <section class="tool-card">
        <h2>表达式与测试文本</h2>
        <label for="regex-pattern">正则表达式</label>
        <div class="pattern-row"><span>/</span><input id="regex-pattern" v-model="pattern" :disabled="running" spellcheck="false"><span>/{{ flagString }}</span></div>
        <fieldset class="flag-list"><legend>Flags</legend><label v-for="(description, flag) in { g: '全局', i: '忽略大小写', m: '多行', s: '点匹配换行', u: 'Unicode', y: '粘连' }" :key="flag"><input v-model="flags[flag]" type="checkbox" :disabled="running"><code>{{ flag }}</code><span>{{ description }}</span></label></fieldset>
        <label for="regex-text">测试文本</label><textarea id="regex-text" v-model="text" rows="12" :disabled="running" spellcheck="false" />
        <p class="counter" :class="{ over: textBytes > REGEX_TEXT_LIMIT }">{{ formatBytes(textBytes) }} / 1 MiB</p>
        <label for="regex-replacement">替换模板（只预览）</label><input id="regex-replacement" v-model="replacement" :disabled="running" spellcheck="false">
        <div class="actions"><UiButton v-if="!running" variant="primary" @click="runRegex">运行正则</UiButton><UiButton v-else variant="danger" @click="cancelRun">取消运行</UiButton></div>
      </section>

      <section class="tool-card result-card">
        <h2>匹配结果</h2>
        <template v-if="result">
          <p class="summary"><template v-if="result.matchLimitReached">匹配至少 {{ REGEX_MATCH_DISPLAY_LIMIT + 1 }} 次，仅显示前 {{ REGEX_MATCH_DISPLAY_LIMIT }} 条</template><template v-else>共 {{ result.matches.length }} 个匹配</template> · flags <code>{{ flagString || '无' }}</code></p>
          <div v-if="visibleMatches.length" class="match-list">
            <article v-for="match in visibleMatches" :key="`${match.number}-${match.start}`">
              <header><strong>#{{ match.number }}</strong><span>[{{ match.start }}, {{ match.end }})</span></header>
              <pre>{{ match.value }}</pre>
              <dl v-if="match.groups.length || Object.keys(match.namedGroups).length"><div v-for="(group, index) in match.groups" :key="index"><dt>捕获 {{ index + 1 }}</dt><dd>{{ group ?? '未参与匹配' }}</dd></div><div v-for="(group, name) in match.namedGroups" :key="name"><dt>{{ name }}</dt><dd>{{ group ?? '未参与匹配' }}</dd></div></dl>
            </article>
          </div>
          <p v-else class="empty-inline">没有匹配；原测试文本保持不变。</p>
          <h3>替换预览</h3><p v-if="result.matchLimitReached" class="preview-omitted">结果规模过大，本次未生成替换预览</p><pre v-else class="replacement-preview">{{ result.replacementPreview }}</pre>
        </template>
        <div v-else class="empty-result"><strong>运行后在此显示</strong><span>修改内容不会自动执行或自动重试。</span></div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.tool-page { width: min(100%, 1180px); padding: var(--space-6); }
.tool-header, .title-line, .match-list article header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.tool-header { align-items: flex-start; }
.breadcrumb { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: 12px; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: 26px; }
h2 { font-size: 16px; }
h3 { margin-top: var(--space-5); font-size: 14px; }
.tool-header > div > p:last-child { margin: var(--space-2) 0 0; color: var(--text-secondary); }
.engine-badge { padding: 4px 9px; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--accent); font-family: var(--font-mono); font-size: 11px; }
.safety-note, .notice { margin: var(--space-4) 0 0; padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text-secondary); font-size: 12px; }
.safety-note { border-color: color-mix(in srgb, var(--warning) 45%, var(--border-subtle)); color: var(--warning); }
.notice.danger { border-color: color-mix(in srgb, var(--danger) 55%, var(--border-subtle)); color: var(--danger); }
.workspace-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); margin-top: var(--space-4); }
.tool-card { min-width: 0; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-surface); }
label { display: block; margin-top: var(--space-3); color: var(--text-secondary); font-size: 12px; font-weight: 600; }
input, textarea { width: 100%; min-height: 40px; padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); font-family: var(--font-mono); }
textarea { margin-top: var(--space-1); resize: vertical; }
.pattern-row { display: grid; grid-template-columns: max-content 1fr max-content; align-items: center; gap: var(--space-2); margin-top: var(--space-1); color: var(--text-muted); font-family: var(--font-mono); }
.flag-list { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); padding: 0; border: 0; }
.flag-list legend { color: var(--text-muted); font-size: 11px; }
.flag-list label { display: inline-flex; min-height: 38px; align-items: center; gap: 5px; margin: 0; padding: 0 9px; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); cursor: pointer; }
.flag-list input { width: auto; min-height: auto; }
.flag-list code { color: var(--accent); }
.counter { margin: 2px 0 0; color: var(--text-muted); font-size: 11px; text-align: right; }
.counter.over { color: var(--danger); }
.actions { margin-top: var(--space-4); }
.summary { color: var(--text-muted); font-size: 12px; }
.match-list { display: grid; max-height: 420px; gap: var(--space-3); overflow-y: auto; }
.match-list article { padding: var(--space-3); border: 1px solid var(--border-subtle); border-left: 3px solid var(--accent); border-radius: var(--radius-control); background: var(--bg-code); }
.match-list article header span { color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; }
pre { margin: var(--space-2) 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); }
.match-list dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); margin: var(--space-3) 0 0; }
.match-list dl div { min-width: 0; padding-top: var(--space-2); border-top: 1px solid var(--border-subtle); }
.match-list dt { color: var(--text-muted); font-size: 10px; }
.match-list dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.replacement-preview { min-height: 120px; padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.preview-omitted { padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--warning); }
.empty-result { display: grid; min-height: 420px; place-content: center; gap: var(--space-2); color: var(--text-muted); text-align: center; }
.empty-inline { color: var(--text-muted); }
@media (max-width: 720px) { .tool-page { padding: var(--space-4); } .tool-header { align-items: flex-start; flex-direction: column; } .workspace-grid { grid-template-columns: 1fr; } .title-line { justify-content: flex-start; } .match-list dl { grid-template-columns: 1fr; } }
</style>

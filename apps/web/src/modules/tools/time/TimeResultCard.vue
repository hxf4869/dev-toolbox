<script setup lang="ts">
import type { TimeSnapshot } from './time'

defineProps<{ value: TimeSnapshot | null }>()
defineEmits<{ copy: [value: string] }>()
</script>

<template>
  <section class="tool-card result-card">
    <h2>转换结果</h2>
    <dl v-if="value" class="result-list">
      <div v-for="row in [
        ['Unix 秒', value.unixSeconds],
        ['Unix 毫秒', value.unixMilliseconds],
        ['ISO 8601', value.iso],
        ['UTC', value.utc],
        ['浏览器本地', value.local],
        [`IANA · ${value.timeZone}`, value.zoned],
        ['UTC offset', value.offset],
      ]" :key="row[0]">
        <dt>{{ row[0] }}</dt>
        <dd><code>{{ row[1] }}</code><button type="button" @click="$emit('copy', row[1])">复制</button></dd>
      </div>
    </dl>
    <p v-else class="empty-result">转换后在此显示。</p>
  </section>
</template>

<style scoped>
.tool-card { min-width: 0; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-surface); }
h2 { margin-top: 0; margin-bottom: var(--space-4); font-size: 16px; }
.result-list { display: grid; gap: var(--space-3); margin: 0; }
.result-list div { padding-bottom: var(--space-2); border-bottom: 1px solid var(--border-subtle); }
.result-list dt { color: var(--text-muted); font-size: 11px; }
.result-list dd { display: flex; justify-content: space-between; gap: var(--space-3); margin: 2px 0 0; overflow-wrap: anywhere; }
.result-list code { color: var(--text-primary); font-family: var(--font-mono); }
.result-list button { width: max-content; padding: 0; border: 0; background: transparent; color: var(--accent); cursor: pointer; }
.empty-result { color: var(--text-muted); }
@media (max-width: 720px) { .result-list dd { align-items: flex-start; flex-direction: column; } }
</style>

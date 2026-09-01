<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <section class="not-found" aria-labelledby="not-found-title">
    <p>404</p>
    <h1 id="not-found-title">页面不存在</h1>
    <span>该工具尚未发布，或链接已经失效。</span>
    <RouterLink to="/">返回首页</RouterLink>
  </section>
</template>

<style scoped>
.not-found { width: min(100% - 32px, 620px); margin: 14vh auto 0; padding: var(--space-8); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); }
.not-found p { margin: 0; color: var(--accent); font-family: var(--font-mono); font-weight: 700; }
.not-found h1 { margin: var(--space-2) 0; font-size: 28px; }
.not-found span { display: block; color: var(--text-secondary); }
.not-found a { display: inline-flex; margin-top: var(--space-5); font-weight: 650; text-underline-offset: 3px; }
</style>

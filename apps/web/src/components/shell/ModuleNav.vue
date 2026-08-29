<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import UiIcon from '../ui/UiIcon.vue'

const route = useRoute()
const settingsMode = computed(() => String(route.name).includes('settings'))
</script>

<template>
  <aside class="module-nav" :aria-label="settingsMode ? '设置导航' : '工作台导航'">
    <header class="module-nav__header">
      <p class="module-nav__eyebrow">{{ settingsMode ? '实例与偏好' : '知识与记录' }}</p>
      <h1>{{ settingsMode ? '设置' : '工作台' }}</h1>
    </header>

    <section v-if="settingsMode" aria-labelledby="settings-nav-heading">
      <h2 id="settings-nav-heading">设置</h2>
      <nav>
        <RouterLink to="/settings/security" :class="{ active: route.name === 'security-settings' }">
          <UiIcon name="shield-check" /> 安全与会话
        </RouterLink>
        <RouterLink to="/settings/appearance" :class="{ active: route.name === 'appearance-settings' }">
          <UiIcon name="sun" /> 外观
        </RouterLink>
      </nav>
    </section>

    <template v-else>
      <section aria-labelledby="fixed-views-heading">
        <h2 id="fixed-views-heading">固定视图</h2>
        <nav>
          <RouterLink to="/" :class="{ active: route.name === 'workspace' }">
            <UiIcon name="inbox" /> 原始收件箱
          </RouterLink>
        </nav>
      </section>
      <section class="module-nav__pending" aria-labelledby="library-heading">
        <h2 id="library-heading">资料库</h2>
        <p>M2 将在此加入搜索、目录、标签与回收站。</p>
      </section>
    </template>
  </aside>
</template>

<style scoped>
.module-nav { width: var(--module-nav-width); min-height: 100dvh; padding: var(--space-5) var(--space-4); border-right: 1px solid var(--border-subtle); background: var(--bg-nav); }
.module-nav__header { margin-bottom: var(--space-8); }
.module-nav__eyebrow, h2 { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; }
h1 { margin: 0; font-size: 20px; line-height: 1.3; }
nav { display: grid; gap: var(--space-1); }
nav a { display: flex; align-items: center; gap: var(--space-2); min-height: 38px; padding: 0 var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); color: var(--text-secondary); text-decoration: none; }
nav a:hover, nav a.active { border-color: var(--border-subtle); background: var(--accent-soft); color: var(--accent); }
nav a.active { box-shadow: inset 2px 0 0 var(--accent); }
.module-nav__pending { margin-top: var(--space-6); }
.module-nav__pending p { padding: var(--space-3); border: 1px dashed var(--border-strong); border-radius: var(--radius-card); color: var(--text-muted); font-size: 12px; }
@media (max-width: 1279px) { .module-nav { display: none; } }
</style>

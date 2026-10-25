<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { RouterView, useRoute } from 'vue-router'

import UiIcon from '../ui/UiIcon.vue'
import AppRail from './AppRail.vue'
import ModuleNav from './ModuleNav.vue'

const route = useRoute()
const navigationOpen = ref(false)
const navigationTrigger = ref<HTMLButtonElement | null>(null)

withDefaults(defineProps<{ routeFailureHref?: string }>(), { routeFailureHref: '' })

const navigationLabel = computed(() => ({
  home: '工作入口',
  knowledge: '资料库导航',
  assistant: '知识助手会话',
  tools: '工具列表',
  ai: 'AI 任务导航',
  settings: '设置分类',
  help: '帮助主题',
  'not-found': '全局导航',
})[String(route.meta.module ?? 'not-found')] ?? '模块导航')

const layoutMode = computed(() => {
  if (route.meta.module === 'settings') return 'configuration'
  if (route.meta.module === 'assistant') return 'assistant'
  if (
    route.meta.module === 'knowledge' ||
    route.meta.module === 'ai' ||
    route.name === 'tool-translate'
  ) return 'contained'
  if (String(route.name).startsWith('tool-')) return 'workbench'
  return 'reading'
})

function openNavigation() {
  navigationOpen.value = true
}

async function closeNavigation() {
  navigationOpen.value = false
  await nextTick()
  navigationTrigger.value?.focus()
}
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="shell" :class="{ 'shell--route-failure': routeFailureHref }">
    <AppRail />
    <p v-if="routeFailureHref" class="shell__route-failure" role="alert">
      <UiIcon name="triangle-alert" />
      <span>页面未能打开。当前页面保持原样，请先保留未保存的输入，再重新加载目标页面。</span>
      <a :href="routeFailureHref">重新打开目标页面</a>
    </p>
    <div class="shell__workspace">
      <ModuleNav :open="navigationOpen" @close="closeNavigation" />
      <main id="main-content" class="shell__main" :data-layout="layoutMode" tabindex="-1">
        <div class="shell__compact-bar">
          <button ref="navigationTrigger" type="button" aria-haspopup="dialog" :aria-expanded="navigationOpen" @click="openNavigation">
            <UiIcon name="menu" />
            <span>{{ navigationLabel }}</span>
          </button>
          <span class="shell__route-label">{{ navigationLabel }}</span>
        </div>
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  width: 100%;
  height: 100dvh;
  min-height: 0;
  grid-template-rows: var(--global-header-height) minmax(0, 1fr);
  overflow: hidden;
  /* sticky .shell__compact-bar 最小高度；scroll-padding 与 min-height 同源引用 */
  --shell-compact-bar-height: 52px;
}

.shell__workspace {
  display: grid;
  height: auto;
  min-height: 0;
  grid-template-columns: var(--module-nav-width) minmax(0, 1fr);
  overflow: hidden;
}

/* 仅在提示存在时给外层 grid 增加一行，workspace 始终占据 minmax(0, 1fr) */
.shell--route-failure {
  grid-template-rows: var(--global-header-height) auto minmax(0, 1fr);
}

.shell__route-failure {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid color-mix(in srgb, var(--danger) 60%, var(--border-subtle));
  background: var(--bg-elevated);
  color: var(--danger);
}

.shell__route-failure > span {
  flex: 1 1 24ch;
  min-width: 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.shell__route-failure > a {
  display: inline-flex;
  flex: none;
  min-height: 44px;
  align-items: center;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-app);
  color: var(--accent);
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
}

.shell__route-failure > a:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.shell__main {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--bg-surface);
  overscroll-behavior: contain;
  scrollbar-color: var(--border-strong) transparent;
}

.shell__main[data-layout='contained'],
.shell__main[data-layout='assistant'] {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
}

.shell__main[data-layout='assistant'] { grid-template-rows: minmax(0, 1fr); }

.shell__compact-bar { display: none; }

@media (max-width: 1279px) {
  .shell__workspace { grid-template-columns: minmax(0, 1fr); }
  .shell__main[data-layout='assistant'] { grid-template-rows: auto minmax(0, 1fr); }
  .shell__main { scroll-padding-top: var(--shell-compact-bar-height); }

  .shell__compact-bar {
    position: sticky;
    z-index: 18;
    top: 0;
    display: flex;
    min-height: var(--shell-compact-bar-height);
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-app) 96%, transparent);
  }

  .shell__compact-bar button {
    display: inline-flex;
    min-height: 40px;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-control);
    background: var(--bg-elevated);
    color: var(--text-primary);
    cursor: pointer;
    font-weight: 650;
  }

  .shell__route-label { color: var(--text-muted); font-size: 12px; }
}

@media (max-width: 599px) {
  .shell__compact-bar { min-height: var(--shell-compact-bar-height); padding-inline: var(--space-3); }
  .shell__compact-bar button { min-height: 44px; }
  .shell__route-label { display: none; }

  .shell__main :deep(button),
  .shell__main :deep(select),
  .shell__main :deep(input:not([type='checkbox']):not([type='radio'])) {
    min-height: 44px;
  }

  .shell__main :deep(select) { height: 44px; }

  .shell__main :deep(label:has(input[type='checkbox'])),
  .shell__main :deep(label:has(input[type='radio'])) {
    min-height: 44px;
    align-items: center;
  }
}

@media (max-width: 1000px) {
  .shell__main[data-layout='contained'] {
    display: block;
    overflow: auto;
  }
}
</style>

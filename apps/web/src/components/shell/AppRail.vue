<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { ref } from 'vue'

import { useAuthStore } from '../../app/auth'
import { useThemeStore } from '../../app/theme'
import UiIcon from '../ui/UiIcon.vue'

const route = useRoute()
const theme = useThemeStore()
const auth = useAuthStore()
const loggingOut = ref(false)

async function logout() {
  loggingOut.value = true
  try {
    await auth.logout()
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <nav class="rail" aria-label="全局导航">
    <div class="rail__brand" role="img" aria-label="开发百宝箱">
      <UiIcon name="wrench" :size="20" />
    </div>

    <RouterLink
      class="rail__item"
      :class="{ 'rail__item--active': route.name === 'task-center' }"
      to="/ai/tasks"
      aria-label="AI 任务"
      title="AI 任务"
    >
      <UiIcon name="sparkles" />
    </RouterLink>

    <RouterLink
      class="rail__item"
      :class="{ 'rail__item--active': route.name === 'workspace' || route.name === 'item-detail' }"
      to="/"
      aria-label="工作台"
      title="工作台"
    >
      <UiIcon name="book-open" />
    </RouterLink>

    <RouterLink
      class="rail__item"
      :class="{ 'rail__item--active': route.name === 'security-settings' }"
      to="/settings/security"
      aria-label="登录安全"
      title="登录安全"
    >
      <UiIcon name="shield-check" />
    </RouterLink>

    <RouterLink
      class="rail__item"
      :class="{
        'rail__item--active': [
          'appearance-settings',
          'provider-settings',
          'token-settings',
          'ai-security-settings',
          'ai-schedule-settings',
          'operations-settings',
        ].includes(String(route.name)),
      }"
      to="/settings/providers"
      aria-label="设置"
      title="设置"
    >
      <UiIcon name="settings" />
    </RouterLink>

    <RouterLink
      class="rail__item"
      :class="{ 'rail__item--active': route.name === 'help' }"
      to="/help"
      aria-label="帮助"
      title="帮助"
    >
      <UiIcon name="circle-help" />
    </RouterLink>

    <button class="rail__item rail__logout" type="button" :disabled="loggingOut" aria-label="退出登录" title="退出登录" @click="logout">
      <UiIcon name="log-out" />
    </button>

    <button
      class="rail__item"
      type="button"
      :aria-label="theme.resolved === 'dark' ? '切换为浅色主题' : '切换为深色主题'"
      :title="theme.resolved === 'dark' ? '切换为浅色主题' : '切换为深色主题'"
      @click="theme.toggle"
    >
      <UiIcon :name="theme.resolved === 'dark' ? 'sun' : 'moon'" />
    </button>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  width: var(--rail-width);
  min-height: 100dvh;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-app);
}

.rail__brand,
.rail__item {
  display: inline-flex;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  text-decoration: none;
}

.rail__brand {
  margin-bottom: var(--space-2);
  color: var(--text-primary);
}

.rail__item {
  cursor: pointer;
  background: transparent;
}

.rail__item:hover,
.rail__item--active {
  border-color: var(--border-subtle);
  background: var(--accent-soft);
  color: var(--accent);
}

.rail__item--active {
  box-shadow: inset 2px 0 0 var(--accent);
}

.rail__logout {
  margin-top: auto;
}

@media (max-width: 599px) {
  .rail {
    width: 100%;
    min-height: 56px;
    flex-direction: row;
    justify-content: flex-start;
    padding: var(--space-2) var(--space-3);
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .rail__brand {
    margin: 0 auto 0 0;
  }

  .rail__logout {
    margin-top: 0;
    margin-left: auto;
  }
}
</style>

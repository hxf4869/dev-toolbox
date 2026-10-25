<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { useAuthStore } from '../../app/auth'
import { useThemeStore } from '../../app/theme'
import { ApiError } from '../../lib/api'
import UiIcon from '../ui/UiIcon.vue'

const route = useRoute()
const theme = useThemeStore()
const auth = useAuthStore()
const loggingOut = ref(false)
const logoutError = ref('')
const logoutButton = ref<HTMLButtonElement | null>(null)

const links = [
  { label: '工作台', title: '工作台', to: '/', icon: 'house' as const, active: () => route.name === 'home' },
  {
    label: '知识与记录',
    title: '知识与记录',
    to: '/knowledge',
    icon: 'book-open' as const,
    active: () => route.meta.module === 'knowledge',
  },
  {
    label: '知识助手',
    title: '知识助手',
    to: '/assistant',
    icon: 'sparkles' as const,
    active: () => route.meta.module === 'assistant',
  },
  {
    label: '工具箱',
    title: '工具箱',
    to: '/tools',
    icon: 'wrench' as const,
    active: () => route.meta.module === 'tools',
  },
  {
    label: 'AI 任务',
    title: 'AI 任务',
    to: '/ai/tasks',
    icon: 'clock' as const,
    active: () => route.meta.module === 'ai',
  },
  {
    label: '设置',
    title: '设置',
    to: '/settings/providers',
    icon: 'settings' as const,
    active: () => route.meta.module === 'settings',
  },
]

const themeLabel = computed(() => theme.resolved === 'dark' ? '切换为浅色主题' : '切换为深色主题')

async function logout() {
  loggingOut.value = true
  logoutError.value = ''
  try {
    await auth.logout()
  } catch (error) {
    logoutError.value = error instanceof ApiError
      ? `退出登录未完成：${error.message}`
      : '退出登录未完成：网络连接中断，请检查网络后重试。'
  } finally {
    loggingOut.value = false
  }
}

function dismissLogoutError() {
  logoutError.value = ''
  logoutButton.value?.focus()
}
</script>

<template>
  <header class="rail">
    <RouterLink class="rail__brand" to="/" aria-label="开发百宝箱首页" title="开发百宝箱">
      <UiIcon name="wrench" :size="20" />
      <span>开发百宝箱</span>
    </RouterLink>

    <nav class="rail__primary" aria-label="全局导航">
      <RouterLink
        v-for="link in links"
        :key="link.to"
        class="rail__item"
        :class="{ 'rail__item--active': link.active() }"
        :to="link.to"
        :aria-current="link.active() ? 'page' : undefined"
        :aria-label="link.label"
        :title="link.title"
      >
        <UiIcon :name="link.icon" />
        <span>{{ link.label }}</span>
      </RouterLink>
    </nav>

    <nav class="rail__utilities" aria-label="账户与帮助">
      <RouterLink class="rail__item rail__help" to="/help" :class="{ 'rail__item--active': route.meta.module === 'help' }" aria-label="帮助" title="帮助">
        <UiIcon name="circle-help" />
        <span>帮助</span>
      </RouterLink>
      <button class="rail__item" type="button" :aria-label="themeLabel" :title="themeLabel" @click="theme.toggle">
        <UiIcon :name="theme.resolved === 'dark' ? 'sun' : 'moon'" />
        <span>{{ themeLabel }}</span>
      </button>
      <button ref="logoutButton" class="rail__item" type="button" :disabled="loggingOut" aria-label="退出登录" title="退出登录" @click="logout">
        <UiIcon name="log-out" />
        <span>{{ loggingOut ? '正在退出' : '退出登录' }}</span>
      </button>
    </nav>

    <div v-if="logoutError" class="rail__logout-error" role="alert">
      <UiIcon name="triangle-alert" />
      <span>{{ logoutError }}</span>
      <button type="button" aria-label="关闭退出失败提示" title="关闭退出失败提示" @click="dismissLogoutError">
        <UiIcon name="x" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.rail {
  position: sticky;
  z-index: 30;
  top: 0;
  display: grid;
  width: 100%;
  height: var(--global-header-height);
  grid-template-columns: minmax(max-content, 1fr) auto minmax(max-content, 1fr);
  align-items: center;
  gap: clamp(var(--space-4), 2vw, var(--space-8));
  padding: 0 clamp(var(--space-4), 2vw, var(--space-8));
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-app);
}

.rail__brand {
  display: inline-flex;
  width: max-content;
  min-width: 0;
  min-height: 44px;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-primary);
  font-size: 17px;
  font-weight: 760;
  letter-spacing: -0.02em;
  text-decoration: none;
}

.rail__primary,
.rail__utilities {
  display: flex;
  min-width: 0;
  align-items: stretch;
  gap: var(--space-1);
}

.rail__utilities { justify-self: end; }

.rail__item {
  position: relative;
  display: inline-flex;
  min-width: 44px;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
}

.rail__item:hover,
.rail__item--active { background: var(--accent-soft); color: var(--accent); }

.rail__item--active::before {
  position: absolute;
  right: var(--space-2);
  bottom: calc((var(--global-header-height) - 44px) / -2);
  left: var(--space-2);
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--accent);
  content: '';
}

.rail__item:disabled { cursor: wait; opacity: .5; }

.rail__logout-error {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: clamp(var(--space-4), 2vw, var(--space-8));
  display: flex;
  width: min(360px, calc(100vw - 2 * clamp(var(--space-4), 2vw, var(--space-8))));
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--danger) 60%, var(--border-subtle));
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-overlay);
  color: var(--danger);
}

.rail__logout-error > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }

.rail__logout-error > button {
  display: inline-grid;
  min-width: 44px;
  min-height: 44px;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

@media (max-width: 1100px) {
  .rail { grid-template-columns: max-content minmax(0, 1fr) max-content; gap: var(--space-3); }
  .rail__primary { justify-content: center; }
  .rail__item { padding-inline: var(--space-2); }
  .rail__item > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
}

@media (max-width: 720px) {
  .rail { gap: var(--space-1); padding-inline: var(--space-2); }
  .rail__logout-error { right: var(--space-2); width: min(360px, calc(100vw - 2 * var(--space-2))); }
  .rail__brand { min-width: 44px; justify-content: center; }
  .rail__brand > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .rail__primary { overflow-x: auto; justify-content: flex-start; scrollbar-width: none; }
  .rail__primary::-webkit-scrollbar { display: none; }
  .rail__item { padding-inline: var(--space-2); }
}

@media (max-width: 520px) {
  .rail__help { display: none; }
  .rail__item { min-width: 40px; min-height: 44px; padding-inline: var(--space-1); }
}
</style>

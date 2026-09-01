<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'

const route = useRoute()

const links = [
  { name: 'provider-settings', to: '/settings/providers', label: 'Provider' },
  { name: 'token-settings', to: '/settings/tokens', label: '外部 Agent' },
  { name: 'ai-security-settings', to: '/settings/ai-security', label: 'AI 与敏感数据' },
  { name: 'ai-schedule-settings', to: '/settings/ai-schedule', label: '自动整理' },
  { name: 'aliyun-settings', to: '/settings/aliyun', label: '阿里云服务' },
  { name: 'security-settings', to: '/settings/security', label: '登录安全' },
  { name: 'appearance-settings', to: '/settings/appearance', label: '外观' },
  { name: 'operations-settings', to: '/settings/operations', label: '系统状态' },
]
</script>

<template>
  <nav class="settings-subnav" aria-label="设置分类">
    <RouterLink
      v-for="link in links"
      :key="link.name"
      :to="link.to"
      :aria-current="route.name === link.name ? 'page' : undefined"
    >
      {{ link.label }}
    </RouterLink>
  </nav>
</template>

<style scoped>
.settings-subnav {
  display: none;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.settings-subnav a {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  flex: 0 0 auto;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  text-decoration: none;
}

.settings-subnav a[aria-current='page'] {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

@media (max-width: 1279px) {
  .settings-subnav {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(10rem, 100%), 1fr));
  }
}

@media (max-width: 599px) {
  .settings-subnav { display: none; }
}
</style>

<script setup lang="ts">
import { RouterLink } from 'vue-router'

import UiIcon from '../../components/ui/UiIcon.vue'
import { V2_TOOLS } from './toolLinks'

const groups = [
  { id: 'encoding', title: '编码与数据' },
  { id: 'development', title: '开发辅助' },
  { id: 'online', title: '在线能力' },
] as const
</script>

<template>
  <div class="tools-index">
    <header class="tools-index__header">
      <div>
        <p>工具箱</p>
        <h1>选择一个工具</h1>
        <span class="tools-index__subtitle">本地工具在浏览器中处理；在线能力会在发送前说明接收方与内容。</span>
      </div>
    </header>

    <section v-for="group in groups" :key="group.id" class="tool-group" :aria-labelledby="`${group.id}-heading`">
      <h2 :id="`${group.id}-heading`">{{ group.title }}</h2>
      <div class="tool-list">
        <RouterLink v-for="tool in V2_TOOLS.filter((entry) => entry.group === group.id)" :key="tool.path" :to="tool.path">
          <span class="tool-list__icon"><UiIcon :name="tool.icon" /></span>
          <span class="tool-list__content"><strong>{{ tool.name }}</strong><small>{{ tool.description }}</small></span>
          <span class="tool-list__aside">
            <span class="tool-list__status" :class="{ 'tool-list__status--cloud': tool.processing === 'cloud' }">
              {{ tool.processing === 'cloud' ? '云服务' : '本地' }}
            </span>
            <UiIcon name="chevron-right" :size="16" />
          </span>
        </RouterLink>
      </div>
    </section>

    <p class="tools-index__boundary">
      页面刷新或关闭后输入与结果不可恢复；工具不会自动保存到“知识与记录”。
    </p>
  </div>
</template>

<style scoped>
.tools-index { width: min(100%, var(--content-max)); margin: 0 auto; padding: var(--space-10); }
.tools-index__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); padding-bottom: var(--space-6); border-bottom: 1px solid var(--border-subtle); }
.tools-index__header p { margin: 0 0 var(--space-1); color: var(--accent); font-size: 12px; font-weight: 700; }
.tools-index__header h1 { margin: 0; font-size: clamp(26px, 3vw, 36px); letter-spacing: -0.025em; }
.tools-index__subtitle { display: block; max-width: 68ch; margin-top: var(--space-2); color: var(--text-secondary); }
.tool-group { margin-top: var(--space-8); }
.tool-group h2 { margin: 0 0 var(--space-3); color: var(--text-muted); font-size: 12px; letter-spacing: .04em; }
.tool-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4); }
.tool-list a { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-code); color: var(--text-primary); text-decoration: none; transition: border-color var(--motion-fast) var(--ease-standard), background var(--motion-fast) var(--ease-standard); }
.tool-list a:hover { border-color: var(--border-strong); background: var(--bg-elevated); }
.tool-list__icon { display: grid; width: 38px; height: 38px; place-items: center; border-radius: var(--radius-control); background: var(--accent-soft); color: var(--accent); }
.tool-list__content { display: grid; gap: var(--space-1); }
.tool-list strong { font-size: 14px; }
.tool-list small { color: var(--text-muted); line-height: 1.5; }
.tool-list__aside { display: flex; height: 100%; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: var(--space-3); color: var(--text-muted); }
.tool-list__status { padding: var(--space-1) var(--space-2); border: 1px solid var(--border-subtle); border-radius: 999px; color: var(--text-secondary); font-size: 11px; line-height: 1; }
.tool-list__status--cloud { border-color: var(--accent); color: var(--accent); }
.tools-index__boundary { margin: var(--space-6) 0 0; color: var(--text-muted); font-size: 12px; }

@media (max-width: 1279px) {
  .tools-index { padding: var(--space-8); }
}

@media (max-width: 599px) {
  .tools-index { padding: var(--space-5) var(--space-4) var(--space-8); }
  .tools-index__header { flex-direction: column; gap: var(--space-4); }
  .tool-list { grid-template-columns: 1fr; }
}
</style>

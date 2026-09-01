<script setup lang="ts">
import { RouterLink } from 'vue-router'

import UiIcon from '../../components/ui/UiIcon.vue'
import ProcessingBadge from '../tools/shared/ui/ProcessingBadge.vue'
import { V2_TOOLS } from '../tools/toolLinks'
</script>

<template>
  <!-- Stitch 34: c5ea4b0f34af4d138f7b35a47442639f -->
  <div class="home-view">
    <header class="home-view__intro">
      <p>Dev Toolbox</p>
      <h1>开发与运维工作，从这里进入</h1>
      <span>知识记录与临时工具平级存在；本地工具的正文只停留在当前页面内存。</span>
    </header>

    <section class="module-choices" aria-labelledby="module-heading">
      <h2 id="module-heading" class="sr-only">业务模块</h2>
      <RouterLink class="module-choice" to="/knowledge">
        <span class="module-choice__icon"><UiIcon name="book-open" :size="22" /></span>
        <span class="module-choice__body">
          <strong>知识与记录</strong>
          <span>保存不可变原始事实，完成搜索、附件管理和受控 AI 整理。</span>
        </span>
        <span class="module-choice__action">打开资料库 <UiIcon name="chevron-right" :size="16" /></span>
      </RouterLink>

      <RouterLink class="module-choice" to="/tools">
        <span class="module-choice__icon"><UiIcon name="wrench" :size="22" /></span>
        <span class="module-choice__body">
          <strong>工具箱</strong>
          <span>打开即用的确定性工具，不保存输入、结果或使用历史。</span>
        </span>
        <span class="module-choice__action">浏览工具 <UiIcon name="chevron-right" :size="16" /></span>
      </RouterLink>
    </section>

    <section class="quick-tools" aria-labelledby="quick-tools-heading">
      <header>
        <div>
          <h2 id="quick-tools-heading">常用工具</h2>
          <p>直接进入当前已发布的 V2.0 本地工具。</p>
        </div>
        <RouterLink to="/tools">查看全部工具</RouterLink>
      </header>
      <div class="quick-tools__grid">
        <RouterLink v-for="tool in V2_TOOLS" :key="tool.path" class="quick-tool" :to="tool.path">
          <UiIcon :name="tool.icon" :size="18" />
          <span><strong>{{ tool.name }}</strong><small>{{ tool.description }}</small></span>
          <UiIcon name="chevron-right" :size="15" />
        </RouterLink>
      </div>
    </section>

    <aside class="privacy-note" aria-label="内容处理边界">
      <ProcessingBadge />
      <p>V2.0 的确定性操作不把正文发送到业务 API，也不写入浏览器持久化存储。JSON 的 AI 类型生成只有在你主动选择并确认发送范围后才会外发。</p>
    </aside>
  </div>
</template>

<style scoped>
.home-view {
  width: min(100%, 1180px);
  min-height: 100%;
  margin: 0 auto;
  padding: clamp(28px, 4vw, 56px);
}

.home-view__intro { max-width: 760px; }
.home-view__intro > p { margin: 0 0 var(--space-2); color: var(--accent); font-size: 13px; font-weight: 700; }
.home-view__intro h1 { max-width: 16em; margin: 0; font-size: clamp(30px, 4vw, 46px); line-height: 1.12; letter-spacing: -0.035em; text-wrap: balance; }
.home-view__intro > span { display: block; max-width: 68ch; margin-top: var(--space-4); color: var(--text-secondary); font-size: 15px; }

.module-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  margin-top: var(--space-8);
}

.module-choice {
  display: grid;
  min-height: 176px;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-4);
  align-content: start;
  padding: var(--space-6);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-card);
  background: var(--bg-elevated);
  color: var(--text-primary);
  text-decoration: none;
  transition: border-color var(--motion-fast) var(--ease-standard), background var(--motion-fast) var(--ease-standard);
}

.module-choice:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent-soft) 44%, var(--bg-elevated)); }
.module-choice__icon { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); color: var(--accent); }
.module-choice__body { display: grid; gap: var(--space-2); }
.module-choice__body strong { font-size: 20px; }
.module-choice__body span { color: var(--text-secondary); line-height: 1.65; }
.module-choice__action { display: inline-flex; grid-column: 2; align-items: center; gap: var(--space-1); margin-top: auto; color: var(--accent); font-weight: 650; }

.quick-tools { margin-top: var(--space-10); }
.quick-tools > header { display: flex; align-items: end; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
.quick-tools h2 { margin: 0; font-size: 18px; }
.quick-tools header p { margin: var(--space-1) 0 0; color: var(--text-muted); font-size: 12px; }
.quick-tools header a { font-size: 13px; text-underline-offset: 3px; }
.quick-tools__grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--border-subtle); border-left: 1px solid var(--border-subtle); }
.quick-tool { display: grid; min-height: 106px; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-3); padding: var(--space-4); border-right: 1px solid var(--border-subtle); border-bottom: 1px solid var(--border-subtle); color: var(--text-primary); text-decoration: none; }
.quick-tool > svg:first-child { color: var(--accent); }
.quick-tool > span { display: grid; gap: var(--space-1); }
.quick-tool strong { font-size: 13px; }
.quick-tool small { color: var(--text-muted); font-size: 11px; line-height: 1.5; }
.quick-tool > svg:last-child { color: var(--text-muted); }
.quick-tool:hover { background: var(--bg-elevated); }

.privacy-note { display: flex; align-items: flex-start; gap: var(--space-4); margin-top: var(--space-8); padding-top: var(--space-5); border-top: 1px solid var(--border-subtle); }
.privacy-note p { max-width: 78ch; margin: 2px 0 0; color: var(--text-muted); font-size: 12px; }

@media (max-width: 899px) {
  .quick-tools__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 599px) {
  .home-view { padding: var(--space-5) var(--space-4) var(--space-8); }
  .home-view__intro h1 { font-size: 30px; }
  .module-choices { grid-template-columns: 1fr; }
  .module-choice { min-height: 154px; }
  .quick-tools > header { align-items: flex-start; flex-direction: column; }
  .quick-tools__grid { grid-template-columns: 1fr; }
  .quick-tool { min-height: 88px; }
  .privacy-note { flex-direction: column; }
}
</style>

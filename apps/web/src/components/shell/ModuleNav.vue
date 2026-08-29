<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import LibraryManageDrawer from '../../modules/knowledge/LibraryManageDrawer.vue'
import { type FolderEntry, useLibraryStore } from '../../modules/knowledge/library'
import UiIcon from '../ui/UiIcon.vue'

const route = useRoute()
const library = useLibraryStore()
const navigationError = ref('')
const settingsMode = computed(() => String(route.name).includes('settings'))
const taskMode = computed(() => route.name === 'task-center')

const fixedViews = [
  { id: 'inbox', label: '原始收件箱', icon: 'inbox' as const },
  { id: 'recent', label: '最近记录', icon: 'clock' as const },
  { id: 'favorites', label: '收藏', icon: 'star' as const },
  { id: 'sensitive', label: '敏感记录', icon: 'shield-alert' as const },
  { id: 'images', label: '图片', icon: 'image' as const },
  { id: 'files', label: '文件', icon: 'file-text' as const },
  { id: 'trash', label: '回收站', icon: 'trash-2' as const },
]

const flatFolders = computed(() => flattenFolders(library.folders))

onMounted(async () => {
  if (settingsMode.value || taskMode.value) return
  try {
    await library.loadNavigation()
  } catch (error) {
    navigationError.value = error instanceof Error ? error.message : '目录与标签暂时不可用'
  }
})

function flattenFolders(entries: FolderEntry[], depth = 0): Array<FolderEntry & { depth: number }> {
  return entries.flatMap((entry) => [
    { ...entry, depth },
    ...flattenFolders(entry.children, depth + 1),
  ])
}

function viewActive(view: string) {
  const current = route.query.view || 'inbox'
  return current === view && !route.query.folderId && !route.query.tagId
}
</script>

<template>
  <aside class="module-nav" :aria-label="taskMode ? 'AI 任务导航' : settingsMode ? '设置导航' : '工作台导航'">
    <header class="module-nav__header">
      <p>{{ taskMode ? '受控 AI 工作流' : settingsMode ? '实例与偏好' : '知识与记录' }}</p>
      <h1>{{ taskMode ? 'AI 任务' : settingsMode ? '设置' : '资料库' }}</h1>
    </header>

    <section v-if="taskMode" aria-labelledby="task-nav-heading">
      <h2 id="task-nav-heading">任务工作台</h2>
      <nav>
        <RouterLink to="/ai/tasks" :class="{ active: route.name === 'task-center' && !route.query.itemId && !route.query.status }">
          <UiIcon name="sparkles" /> 全部任务
        </RouterLink>
        <RouterLink :to="{ name: 'task-center', query: { status: 'running' } }" :class="{ active: route.query.status === 'running' }">
          <UiIcon name="clock" /> 运行状态
        </RouterLink>
        <RouterLink to="/settings/ai-schedule">
          <UiIcon name="settings" /> 批量与自动整理
        </RouterLink>
      </nav>
      <p class="module-nav__boundary">AI 仅可读取受控上下文并提交候选 Artifact；不会执行 Shell、SSH、SQL 或任意高权限工具。</p>
    </section>

    <section v-else-if="settingsMode" aria-labelledby="settings-nav-heading">
      <h2 id="settings-nav-heading">设置</h2>
      <nav>
        <RouterLink to="/settings/providers" :class="{ active: route.name === 'provider-settings' }">
          <UiIcon name="boxes" /> Provider 与模型
        </RouterLink>
        <RouterLink to="/settings/tokens" :class="{ active: route.name === 'token-settings' }">
          <UiIcon name="key-round" /> 外部 Agent
        </RouterLink>
        <RouterLink to="/settings/ai-security" :class="{ active: route.name === 'ai-security-settings' }">
          <UiIcon name="shield-alert" /> AI 与敏感数据
        </RouterLink>
        <RouterLink to="/settings/ai-schedule" :class="{ active: route.name === 'ai-schedule-settings' }">
          <UiIcon name="clock" /> 批量与自动整理
        </RouterLink>
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
          <RouterLink
            v-for="view in fixedViews"
            :key="view.id"
            :to="{ name: 'workspace', query: { view: view.id } }"
            :class="{ active: viewActive(view.id) }"
          >
            <UiIcon :name="view.icon" /> <span>{{ view.label }}</span>
          </RouterLink>
        </nav>
      </section>

      <section class="module-nav__section" aria-labelledby="folders-heading">
        <header><h2 id="folders-heading">目录</h2><button type="button" aria-label="管理目录与标签" @click="library.managerOpen = true"><UiIcon name="settings" :size="15" /></button></header>
        <nav v-if="flatFolders.length">
          <RouterLink
            v-for="folder in flatFolders"
            :key="folder.id"
            :to="{ name: 'workspace', query: { folderId: folder.id, sort: 'updated_desc' } }"
            :class="{ active: route.query.folderId === folder.id }"
            :style="{ paddingInlineStart: `${12 + folder.depth * 14}px` }"
          >
            <UiIcon name="folder" /><span>{{ folder.name }}</span><small>{{ folder.itemCount }}</small>
          </RouterLink>
        </nav>
        <p v-else class="module-nav__empty">尚无目录</p>
      </section>

      <section class="module-nav__section" aria-labelledby="tags-heading">
        <h2 id="tags-heading">标签</h2>
        <nav v-if="library.tags.length">
          <RouterLink
            v-for="tag in library.tags"
            :key="tag.id"
            :to="{ name: 'workspace', query: { tagId: tag.id, sort: 'updated_desc' } }"
            :class="{ active: route.query.tagId === tag.id }"
          >
            <UiIcon name="tag" /><span>{{ tag.name }}</span><small>{{ tag.itemCount }}</small>
          </RouterLink>
        </nav>
        <p v-else class="module-nav__empty">尚无标签</p>
      </section>

      <p v-if="navigationError" class="module-nav__error" role="alert">{{ navigationError }}</p>
      <button class="module-nav__manage" type="button" @click="library.managerOpen = true"><UiIcon name="settings" /> 管理资料库结构</button>
      <LibraryManageDrawer />
    </template>
  </aside>
</template>

<style scoped>
.module-nav { width: var(--module-nav-width); min-height: 100dvh; overflow-y: auto; padding: var(--space-5) var(--space-3); border-right: 1px solid var(--border-subtle); background: var(--bg-nav); }
.module-nav__header { margin-bottom: var(--space-6); padding: 0 var(--space-2); }
.module-nav__header p, h2 { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.module-nav__header h1 { margin: 0; font-size: 20px; line-height: 1.3; }
.module-nav__section { margin-top: var(--space-6); }
.module-nav__section > header { display: flex; align-items: center; justify-content: space-between; }
.module-nav__section > header button { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; }
nav { display: grid; gap: 2px; }
nav a { display: flex; min-width: 0; min-height: 36px; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); color: var(--text-secondary); text-decoration: none; }
nav a span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
nav a small { margin-left: auto; color: var(--text-muted); font-size: 10px; }
nav a:hover, nav a.active { border-color: var(--border-subtle); background: var(--accent-soft); color: var(--accent); }
nav a.active { box-shadow: inset 2px 0 0 var(--accent); }
.module-nav__empty { margin: 0; padding: var(--space-2) var(--space-3); color: var(--text-muted); font-size: 11px; }
.module-nav__error { padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); font-size: 11px; }
.module-nav__manage { display: flex; width: 100%; min-height: 38px; align-items: center; gap: var(--space-2); margin-top: var(--space-6); padding: 0 var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.module-nav__manage:hover { background: var(--bg-elevated); color: var(--text-primary); }
.module-nav__boundary { margin-top: var(--space-5); padding: var(--space-3); border: 1px solid var(--border-subtle); border-left: 3px solid var(--accent); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-muted); font-size: 11px; }
@media (max-width: 1099px) { .module-nav { display: none; } }
</style>

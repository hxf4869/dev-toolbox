<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import UiIcon from '../../components/ui/UiIcon.vue'
import LibraryManageDrawer from './LibraryManageDrawer.vue'
import { type FolderEntry, useLibraryStore } from './library'

const route = useRoute()
const library = useLibraryStore()
const manageEntry = ref<HTMLElement | null>(null)

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

onMounted(() => {
  // 读取失败记录在共享 navigationError，这里不再维护组件私有的错误副本。
  void library.loadNavigation().catch(() => {})
})

async function reloadNavigation() {
  const pending = library.loadNavigation()
  await nextTick()
  // 读取开始会卸载重试按钮：焦点落回 body 时停靠到持久的「管理资料库结构」入口，
  // 读取期间不失效；完成后用户已持有的有效焦点不再强行移动。
  if (document.activeElement === document.body) manageEntry.value?.focus()
  try {
    await pending
  } catch {
    // 失败已由共享 navigationError 承载；重试只读，不触发任何写入。
  }
}

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

  <section class="knowledge-nav__section" aria-labelledby="folders-heading">
    <header>
      <h2 id="folders-heading">目录</h2>
      <button type="button" aria-label="管理目录与标签" @click="library.managerOpen = true">
        <UiIcon name="settings" :size="15" />
      </button>
    </header>
    <nav v-if="flatFolders.length && !library.navigationLoading && !library.navigationError">
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
    <p v-else-if="!library.navigationLoading && !library.navigationError" class="knowledge-nav__empty">尚无目录</p>
  </section>

  <section class="knowledge-nav__section" aria-labelledby="tags-heading">
    <h2 id="tags-heading">标签</h2>
    <nav v-if="library.tags.length && !library.navigationLoading && !library.navigationError">
      <RouterLink
        v-for="tag in library.tags"
        :key="tag.id"
        :to="{ name: 'workspace', query: { tagId: tag.id, sort: 'updated_desc' } }"
        :class="{ active: route.query.tagId === tag.id }"
      >
        <UiIcon name="tag" /><span>{{ tag.name }}</span><small>{{ tag.itemCount }}</small>
      </RouterLink>
    </nav>
    <p v-else-if="!library.navigationLoading && !library.navigationError" class="knowledge-nav__empty">尚无标签</p>
  </section>

  <p v-if="library.navigationLoading" class="knowledge-nav__status" role="status">正在读取目录与标签…</p>
  <div v-else-if="library.navigationError" class="knowledge-nav__error" role="alert">
    <p>{{ library.navigationError }}</p>
    <button type="button" @click="reloadNavigation">重新读取目录与标签</button>
  </div>
  <button ref="manageEntry" class="knowledge-nav__manage" type="button" @click="library.managerOpen = true">
    <UiIcon name="settings" /> 管理资料库结构
  </button>
  <LibraryManageDrawer />
</template>

<style scoped>
h2 { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: .05em; }
.knowledge-nav__section { margin-top: var(--space-6); }
.knowledge-nav__section > header { display: flex; align-items: center; justify-content: space-between; }
.knowledge-nav__section > header button { display: grid; width: 32px; height: 32px; place-items: center; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text-muted); cursor: pointer; }
nav { display: grid; gap: 2px; }
nav a { display: flex; min-width: 0; min-height: 38px; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); color: var(--text-secondary); text-decoration: none; }
nav a span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
nav a small { margin-left: auto; color: var(--text-muted); font-size: 10px; }
nav a:hover, nav a.active { border-color: var(--border-subtle); background: var(--accent-soft); color: var(--accent); }
nav a.active { box-shadow: inset 2px 0 0 var(--accent); }
.knowledge-nav__empty { margin: 0; padding: var(--space-2) var(--space-3); color: var(--text-muted); font-size: 11px; }
.knowledge-nav__status { margin: var(--space-4) 0 0; color: var(--text-muted); font-size: 11px; }
.knowledge-nav__error { display: grid; gap: var(--space-2); margin-top: var(--space-4); padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); font-size: 11px; }
.knowledge-nav__error p { margin: 0; overflow-wrap: anywhere; }
.knowledge-nav__error button { display: flex; width: 100%; min-height: 44px; align-items: center; justify-content: center; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.knowledge-nav__error button:hover { background: var(--bg-elevated); color: var(--text-primary); }
.knowledge-nav__manage { display: flex; width: 100%; min-height: 40px; align-items: center; gap: var(--space-2); margin-top: var(--space-6); padding: 0 var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.knowledge-nav__manage:hover { background: var(--bg-elevated); color: var(--text-primary); }
</style>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { type FolderEntry, type TagEntry, useLibraryStore } from './library'

const library = useLibraryStore()
const tab = ref<'folders' | 'tags'>('folders')
const createName = ref('')
const createParent = ref('')
const editingID = ref('')
const editingName = ref('')
const editingParent = ref('')
const deletingID = ref('')
const deletingName = ref('')
const deleteTrigger = ref<HTMLElement | null>(null)
const saving = ref(false)
const errorMessage = ref('')
const manager = ref<HTMLElement | null>(null)
const confirmBox = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)

const flatFolders = computed(() => flattenFolders(library.folders))

watch(
  () => library.managerOpen,
  async (open) => {
    if (open) {
      previousFocus.value = document.activeElement as HTMLElement | null
      await nextTick()
      manager.value?.querySelector<HTMLElement>('input')?.focus()
      return
    }
    resetTransientState()
    await nextTick()
    previousFocus.value?.focus()
    previousFocus.value = null
  },
)

watch(deletingID, async (id) => {
  if (!id) return
  await nextTick()
  manager.value?.querySelector<HTMLElement>('.manager__confirm .manager__cancel')?.focus()
})

function flattenFolders(entries: FolderEntry[], depth = 0): Array<FolderEntry & { depth: number }> {
  return entries.flatMap((entry) => [
    { ...entry, depth },
    ...flattenFolders(entry.children, depth + 1),
  ])
}

function resetTransientState() {
  createName.value = ''
  createParent.value = ''
  editingID.value = ''
  editingName.value = ''
  editingParent.value = ''
  deletingID.value = ''
  deletingName.value = ''
  deleteTrigger.value = null
  errorMessage.value = ''
}

async function createEntry() {
  if (!createName.value.trim()) return
  saving.value = true
  errorMessage.value = ''
  const submittedName = createName.value
  const submittedParent = createParent.value
  void nextTick().then(() => {
    if (!focusIsUsable(document.activeElement as HTMLElement | null)) {
      manager.value?.querySelector<HTMLElement>('.create-form input')?.focus()
    }
  })
  try {
    if (tab.value === 'folders') {
      await library.createFolder(submittedName, submittedParent || null)
    } else {
      await library.createTag(submittedName)
    }
    if (createName.value === submittedName && createParent.value === submittedParent) {
      createName.value = ''
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建失败'
  } finally {
    saving.value = false
  }
}

async function beginFolderEdit(folder: FolderEntry) {
  editingID.value = folder.id
  editingName.value = folder.name
  editingParent.value = folder.parentId ?? ''
  deletingID.value = ''
  await nextTick()
  manager.value?.querySelector<HTMLElement>('.edit-form input')?.focus()
}

async function beginTagEdit(id: string, name: string) {
  editingID.value = id
  editingName.value = name
  editingParent.value = ''
  deletingID.value = ''
  await nextTick()
  manager.value?.querySelector<HTMLElement>('.edit-form input')?.focus()
}

function cancelEdit() {
  if (!editingID.value || saving.value) return
  const id = editingID.value
  editingID.value = ''
  void nextTick().then(() => {
    manager.value?.querySelector<HTMLElement>(`[data-edit-trigger="${id}"]`)?.focus()
  })
}

async function saveEdit() {
  if (!editingID.value || !editingName.value.trim()) return
  saving.value = true
  errorMessage.value = ''
  const id = editingID.value
  let failed = false
  void nextTick().then(() => {
    if (!focusIsUsable(document.activeElement as HTMLElement | null)) {
      manager.value?.querySelector<HTMLElement>('.edit-form input')?.focus()
    }
  })
  try {
    if (tab.value === 'folders') {
      const current = flatFolders.value.find((folder) => folder.id === editingID.value)
      if (!current) return
      if (current.name !== editingName.value.trim()) {
        await library.renameFolder(current.id, editingName.value)
      }
      if ((current.parentId ?? '') !== editingParent.value) {
        await library.moveFolder(current.id, editingParent.value || null)
      }
    } else {
      await library.renameTag(editingID.value, editingName.value)
    }
    editingID.value = ''
  } catch (error) {
    failed = true
    errorMessage.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    saving.value = false
  }
  if (failed) return
  await nextTick()
  if (!focusIsUsable(document.activeElement as HTMLElement | null)) {
    manager.value?.querySelector<HTMLElement>(`[data-edit-trigger="${id}"]`)?.focus()
  }
}

function openFolderDelete(folder: FolderEntry, event: Event) {
  deleteTrigger.value = event.currentTarget as HTMLElement
  deletingName.value = folder.name
  errorMessage.value = ''
  deletingID.value = folder.id
}

function openTagDelete(tag: TagEntry, event: Event) {
  deleteTrigger.value = event.currentTarget as HTMLElement
  deletingName.value = tag.name
  errorMessage.value = ''
  deletingID.value = tag.id
}

function cancelDelete() {
  if (!deletingID.value || saving.value) return
  deletingID.value = ''
  deletingName.value = ''
  const trigger = deleteTrigger.value
  deleteTrigger.value = null
  void nextTick().then(() => trigger?.focus())
}

function focusIsUsable(element: HTMLElement | null): boolean {
  return !!element && element.isConnected && element !== document.body && !element.matches(':disabled')
}

async function confirmDelete() {
  if (!deletingID.value || saving.value) return
  saving.value = true
  errorMessage.value = ''
  await nextTick()
  if (!focusIsUsable(document.activeElement as HTMLElement | null)) confirmBox.value?.focus()
  let failed = false
  try {
    if (tab.value === 'folders') await library.deleteFolder(deletingID.value)
    else await library.deleteTag(deletingID.value)
    deletingID.value = ''
    deletingName.value = ''
    deleteTrigger.value = null
    await nextTick()
    manager.value?.querySelector<HTMLElement>('input')?.focus()
  } catch (error) {
    failed = true
    errorMessage.value = error instanceof Error ? error.message : '删除失败'
  } finally {
    saving.value = false
  }
  if (failed) {
    await nextTick()
    const active = document.activeElement as HTMLElement | null
    if (!focusIsUsable(active) || active === confirmBox.value) {
      confirmBox.value?.querySelector<HTMLElement>('.manager__cancel')?.focus()
    }
  }
}

function close() {
  if (!saving.value) library.managerOpen = false
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    if (deletingID.value) {
      if (!saving.value) cancelDelete()
    } else {
      close()
    }
    return
  }
  if (event.key !== 'Tab' || !manager.value) return
  const scope = deletingID.value
    ? manager.value.querySelector<HTMLElement>('.manager__confirm')
    : manager.value
  const focusable = Array.from(
    scope?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  ).filter((element) => !element.hidden && element.offsetParent !== null)
  if (!focusable.length) {
    event.preventDefault()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="library.managerOpen">
      <div class="manager-overlay" @click="close" />
      <section ref="manager" class="manager" role="dialog" aria-modal="true" aria-labelledby="manager-title" @keydown="onDialogKeydown">
        <header>
          <div>
            <p>资料库结构</p>
            <h2 id="manager-title">管理目录与标签</h2>
          </div>
          <button type="button" aria-label="关闭管理抽屉" :disabled="saving" @click="close"><UiIcon name="x" /></button>
        </header>

        <div class="manager__tabs" role="tablist" aria-label="管理对象">
            <button type="button" role="tab" :aria-selected="tab === 'folders'" :disabled="saving" @click="tab = 'folders'; resetTransientState()">目录</button>
            <button type="button" role="tab" :aria-selected="tab === 'tags'" :disabled="saving" @click="tab = 'tags'; resetTransientState()">标签</button>
        </div>

        <div class="manager__body">
          <form class="create-form" @submit.prevent="createEntry">
            <label>
              <span>{{ tab === 'folders' ? '新目录名称' : '新标签名称' }}</span>
              <input v-model="createName" :maxlength="tab === 'folders' ? 80 : 40" required />
            </label>
            <label v-if="tab === 'folders'">
              <span>上级目录</span>
              <select v-model="createParent">
                <option value="">根目录</option>
                <option v-for="folder in flatFolders" :key="folder.id" :value="folder.id">
                  {{ '　'.repeat(folder.depth) }}{{ folder.name }}
                </option>
              </select>
            </label>
            <UiButton type="submit" variant="primary" :disabled="saving || !createName.trim()"><UiIcon name="plus" /> 创建</UiButton>
          </form>

          <p v-if="errorMessage && !deletingID" class="manager__error" role="alert"><UiIcon name="triangle-alert" /> {{ errorMessage }}</p>

          <ul v-if="tab === 'folders'" class="entry-list">
            <li v-for="folder in flatFolders" :key="folder.id">
              <template v-if="editingID !== folder.id">
                <span class="entry-list__name" :style="{ paddingInlineStart: `${folder.depth * 16}px` }">
                  <UiIcon name="folder" /> <strong>{{ folder.name }}</strong><small>{{ folder.itemCount }} 条</small>
                </span>
                <button type="button" :data-edit-trigger="folder.id" :disabled="saving" @click="beginFolderEdit(folder)">编辑</button>
                <button type="button" class="danger" :disabled="saving" @click="openFolderDelete(folder, $event)">删除</button>
              </template>
              <form v-else class="edit-form" @submit.prevent="saveEdit">
                <input v-model="editingName" maxlength="80" required aria-label="目录名称" :readonly="saving" />
                <select v-model="editingParent" aria-label="上级目录" :disabled="saving">
                  <option value="">根目录</option>
                  <option v-for="candidate in flatFolders.filter((item) => item.id !== folder.id)" :key="candidate.id" :value="candidate.id">
                    {{ '　'.repeat(candidate.depth) }}{{ candidate.name }}
                  </option>
                </select>
                <UiButton type="submit" variant="primary" :disabled="saving || !editingName.trim()">保存</UiButton>
                <UiButton variant="ghost" :disabled="saving" @click="cancelEdit">取消</UiButton>
              </form>
            </li>
          </ul>

          <ul v-else class="entry-list">
            <li v-for="tag in library.tags" :key="tag.id">
              <template v-if="editingID !== tag.id">
                <span class="entry-list__name"><UiIcon name="tag" /><strong>{{ tag.name }}</strong><small>{{ tag.itemCount }} 条</small></span>
              <button type="button" :data-edit-trigger="tag.id" :disabled="saving" @click="beginTagEdit(tag.id, tag.name)">编辑</button>
              <button type="button" class="danger" :disabled="saving" @click="openTagDelete(tag, $event)">删除</button>
              </template>
              <form v-else class="edit-form" @submit.prevent="saveEdit">
                <input v-model="editingName" maxlength="40" required aria-label="标签名称" :readonly="saving" />
                <UiButton type="submit" variant="primary" :disabled="saving || !editingName.trim()">保存</UiButton>
                <UiButton variant="ghost" :disabled="saving" @click="cancelEdit">取消</UiButton>
              </form>
            </li>
          </ul>

          <div v-if="(tab === 'folders' ? flatFolders.length : library.tags.length) === 0" class="manager__empty">
            尚未创建{{ tab === 'folders' ? '目录' : '标签' }}。
          </div>
        </div>

        <footer><span>{{ tab === 'folders' ? '删除目录不会级联删除记录；非空目录会被服务端拒绝。' : '删除标签会解除与记录的关联，原始记录会保留。' }}</span></footer>

        <div v-if="deletingID" ref="confirmBox" class="manager__confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-structure-title" aria-describedby="delete-structure-warning" tabindex="-1">
          <div>
            <h3 id="delete-structure-title">确认删除{{ tab === 'folders' ? '目录' : '标签' }}「{{ deletingName }}」？</h3>
            <p id="delete-structure-warning">{{ tab === 'folders' ? '非空目录不会被删除。' : '标签会从记录上解除，但记录保持不变。' }}</p>
            <p v-if="errorMessage" class="manager__error" role="alert"><UiIcon name="triangle-alert" /> {{ errorMessage }}</p>
            <UiButton variant="danger" :disabled="saving" @click="confirmDelete">确认删除</UiButton>
            <UiButton variant="ghost" class="manager__cancel" :disabled="saving" @click="cancelDelete">取消</UiButton>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.manager-overlay { position: fixed; z-index: var(--layer-overlay); inset: 0; background: var(--scrim); }
.manager { position: fixed; z-index: calc(var(--layer-overlay) + 1); top: 0; right: 0; display: grid; width: min(480px, 100vw); height: 100dvh; grid-template-rows: auto auto minmax(0, 1fr) auto; border-left: 1px solid var(--border-strong); background: var(--bg-surface); box-shadow: var(--shadow-overlay); }
.manager > header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.manager header p, .manager header h2 { margin: 0; }
.manager header p { color: var(--text-muted); font-size: 11px; }
.manager header h2 { font-size: 17px; }
.manager header > button { display: grid; width: 44px; height: 44px; place-items: center; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.manager__tabs { display: grid; grid-template-columns: 1fr 1fr; padding: 0 var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.manager__tabs button { min-height: 44px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-muted); cursor: pointer; }
.manager__tabs button[aria-selected='true'] { border-color: var(--accent); color: var(--text-primary); }
.manager__body { overflow-y: auto; padding: var(--space-4); }
.create-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(130px, .7fr) auto; align-items: end; gap: var(--space-2); padding-bottom: var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.create-form label { display: grid; gap: var(--space-1); color: var(--text-muted); font-size: 11px; }
input, select { width: 100%; min-height: 40px; padding: 0 var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
.entry-list { display: grid; gap: var(--space-1); margin: var(--space-4) 0 0; padding: 0; list-style: none; }
.entry-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-2); min-height: 48px; padding: var(--space-2); border-bottom: 1px solid var(--border-subtle); }
.entry-list__name { display: flex; min-width: 0; align-items: center; gap: var(--space-2); }
.entry-list__name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-list__name small { margin-left: auto; color: var(--text-muted); }
.entry-list li > button { min-width: 40px; min-height: 40px; border: 0; background: transparent; color: var(--accent); cursor: pointer; font-size: 12px; }
.entry-list li > button.danger { color: var(--danger); }
.edit-form { display: grid; grid-column: 1 / -1; grid-template-columns: minmax(0, 1fr) minmax(120px, .7fr) auto auto; gap: var(--space-2); }
.manager__error { display: flex; gap: var(--space-2); margin: var(--space-3) 0; padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); }
.manager__empty { padding: var(--space-8); color: var(--text-muted); text-align: center; }
.manager > footer { padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-subtle); color: var(--text-muted); font-size: 11px; }
.manager__confirm { position: absolute; inset: 0; display: grid; place-content: center; padding: var(--space-4); background: color-mix(in srgb, var(--bg-app) 88%, transparent); }
.manager__confirm > div { width: min(360px, 100%); padding: var(--space-5); border: 1px solid var(--border-strong); border-radius: var(--radius-dialog); background: var(--bg-elevated); box-shadow: var(--shadow-overlay); }
.manager__confirm h3 { margin: 0 0 var(--space-2); overflow-wrap: anywhere; }
.manager__confirm p { margin: 0 0 var(--space-4); color: var(--text-secondary); }
.manager__confirm .manager__error { margin: 0 0 var(--space-3); color: var(--danger); }
.manager__confirm button { width: 100%; margin-top: var(--space-2); }
@media (max-width: 599px) { .create-form, .edit-form { grid-template-columns: 1fr; } .manager { border-left: 0; } .entry-list li > button { min-width: 44px; min-height: 44px; } .manager .create-form button, .manager .edit-form button, .manager .manager__confirm button { min-height: 44px; } }
</style>

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
// 编辑上级候选：命中 excludeSubtreeOf 的目录及其整个子树不进候选（后端拒绝祖先移入子目录）。
const editableParentFolders = computed(() => flattenFolders(library.folders, 0, editingID.value))
// 共享导航读取未知（读取在途或上次读取失败）：旧行与假空态都撤下，由只读重试恢复。
// 读取开始即清旧错，因此 loading 必须与 error 一起进入未知态，否则 GET 在途时旧行会复活。
const navigationUnknown = computed(() => library.navigationLoading || library.navigationError !== '')

// 导航读取在途或失败都会撤下旧行与表单：焦点失效时由这里统一临时停靠，避免留在 body；
// 已有效的用户焦点不动。停靠到容器只是临时位置（focusIsUsable 不认其为最终控件），
// 各动作完成后的既有回焦（如保存成功回行内「编辑」）照常接管；读失败则转到重试按钮。
watch(
  [() => library.navigationLoading, () => library.navigationError],
  async () => {
    if (!library.managerOpen) return
    if (!library.navigationLoading && !library.navigationError) return
    await nextTick()
    if (!library.navigationLoading && !library.navigationError) return
    if (focusIsUsable(document.activeElement as HTMLElement | null)) return
    if (library.navigationError) {
      const retry = manager.value?.querySelector<HTMLElement>('.manager__nav-retry')
      if (retry) retry.focus()
      else manager.value?.querySelector<HTMLElement>('.create-form input')?.focus()
      return
    }
    // 读取在途：写保存在途时行内表单随旧行撤下，先停靠抽屉容器（tabindex=-1），
    // 保存成功后仍由 saveEdit 回焦该行「编辑」；重试在途则停靠可用的创建输入。
    if (saving.value) manager.value?.focus()
    else manager.value?.querySelector<HTMLElement>('.create-form input')?.focus()
  },
)

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
    restoreCloseFocus()
    previousFocus.value = null
  },
)

watch(deletingID, async (id) => {
  if (!id) return
  await nextTick()
  manager.value?.querySelector<HTMLElement>('.manager__confirm .manager__cancel')?.focus()
})

function flattenFolders(
  entries: FolderEntry[],
  depth = 0,
  excludeSubtreeOf = '',
): Array<FolderEntry & { depth: number }> {
  return entries.flatMap((entry) =>
    entry.id === excludeSubtreeOf
      ? []
      : [
          { ...entry, depth },
          ...flattenFolders(entry.children, depth + 1, excludeSubtreeOf),
        ],
  )
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
  errorMessage.value = ''
  await nextTick()
  manager.value?.querySelector<HTMLElement>('.edit-form input')?.focus()
}

async function beginTagEdit(id: string, name: string) {
  editingID.value = id
  editingName.value = name
  editingParent.value = ''
  deletingID.value = ''
  errorMessage.value = ''
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
  // manager 容器（tabindex=-1）只是读取在途的临时停靠位，不算最终可用焦点，
  // 各动作完成后的回焦逻辑据此继续接管。
  return (
    !!element &&
    element.isConnected &&
    element !== document.body &&
    element !== manager.value &&
    !element.matches(':disabled')
  )
}

// 关闭回焦：抽屉打开期间跨尺寸切换会让原触发控件失效（所在 ModuleNav 在 ≤1279 转
// inert，主区移动管理入口在 ≥1100 隐藏）。依次尝试原控件、页面上的「管理目录与标签」
// 管理入口（导航内与主区各一处，按文档序）与 AppShell 紧凑栏导航按钮，以 focus() 后
// document.activeElement 的实际落点确认成功；null/BODY 不是有效候选，原生 focus 被
// 浏览器拒绝（焦点未落到候选）时顺延下一候选。
function restoreCloseFocus() {
  const candidates: Array<HTMLElement | null> = []
  if (previousFocus.value && previousFocus.value !== document.body) candidates.push(previousFocus.value)
  candidates.push(...document.querySelectorAll<HTMLElement>('button[aria-label="管理目录与标签"]'))
  candidates.push(document.querySelector<HTMLElement>('.shell__compact-bar button'))
  for (const candidate of candidates) {
    if (!candidate) continue
    candidate.focus()
    if (document.activeElement === candidate) return
  }
}

// 只读恢复：重新读取目录与标签；失败仍由共享 navigationError 承载，不触发写入。
// 在途/失败的焦点停靠统一由上面的读取状态 watch 一处处理，这里不再重复停靠。
async function retryNavigation() {
  try {
    await library.loadNavigation()
  } catch {
    // 读取失败只更新共享错误，抽屉保持打开供用户再次重试。
  }
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
      <section ref="manager" class="manager" role="dialog" aria-modal="true" aria-labelledby="manager-title" tabindex="-1" @keydown="onDialogKeydown">
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
            <UiButton type="submit" variant="primary" :disabled="saving || !createName.trim() || navigationUnknown"><UiIcon name="plus" /> 创建</UiButton>
          </form>

          <p v-if="library.navigationLoading && !library.navigationError" class="manager__nav-status" role="status">正在读取目录与标签…</p>
          <div v-else-if="library.navigationError" class="manager__nav-error" role="alert">
            <p><UiIcon name="triangle-alert" /> {{ library.navigationError }}</p>
            <UiButton class="manager__nav-retry" variant="secondary" @click="retryNavigation">重新读取目录与标签</UiButton>
          </div>

          <p v-if="errorMessage && !deletingID" class="manager__error" role="alert"><UiIcon name="triangle-alert" /> {{ errorMessage }}</p>

          <ul v-if="tab === 'folders' && !navigationUnknown" class="entry-list">
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
                  <option v-for="candidate in editableParentFolders" :key="candidate.id" :value="candidate.id">
                    {{ '　'.repeat(candidate.depth) }}{{ candidate.name }}
                  </option>
                </select>
                <UiButton type="submit" variant="primary" :disabled="saving || !editingName.trim()">保存</UiButton>
                <UiButton variant="ghost" :disabled="saving" @click="cancelEdit">取消</UiButton>
              </form>
            </li>
          </ul>

          <ul v-else-if="!navigationUnknown" class="entry-list">
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

          <div v-if="!navigationUnknown && (tab === 'folders' ? flatFolders.length : library.tags.length) === 0" class="manager__empty">
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
.manager__nav-status { margin: var(--space-3) 0 0; color: var(--text-muted); font-size: 11px; }
.manager__nav-error { display: grid; justify-items: start; gap: var(--space-2); margin: var(--space-3) 0; padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); }
.manager__nav-error p { display: flex; align-items: center; gap: var(--space-2); margin: 0; overflow-wrap: anywhere; }
.manager__nav-error button { min-height: 44px; padding: 0 var(--space-3); font-size: 12px; }
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

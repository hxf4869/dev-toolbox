<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'

import UiIcon from '../../components/ui/UiIcon.vue'
import type { AssistantConversationDTO, AssistantFolderDTO, UUID } from './assistantContracts'
import AssistantDialog from './AssistantDialog.vue'
import { useAssistantStore } from './assistantStore'

type DialogKind =
  | 'create-folder'
  | 'rename-folder'
  | 'delete-folder'
  | 'rename-conversation'
  | 'move-conversation'
  | 'delete-conversation'

const emit = defineEmits<{ navigate: [] }>()
const store = useAssistantStore()
const {
  activeConversation,
  conversations,
  conversationNextCursor,
  conversationView,
  folderFilter,
  folders,
  navigationLoading,
  temporaryMode,
  actionError,
} = storeToRefs(store)

const openMenuKey = ref<string | null>(null)
const dialog = ref<DialogKind | null>(null)
const targetConversation = ref<AssistantConversationDTO | null>(null)
const targetFolder = ref<AssistantFolderDTO | null>(null)
const nameDraft = ref('')
const moveFolderId = ref<UUID | 'unfiled'>('unfiled')
const folderDeleteChoice = ref<'unfile' | 'delete' | ''>('')
const folderDeleteDangerStep = ref(false)
const actionBusy = ref(false)
const localError = ref('')

const pinnedConversations = computed(() =>
  conversationView.value === 'active' ? conversations.value.filter((entry) => entry.pinned) : [],
)
const regularConversations = computed(() =>
  conversationView.value === 'active'
    ? conversations.value.filter((entry) => !entry.pinned)
    : conversations.value,
)
const scopeTitle = computed(() => {
  if (conversationView.value === 'archived') return '已归档'
  if (folderFilter.value === 'unfiled') return '未分类会话'
  if (folderFilter.value) {
    return folders.value.find((folder) => folder.id === folderFilter.value)?.name ?? '文件夹'
  }
  return '最近会话'
})
const dialogTitle = computed(() => {
  if (dialog.value === 'create-folder') return '新建文件夹'
  if (dialog.value === 'rename-folder') return '重命名文件夹'
  if (dialog.value === 'delete-folder') {
    return folderDeleteDangerStep.value ? '确认永久删除会话' : '删除文件夹'
  }
  if (dialog.value === 'rename-conversation') return '重命名会话'
  if (dialog.value === 'move-conversation') return '移动会话'
  return '永久删除会话'
})
const destructiveDialog = computed(
  () => dialog.value === 'delete-conversation' || folderDeleteDangerStep.value,
)
const submitDisabled = computed(() => {
  if (actionBusy.value) return true
  if (dialog.value === 'create-folder' || dialog.value === 'rename-folder' || dialog.value === 'rename-conversation') {
    return !nameDraft.value.trim()
  }
  if (dialog.value === 'delete-folder' && !folderDeleteDangerStep.value) {
    return !folderDeleteChoice.value
  }
  return false
})

onMounted(() => {
  void store.initialize()
  window.addEventListener('click', closeMenu)
  window.addEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeMenu)
  window.removeEventListener('keydown', onWindowKeydown)
})

function newConversation() {
  closeMenu()
  store.startNewConversation()
  emit('navigate')
}

function temporaryConversation() {
  closeMenu()
  store.startTemporaryConversation()
  emit('navigate')
}

// scope 意图一次同步确定：setFolderFilter 本身负责切回 active 视图并清理旧
// scope 的列表/游标，避免“先 await 切视图、再补一次筛选”的两段请求在等待期
// 间被另一次选择覆盖。
async function selectScope(value: UUID | 'unfiled' | undefined) {
  if (conversationView.value === 'active' && folderFilter.value === value) return
  await store.setFolderFilter(value)
}

async function showArchive() {
  if (conversationView.value !== 'archived') await store.setConversationView('archived')
}

async function selectConversation(conversation: AssistantConversationDTO) {
  await store.selectConversation(conversation)
  emit('navigate')
}

function toggleMenu(id: UUID) {
  const key = `conversation:${id}`
  openMenuKey.value = openMenuKey.value === key ? null : key
}

function closeMenu() {
  openMenuKey.value = null
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeMenu()
}

function openCreateFolder() {
  closeMenu()
  resetDialogState()
  dialog.value = 'create-folder'
}

function openFolderDialog(kind: 'rename-folder' | 'delete-folder', folder: AssistantFolderDTO) {
  closeMenu()
  resetDialogState()
  targetFolder.value = folder
  nameDraft.value = kind === 'rename-folder' ? folder.name : ''
  dialog.value = kind
}

function openConversationDialog(
  kind: 'rename-conversation' | 'move-conversation' | 'delete-conversation',
  conversation: AssistantConversationDTO,
) {
  closeMenu()
  resetDialogState()
  targetConversation.value = conversation
  nameDraft.value = kind === 'rename-conversation' ? conversation.title : ''
  moveFolderId.value = conversation.folderId ?? 'unfiled'
  dialog.value = kind
}

async function togglePinned(conversation: AssistantConversationDTO) {
  closeMenu()
  await runAction(() => store.patchConversation(conversation.id, { pinned: !conversation.pinned }))
}

async function toggleArchived(conversation: AssistantConversationDTO) {
  closeMenu()
  await runAction(() => store.patchConversation(conversation.id, { archived: !conversation.archived }))
}

async function submitDialog() {
  if (!dialog.value || submitDisabled.value) return
  localError.value = ''

  if (
    dialog.value === 'delete-folder' &&
    folderDeleteChoice.value === 'delete' &&
    !folderDeleteDangerStep.value
  ) {
    folderDeleteDangerStep.value = true
    return
  }

  actionBusy.value = true
  try {
    if (dialog.value === 'create-folder') {
      await store.createFolder(nameDraft.value)
    } else if (dialog.value === 'rename-folder' && targetFolder.value) {
      await store.renameFolder(targetFolder.value.id, nameDraft.value)
    } else if (dialog.value === 'delete-folder' && targetFolder.value && folderDeleteChoice.value) {
      await store.deleteFolder(targetFolder.value.id, folderDeleteChoice.value)
    } else if (dialog.value === 'rename-conversation' && targetConversation.value) {
      await store.patchConversation(targetConversation.value.id, { title: nameDraft.value.trim() })
    } else if (dialog.value === 'move-conversation' && targetConversation.value) {
      await store.patchConversation(targetConversation.value.id, {
        folderId: moveFolderId.value === 'unfiled' ? null : moveFolderId.value,
      })
    } else if (dialog.value === 'delete-conversation' && targetConversation.value) {
      await store.removeConversation(targetConversation.value.id)
    }
    closeDialog()
  } catch (error) {
    localError.value = error instanceof Error ? error.message : '操作未成功，请稍后重试。'
  } finally {
    actionBusy.value = false
  }
}

async function runAction(action: () => Promise<unknown>) {
  localError.value = ''
  try {
    await action()
  } catch (error) {
    localError.value = error instanceof Error ? error.message : '操作未成功，请稍后重试。'
  }
}

function closeDialog() {
  dialog.value = null
  resetDialogState()
}

function resetDialogState() {
  targetConversation.value = null
  targetFolder.value = null
  nameDraft.value = ''
  moveFolderId.value = 'unfiled'
  folderDeleteChoice.value = ''
  folderDeleteDangerStep.value = false
  localError.value = ''
}
</script>

<template>
  <div class="assistant-nav">
    <section aria-labelledby="assistant-nav-actions">
      <h2 id="assistant-nav-actions" class="sr-only">对话操作</h2>
      <button
        class="assistant-nav__new"
        :class="{ active: !activeConversation && !temporaryMode }"
        type="button"
        @click="newConversation"
      >
        <UiIcon name="plus" :size="17" />
        <span>新对话</span>
      </button>
      <button
        class="assistant-nav__temporary"
        :class="{ active: temporaryMode }"
        type="button"
        @click="temporaryConversation"
      >
        <UiIcon name="history" :size="16" />
        <span>临时对话</span>
        <small>不保存</small>
      </button>
    </section>

    <section v-if="pinnedConversations.length" class="assistant-nav__section" aria-labelledby="assistant-pinned-heading">
      <h2 id="assistant-pinned-heading">置顶</h2>
      <div class="assistant-nav__list">
        <article
          v-for="conversation in pinnedConversations"
          :key="conversation.id"
          class="assistant-nav__conversation"
          :class="{ active: activeConversation?.id === conversation.id && !temporaryMode }"
        >
          <button class="assistant-nav__conversation-main" type="button" @click="selectConversation(conversation)">
            <UiIcon name="star" :size="15" />
            <span>{{ conversation.title }}</span>
          </button>
          <button
            class="assistant-nav__more"
            type="button"
            :aria-expanded="openMenuKey === `conversation:${conversation.id}`"
            aria-haspopup="menu"
            :aria-label="`${conversation.title}的更多操作`"
            title="更多操作"
            @click.stop="toggleMenu(conversation.id)"
          ><UiIcon name="more-horizontal" :size="17" /></button>
          <div v-if="openMenuKey === `conversation:${conversation.id}`" class="assistant-nav__menu" role="menu" @click.stop>
            <button role="menuitem" type="button" @click="openConversationDialog('rename-conversation', conversation)">重命名</button>
            <button role="menuitem" type="button" @click="openConversationDialog('move-conversation', conversation)">移动到文件夹</button>
            <button role="menuitem" type="button" @click="togglePinned(conversation)">取消置顶</button>
            <button role="menuitem" type="button" @click="toggleArchived(conversation)">归档</button>
            <hr />
            <button class="danger" role="menuitem" type="button" @click="openConversationDialog('delete-conversation', conversation)">永久删除</button>
          </div>
        </article>
      </div>
    </section>

    <section class="assistant-nav__section" aria-labelledby="assistant-folders-heading">
      <header>
        <h2 id="assistant-folders-heading">文件夹</h2>
        <button type="button" aria-label="新建文件夹" title="新建文件夹" @click="openCreateFolder">
          <UiIcon name="plus" :size="15" />
        </button>
      </header>
      <div class="assistant-nav__list">
        <button
          class="assistant-nav__scope"
          :class="{ active: conversationView === 'active' && folderFilter === undefined }"
          type="button"
          @click="selectScope(undefined)"
        ><UiIcon name="clock" :size="15" /><span>最近会话</span></button>
        <button
          class="assistant-nav__scope"
          :class="{ active: conversationView === 'active' && folderFilter === 'unfiled' }"
          type="button"
          @click="selectScope('unfiled')"
        ><UiIcon name="inbox" :size="15" /><span>未分类</span></button>
        <div v-for="folder in folders" :key="folder.id" class="assistant-nav__folder">
          <button
            class="assistant-nav__scope"
            :class="{ active: conversationView === 'active' && folderFilter === folder.id }"
            type="button"
            @click="selectScope(folder.id)"
          >
            <UiIcon name="folder" :size="15" />
            <span>{{ folder.name }}</span>
            <small>{{ folder.conversationCount }}</small>
          </button>
          <button class="assistant-nav__folder-more" type="button" :aria-label="`${folder.name}文件夹操作`" title="文件夹操作" @click.stop="openMenuKey = openMenuKey === `folder:${folder.id}` ? null : `folder:${folder.id}`">
            <UiIcon name="more-horizontal" :size="16" />
          </button>
          <div v-if="openMenuKey === `folder:${folder.id}`" class="assistant-nav__menu" role="menu" @click.stop>
            <button role="menuitem" type="button" @click="openFolderDialog('rename-folder', folder)">重命名</button>
            <hr />
            <button class="danger" role="menuitem" type="button" @click="openFolderDialog('delete-folder', folder)">删除文件夹</button>
          </div>
        </div>
      </div>
    </section>

    <section class="assistant-nav__section" aria-labelledby="assistant-conversations-heading">
      <header>
        <h2 id="assistant-conversations-heading">{{ scopeTitle }}</h2>
        <span v-if="navigationLoading" class="assistant-nav__busy" role="status">读取中</span>
      </header>
      <div v-if="regularConversations.length" class="assistant-nav__list">
        <article
          v-for="conversation in regularConversations"
          :key="conversation.id"
          class="assistant-nav__conversation"
          :class="{ active: activeConversation?.id === conversation.id && !temporaryMode }"
        >
          <button class="assistant-nav__conversation-main" type="button" @click="selectConversation(conversation)">
            <UiIcon :name="conversation.archived ? 'history' : 'book-open'" :size="15" />
            <span>{{ conversation.title }}</span>
          </button>
          <button
            class="assistant-nav__more"
            type="button"
            :aria-expanded="openMenuKey === `conversation:${conversation.id}`"
            aria-haspopup="menu"
            :aria-label="`${conversation.title}的更多操作`"
            title="更多操作"
            @click.stop="toggleMenu(conversation.id)"
          ><UiIcon name="more-horizontal" :size="17" /></button>
          <div v-if="openMenuKey === `conversation:${conversation.id}`" class="assistant-nav__menu" role="menu" @click.stop>
            <button role="menuitem" type="button" @click="openConversationDialog('rename-conversation', conversation)">重命名</button>
            <button v-if="!conversation.archived" role="menuitem" type="button" @click="openConversationDialog('move-conversation', conversation)">移动到文件夹</button>
            <button v-if="!conversation.archived" role="menuitem" type="button" @click="togglePinned(conversation)">{{ conversation.pinned ? '取消置顶' : '置顶' }}</button>
            <button role="menuitem" type="button" @click="toggleArchived(conversation)">{{ conversation.archived ? '恢复' : '归档' }}</button>
            <hr />
            <button class="danger" role="menuitem" type="button" @click="openConversationDialog('delete-conversation', conversation)">永久删除</button>
          </div>
        </article>
      </div>
      <p v-else-if="!navigationLoading" class="assistant-nav__empty">这里还没有会话。</p>
      <button
        v-if="conversationNextCursor"
        class="assistant-nav__load-more"
        type="button"
        :disabled="navigationLoading"
        @click="store.loadNavigation(true)"
      >{{ navigationLoading ? '正在读取…' : '加载更多' }}</button>
    </section>

    <button
      class="assistant-nav__archive"
      :class="{ active: conversationView === 'archived' }"
      type="button"
      @click="showArchive"
    ><UiIcon name="history" :size="16" /><span>已归档</span></button>

    <p v-if="localError || actionError" class="assistant-nav__error" role="alert">{{ localError || actionError }}</p>
  </div>

  <AssistantDialog
    :open="Boolean(dialog)"
    title-id="assistant-nav-dialog-title"
    :role="destructiveDialog ? 'alertdialog' : 'dialog'"
    @close="closeDialog"
  >
    <template #title><h2 id="assistant-nav-dialog-title">{{ dialogTitle }}</h2></template>

    <label v-if="dialog === 'create-folder' || dialog === 'rename-folder' || dialog === 'rename-conversation'" class="assistant-nav__field">
      <span>{{ dialog === 'rename-conversation' ? '会话名称' : '文件夹名称' }}</span>
      <input v-model="nameDraft" type="text" maxlength="120" autocomplete="off" @keydown.enter.prevent="submitDialog" />
    </label>

    <label v-else-if="dialog === 'move-conversation'" class="assistant-nav__field">
      <span>目标位置</span>
      <select v-model="moveFolderId">
        <option value="unfiled">未分类</option>
        <option v-for="folder in folders" :key="folder.id" :value="folder.id">{{ folder.name }}</option>
      </select>
    </label>

    <div v-else-if="dialog === 'delete-folder' && targetFolder" class="assistant-nav__confirm">
      <template v-if="!folderDeleteDangerStep">
        <p>“{{ targetFolder.name }}”内有 {{ targetFolder.conversationCount }} 个会话。请选择删除文件夹后如何处理这些会话。</p>
        <label>
          <input v-model="folderDeleteChoice" type="radio" value="unfile" />
          <span><strong>会话移到未分类</strong><small>只删除文件夹，会话与运行记录保留。</small></span>
        </label>
        <label>
          <input v-model="folderDeleteChoice" type="radio" value="delete" />
          <span><strong>永久删除全部会话</strong><small>会话、消息、运行和来源都不可恢复。</small></span>
        </label>
      </template>
      <template v-else>
        <p><strong>将永久删除“{{ targetFolder.name }}”及其中 {{ targetFolder.conversationCount }} 个会话。</strong></p>
        <p>这会同时删除消息、运行记录和引用来源，无法撤销。</p>
      </template>
    </div>

    <div v-else-if="dialog === 'delete-conversation' && targetConversation" class="assistant-nav__confirm">
      <p><strong>永久删除“{{ targetConversation.title }}”？</strong></p>
      <p>消息、运行记录和引用来源会一并删除，无法撤销。</p>
    </div>

    <p v-if="localError" class="assistant-nav__dialog-error" role="alert">{{ localError }}</p>

    <template #footer>
      <button class="assistant-nav__button secondary" type="button" :disabled="actionBusy" @click="closeDialog">取消</button>
      <button
        class="assistant-nav__button"
        :class="{ danger: destructiveDialog }"
        type="button"
        :disabled="submitDisabled"
        @click="submitDialog"
      >
        {{ actionBusy ? '正在处理…' : folderDeleteChoice === 'unfile' && dialog === 'delete-folder' ? '删除并移到未分类' : folderDeleteChoice === 'delete' && !folderDeleteDangerStep ? '继续' : destructiveDialog ? '永久删除' : '确认' }}
      </button>
    </template>
  </AssistantDialog>
</template>

<style scoped>
.assistant-nav { display: grid; align-content: start; gap: var(--space-5); min-width: 0; padding-bottom: var(--space-6); }
.assistant-nav h2 { margin: 0; color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: .05em; }
.assistant-nav__new,
.assistant-nav__temporary,
.assistant-nav__archive,
.assistant-nav__scope { display: flex; width: 100%; min-width: 0; min-height: 40px; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }
.assistant-nav__new { border-color: var(--accent); background: var(--accent); color: var(--accent-contrast); font-weight: 700; }
.assistant-nav__new:hover { filter: brightness(1.04); }
.assistant-nav__temporary { margin-top: var(--space-1); border-color: var(--border-subtle); }
.assistant-nav__temporary small { margin-left: auto; color: var(--text-muted); font-size: 10px; }
.assistant-nav__temporary.active,
.assistant-nav__archive.active,
.assistant-nav__scope.active { border-color: var(--border-subtle); background: var(--accent-soft); color: var(--accent); box-shadow: inset 2px 0 0 var(--accent); }
.assistant-nav__section { min-width: 0; }
.assistant-nav__section > header { display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 0 var(--space-1); }
.assistant-nav__section > header > button { display: grid; width: 32px; height: 32px; place-items: center; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text-muted); cursor: pointer; }
.assistant-nav__section > header > button:hover { background: var(--bg-code); color: var(--text-primary); }
.assistant-nav__list { display: grid; gap: 2px; }
.assistant-nav__scope:hover,
.assistant-nav__archive:hover,
.assistant-nav__temporary:hover { border-color: var(--border-subtle); background: var(--bg-code); color: var(--text-primary); }
.assistant-nav__scope span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assistant-nav__scope small { margin-left: auto; color: var(--text-muted); font-size: 10px; }
.assistant-nav__folder,
.assistant-nav__conversation { position: relative; display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) 32px; align-items: center; border: 1px solid transparent; border-radius: var(--radius-control); }
.assistant-nav__folder:hover,
.assistant-nav__conversation:hover,
.assistant-nav__conversation.active { border-color: var(--border-subtle); background: var(--bg-code); }
.assistant-nav__conversation.active { color: var(--accent); box-shadow: inset 2px 0 0 var(--accent); }
.assistant-nav__folder .assistant-nav__scope { grid-column: 1 / -1; grid-row: 1; padding-right: 38px; }
.assistant-nav__conversation-main { display: flex; min-width: 0; min-height: 40px; align-items: center; gap: var(--space-2); padding: 0 0 0 var(--space-3); border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.assistant-nav__conversation-main span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assistant-nav__more,
.assistant-nav__folder-more { z-index: 1; display: grid; width: 32px; height: 32px; grid-column: 2; grid-row: 1; place-items: center; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text-muted); cursor: pointer; }
.assistant-nav__more:hover,
.assistant-nav__folder-more:hover { background: var(--bg-elevated); color: var(--text-primary); }
.assistant-nav__menu { position: absolute; z-index: 12; top: calc(100% + 3px); right: 0; display: grid; width: 172px; padding: var(--space-1); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-elevated); box-shadow: var(--shadow-overlay); }
.assistant-nav__menu button { min-height: 36px; padding: 0 var(--space-3); border: 0; border-radius: calc(var(--radius-control) - 2px); background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }
.assistant-nav__menu button:hover { background: var(--bg-code); color: var(--text-primary); }
.assistant-nav__menu button.danger { color: var(--danger); }
.assistant-nav__menu hr { width: 100%; margin: var(--space-1) 0; border: 0; border-top: 1px solid var(--border-subtle); }
.assistant-nav__busy { color: var(--text-muted); font-size: 10px; }
.assistant-nav__empty { margin: var(--space-2) 0 0; padding: var(--space-3); border: 1px dashed var(--border-subtle); border-radius: var(--radius-control); color: var(--text-muted); font-size: 11px; text-align: center; }
.assistant-nav__load-more { width: 100%; min-height: 36px; margin-top: var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.assistant-nav__archive { border-top: 1px solid var(--border-subtle); border-radius: 0 0 var(--radius-control) var(--radius-control); }
.assistant-nav__error { margin: 0; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--danger) 54%, var(--border-subtle)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); font-size: 11px; }
.assistant-nav__field { display: grid; gap: var(--space-2); color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.assistant-nav__field input,
.assistant-nav__field select { width: 100%; min-height: 42px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); outline: 0; background: var(--bg-surface); color: var(--text-primary); }
.assistant-nav__field input:focus,
.assistant-nav__field select:focus { border-color: var(--focus-ring); box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus-ring) 24%, transparent); }
.assistant-nav__confirm { display: grid; gap: var(--space-3); }
.assistant-nav__confirm > p { margin: 0; color: var(--text-secondary); line-height: 1.6; }
.assistant-nav__confirm label { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); cursor: pointer; }
.assistant-nav__confirm label:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.assistant-nav__confirm input { margin-top: 3px; accent-color: var(--accent); }
.assistant-nav__confirm span { display: grid; gap: var(--space-1); }
.assistant-nav__confirm small { color: var(--text-muted); font-weight: 400; line-height: 1.5; }
.assistant-nav__dialog-error { margin: var(--space-3) 0 0; color: var(--danger); font-size: 12px; }
.assistant-nav__button { min-height: 40px; padding: 0 var(--space-4); border: 1px solid var(--accent); border-radius: var(--radius-control); background: var(--accent); color: var(--accent-contrast); cursor: pointer; font-weight: 700; }
.assistant-nav__button.secondary { border-color: var(--border-strong); background: transparent; color: var(--text-secondary); }
.assistant-nav__button.danger { border-color: color-mix(in srgb, var(--danger) 58%, var(--border-subtle)); background: color-mix(in srgb, var(--danger) 10%, var(--bg-elevated)); color: var(--danger); }
.assistant-nav__button:disabled { cursor: not-allowed; opacity: .55; }

@media (max-width: 1279px) {
  .assistant-nav__new,
  .assistant-nav__temporary,
  .assistant-nav__archive,
  .assistant-nav__scope,
  .assistant-nav__conversation-main { min-height: 44px; }
}
</style>

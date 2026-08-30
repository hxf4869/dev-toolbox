<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { ApiError, apiRequest, jsonRequest } from '../../lib/api'
import { type FolderEntry, useLibraryStore } from './library'

interface CreatedItem {
  id: string
  title: string
  sensitivity: 'normal' | 'sensitive' | 'unknown'
  createdAt: string
}

interface CreateResponse {
  item: CreatedItem
}

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  close: []
  created: [item: CreatedItem]
}>()

const auth = useAuthStore()
const library = useLibraryStore()
const body = ref('')
const contentFormat = ref<'plain_text' | 'markdown'>('plain_text')
const sensitive = ref(false)
const title = ref('')
const folderId = ref('')
const tagIds = ref<string[]>([])
const files = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const editor = ref<HTMLTextAreaElement | null>(null)
const drawer = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)
const saving = ref(false)
const errorMessage = ref('')
const savedMessage = ref('')
const confirmDiscard = ref(false)
const submissionKey = ref('')
const submissionSignature = ref('')
const flatFolders = computed(() => flattenFolders(library.folders))

const dirty = computed(
  () =>
    body.value !== '' ||
    files.value.length > 0 ||
    title.value !== '' ||
    folderId.value !== '' ||
    tagIds.value.length > 0 ||
    sensitive.value ||
    contentFormat.value !== 'plain_text',
)
const totalBytes = computed(() => files.value.reduce((total, file) => total + file.size, 0))
const canSave = computed(
  () => !saving.value && (body.value.trim() !== '' || files.value.length > 0),
)

watch(
  () => props.open,
  (open) => {
    if (open) {
      savedMessage.value = ''
      previousFocus.value = document.activeElement as HTMLElement | null
      void focusEditor()
    } else {
      confirmDiscard.value = false
      previousFocus.value?.focus()
      previousFocus.value = null
    }
  },
)

watch(confirmDiscard, async (open) => {
  await nextTick()
  if (open) drawer.value?.querySelector<HTMLElement>('.discard-state button')?.focus()
  else if (props.open) editor.value?.focus()
})

async function focusEditor() {
  await nextTick()
  editor.value?.focus()
}

function requestClose() {
  if (saving.value) return
  if (dirty.value) {
    confirmDiscard.value = true
    return
  }
  emit('close')
}

function closeAndDiscard() {
  resetForm()
  confirmDiscard.value = false
  emit('close')
}

function resetForm() {
  body.value = ''
  contentFormat.value = 'plain_text'
  sensitive.value = false
  title.value = ''
  folderId.value = ''
  tagIds.value = []
  files.value = []
  errorMessage.value = ''
  submissionKey.value = ''
  submissionSignature.value = ''
  if (fileInput.value) fileInput.value.value = ''
}

function onEscape(event: Event) {
  if (dirty.value || saving.value) {
    event.preventDefault()
    requestClose()
  }
}

function dialogFocusScope() {
  if (!drawer.value) return null
  return confirmDiscard.value
    ? drawer.value.querySelector<HTMLElement>('.discard-state')
    : drawer.value
}

function dialogFocusableElements(scope: HTMLElement) {
  return Array.from(
    scope.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.offsetParent !== null,
  )
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    onEscape(event)
    if (!event.defaultPrevented) requestClose()
    return
  }
  if (event.key !== 'Tab') return
  const scope = dialogFocusScope()
  if (!scope) return
  const focusable = dialogFocusableElements(scope)
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  } else {
    const moveToEnd = event.shiftKey
    window.setTimeout(() => {
      const currentScope = dialogFocusScope()
      if (!currentScope || currentScope.contains(document.activeElement)) return
      const currentFocusable = dialogFocusableElements(currentScope)
      const target = moveToEnd
        ? currentFocusable[currentFocusable.length - 1]
        : currentFocusable[0]
      target?.focus()
    }, 0)
  }
}

function chooseFiles() {
  fileInput.value?.click()
}

function onFileSelection(event: Event) {
  const input = event.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}

function onPaste(event: ClipboardEvent) {
  const pastedFiles = Array.from(event.clipboardData?.files ?? [])
  if (pastedFiles.length > 0) addFiles(pastedFiles)
}

function addFiles(incoming: File[]) {
  errorMessage.value = ''
  const next = [...files.value]
  for (const file of incoming) {
    if (next.length >= 10) {
      errorMessage.value = '单次最多上传 10 个附件。'
      break
    }
    if (file.size > 20 * 1024 * 1024) {
      errorMessage.value = `“${file.name}”超过 20 MiB，未加入本次录入。`
      continue
    }
    if (next.reduce((total, current) => total + current.size, 0) + file.size > 100 * 1024 * 1024) {
      errorMessage.value = '本次附件实际总字节不能超过 100 MiB。'
      break
    }
    next.push(file)
  }
  files.value = next
}

function removeFile(index: number) {
  files.value.splice(index, 1)
  errorMessage.value = ''
}

async function save() {
  if (!canSave.value) return
  errorMessage.value = ''
  savedMessage.value = ''
  const metadata = {
    body: body.value,
    contentFormat: contentFormat.value,
    sensitivity: sensitive.value ? 'sensitive' : 'normal',
    title: title.value.trim() || null,
    folderId: folderId.value || null,
    tagIds: tagIds.value,
  }
  const signature = JSON.stringify({
    ...metadata,
    files: files.value.map((file) => [file.name, file.size, file.type, file.lastModified]),
  })
  if (!submissionKey.value || signature !== submissionSignature.value) {
    submissionKey.value = crypto.randomUUID()
    submissionSignature.value = signature
  }

  saving.value = true
  try {
    let response: CreateResponse
    if (files.value.length === 0) {
      const request = jsonRequest('POST', metadata, auth.csrfToken)
      request.headers = { ...request.headers, 'Idempotency-Key': submissionKey.value }
      response = await apiRequest<CreateResponse>('/api/v1/items', request)
    } else {
      const form = new FormData()
      form.append('metadata', JSON.stringify(metadata))
      for (const file of files.value) form.append('files[]', file, file.name)
      response = await apiRequest<CreateResponse>('/api/v1/items:multipart', {
        method: 'POST',
        headers: {
          'X-CSRF-Token': auth.csrfToken,
          'Idempotency-Key': submissionKey.value,
        },
        body: form,
      })
    }
    emit('created', response.item)
    resetForm()
    savedMessage.value = `“${response.item.title}”已保存。可以继续录入下一条。`
    await focusEditor()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保存失败，请重试'
    if (error instanceof ApiError && error.requestId) {
      errorMessage.value += `（请求 ${error.requestId}）`
    }
  } finally {
    saving.value = false
  }
}

function onEditorKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    void save()
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function flattenFolders(entries: FolderEntry[], depth = 0): Array<FolderEntry & { depth: number }> {
  return entries.flatMap((entry) => [
    { ...entry, depth },
    ...flattenFolders(entry.children, depth + 1),
  ])
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open">
      <div class="capture-overlay" @click="requestClose" />
      <section
        ref="drawer"
        class="capture-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-title"
        aria-describedby="capture-description"
        @keydown="onDialogKeydown"
      >
        <header class="capture-drawer__header">
          <div>
            <h2 id="capture-title">快速记录</h2>
            <p id="capture-description">保存原始事实；AI 不参与本次提交。</p>
          </div>
          <button type="button" class="icon-button" aria-label="关闭快速记录" @click="requestClose">
            <UiIcon name="x" />
          </button>
        </header>

        <div class="capture-drawer__body">
          <div v-if="sensitive" class="sensitive-banner" role="status">
            <UiIcon name="shield-alert" />
            <span><strong>敏感内容</strong>列表将使用安全标题，原文仅在明确揭示后读取。</span>
          </div>

          <label class="editor-field">
            <span>记录内容 <small>正文或附件至少填写一项</small></span>
            <textarea
              ref="editor"
              v-model="body"
              rows="11"
              maxlength="1048576"
              placeholder="粘贴命令、排查过程、配置片段或任何需要保留的原始内容…"
              @keydown="onEditorKeydown"
              @paste="onPaste"
            />
          </label>

          <div class="capture-toolbar" role="group" aria-label="内容格式">
            <button type="button" :class="{ active: contentFormat === 'plain_text' }" :aria-pressed="contentFormat === 'plain_text'" @click="contentFormat = 'plain_text'">
              纯文本
            </button>
            <button type="button" :class="{ active: contentFormat === 'markdown' }" :aria-pressed="contentFormat === 'markdown'" @click="contentFormat = 'markdown'">
              Markdown
            </button>
            <span>{{ body.length.toLocaleString('zh-CN') }} 字符</span>
          </div>

          <section class="attachments" aria-labelledby="capture-attachments-title">
            <header>
              <div>
                <h3 id="capture-attachments-title">附件</h3>
                <p>最多 10 个；单文件 20 MiB，合计 100 MiB。</p>
              </div>
              <UiButton variant="secondary" @click="chooseFiles"><UiIcon name="paperclip" /> 添加文件</UiButton>
              <input ref="fileInput" class="sr-only" type="file" multiple tabindex="-1" aria-label="选择记录附件" @change="onFileSelection" />
            </header>
            <ul v-if="files.length">
              <li v-for="(file, index) in files" :key="`${file.name}-${file.lastModified}-${index}`">
                <UiIcon :name="file.type.startsWith('image/') ? 'image' : 'file-text'" />
                <span><strong>{{ file.name }}</strong><small>{{ formatBytes(file.size) }}</small></span>
                <button type="button" :aria-label="`移除 ${file.name}`" @click="removeFile(index)">
                  <UiIcon name="x" :size="16" />
                </button>
              </li>
            </ul>
            <p v-else class="attachments__empty">可粘贴图片，也可添加任意普通文件。</p>
            <p v-if="files.length" class="attachments__total">合计 {{ formatBytes(totalBytes) }}</p>
          </section>

          <details class="capture-options">
            <summary>更多选项</summary>
            <label>
              <span>自定义标题 <small>可选，最多 200 字符</small></span>
              <input v-model="title" maxlength="200" placeholder="留空时按原文确定性生成" />
            </label>
            <label>
              <span>目录 <small>可选</small></span>
              <select v-model="folderId">
                <option value="">原始收件箱</option>
                <option v-for="folder in flatFolders" :key="folder.id" :value="folder.id">{{ '　'.repeat(folder.depth) }}{{ folder.name }}</option>
              </select>
            </label>
            <fieldset v-if="library.tags.length">
              <legend>标签 <small>最多 30 个</small></legend>
              <label v-for="tag in library.tags" :key="tag.id" class="capture-tag">
                <input v-model="tagIds" type="checkbox" :value="tag.id" :disabled="!tagIds.includes(tag.id) && tagIds.length >= 30" /> {{ tag.name }}
              </label>
            </fieldset>
          </details>

          <label class="sensitive-toggle">
            <span>
              <UiIcon name="shield-alert" />
              <span><strong>标记为敏感</strong><small>密码、私钥、Token 或内部地址等内容。</small></span>
            </span>
            <input v-model="sensitive" type="checkbox" role="switch" />
          </label>

          <div v-if="savedMessage" class="capture-state capture-state--success" role="status">
            <UiIcon name="check" /> <span>{{ savedMessage }}</span>
          </div>
          <div v-if="errorMessage" class="capture-state capture-state--error" role="alert">
            <UiIcon name="triangle-alert" />
            <span><strong>保存失败</strong>{{ errorMessage }}</span>
            <button type="button" @click="save">重试</button>
          </div>
        </div>

        <footer class="capture-drawer__footer">
          <span><kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> 保存</span>
          <UiButton variant="ghost" @click="requestClose">取消</UiButton>
          <UiButton variant="primary" :disabled="!canSave" @click="save">
            <UiIcon name="save" /> {{ saving ? '正在保存' : '保存记录' }}
          </UiButton>
        </footer>

        <div v-if="saving" class="saving-state" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true" />
          <strong>正在保存记录…</strong>
          <small>原文与附件将在同一提交中落盘。</small>
        </div>

        <div v-if="confirmDiscard" class="discard-state" role="alertdialog" aria-modal="true" aria-labelledby="discard-title">
          <div>
            <h2 id="discard-title">放弃编辑？</h2>
            <p>当前内容尚未保存，关闭后无法恢复。</p>
            <UiButton variant="primary" @click="confirmDiscard = false">继续编辑</UiButton>
            <UiButton variant="danger" @click="closeAndDiscard">放弃并关闭</UiButton>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.capture-overlay { position: fixed; z-index: var(--layer-overlay); inset: 0; background: var(--scrim); backdrop-filter: blur(2px); }
.capture-drawer { position: fixed; z-index: calc(var(--layer-overlay) + 1); top: 0; right: 0; display: grid; width: min(460px, 100vw); height: 100dvh; grid-template-rows: auto minmax(0, 1fr) auto; border-left: 1px solid var(--border-strong); background: var(--bg-surface); box-shadow: var(--shadow-overlay); }
.capture-drawer__header, .capture-drawer__footer { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4); border-color: var(--border-subtle); background: var(--bg-surface); }
.capture-drawer__header { justify-content: space-between; border-bottom: 1px solid var(--border-subtle); }
.capture-drawer__header h2, .capture-drawer__header p { margin: 0; }
.capture-drawer__header h2 { font-size: 16px; }
.capture-drawer__header p { margin-top: 2px; color: var(--text-muted); font-size: 12px; }
.icon-button { display: inline-grid; width: 36px; height: 36px; flex: none; place-items: center; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.icon-button:hover { border-color: var(--border-subtle); background: var(--bg-elevated); }
.capture-drawer__body { overflow-y: auto; padding: var(--space-4); }
.editor-field, .capture-options label { display: grid; gap: var(--space-2); }
.editor-field > span, .capture-options label > span { display: flex; justify-content: space-between; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.editor-field small, .capture-options small { color: var(--text-muted); font-weight: 400; }
textarea, .capture-options input, .capture-options select { width: 100%; padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
textarea { min-height: 220px; resize: vertical; font-family: var(--font-mono); font-size: 13px; line-height: 1.65; }
.capture-toolbar { display: flex; align-items: center; gap: var(--space-1); padding: var(--space-2) 0 var(--space-4); border-bottom: 1px solid var(--border-subtle); }
.capture-toolbar button { padding: 5px var(--space-2); border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 11px; }
.capture-toolbar button.active { border-color: var(--border-strong); background: var(--bg-elevated); color: var(--text-primary); }
.capture-toolbar span { margin-left: auto; color: var(--text-muted); font-size: 11px; }
.attachments { padding: var(--space-4) 0; border-bottom: 1px solid var(--border-subtle); }
.attachments header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.attachments h3, .attachments p { margin: 0; }
.attachments h3 { font-size: 13px; }
.attachments header p, .attachments__empty, .attachments__total { color: var(--text-muted); font-size: 11px; }
.attachments__empty { margin-top: var(--space-3) !important; padding: var(--space-4); border: 1px dashed var(--border-strong); border-radius: var(--radius-control); text-align: center; }
.attachments ul { display: grid; gap: var(--space-2); margin: var(--space-3) 0 0; padding: 0; list-style: none; }
.attachments li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-elevated); }
.attachments li span, .attachments li small { display: block; min-width: 0; }
.attachments li strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.attachments li small { color: var(--text-muted); font-size: 10px; }
.attachments li button { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.attachments__total { margin-top: var(--space-2) !important; text-align: right; }
.capture-options { padding: var(--space-4) 0; border-bottom: 1px solid var(--border-subtle); }
.capture-options summary { margin-bottom: var(--space-3); cursor: pointer; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.capture-options fieldset { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-3) 0 0; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
.capture-options legend { color: var(--text-muted); font-size: 11px; }
.capture-tag { display: inline-flex !important; align-items: center; gap: var(--space-1) !important; color: var(--text-secondary); font-size: 11px; }
.capture-tag input { width: auto; padding: 0; }
.sensitive-toggle { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-4); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-elevated); cursor: pointer; }
.sensitive-toggle > span { display: flex; align-items: flex-start; gap: var(--space-2); }
.sensitive-toggle strong, .sensitive-toggle small { display: block; }
.sensitive-toggle small { color: var(--text-muted); font-size: 11px; }
.sensitive-toggle input { width: 36px; height: 20px; flex: none; accent-color: var(--sensitive); }
.sensitive-banner, .capture-state { display: flex; align-items: flex-start; gap: var(--space-2); margin-bottom: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); font-size: 12px; }
.sensitive-banner { border-color: color-mix(in srgb, var(--sensitive) 58%, var(--border-subtle)); background: color-mix(in srgb, var(--sensitive) 10%, var(--bg-elevated)); color: var(--sensitive); }
.sensitive-banner span, .capture-state span, .capture-state strong { display: block; }
.capture-state { margin-top: var(--space-4); margin-bottom: 0; }
.capture-state--success { border-color: color-mix(in srgb, var(--success) 55%, var(--border-subtle)); color: var(--success); }
.capture-state--error { border-color: color-mix(in srgb, var(--danger) 65%, var(--border-subtle)); color: var(--danger); }
.capture-state button { margin-left: auto; border: 1px solid currentColor; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
.capture-drawer__footer { justify-content: flex-end; border-top: 1px solid var(--border-subtle); }
.capture-drawer__footer > span { margin-right: auto; color: var(--text-muted); font-size: 11px; }
kbd { padding: 2px 5px; border: 1px solid var(--border-strong); border-radius: 3px; background: var(--bg-code); font-family: var(--font-mono); }
.saving-state, .discard-state { position: absolute; z-index: 2; inset: 0; display: grid; place-content: center; padding: var(--space-5); background: color-mix(in srgb, var(--bg-app) 88%, transparent); text-align: center; }
.saving-state .spinner { margin: 0 auto var(--space-3); }
.saving-state small { margin-top: var(--space-1); color: var(--text-muted); }
.discard-state > div { width: min(100%, 340px); padding: var(--space-5); border: 1px solid var(--border-strong); border-radius: var(--radius-dialog); background: var(--bg-elevated); box-shadow: var(--shadow-overlay); }
.discard-state h2 { margin: 0 0 var(--space-2); font-size: 18px; }
.discard-state p { margin: 0 0 var(--space-5); color: var(--text-secondary); }
.discard-state button { width: 100%; margin-top: var(--space-2); }
.spinner { display: block; width: 28px; height: 28px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 599px) {
  .capture-drawer { width: 100vw; border-left: 0; }
  .capture-drawer__header { min-height: 56px; }
  .capture-drawer__footer > span, .capture-drawer__footer > button:first-of-type { display: none; }
  .capture-drawer__footer > button:last-child { width: 100%; }
  textarea { min-height: 190px; }
}
</style>

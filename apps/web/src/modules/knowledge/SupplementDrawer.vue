<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { ApiError, apiRequest, jsonRequest } from '../../lib/api'
import type { Sensitivity } from './library'

const props = defineProps<{
  open: boolean
  itemId: string
  rawRecords: Array<{ id: string; recordRole: string; effectiveCapturedAt: string }>
  currentSensitivity: Sensitivity
}>()
const emit = defineEmits<{ close: []; created: [] }>()
const auth = useAuthStore()
const editor = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const body = ref('')
const contentFormat = ref<'plain_text' | 'markdown'>('plain_text')
const sensitivity = ref<Sensitivity>(props.currentSensitivity)
const relationType = ref<'supplements' | 'supersedes' | ''>('supplements')
const relationTarget = ref('')
const files = ref<File[]>([])
const saving = ref(false)
const errorMessage = ref('')
const submissionKey = ref('')
const submissionSignature = ref('')
const drawer = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)
const confirmDiscard = ref(false)

const totalBytes = computed(() => files.value.reduce((total, file) => total + file.size, 0))
// The API enforces the 1 MiB limit on UTF-8 bytes, not on character count.
const BODY_LIMIT_BYTES = 1024 * 1024
const utf8Encoder = new TextEncoder()
const bodyBytes = computed(() => utf8Encoder.encode(body.value).length)
const bodyTooLarge = computed(() => bodyBytes.value > BODY_LIMIT_BYTES)
const dirty = computed(
  () =>
    body.value !== '' ||
    contentFormat.value !== 'plain_text' ||
    sensitivity.value !== props.currentSensitivity ||
    relationType.value !== 'supplements' ||
    relationTarget.value !== (props.rawRecords[0]?.id ?? '') ||
    files.value.length > 0,
)
const canSave = computed(
  () =>
    !saving.value &&
    (body.value.trim().length > 0 || files.value.length > 0) &&
    bodyBytes.value <= BODY_LIMIT_BYTES &&
    files.value.length <= 10 &&
    files.value.every((file) => file.size <= 20 * 1024 * 1024) &&
    totalBytes.value <= 100 * 1024 * 1024,
)

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previousFocus.value = document.activeElement as HTMLElement | null
      sensitivity.value = props.currentSensitivity
      relationTarget.value = props.rawRecords[0]?.id ?? ''
      await nextTick()
      editor.value?.focus()
      return
    }
    confirmDiscard.value = false
    await nextTick()
    previousFocus.value?.focus()
    previousFocus.value = null
  },
)

watch(confirmDiscard, async (open) => {
  await nextTick()
  if (open) drawer.value?.querySelector<HTMLElement>('.supplement-discard button')?.focus()
  else if (props.open) editor.value?.focus()
})

function chooseFiles() {
  fileInput.value?.click()
}

function selectFiles(event: Event) {
  if (saving.value) return
  const input = event.target as HTMLInputElement
  const selected = Array.from(input.files ?? [])
  errorMessage.value = ''
  // 每次文件对话框只返回本次选择的文件；在既有选择之上累加，取消、
  // 空选择或被拒绝的批次都不得清掉用户之前已加入的合法附件。
  const next = [...files.value]
  for (const file of selected) {
    if (next.length >= 10) {
      errorMessage.value = '单次最多上传 10 个附件。'
      break
    }
    if (file.size > 20 * 1024 * 1024) {
      errorMessage.value = `“${file.name}”超过 20 MiB，未加入本次补充。`
      continue
    }
    if (next.reduce((total, current) => total + current.size, 0) + file.size > 100 * 1024 * 1024) {
      errorMessage.value = '本次附件实际总字节不能超过 100 MiB。'
      break
    }
    next.push(file)
  }
  files.value = next
  input.value = ''
}

function reset() {
  body.value = ''
  contentFormat.value = 'plain_text'
  sensitivity.value = props.currentSensitivity
  relationType.value = 'supplements'
  relationTarget.value = props.rawRecords[0]?.id ?? ''
  files.value = []
  errorMessage.value = ''
  submissionKey.value = ''
  submissionSignature.value = ''
  if (fileInput.value) fileInput.value.value = ''
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
  reset()
  confirmDiscard.value = false
  emit('close')
}

function onDialogKeydown(event: KeyboardEvent) {
  // Keys during IME composition belong to the input method. Safari reports
  // the composition-confirm keydown as keyCode 229 with isComposing=false
  // (WebKit bug 324380), so both shapes are treated as composing.
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    if (confirmDiscard.value) confirmDiscard.value = false
    else requestClose()
    return
  }
  if (event.key !== 'Tab' || !drawer.value) return
  const scope = confirmDiscard.value
    ? drawer.value.querySelector<HTMLElement>('.supplement-discard')
    : drawer.value
  const focusable = Array.from(
    scope?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  ).filter((element) => !element.hidden && element.offsetParent !== null)
  if (!focusable.length) return
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

async function save() {
  if (!canSave.value) return
  const metadata = {
    body: body.value,
    contentFormat: contentFormat.value,
    sensitivity: sensitivity.value,
    relation:
      relationType.value && relationTarget.value
        ? { type: relationType.value, targetRawRecordId: relationTarget.value }
        : undefined,
  }
  const signature = JSON.stringify({
    ...metadata,
    files: files.value.map((file) => [file.name, file.size, file.type, file.lastModified]),
  })
  if (!submissionKey.value || submissionSignature.value !== signature) {
    submissionKey.value = crypto.randomUUID()
    submissionSignature.value = signature
  }
  saving.value = true
  // A control disabled by the saving lock cannot keep the dialog's keyboard
  // focus; hand it to the readonly editor only when the refreshed DOM left
  // the current focus unusable.
  void nextTick(() => {
    const active = document.activeElement
    if (
      !(active instanceof HTMLElement) ||
      active === document.body ||
      !drawer.value?.contains(active) ||
      active.hasAttribute('disabled')
    ) {
      editor.value?.focus()
    }
  })
  errorMessage.value = ''
  try {
    if (files.value.length) {
      const form = new FormData()
      form.append('metadata', JSON.stringify(metadata))
      for (const file of files.value) form.append('files[]', file, file.name)
      await apiRequest(`/api/v1/items/${props.itemId}/raw-records:multipart`, {
        method: 'POST',
        headers: {
          'X-CSRF-Token': auth.csrfToken,
          'Idempotency-Key': submissionKey.value,
        },
        body: form,
      })
    } else {
      const request = jsonRequest('POST', metadata, auth.csrfToken)
      request.headers = { ...request.headers, 'Idempotency-Key': submissionKey.value }
      await apiRequest(`/api/v1/items/${props.itemId}/raw-records`, request)
    }
    reset()
    emit('created')
    emit('close')
  } catch (error) {
    if (error instanceof ApiError) {
      errorMessage.value = error.message
      if (error.requestId) errorMessage.value += `（请求 ${error.requestId}）`
    } else {
      // Network-level failure: the request outcome is unknown, so keep the
      // content and tell the user that retrying is safe (same idempotency key).
      errorMessage.value = '网络连接中断，内容已保留；点击重试安全，不会产生重复记录。'
    }
  } finally {
    saving.value = false
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open">
      <div class="supplement-overlay" @click="requestClose" />
      <section ref="drawer" class="supplement-drawer" role="dialog" aria-modal="true" aria-labelledby="supplement-title" @keydown="onDialogKeydown">
        <header>
          <div><p>原始事实层</p><h2 id="supplement-title">添加补充原始记录</h2></div>
          <button type="button" aria-label="关闭补充记录" :disabled="saving" @click="requestClose"><UiIcon name="x" /></button>
        </header>
        <div class="supplement-drawer__body">
          <p class="immutable-notice"><UiIcon name="shield-check" /> 每次保存都会创建新的只读记录，不会覆盖旧正文或向旧记录追加附件。</p>
          <label>
            <span>补充内容</span>
            <textarea
              ref="editor"
              v-model="body"
              rows="10"
              placeholder="补充新的事实、修正或后续过程…"
              :aria-invalid="bodyTooLarge"
              :aria-describedby="bodyTooLarge ? 'supplement-body-limit' : undefined"
              :readonly="saving"
            />
            <small class="body-count">{{ bodyBytes.toLocaleString('zh-CN') }} / {{ BODY_LIMIT_BYTES.toLocaleString('zh-CN') }} 字节</small>
          </label>
          <p v-if="bodyTooLarge" id="supplement-body-limit" class="body-limit-warning" role="alert">
            正文 {{ bodyBytes.toLocaleString('zh-CN') }} 字节，已超过单条原始正文 1 MiB（{{ BODY_LIMIT_BYTES.toLocaleString('zh-CN') }} 字节）上限；请修剪后再保存，输入不会被自动截断。
          </p>
          <div class="row">
            <label><span>格式</span><select v-model="contentFormat" :disabled="saving"><option value="plain_text">纯文本</option><option value="markdown">Markdown</option></select></label>
            <label><span>敏感状态</span><select v-model="sensitivity" :disabled="saving"><option value="normal">普通</option><option value="unknown">待确认</option><option value="sensitive">敏感</option></select></label>
          </div>
          <div class="row">
            <label><span>关系</span><select v-model="relationType" :disabled="saving"><option value="">不建立关系</option><option value="supplements">补充</option><option value="supersedes">替代</option></select></label>
            <label><span>目标原始记录</span><select v-model="relationTarget" :disabled="!relationType || saving"><option v-for="record in rawRecords" :key="record.id" :value="record.id">{{ record.recordRole === 'primary' ? '主记录' : '补充记录' }} · {{ new Date(record.effectiveCapturedAt).toLocaleString('zh-CN') }}</option></select></label>
          </div>
          <section class="supplement-files">
            <header><div><strong>新附件</strong><small>附件只属于本次新记录</small></div><UiButton variant="secondary" :disabled="saving" @click="chooseFiles"><UiIcon name="paperclip" /> 选择文件</UiButton><input ref="fileInput" type="file" class="sr-only" multiple tabindex="-1" aria-label="选择补充记录附件" :disabled="saving" @change="selectFiles" /></header>
            <ul v-if="files.length"><li v-for="(file, index) in files" :key="`${file.name}-${index}`"><span>{{ file.name }}</span><small>{{ formatBytes(file.size) }}</small><button type="button" :aria-label="`移除 ${file.name}`" :disabled="saving" @click="files.splice(index, 1)"><UiIcon name="x" :size="15" /></button></li></ul>
            <p v-else>可创建仅含文字、图片、文件或混合内容的补充记录。</p>
          </section>
          <p v-if="errorMessage" class="supplement-error" role="alert"><UiIcon name="triangle-alert" /> {{ errorMessage }} <button type="button" @click="save">重试</button></p>
        </div>
        <footer><span>{{ files.length }} 个文件 · {{ formatBytes(totalBytes) }}</span><UiButton variant="ghost" :disabled="saving" @click="requestClose">取消</UiButton><UiButton variant="primary" :disabled="!canSave" @click="save"><UiIcon name="save" /> {{ saving ? '正在保存' : '保存补充记录' }}</UiButton></footer>

        <div v-if="confirmDiscard" class="supplement-discard" role="alertdialog" aria-modal="true" aria-labelledby="supplement-discard-title">
          <div>
            <h3 id="supplement-discard-title">放弃本次补充？</h3>
            <p>尚未保存的内容和附件选择将丢失。</p>
            <UiButton variant="primary" @click="confirmDiscard = false">继续编辑</UiButton>
            <UiButton variant="danger" @click="closeAndDiscard">放弃并关闭</UiButton>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.supplement-overlay { position: fixed; z-index: var(--layer-overlay); inset: 0; background: var(--scrim); }
.supplement-drawer { position: fixed; z-index: calc(var(--layer-overlay) + 1); top: 0; right: 0; display: grid; width: min(520px, 100vw); height: 100dvh; grid-template-rows: auto minmax(0, 1fr) auto; border-left: 1px solid var(--border-strong); background: var(--bg-surface); box-shadow: var(--shadow-overlay); }
.supplement-drawer > header, .supplement-drawer > footer { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4); border-color: var(--border-subtle); }
.supplement-drawer > header { justify-content: space-between; border-bottom: 1px solid var(--border-subtle); }
.supplement-drawer header p, .supplement-drawer header h2 { margin: 0; }
.supplement-drawer header p { color: var(--text-muted); font-size: 11px; }
.supplement-drawer header h2 { font-size: 17px; }
.supplement-drawer > header > button { display: grid; width: 40px; height: 40px; place-items: center; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.supplement-drawer__body { overflow-y: auto; padding: var(--space-4); }
.immutable-notice { display: flex; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--accent-soft); color: var(--text-secondary); font-size: 12px; }
label { display: grid; gap: var(--space-1); margin-top: var(--space-3); color: var(--text-secondary); font-size: 12px; font-weight: 700; }
textarea, select { width: 100%; padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
textarea { resize: vertical; font-family: var(--font-mono); line-height: 1.6; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.supplement-files { margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border-subtle); }
.supplement-files header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.supplement-files header div, .supplement-files header small { display: grid; }
.supplement-files header small, .supplement-files > p { color: var(--text-muted); font-size: 11px; }
.supplement-files ul { display: grid; gap: var(--space-1); margin: var(--space-3) 0 0; padding: 0; list-style: none; }
.supplement-files li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-2); padding: var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
.supplement-files li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.supplement-files li small { color: var(--text-muted); }
.supplement-files li button { display: inline-grid; min-width: 40px; min-height: 40px; place-items: center; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.supplement-error { display: flex; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); }
.supplement-error button { min-width: 40px; min-height: 40px; flex-shrink: 0; margin-left: auto; align-self: center; padding: 0 var(--space-3); border: 0; background: transparent; color: inherit; cursor: pointer; text-decoration: underline; white-space: nowrap; }
.body-count { color: var(--text-muted); font-weight: 400; }
.body-limit-warning { margin: var(--space-1) 0 0; padding: var(--space-3); border: 1px solid var(--danger); border-radius: var(--radius-control); color: var(--danger); font-size: 12px; }
.supplement-drawer > footer { justify-content: flex-end; border-top: 1px solid var(--border-subtle); }
.supplement-drawer > footer > span { margin-right: auto; color: var(--text-muted); font-size: 11px; }
.supplement-discard { position: absolute; z-index: 2; inset: 0; display: grid; place-content: center; padding: var(--space-5); background: color-mix(in srgb, var(--bg-app) 88%, transparent); }
.supplement-discard > div { width: min(100%, 340px); padding: var(--space-5); border: 1px solid var(--border-strong); border-radius: var(--radius-dialog); background: var(--bg-elevated); box-shadow: var(--shadow-overlay); }
.supplement-discard h3 { margin: 0 0 var(--space-2); }
.supplement-discard p { margin: 0 0 var(--space-4); color: var(--text-secondary); }
.supplement-discard button { width: 100%; margin-top: var(--space-2); }
@media (max-width: 599px) { .supplement-drawer { border-left: 0; } .row { grid-template-columns: 1fr; } .supplement-drawer > footer > span, .supplement-drawer > footer > button:first-of-type { display: none; } .supplement-drawer > footer > button:last-child { width: 100%; } }
</style>

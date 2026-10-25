<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { useAuthStore } from '../../../app/auth'
import UiButton from '../../../components/ui/UiButton.vue'
import UiIcon from '../../../components/ui/UiIcon.vue'
import CopyButton from '../shared/ui/CopyButton.vue'
import ToolPageHeader from '../shared/ui/ToolPageHeader.vue'
import LanguageSelect, { type LanguageOption } from '../translate/LanguageSelect.vue'
import type { CloudErrorAction, PreflightPlan, TranslationLanguagesResponse } from '../translate/contracts'
import { chunkStatusLabel, describeCloudError, engineLabel, professionalSceneLabel } from '../translate/contracts'
import { describeRunViolation, prepareTranslationRun, type PreparedTranslationRun } from '../translate/prepare'
import {
  fetchTranslationLanguages,
  preflightTranslation,
  TranslateApiError,
} from '../translate/translateClient'
import { useTranslateRun, type TranslateChunkSeed } from '../translate/useTranslateRun'
import {
  formatImageBytes,
  IMAGE_ACCEPT,
  probeImageFile,
  type ImageProbeResult,
  type LoadedImage,
} from './imageInput'
import {
  extractOcrLines,
  isLowConfidenceLine,
  LOW_CONFIDENCE_THRESHOLD,
  type OcrLine,
} from './ocrLines'
import {
  describeOcrCloudError,
  preflightOcr,
  type OcrCloudErrorAction,
  type OcrPreflightPlan,
} from './ocrClient'
import {
  acquireOcrWorker,
  terminateOcrWorker,
  type OcrLanguagePreset,
  type OcrProgressUpdate,
  type OcrWorkerLease,
} from './tesseractWorker'
import { useCloudOcrRun } from './useCloudOcrRun'

/**
 * OCR 翻译任务流（Screen 40 三步骤流 + Screen 42 状态参考；docs/09 §9）。
 *
 * 隐私边界：本地 OCR 路径除本站 /tesseract/* 静态资产外零业务 API、零内容
 * 存储；语言清单与额度只在用户显式走向云路径（打开云端确认、选择目标语言、
 * 点击主按钮）时才请求。图片与 OCR 文本只存在于本页内存与 blob URL。
 */

const auth = useAuthStore()

const AUTO_CODE = 'auto'
/** OCR 页固定启用技术内容保护；校对文本同样可能包含命令、路径与 URL。 */
const PROTECTION_ENABLED = true
const TRANSLATE_BUSY_IMAGE_MESSAGE = '翻译正在进行；请先取消或等待完成，再更换图片。'
const IMAGE_UNREADABLE_MESSAGE = '无法读取这张图片：文件可能已损坏，或浏览器无法完成解码/缩放；请更换图片后重试。'

type LocalOcrPhase = 'idle' | 'running' | 'done' | 'failed' | 'cancelled'

const imageError = ref('')
const image = ref<LoadedImage | null>(null)
const imageUrl = ref('')
const dropActive = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const ocrLanguage = ref<OcrLanguagePreset>('chi_sim+eng')
const localPhase = ref<LocalOcrPhase>('idle')
const localProgress = ref<OcrProgressUpdate | null>(null)
const localError = ref('')
const ocrLines = ref<OcrLine[]>([])
const proofText = ref('')
const proofSource = ref<'local' | 'aliyun' | null>(null)

const cloudDialogOpen = ref(false)
const ocrQuota = ref<{ remaining: number; limit: number } | null>(null)
const cloudPreflightPlan = ref<OcrPreflightPlan | null>(null)
const cloudPreflightRunning = ref(false)
const cloudPreflightError = ref<{ code: string; status: number; message: string } | null>(null)

const cloudRun = useCloudOcrRun()
const {
  phase: cloudPhase,
  queuePosition: cloudQueuePosition,
  ticketExpiresAt: cloudTicketExpiresAt,
  error: cloudError,
  cancelledInFlight: cloudCancelledInFlight,
  isBusy: cloudBusy,
} = cloudRun

const sourceLanguage = ref(AUTO_CODE)
const targetLanguage = ref('')
const languagesResponse = ref<TranslationLanguagesResponse | null>(null)
const languagesLoading = ref(false)
const languagesError = ref('')

const prepared = ref<PreparedTranslationRun | null>(null)
const preparing = ref(false)
const translateConfirmation = ref<{ plan: PreflightPlan; replan: boolean } | null>(null)
const translatePreflightRunning = ref(false)
const translatePreflightError = ref<{ code: string; status: number; message: string; action: CloudErrorAction } | null>(null)
const replanSeeds = ref<TranslateChunkSeed[] | null>(null)

const cloudDialogElement = ref<HTMLElement | null>(null)
const translateDialogElement = ref<HTMLElement | null>(null)
let confirmReturnFocus: HTMLElement | null = null

let localGeneration = 0
/** 图片候选代次：新候选与卸载时递增；旧候选在任何 await 之后都不得再改页面状态。 */
let selectionGeneration = 0
let prepGeneration = 0
let translatePreflightGeneration = 0
let cloudPreflightGeneration = 0
let prepTimer: number | undefined

const run = useTranslateRun({
  pollIntervalMs: 1500,
  onReplanRequired(seeds) {
    replanSeeds.value = seeds
    void requestReplanPlan(seeds)
  },
})
const {
  phase: runPhase,
  chunks: runChunks,
  queuePosition,
  ticketExpiresAt,
  currentChunkIndex,
  detectedLanguage,
  enginesUsed,
  runError,
  cancelBreakdown,
  completedCount,
  failedChunks,
  isBusy: translateBusy,
} = run

// ---------- 派生状态 ----------

const steps = [
  { label: '选择图片' },
  { label: '校对文字' },
  { label: '翻译' },
] as const

const currentStep = computed(() => {
  if (!image.value) return 1
  if (runPhase.value !== 'idle' || translateConfirmation.value !== null) return 3
  return 2
})

const localBusy = computed(() => localPhase.value === 'running')
const anyBusy = computed(() =>
  localBusy.value || cloudPreflightRunning.value || cloudBusy.value || translateBusy.value,
)

const imageMetaLine = computed(() => {
  const current = image.value
  if (!current) return ''
  return `${formatImageBytes(current.sizeBytes)} · ${current.width} × ${current.height} px`
})

const lowConfidenceLines = computed(() => ocrLines.value.filter(isLowConfidenceLine))

const localProgressLabel = computed(() => {
  const update = localProgress.value
  if (!update) return ''
  if (update.stage === 'recognizing') return '正在识别图片文字…'
  return '正在下载并加载识别资源（首次可能较大）…'
})

const localProgressPercent = computed(() => {
  const update = localProgress.value
  if (!update || update.stage !== 'recognizing') return 0
  return Math.round(Math.max(0, Math.min(1, update.progress)) * 100)
})

const generalLanguages = computed(() => languagesResponse.value?.generalLanguages ?? [])
const sourceOptions = computed<LanguageOption[]>(() => [
  { code: AUTO_CODE, label: '自动检测', keywords: 'auto detect' },
  ...generalLanguages.value.map((entry) => toOption(entry.code, entry.nameZh, entry.nameEn)),
])
const targetOptions = computed(() =>
  generalLanguages.value.map((entry) => toOption(entry.code, entry.nameZh, entry.nameEn)),
)

function toOption(code: string, nameZh: string, nameEn: string): LanguageOption {
  return { code, label: nameZh, keywords: `${nameEn} ${code}` }
}

const languageLabel = (code: string | null | undefined): string => {
  if (!code) return ''
  if (code === AUTO_CODE) return '自动检测'
  return generalLanguages.value.find((entry) => entry.code === code)?.nameZh ?? code
}

const sameLanguageSelected = computed(() =>
  sourceLanguage.value !== AUTO_CODE &&
  targetLanguage.value !== '' &&
  sourceLanguage.value === targetLanguage.value,
)

const violations = computed(() => prepared.value?.violations ?? [])

const chunkCount = computed(() => prepared.value?.chunks.length ?? 0)
const payloadUnits = computed(() => prepared.value?.payloadUnits ?? 0)

const outputText = computed(() =>
  runChunks.value
    .filter((chunk) => chunk.status === 'success' || chunk.status === 'restore-failed')
    .map((chunk) => chunk.resultText)
    .join(''),
)

const progressPercent = computed(() => {
  if (runChunks.value.length === 0) return 0
  return Math.round((completedCount.value / runChunks.value.length) * 100)
})

const mainLabel = computed(() =>
  runPhase.value === 'replan' ? '查看新的发送计划' : '确认文字并继续翻译',
)

const mainDisabled = computed(() => {
  if (anyBusy.value || preparing.value || translatePreflightRunning.value || translateConfirmation.value !== null) return true
  if (!proofText.value.trim() || !prepared.value || prepared.value.chunks.length === 0) return true
  if (violations.value.length > 0 || sameLanguageSelected.value || !targetLanguage.value) return true
  if (languagesError.value) return true
  return false
})

const mainHint = computed(() => {
  if (!image.value) return '先选择一张 PNG、JPEG 或 WebP 图片。'
  if (!proofText.value.trim()) return '完成本地识别（或云端重识别）后，在这里校对文字。'
  if (!targetLanguage.value) return '选择目标语言后才能继续翻译。'
  if (runPhase.value === 'finished') return '翻译完成；结果只在本页内存，可复制。'
  return '确认后 OCR 文本将发送给阿里云机器翻译（与图片识别是不同的服务）。'
})

const cloudErrorAction = computed<OcrCloudErrorAction | null>(() => {
  if (!cloudError.value) return null
  return describeOcrCloudError(cloudError.value.code, cloudError.value.status, cloudError.value.details)
})

const cloudPreflightErrorAction = computed<OcrCloudErrorAction | null>(() => {
  if (!cloudPreflightError.value) return null
  return describeOcrCloudError(cloudPreflightError.value.code, cloudPreflightError.value.status)
})

const cloudManualRetryVisible = computed(() => {
  if (cloudPhase.value === 'paused') {
    const kind = cloudErrorAction.value?.kind
    return kind === 'manual-retry' || kind === 'uncertain' || kind === 'requeue' || kind === 'plain'
  }
  if (cloudPhase.value === 'cancelled' && cloudCancelledInFlight.value) return true
  return false
})

const runErrorAction = computed<CloudErrorAction | null>(() => {
  if (!runError.value) return null
  return describeCloudError(runError.value.code, runError.value.status)
})

const showContinueButton = computed(() => {
  if (runPhase.value !== 'paused' || failedChunks.value.length === 0) return false
  const kind = runErrorAction.value?.kind
  return kind === 'manual-retry' || kind === 'uncertain' || kind === 'requeue' || kind === 'plain'
})

const confirmPlan = computed(() => translateConfirmation.value?.plan ?? null)
const confirmIsReplan = computed(() => translateConfirmation.value?.replan ?? false)

const confirmChunkCount = computed(() => confirmPlan.value?.items.length ?? 0)
const confirmPlanUnits = computed(() =>
  confirmPlan.value?.totals.reduce((sum, total) => sum + total.units, 0) ?? 0,
)
const planUsesProfessional = computed(() =>
  confirmPlan.value?.items.some((item) => item.engine === 'professional') ?? false,
)

const fmt = (value: number): string => value.toLocaleString('zh-Hans-CN')

const timeFormatter = new Intl.DateTimeFormat('zh-Hans-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})
function formatClock(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : timeFormatter.format(date)
}

function panelClassForOcr(action: OcrCloudErrorAction | null): string {
  if (!action) return ''
  if (action.kind === 'quota') return 'panel--danger'
  if (action.kind === 'uncertain' || action.kind === 'settings') return 'panel--warn'
  return ''
}

function panelClassForTranslate(action: CloudErrorAction | null): string {
  if (!action) return ''
  if (action.kind === 'quota') return 'panel--danger'
  if (action.kind === 'uncertain' || action.kind === 'settings') return 'panel--warn'
  return ''
}

// ---------- 生命周期 ----------

onMounted(() => {
  window.addEventListener('paste', handleWindowPaste)
})

onBeforeUnmount(() => {
  window.removeEventListener('paste', handleWindowPaste)
  window.clearTimeout(prepTimer)
  selectionGeneration += 1
  localGeneration += 1
  void terminateOcrWorker()
  cloudRun.dispose()
  run.dispose()
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
})

watch(proofText, schedulePrepare)

watch([proofText, sourceLanguage, targetLanguage], () => {
  if (translateBusy.value) return
  translatePreflightGeneration += 1
  translatePreflightRunning.value = false
  run.resetForNewRun()
  replanSeeds.value = null
  translatePreflightError.value = null
  closeTranslateConfirmation(false)
})

// ---------- 图片输入（粘贴 / 拖放 / 文件选择） ----------

function openFilePicker(): void {
  fileInput.value?.click()
}

function handleZoneKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    openFilePicker()
  }
}

function handleFileInputChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void handleFileCandidate(file)
}

function handleZoneDrop(event: DragEvent): void {
  dropActive.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) void handleFileCandidate(file)
}

function handleWindowPaste(event: ClipboardEvent): void {
  const target = event.target
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return
  if (cloudDialogOpen.value || translateConfirmation.value) return
  const file = event.clipboardData?.files?.[0]
  if (!file) return
  event.preventDefault()
  void handleFileCandidate(file)
}

async function handleFileCandidate(file: File): Promise<void> {
  if (translateBusy.value) {
    imageError.value = TRANSLATE_BUSY_IMAGE_MESSAGE
    return
  }
  const selection = ++selectionGeneration
  imageError.value = ''
  let result: ImageProbeResult
  try {
    result = await probeImageFile(file)
  } catch {
    if (selection !== selectionGeneration) return
    imageError.value = IMAGE_UNREADABLE_MESSAGE
    return
  }
  if (selection !== selectionGeneration) return
  if (!result.ok) {
    imageError.value = result.violation.message
    return
  }
  // 解码期间可能已开始翻译：沿用同一规则，不重置在途翻译。
  if (translateBusy.value) {
    imageError.value = TRANSLATE_BUSY_IMAGE_MESSAGE
    return
  }
  await applyImage(result.image, selection)
}

async function applyImage(next: LoadedImage, selection: number): Promise<void> {
  // 先取消在途的本地识别与云端识别；等待期间候选可能已更替，此时只收尾资源、不应用图片。
  const teardown = ++localGeneration
  if (localBusy.value) {
    await terminateOcrWorker()
    // worker 已实际终止：仍由本次收尾归属时解除 running，候选作废也不能卡在 busy。
    if (teardown === localGeneration) {
      localPhase.value = 'cancelled'
      localProgress.value = null
    }
    if (selection !== selectionGeneration) return
  }
  if (cloudBusy.value) {
    await cloudRun.cancel()
    if (selection !== selectionGeneration) return
  }
  // 应用新图即新的本地识别归属：等待期间迟到的取消收尾不得再改写新图的状态。
  localGeneration += 1
  cloudRun.reset()
  run.resetForNewRun()
  replanSeeds.value = null
  translatePreflightError.value = null
  cloudPreflightGeneration += 1
  cloudPreflightPlan.value = null
  cloudPreflightError.value = null
  closeTranslateConfirmation(false)
  closeCloudDialog(false)

  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
  imageUrl.value = URL.createObjectURL(next.blob)
  image.value = next
  localPhase.value = 'idle'
  localProgress.value = null
  localError.value = ''
  ocrLines.value = []
  proofText.value = ''
  proofSource.value = null
  prepared.value = null
}

function changeImage(): void {
  if (translateBusy.value) {
    imageError.value = TRANSLATE_BUSY_IMAGE_MESSAGE
    return
  }
  openFilePicker()
}

// ---------- 本地 OCR（docs/09 §9.2） ----------

async function runLocalOcr(): Promise<void> {
  const current = image.value
  if (!current || localBusy.value || cloudBusy.value) return
  const generation = ++localGeneration
  localPhase.value = 'running'
  localError.value = ''
  localProgress.value = { stage: 'loading', progress: 0, status: 'loading tesseract core' }
  let lease: OcrWorkerLease | null = null
  try {
    lease = await acquireOcrWorker(ocrLanguage.value, (update) => {
      if (generation === localGeneration) localProgress.value = update
    })
    if (generation !== localGeneration) return
    const result = await lease.worker.recognize(current.blob, {}, { text: true, blocks: true })
    if (generation !== localGeneration) return
    ocrLines.value = extractOcrLines(result.data)
    proofText.value = result.data.text.replace(/\n+$/, '')
    proofSource.value = 'local'
    localPhase.value = 'done'
  } catch (error) {
    // 过期归属的迟到失败先于任何资源操作返回：它发生在旧 worker 上，不得
    // 终止或清掉新归属正在使用的缓存。仅当前归属失败（worker 已死亡或不可用，
    // 补丁后 onerror 会拒绝在途识别）才丢弃单例缓存，下一次显式重试重新创建，
    // 不自动重试；终止收尾不写任何视图状态。
    if (generation !== localGeneration) return
    void terminateOcrWorker()
    localPhase.value = 'failed'
    localError.value = error instanceof Error
      ? `本地识别失败：${error.message}`
      : '本地识别失败；可重试本地识别，或选择“使用阿里云重新识别”。'
  } finally {
    // 已过归属（取消/换图/卸载/新识别）时 release 是 no-op，不影响新归属。
    lease?.release()
  }
}

async function cancelLocalOcr(): Promise<void> {
  if (!localBusy.value) return
  const generation = ++localGeneration
  await terminateOcrWorker()
  // 等待期间可能已换图或重新识别：只有仍是本次归属时才写入取消态。
  if (generation !== localGeneration) return
  localPhase.value = 'cancelled'
  localProgress.value = null
}

// ---------- 云端重识别（docs/09 §9.3） ----------

async function openCloudDialog(event: Event): Promise<void> {
  if (!image.value || anyBusy.value || cloudDialogOpen.value) return
  const current = image.value
  const generation = ++cloudPreflightGeneration
  captureTriggerFocus(event)
  cloudPreflightRunning.value = true
  cloudPreflightError.value = null
  try {
    const plan = await preflightOcr(auth.csrfToken)
    if (generation !== cloudPreflightGeneration || image.value !== current) return
    const total = plan.totals.find((entry) => entry.meter === 'ocr_general')
    if (!total) throw new Error('云 OCR 预检未返回额度计划。')
    cloudPreflightPlan.value = plan
    ocrQuota.value = { remaining: total.remainingBefore, limit: total.limit }
    cloudDialogOpen.value = true
    await focusDialogStart(cloudDialogElement)
  } catch (error) {
    if (generation !== cloudPreflightGeneration) return
    cloudPreflightError.value = error instanceof TranslateApiError
      ? { code: error.code, status: error.status, message: error.message }
      : {
          code: 'NETWORK_ERROR',
          status: 0,
          message: error instanceof Error ? error.message : '云 OCR 预检失败。',
        }
  } finally {
    if (generation === cloudPreflightGeneration) cloudPreflightRunning.value = false
  }
}

function closeCloudDialog(restoreFocus = true): void {
  if (!cloudDialogOpen.value) return
  cloudDialogOpen.value = false
  cloudPreflightPlan.value = null
  if (restoreFocus) void nextTick(() => confirmReturnFocus?.focus())
  else confirmReturnFocus = null
}

async function confirmCloudSend(): Promise<void> {
  const current = image.value
  if (!current || !cloudPreflightPlan.value) return
  const returnTarget = confirmReturnFocus
  cloudDialogOpen.value = false
  cloudPreflightPlan.value = null
  confirmReturnFocus = null
  await cloudRun.start(current, () => auth.csrfToken)
  if (cloudRun.resultText.value) {
    proofText.value = cloudRun.resultText.value
    proofSource.value = 'aliyun'
    ocrLines.value = []
  }
  if (cloudRun.remainingAfter.value !== null) {
    ocrQuota.value = {
      remaining: cloudRun.remainingAfter.value,
      limit: ocrQuota.value?.limit ?? cloudRun.remainingAfter.value,
    }
  }
  void nextTick(() => returnTarget?.focus())
}

async function retryCloudOcr(event: Event): Promise<void> {
  // Every billable retry passes through a fresh preflight and confirmation.
  await openCloudDialog(event)
}

// ---------- OCR 后翻译（docs/09 §9.4，复用 V2.1 useTranslateRun） ----------

async function loadLanguages(): Promise<void> {
  if (languagesResponse.value || languagesLoading.value) return
  languagesLoading.value = true
  languagesError.value = ''
  try {
    languagesResponse.value = await fetchTranslationLanguages()
  } catch (error) {
    languagesError.value = error instanceof Error ? error.message : '语言清单加载失败。'
  } finally {
    languagesLoading.value = false
  }
}

function schedulePrepare(): void {
  window.clearTimeout(prepTimer)
  prepGeneration += 1
  if (!proofText.value.trim()) {
    prepared.value = null
    preparing.value = false
    return
  }
  prepared.value = null
  preparing.value = true
  prepTimer = window.setTimeout(() => {
    const generation = prepGeneration
    const result = prepareTranslationRun(proofText.value, PROTECTION_ENABLED)
    if (generation !== prepGeneration) return
    prepared.value = result
    preparing.value = false
  }, 250)
}

async function startTranslationConfirmation(event: Event): Promise<void> {
  if (mainDisabled.value) return
  if (runPhase.value === 'replan' && replanSeeds.value) {
    captureTriggerFocus(event)
    await requestReplanPlan(replanSeeds.value)
    return
  }
  const current = prepared.value
  if (!current || current.chunks.length === 0) return
  const generation = ++translatePreflightGeneration
  captureTriggerFocus(event)
  await loadLanguages()
  if (generation !== translatePreflightGeneration || languagesError.value) return
  translatePreflightRunning.value = true
  translatePreflightError.value = null
  try {
    const plan = await preflightTranslation(
      {
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
        chunkUnits: current.chunks.map((chunk) => chunk.units),
      },
      auth.csrfToken,
    )
    if (generation !== translatePreflightGeneration) return
    translateConfirmation.value = { plan, replan: false }
    await focusDialogStart(translateDialogElement)
  } catch (error) {
    if (generation !== translatePreflightGeneration) return
    translatePreflightError.value = describePreflightError(error)
  } finally {
    if (generation === translatePreflightGeneration) translatePreflightRunning.value = false
  }
}

/** PREFLIGHT_CHANGED 后的重新预检：用“待发 + 剩余未发送”片段与当前语言重取完整计划。 */
async function requestReplanPlan(seeds: TranslateChunkSeed[]): Promise<void> {
  if (seeds.length === 0) return
  const generation = ++translatePreflightGeneration
  translatePreflightRunning.value = true
  translatePreflightError.value = null
  try {
    const plan = await preflightTranslation(
      {
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
        chunkUnits: seeds.map((seed) => seed.units),
      },
      auth.csrfToken,
    )
    if (generation !== translatePreflightGeneration) return
    translateConfirmation.value = { plan, replan: true }
    await focusDialogStart(translateDialogElement)
  } catch (error) {
    if (generation !== translatePreflightGeneration) return
    translatePreflightError.value = describePreflightError(error)
  } finally {
    if (generation === translatePreflightGeneration) translatePreflightRunning.value = false
  }
}

function describePreflightError(error: unknown): { code: string; status: number; message: string; action: CloudErrorAction } {
  if (!(error instanceof TranslateApiError)) {
    return {
      code: 'NETWORK_ERROR',
      status: 0,
      message: error instanceof Error ? error.message : '预检请求未成功。',
      action: describeCloudError('NETWORK_ERROR', 0),
    }
  }
  return {
    code: error.code,
    status: error.status,
    message: error.message,
    action: describeCloudError(error.code, error.status),
  }
}

function confirmTranslateSend(): void {
  const state = translateConfirmation.value
  const current = prepared.value
  if (!state || !current) return
  const seeds = state.replan && replanSeeds.value ? replanSeeds.value : current.chunks
  const planMismatch = state.plan.items.length !== seeds.length || state.plan.items.some(
    (item, position) => item.index !== position || item.units !== seeds[position]?.units,
  )
  if (planMismatch) {
    translatePreflightError.value = {
      code: 'INVALID_INPUT',
      status: 400,
      message: '额度计划片段数与待发送片段不一致，请重新预检。',
      action: describeCloudError('INVALID_INPUT', 400),
    }
    translateConfirmation.value = null
    return
  }
  const returnTarget = confirmReturnFocus
  translateConfirmation.value = null
  confirmReturnFocus = null
  replanSeeds.value = null
  translatePreflightError.value = null
  void run.start(
    {
      chunks: seeds,
      plan: state.plan,
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
      runId: current.runId,
      segmentMap: current.segmentMap,
      protectionEnabled: current.protectionEnabled,
    },
    () => auth.csrfToken,
  )
  void nextTick(() => returnTarget?.focus())
}

function closeTranslateConfirmation(restoreFocus = true): void {
  if (!translateConfirmation.value) return
  const returnTarget = confirmReturnFocus
  translateConfirmation.value = null
  if (restoreFocus) void nextTick(() => returnTarget?.focus())
  else confirmReturnFocus = null
}

// ---------- 对话框焦点管理 ----------

function captureTriggerFocus(event: Event): void {
  confirmReturnFocus = event.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
}

async function focusDialogStart(element: RefLikeElement): Promise<void> {
  await nextTick()
  if (!element.value) return
  element.value.scrollTop = 0
  element.value.focus({ preventScroll: true })
}

interface RefLikeElement {
  value: HTMLElement | null
}

function makeDialogKeydown(close: () => void, element: RefLikeElement) {
  return (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab' || !element.value) return
    const focusable = [...element.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]',
    )]
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
}

const handleCloudDialogKeydown = makeDialogKeydown(() => closeCloudDialog(), cloudDialogElement)
const handleTranslateDialogKeydown = makeDialogKeydown(() => closeTranslateConfirmation(), translateDialogElement)
</script>

<template>
  <section class="ocr-page" aria-label="OCR 翻译">
    <header class="ocr-mobile-header">
      <RouterLink class="ocr-mobile-header__back" to="/tools" aria-label="返回工具箱">
        <UiIcon name="chevron-left" :size="20" />
      </RouterLink>
      <h1>OCR 翻译</h1>
      <span class="ocr-mobile-header__spacer" aria-hidden="true" />
    </header>
    <ToolPageHeader
      class="ocr-desktop-header"
      title="OCR 翻译"
      description="先把图片中的文字在浏览器本地识别并校对，再可选地发送阿里云机器翻译。"
      limit="支持 PNG、JPEG、WebP 单张图片；最大 5 MiB、最长边 4096 px（超过时本地等比缩小）；图片与识别文本只存在于当前页面内存。"
      processing="local"
    >
      <template #actions>
        <p v-if="ocrQuota" class="quota-summary" aria-label="本地保护账本剩余">
          <span class="quota-summary__item">
            云 OCR 剩余 <span class="num">{{ fmt(ocrQuota.remaining) }}</span> / {{ fmt(ocrQuota.limit) }}
          </span>
          <span class="quota-summary__source">本地保护账本 · 不含其他应用用量</span>
        </p>
        <p v-else class="quota-summary quota-summary--muted">本地识别不消耗云额度</p>
      </template>
    </ToolPageHeader>

    <nav class="steps" aria-label="OCR 翻译步骤">
      <ol>
        <li
          v-for="(step, index) in steps"
          :key="step.label"
          :class="{
            'steps__item--done': currentStep > index + 1,
            'steps__item--current': currentStep === index + 1,
          }"
          :aria-current="currentStep === index + 1 ? 'step' : undefined"
        >
          <span class="steps__dot num" aria-hidden="true">
            <UiIcon v-if="currentStep > index + 1" name="check" :size="12" />
            <template v-else>{{ index + 1 }}</template>
          </span>
          <span class="steps__label">{{ step.label }}</span>
        </li>
      </ol>
    </nav>

    <div class="flow">
      <section class="card" aria-labelledby="ocr-image-heading">
        <header class="card__header">
          <h2 id="ocr-image-heading">图片</h2>
          <button
            v-if="image"
            type="button"
            class="link-button"
            :disabled="translateBusy"
            @click="changeImage"
          >更换图片</button>
        </header>

        <input
          ref="fileInput"
          type="file"
          class="visually-hidden-input"
          :accept="IMAGE_ACCEPT"
          aria-label="选择图片文件"
          @change="handleFileInputChange"
        >

        <div v-if="!image" class="upload-zone" :class="{ 'upload-zone--active': dropActive }">
          <div
            class="upload-zone__target"
            role="button"
            tabindex="0"
            aria-label="选择图片；也可以直接粘贴或把图片拖放到这里"
            data-testid="ocr-upload-zone"
            @click="openFilePicker"
            @keydown="handleZoneKeydown"
            @dragover.prevent="dropActive = true"
            @dragleave="dropActive = false"
            @drop.prevent="handleZoneDrop"
          >
            <UiIcon name="image" :size="20" />
            <p class="upload-zone__title">选择、粘贴或拖放一张图片</p>
            <p class="upload-zone__hint">PNG / JPEG / WebP · 单张 · 最大 5 MiB · 最长边 4096 px</p>
            <p class="upload-zone__hint upload-zone__hint--privacy">
              <UiIcon name="lock-keyhole" :size="14" /> 图片留在此设备；本地识别不上传图片
            </p>
          </div>
        </div>

        <div v-else class="image-info">
          <img class="image-info__thumb" :src="imageUrl" alt="已选择的图片预览">
          <div class="image-info__meta">
            <p class="image-info__name" :title="image.fileName">{{ image.fileName }}</p>
            <p class="image-info__line">
              <span class="chip chip--mono">{{ image.typeLabel }}</span>
              <span class="num">{{ imageMetaLine }}</span>
            </p>
            <p v-if="image.adjusted" class="image-info__adjusted">
              原图 {{ image.originalWidth }} × {{ image.originalHeight }} px 超过 4096 px，已在浏览器本地等比缩小到
              {{ image.width }} × {{ image.height }} px（{{ formatImageBytes(image.sizeBytes) }}）。
            </p>
          </div>
        </div>

        <p v-if="imageError" class="panel panel--warn" role="alert" data-testid="ocr-image-error">
          <UiIcon name="triangle-alert" :size="16" /> {{ imageError }}
        </p>
      </section>

      <section class="card" aria-labelledby="ocr-local-heading">
        <header class="card__header">
          <h2 id="ocr-local-heading">本地 OCR · 图片未上传</h2>
          <span class="privacy-note"><UiIcon name="lock-keyhole" :size="14" /> 图片留在此设备</span>
        </header>
        <div class="field-row">
          <label class="field-label" for="ocr-language">识别语言</label>
          <select
            id="ocr-language"
            v-model="ocrLanguage"
            class="field-select"
            :disabled="localBusy || cloudBusy || translateBusy || !image"
          >
            <option value="chi_sim+eng">简体中文 + English</option>
            <option value="eng">仅 English</option>
          </select>
          <UiButton
            variant="secondary"
            data-testid="ocr-local-run"
            :disabled="!image || localBusy || cloudBusy || translateBusy"
            @click="runLocalOcr"
          >开始本地识别</UiButton>
          <UiButton
            v-if="localBusy"
            variant="secondary"
            data-testid="ocr-local-cancel"
            @click="cancelLocalOcr"
          >取消</UiButton>
        </div>
        <p class="card__note">本地识别使用当前设备性能，首次需要下载识别资源（简体中文与 English 数据较大）。</p>
        <p class="card__note card__note--muted">面向印刷体文字；不承诺手写识别。</p>

        <div v-if="localBusy" class="progress-block" data-testid="ocr-local-progress">
          <p class="progress-block__line" aria-live="polite">
            <UiIcon name="clock" :size="16" /> {{ localProgressLabel }}
          </p>
          <div
            class="progress-block__bar"
            role="progressbar"
            aria-label="本地识别进度"
            :aria-valuemin="0"
            :aria-valuemax="100"
            :aria-valuenow="localProgressPercent"
          >
            <div class="progress-block__fill" :style="{ width: `${localProgressPercent}%` }" />
          </div>
        </div>
        <p v-if="localPhase === 'cancelled'" class="inline-notice" role="status">已取消本地识别；图片与已识别内容不受影响。</p>
        <p v-if="localError" class="panel panel--warn" role="alert" data-testid="ocr-local-error">
          <UiIcon name="triangle-alert" :size="16" /> {{ localError }} 可重试本地识别，或选择“使用阿里云重新识别”。
        </p>
      </section>

      <section v-if="proofSource" class="card" aria-labelledby="ocr-proof-heading">
        <header class="card__header">
          <h2 id="ocr-proof-heading">校对识别结果</h2>
          <span class="chip">{{ proofSource === 'local' ? '来自本地识别' : '来自阿里云重新识别' }}</span>
        </header>

        <div v-if="lowConfidenceLines.length" class="low-lines">
          <p class="low-lines__note">
            以下 {{ lowConfidenceLines.length }} 行置信度低于 {{ LOW_CONFIDENCE_THRESHOLD }}（原始识别结果，供校对参考）：
          </p>
          <ul class="low-lines__list">
            <li v-for="(line, index) in lowConfidenceLines" :key="index" class="low-lines__item">
              <span class="low-lines__text">{{ line.text || '（空行）' }}</span>
              <span class="low-lines__tag">低置信度</span>
              <span v-if="line.confidence !== null" class="num low-lines__score">{{ Math.round(line.confidence) }}</span>
            </li>
          </ul>
        </div>

        <label class="field-label" for="ocr-proof-text">校对后的文字（可自由编辑）</label>
        <textarea
          id="ocr-proof-text"
          v-model="proofText"
          class="proof-input"
          rows="10"
          spellcheck="false"
          data-testid="ocr-proof-text"
          :placeholder="'在此校对识别文字…'"
        />
        <div class="action-row">
          <CopyButton :text="proofText" label="复制识别文字" />
          <button
            type="button"
            class="link-button"
            :disabled="!image || localBusy || cloudBusy || translateBusy"
            @click="runLocalOcr"
          >重新本地识别</button>
        </div>
      </section>

      <section v-if="image" class="card card--cloud" aria-labelledby="ocr-cloud-heading">
        <header class="card__header">
          <h2 id="ocr-cloud-heading">云端重识别（可选）</h2>
          <span class="privacy-note"><UiIcon name="lock-keyhole" :size="14" /> 内容不保存</span>
        </header>
        <p class="card__note">
          点击“使用阿里云重新识别”并确认后，调整后的图片将发送至阿里云通用文字识别，消耗 1 次云 OCR 额度；
          本地失败或低置信度不会自动触发。
          <template v-if="ocrQuota">
            当前剩余 <span class="num">{{ fmt(ocrQuota.remaining) }}</span> / {{ fmt(ocrQuota.limit) }}（本地保护账本）。
          </template>
        </p>

        <div class="cloud-option__actions">
          <UiButton
            variant="secondary"
            data-testid="ocr-cloud-open"
            :disabled="!image || anyBusy"
            :aria-busy="cloudPreflightRunning ? 'true' : 'false'"
            @click="openCloudDialog"
          >
            <UiIcon name="scan-text" :size="16" />
            {{ cloudPreflightRunning ? '正在检查额度…' : '使用阿里云重新识别' }}
          </UiButton>
          <span>发送前会先检查本地保护账本，再显示确认信息。</span>
        </div>

        <div
          v-if="cloudPreflightError && cloudPreflightErrorAction"
          class="panel"
          :class="panelClassForOcr(cloudPreflightErrorAction)"
          role="alert"
          data-testid="ocr-cloud-preflight-error"
        >
          <p>
            <UiIcon
              :name="cloudPreflightErrorAction.kind === 'quota' ? 'x-circle' : 'triangle-alert'"
              :size="16"
            />
            <strong>{{ cloudPreflightErrorAction.title }}</strong> {{ cloudPreflightErrorAction.detail }}
          </p>
          <RouterLink
            v-if="cloudPreflightErrorAction.kind === 'settings' || cloudPreflightErrorAction.kind === 'quota'"
            class="panel__link"
            to="/settings/aliyun"
          >{{ cloudPreflightErrorAction.kind === 'quota' ? '查看额度设置' : '前往设置' }}</RouterLink>
        </div>

        <div class="cloud-state" aria-live="polite">
          <p v-if="cloudPhase === 'queueing' || cloudPhase === 'claiming'" class="run-line">
            <UiIcon name="clock" :size="16" /> 正在申请云调用许可…
          </p>
          <div v-else-if="cloudPhase === 'waiting'" class="queue-card" data-testid="ocr-cloud-queue">
            <p class="run-line"><UiIcon name="clock" :size="16" /> 当前云端请求较多，正在排队中…</p>
            <p class="queue-card__position">
              当前队列位置：<span class="num queue-card__number">{{ cloudQueuePosition ?? '—' }}</span>
              <span v-if="cloudTicketExpiresAt"> · {{ formatClock(cloudTicketExpiresAt) }} 到期（最多等待 2 分钟）</span>
            </p>
          </div>
          <p v-else-if="cloudPhase === 'running'" class="run-line">
            <UiIcon name="clock" :size="16" /> 正在上传图片并识别…（消耗 1 次云 OCR 额度）
          </p>
          <p v-else-if="cloudPhase === 'finished'" class="run-line run-line--ok">
            <UiIcon name="check-circle-2" :size="16" />
            云端识别完成<template v-if="cloudRun.remainingAfter.value !== null">
              · 剩余 <span class="num">{{ fmt(cloudRun.remainingAfter.value) }}</span></template>；结果已放入上方校对区，仍需校对。
          </p>
          <p v-else-if="cloudPhase === 'cancelled' && !cloudCancelledInFlight" class="run-line" role="status">
            <UiIcon name="x" :size="16" /> 已取消云端识别；未上传图片或未消耗额度时可直接重新发起。
          </p>

          <div
            v-if="cloudError && cloudErrorAction"
            class="panel"
            :class="panelClassForOcr(cloudErrorAction)"
            role="alert"
            data-testid="ocr-cloud-error"
          >
            <p>
              <UiIcon
                :name="cloudErrorAction.kind === 'quota' ? 'x-circle' : cloudErrorAction.kind === 'uncertain' ? 'clock' : 'triangle-alert'"
                :size="16"
              />
              <strong>{{ cloudErrorAction.title }}</strong> {{ cloudErrorAction.detail }}
            </p>
            <div class="panel__actions">
              <RouterLink
                v-if="cloudErrorAction.kind === 'settings' || cloudErrorAction.kind === 'quota'"
                class="panel__link"
                to="/settings/aliyun"
              >{{ cloudErrorAction.kind === 'quota' ? '查看额度设置' : '前往设置' }}</RouterLink>
            </div>
          </div>

          <div
            v-if="cloudPhase === 'cancelled' && cloudCancelledInFlight"
            class="panel panel--warn"
            role="alert"
            data-testid="ocr-cloud-cancelled-uncertain"
          >
            <p>
              <UiIcon name="clock" :size="16" />
              <strong>结果不确定</strong> 已请求取消，但该次调用无法确认上游是否受理，已按保守计量处理；
              不会自动重试，手动重试可能重复计费。
            </p>
          </div>

          <div class="panel__actions">
            <UiButton v-if="cloudBusy" variant="secondary" data-testid="ocr-cloud-cancel" @click="cloudRun.cancel()">取消</UiButton>
            <UiButton
              v-if="cloudManualRetryVisible"
              variant="secondary"
              data-testid="ocr-cloud-retry"
              @click="retryCloudOcr"
            >手动重试（可能重复计费）</UiButton>
          </div>
        </div>
      </section>

      <section v-if="proofSource" class="card" aria-labelledby="ocr-translate-heading">
        <header class="card__header">
          <h2 id="ocr-translate-heading">翻译（可选）</h2>
        </header>
        <div class="language-bar" role="group" aria-label="翻译语言" @focusin="loadLanguages">
          <LanguageSelect
            id="ocr-source-language"
            v-model="sourceLanguage"
            :options="sourceOptions"
            :placeholder="languagesLoading ? '语言清单加载中…' : '源语言'"
            label="源语言，默认自动检测"
            :disabled="translateBusy || languagesLoading"
          />
          <LanguageSelect
            id="ocr-target-language"
            v-model="targetLanguage"
            :options="targetOptions"
            :placeholder="languagesLoading ? '语言清单加载中…' : '选择目标语言'"
            label="目标语言，必须明确选择"
            :disabled="translateBusy || languagesLoading"
          />
        </div>
        <p v-if="languagesError" class="panel panel--warn" role="alert">
          <UiIcon name="triangle-alert" :size="16" /> 语言清单加载失败：{{ languagesError }}</p>

        <div id="ocr-status" class="status-area">
          <div v-if="violations.length" class="panel panel--warn" role="alert">
            <p v-for="violation in violations" :key="violation.code">
              <UiIcon name="triangle-alert" :size="16" /> {{ describeRunViolation(violation) }}
            </p>
          </div>
          <div v-if="sameLanguageSelected" class="panel panel--warn" role="alert">
            <p><UiIcon name="triangle-alert" :size="16" /> 源语言与目标语言相同；请修改其中一个后再翻译。</p>
          </div>
          <div
            v-if="translatePreflightError"
            class="panel"
            :class="panelClassForTranslate(translatePreflightError.action)"
            role="alert"
            data-testid="ocr-translate-preflight-error"
          >
            <p>
              <UiIcon :name="translatePreflightError.action.kind === 'quota' ? 'x-circle' : 'triangle-alert'" :size="16" />
              <strong>{{ translatePreflightError.action.title }}</strong> {{ translatePreflightError.action.detail }}
            </p>
            <RouterLink
              v-if="translatePreflightError.action.kind === 'settings' || translatePreflightError.action.kind === 'quota'"
              class="panel__link"
              to="/settings/aliyun"
            >{{ translatePreflightError.action.kind === 'quota' ? '查看额度设置' : '前往设置' }}</RouterLink>
          </div>
          <div
            v-if="runError && runErrorAction"
            class="panel"
            :class="panelClassForTranslate(runErrorAction)"
            role="alert"
            data-testid="ocr-translate-run-error"
          >
            <p>
              <UiIcon
                :name="runErrorAction.kind === 'quota' ? 'x-circle' : runErrorAction.kind === 'uncertain' ? 'clock' : 'triangle-alert'"
                :size="16"
              />
              <strong>{{ runErrorAction.title }}</strong> {{ runErrorAction.detail }}
            </p>
            <div class="panel__actions">
              <RouterLink
                v-if="runErrorAction.kind === 'settings' || runErrorAction.kind === 'quota'"
                class="panel__link"
                to="/settings/aliyun"
              >{{ runErrorAction.kind === 'quota' ? '查看额度设置' : '前往设置' }}</RouterLink>
              <UiButton v-if="showContinueButton" variant="secondary" @click="run.continueFromFailure()">
                从失败片段继续
              </UiButton>
            </div>
          </div>
        </div>

        <p v-if="proofText.trim() && !preparing" class="stats">
          输入 <span class="num">{{ fmt(proofText.length) }}</span> 字符 ·
          预计计费 <span class="num">{{ fmt(payloadUnits) }}</span> UTF-16 ·
          <span class="num">{{ fmt(chunkCount) }}</span> 个请求 ·
          仅自然语言片段发送至阿里云机器翻译（技术内容保护已启用）
        </p>

        <div class="translate-run" aria-live="polite">
          <p v-if="runPhase === 'queueing' || runPhase === 'claiming'" class="run-line">
            <UiIcon name="clock" :size="16" /> 正在申请云调用许可…
          </p>
          <div v-else-if="runPhase === 'waiting'" class="queue-card" data-testid="ocr-translate-queue">
            <p class="run-line"><UiIcon name="clock" :size="16" /> 当前云端请求较多，正在排队中…</p>
            <p class="queue-card__position">
              当前队列位置：<span class="num queue-card__number">{{ queuePosition ?? '—' }}</span>
              <span v-if="ticketExpiresAt"> · {{ formatClock(ticketExpiresAt) }} 到期（最多等待 2 分钟）</span>
            </p>
          </div>
          <div v-else-if="runPhase === 'running'" class="progress-block">
            <p class="run-line">
              <UiIcon name="clock" :size="16" />
              已完成 {{ completedCount }} / {{ runChunks.length }} 段<template v-if="currentChunkIndex !== null"> · 正在发送第 {{ currentChunkIndex + 1 }} 段</template>
            </p>
            <div
              class="progress-block__bar"
              role="progressbar"
              aria-label="翻译片段进度"
              :aria-valuemin="0"
              :aria-valuemax="runChunks.length"
              :aria-valuenow="completedCount"
            >
              <div class="progress-block__fill" :style="{ width: `${progressPercent}%` }" />
            </div>
            <p class="run-hint">已成功片段实时保留；失败后仅重试失败段，不会自动重试或换引擎。</p>
          </div>
          <p v-else-if="runPhase === 'replan'" class="run-line">
            <UiIcon name="info" :size="16" />
            额度或引擎已变化，已停止发送；{{ translatePreflightRunning ? '正在获取新的发送计划…' : '请确认新的发送计划后才会继续。' }}
          </p>
          <p v-else-if="runPhase === 'finished'" class="run-line run-line--ok">
            <UiIcon name="check-circle-2" :size="16" />
            已完成 {{ completedCount }} / {{ runChunks.length }} 段<template v-if="enginesUsed.length">
              · 实际引擎：{{ enginesUsed.map((engine) => engineLabel(engine)).join(' + ') }}</template>
          </p>
          <p v-else-if="runPhase === 'cancelled' && cancelBreakdown" class="run-line">
            <UiIcon name="x" :size="16" />
            已取消：未发送 {{ cancelBreakdown.notSent }} 段 · 已发送 {{ cancelBreakdown.sent }} 段 ·
            结果不确定 {{ cancelBreakdown.uncertain }} 段
          </p>
          <p v-else-if="runPhase === 'paused'" class="run-line">
            <UiIcon name="info" :size="16" /> 运行已暂停；可从失败片段继续，或校对后重新预检。
          </p>

          <div v-if="runPhase !== 'idle'" class="translate-result">
            <header class="translate-result__header">
              <h3>译文</h3>
              <div class="translate-result__meta">
                <span v-if="detectedLanguage" class="chip chip--mono">检测语言：{{ languageLabel(detectedLanguage) }}</span>
                <CopyButton :text="outputText" />
              </div>
            </header>
            <output class="translate-output" data-testid="ocr-translate-output" for="ocr-proof-text">
              {{ outputText || '翻译结果将显示在这里…' }}
            </output>
            <ul v-if="runChunks.length" class="segment-list" aria-label="片段状态">
              <li v-for="chunk in runChunks" :key="chunk.index" :class="`segment segment--${chunk.status}`">
                <span class="segment__index num">第 {{ chunk.index + 1 }} 段</span>
                <span class="segment__status">
                  {{ chunk.status === 'sending'
                    ? `发送中 · ${engineLabel(chunk.expectedEngine)}`
                    : chunk.status === 'pending'
                      ? '未发送'
                      : `${chunkStatusLabel(chunk.status)}${chunk.engine ? ` · ${engineLabel(chunk.engine, chunk.scene)}` : ''}` }}
                </span>
              </li>
            </ul>
            <div class="panel__actions">
              <UiButton v-if="translateBusy" variant="secondary" data-testid="ocr-translate-cancel" @click="run.cancel()">取消</UiButton>
            </div>
          </div>
        </div>
      </section>
    </div>

    <footer class="action-bar">
      <p class="action-bar__constraints">PNG/JPEG/WebP 单张 · 最大 5 MiB · 最长边 4096 px · 不支持 PDF、HEIC、批量或相机</p>
      <div class="action-bar__row">
        <p class="run-hint" aria-live="polite">{{ mainHint }}</p>
        <UiButton
          variant="primary"
          class="action-bar__main"
          :disabled="mainDisabled"
          data-testid="ocr-translate-primary"
          @click="startTranslationConfirmation"
        >{{ mainLabel }}</UiButton>
      </div>
      <p class="action-bar__copy-note">你可以只复制 OCR 结果，不进行翻译。</p>
    </footer>

    <div v-if="cloudDialogOpen" class="confirmation-backdrop" @mousedown.self="closeCloudDialog()">
      <section
        ref="cloudDialogElement"
        class="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ocr-cloud-dialog-title"
        tabindex="-1"
        data-testid="ocr-cloud-dialog"
        @keydown="handleCloudDialogKeydown"
      >
        <header>
          <p>云端发送确认</p>
          <h2 id="ocr-cloud-dialog-title">使用阿里云重新识别</h2>
          <span>只有点击“确认发送”才会上传图片并消耗额度；取消不产生排队或额度占用。</span>
        </header>
        <dl v-if="image">
          <div><dt>文件名</dt><dd class="mono">{{ image.fileName }}</dd></div>
          <div><dt>类型</dt><dd>{{ image.typeLabel }}</dd></div>
          <div><dt>尺寸</dt><dd class="mono">{{ image.width }} × {{ image.height }} px<template v-if="image.adjusted">（已本地等比缩小）</template></dd></div>
          <div><dt>大小</dt><dd class="mono">{{ formatImageBytes(image.sizeBytes) }}</dd></div>
          <div><dt>预计消耗</dt><dd>1 次云 OCR 额度</dd></div>
          <div>
            <dt>当前剩余</dt>
            <dd>
              <template v-if="ocrQuota">
                <span class="num">{{ fmt(ocrQuota.remaining) }}</span> / {{ fmt(ocrQuota.limit) }}（本地保护账本）
              </template>
              <template v-else>预检计划不可用，请关闭后重试。</template>
            </dd>
          </div>
          <div><dt>实际接收方</dt><dd>阿里云通用文字识别</dd></div>
        </dl>
        <p class="boundary-note">
          Boundary：图片将明确发送至阿里云 API 端点；本站不保存图片，不创建附件，识别文本只出现在本页内存。
        </p>
        <footer>
          <UiButton variant="secondary" @click="closeCloudDialog()">继续本地识别</UiButton>
          <UiButton
            variant="primary"
            data-testid="ocr-cloud-confirm"
            :disabled="!image || !cloudPreflightPlan"
            @click="confirmCloudSend"
          >确认发送</UiButton>
        </footer>
      </section>
    </div>

    <div v-if="translateConfirmation" class="confirmation-backdrop" @mousedown.self="closeTranslateConfirmation()">
      <section
        ref="translateDialogElement"
        class="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ocr-translate-dialog-title"
        tabindex="-1"
        data-testid="ocr-translate-dialog"
        @keydown="handleTranslateDialogKeydown"
      >
        <header>
          <p>{{ confirmIsReplan ? '重新确认发送（计划已变化）' : '云端发送确认' }}</p>
          <h2 id="ocr-translate-dialog-title">把校对后的文字发送到阿里云机器翻译</h2>
          <span>OCR 文本将发送给阿里云机器翻译，与图片识别是不同的服务；只有点击“确认并翻译”才会申请云调用并发送内容。</span>
        </header>
        <dl>
          <div><dt>实际接收方</dt><dd>阿里云机器翻译</dd></div>
          <div><dt>源语言</dt><dd>{{ languageLabel(sourceLanguage) }}</dd></div>
          <div><dt>目标语言</dt><dd>{{ languageLabel(targetLanguage) }}</dd></div>
          <div v-if="planUsesProfessional && confirmPlan?.professionalScene">
            <dt>专业场景</dt><dd>{{ confirmPlan.professionalScene }}</dd>
          </div>
          <div>
            <dt>片段与计费</dt>
            <dd>{{ fmt(confirmChunkCount || chunkCount) }} 个片段 · 预计计费 {{ fmt(confirmPlan ? confirmPlanUnits : payloadUnits) }} UTF-16</dd>
          </div>
          <template v-if="confirmPlan">
            <div v-for="total in confirmPlan.totals" :key="total.meter">
              <dt>{{ total.meter === 'mt_general' ? '通用版计划' : '专业版计划' }}</dt>
              <dd>
                {{ fmt(total.chunks) }} 片段 / {{ fmt(total.units) }} 字符 ·
                已用 {{ fmt(total.used) }} · 已预留 {{ fmt(total.reserved) }} ·
                计划前剩余 {{ fmt(total.remainingBefore) }} → 计划后
                <span class="num">{{ fmt(total.remainingAfterPlan) }}</span>
              </dd>
            </div>
            <div><dt>额度重置</dt><dd>{{ confirmPlan.resetAt }}（{{ confirmPlan.month }} · Asia/Shanghai）</dd></div>
          </template>
        </dl>
        <p class="boundary-note">
          以上额度来自本地保护账本剩余，只统计本应用调用；额度可能因并发变化而重新计划，届时会停止发送并再次请求确认。
          技术内容保护已启用：命令、代码、URL 与路径替换为占位符，仅自然语言片段发送。
        </p>
        <footer>
          <UiButton variant="secondary" @click="closeTranslateConfirmation()">取消，不发送</UiButton>
          <UiButton
            variant="primary"
            data-testid="ocr-translate-confirm"
            @click="confirmTranslateSend"
          >确认并翻译</UiButton>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.ocr-page {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  min-height: 100%;
  background: var(--bg-app);
}

.ocr-mobile-header { display: none; }

.steps { width: min(720px, 100%); margin: var(--space-4) auto 0; padding: 0 var(--space-6); }
.steps ol {
  display: flex;
  gap: var(--space-5);
  margin: 0;
  padding: 0;
  list-style: none;
}
.steps li { display: flex; flex: 1 1 0; min-width: 0; align-items: center; gap: var(--space-2); }
.steps li::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-subtle);
}
.steps li:last-child::after { display: none; }
.steps__dot {
  display: inline-flex;
  width: 24px;
  height: 24px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  color: var(--text-muted);
  font-size: 12px;
}
.steps__item--current .steps__dot { border-color: var(--accent); background: var(--accent); color: var(--accent-contrast); font-weight: 700; }
.steps__item--current .steps__label { color: var(--text-primary); font-weight: 700; }
.steps__item--done .steps__dot { border-color: var(--accent); color: var(--accent); }
.steps__item--done .steps__label { color: var(--text-secondary); }
.steps__label { color: var(--text-muted); font-size: 12px; white-space: nowrap; }

.flow {
  display: grid;
  gap: var(--space-4);
  width: min(720px, 100%);
  margin: var(--space-4) auto;
  padding: 0 var(--space-6);
}

.card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--bg-surface);
}

.card__header {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.card__header h2 { margin: 0; color: var(--text-primary); font-size: 15px; font-weight: 700; }
.card__note { margin: 0; color: var(--text-secondary); font-size: 13px; }
.card__note--muted { color: var(--text-muted); font-size: 12px; }

.upload-zone__target {
  display: grid;
  gap: var(--space-2);
  justify-items: center;
  min-height: 44px;
  padding: var(--space-6) var(--space-4);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-secondary);
  text-align: center;
  cursor: pointer;
}
.upload-zone__target:hover,
.upload-zone--active .upload-zone__target { border-color: var(--accent); color: var(--text-primary); }
.upload-zone__target:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.upload-zone__title { margin: 0; color: var(--text-primary); font-weight: 650; }
.upload-zone__hint { display: flex; align-items: center; gap: var(--space-1); margin: 0; color: var(--text-muted); font-size: 12px; }
.upload-zone__hint--privacy { color: var(--text-secondary); }
.upload-zone__target > svg { color: var(--accent); }

.visually-hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  overflow: hidden;
  white-space: nowrap;
}

.image-info { display: flex; gap: var(--space-4); }
.image-info__thumb {
  width: 96px;
  height: 96px;
  flex: none;
  object-fit: contain;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}
.image-info__meta { display: grid; gap: var(--space-2); min-width: 0; align-content: start; }
.image-info__name {
  margin: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.image-info__line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-secondary); font-size: 13px; }
.image-info__adjusted { margin: 0; color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }

.field-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.field-label { color: var(--text-secondary); font-size: 13px; font-weight: 600; }
.field-select {
  min-height: 40px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-app);
  color: var(--text-primary);
}
.field-select:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

.progress-block { display: grid; gap: var(--space-2); }
.progress-block__line { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-secondary); font-size: 13px; }
.progress-block__bar { height: 6px; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 999px; background: var(--bg-code); }
.progress-block__fill { height: 100%; background: var(--accent); }

.low-lines { display: grid; gap: var(--space-2); }
.low-lines__note { margin: 0; color: var(--warning); font-size: 12px; }
.low-lines__list { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.low-lines__item {
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-left: 3px solid var(--warning);
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
  background: var(--bg-code);
}
.low-lines__text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; color: var(--text-primary); font-size: 13px; }
.low-lines__tag {
  flex: none;
  padding: 0 var(--space-2);
  border: 1px solid color-mix(in srgb, var(--warning) 55%, var(--border-subtle));
  border-radius: 999px;
  color: var(--warning);
  font-size: 11px;
  font-weight: 700;
}
.low-lines__score { flex: none; color: var(--warning); font-size: 12px; }

.proof-input {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  padding: var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-primary);
  line-height: 1.6;
}
.proof-input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

.action-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }

.cloud-option__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
.cloud-option__actions > span { color: var(--text-muted); font-size: 12px; }

.run-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-secondary); font-size: 13px; }
.run-line--ok { color: var(--success); }
.run-hint { margin: 0; color: var(--text-muted); font-size: 12px; }

.queue-card { display: grid; gap: var(--space-1); }
.queue-card__position { margin: 0; color: var(--text-secondary); font-size: 13px; }
.queue-card__number { font-size: 16px; font-weight: 700; }

.cloud-state { display: grid; gap: var(--space-2); }

.status-area { display: grid; gap: var(--space-2); }

.panel {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-app);
  color: var(--text-primary);
}
.panel p { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; }
.panel strong { flex: none; }
.panel--warn { border-color: color-mix(in srgb, var(--warning) 50%, var(--border-subtle)); }
.panel--warn p { color: var(--warning); }
.panel--danger { border-color: color-mix(in srgb, var(--danger) 50%, var(--border-subtle)); }
.panel--danger p { color: var(--danger); }
.panel__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.panel__link {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  color: var(--accent);
  font-weight: 600;
}

.chip {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: 12px;
}
.chip--mono { font-family: var(--font-mono); }

.num { font-family: var(--font-mono); color: var(--accent); }
.mono { font-family: var(--font-mono); overflow-wrap: anywhere; }

.privacy-note {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  color: var(--text-muted);
  font-size: 12px;
}

.link-button {
  flex: none;
  min-height: 36px;
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
}
.link-button:disabled { color: var(--text-muted); cursor: not-allowed; opacity: .6; }

.inline-notice { margin: 0; color: var(--text-secondary); font-size: 13px; }

.language-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
}

.stats { margin: 0; color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }

.translate-run { display: grid; gap: var(--space-3); }
.translate-result { display: grid; gap: var(--space-2); }
.translate-result__header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.translate-result__header h3 { margin: 0; color: var(--text-secondary); font-size: 14px; font-weight: 700; }
.translate-result__meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); }
.translate-output {
  display: block;
  width: 100%;
  min-height: 160px;
  overflow-y: auto;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-primary);
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.translate-output:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

.segment-list {
  display: grid;
  gap: 2px;
  max-height: 160px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  font-size: 12px;
}
.segment { display: flex; flex-wrap: wrap; gap: var(--space-2); color: var(--text-muted); }
.segment__index { flex: none; }
.segment--success .segment__status { color: var(--success); }
.segment--restore-failed .segment__status,
.segment--uncertain .segment__status { color: var(--warning); }
.segment--failed .segment__status { color: var(--danger); }
.action-bar {
  position: sticky;
  z-index: 20;
  bottom: 0;
  margin-top: auto;
  border-top: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-surface) 96%, transparent);
  box-shadow: 0 -8px 24px color-mix(in srgb, var(--bg-app) 42%, transparent);
  backdrop-filter: blur(10px);
}
.action-bar__constraints {
  margin: 0;
  padding: var(--space-2) var(--space-6) 0;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}
.action-bar__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: min(720px, 100%);
  margin: 0 auto;
  padding: var(--space-3) var(--space-6);
}
.action-bar__row .run-hint { flex: 1 1 240px; min-width: 0; }
.action-bar__main { flex: none; }
.action-bar__copy-note {
  margin: 0;
  padding: 0 var(--space-6) var(--space-3);
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

.quota-summary { display: grid; gap: 2px; margin: 0; text-align: right; color: var(--text-muted); font-size: 12px; }
.quota-summary__item { color: var(--text-secondary); }
.quota-summary__source { font-size: 11px; }
.quota-summary--muted { text-align: right; }

.confirmation-backdrop {
  position: fixed;
  z-index: 80;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--space-5);
  background: var(--scrim);
}

.confirmation-dialog {
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(760px, calc(100vh - 40px));
  overflow: auto;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-dialog);
  background: var(--bg-surface);
  box-shadow: var(--shadow-overlay);
}
.confirmation-dialog header,
.confirmation-dialog dl,
.confirmation-dialog .boundary-note,
.confirmation-dialog footer { margin-right: var(--space-6); margin-left: var(--space-6); }
.confirmation-dialog header { padding-top: var(--space-6); }
.confirmation-dialog header p { margin: 0 0 var(--space-1); color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .12em; }
.confirmation-dialog header h2 { margin: 0; color: var(--text-primary); font-size: 20px; }
.confirmation-dialog header span { display: block; margin-top: var(--space-2); color: var(--text-secondary); }
.confirmation-dialog dl {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
}
.confirmation-dialog dl > div { display: grid; grid-template-columns: 108px 1fr; gap: var(--space-3); }
.confirmation-dialog dt { color: var(--text-muted); }
.confirmation-dialog dd { margin: 0; overflow-wrap: anywhere; color: var(--text-primary); }
.boundary-note {
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-secondary);
  font-size: 12px;
}
.confirmation-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-5) 0 var(--space-6);
}

@media (max-width: 767px) {
  .ocr-page { padding-bottom: 92px; }
  .ocr-desktop-header { display: none; }
  .ocr-mobile-header {
    position: sticky;
    z-index: 25;
    top: 55px;
    display: grid;
    min-height: 56px;
    grid-template-columns: 44px minmax(0, 1fr) 44px;
    align-items: center;
    padding: 0 var(--space-2);
    border-bottom: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-surface) 96%, transparent);
    backdrop-filter: blur(10px);
  }
  .ocr-mobile-header h1 {
    margin: 0;
    color: var(--text-primary);
    font-size: 16px;
    font-weight: 700;
    text-align: center;
  }
  .ocr-mobile-header__back {
    display: inline-grid;
    width: 44px;
    height: 44px;
    place-items: center;
    border-radius: var(--radius-control);
    color: var(--text-secondary);
  }
  .ocr-mobile-header__back:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
  .ocr-mobile-header__spacer { width: 44px; height: 44px; }
  .steps { width: auto; margin: var(--space-3) var(--space-4) 0; padding: 0; }
  .steps ol { gap: var(--space-2); }
  .steps li { gap: var(--space-2); }
  .steps li::after { min-width: 12px; }
  .steps__label { font-size: 11px; }
  .flow { width: auto; margin: var(--space-3) var(--space-4) var(--space-4); padding: 0; }
  .card { padding: var(--space-3); }
  .card__header { min-height: 28px; }
  .image-info { align-items: center; gap: var(--space-3); }
  .image-info__thumb { width: 52px; height: 52px; }
  .image-info__meta { flex: 1 1 auto; gap: var(--space-1); }
  .field-select { flex: 1 1 160px; min-height: 44px; }
  .field-row :deep(button) { min-height: 44px; }
  .action-row :deep(button) { min-height: 44px; }
  .cloud-option__actions { align-items: stretch; flex-direction: column; }
  .cloud-option__actions :deep(button) { width: 100%; min-height: 44px; }
  .proof-input { min-height: 140px; }
  .language-bar { flex-direction: column; align-items: stretch; }
  .action-bar { position: fixed; right: 0; left: 0; bottom: 0; }
  .action-bar__constraints,
  .action-bar__copy-note { display: none; }
  .action-bar__row { padding: var(--space-2) var(--space-4); }
  .action-bar__row--run :deep(button) { min-height: 44px; }
  .action-bar__main { width: 100%; min-height: 44px; }
  .quota-summary,
  .quota-summary--muted { text-align: left; }
  .confirmation-backdrop { align-items: end; padding: 0; }
  .confirmation-dialog { max-height: 92vh; border-radius: var(--radius-dialog) var(--radius-dialog) 0 0; }
  .confirmation-dialog header,
  .confirmation-dialog dl,
  .confirmation-dialog .boundary-note,
  .confirmation-dialog footer { margin-right: var(--space-4); margin-left: var(--space-4); }
  .confirmation-dialog dl > div { grid-template-columns: 1fr; gap: 2px; }
  .confirmation-dialog footer { flex-direction: column-reverse; }
  .confirmation-dialog footer :deep(button) { min-height: 44px; }
}
</style>

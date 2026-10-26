<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { useAuthStore } from '../../../app/auth'
import UiButton from '../../../components/ui/UiButton.vue'
import UiIcon from '../../../components/ui/UiIcon.vue'
import CopyButton from '../shared/ui/CopyButton.vue'
import ToolPageHeader from '../shared/ui/ToolPageHeader.vue'
import type {
  AliyunUsageMeterSnapshot,
  CloudErrorAction,
  PreflightPlan,
  ProfessionalScene,
  TranslationLanguagesResponse,
} from './contracts'
import {
  chunkStatusLabel,
  describeCloudError,
  engineLabel,
} from './contracts'
import LanguageSelect, { type LanguageOption } from './LanguageSelect.vue'
import { describeRunViolation, prepareTranslationRun, type PreparedTranslationRun } from './prepare'
import {
  fetchTranslationLanguages,
  fetchUsageCurrent,
  preflightTranslation,
  TranslateApiError,
} from './translateClient'
import { useTranslateRun, type TranslateChunkSeed } from './useTranslateRun'

/**
 * 文本翻译工作台（Screen 39 双栏规范版 + Screen 42 状态参考）。
 *
 * 大输入统计（保护+分块+计数）采用“主线程有界实现”：250ms 防抖后单次同步计算，
 * 代际标记让被新输入覆盖的旧结果直接作废；单次计算为线性扫描，不为它引入业务
 * Worker（docs/10 §3.3 允许主线程有界实现）。
 */

const auth = useAuthStore()

const AUTO_CODE = 'auto'
const PREVIEW_LIMIT = 1200

interface PreflightFailure {
  code: string
  status: number
  message: string
  action: CloudErrorAction
  /** PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED 时展示的当前场景支持方向。 */
  pairScope: string
}

const inputText = ref('')
const sourceLanguage = ref(AUTO_CODE)
const targetLanguage = ref('zh')
const protectEnabled = ref(true)

const languagesResponse = ref<TranslationLanguagesResponse | null>(null)
const languagesLoading = ref(false)
const languagesError = ref('')

const prepared = ref<PreparedTranslationRun | null>(null)
const preparing = ref(false)

const swapNotice = ref('')
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)

const previewOpen = ref(false)
const preflightRunning = ref(false)
const preflightError = ref<PreflightFailure | null>(null)
const replanSeeds = ref<TranslateChunkSeed[] | null>(null)
const usageMeters = ref<AliyunUsageMeterSnapshot[]>([])
const dialogElement = ref<HTMLElement | null>(null)
let previewReturnFocus: HTMLElement | null = null

let prepGeneration = 0
let preflightGeneration = 0
let pasteGeneration = 0
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
  isBusy,
} = run

const generalLanguages = computed(() => languagesResponse.value?.generalLanguages ?? [])
const sourceOptions = computed<LanguageOption[]>(() => [
  { code: AUTO_CODE, label: '自动检测', keywords: 'auto detect' },
  ...generalLanguages.value.map((entry) => toOption(entry.code, entry.nameZh, entry.nameEn)),
])
const targetOptions = computed<LanguageOption[]>(() =>
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
const inputBlockedReason = computed(() => {
  if (violations.value.length > 0) return violations.value.map(describeRunViolation).join(' ')
  if (sameLanguageSelected.value) return '源语言与目标语言相同；请修改其中一个后再翻译。'
  return ''
})

const chunkCount = computed(() => prepared.value?.chunks.length ?? 0)
const payloadUnits = computed(() => prepared.value?.payloadUnits ?? 0)

const outputText = computed(() =>
  runChunks.value
    .filter((chunk) => chunk.status === 'success' || chunk.status === 'restore-failed')
    .map((chunk) => chunk.resultText)
    .join(''),
)

const restoreFailedCount = computed(() =>
  runChunks.value.filter((chunk) => chunk.status === 'restore-failed').length,
)

const progressPercent = computed(() => {
  if (runChunks.value.length === 0) return 0
  return Math.round((completedCount.value / runChunks.value.length) * 100)
})

const engineChips = computed(() => {
  const chips: string[] = []
  if (enginesUsed.value.length > 0) {
    chips.push(`实际引擎：${enginesUsed.value.map((engine) => engineLabel(engine)).join(' + ')}`)
  }
  if (detectedLanguage.value) chips.push(`检测语言：${languageLabel(detectedLanguage.value)}`)
  return chips
})

const mainLabel = computed(() => {
  if (preflightRunning.value) return runPhase.value === 'replan' ? '正在重新规划…' : '准备翻译…'
  return runPhase.value === 'replan' ? '重试继续' : '翻译'
})

const mainDisabled = computed(() => {
  if (isBusy.value || preparing.value || preflightRunning.value || previewOpen.value) return true
  if (!online.value || languagesError.value) return true
  if (!inputText.value || !prepared.value || prepared.value.chunks.length === 0) return true
  if (violations.value.length > 0 || sameLanguageSelected.value || !targetLanguage.value) return true
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

const translationUsageMeters = computed(() =>
  usageMeters.value.filter((meter) => meter.meter === 'mt_general' || meter.meter === 'mt_professional'),
)

const previewText = computed(() => {
  const text = prepared.value?.protectedText ?? ''
  if (text.length <= PREVIEW_LIMIT) return text
  return `${text.slice(0, PREVIEW_LIMIT)}\n…（截断预览，实际发送完整内容）`
})
const previewNote = computed(() => {
  const current = prepared.value
  if (!current) return ''
  if (!current.protectionEnabled) {
    return '已关闭“保护技术内容”：原文将原样发送（包含代码、URL、路径与命令），不做占位符替换。'
  }
  const truncated = current.protectedText.length > PREVIEW_LIMIT
  return `已保护 ${current.segmentMap.size} 个技术片段（占位符形如 __DT_…__）${truncated ? '；以上为截断预览，实际发送完整内容' : ''}。`
})

onMounted(() => {
  void loadLanguages()
  void refreshUsage()
  window.addEventListener('online', handleOnlineChange)
  window.addEventListener('offline', handleOnlineChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('online', handleOnlineChange)
  window.clearTimeout(prepTimer)
  pasteGeneration += 1
  run.dispose()
})

watch([inputText, protectEnabled], () => {
  schedulePrepare()
})

watch([inputText, protectEnabled, sourceLanguage, targetLanguage], () => {
  // 输入上下文已变化，等待中的粘贴读取不再代表用户此刻想要的原文。
  pasteGeneration += 1
  if (isBusy.value) return
  preflightGeneration += 1
  preflightRunning.value = false
  run.resetForNewRun()
  replanSeeds.value = null
  preflightError.value = null
  closePreview(false)
})

watch(runPhase, (phase, previous) => {
  if ((phase === 'finished' || phase === 'cancelled' || phase === 'paused') && previous !== 'idle') {
    void refreshUsage()
  }
})

function handleOnlineChange() {
  online.value = navigator.onLine
}

async function loadLanguages() {
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

async function refreshUsage() {
  try {
    const usage = await fetchUsageCurrent()
    usageMeters.value = usage.meters
  } catch {
    // 额度摘要尽力而为；实际发送仍以 preflight 计划为准。
  }
}

/**
 * 大输入统计：防抖后一次同步计算；代际标记让被新输入覆盖的旧结果直接作废。
 * 这是本页唯一的重计算路径，单次线性扫描即可完成，结果被下一次输入取代。
 */
function schedulePrepare() {
  window.clearTimeout(prepTimer)
  prepGeneration += 1
  if (!inputText.value) {
    prepared.value = null
    preparing.value = false
    return
  }
  prepared.value = null
  preparing.value = true
  prepTimer = window.setTimeout(() => {
    const generation = prepGeneration
    const result = prepareTranslationRun(inputText.value, protectEnabled.value)
    if (generation !== prepGeneration) return
    prepared.value = result
    preparing.value = false
  }, 250)
}

function swapLanguages() {
  if (sourceLanguage.value === AUTO_CODE) {
    swapNotice.value = '“自动检测”不能作为交换目标；请先手动选择明确的源语言。'
    return
  }
  if (!targetLanguage.value) {
    swapNotice.value = '请先选择目标语言，再交换源/目标。'
    return
  }
  swapNotice.value = ''
  const previousSource = sourceLanguage.value
  sourceLanguage.value = targetLanguage.value
  targetLanguage.value = previousSource
}

async function pasteInput() {
  if (isBusy.value) return
  const generation = ++pasteGeneration
  try {
    const text = await navigator.clipboard.readText()
    if (pasteStale(generation)) return
    inputText.value = text
    swapNotice.value = ''
  } catch {
    if (pasteStale(generation)) return
    swapNotice.value = '浏览器未允许读取剪贴板，请使用系统粘贴快捷键。'
  }
}

/**
 * 读取完成时若已被更新的粘贴/清空/上下文变化取代，或在它之后已有一次有效预检开始，迟到结果永久丢弃；
 * 实际运行中（isBusy）也不写入。预检进行中用户主动发起的新粘贴不在此列，与手输一样生效并作废旧预检。
 */
function pasteStale(generation: number): boolean {
  return generation !== pasteGeneration || isBusy.value
}

function clearInput() {
  if (isBusy.value) return
  pasteGeneration += 1
  inputText.value = ''
  swapNotice.value = ''
}

function openPreview(trigger: Event) {
  if (!prepared.value) return
  capturePreviewTriggerFocus(trigger)
  previewOpen.value = true
  void focusDialogStart()
}

async function startTranslation() {
  if (mainDisabled.value) return
  if (runPhase.value === 'replan' && replanSeeds.value) {
    await requestReplanPlan(replanSeeds.value)
    return
  }
  const current = prepared.value
  if (!current || current.chunks.length === 0) return
  const generation = ++preflightGeneration
  pasteGeneration += 1
  preflightRunning.value = true
  preflightError.value = null
  try {
    const plan = await preflightTranslation(
      {
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
        chunkUnits: current.chunks.map((chunk) => chunk.units),
      },
      auth.csrfToken,
    )
    if (generation !== preflightGeneration) return
    startPlannedRun(current, current.chunks, plan)
  } catch (error) {
    if (generation !== preflightGeneration) return
    preflightError.value = describePreflightError(error)
  } finally {
    if (generation === preflightGeneration) preflightRunning.value = false
  }
}

/** PREFLIGHT_CHANGED 后的重新预检：用“待发 + 剩余未发送”片段与当前语言重取完整计划。 */
async function requestReplanPlan(seeds: TranslateChunkSeed[]) {
  if (seeds.length === 0) return
  const generation = ++preflightGeneration
  pasteGeneration += 1
  preflightRunning.value = true
  preflightError.value = null
  try {
    const plan = await preflightTranslation(
      {
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
        chunkUnits: seeds.map((seed) => seed.units),
      },
      auth.csrfToken,
    )
    if (generation !== preflightGeneration) return
    const current = prepared.value
    if (!current) return
    startPlannedRun(current, seeds, plan)
  } catch (error) {
    if (generation !== preflightGeneration) return
    preflightError.value = describePreflightError(error)
  } finally {
    if (generation === preflightGeneration) preflightRunning.value = false
  }
}

function describePreflightError(error: unknown): PreflightFailure {
  if (!(error instanceof TranslateApiError)) {
    return {
      code: 'NETWORK_ERROR',
      status: 0,
      message: error instanceof Error ? error.message : '预检请求未成功。',
      action: describeCloudError('NETWORK_ERROR', 0),
      pairScope: '',
    }
  }
  let pairScope = ''
  if (error.code === 'PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED') {
    const scene = typeof error.details.scene === 'string' ? error.details.scene : ''
    const pairs = scene
      ? languagesResponse.value?.professionalPairsByScene?.[scene as ProfessionalScene]
      : undefined
    if (pairs) {
      pairScope = `当前场景支持的语言方向：${pairs
        .map(([from, to]) => `${languageLabel(from) || from} → ${languageLabel(to) || to}`)
        .join('、')}`
    }
  }
  return {
    code: error.code,
    status: error.status,
    message: error.message,
    action: describeCloudError(error.code, error.status),
    pairScope,
  }
}

function startPlannedRun(
  current: PreparedTranslationRun,
  seeds: TranslateChunkSeed[],
  plan: PreflightPlan,
) {
  const planMismatch = plan.items.length !== seeds.length || plan.items.some(
    (item, position) => item.index !== position || item.units !== seeds[position]?.units,
  )
  if (planMismatch) {
    preflightError.value = {
      code: 'INVALID_INPUT',
      status: 400,
      message: '额度计划片段数与待发送片段不一致，请重新预检。',
      action: describeCloudError('INVALID_INPUT', 400),
      pairScope: '',
    }
    return
  }
  replanSeeds.value = null
  preflightError.value = null
  void run.start(
    {
      chunks: seeds,
      plan,
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
      runId: current.runId,
      segmentMap: current.segmentMap,
      protectionEnabled: current.protectionEnabled,
    },
    () => auth.csrfToken,
  )
}

function closePreview(restoreFocus = true) {
  if (!previewOpen.value) return
  const returnTarget = previewReturnFocus
  previewOpen.value = false
  previewReturnFocus = null
  if (restoreFocus) void nextTick(() => returnTarget?.focus())
}

function capturePreviewTriggerFocus(event: Event) {
  previewReturnFocus = event.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
}

async function focusDialogStart() {
  await nextTick()
  if (!dialogElement.value) return
  dialogElement.value.scrollTop = 0
  dialogElement.value.focus({ preventScroll: true })
}

function handleDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closePreview()
    return
  }
  if (event.key !== 'Tab' || !dialogElement.value) return
  const focusable = [...dialogElement.value.querySelectorAll<HTMLElement>(
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

function panelClassFor(action: CloudErrorAction | null): string {
  if (!action) return ''
  if (action.kind === 'quota') return 'panel--danger'
  if (action.kind === 'uncertain' || action.kind === 'settings') return 'panel--warn'
  return ''
}

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
</script>

<template>
  <section class="translate-page" aria-label="文本翻译">
    <ToolPageHeader
      title="文本翻译"
      description="翻译 Markdown 与技术文本；代码、URL、路径和命令默认留在本机。"
      processing="cloud"
    />

    <div class="translation-controls">
      <div class="language-bar" role="group" aria-label="翻译语言">
        <LanguageSelect
          id="translate-source-language"
          v-model="sourceLanguage"
          :options="sourceOptions"
          :placeholder="languagesLoading ? '语言清单加载中…' : '源语言'"
          label="源语言，默认自动检测"
          :disabled="isBusy || languagesLoading"
        />
        <UiButton
          variant="ghost"
          class="swap-button"
          aria-label="交换源语言和目标语言"
          :disabled="isBusy"
          @click="swapLanguages"
        >
          <UiIcon name="arrow-left-right" :size="18" />
        </UiButton>
        <LanguageSelect
          id="translate-target-language"
          v-model="targetLanguage"
          :options="targetOptions"
          :placeholder="languagesLoading ? '语言清单加载中…' : '中文'"
          label="目标语言，默认中文"
          :disabled="isBusy || languagesLoading"
        />
      </div>
      <p v-if="translationUsageMeters.length" class="quota-summary" aria-label="本地保护账本剩余">
        <span v-for="meter in translationUsageMeters" :key="meter.meter" class="quota-summary__item">
          {{ meter.meter === 'mt_general' ? '通用版' : '专业版' }}剩余
          <span class="num">{{ fmt(meter.remaining) }}</span> / {{ fmt(meter.limit) }}
        </span>
        <span class="quota-summary__source">本应用额度估算</span>
      </p>
    </div>
    <p v-if="swapNotice" class="inline-notice" role="status">{{ swapNotice }}</p>
    <p v-else-if="!online" class="inline-notice inline-notice--warn" role="alert">
      当前处于离线状态，云翻译暂不可用；本地统计不受影响。
    </p>

    <div id="translate-status" class="status-area">
      <div v-if="languagesError" class="panel panel--warn" role="alert">
        <p><UiIcon name="triangle-alert" :size="16" /> 语言清单加载失败：{{ languagesError }}</p>
        <UiButton variant="secondary" @click="loadLanguages">重试加载</UiButton>
      </div>

      <div v-if="inputBlockedReason" class="panel panel--warn" role="alert">
        <p><UiIcon name="triangle-alert" :size="16" /> {{ inputBlockedReason }}</p>
      </div>

      <div
        v-if="preflightError"
        class="panel"
        :class="panelClassFor(preflightError.action)"
        role="alert"
        data-testid="translate-preflight-error"
      >
        <p>
          <UiIcon :name="preflightError.action.kind === 'quota' ? 'x-circle' : 'triangle-alert'" :size="16" />
          <strong>{{ preflightError.action.title }}</strong> {{ preflightError.action.detail }}
        </p>
        <p v-if="preflightError.pairScope" class="panel__detail">{{ preflightError.pairScope }}</p>
        <RouterLink
          v-if="preflightError.action.kind === 'settings' || preflightError.action.kind === 'quota'"
          class="panel__link"
          to="/settings/aliyun"
        >{{ preflightError.action.kind === 'quota' ? '查看额度设置' : '前往设置' }}</RouterLink>
      </div>

      <div
        v-if="runError && runErrorAction"
        class="panel"
        :class="panelClassFor(runErrorAction)"
        role="alert"
        data-testid="translate-run-error"
      >
        <p>
          <UiIcon
            :name="runErrorAction.kind === 'quota' ? 'x-circle' : runErrorAction.kind === 'uncertain' ? 'clock' : 'triangle-alert'"
            :size="16"
          />
          <strong>{{ runErrorAction.title }}</strong> {{ runErrorAction.detail }}
        </p>
        <p v-if="runErrorAction.kind === 'quota'" class="panel__detail">
          通用版与专业版剩余额度见页面顶部；重置时间以设置页为准。
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

      <p v-if="restoreFailedCount > 0 && !isBusy" class="inline-notice inline-notice--warn" role="status">
        有 {{ restoreFailedCount }} 个片段占位符还原失败，已保留原文；这些片段的云额度已经使用。
      </p>
    </div>

    <div class="translate-columns">
      <section class="pane" aria-labelledby="translate-source-heading">
        <header class="pane__header">
          <h2 id="translate-source-heading"><label for="translate-input">原文</label></h2>
          <div class="pane__actions">
            <UiButton variant="ghost" aria-label="粘贴剪贴板文本到原文" :disabled="isBusy" @click="pasteInput">
              <UiIcon name="copy" :size="16" />
            </UiButton>
            <UiButton variant="ghost" aria-label="清空原文" :disabled="isBusy" @click="clearInput">
              <UiIcon name="trash-2" :size="16" />
            </UiButton>
          </div>
        </header>
        <nav class="skip-links" aria-label="原文区快捷跳转">
          <a href="#translate-actions">跳到操作区</a>
          <a href="#translate-status">跳到状态区</a>
        </nav>
        <textarea
          id="translate-input"
          v-model="inputText"
          class="source-input"
          rows="14"
          spellcheck="false"
          :disabled="isBusy"
          placeholder="在此输入需要翻译的文本（支持 Markdown）…"
        />
      </section>

      <section class="pane" aria-labelledby="translate-result-heading">
        <header class="pane__header">
          <h2 id="translate-result-heading">译文</h2>
          <div class="pane__meta">
            <span v-for="chip in engineChips" :key="chip" class="chip chip--mono">{{ chip }}</span>
            <CopyButton :text="outputText" />
          </div>
        </header>
        <output class="result-output" data-testid="translate-output" for="translate-input">
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
      </section>
    </div>

    <footer id="translate-actions" class="action-bar">
      <div class="action-bar__row action-bar__row--settings">
        <label class="protect-toggle">
          <input v-model="protectEnabled" type="checkbox" :disabled="isBusy" />
          保护技术内容（Markdown 结构、代码、URL、路径及命令）
        </label>
        <p class="stats">
          <template v-if="preparing">正在统计发送范围…</template>
          <template v-else-if="inputText">
            输入 <span class="num">{{ fmt(inputText.length) }}</span> 字符 ·
            预计计费 <span class="num">{{ fmt(payloadUnits) }}</span> UTF-16 ·
            <span class="num">{{ fmt(chunkCount) }}</span> 个请求 ·
            {{ protectEnabled ? '仅自然语言片段发送至阿里云' : '保护已关闭，原文将原样发送' }}
          </template>
          <template v-else>输入文本后显示字符数、预计计费 UTF-16 数与请求数。</template>
        </p>
        <button type="button" class="link-button" :disabled="!prepared" @click="openPreview">查看发送范围</button>
      </div>

      <div class="action-bar__row action-bar__row--run">
        <div class="run-state" aria-live="polite">
          <p v-if="runPhase === 'queueing' || runPhase === 'claiming'" class="run-state__line">
            <UiIcon name="clock" :size="16" /> 正在申请云调用许可…
          </p>
          <div v-else-if="runPhase === 'waiting'" class="queue-card" data-testid="translate-queue">
            <p class="run-state__line">
              <UiIcon name="clock" :size="16" /> 当前云端请求较多，正在排队中…
            </p>
            <p class="queue-card__position">
              当前队列位置：<span class="num queue-card__number">{{ queuePosition ?? '—' }}</span>
              <span v-if="ticketExpiresAt"> · {{ formatClock(ticketExpiresAt) }} 到期（最多等待 2 分钟）</span>
            </p>
          </div>
          <div v-else-if="runPhase === 'running'" class="progress-block">
            <p class="run-state__line">
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
            <p class="run-state__hint">已成功片段实时保留；失败后仅重试失败段，不会自动重试或换引擎。</p>
          </div>
          <p v-else-if="runPhase === 'replan'" class="run-state__line">
            <UiIcon name="info" :size="16" />
            额度或引擎已变化；{{ preflightRunning ? '正在重新规划并继续…' : '重新规划失败，请重试。' }}
          </p>
          <p v-else-if="runPhase === 'finished'" class="run-state__line">
            <UiIcon name="check-circle-2" :size="16" />
            已完成 {{ completedCount }} / {{ runChunks.length }} 段 ·
            实际引擎：{{ enginesUsed.map((engine) => engineLabel(engine)).join(' + ') || '—' }}
          </p>
          <p v-else-if="runPhase === 'cancelled' && cancelBreakdown" class="run-state__line">
            <UiIcon name="x" :size="16" />
            已取消：未发送 {{ cancelBreakdown.notSent }} 段 · 已发送 {{ cancelBreakdown.sent }} 段 ·
            结果不确定 {{ cancelBreakdown.uncertain }} 段
          </p>
          <p v-else-if="runPhase === 'paused'" class="run-state__line">
            <UiIcon name="info" :size="16" /> 运行已暂停；可从失败片段继续，或修改后重新预检。
          </p>
          <p v-else class="run-state__line run-state__line--idle">
            点击“翻译”后将先检查额度，再把受保护的自然语言片段发送至阿里云。
          </p>
        </div>
        <span class="privacy-note"><UiIcon name="lock-keyhole" :size="14" /> 内容不保存</span>
        <UiButton v-if="isBusy" variant="secondary" data-testid="translate-cancel" @click="run.cancel()">取消</UiButton>
        <UiButton
          variant="primary"
          :disabled="mainDisabled"
          data-testid="translate-primary"
          @click="startTranslation"
        >{{ mainLabel }}</UiButton>
      </div>
    </footer>

    <div v-if="previewOpen" class="confirmation-backdrop" @mousedown.self="closePreview()">
      <section
        ref="dialogElement"
        class="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="translate-confirm-title"
        tabindex="-1"
        @keydown="handleDialogKeydown"
      >
        <header>
          <p>发送范围</p>
          <h2 id="translate-confirm-title">将发送给阿里云的内容</h2>
          <span>这里仅供检查，不会发起翻译；关闭后点击“翻译”开始。</span>
        </header>
        <dl>
          <div><dt>实际接收方</dt><dd>阿里云机器翻译</dd></div>
          <div><dt>源语言</dt><dd>{{ languageLabel(sourceLanguage) }}</dd></div>
          <div><dt>目标语言</dt><dd>{{ languageLabel(targetLanguage) }}</dd></div>
          <div>
            <dt>片段与计费</dt>
            <dd>
              {{ fmt(chunkCount) }} 个片段 · 预计计费 {{ fmt(payloadUnits) }} UTF-16
            </dd>
          </div>
        </dl>
        <label class="preview-label" for="translate-send-preview">
          内容预览（{{ protectEnabled ? '占位符代表受保护的技术片段' : '保护已关闭' }}）
        </label>
        <pre id="translate-send-preview" class="preview" data-testid="translate-send-preview">{{ previewText || '（空）' }}</pre>
        <p class="preview-note">{{ previewNote }}</p>
        <footer>
          <UiButton variant="secondary" @click="closePreview()">关闭预览</UiButton>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.translate-page {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-app);
}

.translate-page :deep(.tool-page-header) { padding-top: var(--space-4); padding-bottom: var(--space-4); }

.translation-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  margin: var(--space-3) 0;
  padding: 0 var(--space-6);
}

.language-bar {
  display: flex;
  width: 100%;
  max-width: 720px;
  flex: 1 1 720px;
  align-items: center;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--bg-surface);
}

.swap-button { flex: none; }

.inline-notice {
  width: min(720px, 100%);
  margin: calc(-1 * var(--space-2)) auto var(--space-3);
  color: var(--text-secondary);
  font-size: 13px;
}

.inline-notice--warn { color: var(--warning); }

.status-area {
  display: grid;
  gap: var(--space-2);
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: 0 var(--space-6);
}

.panel {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  color: var(--text-primary);
}

.panel p { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; }
.panel strong { flex: none; }
.panel--warn { border-color: color-mix(in srgb, var(--warning) 50%, var(--border-subtle)); }
.panel--warn p { color: var(--warning); }
.panel--danger { border-color: color-mix(in srgb, var(--danger) 50%, var(--border-subtle)); }
.panel--danger p { color: var(--danger); }
.panel__detail { color: var(--text-secondary) !important; font-size: 13px; }
.panel__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.panel__link {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  color: var(--accent);
  font-weight: 600;
}

.translate-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1px;
  flex: 1;
  min-height: 0;
  margin: var(--space-4) var(--space-6);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--border-subtle);
}

.pane {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-surface);
}

.pane__header {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.pane__header h2 { margin: 0; color: var(--text-secondary); font-size: 14px; font-weight: 700; }
.pane__header label { cursor: text; }
.pane__actions, .pane__meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); }

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

.skip-links { display: flex; gap: var(--space-3); margin: var(--space-1) 0; font-size: 12px; }
.skip-links a { color: var(--text-muted); }

.source-input {
  width: 100%;
  min-height: 0;
  flex: 1;
  resize: none;
  overflow-y: auto;
  padding: var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-primary);
  line-height: 1.6;
}

.source-input:focus-visible,
.result-output:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.result-output {
  display: block;
  width: 100%;
  min-height: 0;
  flex: 1;
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

.segment-list {
  display: grid;
  gap: 2px;
  max-height: 160px;
  margin: var(--space-2) 0 0;
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
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.action-bar__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: var(--space-3) var(--space-6);
}

.action-bar__row--settings { border-bottom: 1px solid var(--border-subtle); }

.protect-toggle {
  display: inline-flex;
  min-height: 32px;
  /* 允许在窄行内收缩换行；桌面行宽充裕时与 flex:none 呈现一致。 */
  flex: 0 1 auto;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}

.protect-toggle input { width: 16px; height: 16px; accent-color: var(--accent); }

.stats { flex: 1 1 320px; min-width: 0; margin: 0; color: var(--text-muted); font-size: 12px; }

.num { font-family: var(--font-mono); color: var(--accent); }

.link-button {
  flex: none;
  min-height: 32px;
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

.action-bar__row--run { padding-top: var(--space-2); padding-bottom: var(--space-3); }

.run-state { display: grid; flex: 1 1 320px; gap: var(--space-1); min-width: 0; }
.run-state__line { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-secondary); font-size: 13px; }
.run-state__line--idle { color: var(--text-muted); }
.run-state__hint { margin: 0; color: var(--text-muted); font-size: 12px; }

.queue-card { display: grid; gap: var(--space-1); }
.queue-card__position { margin: 0; color: var(--text-secondary); font-size: 13px; }
.queue-card__number { font-size: 16px; font-weight: 700; }

.progress-block { display: grid; gap: var(--space-2); width: 100%; max-width: 480px; }
.progress-block__bar { height: 6px; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 999px; background: var(--bg-code); }
.progress-block__fill { height: 100%; background: var(--accent); }

.privacy-note {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  color: var(--text-muted);
  font-size: 12px;
}

.quota-summary { display: grid; min-width: 190px; flex: none; gap: 2px; margin: 0; text-align: right; color: var(--text-muted); font-size: 12px; }
.quota-summary__item { color: var(--text-secondary); }
.quota-summary__source { font-size: 11px; }

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
  width: min(760px, 100%);
  max-height: min(820px, calc(100vh - 40px));
  overflow: auto;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-dialog);
  background: var(--bg-surface);
  box-shadow: var(--shadow-overlay);
}

.confirmation-dialog header,
.confirmation-dialog dl,
.confirmation-dialog .preview-label,
.confirmation-dialog .preview,
.confirmation-dialog .preview-note,
.confirmation-dialog footer {
  margin-right: var(--space-6);
  margin-left: var(--space-6);
}

.confirmation-dialog header { padding-top: var(--space-6); }
.confirmation-dialog header p { margin: 0 0 var(--space-1); color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .12em; }
.confirmation-dialog header h2 { margin: 0; color: var(--text-primary); font-size: 22px; }
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

.preview-note { margin-top: var(--space-3); color: var(--text-muted); font-size: 12px; }

.preview-label { display: block; margin-top: var(--space-3); color: var(--text-secondary); font-size: 12px; font-weight: 700; }

.preview {
  max-height: 260px;
  overflow: auto;
  margin-top: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.confirmation-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-5) 0 var(--space-6);
}

@media (max-width: 1000px) {
  .translate-page { height: auto; min-height: 100%; overflow: visible; }
  .translate-columns { min-height: 440px; }
  .pane { overflow: visible; }
  .source-input, .result-output { min-height: 300px; }
}

@media (max-width: 767px) {
  /* 基础样式的 width:min(720px,100%) 与水平 margin 叠加会超出视口，窄屏改回 auto 收缩。 */
  .translation-controls { align-items: stretch; flex-direction: column; margin: var(--space-3) 0; padding: 0 var(--space-4); }
  .language-bar { max-width: none; flex: none; flex-wrap: wrap; width: 100%; padding: var(--space-3); }
  .swap-button { min-height: 44px; }
  .inline-notice { width: auto; margin: 0 var(--space-4) var(--space-3); }
  .status-area { padding: 0 var(--space-4); }
  .translate-columns { display: flex; flex-direction: column; margin: var(--space-3) var(--space-4); }
  .pane { padding: var(--space-3); }
  .source-input, .result-output { min-height: 200px; }
  .action-bar__row { padding: var(--space-3) var(--space-4); }
  .protect-toggle { min-height: 44px; }
  .action-bar__row--run :deep(button) { min-height: 44px; }
  .pane__actions :deep(button) { min-height: 44px; min-width: 44px; }
  .confirmation-backdrop { align-items: end; padding: 0; }
  .confirmation-dialog { max-height: 92vh; border-radius: var(--radius-dialog) var(--radius-dialog) 0 0; }
  .confirmation-dialog header,
  .confirmation-dialog dl,
  .confirmation-dialog .preview-label,
  .confirmation-dialog .preview,
  .confirmation-dialog .preview-note,
  .confirmation-dialog footer { margin-right: var(--space-4); margin-left: var(--space-4); }
  .confirmation-dialog dl > div { grid-template-columns: 1fr; gap: 2px; }
  .confirmation-dialog footer { flex-direction: column-reverse; }
  .quota-summary { min-width: 0; text-align: left; }
}
</style>

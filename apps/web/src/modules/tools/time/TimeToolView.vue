<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import UiButton from '../../../components/ui/UiButton.vue'
import ProcessingBadge from '../shared/ui/ProcessingBadge.vue'
import { previewCron, type CronDialect, type CronPreview } from './cron'
import LocalDateTimeField from './LocalDateTimeField.vue'
import TimeResultCard from './TimeResultCard.vue'
import TimeZoneCombobox from './TimeZoneCombobox.vue'
import {
  addWorkdays,
  assertTimeText,
  availableTimeZones,
  calculateDate,
  convertTime,
  currentTime,
  differenceBetweenDates,
  parseNaturalLanguage,
  systemTimeZone,
  WORKDAY_AMOUNT_LIMIT,
  type LocalTimeResolution,
  type NaturalLanguageResult,
  type ResolutionRequired,
  type TimeResolutionResult,
  type TimeSnapshot,
} from './time'

type Tab = 'convert' | 'calculate' | 'workday' | 'cron' | 'natural'

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'convert', label: '时间转换' },
  { id: 'calculate', label: '日期计算' },
  { id: 'workday', label: '工作日' },
  { id: 'cron', label: 'Cron' },
  { id: 'natural', label: '自然语言' },
]

const activeTab = ref<Tab>('convert')
const timeZone = ref(systemTimeZone())
const timeZones = availableTimeZones()
const nowSnapshot = ref<TimeSnapshot | null>(null)
const copyStatus = ref('')
const errorMessage = ref('')
const zoneStaleMessage = ref('')
let clockTimer: number | undefined
// 时区切换后旧结果不再作为当前结论展示；捕获该计数使切换前启动的在途异步晚到结果作废。
let zoneGeneration = 0
// 转换的局部代数：输入值/类型变化或新一次转换开始时推进，只归属时间转换的在途结果，不影响其他页签。
let conversionGeneration = 0
// 当前结果与待决夏令时状态所基于的已提交时区；combobox 未提交的草稿输入不触发失效。
let resultsTimeZone = timeZone.value
// 其余表单各自的局部代数：输入变化或新请求开始时推进，只归属本表单的在途结果；工作日与时区无关，不参与换区失效。
let calculationGeneration = 0
let differenceGeneration = 0
let workdayGeneration = 0
let naturalGeneration = 0

const conversionKind = ref<'unix_seconds' | 'unix_milliseconds' | 'iso' | 'local'>('iso')
const conversionInput = ref(new Date().toISOString())
const conversionResult = ref<TimeSnapshot | null>(null)
const conversionResolution = ref<ResolutionRequired | null>(null)

const calculationStart = ref(toLocalInputValue(new Date()))
const calculationDirection = ref<1 | -1>(1)
const calculationValues = ref({ years: 0, months: 0, days: 1, hours: 0, minutes: 0, seconds: 0 })
const calculationResult = ref<TimeSnapshot | null>(null)
const calculationResolution = ref<ResolutionRequired | null>(null)
const differenceFrom = ref(toLocalInputValue(new Date()))
const differenceTo = ref(toLocalInputValue(new Date(Date.now() + 86_400_000)))
const differenceResult = ref<{ duration: string; totalSeconds: string } | null>(null)
const differenceResolution = ref<{ side: 'from' | 'to'; value: ResolutionRequired } | null>(null)
const differenceFromResolution = ref<LocalTimeResolution>()
const differenceToResolution = ref<LocalTimeResolution>()

const workdayStart = ref(new Date().toISOString().slice(0, 10))
const workdayAmount = ref(5)
const holidayInput = ref('')
const workdayInput = ref('')
const workdayResult = ref<Awaited<ReturnType<typeof addWorkdays>> | null>(null)

const cronDialect = ref<CronDialect>('unix')
const cronExpression = ref('0 9 * * 1-5')
const cronBase = ref(new Date().toISOString())
const cronResult = ref<CronPreview | null>(null)

const naturalInput = ref('明天下午 3 点')
const naturalResult = ref<NaturalLanguageResult | null>(null)
const naturalResolution = ref<ResolutionRequired | null>(null)

const currentTimeLabel = computed(() => nowSnapshot.value?.zoned ?? '正在读取…')

watch([differenceFrom, differenceTo, timeZone], () => {
  differenceFromResolution.value = undefined
  differenceToResolution.value = undefined
})

// 转换输入值或类型变化后，旧结果、待决夏令时选择与旧错误立即失效且不自动重算；
// 同步推进转换局部代数，使变化前启动的在途转换晚到时不再写回。
watch([conversionInput, conversionKind], () => {
  conversionGeneration += 1
  conversionResult.value = null
  conversionResolution.value = null
  errorMessage.value = ''
})

// 日期加减输入变化后，旧结果、待决夏令时选择与旧错误立即失效且不自动重算；
// 同步推进局部代数作废在途结果。calculationValues 为嵌套对象，需深度侦听真实字段输入而非仅对象替换。
watch([calculationStart, calculationDirection, calculationValues], () => {
  calculationGeneration += 1
  calculationResult.value = null
  calculationResolution.value = null
  errorMessage.value = ''
}, { deep: true })

// 时间差任一端变化后清除自己的旧结果与待决夏令时提示；已选 resolution 沿用上方含时区的既有 watch 清理。
// 结果清理不得并入含 timeZone 草稿值的 watch：combobox 未提交草稿不作废结果，时区相关失效仅在 commit 时发生。
watch([differenceFrom, differenceTo], () => {
  differenceGeneration += 1
  differenceResult.value = null
  differenceResolution.value = null
  errorMessage.value = ''
})

// 工作日计算与时区无关：仅本表单输入变化清除旧结果、复制入口与旧错误并作废在途，换区 commit 不影响。
watch([workdayStart, workdayAmount, holidayInput, workdayInput], () => {
  workdayGeneration += 1
  workdayResult.value = null
  errorMessage.value = ''
})

// Cron 预览为同步计算，无在途结果；表达式/基准/方言变化清除旧预览与旧错误。方言切换同时替换表达式，同一批触发一次。
watch([cronDialect, cronExpression, cronBase], () => {
  cronResult.value = null
  errorMessage.value = ''
})

// 自然语言表达式变化后清除旧结果、待决夏令时提示与旧错误，并推进局部代数作废在途。
watch(naturalInput, () => {
  naturalGeneration += 1
  naturalResult.value = null
  naturalResolution.value = null
  errorMessage.value = ''
})

onMounted(() => {
  void refreshClock()
  document.addEventListener('visibilitychange', handleVisibilityChange)
  startClock()
})

onBeforeUnmount(() => {
  stopClock()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})

function toLocalInputValue(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000
  return new Date(value.getTime() - offset).toISOString().slice(0, 19)
}

function startClock() {
  if (document.hidden || clockTimer !== undefined) return
  clockTimer = window.setInterval(() => void refreshClock(), 1000)
}

function stopClock() {
  if (clockTimer !== undefined) window.clearInterval(clockTimer)
  clockTimer = undefined
}

function handleVisibilityChange() {
  if (document.hidden) stopClock()
  else {
    void refreshClock()
    startClock()
  }
}

async function refreshClock() {
  const generation = zoneGeneration
  try {
    const snapshot = await currentTime(timeZone.value)
    if (generation !== zoneGeneration) return
    nowSnapshot.value = snapshot
  } catch {
    if (generation !== zoneGeneration) return
    nowSnapshot.value = null
  }
}

function handleTimeZoneCommit() {
  if (timeZone.value !== resultsTimeZone) {
    const previousZone = resultsTimeZone
    resultsTimeZone = timeZone.value
    // 只失效受影响的结果与待决夏令时状态，不自动重新执行任何计算；工作日计算与时区无关，保持不变。
    zoneGeneration += 1
    conversionResult.value = null
    conversionResolution.value = null
    calculationResult.value = null
    calculationResolution.value = null
    differenceResult.value = null
    differenceResolution.value = null
    differenceFromResolution.value = undefined
    differenceToResolution.value = undefined
    cronResult.value = null
    naturalResult.value = null
    naturalResolution.value = null
    errorMessage.value = ''
    zoneStaleMessage.value = `时区已切换（${previousZone} → ${timeZone.value}），旧时区的结果与待决的夏令时选择已失效，请重新执行。`
  }
  // 在时区代数推进之后刷新，使本次时钟刷新以新代数写入新时区，而不是被在途守卫丢弃。
  void refreshClock()
}

function clearError() {
  errorMessage.value = ''
  zoneStaleMessage.value = ''
}

function showError(error: unknown) {
  errorMessage.value = error instanceof Error ? error.message : '处理失败，请检查输入'
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value)
  copyStatus.value = '已复制'
  window.setTimeout(() => { copyStatus.value = '' }, 1600)
}

async function runConversion(resolution?: LocalTimeResolution) {
  clearError()
  conversionResolution.value = null
  conversionResult.value = null
  const generation = zoneGeneration
  const conversion = ++conversionGeneration
  try {
    const result = await convertTime({
      kind: conversionKind.value,
      value: conversionInput.value,
      timeZone: timeZone.value,
      resolution,
    })
    if (generation !== zoneGeneration || conversion !== conversionGeneration) return
    applyTimeResult(result, conversionResult, conversionResolution)
  } catch (error) {
    if (generation !== zoneGeneration || conversion !== conversionGeneration) return
    showError(error)
  }
}

async function runCalculation(resolution?: LocalTimeResolution) {
  clearError()
  calculationResolution.value = null
  calculationResult.value = null
  const generation = zoneGeneration
  const calculation = ++calculationGeneration
  try {
    const result = await calculateDate({
      localDateTime: calculationStart.value,
      timeZone: timeZone.value,
      direction: calculationDirection.value,
      values: calculationValues.value,
      resolution,
    })
    if (generation !== zoneGeneration || calculation !== calculationGeneration) return
    applyTimeResult(result, calculationResult, calculationResolution)
  } catch (error) {
    if (generation !== zoneGeneration || calculation !== calculationGeneration) return
    showError(error)
  }
}

function applyTimeResult(
  result: TimeResolutionResult,
  target: { value: TimeSnapshot | null },
  resolutionTarget: { value: ResolutionRequired | null },
) {
  if (result.status === 'resolution_required') resolutionTarget.value = result
  else target.value = result.value
}

async function runDifference(side?: 'from' | 'to', resolution?: LocalTimeResolution) {
  clearError()
  differenceResult.value = null
  if (side === 'from') differenceFromResolution.value = resolution
  if (side === 'to') differenceToResolution.value = resolution
  differenceResolution.value = null
  const generation = zoneGeneration
  const difference = ++differenceGeneration
  try {
    const result = await differenceBetweenDates({
      from: differenceFrom.value,
      to: differenceTo.value,
      timeZone: timeZone.value,
      fromResolution: differenceFromResolution.value,
      toResolution: differenceToResolution.value,
    })
    if (generation !== zoneGeneration || difference !== differenceGeneration) return
    if ('resolution' in result) differenceResolution.value = { side: result.side, value: result.resolution }
    else differenceResult.value = { duration: result.duration, totalSeconds: result.totalSeconds }
  } catch (error) {
    if (generation !== zoneGeneration || difference !== differenceGeneration) return
    showError(error)
  }
}

function splitDates(value: string): string[] {
  return value.split(/[\s,，;；]+/).filter(Boolean)
}

async function runWorkday() {
  clearError()
  workdayResult.value = null
  const workday = ++workdayGeneration
  try {
    assertTimeText(holidayInput.value, '节假日输入')
    assertTimeText(workdayInput.value, '补班日输入')
    const result = await addWorkdays({
      startDate: workdayStart.value,
      amount: workdayAmount.value,
      holidays: splitDates(holidayInput.value),
      workdays: splitDates(workdayInput.value),
    })
    if (workday !== workdayGeneration) return
    workdayResult.value = result
  } catch (error) {
    if (workday !== workdayGeneration) return
    showError(error)
  }
}

function runCron() {
  clearError()
  cronResult.value = null
  try {
    cronResult.value = previewCron({
      dialect: cronDialect.value,
      expression: cronExpression.value,
      timeZone: timeZone.value,
      baseTime: cronBase.value,
    })
  } catch (error) {
    showError(error)
  }
}

function changeCronDialect() {
  cronExpression.value = cronDialect.value === 'unix' ? '0 9 * * 1-5' : '0 0 9 * * MON-FRI'
  cronResult.value = null
}

async function runNatural(resolution?: LocalTimeResolution) {
  clearError()
  naturalResolution.value = null
  naturalResult.value = null
  const generation = zoneGeneration
  const natural = ++naturalGeneration
  try {
    const result = await parseNaturalLanguage({
      expression: naturalInput.value,
      timeZone: timeZone.value,
      resolution,
    })
    if (generation !== zoneGeneration || natural !== naturalGeneration) return
    if (result.status === 'resolution_required') naturalResolution.value = result
    else naturalResult.value = result
  } catch (error) {
    if (generation !== zoneGeneration || natural !== naturalGeneration) return
    showError(error)
  }
}
</script>

<template>
  <section class="tool-page" aria-labelledby="time-tool-title">
    <header class="tool-header">
      <div>
        <p class="tool-breadcrumb">工具箱 / 开发辅助</p>
        <div class="title-line">
          <h1 id="time-tool-title">时间与 Cron</h1>
          <ProcessingBadge />
        </div>
        <p>转换时间、计算日期和工作日，并预览 Cron；不会创建、保存或执行定时任务。</p>
      </div>
      <div class="clock-card">
        <span>当前基准 · {{ timeZone }}</span>
        <strong>{{ currentTimeLabel }}</strong>
        <button v-if="nowSnapshot" type="button" @click="copyText(nowSnapshot.zoned)">复制当前时间</button>
      </div>
    </header>

    <div class="zone-row">
      <label for="time-zone">IANA 时区</label>
      <TimeZoneCombobox id="time-zone" v-model="timeZone" :options="timeZones" label="IANA 时区" @commit="handleTimeZoneCommit" />
      <span>所有结果均显示此时区、基准时间和 UTC offset。</span>
    </div>
    <p v-if="zoneStaleMessage" class="warning-note zone-stale-note" role="status">{{ zoneStaleMessage }}</p>

    <nav class="tool-tabs" aria-label="时间工具功能">
      <button v-for="tab in tabs" :key="tab.id" type="button" :class="{ active: activeTab === tab.id }" :aria-current="activeTab === tab.id ? 'page' : undefined" @click="activeTab = tab.id; clearError()">{{ tab.label }}</button>
    </nav>

    <p v-if="errorMessage" class="error-summary" role="alert">{{ errorMessage }}</p>
    <p class="sr-only" aria-live="polite">{{ copyStatus }}</p>

    <div v-if="activeTab === 'convert'" class="workspace-grid">
      <section class="tool-card" aria-labelledby="convert-input-title">
        <h2 id="convert-input-title">转换输入</h2>
        <label for="conversion-kind">输入类型</label>
        <select id="conversion-kind" v-model="conversionKind">
          <option value="unix_seconds">Unix 秒</option><option value="unix_milliseconds">Unix 毫秒</option><option value="iso">ISO 8601（含 offset）</option><option value="local">所选时区的本地时间</option>
        </select>
        <label for="conversion-input">时间值</label>
        <input id="conversion-input" v-model="conversionInput" autocomplete="off">
        <p class="hint">本地时间使用 YYYY-MM-DDTHH:mm:ss；输入上限 16 KiB。</p>
        <UiButton variant="primary" @click="runConversion()">转换时间</UiButton>
        <div v-if="conversionResolution" class="resolution-box" role="alert">
          <strong>{{ conversionResolution.message }}</strong>
          <code>{{ conversionResolution.earlier }}</code><code>{{ conversionResolution.later }}</code>
          <div><UiButton @click="runConversion('earlier')">选择较早 / 向后</UiButton><UiButton @click="runConversion('later')">选择较晚 / 向前</UiButton></div>
        </div>
      </section>
      <TimeResultCard :value="conversionResult" @copy="copyText" />
    </div>

    <div v-else-if="activeTab === 'calculate'" class="stack">
      <section class="tool-card">
        <h2>日期加减</h2>
        <div class="form-grid">
          <div class="form-field"><span>起始本地时间</span><LocalDateTimeField id="calculation-start" v-model="calculationStart" label="起始本地时间" /></div>
          <label>操作<select v-model="calculationDirection"><option :value="1">加</option><option :value="-1">减</option></select></label>
          <label v-for="(_, key) in calculationValues" :key="key">{{ ({ years: '年', months: '月', days: '日', hours: '时', minutes: '分', seconds: '秒' } as Record<string, string>)[key] }}<input v-model.number="calculationValues[key]" type="number" min="0" step="1"></label>
        </div>
        <UiButton variant="primary" @click="runCalculation()">计算日期</UiButton>
        <div v-if="calculationResolution" class="resolution-box" role="alert"><strong>{{ calculationResolution.message }}</strong><code>{{ calculationResolution.earlier }}</code><code>{{ calculationResolution.later }}</code><div><UiButton @click="runCalculation('earlier')">选择较早 / 向后</UiButton><UiButton @click="runCalculation('later')">选择较晚 / 向前</UiButton></div></div>
        <TimeResultCard v-if="calculationResult" :value="calculationResult" @copy="copyText" />
      </section>
      <section class="tool-card">
        <h2>两个时间的差</h2>
        <div class="form-grid two"><div class="form-field"><span>起始本地时间</span><LocalDateTimeField id="difference-from" v-model="differenceFrom" label="起始本地时间" /></div><div class="form-field"><span>结束本地时间</span><LocalDateTimeField id="difference-to" v-model="differenceTo" label="结束本地时间" /></div></div>
        <UiButton variant="primary" @click="runDifference()">计算时间差</UiButton>
        <div v-if="differenceResolution" class="resolution-box" role="alert"><strong>{{ differenceResolution.value.message }}</strong><code>{{ differenceResolution.value.earlier }}</code><code>{{ differenceResolution.value.later }}</code><div><UiButton @click="runDifference(differenceResolution?.side, 'earlier')">选择较早 / 向后</UiButton><UiButton @click="runDifference(differenceResolution?.side, 'later')">选择较晚 / 向前</UiButton></div></div>
        <dl v-if="differenceResult" class="result-list"><div><dt>日历差值</dt><dd>{{ differenceResult.duration }}</dd></div><div><dt>实际秒数</dt><dd>{{ differenceResult.totalSeconds }}</dd></div><div><dt>时区</dt><dd>{{ timeZone }}</dd></div></dl>
      </section>
    </div>

    <div v-else-if="activeTab === 'workday'" class="workspace-grid">
      <section class="tool-card">
        <h2>工作日计算</h2>
        <label>起始日期<input v-model="workdayStart" type="date"></label>
        <label for="workday-amount">增加 / 减少工作日<input id="workday-amount" v-model.number="workdayAmount" type="number" :min="-WORKDAY_AMOUNT_LIMIT" :max="WORKDAY_AMOUNT_LIMIT" step="1"></label>
        <p class="hint">允许范围 -{{ WORKDAY_AMOUNT_LIMIT }}..{{ WORKDAY_AMOUNT_LIMIT }}；0 表示保持起始日期。</p>
        <label for="holiday-input">节假日（日期以空格、逗号或换行分隔）<textarea id="holiday-input" v-model="holidayInput" rows="4" placeholder="2026-10-01 2026-10-02" /></label>
        <label for="workday-input">补班日<textarea id="workday-input" v-model="workdayInput" rows="3" placeholder="2026-10-10" /></label>
        <p class="hint">默认周一至周五；不内置也不联网更新法定节假日。补班日优先于周末和节假日。</p>
        <UiButton variant="primary" @click="runWorkday">计算工作日</UiButton>
      </section>
      <section class="tool-card result-card">
        <h2>结果</h2>
        <div v-if="workdayResult" class="large-result"><strong>{{ workdayResult.date }}</strong><span>跨越 {{ Math.abs(workdayResult.traversedDays) }} 个自然日</span><small>命中节假日 {{ workdayResult.holidaysUsed.length }} 个 · 补班日 {{ workdayResult.workdaysUsed.length }} 个</small><UiButton @click="copyText(workdayResult.date)">复制日期</UiButton></div>
        <p v-else class="empty-result">计算后在此显示。</p>
      </section>
    </div>

    <div v-else-if="activeTab === 'cron'" class="stack">
      <section class="tool-card cron-input-card">
        <h2>Cron 预览</h2>
        <fieldset class="segmented"><legend>方言</legend><label><input v-model="cronDialect" type="radio" value="unix" @change="changeCronDialect"><span>Unix/Linux（5 段）</span></label><label><input v-model="cronDialect" type="radio" value="spring_quartz" @change="changeCronDialect"><span>Spring/Quartz（6–7 段）</span></label></fieldset>
        <label for="cron-expression">Cron 表达式</label><input id="cron-expression" v-model="cronExpression" class="mono-input" autocomplete="off">
        <div class="cron-meta"><label>基准时间<input v-model="cronBase" type="text"></label><span>时区<br><strong>{{ timeZone }}</strong></span><UiButton variant="primary" @click="runCron">解析并预览</UiButton></div>
        <p class="warning-note">只解释字段并计算未来 5 次，不保存、不执行。严格 Quartz 的 <code>?</code> 语义和日/星期同时具体指定会被拒绝。</p>
      </section>
      <div v-if="cronResult" class="workspace-grid">
        <section class="tool-card"><h2>字段解释</h2><table><thead><tr><th>位置</th><th>字段</th><th>表达式</th><th>解释</th></tr></thead><tbody><tr v-for="field in cronResult.fields" :key="field.position"><td>{{ field.position }}</td><td>{{ field.name }}</td><td><code>{{ field.value }}</code></td><td>{{ field.meaning }}</td></tr></tbody></table></section>
        <section class="tool-card"><h2>未来执行时间</h2><p class="hint">{{ cronResult.dialectLabel }} · {{ cronResult.timeZone }} · 基准 {{ cronResult.baseTime }}</p><ol class="run-list"><li v-for="run in cronResult.nextRuns" :key="run.iso"><strong>{{ run.zoned }}</strong><code>{{ run.iso }}</code></li></ol></section>
      </div>
    </div>

    <div v-else class="workspace-grid">
      <section class="tool-card">
        <h2>确定性自然语言</h2>
        <label for="natural-expression">表达式</label><input id="natural-expression" v-model="naturalInput" autocomplete="off">
        <p class="hint">支持今天/明天/后天、N 天/小时/分钟后、下周一至周日、上午/下午/晚上，以及 today/tomorrow/in N days/next Monday 等英文形式。</p>
        <UiButton variant="primary" @click="runNatural()">解析表达式</UiButton>
        <div v-if="naturalResolution" class="resolution-box" role="alert"><strong>{{ naturalResolution.message }}</strong><code>{{ naturalResolution.earlier }}</code><code>{{ naturalResolution.later }}</code><div><UiButton @click="runNatural('earlier')">选择较早 / 向后</UiButton><UiButton @click="runNatural('later')">选择较晚 / 向前</UiButton></div></div>
      </section>
      <section class="tool-card result-card"><h2>解析结果</h2><template v-if="naturalResult?.status === 'resolved'"><p class="baseline">基准：{{ naturalResult.base.zoned }}</p><div class="large-result"><strong>{{ naturalResult.value.zoned }}</strong><span>UTC offset {{ naturalResult.value.offset }}</span><small>规范表达：{{ naturalResult.normalized }}</small><UiButton @click="copyText(naturalResult.value.zoned)">复制结果</UiButton></div></template><p v-else class="empty-result">解析后在此显示；未支持或歧义表达式不会调用 AI 猜测。</p></section>
    </div>
  </section>
</template>

<style scoped>
.tool-page { width: min(100%, 1280px); min-width: 0; max-width: 100%; padding: var(--space-6); }
.tool-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-6); }
.tool-breadcrumb { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: 12px; }
.title-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
h1, h2, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: 26px; }
h2 { margin-bottom: var(--space-4); font-size: 16px; }
.tool-header > div:first-child > p:last-child { margin: var(--space-2) 0 0; color: var(--text-secondary); }
.clock-card { display: grid; min-width: 320px; gap: 3px; padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-code); }
.clock-card span, .clock-card button { color: var(--text-muted); font-size: 11px; }
.clock-card strong { font-family: var(--font-mono); font-size: 12px; }
.clock-card button, .result-list button { width: max-content; padding: 0; border: 0; background: transparent; color: var(--accent); cursor: pointer; }
.zone-row { display: grid; grid-template-columns: max-content minmax(220px, 360px) 1fr; align-items: center; gap: var(--space-3); margin-top: var(--space-5); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-surface); }
.zone-row label, label { color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.zone-row span { color: var(--text-muted); font-size: 12px; }
.form-field { display: grid; min-width: 0; align-content: end; color: var(--text-secondary); font-size: 12px; font-weight: 600; }
input, select, textarea { width: 100%; min-width: 0; max-width: 100%; min-height: 40px; margin-top: var(--space-1); padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
textarea { resize: vertical; }
.tool-tabs { display: flex; gap: var(--space-1); margin-top: var(--space-5); border-bottom: 1px solid var(--border-subtle); overflow-x: auto; }
.tool-tabs button { min-height: 44px; padding: 0 var(--space-4); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-secondary); cursor: pointer; white-space: nowrap; }
.tool-tabs button.active { border-bottom-color: var(--accent); color: var(--text-primary); font-weight: 700; }
.workspace-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); margin-top: var(--space-4); }
.stack { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); margin-top: var(--space-4); }
.tool-card { min-width: 0; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-surface); }
.tool-card > label { display: block; margin-top: var(--space-3); }
.tool-card > .button { margin-top: var(--space-4); }
.hint, .baseline { margin: var(--space-2) 0; color: var(--text-muted); font-size: 12px; }
.error-summary { margin: var(--space-4) 0 0; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--danger) 55%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--danger); }
.resolution-box { display: grid; gap: var(--space-2); margin-top: var(--space-4); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--warning) 55%, var(--border-subtle)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--warning) 7%, var(--bg-code)); }
.resolution-box code { overflow-wrap: anywhere; color: var(--text-secondary); }
.resolution-box > div { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.result-list { display: grid; gap: var(--space-3); margin: 0; }
.result-list div { padding-bottom: var(--space-2); border-bottom: 1px solid var(--border-subtle); }
.result-list dt { color: var(--text-muted); font-size: 11px; }
.result-list dd { display: flex; justify-content: space-between; gap: var(--space-3); margin: 2px 0 0; overflow-wrap: anywhere; }
.result-list code { color: var(--text-primary); }
.empty-result { color: var(--text-muted); }
.form-grid { display: grid; grid-template-columns: 2fr repeat(7, minmax(74px, 1fr)); gap: var(--space-2); align-items: end; }
.form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.large-result { display: grid; gap: var(--space-2); align-content: start; min-height: 180px; }
.large-result strong { overflow-wrap: anywhere; color: var(--accent); font-family: var(--font-mono); font-size: 20px; }
.large-result span, .large-result small { color: var(--text-secondary); }
.large-result .button { width: max-content; margin-top: var(--space-3); }
.segmented { display: flex; width: max-content; max-width: 100%; gap: 2px; padding: 3px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); }
.segmented legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
.segmented label { cursor: pointer; }
.segmented input { position: absolute; width: 1px; min-width: 1px; max-width: 1px; height: 1px; min-height: 1px; margin: 0; overflow: hidden; padding: 0; opacity: 0; }
.segmented span { display: block; padding: 7px 11px; border-radius: 4px; }
.segmented input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
.segmented input:checked + span { background: var(--accent-soft); color: var(--text-primary); }
.mono-input, code { font-family: var(--font-mono); }
.cron-meta { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(180px, 1fr) max-content; align-items: end; gap: var(--space-3); margin-top: var(--space-3); }
.cron-meta > * { min-width: 0; }
.cron-meta span { min-height: 40px; color: var(--text-muted); font-size: 11px; }
.cron-meta strong { color: var(--text-primary); font-family: var(--font-mono); }
.warning-note { margin: var(--space-3) 0 0; padding: var(--space-2); border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border-subtle)); color: var(--warning); font-size: 12px; }
.zone-stale-note { margin: var(--space-2) 0 0; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 9px 8px; border-bottom: 1px solid var(--border-subtle); text-align: left; }
th { color: var(--text-muted); font-weight: 600; }
.run-list { display: grid; gap: var(--space-3); padding-left: 24px; }
.run-list li { padding-bottom: var(--space-2); border-bottom: 1px solid var(--border-subtle); }
.run-list strong, .run-list code { display: block; }
.run-list code { margin-top: 2px; color: var(--text-muted); font-size: 11px; }
@media (max-width: 1024px) { .form-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 720px) {
  .tool-page { padding: var(--space-4); }
  .tool-header { flex-direction: column; }
  .clock-card { min-width: 0; width: 100%; }
  .zone-row { grid-template-columns: 1fr; }
  .workspace-grid, .form-grid, .form-grid.two, .cron-meta { grid-template-columns: 1fr; }
  .tool-tabs button { padding: 0 var(--space-3); }
  .result-list dd { align-items: flex-start; flex-direction: column; }
  table { display: block; overflow-x: auto; }
}
</style>

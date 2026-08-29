<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
import SettingsSubnav from '../settings/SettingsSubnav.vue'
import {
  type AISettings,
  type AISchedule,
  type ProviderEntry,
  type SensitivePolicy,
  availableModels,
  policiesWithin,
} from './contracts'

const auth = useAuthStore()
const providers = ref<ProviderEntry[]>([])
const settings = ref<AISettings | null>(null)
const frequency = ref<AISchedule['frequency']>('off')
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai')
const localTime = ref('02:00')
const weekday = ref(1)
const organizeModelID = ref('')
const visionModelID = ref('')
const policy = ref<SensitivePolicy>('block')
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const saved = ref(false)

const modelOptions = computed(() => availableModels(providers.value))
const visionOptions = computed(() => availableModels(providers.value, true))
const allowedPolicies = computed(() => policiesWithin(settings.value?.sensitiveAiPolicy ?? 'block'))

onMounted(() => void loadState())

async function loadState() {
  loading.value = true
  errorMessage.value = ''
  saved.value = false
  try {
    const [scheduleResponse, providerResponse, settingsResponse] = await Promise.all([
      apiRequest<AISchedule>('/api/v1/ai/schedule'),
      apiRequest<{ items: ProviderEntry[] }>('/api/v1/ai/providers'),
      apiRequest<AISettings>('/api/v1/ai/settings'),
    ])
    providers.value = providerResponse.items
    settings.value = settingsResponse
    frequency.value = scheduleResponse.frequency
    timezone.value = scheduleResponse.timezone
    localTime.value = scheduleResponse.localTime
    weekday.value = scheduleResponse.weekday
    organizeModelID.value = scheduleResponse.organizeModelId ?? ''
    visionModelID.value = scheduleResponse.visionModelId ?? ''
    policy.value = scheduleResponse.sensitivePolicy
  } catch (error) {
    errorMessage.value = messageFor(error)
  } finally {
    loading.value = false
  }
}

async function saveSchedule() {
  if (frequency.value !== 'off' && !organizeModelID.value) return
  busy.value = true
  errorMessage.value = ''
  saved.value = false
  try {
    const response = await apiRequest<AISchedule>(
      '/api/v1/ai/schedule',
      jsonRequest(
        'PUT',
        {
          frequency: frequency.value,
          timezone: timezone.value,
          localTime: localTime.value,
          weekday: weekday.value,
          organizeModelId: organizeModelID.value,
          visionModelId: visionModelID.value,
          sensitivePolicy: policy.value,
        },
        auth.csrfToken,
      ),
    )
    frequency.value = response.frequency
    timezone.value = response.timezone
    localTime.value = response.localTime
    weekday.value = response.weekday
    organizeModelID.value = response.organizeModelId ?? ''
    visionModelID.value = response.visionModelId ?? ''
    policy.value = response.sensitivePolicy
    saved.value = true
  } catch (error) {
    errorMessage.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : '请求未成功，请稍后重试'
}
</script>

<template>
  <section class="settings-page" aria-labelledby="schedule-title">
    <SettingsSubnav />
    <header class="settings-page__header">
      <div><p class="settings-kicker">SETTINGS · SCHEDULED AI</p><h2 id="schedule-title">批量与自动整理</h2><p>按当前输入集合识别待处理条目，生成新的候选版本；不会替你删除或判废旧版本。</p></div>
      <UiButton variant="primary" :disabled="loading || busy || (frequency !== 'off' && !organizeModelID)" @click="saveSchedule"><UiIcon name="save" />{{ busy ? '正在保存…' : '保存设置' }}</UiButton>
    </header>

    <div v-if="errorMessage" class="settings-notice settings-notice--danger" role="alert"><UiIcon name="triangle-alert" /><span>{{ errorMessage }}</span><button type="button" @click="loadState">重新读取</button></div>
    <div v-if="saved" class="settings-notice schedule-saved" role="status"><UiIcon name="check" />自动整理设置已保存。</div>
    <div v-if="loading" class="settings-loading"><span class="settings-spinner" />正在读取调度设置…</div>

    <template v-else>
      <section class="settings-card" aria-labelledby="frequency-title">
        <header class="settings-card__header"><div><p class="settings-kicker">FREQUENCY</p><h3 id="frequency-title">运行频率</h3><p>一期默认关闭。每日或每周只在配置时区的时间窗建立一次批次。</p></div><span class="settings-status" :class="frequency === 'off' ? '' : 'settings-status--success'">{{ frequency === 'off' ? '已关闭' : frequency === 'daily' ? '每日' : '每周' }}</span></header>
        <div class="settings-card__body frequency-grid">
          <label v-for="choice in ([{ value: 'off', label: '关闭', detail: '不自动创建任务' }, { value: 'daily', label: '每日', detail: '每天一个时间窗' }, { value: 'weekly', label: '每周', detail: '指定星期与时间' }] as const)" :key="choice.value" :class="{ selected: frequency === choice.value }"><input v-model="frequency" type="radio" :value="choice.value" /><span><strong>{{ choice.label }}</strong><small>{{ choice.detail }}</small></span></label>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="window-title">
        <header class="settings-card__header"><div><p class="settings-kicker">RUN WINDOW</p><h3 id="window-title">时间窗与模型</h3><p>每个定期批次最多选择 20 条；应用重启不会重复同一时间窗。</p></div></header>
        <div class="settings-card__body schedule-form">
          <label><span>IANA 时区</span><input v-model.trim="timezone" list="timezone-suggestions" maxlength="120" required /><small>使用如 Asia/Shanghai、UTC、America/Los_Angeles 的 IANA 名称。</small></label>
          <datalist id="timezone-suggestions"><option value="Asia/Shanghai" /><option value="UTC" /><option value="Asia/Tokyo" /><option value="Europe/London" /><option value="America/Los_Angeles" /></datalist>
          <label><span>本地时间</span><input v-model="localTime" type="time" required /></label>
          <label v-if="frequency === 'weekly'"><span>星期</span><select v-model.number="weekday"><option :value="1">星期一</option><option :value="2">星期二</option><option :value="3">星期三</option><option :value="4">星期四</option><option :value="5">星期五</option><option :value="6">星期六</option><option :value="7">星期日</option></select></label>
          <label><span>正文整理模型</span><select v-model="organizeModelID"><option value="">未配置</option><option v-for="model in modelOptions" :key="model.id" :value="model.id">{{ model.label }}</option></select><small v-if="frequency !== 'off' && !organizeModelID" class="field-error">启用自动整理前必须选择正文模型。</small></label>
          <label><span>视觉模型（可选）</span><select v-model="visionModelID"><option value="">未配置，图片分支跳过</option><option v-for="model in visionOptions" :key="model.id" :value="model.id">{{ model.label }}</option></select><small>纯图片或混合条目的图片分支只使用具备视觉能力的模型。</small></label>
          <label><span>敏感策略</span><select v-model="policy"><option v-for="entry in allowedPolicies" :key="entry" :value="entry">{{ entry === 'block' ? '阻止外发' : entry === 'redact' ? '遮挡后外发' : '允许原文外发' }}</option></select><small>不能比实例的 AI 敏感策略更宽松。</small></label>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="schedule-boundary-title">
        <header class="settings-card__header"><div><p class="settings-kicker">SELECTION RULE</p><h3 id="schedule-boundary-title">处理边界</h3><p>服务端按 Artifact 输入快照判断，不以页面打开状态为依据。</p></div></header>
        <div class="settings-card__body boundary-list">
          <article><UiIcon name="check" /><div><strong>只处理未被当前版本覆盖的正文或 ready 图片</strong><p>过期版本仍可查看并继续参与搜索，直到你主动切换或作废。</p></div></article>
          <article><UiIcon name="shield-alert" /><div><strong>敏感策略在创建子任务前执行</strong><p>阻止或无法遮挡的分支零外部请求，并在批次中显示稳定跳过原因。</p></div></article>
          <article><UiIcon name="boxes" /><div><strong>正文与图片分支相互独立</strong><p>没有视觉模型不会阻塞正文整理；纯文件条目不会误发给模型。</p></div></article>
          <article><UiIcon name="clock" /><div><strong>同一时间窗只创建一次</strong><p>Worker 或 Provider 离线时，录入、搜索、浏览和下载仍可使用。</p></div></article>
        </div>
        <footer class="schedule-footer"><RouterLink to="/ai/tasks"><UiIcon name="sparkles" />查看任务中心与手动批量整理</RouterLink></footer>
      </section>
    </template>
  </section>
</template>

<style scoped>
.schedule-saved { color: var(--success); }
.frequency-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }
.frequency-grid > label { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); cursor: pointer; }
.frequency-grid > label.selected { border-color: var(--accent); background: var(--accent-soft); }
.frequency-grid span { display: grid; }
.frequency-grid small { color: var(--text-muted); }
.frequency-grid > label.selected small { color: var(--text-secondary); }
.schedule-form { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
.schedule-form label { display: grid; align-content: start; gap: var(--space-1); color: var(--text-secondary); font-size: 11px; font-weight: 700; }
.schedule-form input, .schedule-form select { width: 100%; min-height: 40px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-primary); }
.schedule-form small { color: var(--text-muted); font-weight: 400; }
.schedule-form .field-error { color: var(--danger); }
.boundary-list { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.boundary-list article { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-control); background: var(--bg-code); }
.boundary-list article > svg { color: var(--accent); }
.boundary-list p { margin: var(--space-1) 0 0; color: var(--text-muted); }
.schedule-footer { padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-subtle); }
.schedule-footer a { display: inline-flex; align-items: center; gap: var(--space-2); text-decoration: none; }
@media (max-width: 720px) { .settings-page { padding: var(--space-4); } .frequency-grid, .schedule-form, .boundary-list { grid-template-columns: 1fr; } }
</style>

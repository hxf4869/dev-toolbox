<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useAuthStore } from '../../app/auth'
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest, jsonRequest } from '../../lib/api'
import {
  ALIYUN_FAILURE_CATEGORY_LABELS,
  ALIYUN_METER_LABELS,
  ALIYUN_RAM_POLICY_JSON,
  ALIYUN_SCENES,
  aliyunSaveErrorMessage,
  concurrencyIssueFor,
  validateAliyunSettingsForm,
  type AliyunCredentialsState,
  type AliyunSettings,
  type AliyunSettingsPutBody,
  type AliyunStatusState,
  type AliyunUsage,
  type AliyunUsageMeterName,
} from './aliyunContracts'
import SettingsPageShell from './SettingsPageShell.vue'

const auth = useAuthStore()

const loading = ref(true)
const busy = ref(false)
const pageError = ref('')
const usageError = ref('')
const formError = ref('')
const savedNotice = ref(false)

const usage = ref<AliyunUsage | null>(null)
const credentialsState = ref<AliyunCredentialsState>({
  configured: false,
  accessKeyIdMasked: null,
  credentialVersion: 0,
})
const statusState = ref<AliyunStatusState>({
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureCategory: null,
})

// 凭据输入只存在于当前页面内存；Secret 永不回显，也不写入任何浏览器存储。
const accessKeyId = ref('')
const accessKeySecret = ref('')
const generalMonthlyLimit = ref('')
const professionalMonthlyLimit = ref('')
const autoUseProfessional = ref(true)
const professionalScene = ref('')
const ocrMonthlyLimit = ref('')
const ownerConcurrency = ref('')
const globalConcurrency = ref('')

const deleteConfirmOpen = ref(false)
const dialogRoot = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)
const policyCopied = ref(false)
const policyCopyError = ref('')
let policyFeedbackTimer: number | undefined

const credentialsConfigured = computed(() => credentialsState.value.configured)
const concurrencyIssue = computed(() =>
  concurrencyIssueFor(ownerConcurrency.value, globalConcurrency.value),
)
const failureCategoryLabel = computed(() => {
  const category = statusState.value.lastFailureCategory
  if (!category) return '尚未有失败记录'
  return ALIYUN_FAILURE_CATEGORY_LABELS[category] ?? category
})

watch(deleteConfirmOpen, async (open, wasOpen) => {
  if (open && !wasOpen) previousFocus.value = document.activeElement as HTMLElement | null
  if (open) {
    await nextTick()
    // 危险动作默认焦点不放在确认按钮：第一个可聚焦项是“取消”。
    dialogRoot.value?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  } else if (wasOpen) {
    await nextTick()
    previousFocus.value?.focus()
    previousFocus.value = null
  }
})

onMounted(() => void loadState())
onBeforeUnmount(() => window.clearTimeout(policyFeedbackTimer))

async function loadState() {
  loading.value = true
  pageError.value = ''
  void loadUsage()
  try {
    applySettings(await apiRequest<AliyunSettings>('/api/v1/aliyun/settings'))
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '请求未成功，请稍后重试'
  } finally {
    loading.value = false
  }
}

async function loadUsage() {
  usageError.value = ''
  try {
    usage.value = await apiRequest<AliyunUsage>('/api/v1/aliyun/usage/current')
  } catch (error) {
    usage.value = null
    usageError.value =
      error instanceof Error ? `${error.message} 请重试；表单仍可编辑。` : '读取本地保护账本失败，请重试。'
  }
}

function applySettings(response: AliyunSettings) {
  credentialsState.value = response.credentials
  statusState.value = response.status
  generalMonthlyLimit.value = String(response.translation.generalMonthlyLimit)
  professionalMonthlyLimit.value = String(response.translation.professionalMonthlyLimit)
  autoUseProfessional.value = response.translation.autoUseProfessional
  professionalScene.value = response.translation.professionalScene ?? ''
  ocrMonthlyLimit.value = String(response.ocr.monthlyLimit)
  ownerConcurrency.value = String(response.concurrency.owner)
  globalConcurrency.value = String(response.concurrency.global)
}

function buildPutBody(): AliyunSettingsPutBody {
  const scene = ALIYUN_SCENES.find((entry) => entry.code === professionalScene.value)
  const body: AliyunSettingsPutBody = {
    translation: {
      generalMonthlyLimit: Number(generalMonthlyLimit.value),
      professionalMonthlyLimit: Number(professionalMonthlyLimit.value),
      autoUseProfessional: autoUseProfessional.value,
      professionalScene: scene ? scene.code : null,
    },
    ocr: { monthlyLimit: Number(ocrMonthlyLimit.value) },
    concurrency: {
      owner: Number(ownerConcurrency.value),
      global: Number(globalConcurrency.value),
    },
  }
  if (accessKeyId.value.trim() && accessKeySecret.value) {
    body.credentials = {
      accessKeyId: accessKeyId.value.trim(),
      accessKeySecret: accessKeySecret.value,
    }
  }
  return body
}

async function saveSettings() {
  formError.value = ''
  savedNotice.value = false
  const errors = validateAliyunSettingsForm(
    {
      credentialsConfigured: credentialsConfigured.value,
      accessKeyId: accessKeyId.value,
      accessKeySecret: accessKeySecret.value,
      generalMonthlyLimit: generalMonthlyLimit.value,
      professionalMonthlyLimit: professionalMonthlyLimit.value,
      autoUseProfessional: autoUseProfessional.value,
      professionalScene: professionalScene.value,
      ocrMonthlyLimit: ocrMonthlyLimit.value,
      ownerConcurrency: ownerConcurrency.value,
      globalConcurrency: globalConcurrency.value,
    },
    usage.value,
  )
  if (errors.length > 0) {
    formError.value = errors[0]!
    return
  }
  busy.value = true
  try {
    // 全量替换合同：PUT 前先 GET 同步服务端最新状态，再提交完整当前值。
    const latest = await apiRequest<AliyunSettings>('/api/v1/aliyun/settings')
    credentialsState.value = latest.credentials
    statusState.value = latest.status
    await apiRequest<unknown>(
      '/api/v1/aliyun/settings',
      jsonRequest('PUT', buildPutBody(), auth.csrfToken),
    )
    accessKeyId.value = ''
    accessKeySecret.value = ''
    savedNotice.value = true
    await loadState()
  } catch (error) {
    formError.value = aliyunSaveErrorMessage(error)
  } finally {
    busy.value = false
  }
}

function openDeleteConfirm() {
  formError.value = ''
  deleteConfirmOpen.value = true
}

async function confirmDeleteCredentials() {
  busy.value = true
  try {
    await apiRequest<void>('/api/v1/aliyun/settings/credentials', {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': auth.csrfToken },
    })
    deleteConfirmOpen.value = false
    await loadState()
  } catch (error) {
    deleteConfirmOpen.value = false
    formError.value = aliyunSaveErrorMessage(error)
  } finally {
    busy.value = false
  }
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !busy.value) {
    event.preventDefault()
    deleteConfirmOpen.value = false
    return
  }
  if (event.key !== 'Tab') return
  const root = event.currentTarget as HTMLElement
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
  ).filter((element) => element.offsetParent !== null)
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function copyPolicy() {
  policyCopyError.value = ''
  try {
    await navigator.clipboard.writeText(ALIYUN_RAM_POLICY_JSON)
    policyCopied.value = true
    window.clearTimeout(policyFeedbackTimer)
    policyFeedbackTimer = window.setTimeout(() => {
      policyCopied.value = false
    }, 1600)
  } catch {
    policyCopyError.value = '浏览器未允许写入剪贴板：请手动选择并复制下方策略 JSON。'
  }
}

function meterLabel(meter: AliyunUsageMeterName) {
  return ALIYUN_METER_LABELS[meter] ?? meter
}

function meterUsage(meter: AliyunUsageMeterName) {
  return usage.value?.meters.find((entry) => entry.meter === meter) ?? null
}

function meterUsageHint(meter: AliyunUsageMeterName) {
  const entry = meterUsage(meter)
  if (!entry) return '当前月账本尚未读取。'
  return `当前月已用 ${formatNumber(entry.used)}、预留 ${formatNumber(entry.reserved)}；新上限不能低于两者之和。`
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatStatusTime(value: string | null) {
  if (!value) return '尚未发生'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
}
</script>

<template>
  <SettingsPageShell
    title-id="aliyun-settings-title"
    title="阿里云服务"
    description="配置云翻译、文字识别和每月使用上限；保存设置不会发起云调用。"
    :show-aside="!loading"
  >
    <template #actions>
      <UiButton variant="primary" :disabled="loading || busy" @click="saveSettings">
        <UiIcon name="save" />{{ busy ? '正在保存…' : '保存设置' }}
      </UiButton>
    </template>

    <template #notices>
      <div class="settings-notice settings-notice--info" role="note">
        <UiIcon name="info" />
        <span>
          本地账本只统计本应用发起的调用；阿里云免费额度按主账号与 RAM 子账号共享，专用 RAM
          凭据只缩小权限、不能隔离同账号其他应用的用量。如该云账号还有其他调用方，请到阿里云控制台
          <a
            class="aliyun-console-link"
            href="https://expense.console.aliyun.com/"
            target="_blank"
            rel="noopener noreferrer"
            >费用与成本中心人工对账</a
          >，并相应调低本应用上限。本页显示的剩余额度是“本地保护账本剩余”，不是阿里云官方剩余。
        </span>
      </div>

      <div v-if="pageError" class="settings-notice settings-notice--danger" role="alert">
        <UiIcon name="triangle-alert" /><span>{{ pageError }}</span>
        <button type="button" @click="loadState">重试</button>
      </div>
      <div v-if="savedNotice" class="settings-notice aliyun-saved" role="status">
        <UiIcon name="check" />设置已保存。保存不调用阿里云，尚未通过真实调用验证。
      </div>
      <div v-if="formError" class="settings-notice settings-notice--danger" role="alert">
        <UiIcon name="triangle-alert" /><span>{{ formError }}</span>
      </div>
    </template>

    <div v-if="loading" class="settings-loading" aria-live="polite">
      <span class="settings-spinner" aria-hidden="true" />正在读取阿里云服务设置…
    </div>

    <template v-else>
      <section class="settings-card" aria-labelledby="aliyun-credentials-title">
        <header class="settings-card__header">
          <div>
            <h3 id="aliyun-credentials-title">凭据</h3>
            <p>使用专用 RAM 凭据，不复用主账号 AccessKey。</p>
          </div>
          <span
            class="settings-status"
            :class="credentialsConfigured ? 'settings-status--success' : 'settings-status--warning'"
          >
            {{ credentialsConfigured ? '已配置' : '未配置' }}
          </span>
        </header>
        <div class="settings-card__body settings-form">
          <p v-if="credentialsConfigured" class="credential-summary">
            AccessKey ID <code>{{ credentialsState.accessKeyIdMasked }}</code> · 凭据版本
            v{{ credentialsState.credentialVersion }} · Secret 加密保存在服务端，永不回显。
          </p>
          <p v-else class="credential-summary">
            尚未配置凭据：云翻译与云 OCR 会返回“未配置”而停止，本地工具不受影响。首次保存必须同时填写以下两项。
          </p>
          <div class="settings-field-row">
            <label class="settings-field">
              <span>{{ credentialsConfigured ? '替换 AccessKey ID（与 Secret 同时填写）' : 'AccessKey ID' }}</span>
              <input
                v-model="accessKeyId"
                autocomplete="off"
                spellcheck="false"
                maxlength="256"
                :aria-required="!credentialsConfigured"
              />
              <small>两项都留空表示保留现有凭据。</small>
            </label>
            <label class="settings-field">
              <span>{{
                credentialsConfigured ? '替换 AccessKey Secret（与 ID 同时填写）' : 'AccessKey Secret'
              }}</span>
              <input
                v-model="accessKeySecret"
                type="password"
                autocomplete="new-password"
                maxlength="512"
                :aria-required="!credentialsConfigured"
              />
              <small>只在保存时提交一次，不回显、不写入浏览器存储或日志。</small>
            </label>
          </div>

          <dl class="endpoint-list">
            <div><dt>机器翻译</dt><dd><code>mt.cn-hangzhou.aliyuncs.com</code></dd></div>
            <div><dt>通用文字识别</dt><dd><code>ocr-api.cn-hangzhou.aliyuncs.com</code></dd></div>
          </dl>

          <details class="policy-block">
            <summary>查看最小 RAM 权限策略</summary>
            <div class="policy-block__content">
              <div class="policy-block__head">
                <strong>仅包含三个当前功能所需 Action</strong>
                <button type="button" class="policy-copy" @click="copyPolicy">
                  <UiIcon name="copy" :size="14" />
                  <span aria-live="polite">{{ policyCopied ? '已复制' : '复制策略 JSON' }}</span>
                </button>
              </div>
              <pre class="policy-json" tabindex="0"><code>{{ ALIYUN_RAM_POLICY_JSON }}</code></pre>
              <p class="policy-note">
                不要授予 AliyunMTFullAccess、AliyunOCRFullAccess 或复用服务器管理员凭据。
                <a
                  class="aliyun-console-link"
                  href="https://ram.console.aliyun.com/users"
                  target="_blank"
                  rel="noopener noreferrer"
                  >前往阿里云 RAM 控制台</a
                >。
              </p>
              <p v-if="policyCopyError" class="policy-copy-error" role="alert">
                <UiIcon name="triangle-alert" :size="14" />{{ policyCopyError }}
              </p>
            </div>
          </details>

          <div class="credential-actions">
            <button
              type="button"
              class="credential-danger-link"
              :disabled="!credentialsConfigured || busy"
              @click="openDeleteConfirm"
            >
              <UiIcon name="trash-2" :size="14" />移除凭据
            </button>
            <small>独立危险动作：删除后云翻译与云 OCR 停止可用，本地工具与本地 OCR 不受影响。</small>
          </div>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="aliyun-translation-title">
        <header class="settings-card__header">
          <div>
            <h3 id="aliyun-translation-title">阿里云机器翻译</h3>
            <p>分别设置通用版和专业版的月度上限。</p>
          </div>
        </header>
        <div class="settings-card__body settings-form">
          <div class="settings-field-row">
            <label class="settings-field">
              <span>通用版月度硬上限（字符）</span>
              <input
                v-model="generalMonthlyLimit"
                type="number"
                min="1"
                max="1000000"
                step="1"
                inputmode="numeric"
              />
              <small>{{ meterUsageHint('mt_general') }}</small>
            </label>
            <label class="settings-field">
              <span>专业版月度硬上限（字符）</span>
              <input
                v-model="professionalMonthlyLimit"
                type="number"
                min="1"
                max="1000000"
                step="1"
                inputmode="numeric"
              />
              <small>{{ meterUsageHint('mt_professional') }}</small>
            </label>
          </div>
          <label class="settings-check">
            <input v-model="autoUseProfessional" type="checkbox" />
            <span
              >通用版额度不足时自动切换专业版（默认开启）。开启后必须在下方明确选择专业场景，系统不会猜测场景。</span
            >
          </label>
          <label v-if="autoUseProfessional" class="settings-field scene-field">
            <span>专业场景（必选）</span>
            <select v-model="professionalScene" name="professional-scene">
              <option value="" disabled>请选择一个官方场景</option>
              <option v-for="scene in ALIYUN_SCENES" :key="scene.code" :value="scene.code">
                {{ scene.label }}（{{ scene.code }}）
              </option>
            </select>
            <small>
              {{ ALIYUN_SCENES.find((scene) => scene.code === professionalScene)?.detail
                ?? '六个场景的专业语言方向有限；系统不会猜测场景。' }}
            </small>
          </label>
          <p v-else class="scene-retained" role="note">
            已关闭自动切换专业版{{ professionalScene ? '；已保存的专业场景会保留' : '' }}，通用版仍可正常使用。
          </p>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="aliyun-ocr-title">
        <header class="settings-card__header">
          <div>
            <h3 id="aliyun-ocr-title">阿里云通用文字识别</h3>
            <p>只有选择云 OCR 时才消耗额度。</p>
          </div>
        </header>
        <div class="settings-card__body settings-form">
          <label class="settings-field aliyun-ocr-limit">
            <span>OCR 月度上限（次）</span>
            <input
              v-model="ocrMonthlyLimit"
              type="number"
              min="1"
              max="200"
              step="1"
              inputmode="numeric"
            />
            <small>{{ meterUsageHint('ocr_general') }}</small>
          </label>
          <p class="ocr-note" role="note">
            达到本应用上限前会停止调用；阿里云服务本身可能自动进入后付费，请按需把上限设得更低。
          </p>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="aliyun-concurrency-title">
        <header class="settings-card__header">
          <div>
            <h3 id="aliyun-concurrency-title">云调用并发</h3>
            <p>设置本实例的云调用并发上限。</p>
          </div>
        </header>
        <div class="settings-card__body settings-form">
          <div class="settings-field-row">
            <label class="settings-field">
              <span>owner 并发（1–3）</span>
              <input
                v-model="ownerConcurrency"
                type="number"
                min="1"
                max="3"
                step="1"
                inputmode="numeric"
                :aria-invalid="Boolean(concurrencyIssue)"
              />
              <small>当前所有者同时占用的云调用上限，默认 1。</small>
            </label>
            <label class="settings-field">
              <span>全局并发（1–10）</span>
              <input
                v-model="globalConcurrency"
                type="number"
                min="1"
                max="10"
                step="1"
                inputmode="numeric"
                :aria-invalid="Boolean(concurrencyIssue)"
              />
              <small>服务端整体并发上限，默认 3；不能小于 owner 并发。</small>
            </label>
          </div>
          <p v-if="concurrencyIssue" class="inline-error" role="alert">
            <UiIcon name="triangle-alert" :size="14" />{{ concurrencyIssue }}
          </p>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="aliyun-usage-title">
        <header class="settings-card__header">
          <div>
            <h3 id="aliyun-usage-title">本月本地保护账本</h3>
            <p v-if="usage">
              月份 {{ usage.month }} · 时区 {{ usage.timezone }} · 来源：本地保护账本（{{ usage.source }}）
            </p>
            <p v-else>尚未读取到本月账本。</p>
          </div>
        </header>
        <div class="settings-card__body">
          <div v-if="usageError" class="settings-notice settings-notice--danger" role="alert">
            <UiIcon name="triangle-alert" /><span>{{ usageError }}</span>
            <button type="button" @click="loadUsage">重试</button>
          </div>
          <div v-if="usage" class="usage-grid">
            <article v-for="meter in usage.meters" :key="meter.meter" class="usage-meter">
              <header>
                <strong>{{ meterLabel(meter.meter) }}</strong>
                <span v-if="meter.meter === 'mt_professional'" class="usage-badge">后备</span>
              </header>
              <p><span>本地保护账本剩余</span><strong class="usage-remaining">{{ formatNumber(meter.remaining) }}</strong></p>
              <p><span>已用 / 预留 / 上限</span><code>{{ formatNumber(meter.used) }} / {{ formatNumber(meter.reserved) }} / {{ formatNumber(meter.limit) }}</code></p>
            </article>
          </div>
          <p class="usage-note">
            以上只统计本应用发起的调用，不是阿里云官方剩余；本页不提供任意月份查询或调用明细。
          </p>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="aliyun-status-title">
        <header class="settings-card__header">
          <div>
            <h3 id="aliyun-status-title">最近云调用状态</h3>
            <p>以下状态只由真实云调用更新；保存设置不会调用阿里云。</p>
          </div>
        </header>
        <div class="settings-card__body">
          <dl class="status-list">
            <div>
              <dt>最近成功调用</dt>
              <dd>{{ formatStatusTime(statusState.lastSuccessAt) }}</dd>
            </div>
            <div>
              <dt>最近失败</dt>
              <dd>{{ formatStatusTime(statusState.lastFailureAt) }}</dd>
            </div>
            <div>
              <dt>最近失败类别</dt>
              <dd>{{ failureCategoryLabel }}</dd>
            </div>
          </dl>
          <p class="status-note">
            保存成功只代表配置已写入：保存不调用阿里云，尚未通过真实调用验证，不会显示“连接测试成功”。
          </p>
        </div>
      </section>
    </template>

    <template #aside>
      <section>
        <h3>云服务摘要</h3>
        <dl class="settings-context__list">
          <div><dt>专用 RAM 凭据</dt><dd>{{ credentialsConfigured ? '已配置' : '未配置' }}</dd></div>
          <div><dt>专业版后备</dt><dd>{{ autoUseProfessional ? '已开启' : '已关闭' }}</dd></div>
          <div><dt>专业场景</dt><dd>{{ ALIYUN_SCENES.find((scene) => scene.code === professionalScene)?.label ?? '未选择' }}</dd></div>
          <div><dt>OCR 月度上限</dt><dd>{{ ocrMonthlyLimit || '未设置' }} 次</dd></div>
          <div><dt>云调用并发</dt><dd>{{ ownerConcurrency || '—' }} / {{ globalConcurrency || '—' }}</dd></div>
          <div><dt>账本月份</dt><dd>{{ usage?.month ?? '未读取' }}</dd></div>
        </dl>
      </section>
      <section
        class="settings-context__notice"
        :class="credentialsConfigured ? 'settings-context__notice--success' : 'settings-context__notice--warning'"
      >
        <UiIcon :name="credentialsConfigured ? 'shield-check' : 'triangle-alert'" />
        <div>
          <strong>{{ credentialsConfigured ? '配置已保存，尚未实调验证' : '云能力当前不可用' }}</strong>
          <p>{{ credentialsConfigured ? `最近失败类别：${failureCategoryLabel}` : '未配置凭据时，云翻译与云 OCR 会在发送前停止；本地工具不受影响。' }}</p>
        </div>
      </section>
      <p class="settings-context__footnote">这里显示的是本应用的本地保护账本，不代表阿里云主账号的官方剩余额度。</p>
    </template>
  </SettingsPageShell>

  <Teleport to="body">
    <div
      v-if="deleteConfirmOpen"
      class="settings-overlay settings-dialog-shell"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="aliyun-delete-title"
    >
      <section ref="dialogRoot" class="settings-dialog" @keydown="onDialogKeydown">
        <h2 id="aliyun-delete-title">删除阿里云凭据？</h2>
        <p>
          将删除加密保存的 AccessKey：云翻译与云 OCR 会立即停止可用（调用返回“未配置”）；
          本地工具与本地 OCR 不受影响，历史额度账本会保留。
        </p>
        <p>如需恢复云服务，需要重新填写一套专用 RAM 凭据。</p>
        <div class="settings-actions">
          <UiButton variant="ghost" :disabled="busy" @click="deleteConfirmOpen = false">取消</UiButton>
          <UiButton variant="danger" :disabled="busy" @click="confirmDeleteCredentials">
            {{ busy ? '正在删除…' : '确认删除凭据' }}
          </UiButton>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-notice { margin-top: var(--space-3); padding: var(--space-2) var(--space-3); font-size: 12px; }
.settings-card__header { padding: var(--space-3) var(--space-4); }
.settings-card__header h3 { font-size: 15px; }
.settings-card__body { padding: var(--space-3) var(--space-4); }
.settings-status { flex: none; white-space: nowrap; }
.settings-form { gap: var(--space-3); }
.settings-field-row { gap: var(--space-3); }
.settings-field input,
.settings-field select { min-height: 40px; }
.aliyun-saved {
  border-color: color-mix(in srgb, var(--success) 55%, var(--border-subtle));
  color: var(--success);
}
.aliyun-console-link {
  color: var(--accent);
}
.credential-summary {
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-secondary);
}
.credential-summary code {
  color: var(--text-primary);
  font-family: var(--font-mono);
}
.endpoint-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin: 0;
}
.endpoint-list > div {
  display: grid;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}
.endpoint-list dt { color: var(--text-muted); font-size: 11px; }
.endpoint-list dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: 12px; }
.endpoint-list code { font-family: var(--font-mono); }
.policy-block {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}
.policy-block summary {
  min-height: 40px;
  padding: var(--space-2) var(--space-3);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.policy-block__content {
  display: grid;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-3);
}
.policy-block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.policy-block__head strong {
  color: var(--text-primary);
  font-size: 13px;
}
.policy-copy {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 32px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}
.policy-copy:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.policy-json {
  margin: 0;
  padding: var(--space-3);
  overflow-x: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre;
}
.policy-note,
.usage-note,
.status-note,
.ocr-note,
.scene-retained {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}
.policy-copy-error {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}
.credential-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.credential-actions small {
  color: var(--text-muted);
}
.credential-danger-link {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: 0;
  background: transparent;
  color: var(--danger);
  font-size: 13px;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.credential-danger-link:disabled {
  color: var(--text-muted);
  cursor: not-allowed;
  text-decoration: none;
}
.scene-field { max-width: 560px; }
.aliyun-ocr-limit {
  max-width: 360px;
}
.inline-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--danger);
}
.usage-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
}
.usage-meter {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}
.usage-meter header { display: flex; align-items: center; gap: var(--space-1); }
.usage-meter header strong { color: var(--text-primary); font-size: 12px; }
.usage-meter p {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
}
.usage-meter p strong,
.usage-meter p code { text-align: right; font-family: var(--font-mono); }
.usage-meter p code { color: var(--text-secondary); font-size: 11px; }
.usage-badge {
  display: inline-block;
  margin-left: var(--space-1);
  padding: 1px 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
}
.usage-remaining {
  color: var(--accent);
  font-family: var(--font-mono);
  font-weight: 650;
}
.usage-note {
  margin-top: var(--space-3);
}
.status-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
}
.status-list > div {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}
.status-list dt {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
}
.status-list dd {
  margin: 0;
}
.status-note {
  margin-top: var(--space-3);
}
@media (max-width: 599px) {
  .settings-card__header { align-items: flex-start; flex-direction: row; }
  .settings-field input,
  .settings-field select { min-height: 44px; }
  .endpoint-list,
  .usage-grid,
  .status-list { grid-template-columns: 1fr; }
  .credential-actions {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>

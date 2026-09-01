<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import { apiRequest } from '../../lib/api'
import SettingsPageShell from '../settings/SettingsPageShell.vue'
import { formatBytes, formatDateTime, type ComponentStatus, type OperationsStatus } from './contracts'

const status = ref<OperationsStatus | null>(null)
const loading = ref(true)
const errorMessage = ref('')

const overallLabel = computed(() => {
  if (!status.value) return '读取中'
  return status.value.overall === 'healthy' ? '全部可用' : status.value.overall === 'degraded' ? '部分降级' : '核心不可用'
})

onMounted(() => void loadStatus())

async function loadStatus() {
  loading.value = true
  errorMessage.value = ''
  try {
    status.value = await apiRequest<OperationsStatus>('/api/v1/operations/status')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '系统状态暂时不可用'
  } finally {
    loading.value = false
  }
}

function componentIcon(id: ComponentStatus['id']): 'monitor' | 'boxes' | 'sparkles' | 'paperclip' {
  if (id === 'postgres') return 'boxes'
  if (id === 'ai-worker') return 'sparkles'
  if (id === 'attachments') return 'paperclip'
  return 'monitor'
}

function stateLabel(value: string): string {
  const labels: Record<string, string> = {
    healthy: '正常', degraded: '降级', unavailable: '不可用', disabled: '已停用', not_tested: '未测试',
    not_run: '未执行', running: '执行中', succeeded: '通过', failed: '失败', passed: '通过', review: '需复核', blocked: '阻塞',
  }
  return labels[value] || value
}

function releaseIcon(id: string): 'paperclip' | 'shield-check' | 'search' | 'sparkles' | 'download' | 'monitor' | 'clock' | 'boxes' {
  const icons: Record<string, 'paperclip' | 'shield-check' | 'search' | 'sparkles' | 'download' | 'monitor' | 'clock' | 'boxes'> = {
    data_integrity: 'paperclip', auth_security: 'shield-check', search_privacy: 'search', ai_policy: 'sparkles',
    backup_restore: 'download', browser_accessibility: 'monitor', performance: 'clock', deployment_security: 'boxes',
  }
  return icons[id] || 'boxes'
}
</script>

<template>
  <SettingsPageShell
    title-id="operations-title"
    title="系统、备份与发布验收"
    description="查看服务、存储、备份与恢复校验状态。"
    :show-aside="Boolean(status) && !loading"
    :surface="false"
  >
    <template #actions>
      <div class="operations-heading-actions">
        <span v-if="status" class="settings-status" :class="`settings-status--${status.overall === 'healthy' ? 'success' : status.overall === 'degraded' ? 'warning' : 'danger'}`">{{ overallLabel }}</span>
        <UiButton variant="secondary" :disabled="loading" @click="loadStatus"><UiIcon name="rotate-ccw" />刷新</UiButton>
      </div>
    </template>

    <template #notices>
      <div v-if="errorMessage" class="settings-notice settings-notice--danger" role="alert"><UiIcon name="triangle-alert" /><span>{{ errorMessage }}</span><button type="button" @click="loadStatus">重新读取</button></div>
    </template>

    <div v-if="loading" class="settings-loading"><span class="settings-spinner" />正在读取系统状态…</div>

    <template v-else-if="status">
      <p class="status-meta">版本 {{ status.version }} · Schema {{ status.schemaVersion }} · 检查于 {{ formatDateTime(status.checkedAt) }}</p>

      <section class="settings-card" aria-labelledby="system-overview-title">
        <header class="settings-card__header"><div><h3 id="system-overview-title">系统状态概览</h3><p>核心功能与 AI 服务分开显示。</p></div></header>
        <div class="settings-card__body">
          <div class="component-grid">
            <article v-for="component in status.components" :key="component.id" class="component-card" :class="`state-${component.status}`">
              <span class="component-card__icon"><UiIcon :name="componentIcon(component.id)" /></span>
              <div><small>{{ component.label }}</small><strong>{{ stateLabel(component.status) }}</strong><p>{{ component.summary }}</p></div>
            </article>
          </div>
          <div class="core-boundary" :class="status.coreAvailable ? 'core-boundary--ok' : 'core-boundary--danger'">
            <UiIcon :name="status.coreAvailable ? 'shield-check' : 'shield-alert'" />
            <p v-if="status.coreAvailable">核心功能可用：录入、搜索、浏览与附件下载不以 AI 可用性为前提。</p>
            <p v-else>核心依赖不可用；请先检查数据库或附件卷，避免继续产生不完整写入。</p>
          </div>
          <dl class="queue-grid">
            <div><dt>AI 等待 / 运行</dt><dd>{{ status.queue.queued }} / {{ status.queue.running }}</dd></div>
            <div><dt>最早等待</dt><dd>{{ formatDateTime(status.queue.oldestQueuedAt) }}</dd></div>
            <div><dt>最近任务心跳</dt><dd>{{ formatDateTime(status.queue.lastHeartbeatAt) }}</dd></div>
            <div><dt>附件用量</dt><dd>{{ formatBytes(status.storage.attachmentBytes) }} · {{ status.storage.attachmentCount }} 个</dd></div>
            <div><dt>卷可用空间</dt><dd>{{ formatBytes(status.storage.availableBytes) }} / {{ formatBytes(status.storage.capacityBytes) }}</dd></div>
          </dl>
          <div class="provider-strip" aria-label="Provider 最近连接测试">
            <p v-if="!status.providers.length">尚未配置 Provider；核心功能不受影响。</p>
            <span v-for="provider in status.providers" :key="provider.id" :class="`state-${provider.status}`">
              <strong>{{ provider.displayName }}</strong> {{ stateLabel(provider.status) }}<small v-if="provider.lastTestedAt"> · {{ formatDateTime(provider.lastTestedAt) }}</small>
            </span>
          </div>
        </div>
      </section>

      <div class="operations-pair">
        <section class="settings-card" aria-labelledby="backup-status-title">
          <header class="settings-card__header"><div><h3 id="backup-status-title">备份状态</h3><p>显示最近一次备份结果。</p></div><span class="settings-status" :class="`settings-status--${status.backup.state === 'succeeded' ? 'success' : status.backup.state === 'failed' ? 'danger' : 'warning'}`">{{ stateLabel(status.backup.state) }}</span></header>
          <div class="settings-card__body status-details">
            <dl><div><dt>最后成功</dt><dd>{{ formatDateTime(status.backup.lastSuccessAt) }}</dd></div><div><dt>目标标识</dt><dd>{{ status.backup.targetLabel || '尚未配置公开标识' }}</dd></div><div><dt>Snapshot</dt><dd>{{ status.backup.snapshotId || '—' }}</dd></div><div><dt>最近 restic check</dt><dd>{{ formatDateTime(status.backup.resticCheckAt) }}</dd></div></dl>
            <p v-if="status.backup.errorCode" class="operation-error"><UiIcon name="triangle-alert" />{{ status.backup.errorCode }}</p>
          </div>
        </section>

        <section class="settings-card" aria-labelledby="restore-status-title">
          <header class="settings-card__header"><div><h3 id="restore-status-title">恢复校验</h3><p>显示最近一次恢复校验结果。</p></div><span class="settings-status" :class="`settings-status--${status.restore.state === 'succeeded' ? 'success' : status.restore.state === 'failed' ? 'danger' : 'warning'}`">{{ stateLabel(status.restore.state) }}</span></header>
          <div class="settings-card__body status-details">
            <dl><div><dt>最近演练</dt><dd>{{ formatDateTime(status.restore.verifiedAt) }}</dd></div><div><dt>引用 / 已验证</dt><dd>{{ status.restore.referencedAttachments }} / {{ status.restore.verifiedAttachments }}</dd></div><div><dt>孤儿附件</dt><dd>{{ status.restore.orphanAttachments }}（只报告，不删除）</dd></div><div><dt>Snapshot</dt><dd>{{ status.restore.snapshotId || '—' }}</dd></div></dl>
            <p v-if="status.restore.errorCode" class="operation-error"><UiIcon name="shield-alert" />{{ status.restore.errorCode }}</p>
          </div>
        </section>
      </div>

      <section class="release-section" aria-labelledby="release-checks-title">
        <header><div><h3 id="release-checks-title">发布验收状态</h3><p>显示当前版本的发布检查结果。</p></div><span>{{ status.release.candidateVersion }} · {{ formatDateTime(status.release.generatedAt) }}</span></header>
        <div class="release-grid">
          <article v-for="check in status.release.checks" :key="check.id" :class="`release-card state-${check.status}`">
            <header><span><UiIcon :name="releaseIcon(check.id)" /></span><strong>{{ check.label }}</strong><em>{{ stateLabel(check.status) }}</em></header>
            <p>{{ check.summary }}</p>
            <small>最近检查：{{ formatDateTime(check.checkedAt) }}</small>
          </article>
        </div>
      </section>

    </template>

    <template #aside>
      <template v-if="status">
        <section>
          <h3>当前状态摘要</h3>
          <dl class="settings-context__list">
            <div><dt>整体状态</dt><dd>{{ overallLabel }}</dd></div>
            <div><dt>核心记录能力</dt><dd>{{ status.coreAvailable ? '可用' : '不可用' }}</dd></div>
            <div><dt>AI 等待 / 运行</dt><dd>{{ status.queue.queued }} / {{ status.queue.running }}</dd></div>
            <div><dt>附件</dt><dd>{{ status.storage.attachmentCount }} 个</dd></div>
            <div><dt>卷可用空间</dt><dd>{{ formatBytes(status.storage.availableBytes) }}</dd></div>
            <div><dt>检查时间</dt><dd>{{ formatDateTime(status.checkedAt) }}</dd></div>
          </dl>
        </section>
        <section
          class="settings-context__notice"
          :class="status.coreAvailable ? 'settings-context__notice--success' : 'settings-context__notice--danger'"
        >
          <UiIcon :name="status.coreAvailable ? 'shield-check' : 'shield-alert'" />
          <div>
            <strong>{{ status.coreAvailable ? '核心能力独立可用' : '核心依赖需要处理' }}</strong>
            <p>{{ status.coreAvailable ? 'AI Worker 或 Provider 降级不会阻塞录入、搜索、浏览与附件下载。' : '请优先检查数据库与附件卷，避免继续产生不完整写入。' }}</p>
          </div>
        </section>
        <section class="settings-context__notice">
          <UiIcon name="lock-keyhole" />
          <div>
            <strong>本页只读</strong>
            <p>备份、恢复、升级与完整性检查只能由宿主机上的受版本控制脚本显式执行。</p>
          </div>
        </section>
        <p class="settings-context__footnote">Web 不提供任意系统命令、Shell、SSH 或 SQL 入口。</p>
      </template>
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.operations-heading-actions { display: flex; align-items: center; gap: var(--space-2); }
.status-meta { margin: var(--space-4) 0 0; color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; }
.component-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.component-card { display: flex; min-width: 0; gap: var(--space-3); padding: var(--space-4); border: 1px solid color-mix(in srgb, var(--success) 44%, var(--border-subtle)); border-radius: var(--radius-card); background: var(--bg-code); }
.component-card.state-degraded { border-color: color-mix(in srgb, var(--warning) 52%, var(--border-subtle)); }
.component-card.state-unavailable { border-color: color-mix(in srgb, var(--danger) 52%, var(--border-subtle)); }
.component-card__icon { color: var(--accent); }
.component-card small, .component-card strong, .component-card p { display: block; margin: 0; }
.component-card small { color: var(--text-muted); font-family: var(--font-mono); }
.component-card strong { margin-top: 2px; font-size: 16px; }
.component-card p { margin-top: var(--space-2); color: var(--text-secondary); font-size: 12px; }
.core-boundary { display: flex; align-items: flex-start; gap: var(--space-2); margin-top: var(--space-4); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--success) 55%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--success); }
.core-boundary--danger { border-color: color-mix(in srgb, var(--danger) 55%, var(--border-subtle)); color: var(--danger); }
.core-boundary p { margin: 0; color: var(--text-secondary); }
.queue-grid, .status-details dl { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--space-3); margin: var(--space-4) 0 0; }
.queue-grid div, .status-details dl div { min-width: 0; padding-top: var(--space-3); border-top: 1px solid var(--border-subtle); }
dt { color: var(--text-muted); font-size: 11px; }
dd { margin: 2px 0 0; overflow-wrap: anywhere; color: var(--text-primary); }
.provider-strip { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4); }
.provider-strip p { margin: 0; color: var(--text-muted); }
.provider-strip span { padding: 6px 10px; border: 1px solid var(--border-subtle); border-radius: 999px; color: var(--text-secondary); font-size: 12px; }
.provider-strip .state-healthy { border-color: color-mix(in srgb, var(--success) 50%, var(--border-subtle)); }
.provider-strip .state-degraded { border-color: color-mix(in srgb, var(--danger) 50%, var(--border-subtle)); }
.provider-strip small { color: var(--text-muted); }
.operations-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.status-details dl { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 0; }
.operation-error { display: flex; gap: var(--space-2); margin: var(--space-4) 0 0; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--danger) 55%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--danger); font-family: var(--font-mono); font-size: 12px; }
.release-section { margin-top: var(--space-6); }
.release-section > header { display: flex; align-items: end; justify-content: space-between; gap: var(--space-4); }
.release-section h3, .release-section p { margin: 0; }
.release-section > header > div > p:last-child, .release-section > header > span { color: var(--text-muted); }
.release-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); margin-top: var(--space-4); }
.release-card { min-width: 0; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); }
.release-card.state-passed { border-color: color-mix(in srgb, var(--success) 40%, var(--border-subtle)); }
.release-card.state-review { border-color: color-mix(in srgb, var(--warning) 48%, var(--border-subtle)); }
.release-card.state-blocked { border-color: color-mix(in srgb, var(--danger) 48%, var(--border-subtle)); }
.release-card header { display: flex; align-items: center; gap: var(--space-2); }
.release-card header span { color: var(--accent); }
.release-card header strong { font-size: 15px; }
.release-card header em { margin-left: auto; color: var(--text-muted); font-size: 11px; font-style: normal; }
.release-card.state-passed header em { color: var(--success); }
.release-card.state-review header em { color: var(--warning); }
.release-card.state-blocked header em { color: var(--danger); }
.release-card p { margin-top: var(--space-3); color: var(--text-secondary); }
.release-card small { display: block; margin-top: var(--space-3); color: var(--text-muted); }
@media (max-width: 900px) { .component-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .queue-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .operations-heading-actions, .release-section > header { align-items: flex-start; flex-direction: column; } .component-grid, .operations-pair, .release-grid, .status-details dl { grid-template-columns: 1fr; } }
</style>

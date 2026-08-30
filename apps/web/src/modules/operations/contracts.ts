export type ServiceState = 'healthy' | 'degraded' | 'unavailable'
export type RunState = 'not_run' | 'running' | 'succeeded' | 'failed'
export type ReleaseState = 'not_run' | 'passed' | 'review' | 'blocked'

export interface ComponentStatus {
  id: 'api' | 'postgres' | 'ai-worker' | 'attachments'
  label: string
  status: ServiceState
  summary: string
}

export interface ProviderStatus {
  id: string
  displayName: string
  status: 'healthy' | 'degraded' | 'disabled' | 'not_tested'
  lastTestedAt: string | null
  latencyMs: number | null
  failureCategory: 'credentials_invalid' | 'unavailable' | null
}

export interface OperationsStatus {
  checkedAt: string
  version: string
  schemaVersion: number
  overall: ServiceState
  coreAvailable: boolean
  components: ComponentStatus[]
  providers: ProviderStatus[]
  queue: {
    queued: number
    running: number
    oldestQueuedAt: string | null
    lastHeartbeatAt: string | null
  }
  storage: {
    attachmentCount: number
    attachmentBytes: number
    capacityBytes: number
    availableBytes: number
    writable: boolean
  }
  backup: {
    state: RunState
    lastAttemptAt: string | null
    lastSuccessAt: string | null
    snapshotId: string
    targetLabel: string
    resticCheckAt: string | null
    errorCode: string
  }
  restore: {
    state: RunState
    verifiedAt: string | null
    snapshotId: string
    referencedAttachments: number
    verifiedAttachments: number
    orphanAttachments: number
    errorCode: string
  }
  release: {
    candidateVersion: string
    generatedAt: string | null
    checks: Array<{
      id: string
      label: string
      status: ReleaseState
      summary: string
      checkedAt: string | null
    }>
  }
}

export function formatDateTime(value: string | null): string {
  if (!value) return '尚无记录'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间不可用'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date)
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
}

/**
 * 文本翻译（V2.1）共享类型、常量与稳定错误码的 UI 映射。
 *
 * 契约来源：docs/09 §8、docs/11 §9–§13、docs/12 §7/§10/§12。
 * 语言清单不在此复制，只从 GET /api/v1/aliyun/translation/languages 读取。
 */

export type TranslationEngine = 'general' | 'professional'

export type ProfessionalScene = 'title' | 'description' | 'communication' | 'medical' | 'social' | 'finance'

export interface TranslationLanguageEntry {
  code: string
  nameZh: string
  nameEn: string
}

export interface TranslationLanguagesResponse {
  version: string
  generalLanguages: TranslationLanguageEntry[]
  professionalPairsByScene: Partial<Record<ProfessionalScene, string[][]>>
}

export interface PreflightPlanItem {
  index: number
  units: number
  engine: TranslationEngine
  meter: string
  scene: string | null
}

export interface PreflightPlanTotal {
  meter: string
  chunks: number
  units: number
  limit: number
  used: number
  reserved: number
  remainingBefore: number
  remainingAfterPlan: number
}

export interface PreflightPlan {
  operation: 'translation'
  month: string
  resetAt: string
  source: string
  professionalScene: ProfessionalScene | null
  items: PreflightPlanItem[]
  totals: PreflightPlanTotal[]
}

export type QueueTicketStatus =
  | 'waiting'
  | 'ready'
  | 'active'
  | 'expired'
  | 'cancelled'

/** GET /api/v1/aliyun/usage/current（docs/11 §8.4），页面头部额度摘要使用。 */
export interface AliyunUsageMeterSnapshot {
  meter: string
  limit: number
  used: number
  reserved: number
  remaining: number
}

export interface AliyunUsageSnapshot {
  month: string
  timezone: string
  meters: AliyunUsageMeterSnapshot[]
  source: string
}

export interface QueueTicketSnapshot {
  ticketId: string
  operation: 'translation'
  status: QueueTicketStatus
  position?: number
  expiresAt?: string
  claimBy?: string
  idleExpiresAt?: string
  absoluteExpiresAt?: string
  cancelRequested?: boolean
}

export interface QueueTicketClaimResponse {
  ticketId: string
  status: 'active'
  permitToken: string
  idleExpiresAt: string
  absoluteExpiresAt: string
}

export interface TranslationChunkResponse {
  translatedText: string
  detectedLanguage: string | null
  engine: TranslationEngine
  scene: string | null
  billableUnits: number
  upstreamRequestId: string | null
  quota: { meter: string; remaining: number }
  replayed: boolean
}

/** 片段在当前标签页内的运行状态。 */
export type TranslateChunkStatus =
  | 'pending'
  | 'sending'
  | 'success'
  | 'restore-failed'
  | 'failed'
  | 'uncertain'

export interface TranslateChunkRuntime {
  /** 在本次页面输入中的全局片段序号。 */
  index: number
  units: number
  sourceText: string
  expectedEngine: TranslationEngine
  status: TranslateChunkStatus
  resultText: string
  engine?: TranslationEngine
  scene?: string | null
  errorCode?: string
  errorMessage?: string
  requestKey?: string
}

export type TranslateRunPhase =
  | 'idle'
  | 'queueing'
  | 'waiting'
  | 'claiming'
  | 'running'
  | 'paused'
  | 'finished'
  | 'replan'
  | 'cancelled'

/** docs/12 §12 文案词典与 docs/11 §13 稳定错误码对应的 UI 动作。 */
export type CloudErrorActionKind =
  | 'settings'
  | 'quota'
  | 'manual-retry'
  | 'requeue'
  | 'uncertain'
  | 'language'
  | 'plain'

export interface CloudErrorAction {
  kind: CloudErrorActionKind
  title: string
  detail: string
}

const PROFESSIONAL_SCENE_LABELS: Record<ProfessionalScene, string> = {
  title: '商品标题',
  description: '商品详情',
  communication: '买卖家沟通（电商）',
  medical: '医疗',
  social: '社交',
  finance: '金融',
}

export function professionalSceneLabel(scene: string | null | undefined): string {
  if (!scene) return ''
  const known = PROFESSIONAL_SCENE_LABELS[scene as ProfessionalScene]
  return known ? `${known}（${scene}）` : scene
}

export function engineLabel(engine: string | null | undefined, scene?: string | null): string {
  if (engine === 'professional') {
    return scene ? `专业版 · ${professionalSceneLabel(scene)}` : '专业版'
  }
  if (engine === 'general') return '通用版'
  return engine ?? ''
}

export function meterLabel(meter: string): string {
  if (meter === 'mt_general') return '通用版'
  if (meter === 'mt_professional') return '专业版'
  return meter
}

export function chunkStatusLabel(status: TranslateChunkStatus): string {
  switch (status) {
    case 'pending': return '未发送'
    case 'sending': return '发送中'
    case 'success': return '已完成'
    case 'restore-failed': return '占位符还原失败，保留原文'
    case 'failed': return '失败'
    case 'uncertain': return '结果不确定'
  }
}

/** 稳定错误码 → UI 动作（docs/11 §13）。只接收 code/status，不解析上游自由文本。 */
export function describeCloudError(code: string, status: number): CloudErrorAction {
  if (code === 'ALIYUN_NOT_CONFIGURED') {
    return {
      kind: 'settings',
      title: '阿里云凭据尚未配置',
      detail: '云翻译需要实例所有者先在设置中保存阿里云 AccessKey；当前输入不会清空。',
    }
  }
  if (code === 'PROFESSIONAL_SCENE_REQUIRED') {
    return {
      kind: 'settings',
      title: '需要先选择专业版场景',
      detail: '当前计划需要专业版，但设置中尚未明确选择专业场景；请在设置页选择官方场景后重试。',
    }
  }
  if (code === 'SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL') {
    return {
      kind: 'language',
      title: '请先明确源语言',
      detail: '本次额度计划需要专业版，而源语言仍是“自动检测”。请手动选择明确的源语言后重新预检。',
    }
  }
  if (code === 'PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED') {
    return {
      kind: 'language',
      title: '当前专业场景不支持该语言方向',
      detail: '请修改源/目标语言，或到设置页调整专业场景；不会提供“仍然尝试”。',
    }
  }
  if (code === 'QUOTA_EXHAUSTED') {
    return {
      kind: 'quota',
      title: '本月应用保护额度已用尽',
      detail: '已硬停止，没有继续付费的旁路；请等待下月重置、降低本月其他使用，或到设置页核对本地保护账本。',
    }
  }
  if (code === 'UPSTREAM_RESULT_UNCERTAIN') {
    return {
      kind: 'uncertain',
      title: '结果不确定',
      detail: '该片段已保守计量、结果未收到，不会自动重试；手动重试可能重复计费。',
    }
  }
  if (code === 'UPSTREAM_THROTTLED') {
    return {
      kind: 'manual-retry',
      title: '上游限流',
      detail: '不会自动重试；可稍后手动重试该片段。',
    }
  }
  if (code === 'UPSTREAM_REJECTED' || code === 'UPSTREAM_UNAVAILABLE') {
    return {
      kind: 'manual-retry',
      title: status >= 500 ? '上游服务暂不可用' : '上游明确失败',
      detail: '该片段已按服务端结算状态计量；可手动重试，重试使用新的请求标识。',
    }
  }
  if (code === 'QUEUE_FULL') {
    return {
      kind: 'requeue',
      title: '排队已满',
      detail: '当前等待的队列已满；请稍后由你重新发起排队。',
    }
  }
  if (code === 'QUEUE_TICKET_NOT_FOUND' || code === 'QUEUE_TICKET_EXPIRED' || code === 'QUEUE_TICKET_CANCELLED') {
    return {
      kind: 'requeue',
      title: '排队凭证已失效',
      detail: '队列凭证不存在、已过期或已取消（服务可能已重启）；需要重新排队，已成功片段不受影响。',
    }
  }
  if (code === 'QUEUE_TICKET_NOT_READY') {
    return {
      kind: 'plain',
      title: '仍在排队等待',
      detail: '按当前队列状态继续等待即可；不会反复尝试领取。',
    }
  }
  if (code === 'CLOUD_PERMIT_EXPIRED' || code === 'CLOUD_PERMIT_INVALID') {
    return {
      kind: 'requeue',
      title: '云调用许可已失效',
      detail: '需要重新排队后从失败片段继续；已成功片段不会重发。',
    }
  }
  if (code === 'CLOUD_PERMIT_BUSY') {
    return {
      kind: 'plain',
      title: '同一运行已有请求在途',
      detail: '当前许可正处理另一个片段；等待其返回后再继续，不会自动重发。',
    }
  }
  if (code === 'CLOUD_PERMIT_OPERATION_MISMATCH') {
    return {
      kind: 'plain',
      title: '许可与接口不匹配',
      detail: '翻译许可不能用于其他云接口；这是客户端问题，不会重试。',
    }
  }
  if (code === 'CALL_IN_PROGRESS') {
    return {
      kind: 'plain',
      title: '同一片段的请求正在处理',
      detail: '该片段已有同标识请求在途；等待返回，不会重复发送。',
    }
  }
  if (code === 'CALL_SETTLED_WITHOUT_RESULT') {
    return {
      kind: 'manual-retry',
      title: '调用已结算，但结果未收到',
      detail: '相同请求标识已按保守结果结算，内容不会保存也无法凭原标识取回；只能手动发起新请求，可能再次计费。',
    }
  }
  if (code === 'IDEMPOTENCY_KEY_REUSED') {
    return {
      kind: 'plain',
      title: '请求标识与原记录不一致',
      detail: '这是客户端问题；不会自动生成新标识隐藏问题，请重新发起整次运行。',
    }
  }
  if (code === 'NETWORK_ERROR') {
    return {
      kind: 'uncertain',
      title: '结果不确定',
      detail: '网络错误导致无法确认上游是否受理；已按保守计量处理，不会自动重试；手动重试可能重复计费。',
    }
  }
  if (code === 'AUTH_REQUIRED' || code === 'MUTATION_NOT_ALLOWED') {
    return {
      kind: 'plain',
      title: '登录状态已失效',
      detail: '请重新登录后再继续；当前输入和已完成的片段仍保留在本页。',
    }
  }
  if (code === 'INVALID_INPUT') {
    return {
      kind: 'plain',
      title: '请求参数无效',
      detail: '服务端拒绝了本次请求参数（如语言或片段长度）；请检查语言选择后重新预检。',
    }
  }
  return {
    kind: 'plain',
    title: '请求未成功',
    detail: `稳定错误码 ${code}（HTTP ${status}）；不会自动重试。`,
  }
}

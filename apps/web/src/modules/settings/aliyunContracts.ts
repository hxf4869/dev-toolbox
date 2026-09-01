import { ApiError } from '../../lib/api'

/**
 * 阿里云设置页的窄合同辅助：类型、官方场景常量、表单校验与稳定错误文案。
 * 数据形状来自 docs/11-V2-CLOUD-SERVICES-CONTRACTS.md §8；语义见 §2.3、§3 与 docs/09 §8.2。
 */

export type AliyunProfessionalScene =
  | 'title'
  | 'description'
  | 'communication'
  | 'medical'
  | 'social'
  | 'finance'

export type AliyunUsageMeterName = 'mt_general' | 'mt_professional' | 'ocr_general'

export interface AliyunCredentialsState {
  configured: boolean
  accessKeyIdMasked: string | null
  credentialVersion: number
}

export interface AliyunStatusState {
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastFailureCategory: string | null
}

export interface AliyunSettings {
  credentials: AliyunCredentialsState
  translation: {
    generalMonthlyLimit: number
    professionalMonthlyLimit: number
    autoUseProfessional: boolean
    professionalScene: AliyunProfessionalScene | null
  }
  ocr: { monthlyLimit: number }
  concurrency: { owner: number; global: number }
  status: AliyunStatusState
}

export interface AliyunUsageMeter {
  meter: AliyunUsageMeterName
  limit: number
  used: number
  reserved: number
  remaining: number
}

export interface AliyunUsage {
  month: string
  timezone: string
  meters: AliyunUsageMeter[]
  source: string
}

export interface AliyunSettingsPutBody {
  /** 省略表示保留现有凭据；出现时两个字段都必填。Secret 只在请求中出现一次，不回显、不落浏览器存储。 */
  credentials?: { accessKeyId: string; accessKeySecret: string }
  translation: {
    generalMonthlyLimit: number
    professionalMonthlyLimit: number
    autoUseProfessional: boolean
    professionalScene: AliyunProfessionalScene | null
  }
  ocr: { monthlyLimit: number }
  concurrency: { owner: number; global: number }
}

export const ALIYUN_LIMITS = {
  generalMin: 1,
  generalMax: 1_000_000,
  professionalMin: 1,
  professionalMax: 1_000_000,
  ocrMin: 1,
  ocrMax: 200,
  ownerMin: 1,
  ownerMax: 3,
  globalMin: 1,
  globalMax: 10,
} as const

/**
 * 六个官方专业场景。中文名与 docs/11 §2.1.1 固定一致；`communication` 是“买卖家沟通（电商）”，
 * 不得改名为工程记录或作为默认推荐。每个场景都说明其专业语言方向有限。
 */
export const ALIYUN_SCENES: ReadonlyArray<{
  code: AliyunProfessionalScene
  label: string
  detail: string
}> = [
  {
    code: 'title',
    label: '商品标题',
    detail: '专业语言方向有限：仅支持以中文或英文为源的 34 个固定电商方向。',
  },
  {
    code: 'description',
    label: '商品详情',
    detail: '专业语言方向有限：仅支持与商品标题相同的 34 个固定电商方向。',
  },
  {
    code: 'communication',
    label: '买卖家沟通',
    detail:
      '专业语言方向有限：仅支持英语或中文与阿拉伯语、俄语、法语、泰语等 10 种语言互译（38 个方向）。阿里云没有工程记录专用场景。',
  },
  { code: 'medical', label: '医疗', detail: '专业语言方向有限：仅支持中↔英、中↔日共 4 个方向。' },
  { code: 'social', label: '社交', detail: '专业语言方向有限：仅支持中↔英、中↔日、中↔韩共 6 个方向。' },
  { code: 'finance', label: '金融', detail: '专业语言方向有限：仅支持中↔英共 2 个方向。' },
]

export const ALIYUN_METER_LABELS: Record<AliyunUsageMeterName, string> = {
  mt_general: '阿里云机器翻译 · 通用版',
  mt_professional: '阿里云机器翻译 · 专业版',
  ocr_general: '阿里云通用文字识别',
}

/** docs/11 §13.1 的 11 个稳定失败类别；页面只显示类别含义，不显示上游自由文本。 */
export const ALIYUN_FAILURE_CATEGORY_LABELS: Record<string, string> = {
  credential_invalid: '凭据无效（检查或替换 AccessKey）',
  permission_denied: 'RAM 权限不足（检查最小权限策略）',
  service_not_open: '服务未开通（需到阿里云控制台确认）',
  account_arrears: '账号欠费（需到控制台处理账号状态）',
  unsupported_language: '语言或专业场景不支持',
  input_too_long: '输入过长（需缩短或重新分块）',
  invalid_image: '图片不符合要求',
  throttled: '被限流（稍后由用户手动重试）',
  timeout: '超时（结果不确定，已保守计量）',
  unavailable: '服务暂不可用',
  unknown: '未知错误（凭 RequestId 人工排障）',
}

/** docs/11 §3 的最小 RAM 权限策略，三条 Action 为合同内容，不得增删。 */
export const ALIYUN_RAM_POLICY_JSON = `{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "alimt:TranslateGeneral",
        "alimt:Translate",
        "ocr:RecognizeGeneral"
      ],
      "Resource": "*"
    }
  ]
}`

export interface AliyunSettingsFormInput {
  credentialsConfigured: boolean
  accessKeyId: string
  accessKeySecret: string
  /** 数字输入的 v-model：Vue 对 type=number 会把纯数字值转成 number，两种都可能传入。 */
  generalMonthlyLimit: string | number
  professionalMonthlyLimit: string | number
  autoUseProfessional: boolean
  professionalScene: string
  ocrMonthlyLimit: string | number
  ownerConcurrency: string | number
  globalConcurrency: string | number
}

export function parseIntegerInput(value: string | number): number | null {
  const raw = typeof value === 'number' ? String(value) : value.trim()
  if (!/^-?\d+$/.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** 全局并发小于 owner 并发时的就地错误文案；其余情况返回 null。 */
export function concurrencyIssueFor(owner: string | number, global: string | number): string | null {
  const ownerValue = parseIntegerInput(owner)
  const globalValue = parseIntegerInput(global)
  if (ownerValue === null || globalValue === null) return null
  if (globalValue < ownerValue) {
    return `全局并发（${globalValue}）不能小于 owner 并发（${ownerValue}）。请调大全局并发，或调小 owner 并发后再保存。`
  }
  return null
}

/**
 * 保存前的全部前端校验。返回按顺序排列的错误消息；非空时不得发出 PUT。
 * usage 来自本地保护账本，用于阻止保存立即低于当前月已用与预留之和的上限。
 */
export function validateAliyunSettingsForm(
  input: AliyunSettingsFormInput,
  usage: AliyunUsage | null,
): string[] {
  const errors: string[] = []

  const idProvided = input.accessKeyId.trim() !== ''
  const secretProvided = input.accessKeySecret !== ''
  if (idProvided !== secretProvided) {
    errors.push(
      '替换凭据时 AccessKey ID 与 AccessKey Secret 必须同时填写；两者都留空表示保留现有凭据。',
    )
  } else if (!input.credentialsConfigured && !idProvided) {
    errors.push('尚未配置凭据：首次保存必须同时填写 AccessKey ID 与 AccessKey Secret。')
  }

  const general = parseIntegerInput(input.generalMonthlyLimit)
  if (general === null || general < ALIYUN_LIMITS.generalMin || general > ALIYUN_LIMITS.generalMax) {
    errors.push(
      `通用版月度硬上限必须是 ${ALIYUN_LIMITS.generalMin}–${formatLimit(ALIYUN_LIMITS.generalMax)} 的整数。`,
    )
  }
  const professional = parseIntegerInput(input.professionalMonthlyLimit)
  if (
    professional === null ||
    professional < ALIYUN_LIMITS.professionalMin ||
    professional > ALIYUN_LIMITS.professionalMax
  ) {
    errors.push(
      `专业版月度硬上限必须是 ${ALIYUN_LIMITS.professionalMin}–${formatLimit(ALIYUN_LIMITS.professionalMax)} 的整数。`,
    )
  }
  const ocr = parseIntegerInput(input.ocrMonthlyLimit)
  if (ocr === null || ocr < ALIYUN_LIMITS.ocrMin || ocr > ALIYUN_LIMITS.ocrMax) {
    errors.push(`OCR 月度上限必须是 ${ALIYUN_LIMITS.ocrMin}–${ALIYUN_LIMITS.ocrMax} 的整数。`)
  }

  if (
    input.autoUseProfessional &&
    !ALIYUN_SCENES.some((scene) => scene.code === input.professionalScene)
  ) {
    errors.push('已开启自动切换专业版：必须先在六个官方场景中选择一个专业场景，保存前不会猜测场景。')
  }

  const owner = parseIntegerInput(input.ownerConcurrency)
  if (owner === null || owner < ALIYUN_LIMITS.ownerMin || owner > ALIYUN_LIMITS.ownerMax) {
    errors.push(`owner 并发必须是 ${ALIYUN_LIMITS.ownerMin}–${ALIYUN_LIMITS.ownerMax} 的整数。`)
  }
  const global = parseIntegerInput(input.globalConcurrency)
  if (global === null || global < ALIYUN_LIMITS.globalMin || global > ALIYUN_LIMITS.globalMax) {
    errors.push(`全局并发必须是 ${ALIYUN_LIMITS.globalMin}–${ALIYUN_LIMITS.globalMax} 的整数。`)
  }
  const concurrencyIssue = concurrencyIssueFor(input.ownerConcurrency, input.globalConcurrency)
  if (concurrencyIssue) errors.push(concurrencyIssue)

  if (usage) {
    const floors: Array<{ meter: AliyunUsageMeterName; label: string; value: number | null }> = [
      { meter: 'mt_general', label: '通用版月度硬上限', value: general },
      { meter: 'mt_professional', label: '专业版月度硬上限', value: professional },
      { meter: 'ocr_general', label: 'OCR 月度上限', value: ocr },
    ]
    for (const floor of floors) {
      if (floor.value === null) continue
      const entry = usage.meters.find((meter) => meter.meter === floor.meter)
      if (!entry) continue
      const minimum = entry.used + entry.reserved
      if (floor.value < minimum) {
        errors.push(
          `${floor.label} ${formatLimit(floor.value)} 低于当前月已用与预留之和 ${formatLimit(minimum)}；请提高上限或等待额度重置后再保存。`,
        )
      }
    }
  }

  return errors
}

/** 按稳定错误码把保存/删除失败转成“原因 + 下一步”；不依赖上游自由文本作唯一依据。 */
export function aliyunSaveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'AUTH_REQUIRED') return '登录会话已过期：请重新登录后再保存。'
    if (error.code === 'MUTATION_NOT_ALLOWED') {
      return '请求未通过来源安全校验：请刷新页面后重试。'
    }
    if (error.code === 'INVALID_INPUT') {
      return `保存被拒绝（INVALID_INPUT）：${error.message} 请按提示修改取值后再保存。`
    }
    return `保存未成功（${error.code}）：${error.message} 请检查设置后重试；如持续失败请查看系统状态。`
  }
  if (error instanceof Error) return `${error.message} 请检查网络后重试。`
  return '请求未成功，请稍后重试。'
}

function formatLimit(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

import { Cron } from 'croner'

import { assertTimeText, assertTimeZone } from './time'

export type CronDialect = 'unix' | 'spring_quartz'

export interface CronPreviewInput {
  dialect: CronDialect
  expression: string
  timeZone: string
  baseTime?: string
}

export interface CronFieldExplanation {
  position: number
  name: string
  value: string
  meaning: string
}

export interface CronPreview {
  dialectLabel: string
  timeZone: string
  baseTime: string
  fields: CronFieldExplanation[]
  nextRuns: Array<{ iso: string; zoned: string }>
}

const unixFields = ['分钟', '小时', '日', '月', '星期']
const strictFields = ['秒', '分钟', '小时', '日', '月', '星期', '年']

function fieldMeaning(name: string, value: string): string {
  if (value === '*') return '每个允许值'
  if (value.includes('/')) return `按步长：${value}`
  if (value.includes(',')) return `枚举：${value}`
  if (value.includes('-')) return `范围：${value}`
  return `${name} = ${value}`
}

function formatInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).format(date)
}

export function validateCronExpression(input: CronPreviewInput): string[] {
  assertTimeText(input.expression, 'Cron 表达式')
  assertTimeZone(input.timeZone)
  const fields = input.expression.trim().split(/\s+/).filter(Boolean)
  if (input.dialect === 'unix' && fields.length !== 5) {
    throw new Error(`Unix/Linux 方言必须恰好 5 段，当前为 ${fields.length} 段`)
  }
  if (input.dialect === 'spring_quartz' && fields.length !== 6 && fields.length !== 7) {
    throw new Error(`Spring/Quartz 兼容方言必须为 6 或 7 段，当前为 ${fields.length} 段`)
  }
  if (input.dialect === 'spring_quartz') {
    if (fields.some((field) => field.includes('?'))) {
      throw new Error('严格 Quartz 的 ? 语义无法由当前预览器可靠表达，已拒绝计算；请明确改写日或星期字段')
    }
    const dayOfMonth = fields[3] ?? ''
    const dayOfWeek = fields[5] ?? ''
    if (dayOfMonth !== '*' && dayOfWeek !== '*') {
      throw new Error('日与星期不能同时具体指定；请将其中一个字段改为 *')
    }
  }
  return fields
}

export function previewCron(input: CronPreviewInput): CronPreview {
  const fields = validateCronExpression(input)
  const baseDate = input.baseTime ? new Date(input.baseTime) : new Date()
  if (Number.isNaN(baseDate.getTime())) throw new Error('基准时间格式无效')
  const names = input.dialect === 'unix' ? unixFields : strictFields.slice(0, fields.length)
  let cron: Cron | undefined
  try {
    cron = new Cron(input.expression.trim(), {
      paused: true,
      timezone: input.timeZone,
      mode: input.dialect === 'unix' ? '5-part' : fields.length === 6 ? '6-part' : '7-part',
      alternativeWeekdays: input.dialect === 'spring_quartz',
      // Linux crontab(5): 受限的日与星期按 OR 组合；Spring/Quartz 语义为 AND
      legacyMode: input.dialect === 'unix',
    })
    const nextRuns = cron.nextRuns(5, baseDate).map((date) => ({
      iso: date.toISOString(),
      zoned: formatInTimeZone(date, input.timeZone),
    }))
    if (nextRuns.length !== 5) throw new Error('该表达式在可预览范围内不足 5 次执行时间')
    return {
      dialectLabel: input.dialect === 'unix' ? 'Unix/Linux（5 段）' : `Spring/Quartz 兼容（${fields.length} 段）`,
      timeZone: input.timeZone,
      baseTime: baseDate.toISOString(),
      fields: fields.map((value, index) => ({
        position: index + 1,
        name: names[index] ?? `字段 ${index + 1}`,
        value,
        meaning: fieldMeaning(names[index] ?? `字段 ${index + 1}`, value),
      })),
      nextRuns,
    }
  } catch (error) {
    if (error instanceof Error && (error.message.includes('不足 5 次') || error.message.includes('必须') || error.message.includes('不能') || error.message.includes('无法'))) throw error
    throw new Error(`Cron 表达式无效：${error instanceof Error ? error.message : '无法解析'}`)
  } finally {
    cron?.stop()
  }
}

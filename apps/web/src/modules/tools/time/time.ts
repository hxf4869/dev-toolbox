import type { Temporal as PolyfillTemporal } from '@js-temporal/polyfill'

export const TIME_TEXT_LIMIT = 16 * 1024
export const WORKDAY_AMOUNT_LIMIT = 1000

type TemporalAPI = typeof PolyfillTemporal

let temporalPromise: Promise<TemporalAPI> | undefined

export type LocalTimeResolution = 'earlier' | 'later'

export interface TimeConversionInput {
  kind: 'unix_seconds' | 'unix_milliseconds' | 'iso' | 'local'
  value: string
  timeZone: string
  resolution?: LocalTimeResolution
}

export interface TimeSnapshot {
  unixSeconds: string
  unixMilliseconds: string
  iso: string
  utc: string
  local: string
  zoned: string
  offset: string
  timeZone: string
}

export interface ResolutionRequired {
  status: 'resolution_required'
  kind: 'nonexistent' | 'repeated'
  message: string
  earlier: string
  later: string
}

export interface ResolvedTime {
  status: 'resolved'
  value: TimeSnapshot
  adjustment?: string
}

export type TimeResolutionResult = ResolutionRequired | ResolvedTime

export interface DateCalculationInput {
  localDateTime: string
  timeZone: string
  direction: 1 | -1
  values: {
    years: number
    months: number
    days: number
    hours: number
    minutes: number
    seconds: number
  }
  resolution?: LocalTimeResolution
}

export interface DateDifferenceInput {
  from: string
  to: string
  timeZone: string
  fromResolution?: LocalTimeResolution
  toResolution?: LocalTimeResolution
}

export interface DateDifferenceResult {
  from: TimeSnapshot
  to: TimeSnapshot
  duration: string
  totalSeconds: string
}

export interface WorkdayInput {
  startDate: string
  amount: number
  holidays: string[]
  workdays: string[]
}

export interface WorkdayResult {
  date: string
  traversedDays: number
  holidaysUsed: string[]
  workdaysUsed: string[]
}

export interface NaturalLanguageInput {
  expression: string
  timeZone: string
  baseInstant?: string
  resolution?: LocalTimeResolution
}

export interface NaturalLanguageResolved extends ResolvedTime {
  base: TimeSnapshot
  normalized: string
}

export type NaturalLanguageResult = ResolutionRequired | NaturalLanguageResolved

export async function getTemporal(): Promise<TemporalAPI> {
  const nativeTemporal = (globalThis as typeof globalThis & { Temporal?: TemporalAPI }).Temporal
  if (nativeTemporal) return nativeTemporal
  temporalPromise ??= import('@js-temporal/polyfill').then((module) => module.Temporal)
  return temporalPromise
}

export function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function assertTimeText(value: string, label = '输入'): void {
  const size = utf8Size(value)
  if (size > TIME_TEXT_LIMIT) {
    throw new Error(`${label}为 ${size} 字节，超过 16 KiB 上限`)
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function availableTimeZones(): string[] {
  const supportedValuesOf = (Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[]
  }).supportedValuesOf
  const zones = supportedValuesOf ? supportedValuesOf('timeZone') : []
  return Array.from(new Set(['UTC', systemTimeZone(), ...zones])).sort((a, b) => a.localeCompare(b))
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
  } catch {
    throw new Error(`无效的 IANA 时区：${timeZone}`)
  }
}

function decimalToNanoseconds(value: string, unitScale: bigint): bigint {
  const normalized = value.trim()
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized)
  if (!match) throw new Error('Unix 时间必须是十进制数字')
  const sign = match[1] === '-' ? -1n : 1n
  const integer = BigInt(match[2] ?? '0') * unitScale
  const scaleDigits = unitScale.toString().length - 1
  const fractionText = match[3] ?? ''
  if (fractionText.length > scaleDigits) {
    throw new Error(`小数精度最多 ${scaleDigits} 位`)
  }
  const fraction = BigInt(fractionText.padEnd(scaleDigits, '0') || '0')
  return sign * (integer + fraction)
}

function formatEpochDecimal(epochNanoseconds: bigint, scale: bigint, digits: number): string {
  const negative = epochNanoseconds < 0
  const absolute = negative ? -epochNanoseconds : epochNanoseconds
  const integer = absolute / scale
  const fraction = (absolute % scale).toString().padStart(digits, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`
}

async function snapshotFromInstant(
  instant: PolyfillTemporal.Instant,
  timeZone: string,
): Promise<TimeSnapshot> {
  const Temporal = await getTemporal()
  assertTimeZone(timeZone)
  const selected = instant.toZonedDateTimeISO(timeZone)
  const localZone = systemTimeZone()
  return {
    unixSeconds: formatEpochDecimal(instant.epochNanoseconds, 1_000_000_000n, 9),
    unixMilliseconds: formatEpochDecimal(instant.epochNanoseconds, 1_000_000n, 6),
    iso: instant.toString(),
    utc: instant.toZonedDateTimeISO('UTC').toString(),
    local: instant.toZonedDateTimeISO(localZone).toString(),
    zoned: selected.toString(),
    offset: selected.offset,
    timeZone,
  }
}

async function resolvePlainDateTime(
  plain: PolyfillTemporal.PlainDateTime,
  timeZone: string,
  resolution?: LocalTimeResolution,
): Promise<TimeResolutionResult> {
  assertTimeZone(timeZone)
  const earlier = plain.toZonedDateTime(timeZone, { disambiguation: 'earlier' })
  const later = plain.toZonedDateTime(timeZone, { disambiguation: 'later' })
  const earlierMatches = earlier.toPlainDateTime().equals(plain)
  const laterMatches = later.toPlainDateTime().equals(plain)
  const differs = earlier.epochNanoseconds !== later.epochNanoseconds

  if ((!earlierMatches && !laterMatches) || (earlierMatches && laterMatches && differs)) {
    const kind = earlierMatches ? 'repeated' : 'nonexistent'
    if (!resolution) {
      return {
        status: 'resolution_required',
        kind,
        message: kind === 'nonexistent'
          ? '该本地时间处于夏令时跳变缺口，请明确选择向前或向后调整。'
          : '该本地时间在夏令时回拨中出现两次，请明确选择一个 offset。',
        earlier: earlier.toString(),
        later: later.toString(),
      }
    }
    const selected = resolution === 'earlier' ? earlier : later
    return {
      status: 'resolved',
      value: await snapshotFromInstant(selected.toInstant(), timeZone),
      adjustment: kind === 'nonexistent'
        ? `已按用户选择${resolution === 'earlier' ? '向后' : '向前'}调整夏令时缺口`
        : `已选择 ${selected.offset} offset`,
    }
  }

  return { status: 'resolved', value: await snapshotFromInstant(earlier.toInstant(), timeZone) }
}

export async function currentTime(timeZone: string, now?: string): Promise<TimeSnapshot> {
  const Temporal = await getTemporal()
  const instant = now ? Temporal.Instant.from(now) : Temporal.Now.instant()
  return snapshotFromInstant(instant, timeZone)
}

export async function convertTime(input: TimeConversionInput): Promise<TimeResolutionResult> {
  assertTimeText(input.value)
  assertTimeZone(input.timeZone)
  const value = input.value.trim()
  if (!value) throw new Error('请输入要转换的时间')
  const Temporal = await getTemporal()

  if (input.kind === 'local') {
    let plain: PolyfillTemporal.PlainDateTime
    try {
      plain = Temporal.PlainDateTime.from(value)
    } catch {
      throw new Error('本地时间格式无效，请使用 YYYY-MM-DDTHH:mm:ss')
    }
    return resolvePlainDateTime(plain, input.timeZone, input.resolution)
  }

  let instant: PolyfillTemporal.Instant
  try {
    if (input.kind === 'unix_seconds') {
      instant = Temporal.Instant.fromEpochNanoseconds(decimalToNanoseconds(value, 1_000_000_000n))
    } else if (input.kind === 'unix_milliseconds') {
      instant = Temporal.Instant.fromEpochNanoseconds(decimalToNanoseconds(value, 1_000_000n))
    } else {
      instant = Temporal.Instant.from(value)
    }
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('Unix') || error.message.startsWith('小数'))) throw error
    throw new Error(input.kind === 'iso' ? 'ISO 8601 时间必须包含 Z 或明确 offset' : 'Unix 时间超出可表示范围')
  }
  return { status: 'resolved', value: await snapshotFromInstant(instant, input.timeZone) }
}

export async function calculateDate(input: DateCalculationInput): Promise<TimeResolutionResult> {
  assertTimeText(input.localDateTime)
  const Temporal = await getTemporal()
  let plain: PolyfillTemporal.PlainDateTime
  try {
    plain = Temporal.PlainDateTime.from(input.localDateTime.trim())
  } catch {
    throw new Error('起始本地时间格式无效')
  }
  const resolved = await resolvePlainDateTime(plain, input.timeZone, input.resolution)
  if (resolved.status === 'resolution_required') return resolved
  const start = Temporal.Instant.from(resolved.value.iso).toZonedDateTimeISO(input.timeZone)
  const direction = input.direction
  const result = start.add({
    years: input.values.years * direction,
    months: input.values.months * direction,
    days: input.values.days * direction,
    hours: input.values.hours * direction,
    minutes: input.values.minutes * direction,
    seconds: input.values.seconds * direction,
  })
  return {
    status: 'resolved',
    value: await snapshotFromInstant(result.toInstant(), input.timeZone),
    adjustment: resolved.adjustment,
  }
}

async function resolvedZonedDateTime(
  value: string,
  timeZone: string,
  resolution?: LocalTimeResolution,
): Promise<PolyfillTemporal.ZonedDateTime | ResolutionRequired> {
  const Temporal = await getTemporal()
  const plain = Temporal.PlainDateTime.from(value.trim())
  const resolved = await resolvePlainDateTime(plain, timeZone, resolution)
  if (resolved.status === 'resolution_required') return resolved
  return Temporal.Instant.from(resolved.value.iso).toZonedDateTimeISO(timeZone)
}

export async function differenceBetweenDates(
  input: DateDifferenceInput,
): Promise<DateDifferenceResult | { side: 'from' | 'to'; resolution: ResolutionRequired }> {
  assertTimeText(input.from, '起始时间')
  assertTimeText(input.to, '结束时间')
  let from: PolyfillTemporal.ZonedDateTime | ResolutionRequired
  let to: PolyfillTemporal.ZonedDateTime | ResolutionRequired
  try {
    from = await resolvedZonedDateTime(input.from, input.timeZone, input.fromResolution)
  } catch {
    throw new Error('起始本地时间格式无效')
  }
  if ('status' in from) return { side: 'from', resolution: from }
  try {
    to = await resolvedZonedDateTime(input.to, input.timeZone, input.toResolution)
  } catch {
    throw new Error('结束本地时间格式无效')
  }
  if ('status' in to) return { side: 'to', resolution: to }
  const duration = from.until(to, { largestUnit: 'years', smallestUnit: 'seconds' })
  const totalNanoseconds = to.epochNanoseconds - from.epochNanoseconds
  return {
    from: await snapshotFromInstant(from.toInstant(), input.timeZone),
    to: await snapshotFromInstant(to.toInstant(), input.timeZone),
    duration: duration.toString(),
    totalSeconds: formatEpochDecimal(totalNanoseconds, 1_000_000_000n, 9),
  }
}

function normalizedDateSet(values: string[], label: string): Set<string> {
  const result = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    if (!value) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label}包含无效日期：${value}`)
    const parsed = new Date(`${value}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error(`${label}包含无效日期：${value}`)
    }
    result.add(value)
  }
  return result
}

export async function addWorkdays(input: WorkdayInput): Promise<WorkdayResult> {
  if (!Number.isSafeInteger(input.amount)) throw new Error('工作日数量必须是安全整数')
  if (Math.abs(input.amount) > WORKDAY_AMOUNT_LIMIT) {
    throw new Error(`工作日数量必须在 -${WORKDAY_AMOUNT_LIMIT}..${WORKDAY_AMOUNT_LIMIT} 之间`)
  }
  const Temporal = await getTemporal()
  let date: PolyfillTemporal.PlainDate
  try {
    date = Temporal.PlainDate.from(input.startDate.trim())
  } catch {
    throw new Error('起始日期格式无效')
  }
  const holidays = normalizedDateSet(input.holidays, '节假日')
  const workdays = normalizedDateSet(input.workdays, '补班日')
  const direction = input.amount < 0 ? -1 : 1
  let remaining = Math.abs(input.amount)
  let traversedDays = 0
  const holidaysUsed = new Set<string>()
  const workdaysUsed = new Set<string>()

  while (remaining > 0) {
    date = date.add({ days: direction })
    traversedDays += direction
    const key = date.toString()
    const forcedWorkday = workdays.has(key)
    const holiday = holidays.has(key)
    const weekday = date.dayOfWeek >= 1 && date.dayOfWeek <= 5
    if (forcedWorkday) workdaysUsed.add(key)
    if (holiday) holidaysUsed.add(key)
    if (forcedWorkday || (weekday && !holiday)) remaining -= 1
  }

  return {
    date: date.toString(),
    traversedDays,
    holidaysUsed: [...holidaysUsed],
    workdaysUsed: [...workdaysUsed],
  }
}

const chineseWeekdays: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
}

const englishWeekdays: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
}

function nextNaturalWeekDate(
  date: PolyfillTemporal.PlainDate,
  targetDayOfWeek: number,
): PolyfillTemporal.PlainDate {
  return date.add({ days: 8 - date.dayOfWeek + targetDayOfWeek - 1 })
}

function parseChineseClock(value: string): { hour: number; minute: number } | null {
  const match = /^(上午|下午|晚上)?\s*(\d{1,2})(?:\s*(点|:|：)\s*(\d{1,2})?)?\s*(?:分)?$/.exec(value.trim())
  if (!match) return null
  if (!match[1] && !match[3]) return null
  let hour = Number(match[2])
  const minute = Number(match[4] ?? 0)
  const period = match[1]
  if (period && (hour < 1 || hour > 12)) return null
  if (period === '下午' || period === '晚上') hour = hour === 12 ? 12 : hour + 12
  if (period === '上午' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function parseEnglishClock(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(value.trim())
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (hour < 1 || hour > 12 || minute > 59) return null
  if (match[3]?.toLowerCase() === 'pm') hour = hour === 12 ? 12 : hour + 12
  if (match[3]?.toLowerCase() === 'am' && hour === 12) hour = 0
  return { hour, minute }
}

export async function parseNaturalLanguage(input: NaturalLanguageInput): Promise<NaturalLanguageResult> {
  assertTimeText(input.expression, '自然语言表达式')
  assertTimeZone(input.timeZone)
  const expression = input.expression.trim()
  if (!expression) throw new Error('请输入自然语言时间')
  if (/\b\d{1,2}\/\d{1,2}\b/.test(expression)) {
    throw new Error('日期写法存在歧义，请改用 YYYY-MM-DD 明确格式')
  }
  const Temporal = await getTemporal()
  const baseInstant = input.baseInstant ? Temporal.Instant.from(input.baseInstant) : Temporal.Now.instant()
  const base = baseInstant.toZonedDateTimeISO(input.timeZone)
  const normalized = expression.toLowerCase().replace(/\s+/g, ' ').trim()

  let direct: PolyfillTemporal.ZonedDateTime | undefined
  let targetDate: PolyfillTemporal.PlainDate | undefined
  let remainingClock = ''

  let match = /^(\d+)\s*(天|小时|分钟)后$/.exec(normalized)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2]
    direct = base.add(unit === '天' ? { days: amount } : unit === '小时' ? { hours: amount } : { minutes: amount })
  }

  if (!direct) {
    match = /^in (\d+) (days?|hours?|minutes?)$/.exec(normalized)
    if (match) {
      const amount = Number(match[1])
      const unit = match[2] ?? ''
      direct = base.add(unit.startsWith('day') ? { days: amount } : unit.startsWith('hour') ? { hours: amount } : { minutes: amount })
    }
  }

  if (!direct) {
    const chineseBase = /^(今天|明天|后天|下周[一二三四五六日天])/.exec(normalized)
    if (chineseBase) {
      const token = chineseBase[1] ?? ''
      if (token === '今天') targetDate = base.toPlainDate()
      else if (token === '明天') targetDate = base.toPlainDate().add({ days: 1 })
      else if (token === '后天') targetDate = base.toPlainDate().add({ days: 2 })
      else targetDate = nextNaturalWeekDate(base.toPlainDate(), chineseWeekdays[token.slice(-1)] ?? 1)
      remainingClock = normalized.slice(chineseBase[0].length).trim()
    } else {
      const englishBase = /^(today|tomorrow|next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/.exec(normalized)
      if (englishBase) {
        const token = englishBase[1] ?? ''
        if (token === 'today') targetDate = base.toPlainDate()
        else if (token === 'tomorrow') targetDate = base.toPlainDate().add({ days: 1 })
        else targetDate = nextNaturalWeekDate(base.toPlainDate(), englishWeekdays[token.slice(5)] ?? 1)
        remainingClock = normalized.slice(englishBase[0].length).trim()
      }
    }
  }

  if (!direct && !targetDate) {
    const chineseClock = parseChineseClock(normalized)
    const englishClock = parseEnglishClock(normalized)
    if (chineseClock || englishClock) {
      targetDate = base.toPlainDate()
      remainingClock = normalized
    }
  }

  if (direct) {
    return {
      status: 'resolved',
      value: await snapshotFromInstant(direct.toInstant(), input.timeZone),
      base: await snapshotFromInstant(baseInstant, input.timeZone),
      normalized,
    }
  }

  if (!targetDate) throw new Error('暂不支持该表达式')
  const clock = remainingClock
    ? parseChineseClock(remainingClock) ?? parseEnglishClock(remainingClock)
    : { hour: 0, minute: 0 }
  if (!clock) throw new Error('暂不支持该表达式')
  const plain = targetDate.toPlainDateTime({ hour: clock.hour, minute: clock.minute })
  const resolved = await resolvePlainDateTime(plain, input.timeZone, input.resolution)
  if (resolved.status === 'resolution_required') return resolved
  return {
    ...resolved,
    base: await snapshotFromInstant(baseInstant, input.timeZone),
    normalized,
  }
}

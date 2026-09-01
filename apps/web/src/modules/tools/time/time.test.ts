import { describe, expect, it } from 'vitest'

import { previewCron, validateCronExpression } from './cron'
import {
  addWorkdays,
  convertTime,
  parseNaturalLanguage,
  WORKDAY_AMOUNT_LIMIT,
} from './time'

describe('time conversion and DST boundaries', () => {
  it('converts Unix seconds, milliseconds and ISO using the selected IANA zone', async () => {
    const seconds = await convertTime({ kind: 'unix_seconds', value: '0', timeZone: 'Asia/Shanghai' })
    const milliseconds = await convertTime({ kind: 'unix_milliseconds', value: '0', timeZone: 'Asia/Shanghai' })
    const iso = await convertTime({ kind: 'iso', value: '1970-01-01T00:00:00Z', timeZone: 'Asia/Shanghai' })

    expect(seconds).toMatchObject({ status: 'resolved', value: { unixSeconds: '0', unixMilliseconds: '0', offset: '+08:00' } })
    expect(milliseconds).toEqual(seconds)
    expect(iso).toEqual(seconds)
  })

  it('requires an explicit decision for nonexistent and repeated local times', async () => {
    const nonexistent = await convertTime({ kind: 'local', value: '2024-03-10T02:30:00', timeZone: 'America/New_York' })
    const repeated = await convertTime({ kind: 'local', value: '2024-11-03T01:30:00', timeZone: 'America/New_York' })
    expect(nonexistent).toMatchObject({ status: 'resolution_required', kind: 'nonexistent' })
    expect(repeated).toMatchObject({ status: 'resolution_required', kind: 'repeated' })

    const earlier = await convertTime({ kind: 'local', value: '2024-11-03T01:30:00', timeZone: 'America/New_York', resolution: 'earlier' })
    const later = await convertTime({ kind: 'local', value: '2024-11-03T01:30:00', timeZone: 'America/New_York', resolution: 'later' })
    expect(earlier.status === 'resolved' && earlier.value.offset).toBe('-04:00')
    expect(later.status === 'resolved' && later.value.offset).toBe('-05:00')
  })
})

describe('frozen natural language grammar', () => {
  const baseInstant = '2026-08-31T02:30:00Z'

  it.each([
    ['明天下午 3 点', '2026-09-01T15:00:00+08:00[Asia/Shanghai]'],
    ['tomorrow 3pm', '2026-09-01T15:00:00+08:00[Asia/Shanghai]'],
    ['下周一', '2026-09-07T00:00:00+08:00[Asia/Shanghai]'],
    ['next monday', '2026-09-07T00:00:00+08:00[Asia/Shanghai]'],
  ])('parses %s deterministically', async (expression, expected) => {
    const result = await parseNaturalLanguage({ expression, timeZone: 'Asia/Shanghai', baseInstant })
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.value.zoned).toBe(expected)
  })

  it('handles fixed relative amounts from the visible base', async () => {
    const result = await parseNaturalLanguage({ expression: '3 天后', timeZone: 'Asia/Shanghai', baseInstant })
    expect(result.status === 'resolved' && result.value.zoned).toBe('2026-09-03T10:30:00+08:00[Asia/Shanghai]')
  })

  it('rejects ambiguous and unsupported expressions instead of guessing', async () => {
    await expect(parseNaturalLanguage({ expression: '03/04', timeZone: 'UTC', baseInstant })).rejects.toThrow('歧义')
    await expect(parseNaturalLanguage({ expression: '月底最后一天', timeZone: 'UTC', baseInstant })).rejects.toThrow('暂不支持')
  })
})

describe('workdays and Cron dialects', () => {
  it.each([-WORKDAY_AMOUNT_LIMIT, 0, WORKDAY_AMOUNT_LIMIT])('accepts the bounded workday amount %i', async (amount) => {
    await expect(addWorkdays({ startDate: '2026-08-31', amount, holidays: [], workdays: [] })).resolves.toMatchObject({
      date: expect.any(String),
    })
  })

  it.each([-WORKDAY_AMOUNT_LIMIT - 1, WORKDAY_AMOUNT_LIMIT + 1])('rejects the out-of-range workday amount %i', async (amount) => {
    await expect(addWorkdays({ startDate: '2026-08-31', amount, holidays: [], workdays: [] })).rejects.toThrow('-1000..1000')
  })

  it('uses explicit holidays and makeup workdays without a network calendar', async () => {
    const result = await addWorkdays({
      startDate: '2026-10-01',
      amount: 2,
      holidays: ['2026-10-02'],
      workdays: ['2026-10-03'],
    })
    expect(result.date).toBe('2026-10-05')
    expect(result.holidaysUsed).toContain('2026-10-02')
    expect(result.workdaysUsed).toContain('2026-10-03')
  })

  it('supports negative movement and lets a makeup workday override a holiday', async () => {
    const backwards = await addWorkdays({ startDate: '2026-09-07', amount: -1, holidays: [], workdays: [] })
    const override = await addWorkdays({
      startDate: '2026-10-01',
      amount: 1,
      holidays: ['2026-10-02'],
      workdays: ['2026-10-02'],
    })

    expect(backwards.date).toBe('2026-09-04')
    expect(override.date).toBe('2026-10-02')
    expect(override.holidaysUsed).toContain('2026-10-02')
    expect(override.workdaysUsed).toContain('2026-10-02')
  })

  it('previews exactly five Unix and strict six/seven field runs', () => {
    const unix = previewCron({ dialect: 'unix', expression: '0 9 * * 1-5', timeZone: 'UTC', baseTime: '2026-08-31T00:00:00Z' })
    const six = previewCron({ dialect: 'spring_quartz', expression: '0 0 9 * * MON-FRI', timeZone: 'UTC', baseTime: '2026-08-31T00:00:00Z' })
    const seven = previewCron({ dialect: 'spring_quartz', expression: '0 0 9 * * MON-FRI 2026', timeZone: 'UTC', baseTime: '2026-08-31T00:00:00Z' })
    expect(unix.nextRuns).toHaveLength(5)
    expect(six.nextRuns).toHaveLength(5)
    expect(seven.nextRuns).toHaveLength(5)
  })

  it('rejects field count, strict question-mark semantics, and concrete DOM+DOW', () => {
    expect(() => validateCronExpression({ dialect: 'unix', expression: '0 0 9 * * *', timeZone: 'UTC' })).toThrow('恰好 5 段')
    expect(() => validateCronExpression({ dialect: 'spring_quartz', expression: '0 0 9 ? * MON', timeZone: 'UTC' })).toThrow('无法')
    expect(() => validateCronExpression({ dialect: 'spring_quartz', expression: '0 0 9 1 * MON', timeZone: 'UTC' })).toThrow('同时具体指定')
  })
})

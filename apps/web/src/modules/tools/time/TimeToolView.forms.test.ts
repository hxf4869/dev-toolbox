import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addWorkdays,
  calculateDate,
  differenceBetweenDates,
  parseNaturalLanguage,
  type DateDifferenceResult,
  type NaturalLanguageResult,
  type ResolutionRequired,
  type TimeResolutionResult,
  type TimeSnapshot,
  type WorkdayResult,
} from './time'
import TimeToolView from './TimeToolView.vue'

vi.mock('./time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./time')>()
  return {
    ...actual,
    calculateDate: vi.fn(actual.calculateDate),
    differenceBetweenDates: vi.fn(actual.differenceBetweenDates),
    addWorkdays: vi.fn(actual.addWorkdays),
    parseNaturalLanguage: vi.fn(actual.parseNaturalLanguage),
  }
})

async function commitTimeZone(wrapper: VueWrapper, zone: string) {
  const input = wrapper.get('#time-zone')
  await input.setValue(zone)
  await input.trigger('keydown', { key: 'Enter' })
  await flushPromises()
}

function primaryButton(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('button.button--primary').find((item) => item.text() === label)
  expect(button).toBeDefined()
  return button!
}

function tabButton(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('.tool-tabs button').find((item) => item.text() === label)
  expect(button).toBeDefined()
  return button!
}

function staleUnixSnapshot(): TimeSnapshot {
  return {
    unixSeconds: '0',
    unixMilliseconds: '0',
    iso: '1970-01-01T00:00:00Z',
    utc: '1970-01-01T00:00:00+00:00[UTC]',
    local: '1970-01-01T00:00:00+00:00[UTC]',
    zoned: '1970-01-01T00:00:00+00:00[UTC]',
    offset: '+00:00',
    timeZone: 'UTC',
  }
}

function naturalGapResolution(): ResolutionRequired {
  return {
    status: 'resolution_required',
    kind: 'nonexistent',
    message: '该本地时间处于夏令时跳变缺口，请明确选择向前或向后调整。',
    earlier: '2026-03-08T01:30:00-05:00[America/New_York]',
    later: '2026-03-08T03:30:00-04:00[America/New_York]',
  }
}

beforeAll(async () => {
  // 预热 @js-temporal/polyfill 的首次动态导入：首个真实计算断言不依赖模块加载的 macrotask 时序（同 R265）。
  await calculateDate({
    localDateTime: '2026-01-01T00:00:00',
    timeZone: 'UTC',
    direction: 1,
    values: { years: 0, months: 0, days: 1, hours: 0, minutes: 0, seconds: 0 },
  })
  await differenceBetweenDates({ from: '2026-01-01T00:00:00', to: '2026-01-02T00:00:00', timeZone: 'UTC' })
  await addWorkdays({ startDate: '2026-01-01', amount: 1, holidays: [], workdays: [] })
  await parseNaturalLanguage({ expression: '明天', timeZone: 'UTC' })
})

beforeEach(() => {
  vi.mocked(calculateDate).mockClear()
  vi.mocked(differenceBetweenDates).mockClear()
  vi.mocked(addWorkdays).mockClear()
  vi.mocked(parseNaturalLanguage).mockClear()
})

describe('TimeToolView form result attribution', () => {
  it('clears a completed date calculation when a duration field changes and does not recompute', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '日期计算').trigger('click')
    await wrapper.get('#calculation-start-date').setValue('2026-10-26')
    await wrapper.get('#calculation-start-time').setValue('09:00:00')
    await primaryButton(wrapper, '计算日期').trigger('click')
    await flushPromises()

    expect(vi.mocked(calculateDate)).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.result-list').text()).toContain('2026-10-27T09:00:00')
    const timeElement = wrapper.get('#calculation-start-time').element

    await wrapper.findAll('input[type="number"]')[2]!.setValue('2')

    expect(wrapper.find('.result-list').exists()).toBe(false)
    expect(wrapper.get('#calculation-start-time').element).toBe(timeElement)
    expect((wrapper.get('#calculation-start-time').element as HTMLInputElement).value).toBe('09:00:00')
    expect(vi.mocked(calculateDate)).toHaveBeenCalledTimes(1)

    await wrapper.get('select').setValue('-1')
    await flushPromises()
    expect(wrapper.find('.result-list').exists()).toBe(false)
    expect(vi.mocked(calculateDate)).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('removes a pending calculation DST resolution when the start changes', async () => {
    const wrapper = mount(TimeToolView)
    await commitTimeZone(wrapper, 'America/New_York')
    await tabButton(wrapper, '日期计算').trigger('click')
    await wrapper.get('#calculation-start-date').setValue('2026-03-08')
    await wrapper.get('#calculation-start-time').setValue('02:30:00')
    await primaryButton(wrapper, '计算日期').trigger('click')
    await flushPromises()
    expect(wrapper.find('.resolution-box').exists()).toBe(true)

    await wrapper.get('#calculation-start-time').setValue('12:00:00')

    expect(wrapper.find('.resolution-box').exists()).toBe(false)
    expect(wrapper.find('.result-list').exists()).toBe(false)
    wrapper.unmount()
  })

  it('discards a late calculation result after the start changed and lets the new request succeed', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '日期计算').trigger('click')
    await wrapper.get('#calculation-start-date').setValue('2026-10-26')
    await wrapper.get('#calculation-start-time').setValue('09:00:00')
    let resolveCalculation!: (value: TimeResolutionResult) => void
    const pending = new Promise<TimeResolutionResult>((resolve) => {
      resolveCalculation = resolve
    })
    vi.mocked(calculateDate).mockImplementationOnce(() => pending)

    await primaryButton(wrapper, '计算日期').trigger('click')
    await flushPromises()
    expect(vi.mocked(calculateDate)).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.result-list').exists()).toBe(false)

    await wrapper.get('#calculation-start-time').setValue('10:00:00')
    resolveCalculation({ status: 'resolved', value: staleUnixSnapshot() })
    await flushPromises()

    expect(wrapper.find('.result-list').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('1970-01-01')
    expect(wrapper.find('.error-summary').exists()).toBe(false)

    await primaryButton(wrapper, '计算日期').trigger('click')
    await flushPromises()

    expect(vi.mocked(calculateDate)).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.result-list').text()).toContain('2026-10-27T10:00:00')
    wrapper.unmount()
  })

  it('clears a completed difference when an endpoint changes and does not recompute', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '日期计算').trigger('click')
    await wrapper.get('#difference-from-date').setValue('2026-10-26')
    await wrapper.get('#difference-from-time').setValue('09:00:00')
    await wrapper.get('#difference-to-date').setValue('2026-10-26')
    await wrapper.get('#difference-to-time').setValue('10:00:00')
    await primaryButton(wrapper, '计算时间差').trigger('click')
    await flushPromises()

    expect(vi.mocked(differenceBetweenDates)).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.result-list').text()).toContain('PT1H')
    expect(wrapper.get('.result-list').text()).toContain('3600')

    await wrapper.get('#difference-to-time').setValue('11:00:00')

    expect(wrapper.find('.result-list').exists()).toBe(false)
    expect(vi.mocked(differenceBetweenDates)).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('removes a pending difference DST resolution when the from endpoint changes', async () => {
    const wrapper = mount(TimeToolView)
    await commitTimeZone(wrapper, 'America/New_York')
    await tabButton(wrapper, '日期计算').trigger('click')
    await wrapper.get('#difference-from-date').setValue('2026-03-08')
    await wrapper.get('#difference-from-time').setValue('02:30:00')
    await wrapper.get('#difference-to-date').setValue('2026-03-08')
    await wrapper.get('#difference-to-time').setValue('12:00:00')
    await primaryButton(wrapper, '计算时间差').trigger('click')
    await flushPromises()
    expect(wrapper.find('.resolution-box').exists()).toBe(true)

    await wrapper.get('#difference-from-time').setValue('09:00:00')

    expect(wrapper.find('.resolution-box').exists()).toBe(false)
    expect(wrapper.find('.result-list').exists()).toBe(false)
    wrapper.unmount()
  })

  it('discards a late difference result after an endpoint changed and lets the new request succeed', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '日期计算').trigger('click')
    await wrapper.get('#difference-from-date').setValue('2026-10-26')
    await wrapper.get('#difference-from-time').setValue('09:00:00')
    await wrapper.get('#difference-to-date').setValue('2026-10-26')
    await wrapper.get('#difference-to-time').setValue('10:00:00')
    let resolveDifference!: (value: Awaited<ReturnType<typeof differenceBetweenDates>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof differenceBetweenDates>>>((resolve) => {
      resolveDifference = resolve
    })
    vi.mocked(differenceBetweenDates).mockImplementationOnce(() => pending)

    await primaryButton(wrapper, '计算时间差').trigger('click')
    await flushPromises()
    expect(vi.mocked(differenceBetweenDates)).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.result-list').exists()).toBe(false)

    await wrapper.get('#difference-to-time').setValue('11:00:00')
    const staleDifference: DateDifferenceResult = {
      from: staleUnixSnapshot(),
      to: staleUnixSnapshot(),
      duration: 'PT1H',
      totalSeconds: '3600',
    }
    resolveDifference(staleDifference)
    await flushPromises()

    expect(wrapper.find('.result-list').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('1970-01-01')
    expect(wrapper.find('.error-summary').exists()).toBe(false)

    await primaryButton(wrapper, '计算时间差').trigger('click')
    await flushPromises()

    expect(vi.mocked(differenceBetweenDates)).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.result-list').text()).toContain('PT2H')
    expect(wrapper.get('.result-list').text()).toContain('7200')
    wrapper.unmount()
  })

  it('clears a completed workday result and its copy entry when the amount changes and does not recompute', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '工作日').trigger('click')
    await wrapper.get('input[type="date"]').setValue('2026-10-26')
    await wrapper.get('#workday-amount').setValue('1')
    await primaryButton(wrapper, '计算工作日').trigger('click')
    await flushPromises()

    expect(vi.mocked(addWorkdays)).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.large-result').text()).toContain('2026-10-27')
    expect(wrapper.get('.large-result').text()).toContain('复制日期')

    await wrapper.get('#workday-amount').setValue('2')

    expect(wrapper.find('.large-result').exists()).toBe(false)
    expect(wrapper.get('.result-card').text()).toContain('计算后在此显示。')
    expect(vi.mocked(addWorkdays)).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('clears a workday error when the inputs change', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '工作日').trigger('click')
    await wrapper.get('#holiday-input').setValue('not-a-date')
    await primaryButton(wrapper, '计算工作日').trigger('click')
    await flushPromises()
    expect(wrapper.get('.error-summary').text()).toContain('节假日包含无效日期：not-a-date')

    await wrapper.get('#workday-amount').setValue('2')

    expect(wrapper.find('.error-summary').exists()).toBe(false)
    expect(wrapper.find('.large-result').exists()).toBe(false)
    wrapper.unmount()
  })

  it('discards a late workday result after the amount changed and lets the new request succeed', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '工作日').trigger('click')
    await wrapper.get('input[type="date"]').setValue('2026-10-26')
    await wrapper.get('#workday-amount').setValue('1')
    let resolveWorkday!: (value: WorkdayResult) => void
    const pending = new Promise<WorkdayResult>((resolve) => {
      resolveWorkday = resolve
    })
    vi.mocked(addWorkdays).mockImplementationOnce(() => pending)

    await primaryButton(wrapper, '计算工作日').trigger('click')
    await flushPromises()
    expect(vi.mocked(addWorkdays)).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.large-result').exists()).toBe(false)

    await wrapper.get('#workday-amount').setValue('2')
    resolveWorkday({ date: '2026-10-27', traversedDays: 1, holidaysUsed: [], workdaysUsed: [] })
    await flushPromises()

    expect(wrapper.find('.large-result').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('2026-10-27')
    expect(wrapper.find('.error-summary').exists()).toBe(false)

    await primaryButton(wrapper, '计算工作日').trigger('click')
    await flushPromises()

    expect(vi.mocked(addWorkdays)).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.large-result').text()).toContain('2026-10-28')
    wrapper.unmount()
  })

  it('discards a late workday error after the amount changed and lets the new request succeed', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '工作日').trigger('click')
    await wrapper.get('input[type="date"]').setValue('2026-10-26')
    await wrapper.get('#workday-amount').setValue('1')
    let rejectWorkday!: (error: Error) => void
    const pending = new Promise<WorkdayResult>((_, reject) => {
      rejectWorkday = reject
    })
    vi.mocked(addWorkdays).mockImplementationOnce(() => pending)

    await primaryButton(wrapper, '计算工作日').trigger('click')
    await flushPromises()
    expect(vi.mocked(addWorkdays)).toHaveBeenCalledTimes(1)

    await wrapper.get('#workday-amount').setValue('2')
    rejectWorkday(new Error('旧工作日错误'))
    await flushPromises()

    expect(wrapper.find('.error-summary').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('旧工作日错误')

    await primaryButton(wrapper, '计算工作日').trigger('click')
    await flushPromises()

    expect(wrapper.get('.large-result').text()).toContain('2026-10-28')
    wrapper.unmount()
  })

  it('clears a completed cron preview when the expression changes and does not recompute', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, 'Cron').trigger('click')
    await wrapper.get('.cron-meta input').setValue('2026-10-26T00:00:00Z')
    await wrapper.get('#cron-expression').setValue('0 9 * * *')
    await wrapper.get('.cron-input-card .button--primary').trigger('click')
    expect(wrapper.find('.run-list').exists()).toBe(true)
    // run.zoned 为本地化展示（如 2026/10/26 GMT+8 09:00:00），以本地 09:00:00 作为时区无关断言。
    expect(wrapper.find('.run-list').text()).toContain('09:00:00')

    await wrapper.get('#cron-expression').setValue('0 10 * * *')

    expect(wrapper.find('.run-list').exists()).toBe(false)
    expect(wrapper.find('.workspace-grid').exists()).toBe(false)
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    wrapper.unmount()
  })

  it('clears a cron preview and error when the base time changes', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, 'Cron').trigger('click')
    await wrapper.get('.cron-input-card .button--primary').trigger('click')
    expect(wrapper.find('.run-list').exists()).toBe(true)

    await wrapper.get('.cron-meta input').setValue('not-a-date')

    expect(wrapper.find('.run-list').exists()).toBe(false)
    expect(wrapper.find('.error-summary').exists()).toBe(false)

    await wrapper.get('.cron-input-card .button--primary').trigger('click')
    expect(wrapper.get('.error-summary').text()).toContain('基准时间格式无效')

    await wrapper.get('#cron-expression').setValue('0 10 * * *')

    expect(wrapper.find('.error-summary').exists()).toBe(false)
    expect(wrapper.find('.run-list').exists()).toBe(false)
    wrapper.unmount()
  })

  it('clears a completed natural language result when the expression changes and does not recompute', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '自然语言').trigger('click')
    await wrapper.get('#natural-expression').setValue('明天')
    await primaryButton(wrapper, '解析表达式').trigger('click')
    await flushPromises()

    expect(vi.mocked(parseNaturalLanguage)).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.large-result').text()).toContain('规范表达')
    expect(wrapper.get('.large-result').text()).toContain('明天')

    await wrapper.get('#natural-expression').setValue('后天')

    expect(wrapper.find('.large-result').exists()).toBe(false)
    expect(wrapper.get('.result-card').text()).toContain('解析后在此显示')
    expect(vi.mocked(parseNaturalLanguage)).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('removes a pending natural language DST resolution when the expression changes', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '自然语言').trigger('click')
    let resolveNatural!: (value: NaturalLanguageResult) => void
    const pending = new Promise<NaturalLanguageResult>((resolve) => {
      resolveNatural = resolve
    })
    vi.mocked(parseNaturalLanguage).mockImplementationOnce(() => pending)

    await wrapper.get('#natural-expression').setValue('明天')
    await primaryButton(wrapper, '解析表达式').trigger('click')
    await flushPromises()
    expect(vi.mocked(parseNaturalLanguage)).toHaveBeenCalledTimes(1)

    resolveNatural(naturalGapResolution())
    await flushPromises()
    expect(wrapper.find('.resolution-box').exists()).toBe(true)

    await wrapper.get('#natural-expression').setValue('后天')

    expect(wrapper.find('.resolution-box').exists()).toBe(false)
    expect(wrapper.find('.large-result').exists()).toBe(false)
    wrapper.unmount()
  })

  it('discards a late natural language resolution after the expression changed and lets the new request succeed', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '自然语言').trigger('click')
    let resolveNatural!: (value: NaturalLanguageResult) => void
    const pending = new Promise<NaturalLanguageResult>((resolve) => {
      resolveNatural = resolve
    })
    vi.mocked(parseNaturalLanguage).mockImplementationOnce(() => pending)

    await wrapper.get('#natural-expression').setValue('明天')
    await primaryButton(wrapper, '解析表达式').trigger('click')
    await flushPromises()
    expect(vi.mocked(parseNaturalLanguage)).toHaveBeenCalledTimes(1)

    await wrapper.get('#natural-expression').setValue('后天')
    resolveNatural(naturalGapResolution())
    await flushPromises()

    expect(wrapper.find('.resolution-box').exists()).toBe(false)
    expect(wrapper.find('.large-result').exists()).toBe(false)
    expect(wrapper.find('.error-summary').exists()).toBe(false)

    await primaryButton(wrapper, '解析表达式').trigger('click')
    await flushPromises()

    expect(vi.mocked(parseNaturalLanguage)).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.large-result').text()).toContain('后天')
    wrapper.unmount()
  })

  it('keeps an in-flight difference result usable while another form input changes', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '日期计算').trigger('click')
    await wrapper.get('#difference-from-date').setValue('2026-10-26')
    await wrapper.get('#difference-from-time').setValue('09:00:00')
    await wrapper.get('#difference-to-date').setValue('2026-10-26')
    await wrapper.get('#difference-to-time').setValue('10:00:00')
    let resolveDifference!: (value: Awaited<ReturnType<typeof differenceBetweenDates>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof differenceBetweenDates>>>((resolve) => {
      resolveDifference = resolve
    })
    vi.mocked(differenceBetweenDates).mockImplementationOnce(() => pending)

    await primaryButton(wrapper, '计算时间差').trigger('click')
    await flushPromises()

    await tabButton(wrapper, '工作日').trigger('click')
    await wrapper.get('#workday-amount').setValue('3')
    await tabButton(wrapper, '日期计算').trigger('click')

    resolveDifference({
      from: staleUnixSnapshot(),
      to: staleUnixSnapshot(),
      duration: 'PT1H',
      totalSeconds: '3600',
    })
    await flushPromises()

    expect(wrapper.get('.result-list').text()).toContain('PT1H')
    wrapper.unmount()
  })

  it('applies a workday result that resolves after a timezone commit', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '工作日').trigger('click')
    await wrapper.get('input[type="date"]').setValue('2026-10-26')
    await wrapper.get('#workday-amount').setValue('1')
    let resolveWorkday!: (value: WorkdayResult) => void
    const pending = new Promise<WorkdayResult>((resolve) => {
      resolveWorkday = resolve
    })
    vi.mocked(addWorkdays).mockImplementationOnce(() => pending)

    await primaryButton(wrapper, '计算工作日').trigger('click')
    await flushPromises()

    await commitTimeZone(wrapper, 'Asia/Tokyo')
    resolveWorkday({ date: '2026-10-27', traversedDays: 1, holidaysUsed: [], workdaysUsed: [] })
    await flushPromises()

    expect(wrapper.get('.large-result').text()).toContain('2026-10-27')
    wrapper.unmount()
  })

  it('keeps a completed difference result while the timezone combobox has uncommitted draft input', async () => {
    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '日期计算').trigger('click')
    await wrapper.get('#difference-from-date').setValue('2026-10-26')
    await wrapper.get('#difference-from-time').setValue('09:00:00')
    await wrapper.get('#difference-to-date').setValue('2026-10-26')
    await wrapper.get('#difference-to-time').setValue('10:00:00')
    await primaryButton(wrapper, '计算时间差').trigger('click')
    await flushPromises()
    expect(wrapper.get('.result-list').text()).toContain('PT1H')

    await wrapper.get('#time-zone').setValue('Asia/Tokyo')

    expect(wrapper.get('.result-list').text()).toContain('PT1H')
    expect(wrapper.text()).not.toContain('已失效')
    wrapper.unmount()
  })
})

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'

import { convertTime, type TimeResolutionResult, type TimeSnapshot } from './time'
import TimeToolView from './TimeToolView.vue'

vi.mock('./time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./time')>()
  return { ...actual, convertTime: vi.fn(actual.convertTime) }
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

beforeEach(() => {
  vi.mocked(convertTime).mockClear()
})

describe('TimeToolView timezone switching', () => {
  it('clears completed cron results after the timezone changes and asks to re-run', async () => {
    const wrapper = mount(TimeToolView)
    await commitTimeZone(wrapper, 'America/New_York')

    await tabButton(wrapper, 'Cron').trigger('click')
    await wrapper.get('.cron-input-card .button--primary').trigger('click')
    expect(wrapper.find('.run-list').exists()).toBe(true)

    await commitTimeZone(wrapper, 'Asia/Tokyo')

    expect(wrapper.find('.run-list').exists()).toBe(false)
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    expect(wrapper.text()).toContain('已失效')
    expect(wrapper.text()).toContain('请重新执行')
    wrapper.unmount()
  })

  it('clears a pending DST resolution on the convert tab after the timezone changes', async () => {
    const wrapper = mount(TimeToolView)
    await commitTimeZone(wrapper, 'America/New_York')

    await wrapper.get('#conversion-kind').setValue('local')
    await wrapper.get('#conversion-input').setValue('2026-03-08T02:30:00')
    await primaryButton(wrapper, '转换时间').trigger('click')
    await flushPromises()

    expect(wrapper.find('.resolution-box').exists()).toBe(true)
    expect(wrapper.text()).toContain('夏令时')
    expect(wrapper.get('.result-card').text()).toContain('转换后在此显示。')

    await commitTimeZone(wrapper, 'Asia/Tokyo')

    expect(wrapper.find('.resolution-box').exists()).toBe(false)
    expect(wrapper.get('.result-card').text()).toContain('转换后在此显示。')
    wrapper.unmount()
  })

  it('clears a pending DST resolution on the difference tab after the timezone changes', async () => {
    const wrapper = mount(TimeToolView)
    await commitTimeZone(wrapper, 'America/New_York')

    await tabButton(wrapper, '日期计算').trigger('click')
    await wrapper.get('#difference-from-date').setValue('2026-03-08')
    await wrapper.get('#difference-from-time').setValue('02:30:00')
    await primaryButton(wrapper, '计算时间差').trigger('click')
    await flushPromises()

    expect(wrapper.find('.resolution-box').exists()).toBe(true)

    await commitTimeZone(wrapper, 'Asia/Tokyo')

    expect(wrapper.find('.resolution-box').exists()).toBe(false)
    expect(wrapper.find('.result-list').exists()).toBe(false)
    wrapper.unmount()
  })

  it('drops a conversion started before the timezone switch when it resolves late', async () => {
    const wrapper = mount(TimeToolView)
    await commitTimeZone(wrapper, 'America/New_York')

    let resolveConversion!: (value: TimeResolutionResult) => void
    const pending = new Promise<TimeResolutionResult>((resolve) => {
      resolveConversion = resolve
    })
    vi.mocked(convertTime).mockImplementationOnce(() => pending)

    await primaryButton(wrapper, '转换时间').trigger('click')
    await flushPromises()
    expect(vi.mocked(convertTime)).toHaveBeenCalledTimes(1)

    await commitTimeZone(wrapper, 'Asia/Tokyo')

    const staleSnapshot: TimeSnapshot = {
      unixSeconds: '1772959800',
      unixMilliseconds: '1772959800000',
      iso: '2026-03-08T07:30:00Z',
      utc: '2026-03-08T07:30:00+00:00[UTC]',
      local: '2026-03-08T15:30:00+08:00[Asia/Shanghai]',
      zoned: '2026-03-08T02:30:00-05:00[America/New_York]',
      offset: '-05:00',
      timeZone: 'America/New_York',
    }
    resolveConversion({ status: 'resolved', value: staleSnapshot })
    await flushPromises()

    expect(wrapper.get('.result-card').text()).toContain('转换后在此显示。')
    expect(wrapper.text()).not.toContain(staleSnapshot.zoned)
    expect(wrapper.find('.error-summary').exists()).toBe(false)
    wrapper.unmount()
  })

  it('refreshes the clock to the new timezone immediately after the timezone changes', async () => {
    const wrapper = mount(TimeToolView)
    await commitTimeZone(wrapper, 'America/New_York')
    await flushPromises()

    await commitTimeZone(wrapper, 'Asia/Tokyo')

    expect(wrapper.text()).toContain('[Asia/Tokyo]')
    expect(wrapper.text()).not.toContain('[America/New_York]')
    wrapper.unmount()
  })

  it('keeps timezone-independent workday results after the timezone changes', async () => {
    const wrapper = mount(TimeToolView)
    await commitTimeZone(wrapper, 'America/New_York')

    await tabButton(wrapper, '工作日').trigger('click')
    await primaryButton(wrapper, '计算工作日').trigger('click')
    await flushPromises()
    expect(wrapper.find('.large-result').exists()).toBe(true)

    await commitTimeZone(wrapper, 'Asia/Tokyo')

    expect(wrapper.find('.large-result').exists()).toBe(true)
    wrapper.unmount()
  })
})

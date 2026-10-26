import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addWorkdays } from './time'
import TimeToolView from './TimeToolView.vue'

// 只透传 spy addWorkdays：断言页面实际提交的起始日期；其余时间换算保留真实实现。
vi.mock('./time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./time')>()
  return { ...actual, addWorkdays: vi.fn(actual.addWorkdays) }
})

// 组件默认值在 setup 同步读取 new Date() 的本地日历，进程时区与固定时刻必须在挂载前生效。
// 只伪造 Date 不伪造定时器：flushPromises 与 Temporal 动态导入继续走真实宏任务。
function freezeClock(timeZone: string, instant: string) {
  vi.stubEnv('TZ', timeZone)
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(instant) })
}

beforeEach(() => {
  vi.mocked(addWorkdays).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function tabButton(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('.tool-tabs button').find((item) => item.text() === label)
  expect(button).toBeDefined()
  return button!
}

function workdayStartInput(wrapper: VueWrapper) {
  return wrapper.get('input[type="date"]')
}

function workdayStartValue(wrapper: VueWrapper) {
  return (workdayStartInput(wrapper).element as HTMLInputElement).value
}

async function runWorkday(wrapper: VueWrapper) {
  const button = wrapper.findAll('button.button--primary').find((item) => item.text() === '计算工作日')
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}

async function commitTimeZone(wrapper: VueWrapper, zone: string) {
  const input = wrapper.get('#time-zone')
  await input.setValue(zone)
  await input.trigger('keydown', { key: 'Enter' })
  await flushPromises()
}

describe('TimeToolView workday default start date', () => {
  it('defaults to the local calendar day when UTC+8 has already crossed into the next day', async () => {
    // 浏览器 Asia/Shanghai 本地 2026-10-26T06:01+08:00，UTC 日历仍是 10-25（R302 截图场景）。
    freezeClock('Asia/Shanghai', '2026-10-25T22:01:00Z')
    expect(new Date().getTimezoneOffset()).toBe(-480)

    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '工作日').trigger('click')

    expect(workdayStartValue(wrapper)).toBe('2026-10-26')

    await runWorkday(wrapper)

    expect(vi.mocked(addWorkdays)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addWorkdays)).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-10-26' }))
    wrapper.unmount()
  })

  it('defaults to the local calendar day when a negative offset is still on the previous day', async () => {
    // 浏览器 America/New_York 本地 2026-10-25T22:30-04:00，UTC 日历已是 10-26。
    freezeClock('America/New_York', '2026-10-26T02:30:00Z')
    expect(new Date().getTimezoneOffset()).toBe(240)

    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '工作日').trigger('click')

    expect(workdayStartValue(wrapper)).toBe('2026-10-25')

    await runWorkday(wrapper)

    expect(vi.mocked(addWorkdays)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addWorkdays)).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-10-25' }))
    wrapper.unmount()
  })

  it('keeps a manually edited start date across a tab switch and a page timezone commit', async () => {
    freezeClock('Asia/Shanghai', '2026-10-25T22:01:00Z')

    const wrapper = mount(TimeToolView)
    await tabButton(wrapper, '工作日').trigger('click')
    await workdayStartInput(wrapper).setValue('2026-11-03')

    await tabButton(wrapper, 'Cron').trigger('click')
    await tabButton(wrapper, '工作日').trigger('click')
    expect(workdayStartValue(wrapper)).toBe('2026-11-03')

    // 对照：提交页面 IANA 时区后其他结果出现失效提示，但工作日起始日期草稿既不回到默认值也不套用页面时区。
    await commitTimeZone(wrapper, 'America/New_York')

    expect(wrapper.text()).toContain('已失效')
    expect(workdayStartValue(wrapper)).toBe('2026-11-03')

    await runWorkday(wrapper)

    expect(vi.mocked(addWorkdays)).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-11-03' }))
    wrapper.unmount()
  })
})

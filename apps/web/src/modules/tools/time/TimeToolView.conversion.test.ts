import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeAll, vi } from 'vitest'

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

function expectEmptyConversionResult(wrapper: VueWrapper) {
  expect(wrapper.find('.result-list').exists()).toBe(false)
  expect(wrapper.get('.result-card').text()).toContain('转换后在此显示。')
}

function staleUnixZeroSnapshot(): TimeSnapshot {
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

beforeAll(async () => {
  // 预热 @js-temporal/polyfill 的首次动态导入：首个真实转换断言不依赖模块加载的 macrotask 时序。
  await convertTime({ kind: 'unix_seconds', value: '0', timeZone: 'UTC' })
})

beforeEach(() => {
  vi.mocked(convertTime).mockClear()
})

describe('TimeToolView conversion result attribution', () => {
  it('clears a completed conversion result when the input value changes and does not recompute', async () => {
    const wrapper = mount(TimeToolView)
    await wrapper.get('#conversion-kind').setValue('unix_seconds')
    await wrapper.get('#conversion-input').setValue('0')
    await primaryButton(wrapper, '转换时间').trigger('click')
    await flushPromises()

    expect(vi.mocked(convertTime)).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.result-list').text()).toContain('1970-01-01T00:00:00Z')
    const inputElement = wrapper.get('#conversion-input').element

    await wrapper.get('#conversion-input').setValue('1')

    expectEmptyConversionResult(wrapper)
    expect(wrapper.get('#conversion-input').element).toBe(inputElement)
    expect((wrapper.get('#conversion-input').element as HTMLInputElement).value).toBe('1')
    expect(vi.mocked(convertTime)).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('clears a completed conversion result when the input kind changes', async () => {
    const wrapper = mount(TimeToolView)
    await wrapper.get('#conversion-kind').setValue('unix_seconds')
    await wrapper.get('#conversion-input').setValue('0')
    await primaryButton(wrapper, '转换时间').trigger('click')
    await flushPromises()
    expect(wrapper.find('.result-list').exists()).toBe(true)

    await wrapper.get('#conversion-kind').setValue('unix_milliseconds')

    expectEmptyConversionResult(wrapper)
    expect(vi.mocked(convertTime)).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('removes a pending DST resolution when the input value changes', async () => {
    const wrapper = mount(TimeToolView)
    await commitTimeZone(wrapper, 'America/New_York')

    await wrapper.get('#conversion-kind').setValue('local')
    await wrapper.get('#conversion-input').setValue('2026-03-08T02:30:00')
    await primaryButton(wrapper, '转换时间').trigger('click')
    await flushPromises()
    expect(wrapper.find('.resolution-box').exists()).toBe(true)

    await wrapper.get('#conversion-input').setValue('2026-06-01T12:00:00')

    expect(wrapper.find('.resolution-box').exists()).toBe(false)
    expectEmptyConversionResult(wrapper)
    wrapper.unmount()
  })

  it('discards a late successful conversion after the input changed and lets the new request succeed', async () => {
    const wrapper = mount(TimeToolView)
    await wrapper.get('#conversion-kind').setValue('unix_seconds')
    let resolveConversion!: (value: TimeResolutionResult) => void
    const pending = new Promise<TimeResolutionResult>((resolve) => {
      resolveConversion = resolve
    })
    vi.mocked(convertTime).mockImplementationOnce(() => pending)

    await wrapper.get('#conversion-input').setValue('0')
    await primaryButton(wrapper, '转换时间').trigger('click')
    await flushPromises()
    expect(vi.mocked(convertTime)).toHaveBeenCalledTimes(1)
    expectEmptyConversionResult(wrapper)

    await wrapper.get('#conversion-input').setValue('1')
    resolveConversion({ status: 'resolved', value: staleUnixZeroSnapshot() })
    await flushPromises()

    expectEmptyConversionResult(wrapper)
    expect(wrapper.text()).not.toContain('1970-01-01T00:00:00Z')
    expect(wrapper.find('.error-summary').exists()).toBe(false)

    await primaryButton(wrapper, '转换时间').trigger('click')
    await flushPromises()

    expect(vi.mocked(convertTime)).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.result-list').text()).toContain('1970-01-01T00:00:01Z')
    wrapper.unmount()
  })

  it('discards a late conversion error after the input changed and shows only the new request error', async () => {
    const wrapper = mount(TimeToolView)
    let rejectConversion!: (error: Error) => void
    const pending = new Promise<TimeResolutionResult>((_, reject) => {
      rejectConversion = reject
    })
    vi.mocked(convertTime).mockImplementationOnce(() => pending)

    await wrapper.get('#conversion-input').setValue('1970-01-01T00:00:00Z')
    await primaryButton(wrapper, '转换时间').trigger('click')
    await flushPromises()
    expect(vi.mocked(convertTime)).toHaveBeenCalledTimes(1)

    await wrapper.get('#conversion-input').setValue('1970-01-01T00:00:01Z')
    rejectConversion(new Error('旧转换错误'))
    await flushPromises()

    expect(wrapper.find('.error-summary').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('旧转换错误')
    expectEmptyConversionResult(wrapper)

    await wrapper.get('#conversion-input').setValue('not-a-time')
    await primaryButton(wrapper, '转换时间').trigger('click')
    await flushPromises()

    expect(wrapper.get('.error-summary').text()).toContain('ISO 8601 时间必须包含 Z 或明确 offset')
    expectEmptyConversionResult(wrapper)
    wrapper.unmount()
  })
})

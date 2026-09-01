import { flushPromises, mount } from '@vue/test-utils'

import TimeToolView from './TimeToolView.vue'
import { TIME_TEXT_LIMIT, WORKDAY_AMOUNT_LIMIT } from './time'
import viewSource from './TimeToolView.vue?raw'

describe('TimeToolView layout', () => {
  it('uses controlled timezone and locale-independent local datetime fields', async () => {
    const wrapper = mount(TimeToolView)
    const zone = wrapper.get('#time-zone')
    expect(zone.attributes('role')).toBe('combobox')
    expect(wrapper.find('datalist').exists()).toBe(false)

    const calculateTab = wrapper.findAll('.tool-tabs button').find((button) => button.text() === '日期计算')
    await calculateTab!.trigger('click')

    const date = wrapper.get('#calculation-start-date')
    const time = wrapper.get('#calculation-start-time')
    expect(date.attributes('placeholder')).toBe('YYYY-MM-DD')
    expect(time.attributes('placeholder')).toBe('HH:mm:ss')
    expect(wrapper.find('input[type="datetime-local"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the Cron result inside a shrinkable single-column stack', async () => {
    const wrapper = mount(TimeToolView)
    const cronTab = wrapper.findAll('.tool-tabs button').find((button) => button.text() === 'Cron')
    expect(cronTab).toBeDefined()
    await cronTab!.trigger('click')
    await wrapper.get('.cron-input-card .button--primary').trigger('click')

    expect(wrapper.find('.workspace-grid').exists()).toBe(true)
    expect(viewSource).toContain('.tool-page { width: min(100%, 1280px); min-width: 0; max-width: 100%;')
    expect(viewSource).toContain('input, select, textarea { width: 100%; min-width: 0; max-width: 100%;')
    expect(viewSource).toContain('.stack { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr);')
    expect(viewSource).toContain('.cron-meta > * { min-width: 0; }')
    expect(viewSource).toContain('.segmented input { position: absolute; width: 1px; min-width: 1px; max-width: 1px;')
    wrapper.unmount()
  })

  it('uses and explains the shared workday amount boundary', async () => {
    const wrapper = mount(TimeToolView)
    const workdayTab = wrapper.findAll('.tool-tabs button').find((button) => button.text() === '工作日')
    await workdayTab!.trigger('click')

    const amount = wrapper.get('#workday-amount')
    expect(amount.attributes('min')).toBe(String(-WORKDAY_AMOUNT_LIMIT))
    expect(amount.attributes('max')).toBe(String(WORKDAY_AMOUNT_LIMIT))
    expect(wrapper.text()).toContain(`允许范围 -${WORKDAY_AMOUNT_LIMIT}..${WORKDAY_AMOUNT_LIMIT}`)
    wrapper.unmount()
  })

  it.each([
    ['#holiday-input', '节假日输入'],
    ['#workday-input', '补班日输入'],
  ])('rejects oversized raw workday text before splitting: %s', async (selector, label) => {
    const wrapper = mount(TimeToolView)
    const workdayTab = wrapper.findAll('.tool-tabs button').find((button) => button.text() === '工作日')
    await workdayTab!.trigger('click')
    await wrapper.get(selector).setValue('a'.repeat(TIME_TEXT_LIMIT + 1))
    await wrapper.findAll('button.button--primary').find((button) => button.text() === '计算工作日')!.trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain(`${label}为 ${TIME_TEXT_LIMIT + 1} 字节`)
    wrapper.unmount()
  })
})

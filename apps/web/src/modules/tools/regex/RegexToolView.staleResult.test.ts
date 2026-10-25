import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RegexRunResult } from './contracts'

const run = vi.hoisted(() => vi.fn())

vi.mock('./regexRunner', () => ({
  RegexRunner: class {
    run = run
    cancel() {}
    dispose() {}
  },
}))

import RegexToolView from './RegexToolView.vue'

function finishedResult(matchCount: number, preview: string): RegexRunResult {
  return {
    matches: Array.from({ length: matchCount }, (_, index) => ({
      number: index + 1,
      start: index * 6,
      end: index * 6 + 5,
      value: 'error',
      groups: [],
      namedGroups: {},
    })),
    matchLimitReached: false,
    replacementPreview: preview,
  }
}

function expectEmptyResultState(wrapper: VueWrapper) {
  expect(wrapper.find('.empty-result').exists()).toBe(true)
  expect(wrapper.find('.empty-result').text()).toContain('运行后在此显示')
  expect(wrapper.find('.summary').exists()).toBe(false)
  expect(wrapper.findAll('.match-list article')).toHaveLength(0)
  expect(wrapper.find('.replacement-preview').exists()).toBe(false)
  expect(wrapper.find('.notice[role="status"]').exists()).toBe(false)
}

describe('RegexToolView stale result invalidation', () => {
  afterEach(() => {
    // 用例失败会提前中断、留下未消费的一次性 mock 实现队列，必须整体重置，
    // 否则残留实现会泄漏进后续用例，让守卫用例拿到已 settle 的 run 返回值。
    run.mockReset()
  })

  it('invalidates the finished result and completion status when a flag is toggled after a run', async () => {
    run.mockResolvedValueOnce(finishedResult(2, '[ERROR] preview'))
    const wrapper = mount(RegexToolView)

    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('共 2 个匹配')
    expect(wrapper.findAll('.match-list article')).toHaveLength(2)
    expect(wrapper.find('.replacement-preview').exists()).toBe(true)
    const status = wrapper.find('.notice[role="status"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toContain('完成：2 个匹配')
    expect(wrapper.find('.empty-result').exists()).toBe(false)

    // 仅取消 g flag（flag-list 中第一个 checkbox），不重跑
    const globalFlag = wrapper.get('.flag-list input[type="checkbox"]')
    await globalFlag.setValue(false)
    await flushPromises()

    expectEmptyResultState(wrapper)
    expect(wrapper.find('.notice.danger').exists()).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('invalidates the finished result when editing pattern, text or replacement', async () => {
    const edits = [
      { selector: '#regex-pattern', value: '([a-z]+)' },
      { selector: '#regex-text', value: 'error: changed\nwarning: changed' },
      { selector: '#regex-replacement', value: '[$1]' },
    ]
    const wrapper = mount(RegexToolView)

    for (const edit of edits) {
      run.mockResolvedValueOnce(finishedResult(1, 'preview'))
      await wrapper.get('button.button--primary').trigger('click')
      await flushPromises()
      expect(wrapper.find('.empty-result').exists()).toBe(false)

      await wrapper.get(edit.selector).setValue(edit.value)
      await flushPromises()

      expectEmptyResultState(wrapper)
    }
    expect(run).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('clears the stale error and returns to the empty state when editing after a failed run', async () => {
    run.mockRejectedValueOnce(new Error('表达式运行超时，Worker 已终止'))
    const wrapper = mount(RegexToolView)

    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()

    const danger = wrapper.find('.notice.danger')
    expect(danger.exists()).toBe(true)
    expect(danger.text()).toContain('表达式运行超时，Worker 已终止')
    expect(wrapper.find('.empty-result').exists()).toBe(true)

    await wrapper.get('#regex-pattern').setValue('(timeout|error)')
    await flushPromises()

    expect(wrapper.find('.notice.danger').exists()).toBe(false)
    expectEmptyResultState(wrapper)
    expect(run).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not auto-run on edit and shows the fresh result after an explicit second run', async () => {
    run.mockResolvedValueOnce(finishedResult(1, 'first-preview')).mockResolvedValueOnce(finishedResult(2, 'second-preview'))
    const wrapper = mount(RegexToolView)

    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('共 1 个匹配')
    expect(wrapper.get('.replacement-preview').text()).toContain('first-preview')

    await wrapper.get('#regex-text').setValue('error: a\nwarning: b')
    await flushPromises()
    expect(run).toHaveBeenCalledTimes(1)
    expectEmptyResultState(wrapper)

    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()
    expect(run).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('共 2 个匹配')
    expect(wrapper.get('.replacement-preview').text()).toContain('second-preview')
    expect(wrapper.find('.empty-result').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps inputs, flags and clear disabled while a run is pending and re-enables after resolve (guard)', async () => {
    let resolveRun: (value: RegexRunResult) => void = () => {}
    run.mockImplementationOnce(() => new Promise<RegexRunResult>((resolve) => { resolveRun = resolve }))
    const wrapper = mount(RegexToolView)

    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()

    expect(wrapper.get('#regex-pattern').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#regex-text').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#regex-replacement').attributes('disabled')).toBeDefined()
    for (const checkbox of wrapper.findAll('.flag-list input[type="checkbox"]')) {
      expect(checkbox.attributes('disabled')).toBeDefined()
    }
    expect(wrapper.get('.tool-header button').attributes('disabled')).toBeDefined()
    expect(wrapper.find('button.button--primary').exists()).toBe(false)

    resolveRun(finishedResult(0, ''))
    await flushPromises()

    expect(wrapper.get('#regex-pattern').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('#regex-text').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('#regex-replacement').attributes('disabled')).toBeUndefined()
    for (const checkbox of wrapper.findAll('.flag-list input[type="checkbox"]')) {
      expect(checkbox.attributes('disabled')).toBeUndefined()
    }
    expect(wrapper.get('.tool-header button').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('button.button--primary').exists()).toBe(true)
    wrapper.unmount()
  })
})

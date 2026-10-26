import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RegexRunResult } from './contracts'

const run = vi.hoisted(() => vi.fn())
const cancel = vi.hoisted(() => vi.fn())

vi.mock('./regexRunner', () => ({
  RegexRunner: class {
    run = run
    cancel = cancel
    dispose() {}
  },
}))

import RegexToolView from './RegexToolView.vue'

const hosts: HTMLElement[] = []

function mountAttached(): VueWrapper {
  const host = document.createElement('div')
  document.body.appendChild(host)
  hosts.push(host)
  return mount(RegexToolView, { attachTo: host })
}

function actionButton(wrapper: VueWrapper): HTMLButtonElement {
  return wrapper.get('.actions button').element as HTMLButtonElement
}

function finishedResult(matchCount: number): RegexRunResult {
  return {
    matches: Array.from({ length: matchCount }, (_, index) => ({
      number: index + 1,
      start: index * 5,
      end: index * 5 + 5,
      value: 'error',
      groups: [],
      namedGroups: {},
    })),
    matchLimitReached: false,
    replacementPreview: 'preview',
  }
}

describe('RegexToolView action button keyboard focus', () => {
  afterEach(() => {
    run.mockReset()
    cancel.mockReset()
    for (const host of hosts.splice(0)) host.remove()
  })

  it('keeps focus on the action control while waiting, cancels from it and runs again after cancelling', async () => {
    let rejectRun: (reason?: unknown) => void = () => {}
    run.mockImplementationOnce(() => new Promise<RegexRunResult>((_, reject) => { rejectRun = reject }))
    cancel.mockImplementationOnce(() => rejectRun(new DOMException('aborted', 'AbortError')))
    const wrapper = mountAttached()

    const button = actionButton(wrapper)
    button.focus()
    expect(document.activeElement).toBe(button)

    await wrapper.get('.actions button').trigger('click')
    await flushPromises()

    expect(document.activeElement).toBe(button)
    expect(actionButton(wrapper)).toBe(button)
    expect(button.textContent).toContain('取消运行')
    expect(button.className).toContain('button--danger')

    await wrapper.get('.actions button').trigger('click')
    await flushPromises()

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(button)
    expect(actionButton(wrapper)).toBe(button)
    expect(button.textContent).toContain('运行正则')
    expect(wrapper.find('.notice[role="status"]').text()).toContain('运行已取消')

    run.mockResolvedValueOnce(finishedResult(1))
    await wrapper.get('.actions button').trigger('click')
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('共 1 个匹配')
    expect(document.activeElement).toBe(button)
    wrapper.unmount()
  })

  it('keeps focus through a successful run and allows running again from the same button', async () => {
    let resolveRun: (value: RegexRunResult) => void = () => {}
    run.mockImplementationOnce(() => new Promise<RegexRunResult>((resolve) => { resolveRun = resolve }))
    const wrapper = mountAttached()

    const button = actionButton(wrapper)
    button.focus()
    await wrapper.get('.actions button').trigger('click')
    await flushPromises()

    resolveRun(finishedResult(2))
    await flushPromises()

    expect(wrapper.text()).toContain('共 2 个匹配')
    expect(actionButton(wrapper)).toBe(button)
    expect(document.activeElement).toBe(button)

    run.mockResolvedValueOnce(finishedResult(0))
    await wrapper.get('.actions button').trigger('click')
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('没有匹配')
    expect(document.activeElement).toBe(button)
    wrapper.unmount()
  })

  it('keeps focus through a failed run and allows running again', async () => {
    run.mockRejectedValueOnce(new Error('表达式运行超时，Worker 已终止'))
    const wrapper = mountAttached()

    const button = actionButton(wrapper)
    button.focus()
    await wrapper.get('.actions button').trigger('click')
    await flushPromises()

    expect(wrapper.find('.notice.danger').text()).toContain('表达式运行超时，Worker 已终止')
    expect(actionButton(wrapper)).toBe(button)
    expect(document.activeElement).toBe(button)

    run.mockResolvedValueOnce(finishedResult(1))
    await wrapper.get('.actions button').trigger('click')
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('共 1 个匹配')
    expect(document.activeElement).toBe(button)
    wrapper.unmount()
  })

  it('does not steal focus from another control when a pending run finishes', async () => {
    let resolveRun: (value: RegexRunResult) => void = () => {}
    run.mockImplementationOnce(() => new Promise<RegexRunResult>((resolve) => { resolveRun = resolve }))
    const wrapper = mountAttached()

    await wrapper.get('.actions button').trigger('click')
    await flushPromises()

    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    expect(document.activeElement).toBe(elsewhere)

    resolveRun(finishedResult(1))
    await flushPromises()

    expect(wrapper.text()).toContain('共 1 个匹配')
    expect(document.activeElement).toBe(elsewhere)
    wrapper.unmount()
    elsewhere.remove()
  })
})

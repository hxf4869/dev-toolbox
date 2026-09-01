import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { REGEX_MATCH_DISPLAY_LIMIT, type RegexRunResult } from './contracts'

const run = vi.hoisted(() => vi.fn())

vi.mock('./regexRunner', () => ({
  RegexRunner: class {
    run = run
    cancel() {}
    dispose() {}
  },
}))

import RegexToolView from './RegexToolView.vue'

describe('RegexToolView bounded results', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders at most 500 matches with non-exact truncation and no preview', async () => {
    const result: RegexRunResult = {
      matches: Array.from({ length: REGEX_MATCH_DISPLAY_LIMIT + 1 }, (_, index) => ({
        number: index + 1,
        start: index,
        end: index + 1,
        value: 'a',
        groups: [],
        namedGroups: {},
      })),
      matchLimitReached: true,
      replacementPreview: null,
    }
    run.mockResolvedValueOnce(result)
    const wrapper = mount(RegexToolView)

    await wrapper.get('button.button--primary').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.match-list article')).toHaveLength(REGEX_MATCH_DISPLAY_LIMIT)
    expect(wrapper.text()).toContain('匹配至少 501 次，仅显示前 500 条')
    expect(wrapper.text()).toContain('结果规模过大，本次未生成替换预览')
    expect(wrapper.find('.replacement-preview').exists()).toBe(false)
    wrapper.unmount()
  })
})

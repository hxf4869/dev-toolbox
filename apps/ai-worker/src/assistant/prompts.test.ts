import { describe, expect, it } from 'vitest'

import { assistantSystemPrompt } from './prompts.js'

describe('assistant citation grounding prompt', () => {
  it('requires current source content, not a heading or historical ordinal, to support a claim', () => {
    const prompt = assistantSystemPrompt('matched', true)
    expect(prompt).toContain('每项主张必须被所引用的本轮来源正文直接支持')
    expect(prompt).toContain('只有标题、路径或章节名称的来源只能说明主题，不能支撑版本、命令或配置细节')
    expect(prompt).toContain('不得沿用历史回答中的编号')
    expect(prompt).toContain('只能引用给定来源标记 [[S1]]–[[Sn]]')
  })

  it('keeps the distinction between missing evidence and an unavailable knowledge base', () => {
    expect(assistantSystemPrompt('not_found', true)).toContain('当前知识库未找到足够依据')
    expect(assistantSystemPrompt('unavailable', true)).toContain('知识库当前不可用')
    expect(assistantSystemPrompt('not_found', true)).toContain('不得提供一般性补充')
  })
})

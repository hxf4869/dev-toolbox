import { describe, expect, it } from 'vitest'

import { agentConsoleReturnPath } from './agentConsoleReturn'

describe('agentConsoleReturnPath', () => {
  it('accepts only the same-origin Agent Console prefix', () => {
    expect(
      agentConsoleReturnPath('/agent-console/tasks/abc?tab=git#diff', 'https://toolbox.test'),
    ).toBe('/agent-console/tasks/abc?tab=git#diff')
    expect(agentConsoleReturnPath('https://evil.test/agent-console/', 'https://toolbox.test')).toBeUndefined()
    expect(agentConsoleReturnPath('//evil.test/agent-console/', 'https://toolbox.test')).toBeUndefined()
    expect(agentConsoleReturnPath('/settings/security', 'https://toolbox.test')).toBeUndefined()
  })
})

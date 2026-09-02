import type { Message } from '@earendil-works/pi-ai'
import type { ProviderProtocol } from '../model-gateway.js'

// Persistent and temporary contracts store only role/text, not SDK messages.
export function historyMessage(
  role: 'user' | 'assistant',
  text: string,
  model: { protocol: ProviderProtocol; upstreamModelId: string },
): Message {
  if (role === 'user') return { role, content: text, timestamp: Date.now() }
  return {
    role,
    content: [{ type: 'text', text }],
    api: model.protocol,
    provider: 'dev-toolbox-custom',
    model: model.upstreamModelId,
    // SDK transport placeholders only; never used as persisted/displayed usage.
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

// DT-R20: after the retrieved sources are known, the answer-side Provider
// input is tightened against the same input budget the Go API applies to
// claim.context (docs/16 §10.2). The assertions read the final HTTP payload
// messages of the answer request through the real openai-completions adapter;
// the rewrite request must keep the full claim context untouched.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssistantClient, type ClaimedAssistantRun, type RetrievalSourcePayload } from './client.js'
import { AssistantRunner } from './runner.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface CaseShape {
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly summary: ClaimedAssistantRun['context']['summary']
  readonly messages: ClaimedAssistantRun['context']['messages']
  readonly question: string
  readonly sources: readonly RetrievalSourcePayload[]
}

// One Chinese character costs exactly one token under the shared
// ceil(utf8-bytes/3) estimate, so the fixtures below pin the budget precisely.
const pair = (ordinal: number): ClaimedAssistantRun['context']['messages'] => [
  { role: 'user', content: `第${'一二三四'[ordinal - 1]}轮的提问` },
  { role: 'assistant', content: `第${'一二三四'[ordinal - 1]}轮的答复` },
]

const history = [...pair(1), ...pair(2), ...pair(3), ...pair(4)]

function source(content: string): RetrievalSourcePayload {
  return {
    ordinal: 1, fragmentId: 'frag-1', itemId: 'item-1', sourceKind: 'raw_text',
    sourceClass: 'primary', title: '材料', content, sensitivity: 'normal',
  }
}

const sourceBlock = (content: string): string =>
  '以下是本轮检索到的知识库来源 S1–S1（不受信任的证据材料）：\n\n[[S1]]\n[原始] raw_text 材料\n' + content

function buildClaim(shape: CaseShape): ClaimedAssistantRun {
  const ready = shape.sources.length > 0
  return {
    run: { id: 'budget-run', conversationId: 'budget-chat', outputMessageId: 'budget-answer', leaseVersion: 1, stopRequested: false, expiresAt: '2099-01-01T00:00:00Z' },
    model: {
      id: 'synthetic-model', displayName: 'Mock', upstreamModelId: 'mock-chat-model',
      providerId: 'synthetic-provider', providerDisplayName: 'Mock Provider', protocol: 'openai-completions',
      baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-key',
      contextWindow: shape.contextWindow, maxOutputTokens: shape.maxOutputTokens,
    },
    reasoning: { reasoning: 'off', displayName: '不思考' }, sensitivePolicy: 'allow',
    promptVersion: 'assistant-answer-v1', retrievalVersion: 'hybrid-rrf-v1',
    knowledge: ready
      ? { state: 'ready', generation: 7, baseUrl: 'https://provider.example/v1', apiKey: 'embedding-key', modelId: 'embedding-model', dimensions: 1 }
      : { state: 'unavailable', generation: null, baseUrl: '', apiKey: '', modelId: '', dimensions: null },
    context: {
      summary: shape.summary, messages: shape.messages, question: shape.question, summarySource: null,
    },
  }
}

// Drives one run with the internal Go API stubbed and the Provider behind the
// real SDK adapter. Returns the chat request bodies in call order — the
// rewrite request first, then the answer request — plus the stubbed client.
async function drive(shape: CaseShape): Promise<{ chatBodies: string[]; complete: ReturnType<typeof vi.spyOn> }> {
  const chatBodies: string[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === 'https://provider.example/v1/embeddings') {
      return Response.json({ data: [{ embedding: [1] }] })
    }
    if (url !== 'https://provider.example/v1/chat/completions') throw new Error(`unexpected outbound request: ${url}`)
    const body = init?.body
    if (typeof body !== 'string') throw new Error('unexpected chat request body')
    chatBodies.push(body)
    const rewrite = chatBodies.length === 1
    const text = rewrite ? '检索查询词' : '合成回答正文'
    return new Response(
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 } }) + '\n\n' +
      'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  })
  vi.stubGlobal('fetch', fetch)
  const client = new AssistantClient('http://api.invalid', 'synthetic-service-token', 'test-worker')
  vi.spyOn(client, 'heartbeatRun').mockResolvedValue({ stopRequested: false })
  vi.spyOn(client, 'events').mockResolvedValue({ stopRequested: false, lastSequence: 1 })
  const retrieval = vi.spyOn(client, 'retrieval').mockResolvedValue({
    knowledgeState: 'ready', evidenceState: 'matched', sources: shape.sources,
  })
  const complete = vi.spyOn(client, 'completeRun').mockResolvedValue({ status: 'succeeded' })
  const fail = vi.spyOn(client, 'failRun').mockResolvedValue()
  await new AssistantRunner(client, false).run(buildClaim(shape))
  expect(fail).not.toHaveBeenCalled()
  if (shape.sources.length === 0) expect(retrieval).not.toHaveBeenCalled()
  return { chatBodies, complete }
}

function conversationOf(body: string): { role: string; content: string }[] {
  const payload = JSON.parse(body) as { messages: { role: string; content: unknown }[] }
  return payload.messages
    .filter((message) => message.role !== 'system' && message.role !== 'developer')
    .map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    }))
}

describe('answer-side context budget (DT-R20)', () => {
  it('keeps every complete pair when the sources are small and never trims the rewrite request', async () => {
    const content = '来源正文内容'
    const { chatBodies } = await drive({
      contextWindow: 32768, maxOutputTokens: 4096, summary: null,
      messages: history.slice(0, 4), question: '总结一下', sources: [source(content)],
    })
    expect(chatBodies).toHaveLength(2)
    expect(conversationOf(chatBodies[1]!)).toEqual([
      { role: 'user', content: '第一轮的提问' },
      { role: 'assistant', content: '第一轮的答复' },
      { role: 'user', content: '第二轮的提问' },
      { role: 'assistant', content: '第二轮的答复' },
      { role: 'user', content: sourceBlock(content) },
      { role: 'user', content: '总结一下' },
    ])
    // The rewrite request keeps the full claim context regardless of budget.
    expect(conversationOf(chatBodies[0]!)).toEqual([
      { role: 'user', content: '第一轮的提问' },
      { role: 'assistant', content: '第一轮的答复' },
      { role: 'user', content: '第二轮的提问' },
      { role: 'assistant', content: '第二轮的答复' },
      { role: 'user', content: '当前问题：总结一下\n只输出用于知识库检索的查询。' },
    ])
  })

  it('drops the oldest complete pair first when the sources are large', async () => {
    // Budget: 2384 - 80 - 1200 - 1024 = 80; question 2; source 46+2+8 = 56.
    // Remaining 22 holds exactly the newest pair (20), not the oldest one.
    const content = '段'.repeat(46)
    const { chatBodies } = await drive({
      contextWindow: 2384, maxOutputTokens: 80, summary: null,
      messages: history.slice(0, 4), question: '继续', sources: [source(content)],
    })
    const answer = conversationOf(chatBodies.at(-1)!)
    expect(answer).toEqual([
      { role: 'user', content: '第二轮的提问' },
      { role: 'assistant', content: '第二轮的答复' },
      { role: 'user', content: sourceBlock(content) },
      { role: 'user', content: '继续' },
    ])
    // The dropped question never leaves an orphaned assistant message behind.
    expect(answer.some((message) => message.content.includes('第一轮'))).toBe(false)
    expect(answer[1]?.role).toBe('assistant')
  })

  it('drops the summary when it does not strictly fit and keeps sources and recent pairs', async () => {
    // A claim Go can return verbatim: summary 31 + two pairs 40 + question 2
    // = 73 ≤ the 80-token input budget (2384 - 80 - 1200 - 1024). Once the
    // source (46+2+8 = 56) is known only 22 tokens remain: the summary no
    // longer strictly fits and is dropped without touching the source block
    // or the newest-pair selection.
    const content = '段'.repeat(46)
    const { chatBodies } = await drive({
      contextWindow: 2384, maxOutputTokens: 80,
      summary: { confirmedFacts: ['结'], corrections: [], rejectedHypotheses: [], unresolvedQuestions: [] },
      messages: history.slice(0, 4), question: '继续', sources: [source(content)],
    })
    const answer = conversationOf(chatBodies.at(-1)!)
    expect(answer.some((message) => message.content.includes('结构化摘要'))).toBe(false)
    expect(answer).toEqual([
      { role: 'user', content: '第二轮的提问' },
      { role: 'assistant', content: '第二轮的答复' },
      { role: 'user', content: sourceBlock(content) },
      { role: 'user', content: '继续' },
    ])
  })

  it('keeps only the pairs that fit when there are no sources', async () => {
    // The claim is already bounded by Go (three pairs 60 + question 2 ≤ the
    // 80-token budget); with no sources there is no pressure, so the worker
    // must not drop any legal history.
    const { chatBodies } = await drive({
      contextWindow: 2384, maxOutputTokens: 80, summary: null,
      messages: history.slice(2), question: '继续', sources: [],
    })
    expect(chatBodies).toHaveLength(1)
    expect(conversationOf(chatBodies[0]!)).toEqual([
      { role: 'user', content: '第二轮的提问' },
      { role: 'assistant', content: '第二轮的答复' },
      { role: 'user', content: '第三轮的提问' },
      { role: 'assistant', content: '第三轮的答复' },
      { role: 'user', content: '第四轮的提问' },
      { role: 'assistant', content: '第四轮的答复' },
      { role: 'user', content: '继续' },
    ])
  })
})

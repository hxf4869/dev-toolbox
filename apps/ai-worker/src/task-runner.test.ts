import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { loadArtifactContract, type ArtifactContract } from './artifact-schema.js'
import { PromptStore } from './prompts.js'
import type { ClaimedTask, SafeTaskEvent } from './task-client.js'
import { TaskClientError } from './task-client.js'
import { TaskRunner, type TaskApi } from './task-runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '../../..')
const fragmentId = '7484e4f8-6ebc-51c1-9e42-8b4cecff2b4f'
const recordId = '21e2705b-8bd8-43ea-b155-945a2ace1357'
const imageId = 'ad75cf86-90ee-43ac-a329-c35e8cfc47ea'
let contract: ArtifactContract
let organizedArtifact: Record<string, unknown>
const egressServers: Array<ReturnType<typeof createServer>> = []

beforeAll(async () => {
  contract = await loadArtifactContract(resolve(repositoryRoot, 'docs/contracts/ai-artifact.schema.json'))
  organizedArtifact = JSON.parse(await readFile(
    resolve(repositoryRoot, 'tests/fixtures/ai-artifact/valid-organized.json'),
    'utf8',
  )) as Record<string, unknown>
})

afterEach(async () => {
  await Promise.all(
    egressServers.splice(0).map(
      (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    ),
  )
})

describe('bounded task runner', () => {
  it('completes a valid candidate after reading the controlled context', async () => {
    const api = new FakeTaskApi()
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('candidate', 'emit_candidate_artifact', { artifact: organizedArtifact })]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim())

    expect(api.completed).toHaveLength(1)
    expect(api.failures).toEqual([])
    expect(api.completed[0]).toEqual(organizedArtifact)
  })

  it('creates a correctness review candidate without changing the source contract', async () => {
    const api = new FakeTaskApi()
    const artifact = { ...organizedArtifact, artifactType: 'correctness_review' }
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('candidate', 'emit_candidate_artifact', { artifact })]),
    ]
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, type: 'review_record', promptVersion: 'review-v1' },
    }
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(claim)

    expect(api.completed).toHaveLength(1)
    expect(api.completed[0]?.artifactType).toBe('correctness_review')
  })

  it('reads every authorized image before accepting an image analysis candidate', async () => {
    const api = new FakeTaskApi()
    api.attachmentBytes = new Uint8Array([1, 2, 3])
    const artifact = {
      ...organizedArtifact,
      artifactType: 'image_analysis',
      classification: {
        contentType: 'image', suggestedFolderPath: ['图片'], suggestedTags: ['截图'],
        sensitivitySuggestion: 'normal',
      },
      blocks: [{
        id: 'image', type: 'image_reference', attachmentId: imageId,
        caption: '截图内容', sourceFragmentIds: [],
      }],
      sourceFragmentIds: [],
    }
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('image', 'get_attachment', { attachmentId: imageId })]),
      assistant([toolCall('candidate', 'emit_candidate_artifact', { artifact })]),
    ]
    const base = taskClaim({
      attachments: [{
        id: imageId, kind: 'image', mediaType: 'image/png', sizeBytes: 3,
        width: 1, height: 1,
      }],
    })
    const claim: ClaimedTask = {
      ...base,
      task: { ...base.task, type: 'analyze_image', promptVersion: 'image-v1' },
      provider: { ...base.provider, supportsVision: true },
    }
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(claim)

    expect(api.attachmentReads).toEqual([imageId])
    expect(api.completed).toHaveLength(1)
    expect(api.completed[0]?.artifactType).toBe('image_analysis')
  })

  it('allows only one format repair and never parses natural-language JSON', async () => {
    const api = new FakeTaskApi()
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([{ type: 'text', text: `Here is JSON: ${JSON.stringify(organizedArtifact)}` }]),
      assistant([{ type: 'text', text: JSON.stringify(organizedArtifact) }]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim())

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_ARTIFACT_SCHEMA_INVALID')
  })

  it.each([
    ['wrong artifact type', (artifact: Record<string, any>) => { artifact.artifactType = 'correctness_review' }],
    ['text artifact without sources', (artifact: Record<string, any>) => {
      artifact.sourceFragmentIds = []
      artifact.blocks[0].sourceFragmentIds = []
      artifact.blocks[0].steps[0].sourceFragmentIds = []
    }],
    ['duplicate block IDs', (artifact: Record<string, any>) => { artifact.blocks.push(structuredClone(artifact.blocks[0])) }],
    ['nested source outside the top-level set', (artifact: Record<string, any>) => {
      artifact.blocks[0].steps[0].sourceFragmentIds = ['00000000-0000-4000-8000-000000000001']
    }],
    ['table row/column mismatch', (artifact: Record<string, any>) => {
      artifact.blocks = [{
        id: 'table', type: 'table', columns: ['a', 'b'], rows: [['only-one']],
        sourceFragmentIds: [fragmentId],
      }]
    }],
    ['case-folded duplicate tags', (artifact: Record<string, any>) => {
      artifact.classification.suggestedTags = ['Go', 'go']
    }],
    ['raw HTML in Markdown', (artifact: Record<string, any>) => {
      artifact.blocks = [{
        id: 'markdown', type: 'markdown', markdown: '<script>alert(1)</script>',
        sourceFragmentIds: [fragmentId],
      }]
    }],
  ])('rejects %s after one bounded repair', async (_name, mutate) => {
    const api = new FakeTaskApi()
    const artifact = structuredClone(organizedArtifact) as Record<string, any>
    mutate(artifact)
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('invalid-one', 'emit_candidate_artifact', { artifact })]),
      assistant([toolCall('invalid-two', 'emit_candidate_artifact', { artifact })]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim())

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_ARTIFACT_SCHEMA_INVALID')
  })

  it('rejects undeclared tools without executing them', async () => {
    const api = new FakeTaskApi()
    const runner = createRunner(api, async () => ({
      message: assistant([toolCall('shell', 'run_shell', { command: 'id' })]), attempts: 1,
    }))

    await runner.run(taskClaim())

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_TOOL_INVALID')
  })

  it('rejects a repeated domain tool call', async () => {
    const api = new FakeTaskApi()
    const runner = createRunner(api, async () => ({
      message: assistant([
        toolCall('context-1', 'get_record_context', {}),
        toolCall('context-2', 'get_record_context', {}),
      ]),
      attempts: 1,
    }))

    await runner.run(taskClaim())

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_TOOL_INVALID')
  })

  it('stops at eight domain tool calls', async () => {
    const api = new FakeTaskApi()
    const related = Array.from({ length: 10 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      title: `related ${index}`,
      summary: `summary ${index}`,
    }))
    const claim = taskClaim({ relatedRecords: related })
    const searches = Array.from({ length: 8 }, (_, index) =>
      toolCall(`search-${index}`, 'search_related_records', { query: `q${index}`, limit: 1 }))
    const messages = [assistant([toolCall('context', 'get_record_context', {})]), assistant(searches)]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(claim)

    expect(api.failures.at(-1)?.code).toBe('AI_TOOL_LIMIT')
  })

  it('stops after four model turns without a candidate', async () => {
    const api = new FakeTaskApi()
    const relatedRecords = [{
      id: '00000000-0000-4000-8000-000000000001',
      title: 'related record',
      summary: 'alpha beta gamma',
    }]
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('search-1', 'search_related_records', { query: 'alpha', limit: 1 })]),
      assistant([toolCall('search-2', 'search_related_records', { query: 'beta', limit: 1 })]),
      assistant([toolCall('search-3', 'search_related_records', { query: 'gamma', limit: 1 })]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim({ relatedRecords }))

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_TURN_LIMIT')
  })

  it('stops at the task deadline between provider and tool boundaries', async () => {
    const api = new FakeTaskApi()
    const base = taskClaim()
    const claim: ClaimedTask = {
      ...base,
      task: {
        ...base.task,
        limits: { ...base.task.limits, deadlineAt: new Date(Date.now() + 50).toISOString() },
      },
    }
    const runner = createRunner(api, async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80))
      return { message: assistant([toolCall('context', 'get_record_context', {})]), attempts: 1 }
    })

    await runner.run(claim)

    expect(api.completed).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_TASK_DEADLINE_EXCEEDED')
  })

  it('checks cancellation before the first provider request', async () => {
    const api = new FakeTaskApi()
    api.cancelOnHeartbeat = true
    let providerCalls = 0
    const runner = createRunner(api, async () => {
      providerCalls += 1
      return { message: assistant([]), attempts: 1 }
    })

    await runner.run(taskClaim())

    expect(providerCalls).toBe(0)
    expect(api.failures.at(-1)?.code).toBe('AI_TASK_CANCELLED')
  })

  it('makes zero provider requests for a sensitive block claim', async () => {
    const api = new FakeTaskApi()
    let providerCalls = 0
    const runner = createRunner(api, async () => {
      providerCalls += 1
      return { message: assistant([]), attempts: 1 }
    })
    const claim = taskClaim({ sensitivity: 'sensitive', sensitivePolicy: 'block' })

    await runner.run(claim)

    expect(providerCalls).toBe(0)
    expect(api.failures.at(-1)?.code).toBe('AI_SENSITIVE_BLOCKED')
  })

  it.each([
    { policy: 'redact' as const, body: 'password=<PASSWORD_1>', secretVisible: false },
    { policy: 'allow' as const, body: 'password=UltraSecret-2026', secretVisible: true },
  ])('enforces $policy at the real Provider network boundary', async ({ policy, body, secretVisible }) => {
    const api = new FakeTaskApi()
    const network = await startEgressSpy()
    const base = taskClaim({
      sensitivity: 'sensitive',
      sensitivePolicy: policy,
      rawRecords: [{ id: recordId, recordRole: 'primary', contentFormat: 'plain_text', body }],
      fragments: [{ id: fragmentId, rawRecordId: recordId, sourceKind: 'raw_text', ordinal: 0, content: body }],
    })
    const claim: ClaimedTask = {
      ...base,
      provider: { ...base.provider, baseUrl: `${network.baseUrl}/gateway/v1/` },
    }
    const runner = new TaskRunner(
      api,
      new PromptStore(resolve(repositoryRoot, 'apps/ai-worker/prompts')),
      contract,
      true,
    )

    await runner.run(claim)

    expect(api.completed).toHaveLength(1)
    expect(network.bodies).toHaveLength(2)
    const outbound = network.bodies.join('\n')
    expect(outbound.includes('UltraSecret-2026')).toBe(secretVisible)
    if (policy === 'redact') expect(outbound).toContain('<PASSWORD_1>')
  })

  it('keeps sensitive block at zero requests at the real Provider network boundary', async () => {
    const api = new FakeTaskApi()
    const network = await startEgressSpy()
    const base = taskClaim({
      sensitivity: 'sensitive',
      sensitivePolicy: 'block',
      rawRecords: [{ id: recordId, recordRole: 'primary', contentFormat: 'plain_text', body: 'password=BlockedSecret' }],
    })
    const claim: ClaimedTask = {
      ...base,
      provider: { ...base.provider, baseUrl: `${network.baseUrl}/gateway/v1/` },
    }
    const runner = new TaskRunner(
      api,
      new PromptStore(resolve(repositoryRoot, 'apps/ai-worker/prompts')),
      contract,
      true,
    )

    await runner.run(claim)

    expect(network.bodies).toEqual([])
    expect(api.failures.at(-1)?.code).toBe('AI_SENSITIVE_BLOCKED')
  })

  it('uses complete idempotency retry only for a transport failure', async () => {
    const api = new FakeTaskApi()
    api.completeTransportFailures = 1
    const messages = [
      assistant([toolCall('context', 'get_record_context', {})]),
      assistant([toolCall('candidate', 'emit_candidate_artifact', { artifact: organizedArtifact })]),
    ]
    const runner = createRunner(api, async () => ({ message: messages.shift()!, attempts: 1 }))

    await runner.run(taskClaim())

    expect(api.completeAttempts).toBe(2)
    expect(api.completed).toHaveLength(1)
    expect(api.failures).toEqual([])
  })
})

class FakeTaskApi implements TaskApi {
  readonly completed: Record<string, unknown>[] = []
  readonly failures: Array<{ code: string; detail: string }> = []
  readonly taskEvents: SafeTaskEvent[] = []
  cancelOnHeartbeat = false
  completeTransportFailures = 0
  completeAttempts = 0
  attachmentBytes: Uint8Array | null = null
  readonly attachmentReads: string[] = []

  async heartbeat(): Promise<{ readonly cancelRequested: boolean }> {
    return { cancelRequested: this.cancelOnHeartbeat }
  }

  async events(_claim: ClaimedTask, events: readonly SafeTaskEvent[]): Promise<void> {
    this.taskEvents.push(...events)
  }

  async attachment(_claim: ClaimedTask, attachment: ClaimedTask['input']['attachments'][number]): Promise<Uint8Array> {
    if (this.attachmentBytes === null) throw new Error('unexpected attachment read')
    this.attachmentReads.push(attachment.id)
    return this.attachmentBytes
  }

  async complete(_claim: ClaimedTask, artifact: Record<string, unknown>): Promise<unknown> {
    this.completeAttempts += 1
    if (this.completeTransportFailures > 0) {
      this.completeTransportFailures -= 1
      throw new TaskClientError(0, 'API_UNAVAILABLE')
    }
    this.completed.push(artifact)
    return { id: 'artifact' }
  }

  async fail(_claim: ClaimedTask, code: string, detail: string): Promise<void> {
    this.failures.push({ code, detail })
  }
}

function createRunner(api: TaskApi, providerTurn: ConstructorParameters<typeof TaskRunner>[4]): TaskRunner {
  return new TaskRunner(
    api,
    new PromptStore(resolve(repositoryRoot, 'apps/ai-worker/prompts')),
    contract,
    true,
    providerTurn,
  )
}

function taskClaim(overrides: Partial<ClaimedTask['input']> = {}): ClaimedTask {
  return {
    task: {
      id: '79191f32-e265-4f0f-aa13-6ba279491583',
      type: 'organize_record',
      leaseVersion: 1,
      promptVersion: 'organize-v1',
      schemaVersion: '1.0',
      limits: { maxTurns: 4, maxToolCalls: 8, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    },
    input: {
      itemId: '99807597-3f7b-4d19-a0f7-c33be4b2b80d',
      sensitivity: 'normal',
      sensitivePolicy: 'block',
      rawRecords: [{ id: recordId, recordRole: 'primary', contentFormat: 'plain_text', body: 'lsblk' }],
      fragments: [{ id: fragmentId, rawRecordId: recordId, sourceKind: 'raw_text', ordinal: 0, content: 'lsblk' }],
      attachments: [],
      relatedRecords: [],
      ...overrides,
    },
    provider: {
      protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key',
      modelId: 'test-model', modelName: 'Test', contextWindow: 8192, maxOutputTokens: 1024,
      supportsTools: true, supportsVision: false,
    },
  }
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'dev-toolbox-custom',
    model: 'test-model', usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  }
}

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown>): ToolCall {
  return { type: 'toolCall', id, name, arguments: argumentsValue }
}

async function startEgressSpy(): Promise<{ baseUrl: string; bodies: string[] }> {
  const bodies: string[] = []
  const server = createServer(async (request, response) => {
    bodies.push(await readRequestBody(request))
    const turn = bodies.length
    if (turn === 1) {
      respondOpenAITool(response, 'get_record_context', {})
      return
    }
    respondOpenAITool(response, 'emit_candidate_artifact', { artifact: organizedArtifact })
  })
  egressServers.push(server)
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('egress spy failed to bind')
  return { baseUrl: `http://127.0.0.1:${address.port}`, bodies }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function respondOpenAITool(
  response: ServerResponse,
  name: string,
  argumentsValue: Record<string, unknown>,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl_sensitive',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: `call_${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(argumentsValue) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl_sensitive',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

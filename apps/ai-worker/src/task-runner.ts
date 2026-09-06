import type { AssistantMessage, Context, Tool, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'

import {
  artifactDraftSchema,
  createModelTaskContext,
  materializeArtifactDraft,
  mergeArtifactDraftRepair,
  normalizeArtifactDraft,
} from './artifact-draft.js'
import type { ArtifactContract } from './artifact-schema.js'
import { log } from './logger.js'
import { ProviderGatewayError, runProviderTurn, type ProviderTurnRequest } from './model-gateway.js'
import { PromptStore } from './prompts.js'
import {
  TaskClient,
  TaskClientError,
  type ClaimedAttachment,
  type ClaimedTask,
  type SafeTaskEvent,
} from './task-client.js'

const maximumTurns = 4
const maximumToolCalls = 8
const maximumArtifactBytes = 2 * 1024 * 1024
const heartbeatIntervalMs = 10_000

type Usage = { inputTokens: number; outputTokens: number }
type ProviderTurn = (request: ProviderTurnRequest) => ReturnType<typeof runProviderTurn>

export interface TaskApi {
  heartbeat(claim: ClaimedTask, signal?: AbortSignal): Promise<{ readonly cancelRequested: boolean }>
  events(claim: ClaimedTask, events: readonly SafeTaskEvent[], signal?: AbortSignal): Promise<void>
  attachment(claim: ClaimedTask, attachment: ClaimedAttachment, signal?: AbortSignal): Promise<Uint8Array>
  complete(claim: ClaimedTask, artifact: Record<string, unknown>, usage: Usage, signal?: AbortSignal): Promise<unknown>
  fail(claim: ClaimedTask, errorCode: string, errorDetail: string, usage: Usage, signal?: AbortSignal): Promise<void>
}

export class TaskExecutionError extends Error {
  constructor(readonly code: string, readonly detail: string, cause?: unknown) {
    super(detail, cause === undefined ? undefined : { cause })
    this.name = 'TaskExecutionError'
  }
}

export class TaskRunner {
  constructor(
    readonly api: TaskApi,
    readonly prompts: PromptStore,
    readonly artifactContract: ArtifactContract,
    readonly allowInsecureProviderHttp: boolean,
    readonly providerTurn: ProviderTurn = runProviderTurn,
  ) {}

  async run(claim: ClaimedTask, shutdownSignal?: AbortSignal): Promise<void> {
    const usage: Usage = { inputTokens: 0, outputTokens: 0 }
    const heartbeat = new TaskHeartbeat(this.api, claim, shutdownSignal)
    try {
      await heartbeat.start()
      await this.execute(claim, usage, heartbeat)
    } catch (error) {
      if (heartbeat.leaseLost || shutdownSignal?.aborted || isLeaseConflict(error)) return
      const failure = normalizeFailure(error, heartbeat.cancelRequested, claim.task.limits.deadlineAt)
      try {
        await this.api.fail(claim, failure.code, failure.detail, usage)
      } catch (failError) {
        if (!isLeaseConflict(failError)) throw failError
      }
    } finally {
      heartbeat.stop()
    }
  }

  private async execute(claim: ClaimedTask, usage: Usage, heartbeat: TaskHeartbeat): Promise<void> {
    if (claim.task.promptVersion.endsWith('-v2')) {
      await this.executeDraft(claim, usage, heartbeat)
      return
    }
    await this.executeLegacy(claim, usage, heartbeat)
  }

  private async executeLegacy(claim: ClaimedTask, usage: Usage, heartbeat: TaskHeartbeat): Promise<void> {
    validateClaimLimits(claim)
    const deadlineAt = new Date(claim.task.limits.deadlineAt)
    const prompt = await this.prompts.load(claim.task.promptVersion)
    const tools = createTools(this.artifactContract.schema, claim)
    const context: Context = {
      systemPrompt: `${prompt}\n\n任务 schemaVersion=${claim.task.schemaVersion}，taskType=${claim.task.type}。只使用已声明工具。`,
      messages: [{
        role: 'user',
        content: `处理条目 ${claim.input.itemId}。先读取受控上下文，再提交完整候选 Artifact。`,
        timestamp: Date.now(),
      }],
      tools,
    }
    const state = new ToolState(claim)
    let formatRepairUsed = false
    const turns = Math.min(maximumTurns, claim.task.limits.maxTurns)

    for (let turn = 1; turn <= turns; turn += 1) {
      ensureBoundary(deadlineAt, heartbeat)
      await this.event(claim, 'model_request_started', { turn })
      const startedAt = performance.now()
      let message: AssistantMessage
      let attempts: number
      try {
        const result = await this.providerTurn({
          provider: claim.provider,
          context,
          deadlineAt,
          maxOutputTokens: claim.provider.maxOutputTokens,
          allowInsecureHttp: this.allowInsecureProviderHttp,
          signal: heartbeat.signal,
        })
        message = result.message
        attempts = result.attempts
      } catch (error) {
        if (heartbeat.cancelRequested) throw new TaskExecutionError('AI_TASK_CANCELLED', '用户已请求取消任务', error)
        if (Date.now() >= deadlineAt.getTime()) throw new TaskExecutionError('AI_TASK_DEADLINE_EXCEEDED', '任务超过五分钟运行上限', error)
        throw error
      }
      usage.inputTokens += message.usage.input
      usage.outputTokens += message.usage.output
      await this.event(claim, 'model_request_finished', {
        turn,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        attempt: attempts,
      })
      context.messages.push(message)
      const calls = message.content.filter((part): part is ToolCall => part.type === 'toolCall')
      if (calls.length === 0) {
        if (formatRepairUsed) {
          throw new TaskExecutionError('AI_ARTIFACT_SCHEMA_INVALID', '模型未通过候选 Artifact 格式修复')
        }
        formatRepairUsed = true
        context.messages.push({
          role: 'user',
          content: '未收到 emit_candidate_artifact 工具调用。只修复输出格式，并提交完整候选 Artifact。',
          timestamp: Date.now(),
        })
        continue
      }

      for (const call of calls) {
        ensureBoundary(deadlineAt, heartbeat)
        state.countToolCall(claim.task.limits.maxToolCalls)
        await this.event(claim, 'tool_started', { turn, tool: call.name, toolCalls: state.toolCalls })
        const outcome = await state.execute(call, this.api, heartbeat.signal)
        await this.event(claim, 'tool_finished', { turn, tool: call.name, toolCalls: state.toolCalls })
        if (outcome.artifact === undefined) {
          context.messages.push(outcome.result)
          continue
        }

        const candidateError = validateCandidateArtifact(
          this.artifactContract,
          outcome.artifact,
          claim,
          state.readAttachmentIds,
        )
        if (candidateError !== null) {
          if (formatRepairUsed) {
            throw new TaskExecutionError('AI_ARTIFACT_SCHEMA_INVALID', '模型候选 Artifact 两次未通过契约校验')
          }
          formatRepairUsed = true
          context.messages.push(toolError(call, '候选 Artifact 未通过契约；只修复格式、类型与来源引用后重新提交。'))
          continue
        }
        await this.event(claim, 'candidate_received', { turn, toolCalls: state.toolCalls })
        try {
          await completeWithOneTransportRetry(this.api, claim, outcome.artifact, usage, heartbeat.signal)
          return
        } catch (error) {
          if (error instanceof TaskClientError && error.status === 422 && !formatRepairUsed) {
            formatRepairUsed = true
            context.messages.push(toolError(call, '候选 Artifact 未通过服务端边界校验；只修复格式与来源引用后重新提交。'))
            continue
          }
          throw error
        }
      }
    }
    throw new TaskExecutionError('AI_TURN_LIMIT', '模型交互达到四轮上限仍未产生有效候选')
  }

  private async executeDraft(claim: ClaimedTask, usage: Usage, heartbeat: TaskHeartbeat): Promise<void> {
    validateClaimLimits(claim)
    const deadlineAt = new Date(claim.task.limits.deadlineAt)
    const prompt = await this.prompts.load(claim.task.promptVersion)
    const state = new DraftToolState(claim)
    let toolChannel = claim.provider.supportsTools
    let channelFallbackUsed = false
    let context = await createDraftConversation(prompt, claim, toolChannel, this.api, state, heartbeat.signal)
    let formatRepairUsed = false
    const turns = Math.min(maximumTurns, claim.task.limits.maxTurns)

    for (let turn = 1; turn <= turns; turn += 1) {
      ensureBoundary(deadlineAt, heartbeat)
      await this.event(claim, 'model_request_started', { turn })
      const startedAt = performance.now()
      let message: AssistantMessage
      let attempts: number
      try {
        const result = await this.providerTurn({
          provider: claim.provider,
          context,
          deadlineAt,
          maxOutputTokens: claim.provider.maxOutputTokens,
          allowInsecureHttp: this.allowInsecureProviderHttp,
          signal: heartbeat.signal,
        })
        message = result.message
        attempts = result.attempts
      } catch (error) {
        if (heartbeat.cancelRequested) throw new TaskExecutionError('AI_TASK_CANCELLED', '用户已请求取消任务', error)
        if (Date.now() >= deadlineAt.getTime()) throw new TaskExecutionError('AI_TASK_DEADLINE_EXCEEDED', '任务超过五分钟运行上限', error)
        if (
          toolChannel &&
          !channelFallbackUsed &&
          error instanceof ProviderGatewayError &&
          error.category === 'protocol_error'
        ) {
          toolChannel = false
          channelFallbackUsed = true
          context = await createDraftConversation(prompt, claim, false, this.api, state, heartbeat.signal)
          continue
        }
        throw error
      }
      usage.inputTokens += message.usage.input
      usage.outputTokens += message.usage.output
      await this.event(claim, 'model_request_finished', {
        turn,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        attempt: attempts,
      })
      context.messages.push(message)
      const calls = message.content.filter((part): part is ToolCall => part.type === 'toolCall')

      if (toolChannel && calls.length === 0 && !state.contextLoaded) {
        toolChannel = false
        channelFallbackUsed = true
        context = await createDraftConversation(prompt, claim, false, this.api, state, heartbeat.signal)
        continue
      }

      if (calls.length === 0) {
        const parsed = parseExactDraft(message)
        if (parsed.error !== undefined) {
          if (formatRepairUsed) {
            throw new TaskExecutionError('AI_ARTIFACT_SCHEMA_INVALID', `模型 Draft 两次无效：${parsed.error}`)
          }
          formatRepairUsed = true
          context.messages.push({
            role: 'user',
            content: `只修复 JSON 输出，不要解释、不要 Markdown 代码围栏。错误：${parsed.error}`,
            timestamp: Date.now(),
          })
          continue
        }
        const completed = await this.acceptDraft(
          claim,
          parsed.draft,
          state,
          usage,
          heartbeat,
          turn,
          undefined,
          context,
          formatRepairUsed,
        )
        if (completed) return
        formatRepairUsed = true
        continue
      }

      for (const call of calls) {
        ensureBoundary(deadlineAt, heartbeat)
        state.countToolCall(claim.task.limits.maxToolCalls)
        await this.event(claim, 'tool_started', { turn, tool: call.name, toolCalls: state.toolCalls })
        const outcome = await state.execute(call, this.api, heartbeat.signal)
        await this.event(claim, 'tool_finished', { turn, tool: call.name, toolCalls: state.toolCalls })
        if (outcome.draft === undefined) {
          context.messages.push(outcome.result)
          continue
        }
        const completed = await this.acceptDraft(
          claim,
          outcome.draft,
          state,
          usage,
          heartbeat,
          turn,
          call,
          context,
          formatRepairUsed,
        )
        if (completed) return
        formatRepairUsed = true
        break
      }
    }
    throw new TaskExecutionError('AI_TURN_LIMIT', '模型交互达到四轮上限仍未产生有效 Draft')
  }

  private async acceptDraft(
    claim: ClaimedTask,
    draft: unknown,
    state: DraftToolState,
    usage: Usage,
    heartbeat: TaskHeartbeat,
    turn: number,
    call: ToolCall | undefined,
    context: Context,
    formatRepairUsed: boolean,
  ): Promise<boolean> {
    const normalizedDraft = formatRepairUsed && state.previousDraft !== undefined
      ? mergeArtifactDraftRepair(state.previousDraft, draft)
      : normalizeArtifactDraft(draft)
    state.previousDraft = normalizedDraft
    const materialized = materializeArtifactDraft(
      normalizedDraft,
      claim,
      this.artifactContract,
      state.readAttachmentIds,
    )
    if (materialized.artifact === undefined) {
      const detail = materialized.error ?? 'Draft 无法转换为 Artifact'
      if (formatRepairUsed) throw new TaskExecutionError('AI_ARTIFACT_SCHEMA_INVALID', `模型 Draft 两次未通过校验：${detail}`)
      context.messages.push(call === undefined
        ? {
            role: 'user',
            content: `只修复 Draft JSON，不要解释、不要 Markdown 代码围栏。错误：${detail}`,
            timestamp: Date.now(),
          }
        : toolError(call, `Draft 未通过校验，只修复这些字段后重新提交：${detail}`))
      return false
    }
    await this.event(claim, 'candidate_received', { turn, toolCalls: state.toolCalls })
    try {
      await completeWithOneTransportRetry(this.api, claim, materialized.artifact, usage, heartbeat.signal)
      return true
    } catch (error) {
      if (error instanceof TaskClientError && error.status === 422 && !formatRepairUsed) {
        context.messages.push(call === undefined
          ? {
              role: 'user',
              content: '服务端拒绝了转换结果。只重新提交一份完整 Draft JSON，不要解释、不要 Markdown 代码围栏。',
              timestamp: Date.now(),
            }
          : toolError(call, '服务端拒绝了转换结果；只重新提交一份完整 Draft。'))
        return false
      }
      throw error
    }
  }

  private event(claim: ClaimedTask, type: SafeTaskEvent['type'], details: SafeTaskEvent['details']): Promise<void> {
    return this.api.events(claim, [{ type, details }])
  }
}

class TaskHeartbeat {
  readonly #controller = new AbortController()
  #timer: ReturnType<typeof setTimeout> | undefined
  #shutdownHandler: (() => void) | undefined
  #stopped = false
  cancelRequested = false
  leaseLost = false

  constructor(readonly api: TaskApi, readonly claim: ClaimedTask, readonly shutdownSignal?: AbortSignal) {
    this.#shutdownHandler = () => {
      this.leaseLost = true
      this.#controller.abort(this.shutdownSignal?.reason)
    }
    shutdownSignal?.addEventListener('abort', this.#shutdownHandler, { once: true })
  }

  get signal(): AbortSignal { return this.#controller.signal }

  async start(): Promise<void> {
    await this.tick()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    if (this.#shutdownHandler !== undefined) {
      this.shutdownSignal?.removeEventListener('abort', this.#shutdownHandler)
    }
  }

  private async tick(): Promise<void> {
    if (this.#stopped) return
    try {
      const result = await this.api.heartbeat(this.claim)
      if (result.cancelRequested) {
        this.cancelRequested = true
        this.#controller.abort(new Error('task cancellation requested'))
        return
      }
    } catch (error) {
      this.leaseLost = true
      this.#controller.abort(error)
      return
    }
    this.#timer = setTimeout(() => { void this.tick() }, heartbeatIntervalMs)
  }
}

class ToolState {
  toolCalls = 0
  contextLoaded = false
  readonly callKeys = new Set<string>()
  readonly readAttachmentIds = new Set<string>()

  constructor(readonly claim: ClaimedTask) {}

  countToolCall(configuredMaximum: number): void {
    this.toolCalls += 1
    if (this.toolCalls > Math.min(maximumToolCalls, configuredMaximum)) {
      throw new TaskExecutionError('AI_TOOL_LIMIT', '领域工具调用达到八次上限')
    }
  }

  async execute(
    call: ToolCall,
    api: Pick<TaskApi, 'attachment'>,
    signal: AbortSignal,
  ): Promise<{ result: ToolResultMessage; artifact?: Record<string, unknown> }> {
    if (call.name === 'get_record_context') {
      requireKeys(call.arguments, [])
      this.unique('get_record_context')
      this.contextLoaded = true
      return { result: toolJson(call, this.claim.input) }
    }
    if (!this.contextLoaded) {
      throw new TaskExecutionError('AI_TOOL_INVALID', '模型必须先读取当前记录上下文')
    }
    if (call.name === 'get_attachment') {
      requireKeys(call.arguments, ['attachmentId'])
      if (this.claim.task.type !== 'analyze_image' || typeof call.arguments.attachmentId !== 'string') {
        throw new TaskExecutionError('AI_TOOL_INVALID', '当前任务不允许读取该附件')
      }
      const attachment = this.claim.input.attachments.find((entry) => entry.id === call.arguments.attachmentId)
      if (attachment === undefined || attachment.kind !== 'image' || !attachment.mediaType.startsWith('image/')) {
        throw new TaskExecutionError('AI_TOOL_INVALID', '附件不在任务授权图片集合中')
      }
      this.unique(`get_attachment:${attachment.id}`)
      const bytes = await api.attachment(this.claim, attachment, signal)
      this.readAttachmentIds.add(attachment.id)
      return {
        result: {
          role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: false,
          content: [
            { type: 'text', text: JSON.stringify({ attachmentId: attachment.id, mediaType: attachment.mediaType }) },
            { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: attachment.mediaType },
          ],
          timestamp: Date.now(),
        },
      }
    }
    if (call.name === 'search_related_records') {
      requireKeys(call.arguments, ['query', 'limit'])
      const query = typeof call.arguments.query === 'string' ? call.arguments.query.trim() : ''
      const limit = call.arguments.limit
      if (!query || query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
        throw new TaskExecutionError('AI_TOOL_INVALID', '相关记录检索参数无效')
      }
      this.unique(`search_related_records:${query.toLocaleLowerCase()}:${String(limit)}`)
      const normalized = query.toLocaleLowerCase()
      const items = this.claim.input.relatedRecords.filter((entry) =>
        `${entry.title}\n${entry.summary}`.toLocaleLowerCase().includes(normalized),
      ).slice(0, limit as number)
      return { result: toolJson(call, { items }) }
    }
    if (call.name === 'emit_candidate_artifact') {
      requireKeys(call.arguments, ['artifact'])
      if (!isObject(call.arguments.artifact)) {
        throw new TaskExecutionError('AI_TOOL_INVALID', '候选 Artifact 参数无效')
      }
      return { result: toolJson(call, { accepted: true }), artifact: call.arguments.artifact }
    }
    throw new TaskExecutionError('AI_TOOL_INVALID', '模型请求了未授权工具')
  }

  private unique(key: string): void {
    if (this.callKeys.has(key)) throw new TaskExecutionError('AI_TOOL_INVALID', '模型重复调用了同一领域工具')
    this.callKeys.add(key)
  }
}

class DraftToolState {
  toolCalls = 0
  contextLoaded = false
  previousDraft: unknown = undefined
  readonly callKeys = new Set<string>()
  readonly readAttachmentIds = new Set<string>()

  constructor(readonly claim: ClaimedTask) {}

  countToolCall(configuredMaximum: number): void {
    this.toolCalls += 1
    if (this.toolCalls > Math.min(maximumToolCalls, configuredMaximum)) {
      throw new TaskExecutionError('AI_TOOL_LIMIT', '领域工具调用达到八次上限')
    }
  }

  async execute(
    call: ToolCall,
    api: Pick<TaskApi, 'attachment'>,
    signal: AbortSignal,
  ): Promise<{ result: ToolResultMessage; draft?: Record<string, unknown> }> {
    if (call.name === 'get_record_context') {
      requireKeys(call.arguments, [])
      this.unique('get_record_context')
      this.contextLoaded = true
      return { result: toolJson(call, createModelTaskContext(this.claim)) }
    }
    if (!this.contextLoaded) {
      throw new TaskExecutionError('AI_TOOL_INVALID', '模型必须先读取当前记录上下文')
    }
    if (call.name === 'get_attachment') {
      requireKeys(call.arguments, ['attachmentRef'])
      if (this.claim.task.type !== 'analyze_image' || typeof call.arguments.attachmentRef !== 'string') {
        throw new TaskExecutionError('AI_TOOL_INVALID', '当前任务不允许读取该附件')
      }
      const attachment = attachmentForRef(this.claim, call.arguments.attachmentRef)
      if (attachment === undefined || attachment.kind !== 'image' || !attachment.mediaType.startsWith('image/')) {
        throw new TaskExecutionError('AI_TOOL_INVALID', '附件引用不在任务授权图片集合中')
      }
      this.unique(`get_attachment:${attachment.id}`)
      const bytes = await api.attachment(this.claim, attachment, signal)
      this.readAttachmentIds.add(attachment.id)
      return {
        result: {
          role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: false,
          content: [
            { type: 'text', text: JSON.stringify({ attachmentRef: call.arguments.attachmentRef, mediaType: attachment.mediaType }) },
            { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: attachment.mediaType },
          ],
          timestamp: Date.now(),
        },
      }
    }
    if (call.name === 'search_related_records') {
      requireKeys(call.arguments, ['query', 'limit'])
      const query = typeof call.arguments.query === 'string' ? call.arguments.query.trim() : ''
      const limit = call.arguments.limit
      if (!query || query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
        throw new TaskExecutionError('AI_TOOL_INVALID', '相关记录检索参数无效')
      }
      this.unique(`search_related_records:${query.toLocaleLowerCase()}:${String(limit)}`)
      const normalized = query.toLocaleLowerCase()
      const items = this.claim.input.relatedRecords.filter((entry) =>
        `${entry.title}\n${entry.summary}`.toLocaleLowerCase().includes(normalized),
      ).slice(0, limit as number).map((entry) => ({ title: entry.title, summary: entry.summary }))
      return { result: toolJson(call, { items }) }
    }
    if (call.name === 'emit_artifact_draft') {
      if (!isObject(call.arguments)) throw new TaskExecutionError('AI_TOOL_INVALID', 'Draft 参数无效')
      return { result: toolJson(call, { accepted: true }), draft: call.arguments }
    }
    throw new TaskExecutionError('AI_TOOL_INVALID', '模型请求了未授权工具')
  }

  private unique(key: string): void {
    if (this.callKeys.has(key)) throw new TaskExecutionError('AI_TOOL_INVALID', '模型重复调用了同一领域工具')
    this.callKeys.add(key)
  }
}

async function createDraftConversation(
  prompt: string,
  claim: ClaimedTask,
  toolChannel: boolean,
  api: Pick<TaskApi, 'attachment'>,
  state: DraftToolState,
  signal: AbortSignal,
): Promise<Context> {
  const channelInstruction = toolChannel
    ? '必须先调用 get_record_context。完成后调用 emit_artifact_draft；该工具的参数本身就是完整 Draft，不要添加 draft 或 artifact 包装层。'
    : '当前消息已直接提供完整受控上下文。最终响应只能是一个完整 Draft JSON 对象；不要解释，不要 Markdown 代码围栏，不要调用工具。'
  const context: Context = {
    systemPrompt: `${prompt}\n\n任务 schemaVersion=${claim.task.schemaVersion}，taskType=${claim.task.type}。\n${draftContractGuide}\n\n${channelInstruction}`,
    messages: [],
    ...(toolChannel ? { tools: createDraftTools(claim) } : {}),
  }
  if (toolChannel) {
    context.messages.push({
      role: 'user',
      content: '读取当前条目的受控上下文，随后提交 Artifact Draft。',
      timestamp: Date.now(),
    })
    return context
  }

  const modelContext = createModelTaskContext(claim)
  const text = `受控任务上下文如下。S# 只能从 sources.ref 选择，A# 只能从 attachments.ref 选择。\n${JSON.stringify(modelContext)}\n\n现在只返回完整 Draft JSON。`
  if (claim.task.type !== 'analyze_image') {
    context.messages.push({ role: 'user', content: text, timestamp: Date.now() })
    return context
  }
  const content: Array<
    { type: 'text'; text: string } |
    { type: 'image'; data: string; mimeType: string }
  > = [{ type: 'text', text }]
  for (const attachment of claim.input.attachments) {
    if (attachment.kind !== 'image' || !attachment.mediaType.startsWith('image/')) continue
    const bytes = await api.attachment(claim, attachment, signal)
    state.readAttachmentIds.add(attachment.id)
    const attachmentIndex = claim.input.attachments.indexOf(attachment) + 1
    content.push({ type: 'text', text: `下面是附件 A${attachmentIndex}：` })
    content.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: attachment.mediaType })
  }
  context.messages.push({ role: 'user', content, timestamp: Date.now() })
  return context
}

function createDraftTools(claim: ClaimedTask): Tool[] {
  const tools: Tool[] = [
    asTool('get_record_context', '读取带 R#/S#/A# 短引用的当前条目受控上下文。', objectSchema({})),
  ]
  if (claim.task.type === 'analyze_image') {
    tools.push(asTool('get_attachment', '读取一张当前任务授权的 A# 图片。', objectSchema({
      attachmentRef: { type: 'string', pattern: '^A[1-9][0-9]*$' },
    }, ['attachmentRef'])))
  }
  if (claim.input.relatedRecords.length > 0) {
    tools.push(asTool('search_related_records', '筛选服务端已提供的安全相关记录；结果不可作为 S# 来源。', objectSchema({
      query: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    }, ['query', 'limit'])))
  }
  tools.push(asTool('emit_artifact_draft', '提交完整 Artifact Draft；参数直接使用 Draft 根对象。', artifactDraftSchema))
  return tools
}

function attachmentForRef(
  claim: ClaimedTask,
  ref: string,
): ClaimedTask['input']['attachments'][number] | undefined {
  const match = /^A([1-9][0-9]*)$/.exec(ref)
  if (match === null) return undefined
  return claim.input.attachments[Number(match[1]) - 1]
}

function parseExactDraft(message: AssistantMessage): { draft: Record<string, unknown>; error?: undefined } | { draft?: undefined; error: string } {
  const parts = message.content.filter((part) => part.type === 'text')
  if (parts.length === 0) return { error: '响应中没有 JSON 文本' }
  const raw = parts.map((part) => part.text).join('').trim()
  if (!raw) return { error: '响应中的 JSON 文本为空' }
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(raw)
  const candidate = fenced === null ? raw : fenced[1]!.trim()
  try {
    const value: unknown = JSON.parse(candidate)
    return isObject(value) ? { draft: value } : { error: 'JSON 根节点必须是对象' }
  } catch {
    return { error: '响应必须是单个 JSON 对象，或只包含该对象的单个 JSON 代码围栏' }
  }
}

const draftContractGuide = `Artifact Draft 固定包含 title、summary、classification、blocks、warnings、limitations。
classification 固定包含 contentType、suggestedFolderPath、suggestedTags、sensitivitySuggestion，可选 sensitivityReason。
contentType 只能是 operations_guide、command_snippet、credential_related、deployment、database、development、reference、image、file、mixed、other；sensitivitySuggestion 只能是 normal、sensitive、unknown。
每个 block 固定包含 type 和 sourceRefs。type 及额外必填字段：
- markdown: markdown
- code: language, code
- command: shell, command
- command_steps: title, steps；每个 step 含 title, commands, sourceRefs
- key_value: entries；每项含 key, value, sensitive
- table: columns, rows，且每行列数一致
- checklist: title, items；每项含 label, sourceRefs
- callout: tone, body
- image_reference: attachmentRef
- attachment_reference: attachmentRef
shell 只能是 bash、sh、zsh、powershell、cmd、sql、docker、yaml、text、other；callout tone 只能是 info、tip、warning、danger。
每个 warning 固定包含 severity、title、message、basis、sourceRefs；severity 只能是 info、warning、danger；basis 只能是 source_evidence、model_knowledge，且 basis=source_evidence 时 sourceRefs 不得为空。
sourceRefs 只能填写当前上下文的 S#；attachmentRef 只能填写当前上下文的 A#。不要输出 schemaVersion、artifactType、block id、真实 UUID、顶层 sourceFragmentIds 或 review，服务端会确定性生成。limitations 至少写一条真实限制。`

function createTools(schema: Record<string, unknown>, claim: ClaimedTask): Tool[] {
  const tools: Tool[] = [
    asTool('get_record_context', '读取本任务当前条目的受控原始记录、片段和附件元数据。', objectSchema({})),
  ]
  if (claim.task.type === 'analyze_image') {
    tools.push(asTool('get_attachment', '读取一张本任务已授权图片。', objectSchema({
      attachmentId: { type: 'string', format: 'uuid' },
    }, ['attachmentId'])))
  }
  if (claim.input.relatedRecords.length > 0) {
    tools.push(asTool('search_related_records', '在 API 已提供的最多十条安全相关记录中筛选背景；结果不可作为来源 ID。', objectSchema({
      query: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    }, ['query', 'limit'])))
  }
  tools.push(asTool('emit_candidate_artifact', '提交唯一的完整候选 Artifact。此工具不会修改原始记录。', artifactToolSchema(schema)))
  return tools
}

function artifactToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const artifact = { ...schema }
  delete artifact.$schema
  const definitions = artifact.$defs
  delete artifact.$defs
  return {
    type: 'object', additionalProperties: false, required: ['artifact'],
    properties: { artifact },
    ...(definitions === undefined ? {} : { $defs: definitions }),
  }
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, required }
}

function asTool(name: string, description: string, parameters: Record<string, unknown>): Tool {
  return { name, description, parameters } as unknown as Tool
}

function validateCandidateArtifact(
  contract: ArtifactContract,
  artifact: Record<string, unknown>,
  claim: ClaimedTask,
  readAttachmentIds: ReadonlySet<string>,
): string | null {
  let encoded: string
  try {
    encoded = JSON.stringify(artifact)
  } catch {
    return 'serialization'
  }
  if (Buffer.byteLength(encoded) > maximumArtifactBytes || !contract.validate(artifact)) return 'schema'
  const expectedType = claim.task.type === 'organize_record'
    ? 'organized_record'
    : claim.task.type === 'review_record' ? 'correctness_review' : 'image_analysis'
  if (artifact.schemaVersion !== claim.task.schemaVersion || artifact.artifactType !== expectedType) return 'type'
  const topSources = stringSet(artifact.sourceFragmentIds)
  if (topSources === null || (claim.task.type !== 'analyze_image' && topSources.size === 0)) return 'sources'
  const allowedSources = new Set(claim.input.fragments.map((fragment) => fragment.id))
  for (const id of topSources) if (!allowedSources.has(id)) return 'sources'
  if (!referencesStayWithin(artifact, topSources)) return 'sources'

  const blocks = Array.isArray(artifact.blocks) ? artifact.blocks : []
  const blockIds = new Set<string>()
  const attachmentIds = new Set<string>()
  const imageIds = new Set<string>()
  const attachmentKinds = new Map(claim.input.attachments.map((attachment) => [attachment.id, attachment.kind]))
  for (const value of blocks) {
    if (!isObject(value) || typeof value.id !== 'string' || blockIds.has(value.id)) return 'blocks'
    blockIds.add(value.id)
    if (value.type === 'markdown' && typeof value.markdown === 'string' && containsRawHtml(value.markdown)) return 'html'
    if (value.type === 'table') {
      const columns = value.columns
      if (!Array.isArray(columns) || !Array.isArray(value.rows) || value.rows.some((row) => !Array.isArray(row) || row.length !== columns.length)) return 'table'
    }
    if (value.type === 'image_reference' || value.type === 'attachment_reference') {
      if (typeof value.attachmentId !== 'string' || attachmentIds.has(value.attachmentId)) return 'attachments'
      const expectedKind = value.type === 'image_reference' ? 'image' : 'file'
      if (attachmentKinds.get(value.attachmentId) !== expectedKind) return 'attachments'
      attachmentIds.add(value.attachmentId)
      if (value.type === 'image_reference') imageIds.add(value.attachmentId)
    }
  }
  const classification = isObject(artifact.classification) ? artifact.classification : {}
  if (!caseFoldedUnique(classification.suggestedTags)) return 'tags'
  const warnings = Array.isArray(artifact.warnings) ? artifact.warnings : []
  for (const warning of warnings) {
    if (!isObject(warning)) return 'warnings'
    if (warning.basis === 'source_evidence') {
      const sources = stringSet(warning.sourceFragmentIds)
      if (sources === null || sources.size === 0) return 'warnings'
    }
  }
  if (claim.task.type === 'analyze_image') {
    const authorizedImages = claim.input.attachments.filter((entry) => entry.kind === 'image').map((entry) => entry.id)
    if (readAttachmentIds.size !== authorizedImages.length || imageIds.size !== authorizedImages.length) return 'images'
    for (const id of authorizedImages) if (!readAttachmentIds.has(id) || !imageIds.has(id)) return 'images'
  }
  return null
}

function referencesStayWithin(value: unknown, top: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.every((entry) => referencesStayWithin(entry, top))
  if (!isObject(value)) return true
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'sourceFragmentIds') {
      const ids = stringSet(nested)
      if (ids === null) return false
      for (const id of ids) if (!top.has(id)) return false
    }
    if (!referencesStayWithin(nested, top)) return false
  }
  return true
}

function stringSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null
  const result = new Set(value as string[])
  return result.size === value.length ? result : null
}

function caseFoldedUnique(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') return false
    const normalized = entry.trim().toLocaleLowerCase()
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
  }
  return true
}

function containsRawHtml(value: string): boolean {
  return /<(?:\/?[A-Za-z][^>]*|!--|!doctype\b|\?xml\b)[^>]*>/iu.test(value)
}

function requireKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort()
  const allowed = [...expected].sort()
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new TaskExecutionError('AI_TOOL_INVALID', '领域工具参数包含缺失或未授权字段')
  }
}

function toolJson(call: ToolCall, value: unknown): ToolResultMessage {
  return {
    role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: false,
    content: [{ type: 'text', text: JSON.stringify(value) }], timestamp: Date.now(),
  }
}

function toolError(call: ToolCall, message: string): ToolResultMessage {
  return {
    role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: true,
    content: [{ type: 'text', text: message }], timestamp: Date.now(),
  }
}

async function completeWithOneTransportRetry(
  api: Pick<TaskApi, 'complete'>,
  claim: ClaimedTask,
  artifact: Record<string, unknown>,
  usage: Usage,
  signal: AbortSignal,
): Promise<void> {
  try {
    await api.complete(claim, artifact, usage, signal)
  } catch (error) {
    if (!(error instanceof TaskClientError) || error.status !== 0 || signal.aborted) throw error
    await api.complete(claim, artifact, usage, signal)
  }
}

function validateClaimLimits(claim: ClaimedTask): void {
  const deadline = new Date(claim.task.limits.deadlineAt).getTime()
  if (
    !Number.isFinite(deadline) || deadline <= Date.now() || deadline - Date.now() > 5 * 60 * 1_000 + 5_000 ||
    claim.task.limits.maxTurns < 1 || claim.task.limits.maxToolCalls < 1 ||
    claim.task.limits.maxTurns > maximumTurns || claim.task.limits.maxToolCalls > maximumToolCalls
  ) {
    throw new TaskExecutionError('AI_INTERNAL_ERROR', 'API 返回的任务限制无效')
  }
  if (
    claim.input.sensitivity !== 'normal' && claim.input.sensitivePolicy === 'block' ||
    claim.task.type === 'analyze_image' && claim.input.sensitivity !== 'normal' && claim.input.sensitivePolicy === 'redact'
  ) {
    throw new TaskExecutionError('AI_SENSITIVE_BLOCKED', '敏感策略禁止外发任务输入')
  }
}

function ensureBoundary(deadlineAt: Date, heartbeat: TaskHeartbeat): void {
  if (heartbeat.cancelRequested) throw new TaskExecutionError('AI_TASK_CANCELLED', '用户已请求取消任务')
  if (heartbeat.leaseLost) throw new TaskExecutionError('AI_INTERNAL_ERROR', '任务租约已失效')
  if (Date.now() >= deadlineAt.getTime()) throw new TaskExecutionError('AI_TASK_DEADLINE_EXCEEDED', '任务超过五分钟运行上限')
}

function normalizeFailure(error: unknown, cancelled: boolean, rawDeadline: string): TaskExecutionError {
  if (cancelled) return new TaskExecutionError('AI_TASK_CANCELLED', '用户已请求取消任务', error)
  if (Date.now() >= new Date(rawDeadline).getTime()) return new TaskExecutionError('AI_TASK_DEADLINE_EXCEEDED', '任务超过五分钟运行上限', error)
  if (error instanceof TaskExecutionError) return error
  if (error instanceof ProviderGatewayError) {
    if (error.category === 'credentials_invalid') return new TaskExecutionError('AI_PROVIDER_CREDENTIALS_INVALID', 'Provider 凭据无效')
    if (error.category === 'capability_mismatch') return new TaskExecutionError('AI_MODEL_CAPABILITY_MISSING', '模型能力不满足任务要求')
    if (error.category === 'protocol_error') return new TaskExecutionError('AI_PROTOCOL_ERROR', 'Provider 返回了不符合协议的响应')
    return new TaskExecutionError('AI_PROVIDER_UNAVAILABLE', 'Provider 暂时不可用')
  }
  return new TaskExecutionError('AI_INTERNAL_ERROR', 'AI worker 内部错误', error)
}

function isLeaseConflict(error: unknown): boolean {
  return error instanceof TaskClientError && error.status === 409 && error.code === 'AI_TASK_LEASE_CONFLICT'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function runTaskLoop(
  client: TaskClient,
  runner: TaskRunner,
  signal: AbortSignal,
  idleDelayMs = 1_000,
): Promise<void> {
  while (!signal.aborted) {
    let claim: ClaimedTask | null
    try {
      claim = await client.claim(signal)
    } catch (error) {
      if (signal.aborted) return
      await abortableDelay(idleDelayMs, signal)
      continue
    }
    if (claim === null) {
      await abortableDelay(idleDelayMs, signal)
      continue
    }
    try {
      await runner.run(claim, signal)
    } catch (error) {
      // A transient API failure while reporting a finished task must not kill
      // the lane: the lease expires server-side and the task is re-claimed.
      // Lease conflicts (409) and task failures are handled inside runner.run.
      if (!isRecoverableReportError(error)) throw error
      if (signal.aborted) return
      log('warn', 'task_report_failed', {
        errorType: error instanceof Error ? error.name : 'unknown',
        status: error.status,
      })
      await abortableDelay(idleDelayMs, signal)
    }
  }
}

// Transient API failures: network unreachable (status 0) and 5xx responses.
// Anything else escaping the runner is an unexpected defect and must surface
// to the process shutdown so the container restart policy takes over.
function isRecoverableReportError(error: unknown): error is TaskClientError {
  return error instanceof TaskClientError && (error.status === 0 || error.status >= 500)
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timeout = setTimeout(finish, milliseconds)
    const abort = (): void => {
      clearTimeout(timeout)
      finish()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

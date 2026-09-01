import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isInteger, isLosslessNumber, isSafeNumber, parse as parseLosslessJson } from 'lossless-json'

import { loadArtifactContract } from './artifact-schema.js'
import {
  handleAssistantInternalRequest,
  startAssistantRunners,
  type AssistantRunnerOptions,
} from './assistant/index.js'
import { loadConfig } from './config.js'
import { log } from './logger.js'
import {
  generateJsonTypesWithAI,
  JsonTypeGenerationError,
  type JsonTypeGenerationMode,
} from './json-type-generation.js'
import { observeJsonTypeGenerationHttpLifecycle } from './json-type-generation-http.js'
import {
  ProviderGatewayError,
  testProviderConnection,
  type ProviderProtocol,
  type ProviderSnapshot,
} from './model-gateway.js'
import { PromptStore } from './prompts.js'
import { TaskClient } from './task-client.js'
import { runTaskLoop, TaskRunner } from './task-runner.js'

const config = loadConfig()
const artifactContract = await loadArtifactContract(config.artifactSchemaPath)
const taskClient = new TaskClient(config.apiInternalUrl, config.serviceToken, config.workerId)
const taskRunner = new TaskRunner(
  taskClient,
  new PromptStore(config.promptRoot),
  artifactContract,
  config.allowInsecureProviderHttp,
)
const taskLoopController = new AbortController()
const assistantOptions: AssistantRunnerOptions = {
  apiInternalUrl: config.apiInternalUrl,
  serviceToken: config.serviceToken,
  workerId: config.workerId,
  allowInsecureProviderHttp: config.allowInsecureProviderHttp,
}
const assistantRunners = startAssistantRunners(assistantOptions)

const [host, rawPort] = config.address.split(':')
const port = Number(rawPort)

if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('WORKER_ADDRESS 必须是 host:port')
}

const server = createServer((request, response) => {
  void handleRequest(request, response)
})

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET' && request.url === '/health/live') {
    writeJson(response, 200, { status: 'live', service: 'ai-worker' })
    return
  }

  if (request.method === 'POST' && request.url === '/internal/provider-test') {
    if (!validInternalAuthorization(request.headers.authorization, config.serviceToken)) {
      writeJson(response, 401, { error: { code: 'AUTH_REQUIRED', message: '内部服务凭据无效' } })
      return
    }
    try {
      const input = await readProviderTestInput(request)
      const result = await testProviderConnection(input.provider, input.deadlineAt, config.allowInsecureProviderHttp)
      writeJson(response, 200, result)
    } catch (error) {
      if (error instanceof ProviderGatewayError && error.category === 'credentials_invalid') {
        writeJson(response, 422, { status: 'failed', latencyMs: 0, usage: null, failureCategory: 'credentials_invalid' })
        return
      }
      writeJson(response, 503, { status: 'failed', latencyMs: 0, usage: null, failureCategory: 'unavailable' })
    }
    return
  }

  if (request.method === 'POST' && request.url === '/internal/v2/json-type-generation') {
    if (!validInternalAuthorization(request.headers.authorization, config.serviceToken)) {
      writeJson(response, 401, { error: { code: 'AUTH_REQUIRED', message: '内部服务凭据无效' } })
      return
    }
    const requestLifecycle = observeJsonTypeGenerationHttpLifecycle(request, response)
    try {
      const input = await readJsonTypeGenerationInput(request)
      if (!requestLifecycle.canWriteResponse()) return
      const result = await generateJsonTypesWithAI(
        { ...input, signal: requestLifecycle.signal },
        config.allowInsecureProviderHttp,
      )
      if (!requestLifecycle.canWriteResponse()) return
      writeJson(response, 200, result)
    } catch (error) {
      if (!requestLifecycle.canWriteResponse()) return
      if (error instanceof JsonTypeGenerationError) {
        const status = error.code === 'AI_CONTEXT_TOO_LARGE' ? 422 : error.code === 'INVALID_INPUT' ? 400 : 502
        writeJson(response, status, { error: { code: error.code, message: jsonTypeGenerationMessage(error.code) } })
        return
      }
      if (error instanceof ProviderGatewayError) {
        const rejected = error.category === 'credentials_invalid' || error.category === 'protocol_error' || error.category === 'capability_mismatch'
        writeJson(response, rejected ? 502 : 503, {
          error: {
            code: rejected ? 'UPSTREAM_REJECTED' : 'UPSTREAM_UNAVAILABLE',
            message: rejected ? 'Provider 拒绝了类型生成请求' : 'Provider 暂时不可用',
          },
        })
        return
      }
      writeJson(response, 503, { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Provider 暂时不可用' } })
    } finally {
      requestLifecycle.dispose()
    }
    return
  }

  if (await handleAssistantInternalRequest(request, response, assistantOptions)) return

  writeJson(response, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } })
}

async function readJsonTypeGenerationInput(request: IncomingMessage): Promise<Parameters<typeof generateJsonTypesWithAI>[0]> {
  const value = await readJsonBody(request, 320 * 1024)
  if (!isObject(value) || !hasOnlyKeys(value, ['targetLanguage', 'mode', 'input', 'provider', 'deadlineAt']) ||
      typeof value.targetLanguage !== 'string' ||
      (value.mode !== 'structure' && value.mode !== 'full') ||
      !Object.hasOwn(value, 'input') ||
      !isObject(value.provider) ||
      !hasOnlyKeys(value.provider, ['protocol', 'baseUrl', 'apiKey', 'modelId', 'contextWindow', 'maxOutputTokens']) ||
      !isProtocol(value.provider.protocol) ||
      typeof value.provider.baseUrl !== 'string' ||
      typeof value.provider.apiKey !== 'string' ||
      typeof value.provider.modelId !== 'string' ||
      typeof value.deadlineAt !== 'string') {
    throw new JsonTypeGenerationError('INVALID_INPUT')
  }
  const contextWindow = safePositiveInteger(value.provider.contextWindow)
  const maxOutputTokens = safePositiveInteger(value.provider.maxOutputTokens)
  if (contextWindow === undefined || maxOutputTokens === undefined) {
    throw new JsonTypeGenerationError('INVALID_INPUT')
  }
  const deadlineAt = new Date(value.deadlineAt)
  if (!Number.isFinite(deadlineAt.getTime())) throw new JsonTypeGenerationError('INVALID_INPUT')
  return {
    targetLanguage: value.targetLanguage,
    mode: value.mode as JsonTypeGenerationMode,
    input: value.input,
    provider: {
      protocol: value.provider.protocol,
      baseUrl: value.provider.baseUrl,
      apiKey: value.provider.apiKey,
      modelId: value.provider.modelId,
      contextWindow,
      maxOutputTokens,
    },
    deadlineAt,
  }
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximumBytes) throw new JsonTypeGenerationError('INVALID_INPUT')
    chunks.push(buffer)
  }
  try {
    return parseLosslessJson(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new JsonTypeGenerationError('INVALID_INPUT')
  }
}

function safePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  if (isLosslessNumber(value) && isInteger(value.value) && isSafeNumber(value.value)) {
    const parsed = Number(value.value)
    return parsed > 0 ? parsed : undefined
  }
  return undefined
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key))
}

function jsonTypeGenerationMessage(code: JsonTypeGenerationError['code']): string {
  if (code === 'AI_CONTEXT_TOO_LARGE') return '当前模型容量不足，请选择更大模型或结构模式'
  if (code === 'UPSTREAM_REJECTED') return 'Provider 返回了不可用的代码结果'
  return 'JSON 类型生成请求无效'
}

async function readProviderTestInput(request: IncomingMessage): Promise<{
  requestId: string
  provider: ProviderSnapshot
  deadlineAt: Date
}> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > 64 * 1024) throw new ProviderGatewayError('unavailable')
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ProviderGatewayError('unavailable')
  }
  if (!isObject(value) || typeof value.requestId !== 'string' || !isObject(value.provider) || typeof value.deadlineAt !== 'string') {
    throw new ProviderGatewayError('unavailable')
  }
  const provider = value.provider
  if (
    !isProtocol(provider.protocol) ||
    typeof provider.baseUrl !== 'string' ||
    typeof provider.apiKey !== 'string' ||
    typeof provider.modelId !== 'string'
  ) {
    throw new ProviderGatewayError('unavailable')
  }
  const deadlineAt = new Date(value.deadlineAt)
  if (!Number.isFinite(deadlineAt.getTime())) throw new ProviderGatewayError('unavailable')
  return {
    requestId: value.requestId,
    provider: {
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      modelId: provider.modelId,
    },
    deadlineAt,
  }
}

function validInternalAuthorization(value: string | undefined, expectedToken: string): boolean {
  const supplied = value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : ''
  const suppliedHash = createHash('sha256').update(supplied).digest()
  const expectedHash = createHash('sha256').update(expectedToken).digest()
  return timingSafeEqual(suppliedHash, expectedHash) && supplied.length > 0
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProtocol(value: unknown): value is ProviderProtocol {
  return value === 'openai-completions' || value === 'openai-responses' || value === 'anthropic-messages'
}

server.listen(port, host, () => {
  log('info', 'worker_started', { address: config.address })
  void runTaskLoop(taskClient, taskRunner, taskLoopController.signal).catch((error: unknown) => {
    if (!taskLoopController.signal.aborted) {
      log('error', 'task_loop_failed', { errorType: error instanceof Error ? error.name : 'unknown' })
      process.exitCode = 1
    }
  })
})

function shutdown(signal: string): void {
  log('info', 'worker_stopping', { signal })
  taskLoopController.abort(new Error(`worker received ${signal}`))
  assistantRunners.stop()
  server.close((error) => {
    if (error) {
      log('error', 'worker_stop_failed', { errorType: error.name })
      process.exitCode = 1
    }
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

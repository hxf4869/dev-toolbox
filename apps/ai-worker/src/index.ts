import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { loadArtifactValidator } from './artifact-schema.js'
import { loadConfig } from './config.js'
import { log } from './logger.js'
import {
  ProviderGatewayError,
  testProviderConnection,
  type ProviderProtocol,
  type ProviderSnapshot,
} from './model-gateway.js'

const config = loadConfig()
await loadArtifactValidator(config.artifactSchemaPath)

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

  writeJson(response, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } })
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
})

function shutdown(signal: string): void {
  log('info', 'worker_stopping', { signal })
  server.close((error) => {
    if (error) {
      log('error', 'worker_stop_failed', { errorType: error.name })
      process.exitCode = 1
    }
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Process-level regressions (DT-01). Each test boots the real worker entry in a
// child process against a synthetic in-process API server. No database and no
// external services are touched; all HTTP stays on 127.0.0.1.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '../..')
const serviceToken = '0123456789012345678901234567890123'

interface ChildHandle {
  child: ChildProcess
  port: number
  logsText(): string
  healthy(): Promise<void>
  exit(): Promise<{ code: number | null; signal: string | null }>
}

const children: ChildHandle[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const handle of children.splice(0)) {
    handle.child.kill('SIGKILL')
  }
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
  )
})

describe('ai-worker process behaviour', () => {
  it('exits promptly and cleanly on SIGTERM while lanes are idle (T27)', { timeout: 40_000 }, async () => {
    const api = await startApiServer(async (_request, response) => {
      response.statusCode = 204
      response.end()
    })
    const worker = await startWorker(apiPort(api))

    await worker.healthy()

    worker.child.kill('SIGTERM')
    const exit = await worker.exit()
    expect(exit.code).toBe(0)
    expect(worker.logsText()).toContain('"worker_stopping"')
    expect(worker.logsText()).toContain('"worker_stopped"')
  })

  it('stays alive with working health when index failAll hits a 500 (T24)', { timeout: 40_000 }, async () => {
    let claimCalls = 0
    const api = await startApiServer(async (request, response) => {
      const url = request.url ?? ''
      if (url === '/internal/assistant/index/claim') {
        claimCalls += 1
        if (claimCalls === 1) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(indexBatch(`http://127.0.0.1:${apiPort(api)}/embed`)))
          return
        }
        response.statusCode = 204
        response.end()
        return
      }
      if (url === '/embed/embeddings') {
        response.statusCode = 500
        response.end('embedding upstream down')
        return
      }
      if (url === '/internal/assistant/index/fail') {
        response.statusCode = 500
        response.end('api transiently unavailable')
        return
      }
      response.statusCode = 204
      response.end()
    })
    const worker = await startWorker(apiPort(api))

    await worker.healthy()
    // Give the lane time to claim, fail both embedding attempts, hit the 500 on
    // /index/fail, and recover into the next claim cycle.
    await delay(4_000)

    expect(worker.logsText()).toContain('"assistant_run_report_failed"')
    expect(worker.logsText()).toContain('"lane":"index"')
    expect(worker.child.exitCode).toBeNull()
    expect(worker.child.signalCode).toBeNull()
    await worker.healthy()

    worker.child.kill('SIGTERM')
    const exit = await worker.exit()
    expect(exit.code).toBe(0)
  })

  it('exits non-zero when the task lane dies on a non-recoverable report defect (T25)', { timeout: 40_000 }, async () => {
    let claimCalls = 0
    const api = await startApiServer(async (request, response) => {
      const url = (request.url ?? '').split('?')[0] ?? ''
      if (url === '/internal/ai/tasks/claim') {
        claimCalls += 1
        if (claimCalls === 1) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(taskClaim(`http://127.0.0.1:${apiPort(api)}/provider`)))
          return
        }
        response.statusCode = 204
        response.end()
        return
      }
      if (/^\/internal\/ai\/tasks\/[^/]+\/heartbeat$/.test(url)) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ cancelRequested: false }))
        return
      }
      if (/^\/internal\/ai\/tasks\/[^/]+\/events$/.test(url)) {
        response.statusCode = 204
        response.end()
        return
      }
      if (/^\/internal\/ai\/tasks\/[^/]+\/fail$/.test(url)) {
        // Not a lease conflict (that requires status 409) and not a transient
        // network/server error: it must kill the lane and therefore the process
        // instead of leaving HTTP green with a dead worker loop.
        response.statusCode = 400
        response.end(JSON.stringify({ error: { code: 'AI_TASK_REPORT_INVALID', message: 'synthetic defect' } }))
        return
      }
      if (url.startsWith('/provider')) {
        response.statusCode = 500
        response.end('provider down')
        return
      }
      response.statusCode = 204
      response.end()
    })
    const worker = await startWorker(apiPort(api))
    await worker.healthy()

    const exit = await worker.exit()
    expect(exit.code).toBe(1)
    expect(worker.logsText()).toContain('"task_loop_failed"')
    expect(worker.logsText()).toContain('"worker_stopping"')
    expect(claimCalls).toBe(1)
  })
})

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function apiPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('unexpected server address')
  return address.port
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
}

function startApiServer(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<Server> {
  return new Promise((resolveStart) => {
    const server = createServer((request, response) => {
      void handler(request, response).catch(() => {
        if (!response.headersSent) {
          response.statusCode = 500
        }
        response.end()
      })
    })
    servers.push(server)
    void listen(server).then(() => resolveStart(server))
  })
}

async function startWorker(apiPort: number): Promise<ChildHandle> {
  const workerPort = await freePort()
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(here, 'index.ts')],
    {
      cwd: here,
      env: {
        ...process.env,
        WORKER_ADDRESS: `127.0.0.1:${workerPort}`,
        API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
        INTERNAL_SERVICE_TOKEN: serviceToken,
        ARTIFACT_SCHEMA_PATH: resolve(repositoryRoot, '../docs/contracts/ai-artifact.schema.json'),
        PROMPT_ROOT: resolve(repositoryRoot, 'ai-worker/prompts'),
        WORKER_ID: 'subprocess-regression-worker',
        ALLOW_INSECURE_PROVIDER_HTTP: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let logs = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    logs += chunk.toString()
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    logs += chunk.toString()
  })
  const handle: ChildHandle = {
    child,
    port: workerPort,
    logsText: () => logs,
    async healthy() {
      const deadline = Date.now() + 20_000
      for (;;) {
        try {
          const response = await fetch(`http://127.0.0.1:${workerPort}/health/live`)
          if (response.ok) return
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) {
          throw new Error(`worker did not become healthy; logs:\n${logs}`)
        }
        await delay(150)
      }
    },
    exit() {
      return new Promise((resolveExit) => {
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
      })
    },
  }
  children.push(handle)
  return handle
}

async function freePort(): Promise<number> {
  const server = createServer()
  await listen(server)
  const port = apiPort(server)
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return port
}

function indexBatch(embeddingsBaseUrl: string) {
  return {
    generation: 1,
    policy: 'allow',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    baseUrl: embeddingsBaseUrl,
    apiKey: 'synthetic-embedding-key',
    modelId: 'mock-embedding',
    dimensions: 4,
    fragments: [{
      fragmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sourceKind: 'raw_text',
      sensitivity: 'normal',
      content: '子进程索引回归片段',
      attempt: 1,
      sourceCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    }],
  }
}

function taskClaim(providerBaseUrl: string) {
  return {
    task: {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      type: 'organize_record',
      leaseVersion: 1,
      promptVersion: 'organize-v1',
      schemaVersion: '1',
      limits: {
        maxTurns: 2,
        maxToolCalls: 2,
        deadlineAt: new Date(Date.now() + 4 * 60_000).toISOString(),
      },
    },
    input: {
      itemId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      sensitivity: 'normal',
      sensitivePolicy: 'allow',
      rawRecords: [],
      fragments: [],
      attachments: [],
      relatedRecords: [],
    },
    provider: {
      protocol: 'openai-completions',
      baseUrl: providerBaseUrl,
      apiKey: 'synthetic-provider-key',
      modelId: 'mock-model',
      modelName: 'mock-model',
      contextWindow: 8192,
      maxOutputTokens: 512,
      supportsTools: true,
      supportsVision: false,
    },
  }
}

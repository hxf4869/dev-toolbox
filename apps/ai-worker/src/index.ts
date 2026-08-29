import { createServer } from 'node:http'

import { loadArtifactValidator } from './artifact-schema.js'
import { loadConfig } from './config.js'
import { log } from './logger.js'

const config = loadConfig()
await loadArtifactValidator(config.artifactSchemaPath)

const [host, rawPort] = config.address.split(':')
const port = Number(rawPort)

if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('WORKER_ADDRESS 必须是 host:port')
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health/live') {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify({ status: 'live', service: 'ai-worker' }))
    return
  }

  response.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(
    JSON.stringify({
      error: {
        code: 'NOT_FOUND',
        message: '资源不存在',
      },
    }),
  )
})

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

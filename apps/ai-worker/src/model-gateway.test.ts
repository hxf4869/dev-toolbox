import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ProviderGatewayError,
  testProviderConnection,
  type ProviderProtocol,
} from './model-gateway.js'

const servers: Array<ReturnType<typeof createServer>> = []
const protocols = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
})

describe('ModelGateway provider connection test', () => {
  for (const protocol of protocols) {
    it(`normalizes a prefixed base URL and parses ${protocol}`, async () => {
      let requests = 0
      let seenUrl = ''
      let authenticated = false
      const baseUrl = await startMock((request, response) => {
        requests += 1
        seenUrl = request.url ?? ''
        authenticated = Boolean(request.headers.authorization ?? request.headers['x-api-key'])
        respondSuccess(response, protocol)
      })
      const result = await testProviderConnection(
        { protocol, baseUrl: `${baseUrl}/gateway/v1/`, apiKey: 'local-test-key', modelId: 'mock-model' },
        new Date(Date.now() + 60_000),
        true,
      )

      expect(result.status).toBe('ok')
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
      expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1 })
      expect(requests).toBe(1)
      expect(seenUrl).toBe(`/gateway/v1/${endpointFor(protocol)}`)
      expect(authenticated).toBe(true)
    })

    it.each([401, 403])(`${protocol} maps HTTP %s to credentials_invalid without retry`, async (status) => {
      let requests = 0
      const baseUrl = await startMock((_request, response) => {
        requests += 1
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'secret upstream diagnostic' } }))
      })
      await expect(
        testProviderConnection(snapshot(baseUrl, protocol), new Date(Date.now() + 5_000), true),
      ).rejects.toMatchObject({ category: 'credentials_invalid' })
      expect(requests).toBe(1)
    })

    it.each([408, 429, 500, 502, 503, 504])(`${protocol} maps HTTP %s to unavailable without retry`, async (status) => {
      let requests = 0
      const baseUrl = await startMock((_request, response) => {
        requests += 1
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'do not expose this' } }))
      })
      await expect(
        testProviderConnection(snapshot(baseUrl, protocol), new Date(Date.now() + 5_000), true),
      ).rejects.toMatchObject({ category: 'unavailable' })
      expect(requests).toBe(1)
    })

    it.each([400, 404, 501])(`${protocol} rejects non-retriable HTTP %s without retry`, async (status) => {
      let requests = 0
      const baseUrl = await startMock((_request, response) => {
        requests += 1
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'synthetic rejected response' } }))
      })
      await expect(
        testProviderConnection(snapshot(baseUrl, protocol), new Date(Date.now() + 5_000), true),
      ).rejects.toMatchObject({ category: 'unavailable' })
      expect(requests).toBe(1)
    })

    it(`rejects redirects, malformed responses, and timeouts for ${protocol}`, async () => {
      for (const mode of ['redirect', 'malformed', 'timeout'] as const) {
        let requests = 0
        const baseUrl = await startMock((_request, response) => {
          requests += 1
          if (mode === 'redirect') {
            response.writeHead(302, { location: 'http://example.invalid/stolen' })
            response.end()
          } else if (mode === 'malformed') {
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.end('data: not-json\n\n')
          } else {
            setTimeout(() => response.end(), 200)
          }
        })
        await expect(
          testProviderConnection(
            snapshot(baseUrl, protocol),
            new Date(Date.now() + (mode === 'timeout' ? 50 : 5_000)),
            true,
          ),
        ).rejects.toBeInstanceOf(ProviderGatewayError)
        expect(requests).toBe(1)
      }
    })

    it(`rejects oversized responses before parsing for ${protocol}`, async () => {
      let requests = 0
      const baseUrl = await startMock((_request, response) => {
        requests += 1
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-length': String(4 * 1024 * 1024 + 1),
        })
        response.end()
      })
      await expect(
        testProviderConnection(snapshot(baseUrl, protocol), new Date(Date.now() + 5_000), true),
      ).rejects.toMatchObject({ category: 'unavailable' })
      expect(requests).toBe(1)
    })
  }

  it('rejects an oversized chunked stream without buffering the whole response', async () => {
    const baseUrl = await startMock((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const padding = `: ${'x'.repeat(256 * 1024)}\n\n`
      for (let index = 0; index < 17; index++) response.write(padding)
      response.end()
    })
    await expect(
      testProviderConnection(snapshot(baseUrl), new Date(Date.now() + 5_000), true),
    ).rejects.toBeInstanceOf(ProviderGatewayError)
  })

  it.each([
    'https://user:password@example.com/v1',
    'https://example.com/v1?token=secret',
    'https://example.com/v1#fragment',
    'http://example.com/v1',
  ])('rejects an unsafe base URL: %s', async (baseUrl) => {
    await expect(
      testProviderConnection(snapshot(baseUrl), new Date(Date.now() + 5_000), false),
    ).rejects.toMatchObject({ category: 'unavailable' })
  })

  it('rejects a provider test deadline beyond the supported window', async () => {
    await expect(
      testProviderConnection(snapshot('https://example.com/v1'), new Date(Date.now() + 66_000), false),
    ).rejects.toMatchObject({ category: 'unavailable' })
  })
})

function snapshot(baseUrl: string, protocol: ProviderProtocol = 'openai-completions') {
  return {
    protocol,
    baseUrl,
    apiKey: 'local-test-key',
    modelId: 'mock-model',
  }
}

async function startMock(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server failed to bind')
  return `http://127.0.0.1:${address.port}`
}

function endpointFor(protocol: ProviderProtocol): string {
  if (protocol === 'openai-completions') return 'chat/completions'
  if (protocol === 'openai-responses') return 'responses'
  return 'messages'
}

function respondSuccess(response: ServerResponse, protocol: ProviderProtocol): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (protocol === 'openai-completions') {
    sendData(response, {
      id: 'chatcmpl_mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }],
    })
    sendData(response, {
      id: 'chatcmpl_mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    response.end('data: [DONE]\n\n')
    return
  }
  if (protocol === 'openai-responses') {
    const item = {
      id: 'msg_mock', type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: 'OK', annotations: [] }],
    }
    sendData(response, { type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    sendData(response, { type: 'response.output_text.delta', sequence_number: 1, output_index: 0, content_index: 0, delta: 'OK' })
    sendData(response, { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item })
    sendData(response, {
      type: 'response.completed', sequence_number: 3,
      response: {
        id: 'resp_mock', object: 'response', created_at: 1, status: 'completed', model: 'mock-model',
        output: [item], error: null, incomplete_details: null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      },
    })
    response.end()
    return
  }
  sendEvent(response, 'message_start', {
    type: 'message_start',
    message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
  })
  sendEvent(response, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  sendEvent(response, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } })
  sendEvent(response, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sendEvent(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  sendEvent(response, 'message_stop', { type: 'message_stop' })
  response.end()
}

function sendData(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function sendEvent(response: ServerResponse, event: string, value: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
}

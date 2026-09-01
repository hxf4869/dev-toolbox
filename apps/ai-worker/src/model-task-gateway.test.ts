import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import type { Context, Tool } from '@earendil-works/pi-ai'

import {
  ProviderGatewayError,
  runProviderTurn,
  runProviderTurnOnce,
  type ProviderProtocol,
  type ProviderTurnRequest,
} from './model-gateway.js'

const protocols = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const
const retryableStatuses = [408, 429, 500, 502, 503, 504] as const
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
})

describe('ModelGateway task turns', () => {
  it('makes exactly one attempt for the narrow synchronous path', async () => {
    let requests = 0
    const baseUrl = await startMock((_request, response) => {
      requests += 1
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'synthetic temporary failure' } }))
    })

    await expect(runProviderTurnOnce(taskRequest(baseUrl, 'openai-completions'))).rejects.toMatchObject({
      category: 'unavailable',
    })
    expect(requests).toBe(1)
  })

  for (const protocol of protocols) {
    it(`accepts only a declared tool call from ${protocol}`, async () => {
      let requests = 0
      const baseUrl = await startMock((_request, response) => {
        requests += 1
        respondToolCall(response, protocol, 'submit_artifact')
      })
      const result = await runProviderTurn(taskRequest(baseUrl, protocol))

      expect(result.attempts).toBe(1)
      expect(requests).toBe(1)
      expect(result.message.stopReason).toBe('toolUse')
      expect(result.message.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'toolCall', name: 'submit_artifact' }),
        ]),
      )
    })

    it(`rejects an undeclared tool from ${protocol} without retry`, async () => {
      let requests = 0
      const baseUrl = await startMock((_request, response) => {
        requests += 1
        respondToolCall(response, protocol, 'run_shell')
      })
      await expect(runProviderTurn(taskRequest(baseUrl, protocol))).rejects.toMatchObject({
        category: 'protocol_error',
      })
      expect(requests).toBe(1)
    })

    it.each(retryableStatuses)(`${protocol} retries HTTP %s at most twice`, async (status) => {
      let requests = 0
      const baseUrl = await startMock((_request, response) => {
        requests += 1
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'synthetic temporary failure' } }))
      })
      await expect(runProviderTurn(taskRequest(baseUrl, protocol))).rejects.toMatchObject({
        category: 'unavailable',
      })
      expect(requests).toBe(3)
    })

    it.each([400, 401, 403, 404, 501, 505])(
      `${protocol} does not retry HTTP %s`,
      async (status) => {
        let requests = 0
        const baseUrl = await startMock((_request, response) => {
          requests += 1
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'synthetic permanent failure' } }))
        })
        const category = status === 401 || status === 403 ? 'credentials_invalid' : 'protocol_error'
        await expect(runProviderTurn(taskRequest(baseUrl, protocol))).rejects.toMatchObject({
          category,
        })
        expect(requests).toBe(1)
      },
    )

    it(`does not retry a malformed successful response from ${protocol}`, async () => {
      let requests = 0
      const baseUrl = await startMock((_request, response) => {
        requests += 1
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: not-json\n\n')
      })
      await expect(runProviderTurn(taskRequest(baseUrl, protocol))).rejects.toMatchObject({
        category: 'protocol_error',
      })
      expect(requests).toBe(1)
    })
  }

  it('rejects image input before the network when the model lacks vision capability', async () => {
    let requests = 0
    const baseUrl = await startMock((_request, response) => {
      requests += 1
      respondToolCall(response, 'openai-completions', 'submit_artifact')
    })
    const request = taskRequest(baseUrl, 'openai-completions')
    request.context.messages = [{
      role: 'user',
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      timestamp: Date.now(),
    }]
    request.provider.supportsVision = false

    await expect(runProviderTurn(request)).rejects.toMatchObject({
      category: 'capability_mismatch',
    })
    expect(requests).toBe(0)
  })

  it('retries a network interruption within the same turn', async () => {
    let requests = 0
    const baseUrl = await startMock((request, response) => {
      requests += 1
      if (requests < 3) {
        request.socket.destroy()
        return
      }
      respondToolCall(response, 'openai-completions', 'submit_artifact')
    })
    const result = await runProviderTurn(taskRequest(baseUrl, 'openai-completions'))
    expect(result.attempts).toBe(3)
    expect(requests).toBe(3)
  })
})

function taskRequest(baseUrl: string, protocol: ProviderProtocol): ProviderTurnRequest & {
  context: Context
  provider: ProviderTurnRequest['provider'] & { supportsVision: boolean }
} {
  const tool = {
    name: 'submit_artifact',
    description: 'Submit one candidate artifact.',
    parameters: {
      type: 'object',
      properties: { artifact: { type: 'object' } },
      required: ['artifact'],
      additionalProperties: false,
    },
  } as unknown as Tool
  return {
    provider: {
      protocol,
      baseUrl: `${baseUrl}/gateway/v1/`,
      apiKey: 'synthetic-task-key',
      modelId: 'mock-task-model',
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsTools: true,
      supportsVision: true,
    },
    context: {
      systemPrompt: 'Use only the declared tool.',
      messages: [{ role: 'user', content: 'Create the artifact.', timestamp: Date.now() }],
      tools: [tool],
    },
    deadlineAt: new Date(Date.now() + 10_000),
    maxOutputTokens: 512,
    allowInsecureHttp: true,
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

function respondToolCall(
  response: ServerResponse,
  protocol: ProviderProtocol,
  toolName: string,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const argumentsJson = JSON.stringify({ artifact: { schemaVersion: '1.0' } })
  if (protocol === 'openai-completions') {
    sendData(response, {
      id: 'chatcmpl_tool', object: 'chat.completion.chunk', created: 1, model: 'mock-task-model',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: toolName, arguments: argumentsJson } }],
        },
        finish_reason: null,
      }],
    })
    sendData(response, {
      id: 'chatcmpl_tool', object: 'chat.completion.chunk', created: 1, model: 'mock-task-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    })
    response.end('data: [DONE]\n\n')
    return
  }
  if (protocol === 'openai-responses') {
    const item = {
      id: 'fc_fixture', type: 'function_call', status: 'completed',
      call_id: 'call_fixture', name: toolName, arguments: argumentsJson,
    }
    sendData(response, {
      type: 'response.output_item.added', sequence_number: 0, output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    })
    sendData(response, {
      type: 'response.function_call_arguments.delta', sequence_number: 1,
      output_index: 0, item_id: item.id, delta: argumentsJson,
    })
    sendData(response, {
      type: 'response.function_call_arguments.done', sequence_number: 2,
      output_index: 0, item_id: item.id, arguments: argumentsJson,
    })
    sendData(response, {
      type: 'response.output_item.done', sequence_number: 3, output_index: 0, item,
    })
    sendData(response, {
      type: 'response.completed', sequence_number: 4,
      response: {
        id: 'resp_tool', object: 'response', created_at: 1, status: 'completed',
        model: 'mock-task-model', output: [item], error: null, incomplete_details: null,
        usage: {
          input_tokens: 2, output_tokens: 2, total_tokens: 4,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })
    response.end()
    return
  }
  sendEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_tool', type: 'message', role: 'assistant', model: 'mock-task-model', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 },
    },
  })
  sendEvent(response, 'content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'call_fixture', name: toolName, input: {} },
  })
  sendEvent(response, 'content_block_delta', {
    type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: argumentsJson },
  })
  sendEvent(response, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sendEvent(response, 'message_delta', {
    type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 2 },
  })
  sendEvent(response, 'message_stop', { type: 'message_stop' })
  response.end()
}

function sendData(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function sendEvent(response: ServerResponse, event: string, value: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
}

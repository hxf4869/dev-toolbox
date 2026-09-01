import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAssistantApi } from './assistantApi'
import { folderFixture, MOCK_IDS, temporaryFixture } from './assistantMocks'

describe('assistant API client', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps query and mutation bodies aligned with the frozen public contract', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.includes('/conversations?')) return jsonResponse({ items: [], nextCursor: null })
      if (path.includes('/folders/')) return new Response(null, { status: 204 })
      if (path.endsWith('/stop')) return jsonResponse({ status: 'stopped' })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const api = createAssistantApi(() => 'csrf-value')

    await api.getConversations({ view: 'archived', folderId: 'unfiled', cursor: 'next item', limit: 30 })
    await api.deleteFolder(folderFixture.id, 'delete')
    await api.stopRun(MOCK_IDS.run)

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/v1/assistant/conversations?view=archived&folderId=unfiled&cursor=next+item&limit=30',
    )
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      conversationAction: 'delete',
    })
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'X-CSRF-Token': 'csrf-value' },
    })
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBeUndefined()
  })

  it('uses fetch streaming with same-origin credentials, SSE Accept and CSRF for temporary runs', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: run.status\ndata: {"sequence":1,"status":"running","phase":"answer"}\n\n'))
          controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const api = createAssistantApi(() => 'csrf-value')

    const events = []
    for await (const event of api.streamTemporaryRun(temporaryFixture.request, new AbortController().signal)) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'run.status', data: { sequence: 1, status: 'running', phase: 'answer' } },
    ])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/assistant/temporary/stream')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-value',
      },
    })
  })
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LoadedImage } from './imageInput'
import { useCloudOcrRun } from './useCloudOcrRun'

const image: LoadedImage = {
  fileName: 'synthetic.png', typeLabel: 'PNG', blob: new Blob(['synthetic image'], { type: 'image/png' }),
  sizeBytes: 15, originalSizeBytes: 15, width: 100, height: 100,
  originalWidth: 100, originalHeight: 100, adjusted: false,
}

afterEach(() => vi.unstubAllGlobals())

async function pendingStartWindow() {
  let queueCreates = 0
  let uploads = 0
  let releaseDelete!: () => void
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input)
    if (path.endsWith('/queue-tickets') && init?.method === 'POST') {
      return Response.json({ ticketId: `ticket-${++queueCreates}`, operation: 'ocr', status: 'ready' }, { status: 201 })
    }
    if (path.endsWith('/claim')) return Response.json({ permitToken: 'synthetic-permit', status: 'active' })
    if (path.endsWith('/ocr')) {
      if (++uploads === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      }
      return Response.json({ text: '新识别结果', quota: { remaining: 10 } })
    }
    if (init?.method === 'DELETE') {
      if (path.endsWith('/ticket-1')) {
        return new Promise((resolve) => { releaseDelete = () => resolve(new Response(null, { status: 204 })) })
      }
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected synthetic request: ${path}`)
  }))
  const run = useCloudOcrRun()
  const first = run.start(image, () => 'synthetic-csrf')
  await vi.waitFor(() => expect(run.phase.value).toBe('running'))
  const cancelling = run.cancel()
  await vi.waitFor(() => expect(run.phase.value).toBe('cancelled'))
  const pending = run.start(image, () => 'synthetic-csrf')
  await Promise.resolve()
  expect(queueCreates).toBe(1)
  return {
    run,
    counts: () => ({ queueCreates, uploads }),
    settle: async () => {
      releaseDelete()
      await Promise.all([first, cancelling, pending])
    },
  }
}

describe('云 OCR 等待旧 ticket 清理时的取消边界', () => {
  it.each(['dispose', 'reset'] as const)('%s 作废等待中的启动，不再申请许可或上传图片', async (operation) => {
    const pending = await pendingStartWindow()
    pending.run[operation]()
    await pending.settle()
    expect(pending.counts()).toEqual({ queueCreates: 1, uploads: 1 })
  })

  it('清理后仍允许未被作废的显式重试', async () => {
    const pending = await pendingStartWindow()
    await pending.settle()
    expect(pending.counts()).toEqual({ queueCreates: 2, uploads: 2 })
    expect(pending.run.phase.value).toBe('finished')
  })

  it('离页后晚到的启动不会发出请求', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const run = useCloudOcrRun()
    run.dispose()
    await run.start(image, () => 'synthetic-csrf')
    expect(fetch).not.toHaveBeenCalled()
  })
})

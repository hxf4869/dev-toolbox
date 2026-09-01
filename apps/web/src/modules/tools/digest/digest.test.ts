import { describe, expect, it, vi } from 'vitest'

import { DIGEST_CHUNK_SIZE, type DigestWorkerRequest, type DigestWorkerResponse } from './contracts'
import { compareDigest, DigestRunner } from './digestRunner'
import { hashBlob, hashBytes } from './hashCore'

describe('digest algorithms and chunking', () => {
  it.each([
    ['md5', '900150983cd24fb0d6963f7d28e17f72'],
    ['sha1', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    ['sha256', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['sha384', 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7'],
    ['sha512', 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'],
  ] as const)('computes trusted %s fixture', async (algorithm, expected) => {
    await expect(hashBytes(new TextEncoder().encode('abc'), algorithm)).resolves.toBe(expected)
  })

  it('reads a file-like source only through fixed-size slices', async () => {
    const bytes = new Uint8Array(DIGEST_CHUNK_SIZE + 17).fill(97)
    const slices: Array<[number, number]> = []
    const source = {
      size: bytes.byteLength,
      slice(start: number, end: number) {
        slices.push([start, end])
        return new Blob([bytes.subarray(start, end)])
      },
    }
    await hashBlob(source, 'sha256')
    expect(slices).toEqual([[0, DIGEST_CHUNK_SIZE], [DIGEST_CHUNK_SIZE, DIGEST_CHUNK_SIZE + 17]])
    expect(slices.every(([start, end]) => end - start <= DIGEST_CHUNK_SIZE)).toBe(true)
  })

  it('normalizes only the documented expected checksum differences', () => {
    const actual = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(compareDigest(actual, `0x BA78 16BF\n${actual.slice(8)}`, 'sha256').status).toBe('match')
    expect(compareDigest(actual, actual.replace(/.$/, '0'), 'sha256').status).toBe('mismatch')
    expect(compareDigest(actual, 'not-hex', 'sha256').status).toBe('invalid')
  })
})

class FakeWorker {
  onmessage: ((event: MessageEvent<DigestWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request?: DigestWorkerRequest
  terminated = false
  postMessage(message: DigestWorkerRequest) { this.request = message }
  terminate() { this.terminated = true }
  emit(message: DigestWorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<DigestWorkerResponse>) }
}

describe('DigestRunner lifecycle', () => {
  it('terminates on cancel and ignores a late obsolete result', async () => {
    const workers: FakeWorker[] = []
    const runner = new DigestRunner(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })
    const obsolete = runner.run({ kind: 'text', text: 'old', algorithm: 'sha256' })
    const obsoleteAssertion = expect(obsolete).rejects.toMatchObject({ name: 'AbortError' })
    const latest = runner.run({ kind: 'text', text: 'new', algorithm: 'sha256' })
    expect(workers[0]?.terminated).toBe(true)
    workers[0]?.emit({ id: workers[0].request!.id, type: 'result', digest: 'old', totalBytes: 3 })
    workers[1]?.emit({ id: workers[1].request!.id, type: 'result', digest: 'new', totalBytes: 3 })
    await obsoleteAssertion
    await expect(latest).resolves.toEqual({ digest: 'new', totalBytes: 3 })
  })
})

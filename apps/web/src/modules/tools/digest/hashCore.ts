import {
  createMD5,
  createSHA1,
  createSHA256,
  createSHA384,
  createSHA512,
  type IHasher,
} from 'hash-wasm'

import { DIGEST_CHUNK_SIZE, type DigestAlgorithm, type DigestProgress } from './contracts'

type BlobSource = Pick<Blob, 'size' | 'slice'>

async function createHasher(algorithm: DigestAlgorithm): Promise<IHasher> {
  const factories: Record<DigestAlgorithm, () => Promise<IHasher>> = {
    md5: createMD5,
    sha1: createSHA1,
    sha256: createSHA256,
    sha384: createSHA384,
    sha512: createSHA512,
  }
  return factories[algorithm]().then((hasher) => hasher.init())
}

export async function hashBytes(
  bytes: Uint8Array,
  algorithm: DigestAlgorithm,
  onProgress?: (progress: DigestProgress) => void,
): Promise<string> {
  const hasher = await createHasher(algorithm)
  const startedAt = performance.now()
  for (let offset = 0; offset < bytes.byteLength; offset += DIGEST_CHUNK_SIZE) {
    hasher.update(bytes.subarray(offset, Math.min(offset + DIGEST_CHUNK_SIZE, bytes.byteLength)))
    const processedBytes = Math.min(offset + DIGEST_CHUNK_SIZE, bytes.byteLength)
    const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001)
    onProgress?.({ processedBytes, totalBytes: bytes.byteLength, rateBytesPerSecond: processedBytes / elapsedSeconds })
  }
  if (bytes.byteLength === 0) onProgress?.({ processedBytes: 0, totalBytes: 0, rateBytesPerSecond: 0 })
  return hasher.digest('hex')
}

export async function hashBlob(
  source: BlobSource,
  algorithm: DigestAlgorithm,
  onProgress?: (progress: DigestProgress) => void,
): Promise<string> {
  const hasher = await createHasher(algorithm)
  const startedAt = performance.now()
  let processedBytes = 0
  while (processedBytes < source.size) {
    const end = Math.min(processedBytes + DIGEST_CHUNK_SIZE, source.size)
    const chunk = source.slice(processedBytes, end)
    const bytes = new Uint8Array(await chunk.arrayBuffer())
    hasher.update(bytes)
    processedBytes = end
    const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001)
    onProgress?.({ processedBytes, totalBytes: source.size, rateBytesPerSecond: processedBytes / elapsedSeconds })
  }
  if (source.size === 0) onProgress?.({ processedBytes: 0, totalBytes: 0, rateBytesPerSecond: 0 })
  return hasher.digest('hex')
}

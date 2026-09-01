export const DIGEST_CHUNK_SIZE = 4 * 1024 * 1024

export type DigestAlgorithm = 'sha256' | 'sha384' | 'sha512' | 'md5' | 'sha1'

export interface DigestProgress {
  processedBytes: number
  totalBytes: number
  rateBytesPerSecond: number
}

export type DigestWorkerRequest = {
  id: number
  algorithm: DigestAlgorithm
} & (
  | { kind: 'text'; text: string }
  | { kind: 'file'; file: File }
)

export type DigestWorkerResponse =
  | ({ id: number; type: 'progress' } & DigestProgress)
  | { id: number; type: 'result'; digest: string; totalBytes: number }
  | { id: number; type: 'error'; message: string }

export const digestLengths: Record<DigestAlgorithm, number> = {
  md5: 32,
  sha1: 40,
  sha256: 64,
  sha384: 96,
  sha512: 128,
}

export const digestLabels: Record<DigestAlgorithm, string> = {
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
}

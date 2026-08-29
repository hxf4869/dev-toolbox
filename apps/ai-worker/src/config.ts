import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'

export interface WorkerConfig {
  readonly address: string
  readonly artifactSchemaPath: string
  readonly promptRoot: string
  readonly apiInternalUrl: string
  readonly workerId: string
  readonly serviceToken: string
  readonly allowInsecureProviderHttp: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const serviceToken = loadServiceToken(env)
  const apiInternalUrl = normalizeInternalUrl(env.API_INTERNAL_URL ?? 'http://127.0.0.1:8080')
  const workerId = env.WORKER_ID?.trim() || defaultWorkerId()
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(workerId)) {
    throw new Error('WORKER_ID 只允许 1–120 个字母、数字、点、下划线或连字符')
  }
  return {
    address: env.WORKER_ADDRESS ?? '0.0.0.0:3001',
    artifactSchemaPath:
      env.ARTIFACT_SCHEMA_PATH ?? resolve(process.cwd(), '../../docs/contracts/ai-artifact.schema.json'),
    promptRoot: env.PROMPT_ROOT ?? resolve(process.cwd(), 'prompts'),
    apiInternalUrl,
    workerId,
    serviceToken,
    allowInsecureProviderHttp: env.ALLOW_INSECURE_PROVIDER_HTTP?.toLowerCase() === 'true',
  }
}

function normalizeInternalUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('API_INTERNAL_URL 必须是绝对 HTTP(S) URL')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.host || parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('API_INTERNAL_URL 必须是无凭据、查询和路径的 HTTP(S) origin')
  }
  return parsed.origin
}

function defaultWorkerId(): string {
  const safeHost = hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'host'
  return `worker-${safeHost}-${process.pid}`
}

function loadServiceToken(env: NodeJS.ProcessEnv): string {
  let value = env.INTERNAL_SERVICE_TOKEN?.trim()
  if (!value && env.INTERNAL_SERVICE_TOKEN_FILE) {
    value = readFileSync(env.INTERNAL_SERVICE_TOKEN_FILE, 'utf8').trim()
  }
  if (!value || value.length < 32 || value.length > 512) {
    throw new Error('INTERNAL_SERVICE_TOKEN 或 INTERNAL_SERVICE_TOKEN_FILE 必须提供 32–512 字符凭据')
  }
  return value
}

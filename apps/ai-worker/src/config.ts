import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface WorkerConfig {
  readonly address: string
  readonly artifactSchemaPath: string
  readonly serviceToken: string
  readonly allowInsecureProviderHttp: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const serviceToken = loadServiceToken(env)
  return {
    address: env.WORKER_ADDRESS ?? '0.0.0.0:3001',
    artifactSchemaPath:
      env.ARTIFACT_SCHEMA_PATH ?? resolve(process.cwd(), '../../docs/contracts/ai-artifact.schema.json'),
    serviceToken,
    allowInsecureProviderHttp: env.ALLOW_INSECURE_PROVIDER_HTTP?.toLowerCase() === 'true',
  }
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

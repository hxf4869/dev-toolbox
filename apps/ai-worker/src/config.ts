import { resolve } from 'node:path'

export interface WorkerConfig {
  readonly address: string
  readonly artifactSchemaPath: string
  readonly serviceToken: string | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    address: env.WORKER_ADDRESS ?? '0.0.0.0:3001',
    artifactSchemaPath:
      env.ARTIFACT_SCHEMA_PATH ?? resolve(process.cwd(), '../../docs/contracts/ai-artifact.schema.json'),
    serviceToken: env.INTERNAL_SERVICE_TOKEN,
  }
}

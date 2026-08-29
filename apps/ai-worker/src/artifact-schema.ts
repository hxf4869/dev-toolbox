import { readFile } from 'node:fs/promises'

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ArtifactValidator = ValidateFunction<Record<string, unknown>>

export interface ArtifactContract {
  readonly schema: Record<string, unknown>
  readonly validate: ArtifactValidator
}

export async function loadArtifactContract(schemaPath: string): Promise<ArtifactContract> {
  const rawSchema = await readFile(schemaPath, 'utf8')
  const schema = JSON.parse(rawSchema) as Record<string, unknown>
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  ajv.addFormat('uuid', {
    type: 'string',
    validate: (value: string) => uuidPattern.test(value),
  })

  return { schema, validate: ajv.compile<Record<string, unknown>>(schema) }
}

export async function loadArtifactValidator(schemaPath: string): Promise<ArtifactValidator> {
  return (await loadArtifactContract(schemaPath)).validate
}

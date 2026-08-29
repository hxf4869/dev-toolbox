import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadArtifactValidator } from './artifact-schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '../../..')
const schemaPath = resolve(repositoryRoot, 'docs/contracts/ai-artifact.schema.json')
const fixtureRoot = resolve(repositoryRoot, 'tests/fixtures/ai-artifact')

async function loadFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(fixtureRoot, name), 'utf8')) as Record<string, unknown>
}

describe('AI Artifact v1 contract', () => {
  it('accepts the shared valid fixture', async () => {
    const validate = await loadArtifactValidator(schemaPath)

    expect(validate(await loadFixture('valid-organized.json'))).toBe(true)
  })

  it.each(['invalid-unknown-block.json', 'invalid-uuid.json'])(
    'rejects shared invalid fixture %s',
    async (name) => {
      const validate = await loadArtifactValidator(schemaPath)

      expect(validate(await loadFixture(name))).toBe(false)
    },
  )
})

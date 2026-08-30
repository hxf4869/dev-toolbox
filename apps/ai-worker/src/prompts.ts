import { readFile } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'

const allowedPromptVersions = new Set([
  'organize-v1', 'review-v1', 'image-v1',
  'organize-v2', 'review-v2', 'image-v2',
])

export class PromptStore {
  readonly #cache = new Map<string, string>()

  constructor(readonly root: string) {}

  async load(version: string): Promise<string> {
    if (!allowedPromptVersions.has(version) || basename(version) !== version) {
      throw new Error('unsupported prompt version')
    }
    const cached = this.#cache.get(version)
    if (cached !== undefined) return cached
    const path = resolve(this.root, `${version}.md`)
    const rootPrefix = resolve(this.root) + sep
    if (!path.startsWith(rootPrefix)) throw new Error('invalid prompt path')
    const prompt = (await readFile(path, 'utf8')).trim()
    if (!prompt || prompt.length > 32 * 1024) throw new Error('invalid prompt file')
    this.#cache.set(version, prompt)
    return prompt
  }
}

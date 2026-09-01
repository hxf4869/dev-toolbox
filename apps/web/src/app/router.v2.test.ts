import { createMemoryHistory } from 'vue-router'

import { createAppRouter, LEGACY_KNOWLEDGE_QUERY_KEYS } from './router'

describe('V2 route migration', () => {
  it.each(LEGACY_KNOWLEDGE_QUERY_KEYS)('moves legacy %s query links to the knowledge workspace', async (key) => {
    const history = createMemoryHistory()
    const replace = vi.spyOn(history, 'replace')
    const router = createAppRouter(history)

    await router.push({ path: '/', query: { [key]: 'legacy-value', untouched: 'yes' } })
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('workspace')
    expect(router.currentRoute.value.path).toBe('/knowledge')
    expect(router.currentRoute.value.query).toEqual({ [key]: 'legacy-value', untouched: 'yes' })
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('/knowledge?'), expect.anything())
  })

  it('keeps a root q query on the neutral home', async () => {
    const router = createAppRouter(createMemoryHistory())

    await router.push({ path: '/', query: { q: 'not-a-legacy-contract' } })
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('home')
    expect(router.currentRoute.value.query).toEqual({ q: 'not-a-legacy-contract' })
  })

  it('preserves item deep links and their query', async () => {
    const router = createAppRouter(createMemoryHistory())

    await router.push('/items/item-42?view=timeline&from=2025-01-01')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('item-detail')
    expect(router.currentRoute.value.params.itemId).toBe('item-42')
    expect(router.currentRoute.value.query).toEqual({ view: 'timeline', from: '2025-01-01' })
  })

  it('uses lazy components for root module routes and returns a normal not-found route', async () => {
    const router = createAppRouter(createMemoryHistory())
    const names = [
      'home', 'workspace', 'tools', 'tool-base64', 'tool-url', 'tool-jwt', 'tool-json',
      'tool-yaml', 'tool-time', 'tool-digest', 'tool-regex',
    ]

    for (const name of names) {
      const record = router.getRoutes().find((route) => route.name === name)
      expect(typeof record?.components?.default).toBe('function')
    }

    await router.push('/tools/not-released')
    await router.isReady()
    expect(router.currentRoute.value.name).toBe('not-found')
  })
})

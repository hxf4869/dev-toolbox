import { createPinia, setActivePinia } from 'pinia'
import { vi } from 'vitest'

import { useThemeStore } from './theme'

function stubMatchMedia(initialLight: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const query = {
    matches: initialLight,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener)
    },
  }
  vi.stubGlobal('matchMedia', vi.fn(() => query))
  return {
    set(matches: boolean) {
      query.matches = matches
      for (const listener of [...listeners]) listener({ matches })
    },
    listenerCount: () => listeners.size,
  }
}

describe('theme store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the confirmed dark theme by default', () => {
    stubMatchMedia(false)
    const theme = useThemeStore()
    theme.apply()

    expect(theme.preference).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('persists only the appearance preference', () => {
    stubMatchMedia(false)
    const theme = useThemeStore()
    theme.setPreference('light')

    expect(window.localStorage.getItem('dev-toolbox.theme')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('applies a saved system preference against the current scheme', () => {
    window.localStorage.setItem('dev-toolbox.theme', 'system')
    const media = stubMatchMedia(true)
    const theme = useThemeStore()
    theme.apply()

    expect(theme.resolved).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    media.set(false)
    expect(theme.resolved).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('system preference follows OS color scheme changes', () => {
    const media = stubMatchMedia(false)
    const theme = useThemeStore()
    theme.setPreference('system')

    expect(theme.resolved).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')

    media.set(true)
    expect(theme.resolved).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    media.set(false)
    expect(theme.resolved).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('keeps an explicit light choice when the system scheme changes', () => {
    const media = stubMatchMedia(false)
    const theme = useThemeStore()
    theme.setPreference('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    media.set(true)
    expect(theme.resolved).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('removes the media listener when the store scope is disposed', () => {
    const media = stubMatchMedia(false)
    const pinia = createPinia()
    setActivePinia(pinia)
    const theme = useThemeStore()
    expect(media.listenerCount()).toBe(1)

    theme.$dispose()
    expect(media.listenerCount()).toBe(0)
  })
})

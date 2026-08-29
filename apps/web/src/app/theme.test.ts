import { createPinia, setActivePinia } from 'pinia'

import { useThemeStore } from './theme'

describe('theme store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('uses the confirmed dark theme by default', () => {
    const theme = useThemeStore()
    theme.apply()

    expect(theme.preference).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('persists only the appearance preference', () => {
    const theme = useThemeStore()
    theme.setPreference('light')

    expect(window.localStorage.getItem('dev-toolbox.theme')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

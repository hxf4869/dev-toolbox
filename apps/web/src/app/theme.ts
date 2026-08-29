import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type ThemePreference = 'dark' | 'light' | 'system'

const storageKey = 'dev-toolbox.theme'

export const useThemeStore = defineStore('theme', () => {
  const preference = ref<ThemePreference>('dark')

  const resolved = computed<'dark' | 'light'>(() => {
    if (preference.value !== 'system') return preference.value
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })

  function apply() {
    const saved = window.localStorage.getItem(storageKey)
    if (saved === 'dark' || saved === 'light' || saved === 'system') {
      preference.value = saved
    }
    document.documentElement.dataset.theme = resolved.value
  }

  function setPreference(next: ThemePreference) {
    preference.value = next
    window.localStorage.setItem(storageKey, next)
    document.documentElement.dataset.theme = resolved.value
  }

  function toggle() {
    setPreference(resolved.value === 'dark' ? 'light' : 'dark')
  }

  return { preference, resolved, apply, setPreference, toggle }
})

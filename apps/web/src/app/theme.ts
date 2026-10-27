import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type ThemePreference = 'dark' | 'light' | 'system'

const storageKey = 'dev-toolbox.theme'

export const useThemeStore = defineStore('theme', () => {
  const preference = ref<ThemePreference>('dark')
  // 系统深浅色是外部状态：用响应式 ref 承接 matchMedia 的当前值与 change
  // 事件，preference 为 system 时主题才能跟随系统切换。
  const systemQuery = window.matchMedia('(prefers-color-scheme: light)')
  const systemPrefersLight = ref(systemQuery.matches)
  const onSystemChange = (event: MediaQueryListEvent) => {
    systemPrefersLight.value = event.matches
  }
  systemQuery.addEventListener('change', onSystemChange)
  onScopeDispose(() => {
    systemQuery.removeEventListener('change', onSystemChange)
  })

  const resolved = computed<'dark' | 'light'>(() => {
    if (preference.value !== 'system') return preference.value
    return systemPrefersLight.value ? 'light' : 'dark'
  })

  watch(resolved, (value) => {
    document.documentElement.dataset.theme = value
  }, { flush: 'sync' })

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

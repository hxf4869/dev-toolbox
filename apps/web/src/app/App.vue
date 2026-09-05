<script setup lang="ts">
import { onMounted, watch } from 'vue'

import AppShell from '../components/shell/AppShell.vue'
import AuthView from '../modules/auth/AuthView.vue'
import { useAuthStore } from './auth'
import { useThemeStore } from './theme'
import { agentConsoleReturnPath } from './agentConsoleReturn'

const theme = useThemeStore()
const auth = useAuthStore()

onMounted(() => {
  theme.apply()
  void auth.bootstrap()
})

watch(
  () => auth.isAuthenticated,
  (authenticated) => {
    if (!authenticated) return
    const returnPath = agentConsoleReturnPath(
      new URLSearchParams(window.location.search).get('returnTo'),
      window.location.origin,
    )
    if (returnPath) window.location.replace(returnPath)
  },
)
</script>

<template>
  <AppShell v-if="auth.isAuthenticated" />
  <AuthView v-else />
</template>

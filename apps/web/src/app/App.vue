<script setup lang="ts">
import { onMounted } from 'vue'

import AppShell from '../components/shell/AppShell.vue'
import AuthView from '../modules/auth/AuthView.vue'
import { useAuthStore } from './auth'
import { useThemeStore } from './theme'

const theme = useThemeStore()
const auth = useAuthStore()

onMounted(() => {
  theme.apply()
  void auth.bootstrap()
})
</script>

<template>
  <AppShell v-if="auth.isAuthenticated" />
  <AuthView v-else />
</template>

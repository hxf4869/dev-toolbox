<script setup lang="ts">
import { onMounted } from 'vue'

import AppShell from '../components/shell/AppShell.vue'
import { useThemeStore } from './theme'

const theme = useThemeStore()

onMounted(() => theme.apply())
</script>

<template>
  <AppShell />
</template>

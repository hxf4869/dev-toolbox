<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

import UiButton from '../../../../components/ui/UiButton.vue'
import UiIcon from '../../../../components/ui/UiIcon.vue'

const props = defineProps<{ text: string; label?: string }>()
const emit = defineEmits<{ error: [message: string] }>()
const copied = ref(false)
let feedbackTimer: number | undefined

async function copy() {
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    window.clearTimeout(feedbackTimer)
    feedbackTimer = window.setTimeout(() => { copied.value = false }, 1600)
  } catch {
    emit('error', '浏览器未允许写入剪贴板，请手动选择并复制。')
  }
}

onBeforeUnmount(() => window.clearTimeout(feedbackTimer))
</script>

<template>
  <UiButton variant="secondary" :disabled="!text" @click="copy">
    <UiIcon :name="copied ? 'check' : 'copy'" :size="16" />
    <span aria-live="polite">{{ copied ? '已复制' : (label || '复制') }}</span>
  </UiButton>
</template>

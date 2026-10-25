<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import UiButton from '../../../../components/ui/UiButton.vue'
import UiIcon from '../../../../components/ui/UiIcon.vue'

const props = defineProps<{ text: string; label?: string }>()
const emit = defineEmits<{ error: [message: string] }>()
const copied = ref(false)
const failed = ref(false)
let feedbackTimer: number | undefined

function clearFeedbackTimer() {
  window.clearTimeout(feedbackTimer)
}

watch(() => props.text, () => {
  clearFeedbackTimer()
  copied.value = false
  failed.value = false
})

async function copy() {
  const text = props.text
  try {
    await navigator.clipboard.writeText(text)
    if (props.text !== text) return
    failed.value = false
    copied.value = true
    clearFeedbackTimer()
    feedbackTimer = window.setTimeout(() => { copied.value = false }, 1600)
  } catch {
    if (props.text !== text) return
    copied.value = false
    clearFeedbackTimer()
    failed.value = true
    emit('error', '浏览器未允许写入剪贴板，请手动选择并复制。')
  }
}

onBeforeUnmount(clearFeedbackTimer)
</script>

<template>
  <span class="copy-button">
    <UiButton variant="secondary" :disabled="!text" @click="copy">
      <UiIcon :name="copied ? 'check' : 'copy'" :size="16" />
      <span aria-live="polite">{{ copied ? '已复制' : (label || '复制') }}</span>
    </UiButton>
    <span v-if="failed" class="copy-button__error" role="alert">
      <UiIcon name="triangle-alert" :size="14" />
      <span>复制失败：浏览器未允许写入剪贴板，请手动选择并复制。</span>
    </span>
  </span>
</template>

<style scoped>
.copy-button {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.copy-button__error {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--danger);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
}
</style>

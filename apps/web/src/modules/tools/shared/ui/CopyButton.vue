<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import UiButton from '../../../../components/ui/UiButton.vue'
import UiIcon from '../../../../components/ui/UiIcon.vue'

const props = defineProps<{ text: string; label?: string; liveText?: boolean }>()
const emit = defineEmits<{ error: [message: string] }>()
const copied = ref(false)
const failed = ref(false)
let feedbackTimer: number | undefined
let activeCopy = 0

function clearFeedbackTimer() {
  window.clearTimeout(feedbackTimer)
}

function discardPendingCopies() {
  activeCopy += 1
  clearFeedbackTimer()
}

// liveText：text 为持续变化的 live 值（如实时时钟）时启用——反馈归属点击快照，text 自然更新不作废在途复制、不清除反馈；下一次点击仍复制当时最新 text。
watch(() => props.text, () => {
  if (props.liveText) return
  discardPendingCopies()
  copied.value = false
  failed.value = false
})

async function copy() {
  const request = ++activeCopy
  try {
    await navigator.clipboard.writeText(props.text)
    if (request !== activeCopy) return
    failed.value = false
    copied.value = true
    clearFeedbackTimer()
    feedbackTimer = window.setTimeout(() => { copied.value = false }, 1600)
  } catch {
    if (request !== activeCopy) return
    copied.value = false
    clearFeedbackTimer()
    failed.value = true
    emit('error', '浏览器未允许写入剪贴板，请手动选择并复制。')
  }
}

onBeforeUnmount(discardPendingCopies)
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

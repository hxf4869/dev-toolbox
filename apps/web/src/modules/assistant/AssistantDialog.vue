<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

import UiIcon from '../../components/ui/UiIcon.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    titleId: string
    role?: 'dialog' | 'alertdialog'
    closeLabel?: string
    dismissible?: boolean
  }>(),
  { role: 'dialog', closeLabel: '关闭对话框', dismissible: true },
)

const emit = defineEmits<{ close: [] }>()
const root = ref<HTMLElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)

watch(
  () => props.open,
  async (open, wasOpen) => {
    if (open) {
      previousFocus.value = document.activeElement as HTMLElement | null
      await nextTick()
      focusableElements()[0]?.focus()
    } else if (wasOpen) {
      await nextTick()
      previousFocus.value?.focus()
      previousFocus.value = null
    }
  },
)

function requestClose() {
  if (props.dismissible) emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.dismissible) {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const focusable = focusableElements()
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function focusableElements() {
  if (!root.value) return []
  return Array.from(
    root.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="assistant-dialog__overlay" @click.self="requestClose">
      <section
        ref="root"
        class="assistant-dialog"
        :role="role"
        aria-modal="true"
        :aria-labelledby="titleId"
        @keydown="onKeydown"
      >
        <header class="assistant-dialog__header">
          <slot name="title" />
          <button
            v-if="dismissible"
            class="assistant-dialog__close"
            type="button"
            :aria-label="closeLabel"
            :title="closeLabel"
            @click="emit('close')"
          >
            <UiIcon name="x" />
          </button>
        </header>
        <div class="assistant-dialog__body"><slot /></div>
        <footer v-if="$slots.footer" class="assistant-dialog__footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.assistant-dialog__overlay {
  position: fixed;
  z-index: var(--layer-overlay);
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  background: var(--scrim);
}

.assistant-dialog {
  width: min(100%, 460px);
  max-height: min(720px, calc(100dvh - var(--space-8)));
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-dialog);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-overlay);
}

.assistant-dialog__header,
.assistant-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.assistant-dialog__header :deep(h2) {
  margin: 0;
  font-size: 18px;
}

.assistant-dialog__close {
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.assistant-dialog__close:hover {
  border-color: var(--border-subtle);
  background: var(--bg-code);
  color: var(--text-primary);
}

.assistant-dialog__body {
  max-height: min(560px, calc(100dvh - 190px));
  overflow-y: auto;
  padding: var(--space-4);
}

.assistant-dialog__footer {
  flex-wrap: wrap;
  justify-content: flex-end;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 0;
}

@media (max-width: 599px) {
  .assistant-dialog__overlay { align-items: end; padding: 0; }
  .assistant-dialog { width: 100%; max-height: calc(100dvh - var(--space-4)); border-radius: var(--radius-dialog) var(--radius-dialog) 0 0; }
  .assistant-dialog__footer :deep(.button) { flex: 1 1 140px; }
}
</style>

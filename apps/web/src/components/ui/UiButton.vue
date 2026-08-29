<script setup lang="ts">
withDefaults(
  defineProps<{
    type?: 'button' | 'submit' | 'reset'
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    disabled?: boolean
  }>(),
  { type: 'button', variant: 'secondary', disabled: false },
)
</script>

<template>
  <button
    class="button"
    :class="`button--${variant}`"
    :type="type"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.button {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  cursor: pointer;
  color: var(--text-primary);
  font-weight: 600;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.button--primary {
  background: var(--accent);
  color: var(--accent-contrast);
}

.button--primary:hover:not(:disabled) {
  filter: brightness(1.06);
}

.button--secondary {
  border-color: var(--border-strong);
  background: var(--bg-elevated);
}

.button--secondary:hover:not(:disabled),
.button--ghost:hover:not(:disabled) {
  background: var(--accent-soft);
}

.button--ghost {
  background: transparent;
}

.button--danger {
  border-color: color-mix(in srgb, var(--danger) 55%, var(--border-subtle));
  background: transparent;
  color: var(--danger);
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
</style>

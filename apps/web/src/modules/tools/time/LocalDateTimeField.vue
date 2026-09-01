<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  id: string
  modelValue: string
  label: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const datePart = ref('')
const timePart = ref('')

watch(
  () => props.modelValue,
  (value) => {
    const [date = '', time = ''] = value.trim().split(/[T ]/, 2)
    datePart.value = date
    timePart.value = time
  },
  { immediate: true },
)

function emitValue() {
  emit('update:modelValue', `${datePart.value}${timePart.value ? `T${timePart.value}` : ''}`)
}

function updateDate(event: Event) {
  const value = (event.target as HTMLInputElement).value
  const fullValue = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)$/)
  if (fullValue) {
    datePart.value = fullValue[1]
    timePart.value = fullValue[2]
  } else {
    datePart.value = value
  }
  emitValue()
}

function updateTime(event: Event) {
  timePart.value = (event.target as HTMLInputElement).value
  emitValue()
}

function normalizeDate() {
  const digits = datePart.value.replace(/\D/g, '')
  if (digits.length === 8) datePart.value = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`
  emitValue()
}

function normalizeTime() {
  const digits = timePart.value.replace(/\D/g, '')
  if (digits.length === 4 || digits.length === 6) {
    timePart.value = `${digits.slice(0, 2)}:${digits.slice(2, 4)}${digits.length === 6 ? `:${digits.slice(4)}` : ''}`
  }
  emitValue()
}
</script>

<template>
  <div class="local-date-time-field" role="group" :aria-label="label">
    <input
      :id="`${id}-date`"
      :value="datePart"
      type="text"
      inputmode="numeric"
      maxlength="19"
      autocomplete="off"
      spellcheck="false"
      placeholder="YYYY-MM-DD"
      :aria-label="`${label}日期，格式 YYYY-MM-DD`"
      @input="updateDate"
      @blur="normalizeDate"
    />
    <span aria-hidden="true" />
    <input
      :id="`${id}-time`"
      :value="timePart"
      type="text"
      inputmode="numeric"
      maxlength="8"
      autocomplete="off"
      spellcheck="false"
      placeholder="HH:mm:ss"
      :aria-label="`${label}时间，格式 HH:mm:ss`"
      @input="updateTime"
      @blur="normalizeTime"
    />
  </div>
</template>

<style scoped>
.local-date-time-field {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(112px, 1.15fr) 1px minmax(96px, 1fr);
  align-items: stretch;
  margin-top: var(--space-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}

.local-date-time-field:focus-within {
  border-color: var(--focus-ring);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 18%, transparent);
}

.local-date-time-field > span { margin: 8px 0; background: var(--border-subtle); }

input {
  width: 100%;
  min-width: 0;
  min-height: 40px;
  padding: 8px 10px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
}

input::placeholder { color: var(--text-muted); }

@media (max-width: 420px) {
  .local-date-time-field { grid-template-columns: 1fr; }
  .local-date-time-field > span { width: auto; height: 1px; margin: 0 8px; }
}
</style>

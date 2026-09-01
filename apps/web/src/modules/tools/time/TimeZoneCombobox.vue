<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import UiIcon from '../../../components/ui/UiIcon.vue'

const props = defineProps<{
  id: string
  modelValue: string
  options: string[]
  label: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  commit: []
}>()

const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const open = ref(false)
const activeIndex = ref(-1)
const draft = ref(props.modelValue)
const listboxId = computed(() => `${props.id}-options`)
const filteredOptions = computed(() => {
  const query = draft.value.trim().toLocaleLowerCase()
  const matches = query
    ? props.options.filter((zone) => zone.toLocaleLowerCase().includes(query))
    : props.options
  return matches.slice(0, 80)
})

watch(
  () => props.modelValue,
  (value) => {
    if (document.activeElement !== input.value) draft.value = value
  },
)

function updateDraft(event: Event) {
  draft.value = (event.target as HTMLInputElement).value
  emit('update:modelValue', draft.value)
  open.value = true
  activeIndex.value = -1
}

function choose(zone: string) {
  draft.value = zone
  emit('update:modelValue', zone)
  open.value = false
  activeIndex.value = -1
  emit('commit')
  void nextTick(() => input.value?.focus())
}

function commitDraft() {
  const value = draft.value.trim()
  draft.value = value
  emit('update:modelValue', value)
  open.value = false
  activeIndex.value = -1
  emit('commit')
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    open.value = true
    activeIndex.value = Math.min(activeIndex.value + 1, filteredOptions.value.length - 1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    open.value = true
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const option = filteredOptions.value[activeIndex.value]
    if (open.value && option) choose(option)
    else commitDraft()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    open.value = false
    activeIndex.value = -1
  }
}

function handleFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (!next || !root.value?.contains(next)) commitDraft()
}

function toggleOptions() {
  open.value = !open.value
  activeIndex.value = -1
  input.value?.focus()
}
</script>

<template>
  <div ref="root" class="time-zone-field" @focusout="handleFocusOut">
    <input
      :id="id"
      ref="input"
      :value="draft"
      type="text"
      role="combobox"
      :aria-label="label"
      aria-autocomplete="list"
      :aria-controls="listboxId"
      :aria-expanded="open"
      :aria-activedescendant="activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      @focus="open = true"
      @input="updateDraft"
      @keydown="handleKeydown"
    />
    <button type="button" :aria-label="open ? '收起时区选项' : '展开时区选项'" :aria-expanded="open" @click="toggleOptions">
      <UiIcon name="chevron-down" :size="16" />
    </button>
    <ul v-if="open" :id="listboxId" class="time-zone-field__options" role="listbox" :aria-label="label">
      <li
        v-for="(zone, index) in filteredOptions"
        :id="`${id}-option-${index}`"
        :key="zone"
        role="option"
        :aria-selected="zone === modelValue"
        :class="{ active: index === activeIndex }"
        @pointerdown.prevent="choose(zone)"
      >
        <span>{{ zone }}</span>
        <UiIcon v-if="zone === modelValue" name="check" :size="15" />
      </li>
      <li v-if="filteredOptions.length === 0" class="time-zone-field__empty">没有匹配项，可直接输入完整 IANA 时区</li>
    </ul>
  </div>
</template>

<style scoped>
.time-zone-field {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) 40px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-code);
}

.time-zone-field:focus-within {
  border-color: var(--focus-ring);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 18%, transparent);
}

input {
  width: 100%;
  min-width: 0;
  min-height: 40px;
  padding: 8px 10px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
}

.time-zone-field > button {
  display: grid;
  min-height: 40px;
  place-items: center;
  border: 0;
  border-left: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.time-zone-field > button svg { transition: transform 140ms ease; }
.time-zone-field > button[aria-expanded='true'] svg { transform: rotate(180deg); }

.time-zone-field__options {
  position: absolute;
  z-index: var(--layer-popover, 30);
  top: calc(100% + 4px);
  right: 0;
  left: 0;
  max-height: min(320px, 42dvh);
  margin: 0;
  overflow-y: auto;
  padding: var(--space-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-overlay);
  list-style: none;
  overscroll-behavior: contain;
}

.time-zone-field__options li {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-2);
  border-radius: calc(var(--radius-control) - 2px);
  color: var(--text-secondary);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 12px;
}

.time-zone-field__options li:hover,
.time-zone-field__options li.active { background: var(--accent-soft); color: var(--text-primary); }
.time-zone-field__options li[aria-selected='true'] { color: var(--accent); }
.time-zone-field__options .time-zone-field__empty { cursor: default; color: var(--text-muted); font-family: inherit; }
</style>

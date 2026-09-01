<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

/**
 * 可搜索语言下拉（docs/12 §7.1：按中英文名或 code 搜索）。
 * 只展示调用方传入的清单（GET /api/v1/aliyun/translation/languages），
 * 组件本身不持有语言常量。ARIA 采用 combobox + listbox 模式。
 */
export interface LanguageOption {
  code: string
  label: string
  /** 搜索用的附加关键字（英文名、code 等）。 */
  keywords?: string
}

const props = withDefaults(
  defineProps<{
    id: string
    modelValue: string
    options: readonly LanguageOption[]
    placeholder: string
    /** 无可见 label 时提供可访问名称（渲染为输入框与列表的 aria-label）。 */
    label: string
    disabled?: boolean
  }>(),
  { disabled: false },
)
const emit = defineEmits<{ 'update:modelValue': [code: string] }>()

const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const rootElement = ref<HTMLElement | null>(null)
const inputElement = ref<HTMLInputElement | null>(null)
const listElement = ref<HTMLElement | null>(null)

const selected = computed(() => props.options.find((option) => option.code === props.modelValue) ?? null)
const listId = `${props.id}-listbox`
const optionId = (index: number) => `${listId}-option-${index}`

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return props.options
  return props.options.filter((option) =>
    option.label.toLowerCase().includes(keyword) ||
    (option.keywords ?? '').toLowerCase().includes(keyword))
})

function scrollActiveIntoView(): void {
  const element = listElement.value?.querySelector(`#${optionId(activeIndex.value)}`)
  if (element instanceof HTMLElement && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'nearest' })
  }
}

watch(filtered, () => {
  activeIndex.value = 0
})

async function openList() {
  if (props.disabled || open.value) return
  open.value = true
  query.value = ''
  activeIndex.value = Math.max(0, props.options.findIndex((option) => option.code === props.modelValue))
  await nextTick()
  scrollActiveIntoView()
}

function closeList() {
  open.value = false
  query.value = ''
}

function choose(option: LanguageOption) {
  emit('update:modelValue', option.code)
  closeList()
  inputElement.value?.focus()
}

function moveActive(delta: number) {
  if (filtered.value.length === 0) return
  activeIndex.value = (activeIndex.value + delta + filtered.value.length) % filtered.value.length
  void nextTick(() => scrollActiveIntoView())
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!open.value) void openList()
    else moveActive(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!open.value) void openList()
    else moveActive(-1)
    return
  }
  if (event.key === 'Enter') {
    if (!open.value) return
    event.preventDefault()
    const option = filtered.value[activeIndex.value]
    if (option) choose(option)
    return
  }
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    closeList()
  }
}

function handleBlur() {
  // 焦点移出组件（含弹出列表）时收起；选项用 mousedown.prevent 避免先触发 blur。
  window.setTimeout(() => {
    if (!rootElement.value?.contains(document.activeElement)) closeList()
  }, 0)
}

function displayValue(): string {
  if (open.value) return query.value
  return selected.value?.label ?? ''
}
</script>

<template>
  <div ref="rootElement" class="language-select" :class="{ 'language-select--open': open }">
    <input
      :id="id"
      ref="inputElement"
      role="combobox"
      type="text"
      autocomplete="off"
      spellcheck="false"
      :value="displayValue()"
      :placeholder="placeholder"
      :aria-label="label"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="listId"
      :aria-activedescendant="open && filtered.length > 0 ? optionId(activeIndex) : undefined"
      aria-autocomplete="list"
      :disabled="disabled"
      @focus="openList"
      @click="openList"
      @input="open = true; query = ($event.target as HTMLInputElement).value"
      @keydown="handleKeydown"
      @blur="handleBlur"
    >
    <ul
      v-if="open"
      :id="listId"
      ref="listElement"
      class="language-select__list"
      role="listbox"
      :aria-label="label"
    >
      <li
        v-for="(option, index) in filtered"
        :id="optionId(index)"
        :key="option.code"
        role="option"
        :aria-selected="option.code === modelValue ? 'true' : 'false'"
        :class="{
          'language-select__option--active': index === activeIndex,
          'language-select__option--selected': option.code === modelValue,
        }"
        @mousedown.prevent
        @click="choose(option)"
      >
        <span>{{ option.label }}</span>
        <span v-if="option.keywords" class="language-select__code">{{ option.keywords }}</span>
      </li>
      <li v-if="filtered.length === 0" class="language-select__empty" aria-live="polite">没有匹配的语言</li>
    </ul>
  </div>
</template>

<style scoped>
.language-select { position: relative; min-width: 0; flex: 1 1 180px; }

.language-select input {
  width: 100%;
  min-height: 40px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-app);
  color: var(--text-primary);
}

.language-select input:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.language-select--open input { border-color: var(--accent); }

.language-select__list {
  position: absolute;
  z-index: 30;
  top: calc(100% + var(--space-1));
  left: 0;
  max-height: 280px;
  width: min(340px, 90vw);
  margin: 0;
  padding: var(--space-1) 0;
  overflow-y: auto;
  list-style: none;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-overlay);
}

.language-select__list li {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 0 var(--space-3);
  cursor: pointer;
  color: var(--text-primary);
}

.language-select__option--active { background: var(--accent-soft); }
.language-select__option--selected { color: var(--accent); font-weight: 700; }
.language-select__code { flex: none; color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; }
.language-select__empty { color: var(--text-muted); cursor: default; }

@media (max-width: 767px) {
  .language-select input { min-height: 44px; }
  .language-select__list { width: 100%; }
}
</style>

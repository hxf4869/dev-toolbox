<script setup lang="ts">
import { useThemeStore, type ThemePreference } from '../../app/theme'

const theme = useThemeStore()

const choices: Array<{ value: ThemePreference; label: string; detail: string }> = [
  { value: 'dark', label: '深色', detail: '默认主题，适合长时间阅读命令与日志。' },
  { value: 'light', label: '浅色', detail: '明亮环境下保持相同的信息层级。' },
  { value: 'system', label: '跟随系统', detail: '按系统外观自动选择深色或浅色。' },
]
</script>

<template>
  <section class="settings" aria-labelledby="appearance-heading">
    <header>
      <p>设置</p>
      <h2 id="appearance-heading">外观</h2>
    </header>

    <fieldset>
      <legend>主题</legend>
      <label v-for="choice in choices" :key="choice.value" class="theme-choice">
        <input
          type="radio"
          name="theme"
          :value="choice.value"
          :checked="theme.preference === choice.value"
          @change="theme.setPreference(choice.value)"
        />
        <span>
          <strong>{{ choice.label }}</strong>
          <small>{{ choice.detail }}</small>
        </span>
      </label>
    </fieldset>
  </section>
</template>

<style scoped>
.settings {
  width: min(100%, 760px);
  padding: var(--space-6);
}

header {
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
}

header p,
h2 {
  margin: 0;
}

header p {
  color: var(--text-muted);
  font-size: 12px;
}

h2 {
  font-size: 20px;
}

fieldset {
  display: grid;
  gap: var(--space-3);
  margin: var(--space-6) 0 0;
  padding: 0;
  border: 0;
}

legend {
  margin-bottom: var(--space-3);
  font-size: 16px;
  font-weight: 600;
}

.theme-choice {
  display: flex;
  min-height: 64px;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  cursor: pointer;
  background: var(--bg-elevated);
}

.theme-choice:has(input:checked) {
  border-color: var(--accent);
  box-shadow: inset 3px 0 0 var(--accent);
}

.theme-choice input {
  width: 18px;
  height: 18px;
  margin: 2px 0 0;
  accent-color: var(--accent);
}

.theme-choice span,
.theme-choice small {
  display: block;
}

.theme-choice small {
  margin-top: var(--space-1);
  color: var(--text-secondary);
}
</style>

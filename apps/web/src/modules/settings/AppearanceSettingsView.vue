<script setup lang="ts">
import { computed } from 'vue'

import { useThemeStore, type ThemePreference } from '../../app/theme'
import UiIcon from '../../components/ui/UiIcon.vue'
import SettingsPageShell from './SettingsPageShell.vue'

const theme = useThemeStore()

const choices: Array<{ value: ThemePreference; label: string; detail: string }> = [
  { value: 'dark', label: '深色', detail: '默认主题，适合长时间阅读命令与日志。' },
  { value: 'light', label: '浅色', detail: '明亮环境下保持相同的信息层级。' },
  { value: 'system', label: '跟随系统', detail: '按系统外观自动选择深色或浅色。' },
]

const currentChoice = computed(() =>
  choices.find((choice) => choice.value === theme.preference) ?? choices[0]!,
)
</script>

<template>
  <SettingsPageShell
    title-id="appearance-heading"
    title="外观"
    description="选择深色、浅色或跟随系统。"
  >
    <section class="settings-card" aria-labelledby="theme-heading">
      <header class="settings-card__header">
        <div>
          <h3 id="theme-heading">主题</h3>
          <p>更改立即应用，只保存在当前浏览器。</p>
        </div>
      </header>
      <div class="settings-card__body">
        <fieldset class="theme-fieldset">
          <legend class="sr-only">主题</legend>
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
      </div>
    </section>

    <template #aside>
      <section>
        <h3>当前显示</h3>
        <dl class="settings-context__list">
          <div><dt>偏好</dt><dd>{{ currentChoice.label }}</dd></div>
          <div><dt>实际主题</dt><dd>{{ theme.resolved === 'dark' ? '深色' : '浅色' }}</dd></div>
          <div><dt>保存位置</dt><dd>当前浏览器</dd></div>
        </dl>
      </section>
      <section class="settings-context__notice">
        <UiIcon name="monitor" />
        <div>
          <strong>布局不会随主题改变</strong>
          <p>切换只改变界面配色。</p>
        </div>
      </section>
      <p class="settings-context__footnote">“跟随系统”会在系统明暗模式变化后解析为相应主题。</p>
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.theme-fieldset {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  border: 0;
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

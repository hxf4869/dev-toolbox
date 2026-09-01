<script setup lang="ts">
import SettingsSubnav from './SettingsSubnav.vue'

withDefaults(
  defineProps<{
    titleId: string
    title: string
    description: string
    showAside?: boolean
    surface?: boolean
  }>(),
  {
    showAside: true,
    surface: true,
  },
)
</script>

<template>
  <section class="settings-page" :aria-labelledby="titleId">
    <SettingsSubnav />

    <header class="settings-page__header">
      <div class="settings-page__heading">
        <h2 :id="titleId">{{ title }}</h2>
        <p>{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="settings-page__actions">
        <slot name="actions" />
      </div>
    </header>

    <div v-if="$slots.notices" class="settings-page__notices">
      <slot name="notices" />
    </div>

    <div
      class="settings-layout"
      :class="{ 'settings-layout--single': !$slots.aside || !showAside }"
    >
      <div class="settings-main" :class="{ 'settings-main--surface': surface }">
        <slot />
      </div>
      <aside v-if="$slots.aside && showAside" class="settings-context">
        <slot name="aside" />
      </aside>
    </div>
  </section>
</template>

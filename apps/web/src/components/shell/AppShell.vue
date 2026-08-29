<script setup lang="ts">
import { RouterView } from 'vue-router'

import AppRail from './AppRail.vue'
import ModuleNav from './ModuleNav.vue'
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="shell">
    <AppRail />
    <ModuleNav />
    <main id="main-content" class="shell__main" tabindex="-1">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  min-height: 100dvh;
  grid-template-columns: var(--rail-width) var(--module-nav-width) minmax(0, 1fr);
}

.shell__main {
  min-width: 0;
  background: var(--bg-surface);
}

@media (max-width: 1279px) {
  .shell {
    grid-template-columns: var(--rail-width) minmax(0, 1fr);
  }
}

@media (max-width: 599px) {
  .shell {
    display: flex;
    min-height: 100dvh;
    flex-direction: column;
  }
}
</style>

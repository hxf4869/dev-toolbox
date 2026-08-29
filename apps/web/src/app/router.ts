import { createRouter, createWebHistory } from 'vue-router'

import AppearanceSettingsView from '../modules/settings/AppearanceSettingsView.vue'
import WorkspaceView from '../modules/knowledge/WorkspaceView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'workspace', component: WorkspaceView },
    {
      path: '/settings/appearance',
      name: 'appearance-settings',
      component: AppearanceSettingsView,
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

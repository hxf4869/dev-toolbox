import { createRouter, createWebHistory } from 'vue-router'

import AppearanceSettingsView from '../modules/settings/AppearanceSettingsView.vue'
import SecuritySettingsView from '../modules/settings/SecuritySettingsView.vue'
import WorkspaceView from '../modules/knowledge/WorkspaceView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'workspace', component: WorkspaceView },
    { path: '/items/:itemId', name: 'item-detail', component: WorkspaceView },
    {
      path: '/settings/appearance',
      name: 'appearance-settings',
      component: AppearanceSettingsView,
    },
    {
      path: '/settings/security',
      name: 'security-settings',
      component: SecuritySettingsView,
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

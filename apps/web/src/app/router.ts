import { createRouter, createWebHistory } from 'vue-router'

import AppearanceSettingsView from '../modules/settings/AppearanceSettingsView.vue'
import AISecuritySettingsView from '../modules/settings/AISecuritySettingsView.vue'
import ProviderSettingsView from '../modules/settings/ProviderSettingsView.vue'
import SecuritySettingsView from '../modules/settings/SecuritySettingsView.vue'
import TokenSettingsView from '../modules/settings/TokenSettingsView.vue'
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
    {
      path: '/settings/providers',
      name: 'provider-settings',
      component: ProviderSettingsView,
    },
    {
      path: '/settings/tokens',
      name: 'token-settings',
      component: TokenSettingsView,
    },
    {
      path: '/settings/ai-security',
      name: 'ai-security-settings',
      component: AISecuritySettingsView,
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

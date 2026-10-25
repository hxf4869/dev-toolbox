import {
  createRouter,
  createWebHistory,
  type RouterHistory,
  type RouteRecordRaw,
} from 'vue-router'
import { nextTick } from 'vue'

export const LEGACY_KNOWLEDGE_QUERY_KEYS = [
  'view',
  'folderId',
  'tagId',
  'sort',
  'kind',
  'sensitivity',
  'from',
  'to',
] as const

export const appRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('../modules/home/HomeView.vue'),
    meta: { module: 'home' },
    beforeEnter: (to) => {
      const containsKnowledgeQuery = LEGACY_KNOWLEDGE_QUERY_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(to.query, key),
      )
      if (!containsKnowledgeQuery) return true
      return { name: 'workspace', query: to.query, replace: true }
    },
  },
  {
    path: '/knowledge',
    name: 'workspace',
    component: () => import('../modules/knowledge/WorkspaceView.vue'),
    meta: { module: 'knowledge' },
  },
  {
    path: '/assistant',
    name: 'assistant',
    component: () => import('../modules/assistant/AssistantView.vue'),
    meta: { module: 'assistant' },
  },
  {
    path: '/items/:itemId',
    name: 'item-detail',
    component: () => import('../modules/knowledge/WorkspaceView.vue'),
    meta: { module: 'knowledge' },
  },
  {
    path: '/tools',
    name: 'tools',
    component: () => import('../modules/tools/ToolsIndexView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/base64',
    name: 'tool-base64',
    component: () => import('../modules/tools/base64/Base64ToolView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/url',
    name: 'tool-url',
    component: () => import('../modules/tools/url/UrlToolView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/jwt',
    name: 'tool-jwt',
    component: () => import('../modules/tools/jwt/JwtToolView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/json',
    name: 'tool-json',
    component: () => import('../modules/tools/json/JsonView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/yaml',
    name: 'tool-yaml',
    component: () => import('../modules/tools/yaml/YamlView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/time',
    name: 'tool-time',
    component: () => import('../modules/tools/time/TimeToolView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/digest',
    name: 'tool-digest',
    component: () => import('../modules/tools/digest/DigestToolView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/regex',
    name: 'tool-regex',
    component: () => import('../modules/tools/regex/RegexToolView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/translate',
    name: 'tool-translate',
    component: () => import('../modules/tools/translate/TranslateView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/tools/ocr-translate',
    name: 'tool-ocr',
    component: () => import('../modules/tools/ocr-translate/OcrTranslateView.vue'),
    meta: { module: 'tools' },
  },
  {
    path: '/ai/tasks',
    name: 'task-center',
    component: () => import('../modules/ai/TaskCenterView.vue'),
    meta: { module: 'ai' },
  },
  {
    path: '/help',
    name: 'help',
    component: () => import('../modules/help/HelpView.vue'),
    meta: { module: 'help' },
  },
  {
    path: '/settings/appearance',
    name: 'appearance-settings',
    component: () => import('../modules/settings/AppearanceSettingsView.vue'),
    meta: { module: 'settings' },
  },
  {
    path: '/settings/security',
    name: 'security-settings',
    component: () => import('../modules/settings/SecuritySettingsView.vue'),
    meta: { module: 'settings' },
  },
  {
    path: '/settings/providers',
    name: 'provider-settings',
    component: () => import('../modules/settings/ProviderSettingsView.vue'),
    meta: { module: 'settings' },
  },
  {
    path: '/settings/tokens',
    name: 'token-settings',
    component: () => import('../modules/settings/TokenSettingsView.vue'),
    meta: { module: 'settings' },
  },
  {
    path: '/settings/ai-security',
    name: 'ai-security-settings',
    component: () => import('../modules/settings/AISecuritySettingsView.vue'),
    meta: { module: 'settings' },
  },
  {
    path: '/settings/ai-schedule',
    name: 'ai-schedule-settings',
    component: () => import('../modules/ai/AIScheduleView.vue'),
    meta: { module: 'settings' },
  },
  {
    path: '/settings/aliyun',
    name: 'aliyun-settings',
    component: () => import('../modules/settings/AliyunSettingsView.vue'),
    meta: { module: 'settings' },
  },
  {
    path: '/settings/operations',
    name: 'operations-settings',
    component: () => import('../modules/operations/OperationsStatusView.vue'),
    meta: { module: 'settings' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../modules/help/NotFoundView.vue'),
    meta: { module: 'not-found' },
  },
]

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({
    history,
    routes: appRoutes,
    scrollBehavior: async (to): Promise<false | void> => {
      if (!to.hash) {
        document.getElementById('main-content')?.scrollTo({ top: 0 })
        return false
      }
      await nextTick()
      document.getElementById(to.hash.slice(1))?.scrollIntoView()
      return false
    },
  })
}

export const router = createAppRouter()

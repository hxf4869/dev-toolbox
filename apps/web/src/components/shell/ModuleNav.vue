<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { V2_TOOLS } from '../../modules/tools/toolLinks'
import UiIcon from '../ui/UiIcon.vue'

const props = withDefaults(defineProps<{ open?: boolean }>(), { open: false })
const emit = defineEmits<{ close: [] }>()
const route = useRoute()
const navRoot = ref<HTMLElement | null>(null)
const compact = ref(false)
const toolQuery = ref('')
let mediaQuery: MediaQueryList | undefined
let focusTimer: number | undefined

const KnowledgeModuleNav = defineAsyncComponent(
  () => import('../../modules/knowledge/KnowledgeModuleNav.vue'),
)
const AssistantModuleNav = defineAsyncComponent(
  () => import('../../modules/assistant/AssistantModuleNav.vue'),
)

const moduleName = computed(() => String(route.meta.module ?? 'not-found'))
const header = computed(() => ({
  home: { eyebrow: '开发百宝箱', title: '工作入口' },
  knowledge: { eyebrow: '知识与记录', title: '资料库' },
  assistant: { eyebrow: '有出处的多轮问答', title: '知识助手' },
  tools: { eyebrow: '本地与在线工具', title: '工具箱' },
  ai: { eyebrow: '受控 AI 工作流', title: 'AI 任务' },
  settings: { eyebrow: '实例与偏好', title: '设置' },
  help: { eyebrow: '产品逻辑与边界', title: '帮助中心' },
  'not-found': { eyebrow: '开发百宝箱', title: '导航' },
})[moduleName.value] ?? { eyebrow: '开发百宝箱', title: '导航' })

const encodingTools = V2_TOOLS.filter((tool) => tool.group === 'encoding')
const developmentTools = V2_TOOLS.filter((tool) => tool.group === 'development')
const onlineTools = V2_TOOLS.filter((tool) => tool.group === 'online')
const normalizedToolQuery = computed(() => toolQuery.value.trim().toLocaleLowerCase())
const visibleEncodingTools = computed(() => filterTools(encodingTools))
const visibleDevelopmentTools = computed(() => filterTools(developmentTools))
const visibleOnlineTools = computed(() => filterTools(onlineTools))
const visibleToolCount = computed(() =>
  visibleEncodingTools.value.length + visibleDevelopmentTools.value.length + visibleOnlineTools.value.length,
)

const settingsLinks = [
  { to: '/settings/providers', name: 'provider-settings', icon: 'boxes' as const, label: 'Provider 与模型' },
  { to: '/settings/tokens', name: 'token-settings', icon: 'key-round' as const, label: '外部 Agent' },
  { to: '/settings/ai-security', name: 'ai-security-settings', icon: 'shield-alert' as const, label: 'AI 与敏感数据' },
  { to: '/settings/ai-schedule', name: 'ai-schedule-settings', icon: 'clock' as const, label: '批量与自动整理' },
  { to: '/settings/aliyun', name: 'aliyun-settings', icon: 'cloud' as const, label: '阿里云服务' },
  { to: '/settings/security', name: 'security-settings', icon: 'shield-check' as const, label: '安全与会话' },
  { to: '/settings/appearance', name: 'appearance-settings', icon: 'sun' as const, label: '外观' },
  { to: '/settings/operations', name: 'operations-settings', icon: 'monitor' as const, label: '系统状态与验收' },
]

watch(
  () => props.open,
  async (open) => {
    if (!compact.value) return
    if (focusTimer !== undefined) {
      window.clearTimeout(focusTimer)
      focusTimer = undefined
    }
    if (open) {
      await nextTick()
      const firstTarget = navRoot.value?.querySelector<HTMLElement>('.module-nav__header button')
      firstTarget?.focus()
      if (firstTarget) {
        focusTimer = window.setTimeout(() => {
          focusTimer = undefined
          if (compact.value && props.open) firstTarget.focus()
        }, 50)
      }
    }
  },
)

watch(() => route.fullPath, () => {
  if (compact.value && props.open) emit('close')
})

// 只在路由或搜索词变化时展开当前工具所在组；同路由、同查询下的手动折叠保持不变。
watch(
  [() => route.name, normalizedToolQuery],
  async () => {
    if (moduleName.value !== 'tools') return
    await nextTick()
    const currentGroup = navRoot.value
      ?.querySelector('details nav a.active')
      ?.closest('details') as HTMLDetailsElement | null
    if (currentGroup) currentGroup.open = true
  },
  { immediate: true },
)

onMounted(() => {
  mediaQuery = window.matchMedia('(max-width: 1279px)')
  updateCompact(mediaQuery)
  mediaQuery.addEventListener('change', updateCompact)
  window.addEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => {
  if (focusTimer !== undefined) window.clearTimeout(focusTimer)
  mediaQuery?.removeEventListener('change', updateCompact)
  window.removeEventListener('keydown', onWindowKeydown)
})

function updateCompact(event: MediaQueryList | MediaQueryListEvent) {
  compact.value = event.matches
}

function filterTools(tools: typeof V2_TOOLS) {
  if (!normalizedToolQuery.value) return tools
  return tools.filter((tool) =>
    `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(normalizedToolQuery.value),
  )
}

function close() {
  if (compact.value) emit('close')
}

function onContentClick(event: MouseEvent) {
  if ((event.target as Element | null)?.closest('a')) close()
}

function onDialogKeydown(event: KeyboardEvent) {
  if (!compact.value) return
  if (event.key !== 'Tab' || !navRoot.value) return
  const focusable = Array.from(navRoot.value.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hidden)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function onWindowKeydown(event: KeyboardEvent) {
  if (!compact.value || !props.open || event.key !== 'Escape') return
  event.preventDefault()
  close()
}
</script>

<template>
  <div v-if="compact && open" class="module-nav__scrim" aria-hidden="true" @click="close" />
  <aside
    ref="navRoot"
    class="module-nav"
    :class="{ 'module-nav--open': open }"
    :role="compact ? 'dialog' : undefined"
    :aria-modal="compact ? 'true' : undefined"
    :aria-label="`${header.title}导航`"
    :aria-hidden="compact && !open ? 'true' : undefined"
    :inert="compact && !open ? true : undefined"
    @keydown="onDialogKeydown"
  >
    <header class="module-nav__header">
      <div>
        <p>{{ header.eyebrow }}</p>
        <h1>{{ header.title }}</h1>
      </div>
      <button v-if="compact" type="button" aria-label="关闭导航" @click="close">
        <UiIcon name="x" />
      </button>
    </header>

    <div class="module-nav__content" @click="onContentClick">
      <template v-if="moduleName === 'home' || moduleName === 'not-found'">
        <section aria-labelledby="home-nav-heading">
          <h2 id="home-nav-heading">业务模块</h2>
          <nav>
            <RouterLink to="/" :class="{ active: route.name === 'home' }"><UiIcon name="house" /> 首页</RouterLink>
            <RouterLink to="/knowledge"><UiIcon name="book-open" /> 知识与记录</RouterLink>
            <RouterLink to="/assistant"><UiIcon name="sparkles" /> 知识助手</RouterLink>
            <RouterLink to="/tools"><UiIcon name="wrench" /> 工具箱</RouterLink>
          </nav>
        </section>
        <p class="module-nav__boundary">本地工具的输入与结果仅留在当前页面；知识记录可在资料库中保存与检索。</p>
      </template>

      <KnowledgeModuleNav v-else-if="moduleName === 'knowledge'" />

      <AssistantModuleNav v-else-if="moduleName === 'assistant'" @navigate="close" />

      <template v-else-if="moduleName === 'tools'">
        <label class="module-nav__search">
          <UiIcon name="search" :size="16" />
          <input v-model="toolQuery" type="search" placeholder="搜索工具" autocomplete="off" />
          <span class="sr-only">搜索工具</span>
        </label>
        <details open>
          <summary id="encoding-tools-heading"><span>编码与数据</span><small>{{ visibleEncodingTools.length }}</small></summary>
          <nav>
            <RouterLink v-for="tool in visibleEncodingTools" :key="tool.path" :to="tool.path" :class="{ active: route.name === tool.routeName }">
              <UiIcon :name="tool.icon" /><span>{{ tool.name }}</span>
            </RouterLink>
          </nav>
        </details>
        <details :open="normalizedToolQuery ? true : undefined">
          <summary id="development-tools-heading"><span>开发辅助</span><small>{{ visibleDevelopmentTools.length }}</small></summary>
          <nav>
            <RouterLink v-for="tool in visibleDevelopmentTools" :key="tool.path" :to="tool.path" :class="{ active: route.name === tool.routeName }">
              <UiIcon :name="tool.icon" /><span>{{ tool.name }}</span>
            </RouterLink>
          </nav>
        </details>
        <details v-if="onlineTools.length" :open="normalizedToolQuery ? true : undefined">
          <summary id="online-tools-heading"><span>在线能力</span><small>{{ visibleOnlineTools.length }}</small></summary>
          <nav>
            <RouterLink v-for="tool in visibleOnlineTools" :key="tool.path" :to="tool.path" :class="{ active: route.name === tool.routeName }">
              <UiIcon :name="tool.icon" /><span>{{ tool.name }}</span>
            </RouterLink>
          </nav>
        </details>
        <p v-if="normalizedToolQuery && !visibleToolCount" class="module-nav__empty">没有匹配工具。换一个名称或关键词试试。</p>
        <p class="module-nav__boundary">本地工具的输入与结果仅在当前标签页内存中存在；在线工具只在明确确认后发送内容。</p>
      </template>

      <section v-else-if="moduleName === 'ai'" aria-labelledby="task-nav-heading">
        <h2 id="task-nav-heading">任务工作台</h2>
        <nav>
          <RouterLink to="/ai/tasks" :class="{ active: route.name === 'task-center' && !route.query.status }"><UiIcon name="sparkles" /> 全部任务</RouterLink>
          <RouterLink :to="{ name: 'task-center', query: { status: 'running' } }" :class="{ active: route.query.status === 'running' }"><UiIcon name="clock" /> 运行状态</RouterLink>
          <RouterLink to="/settings/ai-schedule"><UiIcon name="settings" /> 批量与自动整理</RouterLink>
        </nav>
        <p class="module-nav__boundary">AI 只能读取受控上下文并提交候选 Artifact，不执行 Shell、SSH 或 SQL。</p>
      </section>

      <section v-else-if="moduleName === 'settings'" aria-labelledby="settings-nav-heading">
        <h2 id="settings-nav-heading">设置</h2>
        <nav>
          <RouterLink v-for="link in settingsLinks" :key="link.to" :to="link.to" :class="{ active: route.name === link.name }">
            <UiIcon :name="link.icon" />{{ link.label }}
          </RouterLink>
        </nav>
      </section>

      <section v-else-if="moduleName === 'help'" aria-labelledby="help-nav-heading">
        <h2 id="help-nav-heading">帮助主题</h2>
        <nav>
          <RouterLink to="/help#capture-search"><UiIcon name="search" /> 快速记录与搜索</RouterLink>
          <RouterLink to="/help#knowledge-assistant"><UiIcon name="sparkles" /> 知识助手与引用</RouterLink>
          <RouterLink to="/help#local-tools"><UiIcon name="wrench" /> 本地工具与 JSON AI</RouterLink>
          <RouterLink to="/help#core-concepts"><UiIcon name="book-open" /> 原始记录与 AI 版本</RouterLink>
          <RouterLink to="/help#sensitive-provider"><UiIcon name="shield-alert" /> 敏感内容与 Provider</RouterLink>
          <RouterLink to="/help#tasks"><UiIcon name="clock" /> 任务取消与重试</RouterLink>
          <RouterLink to="/help#backup-restore"><UiIcon name="download" /> 附件备份与恢复</RouterLink>
          <RouterLink to="/help#boundaries"><UiIcon name="shield-check" /> 产品边界</RouterLink>
        </nav>
      </section>

      <nav v-if="compact" class="module-nav__help" aria-label="帮助与使用指引">
        <RouterLink to="/help" :class="{ active: route.meta.module === 'help' }"><UiIcon name="circle-help" /> 帮助与使用指引</RouterLink>
      </nav>
    </div>
  </aside>
</template>

<style scoped>
.module-nav {
  position: relative;
  z-index: 19;
  width: var(--module-nav-width);
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-5) var(--space-3);
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-nav);
  scrollbar-color: var(--border-strong) transparent;
}

.module-nav__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-6); padding: 0 var(--space-2); }
.module-nav__header p, h2 { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: .05em; }
.module-nav__header h1 { margin: 0; font-size: 20px; line-height: 1.3; }
.module-nav__header button { display: grid; width: 40px; height: 40px; place-items: center; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.module-nav__content > details { margin-top: var(--space-4); }
.module-nav__content > details:first-of-type { margin-top: var(--space-5); }
.module-nav__content summary { display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: var(--space-2); color: var(--text-muted); cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: .04em; list-style: none; }
.module-nav__content summary::-webkit-details-marker { display: none; }
.module-nav__content summary::before { display: inline-block; content: '›'; font-size: 16px; transform: rotate(0deg); transition: transform var(--motion-fast) var(--ease-standard); }
.module-nav__content details[open] summary::before { transform: rotate(90deg); }
.module-nav__content summary span { margin-right: auto; }
.module-nav__content summary small { min-width: 24px; padding: 1px var(--space-1); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); text-align: center; }
.module-nav__search { position: relative; display: flex; min-height: 42px; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-muted); }
.module-nav__search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); }
.module-nav__search input::placeholder { color: var(--text-muted); }
.module-nav__empty { padding: var(--space-4) var(--space-2); color: var(--text-muted); font-size: 12px; }
nav { display: grid; gap: 2px; }
nav a { display: flex; min-width: 0; min-height: 38px; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); color: var(--text-secondary); text-decoration: none; }
nav a span { display: -webkit-box; overflow: hidden; line-height: 1.35; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
nav a:hover, nav a.active { border-color: var(--border-subtle); background: var(--accent-soft); color: var(--accent); }
nav a.active { box-shadow: inset 2px 0 0 var(--accent); }
.module-nav__boundary { margin-top: var(--space-5); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); color: var(--text-muted); font-size: 11px; }
.module-nav__help { margin-top: var(--space-5); }
.module-nav__scrim { position: fixed; z-index: 38; inset: 0; background: var(--scrim); }

@media (max-width: 1279px) {
  .module-nav { position: fixed; z-index: 39; top: 0; bottom: 0; left: 0; visibility: hidden; width: min(292px, calc(100vw - 48px)); height: 100dvh; transform: translateX(-104%); box-shadow: var(--shadow-overlay); transition: transform var(--motion-base) var(--ease-standard), visibility var(--motion-base); }
  .module-nav--open { visibility: visible; transform: translateX(0); }
  .module-nav__header button { width: 44px; height: 44px; }
  nav a { min-height: 44px; }
}
</style>

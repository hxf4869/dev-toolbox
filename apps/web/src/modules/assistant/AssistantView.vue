<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { storeToRefs } from 'pinia'

import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import type { AssistantSourceDTO, TemporarySourceDTO } from './assistantContracts'
import AssistantThread from './AssistantThread.vue'
import CitationDrawer from './CitationDrawer.vue'
import { useAssistantStore, type AssistantCitationSelection } from './assistantStore'

const store = useAssistantStore()
const { bootstrap, loading, pageError } = storeToRefs(store)
const drawerOpen = ref(false)
const selectedCitation = ref<AssistantCitationSelection | null>(null)
const source = ref<AssistantSourceDTO | TemporarySourceDTO | null>(null)
const sourceLoading = ref(false)
const sourceError = ref('')
let sourceRequest = 0

onMounted(() => void store.initialize())

onBeforeUnmount(() => {
  sourceRequest += 1
  store.disposeView()
})

async function openCitation(selection: AssistantCitationSelection) {
  selectedCitation.value = selection
  source.value = null
  sourceError.value = ''
  drawerOpen.value = true
  await loadSource()
}

async function loadSource() {
  if (!selectedCitation.value) return
  const request = ++sourceRequest
  sourceLoading.value = true
  sourceError.value = ''
  try {
    const result = await store.getSource(
      selectedCitation.value.citation,
      selectedCitation.value.messageId,
    )
    if (request === sourceRequest) source.value = result
  } catch (error) {
    if (request === sourceRequest) {
      sourceError.value = error instanceof Error ? error.message : '来源暂时无法读取。'
    }
  } finally {
    if (request === sourceRequest) sourceLoading.value = false
  }
}

function closeCitation() {
  sourceRequest += 1
  drawerOpen.value = false
  sourceLoading.value = false
  sourceError.value = ''
  source.value = null
  selectedCitation.value = null
}
</script>

<template>
  <section class="assistant-view" aria-label="知识助手工作区">
    <section v-if="loading && !bootstrap" class="assistant-view__state" aria-labelledby="assistant-loading-title">
      <span class="assistant-view__spinner" aria-hidden="true" />
      <h1 id="assistant-loading-title">正在准备知识助手</h1>
      <p>读取可用模型、知识索引状态和会话目录。</p>
    </section>

    <section v-else-if="pageError && !bootstrap" class="assistant-view__state assistant-view__state--error" aria-labelledby="assistant-error-title">
      <div class="assistant-view__state-icon"><UiIcon name="wifi-off" :size="24" /></div>
      <h1 id="assistant-error-title">知识助手暂时无法载入</h1>
      <p>{{ pageError }}</p>
      <UiButton variant="secondary" @click="store.initialize">重试</UiButton>
    </section>

    <section v-else-if="bootstrap && !bootstrap.models.length" class="assistant-view__state" aria-labelledby="assistant-no-model-title">
      <div class="assistant-view__state-icon"><UiIcon name="boxes" :size="25" /></div>
      <p class="assistant-view__eyebrow">需要一次明确配置</p>
      <h1 id="assistant-no-model-title">还没有可用的聊天模型</h1>
      <p>知识助手不会替你静默选择或猜测模型。请先启用 Provider、配置 API Key，并至少启用一个聊天模型。</p>
      <RouterLink class="assistant-view__settings-link" to="/settings/providers">
        <UiIcon name="settings" :size="17" />前往 Provider 与模型设置
      </RouterLink>
    </section>

    <AssistantThread v-else-if="bootstrap" @citation="openCitation" />

    <CitationDrawer
      :open="drawerOpen"
      :source="source"
      :loading="sourceLoading"
      :error="sourceError"
      :citation-number="selectedCitation?.citation.citationNumber ?? null"
      @close="closeCitation"
      @retry="loadSource"
    />
  </section>
</template>

<style scoped>
.assistant-view {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-surface);
}

.assistant-view__state {
  display: grid;
  width: min(calc(100% - 32px), 640px);
  height: 100%;
  min-height: 440px;
  place-content: center;
  justify-items: center;
  margin: auto;
  color: var(--text-secondary);
  text-align: center;
}

.assistant-view__state h1 { max-width: 24ch; margin: var(--space-3) 0 0; color: var(--text-primary); font-size: clamp(24px, 1.25rem + .8vw, 34px); line-height: 1.3; text-wrap: balance; }
.assistant-view__state > p:not(.assistant-view__eyebrow) { max-width: 58ch; margin: var(--space-3) 0 var(--space-5); line-height: 1.7; }
.assistant-view__eyebrow { margin: var(--space-4) 0 0; color: var(--accent); font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.assistant-view__state-icon { display: grid; width: 52px; height: 52px; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--radius-card); background: var(--bg-elevated); color: var(--accent); }
.assistant-view__state--error .assistant-view__state-icon { color: var(--danger); }
.assistant-view__spinner { width: 32px; height: 32px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: assistant-view-spin .8s linear infinite; }
.assistant-view__settings-link { display: inline-flex; min-height: 44px; align-items: center; gap: var(--space-2); padding: 0 var(--space-4); border-radius: var(--radius-control); background: var(--accent); color: var(--accent-contrast); font-weight: 700; text-decoration: none; }
.assistant-view__settings-link:hover { filter: brightness(1.04); }

@keyframes assistant-view-spin { to { transform: rotate(360deg); } }

@media (max-width: 599px) {
  .assistant-view__state { min-height: 360px; }
  .assistant-view__state > p:not(.assistant-view__eyebrow) { font-size: 16px; }
  .assistant-view__settings-link { width: 100%; justify-content: center; }
}
</style>

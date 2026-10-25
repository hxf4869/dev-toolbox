<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { RouterLink } from 'vue-router'

import UiIcon from '../../components/ui/UiIcon.vue'
import AssistantComposer from './AssistantComposer.vue'
import AssistantMessage from './AssistantMessage.vue'
import { useAssistantStore, type AssistantCitationSelection } from './assistantStore'

const emit = defineEmits<{
  citation: [selection: AssistantCitationSelection]
}>()

const store = useAssistantStore()
const {
  bootstrap,
  activeConversation,
  conversationLoading,
  messageNextCursor,
  displayMessages,
  models,
  selectedModelId,
  selectedReasoning,
  draft,
  hasActiveRun,
  canStopActiveRun,
  stopRequested,
  sending,
  actionError,
  selectionRequired,
  temporaryMode,
  streamMessage,
  knowledgePollError,
} = storeToRefs(store)

const scrollRoot = ref<HTMLElement | null>(null)
const following = ref(true)
const hasNewContent = ref(false)
const loadingOlder = ref(false)

const title = computed(() =>
  temporaryMode.value ? '临时对话' : activeConversation.value?.title ?? '新对话',
)

const contextRun = computed(() => {
  for (let index = displayMessages.value.length - 1; index >= 0; index--) {
    const message = displayMessages.value[index]!
    if (message.role !== 'assistant') continue
    const runtime = message.run ?? message.temporaryRuntime
    if (runtime && runtime.status !== 'queued' && runtime.status !== 'running') return runtime
  }
  return null
})

const knowledge = computed(() => bootstrap.value?.knowledge ?? null)
const knowledgeLabel = computed(() => {
  if (!knowledge.value) return '知识状态未知'
  if (knowledge.value.status === 'ready') {
    return knowledge.value.counts.active === 0 ? '知识库可用 · 暂无内容' : '知识库可用'
  }
  if (knowledge.value.status === 'indexing') {
    return `知识库索引中 · ${knowledge.value.counts.ready}/${knowledge.value.counts.active}`
  }
  if (knowledge.value.status === 'failed') return `知识库索引失败 · ${knowledge.value.counts.failed}`
  if (knowledge.value.status === 'disabled') return '知识库已禁用'
  return '知识库未配置'
})

const streamFingerprint = computed(() => {
  const last = displayMessages.value.at(-1)
  return [
    displayMessages.value.length,
    last?.content.length ?? 0,
    last?.reasoningContent?.length ?? 0,
    last?.status ?? '',
  ].join(':')
})

watch(streamFingerprint, async () => {
  if (loadingOlder.value) return
  await nextTick()
  if (following.value) scrollToLatest(false)
  else hasNewContent.value = true
})

watch(
  () => `${temporaryMode.value ? 'temporary' : 'persistent'}:${activeConversation.value?.id ?? 'new'}`,
  async () => {
    following.value = true
    hasNewContent.value = false
    await nextTick()
    scrollToLatest(false)
  },
)

onMounted(() => void nextTick(() => scrollToLatest(false)))

function onScroll() {
  const root = scrollRoot.value
  if (!root) return
  const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight <= 72
  following.value = nearBottom
  if (nearBottom) hasNewContent.value = false
}

function scrollToLatest(smooth = true) {
  const root = scrollRoot.value
  if (!root) return
  root.scrollTo({
    top: root.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto',
  })
  following.value = true
  hasNewContent.value = false
}

async function loadOlder() {
  const root = scrollRoot.value
  const previousHeight = root?.scrollHeight ?? 0
  loadingOlder.value = true
  try {
    await store.loadOlderMessages()
    await nextTick()
    if (root) root.scrollTop += root.scrollHeight - previousHeight
  } finally {
    loadingOlder.value = false
  }
}

function useExample(value: string) {
  draft.value = value
  nextTick(() => document.querySelector<HTMLTextAreaElement>('[data-assistant-composer]')?.focus())
}

function emptyStateTitle() {
  if (temporaryMode.value) return '这段对话只存在于当前标签页'
  if (knowledge.value?.status === 'unconfigured') return '可以先进行一般交流'
  if (knowledge.value?.status === 'disabled') return '知识库已禁用，可以先进行一般交流'
  if (knowledge.value?.status === 'indexing') return '知识库正在建立索引'
  if (knowledge.value?.status === 'failed') return '知识库当前不可用'
  if (knowledge.value?.status === 'ready' && knowledge.value.counts.active === 0) return '知识库已就绪，暂时没有可检索内容'
  return '从你的笔记开始提问'
}

function emptyStateDescription() {
  if (temporaryMode.value) return '刷新、关闭标签页或离开本页面后，消息、摘要和草稿都会消失。'
  if (knowledge.value?.status === 'unconfigured') return '未配置 Embedding 时仍可使用模型；回答会明确标记知识库不可用。'
  if (knowledge.value?.status === 'disabled') return '当前知识库不可用；你可以继续使用模型，或前往设置重新启用 Embedding。'
  if (knowledge.value?.status === 'indexing') {
    return `已完成 ${knowledge.value.counts.ready}，待处理 ${knowledge.value.counts.pending}，运行中 ${knowledge.value.counts.running}。索引完成前仍可进行一般交流。`
  }
  if (knowledge.value?.status === 'failed') {
    return `${knowledge.value.counts.failed} 个片段索引失败。修复并重试失败项前，回答不会声称“知识库没有资料”。`
  }
  if (knowledge.value?.status === 'ready' && knowledge.value.counts.active === 0) return '新增合格笔记后会自动建立索引；现在仍可进行一般交流。'
  return '每条消息都会经过确定的知识检索；有依据的回答会提供可追溯引用。'
}
</script>

<template>
  <section class="assistant-thread" aria-labelledby="assistant-thread-title">
    <header class="assistant-thread__header">
      <div>
        <h1 id="assistant-thread-title">{{ title }}</h1>
        <p v-if="temporaryMode"><UiIcon name="history" :size="15" />不保存本会话</p>
        <p v-else-if="activeConversation?.archived"><UiIcon name="history" :size="15" />已归档</p>
      </div>
      <div class="assistant-thread__status">
        <span class="assistant-thread__knowledge" :data-status="knowledge?.status">
          <UiIcon :name="knowledge?.available ? 'check-circle-2' : knowledge?.status === 'failed' ? 'x-circle' : 'info'" :size="15" />
          {{ knowledgeLabel }}
        </span>
        <p v-if="knowledgePollError" class="assistant-thread__knowledge-alert" role="alert">
          <UiIcon name="triangle-alert" :size="15" />
          <span>索引状态自动刷新失败：{{ knowledgePollError }}</span>
          <button type="button" @click="store.retryKnowledgeRefresh">重试</button>
        </p>
      </div>
    </header>

    <div ref="scrollRoot" class="assistant-thread__scroll" role="log" aria-live="polite" aria-relevant="additions text" @scroll.passive="onScroll">
      <div class="assistant-thread__messages">
        <button
          v-if="messageNextCursor"
          class="assistant-thread__older"
          type="button"
          :disabled="conversationLoading"
          @click="loadOlder"
        >
          {{ conversationLoading ? '正在读取…' : '加载更早消息' }}
        </button>

        <div v-if="conversationLoading && !displayMessages.length" class="assistant-thread__loading" role="status">
          <span aria-hidden="true" />正在读取会话…
        </div>

        <div v-else-if="!displayMessages.length" class="assistant-thread__empty">
          <div class="assistant-thread__empty-icon"><UiIcon name="sparkles" :size="24" /></div>
          <h2>{{ emptyStateTitle() }}</h2>
          <p>{{ emptyStateDescription() }}</p>
          <div v-if="knowledge?.status === 'ready' && knowledge.counts.active > 0" class="assistant-thread__examples" aria-label="示例问题">
            <button type="button" @click="useExample('我过去记录过哪些 Docker 数据迁移步骤？')">我过去记录过哪些 Docker 数据迁移步骤？</button>
            <button type="button" @click="useExample('只根据笔记，总结服务器挂载磁盘的检查清单。')">只根据笔记，总结服务器挂载磁盘的检查清单。</button>
            <button type="button" @click="useExample('解释一下这周遇到的部署问题，并区分笔记依据与一般补充。')">区分笔记依据与一般补充</button>
          </div>
          <RouterLink
            v-else-if="knowledge && ['unconfigured', 'failed', 'disabled'].includes(knowledge.status)"
            class="assistant-thread__configure"
            to="/settings/providers"
          ><UiIcon name="settings" :size="16" />配置知识库 Embedding</RouterLink>
        </div>

        <AssistantMessage
          v-for="message in displayMessages"
          v-else
          :key="message.id"
          :message="message"
          @citation="emit('citation', $event)"
          @retry="store.retryLastAnswer"
        />
      </div>
    </div>

    <button
      v-if="hasNewContent"
      class="assistant-thread__latest"
      type="button"
      @click="scrollToLatest()"
    >
      <UiIcon name="chevron-down" :size="16" />跳到最新
    </button>

    <p v-if="streamMessage" class="assistant-thread__stream-status" role="status">
      <UiIcon name="wifi-off" :size="15" />{{ streamMessage }}
    </p>

    <AssistantComposer
      :models="models"
      :model-id="selectedModelId"
      :reasoning="selectedReasoning"
      :draft="draft"
      :active-run="hasActiveRun"
      :can-stop="canStopActiveRun"
      :stop-requested="stopRequested"
      :sending="sending"
      :error="actionError"
      :selection-required="selectionRequired"
      :temporary="temporaryMode"
      :context-run="contextRun"
      @update:draft="draft = $event"
      @model="store.chooseModel"
      @reasoning="store.chooseReasoning"
      @send="store.send"
      @stop="store.stopActiveRun"
    />
  </section>
</template>

<style scoped>
.assistant-thread {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--bg-surface);
}

.assistant-thread__header {
  display: flex;
  min-width: 0;
  min-height: 68px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--page-gutter);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.assistant-thread__header > div { min-width: 0; }
.assistant-thread__header h1 { margin: 0; overflow: hidden; font-size: clamp(18px, 1rem + .35vw, 23px); line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.assistant-thread__header p { display: flex; align-items: center; gap: var(--space-1); margin: 2px 0 0; color: var(--warning); font-size: 11px; }

.assistant-thread__status { display: flex; flex: 0 0 auto; flex-direction: column; align-items: flex-end; gap: var(--space-2); }

.assistant-thread__knowledge {
  display: inline-flex;
  min-height: 32px;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  font-size: 11px;
}

.assistant-thread__knowledge-alert {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-1) var(--space-2);
  border: 1px solid color-mix(in srgb, var(--warning) 48%, var(--border-subtle));
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--warning);
  font-size: 11px;
}

.assistant-thread__knowledge-alert button {
  min-height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-primary);
  cursor: pointer;
}
.assistant-thread__knowledge[data-status='ready'] { border-color: color-mix(in srgb, var(--success) 45%, var(--border-subtle)); color: var(--success); }
.assistant-thread__knowledge[data-status='failed'] { border-color: color-mix(in srgb, var(--danger) 48%, var(--border-subtle)); color: var(--danger); }
.assistant-thread__knowledge[data-status='indexing'] { border-color: color-mix(in srgb, var(--warning) 48%, var(--border-subtle)); color: var(--warning); }

.assistant-thread__scroll {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: var(--border-strong) transparent;
}

.assistant-thread__messages {
  display: grid;
  align-content: start;
  gap: clamp(var(--space-6), 3vw, var(--space-10));
  min-height: 100%;
  padding: clamp(var(--space-6), 4vh, var(--space-10)) 0 var(--space-8);
}

.assistant-thread__older {
  width: max-content;
  min-height: 36px;
  margin: 0 auto;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-secondary);
  cursor: pointer;
}

.assistant-thread__empty,
.assistant-thread__loading {
  display: grid;
  width: min(calc(100% - 32px), 680px);
  min-height: 50vh;
  place-content: center;
  justify-items: center;
  margin: auto;
  color: var(--text-muted);
  text-align: center;
}

.assistant-thread__loading { gap: var(--space-3); }
.assistant-thread__loading > span { width: 28px; height: 28px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: assistant-thread-spin .8s linear infinite; }
.assistant-thread__empty-icon { display: grid; width: 48px; height: 48px; place-items: center; margin-bottom: var(--space-4); border: 1px solid var(--border-strong); border-radius: var(--radius-card); background: var(--bg-elevated); color: var(--accent); }
.assistant-thread__empty h2 { max-width: 28ch; margin: 0; color: var(--text-primary); font-size: clamp(22px, 1.1rem + .65vw, 30px); line-height: 1.35; text-wrap: balance; }
.assistant-thread__empty > p { max-width: 62ch; margin: var(--space-3) 0 0; color: var(--text-secondary); font-size: 14px; line-height: 1.65; }

.assistant-thread__examples { display: grid; width: min(100%, 620px); grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); margin-top: var(--space-6); }
.assistant-thread__examples button { min-height: 48px; padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-elevated); color: var(--text-secondary); cursor: pointer; text-align: left; }
.assistant-thread__examples button:hover { border-color: var(--border-strong); color: var(--text-primary); }
.assistant-thread__examples button:last-child { grid-column: 1 / -1; text-align: center; }
.assistant-thread__configure { display: inline-flex; min-height: 40px; align-items: center; gap: var(--space-2); margin-top: var(--space-5); padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--accent); font-weight: 700; text-decoration: none; }
.assistant-thread__configure:hover { border-color: var(--accent); background: var(--accent-soft); }

.assistant-thread__latest {
  position: absolute;
  z-index: 5;
  right: 50%;
  bottom: 176px;
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-3);
  transform: translateX(50%);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-overlay);
  color: var(--text-primary);
  cursor: pointer;
}

.assistant-thread__stream-status {
  position: absolute;
  z-index: 5;
  right: var(--space-4);
  bottom: 170px;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--warning);
  font-size: 11px;
}

@keyframes assistant-thread-spin { to { transform: rotate(360deg); } }

@media (max-width: 599px) {
  .assistant-thread__header { min-height: 60px; padding-inline: var(--space-3); }
  .assistant-thread__header h1 { font-size: 18px; }
  .assistant-thread__status { max-width: 44%; }
  .assistant-thread__knowledge { max-width: 100%; min-height: 36px; line-height: 1.3; }
  .assistant-thread__knowledge-alert { flex-wrap: wrap; justify-content: flex-end; max-width: 100%; }
  .assistant-thread__knowledge-alert button { min-height: 44px; }
  .assistant-thread__messages { gap: var(--space-8); padding-top: var(--space-6); }
  .assistant-thread__empty > p { font-size: 16px; }
  .assistant-thread__examples { grid-template-columns: 1fr; }
  .assistant-thread__examples button:last-child { grid-column: auto; text-align: left; }
  .assistant-thread__latest { bottom: 220px; min-height: 44px; }
  .assistant-thread__stream-status { right: var(--space-3); bottom: 218px; left: var(--space-3); justify-content: center; }
}
</style>

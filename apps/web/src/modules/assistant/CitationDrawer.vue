<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
import type { AssistantSourceDTO, TemporarySourceDTO } from './assistantContracts'

const props = defineProps<{
  open: boolean
  source: AssistantSourceDTO | TemporarySourceDTO | null
  loading: boolean
  error: string
  citationNumber: number | null
}>()

const emit = defineEmits<{ close: []; retry: [] }>()
const root = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const previousFocus = ref<HTMLElement | null>(null)

watch(
  () => props.open,
  async (open, wasOpen) => {
    if (open) {
      previousFocus.value = document.activeElement as HTMLElement | null
      await nextTick()
      closeButton.value?.focus()
    } else if (wasOpen) {
      await nextTick()
      previousFocus.value?.focus()
      previousFocus.value = null
    }
  },
)

function onRetry() {
  closeButton.value?.focus()
  emit('retry')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab' || !root.value) return
  const focusable = Array.from(
    root.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden)
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="citation-drawer__overlay" @click.self="emit('close')">
      <aside
        ref="root"
        class="citation-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="citation-drawer-title"
        :aria-busy="loading"
        @keydown="onKeydown"
      >
        <header>
          <div>
            <p v-if="citationNumber !== null">引用 [{{ citationNumber }}]</p>
            <h2 id="citation-drawer-title">来源详情</h2>
          </div>
          <button ref="closeButton" type="button" aria-label="关闭来源详情" title="关闭来源详情" @click="emit('close')">
            <UiIcon name="x" />
          </button>
        </header>

        <div class="citation-drawer__body">
          <div v-if="loading" class="citation-drawer__state" role="status">
            <span class="citation-drawer__spinner" aria-hidden="true" />
            <strong>正在读取来源</strong>
            <p>仅加载本条回答实际引用的片段。</p>
          </div>

          <div v-else-if="error" class="citation-drawer__state citation-drawer__state--error" role="alert">
            <UiIcon name="wifi-off" :size="24" />
            <strong>来源暂时无法读取</strong>
            <p>{{ error }}</p>
            <UiButton variant="secondary" @click="onRetry">重试</UiButton>
          </div>

          <template v-else-if="source">
            <section class="citation-drawer__summary">
              <div class="citation-drawer__tags">
                <span>{{ source.sourceClass === 'ai_derived' ? 'AI 派生' : '原始来源' }}</span>
                <span v-if="source.availability === 'unavailable'">来源已删除</span>
              </div>
              <h3>{{ source.title }}</h3>
              <p v-if="source.sourceClass === 'ai_derived'" class="citation-drawer__warning">
                <UiIcon name="triangle-alert" :size="16" />AI 派生，未人工验证
              </p>
              <p v-if="source.titleChanged && source.currentTitle" class="citation-drawer__changed">
                当前笔记标题已变更为“{{ source.currentTitle }}”
              </p>
            </section>

            <section v-if="source.availability === 'unavailable'" class="citation-drawer__unavailable" role="status">
              <UiIcon name="trash-2" :size="22" />
              <div><strong>来源已删除</strong><p>历史回答保持不变，但原笔记和引用摘录已不可用。</p></div>
            </section>

            <section v-else aria-labelledby="citation-excerpt-heading">
              <h3 id="citation-excerpt-heading">本轮使用的摘录</h3>
              <blockquote>{{ source.excerpt || '本轮没有可显示的摘录。' }}</blockquote>
            </section>

            <dl class="citation-drawer__meta">
              <div><dt>来源类型</dt><dd>{{ source.sourceKind }}</dd></div>
              <div><dt>模型侧来源序号</dt><dd>S{{ source.sourceOrdinal }}</dd></div>
              <div v-if="source.locator?.startByte !== null && source.locator?.startByte !== undefined">
                <dt>原文位置</dt><dd>{{ source.locator.startByte }}–{{ source.locator.endByte ?? '末尾' }} byte</dd>
              </div>
            </dl>
          </template>
        </div>

        <footer v-if="source?.locator?.href">
          <a :href="source.locator.href">
            <UiIcon name="book-open" :size="17" />打开原笔记
          </a>
        </footer>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.citation-drawer__overlay {
  position: fixed;
  z-index: var(--layer-overlay);
  inset: 0;
  background: var(--scrim);
}

.citation-drawer {
  position: absolute;
  top: 0;
  right: 0;
  display: grid;
  width: min(480px, 100vw);
  height: 100dvh;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border-left: 1px solid var(--border-strong);
  background: var(--bg-surface);
  box-shadow: var(--shadow-overlay);
}

.citation-drawer > header,
.citation-drawer > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.citation-drawer > header p,
.citation-drawer > header h2 { margin: 0; }
.citation-drawer > header p { color: var(--accent); font-size: 12px; font-weight: 750; }
.citation-drawer > header h2 { font-size: 20px; }

.citation-drawer > header button {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.citation-drawer > header button:hover { border-color: var(--border-subtle); background: var(--bg-code); color: var(--text-primary); }

.citation-drawer__body {
  display: grid;
  align-content: start;
  gap: var(--space-6);
  overflow-y: auto;
  padding: var(--space-5);
  scrollbar-color: var(--border-strong) transparent;
}

.citation-drawer__body section > h3 { margin: 0 0 var(--space-2); font-size: 14px; }
.citation-drawer__summary h3 { margin: var(--space-3) 0 0; font-size: 20px; line-height: 1.4; text-wrap: balance; overflow-wrap: anywhere; }
.citation-drawer__tags { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.citation-drawer__tags span { padding: 3px 7px; border: 1px solid var(--border-subtle); border-radius: 999px; color: var(--text-secondary); font-size: 11px; }
.citation-drawer__warning,
.citation-drawer__changed { display: flex; align-items: flex-start; gap: var(--space-2); margin: var(--space-3) 0 0; color: var(--warning); font-size: 12px; }
.citation-drawer__changed { color: var(--text-secondary); }

.citation-drawer blockquote {
  margin: 0;
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-primary);
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.citation-drawer__meta { display: grid; gap: var(--space-2); margin: 0; }
.citation-drawer__meta > div { display: flex; justify-content: space-between; gap: var(--space-4); padding-bottom: var(--space-2); border-bottom: 1px solid var(--border-subtle); }
.citation-drawer__meta dt { color: var(--text-muted); }
.citation-drawer__meta dd { margin: 0; color: var(--text-primary); font-family: var(--font-mono); font-size: 12px; text-align: right; }

.citation-drawer__unavailable {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--danger) 48%, var(--border-subtle));
  border-radius: var(--radius-control);
  color: var(--danger);
}
.citation-drawer__unavailable strong,
.citation-drawer__unavailable p { margin: 0; }
.citation-drawer__unavailable p { margin-top: var(--space-1); color: var(--text-secondary); }

.citation-drawer__state { display: grid; min-height: 280px; place-items: center; align-content: center; gap: var(--space-2); color: var(--text-muted); text-align: center; }
.citation-drawer__state strong,
.citation-drawer__state p { margin: 0; }
.citation-drawer__state--error { color: var(--danger); }
.citation-drawer__state--error p { color: var(--text-secondary); }
.citation-drawer__spinner { width: 28px; height: 28px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: citation-spin .8s linear infinite; }

.citation-drawer > footer { justify-content: flex-end; border-top: 1px solid var(--border-subtle); border-bottom: 0; }
.citation-drawer > footer a { display: inline-flex; min-height: 44px; align-items: center; gap: var(--space-2); padding: 0 var(--space-4); border-radius: var(--radius-control); background: var(--accent); color: var(--accent-contrast); font-weight: 700; text-decoration: none; }

@keyframes citation-spin { to { transform: rotate(360deg); } }

@media (max-width: 599px) {
  .citation-drawer { width: 100vw; border-left: 0; }
  .citation-drawer__body { padding: var(--space-4); }
  .citation-drawer > footer a { width: 100%; justify-content: center; }
}
</style>

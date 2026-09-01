<script setup lang="ts">
import type { AssistantModelDTO, Reasoning } from './assistantContracts'

defineProps<{
  models: AssistantModelDTO[]
  modelId: string | null
  reasoning: Reasoning
  activeRun: boolean
  required: boolean
}>()

const emit = defineEmits<{
  model: [modelId: string | null]
  reasoning: [reasoning: Reasoning]
}>()

function onModelChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  emit('model', value || null)
}

function onReasoningChange(event: Event) {
  emit('reasoning', (event.target as HTMLSelectElement).value as Reasoning)
}
</script>

<template>
  <div class="model-reasoning-bar">
    <label>
      <span>模型</span>
      <select :value="modelId ?? ''" :aria-invalid="required && !modelId" @change="onModelChange">
        <option value="">{{ models.length ? '选择模型' : '没有可用模型' }}</option>
        <option v-for="model in models" :key="model.id" :value="model.id">
          {{ model.displayName }} · {{ model.provider.displayName }}
        </option>
      </select>
    </label>

    <label>
      <span>思考档位</span>
      <select :value="reasoning" :disabled="!modelId" @change="onReasoningChange">
        <template v-for="model in models" :key="model.id">
          <option
            v-for="option in model.id === modelId ? model.reasoningOptions : []"
            :key="`${model.id}-${option.reasoning}`"
            :value="option.reasoning"
          >
            {{ option.displayName }}
          </option>
        </template>
      </select>
    </label>

    <p v-if="activeRun" class="model-reasoning-bar__hint" role="status">本次切换将在下一条消息生效</p>
    <p v-else-if="required && models.length" class="model-reasoning-bar__hint model-reasoning-bar__hint--required">首次使用或最近模型不可用，请明确选择模型</p>
  </div>
</template>

<style scoped>
.model-reasoning-bar {
  display: flex;
  min-width: 0;
  align-items: end;
  gap: var(--space-2);
}

.model-reasoning-bar label {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.model-reasoning-bar label:first-child { flex: 1 1 260px; }
.model-reasoning-bar label:nth-child(2) { flex: 0 1 180px; }

.model-reasoning-bar label > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
}

.model-reasoning-bar select {
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--bg-code);
  color: var(--text-primary);
  cursor: pointer;
}

.model-reasoning-bar select[aria-invalid='true'] { border-color: var(--warning); }
.model-reasoning-bar select:disabled { cursor: not-allowed; opacity: .55; }

.model-reasoning-bar__hint {
  flex: 0 0 auto;
  margin: 0 0 var(--space-2);
  color: var(--text-muted);
  font-size: 11px;
}

.model-reasoning-bar__hint--required { color: var(--warning); }

@media (max-width: 720px) {
  .model-reasoning-bar { flex-wrap: wrap; }
  .model-reasoning-bar label { flex: 1 1 160px !important; }
  .model-reasoning-bar__hint { flex-basis: 100%; margin-bottom: 0; }
}

@media (max-width: 480px) {
  .model-reasoning-bar label { flex-basis: 100% !important; }
  .model-reasoning-bar label > span { font-size: 12px; }
  .model-reasoning-bar select { min-height: 44px; font-size: 16px; }
}
</style>

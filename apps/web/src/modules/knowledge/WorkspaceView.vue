<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue'
import UiIcon from '../../components/ui/UiIcon.vue'
</script>

<template>
  <section class="workspace" aria-labelledby="workspace-heading">
    <header class="workspace__header">
      <div>
        <p class="workspace__eyebrow">知识与记录</p>
        <h2 id="workspace-heading">工作台</h2>
      </div>
      <UiButton disabled>
        <UiIcon name="plus" />
        快速记录
      </UiButton>
    </header>

    <div class="workspace__empty">
      <UiIcon name="inbox" :size="24" />
      <h3>原始事实层尚未初始化</h3>
      <p>M1 接入认证与不可变记录后，这里会显示真实资料。</p>
    </div>
  </section>
</template>

<style scoped>
.workspace {
  width: min(100%, var(--content-max));
  min-height: 100dvh;
  padding: var(--space-6);
}

.workspace__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
}

.workspace__eyebrow {
  margin: 0 0 var(--space-1);
  color: var(--text-muted);
  font-size: 12px;
}

h2,
h3,
p {
  margin-top: 0;
}

h2 {
  margin-bottom: 0;
  font-size: 20px;
  line-height: 1.3;
}

.workspace__empty {
  display: grid;
  min-height: 320px;
  place-content: center;
  justify-items: center;
  padding: var(--space-8);
  color: var(--text-secondary);
  text-align: center;
}

.workspace__empty h3 {
  margin: var(--space-4) 0 var(--space-2);
  color: var(--text-primary);
  font-size: 16px;
}

.workspace__empty p {
  max-width: 46ch;
  color: var(--text-muted);
}

@media (max-width: 599px) {
  .workspace {
    min-height: auto;
    padding: var(--space-4);
  }

  .workspace__header {
    align-items: flex-start;
  }
}
</style>

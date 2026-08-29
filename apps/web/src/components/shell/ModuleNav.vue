<template>
  <aside class="module-nav" aria-label="工作台导航">
    <header class="module-nav__header">
      <p class="module-nav__eyebrow">知识与记录</p>
      <h1>工作台</h1>
    </header>

    <section aria-labelledby="fixed-views-heading">
      <h2 id="fixed-views-heading">固定视图</h2>
      <div class="module-nav__empty">
        应用骨架已就绪，记录视图将在原始事实层接入后显示。
      </div>
    </section>
  </aside>
</template>

<style scoped>
.module-nav {
  width: var(--module-nav-width);
  min-height: 100dvh;
  padding: var(--space-5) var(--space-4);
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-nav);
}

.module-nav__header {
  margin-bottom: var(--space-8);
}

.module-nav__eyebrow,
h2 {
  margin: 0 0 var(--space-2);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

h1 {
  margin: 0;
  font-size: 20px;
  line-height: 1.3;
}

h2 {
  text-transform: none;
}

.module-nav__empty {
  padding: var(--space-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-card);
  color: var(--text-muted);
  font-size: 13px;
}

@media (max-width: 1279px) {
  .module-nav {
    display: none;
  }
}
</style>

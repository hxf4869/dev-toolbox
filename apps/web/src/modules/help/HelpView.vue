<script setup lang="ts">
import UiIcon from '../../components/ui/UiIcon.vue'

const version = import.meta.env.VITE_APP_VERSION || 'v3.0.0-rc.3'
</script>

<template>
  <article class="help-page" aria-labelledby="help-title">
    <header class="help-hero">
      <p>HELP · {{ version }}</p>
      <h1 id="help-title">帮助与产品边界</h1>
      <span>理解原始事实、AI 候选、敏感外发与可恢复部署之间的边界。</span>
    </header>

    <section id="core-concepts" class="help-section" aria-labelledby="core-title">
      <header><UiIcon name="book-open" /><div><p>DATA MODEL</p><h2 id="core-title">核心概念</h2></div></header>
      <div class="concept-grid">
        <article><UiIcon name="lock-keyhole" /><h3>原始事实 · 不覆盖</h3><p>提交后的原始记录和原始附件没有覆盖接口。需要修正时追加补充记录，永久删除只能从回收站经明确确认执行。</p></article>
        <article><UiIcon name="sparkles" /><h3>AI 整理 · 候选版本</h3><p>AI 结果是可追溯的派生 Artifact。它可以过期、作废、重新生成或切换版本，但不会改写原文和附件。</p></article>
      </div>
    </section>

    <section id="capture-search" class="help-section" aria-labelledby="capture-title">
      <header><UiIcon name="search" /><div><p>CAPTURE & SEARCH</p><h2 id="capture-title">快速记录与搜索</h2></div></header>
      <div class="help-list">
        <p><strong>可见入口优先。</strong>进入“知识与记录”，可直接使用搜索框和“快速记录”按钮，无需记住快捷键。</p>
        <p><strong>当前快捷键。</strong><kbd>/</kbd> 聚焦搜索；<kbd>⌘/Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Enter</kbd> 打开快速记录；编辑器中 <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> 保存。</p>
        <p><strong>字面搜索。</strong>引号、路径、百分号和下划线都按普通字符处理；查询词只进入请求正文，不写入 URL 或浏览器持久化存储。</p>
      </div>
    </section>

    <section id="knowledge-assistant" class="help-section" aria-labelledby="assistant-title">
      <header><UiIcon name="sparkles" /><div><h2 id="assistant-title">知识助手与引用</h2></div></header>
      <div class="help-list">
        <p><strong>先配置再提问。</strong>在“设置 → Provider 与模型”中启用 Provider、配置 API Key，并启用至少一个聊天模型，随后即可开始一般对话。需要基于笔记回答时，在同一页配置“知识库 Embedding”并等待索引就绪。Embedding 未配置、重建中或存在失败片段时仍可继续一般聊天，页面会明确提示“知识库当前不可用”，而不是“知识库没有相关内容”。</p>
        <p><strong>核对外发范围。</strong>启用知识库 Embedding 前请核对接收方与全局敏感策略；确认启用后，新增和更新的合格笔记会自动发送给该 Embedding Provider。提问、实际进入上下文的历史消息与检索片段会按当前策略发送给聊天 Provider。</p>
        <p><strong>回答要回到原文。</strong>从“新对话”开始，确认模型与思考档位后发问；点击行内引用可打开来源抽屉，并从抽屉打开对应笔记核对原文。AI 派生来源会标记“未人工验证”，不要把无引用的一般补充当作笔记事实。</p>
        <p><strong>临时对话不保存。</strong>临时会话只存在于当前标签页内存，刷新、关闭标签页或离开页面即销毁，应用不保存该会话；消息和检索片段仍会发送给你选择的 Provider，并受其数据保留政策约束。</p>
      </div>
    </section>

    <section id="local-tools" class="help-section" aria-labelledby="local-tools-title">
      <header><UiIcon name="wrench" /><div><p>V2.0 TOOLBOX</p><h2 id="local-tools-title">本地工具与 JSON AI</h2></div></header>
      <div class="help-list">
        <p><strong>默认只在浏览器本地处理。</strong>Base64、URL、JWT、JSON、YAML、时间与 Cron、摘要与校验和、正则测试的确定性操作不把正文发送到业务 API，也不写入浏览器持久化存储。</p>
        <p><strong>编辑器按设备加载。</strong>桌面使用 Monaco，手机使用 CodeMirror 6；离开页面后编辑器、Worker 和待处理任务会释放，刷新或关闭页面无法恢复输入与结果。</p>
        <p><strong>JSON AI 必须显式确认。</strong>只有主动切换到 AI、选择 Provider/模型、查看接收方、目标语言、发送模式和字节数，并在确认对话框提交后，JSON 才会发送到窄类型生成接口。结果只是普通文本，不会执行、编译或保存。</p>
        <p><strong>结构模式不发送值。</strong>它只发送字段名、容器关系和原始类型；完整 JSON 模式会发送当前输入全文，并要求二次勾选确认。</p>
      </div>
    </section>

    <section id="copy-policy" class="help-section" aria-labelledby="copy-title">
      <header><UiIcon name="copy" /><div><p>COPY POLICY</p><h2 id="copy-title">逐块复制与安全提示</h2></div></header>
      <div class="policy-rows">
        <article><strong>普通文本</strong><p>可复制整段原文；敏感记录先显示遮挡摘要，需主动显示后才能复制。</p></article>
        <article><strong>Markdown 代码块</strong><p>逐块复制，避免把说明文字混入命令。复制不表示命令已经核验，也不会触发执行。</p></article>
        <article><strong>AI warning / code</strong><p>保留来源链接和警告状态；未知新版区块只显示安全占位，不渲染模型生成的 HTML。</p></article>
      </div>
    </section>

    <section id="sensitive-provider" class="help-section" aria-labelledby="sensitive-title">
      <header><UiIcon name="shield-alert" /><div><p>PRIVACY</p><h2 id="sensitive-title">敏感内容与 Provider</h2></div></header>
      <div class="sensitive-grid">
        <article class="policy-block"><strong>阻止外发</strong><p>敏感或待确认内容不产生 Provider 网络请求。</p></article>
        <article class="policy-redact"><strong>规则脱敏</strong><p>先把可识别敏感片段替换为固定占位符，再发送文本副本；敏感图片不能用该策略外发。</p></article>
        <article class="policy-allow"><strong>允许原文</strong><p>只在所有者明确确认后使用。Provider Key 加密保存且永不回显。</p></article>
      </div>
    </section>

    <section id="tasks" class="help-section" aria-labelledby="task-title">
      <header><UiIcon name="clock" /><div><p>CONTROLLED AI</p><h2 id="task-title">任务取消与重试</h2></div></header>
      <div class="help-list">
        <p>取消在 Provider 或受控领域工具边界生效；已完成模型请求但尚未提交的候选会被丢弃。</p>
        <p>用户重试会创建新的任务记录并关联旧历史。租约恢复最多一次，不会自动切换 Provider 或无限循环。</p>
        <p>内置工具只有读取当前上下文、受权附件、相关记录搜索和提交候选 Artifact。</p>
      </div>
    </section>

    <section id="backup-restore" class="help-section" aria-labelledby="backup-title">
      <header><UiIcon name="download" /><div><p>RECOVERY</p><h2 id="backup-title">附件备份与恢复</h2></div></header>
      <div class="help-list">
        <p>成功备份必须同时包含 PostgreSQL custom dump、原始附件和非敏感配置清单，并形成可读取的 restic snapshot。</p>
        <p>空机恢复逐一验证数据库引用附件的存在性、大小和 SHA-256。任一不一致都会阻止 worker 与 gateway 启动并保留现场。</p>
        <p>完整性检查默认只报告孤儿文件，不自动删除。应用主密钥和 restic 密码需要另行离线保存。</p>
      </div>
    </section>

    <section id="boundaries" class="help-section help-boundaries" aria-labelledby="boundary-title">
      <header><UiIcon name="shield-check" /><div><p>PRODUCT BOUNDARIES</p><h2 id="boundary-title">当前明确边界</h2></div></header>
      <ul>
        <li>不执行 Shell、SSH、SQL、任意 HTTP、任意文件系统或其他高权限工具。</li>
        <li>不自动联网核验外部数据真实性；AI 候选必须由用户判断。</li>
        <li>普通资料库搜索基于关键词、子串与模糊匹配，不提供向量语义搜索；知识助手在完成 Embedding 配置且索引就绪后，可在其检索范围内提供混合召回。</li>
        <li>知识录入与检索不做自动 OCR 或 PDF 正文解析；工具箱 OCR 由用户主动执行。</li>
        <li>不提供通用导入向导、插件市场或多用户协作。</li>
        <li>不提供在线 `.env` 编辑、Web 备份控制台或自动部署；运维脚本由宿主机所有者显式调用。</li>
        <li>机器翻译与云 OCR 只通过用户明确操作进入额度受控的阿里云路径；不提供翻译/OCR 历史、后台任务、Agent loop、代码执行或代码编译。</li>
      </ul>
    </section>
  </article>
</template>

<style scoped>
.help-page { width: min(100%, 1080px); min-height: 100dvh; padding: var(--space-8); }
.help-hero { padding-bottom: var(--space-6); border-bottom: 1px solid var(--border-subtle); }
.help-hero p, .help-hero h1, .help-hero span { margin: 0; }
.help-hero p, .help-section header p { color: var(--accent); font-family: var(--font-mono); font-size: 11px; letter-spacing: .06em; }
.help-hero h1 { margin-top: var(--space-2); font-size: clamp(28px, 4vw, 42px); line-height: 1.15; }
.help-hero span { display: block; margin-top: var(--space-2); color: var(--text-secondary); }
.help-section { scroll-margin-top: var(--space-4); margin-top: var(--space-6); padding: var(--space-5); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--bg-elevated); }
.help-section > header { display: flex; align-items: center; gap: var(--space-3); color: var(--accent); }
.help-section header p, .help-section h2 { margin: 0; }
.help-section h2 { color: var(--text-primary); font-size: 20px; }
.concept-grid, .sensitive-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); margin-top: var(--space-4); }
.concept-grid article, .sensitive-grid article, .policy-rows article { padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--bg-code); }
.concept-grid article > svg { color: var(--accent); }
.concept-grid h3, .concept-grid p, .sensitive-grid p, .policy-rows p { margin: 0; }
.concept-grid h3 { margin-top: var(--space-2); }
.concept-grid p, .sensitive-grid p, .policy-rows p, .help-list p, .help-boundaries li { color: var(--text-secondary); }
.concept-grid p, .sensitive-grid p, .policy-rows p { margin-top: var(--space-2); }
.help-list, .policy-rows { display: grid; gap: var(--space-3); margin-top: var(--space-4); }
.help-list p { margin: 0; padding-left: var(--space-3); border-left: 2px solid var(--border-strong); }
kbd { padding: 2px 6px; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--bg-code); color: var(--text-primary); font-family: var(--font-mono); font-size: 11px; }
.policy-rows article { display: grid; grid-template-columns: 180px minmax(0, 1fr); align-items: start; gap: var(--space-3); }
.policy-rows p { margin-top: 0; }
.sensitive-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.sensitive-grid article { border-left: 3px solid var(--danger); }
.sensitive-grid .policy-redact { border-left-color: var(--warning); }
.sensitive-grid .policy-allow { border-left-color: var(--accent); }
.help-boundaries { border-color: var(--border-strong); background: var(--bg-code); }
.help-boundaries ul { display: grid; gap: var(--space-2); margin: var(--space-4) 0 0; padding-left: var(--space-5); }
@media (max-width: 720px) { .help-page { padding: var(--space-4); } .concept-grid, .sensitive-grid { grid-template-columns: 1fr; } .policy-rows article { grid-template-columns: 1fr; } }
</style>

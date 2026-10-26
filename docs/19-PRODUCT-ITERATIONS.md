# 产品迭代交接记录

本文件是 2026-10-21 起本地托管迭代周期的唯一会话间交接记录：新会话从这里获取迭代目标、已完成事项的真实文件与验证结果、未验证边界和待处理事项。它不替代 `AGENTS.md` 的授权规则，也不修改任何历史正式验收结论与版本号；历史里程碑状态仍以 `docs/00`–`docs/16` 为准。

## 迭代背景（2026-10-21）

用户授权 AI Agent 全权进行产品与技术决策并由 Agent 会话实施；每轮可包含多个边界独立、owner 明确的子任务并行推进（不限于单模块），由本聊天的决策审计 Agent 独立验收后继续，无需每轮等待用户确认。DT-R00 为只读缺陷汇总（不改仓库）。同仓库存在用户本人未提交改动与其他并行项目会话，各轮实施不得回退或覆盖。本轮起基线 HEAD：`0101814`（main）。

## DT-R01｜JSON 修复候选不得覆盖新编辑（已完成，未提交）

- 缺陷：`apps/web/src/modules/tools/json/JsonView.vue` 中「检查受限修复」为输入 A 异步生成候选后，用户改为 B 时 `applyRepair` 仍无条件覆盖输入；运行期间改输入后晚到结果仍展示为可应用；切页签/开始另一操作不清旧候选。
- 验收：修复候选只能应用于生成它的同一份原始输入（字符串精确比较，无 hash）；旧候选与晚到结果不得覆盖后续编辑、不得把不匹配 diff 当当前输入展示；保持显式「生成→看差异→主动应用」。
- 实际文件：
  - `apps/web/src/modules/tools/json/JsonView.vue`：新增 `repairSource` 源文本捕获；repair 结果处理移入 `proposeRepair` 后处理（仿 `generateSchema` 模式）；`applyRepair` 应用前校验源文本一致；`watch(input)` 输入偏离即失效、`execute()` 开头与 `watch(activeTab)` 清理、`clearAll` 补源文本清理；丢弃晚到候选时恢复 `mobilePane='input'`。
  - `apps/web/src/modules/tools/json/JsonView.repair.test.ts`（新增）：4 个真实组件事件用例（正常应用、生成后编辑失效、运行中编辑晚到结果丢弃、切页签/新操作清除）。
- 验证结果（均已实际运行）：
  - 实现前 `pnpm vitest run src/modules/tools/json/JsonView.repair.test.ts`：1 通过 / 3 失败（证明测试能抓到旧实现）。
  - 实现后同命令：4 通过；`pnpm vitest run src/modules/tools/json/JsonView.ai.test.ts`：4 通过（显式 AI 发送无回归）。
  - `apps/web` 下 `pnpm check` 通过；仓库根 `git diff --check` 干净。
- 未验证边界：未在真实浏览器（CodeMirror 自适应编辑器）手动交互，jsdom 中以编辑器 mock 覆盖；未运行全量测试套件与构建镜像（按本轮协议）。本轮未 commit/push/部署。

## DT-R02｜临时聊天恢复、JWT 状态与录入可靠性（已完成，未提交）

三个边界独立模块并行实施，各自单一 owner，主 Agent 只做集成验证与本文件写入。三者均先在旧实现上跑红测证明回归可捕获，再实现转绿。

### A｜临时聊天恢复（owner：`apps/web/src/modules/assistant/assistantStore.ts`）

- 缺陷 1：`temporaryHistoryBefore` 按单条过滤，failed/stopped 的 assistant 被丢弃而 user 保留，下一次临时请求携带孤立 user，后端 temporary 校验（temporary.go:82–99 要求 user/assistant 交替且偶数条）使该会话从此 422。已改为构造完整成功的 user+assistant 对，失败/停止整对排除，保留真实顺序与 `slice(-32)` 上限；user 原文不改写，`stripCitationTokens` 只作用于 assistant 历史。
- 缺陷 2：临时生成中 `selectConversation`/`startNewConversation` 不 abort 临时请求，共享 `sending` 卡死持久会话且停止按钮不可达。新增 `cancelTemporaryRunOnLeave`：离开临时会话时标记进行中回答 stopped、abort 旧 controller（按 docs/16 §12 传播取消）、恢复 `sending`；重复点击当前临时导航不触发取消。竞态按 controller 身份守卫：旧流 `finally` 仅在 `temporaryController === controller` 时清理，晚到 envelope 被循环顶部 `signal.aborted` 检查丢弃，已取消流的异常只做幂等 stopped 标记不写 `actionError`。临时发送错误改用 `actionMessageFor` 稳定码映射。临时路由卸载销毁行为保留；摘要预算/滚动摘要未动。
- 实际文件：`assistantStore.ts`（+68/−26）；新增 `assistantStore.temporary.test.ts`（7 用例，真实 store action + AssistantApi/SSE mock）。
- 验证（实际运行，`apps/web` 下）：红 `pnpm exec vitest run src/modules/assistant/assistantStore.temporary.test.ts` 6 失败/1 通过（通过项为旧实现本就不取消的守卫用例）→ 绿 7/7；模块回归 `pnpm exec vitest run src/modules/assistant/` 11 文件 46/46 通过；`pnpm exec vue-tsc --noEmit -p tsconfig.app.json --pretty false` 无错误。

#### 验收返工（决策审计 Agent 独立验收发现 P1，已修复）

- 验收缺陷：初版候选存在退化——`resetTemporaryConversation`（`AssistantView.vue` 的 `onBeforeUnmount` 经 `disposeView` 的实际路由卸载入口）abort 后置空 `temporaryController`，但未释放该临时运行占有的 `sending`；旧流 finally 的 controller 身份守卫随后必然失败跳过清理，路由离开再返回后 `sending` 永久为 true，所有模式 `canSend` 锁死。
- 修复：`resetTemporaryConversation` 开头改为复用 `cancelTemporaryRunOnLeave`（`temporaryMode`/`temporaryController` 守卫保证无进行中临时流时不误清持久发送的状态），隐私销毁语义与 controller 身份守卫、晚到隔离机制均未改动；调用点核实仅 `disposeView`/store 导出/既有测试，重复点击「临时对话」导航不经过 reset，已验收行为不变。
- 新增真实 store action 回归：临时流进行中 → `disposeView()` → 断言 signal aborted 与临时内存清空 → 旧流结束（含晚到收尾）→ `initialize()`/进入新会话 → `sending === false` 且草稿可发送；旧流晚收尾不影响随后新流。修复前红（失败断言 `sending` 为 true），修复后 `pnpm exec vitest run src/modules/assistant/assistantStore.temporary.test.ts src/modules/assistant/assistantStore.test.ts` 2 文件 16/16 通过（temporary 8 = 既有 7 + 新 1）。
- 返工后集成重跑：仓库根 `pnpm --filter @dev-toolbox/web check` 通过（exit 0）；`git diff --check` 干净。B/C、R01 输入未变未重跑。

### B｜JWT 校验与当前输入一致（owner：`apps/web/src/modules/tools/jwt/JwtToolView.vue`、`JwtToolView.test.ts`）

- 缺陷：验证 Token A 通过后改为 B 不重跑，旧 Header/Payload、「签名通过」与 Claims 仍当当前结果展示；在途隔离不覆盖改输入场景。
- 修复：三组局部 `watch`（沿用现有 `latestRunId`，未建抽象）——Token 变化使解码与全部校验失效；密钥/验签方式/选中 JWKS key 变化使签名结果失效但保留 decoded（JWKS 手选入口不消失）；iss/aud/sub/时钟容差变化使 Claims 失效。`latestRunId += 1` 同时作废在途 run 晚到写回；watcher 只失效不触发请求，保持显式执行。「仅检查 Claims」因 Token 变化后 `decoded=null` 不可能再检查旧 Token。
- 验证（实际运行，`apps/web` 下）：红 `pnpm exec vitest run src/modules/tools/jwt/JwtToolView.test.ts` 6 失败/3 通过 → 绿 9/9（含保留的既有并发隔离与清空卸载用例）。已知取舍：期望参数变化也会作废在途签名结果（需重点一次 run）。

### C｜录入边界与安全重试（owner：`apps/web/src/modules/knowledge/QuickCaptureDrawer.vue`、`SupplementDrawer.vue`）

- 缺陷 1：前端按字符计数（`body.length`/`maxlength`），后端按 UTF-8 1 MiB 字节，约 35 万中文字符 UI 未超限却被后端拒绝。两抽屉改按 `TextEncoder` 实际字节计数（局部 helper，无新依赖），常显「当前字节 / 1,048,576」，超限禁用提交（含 Cmd+Enter，经 `save()` 的 `canSave` 守卫）并以中文 alert 明示，移除按 code unit 静默截断的 `maxlength`，输入永不静默截断；未动后端校验、未加公共配置。
- 缺陷 2：SupplementDrawer 网络失败裸显 "Failed to fetch"。改按 QuickCapture 既有模式：`ApiError` 显示后端消息+requestId，网络层失败显示「网络连接中断，内容已保留；点击重试安全，不会产生重复记录。」；幂等键在输入未变时复用（测试以递增 uuid stub 验证两次请求同 key）。
- 缺陷 3：QuickCapture 敏感+自定义标题时明示「自定义标题会以原文出现在列表与搜索结果中」，无自定义标题保留原安全标题文案；未改标题内容与后端遮挡策略。
- 实际文件：两个抽屉组件 + 新增 `QuickCaptureDrawer.boundary.test.ts`、`SupplementDrawer.boundary.test.ts`。
- 验证（实际运行，`apps/web` 下）：红 `pnpm exec vitest run src/modules/knowledge/{QuickCaptureDrawer.boundary,SupplementDrawer.boundary,QuickCaptureDrawer}.test.ts` 4 失败 → 绿 6/6（含现有 QuickCaptureDrawer.test.ts 2 条回归）；`pnpm exec vue-tsc --noEmit -p tsconfig.app.json` exit 0。

### 集成验证与未验证边界（主 Agent）

- 三者结束后统一运行：仓库根 `pnpm --filter @dev-toolbox/web check` 通过（exit 0）；`git diff --check` 干净。改动范围经 `git status` 复核仅含三个 owner 文件集与各自新测试，R01 保留文件（JsonView.vue 等）与用户本人改动（AGENTS.md、deploy/nginx、.playwright-mcp/）未被触碰。
- 未验证边界：全部回归均在 jsdom + mock（AssistantApi/SSE、verifyJwtSignature、fetch）下驱动真实交互；未做真实浏览器手动验证、真实 Provider/JWKS 端点/网络层验证、全量测试套件与构建镜像。本轮未 commit/push/部署，未访问付费资源。
- 审查结论：临时会话路由卸载即销毁的行为本轮保留，不认定为已证实缺陷。

## DT-R03｜工具结果一致性、代码块操作与本地浏览器验证（已完成，未提交）

三个边界独立模块并行实施（1 主 + 3 frontend-builder 子智能体，主 Agent 集成、docs/19 与浏览器服务），各自先红测再转绿。

### A｜URL 页签结果隔离（owner：`apps/web/src/modules/tools/url/UrlToolView.vue`）

- 缺陷：transform（编解码）与 inspect（解析/重新构建）共用同一份 result 与错误状态：解析过 URL → 切编解码执行编码 → 切回解析时，「重新构建结果」与复制按钮实际显示编码文本。
- 修复：采用「两个模式各自保留局部结果」——拆分 `transformResult`/`rebuildResult`，`copyResult` 按当前模式取自己的结果；新增 `switchMode` 在切页签时清除 `errorMessage`/`liveMessage`（错误归属）；`inspectUrl` 重新解析时只失效 `rebuildResult`（不再反向清编解码结果）；`clearAll` 清两份。输入、Query 行/重复项顺序、显式执行、复制反馈、不自动打开、不联网均未改动；docs/12 §6.3 合同文本未动。
- 实际文件：`UrlToolView.vue`（+21/−13）；新增 `UrlToolView.mode-isolation.test.ts`（3 用例，真实 DOM 事件，剪贴板 stub 沿用既有模式）。
- 验证（实际运行，apps/web 下）：红 `pnpm exec vitest run src/modules/tools/url/UrlToolView.mode-isolation.test.ts` 2 失败/1 通过（失败即缺陷断言：切回解析后重建结果为编码文本、transform 错误在 inspect 模式残留）→ 绿 url 目录 2 文件 9 测试（含既有「不 fetch/不 open/不持久化」6 条）；`pnpm exec vue-tsc --noEmit -p tsconfig.app.json` 无错误。

### B｜时间切时区失效（owner：`apps/web/src/modules/tools/time/TimeToolView.vue`）

- 缺陷：选择新 IANA 时区只 `refreshClock`，已有转换/计算/Cron/自然语言结果仍含旧时区，而页面声明所有结果显示当前时区。
- 修复：失效触发点在 combobox commit 而非 v-model watch（草稿击键与提交相同值不触发）；对比 `resultsTimeZone` 仅实际变化时作废全部时区相关结果与待决 DST 状态（含 difference 的 from/to 已选 earlier/later），显示「已失效，请重新执行」提示（`role=status`），不自动执行；新增 `zoneGeneration` 计数器做在途隔离（转换/日期计算/时间差/自然语言/时钟在 await 前捕获、返回后比对，晚到即丢弃）；工作日计算与时区无关，结果保留并有守卫测试。未改 `time.ts`/`cron.ts`、Cron 方言、自然语言语法。
- 实际文件：`TimeToolView.vue`（+~60/−2）；新增 `TimeToolView.zone.test.ts`（6 用例）。
- 验证（实际运行，apps/web 下）：红 `pnpm exec vitest run src/modules/tools/time/TimeToolView.zone.test.ts` 4 失败/1 通过（Cron 残留、两处 DST 待决残留、在途晚到写回旧区结果）→ 绿 time 目录 4 文件 28 测试；vue-tsc 无错误。

#### 集成返工（主 Agent 审查发现并修复）

- 审查缺陷：子智能体初版 `handleTimeZoneCommit` 首行 `void refreshClock()` 在同步段捕获旧 `zoneGeneration`，随后 `zoneGeneration += 1` 使这次**新时区**时钟刷新也被在途守卫丢弃，页面时钟残留旧时区快照（仅靠 1 秒 interval 兜底），与「所有结果显示当前时区」矛盾，且原有测试未覆盖。
- 修复：把失效逻辑收敛进 `if (timeZone.value !== resultsTimeZone)` 分支，`void refreshClock()` 移到代数推进之后统一执行（未变化时仍只刷新时钟，行为不变）。
- 新增回归：换区后时钟立即显示新时区（断言页面含 `[Asia/Tokyo]` 且不含 `[America/New_York]`）——修复前红，修复后 `pnpm exec vitest run src/modules/tools/time/` 4 文件 29 测试全部通过。

### C｜原始 Markdown 代码块逐块换行（owner：`apps/web/src/modules/knowledge/SafeMarkdown.vue`）

- 缺陷：fenced code block 只有复制按钮与固定 `white-space: pre`，缺产品契约要求的逐块自动换行切换。
- 修复：每块头部新增「自动换行」按钮（`data-wrap-index` + `aria-pressed`，样式仅用现有 token），`wrappedIndices` 按块独立记录，开启后该块 `pre` 加 `is-wrapped`（`pre-wrap + overflow-wrap: anywhere`），默认横向滚动保留；参照 AssistantMarkdown 的焦点恢复思路：v-html 因状态变化重建 DOM 后 `nextTick` 恢复焦点，1600ms 复制反馈结束的清理先判断按钮是否仍持有焦点再恢复，不抢占用户已移动的焦点；复制仍取 `token.content` 精确原文（换行切换只改 CSS 类，不参与复制路径）；复制成功/失败互斥状态与统一焦点恢复补齐。markdown-it `html=false`、origin 标签 escapeHtml、props 合同、RawDocument 纯文本展示均未改动；未引入统一解析器/公共框架。
- 实际文件：`SafeMarkdown.vue`（+~60/−13）；`SafeMarkdown.test.ts` 既有文件追加 2 用例。
- 验证（实际运行，apps/web 下）：红 `pnpm exec vitest run src/modules/knowledge/SafeMarkdown.test.ts` 2 失败/3 通过（旧实现无换行按钮）→ 绿 5/5；消费方回归 `pnpm exec vitest run src/modules/knowledge/RawDocument.test.ts src/modules/ai` 6 文件 17 测试通过；vue-tsc exit 0。

### 集成验证与未验证边界（主 Agent）

- 三者结束后统一运行：仓库根 `pnpm --filter @dev-toolbox/web check` 通过（决策审计 Agent 已独立复跑确认真实 exit 0）；`git diff --check` 干净。`git status` 复核本轮改动仅含三个 owner 文件集与各自新测试；R01/R02 候选（JSON/JWT/assistantStore/两抽屉及测试）与用户本人改动（AGENTS.md、deploy/nginx、.playwright-mcp/）未被触碰。
- 子智能体交付时的验证边界：全部回归为 jsdom + stub（剪贴板、真实指针/焦点时序）；真实浏览器交互、全量测试套件与构建镜像未由实施方运行——真实浏览器验收由决策审计 Agent 完成，见下节。本轮未 commit/push/部署，未访问付费资源。

### 本机合成浏览器验证服务（会话期临时，不入仓库、非真实后端验收）

- 形态：Vite 8.2.2 programmatic `createServer` + 本项目 `apps/web/vite.config.ts`，服务真实前端源码与真实 Monaco/CodeMirror/组件，不 mock 工具实现；仅注入一个 `configureServer` 中间件拦截 `/api/v1/`：`GET /auth/session` 返回明确合成的 authenticated DTO（fixture-owner/fixture-session/fixture-csrf-token），其余 API 一律 501 固定拒绝，不转发 8080，不读取任何生产 Secret/真实数据；无新依赖（fixture 经临时目录 `node_modules/vue` 符号链接复用仓库依赖）。
- 入口与标识：`http://127.0.0.1:18580`（首选端口即空闲，未使用 5199）；脚本 `/tmp/devtoolbox-dt-r03-browser/server.mjs`；SafeMarkdown 独立验收页 `http://127.0.0.1:18580/@fs/private/tmp/devtoolbox-dt-r03-browser/safemarkdown-fixture/index.html`（渲染真实 SFC + 真实 markdown-it，含两个长行 fence 与 HTML 注入转义样例；验收反馈后补充页面内深浅主题切换控件——仅设 `documentElement.dataset.theme` 复用产品 token 机制，不写 localStorage、不改产品主题实现）；进程 PID 14536、后台任务 `exec_59d32bd1-b2a3-42ee-a95a-2fce24215208`，退出 `kill 14536`。已 curl 验证应用 200、合成 session 200、其他 API 501、fixture 与真实 SFC 模块 200；HMR 实时反映本轮全部改动。
- 合成登录/API 状态不构成真实后端验收。

### 决策审计 Agent 独立浏览器验收（隔离 IAB 真实前端，2026-10-21）

- R03 验收通过：
  - URL 工具：两模式往返、Unicode/重复 Query 重建与真实复制，结果归属正确。
  - 时间工具：Asia/Shanghai → America/New_York 提交后旧结果立即清空并提示重跑，新时钟立即换区；重跑得到 `2026-10-20T20:00:00-04:00`，正确。
  - URL/Time/SafeMarkdown 在 390/1024/1440/1920/3840 五种目标宽度均无横向溢出；实际切换深浅主题检查了 URL/Time。
  - SafeMarkdown：第一块折行独立于第二块；复制内容逐字等于原 code textContent（含末尾换行）；v-html 重建与 1600ms 复制反馈结束后焦点仍在当前按钮；HTML 仍转义，无 img/script 执行。
- 验收发现并同轮局部返工：复制/换行按钮实测 32px，低于产品最小 40×40 CSS px 命中区。已将 `SafeMarkdown.vue` 中 `.safe-code-block button` 单条规则改为 `min-height: 40px; min-width: 40px`（纯 CSS 修改，未扩大样式范围，按验收指示未重跑逻辑测试）。
- 返工复验通过（决策审计 Agent 最终复验，隔离 IAB 真实前端）：真实 DOM 实测四个代码块按钮均 `height: 40px`、`width: 60/71px`（均不低于 40）；390/1024/1440/1920/3840 五种目标宽度在 light 主题下按钮均满足最小 40、页面宽等于视口、无横向溢出；dark 主题已实际切换核对；第一块折行仍与第二块隔离；真实 clipboard 复制内容精确等于原文（含末尾换行）。本次返工仅涉及 CSS 与仓库外 fixture，未重跑逻辑测试。
- 同轮补充的跨轮真实浏览器事实（此前仅有 jsdom 回归）：
  - R01：移动端 CodeMirror 与桌面 Monaco 的真实 Worker 修复、编辑后修复候选失效与正常应用，均在真实浏览器通过。
  - R02：以合成 HS256 token 与合成 key 经真实本地 jose 验证：改 Token 清旧解码/签名/Claims、改 key 只使签名失效、改 expectation 只使 Claims 失效；桌面与 390 窄屏正常。
- 仍属组件/mock 级、不得写成真实后端通过：R02 临时聊天 SSE 与录入抽屉（QuickCapture/Supplement）仅有组件与 mock 验收；真实 Provider、真实后端、全量测试套件与构建镜像均未验收。本轮未 commit/push/部署。
- DT-R03 会话至此收束：R03 全部实现、返工与复验通过，未提交 diff 保留；本会话结束即释放 `docs/19` 写入 owner，移交下一迭代会话（R04 已被要求先行等待本文件释放）；18580 合成预览服务保留给决策审计 Agent 继续使用（进程 PID 14536，退出 `kill 14536`，脚本与 fixture 见上节，均不入仓库）。

## DT-R04｜临时聊天长对话闭环：滚动摘要与上下文预算（已完成代码与定向测试，未提交）

三端并行实施（1 主 Go + Worker/Web 两个 owner 子智能体），先冻结三端最小契约再实施，各 owner 红测先行；决策审计 Agent 代码审计后主 Agent 一次修完 5 项返工。公共浏览器 DTO 零新增字段；内部 worker stream payload 新增 `summarySource: {prior, messages} | null`（镜像持久 claim 的既有形状）。

### 冻结契约与关键取舍

- 覆盖语义：非空 `temporarySummary` 完整覆盖“本请求发送的成功 messages 中除最近 16 条以外的整个最旧 prefix”（叠加旧摘要已覆盖部分）。Go 对每次请求计算 `summarySource = len(messages)>16 ? {prior, messages[:len-16]} : null`，用未裁剪的请求原文，独立于回答裁剪。
- Worker 维护为全有或全无：回答成功后、terminal 前，前一版摘要 + 完整 prefix（含脚手架）在独立预算 `floor(contextWindow*0.6)-1024` 内才执行同模型 reasoning-off 调用（60 秒有界、请求 lifecycle 取消联动、redact 策略作用于输入基准与消息）；放不下/失败/超时/取消/输出无效一律 `temporarySummary:null` 沿用旧摘要，不影响本轮回答成败。与持久 Run 的增量 prefix 适配不同，这是临时侧按本轮任务冻结的更强语义，未改持久实现。
- 预算统一在 Go 真实外发前执行（镜像持久 `buildClaimContext`/`trimSourcesToBudget`，仅临时路径窄实现）：先扣当前问题（放不下 → SSE 头之前 422 `ASSISTANT_CONTEXT_TOO_LARGE`），再按实际检索来源从高到低占位（低排名先裁、payload 重编号 S1..Sn，`sources.ready.providedSourceCount`、发送来源与 Worker CitationParser 长度同源于裁剪后集合），摘要放得下才进回答上下文，最后从新到旧加**完整成功问答对**（整对放不下即停，不产生脱离用户问题的孤立 assistant）。16k 模型、knowledge unavailable/零实际来源时 history 获得全部剩余预算（不为 8 个不存在的最大来源预留，定向用例锁定）；rewrite 无 source block，预算按自身真实 payload（仅预留 256 输出上限）单独裁剪。Worker 信任内部裁剪结果组包，与持久 worker 信任 claim 一致。
- Go 合同校验修正：尺寸类超限（>32 条、历史合计 >256KiB、summary 超项或超字节、content>32KiB）返回 422 `ASSISTANT_CONTEXT_TOO_LARGE`，形状错误（角色/交替/空内容/奇数条、summary 空条目）仍 `VALIDATION_FAILED`；DecodeJSON envelope 预留 JSON 转义膨胀后的真实可达上限（6×历史+内容、8×summary + slack）。
- 摘要字节口径三端统一为“四数组条目 UTF-8 字节合计 ≤64KiB”（Go `len(entry)` 求和、Worker `Buffer.byteLength(entry)` 求和）：不用 Go `json.Marshal` 长度（会把 `<>&` 转 `\u003c` 膨胀）也不用 `JSON.stringify` 长度，消除两端相反判定（定向用例：`<x>` 组合 63KiB 两端都接受、66KiB 都拒绝）。
- 历史单条 32KiB 上限取消（合计 256KiB 管总量）：成功 assistant 回答可超 32KiB（MaximumAssistantMessageBytes=4MiB），旧校验会使长回答后的临时会话永久 422；按 docs/16 §13.9 以总量为合同边界。
- Worker 摘要输出脱敏：净化时每条条目过输出 `StreamRedactor`（与回答文本同一规则、单实例顺序编号），脱敏后再验条数/字节上限；不在 JSON 文本层盲替换。合成 fixture（`Bearer SYNTHETICTOKEN12345678`、`192.168.77.77`）断言 public terminal 只出现 `<TOKEN_1>`/`<INTERNAL_IP_1>`。
- Web：删除 `temporaryHistoryBefore` 的 `slice(-32)` 静默截断；发送前（push 乐观 pair 前）全量计算成功对，>32 条本地拦截（稳定提示“如需保留内容请先复制，刷新页面后重新开始临时会话”——无重开入口故指引用复制+刷新，不新增清空按钮/弹窗，草稿保留到用户自行刷新；字节超限由服务端稳定码兜底）。水位推进按发送时实际进入 history 的本地消息 ID 序列：covered = 去掉最近 16 条的前缀，水位推进到 covered 末条 index+1（只前进、找不到不推进）；`streamState` 不再 seed 旧摘要，succeeded terminal 的非 null summary 即服务端实际携带。R02 的成功对构造、controller 身份守卫、离开取消、卸载释放 sending 全部保留并有回归。

### 实际文件

- Go（主）：`apps/api/internal/assistant/temporary.go`（校验重排 + envelope 上限 + `trimTemporaryRewriteContext`/`trimTemporaryAnswerContext`/`fillTemporaryContext`（整对保留）/`temporarySummarySourceFor` + `temporarySummaryBytes`/`temporarySummaryEntries` 口径助手 + 流程接线 + `streamTemporaryAnswer` 携带 summarySource）；新增 `temporary_test.go`；`sse_middleware_budget_test.go` 仅适配新签名调用。
- Worker（owner）：`apps/ai-worker/src/assistant/temporary.ts`（summarySource 类型与消费、`buildTemporarySummaryInput`/`sanitizeTemporarySummary`（输出脱敏+口径）/`maintainTemporarySummary`，terminal temporarySummary 由硬编码 null 改为维护结果）；新增 `temporary.test.ts`（本地 mock openai-completions SSE fixture，8 用例）；`runner.ts` 仅给 4 个既有符号加 `export`，无行为改动。
- Web（owner）：`apps/web/src/modules/assistant/assistantStore.ts`（`TemporaryHistoryPlan{messages,sourceIds}`、发送前拦截、`advanceTemporaryCoverage`、去 seed）；`assistantStore.temporary.test.ts` 新增 5 用例（原 8 用例未动）；`assistantSse.ts` 无需修改（reducer 本就仅在 succeeded+非 null 时写 summary）。

### 验证（实际运行，保留真实退出码）

- Go：红测（临时还原旧 `temporary.go` 跑 handler 边界用例）exit 1——3 个稳定码子测试在旧实现返回 `VALIDATION_FAILED`（超 32 条、content>32KiB、历史合计>256KiB）；恢复后定向用例 exit 0，全包 `go test ./internal/assistant/ -count=1` exit 0（以全包为准；期间修正两处测试构造：summary 体积需真实 >64KiB、大来源 token 算术），`apps/api` 下 `go build ./...` exit 0。用例覆盖：尺寸/形状稳定码矩阵（含 65 项合法条目边界）、可达 envelope 解码后由字节检查命中、字节口径边界（`<x>` 63KiB/66KiB）、16k 零来源保全部 18 条 history、大来源优先保留最高排名且仅最新完整 pair 入选、rewrite 预算独立（同模型保 18 条、极小窗口为空不 panic）、summarySource 16/17/18 边界、跨层 HTTP/SSE（stub worker 捕获内部 payload 断言 summarySource 未裁剪/messages 已裁剪/sources=2，terminal temporarySummary 透传 + usage 合并 + 引用重编号 `[[C1]]`）。
- Worker：红 `pnpm exec vitest run src/assistant/temporary.test.ts` exit 1（4 失败/3 通过，失败均为“temporarySummary 始终 null、无第二次 Provider 调用”）→ 绿 exit 0（审计返工后 8 通过，含输出脱敏用例）；`pnpm run check`（tsc）exit 0；`runner-maintenance.test.ts` 回归 11 通过。用例覆盖：成功维护（第二次调用输入含旧事实与新消息、reasoning off、max_completion_tokens=1024、事件顺序、temporarySummary 等于净化结果）、超预算跳过、无效 JSON/Provider 500/60s 超时均 null 且 succeeded、prefix 独立于 answer 裁剪、summarySource null 不维护、输出脱敏。
- Web：红 exit 1（3 失败/10 通过：水位推进 ×2、超 32 本地拦截）→ 绿 exit 0（13 = 既有 8 + 新增 5）；模块回归 `pnpm exec vitest run src/modules/assistant/` 11 文件 52 测试 exit 0；`vue-tsc --noEmit` exit 0；文案修改后定向复跑 13 通过。
- 主统一集成：仓库根 `pnpm --filter @dev-toolbox/web check` exit 0；`apps/ai-worker` 下 `pnpm run check` exit 0；`git diff --check` 干净。`git status` 复核本轮改动仅含三 owner 文件集（R05 的 ItemDetailView 与新测试、R01–R03 候选、用户本人改动均未触碰）。

### 审计返工（决策审计 Agent 代码审计发现，主 Agent 同轮一次修完）

1. `fillTemporaryContext` 原逐条倒序可留下孤立最旧 assistant（违反“完整成功问答”冻结验收）→ 改为整对预算保留，配套用例断言仅最新完整 pair（user,assistant 顺序）入选；修复过程中发现并改正成对反转顺序错误。
2. `validTemporarySummary` 原把 >64 项并入形状错误返回 `VALIDATION_FAILED` → 项数超限与形状分离，补 65 个合法非空字符串边界用例返回 `ASSISTANT_CONTEXT_TOO_LARGE`。
3. Worker 摘要输出原只过滤空串/条数/字节、未走输出 `StreamRedactor`（docs/16 §6.2 模型输出进事件前脱敏）→ 每条目脱敏后再验上限，加合成 token fixture 断言 public terminal 无原值。
4. Go 摘要字节原按 `json.Marshal` 长度、Worker 按 `JSON.stringify` 长度，`<x>` 类合法 DTO 两端判定相反 → 统一为条目 UTF-8 字节合计口径并加边界用例。
5. Web 拦截文案“请开启新的临时会话”无实际对应入口 → 改为“复制后刷新重开”指引，不加清空按钮/弹窗，草稿保留。

### 未验证边界

- 全部为定向单测/契约测试（jsdom、本地 mock Provider/SSE、httptest stub worker、nil-DB 校验路径）；未做真实浏览器长对话手工验证、真实 Provider/数据库联调、`anthropic-messages`/`openai-responses` 协议下的维护调用（fixture 仅 openai-completions，与既有测试模式一致）、全量测试套件与构建镜像。
- Go handler 的“问题单独超预算 → 头前 422”分支需 DB 才可达，未做 handler 级直测（公式复用持久 `inputContextBudgetTokens`，裁剪行为由单测覆盖）。
- 摘要维护在 terminal 前执行，最坏延长 SSE 结束 60 秒（有界、可取消）；该体验未做真实浏览器评估。
- 本轮未 commit/push/部署，未访问付费资源。

## DT-R05｜ItemDetailView 原文晚到覆盖（已完成，未提交；由另一单主会话实施，本文件 owner 代记）

- 缺陷与修复：原文 A 的晚到结果覆盖新原文 B；按该视图既有代码守卫模式修复（不新增机制）。实际文件：`apps/web/src/modules/knowledge/ItemDetailView.vue` + 新增 `ItemDetailView.raw-race.test.ts`。
- 验证（实施会话实际运行）：红 4 失败 → 绿 5 通过；`WorkspaceView` 相关 4 项通过；web check 与 `git diff --check` 通过。
- 未验证边界：真实浏览器与真实后端未验证；未跑全量测试；未单测路由卸载行为。

## DT-R06｜合成 PostgreSQL 环境与 M1 真库回归（已完成；由已结束的 R06 会话实施，R07 owner 代记）

- 环境（保留供后续轮次使用）：Docker（orbstack context）容器 `dev-toolbox-dt-r06-pg`，宿主端口 `127.0.0.1:18590`，库 `dev_toolbox_dt_r06_test`（用户 `dt_r06`），数据目录 `/tmp/dev-toolbox-dt-r06`；迁移 001–010 已应用，schema 10 含 pgvector 0.8.6 与 pg_trgm 1.6。与任何现有部署隔离；原 make 脚本会 drop 固定库，未使用。
- 结果：迁移 exit 0；M1 真实认证/TOTP/幂等录入/只读原文等真库用例 stdout 为 PASS/ok；之后会话对退出码的包装因 zsh 只读 status 变量失败——测试通过的事实与包装失败如实区分，不为回显重跑。
- 边界：容器与库保留，未 drop；未触碰其他容器、5199/18580 与任何真实部署。

## DT-R07｜临时聊天真实数据库边界验证与交接（已完成，未提交；本轮单主实施）

补齐 DT-R04「未验证边界」中两项必须真实 DB 才可达的事实；未改任何生产代码。

### R02 根审计真实 IAB 事实补记（决策审计 Agent 提供，R07 owner 代记）

- QuickCapture：中文 1,048,578 字节时禁保存且 Cmd+Enter 不提交；1,048,575 字节时可保存；输入未被截断。敏感+自定义标题的「标题会以原文出现」说明真实出现；390 宽度下无页面溢出。
- 该浏览器使用隔离 18580 合成 auth，其余 API 一律 501，未保存任何真实后端数据。Supplement 重试、R05 真实浏览器仍未验证。

### 实际文件

- 新增 `apps/api/integration/v3_temporary_context_test.go`（本轮唯一代码文件）：复用 `newV3Harness`/`createProviderModel` 等既有 helpers 与真实公开/内部入口；未修改生产代码、既有 integration 文件或其他轮次文件。

### 用例与结果

- A `TestV3TemporaryQuestionAloneOverBudgetFailsBeforeSSE`：经真实 `/api/v1/ai/providers` 建合法小窗口模型（contextWindow 8192 / maxOutputTokens 1024），15,600 字节中文问题（估算 5,200 tokens > 输入预算 4,944）且 <32KiB；POST 真实 `/api/v1/assistant/temporary/stream`，断言 422 `ASSISTANT_CONTEXT_TOO_LARGE`、Content-Type 为 JSON 非 SSE、本地 stub worker 0 次请求、六张聊天表计数不变。该分支经 `lockAndValidateModel` 事务后、SSE 头之前触发，补上 R04 缺口。
- B `TestV3TemporaryRollingSummaryAndChatTableIsolation`：18 条成功历史（9 对 user/assistant）+ 旧四数组摘要，两次经公开临时入口请求。httptest worker 捕获内部 payload：第一次 answer messages 为全部 18 条、summarySource = prior + 最旧 2 条；第二次（新摘要 + 保留 16 条 + 刚完成新 pair）uncovered prefix 恰为下一未覆盖对（无重复覆盖、无跳过）、prior = 第一代摘要。public SSE 携带两代 temporarySummary、模型快照 contextWindow 32768、usage answerContextTokens 逐次透传、无凭据泄漏；两次请求前后 `assistant_conversations/assistant_messages/assistant_runs/assistant_run_events/assistant_run_sources/assistant_conversation_summaries` 计数均不变。
- 验证（实际运行，真实退出码）：`TEST_DATABASE_URL` 指向 `127.0.0.1:18590/dev_toolbox_dt_r06_test`（harness `assertTestDatabase` 强制 `_test` 后缀；密码由容器私有配置读入，未回显），`go test -tags integration -count=1 -run '^(TestV3TemporaryQuestionAloneOverBudgetFailsBeforeSSE|TestV3TemporaryRollingSummaryAndChatTableIsolation|TestV3TemporaryContextUsageSnapshot)$' ./integration/ -v` 三个用例全部 PASS，`task_rc=0`。R04 已通过的 Go 包/Worker/Web 检查输入未变，未重跑。

### 未验证边界

- worker 为本地 httptest fixture，未接真实 Provider；本结论是 Go 真实 DB + 真实公开 HTTP/SSE 联调，不是真实模型或整产品 E2E。embedding 未配置，走 knowledge unavailable 路径（evidenceState unavailable）。未运行全量测试、构建镜像、正式 release；未 commit/push/部署，未访问付费资源。
- 交接：R06 PG 容器与库保留；`docs/19` 写入 owner 随本轮结束释放。

## DT-R09｜录入抽屉触控目标局部修正（触控尺寸与隐藏 file input Tab 站点均已过根审计复验；本轮单主实施）

- 背景：根审计在真实 IAB QuickCapture（默认桌面与 390x844 一致）实测低于项目 40x40 最小命中区的控件：关闭 36x36、纯文本 51x29、Markdown 72x29、更多选项 summary 358x19；Supplement 源码关闭同为 36px，两组件附件移除/错误重试无 min40。隐藏 file input（1x1，有可见添加按钮）与敏感 switch（36x20，整行 label 可点）经确认不属缺陷，未改动；添加/取消/保存 UiButton 已为 40，未改动。
- 修正（仅局部 CSS，无 markup/JS 改动，图标视觉尺寸不变，R1 Graphite tokens/字重/结构保留）：
  - `QuickCaptureDrawer.vue`：`.icon-button` 36→40；`.capture-toolbar button` 加 `min-height: 40px`（宽度 51/72 本已 ≥40）；`.capture-options summary` 加 `min-height: 40px; padding: 10px 0`（保持默认 `display: list-item`，原生展开 marker 与键盘行为不变）；`.attachments li button` 加 `inline-grid + min 40x40 + place-items: center`；`.capture-state button`（重试）加 `min 40x40 + 水平 padding + align-self: center`。
  - `SupplementDrawer.vue`：`> header > button` 36→40；`.supplement-files li button` 与 `.supplement-error button`（重试）同上 40x40 处理。
- 浏览器验收支撑（仓库外合成，非产品入口）：现有 18580 服务不动；新增 `/tmp/devtoolbox-dt-r03-browser/supplement-fixture/`（index.html + fixture-main.ts，显式标注合成）挂真实 SupplementDrawer SFC（合成 itemId/rawRecords、createPinia、默认 open、可重开），并按既有授权方式补 `node_modules/pinia` symlink 指向仓库已有依赖。API 仍由该服务 middleware 对 `/api/v1/*` 固定 501。
- 静态检查（实际运行）：经 18580 真实 Vite 拉取两个 SFC 及 scoped style 变换产物，全部 HTTP 200 且包含上述新规则（SFC 实际编译通过）；`git diff --check` exit 0。按本轮约定未重跑 R02 单测与全量/typecheck。
- 未验证边界：真实浏览器（IAB 桌面 + 390x844）命中区与交互复验由根审计执行，本记录不宣称已通过；未运行浏览器自动化、未跑全量测试；未 commit/push/部署，未访问付费资源。`docs/19` 写入 owner 随本轮结束释放；18580 预览与 R06 PG 环境保留。

### 根审计复验反馈与同轮追加修正

- 尺寸复验（根审计真实 IAB 实测，已通过）：两真实 SFC 在五种目标宽度复验——QuickCapture 可见关闭/格式切换/summary/主按钮均 ≥40x40、无页面横溢，summary Enter 可原生收起/展开且焦点 outline solid；Supplement 合成页保存到固定 501 错误后，关闭 40、错误重试 40x43（桌面 43x43）、主按钮 40，五宽均无横溢，输入保留。
- 键盘问题（根审计真实 Tab 路径发现，非命中区问题）：Supplement 从「目标原始记录」按 Tab 到可见「选择文件」按钮后，下一 Tab 落到不可见原生 file input（选择补充记录附件，rect x=-1,y=-1,w=1,h=1），再下一 Tab 才到重试，中间存在完全不可见的重复 Tab 站点。
- 追加修正（授权的最小 markup 例外，不改尺寸/不加新结构与 ARIA 机制/不改 JS）：`SupplementDrawer.vue` 隐藏 file input 加 `tabindex="-1"`，移除不可见 Tab 站点，可见「选择文件」按钮仍完整支持键盘。QuickCapture 同类 sr-only file input 核对结果：模板本就带 `tabindex="-1"`（`QuickCaptureDrawer.vue` 371 行），无需改动。按授权未新增属性镜像单测。
- 静态检查（实际运行）：经 18580 真实 Vite 拉取 `SupplementDrawer.vue` 变换产物 HTTP 200 且渲染输出含 `tabindex: "-1"`；`git diff --check` exit 0。
### 根审计最终 Tab 复验（已通过；R09 会话结束后由 R10 owner 代记）

- 根审计真实 Tab 路径实测：两个抽屉的隐藏 file input `tabIndex` 均为 -1（QuickCapture 为原有实现，Supplement 为本轮追加修正）。从 QuickCapture「添加文件」按 Tab 直接到「更多选项」summary，outline solid；从 Supplement「选择文件」按 Tab 直接到可见「重试」，outline solid、实测宽高约 43px，不可见重复 Tab 站点已移除。五宽目标尺寸与无页面横溢此前已复验通过。
- 未验证边界照实保留：未实际选择附件后测移除按钮，其 40 尺寸仅源 CSS 静态约束；本轮未做 light 主题专项复验（纯 CSS 尺寸修改无主题分支）；未运行浏览器自动化、全量测试与 R02 逻辑测试（输入未变）。R09 会话不再写文件，`docs/19` 唯一写 owner 移交 R10。

### 根审计 QuickCapture 附件移除实操补验（已通过；R18 owner 代记）

- 根在 18580 真实 SFC/合成 auth 环境实测：390x844 下经真实文件 chooser 选择根自己的 r13-sample.txt（71B），移除按钮实测 40x40（pageWidth=390）；点移除后附件条目归 0 且空正文下 Save disabled；同一文件重新选择出现 1 条且 Save enabled；随后再次移除、关闭空对话并还原 viewport。
- 全程未保存、未上传任何 API，故本补验只证明控件实际移除/重选与禁用态联动，不证明后端上传。R13 已验的 Supplement 附件移除事实保留（历史原文不回改）；R09/R13 既有未验记录中「QuickCapture 附件移除实操」一项至此补全。

## DT-R10｜首用模型引导与当前帮助说明（已完成，未提交；本轮 1 主 + 1 frontend-builder 子）

R08 审查采纳结论：只读审查已完成且无安装闭环阻碍；其确认的前端首用缺口（任务中心批量面板空模型死路）已由本轮 A 项修复。R09 会话结束后 `docs/19` 唯一写 owner 移交本轮，R09 最终 Tab 复验已代记于上节。

### A｜任务中心空模型首用引导（owner：frontend-builder 子，独占 TaskCenterView）

- 缺陷：/ai/tasks 批量整理面板在无可用模型时 organizeModelID 为空、select 只有占位项、开始按钮永久 disabled 且无任何解释；面板内唯一设置链接指向 /settings/ai-schedule，不解决模型问题。
- 修复：新增 `providersLoaded` ref（`loadState` 开始置 false，providers 响应赋值成功后置 true，Promise.all 任一失败保持 false）与 `batchModelMissing = providersLoaded && !modelOptions.length`；仅当批量面板打开且该条件成立时显示复用既有 `center-notice center-notice--warning` 样式的 `role="status"` 提示「当前没有可用模型。请前往 Provider 与模型设置完成配置或启用。」，附真实 RouterLink（文字「配置 Provider 与模型」）指向 /settings/providers（`min-height: 40px` + inline-flex + 既有 padding/radius token，全局 :focus-visible 生效，无新增颜色/组件/包装层）。加载中与 providers 读取失败均不误报，既有错误重试路径未动；自动选模、批量 API/选择策略/敏感策略未改动。
- 实际文件：`apps/web/src/modules/ai/TaskCenterView.vue`（+6 行：1 ref、1 computed、2 处赋值、1 条提示、1 条 CSS）；新增 `apps/web/src/modules/ai/TaskCenterView.test.ts`（模式跟随 m4-workbench.test.ts；2 用例：providers 已配置但 `enabled: false` → 面板出现提示与 /settings/providers 链接且开始按钮 disabled，含加载中窗口不误报断言；providers 读取失败 → 既有错误与重试保留且重试真实再次请求 providers、不出现空模型提示）。
- 验证（实施子智能体实际运行，apps/web 下）：红 `pnpm exec vitest run src/modules/ai/TaskCenterView.test.ts` 1 失败/1 通过（失败即缺口断言：面板无空模型提示）→ 绿 `pnpm exec vitest run src/modules/ai/TaskCenterView.test.ts src/modules/ai/m4-workbench.test.ts` 5 通过（有模型批量路径回归保留）；`pnpm -C apps/web check`（vue-tsc + tsc）通过。vitest 输出的 `VUE_ROUTER_R0004 "/settings/operations"` 警告经单跑 m4-workbench 对照确认为既有测试产物，与本轮无关。

### B｜帮助边界与本地开发前提（owner：主）

- `apps/web/src/modules/help/HelpView.vue`：「当前明确边界」中原「不提供向量语义搜索、OCR/PDF 正文解析、通用导入向导、插件市场或多用户协作」一条拆为三条——普通资料库搜索基于关键词/子串/模糊匹配、不提供向量语义搜索，知识助手在完成 Embedding 配置且索引就绪后可在其检索范围内提供混合召回；知识录入与检索不做自动 OCR 或 PDF 正文解析，工具箱 OCR 由用户主动执行；通用导入向导/插件市场/多用户协作非目标原样保留。纯文案拆清，不新增能力或承诺，其余边界条目未动。
- `README.md`：「常用开发命令」前补一段宿主机前提——`make install`/`check`/`test`/`build` 在宿主机执行，要求本机 Node.js `>=22.19.0` 且 `<25` 与 pnpm `11.9.0`（与根 `package.json` 的 `engines`/`packageManager` 一致）；`make up` 的镜像构建在 Docker 内完成，不要求宿主机安装这些 Node 工具。「本地开发」顶端容器前置段保持原样。历史一期边界、Schema 9/验收/版本结论未动。

### 审查返工（R10 候选小范围审查反馈，主 Agent 同轮完成，不新增 Agent）

1. TaskCenter 空模型提示文案简化为通用可用性表述「当前没有可用模型。请前往 Provider 与模型设置完成配置或启用。」，链接文字改「配置 Provider 与模型」——原枚举「未配置 Provider/全部停用」漏了 Provider 存在但尚无模型等状态。`providersLoaded`/空态条件/API 未动；测试断言依赖的「没有可用模型」子串与 `a[href="/settings/providers"]` 选择器不受影响，测试文件无需修改。
2. HelpView OCR 句删去「仅是独立工具、不并入知识附件流水线」排他性断言（知识条目存在 analyze_image 图片分析任务，docs/03 有 image_text 派生检索来源与批量图片分析子任务），改为「知识录入与检索不做自动 OCR 或 PDF 正文解析；工具箱 OCR 由用户主动执行。」
3. README 恢复「本地开发」顶端容器前置段原样，Node/pnpm 前提移至「常用开发命令」前并精确限定为 `make install`/`check`/`test`/`build` 宿主机命令所需；明确 `make up` 镜像构建在 Docker 内完成、不要求宿主机 Node。历史一期/Schema 验收内容未动。
- 返工后复跑（实际运行）：`pnpm exec vitest run src/modules/ai/TaskCenterView.test.ts` 2 通过；范围 `git diff --check` exit 0。按审查指示未重跑 m4-workbench、web check 与其他历史检查（输入未变或不受文案影响）。

### 集成验证与未验证边界（主）

- 仓库根 `git diff --check`（本轮文件范围）exit 0；`git status` 复核本轮改动仅含上列五个文件（docs/19 为 R09 创建、本轮起由 R10 owner 续写），R01–R05 候选、R09 两抽屉与用户本人改动未触碰。
- 未验证边界：TaskCenter 用例全部为 fetch mock 组件测试；浏览器 fixture 初版经成本评估未建，最终审查通过后按协调者决定补建并由其 IAB 真实验收通过（见 fixture 小节），Tab 焦点、40px 命中区与五宽布局已实测；真实后端、真实 Provider/模型调用仍未测（fixture 为合成空数据，非真后端）；HelpView/README 纯文案未做浏览器验证；未运行全量测试；未 commit/push/部署，未访问付费资源。
### 浏览器 fixture（R10 最终审查通过后按协调者决定补建；协调者 IAB 真实浏览器验收已通过）

- 形态（仓库外临时文件，不入仓库）：现有 18580 服务与 server.mjs 不动；新增 `/tmp/devtoolbox-dt-r03-browser/taskcenter-fixture/`（index.html + fixture-main.ts）并按既有授权方式补 `node_modules/vue-router` symlink（指向 `apps/web/node_modules/vue-router`）。页面经真实 Vite 加载真实 TaskCenterView SFC + createPinia + 最小 memory router；`/settings/providers`、`/settings/ai-schedule`、`/items/:itemId` 为明确标注合成的占位页，仅检验 RouterLink 导航目标，不构成真实配置验收。fixture 内 `window.fetch` 仅对 4 类只读请求返回本地合成响应（providers 空 items、settings 与组件测试同形、items 空、tasks 空 items + null cursor），其余一律 501 `FIXTURE_UNKNOWN_API` 拒绝；未登录、未配置 Provider、未连接任何真实后端。页面顶部标注「合成空模型，仅 UI 验收」。
- 入口：`http://127.0.0.1:18580/@fs/private/tmp/devtoolbox-dt-r03-browser/taskcenter-fixture/index.html`。
- 已做验证（实施方，实际运行）：curl 确认 fixture HTML、fixture-main.ts、真实 TaskCenterView SFC、app/auth.ts 经 18580 Vite 变换均 HTTP 200，且 TaskCenterView 变换产物含本轮提示文案与 `batch-model-link` 规则、fixture 含白名单拒绝逻辑（与 R09 同级静态检查）。
- 启动缺陷与修复（协调者 IAB 实测发现）：初版 entry 对 `app/auth` 的 `@fs` 绝对导入未写 `.ts` 扩展，Vite 对外部 @fs 导入不做扩展推断，重写为无扩展 `/src/app/auth` 后资源 canceled（text/plain、size 0），模块图无法启动、页面仅空 #app。已改为显式 `app/auth.ts` 扩展，curl 复验该资源 HTTP 200、`text/javascript`、16,772 字节，entry 变换产物引用 `/src/app/auth.ts`；未改任何产品文件/服务，未重跑产品测试。
- 协调者 IAB 真实浏览器验收（auth.ts 修正后正常挂载，已通过）：批量整理打开后可操作空模型提示出现，开始按钮保持 disabled；390/1024/1440/1920/3840 五种目标宽度 pageWidth 均等于视口、notice 无内横溢、配置链接实测 155x40；从「关闭批量整理」按 Tab 直达配置链接，focus outline solid；点击跳转至明确标合成的 Provider 设置占位页（href=/settings/providers）。未提交真实配置、未调用 Provider；fixture 不是真后端，该验收不构成真实后端结论。按指示未重跑已通过的测试。
- 残余事实（照实记录）：批量面板外页头的 /settings/ai-schedule 链接按任务边界未动；providers 读取成功而 tasks 加载失败时，错误提示与空模型提示会同时出现，两者均事实准确。R10 至此全部完成：代码、文案、审查返工与协调者 IAB 浏览器验收均通过，`docs/19` 写入 owner 于本轮结束时释放，移交正在实施 HomeView 的 R11；18580 合成预览（含 taskcenter-fixture）与 R06 PG 环境保留。

## DT-R11｜首页工具处理边界与当前能力说明（已完成，未提交；根审计真实浏览器验收通过；本轮单主实施）

- 背景：`V2_TOOLS` 10 项中 8 项 `processing: local`，文本翻译与 OCR 翻译为 `processing: cloud`，而 HomeView 仍写「当前已发布 V2.0 本地工具」、工具箱概括为「确定性工具」、footer 用默认 local 的 ProcessingBadge 代表整页并只提 JSON AI 例外，整体「本地处理」提示对含在线能力的入口造成误解。R10 结束后 `docs/19` 写入 owner 移交本轮。
- 修正（仅 HomeView；共享 ProcessingBadge 组件、工具 metadata、工具行为/模型/API/本地持久化零改动，无新 mode/props/注册器/抽象）：
  - intro 副标题改为区分「多数工具在当前浏览器本地处理，翻译与云 OCR 在你确认后才会外发」。
  - 工具箱模块说明改为「浏览器本地工具与需确认外发的在线能力；输入和结果不保存为使用历史。」，不再把含在线能力的工具箱概括为全部确定性本地，也不把文本翻译说成可选云。
  - 常用工具副标题删去 V2.0 版本限定（列表已含 V2.2 翻译/OCR），说明「每个入口标注默认本地或含云服务」。
  - 每个快捷入口卡片复用 `tool.processing` 渲染短文字标签：8 项「默认本地」、文本翻译与 OCR 翻译「含云服务」（OCR 默认可本地识别、含可选云功能，不说一定云处理；JSON 默认本地的 AI 外发例外由 footer 说明）。标签纯文字非交互，无 `white-space: nowrap`、`line-height: 1.4`、`justify-self: start`，位于 `minmax(0, 1fr)` 收缩列内，390 两列窄中栏下可自然换行、不撑出卡片。
  - footer 移除 ProcessingBadge 导入与单一默认 local badge（不再代表混合全页），改为中性 `lock-keyhole` 图标 + 准确文字：标注「默认本地」的工具不把正文发送业务 API、不写浏览器持久化存储；JSON 的 AI 类型生成、文本翻译与云 OCR 仅在明确操作并确认发送范围后外发；实际处理位置以工具页说明为准。未宣称完全离线/绝不联网，未否认前端资源等基础网络请求。
- 实际文件：`apps/web/src/modules/home/HomeView.vue`、`apps/web/src/modules/home/HomeView.test.ts`（本轮产品改动仅此两项，另加本记录）。
- 验证（主 Agent 实际运行，真实结果）：红——初始 4 用例对旧实现 2 失败/2 通过（失败为入口缺处理标示、footer 缺「以工具页」边界且仍渲染单一 ProcessingBadge；全部入口 href 用例旧实现本已满足，属防回归）；绿——实现后 `npx vitest run src/modules/home/HomeView.test.ts` 4/4 通过。审查收尾（副标题删版本限定、工具箱模块文案替换、删第四条实现镜像/禁词用例及仅供其使用的 ProcessingBadge 测试导入，保留无网络无持久化、全部入口 href、按 processing 标示共 3 个真实消费者用例）后重跑同命令 3/3 通过；`pnpm -C apps/web check`（vue-tsc + tsc）收尾稳定候选上一次 exit 0；仓库根 `git diff --check` 第一轮一次 exit 0，收尾轮按指示未重跑。未重跑其他模块/全量。
- 根审计真实浏览器验收（协调者真实 18580 首页实测，已通过）：深/浅两主题 × 390/1024/1440/1920/3840 五宽 pageWidth 均等于视口、cardBody 无横溢；10 个原链接均保留，8 个「默认本地」、文本翻译/OCR 翻译 2 个「含云服务」；默认本地 badge 不再代表混合全页；从正则卡按 Tab 到文本翻译卡 `href=/tools/translate` 且 focus outline solid。验收中未点击云处理动作、未接真实后端/Provider，主题已恢复 dark。
- 未验证边界：附件移除实操（R09 既有未验记录原样保留）、真实云调用/真实后端/Provider、完整 E2E 均未测且维持既有未验记录；本轮不升级任何正式验收结论、版本号或 tag。未 commit/push/部署，未访问付费资源。R11 至此完成，`docs/19` 写入 owner 于本轮结束时释放。

## DT-R12｜模型配置与初始选模真实 API 闭环（验证完成，未提交；本轮单主只读执行，无代码改动）

- 背景：补首用「配置 Provider → 选择模型」的真实 API 消费路径验证，不重复已通过的临时聊天 3 用例，不跑全量。R11 代码与根审计浏览器验收完成、文档收尾并释放 owner 后，`docs/19` 唯一 owner 移交本轮。
- 隔离审计（执行前逐项核对源码）：三用例 Provider/Worker 出口均为本地 fixture 或保留域名——M3 的 Worker 为本地 `httptest.Server`（连通性三态 ok/credentials_invalid/unavailable 均由它返回）；v3 harness 未传 workerURL、默认 `http://worker.invalid`，且两个 v3 用例的 Run 均未 claim，不存在模型调用路径；Provider baseUrl 为 `.test`/`.example` 保留 TLD，密钥与加密主密钥均为合成字节。数据库仅 `127.0.0.1:18590/dev_toolbox_dt_r06_test`（docker ps 核对映射 `127.0.0.1:18590->5432`，容器 `dev-toolbox-dt-r06-pg` 运行中），`assertTestDatabase` 强制 `_test` 后缀，reset 仅 TRUNCATE 所连库。无真实外发、无付费资源、无超长检查，无暂停项；未触碰 5199/18580、deploy 配置与真实部署 DB。
- 验证（apps/api 下实际运行一次；连接密码从容器 env 读入 shell 变量构造 `TEST_DATABASE_URL`、未回显）：`go test -tags integration -count=1 -run '^(TestM3ProviderPATAndExternalArtifact|TestV3BootstrapAndReasoningOptions|TestV3ProviderInUseNarrowing)$' ./integration/ -v` → 原始退出码 `task_rc=0`，3/3 PASS：TestM3ProviderPATAndExternalArtifact 0.68s、TestV3BootstrapAndReasoningOptions 0.20s、TestV3ProviderInUseNarrowing 0.24s（包 1.759s）。
- 覆盖事实：M3——Provider 创建（密钥以版本化加密信封落库、响应不含明文、掩码返回）、模型 contextWindow/maxOutputTokens 清除为 null 与恢复、Provider 连通性测试三态映射（含错误码 AI_PROVIDER_CREDENTIALS_INVALID / AI_PROVIDER_UNAVAILABLE）；Bootstrap——无模型时 bootstrap 返回空 models 且 `newConversationSelection.required`（`no_available_model`），配置 Provider/模型后 models 出现并暴露 contextWindow、reasoningOptions 为 off+2 配置项、选择原因转 `first_use`；InUseNarrowing——存在 queued（已创建、未 claim）Run 时禁用 Provider 与改模型 upstream modelId 均被 409 `PROVIDER_IN_USE` 拒绝、改 Provider 显示名允许（200）、stop 后禁用 Provider 放行（200）。该用例未 claim，未覆盖 running 租约路径，不泛称所有 running Run 均禁止配置变更。
- 边界：真 PostgreSQL（R06 合成专用库）+ 真实 `/api/v1` 公开处理链（auth/CSRF/PAT/加密/持久化为生产代码路径）；Provider 连通性与 Worker 为本地 fixture，非真实模型调用、非整产品 E2E；未跑全量、未重复临时聊天用例、未 commit/push/部署、未访问付费资源、未升级正式验收结论或版本号。命令 `-v` 输出缓冲于 `/tmp/dt-r12-integration.log`（仓库外一次性输出）。R06 PG 容器与 18580 预览保留（测试 TRUNCATE 后由用例自身重建合成数据）。本轮零产品文件改动，仅追加本记录；`docs/19` 写入 owner 于本轮结束时释放。

## DT-R13｜隔离真 API + Web 知识流程联调环境（会话期临时环境，零产品改动，未提交；根审计真实浏览器验收通过）

- 背景：工具与组件合成页此前已验；本轮为真实知识录入→补充→搜索→详情读取搭建本机浏览器联调环境（真实 Go API + 真实 Web + 独立真 PG 库），非完整 E2E、非真实模型评测；不改产品文件/依赖/认证策略。本轮 1 主 + 2 子（A 后端 owner：/tmp/dev-toolbox-dt-r13/ 启动/seed 脚本、进程与新库；B 前端 owner：同目录 web-server.mjs 与进程；主：核对与 docs/19），均已结束。
- 拓扑（全部 IPv4 loopback，lsof 终态核对）：PG 复用容器 dev-toolbox-dt-r06-pg（127.0.0.1:18590，未改动），新库 dev_toolbox_dt_r13_test（tern 迁移 001–010 全量、schema_version=10；provider_configs=0、ai_task_runs=0，真实调度器/assistant runner 随服务启动但空转；dev_toolbox_dt_r06_test 与 18580 既有服务均未触碰）。API 为真实 apps/api/cmd/server 构建（/tmp/dev-toolbox-dt-r13/bin/api-server，PID 71132，127.0.0.1:18591），APP_ORIGIN=http://127.0.0.1:18581，AI_WORKER_URL=http://127.0.0.1:18592 刻意留空（无 worker/Provider/模型/外发）；ATTACHMENT_ROOT 与 OPERATIONS_STATUS_ROOT 为 /tmp/dev-toolbox-dt-r13/ 下独立目录；APP_MASTER_KEY 与 INTERNAL_SERVICE_TOKEN 为 secrets/ 下 0600 合成文件；DB 密码仅 docker exec 读入内存拼 DSN，未回显未落盘。Web 为真实 Vite dev server（PID 71889，127.0.0.1:18581，strictPort），经 web-server.mjs 加载仓库 vite.config.ts 并仅覆盖 host/port//api 代理→18591（cacheDir 指向 /tmp，避免依赖预打包写仓库 node_modules/.vite；已核对仓库 .vite mtime 早于本轮启动）。
- 认证 seed（真实生产链，无旁路）：官方 cmd/dev-toolbox admin init-owner --password-file（0600）创建合成 owner；随后走真实 API：login 202 mfa_setup_required → totp/setup → totp/confirm authenticated（RFC6238 由 python3 标准库生成，一次走通）。登录材料 username/password/totpSecret 存 /tmp/dev-toolbox-dt-r13/browser-login.json（0600，不含 recovery codes/csrf/cookie；内容不外显）。未重置任何现有账号、未经 UI 创建/改密，Secure cookie/CSRF/MFA 约束零改动。
- 已验证（各项一次）：GET /health/live、/health/ready 均 200；GET /api/v1/auth/session 无 cookie 401；Web / 200（真实 Vite HTML）；GET /api/v1/version 经 18581 代理返回真实 API JSON 200；认证链全通；监听终态与库/附件/密钥隔离如上。
- 未验证边界（根 IAB 后更新）：AI worker/真实模型/云（刻意无）；全响应式矩阵与完整 E2E；R05 故意晚到竞态未注入；除本次 Chromium 外的其他浏览器未验（含其对 loopback HTTP 下 `__Host-` Secure cookie 的行为）。本次 Chromium IAB 在 loopback HTTP 下 Secure cookie 正常生效，无 auth mock、未降低任何安全约束。
- 停止方式：kill 71132（API）、kill 71889（Web），均为本轮自有进程；日志在 /tmp/dev-toolbox-dt-r13/logs/（api.log 启动至今 0 ERROR，HTTP 日志不含 Authorization/Cookie）。本轮零产品文件改动（仓库只读，仅全局 go build 缓存），未 commit/push/部署/改版本/正式验收，未访问付费/OSS/restic 资源，未触碰 5199、其他项目与会话。

### 根审计真实浏览器验收（隔离联调环境 18581，已通过；根提供事实，R13 owner 代记）

- 登录与安全：正常密码→TOTP 登录成功，未勾选信任设备；Secure cookie 在本次 Chromium IAB loopback 下正常生效；无 auth mock、未降低任何安全约束。
- 录入与原文：普通 Markdown 经 Meta+Enter 保存成功并清空、可继续录入；敏感纯文本另存使用系统安全标题；列表与敏感搜索命中链接均遮挡正文；普通原文明确读取后「复制全部」与保存 body 逐字一致。
- 补充与附件：对普通 item 追加 text 与 71B 合成 txt 附件，产生第 2 条 raw；附件移除按钮实测触达 40x40、移除后保存 disabled、同文件可重新选择；下载附件与原文件字节完全一致；回读主 raw 复制仍逐字原值，旧原文未被修改。
- 搜索与定位：搜索 DT-R13-SUPPLEMENT 恰 1 条并 hit 定位到新 raw；明确读取后复制等于补充原文；q 未进入 URL（仅 item/hit），输入框 autocomplete/autocapitalize off、spellcheck false。
- 敏感揭示：敏感 body 在详情明确查看+确认前不在 DOM，确认后等于保存内容，离开详情即移除；390x844 重新打开需再次揭示且 body 仍不在 DOM，pageWidth=390。
- 范围：桌面默认 1280 与 390 代表流程，非全响应式矩阵/完整 E2E；未注入 R05 故意晚到竞态；未调用 Worker/真实 Provider/云；数据全部为 r13_test 新合成数据。
- 补验既有未验记录：R09 记录的 Supplement 附件移除实操本次已实测通过；QuickCapture 附件移除仍未测，不与之混称（R09/R11 历史原文不回改）。
- R13 至此完成，`docs/19` 写入 owner 于本轮结束时释放。

### 根审计真实 IAB 小范围工具 QA 代记（纯验证，无产品改动；根提供事实，R13 owner 代记）

- Base64：标准 Base64 中文/emoji 往返正确；交换仅交换且保留 decode 模式不自动执行；无效 UTF-8 有提示且源保留、结果为空。
- YAML：真实 Worker + 390 CodeMirror；`on` 与时间戳保留字符串、中文正常、9007199254740993 字面量不丢精度；重复 mapping key 报错且不改输入。
- SHA256：文本 `abc` 与独立 crypto 结果相同；`0x` 前缀+大小写+ASCII 空白归一后同值；改一 hex 位即不同。
- 正则：真实 Worker 命名 `word` 两匹配 [0,3)/[6,9)；替换 `[abc]123[xyz]` 仅预览、原文 abc123xyz 未改；非法 `[` 报错且旧匹配清空。
- 边界：仅以上代表流程，未测文件输入/全部变体/完整 E2E，无真实 API 与模型参与；根已恢复测试视口。

### 已确认待修复事项：YAML 旧格式化结果覆盖后续新输入（P1，已由 DT-R14 修复）

- 根审计真实 IAB 发现并确认。已由 DT-R14 单主局部修复完成（仅 YamlView.vue + 新增测试，R14 会话不写本文件），代码与根真实 IAB 复验均通过；事实由 `docs/19` owner 代记于下方 DT-R14 节。

## DT-R14｜YAML 旧格式化结果覆盖新输入局部修复（已完成，未提交；R14 单主实施，本文件 owner 代记）

- 背景：根审计真实 IAB 发现的 P1——YAML 旧格式化结果可覆盖后续新输入（见上方 R13 内已确认条目，现已标注已修）。R14 单主局部修复，实际改动仅 `apps/web/src/modules/tools/yaml/YamlView.vue` 与新增 `apps/web/src/modules/tools/yaml/YamlView.stale-result.test.ts`；R14 会话不写本文件，最终事实由现 owner 代记。
- 实现（仅 YamlView.vue，根提供事实）：局部 outputSourceInput 快照；输入漂移即 cancelLocalRequest 并清 output/status/error；成功回调绑定输入快照；apply 检查当前输入一致，且在真正回写前取消任何在途运行，再重绑快照——杜绝旧结果/晚到结果覆盖新编辑或已应用状态。作废语义：逐次编辑第一次即作废既有结果，回退输入不恢复已丢弃结果（不存在「编辑后改回原文一定保留旧结果」的行为）。
- 验证（R14 会话实际运行，真实退出码）：初始红 3 failed/1 passed → 实现后新 + 既有 YamlView 用例共 5/5 PASS；根审计追加「已有结果下再次计算中点击应用」竞态（扩既有正常应用用例）再红 1 failed/3 passed → 增加取消逻辑后两文件 5/5 PASS；`pnpm check`（vue-tsc+tsc）exit 0；相关 `git diff --check` exit 0。
- 审查：根 OCR 仅做文件/规则解析；主模型对两文件定向审查，无其他阻碍。
- 根审计真实 18580 IAB 390 CodeMirror 复验（已通过）：old/value1 格式化完成后输入改为 new/value999/keep 新增内容——旧应用按钮不存在、旧 status 为空、新输入逐字保留；重新格式化并明确应用后，输入逐字等于该最新输出，keep/value999 保留，显示「格式化结果已应用到输入」。复验后视口已恢复。
- 边界：浏览器未刻意注入晚到竞态，该边界由真实取消机制 + 组件回归用例覆盖；非完整 E2E、非全工具/全响应式矩阵。未 commit/push/部署/改版本/正式验收，未访问付费资源。R14 记录完毕，`docs/19` 写入 owner 于本次代记后释放。

## DT-R15｜登录页过时版本标记局部清理（已完成，未提交；根审计真实浏览器验收通过；本轮单主实施）

- 背景：根在真实 18581 正常登录时发现登录页产品头部写死「v1.0」（AuthView.vue 模板硬编码），产品已有后续版本与未发布候选，不应冒充当前版本；属 R11 清理首页旧版本限定的同类局部真实性修正。
- 修正（仅 AuthView.vue，净删 7 行，无行为改动）：删除产品头部模板中硬编码的 `<span>v1.0</span>`；删除仅为该 span 存在的 `.auth-brand > span:last-child` 样式规则（删 span 后该选择器不再匹配任何元素，属专用死样式）。名称/图标与登录、TOTP、恢复码、会话、密钥逻辑及其他全部样式结构保留；未接版本 API、未新增配置/抽象/依赖，未改 APP_VERSION/tag/README/正式验收，未触碰其他产品文件。
- 实际文件：`apps/web/src/modules/auth/AuthView.vue`（本轮唯一产品文件）。
- 验证（R15 会话实际运行）：`git diff --check apps/web/src/modules/auth/AuthView.vue` 干净（1 file changed, 7 deletions）；18581 既有 Vite dev server 真实 SFC 变换 `GET /src/modules/auth/AuthView.vue` HTTP 200（修改后 SFC 编译通过；未重启 server、未读取真实 Secrets）；定向核查产品源码 `v1.0` 硬编码仅此一处（另两处为测试 fixture 的无关版本字符串）、DESIGN.md 无登录页版本标记契约。按本轮约定未新增测试、未重跑全量/web check/历史检查。
- 根审计真实浏览器验收（真实 18581，已通过）：正常退出登录成功，登录页不再显示 v1.0；账号/密码/继续表单保留、密码为空；桌面默认 1280 与 390x844（pageWidth=390）均复验通过，视口已恢复。
- 无发布边界：不改 APP_VERSION/tag/README/正式验收结论；未 commit/push/部署，未访问付费/OSS/restic 资源。R15 记录完毕，`docs/19` 写入 owner 于本轮结束时释放。

### 根首用模型配置真实 IAB 纯验代记（无产品改动；根提供事实，R15 owner 代记）

- 环境：18581 真实 Go API + r13_test 库（R13 隔离联调环境），本轮纯验证，零产品改动。
- 任务中心首用：无模型时批量面板真实提示与配置 CTA 出现、Start disabled；点击 CTA 跳转到真实 Provider 设置页。
- 合成配置（全程无真实外发）：创建合成 Provider `dt-r15-fixture`（HTTPS `.invalid` 保留域名；随机合成 key 未回显，仅页面掩码且 DOM 无明文；未做连接测试）；手工模型 `dt-r15-synthetic-model`（contextWindow 8192 / maxOutputTokens 1024），附加思考标签合成高/high，保存回读成功。
- 首用闭环：回任务中心后模型选择器自动选中该模型、无空模型 CTA；选 1 条普通合成记录后 Start enabled，未点击开始。知识助手首用要求明确选模，选该模型后思考档位恰为不思考/合成高（合成高可选），窗口显示 8192；composer 始终为空，未按发送。
- 边界：未创建 AI 任务/对话消息，未触发 Worker/Provider/Embedding/云调用，不声称模型连接或输出已验证。r13_test 由空配置变为 1 合成 Provider + 1 模型（保留供后续轮次；R13 初始 0 配置的历史事实与 R13 历史验收不回改）。R09 QuickCapture 附件移除实操仍未做，既有其他未验边界原样。key 内容与私有登录材料不入本记录。

## DT-R16｜真实 Worker + 本机 HTTPS 固定响应 Provider 联调准备与代表流程验证（本轮记录完成，未提交；取消竞态缺陷已确认待 DT-R17；本轮 1 主 + 2 子）

- 背景：在 R13 隔离联调环境与 R15 合成 Provider 配置之上，准备真实 Web→Go→Worker→本机固定响应 Provider→SSE 的代表聊天流程并验证，非真实模型评测、非完整 E2E；不改产品文件/生产依赖/安全策略，全部脚本/证书/进程位于 `/tmp/dev-toolbox-dt-r16/`（A owner：`provider/` 下 HTTPS 夹具与专用 CA/证书/响应模式文件；B owner：`worker/` 下启动脚本与 worker 进程；主：定向核对与协调）。R15 已释放本文件 owner，本轮接管并随本记录结束释放。
- 实际拓扑（全部 IPv4 loopback，lsof 终态核对）：
  - Provider 夹具：`https://127.0.0.1:18593/v1/chat/completions`（仅此路径；未知路径 404、非 POST 405、不重定向），Node 标准库 `server.mjs` 无新依赖；专用短期自签 CA（`provider/ca/ca.pem`，30 天）+ SAN 含 IP:127.0.0.1/DNS:localhost 的服务证书，私钥 0600；CA 仅 worker 进程经 `NODE_EXTRA_CA_CERTS` 信任，未改 OS 信任/全局环境，全程无 `NODE_TLS_REJECT_UNAUTHORIZED`/`rejectUnauthorized:false` 等任何 TLS 降级，`ALLOW_INSECURE_PROVIDER_HTTP=false`；日志仅时间/序号/mode/状态/流式/耗时。当前 PID 85740（`provider.pid`；初版 83391 在多 delta 修改后被精确替换）。停止：`kill $(cat /tmp/dev-toolbox-dt-r16/provider/provider.pid)`。
  - 真实 worker：仓库现有 tsx 直跑 `apps/ai-worker/src/index.ts`（不 watch、不改源码、不构建、不跑测试），`WORKER_ADDRESS=127.0.0.1:18592`、`WORKER_ID=dt-r16-fixture`、`API_INTERNAL_URL=http://127.0.0.1:18591`、`INTERNAL_SERVICE_TOKEN_FILE` 为 R13 受控 0600 私有文件（仅路径引用，内容不读取不打印）、`ARTIFACT_SCHEMA_PATH`/`PROMPT_ROOT` 指仓库既有文件；tsx 父进程 83364（`worker.pid` 记录值），实际监听与逻辑为其唯一子进程 83374；启动前核对 r13_test 的 `ai_task_runs` 与 `assistant_runs` 均为空（无 queued/running，未 claim 任何任务）；`GET /health/live` 单次 200 `{"status":"live","service":"ai-worker"}`。停止：`kill $(cat /tmp/dev-toolbox-dt-r16/worker/worker.pid)`（tsx 向子进程转发信号，worker 对 SIGTERM 优雅退出）。
  - 响应模式：`/tmp/dev-toolbox-dt-r16/provider/mode.txt` 每请求重读——`success` 立即正常响应；`delay` 首字节 8 秒零字节挂起后正常响应（按根要求加大以留足取消操作往返窗口，取代初版约 3 秒，仅此模式）；`error` 受控 503 JSON，进程不崩继续服务。
- 夹具响应规格与多 delta 修订：固定中文回答以【DT-R16 合成固定回复】开头并含短 bash 代码块，显著标明合成非真实模型输出；usage 固定合成值（120/48/168），不构成真实来源/计费证明；格式按 `model-gateway.test.ts`/`assistant/runner-maintenance.test.ts` 既有夹具的最窄兼容形状（流式 role→content→stop+usage→`data: [DONE]`，非流式标准 chat.completion）。按根验收反馈把固定回答由 1 个 content delta 拆为 3 个非空 content delta（`FIXED_TEXT` 改为三段拼接常量，构造上保证拼接文本逐字不变；role/stop/usage/[DONE] 与三模式逻辑不动，无新增计时器/模式/抽象，仅改该 /tmp 脚本），确认 83391 仍为本轮 fixture 身份后仅精确重启该进程并更新 `provider.pid`（未用端口兜底杀）；改后仅做一次严格 TLS 流式检查：3 个 content delta 均非空且拼接与 FIXED_TEXT 完全相等、终止序列不变；非流式/error/delay 及其他已过检查未重跑。
- 根审计真实 IAB 代表流程（根提供事实，本 owner 代记）：根经真实 UI 把合成 `dt-r15-fixture` 的 baseUrl 改为 `https://127.0.0.1:18593/v1`（密钥保持）；开始前根真库快照六张聊天表 + `ai_task_runs` 均为 0。持久会话第一问成功：真实 Web→Go→Worker→HTTPS 夹具→SSE 全链路返回，复制回答逐字等于固定 Markdown（3 段无丢失/无重复）；代码块按产品语义标模型生成未验证；UI 上下文 120/8192 为夹具合成 usage，非真实模型统计。硬刷新后默认进入新对话，最近列表出现后台自动生成标题的会话；明确重开该最近会话后原 1 条用户 + 1 条助手消息保留，复制原回答仍逐字一致（非硬刷新自动重开当前会话）。

### 已确认停止竞态缺陷（单列，待 DT-R17 修复；不计为取消流程通过）

- Run `d32c11a9-61ed-4584-b8a7-aec1db172a17`：根先 SQL 确认 running 再点 UI 停止；`stop_requested_at=2026-10-20T23:24:29.045349Z`、`finished_at=2026-10-20T23:24:30.330153Z`，最终却 succeeded 并显示完整回答。夹具 delay 模式该请求自 23:24:22.242Z 起挂起、8.002 秒后才响应——停止明确先于完成。
- 根定向代码确认缺陷位置：Worker 侧忽略 events.stopRequested；Go `completeRun` 行锁后未检查 StopRequestedAt。`docs/16` §11.3 已有停止契约；R17 新会话（主 + 最多 2 子）正在做局部修复，R17 明确不写本文件，修复事实由后续 owner 代记。
- 持久停止缺陷本身待 R17 修复，不计取消流程通过；临时会话与错误恢复流程的最终验证事实见下节（临时停止行为通过，不改变本缺陷结论）。

### 根审计临时会话与错误恢复最终事实（R16 记录补全；根提供事实，本 owner 代记）

- 均在真实旧运行实例（未重启任何进程）上完成。临时第一问成功：3 段 delta 复制回答逐字一致；最近列表仍仅原有 1 条持久会话。
- 错误恢复：夹具 error 503 时临时页显示安全文案「Provider 暂时不可用」；临时页没有专用重试控件，根把夹具恢复 success 后手动重新输入同一可见失败问题并发送，回答恢复——如实记为手动重发，不是一键重试，也不是复用持久会话 Retry API。
- 延迟中停止与继续：delay 8 秒临时请求进行中先编辑下一条草稿再点停止，UI 显示「回答已停止，以上内容可能不完整」，下一条草稿逐字保留且发送可用；立即发送该草稿成功，新回答复制仍逐字等于固定文本，旧延迟结果未污染。夹具日志序号 8→10，中间 #9 延迟请求无 200 完成记录，支持连接提前关闭（仅该受控本机服务上的观察，非抓包、非全取消矩阵）。
- 期间临时 UI 共 5 对气泡：3 成功、1 失败、1 停止。
- 存储隔离：整个临时 success/503/手动恢复/停止/继续/离页序列前后，六张聊天表完全一致——conversations=1、messages=4、runs=2、events=168、sources=0、summaries=0，`ai_task_runs`=0 未变。该基线含 R16 持久停止缺陷留下的 2 个 succeeded Run（未修不回写历史）；临时操作没有新增任何这些资源。
- 离页清理：再填一条未发送 TEMP 草稿 → 去知识模块 → 返回助手，所有 TEMP 标记/临时消息/草稿清空，最近列表仍 1。
- 边界与收束：临时流程通过不把 R17 尚未修复的持久 stop 算作通过，也不因临时通过升级正式 V3/完整 E2E/真实 Provider 结论；仍非真实模型评测。补记时根无活动请求或草稿；R17 正在根授权下更新本机 API+Worker，其候选与复验事实另记、不写本文件。DT-R16 至此补全，`docs/19` 写入 owner 随本轮结束释放。

### 根独立补验代记（纯验证，零产品改动；根提供事实，本 owner 代记）

- 日志字段抽查：本轮开始时真实 R13 API 71 条日志的字段仅 address/durationMs/level/method/msg/requestId/route/service/status/time；合成 owner 密码/TOTP、合成 Provider key、敏感查询标记与原文正文均未出现。仅本批日志检查，不泛称全安全审计。
- 本地 OCR（真实 18581）：自生成 1000x400/17KiB 双语 PNG，默认 chi_sim+eng 真实 Tesseract 与本站静态资源成功识别「开发百宝箱」中文字与 DEV TOOLBOX / LOCAL OCR TEST / 18581；原 OCR 输出在「开发」与「百宝箱」之间插了空白，手工校对后复制逐字一致；390 宽无横向溢出，实测主要按钮与原生 OCR 语言 select 高 44（不扩称全菜单）；未点击云重识别/翻译，隔离 API 日志 `POST /aliyun/*` 为 0；硬刷新后图片/校对结果消失且「开始识别」disabled，恢复视口后关闭该测试 tab。仅单张印刷合成样本，不宣称广泛 OCR 准确率或云能力。
- 边界与收束：非真实模型评测，未用云/付费/OSS/restic 资源，未跑全量/完整 E2E/正式验收，未 commit/push/部署，未改版本；未触碰 5199/18580/18581/18590/18591 既有进程与其他会话文件。DT-R16 记录完毕，`docs/19` 写入 owner 于本轮结束时释放（R17 不写本文件，其修复与后续流程事实待后续轮次代记）。

## DT-R17｜知识助手停止请求输给晚到完成的真实竞态修复（已完成，未提交；根审计真实 IAB 验收通过；本轮 1 主 + 2 子，本文件 owner 代记）

- 背景：R16 记录的已确认停止竞态缺陷（Run `d32c11a9-…`：stop_requested_at 早于 finished_at 却终态 succeeded 并显示完整回答）。两层修复，各对应真实职责：Go 在 complete 同一行锁/事务内尊重先落库的 stop；Worker 消费既有停止信号中止当前执行。未改心跳频率/推送框架/状态枚举/表/字段/HTTP 路径/错误码，不用前端隐藏成功结果。
- 实际文件（共 6 个）：
  - `apps/api/internal/assistant/run_terminal.go`：`completeRun` 在 `FOR UPDATE` 锁定 storedRun 并通过 lease 校验后新增 `StopRequestedAt != nil` 判定——stop 先落库时晚到 complete 终结 stopped（run 与 message 均 stopped、已流式写入的部分内容保留、lease 清空、error 置空、usage/timings 照写），响应 `status` 返回真实终态（succeeded/stopped，同一字段）；complete 先提交则 stop 按既有 409 `ASSISTANT_RUN_NOT_STOPPABLE`，成功不可追溯篡改。与同文件 `failRun` stopped 分支模式一致。
  - `apps/api/integration/v3_stop_race_test.go`（新增）：Stop→late complete 与 complete→stop 双向真 PG 回归。
  - `apps/ai-worker/src/assistant/runner.ts`：新增 `submitEvents()` 统一消费 events 响应 `stopRequested`（`emit()` 与 delta flusher 回调两路径），经 `RunHeartbeat.requestStop()` 复用现有取消域立即中止生成并在途 Provider 请求，失败沿既有 `normalizeFailure(stopped)`→`failRun` 语义（Go 端归 stopped），无新对外错误码；`completeRun` 调用点直接 `return completed.status`（根收窄：类型联合 `succeeded|stopped`，无可选链退路），`stopped` 时跳过标题/摘要成功维护且不走 failRun（lease 已随终态失效，避免二次失败）。
  - `apps/ai-worker/src/assistant/client.ts`：仅 `completeRun` 返回类型收窄为 `{ readonly status: 'succeeded' | 'stopped' }`（jsonRequest 本就解析响应体，请求不变）。
  - `apps/ai-worker/src/assistant/runner-maintenance.test.ts`：+1 个 DT-R17 describe 共 3 条行为回归（首个 events 响应 Stop→不发答案不 complete、answer 阶段 flush Stop→不 complete、complete 返回 stopped→无标题/摘要/二次 fail）。
  - `apps/ai-worker/src/assistant/context-usage.test.ts`：既有桩对齐 `mockResolvedValue({ status: 'succeeded' })`（原 undefined 桩与真实契约不符）。
- 严格成对使用的版本边界：内部 complete 的 stopped 终态是 API+Worker 成对语义，本修复必须两侧同换——旧 Worker 配新 Go 时，complete 返回 stopped 后旧 Worker 仍会先发标题/摘要维护 Provider 调用（Go 只能靠 `status='succeeded'` 条件阻止 title/summary 落库，拦不住其先行的模型调用）。不为此新增兼容层/端点。
- 验证（实际运行，不重跑未变输入）：
  - Go：两条真 PG integration 用例（仅 `dev_toolbox_dt_r06_test`@18590，harness truncate 该库，凭据从容器 env 读入内存不输出）红→绿——修复前 `late complete after stop must end stopped, got "succeeded"` 精确复现审计竞态；修复后 Stop→late complete 终结 stopped 且部分回答保留、complete→stop 保留 succeeded+409 NotStoppable；`go test ./internal/assistant/` 通过。根收窄仅涉 Worker 源，Go 源未再变不重跑，原最终候选构建（`/tmp/dev-toolbox-dt-r17/bin/api-server`）有效；runner.ts 顶部 `AssistantRunOutcome` 注释后续为纯注释修正，无复跑。
  - Worker：维护 14/14 + 受影响消费者（context-usage/runner-flusher/index）16/16 曾过；根收窄 status 联合/直接返回后维护 14 + context-usage 6 共 20/20 与 `npm run check`（tsc）通过。
  - 根 OCR 只解析文件/规则，定向审查 5 个初始文件 + 后续桩对齐，全部实际覆盖；不扩称全库评审。
- 本机隔离实例成对更新（根明确授权，无生产发布）：复用 R13 私有 launcher/config/secrets，`/tmp/dev-toolbox-dt-r13/bin/api-server` 替换为 R17 最终候选（旧 bin 备份同目录 `api-server.r13-pre-r17`）；顺序停旧 Worker 83364/83374 → 旧 API 71132（均优雅退出、端口释放）→ 启新 API PID **3167**（127.0.0.1:18591）→ 启新 Worker 父 **3183**/监听子 **3190**（127.0.0.1:18592，`worker.pid`=3183）。健康各一次：API 无认证请求 401（在线且路由/鉴权正常）、Worker `GET /health/live` 200。精确停止方式：先 `kill -TERM 3183`（tsx 连带 3190，若残留单独 `kill -TERM 3190`）再 `kill -TERM 3167`，只操作已知 PID、不端口兜底批杀。r13_test 数据/附件/master/internaltoken/TOTP、18593 夹具 85740、Web 18581/18580、PG 18590 及 5199 完全未动；未 initOwner、未迁移、未跑测试框架。
- 根新实例真实 IAB 验收（根提供事实，本 owner 代记）：
  - 竞态修复验证：Run `75ad8e0f-05a5-43b2-a9bf-19d515ef9833`，根先 SQL 确认 running/answer；started 23:57:06.127001Z、stop_requested 23:57:12.857150Z、finished 23:57:14.257282Z，最终 run+output 均 stopped、部分内容 50 字符保留、lease 清空/errorCode 空。夹具仍 delay 首字节 8s、完成 8.13s 早于 10s 心跳（旧实现该窗口必被心跳漏掉，由本次两层修复拦截）；UI 停止提示+Retry 出现；Provider #11 后直到根重试 #12 才有下一次请求（无停止后的标题/摘要维护）。
  - 停止后恢复：success 模式下真实点击「重试」，新 Run `7b3e7685-c89d-4672-b214-637ef74448bd` succeeded、retryOf 指旧 stop、同 input/output 消息 ID；旧 run 仍 stopped；UI 仅 3 用户+3 助手，copy 逐字等于固定文本。
  - 持久 error 503：Run `1fc2c7a8-1d2a-4ebf-a6d3-38cf877f9ddc` failed `ASSISTANT_PROVIDER_UNAVAILABLE`，UI 安全文案+Retry；恢复 success 后点 Retry，新 Run `4a1148f6-5d55-4c73-b15d-788875ec974a` succeeded、retryOf 与相同 input/output ID；UI 4 用户+4 助手、copy 完全相等；硬刷新默认新对话，明确重开既有会话后 4+4 保留，最新 copy 仍逐字固定文本。
  - R16 持久停止缺陷留下的坏历史 row（2 个 succeeded 基线）保留未修写，不回写历史。
- 边界与收束：验收时夹具 mode=success、无活动请求/未发草稿；仍合成夹具、非真实模型评测、非正式 V3 验收/完整 E2E；未 commit/push/版本号/tag/release；未访问付费/OSS/restic/生产。DT-R17 记录完毕，`docs/19` 写入 owner 随本轮结束释放，下一轮 R18 由新会话实施。

## DT-R18｜知识库不可用时 8K 模型多轮历史预算修复（已完成，未提交；根审计真实 IAB 复验通过；本轮 1 主 + 1 子，本会话即 owner）

- 背景：DT-R17 轮定位的已证实预算问题——r13_test 内合法合成模型 contextWindow 8192/maxOutputTokens 1024、未配置 Embedding（knowledgeState=unavailable，可一般交流）时，`apps/api/internal/assistant/internal_runs.go` 的 `buildClaimContext` 无条件预留 `MaximumRunSources*8192/3=21845` 来源 token，把 input 预算 4944 扣成 0，下一问丢弃全部历史与摘要。
- 修复（仅「创建时 KnowledgeState=unavailable」的已证实路径）：该类 run 本轮没有来源块，不再预留来源 headroom，预算留给摘要与历史；ready 路径的来源优先、min(budget) 封顶与既有容量校验/脱敏/摘要独立维护合同逐字不变。不改内部协议，Worker 无需跟换（R17 成对语义两侧已在位）；不改历史配对规则、表字段、检索架构，不做全量 RAG 预算改造。
- 实际文件（共 2 个）：
  - `apps/api/internal/assistant/internal_runs.go`（唯一生产改动，1 处 hunk；主 Agent 独占实施）：来源预留移入 `run.KnowledgeState == "ready"` 条件内，注释同步说明 unavailable 不预留的原因。
  - `apps/api/integration/v3_persistent_context_test.go`（新增；唯一子智能体 backend-builder 独占，不改生产/其他测试/文档）：`TestV3PersistentUnavailableKnowledgeKeepsHistoryBudget` 经真实公开 API → internal claim 真 PG 构造 8192/1024、unavailable 的一次成功问答（answer.delta → complete → summary 写入 applied=true）后下一问，断言 claim 保留上轮成功原文与当前问题，同一用例有意义覆盖能容纳的摘要，不造无需求矩阵。
- 分工纪律：主先读生产证据与 harness 入口后即启动唯一测试 owner，测试在旧实现上确认精准红后才放行生产 patch，再复跑绿；子结束即收束，无固定 review 流水线。
- 验证（实际运行，不重跑未变输入）：
  - 唯一真 PG 回归（仅 `dev_toolbox_dt_r06_test`@18590，harness truncate 该库，凭据从容器 env 读入内存不输出）：旧实现红 exit 1——`v3_persistent_context_test.go:203: knowledge-unavailable 8K claim dropped the whole successful history: summary=<nil> messages=[]`（setup 全绿：模型创建 201、两问 202、claim 200 且 knowledge.state=unavailable、events/complete 200、summary applied=true，唯一失败即目标断言）；patch 后同命令同库同 `-count=1` 绿 exit 0，两阶段间唯一变量为生产 patch。用例证明第二问 claim 的 context.messages 含第一问 user/assistant 原文、context.question 为当前问题、context.summary 含写入的 confirmedFact；测试正文不含 citation token，assistant 原文按原样进入断言。
  - 所属包单测：`go test ./internal/assistant -count=1` 通过（ok 3.753s）。
  - 单次构建：`go build -o /tmp/dev-toolbox-dt-r18/bin/api-server ./cmd/server` 一次成功。
  - 审查：根 OCR 只做文件/规则解析，随后对两文件人工定向审查无阻碍；仓库 26 个可评审文件中本轮生产仅 1 个，其余 25 个为已验旧改/用户文件跳过；新增测试被默认测试路径规则排除（default_path），根已完整读。
- 本机隔离 API 更新（根明确授权，无生产发布）：前置确认 r13_test 的 assistant_runs/ai_task_runs 无 queued/running/pending、pg_stat_activity 仅 idle 池连接无 active 查询/索引构建；确认 PID 3167 为我方 R17 API 且 18591 监听归属后 SIGTERM 停止并确认退出与端口释放；备份 `api-server.r17-pre-r18` 后替换为 R18 候选，沿 `/tmp/dev-toolbox-dt-r13/start-api.py` 原私有配置启动（未 initOwner/迁移/reset，r13_test 数据/附件/master/internaltoken/TOTP 全保留）；新 PID **7053**（127.0.0.1:18591）。健康检查仅一次：无认证请求返回 401。精确停止方式：`kill -TERM 7053`。Worker 3183/3190@18592、HTTPS Provider 85740@18593、Web 18581/18580、PG 18590 及 5199 完全未动。
- 根新实例真实 IAB 复验（根提供事实，本 owner 代记）：已有同一会话续发 DT-R18-HISTORY 合成问题，Run `8f9dd4b8-dc0c-4398-badd-db921a63a142` succeeded、knowledge unavailable、模型 8192/1024；UI 5 用户+5 助手，最新 copy 逐字等于固定 Markdown、草稿空。Provider 日志此前最后 #17，本次只新增 #18 流式成功，未复现旧 8K「每问首答标题维护」附加调用。这不是直接捕获上游正文——历史/摘要正确性以真 DB claim 测试为证，不宣称固定回复证明真实模型记忆；截图留在根工作目录，不新建证明材料。
- 边界与收束：仅修创建时 unavailable 的路径；ready 路径及「创建时 ready、claim 时降级 unavailable」的 run（降级判断在 buildClaimContext 之后）仍沿用旧的「最多 8 个最大来源」来源预留策略，本轮未验证实际 RAG 容量——预留偏大不等于 8192 窗口必然装不下实际来源，不可用容量事实泛化掩盖过度预留，留待后续真实索引/来源联调处理；不把全 RAG 预算称为已解决。未 commit/push/版本号/tag/正式验收，未访问付费资源。DT-R18 记录完毕，`docs/19` 写入 owner 随本轮结束释放；下一轮 R19（新会话）按根指示只做本机索引/来源代表联调。

## DT-R19｜本机合成 Embedding→自动索引→真实检索→引用来源代表联调（根真实 IAB 代表流程通过，零产品改动，未提交；本轮 1 主 + 2 子，本会话即 owner）

- 背景：R18 之后的测试环境与入口准备轮——在 R13 隔离环境（真实 Web 18581→Go API 7053@18591→真实 Worker 父 3183/子 3190@18592→HTTPS 夹具@18593，PG 容器 dev-toolbox-dt-r06-pg@18590 的 dev_toolbox_dt_r13_test 为真实 UI 数据）上打通本机合成 Embedding→自动索引→真实检索→引用来源的代表链路。零产品源码改动；不 commit/push、不改版本/正式验收、不加依赖、不真实云付费调用。r13 库此前 5 成功消息对（含历史 R16 坏 stop Run 保留），仅合成 Provider `dt-r15-fixture`/模型 `dt-r15-synthetic-model`（窗口 8192/maxOutput 1024），Embedding 一直未配置、由根本人经真实 UI 填写，子智能体不绕 UI 直接写 DB/API 配置。本轮 1 主 + 2 子（两子不再派生、各自独立 owner），主只协调结果与安全范围、不重读子链路。
- 子A（backend-builder，唯一写入 owner：仅 `/tmp/dev-toolbox-dt-r16/provider/server.mjs`，无仓库产品文件）：
  - 新增 `POST /v1/embeddings`：兼容真实 `generateEmbeddings` 的 `{model, input: string[], dimensions: 3}`，对每个 input 返回 `data[{index, object:"embedding", embedding:[1,0,0]}]`（非零有限固定 3 维），usage 固定合成值 12/12；dimensions≠3、input 非字符串数组或非法 JSON 返回 400 最小受控错误；不造通用向量模拟框架、不调任何外部资源。响应形状对照真实消费者 `apps/ai-worker/src/model-gateway.ts` 的校验逻辑（data 长度/维度/非零范数/usage 字段名）。
  - 来源块感知流式回答：仅当请求 messages 中实际存在含真实 sourceBlock 前缀（「以下是本轮检索到的知识库来源」，与 `apps/ai-worker/src/assistant/temporary.ts:373`、`runner.ts:648` 逐字对齐）与 `[[S` 标记的用户消息时，content delta 改为恰好 3 段「【DT-R19 合成引用验收】这是本机夹具固定内容，非真实模型结论。来源示例 [[S」/「1」/「]]。」，使 `[[S1]]` 跨 delta 边界；无来源块时 R16 固定 3-delta 文本逐字不变；非流式维持原响应、不虚构 S1；role/stop/usage/[DONE] 结构不变，无计时器/遥测。
  - 保留全部既有条件：18593 监听、原 CA/cert、success/delay(首字节 8s)/error(503)、无请求头/正文/密钥日志；日志仅新增 route=chat|embeddings|unknown 枚举标记。
  - 验证与进程：`node --check` exit 0；ps 核对 PID 85740 命令行为本 fixture 且为 18593 唯一监听者后精确 kill（exit 0），以原目录/CA/日志方式重启，新 PID **11645**（`provider.pid` 更新），mode=success，API 7053/Worker 3183→3190/Web 18581/18580/PG 18590/5199 未动。恰好 3 项严格 TLS 请求（`--cacert` 指向 fixture CA、假 Bearer）：① batch embeddings（2 输入）200、data 长度 2、index 对应、embedding 均 [1,0,0]、usage 存在；② 含来源块流式 3 段拼接逐字等于「【DT-R19 合成引用验收】这是本机夹具固定内容，非真实模型结论。来源示例 [[S1]]。」且 `[[S1]]` 跨段边界；③ 无来源块流式逐字等于 R16 原 fixed text。delay/error/非流式矩阵未重跑。设计边界：embeddings 不与 mode.txt 耦合（error 模式下仍 200）。根对 server.mjs 只读审核：loopback、固定 route 枚举日志无正文/headers、TLS 条件正确；PID 11645 保留。A 结束即释放 /tmp 脚本 owner；本机服务脚本、CA、pid 与日志按约保留。
- 子B（architect-auditor，只读：不写文件/不测试/不浏览器，不读 Provider/Embedding 协议）交付 8 条带定位事实（供根真实 IAB 引用验收）：
  - 正文内联引用契约为 `[[C{n}]]`（`/\[\[C(\d+)\]\]/u` 严格等值、前导零不匹配），不匹配则原样纯文本；`S{n}` 序号仅出现在抽屉 meta，不参与正文标记；链接文本内部标记不替换；复制回答按 citations 剥离全部 `[[C{n}]]`（`apps/web/src/modules/assistant/AssistantMarkdown.vue:42-48`、`AssistantMessage.vue:29-31`）。
  - 引用按钮 `aria-label="查看引用 {n}：{title}"`、可见文本 `[n]`（AssistantMarkdown.vue:43-48）；抽屉 `role="dialog"`+`aria-modal`、标题「来源详情」、关闭按钮「关闭来源详情」（`CitationDrawer.vue:67-78`）。
  - 调用链：AssistantMarkdown emit → AssistantMessage 组装 `{citation, messageId}`（:20-22）→ AssistantThread 转发（:209）→ `AssistantView.vue:29-55` `openCitation` → 持久会话 `GET /api/v1/assistant/runs/{runId}/sources/{n}` 按 `${runId}:${n}` 内存缓存；临时会话取本地 sources，缺失报「临时来源已不可用」（`assistantStore.ts:728-743`、`assistantApi.ts:168-171`）。
  - 标题 h3（CitationDrawer.vue:103）；摘录 blockquote + pre-wrap、空摘录回退「本轮没有可显示的摘录」（:117-120）；meta 显示来源类型/`S{sourceOrdinal}`/`startByte–endByte byte`（:122-128）。
  - 原始 vs AI 派生：标签「原始来源」/「AI 派生」（:100），AI 派生附 warning「AI 派生，未人工验证」（:104-106）；标题变更与来源删除各有专门提示（:107-115）。
  - CitationDrawer 及直接调用链（AssistantView/AssistantMessage/AssistantMarkdown）不存在敏感确认交互；敏感策略是发送侧契约 `SensitivePolicy`（`assistantContracts.ts:10,42`）。
  - 「打开原笔记」为原生 `<a :href="source.locator.href">`、仅 locator.href 存在时渲染，href 完全由服务端 DTO 提供（CitationDrawer.vue:132-136、`assistantContracts.ts:247-256`）；未用 RouterLink 也无 target/rel——站内路径将整页导航而非 SPA 路由，当时仅记代码现象未判定缺陷（根实测后按 §16 sessionStorage 合同不计为缺陷，见下）。
  - 可访问性与竞态守卫：抽屉打开聚焦关闭按钮、关闭焦点还原、Escape、Tab 焦点圈闭（CitationDrawer.vue:21-58）；加载态 `role="status"`+`aria-busy`、错误态 `role="alert"`+重试（:70,84-95）；`sourceRequest` 递增守卫防过期响应与关闭后竞态（`AssistantView.vue:39-64`）。
- 根真实 IAB 代表流程（根提供事实，本 owner 代记）：
  - 数据与配置：根经真实 18581 UI 建普通 note「DT-R19 合成检索验收」（item `4bfc718c-34de-42d7-a708-ac9971676f3e`、177B、无附件），初始活跃片段 8→本 note 后 10，未配置状态 ready 0。UI 独立合成 Embedding 填本机 `https://127.0.0.1:18593/v1`、模型 `dt-r19-synthetic-embedding`、维度 3、随机无权限合成 key（值永不入文档）；真实「测试连接」成功（9ms/3 维，usage 12/12 为固定合成值），测试后仍为未配置。保存先返回 409 并出现 `role=alertdialog` 的重建确认（不是保存失效；根最初误用 dialog locator 已纠正），显示 10 活跃片段/脱敏/每批最多 16；根点击确认重建并保存，Generation 1 enabled=true。真实 Worker 自动完成索引；SQL 只读确认 config ready/1/3/true，vector ready 10 且 `vector_dims` min=max=3；未手填向量、未跑测试 harness、未 TRUNCATE/迁移/reset。
  - 新会话首问（「只根据笔记查 DT-R19 回滚演练引用」）：Run `78d20705-0c12-4360-996f-e4a340424a17` succeeded、knowledge ready/evidence matched、真实固化 8 Sources、聚合 content 含 `[[C1]]`——夹具输出的模型侧 `[[S1]]` 经真实 Worker 跨 delta 组装、Go 固化 canonical 引用后映射为 `[[C1]]`，UI 正确渲染 `[1]` 按钮（accessible 名「查看引用1：DT-R19合成检索验收」），S→C 引用映射链实证闭合。抽屉：来源「原始」/sourceKind title、S1、标题与摘录均为「DT-R19 合成检索验收」、href `/items/4bfc718c-34de-42d7-a708-ac9971676f3e`；「打开原笔记」后按需读取 raw，复制全部逐字等于 177B 合成正文。
  - 会话与草稿：会话已真实重命名「DT-R19 合成索引与来源验收」；跳原文前填未发送草稿，返回后明确重开该会话，草稿逐字保留、1 用户+1 助手+引用仍在（符合 `docs/16` §16 sessionStorage 合同，不把普通 `<a>` 整页导航计为缺陷）；测试草稿已清空。
  - 键盘/移动代表实测：桌面 Escape 关闭并焦点回引用；390x844 视口下抽屉 390x844、pageWidth 390 无横向溢出，关闭按钮 44x44；ShiftTab 从关闭圈到原文链接、Tab 回关闭、Escape 关闭焦点恢复均通过；视口已还原。内联 citation 实测 desktop 28x28 / mobile 36x36——仅记事实，不冒称 40px 全部通过。
- 边界与收束：本轮不覆盖 AI 派生来源、敏感来源、已删除来源、临时会话 RAG、全部响应式矩阵；固定 3 维向量与固定文本只证明真实管道与 S→C 引用映射，不证明语义召回、模型准确性或计费统计，不扩称全 E2E/真实模型质量/正式验收。收尾时无活动请求或草稿；Embedding 现为 Generation 1 本机夹具启用、mode=success；API 7053/Worker 3183→3190/Web 18581/18580/PG 18590/5199 未动。R18 遗留 ready 路径来源预留问题未修、仍留 R20 候选；本轮新确认 P2（设置页索引状态不持续更新）单列 R21 候选，均见文末待处理。未 commit/push/版本号/tag。DT-R19 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R20｜持久知识问答按实际来源分配上下文预算（已完成，未提交；根审计通过；本轮 1 主 + 2 子，本会话即 owner）

- 背景：DT-R18 只修复「创建时 KnowledgeState=unavailable」的免预留；ready 创建（含创建时 ready、retrieval 时降级 unavailable）的 run 在 `buildClaimContext` 仍无条件预留 `MaximumRunSources*8192/3=21845`，合法 8192/1024 模型的 input 预算 4944 被扣尽，摘要与多轮历史全丢。DT-R19 已用真实 UI 启用本机 3 维 Embedding（Gen1 ready 10）并完成真实 8K 模型 RAG 首问代表验收（succeeded/matched/8 Sources、`[[S1]]` 跨 delta→`[[C1]]`→引用/原文闭环），但首问无历史参与，不证明第二问的历史预算正确。
- 实现（Go/Worker 统一既有估算口径：`ceil(utf8字节/3)`、每条历史 +4、每来源 content+title+8、summary 严格放得下才留、input 预算=contextWindow−maxOutputTokens−1200(system)−1024(安全余量)，Worker 侧为同值本地常量；不新增协议字段/表/依赖/feature flag，R17 停止语义保留）：
  - Go claim（`apps/api/internal/assistant/internal_runs.go` `buildClaimContext`）：删除 ready 分支固定来源预留（ready 与 ready 后降级同口径）；先扣当前问题，再保留放得下的结构化摘要，随后从新到旧装载完整 user-assistant 历史对（整对放得下才进、失败 Run 遗留的孤儿 user 跳过，不产生其问题被裁掉的孤立 assistant），历史 assistant 旧 canonical citation token 剥离；SummarySource 维护输入仍按完整历史计算，敏感扫描与历史存储/表字段/模型快照不变。
  - Go retrieval（`apps/api/internal/assistant/internal_retrieval.go` `trimSourcesToBudget`）：实际来源只与当前问题竞争剩余预算，claim 历史/摘要不再挤占来源；既有排名顺序、首个放不下即停、8 上限、Source 固化 ordinal 规则逐字不变。
  - Worker（`apps/ai-worker/src/assistant/runner.ts` `providerAnswerMessages`，只读选择不改 claim 原对象）：拿到实际 sources 后按同一预算先保当前问题与全部实际来源，再严格放得下才留摘要，再从新到旧保留完整历史对；sources=0（知识不可用/Embedding 失败降级）时按同口径保留可容纳历史；rewrite 请求仍使用 Go 有界的完整 claim 上下文不裁剪；summarySource 独立维护、标题 firstAnswer、脱敏与引用清理管道不变。
  - 实际文件（共 5 个）：生产 3（上述 Go 两文件 + runner.ts）＋测试 2（`apps/api/integration/v3_persistent_context_test.go` 在 R18 回归上扩展、`apps/ai-worker/src/assistant/runner-context-budget.test.ts` 新增）。
- 分工纪律：1 主 + 2 子（子A 独占 Go 两生产文件与 integration 测试，子B 独占 runner.ts 与新测试；文件互斥、子不再派生），主只协调契约、采纳两子实际验证并做唯一候选构建，不重读子链路；根审后主接管 Worker 测试文件做纯夹具机械收窄，生产源码零改动。
- 验证（实际运行，不重跑未变输入）：
  - Go（真 PG 仅 `dev_toolbox_dt_r06_test`@18590，经真实公开 API→internal claim/retrieval，凭据从容器 env 内存拼装不输出）：两条新 ready 用例在旧实现精准红——`knowledge-ready 8K claim dropped the successful history: []`、`third claim lost the stored summary`；改后同文件 3/3 绿（第二问 claim 含上轮成功原文与当前问题、`[[C1]]` 剥离经 DB 原文比对确认；第三问含摘要与两轮完整对；matched 下 2 来源按预算入位、ordinal [1 2]）；R18 unavailable 回归保留通过；`go vet ./internal/assistant/`＋`go build ./...`、`go test -count=1 ./internal/assistant/`、`TestV3HybridRetrievalReadyAndNotReady` 均通过。测试中 ready 来源由测试扮演 worker 传固定 4 维向量种子经真实检索固化，不是线上 Worker embedding——与下方根真实 3 维流程是两条不同证据链，不互相冒称。
  - Worker：原初 focused 3 红 1 绿中两条夹具本身不是 Go 能产出的合法 claim（summary 78＋两对 40＋问题 2=120>80、四对 80＋问题 2=82>80），该红数量不对应收窄后版本；其中合法的「大来源裁旧对」红证据成立。根审后主机械收窄夹具（summary 收窄为单个「结」31 token、zero-source 改三对 60＋问题 2、`evidenceState` `relevant`→真实 `matched`、`sourceKind` `note`→`raw_text` 并同步 sourceBlock 期待值），focused 4/4 绿 exit 0；夹具收窄前上述共 24（focused 4＋context-usage 6＋maintenance 14）与 tsc 已通过；末次纯 fixture 收窄只重跑 focused 4/4，其余 20 与 Go/check/候选均未重复。
  - 候选构建一次：`go build -o /tmp/dev-toolbox-dt-r20/bin/api-server ./cmd/server` exit 0（无基线构建、无 hash/校验和/证明材料）。
  - 根审查：OCR 只解析规则与文件；三生产文件人工定向审查无阻碍；2 个被默认测试路径规则 excluded 的测试文件已人工全读，其余旧改跳过——不扩大为全库审计。
- 本机隔离实例成对更新（根明确授权，无生产发布）：预检 r13_test 的 assistant_runs/ai_task_runs 无 queued/running、embedding config Gen1 ready 无 pending/running，并确认 7053=我方 API@18591、3183→3190=我方 Worker@18592 后：先 `kill -TERM` Worker 父 3183（子 3190 连带退出、18592 释放，worker 日志确认 SIGTERM 优雅停止）再停 API 7053（18591 释放）；备份 `/tmp/dev-toolbox-dt-r13/bin/api-server.r18-pre-r20`（沿目录既有 `r13-pre-r17`/`r17-pre-r18` 惯例）后替换为 R20 候选，沿原 `start-api.py` 私有配置（容器内存拼 DSN、原 master/internal token/attachments）与原 CA/token/env 的 `start-worker.sh` 启动，无迁移/reset/initOwner。新实例：API **31621**（127.0.0.1:18591）、Worker 父 **33071**/监听子 **33078**（127.0.0.1:18592，`worker.pid`=33071）。健康各一次：API `/api/v1/ai/providers` 未认证 401、Worker `/health/live` 200（如实说明：最初误测不存在的 `/api/v1/auth/me` 与 `/live` 得 404，不算健康通过）。Provider 11645@18593、Web 18581/18580、PG 18590、peer 5199 完全未动；r13_test 数据/Gen1 向量/附件/主密钥/TOTP/内部 token 全保留。精确停止方式：先按 PID/端口/命令行确认身份归属，再 `kill -TERM 33071`（连带 33078）、再 `kill -TERM 31621`。版本边界：成对换版后已闭合；旧 API bin 虽有备份，但「只替回旧 API、Worker 仍以 R20 源码重启」不是可用的成对回退——旧 Worker 候选并未保留，本轮不补造回退机制。
- 根真实 IAB 对照验收（根提供事实，本 owner 代记）：
  - 同一既有命名会话「DT-R19 合成索引与来源验收」（Gen1 本机 3 维 ready 10），换版前后各发同前缀问题「结合上一轮合成回滚演练继续，只根据笔记给出一个来源引用。」
  - BEFORE（旧 API 7053/Worker 3190）：Run `87436c12-0200-4bbe-9221-8971469648cb` succeeded/ready，phase 仅 embedding→retrieval→answer→finalizing，没有 rewrite——旧预留吃光历史后第二问退化为无历史形态。
  - AFTER（新 API 31621/Worker 33078）：Run `017aca5f-ad76-4c4f-92e0-356197bcadbf` succeeded、window 8192、ready/matched，phase rewrite→embedding→retrieval→answer→finalizing，8 Sources 且正文 canonical `[[C1]]`。
  - UI 现 3 用户+3 助手，最新回答 1 个引用按钮；最新 copy 逐字「【DT-R19 合成引用验收】这是本机夹具固定内容，非真实模型结论。来源示例 。」（引用标记已剥）；最新来源抽屉原始/S1/title，标题及摘录「DT-R13 合成磁盘巡检」，原文链接在。截图 `assistant-real-rag-followup-budget-fixed.png` 已根展示；抽屉关闭、草稿空。
  - 边界：Provider 固定向量/文本只证明真实历史 rewrite 路径、引用映射与容量逻辑，不证明语义召回、改写质量、真实 usage 或正式 V3 验收；辅助标题调用不等于 rewrite 阶段，不以请求总数代替 phase 证据。
- 边界与收束：R20 只解决「按实际来源分配上下文预算」这一已证实问题，不称全 RAG 预算或检索质量已解决。未 commit/push/版本号/tag/正式验收/付费调用；本机 CA/脚本/PID/log 按约保留不清理。文末 R18 遗留待办迁移为本节已完成，R21 待办保留（仍在返工，未记通过）。DT-R20 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R21｜Provider 设置页索引进度自动刷新修复（已完成，未提交；根审计与真实 IAB 验收通过；本轮单主实施，本会话即 owner）

- 背景：DT-R19 轮确认的 P2（文末原待办）——设置页确认启用重建后 UI 持续显示 Generation 1「重建中」pending 10/ready 0，而真实 Worker 与 PG 已完成 ready 10；`apps/web/src/modules/settings/ProviderSettingsView.vue` 仅 `onMounted`/`loadEmbeddingSection` 与保存/重试成功后 `refreshIndexData`，无后续订阅/轮询/显式刷新入口，根显式 reload 后才显示新值（reload 不是产品修复）。本轮单主独占前端局部修复，不派子；与并行 R20（Go/Worker 预算，1 主 + 2 子）文件无交叉。
- 实现（实际文件共 2 个）：
  - `apps/web/src/modules/settings/ProviderSettingsView.vue`（唯一生产改动）：新增 2 秒链式 `setTimeout` 轮询（复用 TaskCenterView 既有轻量模式：每轮完成后才排下一轮、串行无重叠），条件为 `status` 非 `disabled`/`unconfigured` 且（`indexing` 或 `pending>0` 或 `running>0`，不只看文字 status），终态即停；`onBeforeUnmount` 清 timer 并递增归属代次。统一归属：初始 `loadEmbeddingSection` 与 `refreshIndexData` 的成功、失败、调度全部服从同一 `indexRefreshSeq`——离页后晚到的初始结果不再写入/不再启动轮询，被更新刷新取代的旧轮询迟到失败不再冒假「自动刷新索引状态失败」。`refreshIndexData` 返回是否实际应用（boolean）：保存 409 的重建确认对话框仅在 fresh refresh=true 时打开，过期或失败不开旧数据确认框（不把失败吞成成功）。自动刷新只更新索引状态/失败列表，不重读覆盖 Embedding 表单/Key/测试连接草稿。
  - 失败分页兼容（根两轮返工后按「自动/手动刷新局部职责」收口）：同 generation 且列表已展开（>50 条）时自动轮询只更新计数、原样保留用户已浏览页与 cursor——语义是保留已展开快照，不称所有失败分页数据实时重取；列表未展开时自动刷新首页（新失败可见、重试入口有效）；新 generation 或用户明确刷新（保存/确认重建/重试片段/手动恢复）重置首页；已拉到末页又有新失败时失败区出现「有新失败 · 刷新列表」UiButton，由用户点击读最新首页，不借 POST「重试」代替刷新入口；列表重置代次（`indexFailureListSeq`）挡住迟到的 load-more 页追加到已重置列表；自动刷新失败有「刷新索引状态」手动恢复入口，成功即自动恢复轮询。未改 cursor 合同、未提高 limit、无通用轮询/分页框架。
  - `apps/web/src/modules/settings/ProviderSettingsView.index-polling.test.ts`（新增 focused 测试，fake timers 与既有 v3 真实计时风格分离，helper 自包含）。
- 验证（真实红绿记录，不把初期通过当最终候选；实际运行不重跑未变输入）：
  - 首轮 3 用例（pending→ready 免重载更新且终态停止、挂起轮询被更新刷新取代、错误恢复+草稿保留）实现前旧红 3 failed → 实现后 3 绿 + 既有 `ProviderSettingsView.v3.test.ts` 4 绿。
  - 根返工两个归属边界（初始 load 晚到 + 先 unmount、旧轮询迟到 500）：两新增旧红（2 failed 3 passed）→ 统一 seq 边界 + boolean 结果修复 → focused 5 + v3 4 绿。
  - 分页兼容：发现已展开 51 条被自动刷回 50、迟到 load-more 追加到重置列表两处回归，追加 3 例（其中「新失败 2→3 未展开自动更新」在旧实现本就绿，作为守卫防退化为永不更新列表）→ focused 8 + v3 4 绿。
  - 末页已展开 51 条 + 同代次 failed 51→52（pending 仍>0）仍被自动重置回 50 的组合：再补 1 例精准旧红（firstPageReads 2≠1）→「有新失败 · 刷新列表」收口后最终 focused 9 + v3 4 = **13 passed**、`pnpm check` exit 0，各仅一次。
  - 根 OCR 只做文件/规则解析，生产与默认排除测试均人工读；无全库/全 E2E 结论。
- 根真实 IAB 验收（根提供事实，本 owner 代记）：API 31621、Worker 父 33071/监听子 33078、HTTPS 夹具 11645、Web 18581、PG 18590 均未重启。在已配置 Gen1 ready 10 的真实设置 UI 只改公开模型 ID `dt-r19-synthetic-embedding`→`dt-r21-synthetic-embedding`（独立 Key 留空保持原值，baseUrl HTTPS loopback/3 维/enabled 不变）；保存返回 409 并出现正常 `role=alertdialog` 确认 10 个合成片段，点击「确认重建并保存」后 UI 立即显示 Generation 2 重建中 pending 10/ready 0；未 reload/未导航/未手工 SQL seed/未暂停或减速服务，自动变为 Generation 2 可检索 ready 10/pending 0/running 0/failed 0。截图 `embedding-index-auto-refresh-ready.png` 根已展示。边界：仅合成 3 维固定向量、真实 UI/API/Worker/strict TLS 管道，不证明真实模型语义或完整错误/51 条分页活体 UI；分页、旧响应归属与草稿保留由组件测试验证，不虚构活体验证；本轮唯一合成配置变化是 modelID，无新 key/凭据/付费调用。
- 边界与收束：未 commit/push/tag/版本号/正式验收/生产/外网付费；R20 历史 Gen1 证据按当时事实保留不回改。文末 R21 待办迁移为本节已完成，另留 R22 已证实在修事项（见文末）。DT-R21 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R22｜摘要工具文本修改后旧摘要与校验结论立即失效（已完成，未提交；根审计与真实 IAB 验收通过；本轮 1 主 + 1 测试子，本会话即 owner）

- 背景：R21 轮确认的 P2（文末原待办，R21 会话记录「R22 在修」）。根 18581 真实 IAB 复现：/tools/digest 文本输入 `abc` 计算得正确 SHA-256（3 B）并填入相同期望值显示「校验值相同」后，把文本改为 `abcd`（输入区提示已变 4 B）但不重新计算，页面仍展示旧 3 B 摘要、可复制、且仍判相同——`DigestToolView.vue` 文本 textarea 无输入失效逻辑，而模式/算法/文件选择变化均已触发 `resetResult()`。
- 实现（仅 1 个生产文件、1 属性最小改动）：`apps/web/src/modules/tools/digest/DigestToolView.vue` 文本 textarea 追加 `@input="resetResult"`，与本文件模式/算法/文件选择的既有 reset 惯例一致。输入一变即清旧摘要、旧匹配结论与期望值（沿既有 `resetResult()` 一致语义，不造平行重置变体），结果卡回空态、复制摘要禁用，不自动计算；重新计算不自动清期望值为既有行为保留。DigestRunner/Worker/算法/4 MiB 分块/取消/本地隐私合同零改动；运行中输入本已 disabled，未为不可达编辑竞态新增守卫/防御。
- 测试（新增 `apps/web/src/modules/tools/digest/DigestToolView.test.ts`，195 行 7 用例）：真实组件 mount；`vi.stubGlobal('Worker', FakeWorker)` 仅隔离 Worker 边界，DigestRunner/compareDigest/组件全真实，摘要期望值为内联公开向量 fixture 并断言 worker 实际收到的 request payload（kind/text/algorithm），不镜像算法。覆盖：改文本后旧摘要/「校验值相同」/复制按钮立即失效；显式重算得新摘要与 `SHA-256 · 4 B` 新字节数、重填新期望恢复「校验值相同」；模式/算法/文件选择既有 reset、取消计算后晚到 Worker 结果不覆盖（含 terminate 断言）、本地隐私空态提示防回归（4 MiB 分块合同仍由既有 `digest.test.ts` 覆盖，不重复测）。
- 分工与红绿（实际运行）：1 主（唯一生产 owner）+ 1 测试子（唯一测试文件 owner，不再嵌套）。子先行在未修复代码跑红 `pnpm exec vitest run src/modules/tools/digest/DigestToolView.test.ts` 1 failed/6 passed——失败即核心用例（改 `abcd` 后文本仍含 `SHA-256 · 3 B`、旧摘要与「校验值相同」、空态缺失），其余 6 例既有合同用例旧代码本就通过，精准旧红；主随后 1 属性修复，同命令 7/7 绿；既有 `digest.test.ts` 8/8。`pnpm check`（vue-tsc + tsc）首跑发现测试文件 `radio.element.checked` 类型错误（`VueNode<Element>` 无该属性），子 owner 按既有测试惯例改为 `(radio.element as HTMLInputElement)` 后重跑 exit 0——如实记录，不冒称一遍全绿。
- 常量机械更正（子结束后主接管测试文件单点修改）：初版 sha256(abcd) fixture `…f289571d…` 一字符错误，更正为公开向量 `88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589`（根已用 Node crypto 对固定公开 `abcd` 独立核对，主落改前亦本机核对一致）。Mock Worker 回放测试自带的 digest，错误常量本会自洽过绿、不证明算法正确性，该更正仅使 fixture 与真实公开向量一致、不涉及生产算法；更正后只重跑 focused 7 一次（通过），digest 8 与 check 输入无影响未重跑。
- 根审查：根 OCR 只做文件/规则解析——本轮 79 文件中 29 可审，生产 target 仅 1 个、其余 28 个跳过；默认路径规则 excluded 的新测试根已全读。不称全库评审。
- 根真实 IAB 验收（根提供事实，本 owner 代记，未重跑）：旧版复现——`abc` 算 3 B 并填相同期望后改 `abcd` 4 B，仍旧 3 B 摘要/可复制/「校验值相同」。更新后 reload 新模板同流程——`abc` 真 Worker 计算正确 `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`；编辑为 `abcd` 立即无结果、无相同结论、复制 disabled；显式重算得正确 4 B 完整 `88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589`，与 Node 独立向量相符；填写相同期望再显「校验值相同」、点击复制逐字相等。文件模式——切文件模式立即清文本结果；原生 file chooser 选根 4B 假文件 `/tmp/dev-toolbox-dt-r22-file-qa.txt`（内容 `abcd`），真 Worker 得与文本路径相同的 digest；清空后返回文本模式，DOM 确认 textEmpty=true/output 0/copy disabled。截图 `digest-text-change-invalidates-result.png` 根已展示，before 与 rerun 截图保留；不称大文件压力或全响应式验证。
- 边界与收束：未 commit/push/tag/发布/真实云/生产。R23 与 R24 分别见各轮记录。文末 R22 待办迁移为本节已完成；DT-R22 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R23｜本机合成整理候选 Provider 与真实整理任务链路代表验收（已完成，未提交；根审计与真实 IAB 验收通过，repo 产品代码零改动；本轮单主实施，R23 会话期间本文件由并行 R22 独占，事实由本轮 owner 补记）

- 背景：真实 UI/API/Worker/本机 HTTPS Provider 已验持久与临时知识问答，但知识模块「手动整理 → AI 任务 → 候选 Artifact → 人工核对」链路尚未用当前实例走完。本轮先有界读取 organize_record 生产调用链（`apps/ai-worker/src/task-runner.ts:570-613`、`apps/ai-worker/src/artifact-draft.ts:755-835`、API `promptVersionForTask`）确定 supportsTools=false 的真实出站 JSON 合同与准确 Draft 形状、S# 映射，再准备最小本机合成 Provider 能力供根 UI 验收；不新增产品功能、不跑长 E2E、不付费、不碰生产。
- 候选与识别合同（仅 /tmp 改动，仓库零改动）：`/tmp/dev-toolbox-dt-r23/provider/server.mjs`（唯一 /tmp 写 owner）基于 R16/R19 现役脚本，其余响应逐字不变，仅新增 organize_record 请求的精确识别——三个固定 production 标记缺一不可：system 消息含 `taskType=organize_record` 插值（task-runner.ts:588）＋直接 JSON 通道系统指令前缀（:586）＋用户消息受控上下文前缀（:602）；HTTP 实际为 stream=true（pi-ai openai-completions 适配器恒流式，命中时流式/非流式都返回固定内容）。固定 Draft：六根字段闭合、markdown+command 两个 blocks 均 sourceRefs=["S1"]、warning basis=model_knowledge、全文本标识「DT-R23 合成固定候选、非真实模型结论」。Go API 对 organize_record 固定 promptVersion=organize-v2；Worker `createModelTaskContext` 按 fragments 顺序发 S1..Sn（S1=claim.input.fragments[0]），物化仍走真实 normalize/materialize 与最终 ai-artifact.schema.json 校验。未新增任务类型、工具通道或通用 mock 框架；普通 chat、RAG 来源块、3 维 embeddings 逻辑原样保留；同路由 mode=error/delay 与严格 TLS、日志隐私继续有效。
- 根审与授权：根只读审候选 diff 及 task-runner.ts:570-613、artifact-draft.ts:755-835、API promptVersion，认可三标记精确匹配、S1 由真实 claim.fragments[0] 映射、未知/空 fragment 不是当前整理任务可达输入（不添理论防御）后，明确授权仅本机 Provider 成对文件/进程换版。
- 本机换版（其余服务零改动）：只读预检——保留库 `dev_toolbox_dt_r13_test` 的 `assistant_runs` 仅 succeeded=8/stopped=1/failed=1、`ai_task_runs` 为空，Gen2 embedding config generation=2/status=ready/enabled；确认 PID 11645（`node /tmp/dev-toolbox-dt-r16/provider/server.mjs`）为 18593 唯一监听且无活动连接 → `kill -TERM 11645` 约 1 秒优雅退出、端口释放 → 原脚本保留同目录 `server.mjs.r19-pre-r23` → 候选复制为原路径 `server.mjs`（`cmp` 字节一致，无 hash）以复用同目录 ca/mode → 沿原 Node 启动方式与日志追加重启，新 PID **50276** 仅监听 127.0.0.1:18593，`provider.pid`=50276，mode=success 保持；原 CA/Secret、Worker `NODE_EXTRA_CA_CERTS` 与 OS 信任零改动，未从 r23 路径直接启动（该处无原 ca/mode）。候选 `node --check` 既有一次通过、输入未变未重跑。
- 换版后恰 2 个严格 TLS 固定假探针（`--cacert` 原 CA、固定假 Authorization、只输出通过与计数）：①三标记真实 shape 的 organize Draft 流式请求——3 个非空 content delta 拼接可 JSON.parse、title 含标识、2 blocks 均 sourceRefs=["S1"]、finish stop，全部通过；②无来源块普通流式 chat——拼接文本与 R16 固定回复逐字节一致。embeddings/error/delay/RAG 矩阵未重跑。当前停止方式：先按 PID/端口/命令行确认身份为 50276 再 TERM（已停旧 11645 不是当前停止 PID）；API 31621、Worker 父 33071→监听子 33078、Web 18581/18580、PG 18590、peer 5199 均不重启。
- 根真实 UI 代表验收（根提供事实，本 owner 代记，未重跑）：既有普通 note item `4bfc718c-34de-42d7-a708-ac9971676f3e`（原人工标题「DT-R19 合成检索验收」、1 raw/0 附件/收件箱/无标签/普通，AI 版本初始 0；related 读取未勾、模型 `dt-r15-synthetic-model` supportsTools=false/contextWindow 8192/maxOutputTokens 1024、redact）。
  - ① 真实「开始任务」→ Task `14de8205-ca81-46f3-84ff-5423c9d8fc4f` succeeded → Artifact `169c6194-5ae8-46b8-a291-39f9a2d8299f` v1/current。UI 标题「DT-R23 合成固定候选（非真实模型结论）」、模型审阅完成与需人工核对标识、两个 blocks，命令 copy 逐字 `echo dt-r23-synthetic-organize-candidate`（未执行）；source S1 为真实 fragment UUID `43cce872-da52-5ff7-8875-8bf9c8448b84`，来源按钮切原始记录并 hit 定位，按需读取/copy 与 177B 原始正文逐字相等；人工标题此时仍原值。中途曾载到 R24 两次保存之间的开发 HMR 中间态致旧实例 undefined helper/VNode 异常，根 reload 稳定候选后重做来源跳转正常——以稳定复验为准，不计产品来源链缺陷，也不称首次全绿。
  - ② 失败与重试：根仅改私有 mode.txt=error 后真实再创建 Task `f26fdd1d-aef2-4c10-aa92-1ade4dae2093`，终态 failed `AI_PROVIDER_UNAVAILABLE`、无 Artifact、v1/原标题保留；mode 还原 success 后真实点「重试」→ Task `62589fe7-c111-4735-97c1-9f8a5f8f556d` succeeded/retry_of=f26…，新 Artifact `551ae06a-b2ce-40a9-878f-46e56632d1da` v2/current，旧失败 row 保留；累计 3 task/2 artifact，SQL 只读核对 UUID/status/retryOf/version。一次等待 2 版本控件过早超时后 fresh snapshot 已见 2 版本，未重复点 Retry；TaskCenter 筛本 item 显示全部 3/成功 2/失败 1/等待 0/运行 0，重试详情有原失败关联按钮，点开显示稳定码 AI_PROVIDER_UNAVAILABLE 与「Provider 暂时不可用」及可创建重试入口；根未再点重复 Retry。usage 120/48 为夹具固定值，不称真实 token 准确性。
  - ③ 版本切换与建议应用：真实 select v1→确认「设为当前」→v1 current，再 select v2→确认→v2 current；快速 v1v2v1v2 最终 selector 为 551a… 且 header 整理版本 v2（此组事实同时作为 R24 修复的代表 UI 证明）。应用建议初始全部 unchecked/提交 disabled，只勾标题、不勾目录与两个 tags，确认后人工标题改为「DT-R23 合成固定候选（非真实模型结论）」，收件箱/无标签/普通/1 raw/0 附件保持；按需原文 copy 仍逐字 177B 未变；hard reload 后新标题、两版本、v2 current 仍在；未作废/删除版本、未执行示例命令。截图 `ai-organize-title-only-original-preserved.png` 根已展示，v1 与 taskcenter 截图保留。
  - ④ 移动代表：390x844 应用弹窗实测 358x511.39/pageWidth 390、取消与提交 40 高、关闭 30x25.6875（低于最小命中区，转 R25），视口已清还原。
- 边界与收束：仅代表流程，不称全矩阵/大规模/真实语义/真实云/完整 E2E 或正式验收；收尾时本机 mode 已回 success、无活动 AI Task/助手请求（索引完成数量本轮未另查，不捏造新的 ready 计数）；repo 产品代码零改动，未 commit/push/版本号/tag/付费/生产。

## DT-R24｜ItemAIView 版本请求与动作归属竞态修复（已完成，未提交；根审计与代表 UI 证明通过；独立单主实施，本文件 owner 按根事实代记，不重审代码）

- 背景：R22 轮文末已证实在修事项（原待办）——`apps/web/src/modules/ai/ItemAIView.vue` 的 `loadArtifact` 无请求归属，版本 A→B 时 B 先成功、A 晚到仍可覆盖 B 的结果；action 又使用 `selectedArtifact.id`，可能对错误版本误操作。R24 独立单主实施，仅修版本请求/动作归属；ItemAI 轮询不在本轮范围、R25 亦不处理，仅 modal 键盘与焦点问题转 R25。
- 实现（生产仅 `ItemAIView.vue`，+30/−4）：局部 AbortController，每次加载先 abort 旧请求；`signal.aborted` 同时守 success/catch/finally，空 id/卸载作废；`selectedArtifactID` 变化清旧 detail 并关闭旧 confirm/apply；原 `loadArtifacts` 语义保留。
- 测试（新增 `apps/web/src/modules/ai/ItemAIView.version-race.test.ts`，266 行；3 例真实组件 deferred 用例在旧实现精准红→绿）：①晚到 A 不覆盖 B，且实际 invalidate mock POST 只有 B；②晚到 A 的错误不冒旧错、不清 B 的 loading；③旧 apply 弹窗在版本切换后关闭且无 POST。
- 验证（实际运行，不重跑未变输入）：既有 ItemAIView + m4-ai + m4-workbench 相关用例 7/7 绿；首跑 web check 发现测试 fixture itemId 可选/必填差异，补显式 itemId 后 check 与 focused 3 例复跑绿，其余 7 未重复——如实记录，不冒称一遍全绿。
- 根审查：OCR 只做文件/规则解析，81 个总文件中 30 可审，本轮 1 个生产 target、其它 29 跳过；新测试被 default_path 规则排除但根已全读，不称全库评审。
- 根实际 UI 代表证明：即 DT-R23 ③ 记录的事实——v1/v2 真实激活、快速 v1v2v1v2 后最终 selector 与 header 整理版本一致（551a…/v2）、v2 建议仅勾标题应用成功；强制乱序由上述 3 个组件测试证明，不把正常本机快速网络说成已强制乱序。
- 边界与收束：R24 只修版本请求/动作归属，不称所有 ItemAI 轮询或 modal 键盘都已修复。未 commit/push/版本号/tag/付费/生产。DT-R23 与 DT-R24 记录完毕，`docs/19` 写入 owner 随本轮结束释放；R25 按文末在修条目由新独立会话实施。

## DT-R25｜ItemAIView AI 建议弹窗键盘与关闭触控修复（已完成，未提交；根审计、组件测试与真实 IAB 验收通过；本轮 1 主 + 1 测试子，本会话即 owner，R24 结束后接手生产文件唯一写 owner）

- 背景：R24 轮文末在修事项（原待办，由 DT-R23 ④ 移动代表实测转来）——根稳定 18581 UI 实测：应用建议弹窗打开聚焦关闭按钮，按 Escape 仍开；从关闭 ShiftTab 焦点落到背景「原始来源 43cce872」按钮（`dialog.contains(activeElement)`=false）；390x844 下弹窗 358x511.39/pageWidth 390 不溢出，但关闭图标按钮实测 30x25.6875 低于最小命中区（根已手动取消弹窗，无 POST）。修复依据 `docs/05-UX-DESIGN-BASELINE.md` §9（Esc 关最上层弹层、关闭焦点回触发）、`docs/12-V2-TOOLBOX-UX-AND-STITCH.md` §11（dialog 锁焦点、手机 44 触控）与 W3C ARIA APG dialog-modal 模式（https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/）。只处理当前 AI 激活/作废确认与应用建议两个共用弹窗，不改其它组件/文案/轮询。
- 实现（按实际，生产仅 `apps/web/src/modules/ai/ItemAIView.vue`）：打开时局部记录 click `event.currentTarget` 为触发器；取消/关闭图标/遮罩/Escape/版本失效五个关闭入口统一走局部 `closeApplyDialog`/`closeConfirmDialog`，关闭后 `nextTick` 核验 `isConnected` 再回焦——触发器已随旧版本详情移除时只回当前组件仍在的版本选择器（单一真实工作流目标，无回退链/全局搜索）；卸载不抢其它路由焦点。两个 modal 以 `@keydown` 处理 Tab/ShiftTab 首尾环绕与 Escape；Escape 在 busy（POST 在途）时不关闭，不冒称撤回已发 POST。busy 变 true 且弹窗开着时重定位内部焦点；确认/取消全部禁用时用 `tabindex="-1"` 的 dialog 容器承接，focusable 为空时 Tab `preventDefault` 留在容器——在途状态焦点不跑背景。关闭图标 44x44（原 30x25.6875），仅本组件 CSS，不改 UiButton/全局样式，不新增依赖/框架。R24 的 AbortController/signal 成功/错误/finally 归属与版本变更清旧详情守卫保持不变。
- 测试与红绿（实际运行）：1 主（唯一生产 owner）+ 1 测试子（唯一测试文件 owner）。子先行新增 `apps/web/src/modules/ai/ItemAIView.dialog-a11y.test.ts`（真实组件 mount + 仅 mock fetch），3 用例在未修复代码全部旧红（红点：Escape 后弹窗仍含「选择要应用的建议」、ShiftTab 后 activeElement 仍是关闭按钮未环绕、作废 Escape 后弹窗仍开）；主最小 patch 后三直接文件 8 绿（dialog-a11y 3 + version-race 3 + ItemAIView 2）、`pnpm check` 首跑发现测试 fixture itemId 可选/必填差异，由测试 owner 补显式字段后 check 过。
- 根审返工（根指出两个真实可达入口，主同轮收口）：①版本切换 watch 在 DOM 更新前同步回焦旧版本「应用建议」按钮，该按钮随旧详情移除后焦点丢 body——`returnFocusToTrigger` 改为 DOM 更新后核验，触发器不在只回版本选择器；在 version-race 既有「换版本关闭旧 apply」用例仅补焦点断言，旧红 `expected <body> to be <select>`。②确认 POST 挂起时 busy=true 禁用当前焦点按钮，浏览器会把焦点挤到 body、focusable 为空致圈定失效——按上节 busy 重定位/容器承接处理；dialog-a11y 新增挂起作废确认用例（mock `hangActionPosts` 挂起 POST，不真正完成作废），旧红 `expected true to be falsy`（焦点停在 disabled 按钮）。两断言旧红 2 失败/既有 5 绿；收口后三直接文件 9 绿（dialog-a11y 4 + version-race 3 + ItemAIView 2）+ `pnpm check` 过，各稳定候选一次；不把初期 8 绿冒称最终通过，不重复未变其它测试。
- 根审查：OCR 仅做规则/文件解析，本轮生产 1 文件；两直接测试已人工读（新增测试默认 default_path 排除、既有版本测试补断言也全覆盖），其它并行旧改跳过，不称全库评审；先前快照 82 总 30 可审只作范围上下文，未补采数字。
- 根真实 IAB 验收（根提供事实，本 owner 代记，不重跑）：从 Home 完整导航进入既有合成 note 以载稳定模块，AI v2/current 与已应用 R23 标题保持。应用弹窗初焦关闭；初始未选标题/提交 disabled 时，关闭 ShiftTab→取消、取消 Tab→关闭；勾标题使提交 enabled 后，关闭 ShiftTab→应用所选建议、提交 Tab→关闭；按 Escape 弹窗消失且焦点回「应用建议」，未点击提交。再开作废确认：初焦取消，取消 ShiftTab→确认、确认 Tab→取消，取消 Escape 关闭并回「作废版本」按钮，未点击确认、无作废。390x844 下应用 dialog 358x511.39/pageWidth 390 无横溢、图标关闭实测 44x44（原 30x25.6875）；手机 Escape 关闭回应用建议。截图 `ai-dialog-mobile-44px-keyboard-fixed.png` 根已展示，指标已 clear 恢复桌面，所有 modal 已关。busy 挂起 POST 与版本失效回焦由组件测试证明，不虚构真实 HTTP 挂起 UI；仅桌面+390 代表验收，不称全矩阵/真实模型/完整 E2E/正式验收。R23 原文 177B/两 Artifact/三 task 无本轮额外业务提交，服务/模型配置均不动。
- 边界与收束：未 commit/push/版本号/tag/生产/付费。不泛称所有已发 POST 关闭后的所有工作流已全验，只记上述实际边界。文末 R25 待办迁移为本节已完成，另留 R26 在修事项（见文末）。DT-R25 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R26｜任务中心请求选择与离页轮询归属修复（已完成，未提交；根审计、组件测试与真实 IAB 验收通过；本轮单主实施，本会话即 owner，R25 docs19 收尾后分时接写本文件）

- 背景：根在本轮真实 TaskCenter 看到三条整理任务与重试链后定向读源码，确认三个最小组件复现的请求归属缺口（非全库审计）——`selectTask` 无归属：A→B 而 A 晚回可覆盖用户最后选的 B 并把 URL 回写 A，catch/finally 也能冒旧错或提前清 B 的 loading；`loadTasks` 列表返回后按 route.taskId/selectedTask 决定后台补选，用户点 B 但详情未返回、URL 尚 A 时晚到 poll 可抢选 A，旧列表响应亦可在重试/新刷新后覆盖新任务集合；`onBeforeUnmount` 只清当时 timer，loadState bootstrap 晚到仍可调用 loadTasks，在途响应晚到可重排 2.5 秒 timer 离页续请。取消/重试入口读 selectedTask，选择意图必须明确。
- 实现（按实际，生产仅 `apps/web/src/modules/ai/TaskCenterView.vue`，5 个 setup 局部变量各一消费者）：`disposed` 生命周期——`onBeforeUnmount` 置位，`loadTasks` 入口/响应后与 `selectTask` 入口/响应后统一拦截；`loadSeq` 列表归属——旧列表响应与旧错误晚到丢弃，不覆盖新集合；`detailSeq` 详情 success/catch/finally 与 URL 归属——非最新请求不写详情/URL/错误、不清新请求 loading；`selectionIntent` 最后选择意图——`loadTasks` 的 desired 以它优先于 route.taskId，用户点击不被 poll 抢回；`detailInFlightId` 避免 poll 在 B 详情在途时再选旧 A 或重发同意图请求。新增 `route.query.taskId` watch 只同步意图，保留已有深链接、状态筛选、在线监听、取消/重试/批量入口加载语义；R10 providersLoaded 缺模型提示与配置入口保持。未叠 Abort/epoch/fallback 框架，无新接口/store/依赖。
- 测试与红绿（实际运行）：新增 `apps/web/src/modules/ai/TaskCenterView.race.test.ts`（真实组件 mount + 仅 mock fetch + 固定假数据），初 5 用例在未修复代码全部真实旧红（晚到成功覆盖 B 并回写 URL、晚到失败冒旧错并提前清 B loading、后台 poll 抢选待 B、离页 poll 晚到续请、bootstrap 晚到离页启动读取）→修复后 5 绿；既有 TaskCenterView.test 2 + m4-workbench 3 + m4-ai 2 共 7 绿，`pnpm check` 过。
- 根审返工（根完整读两文件后发现两个真实可达入口，主同轮收口）：①`selectTask` 入口漏 disposed——cancel/retry/createBatch 的 POST 可在用户离页后返程，`loadTasks` 虽因 disposed 早返，紧接的 `selectTask` 仍发详情 GET；②`loadTasks` 在 await 详情后还须复核 disposed/seq 再排 timer。追加仅用现有 flag/seq 的两处守卫。测试增强原第一例而非铺矩阵：B 用 running 合法任务，A 晚到后详情与 URL 仍 B，实际 Vue 按钮点击取消、mock POST 只一次 B/cancel 非 A；POST 挂起先 unmount 再 resolve 运行中 cancelRequested，推进 10 秒无新增 list/detail GET——此为组件 mock API 动作对象证明，不是根真实后台取消。测试自纠如实记：原增强 mock 未计数致假绿、把合法已发生 GET 的基线误写 0，均已修正，不把那些计数当旧红证据；最终精确旧红 `bDetailCalls 2≠1` 成立后生产两入口 fix，最终 5 focused + 7 既有 + check 绿，稳定候选各一次。其它 4 用例原意保留（旧失败不清 B loading/旧错、后台 poll 不抢待 B、poll 晚到离页不再发请求、bootstrap 晚到离页不启动读取）。
- 根审查：OCR 只做文件/规则解析，快照 83 个总文件中 30 可审，本轮 1 个生产 target、其它 29 跳过；新测试被 default_path 规则排除但根已全读，增强首例及 helper/两处生产守卫也实际读，不称全库评审。
- 根真实 IAB 验收（根提供事实，本 owner 代记，不重跑）：从既有 ItemAI 完整 goto 稳定 TaskCenter，真实保留库 dev_toolbox_dt_r13_test，本机 API 31621/Worker 33071→33078/Provider 50276/Web 18581/PG 18590 等不重启，未创建/取消/重试任何新任务。直接 URL `/ai/tasks?itemId=4bfc718c-34de-42d7-a708-ac9971676f3e&taskId=f26fdd1d-aef2-4c10-aa92-1ade4dae2093`，初 header TASK f26fdd1d、Provider 暂时不可用安全文案、可创建重试入口均正确。3 真实既有任务不变：最新重试成功 62589fe7…、失败 f26fdd1d…、最早成功 14de8205…；依次点列表 latest→first→failed→latest，最后 header TASK 62589fe7 且 URL taskId 为 62589fe7-c111-4735-97c1-9f8a5f8f556d；hard reload 仍该详情，重试关联按钮 f26fdd1d 在。截图 `ai-task-center-selection-stable.png` 根已展示。仅本机正常网络代表切换/深链/重载；强制乱序、挂起 POST 跨离页、running 轮询停止由 5 组件测试证明，不虚构真实网络乱序/挂起 HTTP 验收，不冒称真实断网/浏览器后退等全路径都测过。根现已退首页，两个组件都卸载，无草稿。
- 边界与收束：R26 只修 TaskCenter 请求选择与离页轮询归属，不称所有浏览器历史或真实离线全量验证；与 R27 在修的 ItemAIView 自身生命周期不混称。未 commit/push/版本号/tag/付费/生产。文末 R26 待办迁移为本节已完成，另留 R27 在修条目（见文末）。DT-R26 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R27｜AI 详情（ItemAIView）离页轮询与异步续程修复（已完成，未提交；根审计与最终收口通过；本轮 1 主 + 1 测试子，本会话即 owner，R28 结束释放 docs19 后接写本文件）

- 背景：R26 轮文末在修事项——`apps/web/src/modules/ai/ItemAIView.vue` 离页后晚到响应仍在续程：onBeforeUnmount 仅清当时 polling timer 与 R24 详情 abort，初次任务 GET/已排 poll 在途时先离页，晚到 running 列表仍会排新 2500ms timer 持续请求；create/retry POST 晚到再排 800ms timer；cancel POST 晚到再 loadTasks；激活/作废 POST 晚到再 loadArtifacts 补读列表与详情（晚到 emit 因 Vue 卸载早退本就到不了父组件，未按缺陷处理）。本轮目标仅为组件离页后停止 UI 读取/调度/刷新通知，后端已提交 AI 任务继续执行，绝不补发 cancel。
- 实现（按实际，生产仅 `ItemAIView.vue`）：单一 `unmounted` 标记在 onBeforeUnmount 置位，与既有 timer 清理、R24 详情 abort 并存；在 `loadTasks` 入口（孤儿 2500ms 句柄）、任务 GET 响应后、Artifact 列表 GET 响应后、嵌套 `loadArtifacts(true)` 后重排 timer 前、create/retry/cancel/激活-作废 POST 响应后，丢弃离页晚到结果，阻止补读取或调度。不叠 Abort/epoch/fallback，无新机制/store/依赖/feature flag。
- 测试与红绿（实际运行）：1 主（唯一生产 owner）+ 1 测试子（先行独占新测试文件 `apps/web/src/modules/ai/ItemAIView.offpage.test.ts`，真实组件 mount + 仅 mock fetch + fake timers/deferred，结束后文件归主）。初 4 例旧红：初次任务 GET 晚到、轮询 GET 晚到、retry POST 晚到、作废 POST 晚到（红点均为超额 tasks/artifact GET 计数，基线取真实前置请求数）。根审补 2 例同文件旧红：不同 taskType（running 整理 + failed 审阅，不触发后端 AI_TASK_ALREADY_ACTIVE）挂载时重试成功覆盖旧 2500ms 句柄、作废成功后嵌套 Artifact 列表晚到补发详情 GET——新 2 旧红同为超额 GET 计数；emit 断言仅为现存合同守卫，不称 emit 被本轮修复（Vue 3.5.42 `emit` 对已卸载实例早退是现存保障，applySuggestions 未加重复 guard）。最终 4 文件 15 例（offpage 6 + 基础 2 + version-race 3 + dialog-a11y 4）与 `pnpm check` 在稳定候选各跑一次通过。
- 根审返工（根指出真实可达入口，主同轮收口）：①`loadTasks` 缺入口守卫——create/retry 的 800ms timer 覆盖仍在等待的 2500ms 句柄，卸载只清最新句柄；②作废 POST 挂载时成功后、动作后 Artifact 列表 GET 挂起时离页，晚到列表因 current 仍在显式 loadArtifact 补发详情 GET（R24 abort 拦不住新调用）；③纠正主「嵌套 await 后 hasActiveTask 恒 false」论断——轮询不设 busy，嵌套 loadArtifacts 期间用户创建/重试可把 queued 任务写入 tasks 使计算属性复真，离页后列表返回仍会排 2500ms timer；最终在嵌套 await 与重排之间复用同一标记补 1 行，未造第 7 例/矩阵。
- 根真实 IAB 代记（根提供事实，不重跑）：真实 18581 重新进入合成条目 4bfc718c，v1/v2 选择 label 与 header 一致；应用建议 Escape 关闭且 focus 回「应用建议」按钮；点击原始记录离开 AI 再回 AI，仍 2 versions/v2 当前/3 条 terminal 任务；未 POST 新任务/取消/重试/应用/作废，无真实云调用或业务数据改写。截图 `ai-detail-offpage-normal-path-fixed.png` 根已展示，此图仅 AI 入口正常画面，版本切换/回焦由实际 DOM 观察，不冒称图中可见所有详情；离页晚到与计数由组件模拟证明，不称真实 IAB 强制乱序通过。
- 边界与收束：保留 R24 版本请求/动作归属与 R25 modal 键盘/焦点全部合同；mounted 多 Artifact 列表竞态及其它在页竞态不在本轮。未 commit/push/版本号/tag/付费/生产/正式验收。文末 R27 在修待办迁移为本节已完成。DT-R27 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R28｜知识搜索空结果提示覆盖全部筛选条件（已完成，未提交；根审 1 行 diff 与真实 IAB 验收通过；本轮单主实施，本会话即 owner，R26 docs19 释放后分时接写本文件，R27 仍在独立会话实施、其完成节后续可插于本节前）

- 背景：根在真实 18581 UI 验证知识搜索与已有筛选，确认唯一 UX 缺口是空搜索结果提示只列「目录与标签过滤」，而日期/内容类型/敏感状态筛选同样可造成 0 结果，提示不准确。同轮验证的正确行为不改：人工标题已改 R23 的 note 仍可用原文 DT-R19 检索命中（raw 43cce872，2 条返回）；按文本+普通筛选仍 2 条是 `docs/03` L451 contentKinds 原始记录包含关系的正确结果（mixed 含 text 也命中、一个条目可中多个值，非互斥分类），不属筛选缺陷，不改数据/算法/类别模型。
- 实现（生产仅 `apps/web/src/modules/knowledge/WorkspaceView.vue`，1 行）：仅第 483 行空搜索结果文案「换一个字面词，或清除目录与标签过滤。」改为「换一个字面词，或调整筛选条件。」，保留「搜索不会解释布尔语法。」说明；结构、v-if、其余空态、样式、ARIA、API 与搜索匹配算法均未改，未新增组件/测试/依赖。
- 验证：根读 git diff 确认该文件仅此 1 行变化；纯文案未新增/重跑单元测试或全库 check（如实记录，不冒称这些未跑的检查通过）。
- 根真实 IAB 验收（根提供事实，本 owner 代记，不重跑）：从 Home 完整 goto `/knowledge`、查询 DT-R19、打开已有筛选、起始日期 2030-01-01 形成 0 结果，新说明精确可见，截图 `knowledge-search-date-empty-state-fixed.png` 根已展示；清除全部筛选恢复 2 条且 chips 消失，清除搜索后 query 为空、筛选按钮 disabled（现有合同仅查询时可筛，已有实现正确）。根核对 docs03 合同后修正最初 1 条的计数预期，未误改筛选逻辑/类别模型，也未造新 FilterDrawer；Root 原先预期 1 条的超时不作为产品缺陷或已过测试记。此为代表查询/过滤/空态/恢复验证，不称搜索语义召回质量/全矩阵/正式验收。已清掉日期/查询返回 Home，未写业务数据、未改配置、未发真实云调用。
- 边界与收束：R27（ItemAI 自身离页 UI 读取/调度/changed 续程，保持 R24/R25）仍在独立会话实施，文末在修待办保持，尚未根审不记完成，与本单行 WorkspaceView 改动不冲突；未扩其它候选或工具流水。未 commit/push/版本号/tag/发布/生产/付费。DT-R28 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R29｜Base64 转换上下文变化后的结果失效（已完成，未提交；根审与真实 IAB 验收通过；本轮 1 主 + 1 测试子，独立会话实施，R30 docs19 结束释放后本会话接写本文件，本节按时间线插于 R28 后、R30 前）

- 背景：结果新鲜度 UX 改善——Base64 编码算法本就正确，`base64.ts` 未动；缺口仅是转换上下文变化后旧结果/旧复制反馈/旧错误不失效（手动编辑输入、切换操作/变体、成功粘贴新输入后旧结果仍可见可复制，应再按执行才产生当前结果）。docs12:157 明确交换只交换输入与结果并保留当前模式、不自动连续执行，修复不得用 watch(input/operation/variant) 一刀切抹掉显式交换，也不改为自动切换方向。
- 实现（按实际，生产仅 `apps/web/src/modules/tools/base64/Base64ToolView.vue`，+13/−2）：本地 `invalidateResult()` 清 result/errorMessage/copyMessage，由 textarea `@input`、两个 fieldset `@change` 与粘贴成功程序赋值后显式调用；不用 watch/snapshot/epoch 框架。run/clearAll/swapValues 各清旧复制反馈（仅结果变化时清除，未重构 clipboard 定时器）；swapValues 仍互换双方值、保留 operation/variant、复制可用、不自动再执行，符合 docs12:157。
- 测试与红绿（实际运行）：1 主（唯一生产 owner）+ 1 测试子（先行独占新测试文件 `apps/web/src/modules/tools/base64/Base64ToolView.test.ts`，194 行，真实组件 + 真实 codec、未 mock transform，正常结束、无孙）。9 例 = 5 旧红（手动编辑后旧结果残留、旧复制反馈残留、旧错误残留、切换操作/变体后旧结果残留、成功粘贴后旧结果残留）+ 4 原已绿守卫（粘贴失败保留输入与旧结果、明确交换合同、UTF-8 显式往返、清空三项，守卫如实标注非旧红）。稳定候选组件 9 + 既有算法 5 共 14 例与 `pnpm -C apps/web check` 各跑一次通过。
- 根审：根完整读源码 + 9 例测试；OCR 仅 deterministic preview/rule；测试默认 excluded 但根实际读取；无外部 LLM 审查。
- 根真实 IAB 代记（根提供事实，不重跑）：18581 实测——「开发百宝箱🔧」标准编码/复制精确；追加新字后结果空、复制 disabled、旧反馈清除；切 Base64URL 清旧结果，显式 URL 编码等于 Node Buffer 参考；交换后 input=encoded、result=旧输入，编码与 URL 模式保留且复制精确；再切解码清旧结果，显式 decode 往返正确；真实按钮粘贴后 input 更新、旧结果空、复制 disabled；非法字符错误→编辑有效输入后组件 error-summary alert 消失、aria-invalid=false、显式解码正确。最初立即全局 alert 计数一次读得 false 系自动化噪声，已用组件 locator wait hidden 后精确通过，不作为产品缺陷，仅按上述最终受影响状态记录。清空并返回 Home，未云/API/业务写入。截图 `base64-input-change-invalidates-result.png` 根已展示。
- 边界与收束：R30 节保留其当时「R29 尚未完成」历史语义不改；R31 路由 scroll 仍独立实施未根审、不记完成；未新增在修清单、未扩其它工具。未 commit/push/版本号/tag/发布/生产/付费/正式验收。DT-R29 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R30｜首页与帮助入口说明对齐真实产品（已完成，未提交；根审 2 行 diff 与真实 IAB 验收通过；本轮单主实施，本会话即 owner，R27 会话释放 docs19 后接写本文件，R29 尚未完成、其完成节后续可插于本节前）

- 背景：根 18581 真实 IAB 确认中立工作台只有模块/常用工具入口，搜索与快速记录实际都在「知识与记录」，而 HelpView「工作台始终显示搜索框和“快速记录”按钮」与实际冲突；ModuleNav 工作入口侧栏边界句含「一期的数据与详情合同」内部期次/合同措辞。
- 实现（按实际，仅 2 行可见文案，无其它改动）：`apps/web/src/modules/help/HelpView.vue` 第 26 行保留 strong 眉题「可见入口优先。」，其后改为「进入“知识与记录”，可直接使用搜索框和“快速记录”按钮，无需记住快捷键。」；`apps/web/src/components/shell/ModuleNav.vue` 第 183 行改为「本地工具的输入与结果仅留在当前页面；知识记录可在资料库中保存与检索。」，只限定本地工具，不把翻译/云 OCR 说成本地不外发。HelpView 既存 V3 边界改动（R10 拆分）保留不回退；布局/样式/ARIA/路由/快捷键/其它眉题/其它模块零改动，未新增组件/测试/依赖。
- 验证：根读两文件 git diff 确认本轮增量恰为 2 行文案、原结构与其它文本不变；纯文案无新测试，未跑单测/全库 check/浏览器/服务，不称通过。
- 根 18581 IAB 代记（根提供事实，本 owner 代记，不重跑）：Home 新侧栏句精确可见；打开 Help「快速记录与搜索」主题，新说明精确可见；按全局导航进入「知识与记录」后实际搜索框与「快速记录」按钮均可见；已返回 Home，无数据/配置/云写入。截图 `home-product-language-fixed.png`、`help-capture-navigation-fixed.png` 根已保存且后者已展示。不把 Help 主题链接滚动说成通过：根另发现 Help hash 只改高亮不滚正文（target top 2113.656 / viewport 720 / shell 滚动 0），正由 R31 独立路由会话修复，R30 本轮只验证文案与实际入口。
- 边界与收束：R29（Base64）尚未完成待根审，不记已完成；R31 修复事实不写本文件。未 commit/push/版本号/tag/发布/生产/付费/正式验收。DT-R30 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R31｜路由滚动对齐 AppShell 主滚动容器并补 390 sticky 偏移（已完成，未提交；根审与真实 IAB 验收通过；本轮单主实施，独立会话实施，R29 docs19 结束释放后本会话接写本文件，本节按时间线插于 R30 后、待处理前）

- 背景：根 18581 真实 IAB 复现帮助页 hash 主题只改侧栏高亮不滚正文（目标 heading top 2113.656 / viewport 720 / `.shell__main`.scrollTop 仍 0）。根源定向：`apps/web/src/app/router.ts` scrollBehavior 返回 `{el}`/`{top:0}` 均走 Vue Router window 滚动（本地安装 vue-router 5.3.0 源码 `scrollToPosition` 最终 `window.scrollTo`），而 `AppShell.vue` 整个 shell `overflow:hidden`，`.shell__main` 才是唯一纵向滚动 owner（DESIGN.md:109），window 永不滚动；Home 清零系短页自然收缩，不能当成 window 实现正确。
- 实现（按实际，生产仅 `apps/web/src/app/router.ts` scrollBehavior，路由定义不变）：无 hash 直驱 `#main-content`.scrollTo({top:0})；hash 分支 `await nextTick()` 后 `getElementById(to.hash.slice(1))?.scrollIntoView()`；两分支均 `return false` 阻止 Vue Router 框架 window 滚动，滚动职责单一 owner。不新增 watch/observer/fallback 框架/平滑动画/持久化滚动。曾出现 async 推断 `Promise<boolean>` 类型拓宽不兼容，最终显式 `Promise<false | void>` 修好。
- 测试与红绿（实际运行）：新窄测试 `apps/web/src/app/router.scroll.test.ts`（115 行，真实 `createAppRouter` + memory history 真实导航 + 真实 HelpView/NotFoundView 与 `main#main-content` DOM 容器；jsdom 无布局，仅以最小 spy 观察 `scrollIntoView`/`scrollTo` 滚动入口，实际几何留根 IAB）。5 例 = 3 旧红（跨页 `/help#boundaries` hash、同页 hash 切换、普通无 hash 页回顶，旧实现下两入口均 0 次调用）+ 2 原已绿边界守卫（hash 目标不存在、shell 未挂载，如实标注非旧红）。最终 router.scroll 5 + 既有 router.v2 11 + AppShell.v2 2 共 18 例与 `pnpm -C apps/web check` 各跑一次通过。
- CSS 后续（初版桌面验收后根 390 实测发现 sticky 遮挡，根实机退回同一 owner 补齐）：仅 `apps/web/src/components/shell/AppShell.vue` 纯 CSS——私有 `--shell-compact-bar-height: 52px` 同源化 1279/599 两断点既有 `min-height: 52px`，并给 ≤1279 真实 scroll owner `.shell__main` 增设 `scroll-padding-top` 同源引用；保留原值 52 不改行为，无新 watch/observer/运行时测量/布局系统，desktop/contained/assistant 行为不变。纯 CSS 未重跑 18 例/check（它们不能证明该几何），几何以根最终 390 实测为准；注释按根事实由「自身高度」纠正为「最小高度」（52 是既有 min-height，390 真实 bar 含 padding/border 实际 height 61），仅注释不重验证。
- 根真实 IAB 代记（根提供事实，本 owner 代记，不重跑）：桌面 18581——末尾「产品边界」heading top 398.656 / shell 1715（旧 2113/0）、前部「快速记录与搜索」heading 117.562 / shell 441、普通 Home 回顶 scroll 0、从 Home 完整 goto `/help#tasks` 冷深链 heading 118.437 / shell 1557，均正常，无需为理论懒加载加轮询/MutationObserver/fallback。初 390 标题 117.953 被 bar bottom 125 遮 7px；最终真实 viewport 390×844（专用 tab 复验，非缩放伪截图）bar top 64 / height 61 / bottom 125，目标 section 131.906、眉题 152.906、标题 169.953，全部在栏下；抽屉关闭、Enter「快速记录与搜索」导航、focus 回帮助主题、无横溢出。额外既有 YAML native 跳到操作区实际文字 134、操作按钮 181，均在 bar 125 下；容器 rect 116 本身不当缺陷。未全尺寸/浏览器矩阵。临时 tabs 已关、viewport 恢复、主 tab 5 Home。截图 `help-topic-anchor-scroll-fixed.png` 与 `help-topic-mobile-sticky-offset-fixed.png`（后者根已展示）。不记录调试阶段截图缩放噪声，不冒称全站所有锚点或历史恢复验收。
- 边界与收束：根完整审 router diff、115 行测试与 CSS。R29/R30 历史节不改；R32（Regex）源码/12 测试已给出、正根 IAB 未收口，R33（YAML 负零）独立处理中，均不记完成。未 commit/push/版本号/tag/发布/生产/付费/正式验收。DT-R31 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R32｜正则工具输入或 flags 变化后旧结果与旧错误立即失效（已完成，未提交；根审与真实 IAB 最终收口通过；本轮 1 主 + 1 测试子，独立会话实施，本会话即实施与 docs19 owner，本节按时间线插于 R31 后、待处理前）

- 背景：根 18581 真实 Worker 一次运行证实——默认 pattern `(error|warning):\s+(.+)`、两行文本、replacement `[$1] $2`、flags gmu 得「共2个匹配·flags gmu」2 卡与两行替换预览；取消 g 后未重跑，界面仍 2 卡/完成 2 个，summary 立刻变「共2个匹配·flags mu」；显式重跑才得「共1个匹配·flags mu」1 卡。生产 summary 用当前 flagString 而旧 result 在编辑后不失效，属真实结果归属错误，非算法 bug。
- 实现（按实际，生产仅 `apps/web/src/modules/tools/regex/RegexToolView.vue`，7 增 1 删）：新增本地 `watch([pattern, text, replacement, flagString])` 置空 `result`/`statusMessage`/`errorMessage`，回到既有未执行空态；四个 watch 源精确对应既有 v-model DOM input/change 入口写入的状态（3 个文本输入 + 6 个 flag 经 flagString）。编辑不自动执行/重试、不调 runner；运行期这些字段与清空已有 disabled，不构造不可达「运行中编辑」race；不新 snapshot/epoch/抽象，不改 RegexRunner/Worker/500ms 超时/500 条显示上限/取消语义。
- 测试与红绿（实际运行；1 测试子独占组件直接回归测试、无孙、已正常结束）：新窄文件 `RegexToolView.staleResult.test.ts`（173 行，真实 mount 组件、仅 mock runner 返回受控结果，不 mock 失效逻辑本身）5 例 = 4 旧红（flags 旧结果归属、pattern/text/replacement 三输入失效、旧错误恢复、编辑不自动执行且显式重跑出新结果）+ 1 原已绿运行禁用守卫；初跑 `4 failed | 8 passed (12)`，主修复后新 5 + 既有 500 上限 1 + `regex.test.ts` 算法/Runner 6 共 12 例与 `pnpm -C apps/web check` 各一次通过；既有 500 上限与运行禁用合同只作守卫未称旧红。
- 根审与真实 IAB 代记（根提供事实，本 owner 代记，不重跑）：根完整读生产源码与新测试并以确定性 OCR 复核，默认被 excluded 的测试已手读。根 18581 真实 Worker IAB：gmu 默认 2 匹配；仅取消 g 后即回空态（0 卡、无完成状态、不自动执行），显式重跑得 mu 1 匹配；编辑替换模板清旧预览，重跑出真实新预览 `<error> connection failed` 与 warning 剩余行；编辑测试文本清结果；无效 pattern 报真实 Worker 语法错误，改为有效 pattern 后旧错消失、显式运行得 `<warning> fresh`；清空 3 输入、回 Home。截图 `regex-flags-change-invalidates-old-matches.png` 根已保存（根将展示）。不冒称真实 500ms 灾难性超时/取消矩阵已验证。
- 边界与收束：R33（YAML 负零）当时由另一独立会话处理，本节不代记其完成（见后续 DT-R33 节）。未 commit/push/版本号/tag/发布/生产/付费/正式验收。

## DT-R33｜YAML bigint 分支负零与原始数值词法保留（已完成，未提交；根审与真实 IAB 最终收口通过；独立新会话单主实施，根代记事实交本 owner 记录、不重审代码，本节按时间线插于 R32 后、待处理前）

- 背景：YAML→JSON 的 bigint 分支旧实现把 `-0` 也交 BigInt 规范化，输出丢负号，违反 docs/12 §6.8 数字保留大整数/高精度原始词法的合同；旧宽泛测试断言被日期 `2026-08-31` 中的 `-08` 子串满足，未暴露该缺陷。
- 实现（按实际，仅 `apps/web/src/modules/tools/yaml/operations.ts` bigint 分支，5 增 1 删）：复用同函数 number 分支既有 `node.source` + `isNumber`——合法 JSON 数值词法（含 `-0`）原样保留，其余非 JSON 词法（hex/octal 等）继续 BigInt 规范十进制；不新数值机制，不改 number/浮点/日期/Worker 协议/UI。
- 测试与红绿（实际运行）：`operations.test.ts` 9 增 1 删——把宽泛 `contains(-0)` 精确为 negative 字段断言，旧实现实测 `1 failed / 12 passed`（输出 negative 丢失，旧红证实）；新增 1 例最小 hex `0x1F→31` / octal `0o17→15` guard；最终 operations 14 例（13 原有含精确断言 + 1 guard）及 `pnpm -C apps/web check` 通过。
- 根审与真实 IAB 代记（根提供事实，R32 owner 代记，不重跑、不重审代码）：根已读完整变更并以确定性 OCR 复核规则与选取，测试被 excluded 仍手读。根真实 390 CM6 + 真实 Worker 多文档 YAML→JSON 复制验证：negative 字段经严格 regex 证明 `-0` 保留；大整数 `9007199254740993` 与 `1.2300` 原始词法、日期字符串、按顺序数组、hex `31` / octal `15` 均正确；转换前后用相同 DOM 读取精确比较，原输入未变。截图 `yaml-mobile-negative-zero-preserved.png` 根已保存（根将展示）；临时 tab 10 已关闭、viewport reset、主 tab 5 回 Home；未云/API/业务写入。
- 边界与收束：R34（帮助指引）独立进行、未验收，不记完成；历史 R31 节「R32/R33 未收口」为当时语义，保持不改。未 commit/push/版本号/tag/发布/生产/付费/正式验收。DT-R32/R33 记录完毕，`docs/19` 写入 owner 随本轮结束释放。

## DT-R34｜帮助页新增知识助手与引用上手指引（已完成，未提交；根审与真实 IAB 最终收口通过；独立新会话单主实施，本会话即实施与 docs19 owner，本节按时间线插于 R33 后、待处理前）

- 背景：Help 侧栏 7 主题只覆盖旧模块流程，知识助手仅在产品边界一句提及，缺「配置索引 → 提问 → 看来源」的可执行用户指引。
- 实现（按实际，生产仅 2 文件约 11 新增行）：`apps/web/src/modules/help/HelpView.vue` 新增静态 `#knowledge-assistant` section（复用 `help-section`/`help-list`，aria-labelledby `assistant-title`，4 段），置于快速记录与搜索之后、本地工具之前；`apps/web/src/components/shell/ModuleNav.vue` 帮助主题加对应 `/help#knowledge-assistant` 链接。旧 R30 入口说明与既有 V3 边界全部保留，零新脚本/CSS/依赖。内容据 docs16 与实际 Assistant 入口：启用 Provider/配置 API Key/至少启用一个聊天模型；知识库 Embedding 与索引状态（「知识库当前不可用」≠「没有相关内容」）；启用后新增/更新合格笔记自动发该 Embedding Provider，启用前核对接收方与全局敏感策略；当前提问、实际进入上下文的历史消息与检索片段按策略发聊天 Provider；从「新对话」确认模型/思考档位后提问；行内引用开来源抽屉核原文、AI 派生来源未人工验证、无引用一般补充不作笔记事实；临时会话仅当前标签页内存，但消息与检索片段仍送所选 Provider 并受其保留政策约束。
- 根返工（仅静态措辞，无功能改动）：删新增 section 英文眉题 `V3.0 ASSISTANT`（DESIGN 不默认英文眉题且任务不展示 phase，保留 div+h2 与 sparkles）；strong 导语「外发内容需要确认」改「核对外发范围」，避免暗示每次提问都有确认弹窗；第二段改「提问、实际进入上下文的历史消息与检索片段…」明确当前提问也外发；首句按源合同校准补齐「启用 Provider、配置 API Key，并启用至少一个聊天模型」真实前提（AssistantView 无模型引导）。
- 验证边界：纯静态内容未新增镜像字符串单测、未跑全库 check，不称通过；由根实际 Vite 页面编译显示与 DOM/锚点审查。
- 根 IAB 代记（根提供事实，本 owner 即实施会话，不重复运行）：桌面链接 href/id/aria 一致，4 段及关键前提/外发/保留声明准确可见，标题 top 100.625；真实 390×844 帮助主题内 Enter 新链接后 drawer 关闭、focus 回帮助主题，标题 153.453 > bar 125，无横向溢出，4 段完整在 DOM 且画面清晰。无新问题/会话/配置/索引/云或业务写入。截图 `help-knowledge-assistant-guide-desktop.png` 与 `help-knowledge-assistant-guide-mobile.png`，桌面根已展示；临时 tab 12 已关、viewport reset、主 tab 5 回 Home。该验收不重新证明 RAG 语义质量，亦非付费评测。
- 边界与收束：R35 由独立会话完成（见后节）；R36 README 介绍/入口独立进行尚未根审，不记完成；R31–33 历史节为当时状态，保持不改。未 commit/push/版本号/tag/部署/生产/付费/正式验收。

## DT-R35｜YAML 390 结果标题被复制反馈与快捷导航挤压（已完成，未提交；根审与真实 IAB 最终收口通过；独立新会话单主实施，根代记事实交本 owner 记录、不重审代码，本节按时间线插于 R34 后、待处理前）

- 背景：390 视口下 YAML→JSON 结果 pane 的标题被复制反馈与快捷导航挤压，换行成「JSON 结/果」。
- 实现（按实际，仅 `apps/web/src/modules/tools/yaml/YamlView.vue` scoped CSS，2 新增行）：`.heading > span { flex-shrink: 0 }` 及 1 条注释；压力由既有 pane-actions `flex-wrap` 吸收。保留原 label/input、复制能力与桌面双栏；script/template 及其它轮 `outputSourceInput` 等原样，未改 operations/共享组件/其它模块，未造 fixed width/缩字/新布局体系。
- 验证边界：纯 CSS 修复未新增/跑单测/check（无法证明几何）。
- 根审与真实 IAB 代记（根提供事实，不重跑、不重审代码）：1280 两 pane 均可见，YAML 输入/JSON 结果 height 21.6875、line-height 21.7 均一行，无横向溢出；真实 390 复制前与「已复制」后 JSON 结果均 height 21.6875/line 21.7/width 69.9375，header client=scroll=334，无全页横向溢出，快捷链接可见，切回 YAML 输入仍一行。截图 `yaml-mobile-heading-copy-feedback-fixed.png` 根已展示，桌面另存；临时 tab 11 已关、viewport reset、主 tab 5 回 Home。不称全尺寸/全部主题字体/浏览器矩阵。
- 边界与收束：R36 README 介绍/入口独立进行尚未根审，不记完成；历史各节当时语义不改。未 commit/push/版本号/tag/部署/生产/付费/正式验收。DT-R34/R35 记录完毕，`docs/19` 写入 owner 随本会话结束释放。

## DT-R36｜README 产品介绍与使用入口对齐当前三模块（已完成，未提交；根最终收口通过；独立新会话单主实施，本会话即实施，本节按时间线插于 R35 后、待处理前）

- 背景：README 开头介绍仍停留在「起步/第二期已确认」历史口径，未反映知识与记录、工具箱、知识助手三模块并存现状。
- 实现（按实际，仅 `README.md` 两处）：开头介绍一段对齐现状——个人自托管、三平级模块、原始记录与附件不可变且不被覆盖、AI 整理只生成独立的可追溯可重建派生候选、工具默认本地与 JSON AI 类型生成/机器翻译/云 OCR 等在线增强需配置并按界面确认、助手支持一般交流或知识库问答/引用；V3 说明后新增 13 行「使用入口」块（`/knowledge`/`/tools`/`/assistant`/`/help` 及 `/help#knowledge-assistant`）并附指向本文件的相对链接，明示不改变部署与正式验收结论。
- 根收口语义校准（两轮微调，仅措辞不扩段）：AI 派生候选限定为 AI 整理产物并强调原始事实不被覆盖；「翻译、OCR 等云能力」改「JSON AI 类型生成、机器翻译与云 OCR 等在线增强」（明确云 OCR，非默认本地 OCR）；助手改「支持一般交流，或基于知识库问答并查看引用」。
- 验证边界与收束：V1/V2/V3 历史版本、发布日期、部署/候选与正式验收、构建/备份命令原样；README 既有 Node/pnpm 改动非本轮、未回退。根定向 diff 并核对既有路由/`knowledge-assistant` 锚点/文件链接存在；纯文档未跑单测/check，不称通过。未 commit/push/版本号/tag/部署/生产/付费/正式验收。

## DT-R37｜ModuleNav compact 抽屉补各模块共用帮助 footer 导航（已完成，未提交；根审与真实 IAB 最终收口通过；独立新会话单主实施，根代记事实交本 owner 记录、不重审代码，本节按时间线插于 R36 后、待处理前）

- 背景：窄屏 ModuleNav compact 抽屉缺帮助入口，各模块共用 footer 需补一条 compact 帮助链接。
- 实现（按实际，仅 `apps/web/src/components/shell/ModuleNav.vue` 5 新增行）：各模块共用 compact 帮助 footer 导航（aria「帮助与使用指引」），RouterLink `/help` + 既有 circle-help 图标；复用既有关闭/焦点/Tab 闭环，无新脚本/响应式/组件；桌面 v-if 不渲染。一次 `pnpm -C apps/web check` 通过，无镜像单测。
- 根审与真实 IAB 代记（根提供事实，不重跑、不重审代码）：真实 1280 Header 帮助 1、footer 0（v-if 不渲染）；真实 390 抽屉 5 链接含 footer，链接 267×44，末项 Tab 到关闭、首项关闭 ShiftTab 回 footer，Enter 进 `/help` 抽屉关闭且焦点回帮助主题，帮助主题再 Enter 知识助手新指引成功；真实 1024 Header 帮助仍可见且 footer 可用，Enter 同样关并回焦，无横向溢出。截图 `mobile-help-entry-fixed.png` 根已展示、`tablet-help-entry-fixed.png` 已存；临时 tab 14 已关、viewport reset，无业务/Provider 写入。
- 边界与收束：不称全部尺寸/浏览器矩阵。未 commit/push/版本号/tag/部署/生产/付费/正式验收。

## DT-R38｜AppRail AI 任务图标与助手区分（sparkles 改既有 clock）（已完成，未提交；根审与真实 IAB 最终收口通过；独立新会话单主实施，根代记事实交本 owner 记录、不重审代码，本节按时间线插于 R37 后、待处理前）

- 背景：AppRail 中 AI 任务与助手同用 sparkles 图标，窄屏下不易区分。
- 实现（按实际，仅 `apps/web/src/components/shell/AppRail.vue` 1 行）：AI 任务 icon 由 sparkles 改为既有 clock，助手保持 sparkles；名称/title/to/active/模板/styles 全部原样，无新 SVG/依赖。一次 `pnpm -C apps/web check` 通过。
- 根真实 IAB 代记（根提供事实，不重跑、不重审代码）：真实 1280 DOM 助手 sparkles→`/assistant`、任务 clock→`/ai/tasks`，原名/title 正确；真实 390×844 相同且各 40×44，页面无横向溢出；截图 `mobile-assistant-task-icons-distinct.png` 根已展示。临时 tab 15 已关、viewport reset、主 tab 5 回 Home，无动作 POST/云调用；不称全部尺寸/浏览器矩阵。
- 边界与收束：R36/R37/R38 均已完成未提交；根随后将独立只读验证一个真实正则超时恢复，该项尚未执行、不记通过。未 commit/push/版本号/tag/部署/生产/付费/正式验收。docs19 写入 owner 随本会话记录完毕释放。

## DT-R39｜首页补齐知识助手第三模块主入口（已完成，未提交；根审与真实 IAB 最终收口通过；独立新会话单主实施，本会话即实施，R36 会话释放 docs19 后接写本文件，本节按时间线插于 R38 后、待处理前）

- 背景：导航与 README 均已有三平级模块，首页 `module-choices` 只有 /knowledge 与 /tools 两卡，缺知识助手可发现主入口。
- 实现（按实际，仅 `apps/web/src/modules/home/HomeView.vue`）：复用 module-choice 新增 `/assistant` 知识助手卡，既有 sparkles 22 图标与 chevron-right 16，同 body/strong/描述/action 结构，操作「打开知识助手」，说明「与模型交流，或基于知识库问答并查看引用；内容发送给所选 Provider。」；Intro 仅首分句改为三模块平级进入，其余本地/翻译与云 OCR 确认句、privacy 边界与快捷工具徽标原样；base 改 `repeat(3, minmax(0, 1fr))`，既有 899 断点改单列并删 599 重复声明；根代表画面发现同排操作行不齐后，仅补 `.module-choice` `grid-template-rows: auto 1fr`，复用 action 既有 `margin-top: auto` 贴齐卡片底边。无新组件/script/路由/API/依赖。
- 验证与根真实 IAB 代记（根提供事实，不重跑、不重审代码）：纯静态入口未新增单测/check，不称通过；根做真实 Vite 编译与 DOM。稳定最终 CSS 在 390×844、768×1024、1024×768、1440×900、1920×1080、CSS 3840×2160 全部 page/section/body 无横向溢出；≥1024 三卡同排同高且操作 bottom 齐，768/390 单列；1440 深浅代表态正确、动作 bottom 均 465.125；390 卡 358×172.875、正文宽 250 无溢出，Tools 卡 Tab 到 Assistant 且 focusVisible，Enter 实际 URL `/assistant`（仅入口导航，不称模型/问答已验）。截图 `home-three-modules-desktop-dark.png` 根已展示、desktop-light 与 mobile-keyboard 另存；临时 tab 16/17 已关、viewport reset、dark 恢复、主 tab 5 Home。不称全部尺寸/浏览器矩阵。
- 同期独立只读验证（无新 round/生产改动）：根真实 Regex Worker 单个 1001B 合成回溯输入 `(a+)+$` 加 1000 个 a 后接 !，出「表达式运行超时，Worker已终止」，pattern/text/run 恢复可用；显式普通（warning）重跑得 1 match 及 `<warning>: fresh after timeout`；随后清空回 Home。截图 `regex-real-worker-timeout-recovered.png` 已展示。不称精确 500ms/取消/flags 或 size 矩阵；R38 节「后续待验」为写时历史不回改。
- 边界与收束：R40 仍进行中，不记其它未最终结果，未重跑任何检查。未 commit/push/版本号/tag/部署/生产/付费/正式验收。docs19 写入 owner 随本会话记录完毕释放。

## DT-R40｜本地 OCR Worker 生命周期与旧资源串行清理（已完成，未提交；根审源码与真实 IAB 最终收口通过；原测试子停止后单主完成，事实由根审定）

- 产品变化（`tesseractWorker.ts` 与 OcrTranslateView 接线）：同步登记动态 import＋创建＋旧终止等待的 Promise，旧资源清理串行化；`OcrWorkerLease.release` 以既有代次保护，旧 finally 不清新进度、不排新 idle；旧创建续体不回写新 sink，logger 以当前创建 Promise 校验物理资源来源；View 只接 lease 并在 finally 释放。SDK 初始化完成前不暴露 terminate 句柄，取消语义为句柄可用后立即终止，不是瞬时物理取消。
- 验证（实际运行）：生命周期 10 条（受控 Promise 与 fake timers 交错）＋既有 OcrTranslateView 10 条＝20/20。
- 根真实 18581 IAB：默认 chi_sim+eng 上传纯合成 1200x360 图片，本地识别结果为「开发 百宝箱 本 地 识别」换行「SYNTHETIC SAMPLE 2026」（中文带空格为实际输出，不称逐字原图准确）；复制后把可见校对框改为 SYNTHETIC PASTE SENTINEL，真实全选/粘贴恢复逐字一致；无本地 error，未点击云 OCR 或翻译。截图 `ocr-local-mixed-final-success.png` 根已展示。
- 边界：交错时序未做浏览器强制复现；审计中旧「同 specifier import 去重使旧并发路径不可达」说法已纠正，不记为已排除缺陷。

## DT-R41｜翻译取消/离页后晚到 DELETE 不得触发重新规划续传（已完成，未提交；根审源码接受；1 主 + 1 测试子实施，本会话即该轮，docs19 由本会话按根指示单 writer 补记 R40–R44）

- 产品变化（仅 `useTranslateRun.ts` 最小 diff）：PREFLIGHT_CHANGED 分支在 `await releaseActiveTicket()` 后复用现有 `RunContext`/`isStale` 复查归属，取消或离页后晚到的 DELETE 续程不再置 replan、不再触发 `onReplanRequired` 回调；正常无取消的自动重新预检续传（docs09 §8 / docs12 §7）逐字保留，不新增全局代次/卸载框架。
- 验证（实际运行，全部 fake fetch）：新增 2 条真实 callback 计数用例（cancel 与 dispose 两边界，旧实现先红、修复后绿）＋既有 translateRun 8＋TranslateView 10＝20/20；OcrTranslateView 直接消费者回归按根指示复用 R40 最终 10 绿（执行时点在 helper 修改之后且 helper 未再变），不重复运行。
- 边界：缺陷由源码级受控 Promise 红测证实，未称真实云或浏览器竞态已实机复现。

## DT-R42｜docs11 翻译确认措辞对齐 docs09/12（已完成，未提交；根最终收口通过；独立会话纯文档改动，事实由根审定）

- 变化（仅 docs/11 @189/442/668 三处 UX 措辞）：普通文本翻译点击后即 preflight 直发，PREFLIGHT_CHANGED 重新预检后按对应工具 UX 流程继续——普通文本翻译按既有流程自动继续，OCR 自身确认保留；对齐 docs09 §8 与 docs12 §7。
- 边界：API、错误码、预算、幂等与取消合同不变；纯文档未新增单测与 check，不称通过任何代码验证。

## DT-R43｜摘要工具剪贴板拒绝的手动复制恢复（已完成，未提交；根审源码与真实 IAB 已接受；独立会话实施，事实由根审定）

- 产品变化（仅 `DigestToolView.vue` copyDigest）：捕获剪贴板写入拒绝，以 role=alert 提示手动选择复制，结果与重试保留，不丢已算摘要。
- 验证（实际运行）：既有 7＋新增拒绝恢复 1＝8/8，无 unhandled rejection；拒绝分支为 mock 组件证据。
- 根真实 IAB：单个 4MiB+17B 纯合成文件经真实 Worker 摘要与正常复制逐字精确；390/1024/1440/1920/3840 代表宽度无横向溢出，1440 浅色正确。
- 边界：不称实机强制拒绝了剪贴板权限，未测真实权限弹窗矩阵。

## DT-R44｜ModuleNav 当前工具组展开与 compact 焦点修正（已完成，未提交；根审源码与真实 IAB 最终收口通过；独立会话实施，事实由根审定）

- 产品变化（仅 `ModuleNav.vue`，只用既有 DOM/route/query）：进入当前工具、历史回退与清空搜索时展开当前组；route/query 不变时手动折叠保留；compact 初始焦点改为可见 header 关闭按钮，保留原有 focus correction。
- 验证（实际运行）：新导航 5＋AppShell 2＝7/7（AppShell 仅同步焦点断言）；根真实 IAB——1440 深浅、1920、3840 当前组可见无横溢，真实 1024/390 抽屉重开焦点 Close、Escape 返回工具列表、Tab 首尾闭环、footer 帮助跳转关抽屉并回帮助主题，390 键盘 focus-visible 蓝 2px outline；截图 `tool-navigation-mobile-keyboard-focus.png` 根已展示，只称上述代表态。
- 公共最终验证（R40–R44 全部源码稳定后仅一次）：`pnpm -C apps/web build`（内置 vue-tsc/tsc＋Vite）exit 0 通过；Monaco 相关大 chunk 超 500 kB 为既有已知体积提示，不谎称零 warning；无新依赖、全量测试、版本/tag/部署/生产/付费/正式验收变化。
- 边界与收束：R40–R44 均未 commit/push；docs19 写入 owner 随本记录完毕释放。

## DT-R45｜CopyButton 复制失败可见提示与状态清理（已完成，未提交；根审源码与真实 IAB 验收通过；1 主 + 1 测试子实施，事实由根审定）

- 产品变化（仅 `CopyButton.vue`，不改 5 处父消费者）：新增 failed 状态与可见 `role=alert` 手动复制提示；catch 清 copied 与计时器，成功清错；保留自定义 label、secondary、空 text 禁用、1600ms polite 反馈、error emit 与不移焦，局部 inline-flex wrap。
- 验证（实际运行）：恰好 1 测试子（frontend-builder）只新建 `CopyButton.test.ts`——对旧组件 1 条真实行为红（DOM 无可见 alert）、3 条守卫绿；最终 7 文件 37/37（Copy 4＋JsonAI 4＋JsonRepair 4＋Yaml 1＋YamlStale 4＋Translate 10＋Ocr 10）。
- 根真实 IAB：390 YAML 普通 Copy 成功，剪贴板往返逐字一致；YAML 五宽 390/1024/1440/1920/3840 page/wrapper/title 均不横溢、结果标题均单行，1440 浅色代表态正确；390 JSON 本地格式化 copy 剪贴板精确等于 2 空格 JSON；OCR 默认本地 chi_sim+eng 同纯合成图正常识别、customlabel copy 精确、复制按钮 142x44 无错误无溢出；截图 `shared-copy-ocr-mobile-success.png` 根已展示。
- 公共最终验证与边界：R46 源码稳定/owner 释放后一次 `pnpm -C apps/web check` exit 0（R45 最终 GUI 前执行，覆盖 R45/R46 两轮，不另跑 check/build）；拒绝/恢复仅 mock 组件证据，不称真实权限拒绝或云 OCR/翻译已验（均未点）。

## DT-R46｜原始记录类型标题与补充说明中文化（已完成，未提交；根审源码与真实 IAB 验收通过；独立会话单主实施，事实由根审定）

- 产品变化（仅 `ItemDetailView.vue` 与 `SupplementDrawer.vue`，纯呈现）：原始记录标题新增局部四类型中文映射与派生 computed（文本/图片/文件/混合，无选中仍「原始内容」）并绑定 h2；补充抽屉空附件说明改为「可创建仅含文字、图片、文件或混合内容的补充记录。」
- 根真实 IAB：合成 R13 标题「混合」、R19/R23 标题「文本」；查看原文仍需显式打开，空补充保存禁用、关闭回「添加补充」；五宽页面/抽屉/新说明/文本标题均不横溢，深浅代表态与 390 键盘 Tab 可达选择文件且说明可读；仅打开空表单未填未保存，无业务写入；截图 `knowledge-supplement-chinese-mobile.png` 根已展示。
- 边界：不改 contentKind 协议枚举/派生规则、任何请求、不可变原始数据、保存与 CSS；不新增镜像单测，web check 复用 R45 那次通过（见上）；image/file 仅静态映射结论，不称实机四类型矩阵验证。
- 收束：R45/R46 均未 commit/push、新依赖、全量测试、版本/tag/部署/生产/付费/正式验收变化；docs19 写入 owner 随本记录完毕释放。

## DT-R47｜翻译等待旧清理时的离页与新输入启动归属（已完成，未提交；根逐 hunk 源码验收并 GUI 确认最终计数，事实由根审定；1 主 + 1 测试子，子结束后主接第 4 case）

- 产品变化（仅 `useTranslateRun.ts`，未改 Vue/API/额度合同/依赖）：`start` 在 await 旧清理（supersedeActiveRun 的 pendingTicketRelease）前先预留既有 generation、await 后复查，作废的续体不再接管状态或创建 queue；`resetForNewRun` 只递增输入代次，活实例仍可显式新发；新增闭包 `disposed` 作为实例终态——start 入口及 await 后拒绝、continueFromFailure 入口拒绝已销毁实例，dispose 置终态但不再额外递增 generation（避免等价失效叠加，并保留原取消 phase/breakdown 行为）；R41 late replan 的 isStale 守卫与 releaseActiveTicket 同步快照/串行 DELETE 原样未动。
- 关键证据（全 mock 受控 gate 测试）：新 `translateRun.pending-start.test.ts` 4 用例。前 3 条真实驱动——A 的 chunk POST 真实 abort 先使 phase=cancelled/isBusy=false 而旧 DELETE 仍被 gate 阻塞，B.start park 其上；dispose/reset 两例在含 R41 的旧 helper 上真实红（实际 8 条 POST/DELETE 路径 vs 期望 A 原 4 条，B 意外跑完 queue/claim/chunk/DELETE），正常显式 B 守卫绿。第 4 例对应 TranslateView 晚到 preflight 真实源码调用链（onBeforeUnmount 未增 preflightGeneration，晚到回包会调 run.start），在前一候选上 dispose 后新 start 使 queue POST 实际 1 vs 0 真红；fixture 全部提供正常响应、Promise 收束后断请求次数，无私改 phase/TypeError/超时假红，未用 PREFLIGHT_CHANGED 造窗口。
- 最终验证：pending-start 4＋translateRun 8＋replan-cancel 2＋TranslateView 10＋OcrTranslateView 10＝34/34，一轮最终 `pnpm -C apps/web check` 通过；中间候选 33 与最终 34 为输入变化后的受影响重测，只记最终。
- 边界与收束：HTTP 全 mock，生命周期时序未做真实浏览器强制复现，未触真阿里云/配额/provider；无新 UI 布局故不重复浏览器矩阵，不称正式验收/发布已完成；主与原 1 个 frontend-builder 测试子现均释放源码 owner；无 commit/push/新服务/端口重启/全量测试/生产/费用/版本/tag；R48 只读期间无改文件，最终全局检查为稳定候选；docs19 写入 owner 随本记录完毕释放。

## DT-R48｜ItemDetail 三个弹窗焦点陷阱、关闭回焦与触控命中修复（已完成，未提交；根审源码与真实 IAB 验收通过；独立会话实施，事实由根审定）

- 产品变化（仅 `ItemDetailView.vue` 与新 `ItemDetailView.dialog-a11y.test.ts`）：三个原有 modal 的局部 ref/trigger currentTarget 均在 await 前捕获；编辑弹窗初焦 Title 输入框、两个确认 alert 初焦安全 Cancel；Tab/Shift+Tab 环绕、全禁用时留 tabindex -1 容器；Escape 忽略 IME 组合中；Escape 与 X/footer/Cancel 共用关闭回焦（trigger 仅判 isConnected，无跨路由 fallback）；保留 editor busy 可取消、trash busy 不可取消，既有 mutationBusy watch 进入 busy 只在焦点失效时修复；R46 中文 kind、raw AbortController 与请求原样不动；关闭 X 命中目标 44×44。
- 测试证据：旧 5 红 1 守卫绿；F1 增强 6 条（指针回焦/已聚焦确认失效）全真实红；最终 dialog-a11y 6＋既有 raw 5＝11/11；修 1 行 test 非空标注后真实 web check exit 0，原管道伪 0 失败未计通过。
- 根真实 IAB：3 个 modal 初焦、两方向 Tab、Escape、指针 Cancel 回焦（edit 的 X 与 footer 分验）全通过；五真尺寸 390/1024/1440/1920/3840 无 page/dialog 横溢，1440 浅色正确，原文未打开/未保存/未移动；390 实测其它 6 按钮 40px 后仅既有 720 media 局部 min-height 44 CSS，根复验 390 全部 44 且 Close 键盘 outline 2px，纯 CSS 未重复 unit/check、其余 4 宽未重复；截图 `knowledge-detail-dialog-mobile-focus.png` 根已展示。
- 边界：busy/IME 仅 mock，不称真实失败/忙态已实机强制复现。

## DT-R49｜合成验收环境因旧 /tmp 消失的恢复（已完成；纯仓库外环境恢复，未改业务源码与既有库，新库仅建合成数据；环境 main＋唯一前端子自然结束，事实由根审定）

- 环境与数据边界（仓库外 root `/Users/hxf/.cache/dev-toolbox-lab/r49/`，private 700/secrets 600）：既有 PG `dev-toolbox-dt-r06-pg`@18590 仅启动，旧 r06/r13 库不 drop/reset/TRUNCATE/migrate；仅 fresh `dev_toolbox_dt_r49_test` 才执行迁移，不泛称恢复了旧临时数据。
- 真实服务链路：真实 Go API 18591（PID 12393）＋真实 Vite 18581（PID 12218），/api 直代理无假鉴权；private `login.json` 只记路径及 username/password/totpSecret 字段名，绝不写值。
- 验收事实：真实 CLI 初始化合成账号、真实 HTTP 认证＋恰好 2 条 normal/sensitive SYNTHETIC 记录 create 201，live/ready/version 200；根实际 IAB 正常密码＋TOTP 登录成功（R50/R51 的真实 IAB 均基于此环境）。
- 边界与收束：无 worker/provider/云/索引/生产 secret/业务 repo 改动；运行文件为真实 consumer 不是过程证据包；环境保留供后续迭代。

## DT-R50｜WorkspaceView 永久清除确认弹窗焦点与背景快捷键隔离（已完成，未提交；根审源码、GUI 确认最终计数与真实 IAB 验收通过；1 主＋1 测试子实施，事实由根审定）

- 产品变化（仅 `WorkspaceView.vue` 与新 `WorkspaceView.purge-a11y.test.ts`）：purge alert 局部 Cancel 安全初焦、Tab 显式循环、Escape＋pointer 清错回焦、busy 全禁用留容器；warning 段补 id 与 aria-describedby；原 window 快捷键仅 target.closest(aria-modal=true) 早退、不抢 modal 焦点（同时保护 R48），背景原快捷键保持。
- 测试证据：旧 3 红 1 守卫绿；根校准 new test 为真实 focused 元素派发无容器 fallback、afterEach 卸载 window 监听、真实 DELETE 方法计数、只验首尾 Tab 不依赖 jsdom 默认遍历；原 Tab 循环根实机正确保留，生产注释去测试动机；最终 new 4＋Workspace 4＋library 3＝11/11（TEST_EXIT 0），最终 check exit 0（22:45 GUI 确认），未重放旧红。
- 根真实 IAB：安全初焦/description/两个背景快捷键隔离/双向 Tab/Escape 与 pointer Cancel 回焦/关闭后背景 slash 恢复共 8 项全通过；五真尺寸无横溢，390 按钮 40px 后仅既有 820 media 补 44，根最终 390 全 44＋1440 浅色正确；root 仅把 R49 normal 合成记录临时 soft-trash 触发确认框，始终未执行永久删除，验后真实 Restore 成功、收件箱原 2 条仍在；截图 `purge-dialog-mobile-focus.png` 根已展示。
- 边界：busy/删除成功与失败路径仅 mock，不称真实 purge/屏幕阅读器硬件已验。

## DT-R51｜认证入口静态英文眉题中文化（已完成，未提交；根真实 IAB 验收通过；独立新会话单主实施，本会话即实施，并按根指示单 writer 收束 R48–R51 记录）

- 产品变化（仅 `AuthView.vue` 模板 4 处既有眉题文字，脚本/CSS/认证协议不动）：OWNER ACCESS→所有者登录、SECOND FACTOR→第二重验证、SECURITY SETUP→安全设置、ONE-TIME RECOVERY→一次性恢复码；依据 DESIGN「静态英文眉题不是默认层级」与默认简体中文约束，TOTP 等技术名词保留。
- 根真实 IAB：390/1440 登录＋MFA caption 页面无溢出，正常合成密码＋TOTP 登录成功；绑定/恢复码两处仅静态核对，未为 QA 另显示秘密；截图 `auth-mfa-chinese-mobile.png` 根已展示。
- 边界：纯文案无新增测试或重复 check/build；`AuthView.vue` 源码 owner 已先行释放，R52 不受影响。
- 收束（R48–R51 整体一次说明）：均未 commit/push、未新增生产依赖、未触付费云/生产/版本 tag/正式验收变化；R52（ItemDetail 的 DELETE 失败后恢复焦点）在修、不在此记通过；docs19 写入 owner 随本记录完毕释放，根继续 R52。

## DT-R52｜详情删除失败后的键盘焦点恢复（已完成，未提交；根审源码验收通过；1 主＋1 测试子实施，事实由根审定）

- 产品变化（仅 `ItemDetailView.vue` 既有 mutationBusy watch 一处）：移除仅-true 早退与未使用形参并更新注释，置位与解除都复用 effectiveFocusIn＋focusDialogTarget——失败恢复安全 Cancel、已有有效焦点不重置、成功路径弹窗已关不触焦；无新 API/布局/机制/依赖。
- 测试证据（仅既有 `ItemDetailView.dialog-a11y.test.ts`，it 仍 6）：第 6 条以同一挂起 DELETE 的可 reject gate 增强，保留前置 API 已进入/双禁用/容器断言；既有第4条 IME 断言未动；失败后 alert 可见、双按钮恢复、焦点回 Cancel、双向 Tab 经生产环绕、Escape 关闭回触发器、DELETE 仍 1。实际基线 5 绿＋1 真焦点红（测试初稿曾漏「取消」变量声明致 ReferenceError，修后才计，不作为证红）。
- 验证：最终 dialog-a11y 6＋raw-race 5＝11/11（exit 0）；按根指示从 repo 根直接 `pnpm -C apps/web check` 无管道真 exit 0；未重跑旧红/其它全套/build。
- 边界：失败仅 mock，不称实机强制失败/真实删除；最近 IAB 未受影响交互可复用，无布局变化不重复尺寸/主题/截图；未 commit/push/费用/生产/版本/正式验收。

## DT-R53｜元数据保存后的焦点回归与晚到收尾归属（已完成，未提交；根审源码＋真实 IAB 最终验收通过；1 主＋1 测试子实施，事实由根审定）

- 产品变化（仅 `ItemDetailView.vue`）：正常保存成功后等待 metadata/导航重载完成，焦点回到当前渲染的「编辑元数据」按钮（docs05 弹层关闭回触发器合同，经组件 ref 取重载后新元素）；新增本组件内编辑弹窗归属代次——取消（含 Escape）与新开编辑都推进代次，挂起保存的晚到收尾只作用于同代弹窗：不关闭重开的 B、不抢其焦点、不把旧错误写进 B 或回收站弹窗；已提交写入的既有刷新与 changed 通知保持，busy 可取消等既有语义未变。
- 测试证据（新 `ItemDetailView.metadata-lifecycle.test.ts` 5 case；dialog-a11y 6、raw-race 5 逐字未改）：case1-4 为旧行为真红（保存后焦点落 BODY、B 被晚到 resolve 关闭、B 与回收站显示 A 旧错误），修复后 15/15；case5 覆盖保存自动关闭后仅剩旧导航挂起、已有目录的 B 不再发导航请求的窗口——标题焦点版在旧候选实测 5/5 绿（R52 busy 解除 watch 把瞬时抢焦救回 first-input），不记新增真红；最终锚定「备注」textarea＋标题/备注双草稿保持，使该救援盲点下的焦点丢失可观测。
- 验证：三文件 new5＋dialog-a11y6＋raw-race5＝16/16（vitest 真 exit 0，23:47），绝对 `-C` 直接 `apps/web check` 真 exit 0，根已展开实际工具输出确认；未重放旧红、未跑全套/build。
- 根真实 IAB：Enter 正常保存原元数据后焦点回当前「编辑元数据」按钮、focus-visible 且 outline 2px；截图 `metadata-save-focus-fixed.png` 根已展示。
- 边界：F1 仅 `beginEdit` 推进代次，无 CSS/布局/共享组件/store/API 变化；晚到 PATCH resolve/reject 与导航 resolve 仅 mock、未强制活体服务失败，导航 reject 变体未独立执行、不宣称已测；未 commit/push/费用/生产/版本/正式验收。

## DT-R54｜结构管理确认框键盘安全（已完成，未提交；根审源码＋真实 IAB 验收通过；1 主＋1 测试子实施，子首跑后释放、case5 校准由主接 test owner，事实由根审定）

- 产品变化（仅 `LibraryManageDrawer.vue`；复用 `saving` 全互斥，不新增 deleting 状态/共享组件/store/API）：打开删除确认即捕获触发按钮与名称并清旧错误，初焦安全「取消」，标题含目标名＋`aria-describedby` 关联说明（长名可换行）；取消按钮与内层 Escape 同义回焦该行删除入口且外层不关，IME Escape 忽略；DELETE 在途双按钮禁用、焦点失效才移入 `tabindex=-1` 确认容器、Tab 无可用项留容器不外逃；失败错误仅以 alert 呈现在确认层、解除 saving 后安全回「取消」且不重置有效焦点，成功后行消失回焦创建输入框；saving 期间行编辑/删除、tabs 与 header 关闭禁用；触控 header 44×44、行按钮桌面 40/599 内 44、手机表单按钮 44。
- 测试证据（新 `LibraryManageDrawer.a11y.test.ts` 5 case，全部真实公开事件驱动）：子首跑 4 真合同红＋1 守卫绿（外层关闭回焦为既有实现）；case5 经根校准改走 Tag 合法路径——itemCount>0 可解绑删除、失败为明确合成网络错误文案、成功后 mock GET /tags 少掉目标 Tag 并断言旧行删除按钮 `isConnected=false` 再回焦创建输入框，成功段只记最终绿。
- 验证：new5＋library3＋WorkspaceView4＋purge4＝16/16（00:04:43 实际工具输出根已展开确认）；绝对 `-C` 直接 `apps/web check` 真 exit 0 无诊断（00:08 根已展开确认）；未跑全套/build。
- 根真实 IAB（已通过）：Folder/Tag 安全初焦 Cancel、目标名＋说明描述、双向 Tab、Escape/指针取消回行、外层关闭回入口；390/1024/1440/1920/3840 page/dialog/manager 无横溢，1440 浅色正确，phone 创建/确认/row 44 与 desktop row40/header44，65 字符合法长名手机换行无溢；截图 `library-delete-confirm-mobile-focus.png` 与 desktop-light/long-name 根已看。合成数据：原合成 Folder 临时 rename 已恢复原名，另仅建 1 空「DT-R54 合成确认标签」，始终未真实 DELETE、两条原记录不变。
- 边界：忙态/网络 reject/成功删除/IME 均为 jsdom mock＋真实键盘事件，不称活体强制/硬件验收；未 commit/push/费用/生产/版本/正式验收。

## DT-R55｜QuickCapture 保存期间锁定全部数据输入防中途改动丢失（已完成，未提交；根审源码＋真实 IAB 验收通过；1 主＋1 测试子实施，子首跑后释放、fileInput 类型装置修正由主接 test owner，事实由根审定）

- 产品变化（仅 `QuickCaptureDrawer.vue`，复用 `saving` 与既有遮罩阻塞语义一致，不加草稿缓冲/持久化/代次/新 idempotency 机制/CSS/抽象）：saving 期间正文 textarea 与标题 input native readonly（保焦点），目录 select、敏感 switch、格式两按钮、标签 checkbox（并入既有 30 上限条件）、添加与移除附件按钮 native disabled；`addFiles` 首行 `if (saving.value) return` 覆盖 readonly 挡不住的 paste/filechange 回调；save/resetForm/幂等键/错误文案/焦点逻辑零改动，原文逐字保留、未知结果重试幂等、成功可继续下一条、失败原内容可编辑恢复维持既有合同。
- 测试证据（测试子扩既有 `QuickCaptureDrawer.boundary.test.ts` 恰好 2 个受控 POST gate 用例，deferred fetch 挂起确认在途一次，全部公开 UI 驱动、无实例私写/直调 save）：装置 flush 修正后基线为 1 产品红（在途 `textarea.readOnly === false`）＋3 绿；case a 在途全字段 native 合同＋公开 paste 合成文件未混入＋resolve 后属性恢复/成功消息/按既有合同清空/可继续下一条，case b reject 后全解锁、正文含首尾空白逐字保留、重试可用不自动重发；jsdom 不能真实打字，只证明属性合同＋addFiles 守卫，重试幂等复用仍由既有 `QuickCaptureDrawer.test.ts` 用例守卫。
- 验证：QuickCapture 原 2＋boundary 4＝6/6（vitest 真 exit 0）；绝对 `-C` 直接 `apps/web check` 真 exit 0（首跑子文件 fileInput 可空 TS 装置错误，子已释放后主按文件既有惯例接一行类型收窄修正，零断言改动，复跑 6/6 与 check 双绿）；未跑全套/build。
- 根真实 IAB（已通过）：一次 Control+Enter 创建 1 纯合成普通记录「DT-R55 合成录入验收」id `ad2e37f5-094e-450c-b800-d726191cb4d7`，目录/标签选既有 R54 合成项均落库（现各 1 条）；成功清空正文/标题/目录/标签并解锁，编辑下一草稿 Save 可用且未提交；从所属目录打开按需读原文，69 字符与原输入逐字相等，含首尾双空格/换行/字面 `<raw>`，原 2 条 inbox 记录不变、新总 3 条；截图 `capture-created-raw-exact.png` 根已看；首次 inbox 定位无匹配仅因新记录已归目录，无重复提交。收尾补充：根在真实 Inbox 按「原文逐字验收」跨目录搜索，唯一命中 R55 该条原文、搜索词不入 URL、查询已清空——验证 Product 搜索先于目录的既有原则，无新功能。
- 边界：忙态/网络失败仅 mock 属性合同与 paste 守卫，不称实机强制 pending/failure/IME 已验；QuickCapture 其余键盘问题（内层 Escape 等）留独立新会话 R56 接手、不写 docs；未 commit/push/费用/生产/版本/正式验收。

## DT-R56｜快速记录键盘取消、IME 组合与保存忙态焦点（已完成，未提交；根审源码＋新 4 case 逐段审＋真实 IAB 验收通过；本轮 1 主＋1 测试子，子 baseline 后自然释放，Safari 229 断言与 F2 test 修正由主接手，事实由根审定）

- 产品变化（仅 `QuickCaptureDrawer.vue` 三处局部，无新 CSS/布局/组件）：放弃确认已开时 Escape 仅关闭内层并经既有 `confirmDiscard` watch 回正文焦点（最上层取消语义；普通 dirty Escape 仍先确认、忙态 Escape 仍不关、非 dirty 仍直接关）；`onDialogKeydown` 与 `onEditorKeydown` 两个现有 handler 共用同一平坦 IME guard `isComposing || keyCode === 229`，组合中 Escape 与 Ctrl/Meta+Enter 留给输入法；`save()` 置位后经 `void nextTick` 仅在焦点失效（落 BODY/不在抽屉/停 disabled 控件）时移到 readonly 正文，不加 await、不改 POST 快照与请求时机、已有可用焦点保持，R55 锁输入/幂等/reset/错误合同零改动。
- 测试证据（新 `QuickCaptureDrawer.keyboard.test.ts` 恰好 4 case，全公开 UI 事件驱动、无实例私写/直调 save，键只从真实 activeElement 发）：子对修复前代码 baseline 4 红均为断言失败——内层 Escape 不关、IME Escape 仍开确认、IME Ctrl+Enter 误发请求（以 fetch 1 次为证，非 undefined Response 报错）、忙态焦点停 disabled Save；修复后整组 10/10（新 4＋QuickCapture 原 2＋boundary 4）＋绝对 `-C` 直接 check 真 exit 0。根补充 Safari 证据后 case3 增 `isComposing:false + keyCode:229` 不提交段、正常提交段显式 code 13，仍 4 case 总 10；F2 仅 test 修正（默认完整合法 201 使 guard 回归时误发 POST 走正常成功路径、afterEach 不再吞 unmount 错误），keyboard 4/4＋check 0，原 6 复用既有绿。
- 根真实 IAB（已通过，1280 与 390×844）：dirty Escape 先开确认且初焦「继续编辑」，再 Escape 只关内层回正文，草稿含换行/首尾空白逐字保留，phone focus-visible/outline 2px 无横溢，临时草稿清空未提交；另一次普通 Control+Enter 创建 1 纯合成 normal「DT-R56 合成键盘验收」id `185ee2fc-48cc-458f-b876-3aaf3dd727de`，成功清空/解锁/refocus，现总 4 条（inbox 3/Folder 1），R49 两条与 R55 目录标签记录不变；截图 `capture-escape-editor-mobile.png` 根已看。
- 边界：IME/`isComposing:false+229` Safari 事件形状/保存挂起拒绝焦点仅 jsdom mock 与受控 fetch gate 验证，不称系统 IME/Safari 硬件全矩阵已验；WebKit 一手来源（简述）：[WebKit bug 324380 评论 2](https://bugs.webkit.org/show_bug.cgi?id=324380#c2) 记录 composition-confirm Enter keydown 报 keyCode 229 而 isComposing=false（普通后续 Enter 为 13），[WebKit bug 311717 评论 7](https://bugs.webkit.org/show_bug.cgi?id=311717#c7) 说明该修正已被 317127 回退另案追踪——故采用平坦 guard，不新增 UA 检测/延时计时/兼容框架；未 commit/push/费用/生产/版本/正式验收。

## DT-R57｜结构管理行内编辑的焦点交接与保存忙态锁定（已完成，未提交；根审源码＋新 4 case 逐段审＋真实 IAB 验收通过；本轮 1 主＋1 测试子，子 baseline 首跑后自然释放，source 实施与 F1 test 校准、F2 source 修正由主先后接 owner，事实由根审定）

- 产品变化（仅 `LibraryManageDrawer.vue`，不新增状态/机制/共享组件/store/API，R54 确认层/CSS 零改动）：打开目录/标签编辑后 nextTick 把焦点交编辑表单名称 input；两行「编辑」按钮加 `data-edit-trigger="<id>"` 作为生产回焦定位；行内「取消」改 `cancelEdit`（saving 守卫），清编辑态后 nextTick 回焦该行重建的当前「编辑」，不复用已 v-if 销毁的旧按钮；保存成功在 busy 解除＋DOM 就绪后仅当焦点已失效才回该行当前「编辑」，外层 Create 输入等有效焦点不抢；busy 只锁正在提交的行内字段——名称 input `readonly=saving`、目录上级 select `disabled=saving`、两处行内「取消」`disabled=saving`（rename/move 已提交无撤回 API，避免假取消），「保存」disabled 合并 trim 非空约束（空格名不再看似可点而 saveEdit 早退）；`saveEdit` 在 saving 置位后以 `void nextTick` 安排焦点修复（现焦点真失效才交 readonly 名称，id 于同步段捕获），PATCH/导航先后与快照时机不变；顶层 IME guard 平坦补 `keyCode === 229`（同 R56，WebKit 324380#c2/311717#c7 已录），无 UA 嗅探/定时器。
- 测试证据（新 `LibraryManageDrawer.inline-edit-focus.test.ts` 恰好 4 case，全公开 DOM 事件驱动、键从真实 activeElement 发、无实例私写/直调）：子对修复前 baseline 实际 3 产品红＋1 既有绿（case4「在途焦点外移后不抢 Create 焦点、草稿保留、不发 POST」为现状守卫锚点，如实记绿、不编第 4 红）；初版装置曾于清空名称后缺 flush 致断言时序错，由主补 `await flushPromises()` 修正，不算产品红。F1 校准后仍 4 case：合法前置同级 Folder 使目标固定第二行，回焦以可见行名＋该行「编辑」定位（不依赖生产 data 标记），断言焦点非首行且旧按钮 `isConnected=false` 不复用，两次「保存」均先 focus 再 click 并确认提交前为 activeElement、pending 后焦点停靠 readonly 名称；空格名 trim 禁存、失败后名称 input 与上级 select 解锁可修正、Create 有效焦点与独立草稿不被抢清。F2 校准：去掉 PATCH 前新增的 await，id 同步捕获＋`void nextTick` 焦点修复，原 mutation 顺序不变。
- 验证：最终 new4＋R54 a11y5＋library3＝12/12 实际绿（01:17 vitest 真 exit 0，根已展开确认）；绝对 `-C` 直接 `apps/web check` 真 exit 0 无诊断（根已展开确认）；根已展开两条真实工具记录并读 source 接受；未跑全套/build。
- 根真实 IAB（已通过，1280 与 390×844）：合成原 Folder/Tag 打开编辑即初焦名称 input，取消回本行当前「编辑」；三个空格名「保存」disabled；两者以真实 Enter 保存临时新名后回本行「编辑」且 focus-visible，随后恢复原名；390 标签名称初焦 focus-visible 2px、pageFits 无横溢、取消正常，关抽屉后恢复默认 viewport。仅操作既有自己的合成 Folder/Tag，无 DELETE、未新增条目，4 条记录关系保留；截图系根私有产物，不入仓库。
- 边界：live pending/网络失败/OS IME 未强制，延迟/失败/229 事件形状仅 jsdom mock 驱动，不称 Safari 物理输入或真实挂起已测；未 commit/push/费用/生产/版本/正式验收。

## DT-R58｜PRODUCT.md 产品定义对齐已实现的知识助手（已完成，未提交；根已核实际 git diff 并接受、无须其它润色或检查；独立新会话单主实施，Product 与 docs19 写入 owner 由本会话先后接写并释放）

- 产品变化（仅 `PRODUCT.md` 三处、3 hunk、+11/−2）：Purpose 开头改「知识与记录、工具箱、知识助手」三平级模块表述并保留个人开发运维/原始事实/本地优先定位；Positioning 引导句由「两类平级能力」改为「坚持以下原则」（既有 5 条原则逐字保留）；Capabilities 在二期状态后新增第三期能力状态 6 条——/assistant 一般交流或基于一期笔记多轮问答并区分「基于笔记/一般补充/知识库不可用」，复用片段事实层的 PostgreSQL+pgvector 混合检索、可追溯引用与来源抽屉（索引依赖 Embedding 配置并受既有敏感策略约束），流式/停止、持久与临时会话及会话内滚动摘要（临时不写应用会话历史但仍发所选 Provider、非隐私模式、无跨会话记忆），不做命令执行/任意 HTTP/工具调用/通用 Agent/MCP/多 Agent/保存为笔记，V1「不做向量检索或语义搜索」限一期普通资料库、V3 仅在助手索引检索内解除。
- 权威来源与检查：事实仅取 README 三模块段、docs16 冻结范围与 docs17 2026-09-02 记录，状态只引既有事实（2026-09-02 以 v3.0.0-rc.1 更新既有测试环境、仍候选），未虚构模型质量/用户量/生产验证，详细合同以 PRODUCT.md 内 docs16/17 相对链接为权威（链接目标 `test -f` 存在性通过）；根已看实际 git diff 接受，明确无须其它 Product 润色或任何 tests/check/build。
- 边界：仅文档事实对齐，不改部署与正式验收状态——真实 40 题人工评测、目标版本备份恢复/性能门禁与完整 `release-check` 仍未执行，未运行 tests/check/build/服务，未 commit/push/费用/生产/版本/正式验收；另按根指示同批修正本文件 R56 节键名笔误（改「Escape 与 Ctrl/Meta+Enter」）并把两个 bare WebKit URL 包为描述性 Markdown 链接（URL 与事实原样）。Product owner 已释放，本节完成即释放 docs19 写入 owner。

## DT-R59｜Web 生产构建（已完成；纯构建验证、零源改动；根审接受、BUILD_DONE 已实际通知 peer 且 trial2 继续；独立新会话单主实施，本会话即实施与 docs19 写入 owner）

- 构建事实：单次绝对 `-C` 直接运行现有 `apps/web build` 入口（内置 `pnpm check && vite build`，check 为 vue-tsc＋tsc `--noEmit`，无诊断），真实 exit 0；Vite 8.2.2 转换 3149 modules，产物为 `apps/web/dist/index.html` 与 `dist/assets/`（worker、路由懒加载 CSS/JS、codicon 字体），均属现有构建的正常 ignored 输出。
- 唯一 warning：历史 Monaco >500 kB chunk 提示（`editor.api` 2,656.20 kB／`jsonMode` 1,207.81 kB）原样保留且非 fatal，不为 warning 扩改 chunk 策略或源码；未重复 tests/check/build。
- 边界：source/test/package/依赖/锁文件零改动，无新 preview/代理/容器/部署，未碰 peer 端口；构建资源窗口已释放；正式发布、40 题人工评测、真实云评测与备份恢复验收状态均无变化，未 commit/push/费用/生产/版本/正式验收。本节完成即释放 docs19 写入 owner。

## DT-R60｜结构创建请求完成不得清空下一份草稿（已完成，未提交；根审 source hunk＋真实终端 14 passed＋真实 IAB 验收通过；本轮 1 主＋1 测试子，子 baseline 两跑后自然释放，source 实施与 F1 test 校准由主先后接 owner，事实由根审定）

- 产品变化（仅 `LibraryManageDrawer.vue` 的 `createEntry` 一处 hunk，不新增 ref/代次/操作标识/持久化/回退框架，不锁 Create 表单，R57 行内编辑/删除流程与 try/catch/finally、POST→loadNavigation 顺序零改动）：saving 置位后于同步段以局部常量快照当前 name/parent，POST 时机不变并用快照发送；成功后仅当当前 name 与 parent 均仍等于快照时才清空 name，任一已变化则精确保留用户在途写下的下一份草稿 B 与所选 parent（含首尾空白），parent 按原合同不重置，不自动提交 B；`void nextTick` 复用既有 `focusIsUsable`，仅当焦点已失效（如停在已禁用的「创建」）才停靠到仍可编辑的 `.create-form input`，用户有效焦点不抢。
- 测试证据与验证（新 `LibraryManageDrawer.create-draft.test.ts` 恰好 2 case：公开 DOM 事件＋真实 pinia＋受控 POST deferred gate，记录快照 payload，无实例私写/直调/store mock）：子首跑 2 红为 fixture 时序（填名后「创建」disabled 未 flush，jsdom click/focus 被吞），子自行补 flush 修装置、不计产品红；第二跑 2 实际产品红（目录 A 成功后清掉在途 B；标签从聚焦「创建」提交后焦点仍停在已禁用按钮）根接受；主改 source 后 new2＋R57 inline4＋R54 a11y5＋library3＝14/14（根已滚真实终端见 4 files 14 passed）＋绝对 `-C` 直接 `apps/web check` 真 exit 0；F1 仅 test：B 改为真实首尾双空格字符串并删过时过程注释，新 2/2 绿、原 12 未重跑；两轮冻结后的联合 check 见 R61 节。
- 根真实 IAB（已通过，1280）与边界：真实 Enter 仅新建 1 条自用纯合成 Tag「DT-R60 合成连续录入标签」（id `ed57a06c-15b4-426a-a3f2-4ec65fb6831c`，0 条），成功后清空/解锁/名称 focus-visible；随后键入带双空格 B（发生在快速成功之后、非 live pending 期间），「创建」可用、B 未提交并已清，记录仍 4 条、R54 合成 Folder/Tag 各 1 条，无 DELETE。真实 pending 期间的 B 保留仅 jsdom mock 验证，不把后续输入说成 live race 验收；未 commit/push/费用/生产/版本/正式验收。

## DT-R61｜设置抽屉 IME 组合 Escape 守卫与关闭触控尺寸（已完成，未提交；根审三处最小 source diff＋全部新 test＋真实 IAB 验收通过；独立会话 1 主＋1 测试子均已自然结束，事实由根审定、本 owner 代记）

- 产品变化（仅两个现有 settings 页面三处最小 diff，不新增压缩约束/机制）：两页 `onDialogKeydown` 加同一平坦 `isComposing || keyCode === 229` guard（同 R56/R57），既有 `settings-icon-button` 宽高 36→44；Provider/模型/PAT 的保存、权限、测试连接、Tab trap、初焦、回焦与 busy 逻辑零改动。
- 测试证据与验证（唯一子新增 `SettingsDrawers.keyboard.test.ts` 恰好 3 case：Provider 新增/Model 编辑/PAT 创建；公开 DOM＋合法 fetch fixtures，真实聚焦 opener→input）：3 实际产品旧红均落在首个「isComposing=true 的 Escape 关闭抽屉」断言，229 形状在同 case 修复后通过、不编独立 3 旧红；true IME 与 `isComposing:false+229` 均保留抽屉与草稿，普通 Escape 关闭并回焦 opener，全程无 mutating/测试连接请求。主跑 new3＋v3 既有 4＋m3 既有 4＝11 真 exit 0；既有单路由 memoryRouter R0004 warnings 非产品失败、未顺手修；根已读全部新 test 与实际 source 三处最小 diff 并核原命令/RUN。两轮冻结后根另授权 R61 主单次绝对 `-C` 直接 `apps/web check`，实际 exit 0 无诊断（根已展开 compiler 行核对），覆盖当前两轮 Vue/TS 与新测试的类型检查；CSS 尺寸由真实 DOM/布局验收，类型检查不验证 CSS。
- 根真实 IAB（已通过，390×844）与边界：Provider/PAT 关闭按钮 44×44、无横溢；Provider 末端 Tab→Close、首端 Shift+Tab→Save；合成显示名普通 Escape 回焦「新增 Provider」，PAT 合成名 Escape 回焦「Create Token」，0 有效/0 历史，未创建 Provider/Key/Token、未测试连接/费用；phone 截图根已看。Model 与 OS IME 仅 jsdom mock、非实机；本两轮未重跑 build/全量/正式 release，R59 旧 build 不覆盖本两轮，付费评测/40 题/OSS/restic/正式验收状态未变；未 commit/push/费用/生产/版本/正式验收。本节完成即释放 docs19 写入 owner。

## DT-R62｜结构管理标签页的删除规则说明（已完成，未提交；根审一行 diff 与真实 IAB 验收通过；本轮单主实施，本会话即实施与 docs19 owner）

- 产品变化（仅 `LibraryManageDrawer.vue` footer 一处随 tab 文字）：目录 tab 原句逐字保留「删除目录不会级联删除记录；非空目录会被服务端拒绝。」，标签 tab 改为「删除标签会解除与记录的关联，原始记录会保留。」；用模板内联三元沿文件既有惯用法，无新增状态/computed，其它确认文案、逻辑、样式、接口、store、API 与测试零改动。后端依据仅事实核对：`organization.go` deleteTag 只删 tags 并重建关联 item 元数据、不删 knowledge_items，迁移 003 `item_tags.tag_id` 外键 ON DELETE CASCADE 解除关联；后台无任何修改。
- 根真实 IAB（已通过）与边界：1280 切目录/标签两页文案分别正确；390×844 两个既有合成 Tag（1 条与 0 条）同屏，说明位于视口底部可见/pageFits，截图根已看；未执行任何 DELETE/数据写入。纯文案修改未重跑 unit/check/build，无真实删除与发布状态变化；未 commit/push/费用/生产/版本/正式验收。本节完成即释放 docs19 写入 owner。

## DT-R63｜补充原始记录保存期间的草稿保护与 IME 取消（已完成，未提交；根逐段审 source 与新 test 接受、实际展开工具确认 2 files 5 passed 与直接 check 零诊断、真实 IAB 验收通过；独立会话 1 主＋1 测试子，子 baseline 后自然释放，source 由主接 owner 实施，本会话即实施与 docs19 owner）

- 产品变化（仅 `SupplementDrawer.vue`，复用 R56/R57/R60/R61 同款写法，不新增 helper/ref/代次/操作标识/计时器/UA 分支，不加 Ctrl+Enter）：saving 期间正文 textarea native `readonly` 并保持可聚焦；格式/敏感/关系三个 select 与目标 select（合入既有 `!relationType` 条件）、选择文件按钮、隐藏 file input、逐项移除、header 关闭、底部取消全部 native `disabled`，与既有 `requestClose` busy 无效语义一致；`selectFiles` 仅加一层 saving busy guard，附件替换与 10 个/20 MiB/100 MiB 限制原样；`saving=true` 后 `void nextTick` 一次焦点修复，仅当焦点为 body/不在 drawer/已 disabled 时交给 editor，有效焦点不抢、不新增 await 推迟请求；`onDialogKeydown` 首部一行平坦 `isComposing || keyCode === 229` guard；byte caps/metadata 快照/签名/幂等 key/端点/error/retry/reset/emits/CSS 零改动，inner discard 第二次 Esc 既有正确合同未动。
- 测试证据与验证（唯一子新增 `SupplementDrawer.saving-keyboard.test.ts` 恰好 3 case：multipart pending 逐项锁与快照不变→201 复位解锁、JSON 挂起 reject 后逐字保留与解锁且无自动重发、IME Escape 不开 discard 而普通双 Escape 保持；公开 DOM＋真实 pinia＋完整合法 201 Response＋受控 POST gate，open 按 false→setProps true，无实例私写/直调/store mock；既有 `SupplementDrawer.boundary.test.ts` 2 case 未改、幂等重试矩阵不重复）：子在未改源上 baseline 3 红分别为 multipart/JSON pending `readOnly` 收到 false 与 composition Escape 误开 discard——两个 readonly 红是同一合同在两种真实路径的采样，不称 3 个独立 bug；其后 guard/229/reject/resolve 段因首断言即止在 baseline 未执行到，源码修后首次实际全绿；无 fixture 修正。偏离如实记录：子首跑误带 `--`（pnpm 原样透传、vitest 不作过滤）意外扩大为 91 files/511 unit（508 passed/3 failed，失败即本文件 3 红，13.34s 已退出），子自行纠正为无 `--` 单文件 3 failed 作 baseline 依据；该意外扩大不是正式全门禁或全量验收。主改 source 后 new3＋boundary2＝5/5（2 files）＋绝对 `-C` 直接 `apps/web check` exit 0 零诊断，根已展开原工具与 compiler 行核对。
- 根真实 IAB（已通过）与边界：在既有自有普通 R56 合成 item `185ee2fc-48cc-458f-b876-3aaf3dd727de`，390×844 填入含首尾双空格/换行/字面 `<raw>` 的补充草稿，第一次普通 Escape 开 confirm 且「继续编辑」安全初焦，第二次 Escape 只关 inner 回 editor，值逐字保留、focus-visible 2px、pageFits；恢复 1280 后真实 Enter 一次保存新建 1 条 Supplement，R56 raw 1→2，总 item 仍 4、normal/附件 0，补充正文 52 chars/90 bytes 逐字等于提交输入，原主记录 46 chars 逐字等于保存前 DOM 内存快照（两处真实查看原文），无 DELETE/真实 Key/云调用，两张截图根已看。pending 锁/失败解锁/附件锁/OS IME 仅 jsdom mock，不称实机强制已验。已知父侧缺口（仅记录事实，不修父源、不新 Backlog/证据包）：保存成功并 metadata 刷新后根实际 DOM focus=BODY、旧 Add 按钮被重建，属父 `ItemDetailView` 既有收尾缺口，交 R65 新会话只读审计焦点/metadata GET 归属；本节不声称保存后整体回焦已通过，本模块输入保护与普通 inner Esc 已通过，不停任务。本轮未跑 build/正式 release，unit 范围以上点如实记录为准；未 commit/push/费用/生产/版本/正式验收。本节完成即释放 docs19 写入 owner。

## DT-R64｜设置抽屉保存忙态输入锁定与 Token 签发焦点交接（已实施、定向验证通过，统一 check/build 已由 R68 通过；未提交；根审 source＋新 3 test＋F1 校正接受，并核原命令/RUN 与主结束回报；独立会话 1 主＋1 测试子均已自然释放，事实由根审定、本 owner 代记）

- 产品变化（仅 `ProviderSettingsView.vue` 与 `TokenSettingsView.vue`，沿 R55/R57/R63 同款写法）：busy 期间文字/密码/数值输入原生 `readonly`，其它 select/checkbox/动态行与关闭/取消按钮 `disabled`，原索引边界保留；`void nextTick` 仅在焦点无效时救援到 readonly 首输入（Provider 两个消费者共用小 helper，Token 内联）；Token 把现有 aggregate bool watch 改为派生 create/revoke/issued stage，create→issued 真正把焦点交接到既有 readonly 一次性明文 input（focus＋全选），关闭返回 opener。payload/JSON/保存时机/权限/一次性明文隐藏/clipboard 不变，Embedding/poll/loader/API/CSS/依赖零改动。
- 测试证据与验证（唯一子新增 `SettingsDrawers.saving.test.ts` 恰好 3 case：Provider POST pending→201、Model PATCH pending→显式 422 保草稿并解锁、Token POST pending→显式 422→用户手动 retry 201→issued focus＋select→关闭消失返 opener 且 0 剪贴板调用；全数据 SYNTHETIC_ONLY）：未改源 baseline 3 个 readonly 实际产品红；source 后 new3＋既有 keyboard3＋v3 four＋m3 four＝14/14 exit 0；F1 仅新文件校正为重查真实 DOM 行序与 422 后逐行名 readonly false，new 3/3 exit 0，旧 11 输入未变复用已通过不重跑；根已审 source、新 3 与 F1。
- 根验收与边界（本轮无新真实 IAB）：busy/422/issued 阶段全为 jsdom mock；根此前 R61 已验真实 390 idle 的开关 44 目标/Tab/Esc，本轮不称真实创建 Token/Provider/Key，不称所有保存后回焦已通过（卡片 trigger 重建候选交 R66 先做 baseline）。本轮 check/build 未运行：已实施、定向 unit 验证通过，统一类型/构建后续 R68 已对当前稳定候选统一通过（script 内置 check 的 Web build），R59 旧 build 不覆盖本轮；未 commit/push/费用/生产/版本/正式验收。

## DT-R65｜详情元数据请求归属与补充保存后的当前 Add 回焦（已实施、定向验证通过，统一 check/build 已由 R68 通过；未提交；根审 4 处最小 source＋新 4 test＋新增 loading 断言与历史 baseline 注释接受、实际展开 20 项原命令/RUN、真实 IAB 验收通过；独立会话先只读审计后 1 主＋1 测试子，子 baseline 后自然释放，source 由主接 owner 实施，本会话即实施与 docs19 owner）

- 产品变化（仅 `ItemDetailView.vue` 4 处，闭环 R63 记录的父侧收尾缺口；新增 1 个本地数字 counter 与 1 个 `supplementTrigger` component ref，沿 `editTrigger` 的 `$el` 模式；不加 AbortController/跨 item epoch/通用 loader，跨 item 隔离仍靠 WorkspaceView 既有 `:key`）：审计前提经根修正——loading 只挡新 UI 入口，挡不住已发 PATCH/POST 的晚到回调，R53 允许的 busy 中 Escape 取消保存与 R63 正常补充组合即在同实例并发两次详情 GET。`loadDetail` 每次启动递增并捕获请求代次，响应先入局部变量，只有当前代次可写 detail/matchedFragment/selectedRaw，catch 与 finally 同样只允许当前请求写 error/loading，原 `await nextTick` 后的 heading focus 原位保留并加当前守卫；`onSupplementCreated` 保留 `await loadDetail()`＋`emit('changed')` 顺序，DOM 稳定后只在焦点确实无效（BODY/断连/disabled）时补焦当前重建的「添加补充」按钮，外部仍连接可用的焦点（如资料库搜索框）不抢、不用 `root.contains` 限制有效性；R53 cancel/editGeneration、mutationBusy、服务器写入语义零改动。
- 测试证据与验证（唯一子新增 `ItemDetailView.supplement-refresh.test.ts` 恰好 4 case：①补充 POST 201→GET 重载后焦点回重新 query 的当前 Add 且旧按钮 isConnected=false；②GET 挂起期间外部宿主 input 真实 focus＋草稿不被收尾抢；③A 保存 PATCH pending→Escape 取消→B 真实 SupplementDrawer 填写并 Save→PATCH 204 得 GET1、POST 201 得 GET2→先 GET2 fresh 2 条再 GET1 旧 1 条，两份 DTO 分离；④同链 GET1 晚 reject 不得清成错误整页，GET2 resolve 后无旧错误残留；公开 DOM＋真实 pinia/router＋受控 gate，不 stub 子 emit）：未改源 baseline 3 产品红（①activeElement=BODY、③头部回落「1 条原始记录」、④出现错误整页）＋②既有外部 focus 行为绿；④首断言红后错误残留段未执行，本轮新增的「GET2 挂起时 loading 文案仍在」断言 baseline 也未到达，不虚构为独立旧红。主 4 处 source 修后 new4＋既有 metadata-lifecycle 5＋raw-race 5＋dialog-a11y 6＝20/20 exit 0，一次运行无失败恢复，旧 16 未改；注释改为历史 baseline 语气，不加 case。
- 根真实 IAB（已通过，1280×720）与边界：既有自有普通 R56 合成 item `185ee2fc-48cc-458f-b876-3aaf3dd727de`，从「添加补充」打开、填入含首尾双空格/换行/字面 raw 的 62 字符/98 字节合成补充，关系补充→原 primary，一次真实 Enter 保存，raw 2→3，当前 DOM `activeElement === 当前「添加补充」` 为 true、focus-visible 2px、pageFits；新 62 字符逐字相等，原 primary 46 与 R63 旧 supplement 52 均经实际只读端点查看原文逐字等于保存前内存快照，截图根已看；item 数不变、无删除、无真实 Key/云调用。竞态乱序与外部焦点保留仅 jsdom mock 已验，不称实机强制乱序。本轮 check/build 未运行：已实施、定向 unit 验证通过，统一类型/构建后续 R68 已对当前稳定候选统一通过（与 R64 合并一次稳定候选 Web build；当时 R66 baseline 期间避免读到半成品），R59 旧 build 不覆盖本轮；未 commit/push/费用/生产/版本/正式验收。本节完成即释放 docs19 写入 owner。

## DT-R66｜Provider/Model 保存后的编辑触发器回焦（已完成，未提交；根审 source＋新 3 test 与 F1 校正接受，事实由根审定、本 owner 代记；独立会话实施，F1 由主接 owner）

- 产品变化（仅 `ProviderSettingsView.vue` 6 处约 +13 行、改 2 行）：限定两消费者 helper `refocusEditTriggerIfFocusLost(kind, id)` 用 `void nextTick`，当前 active 为 connected、非 BODY、原生非 disabled 即保留（含 readonly 输入 B）；提交前局部 `editingId` 快照，已有 Provider/Model 保存后 `await loadProviders` 再按 id 查询当前对应编辑 trigger，两个 data 属性真实绑定 backend id；无 Map/ref 表/epoch，旧 watch/关闭/payload/Key/权限/loader/请求时机/创建 Provider 持久 header opener 均不变，未扩创建 Model 触发器。
- 测试证据与验证（新 `save-focus.test` 恰好 3 case）：未改源首次 baseline 2 个实际产品红（两处当前 activeElement=BODY）＋③焦点保持部分曾绿；③曾向 readonly B 程序赋 value＋input，根判为不可达输入，不称真实在途草稿已绿。主接管 F1：GET pending 打开 B 时 readonly 且空只 focus；GET 完成同一 B 焦点保留并解锁后才输入 B，值保持/0 auto POST；activeWrapper afterEach 统一 unmount/unstub globals 避免预期红跳过末尾卸载。修复后 new3＋旧 saving3＋keyboard3＋v3 four＋m3 four＝5 files 17 断言全绿、Duration 1.06s；pnpm runner 退出码未捕获（zsh 管道 grep/tail 后误用 bash PIPESTATUS 为空），不为补数字重跑，不写已独立验证 unit exit 0；联合类型/构建由 R68 独立直接 exit 0。
- 边界：根已审 source、新 test 与 F1；无真实 Provider/Model/Key 写入，焦点行为仅 jsdom；未 commit/push/费用/生产/版本/正式验收。

## DT-R67｜详情正文读取后的正文回焦与外部焦点保留（已完成，未提交；根审 source＋新 3 test 与真实实机验收通过，事实由根审定、本 owner 代记；独立会话实施）

- 产品变化（仅 `ItemDetailView.vue` 3 处）：1 个 `rawContent` DOM ref、article `tabindex=-1`＋ref；无 matchedFragment 的成功读取后只在 active 无效时焦点落正文；外部有效 focus 不抢，既有命中 anchor 滚动/获焦原样；rawAbort/request/敏感确认/clipboard/RawDocument/CSS 均未动，`loadDetail` h1 原有 no-op 按根要求原位保留，本轮不再把 h1 视为有效路由回焦。
- 测试证据与验证（新 `raw-focus.test` 恰好 3 case：公开 DOM＋真实 Pinia/router＋合法 UTF-8 fragment＋gate）：未改源 baseline 一次 ①产品红②外部 focus 草稿 guard③命中 anchor＋scroll guard 绿，0 fixture 恢复；修复后 new3＋supp4＋metadata5＋rawrace5＋dialog6＝5 files 23 断言 exit 0，一次运行无恢复，旧 20 未改；2 处正文 trim 去掉成直接 textContent 逐字断言、历史 baseline 注释校正，仍 3 case。
- 根真实实机与边界（结束后已恢复 1280×720）：1280×720 现有 normal R56 item 按 Enter 读取 R65 新 62 字符正文，active 为 ARTICLE.raw-content `tabindex=-1`、focus-visible 2px、正文逐字与提交 62 相同，随后 Tab 到 PRE `tabindex=0`；390×844 切原 primary 46 后 Enter 同样落 article 2px、bounds 12–378/pageFits、46 逐字等于保存前快照、Tab 到 pre 0；只读 GET，无新写入/敏感揭示/Key，截图根已看。普通外部焦点与命中 fragment 仅 mock，无实机强制延迟/OS 读屏/200% zoom 认证；未 commit/push/费用/生产/版本/正式验收。

## DT-R68｜Web 联合类型检查与生产构建（已完成；纯构建验证、零源改动；根已核原命令真实工具结果并接受、BUILD_DONE 已实际通知 peer 且让出仅 trial1 窗口；独立新会话单主实施，本会话即实施与 docs19 写入 owner）

- 构建事实：唯一直接 `pnpm -C apps/web build`（内置 `pnpm check && vite build`），vue-tsc app＋tsc node 两个 compiler 零诊断，整体工具 exit 0；Vite 8.2.2 转换 3149 modules，built 874ms 仅 Vite 阶段、非整个命令耗时；`dist/` 正常 ignored 输出；历史 Monaco >500 kB chunk 提示原样非 fatal，不扩 chunk 策略。
- 边界：零源码变化、零修复重试，无重复 unit/check/build/full/release-check；根已发 BUILD_DONE 并让出仅 trial1 窗口，后续 profile 前仍需双方确认。未 commit/push/费用/生产/版本/正式验收。本节完成即释放 docs19 写入 owner。

## DT-R69｜会话过期恢复与 401 归属只读审计（只读审计完成，零源改动；两项源码可达候选尚无实跑，是重要发现记录而非修复完成；根已读主与 child 最终报告并接受口径；独立会话 1 主＋1 只读审计子 architect-auditor 均已自然结束，本会话即 docs19 写入 owner）

- 已确认正确：服务端每请求查库拒绝过期/撤销/改密后会话（`middleware.go` lookupSession 四条件）与撤销/过期 PAT，单 owner 归属、Origin＋`X-CSRF-Token` 常量时间比较、PAT scope 检查均正确；Web `bootstrap()` 刷新后收 401 回匿名路径正确；Web 无全局 401 handler，「旧 401 全局误退新会话」假设当前无入口，明确不加 epoch/全局 interceptor 机制。
- 候选一（源码可达/实机未验）会话失效后点击退出仍留在 App 内：`auth.logout()` 仅在 await POST 成功后 `clearAuthentication()`；失效 Cookie 认证返回 401 `AUTH_REQUIRED` 并清 Cookie，`apiRequest` 抛 `ApiError` 使 clear 不执行；`AppRail.vue:55–62` 仅 try/finally 无 catch，`App.vue:32` 仍 authenticated 挂 AppShell；`SecuritySettingsView.vue:227–237` 退出全部只显示 pageError 同样留在 App；手动刷新 bootstrap 401 清认证可恢复。后续优先在 logout 窄入口对 `AUTH_REQUIRED` 恢复，不先造全局任意 401 清认证，因 `AUTH_INVALID_CREDENTIALS` 也可在有效会话二验失败时返回 401。
- 候选二（源码＋[PostgreSQL Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html) 推导/尚未实跑；不叫越权漏洞，也不以 fail-closed「不建议改动/可用性 PASS」淡化）PAT 并发误拒绝：`middleware.go:212–251` SELECT 有效 PAT 后，`last_used_at` NULL 或闲置 ≥5 分钟进入带时间 WHERE 的 UPDATE；两个并发有效 Bearer 请求可都读旧值，先提交者更新时间，后者重判 WHERE 得 0 行，`246–248` 当认证失败，`107–109` 回 401 `AUTH_REQUIRED`；属公开 API 普通并发消费者。未来修复须保留撤销与 DB 错误拒绝，不能把所有 Rows0 放行；本轮未设计/改补丁。本轮检查约束：受重负载 HOLD，仅 source 与已有 test 文本读审、测试文本不当执行通过，runtime/HTTP/数据库访问与 unit/check/build 均未运行；两项候选的实跑复现待根另行安排窗口。未 commit/push/费用/生产/版本/正式验收。本节完成即释放 docs19 写入 owner。后续收口：候选一与候选二已分别由 DT-R71、DT-R72 实跑验证并修复完成，统一类型检查与生产构建由 DT-R73 通过（本节「尚无实跑」为当时历史口径，不回改）。

## DT-R71｜失效会话点击退出仍留在应用内的 logout 窄 401 恢复（已完成，未提交；根逐读 source/新 test 并核服务端 login/session DTO 接受；真实过期 Cookie/多 Tab 实机未验，统一类型检查/构建由 R73 通过；独立会话 1 主＋sole frontend-builder 测试子均已自然结束，R70 仅 source/test 只读复现准备、0 写 0 跑并入本轮前提、不单列章节；事实由根审定、本 owner 代记）

- 产品变化（仅 `apps/web/src/app/auth.ts` 的 `logout` 一处）：新增 try/catch，仅吞 `ApiError` status 401 且 code `AUTH_REQUIRED`，其它错误照常 throw；以局部快照比对既有 `session.id`，仅此新增的 401 恢复用它校验会话归属，防旧 401 清掉新登录会话；CSRF 早退与正常 204 既有路径不改，无 epoch/全局 interceptor（维持 R69 明确不加的结论）。
- 测试证据与验证（`auth.test.ts` 既有 2 断言未改、恰好新增 5：默认 logout；全部 401 `AUTH_REQUIRED` 时清认证；403 保会话并 reject；TypeError 保会话并 reject；公开双 logout 在途＋一个 204 后同 owner 经 public login 新建 session B、旧 401 晚到不得清 B——新 5 均走公开 action/真实 Pinia/独立 DTO，无 store 私写）：未改源 baseline 实际 2 产品红＋5 绿（共 7）；主一次同单文件稳定 7/7 真实 exit 0，无恢复重跑。
- 根审与边界：根已逐读 source 与新 test，并读服务端 login/session DTO 确认含 `session.id` 字段。实际过期 Cookie/多 Tab 未做真实 UI 验收，mock guard 不称 Cookie 竞争实机认证；统一类型检查与生产构建由 DT-R73 通过。未 commit/push/费用/生产/版本/正式验收。

## DT-R72｜PAT 并发首用误拒绝的 last_used_at 竞态修复（已完成，未提交；根完整读 source/test 接受，专用测试库与临时 env 已清理；独立会话 1 主＋sole backend-builder 测试子均已自然结束，R70 只读复现准备同并入前提；事实由根审定、本 owner 代记）

- 产品变化（仅 `apps/api/internal/auth/middleware.go` 的 `authenticatePAT` 一条 UPDATE，+1/−2）：`last_used_at` 赋值改为 `GREATEST(last_used_at, $2::timestamptz)`，WHERE 保留 id/revoked_at、去掉旧时间谓词；外层「NULL 或闲置 ≥5 分钟才进 UPDATE」的 Go 门槛与 `updateErr || RowsAffected != 1` 即拒绝均不改，不把全部 Rows0 放行，撤销与 DB 错误拒绝保留（R69 候选二修复）。
- 测试证据（新 `apps/api/integration/m3_pat_race_test.go` 恰好 1 个核心 case `TestM3PATConcurrentFirstUse`：走现有 M3 真实 API、公开 GET /api/v1/items、records:read scope、无 Cookie 双 Bearer、新 PAT `last_used_at` 为 NULL；以根事务行锁＋当前独立 DB 的 `pg_locks` JOIN `pg_stat_activity` distinct PID ≥2 作 gate 后释放，不靠固定 sleep 猜并发；buffered 结果/超时/defer 先 rollback 再 `server.Close()`）。
- 环境与验证（实际运行，真实退出码）：新建此前不存在的本地专用测试库 `dev_toolbox_dt_r72_test`（loopback/OrbStack，迁移 schema 10），绝不 reset/migrate/drop 旧 r06/r49 库。子实际 2 次 go vet——首败为 fixture HandlerFunc 参数的编译装置错、最小修后第二次 pass，不计产品红；随后 1 次真实触库 baseline 复现 [200,401]/`AUTH_REQUIRED` exit 1。修复后主 1 次 `go test -tags integration -count=1 ./integration -run '^(TestM3PATConcurrentFirstUse|TestM3ProviderPATAndExternalArtifact)$' -v`：new race PASS 0.50s＋既有 M3 PASS 0.96s、package 2.086s、go_test_rc=0，无 SKIP。
- 覆盖与边界：scope 不足 403、撤销 401、到期 401、Cookie+Bearer 混用 400 `AUTH_METHOD_CONFLICT` 等既有护栏通过；DB 失败拒绝仅源码保持、未做故障注入；单并发用例不称全矩阵/安全全部通过，Go 门槛不代表并发旧快照下严格 5 分钟仅一次物理 UPDATE。根完整读 source/test 接受，未加依赖/迁移/fixture 生产钩子。
- 验收后清理（主实际执行）：确认无测试进程、该库无连接后以无 FORCE `DROP` 精准删除本轮新建专用库，catalog count 0；仅删本轮新私有 env 文件并 rmdir 空目录，exists=false；旧 r06/r49 库仍在，API 18591（PID 12393）/Vite 18581（PID 12218）不变，资源清理已核 native 终报 05:34。

### R72 期间根脚本凭据暴露事件（单独记录，必须用户本人处理，文末有指针）

- 事实：R72 期间根的元数据检查脚本误将 keyword DSN 按 URL 解析，把本地非生产测试数据库的连接口令输出到本会话工具结果；属根的脚本错误，不归因 ZCode 产品/runner。根已向用户说明，后续检查已改为 URI/keyword 兼容且只输出白名单布尔结果的受控形式，不再输出原始字段。临时 env 与本轮专用测试库已清理，但不等同于共享本地 DB 凭据已轮换；本轮未修改任何密码/凭据，待用户统一核对私有配置使用方后决定是否轮换。本记录不含任何秘密值、DSN 或可重建凭据的片段，亦不以「全程未输出秘密」作总断言；未新造事故治理框架、未主动改口令。

## DT-R73｜认证修复后 Web 联合类型检查与生产构建（已完成；纯构建验证、零源改动；根已核原命令/两 compiler/Vite 3149 输出与真实整体 exit 0 并接受、DONE 已实际通知 peer；独立新会话单主实施，本会话即实施与 docs19 写入 owner）

- 构建事实：唯一直接 `pnpm -C apps/web build`（内置 `pnpm check && vite build`），vue-tsc app＋tsc node 两个 compiler 零诊断，真实整体 exit 0；Vite 8.2.2 转换 3149 modules，built 1.48s 仅 Vite 阶段、非整个命令耗时；`dist/` 正常 ignored 输出。历史 Monaco >500 kB chunk 提示原样非 fatal，不为 warning 改 chunk 策略；无 retry、无其它检查。
- 边界：R73 本身源码 0 改（R71/R72 修复见前两节，本构建即其后的统一验证）。根接受并实际发 DONE 给 peer；下一 perf 窗口须 peer 实际 RUN_START 方算启动，不预写已启动。正式发布、40 题人工评测、付费 Provider、备份恢复等既有用户事项状态不变；未 commit/push/费用/生产/版本/正式验收。本节完成即释放 docs19 写入 owner。

## DT-R74｜AppRail 局部退出失败反馈与关闭回焦（已完成，未提交；根审 source＋新 test 接受；独立会话实施，事实由根审定、本 owner 代记）

- 产品变化（退出路径源码 +54/-1）：局部退出失败可见反馈，原按钮解锁并支持手动重试，反馈关闭后回焦原按钮；保留 R38 图标，其余导航行为不动。新增 `apps/web/src/components/shell/AppRail.logout-feedback.test.ts` 最终 180 行 2 case；F1 把 fixture 日期改为 2099 并补关闭回焦的公开 DOM 断言。
- 验证（实际运行，保留真实退出码）：未改源 baseline 一次 2 红 exit 1；修复后一次 2/2 exit 0；无 fixture 恢复、无自动重试。
- 边界：真实浏览器注入退出错误、390 错误态、读屏未验；类型检查由 DT-R78 覆盖。未 commit/push/费用/生产/版本/正式验收。

## DT-R75｜助手首次可用路径只读审读（只读完成，零源改动；独立会话实施，事实由根审定、本 owner 代记）

- 仅 source 审读，无 blocker；未运行真实 Provider 与评测，不称运行验证通过。

## DT-R76｜AssistantThread 知识索引禁用指引文案（已完成，未提交；根审接受；独立会话实施，事实由根审定、本 owner 代记）

- 产品变化（仅 `AssistantThread.vue` +2 分支）：knowledge.status=disabled 时标题与说明指引「可继续一般交流，或去设置启用 Embedding」；temporary 优先与 send 逻辑不动。无新测试、无真实配置写入；类型检查由 DT-R78 覆盖。

## DT-R77｜AuthView MFA 过期路径只读候选（只读候选记录，非已确认缺陷；独立会话实施，事实由根审定、本 owner 代记）

- 只读候选：MFA challenge 过期可能无「回密码/重启」路径；尚未核后端真实 TTL、错误码与实跑。不称已确认缺陷或修复，留给根后续验证。后续见 DT-R84 收口。

## DT-R78｜Web 生产构建计时（已完成；纯构建验证、零源改动；根核接受；独立会话实施，事实由根审定、本 owner 代记）

- 构建事实：一次 `time pnpm -C apps/web build` 真实整体 exit 0；vue-tsc app＋tsc node 两 compiler 零诊断；Vite 8.2.2 转换 3149 modules、1.86s 仅 Vite 阶段，总墙钟 7.847s；零源码改动。
- 覆盖：根已读 tsconfig.app.json（src/**/*.ts 无排除），R74 新测试确实参与 typecheck。

## DT-R79｜冻结工作区全量 OCR（已完成；用户要求的唯一次完整 OCR；ZCode 主＋3 只读审读子均实际 GLM-5.3；事实由根审定、本 owner 代记）

- 范围：main@0101814 → R78 结束后的冻结工作区，全部 staged/unstaged/untracked：56 修改＋74 新＝130（staged 0）；不是近期模块、不是 HEAD 空 range。
- 方式：实际调用用户的 open-code-review-delegate 技能（ocr delegate preview/rule）；OCR 做文件/规则，主＋3 只读子审读，无额外 LLM endpoint。42 源码＋53 测试＋6 文档配置＝101 正文全文完成；6 个生成 YML 仅键名/敏感标签值检查；23 张 PNG 明确跳过，不称看图。
- 返工：根发现子 C 21 个新测试读不足，原 100% 结论撤回；同一个 R79 内续用原 C 补齐 21/21 未读正文后定稿、无新增 finding，不是新开/分开的审计。
- 结论与处置：最终 0 critical/high/medium、7 low。L3→DT-R80、L5→DT-R81 修复；L1 由 DT-R83 纯排版闭合；L7 由 DT-R83 文档闭合；L4 跨 source 换行偏好本轮不动；L2 nginx 65s 与摘要 60s 维持既有取舍、不追加心跳；L8 原有用户 QA 产物保留、不 ignore/delete；L6 明确当前不可达，移出 finding、作为不采纳的未来对称性建议。
- 边界：源级审计无任何测试/构建/runtime 调用；R80 及之后的改动属审计后修复、由各轮自行验证，不属于冻结审计范围。原有 dirty 31 项与窗口 99 项仅作时间窗分类，不以 mtime 推作者归属。

## DT-R80｜Provider 设置页失败增量提示（已完成，未提交；根审 source＋新 case 接受；独立会话实施，事实由根审定、本 owner 代记）

- 产品变化（仅 `ProviderSettingsView.vue` +2/-1）：同 generation 已展开中间页时，比较本次 failed 与上次有效 indexStatus.failed 的增长来提示，避免直接删除 cursor 条件后按未加载长度误报；分页/手动刷新不动。
- 验证（对应测试新增 1 case、+91 行）：150 失败已加载 100 且还有 page3 时，150→150 不提示不重取；150→151 提示并保留 100 项/游标；点击才重取首页 50 含新失败。未改源 baseline 一次 1 红 9 绿（524 行 refreshEntry undefined；zsh PIPESTATUS 未取到数值，ELIFECYCLE 非零，不写精确 exit 1、不为数字重跑）；修复后一次 10/10 exit 0。类型由 DT-R82 覆盖。

## DT-R81｜SafeMarkdown 复制反馈焦点恢复（已完成，未提交；根审 source＋新 3 test 与真实 IAB 键盘验收通过；独立会话实施，事实由根审定、本 owner 代记）

- 产品变化（仅 `SafeMarkdown.vue`，源码首版 +32/-15、F1 +8/-4）：私有 focus 快照恢复只覆盖本组件 wrap/copy/1600ms 反馈，单 feedbackTimer＋卸载清理；F1 后仅同 root/同 source 且焦点只落 BODY 或原 active 才恢复，尊重外部主动焦点。不改安全 renderer/v-html/HTML/CSS/props/消费者，未实施审计 L4。
- 验证（新测试 +83 行恰好 3 case，旧 5 case 不动）：未改源 baseline 一次 2 红 6 绿 exit 1（135 pre/162 link 焦点变 BODY）；首修一次 8/8 exit 0；F1 改 source 后仅重跑同文件一次 8/8 exit 0，无 fixture 恢复。
- 根真实 IAB（深色 1280×720）键盘三项通过：Return 复制成功 → Tab 到 PRE；Tab 两次到链接；ShiftTab 三次到外部主记录按钮；每项复制反馈消失（等待 1.8s）后焦点仍在对应当前 PRE/链接/外部同按钮，链接从未打开。新建本地纯合成 Markdown 样本 1262988b-3afb-4695-8579-ce6f42b15d30（标题「DT-R81 合成焦点验收」，一条原始记录）；旧 R56 及其它记录未改，未发 Provider。
- 边界：原生 before 修复探针一次因只读 DOM scope 不支持 document.hasFocus，未取得完整 before 快照、仅观察到最终 BODY，不称完整浏览器 baseline，正式复现依实际 jsdom 红灯；浏览器矩阵/读屏/移动缩放/真实用户数据未验证。

## DT-R82｜审计修复后 Web 联合类型检查与生产构建（已完成；纯构建验证、零源改动；根核接受、BUILD_DONE 已实际通知 peer；独立会话实施，事实由根审定、本 owner 代记）

- 构建事实：唯一直接 `pnpm -C apps/web build` 一次真实整体 exit 0；vue-tsc app＋tsc node 均零诊断（含新增 tests 类型）；Vite 8.2.2 转换 3149 modules、built 864ms 仅 Vite 阶段，总墙钟未测；仅历史 Monaco >500 kB 非 fatal。
- 边界：无修复/源码写入/额外 unit/check/E2E；当前 NO_PERF，旧 trial2/3 不算启动。

## DT-R83｜迭代记录补齐与测试纯排版（本文件＋`temporary_test.go` 两处写入；根审定代记，本会话即本轮 owner）

- 写入仅两处：`apps/api/internal/assistant/temporary_test.go` 315 行纯排版——左花括号后的 TAB 改为换行＋同级 TAB，使 `summary` 单独一行，严格纯空白、无其它 token/断言变动，未全文件 gofmt；以及本文件 R74–R83 补记。
- 验证边界：本轮未再运行任何 Go 测试/vet/编译与 Web 检查/构建/runtime；上文各轮结果均为各自轮次的历史事实，不由本轮重跑，也不回写为本次执行。
- 既有事项不变：文末「必须用户本人处理的事项」四项原样保留（付费真实云评测；生产/版本/tag/正式验收；品牌域名；R72 共享本地 DB 凭据轮换需本人，见 DT-R72 事件小节）；不泄露秘密值、不归因到 ZCode；审计 L4 与旧 QA 文件不新增「必须用户本人」阻塞。本节完成即释放 docs19 写入 owner。

## DT-R84｜AuthView MFA 过期后用户主动「重新输入密码」恢复入口（已完成，未提交；根完整读 source/新 test/F1 并接受；独立会话 1 主＋1 测试子与 F1 均已自然结束，事实由根审定、本 owner 代记；Web 类型构建由 DT-R85 补记）

- 产品变化（仅 `AuthView.vue` +11 行）：passwordInput ref＋模板 ref；restartLogin 调既有公开 auth.clearAuthentication＋nextTick 密码回焦；MFA 表单主按钮后新增 ghost「重新输入密码」（type=button、:disabled=busy）；沿用 watch(stage) 清 error/code，保留 username/method/trustDevice/deviceName；auth.ts/Go/协议/CSS 无改。
- 后端事实（根核 Go 源）：MFA challenge TTL 5min、失败最多 5 次、HTTP 401 统一 AUTH_INVALID_CREDENTIALS（过期与输错不可区分）；本修复只提供用户主动恢复，不做 401 自动回密码。
- 测试（新 `AuthView.mfa-restart.test.ts` 218 行恰好 2 case，全部合成数据、真实 Pinia/DOM、不写私有 stage）实际 4 次运行：①首轮 2 failed exit 1 为装置错（原生 click 前未等 Vue 更新、按钮仍 disabled），非产品红；②修 submit 装置后 2 failed exit 1：it② 缺恢复入口 undefined 是真产品红，it① 同步 disabled 断言仍缺 await 属装置错，该断言加 await 后未再跑 baseline、不称该版本 2 例都产品红；③生产实现后 2 passed exit 0；④根 F1 仅改 test 提交 helper（async 先 flushPromises、断言真实 primary 为 HTMLButtonElement 且 enabled、原生 click 后 flush、6 处调用均 await）后 2 passed exit 0。实跑证明 jsdom30 支持该 enabled 原生 click 触发 @submit.prevent，「jsdom 不实现隐式提交」早期归因已撤回，form dispatch 适配预案未使用。
- 最终 2 例覆盖：模拟 401 后仍停 MFA、不自动重试；清空 code 后仍能回密码页（type=button 不受 required 提交影响）；username 非默认值保留、password 空、旧 error code-expiry 清理、password 获焦、点击恢复 0 新请求（无 logout/额外 bootstrap）；手动再登录取 challengeB、verify body 用 B 非 A 并由合成 authenticated DTO 完成登录；deferred verify pending 时恢复按钮原生 disabled、click 无效，gate 401 后解锁。
- 边界：非实际等待 5min、非实际服务器 MFA 过期或真实密码/TOTP 配置验证；未做真实浏览器 MFA/视觉/读屏/移动缩放/全量 auth 或 Go 测试；DT-R85 未重跑 R84 unit；root 既有 IAB 已登录合成 Markdown 页不动。

## DT-R85｜MFA 恢复收口后 Web 联合类型检查与生产构建（已完成；纯构建验证、零源改动；独立会话单主实施，本会话即本轮与 docs19 写入 owner）

- 构建事实：唯一直接 `pnpm -C apps/web build` 一次真实整体 exit 0；vue-tsc app＋tsc node 两 compiler 零诊断（含 R84 新测试类型，未发生任何类型修正）；Vite 8.2.2 转换 3149 modules、built 1.04s 仅 Vite 阶段，总墙钟未测；仅历史 Monaco >500 kB 非 fatal 提示。
- 边界：源码与测试零写入、无额外 unit/check/E2E/lint、无发版与版本动作；本轮唯一写入为本文件 R84/R85 两节及 R77 段末收口指针；DT-R86 尚处只读准备，不写为已修复。本节完成即释放 docs19 写入 owner。

## DT-R86｜AuthView 绑定恢复：loading/500 重试、reset 可取消、pending 互斥锁（已完成，未提交；根完整读 AuthView 增量与新增 334 行 3 case 并接受；独立会话 1 主＋1 GLM-5.3 测试子均已自然结束，事实由根审定、本 owner 代记；Web 类型构建与机械检查由 DT-R87 补记）

- 产品变化（仅 `AuthView.vue`，本轮增量 +58/-13；相对 Codex 基点 0101814 该文件累计 +73/-24，累计含此前改动不全归本轮）：watch 与手动 retry 复用 loadProvisioning；submitLogin finally 在 totp_setup 不清 busy、由 loader 接管；原 grid 内取消移到顶层统一操作行，无 provisioning 时提供手动重取；初次绑定始终可重新输入密码，reset 始终可取消并保留原 session/csrf；三动作 busy 时原生 disabled；手动 retry 成功失焦回标题、失败失焦回 retry，保留外部已有焦点。AuthStore/Go/协议/依赖/CSS 无改。
- 测试（新 `AuthView.enrollment-recovery.test.ts` 恰 3 case、334 行，真实 Pinia/公开 DOM/原生 enabled click/合成 fetch）：A 加载 pending 锁＋500 后同 challenge 重试 200 回标题、已加载 QR confirm 401 后本地回密码；B reset setup 500 无 QR 仍可 cancel 回原 session/csrf；C confirm pending 禁止 cancel、401 解锁后取消。两次 unit 历史：未改源 baseline 仅一次，Test Files 1 failed/Tests 3 failed（测试行 120 loading 消失、242 无取消、308 取消未 disabled，均产品真实红；命令 pipe tail＋echo $?，pnpm 精确数字 exit 未取得、仅记 ELIFECYCLE 非零，不采 echo 0，未修 fixture、未重放 baseline）；修复后仅一次定向新 3＋受共享 submitLogin 影响既有 R84 MFA 2 同批回归＝2 files/5 tests passed，pipe tail25 但以 zsh pipestatus[1] 取得 pnpm 实际 EXIT=0，根在原生终端展开原输出读到 Vitest 4.1.11、3＋2 通过后接受。此后无测试输入变化，未重跑绿测。
- 边界：无真实 MFA/密码/Key 变更、未等真实 5min；不称浏览器/读屏/手机验证；手动 retry 再次失败的焦点分支与外部焦点保留尚无显式 unit，未覆盖（不称「必须有第 4 例」）；测试子未运行项目测试/构建、未安装或写 Git 及其它文件，但曾用 ls/grep/node require.resolve 只读定位 jsdom 源码，非全程零命令。

## DT-R87｜绑定恢复后 Web 构建、机械检查与文档交接（已完成；纯构建/detector 验证、零源码改动；独立会话单主实施，本会话即本轮与 docs19 写入 owner）

- 构建事实：唯一直接 `pnpm -C /Users/hxf/projects/idea/dev-toolbox/apps/web build` 一次真实整体 exit 0（无 pipe/tail/tee/echo，保留工具原退出值）；vue-tsc app＋tsc node 两 compiler 零诊断（含 R86 新测试类型，未发生任何类型修正）；Vite 8.2.2 转换 3149 modules、built 904ms 仅 Vite 阶段、总墙钟未测；仅历史 Monaco 相关大 chunk（jsonMode 1,207.81 kB、editor.api 2,656.20 kB）>500 kB 非 fatal 警告，无源码/测试改动。
- 机械检查：唯一次直接 `node /Users/hxf/.codex/skills/impeccable/scripts/detect.mjs --json apps/web/src/modules/auth/AuthView.vue`（cwd 仓库根），返回 `[]` 零命中——新增相关与该文件旧有风格（eyebrow/gradient 等）均无命中；无 hook 安装、无 config 写入、未跑 context 第二遍。
- 写入仅本文件三处：R86/R87 两节追加于「待处理已证实事项」之前，＋R84 边界一处勘误（「历史 R84 unit 不由后续轮次重跑」改为「DT-R85 未重跑 R84 unit」；R86 共享源码真实变化时已合理同批回归 R84 两例）；其余历史、文末四项用户事项与 R79 审计冻结范围原样。
- 边界：无 Docker/DB/服务启停/真实 HTTP/MFA/Provider/付费/凭据操作，无 git commit/push/tag/部署/版本号/正式验收；原 dirty AGENTS、deploynginx、.playwright-mcp 与私有配置未动；未提交、未发布。本节完成即释放 docs19 写入 owner。

## DT-R88｜恢复码「全部复制」失败反馈：直接复用 CopyButton（已完成，未提交；根已读 AuthView R88 变化（增量 +7/-10）、新 130 行 1 it、R88 原始 1/1 通过输出、类型 build 0 诊断与机械 `[]` 及本记录并接受，合成 IAB 浏览器补验见 DT-R89；独立会话 1 主＋1 GLM-5.3 frontend-builder 测试子均已自然结束，本会话即本轮与 docs19 写入 owner）

- 产品变化（仅 `AuthView.vue`）：recovery_codes 操作行「全部复制」由原无 catch 的 copyRecoveryCodes（剪贴板拒绝时仅余未处理 NotAllowedError 拒绝与 Vue warn、页面零本地反馈；恢复码本就可手选/下载，定性为 UX 反馈缺失、非安全漏洞）替换为既有 `modules/tools/shared/ui/CopyButton.vue`（`:text="auth.recoveryCodes.join('\n')"`＋`label="全部复制"`），失败即渲染 role=alert「复制失败：浏览器未允许写入剪贴板，请手动选择并复制。」、成功 aria-live「已复制」；删除原 copied ref 与 copyRecoveryCodes 函数；下载备份、10 码列表、「我已保存并继续」及 R84/R86 全部恢复入口/busy/焦点逻辑不动；CopyButton/UiButton/auth.ts/Go/协议/依赖零改动，未移动通用组件、未新建 helper。
- CSS：仅既有 max-720px 块内追加 `.recovery__actions :deep(.copy-button .button) { width: 100%; }`——CopyButton 根为 span，原 `.recovery__actions > *` 全宽规则只作用于 wrapper，需穿透使内部原生 button 手机保持全宽；源级消费者修正，非 390 实测。
- 测试（新 `AuthView.recovery-copy.test.ts` 恰 1 describe/1 it，唯一测试子交付、只写该新文件、未跑任何项目命令）：真实 Pinia 经公开 `auth.bootstrap()`（mock authenticated owner/session/csrf）→ 公开 `auth.regenerateRecoveryCodes(全合成 password/method/code)`（mock 10 个合成恢复码）直达 recovery_codes 后 mount attachTo document.body；navigator.clipboard 整体替换 writeText（首拒 NotAllowedError、次 resolve），原 descriptor 保存/还原，unmount/stub 清理。两次 unit 历史：未改源 baseline 直接一次真实 exit 1（Test Files 1 failed/Tests 1 failed/Errors 1）——测试 98 行 `[role="alert"]` 为 null 的产品真实红，且 Vitest 捕获 1 个 Unhandled Rejection `NotAllowedError: denied`＋`[Vue warn]: Unhandled error during execution of native event handler`（无 catch 的真实产品路径，未包装为 fixture 绿、未注册全局 errorHandler 掩盖）；替换后同命令一次 1 file/1 test passed（Duration 495ms）——首拒后 alert 含剪贴板/手动、原 10 码全文与 stage recovery_codes 不变、下载备份/我已保存继续仍 enabled、fetch 维持 bootstrap＋regenerate 共 2 次；第二次原生 click 后 alert 消失、按钮显示已复制（aria-live）、writeText 收到 10 码以 U+000A 逐码 join 的精确文本（split('\n') 长度 10 逐码相等）、零额外 HTTP、session/CSRF 快照不变。1600ms timer 矩阵未重复（CopyButton 自身已测）、未 fake timers/推进时钟、未点击下载/继续、未触系统真实剪贴板、未 import 其它 *.test.ts。R84/R86/CopyButton 既有测试未重跑（其内容与受测逻辑未改）。
- 构建与机械检查：唯一直接 `pnpm -C /Users/hxf/projects/idea/dev-toolbox/apps/web build` 一次真实整体 exit 0（无 pipe/tail/tee/echo，保留工具原退出值）；`pnpm check`＝vue-tsc --noEmit（app）＋tsc --noEmit（node）两 compiler 零诊断（含新测试类型，未发生任何类型修正；两 compiler 阶段工具无耗时输出、不编数字）；Vite 8.2.2 转换 3149 modules、built 892ms 仅 Vite 阶段、总墙钟未测；仅历史 Monaco 大 chunk >500 kB 非 fatal 警告。唯一次 `node /Users/hxf/.codex/skills/impeccable/scripts/detect.mjs --json apps/web/src/modules/auth/AuthView.vue`（cwd 仓库根）返回 `[]` 零命中；无 hook/config 写入、未跑 context 第二遍。
- 边界：手机全宽仅源级推导，390/浏览器/读屏/深浅色实机未验；无真实恢复码/密码/Key/MFA 变更、无真实 HTTP/DB/Docker/Provider/付费动作；无 git commit/push/tag/部署/版本号/正式验收；原 dirty AGENTS、deploynginx、.playwright-mcp 与私有配置未动；未提交、未发布。本轮 docs 写入仅本文件本节一处，插于「待处理已证实事项」之前，其余历史与文末四项用户事项原样。

## DT-R89｜恢复码复制的隔离合成浏览器补验与 R88 收口（已完成；纯外部夹具＋浏览器 QA、零产品源码改动；独立会话单主实施，本会话即本轮与 docs19 写入 owner）

- 预验准备（临时夹具，不入仓库）：`/Users/hxf/.cache/dev-toolbox-lab/r89-recovery-preview/` 仅 index.html/main.ts/vite.config.ts 3 个临时文件＋node_modules symlink 与本地 `.vite-cache`；真实加载仓库 AuthView.vue/CopyButton/UiButton/UiIcon、`app/auth.ts` store 与 design tokens，产品源零复制零改动。fetch 本页全量封闭：GET `/api/v1/auth/session` 合成 authenticated owner/session/csrf（不含恢复码）、POST `/api/v1/auth/totp/recovery-codes/regenerate` 合成 10 个 SYNTH-批次码，其余请求一律 502 拦截并计数；进入 recovery_codes 仅经真实公开 `auth.bootstrap()`→`auth.regenerateRecoveryCodes()`（合成占位参数）；navigator.clipboard 整体替身（默认拒绝 NotAllowedError、面板可切仅 resolve 成功），不申请权限、不读写系统真实剪贴板；服务仅 127.0.0.1:18582、无 proxy。初版相对路径多一层导致依赖扫描失败的启动期问题在正式打开前已修正（运行时模块/预打包均验证 200），属夹具自纠、不包装为产品缺陷、不作为一次启动无修复。产品源在 R88 green/build 后未再变化，本轮零 unit/build/detector/context/E2E。
- 根 CUA 合成 IAB 实测（默认深色 1280×720）：原生 Return 触发「全部复制」拒绝，role=alert 显示「复制失败：浏览器未允许写入剪贴板，请手动选择并复制。」，10 码逐字不变、stage 保持 recovery_codes；复制/下载/继续均 enabled、按钮高 40px；根切「模拟复制成功」再 Return 手动重试，alert 消失、aria-live/按钮瞬态「已复制」，焦点仍在复制按钮；面板剪贴板调用 1→2、最近一次匹配合成 10 码=是、未放行 API 拦截 0、批次 1。
- 390×844 模拟视口（非物理手机）：同路径拒绝→手动切成功→重试，累计 4 次剪贴板调用均匹配同批次 10 个 SYNTH 码，stage 与拦截计数不变；复制/下载/继续三按钮均 292×40 CSS px 相等、填满 actions 宽 292（夹具外层含 16px 说明区 padding，292 为夹具内测量，不冒充真实 App 全屏固定宽度）；document.scrollWidth=clientWidth=390 无横向溢出，错误文字自然换行；Tab 两次从复制经下载到继续仅聚焦未点击激活，stage 不变；未点击下载与「我已保存并继续」，不称实际下载已测。截图以最终实际 viewport 为准（首个整页截图因 100dvh 截图时重排造成图片截断，已弃用替换，不作失败或通过证据），存于根本地可视化目录并向用户展示 desktop-error 与 mobile-success。
- 收口与边界：viewport.reset 后 DOM 实读恢复 1280×720；预览 Vite（PID 91018、127.0.0.1:18582）经核对命令行/cwd/监听归属确系本预览后 managed 终止，复验进程已退出、18582 不再监听（managed killed 为预期停止，非运行崩溃）；r89 临时文件与缓存按指示保留。全程未动真实账号/密码/TOTP/Key/系统剪贴板，无真实后台认证、无付费/API 配额/DB/生产动作；Chrome/Safari 完整矩阵、读屏、物理手机、浅色与缩放未验，不扩大结论；无 git commit/push/tag/发布/版本号。本轮 docs 写入仅本文件两处：R88 头部收口一句＋本节，插于「待处理已证实事项」之前，其余历史与文末四项用户事项原样。

## DT-R90｜共享 CopyButton 复制反馈只对应当前文本（已实施、7 case 定向验证与构建/机械检查通过，未提交；根已读最终 source、新 2 it 与旧 4/前缀未动、原 7 通过输出及记录并接受，收口完成；独立会话 1 主＋1 GLM-5.3 frontend-builder 测试子均已自然结束，本会话即本轮与 docs19 写入 owner）

- 缺陷与真实消费者（先经 DT-R90 只读核实确认候选，本节为实施记录）：共享 `modules/tools/shared/ui/CopyButton.vue` 的 copied/failed 只由 copy() 与 1600ms timer 改变、不随 props.text 变化，且 copy() 的 await navigator.clipboard.writeText 落定后无条件写状态。两条真实可达路径：①复制成功后 1600ms 内结果文本变化（YamlView input/mode watch 置 output='' 或重跑写入新 output，结果 pane 的 CopyButton 无 v-if/key 持续挂载），同一按钮对空/新文本仍显示旧「已复制」；②剪贴板 promise pending 期间 text 变化，晚到成功/拒绝把旧反馈挂到新文本，拒绝分支还会 emit 旧 error 且 failed 无 timer、残留至下次成功复制。同类第二消费者 `JsonView.vue:707` 同 `:text="output"` 绑定模式佐证组件级修复的单一 owner 定位（不采用消费者换 key 方案）。定性仅「当前文本的反馈可信度」：非剪贴板错写、非数据丢失、非安全漏洞（A 场景当时点击的文本确实已写入剪贴板）。
- source（唯一 source writer＝主，仅 CopyButton.vue 最小 diff）：import 增 watch；新增 `watch(() => props.text)`（实际变化时）复用既有 clearFeedbackTimer 并置 copied/failed=false；copy() 开头 `const text = props.text`、writeText(text)，await 成功/失败落定后先比当前 props.text 与捕获 text，不同则直接 return（不写状态、不起 timer、不 emit 旧 error），相同沿用原分支。A→B→A 文本相等采信旧反馈；不引请求序号/epoch/hash/全局 store/disposed 框架/copier helper；模板、CSS、props、error 协议、onBeforeUnmount 清 timer、UiButton 与所有消费者零改动，Base64 等独立复制实现未迁移。
- 测试（唯一测试 writer＝frontend-builder 子，只写 `CopyButton.test.ts`——该文件为迭代期未提交新文件；原 4 it、顶部常量与 installClipboard/flushCopyWork/afterEach 逐行未动，仅在既有 describe 末尾追加恰 2 it，名称均含小写 "new text"，旧 4 名称不含该子串）：①`clears copied and error feedback synchronously when the text prop changes to a new text`——A 复制成功显示「已复制」→setProps B 后立即回原 label 且无 role=alert→B 复制拒绝出现含「剪贴板」alert→setProps C 后旧 alert 清空、原 label、按钮 enabled；writeText 第 1/2 次精确收到 A/B。②`ignores late-settling stale copy promises so feedback only reflects the new text`——A 写入 pending→setProps B→resolve A 不给 B 挂「已复制」；B 写入 pending→setProps C→reject B 对 C 无 alert 且公开 emitted('error') 为 undefined；最后 C 真正复制成功恢复「已复制」；writeText 第 1/2/3 次精确收到 A/B/C。装置：vi.useFakeTimers、复用既有 installClipboard/flushCopyWork/afterEach、每次点击前断言真实 HTMLButtonElement 且 disabled===false 后 native .element.click()、props 仅经公开 await setProps、不用私有 vm/trigger；手动 gate 用普通 new Promise 与 resolve/reject 闭包（未用 Promise.withResolvers，合 ES2023 lib 约束），try/finally 对未落定 gate 只 resolve 防 unhandled rejection；不推进 1600ms、不重复旧 timer 矩阵；全 synthetic，未触真实 OS 剪贴板。
- 验证（全部真实退出码，无 pipe/tail/tee/echo）：baseline 唯一一次 `pnpm -C /Users/hxf/projects/idea/dev-toolbox/apps/web test src/modules/tools/shared/ui/CopyButton.test.ts -t 'new text'` 真实 exit 1——新 2 真实产品红（Case 1 于测试 156 行 setProps 后「已复制」残留、Case 2 于 225 行 A 晚到成功挂到 B，均在各自首个断言失败，后续分支未跑到，不称每分支红测）、旧 4 skipped、无 fixture/unhandled 错误。source 修复后唯一定向 7 case `pnpm -C …/apps/web test src/modules/tools/shared/ui/CopyButton.test.ts src/modules/auth/AuthView.recovery-copy.test.ts` 真实整体 exit 0（Test Files 2 passed / Tests 7 passed / Duration 568ms），一次通过无返工；R88 recovery-copy 1 case 同批回归（CopyButton 共享源真实变化），MFA/YAML 全矩阵等未变部分未重跑。唯一次 `pnpm -C …/apps/web build` 真实整体 exit 0：vue-tsc（app）＋tsc（node）两 compiler 零诊断（含新 2 it 类型，未发生任何类型修正）、Vite 8.2.2 转换 3149 modules ✓ built in 1.05s、仅历史 Monaco 大 chunk >500 kB 非 fatal 警告。唯一次 `node /Users/hxf/.codex/skills/impeccable/scripts/detect.mjs --json apps/web/src/modules/tools/shared/ui/CopyButton.vue`（cwd 仓库根）返回 `[]` 零命中；旧 R88 AuthView `[]` 不冒充本轮覆盖，无 context 重跑/hook/config 写入。
- 边界：真实浏览器延迟剪贴板、系统权限弹窗与真实 OS 剪贴板未验（全部 synthetic unit）；多工具页消费者仅源级推导（YAML 直接读、JSON 定位 1 处佐证），未逐一浏览器验证；A→B→A 采信语义为文本相等而非请求序，同文本不同来源的极端场景未单测。无真实 Clipboard/HTTP/API/DB/Docker/Provider/费用/凭据/服务启停，未重启 R89 预览；无 git commit/push/tag/部署/版本号/正式验收；R79 审计冻结范围未变；原 dirty AGENTS、nginx、.playwright-mcp、历史事实与私有配置未动。本轮 docs 写入仅本文件本节一处，插于「待处理已证实事项」之前，其余历史与文末四项用户事项原样。本节完成即释放 docs19 写入 owner，根收口结论由根读最终 diff/test 后另行确认。

## DT-R91｜90 轮累计改动组合的本地全包单测回归（已完成，未提交；非发布门禁、非正式验收；本轮 1 主＋1 唯一 GLM-5.3 frontend-builder 检查子均已自然结束，本会话即本轮与 docs19 写入 owner）

- 范围与目的：验证 90 轮累计未提交改动在跨文件组合下的整体表现，不再以各小模块定向用例（如 R90 7 case）代替整体；不做 OCR/全库审计、release-check、发布、备份/恢复、性能与完整浏览器矩阵。根已向用户说明本地全包单测范围且当前无全包耗时基线；本轮零产品 source/test/config 写入，R90 定向 7 case 已包含在全包内未单独重跑，Web 类型/build R90 稳定候选已过未重复，未启动任何浏览器/服务/容器。
- Web 全包 unit（主执行，唯一一次 `CI=1 pnpm -C …/apps/web test`，vitest 4.1.11＋pnpm 11.9.0，真实 exit 0）：Test Files 99 passed (99)、Tests 543 passed (543)、0 skip/0 fail，Duration 14.44s。运行前定向读 `apps/web/package.json` 与 `vite.config.ts`：jsdom＋globals、无 setupFiles、无浏览器模式，`server.proxy` 仅作用于 dev server 不影响 vitest run，配置层无真实 API/DB/Provider 激活；输出中大量 VUE_ROUTER_R0004 警告为既有测试 router stub 的预期 stderr，非失败。
- AI-worker 全包（唯一检查子执行，各恰好一次）：`CI=1 pnpm -C …/apps/ai-worker test` 真实 exit 0——Test Files 19 passed (19)、Tests 228 passed (228)、0 skip/0 fail、Duration 15.01s（vitest 4.1.11）；`pnpm -C …/apps/ai-worker check`（tsc -p tsconfig.json --noEmit）真实 exit 0 零诊断——既有 tsconfig 排除 `src/**/*.test.ts`，该零诊断只覆盖生产代码，测试文件的类型正确性不由该 check 证明；node v22.23.1、pnpm 11.9.0。子先行定向读 package.json/tsconfig/vitest 默认配置与激活门：无 setupFiles，19 个测试文件中 process.env 仅 worker-process.test.ts 一处且关键变量全部覆写为本机 mock，所有 HTTP 均为 127.0.0.1 回环 fixture、非本机 URL 一律保留 TLD＋stub fetch（finally 恢复），未发现真实外部调用门或配额消耗。
- Go 非库单测（主执行，唯一一次 `env -u TEST_DATABASE_URL -u RUN_M5_RECOVERY_FIXTURE -u RUN_M5_PERFORMANCE -u RUN_M5_FULL_STORAGE GOPROXY=off GOFLAGS=-mod=readonly go -C …/apps/api test -count=1 -json ./...`，本机 go1.27.1 darwin/arm64 ≥ go.mod 要求 1.27.0 无需下载工具链，真实整体 exit 0，stderr 空）：14 个包中 11 个含测试包全部通过（182 个测试通过事件＝147 顶层＋35 子测试，含 7 个带子测试的父测试自身的通过事件计数，非去重叶子用例数；0 failed / 0 skipped），3 个 `cmd/*` 包无测试文件（包级 skip＝no test files）；go.mod/go.sum 未变（readonly＋off 保证）。运行前有界核实测试门：`integration/` 全部文件与 `internal/assistant/summary_store_test.go` 均带 `//go:build integration`，默认 `./...` 不编译不运行——本轮 DB/恢复/性能集成属「未纳入运行」而非「运行后跳过」；即便强制纳入，TEST_DATABASE_URL 为空与三个 RUN_M5_* 门未设时也均为 t.Skip 不触库。
- 真实统计汇总：三路合计 953 个通过事件（Web 543＋AI-worker 228＋Go 182；Go 182 为 147 顶层＋35 子测试的测试通过事件、含父测试计数，非去重叶子用例数）全部通过、0 失败、0 跳过（Go 集成未纳入不计 skip）；完整临时日志留 `/tmp/dt-r91-web-test.log`、`/tmp/dt-r91-aiworker-test.log`、`/tmp/dt-r91-aiworker-check.log`、`/tmp/dt-r91-go-test.jsonl` 供根审阅。
- 未验证边界（不得据此宣称集成已跑）：DB 集成（M1–M5/v2/v3/agent-console/summary_store）、恢复/性能/全量存储演练、migrations、真实云与真实 Provider、真实浏览器矩阵、release-check 与发布门禁均未运行；Go 四门在子进程 env -u 清空、未读取/未打印原值、未 source deploy/.env；本轮全绿仅代表当前未提交工作区的本地合成 unit 组合，不代表 V3 正式验收完成（docs16 §20.3 及文末四项用户事项边界不变）。
- 本轮 docs 写入仅本文件两处：R90 头部根收口状态一句＋本节，插于「待处理已证实事项」之前，其余历史、R79 唯一次审计范围与文末四项用户事项原样。

## DT-R92｜真实 DB 迁移与带标签两包回归（迁移 exit 0/schema 10；Go 两包一次整体 exit 1；唯一 fail 经根终判定为既有测试前提过时、非产品缺陷；R92 主已自然结束，本节由 R94 owner 按根审定事实代记）

- 环境与范围：本轮唯一新增运行容器 `dev-toolbox-dt-r92-pg`（命名卷 `dev-toolbox-dt-r92-pgdata`，`127.0.0.1:18593/devtoolbox_test`）为本轮私有 fixture DB，不触碰旧 r06/r49 配置、旧服务与真实数据。
- 迁移：migrations 对该库真实执行 exit 0，schema_version=10。
- Go 带标签两包一次整体运行（`-tags integration -p 1 -count=1 -json`）真实整体 exit 1：integration 包 59 顶层＋11 子测试 pass、3 特殊门 skip（RUN_M5_* 等门未启用的预期 skip）、0 fail（32.072s）；assistant 包 42 顶层＋14 子测试 pass、1 顶层 fail（4.627s）。原 540 行事件根已全量解析，stderr 0 字节、JSON 无坏行。
- 唯一失败：`TestClaimCarriesBaselinePairIndependentOfAnswerBudget`（summary_store_test.go:419）断言期望 claim 回答侧 Summary=nil 但实际非 nil。
- 根终判定（替代 R92 主的候选结论）：既有测试前提过时而非产品行为缺陷——run 改 8192/512 后 inputContextBudgetTokens=8192-512-1200-1024=5456，而 fixture 问题极短、基准摘要也很短，摘要本就放得下；docs16 §10.2/10.3 只要求按预算裁剪，回答侧裁剪与 summarySource 维护基准解耦，不要求有空间也强行裁掉；R18/R20 移除无实际来源的固定预留为正确行为。R92 主把断言候选直接称为产品行为缺陷的推断不采纳；「此前从未在真实 DB 执行过」缺全历史证据，不传播。修正方式见 DT-R94。

## DT-R93｜V3 合成四容器入口只读预检（已完成，只读；独立主 10 分 28 秒自然结束，无子、零源修改/测试/构建/服务启动；事实由根审定、本轮 R94 owner 代记）

- 模式与边界：独立只读主 10 分 28 秒自然结束，无子，零源修改/测试/构建/服务启动；实际执行过只读源/配置及 Docker 缓存/资源元数据命令，不称「零执行/零命令」。
- 确认事实：已有 V3 四容器骨架可复用，确认遗漏 `agent_console_internal_token` 的随机合成 secret 生成及私有 file override（由 DT-R95 补）；Docker 缓存 tag 缺失不能直接证明所有层必须重新下载，实际缓存命中留待 R96 实测。
- 判定与隔离：Caddy relay DNS 启动疑点未实证，不预先给 api 加 relay 别名或改生产路由；fixture `localhost:18380` 与旧 `127.0.0.1:18581` host-only Cookie 天然隔离；本机已有普通 assistant-eval bind 文件仅为存在事实，不代表当前源码可用。
- 建议与不扩界：推荐复用已有 `caddy,flows` 最小组；本轮不做 40 题人工质量评测、真实 Provider 调用或正式 V3 结论。

## DT-R94｜维护摘要独立预算测试前提修正（fixture 修正与一次 focused 验证完成，未提交；生产源码 0 改；根已实际读取 R92/R94 脱敏事件、原始 returncode 元数据与最终 test 全文 diff（437→447 仅插入 10 行、原断言字节级保持）并接受，收口完成；本轮单主实施，本会话即本轮与 docs19 写入 owner）

- 唯一 source 写入＝`apps/api/internal/assistant/summary_store_test.go` 该既有 case 内最小增量：在 shrink 8192/512 之后，经该 run 的 `input_message_id` 把当前问题更新为 `strings.Repeat("问", 5455)`（16365 字节，低于 32KiB 用户输入上限；按生产 estimateTokens 每 3 UTF-8 字节 1 token 恰 5455，预算 5456 仅余 1 token——短摘要必被裁剪、问题自身完整可容纳），附 5456/5455 预算推导短注释；不调用被测预算 helper 自证。17 条历史与基准摘要不误改；原 Summary=nil、SummarySource.Prior 内容＋水位 2、Messages 序列/内容强断言逐字保留，不删/放宽/不 skip、不改共享 fixture、不新增 case；其他 case 与旧 4xx 前缀不变。
- 生产源码、共享 helper、其他测试、依赖/配置、Git 均 0 改动；不 commit/push/tag。
- 一次 focused 真实验证（不重放已知红、不重跑 R92 已过的 integration 或 R91 全部 unit/构建）：`GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local go -C …/apps/api test -tags integration -p 1 -count=1 -json ./internal/assistant -run '^TestClaimCarriesBaselinePairIndependentOfAnswerBudget$'` 真实 go_rc=0：该 case 1 pass / 0 fail / 0 skip，包级 pass，JSON 0 坏行、stderr 空。唯一运行 DB 为 R92 新容器（env 600 仅内存加载未打印，host/port/db 布尔匹配均 1；RUN_M5_*/M5_RECOVERY_*/M5_PERFORMANCE_*/M5_FULL_STORAGE_*/KEEP_M5_PERFORMANCE_DATABASE 全部清空）；无真实 Provider/云/费用/备份/恢复/性能/满盘。
- 日志：原始 JSON/stderr 运行时以 600 权限留 `/Users/hxf/.cache/dev-toolbox-lab/r92-db-integration/`（r94-summary-focused.*，禁止 tail/head/cat），现已随本轮精准收口删除；脱敏副本 `/tmp/dt-r94-summary-test.sanitized.jsonl`（.err 空，DSN/密码精确遮盖，布尔检查无 postgres URL/端口/密码残留）仍保留供根读取。R92 曾误打印原始日志末尾 400 字节（已核 PASSWORD/DSN/PG_URL 均无），本轮不重蹈该做法、亦不称全程零原始输出。
- 定性边界：只有 fixture 前提改变使断言条件真实成立，非产品修复；无真实模型 40 题、正式 V3 验收（docs16 §20.3 条件不变）、发布/部署/版本号。根验收通过后本轮已定向清理全部 R92 自有 fixture 资源：先核对容器精确 Name（/dev-toolbox-dt-r92-pg）、唯一数据挂载（volume/dev-toolbox-dt-r92-pgdata//var/lib/postgresql）、仅 loopback 127.0.0.1:18593 绑定、该命名卷唯一引用方即本容器、私有目录非 symlink 且 13 个文件均 R92（env/docker.env/迁移与测试驱动/原始 gotest 日志与元数据/analysis）与 R94（r94-summary-focused.*）自建且无未知条目；无活跃测试/迁移连接后正常 stop＋rm 容器，复核卷无引用后 rm 唯一命名卷，私有目录文件删除后 rmdir；清理后核验容器与卷 inspect 均报 no such object/no such volume、18593 无 listener、私有目录不存在。/tmp/dt-r92-tag-compile.log、dt-r92-db-test.sanitized.*、dt-r94-summary-test.sanitized.* 根消费安全输出保留；无匿名卷/时间窗/prune 删除，无 force drop，旧 18581/18590/18591 服务 listener 未动，旧 r06/r49 配置未读未动。文末四项用户事项与 R79 唯一审计冻结范围原样；本节收口状态为最终状态，docs19 写入 owner 随本会话自然结束释放。

## DT-R95｜stack.mjs 补 agent_console_internal_token 合成 secret（已完成，精确 diff +3/-1，唯一一次 `node --check stack.mjs` 原 returncode 0；该阶段未运行 build/up/verify/eval；根已读完整 Git diff 与原生终报并接受；独立主 1 分 22 秒自然结束，无子，事实由根审定、本轮 R94 owner 代记）

- 模式：独立只写 stack.mjs 主 1 分 22 秒自然结束，无子；native 会话标题自动变为「stack.mjs补agent_console_internal_token合成secret」。
- 精确最终 diff +3/-1：同一随机 secret 对象新增 `randomBytes(32).toString('hex')` 的 `agent_console_internal_token`；同一 override YAML secrets 新增 `file` 指向该 mkdtemp 私有目录的对应文件；沿原权限/循环，无新抽象、新服务、新依赖或新目录机制。
- 验证与验收：只运行一次 `node --check stack.mjs`，原 returncode 0；根已读完整 Git diff 与原生终报并接受；该阶段未运行 build/up/verify/eval。
- 边界：未加 relay alias、未修改生产 compose/Caddy、未读真实 deploy secrets/env；token 缺失为基点已有问题，不称 R90–R92 引入；后续实际 build/up 与 `caddy,flows` 由 R96 独立进行，结果未验不写已通过。

## DT-R96｜V3 四容器 mock 栈首建与原 caddy,flows 验收（已完成；一次 up exit 0/122s、一次原 verify caddy,flows exit 0/5s、verify stderr 0、6 条 PASS；source 0 改；独立主 14 分 26 秒自然结束；事实由根审定、R97 owner 代记；「stderr 0」仅指 verify，up 的 40 行 stderr 为 Compose 创建/健康进度而非错误，由 R99 owner 按根事实澄清）

- 一次 stack up（build 与 up 内部各断言 0）真实 returncode 0/122s；一次原版 verify（R97 修改前版本）`caddy,flows` 真实 returncode 0/5s、stderr 0、6 条 PASS（Caddy 首事件/持续断开、临时断开不落库、Worker→Go 公共引用链、失败重试、persistent stop、unavailable 区分 not_found）。
- 资源：三镜像/四容器/两网络全部为本轮新 fixture（Caddy localhost:18380＋内部 mock ai-worker:3002，新库新合成数据，无真实付费/云/OSS/backup/restore/perf）；四容器两网未删未停，保留供根浏览器 QA；资源仍保留中。后续只读补核已完成（R99 owner 按根事实代记）：4 个容器 CID 合计 14 条 bind 挂载、无任何 volume 条目（其中 7 条为 file secrets bind）；不再按 project 标签卷计数 0 推断挂载形态，精确 CID/Mounts 映射由根持有、长 CID 不写入本仓库。
- 定性：原 up stderr 40 行为 Compose 创建/健康进度，非错误；build 有 pi-ai CLI bin ENOENT 与 chunk 非阻断提示，当前链路运行通过，未扩大修 CLI；R93 的 Caddy relay DNS 启动假设未发生，未加 alias。原 stop PASS 名称（persistent stop reaches provider and terminal state）在 R96 旧代码只证 Go stopped 终态，Provider 端直接 abort 证明由 DT-R97 补。

## DT-R97｜persistent stop 的 Provider 端断开验收断言补缺（verify.mjs +2/0 根已接受；随后唯一一次 flows 真实 exit 1：新断言实际执行并 PASS，下游 reindex 60s 超时失败；未重跑未改源，待根定性；单主无子，本会话即本轮与 docs19 写入 owner）

- source：`deploy/tests/v3/verify.mjs` 仅 +2/-0——第 116 行 `const stopAbortsBefore=control(state).aborted.answer??0`（本轮 stopping answer 已 active 后、POST stop 前捕获基线，不用历史固定计数）与第 119 行 `await until(()=> (control(state).aborted.answer??0)>stopAbortsBefore,'persistent AbortSignal reached provider')`（stopped 终态断言后、holdAnswers:false 前）；沿既有 previousAborts 模式，原全部文本逐字保留，无新 helper/timeout/sleep/并行矩阵，旧断言、PASS 名称、mock 行为、产品源 0 改；`node --check` 1 次 exit 0。非产品 bug 修复、不称旧用例红转绿，缺口是原验证证明范围不够。
- 唯一一次 flows（subprocess 单独捕获原 Node returncode，未跑 caddy/lanes/nginx/eval/up/build/unit，已过的 nodecheck 不重跑）：真实 exit 1/74.3s；stdout 2 条 PASS——`failed run / explicit retry` 与 `persistent stop reaches provider and terminal state`，后者在新增 until 之后打印，证明 holdAnswers 仍 true 期间 Provider receiver aborted 计数相对基线真实增长、之后才释放 hold；stderr 仅 `Timed out: reindex`，失败点为 embedding unavailable/reindex 子流程的 60s index-status 等待，位于新断言下游且彼此独立。R96 原运行不能借用此新证据。
- 失败处置：原始 log/err/rc（600 权限）留 `/Users/hxf/.cache/dev-toolbox-lab/r97-flows-run/`，脱敏副本 `/tmp/dt-r97-flows.sanitized.log`/`.err`（state＋fixture 秘密精确遮盖＋防御正则，本轮 0 命中）供根读取；未改源/未降断言/未重跑 flows，reindex 超时不定性为产品红，由根决定；verify 仅在全部组完成后写 checks，本轮异常退出未生成 checks-flows.json，R96 checks-caddy-flows.json 未动；fixture mock 控制态已由 verify catch 重置（holdAnswers/holdIndex=false、failAnswers=0）。
- 边界：四容器/两网未删未停、无 rm/down/prune，未触旧 18581/18590/18591/r06/r49/VC/KB；state 路径 `/var/folders/t7/s9mtr44s5tj_5_th3p555wtc0000gn/T/dev-toolbox-v3-acceptance-vaeTU9/state.json` 可记、内容不记；无 commit/push/tag/费用。文末四项用户事项、R79 唯一次冻结审计与旧历史原样；真实 40 题评测/浏览器 QA/正式 V3 完成/发布均未验。

## DT-R98｜R97 flows reindex 超时的只读根因排查（只读完成，零源码/零测试/零配置改动；初期「无 claim 发生」推断已被 API 每秒 500 日志纠正——claim 每秒真实发生并持续返回 500；真实根因为索引跨代重建未重置 attempt 计数，修复由 DT-R99 实施；独立会话只读实施，事实由根审定、R99 owner 代记）

- 根核实的事实链：R96 初建 gen1（行 attempt 0→claim 后 1）与原 verify flows 第一次重建 gen3（attempt 1→2）均成功；R97 flows 第二次重建（初建＋两次重建共三轮索引中的第三轮）至 gen5 后 4 行 pending、attempt=2，claim 每秒 500、持续 15 分钟，与 R97 flows 中 reindex 60s 超时同源。migration 008 CHECK attempt BETWEEN 0 AND 2；`apps/api/internal/assistant/indexing.go` 的 claim 更新 attempt=attempt+1，而 requeueIndexRows 的 ON CONFLICT DO UPDATE SET 新工作清单未把 attempt 清零。
- 排除项：Worker 一直轮询、Provider 健康；非慢查询、非 R97 停止断言、非 fixture 问题。根已读 indexing.go 226-322/425-458、全部 requeue 调用与 settings 停用分支及活库安全日志。R96 四容器 gen5 失败现场数据原样保留，本轮未触碰。

## DT-R99｜索引跨代重建 attempt 计数清零一行修复与红绿回归（已完成并经根验收通过：根已完整读 844 行源快照差异（仅指定 state 行＋attempt=0）、新 148 行 case 全文、红 9 事件/第三轮 500、绿 12 事件/两 case PASS 及独立 baseline.rc=1、green.rc=0，source 与测试均接受；子原生预览已核实际 GLM-5.3（个人套餐）、注册定义 thoughtLevel=max 已读；未提交；1 主＋1 唯一 GLM-5.3 backend-builder 测试子（baseline 红后自然结束）；本会话即本轮与 docs19 owner，收口后释放）

- 生产改动（唯一一行）：`apps/api/internal/assistant/indexing.go` requeueIndexRows 的 ON CONFLICT (fragment_id) DO UPDATE SET 清单在 `state = 'pending'` 行补 `attempt = 0`。新代次排队时行级 attempt 归零，claim 的 `attempt = attempt + 1` 不再跨代累积到 3 违反 migration 008 CHECK（attempt BETWEEN 0 AND 2）。该 SET 的 WHERE 只在 excluded/来源时间/代次/敏感快照/策略快照变化时更新，因此同签名 failed/pending 不会被 reconciler 静默重排（TestV3IndexFailureRequiresExplicitRetry 绿证）；同代过期租约 retry 分支（attempt < MaximumIndexAttempt=2）、MaximumIndexAttempt 常量、DB CHECK 与租约协议全部保持不变。未改成 claim 永远 attempt 1、未去约束、未加循环兜底、未加新日志框架、未顺手改 writeAssistantInternalFailure。
- 新测试：`apps/api/integration/v3_index_rebuild_attempt_test.go`（148 行，测试子新建）唯一 case TestV3IndexGenerationRebuildResetsAttempts。同一 harness、同一组 2 条 normal 合成片段贯穿三轮（初建＋两次公开 embedding-settings 停用/启用触发的重建），每轮 RunOnce→claim（非 200 只记录不 Fatal）→complete（leaseVersion/generation/policy 全用 claim 实际返回值，不硬编码）→RunOnce→index-status；三轮全部执行完才统一断言（三轮 claim 全 200 → 每轮每片段 Attempt==1 → 每轮终态 ready），避免旧代码第二轮 leaseVersion=2 被提前断言挡住精准红。无每轮新 harness/reset/truncate/删行、无 SQL 直改 attempt/generation、无真实 Provider（全部既有 fake 路径与合成向量）、无矩阵扩展。
- 红绿证据（原 go returncode 独立捕获；脱敏为精确 DSN/密码替换＋防御正则，红绿各 0 命中）：
  - baseline 红（测试子，修复前，专用新库真实跑一次）：rc=1，唯一 fail 即新 case，失败落点第一条收尾断言——第1轮 claim=200 generation=1 attempts=[1 1] indexStatus=ready ｜ 第2轮 claim=200 generation=3 attempts=[2 2] ready ｜ 第3轮 claim=500 INTERNAL_ERROR，与 R98 根因链一致；baseline.err 0 字节，无编译/装置红。原始日志（600）仅供本轮执行与脱敏，收口时已随私有目录清理；脱敏副本 `/tmp/dt-r99-red.sanitized.jsonl`/`.err` 与独立 baseline.rc=1 数值保留供根。
  - 修复后绿（主，稳定候选一次）：`go test -tags=integration -p=1 -count=1 -json`（-run 两 case）rc=0，TestV3IndexGenerationRebuildResetsAttempts pass×1、TestV3IndexFailureRequiresExplicitRetry pass×1（后者证明同代 failed 不被静默重排的行为在修复后保持）。未跑全套 unit/tagged/Web/Worker/build/release-check。原始（600）同上仅供本轮执行与脱敏、收口时已清理；脱敏 `/tmp/dt-r99-green.sanitized.jsonl`/`.err` 与独立 green.rc=0 保留供根。
- 专用测试环境（本轮新建，收口时已定向清理）：容器 dev-toolbox-dt-r99-pg（镜像 pgvector/pgvector:0.8.6-pg18-trixie 本地缓存 --pull=never，仅 loopback 127.0.0.1:18594，命名卷 dev-toolbox-dt-r99-pgdata 挂 /var/lib/postgresql）、库 devtoolbox_r99_test（_test 后缀满足 assertTestDatabase），全新随机密码仅此库、只存 600 私有 env；现有 cmd/migrate 对新库一次迁移 001-010 全部应用 rc=0；RUN_M5_*/M5_* 环境变量确认未设置并防御性清除（diag 排查痕迹中 M5 gating 用例均输出 is not enabled 佐证）。指令形态事实（收口修正，撤回此前「本机 Bash 吞/破坏参数」的泛化表述）：最初两次按根任务原文 `-p1`/`-count1` 紧邻缩写形态运行失败——go test 报 `no Go files in /Users/hxf/projects/idea/dev-toolbox/apps/api`、`FAIL . [setup failed]`、rc=1，setup failed、测试 0，不属于产品红也不计入 baseline；`-p1`/`-count1` 紧邻缩写不是 Go 支持的正常写法（正确为 `-p 1` 分离式或 `-p=1` 等号式）。改用 `-tags=integration -p=1 -count=1` 等号形态后完成上述真实红绿；未对 Shell 环境做排查或修改，未为此再运行 Go 命令。子排查期间共留 11 个 diag 痕迹文件（含最初两次 setup failed 的 jsonl 事件、一次漏 -tags=integration 的 build constraints 形态与 `=` 形式验证过程），已精确遮盖（0 命中）后摘要保留于 `/tmp/dt-r99-setup.sanitized.log`；红/绿脱敏 JSON 未改动。R99 实施阶段未触碰 R96 四容器 18380（未 build/up/verify/替换其镜像），其更新 API 与复验由后续 R100 独立应用，本节不跨轮断言其现场状态；未删匿名卷、无 prune。
- 根验收与纯收口（收口轮：不再跑任何测试/check/build/格式化、不改代码、无 Git 写入/版本/发布/云）：根验收通过后仅做两处准确性修正（setup 失败与产品红分开记并撤回 Shell 泛化表述；R98 跨代口径为初建＋两次重建共三轮索引）与定向清理。清理真实结果：先核容器 CID/Name（6100e4abd338…，与创建时一致）、唯一挂载 volume|dev-toolbox-dt-r99-pgdata|/var/lib/postgresql、端口仅 127.0.0.1:18594→5432、卷仅本容器引用、无 go test/go run 残留进程；随后正常 stop→rm 容器，复核卷引用为 0 后 rm 唯一命名卷；私有目录 20 个文件（顶层 3＋main 3＋sub 14，含 11 个 diag 痕迹）经白名单与非 symlink 校验后精确 unlink/rmdir，无未知条目；删除在 setup 摘要脱敏完成之后执行，r99.env/docker.env 随之删除。清理后核验：容器与命名卷 inspect 均不存在、127.0.0.1:18594 无 listener、私有目录不存在；`/tmp/dt-r99-red.sanitized.jsonl`/`.err`、`/tmp/dt-r99-green.sanitized.jsonl`/`.err`、`/tmp/dt-r99-setup.sanitized.log` 保留供根。未清 Go/Docker 全局 cache 与 AGENT 定义；R96 四容器/两网/其 state 目录本轮未触碰，其更新 API 与复验由 R100 独立应用（R100 此阶段不写 docs，与本节无冲突）。文末四项用户事项与 R79 唯一次冻结审计原样。本节收口完成，docs19 owner 随本轮结束释放。

## DT-R100｜R99 修复后合成栈 API 单组件更新与索引跨代恢复复验（已完成并经根验收通过：根已验收三原始 rc=0（api-build/api-up/flows）、读全部脱敏日志与 runner.py/confirm.py，flows 一次 3 PASS，新代次 generation=7 全 ready 且 attempt=1，根真实 IAB 桌面引用验收通过；本轮单主无子（DT 总上限 2 已满，与收口中的 R99 主并行且不共享资源写入），本会话即本轮与 docs19 owner，收口后释放）

- 执行与授权边界：仅沿 stack.mjs 既有 Compose 参数各一次 `build api`（rc=0）与 `up -d --no-deps --wait --wait-timeout 120 api`（rc=0），把含 R99 修复的 API 镜像应用到 R96 既有合成栈（project dev-toolbox-v3-acceptance，localhost:18380）；未运行 stack up/down、未重建 gateway/ai-worker/postgres、未换端口/网络/secret/DB、未独立迁移（schema 未变）；未重跑 R99 的 unit/Go/check/OCR，未改任何仓库 source/test/配置/Dockerfile/lockfile，无 commit/push/tag/版本/发布/云。开始前按精确 Name/ID 核验四容器归属与任务给定一致后才操作。
- 资源映射（根独立 inspect 复核确认）：api-1 容器替换为新 CID `8d2dbb5dcb82…`（完整 CID 与四容器映射由根持有并更新清理映射，沿 R96「长 CID 不写入本仓库」约定）；gateway-1 `4623bfa2…`、ai-worker-1 `2843ac10…`、postgres-1 `da5f7dcf…` 三 CID 原样保持。挂载现态：api 8 条 bind（/data、/operations、/fixture-state、/fixture/assistant-eval、四个 /run/secrets/ file secrets）；四容器合计 14 bind、其中 7 条 secret bind、无任何 volume 条目。主 agent 初始汇报把 api 8 条误数为 7，根独立 inspect 纠正，本节以纠正后数字为准。up 后 public 入口 `http://localhost:18380/` 返回 200、api healthy；四容器/两网/R96 state 与私有数据全部保留，未 stop/rm/down/清理任何卷或目录，供根后续 UI 验证。
- 唯一一次 flows（含必要的新代次重建）：`verify.mjs <STATE> flows` 真实 rc=0，三条 PASS——`failed run / explicit retry`、`persistent stop reaches provider and terminal state`（含 R97 新增 Provider aborted 直接断言）、`unavailable skips retrieval and is distinct from not_found`。其末尾公开 embedding-settings 停用/启用即新代次重建动作：从 R97 遗留 gen5 失败状态（4 行 pending attempt=2、claim 持续 500）经正常重建演进至实测 generation=7，未做任何 SQL 改 attempt/删行/手改 lease/调大 60s/额外手工重试，gen5 历史 pending 行由公开重建自然演进。
- flows 后白名单确认（一次公开 GET index-status＋SELECT 聚合＋control GET）：available=true status=ready generation=7；counts active=4 ready=4 pending=0 running=0 failed=0 excluded=0；assistant_fragment_embeddings 唯一分布 `7|ready|attempt=1|4 行`；embedding_config `7|ready|enabled`；control holdAnswers/holdIndex=false、failAnswers=0、active.index=0。与 R99 修复预期（新代次重建后全 ready 且 attempt=1）一致。
- 会话与安全：fixture Node 会话探测 200 直接复用（auth=true reused），根浏览器正常 owner 密码＋TOTP 登录未使 Node 会话变化、无 cookie 注入/信任设备，未做 setup/reset/credential 变更；owner_password/TOTP/cookie/CSRF/DSN/masterkey 仅内存处理、未进 argv/stdout/工具结果，返回码均由 subprocess 直接捕获写入 600 rc 文件，原始日志未 cat/tail 到终端。私有目录 `/Users/hxf/.cache/dev-toolbox-lab/r100-api-runtime/`（700）保存原始 log/err/rc×3 与 4 个辅助脚本（600）；脱敏副本 `/tmp/dt-r100-api-build.sanitized.log`/`.err`、`/tmp/dt-r100-api-up.sanitized.log`/`.err`、`/tmp/dt-r100-flows.sanitized.log`/`.err`（fixture 秘密精确遮盖＋防御正则，0 命中）供根读取，未覆盖 R96/R97/R98 既有日志。
- 根真实浏览器验收事实（根提供，本 owner 代记）：API 更新后原已开 tab 仍显示 0/4 indexing，主动 reload 后才显示知识库可用——根已读 assistantStore.ts 197-219（bootstrap 只初始化一次）、assistant 模块 getIndexStatus 仅 API 定义未被前端调用、AssistantThread.vue:55 读取 bootstrap.knowledge，确认现存索引进度不会自动刷新问题（已登记待处理，交 DT-R101，本轮未修）。刷新后真实桌面 1280×720 一次发送「DT-R100 浏览器验收：根据笔记，织云节点巡检有哪些约定？请给出依据并引用来源。」，仅已选 V3 合成 Provider 本地 mock、无付费；回答完成、引用 1(title)/2(raw_text) 可打开，引用 2 摘录「织云验收节点每天09:00执行巡检。」与原笔记 fc0b023e-39bf-462f-b694-d4e32943f78a 按需读取原文一致；截图 dt-r100-assistant-citation-desktop.png 根已保存展示（不在本仓库）。根后续 390×844 手机视口验收（根提供，本 owner 代记）：回答/引用 2 抽屉截图已保存且 scrollWidth=390 无横向溢出，原笔记入口命中目标 358×44 位于 (16,784) 可达，验收后默认视口已恢复 1280×720；截图 dt-r100-assistant-citation-mobile.png 存根会话 visualizations（不复制入本仓库）；物理手机/AT/Safari 仍未验、未虚报。
- 边界：合成通路验收不代表真实 Provider 质量 40 题评测、V3 正式完成或发布；外部 Provider/Embedding 仍 `http://ai-worker:3002/v1` 本地 mock；未触旧 18581/18590/18591/5199/8080/r06/r49、R99 专用 PG18594 与 VC/KB 保护；文末四项用户事项、R79 唯一次冻结审计与 R96–R99 历史记录原文未动。本节写入完成即 docs19 owner 随本轮结束释放。

## DT-R102｜四容器独立任务通道 lanes 功能复验（已完成并经根验收通过：根已读 probe.mjs/run-lanes.mjs、独立 lanes.rc=0、完整脱敏日志与原生最终状态；单主无子，本轮唯一 docs19 owner——R101 明确禁止写 docs，未回退他人变更——收口后释放）

- 唯一一次 lanes：`verify.mjs <STATE> lanes` 真实 rc=0（stderr 0B）。按现有流程 hold 2 chat＋1 index 并触发现有 AI Task（organize_record），三通道独立推进，释放后断言 2 chat run 与 Task 均 succeeded、index available；lanes 自建的合成新增条目按现有 fixture 工作流软删入 trash、可恢复（trash 精确匹配 1 条）。auth 探测 200 直接复用，未刷新/未 setup/reset，state.json 未被本轮改动。
- 运行前核对：四容器按名称＋完整 CID 与 R100 根映射完全一致（api 为新 CID、旧 bdb 已不在，project 下无陌生容器），挂载 14 bind／7 secret bind／无 volume，_frontend/_backend 两网原样（backend internal）；全程未重建/启停/清理任何容器、卷、目录、镜像，未 Docker prune、未触 18380 以外端口与受保护资源。
- 运行后白名单（一次 control GET＋公开 index-status，软删后首查即收敛、无等待轮询）：holdAnswers/holdIndex=false、failAnswers=0、active 全 0；generation=7、counts active=4 ready=4 pending=0 running=0 failed=0 excluded=3，与 R100 基线 gen7 4/4 一致。mock 计数器（started/finished/aborted）为 worker 启动以来累计值，本轮仅作功能复核，不作性能/容量/基准结论。
- 会话与安全：所有秘密仅内存处理、未进 argv/日志/工具输出；原始 stdout/stderr/rc 由直接 subprocess 捕获存私有目录 `/Users/hxf/.cache/dev-toolbox-lab/r102-lanes-runtime/`（700，文件 600），原始日志未预览，脱敏副本 `/tmp/dt-r102-lanes.sanitized.log`/`.err`（精确值＋防御正则，redactions=0，不据此宣称绝对无风险）已由根读取。
- 边界：合成 lanes 复验不代表真实 Provider 40 题评测、V3 正式完成或发布；本轮仅写本文件（含 R100 节两处根定事实校正），未改源码/测试/配置/私有脚本、未跑任何额外检查；四容器/两网/R96 state、r100/r102 私有目录与 runtime 全部保留交根，供 R101 网页更新验收；无 Git 提交/推送/发布。

## DT-R101｜助手会话页知识索引进度自动刷新（源码与合成回归已完成并经根验收：根已读任务起点与两轮候选全文差异（assistantStore.ts 1116→1187、AssistantThread.vue 398→434、AssistantView.vue 144 不变）、新 299 行 6 case 测试全文与全部红/绿/组/build 日志原始 rc；真实 18380 网页仍待 R104 更新 gateway 后验收（当时语境；已由 DT-R104 完成真实页面验收，见 DT-R104 节），未提交；单主无子（R100 主同期只做 docs19 收口、不共享资源写入），本会话即本轮与 docs19 owner，收口后释放）

- 生产改动与行为：仅 `assistantStore.ts`＋`AssistantThread.vue` 两个源文件（AssistantView 不变）＋新专用回归 `assistantStore.knowledgeRefresh.test.ts`（6 case）。知识助手挂载且索引仍有真实工作（indexing 或 pending/running>0）时按 2s 递归单飞 GET（既有 getIndexStatus）只替换 bootstrap.knowledge，不重新 initialize，保留当前会话/草稿/模型与思考选择；ready、disabled、unconfigured 及无待处理工作的终态即停；GET 失败保留最近成功索引状态、页面内可访问反馈（role=alert）＋显式重试入口，不做失败任务的隐式重试/重建，不阻断一般交流与草稿。间隔与停止语义沿用设置页（ProviderSettingsView）既有约定。
- 生命周期（根审补齐后收口）：复用同一序号机制同时守护轮询与 initialize——initialize 的成功写入/catch 错误/finally 解除 loading 均校验归属序号，卸载（disposeView）或新初始化递增序号后，迟到的 bootstrap 与 poll 响应不写入、不清新视图草稿、不调度或复活已离开视图的轮询；disposeView 同时解除已销毁视图占有的 loading，使再次挂载可立即重新初始化。
- 测试与红绿事实（均合成 fixture，日志含原始 rc 且全部保留）：首红 4 fail/1 pass rc=1（`/tmp/dt-r101-red.log`）——其中第 3 case 首次形态因未覆盖 getBootstrap 落入 createApi 默认 ready、终态本就不轮询，属测试装置错误而非产品红，根纠正为显式 indexing bootstrap 后才取得有效红；首轮候选 5 case 全绿（`/tmp/dt-r101-green.log`）、assistant 组 12 files/57 tests rc=0（`/tmp/dt-r101-assistant-suite.log`）、build 含 typecheck rc=0（`/tmp/dt-r101-build.log`）。根审定位 initialize 迟到归属缺口后新增第 6 case 先红 1 fail/5 pass rc=1（真实红点：挂起的旧 initialize 占有 loading、挡住新视图第二次 bootstrap，`/tmp/dt-r101-init-red.log`），修正后 focused 6 case rc=0（`/tmp/dt-r101-focused6-green.log`）、受影响 assistant 组 12 files/58 tests rc=0（`/tmp/dt-r101-assistant-suite-v2.log`）、build rc=0（`/tmp/dt-r101-build-v2.log`）。既有 chunk 体积警告未新增处理。
- UI 仅如实记源码意图：AssistantThread header 知识徽标外包嵌套 status 容器，承载轮询失败提示与重试按钮；mobile 下 44% 宽度约束从徽标移至 status 容器（恢复以 header 为参照）、徽标 max-width 100%，重试按钮 mobile min-height 44px，focus 沿用全局 :focus-visible。「390 窄屏徽标可读/不溢出」尚无新 bundle 真实浏览器证据，不按已测落笔。
- 边界：58 tests/build 0 仅合成回归，不代表真实 18380 网页已验证；本轮未触四容器/两网/R96 state 与任何受保护端口，未跑 Docker/PG/server/GET——18380 仍为 R100 更新 API 后的旧前端 bundle，R100 既有真实桌面/390 引用验收事实照旧、不冒充为 R101 进度刷新验收；R103 同期持有 runtime（独立 nginx 组、禁 docs），真实页面验收待 R104 独立会话仅更新 gateway＋正常新代次 hold/release 后进行（预期无 reload 恢复且保留 draft/model/conversation）。真实付费 Provider 40 题评测、V3 正式完成与发布未验；未提交/推送/发布，未改其它模块/依赖/版本/AGENTS；R79 唯一次冻结整审、R96–R100/R102 历史与文末四项用户事项原文未动。

## DT-R103｜Nginx TLS 独立验证尝试（已终态、runtime 已释放；未修复未重跑，根因留后续；事实由根审定、R104 owner 代记）

- 结果事实：镜像缓存预检返回约定 rc2，verify 未运行，本轮没有发布检查，不得据此把任一 SSE 子检查记为通过；随后基于本地缓存 nginx 1.28.2 临时本地 tag 的唯一一次实际 nginx 运行 rc=1——TLS 建立前连接即断开，stdout 零 PASS。该 rc1 零 PASS 原始事实保留不改，原实跑的精确时刻不能回溯补测；后续已由 DT-R107 短探测定位、DT-R108 就绪等待与定向测试、DT-R109 修后实跑 2 PASS 收口（见 DT-R109 节）。
- 收尾状态：本轮临时使用的 nginx:stable-alpine 镜像标签与临时代理均已清除（仅指该临时镜像 tag 与临时代理，不涉及原网关的网络别名），18443 端口空闲；runtime 已按授权释放，本轮不修不重跑。
- 定性边界：不得把镜像 image Config 为空断言为镜像损坏，也不得断言上游镜像非等价；DT-R106 只读已结束（静态配置相符、因果未唯一证明）；DT-R107 短探测已定位：首次 TLS reset 时 443 尚未监听、约 2.1 秒后严格 TLS 200，不认定缓存损坏；最终由 DT-R109 修后实跑通过收口，文末待处理对应条目已标记解决。

## DT-R104｜R101 网页容器更新与真实索引进度页面验收（已完成并经根验收通过：gateway build/up 各一次原 rc=0、仅 gateway 容器替换，真实页面 indexing→无 reload 自动恢复且草稿/模型/会话保留；本轮单主无子，本会话即本轮与 docs19 owner，收口后释放）

- Gateway 更新边界：沿 stack.mjs 既有 Compose 参数仅执行 `build gateway`（rc=0）与 `up -d --no-deps --wait --wait-timeout 120 gateway`（rc=0）各一次；只替换 gateway 容器（新 CID `6f6a544f7ac1…`，完整 CID 由根持有、沿 R100 长 CID 不入仓库约定），api/ai-worker/postgres 三容器完整 CID 逐字不变，全栈挂载仍 14 bind（含 7 条 /run/secrets secret bind）、无 volume（根独立 inspect 复核）。build stderr 曾显示 Compose 计划内出现 `api Building`，故不声明 API 镜像未参与 Compose 内部计划；本轮未独立执行 api 的 build/up，api 容器未被替换。
- 更新后就绪：public 入口 `http://localhost:18380/` 返回 200；初次未带 Cookie 的 GET 返回 401 后仅走正常 owner 密码 login＋`/mfa/verify`（未 setup/reset、无凭据变更；不能表述为原 Cookie 过期——根读 check-entry 源码确认 401 系请求未带 Cookie 所致，DT-R109 实测原 cookie 仍有效），`GET index-status` ready/available、generation=7、active=4 ready=4；R96 state.json 未被写入，秘密仅内存处理。
- 索引 setup 周期×2（公开路径＋本地 mock，未做 SQL/手工 lease/attempt/失败重试）：经公开 embedding-settings disable/enable（两次均 confirmReindex:true、apiKey:null 保留原连接与 key；经根审修正后 holdIndex 前置到两次 PUT 之前并挂严格 60 秒 deadline 守卫，control 仅动 holdIndex 单键，runner 记录真实 status/signal 并传播子 rc）触发新代次重建。首轮 7→9：cycle rc=0，index-ready 记 gen9 running=4/mockActiveIndex=1，result ready 4/4；根因前置处理耗时错过 60 秒观察窗口、未操作页面——不构成产品失败、也不算前端通过，该轮文件原样保留。第二轮 run-2（已审脚本原样复制、不改代码/超时）9→11：cycle.rc={status:0,signal:null,spawnError:null}，result ready=4/active=4/pending=running=failed=0/excluded=3；两轮 60 秒自动释放均按 deadline 真实执行。
- 真实页面验收（根提供事实，本 owner 代记；新版页面 status wrapper=1）：root 在 run-2 的 indexing 0/4 窗口内于真实 18380 页面选择已有合成会话、填写草稿 SYNTHETIC-DT-R104-RUN2、思考档位 off；此后无任何 reload，页面自动恢复知识库可用，草稿/模型＋reasoning/会话标题与全部消息逐项相等；1280×720 无横向溢出；390×844 scrollWidth=390、知识徽标 x=286 y=137 w=92 h=36、clientWidth=scrollWidth=90 完整可读、草稿值保留，验收后默认 1280×720 已恢复。截图 dt-r104-indexing-draft-run2-desktop.png、dt-r104-ready-draft-desktop.png、dt-r104-ready-draft-mobile.png 存根会话 visualizations、不复制入本仓库；物理手机/AT/Safari 与真实网络错误 UI 未验、不虚报。
- 私有产物与安全：原始 build/up/cycle 的 stdout/stderr/rc（600）存 `~/.cache/dev-toolbox-lab/r104-web-runtime/700` 与 `…/700/run-2`（目录 0700、文件 600），原始日志未预览；脱敏副本 `/tmp/dt-r104-gateway-{build,up}.sanitized.{log,err}`（fixture 秘密精确遮盖＋防御正则）供根读取。本轮对 R96 栈仅按记录替换 gateway 容器：api/ai-worker/postgres 三容器 CID、两网、R96 state 与 nginx 证书及既有文件保持原样；数据库经公开 embedding-settings 路径推进到 gen11，不表述为整个栈未触；r100/r102/r103 私有目录、旧 18581/18590/18591/5199/8080/r06/r49 与 VC/KB 保护资源未触。
- R105 关联口径（另一会话，只读）：R105 仅只读确认既有模型拒绝保草稿/选择恢复路径的行为，未改代码；涉及存储的描述以源码 sessionStorage 为准（非 localStorage）；R104 真实页面仅验证本轮选定的会话/草稿/思考档位组合，不宣称全部动态模型组合已做运行验证。
- 边界：本轮不代表真实 Provider 40 题评测、V3 正式完成或发布（`docs/16` §20.3 条件未全满足）；未提交/推送/发布，仓库源码/测试/配置文件零改动（lab 私有脚本经根审有修正，不计入「零改动」）；R79 唯一次冻结整审、既有历史与文末四项用户事项原文未动。

### R104 期间 Read 工具把 R96 state.json 合成凭据带入输出（单独记录，根已告知用户）

- 事实：R104 首个工具调用用 Read 直读 R96 state.json，工具结果原样回显整行 JSON，把本地合成会话凭据带入可见工具输出；自核确认为 true。属主 Agent 工具选择失误（秘密文件应仅由脚本内存加载），非产品缺陷；根已告知用户，本记录不重复任何值。
- 纠正与区分：其后 state/env 一律改为脚本内存加载＋白名单输出，Mounts 只输出 Type/Name/Destination；lab 目录 parent 与 `/700` 均 0700、文件 600。此前「parent 755/child 700」的权限歧义源于根任务文案笔误、已当场纠正，与 Read 输出事件是两件事、分开记录。
- 后续处置：剩余 TLS 消费者完成后，R96 state 原目录已由 DT-R111（2026-10-22）真实定向退休删除并核验不存在，合成凭据随之失效；r96/r100/r102/r103/r104/r107/r109 私有脚本日志按约保留（不再含可用凭据）；不影响文末 R72 旧共享库凭据待用户决定事项；未操作任何真实 Provider/生产密钥。

## DT-R107｜Nginx TLS-only 短探测定位（临时代理已按 CID 清除；事实由根审定、DT-R111 owner 代记）

- 结果事实：本轮曾创建自有临时 Nginx 代理（18444 端口、两只读 bind、默认启动）并运行 TLS-only 短探测：首次观测到 TLS reset 时目标 443 尚未监听（nginx 启动窗口期），约 2.1 秒后同一探测以严格 TLS 校验取得 200；探测后临时代理按 CID 清除，核心四容器未替换，仓库源码/配置零改动。据此 R103「TLS 建立前断开」指向启动窗口期现象；原 R103 实跑的精确时刻不能回溯补测，也不认定镜像缓存损坏。
- 边界：临时代理仅本探测用途、两只读 bind、按 CID 精确清除；修后全量实跑由 DT-R109 完成。

## DT-R108｜waitForNginx 就绪等待与 5 项定向测试（已完成、定向 rc=0；事实由根审定、DT-R111 owner 代记）

- 结果事实：26 行 waitForNginx 就绪等待实现在 stack.mjs，verify.mjs 为 import＋调用；5 项定向测试 rc=0——拒绝后恢复、总 deadline、慢速响应、错误 CA、错误主机名；既有严格 TLS 与 SSE 2 秒断言保留不变。
- 边界：定向测试为合成环境验证，不替代全量实跑结论（见 DT-R109）。

## DT-R109｜修后 nginx 实跑验收（已完成并经根验收通过：唯一一次修后实跑 verifier rc=0、executor rc=0、2 PASS、firstEvent 27ms；事实由根审定、DT-R111 owner 代记）

- 结果事实：唯一一次修后 nginx 实跑通过——verifier rc=0、executor rc=0、2 PASS、firstEvent 27ms；持久 Run 继续并正常持久化，临时断连取消且不落库；原 state 内 cookie 实测仍有效、无需重新登陆；临时代理与临时镜像 tag 已清，四容器核心（gateway/api/worker/postgres）原样未动；索引 gen11 ready4/active4/excluded3。根独立已读日志、结果与资源元数据。
- 边界：仅合成栈实跑，不代表真实 Provider 40 题评测、V3 正式完成或发布；完整 CID 不入仓库。

## DT-R110｜助手导航 scope 竞态修复（实现、定向回归与真实页面验证完成；事实由根审定、DT-R111 owner 代记、真实页面结果由 DT-R112 补记）

- 生产改动：`assistantStore.ts` 新增 navigationSeq——最新响应/error/finally 按序号归属、scope 切换清旧列表与 cursor、dispose 使序号失效；`AssistantModuleNav.vue` 改为一次确定 scope 再 await，避免旧两段续程覆盖；另两个测试文件共新增 5 例。
- 测试事实：真实初红 5 fail（初始夹具 ID 冲突已修，与忙丢请求等失败机制无关）；修复后定向 15/15、助手组 63/63、含类型 build 0 诊断。
- 真实页面验证：已由 DT-R112 在新建合成栈完成并经根验收（桌面 A/B/归档/B scope 准确、390 抽屉列表正确且草稿/模型/low 保持、无横向溢出），细节与定性见 DT-R112 节；确定性乱序保证仍以本节定向 deferred 测试为准。

## DT-R111｜R96 合成栈定向退休与 Nginx 结果收录（已完成；单主无子，本会话即本轮与 docs19 owner，收口后释放）

- 退休事实：先核验后删除——四容器按精确 CID、容器名（dev-toolbox-v3-acceptance-gateway/api/ai-worker/postgres-1）与 compose project 标签确认归属，合计 14 条 bind 含 7 条 /run/secrets secret bind、无挂载 volume；两网名称/标签匹配且端点仅含这四 CID；两个 nginx 临时代理容器确认已不存在。随后仅删除四个精确 CID 容器、两个精确网络 ID 与原 R96 合成目录树，未用 compose down/prune、未删镜像、未按全局差集推断归属。删除后核验四 CID/两网/原目录均不存在，18380/18443/18444 端口全部释放；缓存镜像与 r96/r100/r102/r103/r104/r107/r109 私有脚本日志按约保留。
- 留存与凭据：四份非密报告（checks-caddy-flows/flows/lanes/nginx.json）以 0600 留存于私有 `~/.cache/dev-toolbox-lab/r111-retirement/`（目录 0700）；本轮原退出状态与白名单日志见同目录 `r111-retirement.log`（0600，仅资源/文件存在性、rc 与端口状态，不含 Env/HostSource/私密值）。合成凭据随原目录销毁失效。
- docs 收录与边界：R103 rc2 表述勘误与后续指针、R104 认证口径更正（初次未带 Cookie 的 GET 401 后正常登录，非原 Cookie 过期）与凭据失效补记、文末 Nginx TLS 条目标记已解决；R107/R108/R109/R110 事实由本轮代记；R79 唯一 OCR 冻结整审不重跑，V3 正式完成/真实 40 题/版本/tag/发布状态未改，文末四项用户事项与 R72 事项原文未动；完整 CID 不入仓库。无 SQL/登陆/部署/发布/Git 写入，未重建新栈，真实页面验证待新环境。

## DT-R112｜新合成环境与 R110 真实页面验收（已完成并经根真实页面验收；单主无子，本轮 docs19 owner 即本会话，收口后释放）

- 新合成栈：一次既有 `stack.mjs up` 与私有薄包装均 rc=0（无重跑），新 state 目录 `dev-toolbox-v3-acceptance-FpEKm3`（路径可记、内容不记）；3 个服务镜像正常重建，gateway 含 R110 前端产物；四容器/两网正常，/run/secrets secret bind 共 7，栈保持运行供后续使用。完整 CID 仅存私有 `~/.cache/dev-toolbox-lab/r112-ui-runtime/`（0700/0600，含无密 ui-fixture.json），不入仓库。
- 播种与就绪：仅经公开 API 建 2 文件夹（SYNTHETIC-DT-R112-A/B）与 3 会话（A/B active、ARCHIVE 归档；run 均 succeeded，run 完成后 PATCH 手动标题避免自动标题覆盖）；index ready，mock 控制 holdAnswers/holdIndex=false、failAnswers=0、active 全类别 0。根已读 safe.log 与无密 fixture，并以正常密码+TOTP 登录新栈；私有密文件与 raw 日志不经 Read/cat 输出，仅在正常登录时内存加载、不回显。
- 根真实页面验收：1280×720 依次 A→B→归档→B，侧栏 scope 对应准确；当前会话 A、未发送 26 字草稿、验收模型与 low 推理保持。390×844 打开抽屉，归档/A/B 列表正确，关闭回到原 A 会话，草稿/模型/low 一致，document.scrollWidth=390 无横向溢出，视口已 reset。截图 3 张：`~/.codex/visualizations/2026/10/22/01a15af6-2571-7290-ab40-4feef7914639/`（dt-r112-scope-desktop / dt-r112-scope-mobile-nav / dt-r112-scope-mobile-draft）。
- 定性与边界：真实页面无人为延迟网络，不把普通页面切换称为确定性乱序复现；乱序保证来自 R110 定向 deferred 测试，本轮验证的是实际集成与响应式表现。本轮实际新建并启动自有四容器合成栈；本次文档补记没有追加容器操作、审计、全量测试或产品代码改动；不声称整个产品验收完毕（V3 正式完成、真实 40 题评测与发布状态未变）；R79 唯一次统一审计结论与文末四项用户决策原文未动。

## DT-R113｜startRun 迟到响应串台修复（已完成并经根验收：根逐项核对最终源码 diff、8/8 定向、助手 13 文件 71/71 与类型构建 rc0；未提交；事实由根审定、DT-R114 owner 代记）

- 缺陷与修复范围：本地 `POST runs`（202/SSE）的迟到响应在切换会话后抢回旧会话、混入消息并清掉新草稿；仅改 `assistantStore.ts` 与 `pendingSend.test`——contextSeq 归属、已发送草稿条件清理与 new 键迁移、请求时捕获模型档位（实际 last-used 记忆契约核对为正确）、回到目标会话恢复 pair/observe、viewAlive 阻止 dispose 后观察；其余源码零改动。
- 红绿事实：修前清洁红 5 fail 1 pass（更早一次测试夹具错误修正后才计入红）；首版绿定向 6/6、助手组 69、build 0；根补审 A→B→A 与 new→B→new 两时序后新增红 2 fail 6 pass；最终定向 8/8、助手 13 文件 71/71、vue-tsc+tsc+Vite build rc0。日志 `/tmp/dt-r113-{red-return,green-return,assistant-tests-r2,build-r2}.log`。
- 边界：真实浏览器红/绿重放随 DT-R114 的 gateway 更新完成并经根验收（见 DT-R114 节）；新发现「历史 GET 迟到污染新对话」不属本轮已验范围，已由 DT-R115 修复并经 DT-R116 真实重放验收（见两节）。

## DT-R114｜R113 修后 gateway 定向更新与迟到响应真实重放（已完成并经根验收；单主无子，本轮 docs19 owner 即本会话，收口后释放）

- 更新事实：私有脚本经根两轮审改（HTTP 仅 200 判就绪并取消消费响应体、state 目录匹配断言且 parse 失败不落错误内容、raw 日志创建即 600）后唯一一次执行：`build gateway` rc=0、`up -d --no-deps gateway` rc=0、包装器 rc=0；仅 gateway 容器 `be1081111a59`→`783361bd1dc9`，api/ai-worker/postgres 三 CID 与两网络逐一不变，R112 数据/seed/secrets 保留，127.0.0.1:18380 绑定与全部 override 原样；回环普通 GET `/` 返回 200。完整资源与原始日志仅私有 `~/.cache/dev-toolbox-lab/r114-gateway-update/`（0700/0600），不入仓库。
- 根真实浏览器重放（1280×720，仅本地 mock 拦截、两次拦截均已清除）：修前（更新前镜像）暂停本地 `POST runs` Fetch（Response 202）后 A→B 填新草稿，放行实见跳回 A、草稿空、混入 B 历史；修后相同时序仍停留 B、B 草稿完整、无 A 问句，回 A 见后台完成的回答。另暂停 Request 使服务器尚未创建 Run：A→B→A 读旧历史、填新草稿后放行，新问答恢复并完成、问句仅 1 条、草稿与模型 low 保留。截图 3 张（dt-r113-late-response-red.png、dt-r114-late-response-green.png、dt-r114-return-to-a-green.png）存该验收聊天 2026/10/22 可视化目录，不复制入本仓库。
- 边界：本轮有实际 gateway 构建与容器替换，「无追加容器操作」仅指本次文档补记；未重复手机布局检查，不冒充全产品完成；V3 正式完成/真实 40 题评测/发布状态未变，R79 唯一次整审与文末四项用户决策原文未动；未提交/推送。

## DT-R115｜历史 GET 迟到污染新对话修复（已完成并经根验收：根重新核对最终源码与最终已审候选逐字一致，13/13 定向、助手 14 文件 84/84、完整 build 与生产 diff 通过；未提交；事实由根审定、DT-R116 owner 代记）

- 修复范围：仅 `assistantStore.ts` 与新增 `historyLoad.test.ts`。要点：contextSeq 丢弃旧历史并在分页成功/失败 finally 收口，最新点击生效；新对话/临时切换/dispose 解除 loading，选择时立即清旧 messages 与分页 cursor；旧快照合并本地新 pair 且本地优先；当前 Run 只认最新带 Run 消息，observingRunId 于观察建立/停止时设置/清除，保护新回答并做首 snapshot 前去重；临时切换清分页 cursor。
- 红绿事实：首轮 6 fail 输出可信，但 zsh PIPESTATUS 无效、shell rc 未保存，不得补造；r2 一例最初 fixture await 死锁，修 fixture 后 2 fail 7 pass 才计真实红；其后 r3–r5 均有真实红绿证据，根全 diff 验收。最终定向 13/13、助手 14 文件 84/84、完整 `pnpm build` check+Vite rc0；日志 `/tmp/dt-r115-r5-{red-before-fix,green-historyLoad,green-assistant-all,build}.log`。
- 边界：真实浏览器红/绿重放随 DT-R116 的 gateway 更新完成并经根验收（见 DT-R116 节）；首 snapshot 等细分行为只由本轮单测保证，不冒称浏览器覆盖。

## DT-R116｜R115 修后 gateway 定向更新与历史迟到污染真实重放（已完成并经根验收；单主无子，本轮 docs19 owner 即本会话，收口后释放）

- 更新事实：复用根审 R114 脚本，仅改 task 标识、日志目录与 gateway 前置基线（gateway 预期替换为 R114 report 的 gatewayNewCid `783361bd1dc9`，其余 3 容器 CID 与两网络仍严格对齐 R112 fixture）；root 重新核对源码与 R115 最终已审候选逐字一致后放行，唯一一次执行：`build gateway` rc=0、`up -d --no-deps gateway` rc=0、包装器 rc=0；仅 gateway 容器 `783361bd1dc9`→`fce05001eb24`，api/ai-worker/postgres 三 CID 与两网络逐一不变，FpEKm3 数据/seed/secrets 保留；回环普通 GET `/` 返回 200。state 仅经脚本内存加载、不经 Read/cat 回显；原始日志私有 0600，根读无密 report 并独立 docker ps 核对。完整资源与原始日志仅私有 `~/.cache/dev-toolbox-lab/r116-gateway-update/`（0700/0600），不入仓库。
- 根真实页面验收（1280×720，仅本地 mock 拦截、三次拦截均已清除）：① A 有历史时选 B（暂停 B 历史 GET，Response 200），旧 A 立即隐藏并显示读取态；新对话填草稿再放行，标题/草稿保留、无旧 B 内容。② B 历史暂停时点 A，A 读取完成后放行 B，最终 A 选择/草稿保持、无 B 历史。③ B 旧历史暂停期间发送并完成 1 次本地 mock 回答、编辑新草稿、再放行旧页：旧历史补入，新问句仅 1 条、两条回答均有复制按钮、无停止按钮、发送可用，草稿/模型 low 保留。截图 3 张（dt-r115-history-late-red.png、dt-r116-new-conversation-green.png、dt-r116-history-send-green.png）存该验收聊天 2026/10/22 可视化目录，不复制入本仓库。
- 边界：本轮有实际 gateway 构建与容器替换，「无追加容器操作」仅指本次文档补记；首 snapshot 等细分只由 R115 单测保证，勿冒称全做浏览器；未重复手机布局检查；R79 唯一次整审、文末四项用户决策原文未动；V3 正式完成/真实 40 题评测/发布状态未变；未提交/推送；后续 R117 为只读产品缺口复核。

## DT-R118｜产品缺口静态只读复核（已完成；1 主＋1 只读审读子均已自然结束；事实由根审定、R119 owner 代记）

- 范围与产出：静态只读复核共发现 3 个候选问题；零源码/测试/文档改动，无全产品完成结论。
- 后续：前两项已分别由 DT-R119、DT-R120 修复并经根验收（见两节）；第三项「上传等待取消」尚未核服务器结果语义，仅为静态候选，不写成已证实必须修。

## DT-R119｜助手登录失效后观察无限重连修复（已完成并经根验收：根逐读最终生产差异——对 R115 已审完整源码比较仅新增 9 行——与 3 项新测试并接受；未提交；本会话即本轮与 docs19 收口 owner）

- 修复范围：仅 `assistantStore.ts`（`observePersistentRun` catch 在 abort 检查后新增窄分支）与新增 `assistantStore.authExpired.test.ts`。要点：仅 ApiError 401＋`AUTH_REQUIRED`（与 `auth.logout` 同一三重判定）停止本次观察并复用既有 `stopObservation` 清理 reconnecting 与观察占用，提示「登录已失效，已停止恢复回答；请退出登录后重新登录」；已收到消息、会话、草稿/模型选择保留，不伪造 Run 失败或取消、不发送 stop/delete/重建；网络错误与非 `AUTH_REQUIRED` 仍按既有合同重连；旧观察被 abort 后的迟到错误由前置 abort 检查挡住。
- 红绿事实：新增 3 测试修前 1 红 2 绿（红测复现 401 `AUTH_REQUIRED` 落入 reconnecting=true 无限重连）、修后 3/3 绿；助手组 15 文件 87/87 一次稳定绿（zsh pipestatus 记录真实 EXIT=0）；R119＋R120 统一 `pnpm build`（vue-tsc＋tsc＋Vite）一次通过 rc=0，完整无密日志 `/tmp/dt-r119-r120-build.log`（0 条 TS 诊断、Vite built in 1.26s）。
- 边界：未做真实 Cookie 过期/浏览器 SSE 断线复现，停止后恢复重新观察等行为由公开 action 单测覆盖，不冒称浏览器验证；未提交/推送。

## DT-R120｜SupplementDrawer 累加文件选择修复（已完成并经根验收：根已真实本地页面修前/修后重放并接受；未提交；事实由根审定、R119 owner 代记）

- 修复范围：仅 SupplementDrawer 累加文件选择逻辑与对应 boundary 测试新增 4 例。
- 红绿事实：4 新例修前红 EXIT=1，修后 2 文件 9 例绿 EXIT=0。
- 根真实页面验证：18581 本地页面修前/修后重放连续选择，两张合成截图（dt-r120-file-selection-red.png、dt-r120-file-selection-green.png）存根 2026/10/22 可视化目录：修前第二批替换第一批只剩 1 个；修后两批共 2 个、移除第一项仍留第二项。验证过程无保存或 POST，测试草稿已放弃关闭，无新增保存记录。

## DT-R121｜ItemAI 版本详情读取失败误显空态修复（已完成并经根验收：根已完整比较本轮前后 ItemAIView 生产差异、读新 4 测试并接受，最终 19 测试绿与 build 日志核对通过，并完成 18581 真实页面本地合成响应验收；未提交；R119 收口释放后本会话获 docs19 唯一 owner，写入后释放）

- 修复范围：仅 `ItemAIView.vue` 最小源改动（新增 `artifactError` 详情错误状态、`loadArtifact` catch 改写为详情错误、`reloadArtifact` 原地重读入口（仅 GET 当前版本、加载中防重）、模板详情错误块与样式，AbortController 迟到丢弃及 R24/R25/R27 合同原样保留）与新增 `ItemAIView.detail-error.test.ts` 4 例；未触碰 task 轮询、列表并发及其他工作流未提交改动。真正列表为空仍保持原空态。
- 红绿事实：新 4 例修前红 3 绿 1，红均来自产品缺陷（详情 GET 失败后显示「暂无 AI 派生版本」误导空态、无原地重读入口；真正空态用例修前即绿）；红测命令真实退出码未保留（管道 tail 干扰），不写数字。最终候选 ItemAIView 组件组 5 文件 19/19 绿（pipefail EXIT=0，无密日志 `/tmp/dt-r121-tests.log`）。
- build 事实：首轮 `pnpm build` 因新测试 fixture spread 后缺显式 `itemId`/`taskRunId` 被 vue-tsc 拒绝（TS2322、EXIT=2）；补齐该两行（与既有 version-race/offpage fixture 写法一致）为类型检查要求、非产品红，修正后最终 `pnpm build`（vue-tsc＋tsc＋Vite）通过 rc=0（`/tmp/dt-r121-build.log`，Vite chunk>500kB 警告为既有），不写「一次 build 通过」。
- 根真实页面验证：18581 仅浏览器本地合成响应（Fetch patterns 拦截 artifacts 列表为 1 个已存在版本、详情 GET 返回 500，不向后端写数据）：修前 DOM 同时「1 个版本＋暂无 AI 派生版本」（截图 dt-r121-artifact-detail-red.png）；载入新构建后显示独立「版本内容读取失败＋重新加载」、无空态（截图 dt-r121-artifact-detail-green.png，为修后失败块与重读入口、非重试成功内容）；桌面深/浅主题可辨，390×844 浅色 scrollWidth=390、错误块 332px 与按钮可见（dt-r121-artifact-detail-mobile-light.png）；点击重新加载 Network 仅 1 个 GET 当前详情（无 POST），合成 detail 返回后经 DOM 观察标题恢复、错误入口消失。三截图存根 2026/10/22 可视化目录；此为真实浏览器页面＋本地合成网络响应验收，不代表真实后端故障场景或真实 Provider 测试；验证环境（拦截、仿真、临时 viewport）已清理并还原默认。
- 边界：详情失败块浅色/深色真实主题由根页面验收覆盖，未做真实后端 5xx 与付费 Provider 场景；未提交/推送。

## DT-R122｜知识附件慢速上传截断只读诊断与标准库 httptest 机制实验（已完成；先只读核对，后私有机制实验，单主无子，已自然结束；事实由根审定、R123 owner 代记）

- 范围：先只读核对现状——Go main 全局 ReadHeader 5s/Read 15s/Write 60s，两个 AuthoriseMutation(records:write) multipart 入口同步读取 body，Caddy 未配 request_buffers，Nginx 兜底 proxy_request_buffering off；后做私有 Go 标准库 httptest 机制实验（报告 `~/.cache/dev-toolbox-lab/r122-upload-timeout/report.txt`），仅标准库、无鉴权/存储/DB/代理链，不能冒充真实知识 handler 全链路。
- 三个实际 case：同 197050 字节 multipart（files[] 196608 字节）快发 200 且服务端读全；同 body 慢发（16KiB/1.5s）15.0009s 得 500，服务端 files[] 读取 ~15.003s 报 i/o timeout；入口本地延长 deadline（25s）后同慢流 18.011s 完整读全并 200，harness 实际 exit 0。
- 结论撤回：实验轮早先「UI 最多 15 秒/无限等待排除」「家宽分布」「历史作者意图」等过宽推断一律撤回，不保留为事实；实验只证明 server ReadTimeout 是覆盖 multipart body 读取的绝对窗口、且逐请求 deadline 延长在 handler 层可行。
- 交接：修复由 DT-R123 实施。

## DT-R123｜知识附件慢速上传被通用 15 秒期限截断修复（已完成并经根验收：根已审最终 Go 三文件与新测试、核两个真实 handler 红/绿日志与稳定 go test/go build 真实回执均 0、gofmt 空输出，最后变化仅纠正注释、源行为与已审候选一致，API 实现接受；本轮 1 主＋1 Nginx 子，主与子均已结束；本会话获 docs19 唯一 owner，写入后释放）

- 修复范围：仅 Go 三源文件＋新 `upload_deadline_test.go`。`internal/knowledge/upload.go` 新增窄 helper（读预算 300s、写 deadline 同一起点＋360s 即 60s 余量，`http.ResponseController` 实现，恰两个真实消费者），`createMultipart` 与 `createSupplementMultipart` 在鉴权与合法参数解析之后、幂等数据库预查之前接线；deadline 设置失败不静默当成功，按既有 INTERNAL_ERROR 收口；幂等预查本身也在 300s 窗口内（注释按此表述）。main.go 四项全局期限、20MiB/100MiB/10 文件限额、鉴权/CSRF/PAT、幂等/事务/原始记录不变量全部保留。
- 红绿事实：真实 httptest.Server（短 2s 全局读写期限＋3s 小文件停顿）经生产 RequestID/Recover/RequestLog 链挂两个真实 handler（无 Idempotency-Key、files 后未知 part 走既有 422 分支退出）：修前两入口均连接被服务器关闭为真实红（exit 1）；修后各自经 422 分支完成，证明 body 读完整且未进落库。普通对照请求不调用 helper 仍被短全局期限拦截；同起点 300/360 对应关系与 unsupported writer（500 INTERNAL_ERROR、不静默成功）用例通过。一次补充文案断言中途失败为测试 fixture 文案差异（supplement 与 create 入口 422 文案不同），非产品红。
- 稳定回执：`go test ./internal/knowledge ./internal/platform/httpapi` 与 `go build ./cmd/server` 均 exit 0，gofmt 干净，无密日志在 `/tmp/dt-r123/`。
- 边界：缩短时限的机制测试不冒充真实 >65s 上传或触库全链路；360s 写 deadline 是网络写入限制，不是 handler 总执行超时。
- Nginx 365s 方案撤回：根核官方 1.28.2 源码证实代理请求体未发完的 NGX_AGAIN 分支先 return、body 发送完才挂 read timer（proxy_read_timeout），原「65s 会截断慢上传」前提不成立；子已精确移除仅其本轮新增的 location/断言，既有 404 规则、Agent Console 等保持本轮前快照（模板与轮初逐字节一致、test-production-edge-modes.sh 无 diff），保留原 65s 配置。「body 发完」与「Go 收完 body」两时刻不宣称绝对同步，也不保证所有后处理耗时 ≤60s。缓存 Nginx 的独立有界机制实验已由 DT-R124 执行唯一一次完成（仅隔离机制验证、非生产模板或代理全链路验收，见 DT-R124 节），本节仍不写为代理全链路已通过。

## DT-R124｜缓存 Nginx 1.28.2 最小配置慢上传计时隔离机制实验（已完成并经根验收：唯一一次实跑 wrapper/container 均 exit 0；仅 loopback、network none、缓存镜像与合成数据，非生产模板或代理全链路验收，不重跑；独立私有实验主已自然结束，事实由根审定、R125 owner 代记）

- 范围与结果：隔离 nginx 1.28.2 最小配置机制实验，唯一一次实跑 wrapper 与 container 均 exit 0，runtime 4802ms；报告 `~/.cache/dev-toolbox-lab/r124-nginx-upload-timer/run/report-20261022T144303Z.log`。
- Case A（慢发请求体）：同 163840 B 请求体按 8KiB×20、每片间隔 150ms 发送，上游实际读取 21 次、跨 2896ms，client 得 200 / 2922ms。
- Case B（上游延迟响应）：快速发送同 body，上游读满后延迟 1500ms，client 得 504 / 1005ms，client 结束相对上游 bodyDone 1003ms。
- 核对：两项 match 均为真、watchdog 为假、cleanup 确认 30ms；自有容器 `ps` exit 0 且输出为空（已消失），根独立核空。
- 边界：仅 loopback、`network none`、缓存镜像与合成数据；不是生产 Nginx 模板，不是代理全链路验收，不重跑。

## DT-R125｜R119/R120/R121/R123 修后合成栈 api＋gateway 定向更新与补充入口真实限速长传验收（已完成并经根验收：唯一一次 build api rc0/23.093s、build gateway rc0/21.386s、up rc0/8.890s、总 exit 0；执行期只读迁移门禁 10/10/0；根已读 report 与真实回执并独立核四 CID/两网；单主无子，本会话即本轮与 docs19 唯一 owner，写入后释放）

- 更新范围：仅重建并替换自有合成栈 `dev-toolbox-v3-acceptance` 的 api 与 gateway（串行 `build api`→`build gateway`，`up -d --no-deps api gateway`），原因是 R119/R120/R121 前端与 R123 API 源码已过根审/相关测试/build 但该栈尚未更新；gateway 构建同时包含 R126 的纯 CSS 修正。更新器 `~/.cache/dev-toolbox-lab/r125-api-gateway-update/api-gateway-update.mjs` 复用 R116 已审脚本（固定 orbstack context/project/env/compose＋override 与全部 binds、state.json 仅内存解析与目录断言、parse 错误不带原文、日志创建即 600、无密 report），新增四容器/两网精确身份核验、执行期只读 `/app/migrate --preflight` 门禁（仅 10/10/0 放行）、新 api 容器自身 healthcheck 就绪与重建生效校验；根审后仅加三处有界修正（dockerLines timeout 10s＋SIGKILL、migratePreflight killSignal SIGKILL、runStage 超时文案改「termination requested」），`node --check` 一次 exit 0 后唯一一次正式运行。
- 真实回执：api `a33416b68849`→`daf1d102f60e`，gateway `fce05001eb24`→`7c3f0b112ed9`；worker `d97d089a87b3`、postgres `a2d63860bea4` 与两网络 `cb238584974d`/`04d5180cf4c0` 前后不变；gateway `127.0.0.1:18380/` 200，新 api 容器自身 healthcheck（容器内 wget `http://127.0.0.1:8080/health/ready`）healthy，不以 SPA 回退的 `/health/ready` 200 代替。端口、env/override/seed/secrets 保持；无 pull/prune/down、无新 override、未触碰 worker/PG。共三次只读预查，首次仅确认 exit0 但字段提取未成功；后两次（JSON 恢复解析与正式执行期门禁）可确认 10/10/0，三次均未实施迁移写库。
- 合成 fixture：`DT-R125-SYNTHETIC-SLOW-UPLOAD.txt` 恰 524288 字节纯 ASCII、内容明示合成；更新器本身无业务 POST。
- 根浏览器真实限速验收（合成写入，仅补充入口）：先创建 1 条合成主记录（含同 512KiB 文件；该次约 3.4s 即限速恢复，不计为慢传证据）。随后同条目补充正文 90 字节＋同 512KiB 附件：旧 API 持续 8KiB/s 下真实 500（client 25.959s、同请求 server 15002ms），原页原正文/File 保留；新 API 同 8KiB/s 下原页原草稿重试，Network 核原 Idempotency-Key 相同，真实 201（client 64.112s、同请求 server 64071ms），UI 原始记录 1→2、附件 1→2，实际读取补充正文与输入一致；仅创建 1 条新补充、原主记录仍在。完整限速后已恢复、未刷新原 Tab5；返回原 B 会话标题与 22 字未发送草稿完全相同、模型/low 保持——原 UI 上下文保留限于不刷新原 Tab5 的条件，不是跨整页 reload 的保存。截图 dt-r125-upload-red.png / dt-r125-upload-green.png 存根 2026/10/22 可视化目录，report 在本轮私有 lab。
- 边界：本次真实长传只验补充入口，创建入口仍以 R123 真实 handler 定向测试覆盖，不能声称两入口都做了 64 秒实跑；合成栈与合成数据验收，不是真实付费 Provider 40 题评测、V3 正式完成、发布/tag 或生产验收；未提交/推送。

## DT-R126｜补充与快速记录抽屉错误重试按钮 390 竖排修复（已完成并经根验收：仅 SupplementDrawer 与 QuickCaptureDrawer 各一个错误按钮规则加 flex-shrink:0＋white-space:nowrap，根逐字比较其它字符不变、源码冻结；纯 CSS，无新增单测与主机重复 build，生产 build 由 DT-R125 gateway 包含；未提交；R126 主已自然结束，事实由根审定、R125 owner 代记）

- 修复范围：仅两组件各一个错误按钮 CSS 规则新增 `flex-shrink: 0` 与 `white-space: nowrap`；正文/逻辑/文案无改；context 无 drift、机械检测 `[]`。
- 修前复现：根独立 Tab6 以旧产物真实 UI 复现 QuickCapture 390 下「重/试」竖排（浏览器合成 500）。
- 修后验收：载入新网关后两入口桌面 1280 与 390 均 nowrap、shrink 0，Capture 按钮 50×40、Supplement 52×40；Tab 从前一个控件可到重试且焦点可见；alert/document 无横向溢出；补充错误可滚动完整查看。3 次浏览器内合成 POST 全部被 Fetch 拦截回 500、未抵达后端，R126 无业务写入。截图 4 张 green：dt-r126-{capture,supplement}-green-{desktop,mobile}.png，另 capture-red-mobile；拦截/仿真已清除，测试草稿关闭、Tab6 关闭。
- 边界：浏览器合成响应验收，不代表真实后端 5xx 或付费 Provider 场景；未提交/推送。

## DT-R127｜R119 鉴权失效 SSE 真实浏览器局部回放（准备＋根唯一一次回放均已完成；源码零改动、回放通过、无需修复；R125 更正收口并释放 owner 后本会话接任 docs19 唯一 owner，写入后释放）

- 准备（本会话只读侦查，零修改、零检查运行）：定位 R119 直接分支——观察订阅为 fetch GET `/api/v1/assistant/runs/{runId}/events?after={appliedSequence}`（非 EventSource；`Accept: text/event-stream`、same-origin 凭据）；SSE 线上编码为 `event:`＋`data:`（单行 JSON）＋空行分发，持久流首事件必须 `snapshot`，其后事件 `sequence` 严格等于已应用序号 +1；鉴权失效不走 SSE error 事件，而是 events GET 本身返回 HTTP 401＋JSON `{"error":{"code":"AUTH_REQUIRED",…}}`，store 窄判定 `status===401 && code==='AUTH_REQUIRED'` 后 stopObservation、展示「登录已失效，已停止恢复回答；请退出登录后重新登录。」、不再排期 600ms 重连、不触发 auth 登出跳转；浏览器内触发观察只需把 history GET 响应中最后一条带 currentRun 的 assistant 消息的 `currentRun.status` 改为 running（latestActiveRun 只认 queued/running）。材料交根执行。
- 根回放事实（根提供，本节唯一一次记录）：全新独立 Tab7 只读真实 B 会话 history（4 条消息、2 问 2 答），最新真实 assistant.currentRun 非空、原 status succeeded、真实 lastSequence 44。浏览器内拦截该 history GET，只把已有对象的状态/生命周期字段改为 running/streaming（沿用全部真实 ID 与既有内容，不在后端造 Run）；随后自动订阅，首 GET events?after=0。按变体 B 保留原快照正文与真实 lastSequence 44，以有限 SSE snapshot(lastSequence 44)＋answer.delta(sequence 45，追加「DT-R127 断线前合成片段。」)后正常 EOF；实际看到「连接暂时中断，正在恢复回答…」并发生第二 GET events?after=45，草稿仍在。
- 第二 GET 以浏览器 Fetch.fulfillRequest 回 HTTP 401＋JSON error.code AUTH_REQUIRED（非 SSE error 事件）；UI 立即显示「登录已失效，已停止恢复回答；请退出登录后重新登录。」。第二响应后约 72.702 秒时根一次读取完整事件缓冲：目标 run events GET 仍恰 2 次（after 0/45），两次均被拦截未到后端、未出现第 3 次；拦截在取证结束后才清除，不能被真实终态响应掩盖。两个历史用户消息、两答原内容与新增片段仍在，22 字本轮合成草稿保持，恢复中提示消失。Network 本轮业务 POST/PATCH/PUT/DELETE 计数 0，未调用任何 Provider、未启动 mock run、后端业务状态不变。约 72.702 秒为取证间隔事实，不写成精确终止耗时或正式稳定性测试。
- 清理与边界：Fetch patterns 清空、本轮草稿由 UI 清空、新对话退出观察、Tab7 关闭；原 Tab5 B 会话原 22 字草稿再次对比完全相同。截图 dt-r127-auth-required-stream-stopped.png 存根 2026/10/22 可视化目录（不入本仓库）。仅验证真实浏览器中合成 401/AUTH_REQUIRED 的前端行为，不代表真实 Cookie/Session 过期、生产故障或付费 40 题。回放通过，源码无需修改，不为凑问题加修复；R119 节及其余历史段落、R79 审计范围与文末四项用户事项逐字未动。本节写入后释放 docs19 owner。

## DT-R128｜正则工具真实 Worker 超时与再次运行验收记录（文档收口，无代码修复；根已完成源级只读确认与真实 IAB 桌面验收，事实由根提供、本 owner 仅代记，不重跑不另证；R127 已自然结束并释放 docs19 owner，本会话接任唯一写入 owner，写入后释放）

- 源级事实（根只读确认，本轮零源码改动、未重跑任何测试）：`regexRunner.ts` 生产 `defaultWorkerFactory` 为真实一次性 Web Worker，默认 500ms 定时分支 terminate 后以「表达式运行超时，Worker 已终止」reject；既有 `regex.test.ts` 已用 FakeWorker 覆盖超时分支，本轮未重跑该测试。
- 超时真实验收（根执行，仅桌面）：全新独立 IAB Tab8 打开 `localhost:18380/tools/regex`（R125 生产网关产物），无 mock、无网络拦截、无设备或网络仿真；桌面 1280、gmu flags；表达式 `^(a+)+$`、测试文本 40 个 ASCII `a` 加 `!`（41B）、替换模板「已替换」，只运行一次。实际 UI 出现「表达式运行超时，Worker 已终止」，输入/flags/替换模板保留，控件恢复可编辑、「运行正则」重新可用。此为真实 Worker 行为，不是 FakeWorker 单测；根未测精确 500ms 终止时刻，不把取证/工具墙钟时间当执行基准。
- 再次运行恢复（根执行，同页）：只改表达式为 `a+` 后再显式运行一次：完成 1 个匹配、范围 [0,40)、替换预览「已替换!」正确；旧超时错误消失，其余输入保留。未反复跑灾难性 case，未做取消/离页/大输入/浏览器矩阵扩展。
- 网络与清理（根执行）：两次运行 Network 共捕获 2 个请求，其中 API 请求 0、外部 host 请求 0、POST/PATCH/PUT/DELETE 0（不进一步臆测这 2 条请求的性质）；全程本地，无外部付费资源/Provider、无业务写入。Tab8 已关闭，无残留仿真/拦截；原 Tab5 B 会话草稿未操作。
- 证据与结论：截图 dt-r128-regex-worker-timeout.png 与 dt-r128-regex-worker-recovery.png 存根 2026/10/22 可视化目录 `/Users/hxf/.codex/visualizations/2026/10/22/01a15af6-2571-7290-ab40-4feef7914639/`（不入本仓库）。结论：已有行为正确，无需源码修复，不为凑问题加修复。仅桌面实际交互验收，不是严格时间基准、全产品验收、付费 40 题评测或发布；未提交/推送。本轮 docs 写入仅本文件本节一处，按时间线插于 R127 后、待处理前；其余历史（含 R79 审计范围与文末四项用户事项）逐字未动；本节写入后释放 docs19 owner。

## DT-R130｜R125 新增条目自身索引状态只读核验与固定夹具临时流引用回溯（已完成；零源码改动；根已另读 docs16 第 156–172 行确认 filename 片段首版不作回答证据，两条 filename 无嵌入行符合合同、非漏索引或失败，无需修复源码；R128 已释放、R129 只读结束无改动无节，本会话接任 docs19 唯一 owner，单主无子，写入后释放）

- 根 UI 索引总览与关键词搜索（根执行）：R125 更新后在真实 UI 看到知识索引 generation 1、active 7/ready 7、pending/running/failed/excluded 均 0。用新增补充正文唯一短语「持续限速上传对照」发一次只读业务 `POST /api/v1/search`：200、唯一 1 条结果，指向 item `84fa3955-c2e7-4be5-bb8a-b64d4017e043`（hit `205b261c-4a17-57a5-b525-bb5efd42e533`）；打开后「搜索命中定位」与真实只读补充正文均为 R125 那两行 90 字节，512KiB 附件仍在。截图 dt-r130-new-supplement-search-hit.png 在根 2026/10/22 可视化目录。
- 精确 PG 只读查询（本会话执行，唯一一次）：白名单 inspect 确认短 CID `a2d63860bea4` 即 `/dev-toolbox-v3-acceptance-postgres-1`（project `dev-toolbox-v3-acceptance`、service postgres）后，容器内唯一一次 psql：`-X --no-password -v ON_ERROR_STOP=1`、`BEGIN READ ONLY`＋`SET LOCAL statement_timeout='5s'`、命令外层约 15 秒上限，exit 0（BEGIN→SET→3 行分组→COMMIT）。查询为单条定向 JOIN 分组（knowledge_items→search_fragments→assistant_fragment_embeddings，按 source_kind/active/generation/state/policy_snapshot 分组计数，仅该 item）。真实结果：该 item 共 5 个 active search_fragments——raw_text×2 与 title×1 均 generation 1/state ready/policy redact；filename×2 无嵌入行，按 docs16 第 156–172 行（filename=否、首版不作回答证据）与索引候选六类清单（title/metadata/raw_text/code/ai_text/image_text）不参与 Assistant，是设计内不入索引，不写成 excluded=2，也不是漏索引或失败。数据库 role/name 仅取公开 `deploy/tests/v3/stack.mjs` 固定配置；容器内 Unix socket `--no-password` 现有认证接受；未读 state/env/secret、不改认证，未查正文/向量/key，无 DML/DDL/迁移/写库。
- 固定夹具临时流（根执行）：根只读 `deploy/tests/v3/mock-provider.mjs` 确认 rewrite/answer 均为固定夹具；根仅发一次前端 `POST /api/v1/assistant/temporary/stream`（200），问题含「结合青岚复核笔记，列出这次可引用的原始资料来源」，临时回答只引用旧「青岚复核」2 条。该次请求不是向新条目提问的精确召回测试，不据此判断新条目索引故障；也不把这一次前端请求写成底层 Provider 只有一次调用。未追加任何模型请求，未变更 Mock/检索阈值；仅本地合成 Provider，未访问付费真实服务。
- 引用回溯（根执行）：该次引用 [2] 来源抽屉显示 raw_text/S2，摘录「青岚验收节点每周一进行复核。」；点击打开原笔记到 item `227e2a62-a8c6-48ec-bfbf-23ddbe0f0955`，显式读取原文同句一致。截图 dt-r130-citation-original.png 同目录。流结束 Network 有 `canceled=true`/`net::ERR_ABORTED`，同时 UI 回答/用量/引用均已显示，不单独把它判为服务端失败。来源回溯验证的是旧夹具引用，不是新条目的精准召回或答案质量。
- 清理与结论：Tab10 离开临时对话后已关闭；原 Tab5 原 B 会话与 22 字草稿保留；无网络拦截/仿真变更。新增条目现有允许入 Assistant 的 3 片段 ready 已由目标查询确认，关键词搜索与引用入口正常，无需源码修复。此为合成栈局部核验，不是正式验收、真实 40 题/发布；用户四项待决原文保留。本轮 docs 写入仅本文件本节一处，按时间线插于 R128 后、待处理前；未重跑 SQL/测试/build/HTTP/Provider/容器，未改版本/Git；其余历史（含 R79 与四项用户事项）逐字未动；本节写入后释放 docs19 owner。

## DT-R131｜工作页刷新后草稿与模型恢复验收（已完成；仅文档记录，零源码改动、无需修复；根已完成真实 UI 验收，本 owner 只代记根提供事实、不重跑；R130 已释放，本会话接任 docs19 唯一 owner，单主无子，写入后释放）

- 前置与唯一一次刷新（根执行）：Tab5 原 B 会话自 R125 运行时更新后一直未刷新。根先只读捕获当时 22 字草稿、所选模型 ID/标签、reasoning 值/标签及 DOM 中现成模块脚本 src；原草稿仅留内存副本、未另存文件。确认当前仍是原 B 会话且草稿未变后，执行唯一一次整页 reload。
- 刷新后恢复结果（根执行）：刷新后进入默认新对话，原先 19 字「新对话」草稿也显示；根手动点击原 B 会话（不声称自动恢复选中会话）。其历史真实返回后：原 B 22 字未发送草稿逐字相同，模型与思考档位值均相同（验收模型·V3 合成 Provider/低），历史消息正常显示；全程无手动填回、无发送消息或发起模型请求。
- 构建确认方式（根执行）：DOM 中现成 module 脚本 src 刷新前后不同，仅在内存比较并输出布尔值，用于确认保留页在此次刷新后已载入 R125 当前构建；未计算额外哈希/摘要、不输出原始资源标识。原 Tab5 继续保留供后续工作。
- 结论与边界：五项检查全部为真——draftPreserved/modelPreserved/reasoningPreserved/updatedFrontendLoaded/historyVisible。无源码修改、无需修复、未追加测试/build/运行时更新。仅覆盖同标签页普通刷新＋重新选择原会话的恢复行为，不扩大为跨浏览器/设备/清存储/真正会话过期/自动恢复选中会话的保证。
- 证据与收尾：截图 dt-r131-reload-preserved-draft.png 存根 2026/10/23 可视化目录 `/Users/hxf/.codex/visualizations/2026/10/23/01a15af6-2571-7290-ab40-4feef7914639/`（不入本仓库）。用户四项待决、正式 V3 验收/付费 40 题评测/版本 tag 发布均不变。本轮 docs 写入仅本文件本节一处，按时间线插于 R130 后、待处理前；未跑测试/build/浏览器/HTTP/Provider/容器、未重复 OCR、未建过程或证明文件、未改版本/Git；其余历史（含 R125 当时「未刷新 Tab5」的历史条件、R79 与四项用户事项）逐字未动；本节写入后释放 docs19 owner。

## DT-R142｜本地 WebKit 补验与资料库错误隔离

- 环境与溢出结论（R134–R135）：采用已装 Playwright 1.62.1/WebKit build 2336（engine 26.5），缓存 CLI 与现有引擎不匹配，不重装。独立 headless WebKit 以 mobile=true/touch=true、viewport 390×664、screen 390×844、DPR 3 与桌面 1280×800 在 light 主题检查 /tools/translate、/tools/ocr-translate、/settings/aliyun：三页两视口根元素横向溢出均为 0。翻译仅走浏览器 mock 成功链；设置页只看合成 DTO，未保存/删除。新测试 context 的 auth/session 等业务 API 均 mock/abort，未用真实登录与凭据、未调用真实 Aliyun/产品 Provider；tesseract 模型资源仍来自本站 /tesseract。
- 键盘可达性补验（R136–R137）：根看图发现 fullPage 截图仅覆盖 shell 当前 viewport、按钮尺寸统计不能代表触达，遂补内部滚动。R136 关闭 mobile 的窄屏结果被根拒作 mobile 证据并纠偏中断，未据此宣布全部通过（该轮 OCR 未完成）。R137 保持 mobile=true：focus 可聚焦 main，真实键盘使 main.scrollTop 0→508→898→0，doc/input 未被误滚；翻译底部按钮 62×44 中心命中（空输入 disabled，只记几何）。
- 控件与本地 OCR（R138/R140）：R138 补设置关键上限/并发/策略/移除等控件与桌面 OCR/设置下部：手机主要按钮/输入 44px；桌面按既有尺寸检查，未执行危险写入或云操作；summary 实测 40，不写「全部控件 44」。R138 本地 OCR 约 505ms 失败、校对卡未渲染且 staticBlocked 2，根未据此判产品 bug。R140 只对 A1 定向恢复：测试白名单额外放行同源本地 blob GET，实际 blobAllowed 2（resourceType=image、xhr，不称已证明 xhr 是 worker）、staticBlocked 0，真实默认 chi_sim+eng 识别合成 PNG 输出 Hello 123 World；校对 textarea 332×250、复制按钮 141×44 清晰可见且中心命中，继续键盘滚动后目标语言与固定底栏可达（底栏 390×92、主按钮 358×44 因未选目标语言 disabled）。未走云/翻译；原 R138 失败产物保留，未改生产 OCR 代码。根已亲看 R135 的 7 图、R138 的 6 图、R137 底图与 R140 的 3 图；代表性截图两条：/Users/hxf/.cache/dev-toolbox-lab/r140-ocr-blob-recheck/r140_a1_proof_textarea_copy.png 与 /Users/hxf/.cache/dev-toolbox-lab/r138-webkit-lower/b2_desktop_settings_bottom.png。边界：属 headless 等效 WebKit 与键盘布局补验，非真机触摸滚动、完整 AT 或正式验收；maxTouchPoints 0 只作本机实测，不外推。
- 资料库竞态修复（R139）：旧 500 响应已到 headers 而 body 读取中被新查询 abort，apiRequest 将 json 读取 AbortError 吞成 {} 后抛 ApiError；两个 catch 原无 sequence guard，旧失败可给新成功结果写入刷新失败横幅。修复仅 library.ts 两个 catch 各加 1 行现成 sequence 判断，未改共享 apiRequest。library.test.ts 新增 3 条真实 apiRequest＋ReadableStream/AbortSignal 回归（旧 browse→新 search、旧 search→新 browse、当前失败保留具体错误）：修复前 RED 2 failed/4 passed，修复后 6/6 green，pnpm check 通过；语义参考 https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch 。源修复无其它重构。
- 网关更新（R141）：根审私有 gateway-only 脚本后仅执行一次：gateway production build rc0/30968ms（含 pnpm check＋Vite，保留 >500KB chunk 提示，不写零 warning）；up --no-deps gateway rc0/1949ms；本地 gateway CID 7c3f0b112ed9→ecd0d3eb59d8。根独立 Docker 元数据确认 API daf1d102f60e、worker d97d089a87b3、PG a2d63860bea4 均未换且 healthy，网络 cb238584974d/04d5180cf4c0 不变；gateway 只绑定 127.0.0.1:18380，静态 HTTP 200，API 健康来自既有容器 metadata（未拿 SPA /health 当 API 健康）。未迁移/seed/备份/正式发布，Tab5 原 B 保留页未刷新；私有 report：~/.cache/dev-toolbox-lab/r141-gateway-update/report.json（未读任何 state/env）。
- 收尾：四人工事项、RC review、正式 V3 验收/付费 40 题、版本 tag 与 R79 一次性审计范围全部保留，不宣称后续改动全量 OCR 再次通过。本轮 docs 写入仅本文件本节一处，按时间线插于 R131 后、待处理前；未跑测试/build/HTTP/浏览器/容器/Provider、未做 Git 操作、未建过程或证明文件；其余历史（含 R131 澄清、R125 当时未刷新 Tab5 的历史条件、R79 与四人工事项尾段）逐字未动；本节写入后释放 docs19 owner。

## DT-R146｜资料库导航跨入口响应归属

- 已证问题与修复（R143/R144）：初始目录/标签读取尚未返回时，桌面与手机管理入口没有 navigationLoading 禁用，抽屉 saving 只约束自身提交，用户可创建目录或标签并触发第二次导航刷新。旧成功会覆盖刚创建的目录，旧失败会回到初始调用者；R143 的“缺少可达异常序列”判断已被真实 store/API 回归推翻。R144 仅在 library.ts 的 loadNavigation 增加局部 navigationSequence，旧成功与失败忽略，只有当前请求解除 loading，最新失败仍抛出。R139 的 browse/search 错误归属保护原样保留。
- 验证：沿实际 createFolder/createTag 与 apiRequest，延迟真实 Response 交付，修前 2 failed / 7 passed，修后 9/9；pnpm check 退出 0。三条新增回归分别覆盖旧成功不能抹去新目录、旧失败不能否定已完成的新标签刷新、最新失败仍保留具体错误。根已完整阅读源与测试差异；未将单元测试称为真实浏览器乱序复现。
- 本地更新（R145）：精确复用已审 R141 私有脚本，仅替换轮次、私有目录、载入轮次与预期旧 gateway 身份；根独立逐字比较通过。唯一一次 gateway build 退出 0（约 21.4 秒，含 Web 类型检查与生产构建），随后 up -d --no-deps gateway 退出 0；仅 gateway 被替换。根独立核对其他三容器、两张网络、端口均保持，仍只绑定 127.0.0.1:18380；静态入口首个 HTTP 200、既有 API healthcheck 元数据 healthy。私有报告 ~/.cache/dev-toolbox-lab/r145-gateway-update/report.json；既有大 chunk 警告保留，不称零警告。
- 边界：本轮只修资料库前端与对应测试；未迁移/重启其他服务、重复全库 OCR、运行完整浏览器或正式发布门禁、调用真实付费 Provider/阿里云，未改变版本、tag、Git 提交/推送或正式验收结论。R79 唯一次统一审计及文末四项用户事项原文保留。

## DT-R151｜设置首次读取失败的保存门禁

- 已证问题（R147/R149）：自动整理页首次三项 GET 任一失败仍显示默认 off/02:00 并允许保存；AI 与敏感数据页首次两项 GET 任一失败仍显示默认 redact、三个空模型与假摘要，并允许覆盖未知配置。根分别在旧运行版本真实 IAB 页面重放，实际捕获到默认 off 与 redact/空模型的合成 PUT；两次保存均已被临时页 Fetch 拦截，真实配置未写。
- 最小修复与回归：两页各只改三行模板，直接复用既有 settings 非 null 的就绪事实控制正文、摘要与保存按钮，保留错误/重读与成功后正常保存，不新增状态或样式。R147 新增一条实际组件/API 回归，修前 Vitest 1 failed / 3 passed（命令退出码被 tail 覆盖，以失败输出判定，未称 rc1），修后 4/4、Web pnpm check 退出 0；R149 同类新增一条，修前 1 failed / 4 passed、rc1，修后 5/5、Web check 退出 0，既有允许敏感原文外发必须确认的测试继续通过。根已完整读两轮源与测试差异。
- 根局部页面补验（1280×720）：更新后两页首次失败均保留错误和重读入口，保存 disabled、默认表单与假摘要消失，故障态零 PUT；Enter 重读后，自动整理恢复合成每日 04:25 与正文模型，AI 策略恢复合成 block 与三个默认模型，随后各一次 mock 保存保持正确配置。首个正常页面打开仅读取既有会话/配置，故障重放与保存阶段用合成响应，不称真实策略写入或真实模型验证。准备阶段曾遇 CSS 导航被阻止、拦截事件/处理器问题，纠正工具后才计入功能结果，不据此判产品失败；最后按浏览器要求清空 raw interception patterns 并关闭临时 Tab12，原 B 会话/草稿未操作。
- 本地载入（R148/R150）：两次分别精确克隆上轮已审私有脚本，仅替换轮次/目录/载入轮次/预期旧 gateway 身份，根独立逐字比较通过；各仅一次 gateway build 和 up -d --no-deps gateway，均退出 0，构建各约 20.8 秒且包含 Web check 与生产构建。根分别独立核对仅 gateway 替换，其他三容器、两网与端口保持，仍仅 127.0.0.1:18380，静态首个 HTTP 200、既有 API healthcheck healthy；私有报告为 ~/.cache/dev-toolbox-lab/r148-gateway-update/report.json 与 ~/.cache/dev-toolbox-lab/r150-gateway-update/report.json。既有大 chunk 警告保留，不称零警告。
- 边界：无实际 AI 策略/凭据/付费 Provider/阿里云调用，无其他服务重启、迁移、全量 E2E、正式发布或验收状态变更，未提交/推送、改版本或 tag。R79 唯一次整审及文末四项用户事项原文保留。

## DT-R155｜设置保存反馈与模型说明准确性

- 已证问题与修复（R152/R153）：旧页面保存后编辑默认模型或时间，草稿/摘要已变但旧“已保存”仍显示，根真实 IAB 已分别复现。AI 策略页扩展既有 watch 到三个默认模型，保留原 allowConfirmed 条件；自动整理页监听现有七项表单值，使用同步 watch 保持“响应回填在前、成功提示在后”的顺序。原 R147/R149 就绪门禁保留，无新状态机/自动保存。两句旧“需要工具调用”说明同步对齐已支持的工具调用/严格 JSON 双通道及图片视觉能力，能力过滤与协议未改。
- 验证：R152 新增一条组件回归，RED 1 failed / 5 passed、rc1；初次 GREEN 汇总 6 passed 但过滤命令未保全退出码。R153 扩展既有成功保存 case，RED 1 failed / 3 passed、rc1；稳定候选合并 m3-settings 与 m4-workbench 一次，10/10、真实 rc0、无未处理错误，Web pnpm check rc0，补齐前次回执缺口。根完整读差异及原始私有日志，m3 在 R153 中逐字未改，既有首读失败与 allow 确认回归继续通过。
- 本地载入（R154）：精确克隆已审私有脚本并只替换元数据，根全文比较与权限核对通过；唯一一次 gateway build 约 20.6 秒（含 Web check/生产构建）及 up --no-deps 均 rc0。根独立核仅 gateway 替换，其余三容器、两网与端口不变，仍只 127.0.0.1:18380；静态首个 HTTP 200、既有 API healthcheck healthy。报告 ~/.cache/dev-toolbox-lab/r154-gateway-update/report.json；既有大 chunk 警告保留。
- 根桌面 IAB（1280×720）：两页各一次 mock 保存后编辑，旧提示均消失，03:30 草稿/摘要或待保存变更 1/其他模型保留，各页 PUT 仍 1 次。supportsTools=false 的合成模型可选，两条新说明完整可见且无横溢。头部对照图 dt-r153-schedule-edit-stale-saved-header-red.png、dt-r153-schedule-edit-clears-saved-header-green.png 与 dt-r152-policy-edit-clears-saved-green.png 位于本聊天 2026/10/23 可视化目录。初次正常打开只读既有配置，重放/保存阶段用合成响应，零真实 PUT；临时拦截已清空、Tab13 已关、原 B 未刷新。
- 边界：属局部状态/文案与桌面 mock 补验，不称完整矩阵或正式验收；无真实付费 Provider/阿里云、迁移/其他服务重启、生产发布/版本/tag/Git提交推送。R79 唯一次整审与文末四项用户事项原文保留。

## DT-R158｜保存期间输入保护与本地收尾

- 真实问题（R156）：根用暂停的合成 PUT 在 IAB 复现，自动整理提交 04:25 后仍能编辑为 03:30，迟到成功将草稿覆盖回 04:25；AI 策略保存中改模型，迟到成功会把未发送的新编辑标成已保存。两页各直接对现有原生控件绑定 busy 禁用（自动整理 7 处、AI 策略 4 处），保留现有 API、首读门禁、saved watch、allow 确认与焦点逻辑，无新状态/包装/CSS。
- 实施与验证：主 Agent 负责自动整理及 m4 测试，唯一 frontend-builder 子负责 AI 策略及 m3 测试，子配置经核为 GLM-5.3/max，两者各只写自有两文件，均已自然结束。每页新增一条真实组件、实际 apiRequest 与 deferred PUT/503 回归；主 RED 1 failed / 4 passed、子 RED 1 failed / 6 passed，真实 rc1；候选稳定后两文件一次合并 12/12、rc0，Web pnpm check rc0。根完整读四文件差异与原始日志；原合成日志初始 644，收尾已逐一改为 600，未含真实凭据。
- 额度中断与实际载入（R157）：标准 GLM-5.3 请求 13 秒后因每周/月上限结束，界面显示 2026-10-29 07:11:40 重置（未标时区），未执行工具。根未购买升级或切换本聊天模型，改用 CUA 控制 ZCode 本项目内置终端执行已审脚本的精确副本；仅四项元数据替换，全文比较与 node --check 门禁通过。唯一一次 gateway build 约 20.0 秒、up --no-deps 约 1.6 秒均 rc0，报告 ~/.cache/dev-toolbox-lab/r157-gateway-update/report.json。根独立核仅 gateway 变化，其余三容器、两网、端口不变，仍只 127.0.0.1:18380，静态首个 HTTP 200、既有 API healthcheck healthy。目录 700、脚本/日志/报告 600；既有大 chunk 警告保留。
- 根 IAB 补验（1280×720）：合成 weekly 调度的 9 个原生控件与 AI 策略 6 控件在 pending 时全部 disabled；503 后全部解禁，04:25/星期三/两模型/策略或三个默认模型草稿保留，可真实继续编辑为 03:30/清空整理模型，未自动追加 PUT。各页仅一次合成 PUT，未知 API 阻断数 0、零真实 PUT；临时 Tab15、暂停请求与 raw interception patterns 均已清理，原 B 未刷新。代表图 dt-r157-save-failure-draft-editable-green.png 位于本聊天 2026/10/23 可视化目录。
- 边界：本轮为局部输入保护、类型/定向测试及本地 mock 页面补验，非完整矩阵或正式验收；无真实付费 Provider/阿里云、其他服务重启/迁移、生产发布/版本/tag/Git提交推送。R79 唯一次整审与文末四项用户事项原文保留；编码服务额度情况如上记录，当前已审本地收尾已完成。

## DT-R161｜Token 创建后的列表读取归属

- 问题与边界（R159）：Token 页初始 GET 尚未完成时，界面允许创建；POST 成功后的新 GET 返回后，旧成功会把新 Token 从列表抹掉，旧失败会在最新列表添加错误。真实组件与实际 apiRequest/deferred Response 回归分别在这两个位置失败（RED 2 failed / 8 passed，rc1）；另测最新 GET 失败仍可见。仅在 TokenSettingsView.vue 增加局部读取序号，成功/错误/结束 loading 都归最新请求；保留创建入口、一次性明文、scope、API 与 busy 语义，无新依赖或持久化。
- 实施与最小验证：因 R158 已记录的 ZCode 额度中断，本轮由根经 CUA 操作 ZCode 自有 dev-toolbox 2 终端写入源码与 m3 回归测试，未重复调用模型。先只插入三条测试确认 RED，再改源码；候选一次 m3 10/10、rc0，Web pnpm check rc0。根全文对比两文件，既有内容仅按审核的局部替换/插入变化；日志 ~/.cache/dev-toolbox-lab/r159-token-read-ownership，目录 700、日志/退出码 600。
- 本地载入（R160）：复用 R157 已审 gateway-only 脚本，仅替换轮次/日志目录/修复轮次/旧 gateway CID 四项元数据，全文核对与 node --check 后执行一次。build 20.3 秒、up --no-deps 约 1.7 秒均 rc0；gateway 7cc0e5e2f2ea → c691d4c53ded，API/worker/PG、两网络与端口经根独立只读核对不变，仍只 127.0.0.1:18380，静态首个 HTTP 200、既有 API healthcheck healthy。报告 ~/.cache/dev-toolbox-lab/r160-gateway-update/report.json，目录/文件 700/600；生产构建已有 chunk 提示如实保留。
- 真实页面验收：独立 IAB 合成 fixture 在旧网关复现“创建后 1 条 → 旧成功返回后 0 条”；更新后分别释放旧成功/503，均保留新 Token、不显示伪错误、loading 正常结束，一次性合成明文可显示并关闭，每例仍只有 2 GET/1 mock POST；最新失败由定向测试证明不被吞。三个页面用例共 3 mock POST，真实创建/撤销 0，未知 API 0。临时页 16 的拦截全部清除、无悬挂请求并已关闭；原 B 页草稿未刷新。
- 审计与授权边界：本轮没有再次运行 R79 全量 OCR，也不把之后改动称为已经全量 OCR 审计。未提交、推送、改版本/tag/正式验收，未调用付费 Provider/云评测、创建真实 PAT、轮换凭据或扩大网络访问；四项人工事项保持原文。

## DT-R164｜Provider 保存后的列表读取归属

- R162 复现：初始 Provider GET 未完成时允许新增；保存后的最新列表已显示新配置，旧成功仍会清空它，旧失败仍会追加伪错误。真实组件与实际 apiRequest/deferred Response 新增三条回归，两个竞态各在目标断言失败（RED 2 failed / 5 passed、rc1），最新请求失败用例通过。仅在 ProviderSettingsView.vue 增加局部列表读取序号，最新请求统一拥有列表、HTTP 标志、测试模型选择、错误与 loading；索引轮询、Embedding、密钥处理与 API 均未改。
- 根经 CUA 操作 ZCode 自有 dev-toolbox 2 终端实施，未因额度限制重复调用模型。唯一源码局部补丁增加 4 行，既有 V3 测试只插入本轮用例；候选稳定后 V3 与保存焦点两文件 10/10、rc0，Web pnpm check rc0，Provider/模型保存后焦点恢复及 pending GET 期间抽屉行为均保留。根全文核对两文件；私有日志 ~/.cache/dev-toolbox-lab/r162-provider-read-ownership，目录/文件 700/600。
- R163 本地载入：已审 R160 gateway-only 脚本仅四项元数据替换，根全文核对、node --check 通过后执行一次；build 约 25.7 秒、up --no-deps 约 1.6 秒均 rc0，gateway c691d4c53ded → 0d83b69099c9。根独立只读核对 API/worker/PG、两网络与端口不变，仅 127.0.0.1:18380，首个静态 HTTP 200、既有 API healthcheck healthy；报告 ~/.cache/dev-toolbox-lab/r163-gateway-update/report.json，目录/文件 700/600，构建已有 chunk 提示保留。
- 真实 IAB 两例各暂停初始 GET，经表单模拟创建后再释放旧成功或 503；新 Provider 均保持可见，无伪错误/loading/横向溢出，各 2 GET/1 mock POST，最新失败仍由定向测试证明可见。API Key 为明确合成值，真实配置写入、连接测试与外部 Provider 调用均为 0，未知 API 0；临时页 17 的拦截已清除、无悬挂请求并关闭，原 B 草稿未刷新。
- 未重跑 R79 全量 OCR，未提交/推送/改版本/tag/正式验收，未调用付费评测、变更凭据或扩大网络访问，四项人工事项保持原文。

## DT-R167｜设置页主内容优先与响应式收尾

- R165 问题：1280 页面中，次要摘要卡被共享 CSS 在容器 ≤1060px 时用 order:-1 提到主工作区前，主配置/实体列表被推到下方，视觉顺序与 DOM 不同。按既有 PRODUCT.md、DESIGN.md 与精确 R1 设置骨架 Screen 41d4983dae7c4021a28381d9d0b88b91，只移除 settings.css 这一行；沿用现有单/双栏、手机顺序、令牌、文案和功能，不改组件或数据。
- 根使用 impeccable/layout 先做人工布局判断，再跑定向扫描；context --target 只执行一次（关闭无关更新探测），布局扫描与修改后机械扫描均 rc0/[]。源码由根经 CUA 操作 ZCode 自有 dev-toolbox 2 终端精确替换，全文比较仅删该行；无新依赖/状态/抽象/单元测试。私有日志 ~/.cache/dev-toolbox-lab/r165-settings-layout，目录/文件 700/600。
- R166 仅本地 gateway：已审脚本四项元数据替换、全文核对和 node --check 后一次执行。build 约 20.2 秒（包含 Web 类型检查与 Vite build）、up --no-deps 约 6.3 秒均 rc0，gateway 0d83b69099c9 → ca18f3f3d8e0；根独立核对其余三容器、两网络和端口不变，仅 127.0.0.1:18380，静态首个 HTTP 200、既有 API healthcheck healthy。报告 ~/.cache/dev-toolbox-lab/r166-gateway-update/report.json，目录/文件 700/600，既有 chunk 提示保留。
- 一批真实 IAB 验收：Token 使用长中文和多个 scope 的只读合成 fixture，390×844（mobile emulation）、1024×768、1280×720、1440×900、1920×1080、3840×2160 六尺寸各深/浅主题；单栏主内容在摘要之前，1440 起为右侧摘要，4K 内容受限居中，均无页面/主区横向溢出，只有既有主区域纵向滚动。原生截图接口对非默认视口会裁切，已改用浏览器 Page.captureScreenshot 并核 PNG 范围等于对应视口，不以初始裁切图作视觉证明。另核 Provider、AI 策略、自动整理三页在 1280 的共享顺序与首个主控件可见；实际 Tab 到“保存设置”，焦点可见且 solid 2px。
- 原深色偏好已恢复；真实配置写入/Provider 调用 0，未知 API 0，无悬挂请求；临时页 18 拦截已清除并关闭，原 B 草稿未刷新。这里是 Chromium/IAB 模拟尺寸与局部视觉验收，不冒充真机、完整辅助技术或全浏览器矩阵。未重跑 R79 全量 OCR，未提交/推送/改版本/tag/正式验收，四项人工事项保持原文。

## DT-R170｜Embedding 测试结果与连接参数归属

- R168 复现：既有 watch 在编辑连接参数时只清已完成结果；等待中的 A 测试仍会在模型改为 B 后显示旧成功或旧失败。真实组件与实际 apiRequest/deferred Response 新增旧成功、旧失败、最新失败三条回归；RED 两个目标断言失败（2 failed / 8 passed、rc1），最新失败可见用例通过。根也在旧前端 IAB 以一次 mock POST 复现 model-b 与 A 的“连接成功”同时存在，未连接外部 Provider。
- 最小修复：仅 ProviderSettingsView.vue 增加局部连接版本，沿用现有 baseUrl/apiKey/modelId/dimensions watch，同步使参数版本和旧显示失效；测试提交时捕获版本，只接收归属当前参数的成功/错误。等待中仍能编辑，测试/保存按钮沿用既有 pending 约束；不取消或重试请求，不改变密钥、外发范围、费用说明、API 或索引流程。根经 CUA 操作 ZCode 自有终端精确替换，净加 5 行；V3 测试只插入本轮三例，既有内容保留。稳定候选一次 10/10、rc0，Web pnpm check rc0，impeccable 定向机械检查 rc0/[]；私有日志 ~/.cache/dev-toolbox-lab/r168-embedding-test-ownership，目录/文件 700/600。
- R169 本地载入：已审 gateway-only 脚本四项元数据替换、根全文比较与 node --check 门禁后一次执行；build 约 20.1 秒、up --no-deps 约 1.5 秒均 rc0，gateway ca18f3f3d8e0 → ffad57dea4e0。根独立只读核对其余三容器、两网络与端口不变，仅 127.0.0.1:18380，首个静态 HTTP 200、既有 API healthcheck healthy；报告 ~/.cache/dev-toolbox-lab/r169-gateway-update/report.json，目录/文件 700/600，构建既有 chunk 提示保留。
- 修后真实 IAB：旧成功和旧 503 均不覆盖 B 的草稿、不显示过期结果/错误，按钮恢复可显式重测；显式测试 B 返回 19ms 成功可见，之后改 Base URL 又清结果且 POST 数不增加。最新失败不被吞由定向回归证明。前后共 4 mock POST，真实 Provider 调用/配置保存均 0，未知 API 0；页 19/20 的拦截已清除、无悬挂并关闭，原 B 草稿未刷新。判定依据是实际 DOM/请求归属与有效原生截图；RED 截图只含草稿，另一个 CDP 黑帧不作结果证明。
- 未重试已耗尽的模型额度，未重跑 R79 全量 OCR，未提交/推送/改版本/tag/正式验收；人工事项原文保持。

## DT-R173｜Embedding 保存期间的草稿保护

- R171 问题与复现：Embedding 保存中仅按钮受保护，五个输入和启用开关仍能修改；成功响应 setEmbeddingSettings 会覆盖等待期间的新草稿。真实组件/实际 apiRequest/deferred PUT 新增一条保护及 503 恢复回归，RED 在 readonly 断言失败（1 failed / 10 passed、rc1）；旧前端 IAB 另以一次 mock PUT 复现“提交 A → 输入 B → 迟到成功重置为 A”，六个控件当时均可改。
- 最小修复：只对既有五个输入绑定 readonly=embeddingBusy、启用开关绑定 disabled=embeddingBusy；保持文本焦点，不影响测试等待中编辑，不新增状态、CSS、错误路径或 API。根经 CUA 操作 ZCode 自有 dev-toolbox 2 终端实施并全文比较，唯一源码差异为六个属性；测试仅插入本轮一例。候选稳定后 V3 11/11、rc0（包含 R168 测试等待可编辑回归），Web pnpm check rc0，机械扫描 rc0/[]；私有日志 ~/.cache/dev-toolbox-lab/r171-embedding-save-draft，目录/文件 700/600。
- R172 本地载入：已审 gateway-only 脚本仅四项元数据替换，经全文核对、node --check 后执行一次；build 约 19.4 秒、up --no-deps 约 1.3 秒均 rc0，gateway ffad57dea4e0 → c930b2d1c303。根独立核对其余三容器、两网络和端口保持不变，仅 127.0.0.1:18380，静态首个 HTTP 200、既有 API healthcheck healthy。报告 ~/.cache/dev-toolbox-lab/r172-gateway-update/report.json，目录/文件 700/600，构建既有 chunk 提示保留。
- 修后 IAB：五个输入 readonly、开关 disabled，实际 End+x 键盘输入未改变提交值；释放合成 503 后六个控件全部恢复，草稿保留且错误可见，再填写 B 成功、PUT 仍为 1。前后浏览器共 2 mock PUT，真实配置写入、索引变更、Provider 调用均 0，未知 API 0；页 21/22 的拦截均清除、无悬挂并关闭，原 B 草稿未刷新。有效原生截图只用于展示可编辑草稿，错误与请求数量以实际 DOM/拦截记录确认。
- 未重试耗尽的模型额度，未重跑 R79 全量 OCR，未提交/推送/改版本/tag/正式验收；四项人工事项原文保持。

## DT-R176｜聊天模型连接结果的模型归属

- R174 复现：连接状态只按 Provider 保留；A 成功后切到 B 仍显示 A 成功，A 请求等待中切到 B，迟到凭据错误也仍显示。真实组件/实际 apiRequest 两条回归各在目标结果断言失败（RED 2 failed / 11 passed、rc1）；同时检查选择变化不新增请求、pending 按钮继续禁用、显式测试 B 的成功/凭据错误仍可见。
- 最小修复：只在私有 TestState 附带实际提交的 modelId，testing/success/error 三种赋值都带该值，展示时与当前选择匹配；继续沿用既有单次在途按钮约束，不自动测试或重试，不变更 API、错误分类、凭据、索引或费用说明。根经 CUA 操作 ZCode 自有终端精确替换，源码净加 3 行，既有 V3 测试只插入本轮两例；稳定候选 13/13、rc0，Web pnpm check rc0，机械检查 rc0/[]。私有日志 ~/.cache/dev-toolbox-lab/r174-provider-test-model，目录/文件 700/600。
- R175 本地载入：已审 gateway-only 脚本四项元数据替换、全文核对与 node --check 后执行一次；build 约 20.1 秒、up --no-deps 1.5 秒均 rc0，gateway c930b2d1c303 → 6be75c65ba73。根独立核对其余三容器、两网络和端口保持不变，仅 127.0.0.1:18380，首个静态 HTTP 200、既有 API healthcheck healthy。报告 ~/.cache/dev-toolbox-lab/r175-gateway-update/report.json，目录/文件 700/600，构建已有 chunk 提示保留。
- 真实 IAB 对照：旧前端 A 测试返回 12ms 后切 B，旧成功仍显示；修后 A 在途时切 B，按钮仍禁用且 POST 仍 1，迟到 A 成功不显示，按钮恢复后显式测试 B 的合成 422 可见。前后共 3 mock POST，真实 Provider 调用/配置写入 0，未知 API 0；页 23/24 拦截均清除、无悬挂并关闭，原 B 草稿未刷新。HTTP 结果全部合成，只证明前端归属与请求数量，不作真实凭据或外部连通性结论。
- 未重试耗尽的模型额度，未重跑 R79 全量 OCR，未提交/推送/改版本/tag/正式验收；人工事项原文保持。

## DT-R179｜连接测试的启用状态与有效选择

- R177 合同与复现：服务端 providers.go 查询明确同时要求 provider.enabled 与 model.enabled；前端刷新却用 some(id) 保留已停用模型，且测试按钮未检查 Provider 开关。真实组件/实际 apiRequest 三例分别覆盖停用 Provider、停用当前模型后有/无启用替代；RED 3 failed / 13 passed、rc1，在目标选择/按钮断言失败。旧前端 IAB 用一次 mock 模型 PATCH 再现“已有启用 B 却下拉空白、测试仍可用”，另核停用 Provider 的下拉禁用而按钮可用，未发起测试。
- 最小修复：只让保留当前选择的判断同时检查 model.enabled，并让测试按钮同时检查 provider.enabled；沿用现有首个启用模型/空选择及单次在途逻辑，无新状态、API、权限、CSS 或依赖。根经 CUA 操作 ZCode 自有终端，全文比较只变两处条件，V3 只插入本轮三例；稳定候选 16/16、rc0，Web pnpm check rc0，机械检查 rc0/[]。私有日志 ~/.cache/dev-toolbox-lab/r177-provider-test-eligibility，目录/文件 700/600。
- R178 本地载入：已审 gateway-only 脚本四项元数据替换、全文核对、node --check 后执行一次；build 约 20.8 秒、up --no-deps 约 1.5 秒均 rc0，gateway 6be75c65ba73 → 5cdb852840db。根独立核对 API/worker/PG、两网络与端口不变，仅 127.0.0.1:18380，首个静态 HTTP 200、既有 API healthcheck healthy。报告 ~/.cache/dev-toolbox-lab/r178-gateway-update/report.json，目录/文件 700/600，构建既有 chunk 提示保留。
- 修后 IAB：通过编辑抽屉停用 A 后自动选择启用 B，尚未测试；显式点击才发送 B 的已保存 ID。停用 Provider 后下拉/按钮均禁用；再以仅一个模型重演停用后为空选择/按钮禁用，请求数不增加。前后共 3 mock PATCH、1 mock POST，真实配置写入/Provider 调用 0，未知 API 0；页 25/26 拦截已清除、无悬挂并关闭，原 B 草稿未刷新。全部 HTTP 结果为合成响应，只证明前端资格/请求行为，不作外部连通性结论。
- 下一轮定向调查候选：后端 Provider PATCH 会清 last_test_*，但 recordProviderTest 当前仅按 Provider ID/未删除条件写结果；需用合成延迟测试与配置变化复现旧结果是否回写新配置，尚未修复或验证，不冒充本轮已完成项。未重跑 R79 全量 OCR、未重试耗尽模型额度，未提交/推送/改版本/tag/正式验收，人工事项保持原文。

## DT-R182｜后端连接测试结果归属与 API 本地载入

- R180 复现 R179 候选：测试最初读取旧 Provider 配置，等待合成 worker 时修改连接，原 recordProviderTest 仅按 ID/未删除条件仍把旧结果写回新配置。新增隔离集成回归，初始 RED 用 Base URL 变化分别释放成功/凭据错误，2 failed / 1 passed、rc1；显示名调整对照通过。GREEN 前把凭据错误例改为 API Key 替换，最终覆盖 Base URL 变化、Key 替换、仅显示名变化；不声称 Key 替换做过 RED。
- 最小修复：providers.go 私有快照保存实际测试的 protocol/baseURL/加密 Key，六条记录路径沿用同一快照，单条 UPDATE 原子地要求 enabled、未删除且三项仍匹配；过期结果不落库，原探测 HTTP 结果仍返回。显示名不影响连接，不按 updatedAt 一概丢弃；无新增表、迁移、API 或依赖。源码净加 8 行及一个 157 行集成测试，根全文比较/gofmt 核对；secretbox.Open 使用新输出，不改写快照密文。
- 必要验证：现有 Go 1.27.1 交叉编译 linux/arm64、并发上限 2，复用已运行 PG 中新建的独立 dev_toolbox_r180_provider_context_test；只迁移该新库。GREEN 三个连接归属子例、直接消费者 TestM5OperationsMigrationAndIntegrity、internal/ai 单测均通过 rc0。合成探测不发外部 Provider 请求，运维测试只使用本地状态/附件 fixture，无 restic；口令只由 PG 内子进程消费，未输出或传回宿主机。完成后私有测试库与容器内临时目录已移除，根另核库计数 0/目录不存在；既有验收库未重置。日志 ~/.cache/dev-toolbox-lab/r180-provider-test-context，700/600。
- R181 本地载入：经全文审查和 node --check 的 API-only 脚本执行一次，只读 migrate --preflight 为 10/10/0；build api 18.6 秒、up --no-deps api 1.7 秒均 rc0，API daf1d102f60e → a2d81fba8fbb 且 healthcheck healthy。gateway 5cdb852840db、worker d97d089a87b3、PG a2d63860bea4、两网络及所有端口保持，入口仅 127.0.0.1:18380。根独立核对元数据，迁移目录/APP_VERSION/Compose 无本轮改动。
- 探针纠正：初始脚本错误使用 127.0.0.1 Host，匿名会话得到 200，脚本 rc1，原 report.json 如实保留；Caddy 与栈源码确认实际配置 Origin 为 http://localhost:18380，改用该 Origin 的一次匿名补验返回预期 401，无 Cookie/Authorization、不读响应体。补验记录 anonymous-origin-check.json，不把最初 rc1 改称通过，也不作真实登录/Provider 连通性结论；未重复构建。报告 ~/.cache/dev-toolbox-lab/r181-api-update，700/600。
- 执行均由根经 CUA 操作 ZCode 自有终端；未重试耗尽模型额度，native agent 仍 0，原 B 草稿未刷新。未重跑 R79 唯一次全量 OCR，未提交/推送/改版本/tag/正式验收，四项人工事项原文保持。

## DT-R185｜配置保存后的前端连接反馈失效

- R183 定向复现：Provider Base URL 保存后仍显示旧成功；同一模型记录改上游 ID 时，旧在途状态及迟到凭据错误仍显示在新配置下。真实组件/实际 apiRequest 两例 RED 2 failed / 16 passed、rc1；旧网关 IAB 又以一次 mock PATCH/POST 复现后者，内部模型记录 ID 保持不变。
- 修复仅限 ProviderSettingsView：私有测试版本写入既有三种结果；成功保存 Provider 或当前被测试的模型记录后推进版本，显示同时匹配模型 ID 和配置版本。旧请求仍完成并释放既有单次在途约束，保存不自动测试、不重试；未新增 API、依赖、CSS 或密钥处理。源码净加 12 行、既有 V3 文件加 79 行两例；根全文精确比较。稳定候选 V3 18 条加保存焦点 3 条共 21/21、rc0，Web check rc0，impeccable 定向扫描 rc0/[]；日志 ~/.cache/dev-toolbox-lab/r183-provider-config-feedback，700/600。
- R184 只载入网关：沿用已审脚本，更新轮次/CID，并改用实际 localhost Origin；全文比较及语法检查后只执行一次 build gateway（19.8 秒）/up --no-deps gateway（1.5 秒），均 rc0。gateway 5cdb852840db → c7c42c28777b；根独立核对 API a2d81fba8fbb、worker、PG、两网络及端口不变，localhost 首页首次 200、既有 API healthy。报告 ~/.cache/dev-toolbox-lab/r184-gateway-update，700/600，未重复构建。
- 修后 IAB：保存模型后旧反馈隐藏，旧请求仍在途时按钮禁用；释放合成 422 后不显示旧错误、按钮恢复、焦点落回编辑模型；只有再点击才发第二次测试并显示 34ms。前后浏览器共 3 mock POST、2 mock PATCH，真实配置写入/Provider 调用 0，未知 API 0；页 27/28 的拦截均清除、无悬挂并关闭，原 B 草稿未刷新。有效原生截图 dt-r183-saved-config-explicit-retest-green.jpg 展示合成结果，不作外部连通性结论。
- git diff --check 通过。未重跑 R79 全量 OCR、未重试耗尽模型额度、native agent 仍 0；未提交/推送/改版本/tag/正式验收，四项人工事项原文保留。

## DT-R188｜回收站操作依据条目真实删除状态

- R186 合同与复现：普通搜索 SQL 固定 i.deleted_at IS NULL，搜索 DTO 不含 deletedAt；列表 DTO 已返回该字段。旧 Workspace 仅按 route.view=trash 选择卡片，导致未删除搜索命中、以及切入回收站时保留的普通列表都变成“删除于…／恢复／永久删除”，且不能打开详情。搜索回归 RED 1 failed / 4 passed、rc1；补充普通列表→回收站等待/失败路径后，仅新例 RED 1 failed / 5 skipped、rc1。旧网关 IAB 用一次只读 mock 搜索 POST 复现正常记录出现两项错误操作，未点击操作。
- 最小修复：仅将普通卡片条件改为 !isTrash || !libraryEntry(entry)?.deletedAt；只有真实带删除时间的列表条目才显示回收站卡片，不改搜索范围、API、服务端删除保护或确认流程。两条回归覆盖搜索与清除后的 debounce 过渡、普通列表切入回收站的等待与失败；保留原四例并复用现有 helper。根精确比较源码只有一处条件；稳定候选搜索 6 条加既有回收站键盘/确认 4 条共 10/10、rc0，Web check rc0、impeccable 扫描 rc0/[]、git diff --check 通过。日志 ~/.cache/dev-toolbox-lab/r186-trash-search-card，700/600。
- R187 本地载入：已审 gateway-only 脚本仅更新轮次、私有目录与旧 gateway 身份，精确比较/node --check 后执行一次；build 20.2 秒、up --no-deps 1.5 秒均 rc0，gateway c7c42c28777b → 4cb18d9a6d52。根独立核对 API a2d81fba8fbb、worker/PG、两网络及端口保持，仍仅 127.0.0.1:18380，实际 localhost 首页首个 200、API healthy。报告 ~/.cache/dev-toolbox-lab/r187-gateway-update，700/600。
- 修后 IAB：普通命中为含正确 item/hit 的链接，无恢复/永久删除；实际 Tab 五次可达，焦点 solid 2px。清除搜索后延迟回收站 GET 时旧命中仍为普通链接；释放响应后真实 deletedAt 条目恢复两项操作。前后共 2 个只读 mock 搜索 POST，恢复/永久删除请求 0、真实数据写入 0、未知 API 0；页 29/30 拦截已清、无悬挂并关闭，原 B 未刷新。有效原生图 dt-r186-search-hit-has-no-trash-actions-green.jpg 展示普通结果与焦点，不作完整浏览器或辅助技术验收结论。
- 经 CUA 操作 ZCode 自有终端实施；未重试耗尽额度，DT native agent 0。未重跑 R79 全量 OCR、未提交/推送/改版本/tag/正式验收，四项人工事项原文保持。

## DT-R191｜最近记录的排序合同与真实 API 补验

- R189 问题：后端 library.go 与 API 合同明确要求 view=recent 固定 effective_desc；前端仍提供“最近更新”并优先采用 URL 的 updated_desc。未加拦截的实际本地页面选择该项后出现“刷新失败，以下仍是上次结果：资料库筛选条件无效”，三条旧结果被保留；临时页 31 已关闭，只做只读查询。新增两条真实组件/API 回归，分别覆盖旧 URL 与搜索→清除，定向 RED 2 failed / 6 skipped、rc1。
- 最小修复：WorkspaceView 仅在 recent 且无有效搜索词时优先固定有效采集时间，并禁用此时的排序控件；有搜索词时保留相关性/时间选择，清除后立即恢复固定浏览合同。两处源码锚点、净加 2 行，无新状态、API、路由改写、CSS 或依赖；根全文精确比较，既有回收站显示条件原样保留。稳定 Workspace 小套件 8/8、rc0，Web check rc0，impeccable 局部扫描 rc0/[]，git diff --check 通过；未重复运行不受此次排序条件影响的回收站弹窗组。日志 ~/.cache/dev-toolbox-lab/r189-recent-sort，700/600。
- R190 本地载入：已审 gateway-only 脚本四项元数据替换、全文比较/node --check 后执行一次；build 19.4 秒、up --no-deps 1.4 秒均 rc0，gateway 4cb18d9a6d52 → 9ae0c1d58828。根独立核对 API a2d81fba8fbb、worker、PG、两网络/所有端口保持，入口仅 127.0.0.1:18380，实际 localhost 首页首次 200、API healthy。报告 ~/.cache/dev-toolbox-lab/r190-gateway-update，700/600。
- 修后真实 IAB/API：未安装 Fetch 拦截、未改 fixture；带旧 updated_desc URL 打开时显示固定 effective_desc、控件禁用且三条本地合成记录正常。输入既有合成词“织云”后控件可用、相关性搜索返回一条；清除后恢复三条、固定排序与搜索框焦点，全程无错误横幅。页 32 已关闭，原 B 未刷新；未修改知识记录或配置、未调用付费 Provider/阿里云。原生图 dt-r189-recent-real-api-sort-restored-green.jpg 展示本地合成库，不作外部服务或正式验收结论。
- 经 CUA 操作 ZCode 自有终端实施，耗尽模型额度未重试、DT native agent 0。未重跑 R79 全量 OCR、未提交/推送/改版本/tag/正式验收，四项人工事项原文保持。

## DT-R194｜恢复失败反馈、明确重试与焦点归属

- R192 已证问题：restoreItem 捕获的错误只渲染在永久删除弹窗，普通“恢复”失败无任何可见提示；新回归定向 RED 1 failed / 8 skipped、rc1。旧网关 IAB 一次合成 503 复现无 alert、原条目保留/按钮恢复但焦点为 BODY，真实恢复 0，临时页 33 已清理关闭。
- 局部修复：仅在回收站列表复用现有 destructiveError/refresh-error 呈现非弹窗错误，打开另一永久删除动作时清旧错误；未加状态或 CSS。首候选 13/13、类型/机械检查 rc0；根实际页面发现失败丢焦点后，再把原点击元素作为本次调用局部变量，结束后 nextTick 只在元素仍连接且焦点为 BODY 时回焦，用户主动移焦保持。模板仅补传 $event，源码较本轮起点净加 9 行；一条回归覆盖失败可见/条目保留/按钮恢复、打开并取消其他动作无旧错误、只在显式重试后成功。最终稳定候选再次 9 条 Workspace + 4 条回收站键盘/确认共 13/13，Web check rc0、impeccable 局部扫描 rc0/[]；这次重跑因焦点源码改变，首轮日志保留。根全文比较源码/测试；日志 ~/.cache/dev-toolbox-lab/r192-trash-restore-error，700/600。
- R193 本地载入：已审 gateway-only 模板四项元数据替换、精确比较与 node --check 后执行一次；build 25.4 秒、up --no-deps 1.6 秒均 rc0，gateway 9ae0c1d58828 → 01cb394d60d5，localhost 首页首个 200、API healthy；API a2d81fba8fbb、worker/PG、两网络与所有端口保持，仍只绑定 127.0.0.1:18380。私有报告 ~/.cache/dev-toolbox-lab/r193-gateway-update，700/600，未重复构建。
- 修后 IAB：第一次合成 503 显示错误、条目和可用按钮保留，DOM 确认焦点回到恢复按钮；实际 Enter 发起第二次请求，等待时主动点击搜索框，第二次 503 后焦点仍在搜索框；第三次显式点击合成 204 后错误/条目清除并显示空回收站。前后合计 4 mock 恢复 POST，真实恢复/永久删除 0、未知 API 0；页 33/34 拦截已清，无悬挂并关闭，原 B 未刷新。截图 dt-r192-restore-failure-feedback-and-focus-green.jpg 只证明可见错误和保留条目；回焦及保留用户焦点由实际键盘/DOM 断言确认，不以图片冒充焦点环证据。
- 本轮仍由根经 CUA 操作 ZCode 自有终端实施，DT native agent 0。期间 KB 转述用户已恢复额度，随后 KB 实际标准 GLM-5.3 执行测试、VC 新会话实际启动，属于新条件；DT 将在本轮收口后用新会话核实恢复，不再按旧额度错误反复重试。既定 KB3+DT2+VC3≤8 分配保持。未重跑 R79 全量 OCR、未提交/推送/改版本/tag/正式验收，四项人工事项原文保留。

## DT-R200｜附件缩略图失败反馈与主动重试（R195–R198）

- R195 在新 ZCode 会话恢复标准 GLM-5.3/最高/完全访问，实际执行只读工具并用 1 个只读后端子核对合同；主/子均自然结束。R196 浏览器合成图片 500 确认旧页面只有坏图、没有失败文案。原件下载“会把错误 JSON 成功保存”的推断未获实测支持：合成 512 KiB 成功对照通过，404 对照未出现成功下载事件（等待超时不等于证明全部错误路径）；未据此扩写下载链路。
- R197 新会话实施：仅 ItemDetailView 与紧邻的 3 场景回归。运行时图片错误显示“预览加载失败／重试预览”，显式点击清除当前附件失败态，由 v-if 重挂原 URL 图片；详情生命周期清空失败态，静态预览限制和敏感揭示门控保持。根审查删除重复的代次计数/key/前置 guard，最终源码净加 30 行。旧代码 RED 2 failed / 1 passed、rc1；最终新用例 3/3、ItemDetail 6 文件共 26/26、Web check 均 rc0；根 impeccable 局部检测 rc0/[]。实际日志已收归 ~/.cache/dev-toolbox-lab/r197-thumbnail-retry，700/600；初版类型检查失败及修正日志保留，未将其误报为通过。
- R198 单次 gateway-only 加载：已审模板四项元数据替换、精确比较与语法检查后执行；build 21.8 秒、up --no-deps 1.6 秒均 rc0，gateway 01cb394d60d5 → 0954d59d97ee，localhost 首页首个 200、API healthy。根独立核对 API a2d81fba8fbb、worker d97d089a87b3、PG a2d63860bea4、两网络和端口保持，入口仍为 127.0.0.1:18380。报告 ~/.cache/dev-toolbox-lab/r198-gateway-update。
- 更新后 IAB：首次 500 显示失败反馈且无坏图；实际 Enter 重试再遇 500 后，Tab 能回到重试按钮；再次 Enter 收到合成 200 后 naturalWidth=1、错误与重试入口消失。首次加载与两次显式重试合计 3 次图片 GET，无附加查询参数；敏感未揭示对照无图片、无重试/下载链接、图片请求为 0。未知 API 0、真实数据写入 0；验收页 39 拦截清除并关闭，截图 dt-r197-thumbnail-failure-retry-green.jpg 为原生页面及真实焦点环。
- 后续 R199 已在真实工具箱复现：格式化后修改 JSON 输入，旧输出仍可复制且无失效提示；源码 input watcher 未取消旧计算或清结果。新独立会话当前只读准备方案，R198 加载前核实 JSON 源码未变。JSON 大整数格式化与 JSONPath 实测正确，不列为问题。常规跨会话通知已停止，仅实际冲突才协调；KB3+DT2+VC3≤8 分配保持。未重跑 R79 全量 OCR，四项人工事项原文保留。

## DT-R203｜JSON 结果失效与已确认请求归属（R199/R201/R202）

- 真实问题与取证：格式化后改输入，旧输出仍可复制；JSONPath 零匹配后改表达式仍留旧提示。合成 AI 响应另复现改输入、改目标语言、切换生成方式及等待中仅改选项时旧代码重新出现。R199 只读定位后，R201 新增九条组件回归：原代码前七例 RED 7/7、rc1；补入前七项后的第八例 RED 1 failed / 7 passed、rc1；source-only 候选的第九例 RED 1 failed / 8 passed、rc1。工作目录错误的那次命令不作为 RED 证据，已在 apps/web 有效重跑。
- 局部实现：JsonView 净加 51 行，统一清除旧 output/summary/issues/error、取消旧本地计算；只在真实输入/Schema/B 编辑、实际操作参数和生成方式切换时失效，程序生成 Schema 与应用修复提示保持。AI 成功与非取消错误共用当前类型生成上下文、源输入、Provider/模型/目标语言/发送模式的归属判断；组件内保留必要快照，HTTP 仍仅发送原 confirmation.body，不自动发送新内容。既有 repair/ai 测试全文未改；新增九例与两组既有用例最终 17/17、Web check、impeccable 局部检测均 rc0，检测 []。新测试 Promise 类型问题已修正；未将中间失败报告为通过。实际日志 ~/.cache/dev-toolbox-lab/r201-json-stale-result，700/600。
- R202 单次本地载入：已审 gateway-only 模板元数据替换、精确比较/语法检查后执行；build 23.5 秒、up --no-deps 2.0 秒均 rc0，gateway 0954d59d97ee → 8c9a1c144cb1。localhost 首页首个 200、API healthy；根独立核对 API a2d81fba8fbb、worker d97d089a87b3、PG a2d63860bea4、两网络与端口保持，仍只绑定 127.0.0.1:18380。报告 ~/.cache/dev-toolbox-lab/r202-gateway-update。
- IAB 验收：改输入后旧输出清空/复制禁用，显式重算正常；零匹配旧提示在改表达式后清除，显式查询返回当前值。AI 晚到成功与错误不污染新输入；源不变、Rust 改 Go 后旧 Rust 响应丢弃，重新确认 Go 后新结果可复制；完成后再改目标语言或切本地会清旧输出，本地 TypeScript 生成仍成功。合成结构模式预览/请求均无源值或私有源快照。红对照 3 次加绿验收 5 次 mock POST，真实 AI/数据写入 0、未知 API 0；页 42–47 已清除拦截/悬挂并关闭，原 B 未刷新。原生截图 dt-r201-json-input-invalidates-old-result-green.jpg、dt-r201-ai-old-context-discarded-green.jpg。
- 独立新问题：有效实例 {"changed":true} 与程序生成的 boolean Schema 在实际页面校验时仍被 script-src 禁止 unsafe-eval 拦截；生成本身、手改 Schema 保留和旧错误清除正常，但 Schema 校验路径未通过，不能据本轮测试声称其可用。已以新 R204 会话只读调查：主看验证库/公开合同，最多一个只读子看 CSP/Worker 响应配置；本阶段不改依赖或策略。截图 dt-r204-schema-validation-csp-blocked.jpg。KB3+DT2+VC3≤8 分配、常规通知收敛及四项人工事项保持；未重跑 R79 全量 OCR。

## DT-R214｜Schema/CSP 私有候选收口与依赖待确认（R204–R213）

- R204 确认实际浏览器 Schema 校验被 CSP 拦截：Ajv 运行时 new Function 与冻结的禁止 unsafe-eval 策略冲突；不调整 CSP。R205 在私有目录研究固定 @hyperjump/json-schema@1.18.0，仅临时安装、ignore-scripts；未应用到真实项目。既有 Worker handler 已 await 异步结果，取消/迟到结果合同保持，JsonView 除拟议的一行格式注解提示外不改 R201 行为。
- R208 实测远程 $dynamicRef 可绕过旧 $ref-only 检查，所有探针请求均被 fetch 替身拒绝；省略 validation 词汇表的 $id/$vocabulary 输入会污染后续校验，原未污染对照保留。R210 处理根/嵌套资源，R212 再以 allOf 数组入口复现遗漏（1 failed / 10 skipped、rc1），仅修正数组子节点资源识别。候选统一禁止远程两类引用、非2020-12方言和资源级自定义词汇表；精度策略保持先验证 Schema，再整份跳过不安全实例。
- R211 使用包实际发布的类型，移除错误的 ambient 声明；真实候选配真实 lossless/contracts 等 helper 的10例及类型检查通过。R213 补验布尔 Schema（能力正确），发现根错误缺少 $ 路径、null Schema 泄出 TypeError，实际 RED 2 failed / 11 skipped、rc1；以根类型校验和空片段显示修正。最终私有13/13、定向真实类型检查、git apply --check 均 rc0。中间结果提取转义错误与0-test语法失败不作产品RED或通过证据；修正后只补齐受影响检查。
- 最终未应用补丁为6个文件，位于 ~/.cache/dev-toolbox-lab/r205-schema-csp-prototype/patch/proposal.patch，说明和真实日志同目录，产物700/600。格式/未知关键字采用2020-12默认注解，页面会明确format不检查邮箱等格式；不声称完整标准矩阵或大输入性能已验证。其余JSON操作与Schema生成全文不变，真实源码/依赖清单/锁文件尚未载入候选，本节为落库记录。
- 已按仓库 AGENTS.md:62 就新增生产依赖提出具体确认：仅Web移除Ajv8.20.0、增加固定Hyperjump1.18.0并更新锁，AI worker保留Ajv；批准前不应用，批准后再做项目集成和真实浏览器CSP验收。当前未进行服务更新、真实付费调用、提交或推送，未重跑R79唯一全量OCR。常规跨会话通知继续收敛，KB3+DT2+VC3≤8上限与四项人工事项原文保持；继续独立产品检查。

## DT-R217 已批准 Web Schema 校验器落地与目录边界验收（2026-10-23）

- 用户已明确批准仅将 Web 的 `ajv@8.20.0` 替换为 `@hyperjump/json-schema@1.18.0` 并更新锁文件。DT-R216 已将 DT-R213 审查后的 6 文件候选逐字应用到真实项目；AI worker 的 package 与 lock importer 逐字保持，仍使用 Ajv 8.20.0。原 DT-R214 的“待批准/未应用”是当时状态，本节记录后续批准与落地。
- 生产集成新增发现：peer `@hyperjump/browser@1.6.0` 的 `lib/index.d.ts` 构造声明缺少参数类型且包含非法默认值，首次 Web check 实际退出 2（TS7006/TS2371）。私有候选配置的 skipLibCheck 未覆盖这层声明检查。最终沿用既有 pnpm patchedDependencies，仅将该声明一行改为 `constructor(response: Response, message?: string)`，补丁为 `patches/@hyperjump__browser@1.6.0.patch`，workspace 增加对应条目；运行时库、项目严格检查设置不变。中途添加 skipLibCheck 的方案已撤销，该中间结果不作为最终通过证据。
- 依赖安装使用官方 registry、ignore-scripts；patch-commit 不支持该 CLI 参数，读具体错误后以 `npm_config_ignore_scripts=true` 执行成功。锁文件变更只包含 Web importer 替换、10 个新增包（含校验器本身及其 9 个传递/peer 包）和声明补丁的必要登记，无其他版本升级。
- 实际验证：补丁后的原始严格 Web check 退出 0；JSON operations、staleResult、AI、repair、privacy 共 5 文件 52/52 通过，退出 0；指定改动 diff 检查与新增 workspace diff 检查均退出 0。未运行全库审计或完整 E2E，也不宣称完整标准一致性、性能或真实云服务已验收。
- DT-R215 独立修正目录：标题改为“选择一个工具”，说明本地处理与在线发送确认边界，移除页头统一“浏览器本地处理”徽标及其无用 import；8 个本地卡片和 2 个云服务卡片、路由、分组、CSS 与页脚保持。该轮 Web check、impeccable detector 与文件 diff 检查各一次通过。
- DT-R216 仅重建/替换既有验收栈 gateway：构建退出 0（34.649 秒），up 退出 0；gateway `8c9a1c144cb1` → `fb87c85a2fd3`，API `a2d81fba8fbb`、worker `d97d089a87b3`、PG `a2d63860bea4`、两个网络与端口绑定均保持；仍仅 127.0.0.1:18380，localhost 首页 200，API 沿用 healthcheck healthy。无迁移、seed、真实 Provider 调用或其他栈操作。
- 根真实浏览器验收：目录桌面与 390px 均显示新文案、8 本地/2 云徽标；手机 document 宽和 scrollWidth 均 390，卡片左右 16–374，无水平溢出。视口已恢复。
- 根使用真实 Monaco 和业务 Worker 验收 Schema：`{"changed":true}` 生成的布尔字段 Schema 校验通过（原 R204 同样例被 CSP 阻断）；改成字符串后显示“实例不符合 Schema”且定位 `/changed`；超大整数显示“未执行：数值精度保护”，无假 pass/fail；远程 `$ref` 被明确拒绝；布尔 false Schema 的根问题显示 `$`；随后本地 `$defs`/`$ref` 加 format=email 的非邮箱样本通过，符合 format 仅作注解的公开说明，连续请求可恢复。当前页面 error/warn 控制台为空。
- 实际文档响应 CSP 仍为 `script-src self + wasm-unsafe-eval`、`connect-src self`，没有允许 unsafe-eval；Caddyfile 逐字保持。没有放开远程取数、自定义词汇表、其他方言或数值精度边界。截图和实际退出码均保留在本机轮次目录；保护的原标签未刷新或导航。
- 未提交、push、改版本/tag、生产发布或变更凭据；下方人工事项与既有尾段原样保留。

## DT-R231｜全会话 OCR 审计取舍与四项局部修复（R222–R230）

- 按用户要求，R222 使用 Alibaba Open Code Review CLI 1.0.0 的 delegate 路径，覆盖本会话基线 0101814d6ee3d9ecf98a32ad5c4c031e29e93d50 至当前工作区；HEAD 未新增提交。精确路径集合为 173 项，其中 143 项完成审阅、30 项为 29 个 Playwright 生成物及 api/server 二进制而跳过；根对 coverage/comments 与实际路径集合核对无缺漏。审阅结果已落盘后，主任务在最终摘要阶段连接重试，根停止重试并据完成结果整理 report，不能称原任务自然完成。材料位于 ~/.cache/dev-toolbox-lab/r222-full-session-review。
- 八条原始建议按实际影响取舍：修复 OCR SDK 启动失败挂起、损坏图片无反馈、Schema 数据引用误拒和元数据重开编辑覆盖新值；相关测试缺口并入对应修复。当前 Go/TS 常量一致且已有检查，不为潜在未来漂移增加机制；未展示给用户的内部 OCR 初始阶段状态不作产品缺陷处理。既有已证实的图片选择乱序一起进入同一页面修复，无再次全库审计。
- R225 沿用 pnpm patchedDependencies，为现有 tesseract.js@7.0.0 增加启动错误补丁：load/loadLanguage/initialize 或启动 worker error 都先终止物理 worker，再拒绝启动 Promise；应用层 errorHandler 与既有 lease 配合。版本不升级，无新依赖，既有 Monaco/Hyperjump 补丁保留。新增测试编译实际安装的 SDK 源码，仅替代 worker I/O，覆盖四种启动失败、先终止后拒绝及后续创建/识别成功；不以 mock createWorker 冒充 SDK 覆盖。该候选 OCR 6 文件 55/55、严格 Web check 与 diff 检查通过，私有红对照确认旧 SDK 的挂起/未终止行为。初始探针 unref 导致提前退出的空结果已纠正，不计为通过。范围不包括 worker ready 后在途 recognize 的任意崩溃恢复。
- R227 仅改 OCR 页面与组件测试：图片候选代次覆盖 probe、终止 worker、取消云识别后的异步返回及卸载；资源收尾按 localGeneration 归属，候选被新无效图片取代也会解除已终止识别的 busy；取消收尾不污染新识别。损坏图片或缩放失败显示中文 alert，保留旧图与校对文字，文件输入清空允许同一文件重选；probe 后重查翻译 busy。15/15 组件测试通过、stderr 空；旧逻辑红对照新增五例中四例失败，旧失败不污染这一例在旧逻辑中也通过，不宣称五例均完成 RED。生产文件随后与通过候选逐字恢复一致，diff 检查通过；未改 imageInput.ts。日志 ~/.cache/dev-toolbox-lab/r227-ocr-image-selection-fix。
- R228 仅改 JSON operations 与测试：两遍保守分类区分 Schema、关键字映射和数据位置；没有 Schema 级引用时，const/enum/default/examples 中的 $ref/$dynamicRef 字符串作为普通数据。只要存在 Schema 级引用，继续沿用整树安全拒绝，数据中的 $schema/$id/$vocabulary 资源限制也保留。有效本地引用与数据引用字面量混用仍可能被保守拒绝，页面明确提示该组合暂不支持，不宣称此问题已全面解决。39/39 通过，包括值匹配/不匹配、零 fetch、映射边界、资源污染与混用限制；未引入 URI/anchor 图遍历框架。日志 ~/.cache/dev-toolbox-lab/r228-schema-data-ref-fix。
- R229 仅改 ItemDetailView 与两个直接测试：打开编辑时建立独立快照，保存只 PATCH 相对该快照真正改变的字段；旧保存完成后的详情重载不改新草稿。A 改标题、B 仅改备注时第二笔不回退 A 的标题；B 明确改同字段仍生效，清空备注/标签保留 null/[] 合同。无变化直接关闭，不发空 PATCH，并回焦当前重建的编辑入口。三个相关文件 19/19 通过（元数据生命周期 9、弹窗可访问性 6、补充刷新 4）；后端现有缺失字段保留语义未改。日志 /tmp/r229-metadata-patch-fix。
- R230 统一集成：首次 gateway 构建在严格 vue-tsc 报测试夹具 folder:null 推断过窄（TS2322），29.386 秒后退出 1，未执行 up；记录保留为 report.attempt1.json/build-gateway.attempt1.log。R229 只补对象|null 类型声明，运行时不变，未重复功能测试。修后构建包含 vue-tsc、tsc 与 Vite，20.981 秒退出 0；up --no-deps gateway 1.643 秒退出 0。gateway fb87c85a2fd3 → 777c6ce49ca3，根独立核对 API a2d81fba8fbb、worker d97d089a87b3、PG a2d63860bea4 保持运行，脚本核对两网络/端口不变，入口仍仅 127.0.0.1:18380，首页 200、既有 API healthcheck healthy。未迁移、seed、重启其他服务或调用付费资源。
- 根真实 IAB 验证：本地合成页面截图经真实 Tesseract 识别成功；改入校对文字后连续两次选择同一 corrupt.png 均出现 alert，原图与校对值保持；换回有效图片后清错、清旧校对并恢复识别按钮。尝试的页面级资源阻断未作用于子 worker，Target 自动附加接口不支持，已移除阻断并关闭 Network 观察；因此不把启动失败恢复计作浏览器通过，证据仍为 R225 实际 SDK 测试。没有云 OCR、翻译或 Provider 请求。
- 根真实 Monaco/业务 Worker 验证：const 中远程形式的 $ref 普通数据匹配时通过，不同值报根 const 不匹配；真正远程 Schema 引用拒绝；本地 Schema 引用加数据引用混用显示准确的暂不支持说明；随后普通数据样本可再次通过。未放宽 CSP，当前页 error/warn 日志为空。有效页面截图 dt-r230-corrupt-image-feedback.png 与 dt-r230-schema-data-ref-pass.png 保存在本机可视化目录；未修改知识库真实记录。旧浏览器控制连接本轮不可用，原受保护标签未被刷新或关闭；验收使用新建 IAB 标签。
- 执行继续遵循用户指定的 ZCode GLM-5.3-Flash / 最高 / 完全访问，Fast 未改；R224 已将五个原生角色配置同步到该模型与强度。无提交、push、版本/tag 或正式验收结论变更。下方人工事项与尾段原样保留。

## DT-R232 / R234｜OCR 运行期失败退出、显式重试与新任务归属

- R232 修复真实 tesseract.js@7.0.0 在 ready 后 worker onerror 导致 recognize 永久 pending 的路径：补丁先终止物理 worker，再拒绝并删除全部待决作业；应用只在当前识别归属失败时清掉死亡缓存，等待用户显式重试。保留 R225 启动失败补丁，无版本升级或新依赖。实际安装 SDK 编译测试仅替代 worker I/O，新增在途拒绝、终止先于拒绝、恰好一次终止与新建成功，6/6；既有 lifecycle 12/12。补丁首次应用暴露 pre-image 写成补丁后代码的错误，已恢复 pristine 上下文后成功应用，不把该次失败算作通过。
- 根审拒绝首版 catch 的无条件清理：SDK 异步读图期间取消或换图后，旧 A 的迟到失败可能终止正在识别的新 B。扩展现有组件用例让 B 真正在途，坏候选在 terminate 次数断言出现 expected 1 / received 2（exit1）；将 generation 判断移到资源清理之前后，同一用例验证 B 无新增终止并完成新校对文字，整个 View 18/18、exit0。组件用例使用 deferred 识别 gate；真实 SDK 运行期语义由前述 SDK 测试覆盖。修正阶段仅改 View 与该测试，未重复输入未变的 SDK/lifecycle 检查。日志 ~/.cache/dev-toolbox-lab/r232-ocr-runtime-error。
- R234 本地快速更新仅重建并替换 gateway。复用已审 R230 脚本，仅改任务/日志目录/说明和当前期望 gateway CID；语法检查 exit0。构建包含 vue-tsc、tsc 与 Vite，37.335 秒、exit0；up --no-deps gateway 1.820 秒、exit0。gateway 777c6ce49ca3 → 316a02f4e43a；根独立核对 API a2d81fba8fbb、worker d97d089a87b3、PG a2d63860bea4 运行且未替换，脚本核对两网络与端口不变，入口仍仅 127.0.0.1:18380、静态首页200、既有 API healthcheck healthy。未迁移或 seed。报告 ~/.cache/dev-toolbox-lab/r234-gateway-update/report.json。
- 根真实 IAB 使用同一本机合成目录截图：仅 English 配置先验证识别返回，随后按默认简体中文 + English 重跑混合文字，回填758字符并显示两行低置信度提示；error/warn 日志为空。截图 dt-r234-local-ocr-default-smoke.png 位于本机会话可视化目录。异常退出与迟到失败恢复的证据为 SDK/组件回归，本次浏览器烟测限于正常识别及语言切换重建；没有云 OCR、翻译或 Provider 调用。
- R233 的 Schema 混用引用离线边界调查仍独立进行，R228 的保守限制尚未解除。执行模型保持 GLM-5.3-Flash / 最高 / 完全访问，Fast 未改；无提交、push、版本/tag 或正式验收结论变更，下方待处理与四项人工事项原样保留。

## DT-R233 / R236–R237｜Schema 本地引用与数据字面量的离线兼容

- R233 只读调查确认 scheme-only 候选存在合同缺口：移除取数插件后，数据中的非 # ref 被局部引用激活时仍可命中内置元 Schema 缓存。根拒收该候选，没有放宽 docs/09 的当前文档引用范围。随后用当前实际 SDK 的公开 getSchema/compile/interpret/CompiledSchema AST 与 browser/jref.Reference 做四例内存探针，合法混用匹配/不匹配正确、激活缓存越界与普通缓存越界均拒绝，fetch 0、仓库写入0；未复制 URI/anchor 图或修改 SDK。旧 scheme-only 产物仅为调查证据。
- R236 最终仅改 JSON operations、其测试、Web package 与 lock importer：保留 Schema 位置非 # 声明检查（含未用 defs）及所有 $schema/$id/$vocabulary 资源保护，data ref 字面量可以与本地引用共存；JSON Worker 模块移除默认 http/https/file 取数插件，公开 RetrievalError.cause=UnsupportedUriSchemeError 翻译既有稳定码。编译后按公开 AST 复核实际引用的原词面值，拒绝数据提升为 Schema 后的非 # 引用，含内置缓存命中；内置元 Schema 自身继续由 SDK 处理。编译/解释仍为同一 SDK 公共流程，元校验先于实例精度保护，finally 注册表清理保持。
- 仅补齐已批准且已在运行的 peer @hyperjump/browser@1.6.0 的直接声明；完整 package 与 snapshot 集合逐对象比较相同，392→392，AI worker importer 不变，无新增解析包或升级。私有四文件候选经根全文 diff 审查和 git apply --check 后，全部写入与命令均通过 ZCode 自有 dev-toolbox 2 终端执行；实际文件逐字等于候选。pnpm install --offline --frozen-lockfile --ignore-scripts exit0（已是最新、跳过解析）；operations 定向 41/41、exit0，覆盖合法混用 valid/invalid、真实取数拒绝及0fetch、激活 $ref/$dynamicRef 命中内置缓存仍拒绝和后续恢复，原资源污染、局部递归与精度回归保留。日志 ~/.cache/dev-toolbox-lab/r236-schema-local-reference-fix。
- R237 只重建并替换本地 gateway：构建含 vue-tsc、tsc、Vite，37.623秒 exit0；up --no-deps gateway 2.562秒 exit0，gateway 316a02f4e43a → 5da32b5e4b22。根独立核对 API a2d81fba8fbb、worker d97d089a87b3、PG a2d63860bea4 保持运行且未替换；两网络及端口不变，仅127.0.0.1:18380，静态入口200、既有 API healthcheck healthy。报告 ~/.cache/dev-toolbox-lab/r237-gateway-update/report.json。
- 根在真实 IAB Monaco 与业务 Worker 连续验证：同一 Schema 中 local $defs ref 与 const 数据 $ref 字面量混用通过；不同数据值报 /literal const 不匹配；#/enum/1 激活数据并指向内置缓存元资源时明确拒绝；激活外部地址时显示 SDK 边界取数已禁用；随后恢复原样本再次通过。error/warn 日志为空，截图 dt-r237-schema-mixed-local-ref-pass.png 在本机会话可视化目录。浏览器验证覆盖实际拒绝文案与连续恢复，0fetch 的定量证据为 SDK/单测桩；不宣称任意 JSON Schema 方言或文档外引用支持。
- 原生 R233 在候选阶段实际遇到5小时额度限制（提示18:11:04重置）；根按既有授权经 CUA 的 ZCode 自有终端继续完成局部实施，没有反复请求模型或触发额度升级。GLM-5.3-Flash / 最高 / 完全访问及 Fast 设置保持。未再次全量 OCR、未提交/push、改版本/tag/正式验收，未调用付费云服务、迁移/seed 或变更其他项目；下方人工事项与尾段完整保留。

## DT-R239–R242｜会话文件夹的并发删除保护与重名错误

- R239 仅定向核对 docs/16 §20.3 的归档、置顶、单层文件夹与删除两分支；主核 Web、一个只读子核 API，均结束且未改源码。入口与串行源码核对后，R240 对实际可达的删除竞争和规范化重名错误做真实数据库回归，没有重复全会话 OCR 审计或扩写未来功能。
- 预测与观测区分：首次三项运行 exit1，既有 unfile/active 门禁用例通过；重名 PATCH 实际500，竞争实际 create202/delete500，folder/conversation/runs/messages 全部保留。先前“204并丢数据”的静态推断未被实测支持。追加的一次两项窄诊断中，串行终态会话删除204且完整级联，竞争仍500；本次临时 PG verbose 日志确认40P01，等待环连接删除侧会话行锁与 createRun 的第二次会话行 UPDATE。仅增加子会话锁的首版候选四项中3通过/1失败、exit1，未按完成交付。
- 最终生产仅改 folders.go 与 runs_create.go：文件夹 delete 在既有父锁之后、活跃检查之前按id锁定所属会话；重名23505复用422 VALIDATION_FAILED。创建 Run 保留同一事务和会话行锁，将消息序号推进合入原模型/档位 UPDATE：普通发送+2，retry复用位置+0，移除原先独立的会话 UPDATE；snapshot、模型偏好和提交语义保持。没有新增字段、持久化结构、依赖、弱化父锁或追加重试框架。新增测试仅 v3_folder_management_test.go。
- 最终定向五项全部实际执行并通过，Go exit0、1.298秒：既有 RunIdempotencyAndLifecycle（幂等/停止/重试）、FolderDeleteBehaviors（unfile/active409/missing404）、并发发送/删除（202/409 ASSISTANT_RUN_ALREADY_ACTIVE、新queued Run/4消息/会话与folder保留、next_message_sequence=5）、终态会话串行删除（204且四类数据清零）、规范化重名（422且原名保留，自规范化改名200）。最终 postgres.log 无40P01，仅有重名用例预期23505。真实最终日志 ~/.cache/dev-toolbox-lab/r240-folder-management/logs/2026-10-23T11-41-10-430Z；前述失败与窄诊断日志保留，没有把编译或环境失败算作目标RED。两个生产文件相对本轮私有备份的最小diff经根审，gofmt与限定生产diff检查通过。
- 隔离测试只用新建的临时 PostgreSQL 18、loopback随机端口、覆盖实际PGDATA的tmpfs与合成fixture；迁移仅发生在该全新 *_test 库。每次按实际返回CID清理，未新增持久卷，既有本地验收服务保持；无真实Provider、翻译/OCR或对象存储调用。此前无数据库的编译检查 exit0/[no tests to run] 只记为编译，不计作功能测试。
- R242 本地快速更新只构建并替换 API：更新前逐字节核对旧镜像与工作区10份迁移文件一致；build包含server/migrate/CLI，18.062秒 exit0；up --no-deps api 1.593秒 exit0。API a2d81fba8fbb → 6aa8894b2bf8，gateway 5da32b5e4b22、worker d97d089a87b3、PG a2d63860bea4 保持运行且未替换，两网络与端口不变，仅127.0.0.1:18380。入口200、新API healthcheck healthy，启动窗口仅migration_complete、无migration_started，本轮未应用新迁移或seed。报告 ~/.cache/dev-toolbox-lab/r242-api-update/report.json。
- 更新后根在原IAB验收标签通过实际导航进入知识助手，SYNTHETIC-DT-R112合成文件夹（2/1计数）与最近会话正常加载，error/warn为空；截图 dt-r242-assistant-api-smoke.png 位于本机会话可视化目录。浏览器烟测仅为只读接线，没有发送问题、改写知识记录或执行真实永久删除；删除/冲突语义的证据为前述隔离PG与真实Go HTTP处理器回归。未重跑Web/Worker全量或其他输入未变检查。
- 本轮原生执行已按用户最新要求恢复 GLM-5.3 / 最高 / 完全访问，Fast未改。未提交/push、改版本/tag或正式验收结论；不据此宣称V3完成。下方待处理与四项人工事项原文保持。

## DT-R245–R247｜思考档位动态编辑后的焦点恢复

- R245 局部只读核对与根真实 IAB 复现确认：删除聚焦档位行、把档位移动到排序边界、添加到六档上限时，原按钮卸载或禁用，焦点落到页面根节点，Escape 无法到达弹窗处理器；Tab 可以重新进入，非永久键盘锁死。普通 Tab 首尾循环与关闭后归还触发器原本正常。
- R246 只修改 ProviderSettingsView.vue 和既有 ProviderSettingsView.save-focus.test.ts。沿用 dialogRoot 与行 key，新增时聚焦新行显示名；排序保持原方向有效按钮，边界处聚焦该行输入；删除时聚焦相邻行输入，删空时聚焦添加按钮。未改变布局、样式、API、业务配置或依赖。
- 首轮新增测试因 fixture 作用域错误未到达焦点断言，不计为有效 RED；修正后四个新增用例在旧实现上真实焦点断言失败、三个原用例通过。最终相关 save-focus/keyboard/v3 三份测试 28/28、exit0，vue-tsc exit0；Escape 从实际 activeElement 派发，验证关闭与触发器焦点归还，测试无变更请求。私有日志与 dirty 基线位于 ~/.cache/dev-toolbox-lab/r246-reasoning-focus。
- R247 仅更新本机验收 gateway：构建80.793秒、替换3.766秒，均rc0；gateway 5da32b5e4b22 → c3f269669f5e，API 6aa8894b2bf8、worker d97d089a87b3、PG a2d63860bea4及网络/端口保持，入口首次200、API健康。报告 ~/.cache/dev-toolbox-lab/r247-gateway-update/report.json。
- 根刷新真实 IAB 后验证键盘删除、排序到首行、添加至第六档，焦点均落入有效控件，紧接 Escape 均可关闭并返回编辑模型入口；浏览器 error/warn 为空。所有编辑草稿已取消，没有保存模型配置或调用 Provider。截图 dt-r247-reasoning-focus.png 位于本机会话可视化目录。
- 开发执行为 GLM-5.3 / 最高 / 完全访问，Fast未改；真实40题评测按用户要求暂留人工项。没有提交、推送、生产发布或变更正式验收结论。

## DT-R249｜模型能力状态的明确文字

- 根核对当前模型表格与真实 IAB 无障碍树：原实现用变淡和删除线区分能力标记，但可访问文本只有“工具”“视觉”，无法辨别支持与不支持。初始“仅靠颜色”的描述不完整；本轮依据的是可访问状态缺失。
- 仅改 ProviderSettingsView.vue 两行模板，明确显示“工具：支持/不支持”和“视觉：支持/不支持”。首轮窄屏检查发现旧删除线叠在“不支持”上存在歧义，随后移除该局部 muted 规则的 text-decoration，保留中性色和背景；停用文字也不再带删除线。没有改变模型配置、API、依赖或布局，没有为局部文案新增测试。
- 两个稳定候选分别执行一次本机 gateway 更新，均包含原有构建检查并成功：R249 build53.899秒/up3.284秒，gateway c3f269669f5e→e7a33df1a299；样式修正后的R249b build70.437秒/up8.790秒，gateway→a7f47a8f8361。API6aa8894b2bf8、worker d97d089a87b3、PGa2d63860bea4、网络和端口均保持；入口200、API健康。两轮私有报告位于 ~/.cache/dev-toolbox-lab/r249-gateway-update 与 r249b-gateway-update，未覆盖旧日志。
- 最终真实 IAB 在1280桌面与390窄屏均明确读取“不支持”，页面scrollWidth等于视口宽度；窄屏实际截图确认状态完整可见，computed textDecorationLine为none，error/warn为空，已恢复视口。截图dt-r249-capability-mobile.png位于本机会话可视化目录。未保存业务配置、测试Provider、提交推送或正式发布。

## DT-R251–R254｜全会话审计裁决与局部修复（2026-10-24）

- R251 按用户新要求实际执行 Alibaba Open Code Review v1.13.3 的 delegate preview/rule：本会话基线与当前 HEAD 仍为 0101814d，因此审查 staged/unstaged/untracked 完整工作区。179 个 (path,status) 全部记账，149 个实质文件审查完成，30 个历史生成物/二进制按理由跳过；默认排除中的 88 个实质文件也纳入规则与审读。根独立核对路径与规则无缺漏；审计资料位于 /private/tmp/dev-toolbox-r251-review，不将审查覆盖等同于全量测试通过。
- 三条原始意见保留并由根裁决：LibraryManageDrawer 的确认层 scope 已正确实现，拒绝误报；ItemAIView 在 POST pending 时两个遮罩与应用弹窗 X 仍可关闭，接受 P2；ItemDetailView 测试仅438行现在时注释过时，接受 P3，原意见对441行的指称不准确。R252 只守卫用户关闭入口、禁用 X 并沿用现有禁用反馈，保留版本切换清理与成功自动关闭；另一测试只改一行历史表述。真实 RED 为新增两例失败/旧四例通过，最终 dialog-a11y 与 version-race 共9/9、vue-tsc 均退出0。局部 detector 的两条既有3px侧边框 warning 未扩展修改，本轮没有真实浏览器验收。
- R253 定向确认一条基线既有 API 边界：删除事务持有 folder 行锁时，公开新建 Run(folderId) 阻塞在 conversation INSERT，删除提交后实际500 INTERNAL_ERROR；原 API SQL 的数据库日志为23503，folder/conversation/run/message均无残留。R254 移除测试中的重复 FK 探针及旧 INSERT 固定断言，整理后仍真实复现同一500。生产仅在原事务内的 folder 存在性查询增加 FOR KEY SHARE：保护引用直到事务结束，删除先提交时沿用 ErrNoRows→422 VALIDATION_FAILED，无新增错误码、重试、依赖或 schema。
- R254 最终六项定向 Go 回归全部实际通过、无skip：新建会话/删除交错、Run幂等停止重试、既有文件夹删除两分支、既有会话并发活跃保护、终态级联删除、规范化重名。新交错实际等待在 folder SELECT FOR KEY SHARE，删除提交后返回422；最终 PostgreSQL 日志无23503/40P01，仅有重名用例预期23505。RED/GREEN日志分别为 /private/tmp/dev-toolbox-r253-folder-create-race/logs/2026-10-24T08-16-55-834Z 与 2026-10-24T08-17-30-282Z。测试复用已审隔离runner、本机已有镜像、loopback随机端口和tmpfs；迁移只作用于全新 *_test 库，按本次CID清理，无共享库重置。R255 仅进一步澄清两处注释的“删除先完成”条件并记录本节，运行语句与断言未变，不重复功能检查。
- 主会话实际核实为 Start Plan GLM-5.3 / 最高 / 完全访问，Fast未改；审计子任务的 Start Plan 临时参数与原生“个人套餐”显示存在冲突，实际子请求路由未核实，已在私人报告如实记录，R252起采用已核实主会话串行。原验收栈四个旧容器本轮检查时均已停止，未启动或装载本轮代码；组件与隔离API回归不作为在线页面更新证据。没有提交、推送、改版本/tag、正式发布或真实云调用；真实40题评测仍按用户要求暂留人工事项，下方尾段原样保留。

## DT-R256｜会话移动到未分类及目标删除并发（2026-10-24）

- 根从已确认的文件夹引用竞争定向核对另一个真实消费者：AssistantModuleNav 的“移至未分类”只发送 {folderId:null}。公开 PATCH 的真实 RED 证实原双指针请求字段把显式null当成省略，返回422而非200；目标文件夹先锁定并删除时，移动请求阻塞在旧 UPDATE，随后500，原API的PG日志为23503。会话仍未分类、Run为queued、两条消息保留，没有观察到数据丢失。首轮另一用例的setup查询漏FROM导致42703，已纠正，不计作有效产品RED；完整RED来自后续两例均到达HTTP断言的运行。
- 生产只改 conversations.go：请求中的folderId以标准库json.RawMessage保留省略/null/UUID三态，出现时仅解码一次到局部*uuid.UUID，非法UUID仍422。非null目标的唯一存在性查询在同一事务内移至会话行锁之前并加FOR KEY SHARE，沿用folder→conversation顺序；null不取目标锁。其他title/pin/archive/model逻辑、接口字段、错误码与schema保持，没有新增可空字段框架、重试或外部依赖。
- 既有 v3_folder_management_test.go 只追加两个直接公开HTTP回归：省略保留、null清空且DTO/DB一致、有效UUID移回、数字输入拒绝且不改文件夹；每步保留原Run/messages。删除先锁定并提交的交错验证真实Lock等待、422和会话/Run/messages保持。最终2/2实际通过、无skip；PG23503/40P01均为0。使用同一已审隔离runner，仅运行这两个新增目标，旧Go6项/Web9项不重复。真实RED/GREEN日志分别位于 /private/tmp/dev-toolbox-r253-folder-create-race/logs/2026-10-24T08-49-02-754Z 与 2026-10-24T08-49-59-647Z；临时CID均清理，未触碰共享验收库。
- 本模块为R251审计快照后的定向补充，新增修改的conversations.go按上述实际调用链、根审diff及两项回归核对，不改写R251当时149个实质文件的覆盖记录，也不重复全库审计。执行仍为已核实的Start Plan GLM-5.3/最高/完全访问主会话串行。原验收栈保持停止，本轮未装载服务或进行在线页面验收；未提交、推送、改版本/tag、正式发布或真实云调用，下方人工事项保持。

## DT-R258｜本地验收栈恢复与会话移动页面闭环（2026-10-24）

- 原验收栈四容器正常退出后，本轮保留原数据、配置、Secret及网络，仅启动原PG a2d63860bea4与worker d97d089a87b3，重建替换API 6aa8894b2bf8→4730f9ed678c、gateway a7f47a8f8361→2cd04413bcaa。四服务恢复运行，PG/API/worker均healthy，入口仍仅127.0.0.1:18380。工作区与旧API镜像的10份迁移逐字节一致，数据库版本为10；新API实际启动日志1条migration_complete、0条migration_started，无新增迁移或seed。
- API构建约20秒，gateway构建约21秒、替换约2秒，相关build/up均成功。临时恢复脚本的健康等待变量初始化及SQL失败退出先经根审修正；首段随后在worker启动前因未定界变量紧接中文标点而中止，根同机复现后仅修正3行4处变量边界，从worker阶段完成一次续段，未重复API构建或替换。实际日志位于/private/tmp/dev-toolbox-r258-runtime-restore（700/600），不把中断的原整段脚本说成一次成功。
- 根真实IAB验证既有SYNTHETIC-DT-R112-B会话：从原文件夹移到未分类，刷新后仍在未分类且原4条消息保留；随后移回原文件夹，B计数恢复1、A仍为2，未分类列表为空；本次页面error/warn均为空。截图r258-unfiled-after-reload.png与r258-folder-move-restored.png在上述私有目录。此烟测覆盖真实页面与持久化往返，不替代前述隔离PG并发回归或busy弹窗组件回归。
- 启动前实际只读核对Provider及Embedding各1条，均精确匹配既有本地mock；worker实际命令/只读挂载与仓库fixture一致。没有发送新问答、访问真实Provider/付费资源、重跑全量检查、提交推送或正式发布。真实40题评测仍按用户要求保留，未宣称V3完成；下方已解决事项与四项人工事项保持原文。

## DT-R259｜归档与置顶的实际页面往返验收（2026-10-24）

- 根按docs/16中“置顶只改变排序、归档隐藏于默认历史且可恢复、文件夹计数包含归档”的既有合同，在R258已载入修复的本地四服务验收栈完成页面操作；本轮补充实际菜单操作与持久化证据，未重复既有组件或隔离API检查。既有SYNTHETIC-DT-R112-B会话置顶后刷新仍出现在置顶区，原文件夹B计数保持1。
- 从置顶会话菜单归档后，默认历史与置顶区隐藏该会话；刷新后仍只在已归档列表可见，原4条消息与引用入口保留，文件夹计数仍为1。点击恢复后回到原文件夹并保留置顶属性；随后取消本轮测试置顶，再刷新确认B为未归档、未置顶且仍在原文件夹，A/B计数为2/1，原4条消息完整。本次页面error/warn为空，截图r259-pin-after-reload.png、r259-archived-after-reload.png、r259-restored-original-state.png位于/private/tmp/dev-toolbox-r258-runtime-restore（700/600）。
- 当前归档、恢复、置顶与取消行为正确，无业务代码修改或服务重建。没有发送新问题、创建新Run、永久删除、访问真实Provider/付费资源、提交推送或正式发布；真实40题评测仍保留，不据此宣称V3整体完成。下方人工事项与历史记录保持。

## DT-R263｜Unix Cron 日与星期组合语义修复（2026-10-24）

- 真实问题：时间工具（TimeToolView 约 274 行调用 previewCron，docs/09 §7.5 的 Unix 5 段预览）此前对所有方言统一传 croner `legacyMode:false`，使 Unix 表达式「日」与「星期」同时受限时按 AND 组合，与 Linux crontab(5) 的 OR 语义不符；如 `0 9 1 * MON` 实际预览出 2027-02-01 等「既是 1 日又是周一」的日期，预览不到每月 1 日或每周一。
- 局部行为变化：仅 cron.ts 一处，`legacyMode` 改为按 dialect 选择——unix 为 true（OR），Spring/Quartz 保持既有 false（AND）；字段段数校验、Quartz `?` 与日星期双具体拒绝、暂停预览与 stop、时区与固定 5 次输出逻辑均不变，不迁移弃用选项、不加回退。
- 实际验证：time.test.ts 新增 1 条真实调用生产 previewCron 的回归（unix `0 9 1 * MON`、UTC、基准 2026-08-31T10:00:00Z，断言依次为 2026-09-01/07/14/21/28 的 09:00Z）；旧实现上定向单测一次运行真实 RED（1 failed/17 skipped，预期日期断言失败，非环境失败）。修复后在最终候选各运行一次：time 目录 vitest 4 个文件 30/30 通过 exit 0（含消费方 TimeToolView 两份测试）、`pnpm check` exit 0、限定三路径 `git diff --check` exit 0（docs/19 为未跟踪新文件，git diff 不覆盖其内容）。
- 边界：本修复只改预览展示语义，不新增调度执行器、依赖、服务、接口或 UI 入口；未运行全量测试、生产镜像 build、容器/HTTP/数据库/付费 Provider/备份或发布门禁；未 commit/push、未改版本/tag/正式验收结论。真实 40 题评测按用户 2026-10-24 指示记为待办，见下方人工事项首条。

## DT-R264｜Cron 修复载入本地预览与实际页面复验（2026-10-24）

- R263 源码及测试已审定，沿用其 time 目录 30/30、类型与差异检查结果，不重复测试。旧本地 gateway 2cd04413bcaa 为 09:50 构建的静态产物，没有源码热挂载；R264 原生模型请求 1 秒返回「当前系统繁忙」，未执行工具，随后由 Root 通过 ZCode 本项目专用终端 dev-toolbox 2 完成同一项本地定向更新，未切换模型来源或升级账户。
- 实际更新仅 gateway：使用原项目、test.env 与 override，OrbStack compose build --pull=false gateway 耗时 20.72 秒、up -d --no-deps --pull never gateway 耗时 1.67 秒，退出码均为 0，随后单次本机静态 GET 为 HTTP 200。新 gateway 为 7e80092bbdb5；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份和启动时间均保持原值，3 服务仍 running/healthy；原网络成员与仅 127.0.0.1:18380 绑定不变，未重建或重启其他服务，未操作数据库、Secrets 或配置。
- Root 使用既有 IAB 本地页面实际复验：Unix 0 9 1 * MON、UTC、基准 2026-08-31T10:00:00Z，旧页面给出 2027-02-01 等 AND 日期；更新后刷新同页、重填相同输入，实际五次为 2026-09-01/07/14/21/28 的 09:00 UTC，与 R263 回归一致。页面 error/warn 为空；前后截图 /private/tmp/dev-toolbox-r264-cron-before.png 与 /private/tmp/dev-toolbox-r264-cron-after.png 均为 600，最终预览停留在正确结果页。全部为本地确定性计算，未发送 AI 问答或调用真实 Provider。
- 本轮未改业务源码、测试、依赖或版本；只新增本节交接事实。真实 40 题继续遵循下方「待用户提供数据后执行」待办，不阻塞其他独立产品工作；未 commit/push、生产发布或修改正式验收结论。

## DT-R265｜时间转换输入变化后的结果与在途归属（2026-10-24）

- 真实问题：时间工具「时间转换」页此前只有时区切换的 zoneGeneration 保护；转换完成后仅编辑时间值或输入类型而不重新转换，旧 conversionResult、conversionResolution 与复制入口仍按旧输入展示（Root 在本地 http://localhost:18380/tools/time 以 Unix 秒 0→转换→改值 1 复现，截图 /private/tmp/dev-toolbox-r265-conversion-before.png）；转换开始后再改输入或被新转换取代，旧成功、旧待决夏令时选择与旧错误还会晚到写回。
- 局部变更：仅 TimeToolView.vue 一处——新增转换局部代数 conversionGeneration，由输入值/类型变化 watch 与每次 runConversion 开始推进；成功与 catch 守卫由「zoneGeneration 未变」扩为「zoneGeneration 与转换序号均未变」。输入或类型变化时立即清除旧结果、待决夏令时选择与旧错误反馈，保留输入与焦点、不自动重算、复用既有「转换后在此显示。」空态。不动全局 zoneGeneration 的既有用途、换区 commit 保护、未提交 combobox 草稿、时钟与其他页签；不新增请求框架、Abort 链或更换 Temporal。
- 实际验证：新增 TimeToolView.conversion.test.ts 5 条真实组件 DOM 回归（VTU＋实际 TimeResultCard 与实际 convertTime，deferred 仅控制在途回包）：输入值/类型变化使完成结果失效、旧 DST 待决选择随输入变化移除、旧异步成功与错误在输入变化后被丢弃、新请求仍可成功或显示自身错误。旧实现上新文件一次运行 5 项失败（输出涉及旧结果/旧错误/晚到写回业务断言；该次管道误取 tail 退出码 0，非 vitest 退出码，RED 事实以输出 Tests 5 failed (5) 为准）。修复后最终候选：time 目录 vitest 5 文件 35/35 通过 exit 0（含 R263 既有用例与 zone 保护回归）、`pnpm check` exit 0、impeccable detect（--json）无发现项 exit 0、TimeToolView.vue `git diff --check` exit 0；新测试与 docs/19 未跟踪，git diff 不覆盖，已实际检查无尾随空白；Vue 与逐字节备份 diff 仅上述局部变更四处。首轮 GREEN 曾 1 例失败：首个真实 convertTime 触发 @js-temporal/polyfill 首次动态导入，未在单次 flushPromises 内结算，属测试夹具时序，beforeAll 预热一次真实转换后消除，非修复逻辑问题。
- 边界：本轮只改转换页的结果归属，不涉其他页签、其他工具页、time.ts 精确小数与数值转换算法、依赖或 UI 视觉；源码阶段尚未更新本地静态预览，后续载入与实际页面复验见下条；未运行全量测试、正式发布门禁、数据库管理或真实 Provider/Embedding/云/OSS 调用；未 commit/push/tag、未改版本号或正式验收结论。真实 40 题评测继续按文末待办等待用户提供数据，不阻塞其他独立产品工作。
- 本地载入与实际页面复验（2026-10-25）：Root 审定上述局部差异与最终原始成功回执后，通过 ZCode 专用终端只构建并替换 gateway（build 27.48 秒、up --no-deps 1.97 秒，均 rc=0），单次静态 GET HTTP 200；新 gateway 14645e211c9f，API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间和健康状态保持，原两网络与仅 127.0.0.1:18380 绑定不变。刷新既有 IAB 页面后实际完成：Unix 秒 0 转换后编辑为 1，旧结果与 7 个复制入口清除且输入保留焦点；再次转换得到 1970-01-01T00:00:01Z；切换输入类型清除旧结果；旧夏令时选择与旧错误随输入修改移除。390×844 CSS 窄屏同一编辑流程通过，焦点保留、复制入口为 0、文档宽度 390 无横向溢出，随后恢复默认视口。页面 error/warn 为空。前后截图 /private/tmp/dev-toolbox-r265-conversion-before.png 与 /private/tmp/dev-toolbox-r265-conversion-after.png 均为 600，最终页面保留输入 1 与待转换空态。未修改业务会话数据、未发送 AI 问答或访问真实产品模型。

## DT-R266｜时间页其余表单的结果归属与在途保护（2026-10-25）

- 真实问题：R265 只修复了「时间转换」页签；其余表单完成计算后仅修改输入而不重新执行，旧结果、复制入口与旧错误仍按旧输入展示（Root 在本地 http://localhost:18380/tools/time 逐项复现：工作日起始 2026-10-26 数量 1→2 仍显示 2026-10-27 与复制按钮；Cron 基准 2026-10-26T00:00:00Z 表达式 0 9 * * * → 0 10 * * * 预览仍 9 点；自然语言 明天→后天 仍显示明天的规范表达与复制结果；日期加减 2026-10-26T09:00:00 加 1 日→2 日仍 27 日；时间差 09:00→10 点改 11 点仍 PT1H/3600；前两截图 /private/tmp/dev-toolbox-r266-workday-before.png 与 /private/tmp/dev-toolbox-r266-cron-before.png）。源码上 runCalculation/runDifference/runNatural 仅有时区 zoneGeneration 保护，runWorkday 无任何输入/请求归属；输入已变化或被同一路径新请求取代后，旧成功、旧 DST 与旧错误可能晚到写回。
- 局部变更：仅 TimeToolView.vue 一处——新增 calculationGeneration/differenceGeneration/workdayGeneration/naturalGeneration 四个表单局部代数，与 R265 的 conversionGeneration 同构：由各表单输入变化 watch 与每次运行开始推进，成功与 catch 守卫由「zoneGeneration 未变」扩为「时区代数与本表单序号均未变」；runWorkday 与时区无关，不捕获 zoneGeneration，换区 commit 不影响其有效结果与在途。新增五个输入变化 watch：日期加减起点/加减方向/六个时长字段（calculationValues 为 ref 嵌套对象，深度侦听真实字段输入而非仅对象替换）、时间差任一端、工作日起点/数量/节假日/补班日、Cron 表达式/基准/方言、自然语言表达式，变化时清除各自旧结果、待决夏令时提示/已选 resolution、复制入口与旧错误，保留输入与焦点、不自动重算、复用既有空态与结果区。时间差的结果清理独立于既有含 timeZone 的 watch（该 watch 只清已选 resolution 的职责不变），结果不因 combobox 未提交草稿作废；Cron 预览为同步计算无在途。不动 zoneGeneration/conversionGeneration 既有保护、time.ts/cron.ts 算法、自然语言 grammar、LocalDateTimeField、模板样式与服务；不新增通用请求框架、Abort 链、兼容层或依赖。
- 实际验证：新增 TimeToolView.forms.test.ts 18 条真实组件 DOM 回归（VTU＋实际 time 函数与实际结果组件，deferred 仅控制真实在途返回/失败，beforeAll 预热真实函数避免 Temporal 首次动态导入不在 flushPromises 内结算）：覆盖上述 5 条用户流程、日期加减/时间差的真实夏令时待决提示（America/New_York 2026-03-08）与自然语言 DST 提示随输入变化移除、4 条异步路径在输入变化后的晚到成功/待决状态丢弃与再次运行（工作日另含晚到错误）、以及跨表单输入变化不作废在途时间差、工作日在途结果在换区 commit 后仍写回、时区草稿不清已完成结果三项契约保留。旧实现首次运行退出码 1，15 failed | 3 passed (18)：14 项在旧结果、旧待决选择、旧错误或晚到写回断言失败；1 项（Cron 表达式）先因本地化展示格式的前置断言失败，未到达结果清理断言，该流程有 Root 修前真实页面复现。3 项契约保留用例通过；完整输出 /private/tmp/dev-toolbox-r266-red.log。修复后最终候选：新文件 18/18 通过 exit 0；time 目录 vitest 6 文件 53/53 通过 exit 0（含 R263–R265 既有用例无回归）；`pnpm check` exit 0；impeccable detect（--json）无发现项 exit 0；TimeToolView.vue `git diff --check` exit 0；新测试与 docs19 均未跟踪，实际尾随空白检查无命中；修改前后 Vue 与 docs19 各有 600 权限逐字节备份（/private/tmp/dev-toolbox-r266-TimeToolView.before.vue、/private/tmp/dev-toolbox-r266-docs19.before.md）。首轮 GREEN 曾 1 例失败：Cron 未来执行时间的 zoned 为本地化展示（2026/10/26 GMT+8 09:00:00）而非 Temporal ISO 文本，属测试断言夹具问题，改为时区无关的 09:00:00 断言后消除，非修复逻辑问题。
- 边界：本轮只补齐时间页其余表单的结果归属，不重做 R265 转换页既有保护，不涉其他工具页、依赖或 UI 视觉；源码阶段尚未更新本地 gateway，后续载入与实际页面复验见下条。未运行全量测试、正式发布门禁、数据库管理或真实 Provider/Embedding/云/OSS 调用；未 commit/push/tag、未改版本号或正式验收结论。真实 40 题评测继续按文末待办等待用户提供数据，不阻塞其他独立产品工作。
- 本地载入与实际页面复验（2026-10-25）：Root 核对局部差异、全部原始成功回执后，通过 ZCode 专用终端仅构建并替换 gateway（build 29.21 秒、up --no-deps 1.59 秒，均 rc=0），单次静态 GET HTTP 200；新 gateway 3fe1f953f213，API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间与健康状态保持，原两网络成员关系及仅 127.0.0.1:18380 绑定不变。刷新既有 IAB 页面后，实际完成五条修前流程：工作日数量 1→2 清除旧日期与复制入口，重新计算为 2026-10-28；Cron 9 点→10 点清除旧字段/预览，重新解析显示 2026-10-26T10:00:00.000Z；自然语言明天→后天清除旧解析与复制入口，重新解析为后天；日期加减 1 日→2 日清除旧结果，重算为 2026-10-28T09:00:00Z；时间差结束 10 点→11 点清除旧 PT1H/3600，重算为 PT2H/7200。同页两计算表单互不清理，时区未提交草稿保留时间差，真实 America/New_York 2026-03-08T02:30 夏令时两选项随起点编辑为 12:00 移除；工作日结果在换区后保留。390×844 CSS 窄屏复验工作日编辑：值 2 与焦点保留，复制入口 0、空态可见，文档宽度 390 无横向溢出，随后恢复默认视口。浏览器 error/warn 为空；最终实际页面截图 /private/tmp/dev-toolbox-r266-workday-after.png（600），修前截图同节所列。未修改业务会话数据、未发送 AI 问答或访问真实产品模型。

## DT-R267｜持久引用来源每次打开重新确认当前状态（2026-10-25）

- 真实问题：assistantStore 的 persistentSources 在 Pinia 生命周期内无限缓存，applyPersistentStream 随 SSE 快照写入、getSource 命中缓存即返回，完全绕过服务端。这违反 docs/16 §13.5（来源详情返回当前/快照标题与已删除状态）与 §14（GET /assistant/runs/{id}/sources/{citationNumber} 对被 retry 取代的旧 Run 返回 NOT_FOUND）：笔记改名后重新打开来源抽屉无法更新当前标题提示；来源删除后仍显示旧摘录与原笔记入口；被重试取代的旧 Run 引用仍绕过服务端有效性判定。临时来源按 messageId 从 temporaryMessages.sources 读取是正确合同，保持不变。
- 局部变更：仅 assistantStore.ts 三处——删除 persistentSources reactive 声明；删除 applyPersistentStream 内把 state.sources 写入缓存的循环（PersistentStreamState 的 SSE 快照形状不动）；getSource 持久分支删除缓存读写，改为每次打开/重试直连既有 client().getSource(runId, citationNumber)，标题更新、unavailable（摘录/定位为空）与旧 Run NOT_FOUND 一律由服务端实时判定，抽屉沿用既有加载/错误/重试。临时分支逐字保留。assistantStore.test.ts 仅追加 ApiError import 与三条用例，复用既有 createApi/sourceFixtures，未新建平行工厂；不新增缓存 TTL、失效事件、刷新按钮、请求包装、轮询或依赖。
- 实际验证：新增 3 条真实 Pinia 业务回归，同一 runId/citationNumber 第一次 available 后第二次分别断言返回 DTO 的 currentTitle 更新（「已重命名的数据目录」）、来源 unavailable 且 excerpt/locator/currentTitle 为 null、以及旧 Run 404（ApiError NOT_FOUND）必须 rejects 而非返回首份缓存 DTO。旧代码一次运行 rc=1：3 failed | 87 passed (90)，三条新用例全部失败于缓存回放；完整输出 /private/tmp/dev-toolbox-r267-red.log（600）。首次源码候选各运行一次：`pnpm --dir apps/web test src/modules/assistant` rc=0，15 文件 90/90 通过（含既有临时来源用例与全部既有回归无回归）；`pnpm --dir apps/web check` rc=0（vue-tsc＋tsc）；两源码 `git diff --check` rc=0；日志 /private/tmp/dev-toolbox-r267-green.log 与 /private/tmp/dev-toolbox-r267-check.log（600）。夹具收口：真实 404 为 code NOT_FOUND、message 资源不存在（apps/api/internal/assistant/errors.go），测试 ApiError 夹具由虚构 RUN_NOT_FOUND/专用文案同步更正为 NOT_FOUND/资源不存在并保持断言原错误对象直接抛出，仅重跑本文件 15 条与 `pnpm check` 均 rc=0（/private/tmp/dev-toolbox-r267-fixture-test.log、/private/tmp/dev-toolbox-r267-fixture-check.log，600），未重跑旧 RED 或模块其他 75 条。
- 边界：不动 SSE 协议/Parser、索引、发送/会话归属、API/DB/后端、Vue 模板/样式/抽屉组件；源码阶段未进行 Docker/HTTP/DB/浏览器操作；本轮未访问真实 Provider/Embedding/云/OSS/备份或其他付费资源；未 commit/push/tag、未改版本号或正式验收结论。源码阶段的编译页面尚未更新；后续本地载入与实际 UI 合成响应重放见下条。真实 40 题评测继续按文末待办等待用户提供数据，不阻塞其他独立产品工作。本轮 docs 写入仅本文件本节一处，按时间线插于 R266 后、待处理前；其余历史（含 R79 审计范围、文末用户事项与 40 题待办）逐字未动；修改前 assistantStore.ts、assistantStore.test.ts 与 docs19 均有 600 权限逐字节备份（/private/tmp/dev-toolbox-r267-assistantStore.before.ts、/private/tmp/dev-toolbox-r267-assistantStore.test.before.ts、/private/tmp/dev-toolbox-r267-docs19.before.md），删除本节即与备份全文逐字节相等；本节写入即释放 docs19 owner。
- 本地载入与实际页面重放（2026-10-25）：Root 审定三处生产差异、测试增量与全部原始回执后，通过 ZCode 专用终端仅构建并替换 gateway（build 26.78 秒、up --no-deps 1.56 秒，均 rc=0），单次静态 GET HTTP 200；新 gateway 05f8b704ac5f，API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间与健康状态不变，两网络成员关系及仅 127.0.0.1:18380 绑定保持。在独立本地 IAB 标签页，以既有合成 B 会话的引用 3 为入口，仅对该来源 GET 使用合成响应：修前同一引用两次打开只读取一次，旧摘录和原笔记入口仍在；修后两次打开均发起新读取，第二次 unavailable 响应使旧摘录与入口移除，显示来源已删除。再重放 NOT_FOUND/资源不存在 的 404→显式重试→200，错误态无旧摘录/入口，重试返回的当前标题变更提示正确。删除态在 390×844 CSS 窄屏占满 390 且文档无横向溢出，Tab 圈闭、Escape 回到原引用通过，视口随后恢复默认。临时响应拦截均已清除；未修改或删除真实笔记，未发出产品 AI 问答，合成响应不证明真实删除或真实模型质量。修前/修后截图 /private/tmp/dev-toolbox-r267-citation-before.png 与 /private/tmp/dev-toolbox-r267-citation-after.png 均为 600。该重试重放另确认 CitationDrawer 在按钮被 loading 移除后焦点落到 BODY、成功后仍在抽屉外，已交由新会话 DT-R268 独立修复，不混入本轮取源刷新改动。

## DT-R268｜来源抽屉重试期间保持键盘焦点（2026-10-25）

- 真实问题：R267 实际页面合成来源响应重放确认，来源抽屉错误态的「重试」按钮按 Enter 后被 loading 分支移除，焦点落到 BODY，成功返回后仍在抽屉外，违反既有抽屉焦点合同。该问题独立于 R267 的来源刷新逻辑。
- 局部变更：CitationDrawer.vue 新增 onRetry()，先同步聚焦已有稳定关闭按钮，再 emit('retry')，并将错误态按钮 click 绑定到该函数；不新增 watcher、异步焦点流程、样式或 Store 改动。AssistantInteraction.test.ts 仅新增 1 条真实挂载 DOM 回归，覆盖重试按钮获得焦点并触发、loading 卸载按钮后焦点仍在关闭按钮、实际来源成功返回后仍在抽屉、Escape 关闭后恢复原引用触发器，并断言 retry 仅发出一次。
- 实际验证：旧实现 RED 为 1 failed | 3 passed (4)，rc=1，失败位于 loading 焦点断言；稳定候选的 AssistantInteraction 与 AssistantView 两测试文件 6/6 通过，rc=0；pnpm --dir apps/web check（vue-tsc＋tsc）rc=0；目标组件 impeccable detect 输出 []、rc=0；两源码 git diff --check rc=0。Root 核对实际差异与原始回执；日志 /private/tmp/dev-toolbox-r268-{context,red,final-tests,check,detect,diffcheck}.log 均为 600；修改前两个源码文件备份 /private/tmp/dev-toolbox-r268-CitationDrawer.before.vue 与 /private/tmp/dev-toolbox-r268-AssistantInteraction.test.before.ts 均为 600。未重复运行未变化的 R267 模块回归。
- 本地载入与实际页面复验：Root 通过 ZCode 专用终端仅构建并替换 gateway（build 23.07 秒、up --no-deps 1.59 秒，均 rc=0），单次静态 GET HTTP 200；新 gateway da2fb33c6cb8，API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间、健康状态及原网络成员关系保持，仅 127.0.0.1:18380 绑定不变。刷新既有 IAB 页面后，在默认 1280×720 与 390×844 CSS 窄屏分别重放来源 3 的 NOT_FOUND/资源不存在 404→键盘 Enter 重试→200 当前标题更新：每次两次来源 GET，loading 期间与成功后焦点均保持在抽屉关闭按钮，Escape 恢复原引用 3；窄屏抽屉与文档宽度均为 390，无横向溢出。实际 loading 截图 /private/tmp/dev-toolbox-r268-retry-loading.png（600）可见关闭按钮焦点环。临时响应拦截全部清除，默认视口恢复，重新读取真实来源 3 后原笔记入口与真实摘录恢复；已关闭无草稿的旧 Root 自建标签页，保留当前验收页，浏览器 warn/error 实际为空。
- 边界：上述 HTTP 响应为定向合成重放，不证明真实删除或真实模型质量；未修改/删除真实笔记，未发送产品 AI 问答，未访问真实 Provider/Embedding/云/OSS 或其他付费资源，未 commit/push/tag、未改版本号或正式验收结论。仅本节插入，之前全部历史与用户待办逐字保留；文档修改前独占备份 /private/tmp/dev-toolbox-r268-docs19.before.md（600）。

## DT-R269｜持久回答重试与停止的响应归属（2026-10-25）

- 真实问题：send/history 已有上下文保护，retryLastAnswer 与 stopActiveRun 却未按相同归属处理迟到响应。旧重试成功会抢回已切走的会话、混入消息并接管观察，旧重试/停止失败会在新上下文冒错，旧停止成功还会中止另一会话的观察；停止更新只匹配 outputMessageId，会覆盖同一助手位置上已替代它的新 retry Run。Root 在修前本地页面分别拦截重试与停止 POST、切到新对话后再返回 404 NOT_FOUND/资源不存在，实际均在新对话的导航及 composer 显示旧错误；这两条 POST 未到后端，停止路径的 SSE GET 也仅在浏览器内拦截。
- 局部变更：仅 assistantStore.ts 的 retryLastAnswer、stopActiveRun 与既有 updateRunInMessages 三处（相对本轮开工备份 +52/-10）。重试复用 sending、contextSeq/viewAlive 与目标会话归属，阻止在途重复点击；切走/销毁后的旧成功不抢回页面，失败不跨上下文显示；A→B→A 可接纳，历史读取在途时按 sequence 合入响应中的原用户消息及新助手占位，同一新 Run 已由历史/SSE 推进时不以迟到空快照覆写正文或重启观察。停止更新校验 currentRun.id，停止观察仅作用于仍在观察的同一 Run；失败必须同时属于原上下文与当前活动 Run，既不把旧错误冒给替代 Run，也保留同 Run 真实停止失败。Root 逐字比较确认 send/history、SSE、来源读取与临时路径等其余代码未改；无 Vue 模板/样式、API、DB、依赖或新请求层变更。
- 实际回归：现有 pendingSend.test.ts 追加 13 条有效 case，原 8 条及原 deferred/createApi 工厂逐字保留；真实 Pinia、deferred API 与真实 AbortSignal 挂起流覆盖切换/销毁、回切接纳、正文保留、占位与原问题、重复请求、B 观察及同位置替代 Run、正常停止/真实失败。初轮有效 RED rc=1：10 failed / 92 passed (102)；首轮源码候选助手模块 15 文件 102/102、rc=0。最初一次测试启动因 umask 177 导致 Vitest mkdir EACCES、0 测试，恢复默认权限后才取得上述有效 RED，该无效启动不计业务回归。Root 审阅补缺：同一 A 内旧 stop 失败仍污染替代 Run，以及回切历史在途缺少已返回的原用户消息；在首轮候选上补断言的 followup RED rc=1：2 failed / 19 passed (21)，分别精确失败于只有 assistant 而缺 user、以及旧停止失败不为空。最终仅重跑受影响文件 21/21、rc=0，pnpm --dir apps/web check（vue-tsc＋tsc）及两文件 diff --check 均 rc=0；其余 83 条未重复运行，不声称最终全模块 104 条已实跑。Root 已核对原始命令卡片的直接 rc、日志全部失败断言与汇总；初轮 /private/tmp/dev-toolbox-r269-{red,green,check,diffcheck}.log、收口 /private/tmp/dev-toolbox-r269-followup-{red,green,check,diffcheck}.log 均为 600；两源码开工逐字备份 /private/tmp/dev-toolbox-r269-assistantStore.before.ts 与 /private/tmp/dev-toolbox-r269-assistantStore.pendingSend.test.before.ts 均为 600，新增测试无行尾空白。
- 本地载入：Root 审定稳定源码后通过 ZCode 专用终端仅构建并替换 gateway（build 40.40 秒、up --no-deps 2.17 秒，均 rc=0），单次静态 GET HTTP 200；新 gateway 0ce886947356，API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间与健康状态保持，原网络成员关系及仅 127.0.0.1:18380 绑定不变。源码冻结后未重复测试/构建。
- 实际页面复验：刷新既有 IAB 本地页面，在 1280×720 桌面分别重放两条修前路径，每条有效重放均只拦截 1 个 POST 并返回上述合成 404。重试在途切新对话、编辑 17 字未发送草稿后，旧错误不出现，草稿保留且发送恢复可用；停止在途切新对话后，旧错误同样不出现。全部临时拦截清除、验证草稿清空、真实 B 会话 4 条消息及验收模型/低档位恢复，浏览器 warn/error 实际为空；当前预览页保留。本轮未修改布局，未另做 390 CSS 或物理移动端验收。截图 /private/tmp/dev-toolbox-r269-retry-before.png、/private/tmp/dev-toolbox-r269-retry-after.png、/private/tmp/dev-toolbox-r269-stop-before.png、/private/tmp/dev-toolbox-r269-stop-after.png 均为 600；重试修后截图可核对新对话、草稿、可用发送及无旧错误。
- 执行与边界：按用户本轮明确指示，ZCode 本会话实际切换并核实 BigModel 标准 GLM-5.3、最高思考、完全访问；单主实施，无子任务，全局分配上限保持不超过 9。合成 HTTP 重放不证明真实后端停止/重试、真实 Provider 取消或答案质量；未发出产品 AI 问答、未写入新消息/删除真实数据，未访问真实 Provider/Embedding/云/OSS 或其他付费产品资源，未 commit/push/tag、未改版本号或正式验收结论。仅插入本节，之前历史与用户待办逐字保留；文档修改前独占备份 /private/tmp/dev-toolbox-r269-docs19.before.md（600）。

## DT-R270｜回答复制反馈随当前正文失效（2026-10-25）

- 真实问题：AssistantThread 按 message.id 复用回答组件，流式生成和重试会替换同一组件的正文。原 copyAnswer 在剪贴板 Promise 完成后无条件显示成功/失败，且多个 1600ms timer 未互相替换；因此新正文会承接旧反馈，第二次复制也会被第一次 timer 提前清除。Root 在旧编译页面实际复制合成回答 A，再通过同一消息的 SSE snapshot 更新为 B，B 仍显示“已复制”（修前截图见下）。
- 局部变更：仅 AssistantMessage.vue 的 script 与现有 AssistantMessage.test.ts；生产 +26/-7、测试 +149/-2。沿用现有共享 CopyButton 的当前文本归属模式：computed copyText 复用原已识别 [[C数字]] 去除循环，watch 实际复制文本清反馈和旧 timer，await 的成功/失败分支只更新仍匹配当前文本的结果，有效结果替换 1600ms timer，卸载清理 timer。不增加身份序号、Run 状态或公共框架。Root 逐字节确认整个模板/样式、openCitation/statusText 及原有引用归属/已知与未知标记用例未变。
- 必要验证：新增 4 条真实 VTU 回归，覆盖成功与失败反馈随内容失效、A→B 成功与 B→C 失败迟到时忽略且当前 C 可复制、原始正文不变但引用成员变化导致实际复制文本变化、连续同文复制保持后一次完整反馈窗口。旧实现一次 RED 为 4 failed | 1 passed (5)，RED_RC=1；稳定候选一次 GREEN 为 5/5，GREEN_RC=0。pnpm check（vue-tsc＋tsc）、仅目标 Vue 的 impeccable detector（[]）、两文件 git diff --check 均 rc=0。Root 已读全部实际日志及展开的原始终端返回码；日志 /private/tmp/dev-toolbox-r270-{red,green,check,detector,diffcheck}.log 均为 600。两目标独占备份 /private/tmp/dev-toolbox-r270-AssistantMessage.before.vue、/private/tmp/dev-toolbox-r270-AssistantMessage.test.before.ts（600）；源码冻结后不重复检查。
- 本地载入：Root 通过 ZCode 自有 dev-toolbox 2 终端只构建并替换 gateway，build 21.57 秒、up --no-deps 1.78 秒均 rc=0，单次静态 GET HTTP 200。新 gateway f7a2c2467c8a；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间与健康状态保持，原网络成员关系及仅 127.0.0.1:18380 绑定保持。更新控制进程 73682 已自然结束；build/up 日志 /private/tmp/dev-toolbox-r270-gateway-{build,up}.log 为 600。
- 实际页面复验：1280×720 既有 IAB 页面刷新后重放同一合成 GET→SSE 路径。实际复制 A 成功且剪贴板文本匹配，持有的单个 SSE GET 返回同一消息的 B snapshot 后，在原 1600ms 窗口内旧反馈消失、按钮恢复“复制”、title/aria-label 恢复且焦点保留；随后真实 Enter 复制 B，剪贴板内容匹配当前 B。修前 /private/tmp/dev-toolbox-r270-copy-before.png、修后 ...-copy-after.png、当前 B 键盘复制 ...-copy-current.png 均为 600。全部临时拦截清除，原 B 会话 4 条消息、空草稿与验收模型/低档位恢复，浏览器 warn/error=[]，剪贴板在内存保留后恢复，预览页保留。本轮未改布局，未另作窄屏或物理移动端验收。
- 执行与边界：fresh ZCode 会话实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问；单主实施、无子任务，全局并行分配保持不超过 9。浏览器合成响应只验证前端交互，不代表真实 Provider 回答/取消或答案质量；没有产品 AI POST、直接数据库操作、真实 Provider/Embedding/云/OSS/付费资源访问或正式发布，未 commit/push/tag、未改版本或正式验收结论。仅插入本节，既有历史和用户待办逐字保留；修改前独占备份 /private/tmp/dev-toolbox-r270-docs19.before.md（600）。真实 40 题评测继续等待用户提供数据，不阻塞其他独立产品迭代。

## DT-R271｜代码块复制反馈保持正文节点与焦点（2026-10-25）

- 真实问题：AssistantMarkdown 的 fence HTML 原本直接读取复制成功/失败状态，反馈变化便重设整个 v-html；读者 Tab 到 PRE/链接后反馈到期会丢焦，CitationDrawer 保存的引用 opener 也会被拆掉。Root 在旧本地编译页面实际 Enter 复制→Tab 到 PRE→等待反馈到期，焦点丢失；再复制→Enter 打开引用→等待到期→Escape 关闭来源，未返回原引用。代码复制内容本身精确（含末尾换行）。旧 await 结果还会写到被替换的同序号代码块，多个旧 timer 会提前清掉后一次反馈。
- 局部变更：仅 AssistantMarkdown.vue 的 script 与现有 AssistantMarkdown.test.ts，相对本轮独占备份生产 +44/-9、测试 +193/-0。将复制反馈从 rendered.html 的依赖中移出，保留既有 v-html、安全 renderer 与事件委托；fence 默认按钮文字不变，局部 flush-post watcher 仅用 textContent 更新本组件生成的复制按钮，不因反馈重建正文节点。反馈保存所属代码文本，代码变化/消失时清状态与 timer；await 后比较当前同 index 的代码文本，忽略迟到成功/失败；同文正文追加继续保留有效反馈；成功反馈复用单 timer 的完整 1600ms，失败维持显式重试语义，卸载清 timer。Root 逐字节确认模板/CSS、安全文本与链接 renderer、fence HTML 除默认反馈标签外、wrap 分支和既有焦点 helper、原 3 个测试用例正文断言均未改。
- 必要验证：新增 4 条真实组件用例，覆盖 PRE/链接原节点和焦点保持、真实 Markdown＋CitationDrawer host 的引用返回、A→B 旧成功与 B→C 旧失败忽略及当前 C 精确重试、普通正文追加/代码替换或删除/连续复制窗口。旧实现一次 RED_RC=1，4 failed | 3 passed (7)，失败点分别是节点断开、opener 断开、迟到成功污染新代码、旧 timer 提前清反馈。首个修后运行 GREEN_RC=1（5/7），两处测试装置有误：VTU trigger 不赋焦，引用打开前补 opener.focus；sr-only 的实际成功文案“代码块已精确复制”被误断言为“已复制”子串，改为原精确文案。生产此后未变，最终 GREEN_RC=0、7/7；pnpm check（vue-tsc＋tsc）、仅目标 Vue 的 detector（[]）均 rc=0。原生 DIFFCHECK_RC=0 仅为 diff 展示退出码，Root 更新前实际补跑两文件 git diff --check，ROOT GIT_DIFFCHECK_RC=0，追加进既有 diffcheck.log。Root 已读原始终端两轮返回码及全部相关日志；/private/tmp/dev-toolbox-r271-{red,green,check,detector,diffcheck}.log 均为 600。
- 本地载入：Root 通过 ZCode 自有 dev-toolbox 2 终端只构建并替换 gateway；build 19.61 秒、up --no-deps 1.65 秒均 rc=0，单次静态 GET HTTP 200。新 gateway b31ea8ad8409，API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间、健康状态保持，原网络成员关系与仅 127.0.0.1:18380 绑定不变。更新控制进程 85043 已自然结束，gateway build/up 日志为 600；源码冻结后未重复测试/构建。
- 实际页面复验：刷新 1280×720 既有 IAB 页面，以明确标注 DT-R271 合成内容的单次历史 GET 响应重放同样两条键盘路径；引用来源读取仍使用已有本地 GET。修后 PRE 在复制反馈消失后保持焦点，抽屉内关闭按钮在到期期间不被抢焦，Escape 关闭后返回原引用，代码复制仍精确。修前 /private/tmp/dev-toolbox-r271-pre-before.png 与 citation-before.png、修后 pre-after.png 与 citation-after.png 均为同前缀的 600 截图。临时历史响应拦截全部清除，原 B 会话 4 条消息、空草稿、验收模型/低档位恢复，来源抽屉关闭，剪贴板私下保留后恢复，浏览器 warn/error=[]，预览保留。未打开示例外链或执行代码，未另作窄屏或物理移动端验收；本文仅验证反馈自身变化的节点稳定，不改源正文更新时原有渲染方式。
- 执行与边界：fresh ZCode 会话实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，单主无子任务，全局并行分配不超过 9；实际会话自动标题为“AssistantMarkdown 代码块复制反馈节点归属验证”。没有产品 AI POST、真实 Provider/Embedding/云/OSS/付费资源调用或直接数据库操作，未 commit/push/tag、未改版本号或正式验收结论。两目标修改前独占 600 备份为 /private/tmp/dev-toolbox-r271-AssistantMarkdown.before.vue 与 -AssistantMarkdown.test.before.ts。本节由 Root 单独写入，文档独占备份 /private/tmp/dev-toolbox-r271-docs19.before.md（600）；此前历史与用户待办逐字保留，真实 40 题继续等待用户提供数据，不阻塞其他独立产品迭代。

## DT-R272｜命令填写弹窗键盘操作与复制反馈归属（2026-10-25）

- 真实问题：ArtifactBlocks 的 command 与 command_steps 共用填写弹窗，原实现没有初始输入聚焦、双向 Tab 循环和关闭返焦，Escape 还会关闭正在输入法组合的弹窗；填写复制的 await 结果可关闭后来重开的弹窗或把旧错误带给新输入。直接复制失败后的旧错误也未在填写复制成功时清除，多个 1600ms timer 会提前结束后一次反馈。Root 在旧编译页面实际验证初始聚焦、双向 Tab、Escape 返焦和成功返焦五项失败，复制文本本身精确。
- 局部变更：仅 ArtifactBlocks.vue 与现有 ArtifactBlocks.test.ts；相对本轮独占备份生产 +86/-18、测试 +288/-0。两个命令入口同步保存 event.currentTarget；本地 nextTick 聚焦首个输入，Tab 限于当前弹窗，Escape 避开 isComposing/keyCode 229，关闭与成功后只在没有新弹窗且原按钮仍连接时返焦。填写复制捕获实际响应式状态与当前预览，迟到结果只作用于仍属于同一输入的弹窗；共用复制成功处理清旧错误并替换单个 timer，卸载使在途填写复制与焦点续程失效。Root 确认整段 CSS、除三处必要绑定外的模板、占位符识别/替换、安全渲染及原 6 条用例正文均逐字保留；未增加公共弹窗、请求序号或跨版本状态机制。
- 必要验证：新增 4 条 VTU 回归覆盖键盘/IME/返焦、取消重开或编辑后的迟到结果、旧复制错误不复现和连续复制完整反馈窗口。首轮旧实现 RED_RC=1、4 failed | 6 passed；其中旧错误用例误选 SafeMarkdown 内部 status，修正为直接子 status 后、生产未变，再次 RED_RC=1、4 failed | 6 passed，失败落在真实缺陷。首个生产候选 GREEN_RC=1、1 failed | 9 passed，初始聚焦发现原对象与 Vue Proxy 身份比较错误；仅改为传入 fillState.value 后最终 GREEN_RC=0、10/10，1.19 秒。pnpm check（vue-tsc＋tsc）与实际两文件 git diff --check 均 rc=0；detector rc=2、两条 border-left 既有样式 warning，Root 已核对备份与整个 style 字节不变，未把它记为零警告通过。Root 已读原始工具命令、返回码与实际日志；/private/tmp/dev-toolbox-r272-{red,green,check,detector,diffcheck,context}.log 与两目标 before 备份均为 600。
- 本地载入：Root 在 ZCode 自有 dev-toolbox 2 终端只构建并替换 gateway，build 31.01 秒、up --no-deps 1.62 秒均 rc=0，单次静态 GET HTTP 200。新 gateway 52a76ffb91e8；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 身份、启动时间与健康状态保持，原网络成员关系和仅 127.0.0.1:18380 绑定保持。控制进程 14459 自然结束，gateway build/up 日志为 600；构建保留已有大 chunk 提示，未扩展优化范围。
- 实际页面复验：刷新既有 1280×720 IAB 页面，仅对现有合成普通笔记的 Artifact 列表/详情 GET 返回明确标注 DT-R272 的临时合成 command＋code 内容，不创建或激活 Artifact。重放 Enter 打开、Shift+Tab 首尾反向循环、Tab 正向循环、Escape 关闭并返焦，再实际输入并 Enter 复制：修后五项焦点合同均通过，剪贴板命令精确、弹窗关闭、原复制按钮聚焦。修前 /private/tmp/dev-toolbox-r272-fill-initial-before.png 与 -fill-return-before.png、修后 -fill-initial-after.png 与 -fill-return-after.png 均为 600；两张修后图已实际查看。最后回到原始记录标签卸载合成内容，全部临时拦截清除，剪贴板私下保留后恢复，浏览器 warn/error=[]，预览保留。IME 与 Promise 乱序依据组件回归，未伪造浏览器 IME 或剪贴板 Promise；本轮未改布局，未另作窄屏或物理移动端验收。
- 执行与边界：fresh ZCode 会话实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，单主无子任务，全局并行分配不超过 9；实际会话标题“R272 修复返焦回归测试与实现”。没有产品 AI POST、真实 Provider/Embedding/云/OSS/付费资源调用、直接数据库操作、产品内命令执行或示例外链访问，未 commit/push/tag、未改版本号或正式验收结论。Root 单独插入本节，修改前独占备份 /private/tmp/dev-toolbox-r272-docs19.before.md（600），此前历史和用户待办逐字保留；真实 40 题继续等待用户提供数据，不阻塞其他独立产品迭代。

## DT-R273｜原始记录复制反馈归属与完整提示窗口（2026-10-25）

- 真实问题：ItemDetailView 的 copyAll 原本在剪贴板 Promise 完成后无条件修改 copied/copyError，切换原始记录或重载详情只复位 bool、不清旧 timer。因此 A 的迟到成功/失败会出现在 B 上，同记录连续复制或 A→B 复制也会被前一次 1600ms timer 提前清掉。Root 在旧编译页面实际复制合成原文 A、切到 B 并复制，B 在自身反馈窗口内已恢复“复制全部原文”；问题是反馈归属，不是原文错写、丢失或安全泄漏。
- 局部变更：仅 ItemDetailView.vue 与现有 ItemDetailView.raw-race.test.ts，相对本轮独占备份生产 +25/-6、测试 +146/-0。copyAll 捕获 rawRecord.value 的实际响应式对象与精确 body，await 后的成功与失败均比较当前记录同一性，切换/重载后的迟到结果丢弃；有效成功替换唯一 copyTimer，clearCopyFeedback 在记录切换、详情重载与卸载时清当前 timer 和两个反馈状态。保留空 body 复制、原成功/失败文案、1600ms、手动重试和焦点。Root 确认整个模板/CSS、原 5 条用例正文及全部 10 个既有 helper 逐字保留，未改原文揭示、敏感确认、Abort 请求、元数据或 RawDocument，未新增 epoch、公共框架或依赖。
- 必要验证：新增 4 条公开 DOM/VTU 回归，覆盖跨 A→B 的迟到成功与失败、B 当前正文精确可复制、同记录第二次复制完整 1600ms、A 旧 timer 不清 B 提示。首次运行因 umask 177 泄漏至 Vitest 临时目录而 EACCES、无测试执行，不计为产品 RED；修正为单独创建 600 日志、正常 umask 运行后，生产仍与备份一致，真实 RED_RC=1、4 failed | 5 passed (9)。生产一次候选 GREEN_RC=0、9/9，1.87 秒。pnpm check 的 vue-tsc＋tsc rc=0；原生因 stdout 日志为空补 stderr 重跑记录，候选未变。目标 detector 前两次路径不可访问，改绝对路径后 rc=0、[]。原生 git diff --check 返回 0，Root 更新前再以 git -C 明确仓库根执行目标检查，ROOT_GIT_DIFFCHECK_RC=0；测试文件仍为既有未跟踪文件，Git 不检查它，Root 已单独核对两文件当前字节无尾随空白和旧测试保留。相关最终日志 /private/tmp/dev-toolbox-r273-{red,green,check,detector,diffcheck,context}.log 为 600；原始装置失败与关键返回码保留于 ZCode 工具历史，没有把装置失败当产品红或宣称所有检查一次通过。
- 本地载入：Root 经 ZCode 自有 dev-toolbox 2 终端只构建和替换 gateway，build 24.22 秒、up --no-deps 1.69 秒均 rc=0，单次静态 GET HTTP 200。新 gateway 46372230d542；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间和健康状态保持，原网络成员与仅 127.0.0.1:18380 绑定保持。控制进程 35773 自然结束，gateway build/up 日志为 600；源码冻结后未重复目标测试或构建。
- 实际页面复验：1280×720 既有 IAB 中，仅为现有普通合成条目的详情 GET 和两个合成 raw-record GET 返回明确标记 DT-R273 的临时内容，无数据写入。首次以 reload 触发重放未命中拦截，改用页面已有条目链接切换后完成修前路径；修后首次重放确认 A/B 精确复制与焦点，随后将计时基准收紧到已可见的 A 成功提示，并保证 B 在旧窗口结束前复制成功。在 A 成功提示后 1763ms、B 按键后 725ms，A 的旧窗口已过而 B 的自身窗口仍在，B 保持“已复制全部”与焦点，A/B 剪贴板内容均精确（含末尾换行）。原始修前结果变量保存失败，但已实际生成并查看修前截图、完成清理，没有为取回数字重跑修前流程；不引用丢失的精确修前时值。截图 /private/tmp/dev-toolbox-r273-raw-copy-before.png、-raw-copy-after.png、-raw-copy-after-timed.png 均为 600，计时图与已查看的修后图字节一致。最终清除全部拦截，回到原条目的原始记录标签、按需读取状态，合成内容卸载，剪贴板私下保留后恢复，浏览器 warn/error=[]，预览保留。迟到 Promise 依据组件回归，浏览器未改写 navigator.clipboard；本轮未改布局，未另作窄屏或物理移动端验收。
- 执行与边界：fresh ZCode 会话实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，单主无子任务，全局分配不超过 9；实际标题“DT-R273 修复原始记录复制反馈竞态”。没有产品 AI POST、真实 Provider/Embedding/云/OSS/付费资源调用、直接数据库操作或产品内命令执行，未 commit/push/tag、未改版本号或正式验收结论。两目标修改前独占 600 备份为 /private/tmp/dev-toolbox-r273-ItemDetailView.before.vue 与 -ItemDetailView.raw-race.test.before.ts。Root 单独插入本节，文档备份 /private/tmp/dev-toolbox-r273-docs19.before.md（600），此前全部历史和用户待办逐字保留；真实 40 题继续等待用户提供数据，不阻塞独立产品迭代。

## DT-R274｜任务取消与重试的异步收尾归属（2026-10-25）

- 真实问题：TaskCenterView 的 cancelTask 与 retryTask 在 POST、刷新列表之后无条件回选旧任务或新重试任务，retry 还会清后来的状态筛选；迟到失败也会覆盖新上下文的提示。列表和筛选在请求期间仍可操作，Root 在旧编译页面以合成 A/B 任务实际 Enter 发起取消或重试、随后选 B：取消完成后详情回到 A 而 URL 仍为 B，重试完成后详情与 URL 均跳到新 R。已有读取序号只保护读取，不能解决动作收尾归属。
- 局部变更：仅 TaskCenterView.vue 与现有 TaskCenterView.race.test.ts，相对独占备份生产 +25/-9、测试 +335/-1。沿用 selectionIntent，并比较发起时 statusFilter、itemFilter 与 disposed；当前上下文才改提示、筛选和最终选择，迟到失败同样受限。取消和重试成功后始终刷新队列，即使用户已经切任务；重试的当前上下文仍按原行为清筛选并选中新 R。Root 确认整个模板/CSS、其他 12 个生产函数与原 5 条测试正文逐字保留；未改请求契约、轮询、批量表单，未禁用列表/筛选，也未加请求计数器、watcher 或公共机制。
- 必要验证：新增 6 条公开 DOM/URL 回归，覆盖正常取消/重试、迟到成功/失败、后来的任务选择与状态筛选、条目筛选清除，以及刷新列表期间的切换。第一轮旧实现 RED rc=1、4 failed | 6 passed，候选 GREEN rc=0、10/10。Root 审查发现该候选在切到 B 后跳过重试队列刷新，并遗漏 itemFilter，要求原两文件补齐。第二轮补充 RED 首次 1 failed | 10 passed，队列 fixture 过早提供 R 造成该断言假绿；调整 R 仅在动作后的第三次列表读取出现、生产仍未变，正确 RED rc=1、2 failed | 9 passed。最小修复后最终 GREEN rc=0、11/11，总耗时 609ms。两轮 pnpm check（vue-tsc＋tsc）均 rc=0；因第二轮源码变化才重跑受影响检查。最终实际 git -C 仓库根 diff --check rc=0；两目标相对备份 no-index --check rc=1（仅差异、无空白错误，覆盖既有未跟踪测试），冲突标记扫描 rc=1（无）。detector rc=2，仅一条原有 .cancel-pending border-left 样式 warning，Root 已核对备份中存在且整段 CSS 不变，未记为零警告通过。Root 已读最终原始工具命令、返回码和日志；/private/tmp/dev-toolbox-r274-{red,green,check,detector,diffcheck,context}.log 为 600，原始红绿及 fixture 修正过程保留。
- 本地载入：Root 经 ZCode 自有 dev-toolbox 2 终端只构建并替换 gateway，build 21.39 秒、up --no-deps 1.63 秒均 rc=0，单次静态 GET HTTP 200。新 gateway 100e46c3ef97；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间及健康状态保持，网络成员和仅 127.0.0.1:18380 绑定保持。控制进程 65663 自然结束，gateway build/up 日志为 600；稳定候选后未重复测试或构建。
- 实际页面复验：1280×720 既有 IAB 刷新后，分别重放取消与重试：仅拦截本机任务路径和确切 recent items GET，以明确标注 DT-R274 的合成 A/B/R 响应，在唯一的 A/action 合成 POST 持有期间通过真实 Enter 选 B，再在浏览器内返回合成成功，不转发该 POST。修后两路径的 B 详情、URL、可用操作保持，取消 A 状态已刷新，重试新 R 已进入三条队列；各一次合成 POST、意外请求为零。修前 /private/tmp/dev-toolbox-r274-{cancel,retry}-before.jpg、修后 -after.jpg 均为 600，四图已实际查看。最后通过普通导航卸载任务中心并清轮询，清除全部拦截，恢复原普通条目的按需原文状态，无合成内容或弹窗，浏览器 warn/error=[]，预览保留；本轮未使用剪贴板。确定性错误、筛选和列表乱序依据组件回归；本轮未改布局，未另作窄屏或物理移动端验收。
- 执行与边界：fresh ZCode 实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，同一会话经 Root 补充审查两轮自然结束；实际标题“DT-R274 TaskCenterView 取消重试异步收尾归属”。单主无子任务，全局分配不超过 9。没有真实产品任务 POST、Provider/Embedding/云/OSS/付费资源访问、数据库写入或产品内命令执行，未 commit/push/tag、未改版本或正式验收结论。两目标独占 600 备份为 /private/tmp/dev-toolbox-r274-TaskCenterView.before.vue 与 -TaskCenterView.race.test.before.ts。Root 单独插入本节，文档独占备份 /private/tmp/dev-toolbox-r274-docs19.before.md（600），此前全部历史和用户待办逐字保留；真实 40 题继续等待用户数据，不阻塞其他独立产品迭代。

## DT-R275｜批量整理提交后的草稿与导航归属（2026-10-25）

- 真实问题：createBatch 的迟到成功原本无条件关闭批量面板、清空选择、清状态筛选并跳到新批次，迟到失败也无条件写全局提示；请求期间记录选择、两个模型、敏感策略、关闭/重开与任务导航都可操作。Root 在旧编译页面实际提交合成 A/modelA/block，继续改为 B/modelB/视觉 B/redact、关再开面板、选任务 B 与失败筛选，再返回合成成功：新草稿被清、详情与 URL 跳新批次，UI 变“全部”而 URL.status 仍是 failed。发起时的请求 payload 本身正确冻结，没有原始数据错写。
- 局部变更：仅 TaskCenterView.vue 与现有 TaskCenterView.race.test.ts；相对独占备份生产 +34/-10、测试 +530/-0。createBatch 捕获面板 DOM ref、记录 IDs、模型、策略及现有 selectionIntent/statusFilter/itemFilter；只有草稿、面板实例与选择上下文均仍归属当前提交时，才关闭/清选择、同步清 UI 与 URL.status、设置成功提示。ownedOutcome 保存该正常收尾分支，列表刷新后仍需选择上下文未变才选中新批次；成功始终刷新队列，不能因较新草稿或导航而跳过。当前失败保留草稿并显示原错误，旧失败受同样归属保护。Root 逆向逐字节确认：除 createBatch、一条局部 ref 和一处模板绑定外，其他全部生产代码、整个 CSS、原 11 条测试及所有旧 helper 保留；未禁用表单或导航，未加 epoch、watcher、公共机制或组件，R274 取消/重试与读取/轮询均未改。
- 必要验证：新增 14 条公开 DOM/router 回归，覆盖正常成功与 payload、四个真实 v-model 字段分别编辑、重开同值面板、任务/状态/条目筛选变化、列表 await 期间另选、当前失败、两类旧失败、离页续程。生产仍与备份相同时，RED rc=1、12 failed | 13 passed (25)，1.09 秒；原 11 条及当前失败/离页保护通过。首个生产候选 GREEN rc=1、3 failed | 22 passed：一处测试错误要求清空选择后按钮启用，改为检查“开始批量整理”与非 busy 文本，生产禁用条件保留；另两处为真实缺口，较新草稿/重开面板仍会在列表刷新后跳新批次，以 ownedOutcome 最小修复。最终 GREEN rc=0、25/25，总耗时 787ms；pnpm check（vue-tsc＋tsc）rc=0。detector rc=2，仅一条原有 .cancel-pending border-left warning，Root 已确认备份中存在且整段 CSS 不变，未记为零警告通过。实际 git -C 仓库根 diff --check rc=0；两目标相对备份 no-index --check rc=1（只有内容差异、无空白错误，覆盖未跟踪测试），冲突扫描为无。Root 已读原生最终 GREEN/check/detector 输出、diffcheck 实际日志及完整目标 diff；/private/tmp/dev-toolbox-r275-{red,green,check,detector,diffcheck,context}.log 均为 600，过程与修正说明保留，context 本会话仅一次。
- 本地载入：首次控制器因 Root 把 R274 网关短 ID 100e46c3ef97 抄为 100e4cc3ef97，在 docker inspect 前置检查阶段退出；当时 build/up 日志均未创建，没有构建或替换服务。只读 docker ps 确认真实 ID 后更正，唯一实际 gateway build 22.56 秒、up --no-deps 1.64 秒均 rc=0，单次静态 GET HTTP 200。新 gateway 0560e889d456 已经实际终端输出和只读列表确认；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间、健康状态保持，原网络和仅 127.0.0.1:18380 绑定保持。成功控制器 78365 自然结束，gateway build/up 日志为 600。未因前置标识错误重跑源码测试或构建第二次。
- 实际页面复验：1280×720 既有 IAB 仅拦截本机 AI 路径与确切 recent items GET，返回明确标记 DT-R275 的合成 Provider/模型/设置、条目和任务；唯一的批量 POST 持有期间通过公开控件修改四类输入、关闭/重开面板、Enter 选 B 与失败筛选，再在浏览器内返回合成批次，不转发 POST。首次修前重放只因精确 label 定位不匹配而停在提交前，清理后从真实 AX 核对 combobox 名称并修正，随后完成有效修前路径。修后一次同路径：面板仍打开，仅 B 勾选，正文/视觉均为 B、策略 redact，任务详情与 URL 保持 B、UI 和 URL 均为 failed，新批次包含在“全部 3”计数且无旧成功提示；原请求仍是 A/modelA/无视觉/block，控件可用、合成 POST 1 次、意外请求零。截图 /private/tmp/dev-toolbox-r275-batch-before.jpg 与 -after.jpg 均为 600，已实际查看。最后普通导航卸载任务中心、清轮询与全部拦截，恢复原条目的按需原文状态，无合成内容/面板/弹窗，浏览器 warn/error=[]，预览保留，剪贴板未使用。正常成功、失败与确定性列表乱序依据组件回归；本轮未改布局，未另作窄屏或物理移动端验收。
- 执行与边界：fresh ZCode 实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，单主无子任务，全局分配不超过 9；会话“DT-R275 批量提交归属与导航竞态修复”自然结束。无真实产品任务 POST、Provider/Embedding/云/OSS/付费资源调用、数据库写入或产品内命令执行，未 commit/push/tag、未改版本或正式验收结论。两目标独占 600 备份 /private/tmp/dev-toolbox-r275-TaskCenterView.before.vue 与 -TaskCenterView.race.test.before.ts。Root 单独插入本节，并仅更正 R274 节新 gateway 的一位抄录错误；文档独占备份 /private/tmp/dev-toolbox-r275-docs19.before.md（600），其他全部历史与用户待办逐字保留。真实 40 题继续等待用户数据，不阻塞独立产品迭代。

## DT-R276｜正常重试后的筛选 URL 与刷新一致性（2026-10-25）

- 真实问题：retryTask 当前归属成功时原本只清 statusFilter，随后 selectTask 扩展旧 route.query，把 status=failed 留在 URL。Root 在旧编译页面实际从失败筛选 Enter 重试合成 A，正常结果显示“全部 3”与新排队任务 R，但 URL 仍为 failed＋R；刷新同一地址后恢复“失败 2”，新 R 被隐藏、详情退回 A，而 URL.taskId 仍为 R。任务本身没有丢失，问题是页面筛选状态未写入可重新打开的地址。
- 局部变更：仅 TaskCenterView.vue 的 retryTask 归属成功分支增加一行 await router.replace，按既有 R275 做法同步移除 query.status，并保留其他 query。原 POST、成功/失败提示、选择意图与用户后来导航保护、无条件队列刷新均保持。现有正常重试用例增加 URL.status、三行可见、单次 POST 断言，读取实际 fullPath，卸载后按同一路径重挂载，验证新 R 排队行、详情与可用操作。生产 +1/-0、测试 +20/-0，仍为原 25 条用例。Root 独立逆向逐字节确认：生产除该行外全部保留，既有用例原行与断言保持，其余 24 条及所有 helper、模板/CSS、R274/R275 逻辑均逐字保留；未新增公共机制、字段、框架或重复用例。
- 必要验证：增强测试先在旧生产上运行，原生工具顺序为测试编辑→RED→生产编辑→GREEN；RED rc=1、1 failed | 24 passed (25)，1.36 秒，唯一失败为 query.status 期望 undefined、实际 failed。一次生产候选 GREEN rc=0、25/25，2.74 秒；pnpm check（vue-tsc＋tsc）rc=0。detector rc=2，仅一条已有 .cancel-pending border-left warning，Root 核对备份存在且 CSS 整段未变，未记为零警告通过。目标实际 git -C diff --check rc=0；两目标相对本轮备份 no-index --check 均 rc=1（内容差异、无空白错误，包含未跟踪测试），冲突扫描 rc=1（无）。Root 已打开五项原生工具核对真实返回码，并读实际日志与目标 diff。/private/tmp/dev-toolbox-r276-{red,green,check,detector,diffcheck,context}.log 均为 600；context 本会话一次，未为补证重复运行检查。
- 本地载入：Root 经 ZCode 自有 dev-toolbox 2 终端只构建并替换 gateway，build 21.33 秒、up --no-deps 1.62 秒均 rc=0，单次静态 GET HTTP 200。新 gateway 71df67fc2e4f 由实际终端与只读容器列表确认；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间与健康状态保持，原网络及仅 127.0.0.1:18380 绑定保持。控制进程 87226 自然结束，gateway build/up 日志为 600；稳定源码后未重复测试或构建。
- 实际页面复验：1280×720 既有 IAB 仅为本机任务路径与确切 recent items GET 返回明确标记 DT-R276 的合成数据；唯一 A/retry POST 持有后在浏览器内返回合成 R，不转发请求。修前正常及同 URL 刷新两图为 /private/tmp/dev-toolbox-r276-retry-before.jpg、-retry-reload-before.jpg（600）。首次修后已完成正常重试并保存 -retry-after.jpg，但刷新时一条不属于本轮任务接口的普通 Document 导航事件被控制脚本误当作任务请求，返回失效拦截标识；当次清理已完成，未记为产品失败或完整通过。Root 只收窄内存中复验脚本的事件处理范围，保留该中断截图，再完成同路径：正常与真实刷新后均为“全部 3”、URL.status 无值、URL.taskId 与详情均为新 R、排队行可见且操作可用。完整通过路径合成 POST 1 次、任务接口意外请求零，另 1 条范围外导航事件明确跳过。最终两图为 -retry-after-final.jpg 与 -retry-reload-after-final.jpg（600），均已实际查看。所有临时拦截清除、任务中心卸载并清轮询，原条目恢复按需读取原文，无合成内容或弹窗，浏览器 warn/error=[]，预览保留，剪贴板未使用。未改布局，未另作窄屏或物理移动端验收；页面重放不代表真实 Provider 或任务执行。
- 执行与边界：fresh ZCode 实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，单主无子任务，全局分配不超过 9；会话“DT-R276 retryTask 筛选URL一致性测试与修复”自然结束。没有真实产品任务 POST、Provider/Embedding/云/OSS/付费资源访问、数据库写入或产品内命令执行，未 commit/push/tag、未改版本与正式验收结论。目标独占 600 备份 /private/tmp/dev-toolbox-r276-TaskCenterView.before.vue 与 -TaskCenterView.race.test.before.ts。Root 单独插入本节，文档独占备份 /private/tmp/dev-toolbox-r276-docs19.before.md（600）；R275、R274 已更正的网关标识、其他全部历史及人工待办逐字保留。真实 40 题继续等待用户提供数据，不阻塞独立产品迭代。

## DT-R277｜任务历史地址与详情同步及读取失败归属（2026-10-25）

- 真实问题：taskId watcher 原本只更新 selectionIntent。AppRail“AI 任务”与 ModuleNav“全部任务”是普通 push 导航，而任务行通过 replace 写 taskId，公开路径可形成同组件的 A、B 历史条目。Root 在旧编译页面 Enter 选 A→全局 AI 任务导航→Enter 选 B→浏览器 back，地址已回 A，但详情/选中行仍为 B，期间详情请求为零；forward 回 B 仍为 B。两任务均为终态，不会靠轮询自行纠正。全过程只有合成 GET，没有创建任务。
- 局部变更：仅 TaskCenterView.vue 的既有 taskId watcher 增加 8 行，以及现有 TaskCenterView.race.test.ts 增加 3 条用例（+195 行）。对于字符串且在当前已加载、当前筛选可见列表内的目标，避开在途同目标，复用 selectTask(value, false) 跟随历史；组件自身写回 URL 不重复读取，不写新历史，快速 back A→forward B 仍由原 detailSeq 处理迟到结果。读取不同目标前清空旧展示，同目标已有详情保留；当前读取失败不再把另一任务的详情与操作放回页面。空值、数组、未知或当前列表外的 query 不新增任意 HTTP 路径请求；其他筛选/回退方式保持既有行为。Root 独立逆向逐字节确认：除这 8 行外的全部生产代码、整个模板/CSS、原 25 条用例正文和既有 helper 保留，没有新状态字段、epoch、公共框架或禁用控件。
- 必要验证：初轮旧生产 RED rc=1、2 failed | 25 passed (27)，971ms，分别在 back 后仍显示 B、back 未启动 A 读取处失败；首候选 7 行实现 GREEN rc=0、27/27，783ms。Root 审查发现新调用先改地址、读取失败后仍保留 B 详情/重试按钮，未接受该候选或载入运行时；同一会话追加一条失败回归，在当前候选定向 RED rc=1、1 failed | 27 skipped (28)，738ms，错误提示断言已通过后才在 B 详情残留处失败。仅增一条不同目标的旧展示清理后最终 GREEN rc=0、28/28，975ms。两轮 pnpm check（vue-tsc＋tsc）均 rc=0；第二轮因为生产输入变化才重跑受影响检查。detector 两次 rc=2，最终仅一条已存在的 .cancel-pending border-left warning（491 行），Root 已核对 CSS 与备份逐字相同，未记为零警告通过。实际 git -C diff --check rc=0；两目标对备份 no-index --check 各 rc=1（内容差异、无空白错误，包含未跟踪测试），冲突扫描 rc=1（无）。Root 已读原生初轮 RED、补充 RED/最终 GREEN/check/detector/diff 返回码及实际日志；/private/tmp/dev-toolbox-r277-{red,green,check,detector,diffcheck,context}.log 均为 600，原始记录保留、补充轮只追加，备份与 context 未重做。
- 本地载入：Root 经 ZCode 自有 dev-toolbox 2 终端只构建并替换 gateway，唯一 build 22.95 秒、up --no-deps 2.06 秒均 rc=0，单次静态 GET HTTP 200。新 gateway ce4a834ffa16 由实际终端与只读容器列表确认；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间与健康状态保持，原网络与仅 127.0.0.1:18380 绑定保持。控制进程 5840 自然结束，gateway build/up 日志为 600；只载入最终 8 行候选，未为补证重复构建或重跑已稳定源码检查。
- 实际页面复验：1280×720 既有 IAB 只为本机任务路径和确切 recent items GET 返回明确标记 DT-R277 的临时合成数据；保持真实公开导航和 browser back/forward，不注入应用状态。修后正常路径 back 为 URL A＋A 详情、forward 为 URL B＋B 详情，每次各读取一次对应详情，操作可用、错误为空。再以单次合成 A 详情 503 验证：back 的 URL 仍为 A，但旧 B 详情/操作不可用，错误可见且无错误选中行；forward 后恢复 B、清旧错误。两条完整路径均任务 POST=0、意外任务接口请求=0，合成 503 只在浏览器内返回、不访问真实任务或 Provider。修前 /private/tmp/dev-toolbox-r277-history-{back,forward}-before.jpg、正常修后 -{back,forward}-after.jpg、失败/恢复 -{back,forward}-after-error.jpg 共 6 图均为 600，已实际查看。最后清除全部临时拦截，普通导航卸载任务中心并清轮询，原条目恢复按需读取原文，无合成内容或弹窗，浏览器 warn/error=[]，预览保留、剪贴板未使用。快速前进与迟到响应由组件 deferred 回归验证；本轮未改布局，未另作窄屏或物理移动端验收，不将合成页面结果视为真实任务执行。
- 执行与边界：fresh ZCode 实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，单主无子任务，全局分配不超过 9；同一会话“DT-R277 TaskCenterView taskId watcher 历史同步”两轮自然结束（8 分 32 秒与 2 分 54 秒）。无真实产品任务 POST、Provider/Embedding/云/OSS/付费资源调用、数据库写入或产品内命令执行，未 commit/push/tag、未改版本与正式验收结论。目标独占 600 备份 /private/tmp/dev-toolbox-r277-TaskCenterView.before.vue 与 -TaskCenterView.race.test.before.ts。Root 单独插入本节，文档独占备份 /private/tmp/dev-toolbox-r277-docs19.before.md（600），此前全部历史、R274 已更正的网关标识及人工待办逐字保留。真实 40 题继续等待用户数据，不阻塞其他独立产品迭代。

## DT-R278｜任务中心记录筛选与读取状态同步（2026-10-25）

- 真实问题：ItemAIView 的“打开任务中心/查看全部”会带 itemId；AppRail“AI 任务”和 ModuleNav“全部任务”则 push 到无 itemId 的任务地址。原 itemFilter 只是 computed，只有专用清除按钮在路由完成后手动 loadTasks。Root 在旧编译页面以终态合成 A/B 验证：记录 A 筛选→Enter 真实“全部任务”后 chip 消失但仍只有 A、全列表 GET=0；同地址 reload 才显示 A+B；再 back 回 A 时 chip 出现但仍显示 A+B、筛选 GET=0。不是轮询延迟或数据集变化。
- 局部变更：TaskCenterView.vue 相对本轮备份 +19/−5，现有 TaskCenterView.race.test.ts +272、增加 4 条用例。itemFilter 变化时失效旧详情序号、清除旧行/详情/反馈并按当前范围读取；复用原 loadSeq/detailSeq，唯一新增 scopeLoading 用于后续范围读取，避免与 bootstrap loading 混用，最新 loadSeq 的 finally 负责收口，offline 早退也经过 finally。清除按钮保留 taskId/status 和 replace 语义，读取统一交给 watcher、只读一次。读取中显示原队列加载态，失败保留真实错误与重新读取，隐藏错误下的假空态；离线空列表明确为当前范围暂不可读，联网后自动刷新。selectionIntent 保留原清除按钮的选择偏好，新范围仍有该任务才选中，否则按原逻辑取首条。Root 逆向逐字节确认其他生产代码、CSS、R274–277 修复、原 28 条用例正文与既有 helper 均保留。无新组件、框架、API、存储或依赖。
- 必要验证：初次有效 RED rc=1、3 failed | 28 passed (31)，804ms，分别复现公开导航不读取与清除后没有加载态；初候选 GREEN rc=0、31/31，811ms。前三次启动错误因子进程继承 umask 177 使临时目录缺执行权限，均为 0 tests，未当作 RED；记录保留，改为日志独占 600、验证子进程正常 umask 022 后才运行有效测试，临时沙箱误判已更正。Root 未接受离线仍声称缓存/没有任务的初候选：S1 定向 RED rc=1、1 failed | 31 skipped (32)，747ms；只改两处模板文案后 GREEN rc=0、32/32，994ms。实际 IAB 又暴露读取失败与“没有符合条件的任务”同时出现，S2 只增加一条断言与一个现有空态条件，定向 RED rc=1、1 failed | 31 skipped (32)，672ms，最终 GREEN rc=0、32/32，888ms。每个变化后的稳定候选 pnpm check 均 rc=0；detector 均 rc=2，仅既有 .cancel-pending border-left warning（最终 505 行），未改 CSS、未记为零警告通过。最终 scoped git diff --check rc=0，两目标对备份 no-index --check 各 rc=1（内容差异、无空白错误），冲突扫描 rc=1（无）。Root 已读原始返回码与实际日志；/private/tmp/dev-toolbox-r278-{red,green,check,detector,diffcheck,context}.log 为 600，S1/S2 追加保留全部旧结果，备份/context 未重建。
- 本地载入：Root 经 ZCode 自有 dev-toolbox 2 终端，仅构建与替换 gateway。首轮 build 22.03 秒、up --no-deps 1.76 秒、HTTP 200 均成功，gateway 为 27806bc8f10d，控制进程 21412 结束。因实际页面发现 S2 单行缺口，修正后仅重建受影响网关：build 19.98 秒、up 1.61 秒、HTTP 200，最终 gateway 797d2db7a586，控制进程 23651 结束；两标识均由只读容器列表确认。API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间、健康状态、网络及仅 127.0.0.1:18380 绑定均保持。两轮 build/up 日志分别为 /private/tmp/dev-toolbox-r278-gateway-{build,up}.log 与 -r278-s2-gateway-{build,up}.log（600）。后续源码未变，不重复构建或源码检查。
- 实际页面复验：1280×720 既有 IAB 只对本机任务 GET 与确切 recent items GET 返回标记 DT-R278 的临时合成响应，保持公开键盘导航、browser back/forward，不注入应用状态。修后 All 显示 A+B、back 筛选 A 只显示 A、forward 恢复 A+B，各新增一条当前范围列表读取。旧 B 详情在途时 back 到 A，暂停新列表可见真实队列加载、无旧行/详情/操作且无假空态；单次合成 503 后放行旧 B，URL 仍属于 A、旧对象不恢复，重新读取恢复 A。首轮失败页仍出现假空态的结果如实保留；S2 载入后仅重验受影响路径，实际错误下无空态、恢复成功。另以当前独立标签的临时网络模拟验证：离线切到 All 无新 GET、无旧操作或残留 spinner，离线提示准确；联网后自动一条 All GET 恢复 A+B。各路径任务 POST=0、意外任务请求=0，合成错误只在浏览器内返回。最终全列表与错误图 /private/tmp/dev-toolbox-r278-all-final-after.jpg、-scope-error-late-final-after.jpg，离线/恢复图 -scope-{offline,online}-after.jpg，连同修前与中途状态图均已查看、600。末尾清除拦截、恢复联网、普通导航卸载任务中心并恢复原条目，未打开原始记录入口，合成内容/弹窗均无，浏览器 warn/error=[]，预览保留。本轮未改 CSS，不另作全量响应式或物理移动端验收，不把合成读取视为真实任务执行。
- 执行与边界：fresh ZCode 实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，Fast 未操作；同一原生会话串行修正，无子任务，遵守总体不超过 9 的分配。最终会话“R278 状态更正与剩余检查收尾”，S1/S2 收尾自然结束，无排队指导或在途控制命令。无真实产品 Provider/Embedding/云/OSS/付费资源访问、数据库写入、产品内命令执行、commit/push/tag、版本或正式验收结论变更。目标独占 600 备份 /private/tmp/dev-toolbox-r278-TaskCenterView.before.vue 与 -TaskCenterView.race.test.before.ts；Root 独立插入本节并保留 /private/tmp/dev-toolbox-r278-docs19.before.md（600），此前全部历史、R274 更正与人工待办逐字保留。status 与 itemId 同时变化时仍可能有两条本地列表读取，由既有 loadSeq 取最新；本轮不扩展为状态筛选去重或列表外 taskId 的新合同。真实 40 题继续等待用户数据，不阻塞独立迭代，整体产品与 V3 正式验收仍未宣称完成。

## DT-R279｜列表外任务地址恢复、详情归属与活动刷新（2026-10-25）

- 真实问题：TaskCenter 列表每次只读取最近 100 条，API 的单任务 GET 按 UUID 独立读取；现有“这是任务…的重试”按钮可打开已不在这 100 条内的旧任务 C。Root 在旧编译页面实际打开该公开链接，随后刷新同一 URL，地址仍为 C、详情及重试操作却回到 A，C GET 为零；经全局 AI 任务导航建立 A 条目再 back 到 C 同样未读 C。此前 R277 的当前可见列表 watcher 没有覆盖这个真实入口。修前为明确标记 DT-R279 的 100 条终态合成任务，三图 /private/tmp/dev-toolbox-r279-linked-{opened,reload,back}-before.jpg（600）；只复现前端缺口，不代表数据库或真实任务执行。
- 局部变更：唯一源码 owner 在 TaskCenterView.vue 复用 loadTasks/selectTask/detailSeq，增加规范 UUID 的路由恢复入口及窄的 recoverRouteIntent 参数；初始化、记录上下文变化、后台读取与外部 taskId/history 导航能直接读取列表外目标，不把它追加到最近列表或修改计数。同目标在途去重；非 UUID 在拼接请求前给出准确链接错误，不请求任意路径；列表外且有 itemId 筛选时只在读回处比较记录归属，当前 API 筛选列表已证明的归属不重复校验。不同目标读取前清掉旧展示，404 或记录不匹配不回退另一任务。Root 未接受初次 36 绿候选：已展示 C 而另一目标 A 在途时返回 C，原早退会留下 A 的覆盖权；列表外 queued/running 任务也会被当作终态缓存。S1 用既有序号失效不同目标的在途读取，并把“列表活动或已选任务活动”接到同一个 2500ms pollTimer；详情完成与列表完成共用一处调度，终态不续排，无新增状态字段、第二 timer、缓存、后端或分页遍历。最终生产 +55/-12、测试 +409/-0（6 条新用例，共 38 条）；Root 逐字节确认原 32 条测试正文与 helpers 全部保留，模板/CSS 与本轮备份完全相同。
- 必要验证：初次测试先于生产变更，真实 RED rc=1、4 failed | 32 passed (36)，1.08 秒；首候选 GREEN rc=0、36/36，1.15 秒。首次误用 pnpm -C 导致 EACCES、零测试，只保留了 Native 工具记录及日志说明，未声称原始 stderr 仍在 red.log。S1 针对上述两处可达问题增加 2 条 DOM/router 用例，定向 RED rc=1、2 failed | 36 skipped (38)，731ms；首次完整运行 37 通过/1 失败，是新测试把自身 URL 写回的 A GET 计数误写成 2，按已有单次读取合同改为 1 后生产未再变，最终 38/38、rc=0、865ms。原 36 条正文和断言未动。最终 pnpm check（vue-tsc＋tsc）rc=0；detector rc=2，仅原有 .cancel-pending border-left warning（现 548 行），未记为零警告通过。scoped git diff --check rc=0，两目标对本轮备份 no-index --check 各 rc=1（内容差异，无空白错误），冲突扫描 rc=1（无）。S1 diff 日志首次被 zsh multios 交错重复写入，原记录保留并追加说明及干净记录，结果一致。Root 已读真实源码、测试、日志并在 Native 展开最终 RED/GREEN/check/detector 原始输出；/private/tmp/dev-toolbox-r279-{context,red,green,check,detector,diffcheck}.log 与 5 个已知 r279-*.tmp 均为 600，context 和备份没有重建。
- 本地载入：Root 仅经 ZCode 自有 dev-toolbox 2 终端构建并替换 gateway 一次，build 21.31 秒、up --no-deps 1.97 秒均 rc=0，单次静态 GET HTTP 200；控制进程 47942 自然结束。gateway 由 797d2db7a586 变为 16680eb45bbc，实际终端及只读容器列表均已确认；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 身份、启动时间、健康状态和网络保持，网关仍仅绑定 127.0.0.1:18380。build/up 日志为 600。替换后旧打开页面首次导航仍引用旧 bundle 的 CSS，出现一次 Unable to preload CSS，未进入合成任务首屏；该轮清理后，公开 reload 原页面加载新版本，再进行下面完整复验，未重建或改源。
- 实际页面复验：1280×720 既有 IAB，仅本机 tasks 路径和确切 recent items GET 返回 DT-R279 合成数据，所有非预期任务 POST 均阻断。公开旧任务链接→真实 reload C 地址：详情 C、最近列表仍 100 条，新增 C GET=1/A GET=0；AI 导航→选 A→back C→forward A，每次地址和详情一致，目标 GET 各 1，无自身写回重复读。该完整路径 lists=2、A=3、C=3、POST/意外请求=0。独立错误路径在 back C 时返回一次合成 503，显示真实读取错误、详情为空且没有旧 A 操作，forward A 后恢复（lists=1、A=3、C=2、合成错误=1、POST/意外=0）。独立活动路径最近 100 条全为已取消，直接打开列表外 C（running）后由实际 2500ms 轮询读为 failed，取消按钮变为重试按钮；lists=2/C=2，继续观察 3 秒计数不增，证明终态停止，无 POST/意外请求。六张修后图为 /private/tmp/dev-toolbox-r279-linked-{opened,reload,back,error,recovered,live}-after.jpg（600），均已实际查看。每条流程清除 Fetch patterns、卸载任务中心并停止轮询，恢复青岚复核原条目，合成内容和弹窗为零、原文仍按需打开，原始记录按钮未触发；预览已保留。控制台保留前述旧资源错误，新版本 reload 后至全部复验结束没有新增 warn/error。未变布局，未另做响应式矩阵或真实 Provider 验收。
- 执行与边界：fresh ZCode 实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，单主无子任务、没有排队指令，全局分配不超过 9；同一 R279 会话的初轮与 S1 均自然结束。目标独占 600 备份 /private/tmp/dev-toolbox-r279-TaskCenterView.before.vue 与 -TaskCenterView.race.test.before.ts；Root 单独插入本节并保留 /private/tmp/dev-toolbox-r279-docs19.before.md（600），此前全部历史和人工待办逐字保留。手工 status 筛选、POST 收尾与空/数组 query 的原有选择政策未重设计，不宣称本轮解决所有筛选 URL 语义。没有真实产品任务创建、Provider/Embedding/云/OSS/付费资源调用或数据库写入，未 commit/push/tag、未改版本或正式验收结论。真实 40 题继续等待用户数据，整体产品与 V3 正式验收仍未完成。

## DT-R280｜路由页面资源失败的可见恢复入口与导航归属（2026-10-25）

- 真实问题：R279 替换本地 gateway 后，已打开的旧页面曾在懒加载任务页时请求已移除的 CSS，只向控制台报错；App、router 与 AppShell 没有可见的路由加载恢复入口。Root 本轮独立从公开工具箱进入 Base64，填入明确 DT-R280 合成草稿后 Enter“帮助”，仅对实际 HelpView CSS 请求返回一次合成 404：地址仍为 Base64、草稿完整，但 alert 和恢复入口均为零。修前图 /private/tmp/dev-toolbox-r280-route-error-before.jpg（600），清除拦截后原青岚复核条目已恢复。问题属于当前懒加载路由的真实交付路径，没有为此扩展静态资源保留服务、部署框架或任意全局异常捕获。
- 局部变更：仅 App.vue、AppShell.vue 与新 App.navigation-failure.test.ts。App 常驻 setup 在认证完成前注册当前 router 的 beforeEach/afterEach/onError，保存最近导航意图，只给当前失败目标生成同源完整加载入口；成功导航清提示，卸载移除本组件的三个 hooks。恢复地址采用 window.location.origin + to.fullPath，保留 query/hash，并避免双斜杠路径被原生链接解析成外站；Root 用当前 Vue Router 5.3.0 的实际解析验证过该边界，没有访问外站。AppShell 在现有 header 与 workspace 之间增加 role=alert，说明页面未能打开、先保留未保存输入，再通过原生链接“重新打开目标页面”；用户操作后才完整读取 HTML/资源。当前页和输入继续保留，不自动刷新、重放、持久化草稿或呈现原始错误/资源地址/堆栈。仅提示存在时增加一条外层 grid 行，workspace 仍为 minmax(0,1fr)，使用既有语义 token 和 44px 链接触点。最终相对本轮备份 App +31/-2、AppShell +52/-1，新测试 365 行/6 条；Root 逆向逐字节确认既有 auth/bootstrap/returnTo/theme 及壳层滚动、compact bar、响应式规则均保留。
- 必要验证与审查：初次 5 条回归有一条旧 import 永不结算而超时，Root 不接受该次整体 RED；原失败保留。Native 先修正挂起，再按 Root 当前依赖实测把正常取消改为 resolve 后的 NavigationFailure，并把“已 ready 后的跳转”改成 history.replace 预置地址、mount 安装 router 的真首次导航；第三次有效 RED 为 5 failed、rc=1、1.56 秒，四处 alert 缺失及一处缺少 hooks 清理，无超时。初轮 GREEN 5/5、rc=0、1.47 秒，4 文件定向组 23/23、2.10 秒。Root 随后拒绝该候选：帮助 import 在途时再点当前 Base64，duplicated 结算不会运行 beforeEach，旧帮助失败仍能复活提示。实际依赖事件顺序与第 6 条 DOM/router 测试均复现；S1 定向 RED 1 failed | 5 skipped、rc=1、572ms，生产仅补 afterEach 的成功/duplicated 最近意图归属及清提示，aborted/cancelled 不冒充成功。最终新文件 6/6、609ms、rc=0，完整定向组 4 文件 24/24、914ms、rc=0；pnpm check（vue-tsc＋tsc，包含新测试）rc=0。两个 changedVue 检测器的首个相对路径错误返回 cannot access，虽 rc=0 但不算有效检查；更正 cwd 后两文件 []/rc=0，S1 仅受影响 App 再测 []/rc=0。scoped git diff --check rc=0、冲突标记无；未跟踪新测试另经 Root 逐行确认无尾随空白。6 份规定日志 /private/tmp/dev-toolbox-r280-{context,red,green,check,detector,diffcheck}.log 均 600，三次初轮 RED、S1 RED、所有 GREEN 与错误 cwd 记录均保留；没有声称夹具路由的预期 warning 为零。Root 已读最终源/测试/真实日志，并在 Native 展开 S1 RED、24 条/check、detector/diff 原始输出。旧测试正文未修改，S1 只在原 5 条外插入第 6 条。
- 本地载入：Root 通过 ZCode 自有 dev-toolbox 2 终端只构建并替换 gateway 一次，build 21.39 秒、up --no-deps 1.76 秒均 rc=0，单次静态 GET HTTP 200，控制进程 59604 自然结束。实际新 gateway 1e40f2579dbd（旧 16680eb45bbc）由只读容器列表确认；API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间、健康状态及网络保持，仍只有 127.0.0.1:18380 绑定。build/up 日志均 600。Root 公开刷新原预览页后才验证新 App；已经停留在更早版本的标签页也需要先加载新版本才获得该恢复提示，本轮没有静默刷新已有用户输入。
- 实际页面验收：第一批在新编译页面重放同一 Base64 草稿→帮助 CSS 404，出现可见 alert、原草稿和 URL 保持、链接精确指向本站 /help；Tab 从帮助、主题、退出登录依次到达恢复链接，未触发退出。清除拦截后 Enter 原生恢复链接完整打开“帮助与产品边界”，提示消失。初批 CSS 视口几何通过，但直接 CDP 改尺寸的截图被宿主裁切，未当作完整尺寸图交付。Root 读取正式 viewport capability 后完成唯一一批截图确认：390×844、1024×768、1440×900、1920×1080、CSS 3840×2160 均无 main/文档横向溢出、提示与 workspace 不重叠、草稿逐字保留，手机链接高度 44px；390 深/浅主题均已查看。最终图 /private/tmp/dev-toolbox-r280-route-error-{390,1024,1440,1920,3840}-dark-final-after.jpg 与 -390-light-final-after.jpg（600）；前四个尺寸和手机浅色位图尺寸精确匹配，4K CSS 布局几何通过但宿主实际只捕获 3840×1911，不能称为完整 3840×2160 截图。初批手动恢复图为 /private/tmp/dev-toolbox-r280-route-recovered-after.jpg（600）；原裁切图保留，未覆盖或伪称无问题。确认批另经公开“知识与记录”成功导航，alert=0，验证无需完整重载也可清提示。两批各只合成一次 CSS 404；没有任务、Provider、云或数据库写入。所有 Fetch patterns、CDP 尺寸覆盖、正式 viewport override 均清理，1280×720、原深色、青岚复核地址恢复，合成内容/弹窗/alert 为零，原始记录按钮未触发，预览保留；新版本两批页面操作无新增 warn/error。确定性乱序、真首次导航、双斜杠与重复导航归属由真实内存 router 回归证明；不宣称物理手机、完整浏览器矩阵或真实外部服务验收。
- 执行与边界：fresh ZCode 实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，Fast 未改；单主无子任务，遵守共享分配与全局总数不超过 9。当前会话实际标题“修正R280两个RED前测试用例缺陷”，实施与 S1 已结束，无排队指令；早期两次即时指导仅在原会话继续，没有重启任务。源码独占备份 /private/tmp/dev-toolbox-r280-{App,AppShell}.before.vue（O_EXCL、600）；Root 单独插入本节并保留 /private/tmp/dev-toolbox-r280-docs19.before.md（600），此前 R279/R278/其他历史及人工待办逐字保留。没有改 main/router/auth 文件、后端、API、数据库、依赖、部署配置、版本号或正式验收结论，未 commit/push/tag、未调用产品 Provider/Embedding/OSS/付费资源。真实 40 题继续等待用户数据，整体产品与 V3 正式验收仍未完成。

## DT-R281｜Token 列表未知状态、撤销错误归属与代码收尾（2026-10-25）

- 问题与修复：修前真实 IAB 用合成响应证实，Token GET 失败仍显示“尚无 Token”和零计数；A 撤销失败后取消，再打开 B 会显示 A 的错误。仅在 TokenSettingsView.vue 增加当前读取成功的显示条件，失败或读取中隐藏计数、空态、缓存卡片与摘要；复用既有重试，成功空列表仍正常显示。打开撤销确认时先清旧 actionError 再设置目标。既有读取序号、创建/撤销流程、明文一次性、焦点和 CSS 保留。现有 m3-settings.test.ts 增强读取失败用例，并新增撤销后重读失败恢复、A/B 错误归属两条 DOM 回归。
- 本轮验证：生产与备份一致时 RED 为 3 failed / 9 passed（12），三处正好复现假空态、旧列表和错误串入；一个生产候选 GREEN 12/12，含键盘与保存流程的三文件组 18/18，Web 类型检查通过，当前 Vue detector []，空白与冲突检查通过。既有夹具路由警告如实保留，不宣称零 warning。ZCode 标准 GLM-5.3、最高、完全访问，单主完成后停止写入。
- 提交前整体检查：Web 110 文件 772 项、worker 19 文件 228 项测试通过，Web 与 worker 类型检查通过，Go API 单元测试通过；集成测试文件仅编译通过（-tags=integration -run ^$，没有执行数据库用例），本地 Nginx 等待逻辑 5/5 通过。Vite 构建通过，保留既有大 chunk 提示；最终 Web 检查期间候选文件逐字节未变。为避免纳入本地产物，.gitignore 增加 .playwright-mcp/ 和 apps/api/server，文件仍留在本机。
- 收尾边界：按用户要求收尾全部现有改动并提交推送；本节记录的是提交前结果。R281 修后以 DOM 回归、类型检查与构建验证，未更新运行栈或追加修后浏览器验收；不把修前三图记为修后通过。未部署、未改版本号/tag 或正式验收状态，未调用真实 Token 写接口、产品 Provider/Embedding、云或 OSS；真实 40 题仍待用户数据。此前全部迭代记录和人工待办保留。

## DT-R282｜接续已提交基线与 Token 实际页面补验（2026-10-25）

- 本地载入：接续 R281 与全仓审计提交后的 bc24540 干净基线，通过新 ZCode 会话仅构建并替换既有本地 gateway；build/up 均 rc=0，单次 HTTP GET 返回 200。gateway 从 1e40f2579dbd 更新为 a340c72a213c；API、worker、Postgres 身份与启动状态、网络及 127.0.0.1:18380 绑定保持。复用该栈原私有环境文件，未输出其值；日志 /tmp/dt-r282-local/ 为 600。没有重启其他服务或宣称后端审计修复已载入运行栈。
- Root 页面补验：新版本中仅拦截 Token 路径，依次返回合成读取失败、成功空列表、两条合成 Token。读取失败时错误与重试可见，空态、零计数、缓存卡片不出现；重试成功空列表正常。合成 A 撤销返回失败后，取消并打开 B，确认框没有 A 的旧错误。合成 GET=3、浏览器内阻断 DELETE=1、意外请求=0、转发写入=0；两张修后截图 /tmp/dev-toolbox-r282-token-{error,revoke}-after.png。清除全部拦截并返回首页，合成内容消失，浏览器 warn/error 为空。本轮补齐 R281 未做的运行页面验证，不代表真实 Token 创建/撤销或外部服务验收。
- 协调与边界：新会话实际核实 BigModel 标准 GLM-5.3、最高思考、完全访问，Fast 保持。与另外两个产品主控共用原子 UI 锁，三个仓库分离、每项目最多一个执行 agent，已知总数最多 3，无子 agent。未改产品源码、commit/push、版本或正式验收结论，未执行服务器、Provider、云、OSS、备份恢复；真实 40 题、正式发布和既有人工待决保留。

## DT-R283｜目录与标签编辑错误的目标归属（2026-10-25）

- 问题与局部修复：Root 用合成目录、标签 A/B 分别复现 A 保存失败后直接编辑 B，表单已切到 B 却仍显示 A 的旧错误。仅在 LibraryManageDrawer.vue 的 beginFolderEdit、beginTagEdit 各清理一次 errorMessage，共两行；原有请求、取消、删除、创建、焦点、模板与 CSS 保留。同一 A 失败时仍保留草稿和错误，开始新的编辑意图才清除旧错误。
- 必要验证：新增两条真实组件/Pinia/DOM 回归，旧生产代码上两条都准确失败在“开始编辑 B 后 A 的 alert 应消失”，此前 A 草稿和错误保留断言通过。稳定修后 4 文件 13 项通过，Web vue-tsc/tsc、scoped diff 检查通过；新文件无空白问题，no-index 的 rc=1 仅表示文件有差异。Root 已逐读最终两行生产 diff、新测试及实际日志；没有重跑全量测试或更改旧测试。
- 本地页面闭环：在同一 ZCode 会话候选审查后，只构建并替换本地 gateway，build/up/单次 HTTP 检查均 rc=0、HTTP 200。gateway 从 a340c72a213c 更新为 dce87b4c1acf，API/worker/Postgres 身份和启动时间、网络与 127.0.0.1:18380 绑定保持；日志 /tmp/dt-r283-local/ 为 600。Root 重新加载后，从公开知识入口进入管理抽屉，以键盘重走目录与标签两条 A 保存失败→编辑 B 的路径：失败草稿保留，B 无旧错误、名称与焦点正确，Escape 关闭并回焦管理入口。修后图 /tmp/dev-toolbox-r283-{folder,tag}-after.png；两次合成 PATCH 均在浏览器内返回 503，意外请求与转发写入为零。全部临时拦截清除并返回首页，合成内容消失，浏览器 warn/error 为空。本轮未修改布局，未宣称额外设备矩阵或真实写接口验收。
- 执行与边界：新 ZCode 会话核实 BigModel 标准 GLM-5.3、最高思考、完全访问，Fast 保持、单主无子 agent；全局已知最多 3，原生 UI 与其他主控分时占锁。Root 独占更新本记录，源码改动未 commit/push；无服务器、Provider、云、OSS、备份恢复、版本号/tag 或正式验收变更。

## DT-R284｜安全页列表未知状态与操作失败的区分（2026-10-25）

- 问题与修复：设备列表读取失败时，安全页仍显示零设备、空设备说明及活跃/当前会话零计数。仅在 SecuritySettingsView.vue 增加 listsLoaded：每次读取开始置 false，两份列表均成功赋值后才置 true，用于显示两个列表区和依赖它们的摘要，共六行改动。独立登录验证区和 TOTP 标识保留；操作失败不改变列表已读取状态，因此设备改名失败仍保留已知列表、摘要与输入草稿。没有改认证、密码、恢复码、撤销、请求或 CSS。
- 必要验证：两个新组件/Pinia/公开 DOM 流程在旧代码上分别准确失败于初始假零态、重读失败后的缓存展示；修后 2/2、Web vue-tsc/tsc、scoped diff 检查均 rc=0，原测试未改。最小 memory router 的既有路由警告如实保留，不记为零 warning。Root 已读源码、测试和实际日志，并在 Native 核实退出码。只构建并替换本地 gateway：首次命令因 override 路径转录笔误在读配置阶段退出，修正后 build/up 均 rc=0、单次 HTTP rc=0/200；初始失败和成功均保留在 Native 工具历史。gateway 从 dce87b4c1acf 更新为 4e3564d640de，API/worker/Postgres 身份、网络及 127.0.0.1:18380 绑定保持。网关日志原为 644、HTTP 文件仅保存空响应正文；Root 将其修正为 600，并明确标注转录已展开的 Native 原始 rc/HTTP 回执，没有追加请求或重新构建。
- 实际页面验收：Root 重新加载新版本后，依次验证初始合成 GET 失败、重试在途、读取成功、合成改名失败仍保留列表与草稿、再次读取失败隐藏缓存、成功空设备列表保留当前会话 1 条。设备/会话 GET 各 4，浏览器内返回失败的 PATCH=1，意外请求及转发写请求=0。失败状态在 CSS 390、1024、1440、1920、3840 宽度均无文档/主区横向溢出，登录验证区保留；截图 /tmp/dev-toolbox-r284-read-error-{390,1440}-after.png 与稳定空态 -read-empty-after.png。临时拦截和视口覆盖已清除，返回首页后合成内容消失，浏览器 warn/error 为空。新 ZCode 会话核实标准 GLM-5.3、最高、完全访问，Fast 保持、单主无子 agent、全局已知最多 3；本会话实施与载入已自然结束。未 commit/push、更新服务器/其他服务、调用 Provider/云/OSS/备份，未改版本或正式验收状态。

## DT-R285｜可信设备改名回包与当前草稿归属（2026-10-25）

- 问题与修复：Root 已复现 A 改名在途时切到 B 输入草稿、或在 A 继续输入新名称，两种情况都会被 A 的旧成功回包关闭编辑框。仅调整 saveDeviceName：捕获本次提交的原始名称、trim 后发送，成功仍更新对应设备的已保存名称；只有当前编辑设备 ID 与原始草稿都仍对应本次提交，才退出编辑。保存中继续输入、编辑其他设备和正常成功收束均保留，未新增 busy 锁、序号、抽象或请求。
- 必要验证：原测试文件新增三条公开 DOM/Pinia/deferred fetch 回归，分别覆盖 B 草稿与 A 提交原文相同、同设备后续草稿、正常保存及 trim 请求值。旧生产上两条新用例准确失败于编辑框丢失，原两条与正常控制通过（2 failed / 3 passed）；修后 5/5、Web vue-tsc/tsc、scoped diff 均 rc=0。Root 与开工前内存基线比对，原两条测试逐字保留，生产文件在改名函数之外完全一致，R284 的列表读取状态及模板/CSS未变。日志 /tmp/dt-r285-local/ 为 600，最小 memory router 的已有路由警告如实保留。
- 本地与页面闭环：通过新 ZCode 会话完成候选，核实标准 GLM-5.3、最高、完全访问，Fast 保持、单主无子 agent、全局各项目最多一个执行 agent，已知合计最多 3。仅构建并替换本地 gateway，build/up/单次 HTTP 均 rc=0、HTTP 200，网关从 4e3564d640de 更新为 381b5d05dd96。Root 只读 inspect 确认 API/worker/Postgres 身份、启动时间和网络保持，仅网关绑定 127.0.0.1:18380。Root 新版本实际页面复验三条路径均通过：B 同名草稿保留且可继续编辑；A 后续草稿保留，取消后仍显示已保存第一稿；未改草稿的正常成功退出编辑并发送 trim 值。设备/会话合成 GET 各 3，受控成功 PATCH=3，意外与转发写请求为零。截图 /tmp/dev-toolbox-r285-device-{edit-late,same-edit}-after.png；全部拦截清除、首页恢复、合成内容消失，浏览器 warn/error 为空。未改布局，不重复响应式矩阵；未 commit/push、更新其他服务或服务器、调用真实 Provider/云/OSS/备份，未改版本或正式验收状态。

## DT-R286｜URL 转换与 Query 编辑结果的上下文归属（2026-10-25）

- 问题与修复：Root 在实际页面复现输入、编码/解码或范围变化后仍可复制旧转换结果，Query 行修改后仍可复制旧重建地址，以及更换源 URL 后仍可用旧 host/path 重建。仅在 UrlToolView.vue 增加输入、转换选项和 Query 行监听：输入变化撤下两个模式的旧结果与解析上下文；转换选项只清转换结果；Query 编辑只清重建结果，保留草稿。复制开始清旧反馈，异步完成时核对原模式与对应结果。保持同一输入下的模式切换缓存、重复参数和顺序；url.ts、旧三条模式用例及整个模板/CSS逐字保留，无新增框架、序号或依赖。
- 必要验证与审查修正：新增九条真实组件/DOM回归。首轮 RED 的同文复制夹具误用含百分号地址，已改为编码前后不变的 ASCII 地址；原失败日志保留，修正后的有效 RED 为 7 failed / 1 passed。首候选 17 项通过后，Root 发现 Query 深监听会吞掉解析失败错误，新增第九条先在候选上准确失败，再仅将清反馈限制为 parsed 存在时。最终 URL 三文件组 18/18、Web vue-tsc/tsc及 scoped diff通过。一次 scoped diff 命令引用错误修正后通过，未重复全量验证；日志 /tmp/dt-r286-local/。Root 逐读最终源码、用例和实际日志，并核对载入前后仍为同一候选。
- 本地与实际页面闭环：同一 ZCode 会话仅构建并替换本地 gateway，build/up rc=0，唯一一次 HTTP 检查的实际 stdout 为 curl_rc=0、http_status=200（gateway-http.rc 文件为空，不单凭它认定通过）。gateway 从 381b5d05dd96 更新为 a4a40db304b5；API/ai-worker/Postgres 身份、启动时间、网络及 127.0.0.1:18380 绑定保持。Root 在 localhost 重载后实测输入/选项变化清结果并禁用复制、同源模式缓存保留、Query 值/等号/增删行保留草稿与顺序、编辑焦点保持、更换来源撤下旧字段并重解析新地址、非法百分号错误可见且 aria-invalid=true、修正后正常解析重建，全部通过；三次正常复制内容正确并即时恢复原剪贴板。异步复制成功/失败与重试由组件 deferred 用例覆盖，未冒称浏览器权限拒绝实测。截图 /tmp/dev-toolbox-r286-query-invalidated-after.png、-invalid-url-after.png、-url-recovered-after.png。已清空输入并回首页，合成验收文本消失，浏览器 warn/error为空；未改布局，不重复设备矩阵。
- 执行与边界：新 ZCode 会话核实 BigModel 标准 GLM-5.3、最高、完全访问，Fast 保持、单主无子 agent；与另两主控分时持原子 UI 锁，已知全局最多三个执行者。候选实现和本地载入均已自然结束，Root 独占本记录。未 commit/push、改版本或正式验收结论，未更新其他服务、服务器、Provider、云、OSS或备份；原有用户待决保留。

## DT-R287｜JWT 复制反馈的结果归属与失败恢复（2026-10-25）

- 问题与局部修复：Root 在实际 localhost 页面复现合成 Token A 解码并复制 Payload 后，编辑为 B，解码区已撤下却仍显示 A 的复制成功提示。仅在 JwtToolView.vue 的既有 Token 监听清理 liveMessage；copyJson 开始清旧反馈/错误，捕获 decoded 对象，异步成功或失败时只向仍对应同一解码结果的页面显示反馈。密钥和 Claims 期望值变化不改变解码内容，因此不使用会被这些字段推进的 latestRunId 门控复制。当前复制失败保留结果及重试入口，重试成功清错误；不假称能撤销已发起的剪贴板写入。没有修改算法、验签判断、模板、CSS或引入新机制。
- 必要验证与审查：新五条公开 DOM/真实解码/受控 Clipboard 回归，旧生产 RED 为 4 failed / 1 passed，分别准确落在 Token 编辑残留提示、不同 Token 同文 Header 的迟到成功、清空后的迟到错误、失败后成功重试仍残留错误。Root 将第五条正向守卫从“编辑后才复制”收紧为“复制在途期间编辑密钥和 Claims，再完成复制”，不新增用例或重跑旧 RED。测试输入变化后最终三文件组 32/32（新5＋原9＋算法18）、Web vue-tsc/tsc通过；首轮及最终日志均保留在 /tmp/dt-r287-local/，权限600。Root 逐读最终源码和用例，核对原九条及 helper、jwt.ts、完整模板/CSS逐字保留，受影响 diff和新文件空白检查通过；载入后四个文件仍与已审候选相同。
- 本地与实际页面闭环：同一 ZCode 会话仅 build gateway、up -d --no-deps gateway和一次 HTTP检查，独立 rc 均为0，HTTP200。gateway 从 a4a40db304b5 更新为 c30ae6446464；Root inspect确认 API/ai-worker/Postgres 身份、启动时间、网络及 127.0.0.1:18380绑定保持。Root 重载新页面后复验复制→编辑 Token旧提示消失且新草稿/焦点保留、正常 Header/Payload复制、修改密钥与期望 iss后解码内容保留且仍能复制，四次复制 JSON与当前显示内容一致、均即时恢复原剪贴板；签名保持“未验证”，Claims按原合同恢复“未检查”。迟到成功/失败及权限拒绝后重试由组件 deferred用例覆盖，未宣称浏览器权限拒绝实测。截图 /tmp/dev-toolbox-r287-jwt-feedback-after.png 与 -jwt-copy-after.png。已清空全部合成输入并回首页，合成文本消失，浏览器 warn/error为空；未改布局，不追加设备矩阵。
- 执行与边界：新 ZCode 会话实际核实 BigModel标准 GLM-5.3、最高思考、完全访问，Fast保持，单主无子agent；与另两主控分时持原子UI锁，全局已知最多三个执行者。实现与载入均自然结束，Root独占本记录。未 commit/push、改版本或正式验收结论，未访问服务器、Provider、远程JWKS、云、OSS或备份；原有人工待决保留，持续进入后续产品迭代。

## DT-R288｜目录编辑上级候选排除自身子树（2026-10-25）

- 问题与局部修复：Root 在合成五节点树 A→child→grand、B→B-child 的实际页面确认，编辑 A 时 grand 仍可被选为上级；只查看并取消，未提交非法移动。后端 organization.go 的 folderIsDescendant 与既有 M2 集成用例明确拒绝循环移动。仅复用 LibraryManageDrawer.vue 的 flattenFolders，增加可选的整棵子树跳过参数，并为编辑 select 提供随 editingID/当前树计算的候选；新目录创建仍使用完整树。根目录、原父/祖先、其他分支、原选择、顺序缩进与焦点保留，不新增深度/重名规则或重复服务端校验。Root 比对确认除该 computed、遍历参数及编辑 v-for来源外，整个生产文件逐字保留，包含 R283 的两处错误清理；CSS、library.ts和原 R283 测试未改。
- 必要验证与夹具校准：新增三条公开 DOM/真实 Pinia/受控 fetch 用例，旧生产准确 RED为2 failed / 1 passed，分别在根/嵌套目录的后代仍进入选项处失败；合法 B移动作为原已绿控制。首候选五文件16/16、Web vue-tsc/tsc通过。Root发现合法移动夹具把 A插到 B-child前，与后端 MAX(sort_order)+1追加行为不符，仅校准该夹具和顺序断言；新文件3/3及受影响类型检查再次通过，生产和旧13条输入未变、不重复运行。原 RED与首轮日志保留，r2追加至 /tmp/dt-r288-local/，均600；Root逐读源码、用例及实际结果，受影响 diff和新文件空白检查通过，载入后仍为同一已审候选。
- 本地与实际页面闭环：同一 ZCode 会话只构建并替换本地 gateway，build/up/唯一一次HTTP检查实际rc均0、HTTP200，gateway从 c30ae6446464更新为0c67329bf69b。Root inspect确认 API/ai-worker/Postgres 身份、启动时间、网络及127.0.0.1:18380绑定保持。Root重载后实测根A候选仅根/B/B-child、嵌套child仍选原父A而排除child/grand、切换B后A子树恢复可选、创建候选始终完整，名称焦点及取消回焦正确。合法A→B移动后 fresh GET显示 B、B-child、A、child、grand，子树缩进正确、无错误、焦点回A编辑入口；再编辑A时原父B及候选仍正确。修前后合计合成 tree GET=3、tags GET=3、items GET=2，浏览器内返回成功的move POST=1，意外请求及转发写入=0，不代表真实数据库移动验收。关闭回焦首次以 textContent检查误判空值，实际是 aria-label图标按钮；经可访问名称与AX确认正确，没有据此改产品。截图 /tmp/dev-toolbox-r288-parent-{cycle-before,move-after,options-after}.png。全部临时拦截清除，回首页重载卸载合成状态，管理抽屉已无，浏览器warn/error为空；未改布局，不追加设备矩阵。
- 执行与边界：新 ZCode 会话实际核实 BigModel标准GLM-5.3、最高、完全访问，Fast保持，单主无子agent；与另两主控分时持原子UI锁，全局已知最多三个执行者。原生实施与载入均自然结束，Root独占本记录。未 commit/push、改版本或正式验收结论，未更新其他服务、服务器、Provider、云、OSS或备份；原人工待决保留，继续后续产品迭代。

## DT-R289｜已确认写入与目录刷新失败分开恢复（2026-10-25）

- 问题与完整局部修复：Root 实际页面复现创建 POST 已返回201，后续目录 GET失败却导致创建按失败收尾、原名称仍可重提且没有只读恢复入口。library.ts 七个目录/标签写方法现在仅在写响应成功后通过同一窄 helper刷新；刷新失败记录共享 navigationError，不再拒绝已确认的写入，真正写失败仍拒绝且不读取。loadNavigation 的直接调用继续抛出当前读取错误，原序号处理迟到结果。Nav与Drawer共用读取状态，读取中/失败时隐藏旧缓存操作和假空态，提供只发GET的“重新读取目录与标签”。匹配的提交稿按成功规则清理，新草稿保留；两步rename→move中真实move失败仍保留草稿与写错误，读取恢复不重放写入。Drawer统一处理读取在途/失败焦点，保存中可临时停靠容器，原正常成功回焦保持。Root核对原13个操作函数、R283/R288及其旧测试逐字保留；HTTP契约、后端与数据模型未改。
- 必要验证与审查补足：新store八例覆盖七个写方法及真正写失败控制，新Nav/Drawer集成五例覆盖初始读取、创建、编辑、标签删除与两步部分成功；旧library九例只补两条共享错误断言。旧生产首轮22项为15 failed / 7 passed，其中写失败仍拒绝/零GET的控制主体此前已正确，末尾共享字段因未实现而红。store最终17/17。初候选UI5通过后，Root拒绝其重试在途复活缓存与失焦：S1两例精确RED，再UI21通过；S1另修测试handler的Promise返回类型并复跑Nav5/check。Root再以自动刷新慢GET补现有编辑例，S2准确RED于焦点落body，统一停靠后UI21/21、check通过；未重跑未变的store17。实现者曾超范围运行一次knowledge目录23文件115项并通过，已纠正、不重复。Root实际运行既有impeccable detect.mjs查两个Vue得到rc0/[]；实现者自建grep自检不作为设计扫描结论。差异/新文件空白检查通过，日志 /tmp/dt-r289-local/ 权限600，RED、S1/S2分开保留；载入后七份已审文件与候选相同。
- 本地与页面闭环：同一ZCode会话只build gateway、up --no-deps gateway及一次HTTP检查，实际rc均0、HTTP200。gateway从0c67329bf69b更新为26f249801b55；Root确认API/ai-worker/Postgres身份、启动时间、网络与127.0.0.1:18380绑定保持。新页面验证初始读取失败不冒称空目录/标签、Nav只读重试在途不显示缓存且焦点有效；创建已确认后匹配稿清空、提示“更改已保存”、无写错误/旧行/假空态；1440与390无横向溢出，已显示的重试按钮实测44px。Drawer重试挂起时创建提交禁用、字段可编辑，含首尾空白的新B草稿在恢复后保留，创建仅一条。改名已确认后的慢GET中焦点实际停在manager容器，503后转重试；再读取后出现新名且未重放改名。修前后合成tree/tags GET各8、items GET2、浏览器内返回的创建POST2和改名PATCH1，意外请求与转发写入0，不代表真实数据库操作验收。截图 /tmp/dev-toolbox-r289-read-refresh-{1440,390}-after.png 与 -save-refresh-pending-after.png。全部拦截和挂起请求清除，视口恢复865，回首页重载卸载合成状态，浏览器warn/error为空；删除/两步move失败由组件回归覆盖，未冒称实际浏览器全流程。
- 执行与边界：新会话实际核实BigModel标准GLM-5.3、最高、完全访问，Fast保持，单主无子agent；与其他主控分时原子占UI锁，已知全局最多三个执行者。实现、S1/S2及唯一一次载入均已自然结束，Root独占本记录。未commit/push、改版本或正式验收结论，未访问服务器、Provider、云、OSS或备份。收尾观察到跨尺寸关闭后的回焦问题，列为下一轮候选，未在本轮宣称解决。

## DT-R290｜管理抽屉跨尺寸关闭后的有效回焦（2026-10-25）

- 真实问题与局部修复：Root 在已载入的 R289 页面仅合成目录、标签与条目 GET，复现 1440→390、390→1440、1440→1200 三条关闭路径均停在 BODY：原侧栏入口因紧凑导航关闭而 inert，或原移动入口已被响应式规则隐藏。LibraryManageDrawer.vue 只将关闭分支原 focus 调用替换为私有 restoreCloseFocus：依次尝试原控件、现有两处“管理目录与标签”入口及紧凑栏导航按钮，以浏览器原生 focus 后的 activeElement 确认落点，跳过 null/BODY。没有新增状态、可见性推断或通用焦点框架。Root 逆向文本核对，除关闭调用与该局部函数外整个 Vue 保持；模板/CSS、打开分支、R289 读取恢复、13 个操作函数、R283/R288 与旧测试均保留。
- 必要验证：新增 close-focus 四例，真实 Pinia/KnowledgeModuleNav 与页面入口夹具覆盖三种尺寸切换及打开前焦点为 BODY；仅对不可用入口实例模拟 jsdom 缺失的原生焦点拒绝，可用入口仍真实聚焦。首次夹具中的移动纯 DOM 按钮没有打开 handler，实施者改为聚焦后经公开 store 打开，再得到旧生产四例准确 RED（均为 BODY 未回目标按钮，无超时）；最终有效 RED 日志保留，早期夹具失败曾被同名日志覆盖，过程由 ZCode 终态说明，不声称所有原始失败文件均保留。稳定候选七文件 25 项通过（新 4＋既有 Drawer 16＋Nav recovery 5），pnpm check 通过；store 输入未变，未重跑其 17 项或扩大到全目录。Root scoped diff --check 与新文件空白核对通过。日志位于 /tmp/dt-r290-local/，目录 700、文件 600；本轮为脚本行为修改，未把自建检查器计作设计验证。
- 本地与实际页面闭环：同一 ZCode 会话唯一一次 build gateway、up --no-deps gateway、静态 GET 均 rc=0，HTTP200；新 gateway a0b13d1d4431，API 4730f9ed678c、ai-worker d97d089a87b3、PG a2d63860bea4 身份、启动时间及网络保持，唯一宿主绑定仍是 127.0.0.1:18380。Root 在新页面确认 1440 正常关闭回原侧栏按钮；1440→390 回移动管理入口，390→1440 回桌面管理入口，1440→1200 回“资料库导航”，均 connected、非 inert、焦点未落 BODY；紧接 Enter 后导航真实展开，再关闭仍回该按钮。修前与修后各只读目录/标签/条目 GET 一次，共各 2，意外请求和写入均为 0。修后图 /tmp/dev-toolbox-r290-close-focus-mobile-after.png 与 -middle-after.png（600）。拦截全部清除，视口恢复 865，回首页重载，管理抽屉与导航关闭、浏览器 warn/error 为空；不宣称物理手机或完整浏览器矩阵验收。
- 执行与边界：fresh ZCode 实际确认 BigModel 标准 GLM-5.3、最高、完全访问，Fast 保持；单主无子 agent，与其他项目分时使用 UI，已知总执行者不超过 3。实施与唯一一次载入均已自然结束，Root 已在本轮原生会话核实最终报告、空输入框及无停止生成按钮；交付源码与已审候选逐字相同。Root 独占本记录。未 commit/push、改版本或正式验收结论，未访问服务器、Provider、云、OSS、备份或新增依赖；人工待办继续保留。

## DT-R291｜阿里云设置读取失败的未知状态与只读恢复（2026-10-25）

- 真实问题与局部修复：Root 在旧页面仅合成 settings GET 503、usage GET 200，实际看到“尚未配置凭据”“云能力当前不可用”、空额度/默认摘要和可用的保存按钮。读取失败不能证明服务未配置。AliyunSettingsView.vue 仅补三处模板条件：上下文摘要和主表单要求无 pageError，保存按钮在 pageError 时禁用；复用既有 loading/pageError，没有新增状态或框架。标题、常驻边界说明、错误与原重试保留。Root 逐字还原确认除三条件及一条注释外全文件不变，读取、保存、删除逻辑、CSS、API 和凭据语义均未改。沿用既有 R1 设置骨架；Root 取回精确 Screen 41d4983dae7c4021a28381d9d0b88b91 并查看参考图，没有重做布局。
- 必要验证：既有 aliyunSettings.test.ts 只追加三例，handler 返回类型为 deferred 夹具局部放宽至 Response | Promise<Response>；原十例正文及 helpers 均由 Root 文本核对保留。新例覆盖 pending→503→重试在途→真实配置、PUT 确认后重读失败且不重放写入、账本单独失败仍可编辑。旧生产准确 RED 为 2 failed / 11 passed（13），两处都失败于应隐藏的凭据标题，无超时或装配错误；稳定候选 13/13、pnpm check 均 rc=0。真实 impeccable detect.mjs 针对本 Vue rc=0、无发现；实施者的 ~/.zcode 路径实际解析到 ~/.codex 同一脚本，没有自造 checker。scoped diff --check 通过；日志 /tmp/dt-r291-local/ 目录 700、文件 600。未运行全目录、完整 E2E 或重复其他轮次已过检查。
- 本地与实际页面闭环：同一 ZCode 会话唯一一次 build gateway、up --no-deps gateway 和静态 GET 均 rc=0，HTTP200；新 gateway 59984dce4bf4。Root 确认 API 4730f9ed678c、ai-worker d97d089a87b3、PG a2d63860bea4 的身份、启动时间和网络保持，唯一宿主绑定仍为 127.0.0.1:18380。新页面读取在途/失败不显示表单或摘要，保存禁用；Enter 原重试仅发 GET，在途保持未知，成功后显示合成返回的凭据掩码和五项实际值。真实未配置响应仍保留首次配置表单；仅账本失败时设置可编辑，改动额度草稿后只重读账本，草稿逐字保留。失败状态在 390×844、1024×768、1440×900、1920×1080、CSS 3840×2160 均无文档或主区横向溢出，手机深浅主题已查看。修前/后合计 settings GET 5、usage GET 6，API 意外请求和转发写入均 0；PUT 后读取失败由组件回归覆盖，浏览器没有保存或删除。编排两次误处理 CDP 流中已由浏览器处理的 Document 响应事件，遭失效句柄拒绝；查明事件类型后仅处理匹配的 API 请求，并继续原挂起 GET，没有重复构建或重放写入。截图 /tmp/dev-toolbox-r291-read-failure-{1440,390}-after.png 与 -390-light-after.png（600）。所有拦截和挂起请求清除，恢复深色、视口 865、首页重载，合成内容为零，浏览器 warn/error 为空；不宣称完整浏览器矩阵或真实云服务验收。

- 执行与边界：本轮 fresh ZCode 实际确认完全访问、BigModel 标准 GLM-5.3（Flash 未选）、最高思考，Fast 保持；单主无子 agent，与其他项目原子分时占用 UI，已知总数不超过 3。Root 已在本轮原生会话分别核实实施与本地载入最终报告、空输入框及无停止生成按钮，执行均已自然结束；载入后源码/测试与已审候选逐字相同，Root 独占本记录。未 commit/push、修改版本或正式验收结论，未访问服务器、真实 Provider、阿里云、OSS 或备份，未新增依赖；人工待办继续保留。

## DT-R292｜阿里云设置保存快照与更新草稿归属（2026-10-25）

- 真实问题：Root 在 R291 页面以浏览器内合成响应复现三个时序：输入 900001 点击保存，保存前 GET 挂起时改为 900002，实际 PUT 偷带了后来值；PUT 已提交 900001、响应挂起时输入 900002，成功重读把新草稿覆盖为 900001；保存后 GET 503，再手动只读重试也丢掉新草稿。两种有新草稿的情况仍显示“设置已保存”。修前图 /tmp/dev-toolbox-r292-draft-{pending,lost}-before.png（600），没有把合成 PUT 转发给 API。
- 局部实现：仍只改 AliyunSettingsView.vue 与既有 aliyunSettings.test.ts。保存开头用现有 AliyunSettingsFormInput 取一次点击快照，校验和 PUT 同用它，保留 PUT 前 GET 合同，字段继续可编辑。成功后仅在 ID、Secret 都未被改动时清整对凭据；七个配置字段只有仍等于点击快照才用服务端回显覆盖。页面内 pendingMergeBase 让保存后读失败的手动重试沿用同一归属，成功读取后释放，凭据/状态与账本照常刷新。通用成功反馈只属于没有后来编辑的提交，后续用户编辑立即清除；同步 watch 与程序性回写的 try/finally 守卫区分用户输入和服务端回显。Root 确认 loadUsage、删除/对话/策略区、R291 读取条件、原十三例正文与 helpers 保留，未建立通用表单框架、存储或 API。S1 审查只补一条赋值及注释，让恢复基准中的 ID/Secret 为空，避免保存后读取失败时继续持有已提交旧凭据，不动当前新凭据草稿。
- 必要验证：新增四条真实 DOM/deferred 回归，覆盖慢 preGET、慢 PUT 含新凭据对、保存后读失败与只读恢复、正常保存后编辑清反馈；mock PUT handler 仅局部扩为 Response | Promise<Response>。旧生产有效 RED 为 4 failed / 13 passed（17），分别准确失败于提交值、新草稿和两处过期成功反馈，无超时/装配错误。初候选 15/17，原正常保存例和新正常对照发现 nextTick 守卫复位顺序会清掉成功通知，改为同步 watch 和同步 try/finally 后 17/17。S1、最终 S2 都因实际源码变化各验证本文件 17/17、pnpm check 与 scoped diff --check 通过。S2 有一处模板文案变化，真实 impeccable detect.mjs 仅扫本 Vue，rc=0、无发现。red、首次失败 green、green-2、S1/S2 记录分别保留于 /tmp/dt-r292-local/（目录最初 755 由 Root 收为 700，文件均 600；Root 临时重复副本确认与原件相同后已去重）。未跑全目录或完整 E2E，未新增只镜像静态文案的测试。
- 两次本地载入与页面审查：首批只 build/up --no-deps gateway/单次静态 GET，均 rc=0、HTTP200，59984dce4bf4 更新为 4966f5949d18。首批真实页面数据流程均通过，但 Root 看到未保存 B 的摘要旁仍写“配置已保存”，与其仅检查 credentialsConfigured 的真实条件不符。S2 仅将这一处字面量改为“凭据已配置，尚未实调验证”；其余脚本、结构、CSS、测试逐字不变。因该实际修正再载入第二次 gateway，三步同样通过，最终为 40c091e77821，不把本轮说成只载入一次。Root 独立确认 API 4730f9ed678c、ai-worker d97d089a87b3、PG a2d63860bea4 身份、启动时间、健康状态及网络保持，唯一宿主绑定仍为 127.0.0.1:18380。
- 实际页面闭环：首批验证 preGET 期间改五项数值和专业场景，PUT 仍完整提交 A，六项 B 保留；只有再次显式保存才提交 B，之后编辑立即清旧反馈。390 下慢 PUT 保留新额度及关闭自动专业版；保存后读 503 时继续隐藏未知状态、禁用保存，手动重试在途不显示表单，成功后 B 恢复，PUT 未重放。最终 S2 再以 preGET 暂停重放全部七项配置编辑，完整 A 请求与 B 表单同时正确，新侧栏文案准确且无通用已保存通知。390×844、1024×768、1440×900、1920×1080、CSS 3840×2160 均无文档或主区横向溢出，手机深浅主题已查看。修前、首批和最终确认合计目标 settings GET25、usage GET17、浏览器内合成 PUT8，意外目标请求与转发写入均 0；凭据草稿由组件回归验证，浏览器未输入或修改真实凭据，不冒称真实数据库或云调用验收。最终图 /tmp/dev-toolbox-r292-save-draft-{1440,390}-final-after.png 与 -390-light-final-after.png（600）。全部拦截/挂起请求已清理，恢复深色、视口 865、首页重载，合成内容为零，收尾 warn/error 为空。
- 执行与边界：fresh ZCode 实际确认完全访问、BigModel 标准 GLM-5.3、最高思考，未调整 Fast；单主无子 agent，与其他项目分时原子占 UI 锁，已知总执行者不超过 3。初实现、S1、两次载入及 S2 均已在本轮原生会话观察到最终报告、空输入框、无停止生成按钮；最终源码与已审候选逐字相同，Root 独占本记录。保留其他既有 dirty；未 commit/push、改版本/tag/正式验收，未访问服务器、真实 Provider、阿里云、OSS 或备份，未新增依赖，人工待办保持。

## DT-R293｜阿里云账本读取归属与在途反馈（2026-10-25）

- 真实问题：Root 在 R292 页面用浏览器内合成响应复现三条路径：初始账本读取挂起，正常保存后较新读取已得到 used250/reserved5，迟到的旧成功100/0却覆盖新卡片与校验提示；相同顺序下旧503清掉新账本并显示过期错误；已有账本在保存刷新及失败后重试期间仍展示旧数值、没有读取状态。修前截图 /tmp/dev-toolbox-r293-old-ledger-error-before.png（600）。这些请求只在浏览器内响应，没有转发配置写入。
- 局部实现：唯一产品改动仍为 AliyunSettingsView.vue 与既有 aliyunSettings.test.ts。loadUsage 增加本页递增序号与 usageLoading；开始即清旧账本/旧错误并标记读取，成功或错误先收集到局部变量，仅通过一次当前序号判断后统一落地三项状态。原卡片提示槽增加 role=status 的“正在读取本月账本…”，额度提示同步读取状态，侧栏月份显示“读取中”。无新增 CSS、缓存、轮询或通用框架。Root 逐字确认 R291 读取门控、R292 点击快照/草稿合并/凭据及保存反馈、其余脚本和页面结构保持。usage 为 null 时沿用已有本地校验分支，服务端422仍为额度约束的权威，账本读取不锁表单。
- 必要验证：原17例正文/断言与 helpers 保持，仅将 usage mock 扩成可计数的 deferred 返回；新增三例对应旧成功、旧失败、刷新等待→当前失败→只读重试与草稿保留。旧实现有效 RED 为3 failed/17 passed，准确命中旧数值与新数值缺失，无超时或装配失败；最终20/20、pnpm check、真实 impeccable detect.mjs 针对本 Vue、scoped diff --check 均 rc=0。实施者另做了一次实际 detector --json 复核得到[]，不将其算作独立发现；Root未重复已过检查。日志 /tmp/dt-r293-local/（700，文件600），未跑全目录或完整E2E。
- 本地构建异常与恢复：本轮有三次条件不同的构建尝试。标准输入先在解析 docker/dockerfile:1.7 前端元数据时以8073!=7735 size validation失败，未编译源码、未执行up/GET；这不足以断言本地缓存损坏。第二次仅用 /tmp 中原Dockerfile去首行的临时副本，但Bake拒绝读取上下文外文件，仍未编译或更新服务。Root查阅 [Docker syntax说明](https://docs.docker.com/reference/dockerfile/#syntax) 与 [Bake文件系统权限说明](https://docs.docker.com/reference/cli/docker/buildx/bake/)，选择把相同副本临时放入既有deploy构建上下文，保留Bake、BuildKit及原权限设置。进程内比较确认最后一份Compose覆盖只有gateway.build.dockerfile不同，命名agent_console_web上下文、端口/网络及其他服务不变；第三次实际build/up --no-deps gateway/单次CLI GET均rc=0、HTTP200。原Dockerfile、compose与.dockerignore无改动；新建deploy临时文件完成后已删除，仅保留/tmp失败与成功日志。没有prune、pull重试、放宽fs权限、改变共享builder/registry/全局配置或重启运行时。当前gateway为3c70300b37ee；API4730f9ed678c、ai-worker d97d089a87b3、PG a2d63860bea4身份/启动时间/健康状态及网络保持，唯一宿主绑定127.0.0.1:18380。Root一次批量inspect因gateway没有Health字段而模板报错，随后只读补取gateway所需字段，未因此重复构建或请求。
- 实际页面闭环：新页面初读及刷新在途均隐藏旧卡片/旧校验数，显示状态和“读取中”，表单仍可编辑；新成功250/5/900001后释放旧成功或旧503，三卡仍为新账本、无旧错误。输入200正确按255下限阻止，目标GET/PUT计数零增加。当前读取503准确展示错误；Enter重试只增加usage GET一次，在途状态正确，成功后新卡片恢复、未保存900002逐字保留且无过期保存反馈。390×844、1024×768、1440×900、1920×1080、CSS3840×2160五档读取态无文档或主区横向溢出，手机深浅主题已查看。修前与修后合计settings GET18、usage GET14、浏览器内合成PUT6，意外目标请求与转发写入均0；不冒称真实凭据、数据库或阿里云调用验收。截图 /tmp/dev-toolbox-r293-latest-ledger-{1440,390}-after.png、/tmp/dev-toolbox-r293-ledger-pending-390-after.png及-390-light-after.png（600）。挂起请求/拦截已清除，恢复深色、视口865、首页重载，合成内容为零，收尾warn/error为空。
- 执行与边界：fresh ZCode实际确认完全访问、BigModel标准GLM-5.3（Flash未选）、最高思考，Fast保持；单主无子agent，与其他项目原子分时占用UI，已知总数不超过3。Root在本轮原生会话观察到实现和三次构建尝试的最终报告、空输入框及无停止生成按钮，全部自然结束；最终源码/测试与已审稳定候选逐字一致，Root独占本记录。保留其他dirty，未commit/push、改版本/tag/正式验收，未访问服务器、真实Provider、阿里云、OSS或备份，未新增依赖，人工待办保持。

## DT-R294｜摘要校验值只规范化约定的 ASCII 空白（2026-10-25）

- 真实问题与合同：Root在18380摘要页用真实Worker计算公开abc向量后，给期望值两端各加U+00A0（66字符），页面仍显示“校验值相同”；合法摘要中间含U+000B纵向制表符时却判无效。docs/09 §7.6、docs/12 §6.6与页面placeholder均限定大小写、ASCII空白及可选0x前缀。修前图 /tmp/dev-toolbox-r294-nonascii-checksum-before.png（600）。问题来自normalizeExpectedDigest的trim吞掉Unicode两端空白、字符类漏VT，未将其扩大为算法或页面重设计。
- 最小实现：唯一生产改动为digestRunner.ts一行，先移除HT/LF/VT/FF/CR/空格六种ASCII空白，再去一次前导0x并转小写。非ASCII字符保留，交给既有十六进制/长度验证判invalid，不能被吞成match或empty。compareDigest其余部分、Runner/Worker、4MiB分块、取消与本地处理保持。Root逐字对比确认DigestToolView.vue及其测试均未变，原digest八项测试正文/断言保留，只在digest.test.ts新增三例18行；不可见字符最终用显式Unicode转义表达。
- 必要验证：旧生产有效RED为2 failed/9 passed（11），分别是含VT的合法值应match却invalid，以及NBSP两端应invalid却match；纯ASCII空白的empty对照原本就通过，无超时/装配错误。稳定候选一次运行digest.test.ts 11/11与直接消费者DigestToolView.test.ts 8/8，共19/19；Web pnpm check与scoped diff --check均rc=0。日志 /tmp/dt-r294-local/（700，文件600），Root读取原结果而未重复运行；未跑全库或完整E2E，未为未改的模板/CSS追加设计扫描。
- 本地载入：没有新环境证据，不重复R293已失败的标准远端前端构建。沿用上一轮成功的上下文内临时Dockerfile方案，仅去syntax首行，Root读到临时正文与原余下字节精确相同；末尾Compose覆盖仅一个dockerfile字段。实施者进程内比较两份配置，保留四服务、命名agent_console_web上下文和端口/网络，不输出私有配置。一次build gateway→up --no-deps gateway→单次CLI GET均rc=0，HTTP200/正文0字节。新gateway84a351290644替换3c70300b37ee；Root确认API4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4身份/启动时间/健康状态/网络保持，宿主唯一绑定127.0.0.1:18380。deploy临时文件已删除，原Dockerfile/compose/.dockerignore无diff；未改共享builder/registry/缓存/全局配置或FS权限，标准构建异常仍按R293待核实项保留。
- 实际页面与收口：新预览真实Worker再次计算abc正确向量，分别验证NBSP两端无效、VT+0x匹配、六种ASCII空白+大写前缀匹配、NBSP-only无效、ASCII-only无结论、真实不同值显示不同；输入焦点与复制可用状态保持。Shift+Tab从期望值回到复制按钮，Tab能返回原输入。无效值状态在390×844、1024×768、1440×900、1920×1080、CSS3840×2160无文档或主区横向溢出，手机深浅主题已查看；图 /tmp/dev-toolbox-r294-nonascii-checksum-{1440,390}-after.png及-390-light-after.png（600）。清空后原文、摘要和比较结论均空且复制禁用；恢复深色、视口865、首页重载，warn/error为空。本轮未使用API fixture或剪贴板替身，不将页面复验冒称完整浏览器矩阵、真实云服务或文件上限验收。
- 执行与边界：fresh ZCode实核完全访问、BigModel标准GLM-5.3 Value1/Flash0、最高思考，Fast保持；单主无子agent，与其他项目按原子锁分时操作UI，已知总数不超过3。Root分别在本轮原生会话核实实现与本地载入最终报告、空输入框、无停止生成按钮，均自然结束；载入后四个相关源码/测试文件与已审候选逐字相同，Root独占本记录。其他dirty保留，未commit/push、改版本/tag/正式验收，未访问服务器、Provider、阿里云、OSS或备份，未新增依赖；原人工待办保持。

## DT-R295｜工具搜索变化时重新展开结果分组（2026-10-25）

- 真实问题：Root在摘要工具页先折叠“编码与数据”，再搜索json；1440和390抽屉都显示2个匹配，却没有JSON/YAML可见入口。非空json下折叠“在线能力”再改ocr，同样计数1、入口隐藏。静态open与非空查询间恒true的绑定不会重新打开已被手动折叠的details，原watch又只寻找当前工具组。修前图 /tmp/dev-toolbox-r295-hidden-search-match-before.png及-390-before.png（600）。初次自动化把原生AX的summary按钮直接作role=button定位未匹配，改用其实际文本点击；getClientRects在此闭合details仍返回矩形，Root随即修正记录，以closed祖先、AX、role定位可见性及截图交叉确认，未把矩形当作可见证明。
- 最小实现：Root已读取DESIGN/docs07/docs12导航合同，并按精确R1 Screen f35fd8e5e10240be963e69a841e9a514取图查看，保留既有搜索分组骨架。只在ModuleNav.vue现有route.name与normalizedToolQuery监听的nextTick后，非空查询时主动展开工具分组，空查询仍按原逻辑展开当前工具组；同路由同规范化查询下的手动折叠保持。未新建状态、监听、定时器或存储。Root逐字确认模板/CSS/过滤函数、watch前所有脚本与原currentGroup之后尾部完整保留。
- 必要验证：既有ModuleNav.tools-navigation.test.ts只新增两条57行，原5例及helpers逐字保持。桌面折叠编码组→json，与compact在json下折叠在线组→同规范化查询保持→ocr重开，旧生产有效RED为2 failed/5 passed，失败都准确落在open应true却false，无装配/超时问题；稳定候选7/7、Web pnpm check、真实impeccable detect.mjs仅扫本Vue、scoped diff --check均rc=0。detector文本模式零发现静默，实施者只读核对过CLI扩展名/输出与项目忽略条件，没有追加JSON扫描或自建checker。测试stderr有既有helper未注册/help的router提示（原compact例与新compact例各一），未将其当生产故障或改动原helper。日志 /tmp/dt-r295-local/（700，文件600）；未跑全目录或完整E2E，Root未重复已过检查。
- 本地载入：沿R293/R294已验证的上下文内临时Dockerfile办法，仅去syntax首行；Root读到临时正文与原余下字节精确相同，最后一份Compose覆盖仅一个dockerfile字段。两份配置由实施者进程内比较，四服务、agent_console_web命名上下文、端口/网络保持，未输出私有配置。一次build gateway→up --no-deps gateway→单次CLI GET均rc=0、HTTP200/正文0字节，新gateway bdb9f7a10d4f。Root独立确认API4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4身份/启动时间/健康状态/网络保持，唯一宿主绑定127.0.0.1:18380。临时deploy文件已删，原Dockerfile/compose/.dockerignore无diff；没有改共享builder/registry/缓存/权限或重试标准外部前端，R293异常继续待核实。
- 实际页面闭环：桌面与390均在折叠后输入json自动显示JSON/YAML两入口并保持搜索焦点；改大小写/尾空格仍属同一规范化查询，手动折叠不被撤销；新jwt或ocr查询会重开相应组。无匹配时显示可恢复提示，清空后恢复十项元数据并展开当前摘要组。桌面和手机通过Enter真正进入JSON工作台且导航标记当前页；手机初开聚焦关闭按钮，Escape关闭回“工具列表”，重开保留当前查询，键盘进入工具后抽屉关闭并回有效入口。390×844、1024×768、1440×900、1920×1080、CSS3840×2160下匹配链接可见，文档/主区/导航均无横向溢出，手机深浅主题已查看。图 /tmp/dev-toolbox-r295-search-results-{1440,390}-after.png、-390-light-after.png与/tmp/dev-toolbox-r295-search-navigation-1440-after.png（600）。恢复深色、865、首页重载，导航关闭、测试查询已清，收尾warn/error为空；未用API fixture、未执行云OCR或AI外发，不冒称完整浏览器矩阵验收。
- 执行与边界：fresh ZCode实核完全访问、BigModel标准GLM-5.3 Value1/Flash0、最高，Fast保持；单主无子，与其他项目原子分时占UI，已知总数不超过3。Root分别看到实现与本地载入最终报告、空输入框、无停止生成按钮，两阶段自然结束；曾准备收束额外调查，复核时已自然终态，实际未点击停止。最终两源码/测试文件与已审候选逐字相同，Root独占本记录。保留其他dirty，未commit/push、改版本/tag/正式验收，未访问服务器、Provider、阿里云、OSS或备份，未新增依赖；人工待办保持。

## DT-R296｜三路独立修复状态刷新、摘要复制与 Base64 迟到粘贴（2026-10-26）

- 执行方式已按用户新指示切换：本 Root 只通过 Computer Use 控制 dev-toolbox 的三个独立 ZCode 会话，每个实际核实完全访问、BigModel 标准 GLM-5.3（Flash 未选）、最高思考，Fast 保持；不开子 agent，不再向其他 Codex 会话发送协调消息或读取进度。三路文件 owner 不重叠，Root 独占本记录；原生 UI 仅在点击片段持原子锁并 finally 释放，不在推理或等待期间占锁。A/B/C 及后来指定 A 执行的唯一集成阶段均已看到最终报告、空输入框、无停止生成按钮，自然结束。
- A：OperationsStatusView.vue 仅在 loadStatus 开头增加 status.value = null，刷新在途及失败不再把旧健康 badge、状态主体和侧栏当成当前快照。原三例/helpers 保留，新增一条完整 deferred 回归，旧生产有效 RED 1 failed / 3 passed，修后 4/4。最初 pnpm -C 的 EACCES 是命令调用问题，随后 cd && pnpm exec 的 RED 才是缺陷证据；既有 router helper 未注册 settings 子路由的警告不视为生产故障。日志 /tmp/dt-r296-a-local/。
- B：DigestToolView.vue 的既有复制按钮显示“已复制”，仍为同一按钮并保留焦点；复制序号只让当前结果与当前复制请求的成功/失败显示反馈，旧计时器在新操作时清理，输入变化、重算及卸载作废旧反馈。CSS、算法、Worker、4 MiB 分块均未改。原八例正文/helpers 保留，新三例旧生产 RED 3 failed / 8 passed，修后 11/11；计时器用例在旧版先被可见文案断言挡住，不声称旧版计时器后半段也单独运行到 RED。日志 /tmp/dt-r296-b-local/。
- C：Base64ToolView.vue 为异步粘贴捕获输入上下文，只有仍属于该上下文的成功/失败可回写；复用 invalidateResult 推进归属，覆盖手输、清空、执行、交换及操作/变体切换。Root 在初候选 14 项通过后发现 fieldset 变更遗漏，要求同会话增加模式切换单例，得到准确 RED 1 failed / 14 passed 后最小补齐，最终 15/15。初版旧生产定向 RED 4 failed / 1 passed / 9 skipped；原九例及已有新增正文保留，最终整个模板/CSS 与修前逐字相同。日志实际位于被忽略的 logs/tmp/dt-r296-c-local/，保留原路径，不迁移重跑。
- 验证边界：三路共 30 项相关测试通过，未跑全库或完整 E2E；A/B 真实 impeccable 检测零发现，C 检测 rc=2 仅指出原有 privacy-note 的 3px 左边框，CSS 未变，作为后续样式候选保留，不能报告全部扫描通过。owner diff --check 通过。各日志目录 700、结果文件 600。候选冻结后唯一一次 Web vue-tsc/tsc、gateway build、up --no-deps gateway、CLI GET 均 rc=0，HTTP200；集成日志 /tmp/dt-r296-integration/。沿 R293 已验证的上下文内临时 Dockerfile，仅去 syntax 首行，正文精确比较、配置唯一 dockerfile 路径差异已核实，临时 deploy 文件已删除，原 Dockerfile/compose/.dockerignore 无 diff。新 gateway f934be210f2b，API 4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份/启动时间/健康状态/网络保持，唯一宿主发布仍为 127.0.0.1:18380。
- 实际页面：状态页成功快照→慢刷新→503→键盘只读重试→新快照，旧 badge/版本/主体/侧栏在途及失败均撤下，恢复仅显示新快照。有效 fixture 只处理三个 XHR GET、零转发写入；前面自动化曾因旧 tab 闭包、页面未挂载及 CDP Document 限制中止并清理，未得到有效修前图，不当作产品故障或有效请求证明。摘要真实 Worker 计算 abc、实际复制内容正确、可见成功与同按钮焦点保留，编辑后结果/复制提示立即清除；Base64 真实剪贴板粘贴公开合成文本、编码、交换、解码均正确。迟到 Clipboard 边界由 deferred 回归覆盖，不冒称真实权限拒绝验收。三页 390/1024/1440/1920/CSS3840 无文档或主区横向溢出，B/C 手机深浅主题已查看。截图 /tmp/dev-toolbox-r296-status-read-failure-{1440,390}-after.png、-digest-copy-{1440,390}-after.png、-digest-copy-390-light-after.png、-base64-paste-1440-after.png、-base64-390-after.png、-base64-390-light-after.png（600）。原剪贴板已恢复且内存副本释放；所有拦截/挂起请求已清，恢复深色、865、首页重载，收尾 warn/error 为空。八份相关源码/测试与已审候选逐字相同。
- 收尾另实测状态重试按钮卸载后焦点落 BODY，列入下一轮独立修复；本轮只解决快照真实性，不宣称焦点问题已解决。其余 dirty 保留，未 commit/push、改版本/tag/正式验收结论，未访问服务器、真实 Provider、阿里云、OSS、备份或新增依赖；人工待办继续保留。

## DT-R297｜读取恢复焦点、复制请求归属与手机当前导航（2026-10-26）

- A：OperationsStatusView.vue 用户触发的刷新/重试在 nextTick 后聚焦既有读取提示，读取提示补 tabindex=-1、polite live 与装饰 spinner 隐藏；失败回到可重试按钮，成功回到已解锁的刷新。只有结束后焦点已落 BODY/null 才回焦，等待期间移到别的控件则保留；初次自动读取不接管焦点。保留 R296 的 status=null、旧快照撤下、真正 disabled 与只读单 GET，没有轮询或全局焦点框架。原四例及 helpers 保留，新增三个 DOM/deferred 回归；旧生产 RED 3 failed / 4 passed，GREEN 7/7。第三例在等待落点断言先红，用户移开后的保留属于正向守卫，未冒称旧代码会主动抢焦点。既有 router helper 未注册 settings 子路由仍有提示，实施报告“无 Vue 警告”不能覆盖该原始日志事实。
- B：共享 CopyButton.vue 用同一个递增序号替换字符串相等判断，成功/失败只归属最新调用；text 变化和卸载推进序号并清 timer，label 不推进。原生剪贴板、1600ms 成功反馈、同一按钮、模板/CSS 与公开 props/error 事件保持。原六例原文不动，新增四例，旧生产 RED 4 failed / 6 passed，GREEN 10/10。新成功后旧失败、新失败后旧成功、A→B→A 均有准确失败证据；卸载例的 RED 是迟到成功仍创建计时器，卸载后 error 事件原本已由 Vue 运行时抑制，未把原本正确部分说成新修复，也不声称能撤销已开始的系统写入。JSON/YAML/翻译/OCR/认证消费者只读定位，未修改。
- C：390 实测“设置”入口右缘 316 超过 nav 右缘 294，当前入口被裁 22px。AppRail.vue 只给既有 nav 加 ref，以局部几何比较调整自己的 scrollLeft；挂载、当前入口身份变化及 ResizeObserver 发现 nav 尺寸变化时才揭示被裁入口，卸载断开 observer。不调用 scrollIntoView，不改焦点/主区纵向滚动；同入口用户横向浏览和模块内路由切换不强拉回。整个 CSS、链接顺序/语义、退出逻辑及原 logout 两例原文保持。新四例局部几何夹具 RED 4/4 均准确落在 0 应为 22（末例先在初始揭示处红，后面的手动滚动片段为正向控制）；GREEN 新四例＋原两例 6/6。RED 后只补夹具缺失路由消除新增 RouterLink 提示，没有改变断言。
- 必要验证与本地载入：三路共 23 项 focused 测试通过；三个真实 impeccable 检测器 rc=0、零发现，owner diff --check 干净。日志 /tmp/dt-r297-{a,b,c}-local/（700，文件600）。候选冻结后唯一集成执行者 C 只跑一次 Web vue-tsc/tsc、配置比较、gateway build、up --no-deps gateway、CLI GET，实际 rc 均0、HTTP200/0字节；日志 /tmp/dt-r297-integration/。沿 R293 内置前端临时输入办法，Root 实读临时普通文件600、正文与原去 syntax 首行余下字节相同，配置唯一差异为 dockerfile 路径；临时 deploy 文件已删，原 Dockerfile/compose/.dockerignore 无 diff。新 gateway 67ffefa4ca67，API4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4 的身份/启动时间/健康状态/网络保持，唯一宿主绑定127.0.0.1:18380。未重复旧远端前端失败、全量测试或完整 E2E。
- 浏览器闭环：修前重试在途及成功均实测 BODY。修后初次失败保留用户原已聚焦控件；Enter 重试在途聚焦可感知读取提示，失败回重新读取；Shift+Tab 移到既有设置链接后，迟到成功保持该链接；正常刷新在途保持有效落点、旧版本撤下，成功回可用刷新。手机初始设置入口 scrollLeft=22、左右缘254/294完整可见；用户横向滚回0不被拉回且主区不动，去工作台仍0，历史返回设置重新22。390/1024/1440/1920/CSS3840下当前入口完整，文档/主区无横向溢出，手机深浅主题已查看。受控状态 fixture 修前2、修后焦点4、导航2个 GET，零写入转发，不代表真实云/备份验收。截图 /tmp/dev-toolbox-r297-status-retry-focus-before.png、-status-retry-pending-1440-after.png、-global-nav-current-390-{before,after}.png 及 -global-nav-current-390-light-after.png（600）。
- 共享复制真实消费者：JSON 工作台用原生聚焦后的全选/粘贴替换默认样例，本地格式化后实际复制公开 JSON，剪贴板内容准确、同按钮焦点保留、桌面/390均可见“已复制”；清空后复制禁用并恢复原标签。按元素准备 Monaco EditContext 输入曾遭工具超时，改为向已聚焦编辑器直接发送原生按键/粘贴后完成，没有改编辑器或调用隐藏运行状态，也未将工具失败当产品故障。清空时两个 role=alert 经定向读取确认为空的 monaco-alert 播报节点（1×0），不是复制错误。图 /tmp/dev-toolbox-r297-json-copy-{1440,390}-after.png（600）；迟到 Clipboard 由组件 deferred 回归覆盖，未冒称真实权限拒绝或 OS 写入顺序验收。
- 收尾：全部合成拦截与挂起请求清除、原剪贴板恢复且内存副本释放，深色/默认视口恢复（最终实测1280）、首页重载，合成文本与 alert 均无，warn/error为空；十三份相关源码/测试与已审候选逐字相同。三个 fresh ZCode 均实际核实标准 BigModel GLM-5.3、最高、完全访问，Fast 保持，无子 agent；实现与唯一集成阶段均自然终态、空输入框、无停止按钮。继续只做本 Root 三路独立控制，未跨 Codex 协调；其他 dirty 保留，未 commit/push、改版本/tag/正式验收，未访问服务器、真实 Provider、阿里云、OSS、备份或新增依赖。原人工待办保持。

## DT-R298｜正则操作焦点、Base64复制恢复与44px顶栏（2026-10-26）

- A：Root 在真实 Worker 默认运行完成2匹配后复现焦点落 BODY。RegexToolView.vue 仅一行模板改动，将 v-if/else 的运行/取消两个 UiButton 合为同一按钮，按 running 改文案、variant 和调用；脚本/CSS、Worker、取消/限额/结果合同不变，无程序化 focus。新 focus 四例旧生产 RED 3 failed / 1 passed，不抢他处焦点的对照原本通过；稳定候选新四例＋原 bounded 一例＋staleResult 五例，共10/10。原测试及 helpers 原文保持。
- B：Base64 复制以既有 inputContext 的只读快照＋当前 copyContext 序号判断归属，输入/结果变化后旧回调丢弃，同文本后发调用优先；复制不推进输入归属，R296粘贴合同保持。保存/清理唯一反馈 timer，复制错误用局部 copyError，当前复制失败不再标记有效输入非法，成功只清复制错误。原15例保留，新增四例旧生产准确 RED 4 failed / 15 passed，首候选19/19。Root另在真实页面两次复制，第一次成功后2321ms、第二次发起后1306ms提示已空，独立证实旧timer截断较新反馈；原剪贴板当轮恢复。
- B的审查补漏：首候选卸载只清已有 timer，等待中的复制成功仍可重建 timer；errorMessage优先又会遮住“粘贴读取失败但结果保留”之后的复制失败。Root要求同会话新增两例，当前19候选上定向 RED 2 failed / 19 skipped，分别准确得到卸载后timer数1、notice仍为旧读取错误。最终只在卸载推进copyContext并清timer、notice优先copyError两处增量，完整21/21；读取错误字段/输入关联和原19例/helper原文保持。原RED/GREEN与S1分开保存于 /tmp/dt-r298-b-local/{red,green,s1}/。两次相对路径检测器调用未读到目标属无效执行，绝对路径实际检测及S1最终检测均rc2，仅原有privacy-note 3px边框，CSS未改。
- C：Root实测390下六个全局入口及主题/退出共八个已渲染操作均40×44px。AppRail.vue仅把≤520px的min-width从40改44，其余整个文件逐字保持，含R297当前入口揭示、路由/尺寸观察、手动滚动与退出行为。CSS尺寸不依赖jsdom结果，按约定未新增镜像样式测试，也未重跑原六例；由Root真实浏览器验收。C检测器rc0；A检测器rc2仅原有匹配卡片3px左边框，CSS同样未改，不能称所有扫描通过。三路owner diff --check干净，最终共31项相关测试通过；没有全库或完整E2E。
- 唯一汇总与本地载入：候选冻结后C只跑一次Web vue-tsc/tsc、Dockerfile字节比较、配置比较、gateway build、up --no-deps gateway和CLI GET，实际rc均0、HTTP200/0字节，日志 /tmp/dt-r298-integration/。沿R293内置前端临时输入，Root实读普通文件600、内容与原去syntax首行余下字节相同；配置唯一差异dockerfile路径，原Dockerfile/compose/根与deploy的dockerignore无diff，临时deploy文件已删。误写的小覆盖路径 /tmp/dt/r298-does-not-exist 已当轮删除，Root确认该文件不存在。新gateway7b5e0ad62cbd；API4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4的身份/启动时间/健康状态/网络保持，唯一宿主绑定127.0.0.1:18380；未重试旧远端前端、改builder/registry/权限或更新其他服务。
- 实际页面：正则Enter成功2匹配、无效表达式失败、修改后再次成功1匹配，三次焦点均留在运行按钮，字段正常解锁；等待取消与用户移焦由deferred组件例覆盖，未冒称浏览器灾难性表达式/500ms压力验收。Base64两次实际复制后，第一次成功后2268ms、第二次发起后1260ms仍显示“结果已复制”，随后正常到期；桌面/390实际剪贴板均为当前公开向量、同按钮焦点保留，手机有效输入aria-invalid=false，编辑后旧结果/提示清除且复制禁用。原剪贴板恢复、内存副本释放；拒绝/迟到/卸载/混合错误由组件例覆盖，未冒称真实权限拒绝或撤销OS写入。
- 尺寸与导航：三页均验390/1024/1440/1920/CSS3840，文档和主区无横向溢出。手机八个已渲染操作本征尺寸均44×44，设置当前入口随新滚动槽正确到scrollLeft54并完整可见；手动左滚0后不被拉回、主区和焦点保持，工作台0，历史返回设置54，跨尺寸回手机仍正确，深浅主题已查看。仅状态页合成2个GET、零转发写入，不代表真实云/备份验收。截图 /tmp/dev-toolbox-r298-regex-keyboard-focus-before.png、-regex-keyboard-focus-{1440,390}-after.png、-base64-copy-timer-before.png、-base64-copy-timer-1440-after.png、-base64-copy-390-after.png、-44px-navigation-390-after.png及其-light-after.png（600）。
- 收尾：所有挂起请求/拦截清除，深色/默认视口恢复（1280）、首页重载，合成文本和alert无、warn/error为空；集成后17份相关源码/测试与已审候选一致。最终权限审查发现A六个结果文件非600、B父目录755，已仅chmod修正为结果600/目录700，原内容保留，未因此重跑测试。三路fresh标准BigModel GLM-5.3、最高、完全访问逐会话实核，Fast保持，无子agent；实现、S1和唯一集成阶段均自然终态、空输入框、无停止按钮，仍仅本Root三路独立控制，不跨Codex协调。其他dirty、版本/tag和正式验收结论保持，未commit/push、服务器/真实Provider/阿里云/OSS/备份或新增依赖。视觉检查另确认正则390标题被徽标挤成“正则测／试”，作为下一轮独立布局修复保留。

## DT-R299｜正则预览复制、时间复制反馈与URL粘贴归属（2026-10-26）

- 三路仍由本Root通过Computer Use独立控制ZCode，标准BigModel GLM-5.3、最高、完全访问逐会话实核，Fast保持；不与其他Codex共享业务会话、不开子agent，本项目并发至多3。A/B/C各有单一文件owner，Root独占本文件和独立验收，已有dirty与正式版本/验收结论保持。
- A：RegexToolView.vue沿现有title-line增加flex-wrap，390标题由90.75px宽、两个文字片段变为104px宽、单片段，26px字号保持。替换预览标题行复用Shared CopyButton，复制精确preview文本；达到展示上限时不显示复制入口，原省略说明保持；h3 margin归零以对齐按钮。Worker/运行取消/限额与R298同一按钮焦点合同未改。新增preview-copy三例：最初RED三失败中，两例准确证明旧版缺复制入口，第三例依赖新增wrapper而失败，不能当作旧版功能缺陷；Root要求改为公开h3标题断言，保留省略/无预览/无复制断言。首GREEN13/13（新3＋原focus/bounded/stale共10）；B共享组件稳定后仅最终新3重跑通过，旧10输入未变不重复。A最终检测rc2仅原match-card 3px边框，diff检查0。
- B：TimeToolView.vue/TimeResultCard.vue去掉裸clipboard promise及未管理的sr-only反馈timer，时钟、结果行、工作日与自然语言复制全部复用现有Shared CopyButton，权限拒绝有局部失败/重试和可见反馈。Root逐字归一比较确认时间计算、时区/DST、watchers、1000ms时钟及visibility行为保持。Root审查发现自然时钟tick会按共享默认语义清掉在途复制/反馈，故仅新增可选liveText：时钟启用，保留本次点击快照的反馈，下一次点击仍取最新text；普通消费者默认失效合同保持，原Shared十例及helpers原文未改。新Time前两例旧版RED2失败、首GREEN12/12；再加实际1000ms interval边界和Shared opt-in各两例，RED4失败/12通过，最终26/26（Shared12＋Time复制4＋原布局5＋转换5）。三个涉及Vue的最终有效检测均rc0。
- C：UrlToolView.vue仅script内增加单一pasteContext代数，等待readText成功/失败后先确认归属。手输、即使已空时清空、显式转换/解析/重建、真正模式切换、操作/scope变化、Query草稿编辑/增删及较新粘贴均作废旧归属；复制不推进paste归属。Root确认模板/CSS、R286 copyResult、原mode-isolation/result-context测试及URL算法逐字保持。新增六例最初RED5失败/1通过，其中Query例把编辑放在粘贴之前，时序本身错误，不能计为有效缺陷证明；首GREEN17/18，旧12全过，随后只校正该测试顺序、生产码不变，新6重跑6/6。共18个不同用例通过，未声称单次18/18。检测rc2仅原privacy-note 3px边框，diff0。
- 汇总共57个不同相关测试通过。首次统一Web check实际rc2：新Time复制测试mountView将vi.fn的宽泛ReturnType作为Vue errorHandler参数，TS2322。由B只把该处注解改为(error: unknown) => void，Root精确比较确认没有其他变动；受影响Time四例重跑0，随后C唯一集成check重跑0。首轮失败日志保留于/tmp/dt-r299-integration/，重跑在其retry/，未重复未受影响检查。
- 新环境阻塞：原acceptance目录的test.env、override.yaml及四个Secret源文件均缺失，Root限定路径复核与已挂载原文件test -s均不可读；原因未定。四容器仍运行。完整gateway镜像构建/Compose更新在开始前停止，本轮没有临时deploy Dockerfile、配置比较/build/up，不恢复/猜造/轮换凭据。改由C只执行一次pnpm --dir apps/web exec vite build（已有check0，不重复package build内的check），实际rc0；保留既有大于500kB的chunk warning，未因此扩展优化。
- 本地静态载入：首次docker cp备份及三次载入均rc1，后续一次限定探针捕获原错误为Could not find the file /srv/index.html in container。Root实读srv-before/after和exec stat确认文件始终存在（603B/644），推测为空目录或归因OrbStack/挂载均不成立，不作原因定性。C以tar经docker exec -i流入同一gateway的/srv，assets、tesseract先，index最后，三个实际rc均0；旧assets保留，agent-console静态目录未动。索引读回与dist精确字节相等，Root复核通过。流程偏差：旧索引未先成功备份即被覆盖，后续backup-current只是载入后当前版，不能算R298旧版备份；镜像未改动。本轮仅一次CLI GET 127.0.0.1:18380得HTTP200/0字节，不能据此证明页面内容或判定目录为空；真正新产物由localhost实际页面验收，不冒称镜像构建通过。
- 实际页面A：真实Worker默认2匹配、精确复制替换预览、输入原文与完成状态不变（不重跑由组件spy例保障），复制按钮焦点保持；预览h3/按钮中心相同、margin0。再以501个a正常运行确认500卡片、至少501次提示、预览省略且无复制入口；编辑后旧结果/反馈清除。B：document.hidden=false下实际时钟跨过1050ms发生更新，已复制反馈仍在，第二次实际剪贴板取最新且与前一次不同；Unix秒0/1转换复制分别精确到对应ISO，编辑后结果移除；工作日2026-01-05加1得到01-06、自然语言默认表达结果均真实复制并显示反馈。迟到/拒绝/卸载保证以deferred组件例为准，未伪造浏览器权限拒绝。
- 实际页面C：正常粘贴公开example.com向量，解析保留两个x及无等号flag；首值改9重建为https://example.com/a?x=9&x=2&flag#part，桌面/390实际剪贴板正确；再改10后重建清空、复制禁用、三行草稿保留，地址始终/tools/url，未打开example.com。三页均验390/1024/1440/1920/CSS3840，文档/主区无横向溢出；时间手机八个已渲染复制入口最小高44px。截图/tmp/dev-toolbox-r299-regex-heading-390-after.png、-regex-preview-copy-{390,1440}-after.png、-time-live-copy-1440-after.png、-time-result-copy-390-after.png、-url-query-copy-390-after.png、-url-query-1440-after.png（600）。
- 浏览器范围与收尾：新索引重载后真实测试栈显示登录页，未恢复真实认证；纯本地工具验收使用临时GET /api/v1/auth/session合成响应，所有其它API均拦截拒绝，实际仅3个session GET、零其它API、零写入，工具验收warn/error为空。原剪贴板按当前仍为自有公开向量时恢复，私有内存副本释放，公共样例清空；拦截清除后回首页重载，真实登录页、默认1280×720、深色、无样例/alert，不能称为真实登录/后端验收。18份源码/测试与已审冻结候选精确相同；A/B/C实现、类型修复和静态阶段均已看到自然终态。私有日志/tmp/dt-r299-{a,b,c}-local、integration、static-preview经Root复核目录700/文件600；原deploy四目标无diff。gateway仍7b5e0ad62cbd，API4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4的身份/StartedAt/网络/绑定保持，RestartCount均0，唯一宿主绑定127.0.0.1:18380。未commit/push、正式发布/云/服务器/付费调用或新增依赖；持续目标保持active。

## DT-R300｜JWT/翻译粘贴归属与摘要键盘焦点（2026-10-26）

- 本Root继续直接控制三个fresh ZCode会话，各自实核dev-toolbox项目、BigModel标准GLM-5.3选中、Flash/FlashX未选、最高slider2、完全访问；Fast未改，不读取或消息其它Codex，不开额外执行者。A/B/C只写各自Vue与一个新增测试，Root只写本文件并独立源审/浏览器验收。初次派发后的瞬时快照未显示Stop，随后在同一会话确认运行，未重发任务。三路实现、审计返工、测试类型修正及唯一集成均已看到自然终态。
- A：JwtToolView.vue新增两个按Token/key分别归属的局部pasteEpoch。对应字段手输/后发粘贴使旧read成功和失败失效；key模式或手选key变化作废密钥read；显式run/仅检查Claims及清空全部推进两目标，已空清空也有效；onBeforeUnmount仍复用clearSensitiveState。两个目标互不误拦，copyJson原decoded身份合同不推进paste归属。新增paste-context七例旧生产RED6失败/1正常对照通过，首GREEN21/21（新7＋原9＋复制5）。Root发现第三例卸载后读取旧DOM不能证明隔离，要求仅删除该无效段/改标题，保留两目标已空清空后的成功/失败断言；新7重跑0，旧14与生产/检测输入不变复用。卸载保障只作源码调用链确认，未冒称独立动态验证。原测试/helpers、jwt.ts及模板/CSS精确保持；检测rc2仅原有3/3/4px边框，非新发现。
- B：TranslateView.vue用单一pasteGeneration保护原文read及失败提示，输入/保护/源目标语言变化、已空清空、后发粘贴和卸载作废旧归属；当前重试成功清旧读取错误。新八例旧生产RED7失败/1正常对照通过，首GREEN18/18。Root源审发现初候选的isBusy/preflightRunning布尔guard会在预检结算后重新允许旧read，又会静默丢掉预检期间用户主动发起的新粘贴。追加两例只在该候选上定向RED2失败/8跳过：有效预检失败后旧read仍不能改写；预检期间新read应像手输一样生效，旧计划晚到不得排队/发chunk。最终仅在初次/重新预检的有效入口推进generation，移除preflightRunning一刀切，实际运行isBusy保护保持；GREEN20/20。预检/队列/分块/计费算法与模板/CSS、原10例原文保持。
- B测试收口与类型检查：新夹具漏/tools路由产生10条Vue Router警告，补一条与原夹具一致的空路由后仅新10重跑0、stderr0，旧10复用；一次未分词CMD变量导致zsh rc127、vitest未启动，独立保留，不计为测试运行。首次统一check实际rc2，指向新增例get(...).exists()被类型定义有意排除；B只改这一行为find(...).exists()、期望true保持，新10再跑0、stderr0，Root精确比较其它内容及整个生产Vue未变。C受影响check重跑0，原失败记录不覆写。原10与检测器输入未变未重复；B最终Vue检测0。
- C：Root真实浏览器用abc/Enter运行旧Digest Worker后，结果出现且字段解锁，焦点落BODY，修前图/tmp/dev-toolbox-r300-digest-focus-before.png。DigestToolView.vue仅一行模板，将两个v-if/else计算/取消UiButton合为同身份按钮，按running切换variant、文案与调用；整个script/CSS、Runner、算法、复制序号/timer、原11例与helpers逐字保持，无程序化focus。新增focus四例旧生产RED3失败/1主动移焦对照通过，最终15/15；公开既有选择器、附到document的DOM与deferred Worker证明完成/错误/取消及不抢外部焦点，jsdom以聚焦后click模拟原生Enter激活，限制已注明。检测0，tracked diff检查0，新untracked文件no-index检查1为内容差异且无空白报告。
- 共56个不同相关用例通过（A21/B20/C15），没有全库/E2E或真实云调用。Root冻结14份源码/测试（含R299 Shared）后由C唯一汇总：首check2在任何backup/build/load前停止；只修测试后重试check0，再一次exec vite build0，既有大chunk warning保留。日志/tmp/dt-r300-integration/及retry/；未重做不变focused、探测旧Docker远端前端、Compose或镜像构建。
- 本地载入：先exec cat成功备份旧索引为retry/02-index.before.html（603B/600），Root确认精确等于R299旧索引且不同于新产物，再构建/写入。assets与index分别先产出无AppleDouble/Pax的ustar，再经同一gateway的exec -i stdin读入，两生产者/两消费者实际rc均0，index最后；旧assets保留，tesseract和agent-console未动。新索引读回与dist精确相同；本轮唯一CLI GET使用实际站点host localhost:18380，HTTP200/603B，body与dist精确相同，避免把127 host的200/0字节误作页面证明。未docker cp、restart/reload、改Caddy/镜像tag/配置/绑定。Root复核原deploy/package/lock/Vite/Makefile无diff，14份最终源码与已审候选精确相同。
- 实际页面：新入口index-egkRCOCo.js确已加载。JWT实际Token/key粘贴、Header复制精确，未验证/Claims未检查提示保持；新Token粘贴后旧Header/复制反馈清除，清空无alert，未验证任何真实签名。翻译实际粘贴79字符、本地统计与保护URL/路径预览正常，预览零API，键盘关闭回到查看发送范围，清空后入口禁用；忙时/迟到/拒绝与重新预检由纯mock组件例覆盖，浏览器未点击翻译。摘要真实Worker桌面abc、手机abcd两个已知向量正确，完成后均聚焦同一计算按钮、字段解锁、无alert；取消/错误/主动移焦由deferred例覆盖，未做大文件压力测试。三页按390×844、1024×768、1440×900、1920×1080、CSS3840×2160验收，文档/主区无横向溢出，手机深浅主题已看。
- 浏览器范围与收尾：临时只读合成会话/语言清单/本地额度用于隔离前端，实际5个session GET＋languages/usage各1，零其它API、零写入，工具窗口warn/error为空；不代表真实认证、阿里云额度或翻译成功。原剪贴板已恢复、私有内存副本释放、所有公开样例清空，拦截清除；深色/默认1280×720、首页真实登录页、无样例/alert。截图/tmp/dev-toolbox-r300-jwt-paste-copy-1440-after.png、-jwt-390-light-after.png、-translate-local-preview-1440-after.png、-translate-paste-390-after.png、-translate-390-light-after.png、-digest-focus-{1440,390}-after.png、-digest-390-light-after.png均600；私有a/b/c-local与integration目录700、全部文件600经Root检查。
- 基础环境限制单列：gateway仍7b5e0ad62cbd、API4730f9ed678c、worker d97d089a87b3、PG a2d63860bea4。静态载入前后限定快照完全相同，只能证明该载入阶段未改变容器；不能声称整轮四容器健康。Root最终实查PG exited133、OOM=false、RestartCount1，FinishedAt=2026-10-25T20:03:39.651967306Z（本地26日04:03，早于首轮集成20:45与静态写入20:54）；重启尝试错误明确为原postgres_password源文件缺失导致mount失败，初次退出原因未知，API现unhealthy、worker healthy。C把24日StartedAt误作退出日期，Root依FinishedAt纠正；未因此重启、恢复/猜造/轮换Secret或触碰数据。真实登录/后端、完整镜像/Compose仍未验收，记待受控恢复，不阻塞独立前端工作。未commit/push、版本/tag/正式验收变更、服务器/外部费用或新增依赖；持续目标保持active。

## DT-R301｜JWKS 重新手选、能力名称搜索与 YAML 焦点（2026-10-26）

- 继续按用户要求仅控制三个独立 fresh ZCode 会话，每个实核 dev-toolbox、BigModel 标准 GLM-5.3、最高思考 slider2、完全访问，Flash/FlashX 未选、Fast 未改。无 Codex 会话消息/状态协调、无子 agent；三路写入 owner 分离，Root 只写本记录并独立审计。原生 UI 仅操作片段持原子锁；三路实现与 C 的唯一集成均已见自然终态。
- A：真实旧页面将 public-demo-a/b 的 JWKS 换成 public-demo-c/d 后，旧索引0静默指向新 c。JwtToolView.vue 只增加 keyValue watcher 清除 selectedKeyIndex；未改变模板/CSS、jwt.ts、原21例、R300粘贴或复制归属。新3例覆盖替换、清空回填/重排与不变输入/唯一kid对照，旧生产有效 RED 2失败/1通过，GREEN24/24。组件例 mock 验签，Root另用公开重复字符密钥和真实 HMAC JWT 在浏览器验证：原A通过→替换后请选择且已解码内容保留→无手选要求确认→手选新C校验旧Token正确失败→唯一kid新Token自动匹配通过。初次无手选路径原本正确，不作新修复。
- B：SHA-256、JSONPath 原搜索均零命中。toolLinks.ts 只增加可选 searchTerms，JSON 引用 JSONPath，摘要复用 digest/contracts 已有算法ID/展示名；ModuleNav.vue 只扩展原子串过滤字段，查询规范化、分组展开/折叠、抽屉、模板/CSS及其他元数据逐字保持。新6例 RED 5失败/1对照通过，GREEN 新6＋原7共13/13。原7有两条既有 /help 路由夹具提示，新6无提示；不改旧helper。Root实际核对 SHA-256/sha256/MD5、JSONPath、BASE、无匹配与清空；手机搜索后进入摘要工具，抽屉 expanded=false、aria-hidden=true、inert，未触发计算。首页与工具目录十个入口及原本地/云服务标签保持；直接元数据消费者原 HomeView 三例3/3，三条既有 /assistant 夹具提示保留。
- C：旧真实 YAML Worker 完成后焦点落 BODY。YamlView.vue 仅将计算与取消两个条件按钮合为同一按钮，running 切文案/variant/调用，等待时可直接取消；整个script/CSS、Worker、原5例与应用/清空合同不变。新4例 RED 2失败/2通过，GREEN9/9；JSDOM未模拟原生disabled失焦，完成/错误例旧版也通过，RED只证明等待/取消同控件差异。Root真实浏览器以Enter运行默认样例、语法错误和修正重试，三次结束均聚焦可用原按钮；空输入禁用。未做大文件压力测试，等待取消/主动移焦守卫由deferred例覆盖。
- 必要验证共49个不同相关用例通过（A24/B13/C9/Home3）；原测试正文保留，14份最终源码/测试与已审冻结候选逐字相同。A检测rc2只报告原有3/3/4px边框，B/C检测0；owner diff检查通过。B额外探查检测器实现时Root已要求收束，未为静默输出重复扫描。候选冻结后C首次Web vue-tsc/tsc rc0，一次Vite构建rc0，既有大chunk提示保留；无全库或完整E2E。私有 /tmp/dt-r301-{a,b,c}-local/ 与 integration/ 均700、全部结果文件600，经Root复核。
- 本地载入仍限同一 gateway 7b5e0ad62cbd 的公共静态资产。构建/覆盖前旧 index 备份603B，Root确认精确等于R300读回；assets与index分别生成ustar再由exec -i流入，两个生产者/两个消费者均0，index最后，旧资产、tesseract、agent-console保留。新读回和唯一CLI GET localhost:18380 的HTTP200/603B正文均精确等于dist，新入口 index-CoNlNj5q.js 已加载。容器前后限定快照逐字相同，deploy/package/lock/Makefile/Vite无diff；未docker cp、镜像/Compose构建、restart/reload或改配置。
- 三页按390×844、1024×768、1440×900、1920×1080、CSS3840×2160检查，文档/主区无横向溢出，手机深浅主题已查看；工具页控制台warn/error为空。隔离前端仅6个合成session GET、零其它API、零写入，不代表真实认证或后端验收。截图 /tmp/dev-toolbox-r301-jwks-reset-1440-after.png、-jwks-390-light-after.png、-tool-search-{1440,390}-after.png、-yaml-focus-{1440,390}-after.png、-yaml-focus-390-light-after.png（600）。公开样例已清，原剪贴板仅在仍属自有公开样例时恢复、私有副本释放；拦截清除，深色/默认1280×720，首页回真实登录页。
- 环境限制保持：PG a2d63860bea4 exited133、API4730f9ed678c unhealthy，worker d97d089a87b3 healthy；PG退出时间及原Secret源文件缺失见R300，原因未作扩大推断。本轮未重启、恢复/猜造/轮换凭据。已异步询问原配置/Secret的本机备份路径，要求不粘贴密钥，尚无回复；继续独立前端工作。未commit/push、版本/tag/正式验收变更、服务器/真实Provider/阿里云/OSS/备份调用或新增依赖，持续目标active。

## DT-R302｜JSON 操作焦点、URL 重建校验与本地默认日期（2026-10-26）

- 继续直接控制三个独立 fresh ZCode 会话，逐个实核 dev-toolbox、BigModel 标准 GLM-5.3 选中、Flash/FlashX 未选、最高 slider2、完全访问，Fast 不变；没有其它 Codex 会话消息/进度协调或子 agent。三路 owner 分别为 JSON、URL、Time，Root 只写本记录并独立审计。一个未发送草稿因界面切换而重建，每路初任务只实际发送一次；UI 锁等待未当作会话终止或重启证据。三个实现、后续原 owner 修正及两次静态载入阶段均已实见自然终态。
- A：旧真实 JSON 默认格式化经 Enter 完成、复制已启用，焦点却落 BODY，图 /tmp/dev-toolbox-r302-json-focus-before.png。JsonView.vue 让本地主按钮在 running 时保持同一身份并成为可用取消，结束恢复原 actionLabel/variant/空输入禁用；primaryDisabled 只描述非运行态。AI 的 aria-disabled、isBusy 守卫、单独取消与确认/请求流程保持，未新增状态或程序化 focus，CSS 与其余脚本逐字不变。新4个 attached DOM/deferred Worker 用例旧生产 RED 2失败/2通过，GREEN 新4＋原 staleResult9/repair4/ai4 共21/21；JSDOM不模拟原生disabled失焦，完成/错误和主动移焦对照旧版已通过，不冒称这些片段也曾失败。检测0，原测试不改。
- B：旧页面把公开 URL 第一行值改为单个%后仍生成可复制的非法地址，无alert，图 /tmp/dev-toolbox-r302-url-invalid-rebuild-before.png。按docs/09 §7.3，rebuildUrl仅在最终拼接文本复用assertUrlInputLimit及validatePercentEscapes，不自动编码/解码/规整；视图捕获已知错误、清本次结果、禁用复制，保留原输入、parsed字段与重复key/flag/fragment及全部草稿。一个局部rebuildFailed标记使Query错误不误标原始有效输入invalid。新核心7例＋视图2例旧生产RED8失败/1正常对照通过，GREEN含原unit6/paste6/result9共30/30。原三份测试与其它算法保持，CSS逐字不变；检测rc2仅原有privacy-note的3px边框，不能报为全扫描通过。
- Root首载入后拒绝了B的提示位置：实际1440×900错误摘要top=-365.7、bottom=-318，用户当前只见空结果/禁用复制。证据 /tmp/dev-toolbox-r302-url-invalid-1440-first-candidate.png。原owner只将输入区摘要限定为非rebuildFailed，并在Query动作前放互斥的重建错误摘要；无新状态、滚动/焦点脚本或CSS。原两个新DOM例各加Query归属与唯一alert两断言，首候选准确RED2/2，补齐后GREEN2/2，其余28例及A/C输入不变复用。最终真实错误在Query旁、视口内（1440 top537/bottom585），五尺寸均可见；值%与无等号flag%A失败时草稿保留、源输入invalid=false，修为合法原始转义后重建及实际复制准确；原始输入非法%仍在原区报错并invalid=true。地址始终/tools/url，没有打开example.com。
- C：浏览器基准Asia/Shanghai为26日06:01，工作日起始日期却默认为25日，图 /tmp/dev-toolbox-r302-workday-default-before.png。TimeToolView.vue仅将UTC切片初值改为既有toLocalInputValue(new Date()).slice(0,10)，加一行注释；模板/CSS、time.ts/cron.ts及原测试保持。新3例以固定Date和真实进程TZ覆盖上海已到次日、纽约仍在前日，并断言实际提交参数；用户手改日期跨页/页面IANA提交不被覆盖。旧生产RED2失败/1对照通过，GREEN含原页面38例共41/41。首次统一check rc2只报新测试四处process全局TS2591；原owner按Root限定改用vi.stubEnv/unstubAllEnvs，全部断言与生产码精确不变，新3例重跑0，旧38与A/B复用，随后check0。未增加Node全局类型、依赖或配置；首次失败记录保留。纯默认值修改未运行设计扫描。
- 共92个不同相关用例通过（A21/B30/C41），未把重跑累计成新case，未跑全库/完整E2E或真实Provider。12份最终源码/测试与Root已审候选逐字一致；原tracked测试/算法、deploy/package/lock/Makefile/Vite/tsconfig无新增diff，既有dirty与untracked测试保留。私有 /tmp/dt-r302-{a,b,c}-local/ 与 integration/（含retry、inline-final）全部目录700/文件600，经Root复核。
- 集成由C唯一执行。初check2在任何备份/构建/载入前停止；类型修正后的retry/check0，一次Vite构建0。首次只读容器采集错误访问不存在的State.Health而rc1，owner自行最小改为index条件访问，原始attempt1记录保留，无环境写入。B提示位置经真实验收追加修改后，新稳定候选在inline-final单独check0、一次build0；不重跑不变用例/检测，既有大chunk警告照实保留。两次构建均有实际源输入变化依据，不是重复相同候选验证。
- 两次均先exec cat成功备份当前603B索引再构建/写入：retry备份精确等于R301读回，inline-final备份精确等于首R302读回。沿原ustar参数分别生产assets/index，逐一核实生产者/exec -i消费者均0，index最后，保留旧assets、tesseract与agent-console。每次读回均cmp等于dist，每个稳定候选仅一次CLI GET localhost:18380，均HTTP200/603B且正文精确等于dist；两阶段限定容器前后快照均cmp0。首入口index-DDdASWPp.js用于A/C及B首验，最终index-DCFLLWya.js用于B收口复验，A/C输入不变不重复。没有docker cp、镜像/Compose构建、reload/restart、配置或绑定变化。
- 浏览器实际闭环：JSON成功/语法错误/修正重试及JSONPath两匹配后均保持可用原按钮焦点，公开格式化JSON实际复制精确；取消/主动移焦由deferred例保障，未做压力测试或真实AI发送。工作日默认26日与本地基准一致，默认加5工作日得到11月2日；手改11月3日经切页、纽约时区与实际跨秒时钟更新仍保持。三页均验390×844、1024×768、1440×900、1920×1080、CSS3840×2160，文档/主区无横向溢出，手机深浅主题已看。URL最终错误五尺寸均在当前视口，1MiB边界只作单元验证，不冒称浏览器大输入/权限拒绝或完整浏览器矩阵验收。图 /tmp/dev-toolbox-r302-json-focus-{1440,390}-after.png、-json-focus-390-light-after.png、-workday-default-1440-after.png、-workday-draft-390-after.png、-workday-default-390-light-after.png、-url-invalid-{1440,390}-after.png、-url-invalid-390-light-after.png（600）。
- 隔离前端实际仅7个合成session GET、零其它API/零写入，工具验收warn/error为空；不代表真实认证/后端/云调用。样例已清、原剪贴板仅在仍属自有公开向量时恢复、私有内存副本释放，Fetch拦截清除，深色/默认1280×720、首页真实登录页。gateway仍7b5e0ad62cbd，API4730f9ed678c unhealthy、worker d97d089a87b3 healthy、PG a2d63860bea4 exited133/RestartCount1等既有环境限制保持；原配置/Secret备份路径问题尚无用户回复，未恢复/猜造/轮换凭据、重启或触碰数据。未commit/push、版本/tag/正式验收变更、服务器/OSS/备份/付费调用或新增依赖，持续目标active。

## DT-R303｜按用户要求收尾累计代码（2026-10-26）

- 用户确认原配置/Secret暂时没有备份，并要求“将当前所有代码收尾一下”。据此冻结新增迭代；此前R303仅作只读探索，没有派发新功能。收尾范围为当前Web的53份代码/测试（22生产、31测试）及本记录；没有后端、worker、依赖、配置或正式验收范围的新增修改。
- 三个fresh独立ZCode会话逐个实核dev-toolbox、BigModel标准GLM-5.3、Flash/FlashX未选、最高slider2、完全访问，Fast保持，无子agent或其它Codex会话协调。A只读核对知识/operations/settings六个生产diff及必要测试/直接消费者，0项必须修复；B只读核对壳层/工具16个生产diff，除Base64一项反馈遮蔽外无必须修复；C唯一执行标准Web全量回归。足够证据后各自自然结束，未扩大为新功能、样式清理或既有未改实现的额外改造。
- 收尾唯一修正：Base64先复制失败、再粘贴失败时，旧copyError优先遮住本次“使用系统粘贴快捷键”指引。Root直接核对diff与旧反向顺序测试后，授权B仅在pasteInput入口清copyError一行，追加一个DOM用例，生产其余脚本/模板/CSS与原测试/helpers精确保持。新增例旧生产准确RED1（收到旧复制错误）、修后GREEN1；两次用-t只过滤新增例，原21例没有被改成skip，最后由包级套件全部运行。输入与既有编码结果保持。日志 /tmp/dt-r303-closeout-b-fix/（700/600）。
- 首次标准Web全量为134文件/930例、rc0、37.98s。133个.test.ts之外还有既有tesseractSdk.startup-failure.test.mjs，实际收集134，无遗漏。发现并修正上述真实源变化后，最后稳定候选重新执行一次同标准套件（--maxWorkers=2），134文件/931例全部通过、0失败/0跳过，rc0、40.19s；没有把两次运行累计为新case。旧路由夹具提示保留：459条R0004未注册路径、R0011与R0003各1条来自App.navigation-failure的故意失败场景，无unhandled error；未为安静日志改旧测试。初次输出保留 /tmp/dt-r303-closeout-c/，最终输出 /tmp/dt-r303-closeout-final/，均700/600。
- 最终Web vue-tsc/tsc rc0、一次Vite构建rc0、git diff --check rc0；源码确有一行变化才重新绑定检查/构建，没有重复不变候选。既有大chunk warning保留，未扩展拆包。Root逐字核对其余51份代码/测试与收尾基线完全相同；修后两文件与已审新候选完全相同，路径集合没有新增或移除；deploy/package/lock/Makefile/Vite/tsconfig不变。用于该核对的本机临时源副本在核对后清理，当前工作区全部既有dirty/untracked保留。
- 最终本地载入：先exec cat备份当前603B索引并cmp精确等于R302最终读回，再构建；assets与index两个ustar生产者/两个exec -i消费者实际rc均0，index最后。旧assets、tesseract、agent-console、Caddy/镜像tag保留，无docker cp、Compose/镜像构建、reload/restart。新入口index-Cb3q39yO.js，索引读回及唯一CLI GET localhost:18380的HTTP200/603B正文均精确等于dist，四容器限定前后快照逐字相同。执行器原生终态报告curl rc0；curl.rc占位文件为空，Root没有把空文件当作退出码证据，独立核实了HTTP码、完整正文及精确字节相等。
- Root在新入口实际以公开“收尾验证🔧”完成系统剪贴板粘贴→浏览器编码→精确复制，结果24B与独立公开向量一致、可见“结果已复制”、无alert及warn/error。只用1个合成session GET、零其它API/零写入隔离前端；拒绝读取/写入的遮蔽修正由上述DOM回归覆盖，不冒称真实浏览器拒绝权限验收。图 /tmp/dev-toolbox-closeout-base64-1440.png（600）。样例清空、原剪贴板按仍属自有公开向量时恢复、私有副本释放、Fetch拦截清除，恢复深色/默认1280×720并回首页真实登录页。
- 三路初核对、Base64修正及最终验证都已实见自然终态，没有仍在运行的本次执行任务。当前代码收尾完成，停止本次持续新增迭代；代码留在工作区，未stage/commit/push、改版本/tag或正式发布。原本地PG exited133、API unhealthy及缺失配置/Secret仅保留待办，未恢复/猜造/轮换凭据、重启或触碰数据，不能把前端测试与静态烟测当作真实登录/后端或V3正式验收通过。

## 待处理已证实事项（后续轮次候选）

- 已解决——JWT更换JWKS后旧手选索引自动指向另一把key：DT-R301 局部清除旧手选，24项组件回归与公开合成HMAC向量实际验签通过；修前图/tmp/dev-toolbox-r301-jwks-selection-before.png及修后重选图保留，R300只改粘贴归属的历史事实保持。

- 已解决——系统状态页键盘重试/刷新失焦：DT-R297 完成等待期有效落点、失败/成功回焦、用户移开后不抢焦点，7项回归及实际页面复验通过；只读与 R296 快照合同保持。

- 已解决——手机顶栏40px命中宽度：DT-R298仅一处CSS改44，八个已渲染操作实测44×44，当前入口/手动滚动/历史返回与五尺寸验收保持，未重排应用壳。

- 已解决——正则页390标题被徽标挤成“正则测／试”：DT-R299沿原flex骨架换行，标题104px、单片段、26px，徽标完整可见；五尺寸验收通过，修前/后图 /tmp/dev-toolbox-r299-regex-heading-390-{before,after}.png。

- 已证实——原本地acceptance的test.env/override与Secret源文件缺失，挂载原文件不可读。R299时四容器仍健康；R300最终PG已exited133、API unhealthy，PG FinishedAt为25日20:03Z，早于当轮集成/载入；一次重启尝试因缺失原postgres_password源文件而mount失败，初次退出原因未定、OOM=false。仅前端静态载入和隔离工具页面验收通过，不能替代真实认证/后端或完整镜像验收。用户2026-10-26确认暂时没有备份，并要求收尾当前代码；本次保持数据库原状，受控恢复原配置/Secret作为后续重新启动完整验收的前置待办，不直接运行旧stack up。

- 样式候选——Base64原有privacy-note及正则匹配卡片的3px左边框被impeccable指出；DT-R298均未改变对应CSS，作为视觉判断候选保留，不视为新功能回归或阻塞项。

- 待核实——标准Dockerfile前端docker/dockerfile:1.7远端元数据size validation异常：DT-R293仅用临时内置前端输入恢复本地预览，未将原因定性为缓存损坏、未永久修改构建配置；后续标准构建如需执行，先依据当时环境核实。此次gateway的Compose配置记录包含临时Dockerfile路径，之后采用标准配置up可能正常触发gateway重建；不为消除此差异再重建。

- 已解决——管理抽屉跨尺寸关闭回焦：三条修前 BODY 路径、关闭时有效入口恢复、25 项回归与实际页面复验见 DT-R290；合成状态已清理，当前没有未完成请求或弹窗。

- 已解决——DT-R285 可信设备改名的迟到成功清除更新草稿：修复、原测试保留、5 项回归和三条实际页面复验见上节；修前截图 /tmp/dev-toolbox-r285-device-{edit-late,same-edit}-before.png 保留。

按 DT-R00 汇总保留（原 1、2、6 已由 DT-R02 完成；原 URL 模式串扰、时区旧结果、Markdown 换行三项已由 DT-R03 完成；原临时滚动摘要/窗口预算已由 DT-R04 完成；R18 预算预留的「创建时 unavailable」限定范围已由 DT-R18 完成；R18 遗留的 ready 路径来源预留已由 DT-R20 按实际来源预算完成；设置页索引状态不持续更新已由 DT-R21 完成并经根真实 IAB 验收；摘要工具文本修改后旧结果未失效已由 DT-R22 完成并经根真实 IAB 验收；ItemAIView 版本请求与动作归属已由 DT-R24 完成；ItemAI 弹窗键盘/焦点与关闭 44 命中目标已由 DT-R25 完成并经根真实 IAB 验收；TaskCenter 请求选择与离页轮询归属已由 DT-R26 完成并经根真实 IAB 验收；ItemAIView 离页轮询与异步续程已由 DT-R27 完成并经根最终收口；Base64 转换上下文变化后的结果失效已由 DT-R29 完成并经根审与真实 IAB 验收；帮助路由 hash 滚动对齐主滚动容器与 390 sticky 偏移已由 DT-R31 完成并经根审与真实 IAB 验收；正则工具输入或 flags 变化后旧结果未失效已由 DT-R32 完成并经根审与真实 IAB 最终收口；YAML bigint 分支负零与原始数值词法丢失已由 DT-R33 完成并经根审与真实 IAB 最终收口；帮助页缺知识助手配置→提问→引用可执行指引已由 DT-R34 完成并经根审与真实 IAB 最终收口；YAML 390 结果标题被复制反馈与快捷导航挤压已由 DT-R35 完成并经根审与真实 IAB 最终收口；README 产品介绍与使用入口未对齐当前三模块已由 DT-R36 完成并经根最终收口；ModuleNav compact 抽屉缺帮助 footer 入口已由 DT-R37 完成并经根审与真实 IAB 最终收口；AppRail AI 任务与助手图标相同已由 DT-R38 完成并经根审与真实 IAB 最终收口；首页缺知识助手可发现主入口已由 DT-R39 完成并经根审与真实 IAB 最终收口；助手会话页知识索引进度不会自动刷新已由 DT-R101 实现并经 DT-R104 真实页面验收，见两节）：

- 已解决——Nginx TLS 验证（原 DT-R103 未完成事项）：DT-R107 TLS-only 短探测定位首次 TLS reset 时 443 尚未监听、约 2.1 秒后严格 TLS 200（原 R103 精确时刻不能回溯、不认定缓存损坏）；DT-R108 在 stack.mjs 实现 26 行 waitForNginx、verify.mjs import＋调用、5 项定向测试 rc=0（拒绝后恢复、总 deadline、慢速响应、错误 CA/主机名），保留严格 TLS/SSE 2 秒；DT-R109 唯一一次修后 nginx 实跑通过（verifier rc=0、executor rc=0、2 PASS、firstEvent 27ms）。R103 的 rc1 零 PASS 与「镜像缓存预检返回约定 rc2、verify 未运行」事实保留；不得把镜像 image Config 为空断言为损坏或上游非等价的定性不变；相关合成栈已由 DT-R111 定向退休。

- 已解决——助手导航 scope 修复（DT-R110）真实页面验证：DT-R112 新建四容器合成栈（原 R96 栈已由 DT-R111 退休）后由根完成桌面与 390 真实页面验收，scope/草稿/模型/推理保持与响应式符合预期，详见 DT-R112 节；确定性乱序保证以 R110 定向 deferred 测试为准。

## 必须用户本人处理的事项（记录即继续，不阻塞代码迭代）

- 真实云评测（涉及付费 Provider/配额的评测与烟测）。真实 40 题评测按用户 2026-10-24 指示记录为待办：待用户提供真实数据后执行，不阻塞其他独立产品迭代；实际运行时仍按 docs/16 §20.2 取得当次 Provider 与调用规模授权。
- 生产发布、版本号与 tag、正式验收结论变更。
- 品牌域名相关决策与配置。
- 共享本地数据库凭据是否轮换：R72 期间根脚本误解析 DSN 曾把本地非生产测试库口令输出到会话工具结果（详见 DT-R72 事件小节）；临时 env/专用库已清、凭据未轮换，待用户核对私有配置使用方后决定。

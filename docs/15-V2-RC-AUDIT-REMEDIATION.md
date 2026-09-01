# V2.0 RC 审计修复多 Agent 执行文档

状态：**已执行；九项审计问题已关闭，修复结果已随 `v2.2.0-rc.1` 发布候选提交、部署并打 tag；真实 Provider 留待 owner 配置后验证**

最后更新：2026-09-01

## 1. 目的与适用范围

本文只用于关闭 2026-08-31 V2.0 RC 全库审计确认的九项问题。它是执行与 ownership 文档，不新增产品能力，也不改写 `docs/09`～`docs/14` 已冻结的产品、架构、云合同、UX 和验收规则。

执行后的目标是得到一个**新的、本地已验证但尚未命名的 V2.0 RC 候选**。旧 `v2.0.0-rc.1` 的部署、恢复和升级记录是历史事实，必须保留；但旧候选不包含本文修复，不能作为新候选已部署或已验证真实 Provider 的证据。

本文不授权 Git commit、tag、push、部署、生产重启、真实 Provider 调用或正式发布。完成本地修复和验收后必须停下，由 owner 决定下一步。

上述授权边界只描述本文初始的本地修复阶段。该阶段完成后，owner 另行明确授权“先部署、再配置 API 测试”；后续部署事实记录于第 15 节，不倒改本文原始任务边界。

## 2. 开始前必须保持的事实

1. 当前工作树包含尚未提交的 V2 设计、实现、验收记录和其他用户成果；它们是执行基线，不得删除、覆盖、回退或用历史版本替换。
2. 每个 Agent 开始前必须读取根 `AGENTS.md`、本文、`docs/09-V2-TOOLBOX-BASELINE.md`、`docs/10-V2-TOOLBOX-ARCHITECTURE.md`、`docs/13-V2-TOOLBOX-DELIVERY-AND-ACCEPTANCE.md`、`docs/14-V2-AGENT-RUNBOOK.md`，以及自己 ownership 内最近的代码和测试。
3. 每个 Agent 开始前运行 `git status --short`，只用于识别现有改动；不得运行 `git reset`、`git checkout --`、`git clean` 或其他回退命令。
4. `docs/09`～`docs/14` 的决定继续生效。若实现需要改变这些合同，停止对应问题并报告准确文件、段落和冲突，不在代码中创造第三种方案。
5. 全部测试只使用合成内容、本地 loopback 和 fake Provider；不得把 JSON、JWT、密钥或工具正文发送到外部服务。

## 3. 固定修复清单

本文只处理下表问题。执行中发现的新问题由 integrator 记录并判断是否阻断；不得借机扩大为全库重构。

| ID | 级别 | 已确认问题 | 本轮通过条件 |
|---|---|---|---|
| RC-01 | P0 | JWT 异步验签的旧 Promise 可覆盖较新一次运行结果 | 晚到成功、晚到失败、清空和卸载后均不能写回旧状态 |
| RC-02 | P0 | YAML 多文档格式化重复插入 `---`，两个文档可能变成三个 | 格式化前后文档数、顺序和注释保持，分隔符只出现一次 |
| RC-03 | P1 | ai-worker 只监听 request `aborted`，正文完整后的 caller 断连不能取消 Provider | response 提前关闭会传播同一 AbortSignal；正常完成不误取消 |
| RC-04 | P1 | 正则 Worker 可返回并让 Vue 渲染无界匹配对象 | 最多返回和渲染前 500 条，第 501 条即停止并明确说明截断 |
| RC-05 | P1 | README、PRODUCT、`docs/13` 仍宣称 RC 无 P0/P1、验收完成 | 修复期间状态改为“审计重新打开”；完成后只声明新的本地候选已验证 |
| RC-06 | P2 | JSON 文本 diff 绕过单编辑面 5 MiB UTF-8 上限 | text 模式左右编辑面分别在计算前执行既有字节上限校验 |
| RC-07 | P2 | JSONPath 带逗号的 quoted property union 被错误拆分并静默漏匹配 | `$['a,b','c']` 按两个属性正确匹配，脚本能力仍禁用 |
| RC-08 | P2 | 工作日数量只校验 safe integer，可在主线程执行近乎无界逐日循环 | 固定并显示 `-1000..1000`，超限在加载 Temporal 和进入循环前拒绝 |
| RC-09 | P2 | Monaco 0.56.0 的生产路径实际使用 vendored DOMPurify 3.4.8，存在 2 条 moderate、2 条 low 公告 | 审计依赖和实际浏览器 bundle 都使用已修版本，不能只把 audit 输出变绿 |

发布恢复条件不是“没有 P0/P1 就算完成”。用户要求修复“这些”问题，因此 RC-01～RC-09 必须全部关闭；任一项停在阻塞状态时，文档状态仍保持“审计重新打开”。

## 4. 全局执行边界

### 4.1 必须做

- 采用满足当前问题的最小局部修改，优先复用现有函数、错误类型、Worker 和测试设施。
- 保持所有确定性工具在浏览器本地处理，不新增业务 API、存储或日志路径。
- 保持 V1 `/knowledge`、`/items/:itemId` 及 query 合同不变。
- 保持 JSON AI 为现有窄同步接口、单轮、无工具、无后台续跑。
- 对异步结果使用现有页面/请求生命周期内的失效机制，不搭建通用任务系统。
- 每个 owner 先跑直接回归测试；只有稳定候选形成后，由 integrator 统一跑一次受影响的完整门禁。
- 测试、浏览器和依赖证据只记录真实运行结果，不预填数量、耗时或“通过”。

### 4.2 明确不做

- 不新增 V2.1/V2.2 页面、菜单、云翻译、OCR、额度账本或云队列。
- 不新增数据库、Redis、消息队列、微服务、RBAC、Kubernetes、动态插件或 billing。
- 不新增 AI task、Artifact、历史记录、Agent loop、代码执行、代码编译、重试或回退链。
- 不修改路由、App shell、导航、编辑器 adapter 或通用 Worker 协议，除非某项直接测试证明无法在 owner 模块内修复；出现这种情况先停止并交给 integrator。
- 不为 JSONPath 写通用解析器，不替换 JSONPath/YAML/正则库，不开放 `eval` 或脚本过滤。
- 不把 JWT 移入 Worker，不加入远程 JWKS、验签队列、Token 历史或签发能力。
- 不为工作日增加节假日服务、后台任务、通用日期 Worker、分块调度或复杂跳周算法。
- 不给正则增加虚拟列表依赖、分页、RE2、服务端执行、自动改写或超时自动重试。
- 不运行 `pnpm audit fix`，不升级无关依赖，不把桌面 Monaco 全面替换为 CodeMirror。
- 不重复整套旧浏览器矩阵，不因本轮未修改的页面重新做全量 Stitch 对照。
- 不修改 Go 源码；若 RC-03 的 Node loopback 测试证明必须改 Go，AI owner 停止并提交证据，由 integrator 重新划定 ownership 和验证范围。
- 不运行 `production-up`、`upgrade.sh`、`release-check`、`publish-release-status`、备份/恢复/prune、SSH 或任何生产命令。
- 不创建 commit、tag、分支，不 push，不给新候选自行命名 `rc.2`。

## 5. Agent ownership

同一文件在同一执行窗口只有一个写 owner。Agent 可以读取其他模块，但不得修改 ownership 外文件；不得回退或整理别人的改动。

| Owner | 独占写入范围 | 职责 | 禁止触碰 |
|---|---|---|---|
| Main integrator / documentation / dependency | 本文；`README.md`、`PRODUCT.md`、`docs/13-V2-TOOLBOX-DELIVERY-AND-ACCEPTANCE.md`；根依赖配置、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、本轮 Monaco patch | 状态纠正、共享依赖、冲突集成、最终门禁和证据收口 | 不代替功能 owner 顺手重写业务模块 |
| Structured-data owner | `apps/web/src/modules/tools/json/**`、`apps/web/src/modules/tools/yaml/**` | RC-02、RC-06、RC-07 | 编辑器 adapter、路由、shell、依赖、文档、JSON AI |
| Local-safety owner | `apps/web/src/modules/tools/jwt/**`、`apps/web/src/modules/tools/regex/**`、`apps/web/src/modules/tools/time/**` | RC-01、RC-04、RC-08 | shared Worker、编辑器、路由、依赖、文档、其他工具 |
| JSON AI cancellation owner | `apps/ai-worker/src/index.ts`；端点专用的新 helper/test 文件 | RC-03 | `model-gateway.ts`、Go、API schema、数据库、其他 ai-worker task |
| Independent final reviewer | 只读 | 在稳定候选上核对九项实现、测试、依赖和状态文案 | 不直接修代码、不修改文档、不重复运行全量检查 |

补充规则：

- `apps/web/package.json` 当前也属于 dependency integrator；任何工具 owner 不自行安装包或改版本。
- `apps/ai-worker/src/index.ts` 当前已有用户 V2 改动，JSON AI owner 只能在现状上做局部取消修复，不能用旧版本覆盖。
- `README.md`、`PRODUCT.md`、`docs/13` 当前已有用户验收记录，documentation integrator 只能追加/校正当前状态，不能删除旧 `rc.1` 的历史证据。
- Agent 不再派生新的写入 Subagent。需要额外分析时可以请求 integrator 提供只读结论，不能绕开 ownership。

## 6. 执行顺序与批次门禁

### Phase 0：先纠正发布状态

由 documentation integrator 单独执行，其他写 owner 暂不修改文档。

1. 在 `docs/13` 增加“RC 审计重新打开”小节，并把顶部状态、V2.0 状态表和当前结论改为：功能实现存在，但九项审计修复尚未闭环，当前不得发布。
2. 在 `README.md` 和 `PRODUCT.md` 只校正对应的 V2.0 当前状态句。
3. 明确保留：`v2.0.0-rc.1` 曾部署、恢复和升级验证是旧字节的历史事实。
4. 明确新增：旧证据不覆盖本文修复；当前新候选未命名、未提交、未部署、未做真实 Provider 验证。
5. 不改写 `docs/13` 中已真实发生的历史命令、环境和结果，不删除 V1 验收事实。

Gate 0：文档 diff 只能包含状态校正和新审计说明；若历史部署证据被删除或改成新候选证据，停止后修正文案。

### Wave 1：三个写 owner 并行修复

Integrator 在任务消息中逐一写明 ownership、目标、禁止项和最小测试。三个 owner 可以并行，但不能修改共享依赖或文档。

- Structured-data owner：RC-02、RC-06、RC-07。
- Local-safety owner：RC-01、RC-04、RC-08。
- JSON AI cancellation owner：RC-03。

每个 owner 完成后只返回：修改文件、关键语义、实际运行的命令与结果、仍存在的停止项。不得自行宣布 V2.0 完成。

Gate 1：每个 owner 的直接测试通过；`git diff --check -- <owner 范围>` 通过；没有越界文件。任一 owner 失败只重跑其受影响测试，不从头重跑全库。

### Phase 2：依赖修复与集成

三个功能 owner 完成并停止写入后，由 dependency integrator 独占根依赖、锁文件和 Monaco patch。

1. 再次确认当时可用的 Monaco 正式版本及其**实际 ESM sanitizer 路径**，不能只看 manifest。
2. 若已有包含修复版 DOMPurify 的正式 Monaco 版本，优先做精确版本升级，不升级其他包。
3. 若仍是当前事实——Monaco 0.56.0 为最新且 ESM vendored 3.4.8——执行本轮唯一允许的窄 patch：
   - 对 `monaco-editor > dompurify` 做 scoped override 到已修的精确版本 3.4.14；
   - 使用 pnpm 生成的 `monaco-editor@0.56.0` patch，只把 `esm/vs/base/browser/domSanitize.js` 从相对 vendored import 改为 bare `dompurify`；
   - 不编辑 Monaco 其他源码，不手改 `node_modules` 作为交付结果。
4. 更新锁文件和 pnpm 自动生成的 patch 元数据，执行 frozen-lockfile 安装验证。
5. 检查构建实际解析到修复版 DOMPurify；`pnpm audit` 变绿但 bundle 仍含 3.4.8 视为失败。

依赖停止条件：

- bare import 与 Monaco 构建或运行不兼容；
- 生产 chunk 仍包含 vendored 3.4.8；
- 修复需要 fork Monaco、改变编辑器架构或升级一组无关依赖。

命中任一条件时保持 RC 阻断并报告，不扩成自维护 Monaco fork，也不通过隐藏审计结果宣称修复。

Gate 2：依赖树、patch 源码和生产构建三者一致；桌面 Monaco 基本行为通过；未把 Monaco/CodeMirror 放入首页首包。

### Phase 3：稳定候选统一验证

只有所有写 owner 和 dependency integrator 停止修改后，integrator 才运行一次稳定候选门禁和受影响浏览器流程。失败后只修复直接原因并重跑受影响部分；代码再次稳定后才补跑被该修改影响的最终门禁。

### Phase 4：独立终审与文档收口

1. Independent final reviewer 只读检查九项 diff、测试证据、依赖实际路径和 owner 边界。
2. 任一 RC-01～RC-09 未关闭，documentation integrator 保持“审计重新打开”。
3. 九项全部关闭且最终门禁通过后，`README.md`、`PRODUCT.md`、`docs/13` 才可更新为“修复后的本地 V2.0 RC 候选已验证”。
4. 最终文案必须同时写明：新候选未命名、未提交、未部署、未正式发布；旧 `rc.1` 证据只属于旧候选；真实 Provider 未验证。
5. 不复用 `rc.1` 标签，不自行命名 `rc.2`，不把历史部署证据复制到新候选。

## 7. Structured-data owner 精确任务

### 7.1 RC-02：YAML 多文档格式化

Owner 文件：

- `apps/web/src/modules/tools/yaml/operations.ts`
- `apps/web/src/modules/tools/yaml/operations.test.ts`

实施：

1. 保留现有 `parseYamlDocuments()`、YAML 1.2、重复 key、tag、alias 和 merge key 规则。
2. 每个 `Document` 使用 `document.toString({ lineWidth: 0, directives: false })`，避免第二个及后续文档自带 `---`。
3. 由格式化操作唯一一次使用 `join('---\n')` 插入文档分隔符。
4. 不改注释、anchor/alias 或 YAML→JSON 语义，不增加 `%YAML`/`%TAG` 能力。

直接测试使用三个带注释的文档，断言：

- `documentCount === 3`；
- 输出恰有两行独立 `---`；
- 不包含连续 `---\n---`；
- 三段注释仍存在；
- 把格式化结果重新执行 `to-json` 后仍是三个文档且顺序不变。

### 7.2 RC-06：JSON text diff 5 MiB

Owner 文件：

- `apps/web/src/modules/tools/json/operations.ts`
- `apps/web/src/modules/tools/json/operations.test.ts`

实施：

1. 复用 `lossless.ts` 的 `assertStructuredTextLimit`，不新增第二套字节计算。
2. 只在 `diffJson(..., mode: 'text')` 分支对 left/right 分别校验后再 `split`；结构模式继续由现有 `parseLosslessJson` 校验，避免重复防御。
3. 维持“每个编辑面各 5 MiB”，不得改为两个输入合计 5 MiB。
4. text 模式仍比较原始字符/行，不要求输入是合法 JSON。

直接测试：

- 左右各为精确 5 MiB ASCII，成功且零差异；
- 左侧 `limit - 2` 个 ASCII 加一个 `你`，实际 UTF-8 超限，返回 `INPUT_TOO_LARGE`；
- 右侧同样超限，返回 `INPUT_TOO_LARGE`；
- 既有 structure diff 精度与 identity 测试继续通过。

### 7.3 RC-07：JSONPath quoted property union

Owner 文件同 7.2。

实施：

1. 替换当前用 `/\s*,\s*/` 拆分的 `normalizeQuotedPropertyUnions()`。
2. 新 helper 只识别“方括号内至少两个、全部带单引号或双引号的属性成员”；扫描时只在引号外的逗号分隔。
3. 将每个 union 成员展开为独立 JSONPath 查询，按用户书写顺序执行并扁平合并。
4. 属性名自身含逗号时，内部使用 `jsonpath-plus` 已有的 backtick literal-property 形式，例如内部路径 ``$[`a,b]``。用户输入仍不得直接开放 backtick、脚本或 `eval`。
5. 保持现有 `JSONPath({ resultType: 'all', eval: false, wrap: true })` 和规范路径输出。
6. 不实现通用 JSONPath parser、AST、过滤器、写回或新依赖；如果局部 scanner 无法覆盖冻结的 quoted-property union，停止并报告。

直接测试数据至少包含属性 `"a,b"` 和 `"c"`。查询 `$['a,b','c'].value` 必须按顺序得到两个结果和规范路径 `$['a,b']['value']`、`$['c']['value']`。同时保留普通 property union、嵌套后缀和脚本过滤拒绝测试。

### 7.4 Structured-data 定向命令

```bash
pnpm --filter @dev-toolbox/web exec vitest run src/modules/tools/yaml/operations.test.ts
pnpm --filter @dev-toolbox/web exec vitest run src/modules/tools/json/operations.test.ts
pnpm --filter @dev-toolbox/web exec vitest run src/modules/tools/json src/modules/tools/yaml
git diff --check -- apps/web/src/modules/tools/json apps/web/src/modules/tools/yaml
```

## 8. Local-safety owner 精确任务

### 8.1 RC-01：JWT 晚到验签结果

Owner 范围：`apps/web/src/modules/tools/jwt/**`。

实施：

1. 在 `JwtToolView.vue` 增加页面局部、单调递增的 run ID，不建立共享请求框架。
2. 每次显式运行先递增 ID，并快照 token、key mode/value、JWKS 选择和 Claims 参数。
3. 使用局部快照解码、检查 Claims 和构造 key input；不能在 `await` 后再读取可能已经变化的 ref。
4. `await verifyJwtSignature()` 的成功和 catch 分支都只在 ID 仍是当前运行时写回。
5. 清空和 `onBeforeUnmount` 递增 ID，使未完成 Promise 失效并清除敏感状态。
6. 不宣称能取消 WebCrypto；语义是“旧结果丢弃”。不加队列、历史、watcher 或 Worker。

直接组件测试使用受控 deferred verifier，覆盖：

- A 先运行但后完成，B 后运行但先完成，最终只显示 B；
- A 晚到成功不能覆盖 B 失败；
- A 晚到失败不能清空 B 成功；
- 清空后完成不写回；
- 卸载后完成不产生状态写入或未处理 rejection。

继续运行现有 12 算法 fixture；不为每种算法复制竞态矩阵。

### 8.2 RC-04：正则匹配结果有界

Owner 范围：`apps/web/src/modules/tools/regex/**`。

实施：

1. 在现有 contracts 中定义单一常量 `REGEX_MATCH_DISPLAY_LIMIT = 500`，Worker、engine 和 UI 共用。
2. engine 最多保存前 500 条；发现第 501 条时立即停止继续扫描，返回 `matchLimitReached: true`。
3. UI 最多创建 500 个结果节点，并显示“匹配至少 501 次，仅显示前 500 条”。不得把 501 写成精确总数。
4. 达到匹配上限时不再生成完整 replacement preview，显示“结果规模过大，本次未生成替换预览”。
5. 未达到上限时保持当前 JavaScript replacement 的精确语义；本轮不新增部分预览、分页或另一套 replacement 解释器。
6. 保持现有一次性 Worker、500 ms terminate、取消和晚到结果丢弃语义。

直接测试：

- 1 MiB 文本配合零宽全局表达式，返回对象最多 500 条且标记上限；
- 第 501 条之后不继续扫描、不生成 replacement preview；
- 组件最多渲染 500 个结果项并显示非精确截断文案；
- 普通少量匹配仍返回范围、捕获组和精确替换预览；
- 既有灾难性回溯 timeout、取消和晚到结果测试继续通过。

不增加易波动的单元测试毫秒断言。响应性只在后面的真实浏览器受影响流程中检查。

### 8.3 RC-08：工作日循环边界

Owner 范围：`apps/web/src/modules/tools/time/**`。

实施：

1. 在 `time.ts` 定义并导出单一常量 `WORKDAY_AMOUNT_LIMIT = 1000`。
2. `addWorkdays()` 在 `await getTemporal()` 和循环之前同时校验 safe integer 与 `-1000..1000`。
3. 工作日数字输入使用同一常量设置 `min/max`，并在表单附近持续显示范围。
4. `runWorkday()` 在 `splitDates()` 前复用现有 `assertTimeText`，分别校验节假日和补班日原始输入的 16 KiB UTF-8 合同。
5. 保持补班日优先、周一至周五默认和纯本地计算；不加入网络节假日、Worker 或快速跳周抽象。

直接测试：

- `-1000`、`0`、`1000` 可执行；`-1001`、`1001` 在循环前拒绝；
- 正负方向、节假日、补班日优先级不回归；
- 节假日或补班日原始输入超过 16 KiB 时在拆分/Temporal 前拒绝；
- UI 的 min/max 和可见说明与纯函数常量一致。

移动 WebKit 实测 `±1000`。如果该边界在目标页面上明显超过约 300 ms 并造成不可交互，停止发布并把常量调低后重测；不要在本轮临时加入分块调度或 Worker。

### 8.4 Local-safety 定向命令

```bash
pnpm --filter @dev-toolbox/web exec vitest run src/modules/tools/jwt
pnpm --filter @dev-toolbox/web exec vitest run src/modules/tools/regex
pnpm --filter @dev-toolbox/web exec vitest run src/modules/tools/time
git diff --check -- apps/web/src/modules/tools/jwt apps/web/src/modules/tools/regex apps/web/src/modules/tools/time
```

## 9. JSON AI cancellation owner 精确任务

### 9.1 RC-03：正文完成后的 caller 断连

Owner 文件：

- `apps/ai-worker/src/index.ts`
- 可新建 `apps/ai-worker/src/json-type-generation-http.ts`
- 可新建 `apps/ai-worker/src/json-type-generation-http.test.ts`

新 helper 只服务 `/internal/v2/json-type-generation` 当前端点，用于隔离 Node HTTP 事件和真实 loopback 测试；它有当前消费者和真实边界，不得扩成通用 HTTP cancellation framework。

实施：

1. 保留一个 request-local `AbortController`，同时覆盖两条不同的真实边界：
   - request `aborted`：正文尚未完整时断连；
   - response `close`：正文完整、Provider 仍在等待时 caller 断连。
2. response close 只有在 `response.writableEnded === false` 时 abort；正常 `response.end()` 不误取消。
3. abort 保持幂等，Provider 继续收到当前 `generateJsonTypesWithAI` 已支持的同一 signal。
4. `finally` 同时移除 request/response listener，不能在 keep-alive 连接上泄漏。
5. caller 已断开或 response 已销毁时直接结束 handler，不再尝试写 503；不记录请求正文、Provider 凭据或完整上游错误。
6. 不修改 `model-gateway.ts`：signal 从 `index.ts` 到 `generateJsonTypesWithAI` 再到单次 provider turn 的链路已经存在。
7. 不改 Go、API schema、错误码、数据库、重试或后台任务。

### 9.2 必须使用真实 Node HTTP 事件的测试

测试使用 `node:http`、`127.0.0.1` 和随机端口，不只使用 EventEmitter fake，不访问真实 Provider。

1. **正文完整后断连**：client 完整 POST 合成 JSON；server 确认 `request.complete === true` 后让 injected provider fake 等待 signal；client 在响应前 destroy；断言同一 signal abort、provider 只调用一次、没有成功响应。
2. **正常完成**：provider fake 返回合成代码，client 收到并读完 200；断言 signal 未 abort。
3. **正文未完成时断连**：声明较大 `Content-Length`，只发送部分 body 后 destroy；断言 request `aborted` 路径仍 abort。

所有等待必须有本地有界 timeout，并在 `finally` 关闭 client socket、server 和未完成 Promise，防止测试挂住。不要增加重试来掩盖事件竞态。

### 9.3 JSON AI 定向命令

```bash
pnpm --filter @dev-toolbox/ai-worker exec vitest run src/json-type-generation-http.test.ts src/json-type-generation.test.ts
pnpm --filter @dev-toolbox/ai-worker check
pnpm --filter @dev-toolbox/ai-worker test
pnpm --filter @dev-toolbox/ai-worker build
git diff --check -- apps/ai-worker/src/index.ts apps/ai-worker/src/json-type-generation-http.ts apps/ai-worker/src/json-type-generation-http.test.ts
```

本轮预计不修改 Go，因此不运行额外 Go 测试。若 ownership 经 integrator 明确扩大到 Go，才按实际受影响包增加测试，不能在本任务中自行扩大。

## 10. Dependency integrator 精确任务

### 10.1 RC-09 的正确修复判定

当前证据是：`monaco-editor@0.56.0` 声明 `dompurify@3.4.8`，且 `esm/vs/base/browser/domSanitize.js` 相对导入 Monaco 自带的 `dompurify/dompurify.js` 3.4.8。因此：

- 只写 pnpm override 不足以证明浏览器 bundle 已修复；
- 只让 `pnpm audit --prod` 不再报告也不足以证明已修复；
- 必须让 Monaco 的运行时 import 实际解析到修复版，并用构建和桌面行为验证。

允许写入范围：

- 根依赖/工作区中 pnpm 生成的 override 与 patchedDependencies 配置；
- `pnpm-lock.yaml`；
- pnpm 生成的单个 Monaco patch 文件；
- 如必须记录精确依赖，`apps/web/package.json` 由 dependency integrator 独占。

不允许修改 SafeMarkdown；它使用 `markdown-it` 且 `html: false`，不在本公告路径内。

### 10.2 依赖验证

至少运行并记录：

```bash
pnpm install --frozen-lockfile
pnpm why dompurify
pnpm audit --prod
pnpm --filter @dev-toolbox/web check
pnpm --filter @dev-toolbox/web build
git diff --check -- package.json pnpm-workspace.yaml pnpm-lock.yaml apps/web/package.json patches
```

构建后检查：

- Monaco ESM patched import 是 bare `dompurify`；
- 安装树解析到预期修复版本；
- 生产 chunk 不再包含 `DOMPurify 3.4.8`；若压缩移除版本 banner，必须用构建解析证据确认实际模块来源，不能凭“没搜到字符串”判通过；
- 首页和知识页初始 chunk 仍不包含 Monaco/CodeMirror；
- 桌面 JSON/YAML 冷启动、诊断/hover、主题同步和离页 dispose 正常。

只做一个代表性的 sanitizer 路径 smoke，不建立新的安全测试框架或 fuzz 矩阵。

## 11. 稳定候选验证矩阵

### 11.1 自动化门禁

Owner 定向测试已通过后，在同一稳定工作树上只运行一次：

```bash
pnpm check
pnpm test
pnpm build
pnpm audit --prod
git diff --check
git status --short
```

说明：

- `pnpm check/test/build` 覆盖本轮修改的 Web 和 ai-worker。
- 本轮不修改 Go，不额外运行 Go 测试；已有旧 Go 证据保留，但不伪装成本轮新运行。
- 若最终确实修改 Go，必须把相应受影响包测试加入本表并在文档中记录；否则不得宣称通过。
- 不重复运行同一份稳定输入上的全量命令。修复失败项后，只补跑受影响定向检查；最终输入变化影响根门禁时再补跑对应根命令。

### 11.2 受影响浏览器验收

本轮没有路由、shell 或 Stitch 布局变更，因此不重做八工具全流程和全部 V1 页面矩阵。只在构建后的同一候选上检查受影响流程。

桌面 Chrome，1440×900：

1. JWT：分别运行两个不同合成 Token，结果、Header、Payload 属于最后一次显式运行；主要竞态由 deferred 组件测试证明，不用人工计时制造不稳定竞态。
2. YAML：三个带注释文档格式化后仍为三个，分隔符不重复；再转 JSON 数量正确。
3. JSON：text diff 精确边界/超限提示；`$['a,b','c'].value` 返回两个规范路径。
4. Regex：1 MiB 零宽全局 fixture 只显示前 500 条、明确“至少 501”，没有替换预览，页面仍可点击、取消和切换路由。
5. Time：`1000` 与 `-1000` 得到结果，`1001` 与 `-1001` 立即显示范围错误。
6. JSON/YAML：Monaco 冷启动、诊断或 hover、主题同步和离页释放无异常。

移动 WebKit，390 px 宽：

1. Regex 同一截断 fixture 不产生无界节点，页面可继续操作。
2. Time `±1000` 可完成，`±1001` 立即拒绝；记录实际观察，不写虚构耗时。
3. JSONPath comma union 和 YAML 三文档各完成一次主流程；手机仍只加载 CodeMirror，不初始化 Monaco。

浏览器期间附带确认：

- 修改过的确定性工具没有新增业务 API 请求；
- localStorage、sessionStorage、IndexedDB 没有写入工具正文；
- 控制台没有由本轮修改新增的 error/warning；
- 不访问真实 Provider。RC-03 以 Node loopback 集成测试为主要证据。

如果 dependency integrator 未改变移动编辑器依赖，移动端只做上述窄流程，不重测所有 CodeMirror 生命周期和全部工具。

### 11.3 独立终审清单

Independent final reviewer 只读回答：

1. 九项问题是否各有对应代码 diff 和直接测试，是否存在只改测试/只改文案的假修复？
2. JWT 成功和失败两个晚到分支是否都受 run ID 保护？
3. YAML 是否只由一处插入 `---`，格式化输出可重新解析为原文档数？
4. AI cancellation 是否覆盖 request 半包与 response 提前 close，正常 close 是否不 abort？
5. Regex 是否在第 501 条停止，而不是先创建全部结果再 slice？
6. JSON text diff 是否对两个编辑面分别按 UTF-8 字节校验？
7. JSONPath 是否仍 `eval: false`，是否没有开放用户 backtick/script？
8. 工作日范围是否在 Temporal/循环前校验，UI 与纯函数是否使用同一常量？
9. Monaco 实际 bundle 是否已脱离 vendored 3.4.8，而不是只有 audit 输出变化？
10. 文档是否准确区分旧 `rc.1` 历史和新本地候选，是否没有宣称部署、正式发布或真实 Provider 已验证？
11. diff 是否只落在本文 ownership，是否没有 V2.1/V2.2、基础设施或无关 V1 重构？

终审发现问题时只报告文件、行号、影响和重现证据；由原 owner 修复，reviewer 不直接写入。

## 12. Agent 任务消息模板

Integrator 派发每个任务时使用同一短模板，避免 Agent 自行解释范围：

```text
目标：关闭 docs/15 中的 RC-XX；不处理其他问题。
Owner：列出唯一可写目录/文件。
必读：AGENTS.md、docs/09、docs/10、docs/13、docs/14、docs/15 对应章节。
必须做：复制对应实施条目和直接测试。
明确不做：复制对应禁止项；不得修改共享依赖、文档或其他 owner 文件。
协作：你不是仓库中的唯一 Agent；保留并适配现有用户/其他 Agent 改动，不得回退。
停止条件：需要越过 ownership、改变冻结合同或新增依赖时停止并报告证据。
返回：修改文件、关键语义、实际命令与结果、剩余阻塞；不要宣布版本完成。
```

## 13. 完成定义

只有同时满足以下条件，本文修复才可标记完成：

- RC-01～RC-09 全部有真实实现和直接回归测试，未留“接受风险”代替修复。
- 所有 owner 均未越过文件 ownership，用户现有 V2 成果和旧验收历史完整保留。
- 稳定候选 `pnpm check`、`pnpm test`、`pnpm build`、`pnpm audit --prod`、`git diff --check` 实际通过。
- 受影响桌面和移动 WebKit 流程实际检查通过，没有为未修改页面重复全量验收。
- 独立终审未发现剩余 P0/P1，且九项固定清单均关闭。
- 文档只声明“新的本地 RC 候选已验证”，明确未命名、未提交、未部署、未正式发布、真实 Provider 未验证。
- 没有新增 V2.1/V2.2 能力、外部服务、基础设施、通用框架、重复防御或无当前消费者的抽象。

任一条件不满足时，停止在“V2.0 RC 审计修复中/阻断”，列出准确失败项和下一步，不用旧 `rc.1` 证据补齐新候选缺失的证据。

## 14. 执行结果（2026-08-31）

- RC-01～RC-09 均已完成实现和直接回归；没有使用“接受风险”代替修复。浏览器额外发现的 Monaco 0.56 service 注册时序问题只通过首次 model 前预加载既有 JSON mode 修复，没有导入全语言集合、重写编辑器 adapter 或新增抽象层。
- 当前稳定候选实际通过 `pnpm check`、`pnpm test`、`pnpm build` 和 `pnpm audit --prod`。Web 为 `36` 个测试文件、`177` 项，ai-worker 为 `6` 个测试文件、`149` 项；生产依赖审计为零已知漏洞。本轮未修改 Go，未运行也未宣称新的 Go 测试结果。
- 桌面受影响流程与 Monaco JSON-first、YAML-first→JSON 冷启动已实际检查；移动端使用 Playwright `1.62.1` WebKit build `2336` 在 390 px 宽执行 JSONPath、YAML 三文档、1 MiB 正则截断和工作日 `±1000/±1001`。确定性流程没有认证以外的业务 API 请求，没有写 localStorage、sessionStorage 或 IndexedDB，控制台没有 warning/error/pageerror。
- Monaco 安装树、窄 patch 和生产 bundle 均指向 `dompurify@3.4.14`，生产 bundle 不含 vendored `3.4.8`；首页和 Home 初始 chunk 没有 Monaco/CodeMirror。
- 独立只读终审未发现剩余代码级阻断或超出本文范围的修复。文档收口后的 `git diff --check` 与新增源码/文档尾随空白检查均已通过；pnpm patch 中统一 diff 所需的空白 context marker 按格式保留。
- 本文初始阶段只完成本地修复与验收，当时没有命名、提交或部署新候选。owner 后续单独授权的 `v2.0.0-rc.2` 部署见第 15 节；旧 `v2.0.0-rc.1` 的部署、恢复和升级记录仍只属于修复前字节。

## 15. owner 后续授权的候选部署（2026-08-31）

- 修复后字节已命名并部署为 `v2.0.0-rc.2`。归档不包含 `.git`、依赖、构建产物、部署 Secret/环境文件或运行数据；由于 Monaco 的锁定 patch 已成为安装输入，两个生产 Dockerfile 只增加了安装前复制 `patches/` 的必需步骤。
- `v2.0.0-rc.2` 三张镜像构建、生产静态检查、从 snapshot `6a52181b22f7178024a8a50393949894112ee528160b3054adbaf71a96265038` 开始的隔离空机恢复、`v2.0.0-rc.1 → v2.0.0-rc.2` 正式升级、公网 HTTPS/安全头和容器健康检查均通过。隔离恢复耗时 `27s`、完整性 `0/0/0`、`containsUserContent=false`；升级前生成 snapshot `2ce37835eda5418ffb83b70dd4de2d76acd957dc908811707f6b08971634f664`，PostgreSQL 未重启。
- 生产 Chrome 桌面与 390 px 手机关键流程、旧 query 迁移、响应式布局和八个本地工具主路径已实测。摘要工具暴露的 CSP 问题只通过 `script-src 'self' 'wasm-unsafe-eval'` 放行 WebAssembly 编译，未加入通用 `unsafe-eval` 或回退实现；修正后生产 SHA-256 实测通过。生产 WebKit 新会话没有登录态，因此只保留部署前 WebKit 全流程和当前 WebKit CSP 能力证据，不伪造生产登录后 WebKit 证据。
- 只读运维状态中 `backup_restore`、`browser_accessibility`、`deployment_security` 已为 `passed`；`ai_policy` 仍为 `review`，等待 owner 配置并验证真实 Provider。当前没有 Git commit/tag，没有正式发布，也没有实现 V2.1/V2.2。

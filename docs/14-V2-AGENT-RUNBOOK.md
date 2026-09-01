# 开发百宝箱第二期多 Agent 开发手册

状态：**V2 协作合同；实现开始前必读**

最后更新：2026-08-31

## 1. 目的

本文不是产品需求补充，而是防止多个 Agent 同时开发时发生范围漂移、重复抽象、共享文件冲突和合同分叉。每个 Agent 只完成分配给自己的最小完整闭环；没有 ownership 的共享文件不能自行修改。

用户明确要求优先。本文与产品合同冲突时停止并上报，由 integrator 更新权威文档后再继续；不得在代码中创造“临时第三种解释”。

## 2. 开始任务前的必读顺序

所有 V2 Agent：

1. 根目录 `AGENTS.md`。
2. `docs/09-V2-TOOLBOX-BASELINE.md`。
3. 自己任务对应的专题：
   - 前端/依赖/Worker：`10-V2-TOOLBOX-ARCHITECTURE.md`
   - 阿里云/API/设置/JSON AI：`11-V2-CLOUD-SERVICES-CONTRACTS.md`
   - 页面/响应式/文案：`12-V2-TOOLBOX-UX-AND-STITCH.md`
   - 测试/验收：`13-V2-TOOLBOX-DELIVERY-AND-ACCEPTANCE.md`
4. 与修改文件最近的现有 V1 文档和测试。
5. 任务对应的精确 Stitch Screen ID；只做纯函数/后端时不强制读取无关画面。

读完后先写出自己的：目标、拥有目录/文件、明确不做、依赖的已存在合同、最小验证。这个说明可以放在任务消息/PR 描述，不新建过程文档。

## 3. 权威范围

| 来源 | 决定什么 | 不能被什么覆盖 |
|---|---|---|
| `09` 基线 | 工具清单、版本、产品边界、本地/云原则 | 库默认能力、Stitch 示例、个人偏好 |
| `10` 架构 | 模块、进程、依赖、Worker、调用位置 | 为“统一”新增服务/框架 |
| `11` 合同 | 表、字段、API、额度、错误和事务 | 前端临时模型、SDK 自动重试 |
| `12` UX | Screen ID、布局、状态、文案、响应式 | Stitch 生成 HTML、示例数据 |
| `13` 验收 | 实施顺序、必测用例、完成门槛 | “本地看起来能用” |
| V1 冻结文档 | 未被 V2 明确覆盖的一期事实 | V2 不能顺手重写历史 |

## 4. Ownership 模型

一个文件在同一集成窗口只能有一个写 owner。多个 Agent 可以读同一合同，但不能并行编辑同一共享文件。Integrator 在分工前记录 owner；没有记录则视为未授权修改。

### 4.1 必须单 owner 的共享范围

| 范围 | 建议 owner | 其他 Agent 的动作 |
|---|---|---|
| `apps/web/src/app/router.ts` | Web shell integrator | 提交需要的 route 定义，不直接改 |
| `apps/web/src/components/shell/AppShell.vue`、`AppRail.vue`、`ModuleNav.vue` | Web shell integrator | 提交入口/导航需求 |
| `apps/web/package.json`、`pnpm-lock.yaml` | Web dependency integrator | 不自行安装包；提供依赖清单 |
| Monaco/CodeMirror adapter 与通用 Worker request/cancel envelope | Editor/performance owner | 只管编辑器/生命周期/取消外壳，不定义 JSON/YAML AST 或业务消息 |
| `apps/api/cmd/server/main.go` | API integrator | 模块 owner 提供 `NewService/RegisterRoutes` |
| `apps/api/go.mod`、`go.sum` | API dependency integrator | SDK owner提供精确包需求 |
| `007_v2_aliyun_services.sql`、schema version | Aliyun settings/quota owner | 其他 Agent 不加平行迁移 |
| `apps/api/internal/aliyun/**`（含 `translation_languages.v1.json`） | Aliyun API owner | Web/AI Agent 不修改；语言与 pair 只维护这一份 |
| `apps/api/internal/ai/json_type_generation.go` 及对应测试 | JSON AI owner | 只实现窄公开 handler，不改一期 task schema |
| `apps/api/internal/ai/service.go` | API integrator | JSON AI owner提交单条 route 接线需求，不直接并行编辑 |
| `apps/ai-worker/src/index.ts`、`model-gateway.ts`、新增 JSON type-generation handler/prompt | JSON AI owner | 其他 Agent 不扩任务类型 |
| `apps/web/src/modules/settings/AliyunSettingsView.vue` 及页面局部测试 | Aliyun Settings Web owner | 只消费已冻结设置/usage/language API |
| `apps/web/src/modules/settings/SettingsSubnav.vue` | Web shell integrator | Settings owner提交一个导航项需求，不直接并行编辑 |
| `Makefile`、Compose、部署配置 | Release integrator | V2 不应改服务拓扑；测试入口提需求 |
| `README.md`、`PRODUCT.md`、`AGENTS.md`、`docs/**` | Documentation integrator | 功能 owner 反馈事实，不各自重写索引 |

`main.ts`、全局 token、共享 API client 等如果必须修改，也由 shell/integrator 分配单 owner。

### 4.2 可以并行的独立范围

在合同稳定且共享依赖由 integrator 先落地后，下列目录可分别分配：

- `modules/tools/base64/**`
- `modules/tools/url/**`
- `modules/tools/jwt/**`
- `modules/tools/time/**`
- `modules/tools/digest/**`
- `modules/tools/regex/**`
- `modules/tools/json/**` + `modules/tools/yaml/**`（同一个 Structured-data owner）
- `modules/tools/translate/**`
- `modules/tools/ocr-translate/**`

JSON/YAML 固定由同一个 Structured-data owner 实现无损 AST、JSON→YAML 数值合同和两类业务 Worker 消息；不得拆给两个业务 Agent。Editor/performance owner 只提供编辑器 adapter 与通用 request ID/cancel/late-result envelope，不接触解析语义。这样仍可与其他工具并行，但 JSON/YAML 不会各写一套数字或转换规则。

翻译/OCR 共用额度/队列/API，因此 Go 后端不拆成两个并行写 owner；Web 页面可以在 API 合同稳定后分别实现。

## 5. 集成顺序与停止点

### 5.1 V2.0

1. Documentation/Design 已冻结（当前文档与 Screen 34–42）。
2. Web dependency owner 安装并锁定批准依赖。
3. Shell owner 完成中立首页、路由兼容和工具导航。
4. Editor owner 完成 Monaco/CodeMirror/Worker 生命周期合同。
5. 独立工具 owner 开发并跑局部测试。
6. JSON AI owner 在本地类型生成稳定后接窄接口。
7. Integrator 合入路由、依赖和共享组件。
8. QA 按 V2.0 矩阵验收。

停止点：Foundation 未通过时，不把所有工具一次性接入 shell；编辑器 adapter 未稳定时，JSON/YAML Agent 不各自引入包装器。

### 5.2 V2.1

1. Aliyun owner 先用 fake client 完成迁移、设置、额度、幂等和队列。
2. API 合同测试稳定后，Web settings/translate owner 对接 mock。
3. 官方 SDK adapter 最后接入，仍由 fake 覆盖默认测试。
4. Integrator 完成 `main.go`、Go 依赖和 schema version。
5. QA 完成并发、月末、结果不确定和日志检查。

停止点：额度事务未通过前禁止真实 SDK 调用；专业 scene 未配置时禁止专业版 fallback；真实凭据未获明确授权时禁止烟测。

### 5.3 V2.2

1. OCR Web owner先完成本站资产与本地单 worker。
2. Aliyun owner在既有额度/队列中增加 `ocr_general`，不另建系统。
3. OCR Web owner增加明确云确认，再组合已有翻译流程。
4. QA验证本地零上传与云路径双重确认。

停止点：Tesseract 默认 CDN 未替换为本站资产时不能发布；云 OCR 未走额度预留时不能联调。

## 6. 每类 Agent 的明确任务边界

### 6.1 Web shell/integrator

做：路由动态 import、旧 query 迁移、AppRail/ModuleNav/mobile drawer、当前版本可见性、最终依赖集成。

不做：工具业务逻辑、工具 registry、最近使用、收藏、个性化排序、未发布占位页面、重写知识 Workspace。

验收：Foundation F-01–F-07；知识现有相关测试；bundle 路径检查。

### 6.2 本地工具页面 owner

做：一个工具的纯函数/Worker/UI/错误/取消/测试，复用已批准依赖和壳层。

不做：API、数据库、analytics、内容 storage、路由共享文件、为其他未来工具建抽象。

验收：`13` 中该工具全部用例；fetch/storage spy；390/1024/桌面状态。

### 6.3 Editor/performance owner

做：按设备只创建一种编辑器、动态 import、model/view/worker dispose、Diff 适配、业务 Worker protocol、构建产物检查。

不做：IDE、LSP、远程 Schema、全语言包、Vue wrapper、通用 worker pool、知识模块编辑器改造。

验收：反复路由进入/退出、设备条件切换、取消、晚到消息、首包与 memory 抽查。

### 6.4 Structured-data（JSON + YAML）owner

做：无损 AST、允许的 JSONPath 子集、结构 Diff、Draft 2020-12 有限数值语义、受限修复、YAML 1.2/注释/alias。

不做：`eval`、远程 `$ref`、Kubernetes/Helm、任意 repair、quicktype、任意精度 Schema 新引擎、自动业务类型推断。

必须写 fixture 明确 `9007199254740993`、`1.2300`、`1e1000`、`-0`、重复 key、custom tag 和 alias 上限。

### 6.5 JSON AI owner

做：拥有 `apps/api/internal/ai/json_type_generation.go`、对应 Go 测试和 ai-worker 的固定 prompt/窄 handler；实现 Provider/model 校验、容量公式、结构/完整确认、纯文本代码返回、取消和 mock。`internal/ai/service.go` 只由 API integrator 加一条路由。

不做：新 AI task type、Artifact、历史、Agent loop、工具调用、代码执行/编译、任意 system prompt、默认上传。

如果实现要求给 task 填假 `item_id`，立即停止，说明走错了合同。

### 6.6 Aliyun API owner

做：`internal/aliyun`、官方 SDK adapter、固定 endpoint、设置加密、额度事务、进程内 queue、每 permit 单 in-flight handler、稳定错误、无正文日志。

不做：AI worker 转发、万能 cloud provider、Redis/队列表、调用历史、余额抓取、自动重试、任意 endpoint、PAT scope。

SDK 请求前必须能指出已经成功预留的 call row；不能指出就禁止发出。

### 6.7 Aliyun Settings Web owner

做：拥有新增 `AliyunSettingsView.vue` 及其局部测试；实现凭据掩码/替换/删除、三项额度、专业 Scene、并发、本地账本和账号共享额度警告。向 shell owner提交 `/settings/aliyun` 与 `SettingsSubnav` 接线需求。

不做：直接编辑 router/SettingsSubnav、连接测试旁路、云账号管理、价格/资源包、余额抓取、角色系统、保存 Secret 到浏览器。

### 6.8 Translation Web owner

做：手动/自动语言、交换规则、技术内容保护、UTF-16 分块、确认、顺序 chunk、当前标签页恢复、queue/额度/不确定状态。

不做：后台任务、历史、术语库、文件翻译、单独语言检测、自动重试、保存到知识。

API 只接收已经保护的单 chunk；不要把 Markdown parser 复制到 Go。

### 6.9 OCR Web owner

做：单图输入、客户端尺寸处理、Tesseract 单 worker、校对、云确认、复用翻译流程。

不做：服务器本地 OCR、批量/PDF/相机、手写承诺、版面回绘、附件/知识集成、自动云降级。

### 6.10 QA/acceptance owner

做：按矩阵运行能改变结论的最小检查，记录实际命令/浏览器/结果，检查网络、storage、bundle、日志和边界。

不做：为凑数量造问题、默认调用付费 API、替功能 owner重构代码、把未运行写成通过。

## 7. 契约变更流程

实现发现合同无法满足时：

1. 停止相关写入，不先加兼容分支。
2. 提供最小复现、受影响合同、两种以内可行选择和各自影响。
3. 判断是否改变产品范围、外发内容、额度、服务拓扑、数据库或用户主流程。
4. 重大变化由用户确认；纯粹纠错由 documentation/integrator 更新权威文档。
5. 文档合并后相关 Agent 再继续。

禁止通过 feature flag、隐藏设置、环境变量或“先留字段”绕过决策。

## 8. 反过度设计检查

每个新增项必须回答唯一的当前消费者：

| 新增项 | 必须能指向 |
|---|---|
| 表/字段 | `11` 的设置、额度或幂等结算字段 |
| API | 当前工具的已确认主流程 |
| 依赖 | `10` 依赖表中的一种真实能力 |
| 共享抽象 | 至少两个已经实现的调用者，而非未来假设 |
| 校验 | 浏览器不可信输入、持久化数据、版本错配或真实外部边界 |
| 错误码 | UI 有明确不同动作的失败状态 |
| 配置项 | owner 真实需要改变且范围已确认的值 |

以下理由不成立：“以后可能会有更多工具”“企业项目都这样”“顺便统一”“库本身支持”“便于未来切供应商”“多加一层更安全”。已有上游类型/事务/数据库约束能保证的，不再重复三层校验。

## 9. 安全与隐私检查

提交前逐项确认：

- [ ] V2.0 确定性模块没有业务 API client import；JSON AI 调用只在显式确认分支，本地 OCR 只读取本站公共模型资产且不上传图片/文本。
- [ ] 正文、结果、JWT、图片、key 没有进入 URL、storage、数据库和日志。
- [ ] Aliyun Secret 只在 Go 服务解密，响应只显示末 4 位状态。
- [ ] 云调用前有服务端配额预留，且 endpoint 固定。
- [ ] 结果不确定不自动重试；同 key 不重复调用。
- [ ] JSON AI full payload 有逐字确认，structure 默认不含值。
- [ ] 没有执行用户内容、模型代码、正则回调、Cron、URL 或命令。
- [ ] 测试 fixture 是合成数据，没有真实凭据/用户文本。

## 10. 依赖与生成物规则

- 业务 owner 不直接运行会改 lockfile 的安装命令；把包名和用途交给 dependency integrator。
- Integrator 使用 `pnpm add --save-exact` 的等价行为并审核实际依赖树；不添加 wrapper 或全量语言包。
- Go SDK 由 API dependency integrator更新 `go.mod/go.sum`；不在多个分支重复执行 `go get`。
- Tesseract 公共资产的来源、版本和许可证必须可追溯；资产不是用户内容，可以缓存。
- 不提交 Stitch 生成 HTML、截图临时文件、真实云响应、AccessKey 或本地 `.env`。
- 自动格式化/生成只作用于 owner 范围；不得借机改全仓库格式。

## 11. Git 与共享工作区规则

- 开始前查看 `git status`；已有改动默认属于用户或其他 Agent，不回滚、不覆盖。
- 一个 Agent只修改分配目录和明确列出的共享文件。
- 不使用 `git reset --hard`、`git checkout --` 或删除他人未提交改动。
- 发现同一文件已有他人修改时停止该文件写入并联系 integrator。
- 提交/交付只包含任务范围；不要混入重命名、无关格式、依赖升级和旧代码清理。
- 合并冲突由共享文件 owner处理；工具 owner提供意图和测试，不在冲突中重写对方逻辑。

## 12. 最小验证原则

Agent 先跑自己范围内最小测试；只有集成 owner 在稳定候选上跑全体 `make check/test/build`。测试失败后修复直接原因并重跑受影响部分，不在输入未变化时重复全套。

任何超过 10 分钟的完整 E2E、性能或真实服务检查，启动前说明目的和更小替代；未获当前授权不调用真实付费服务。

## 13. Agent 交付格式

每个 Agent 完成时用以下结构交付，不创建额外报告文件：

```text
目标：
完成：
明确未做：
改动文件：
合同/API 变化：无（或列出已批准文档位置）
实际运行：<命令>
结果：<通过/失败及关键数值>
未运行：<检查及原因>
风险/需 integrator 动作：
```

不能只说“已完成”或“测试通过”；必须给出文件和实际命令。真实云调用要另列 meter、次数/字符和是否进入本地账本，但不写正文。

## 14. 可直接复制的任务模板

### 14.1 单个本地工具

```text
你负责 apps/web/src/modules/tools/<tool>/**，不是唯一在仓库工作的 Agent；不要回滚或覆盖其他改动。
如果任务涉及 JSON 或 YAML，必须把两个目录一起分给同一个 Structured-data owner，不能使用本模板拆成两个 Agent。
先读 AGENTS.md、docs/09、10、12、13、14 和该工具对应 Stitch Screen。
实现该工具在 docs/09 中的完整主流程、错误、取消、超限和移动状态；添加本目录相关测试。
不得修改 router、AppRail、ModuleNav、package.json、pnpm-lock 或其他工具目录；需要共享变更时只报告给 integrator。
不得调用 API、持久化内容或增加未批准依赖。完成时按 docs/14 §13 交付。
```

### 14.2 Aliyun 后端

```text
你负责 apps/api/internal/aliyun/** 和由 integrator 明确分配的 007 migration；不是唯一在仓库工作的 Agent。
先读 AGENTS.md、docs/09、10、11、13、14。严格实现固定 endpoint、secretbox、额度事务、幂等和进程内短队列；冻结 214 语言与专业 pair 单一数据源，OCR 复用现有 WebP decoder 并在上云前校验尺寸/比例；默认测试只用 fake client。
不得改 AI task/Artifact，不增加服务/Redis/通用供应商抽象，不记录正文，不自动重试。
main.go、go.mod/go.sum 和 schema version 由 integrator 修改；向其提供准确接线要求。完成时按 docs/14 §13 交付。
```

### 14.3 Web shell/integrator

```text
你是 V2 Web 共享文件唯一 owner。先读 AGENTS.md、docs/09、10、12、13、14，并读取 Stitch 34–37。
实现中立首页、/knowledge 兼容迁移、动态工具路由、AppRail/ModuleNav/mobile drawer；只注册当前里程碑已完成工具。
不要实现工具业务或创建 registry/plugin；保护现有 /items/:id 和知识 query。审核依赖没有进入首包，并运行 Foundation 验收。
```

### 14.4 JSON AI 窄路径

```text
你负责 apps/api/internal/ai/json_type_generation.go、对应测试，以及 ai-worker 的 JSON type-generation prompt/handler；不是唯一在仓库工作的 Agent。
先读 AGENTS.md、docs/09 §7.2、docs/10 §8、docs/11 §12、docs/13、docs/14。只复用现有 Provider 配置和内部服务令牌；实现启用/密钥/容量校验、单轮无工具调用和普通代码文本响应。
不得创建 AI task/event/Artifact、假 item_id、历史、代码执行或自动换模型。internal/ai/service.go 由 API integrator 只接一条 route；package/lockfile 变化交给依赖 owner。完成时按 docs/14 §13 交付。
```

### 14.5 阿里云设置 Web

```text
你负责 apps/web/src/modules/settings/AliyunSettingsView.vue 及局部测试；不是唯一在仓库工作的 Agent。
先读 AGENTS.md、docs/09、docs/11 §2–§8、docs/12 §9、docs/13、docs/14，并读取 Stitch Screen 41 的规范 ID。
实现凭据掩码/替换/删除、通用/专业/OCR 硬上限、专业 Scene、owner/global 并发、当前月本地账本和阿里云账号共享额度警告。保存不能调用云服务。
不得编辑 router/SettingsSubnav、保存 Secret 到浏览器、加入连接测试旁路、价格/资源包/余额抓取。把单个路由和导航项需求交给 shell owner。
```

### 14.6 翻译 Web

```text
你负责 apps/web/src/modules/tools/translate/**；不是唯一在仓库工作的 Agent。
先读 AGENTS.md、docs/09 §8、docs/10、docs/11 §8.5–§10、docs/12 §7、docs/13、docs/14，并读取 Stitch Screen 39/42。
语言和专业 pair 只读服务端静态 API；实现本地技术片段保护、UTF-16 分块、preflight、确认、queue、顺序 chunk、占位符恢复和当前标签页继续。PREFLIGHT_CHANGED 必须重新预检当前+剩余片段。
不得复制语言清单、额外调用语种识别、自动重试/自动换场景、保存正文或进入知识模块。共享路由/API client 变化交给 owner。
```

### 14.7 OCR Web

```text
你负责 apps/web/src/modules/tools/ocr-translate/** 和由 integrator 分配的本站 Tesseract 公共资产接入；不是唯一在仓库工作的 Agent。
先读 AGENTS.md、docs/09 §9、docs/10 §3.5、docs/11 §11、docs/12 §8、docs/13、docs/14，并读取 Stitch Screen 40/42。
先完成单图尺寸边界、单 worker 本地识别、进度/取消/校对，再增加用户明确确认的云重识别；翻译复用既有 Translation 流程。
不得自动上传、服务器运行 Tesseract、批量/PDF/相机、附件/知识接入、CDN 模型或第二套翻译实现。
```

## 15. 最终集成清单

Integrator 合并每个版本前确认：

- [ ] 所有改动都有唯一 owner，没有同文件并行覆盖。
- [ ] 代码与 09–13 当前合同一致，文档没有悬空链接。
- [ ] 当前版本以外路由/菜单/设置不存在。
- [ ] 依赖和迁移只有一条集成来源，锁文件没有无关变化。
- [ ] V2.0 确定性路径零业务 API/零内容持久化；JSON AI 和 OCR 静态资产例外已按合同分别验证。
- [ ] 云调用额度、scene、队列、幂等和不确定状态完整。
- [ ] Screen ID 正确，探索稿和 Stitch HTML 未进入生产。
- [ ] 实际检查与未检查都记录，未伪造真实阿里云/浏览器证据。
- [ ] V1 冻结文档、数据模型和发布证据未被改写。

满足这些条件后才进入 `13` 的版本发布门槛；本手册本身不是完成证据。

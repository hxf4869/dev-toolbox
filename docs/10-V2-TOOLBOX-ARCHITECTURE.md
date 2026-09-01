# 开发百宝箱第二期工具箱架构

状态：**V2 实现契约；V2.0–V2.2 已以 `v2.2.0-rc.1` 发布候选部署**

最后更新：2026-09-01

## 1. 目的与适用范围

本文把 `09-V2-TOOLBOX-BASELINE.md` 转成可以分模块实现的技术边界。本文只负责第二期新增内容；一期的知识、认证、AI Artifact、部署和备份架构在未明确覆盖处继续有效。

本文锁定以下决定：

- 八个本地工具只在浏览器运行。
- 阿里云机器翻译和 OCR 由 Go API 的窄模块直接调用官方 SDK，不经过 AI worker。
- JSON 的可选 AI 类型生成复用现有 AI Provider 和 AI worker，但不进入一期 AI 任务/Artifact 数据模型。
- 不增加常驻服务、Redis、消息队列、对象存储或第二数据库。
- 桌面 JSON/YAML 编辑器使用 Monaco，手机使用 CodeMirror 6；两者均按路由和设备懒加载。
- 工具内容不持久化；数据库只保存阿里云配置、月度额度账本和不含正文的调用元数据。

实现中如需要违反其中任一项，必须停止并先更新基线；不得用“统一架构”自行增加万能工具服务。

## 2. 运行拓扑

第二期沿用现有四服务拓扑：

```text
Browser
  ├─ local tool modules + Web Workers
  ├─ Monaco or CodeMirror 6 (JSON/YAML route only)
  ├─ Tesseract.js Worker/WASM (OCR route only)
  └─ /api/v1
       ↓
gateway (Caddy)
  ├─ static Web assets
  └─ reverse proxy
       ↓
api (Go modular monolith)
  ├─ existing auth/knowledge/ai/operations
  ├─ new aliyun module
  └─ PostgreSQL
       ↘
        Aliyun MT/OCR fixed endpoints

api ──internal authenticated request──> ai-worker
                                         └─ existing configured AI Provider
```

不创建 `tool-service`、`ocr-service`、浏览器端代理、后台队列进程或新的 Compose 服务。Tesseract 的 WASM、worker 和语言模型是 Web 静态资产，服务端只负责同源分发，不执行 OCR。

## 3. Web 模块边界

### 3.1 允许新增的目录

新增代码放在以下边界中；不要先创建空目录或无消费者抽象：

```text
apps/web/src/modules/home/              # 中立首页
apps/web/src/modules/tools/             # 工具入口与工具导航
apps/web/src/modules/tools/base64/
apps/web/src/modules/tools/json/
apps/web/src/modules/tools/url/
apps/web/src/modules/tools/jwt/
apps/web/src/modules/tools/time/
apps/web/src/modules/tools/digest/
apps/web/src/modules/tools/regex/
apps/web/src/modules/tools/yaml/
apps/web/src/modules/tools/translate/
apps/web/src/modules/tools/ocr-translate/
apps/web/src/modules/settings/           # 只增加阿里云设置页面
```

只有两个以上已实现工具需要相同代码时，才把代码提升到 `modules/tools/shared/`。允许优先共享的真实能力仅包括：本地/云服务徽标、复制反馈、字节计数、有界 Worker 调用、编辑器适配和云调用确认层。不得建立工具注册器、插件 manifest、通用 schema-driven form 或万能转换管线。

### 3.2 路由与首包

- `/`、`/knowledge`、`/tools` 和每个 `/tools/...` 页面都使用 Vue Router 动态 import。
- 原 `/` 的知识工作台移到 `/knowledge`；`/items/:itemId` 保持原深链接。
- `AppRail` 增加“首页、知识与记录、工具箱”三个明确入口；`ModuleNav` 对 `tools` 模式使用工具清单，不得误触知识列表请求。
- 工具详情可直接刷新和深链接；内容不进入 URL。
- 首页、登录、知识列表和非编辑器工具的入口 chunk 不得静态 import Monaco、CodeMirror、Tesseract、语言模型或全部工具实现。
- 每个工具只按实际需要加载依赖；不得创建一个包含十个工具库的 `tools/index.ts` 聚合入口。

### 3.3 本地处理与 Worker

以下操作放入业务 Web Worker：

- JSON/YAML 的 5 MiB 解析、格式化、转换、结构 Diff、Schema、JSONPath 和类型生成。
- 正则执行；每次运行创建一次性 Worker，主线程 500 ms 到期后直接 `terminate()`。
- 单文件分块摘要。
- 翻译前的大文本分块和占位符保护可在 Worker 中执行；最终确认数据仍回到页面内存。

简单的 Base64、URL、JWT 小输入和时间表单可以在主线程执行，但必须遵守输入上限。不得为了形式统一把每个按钮都包装为 Worker RPC。

Worker 消息只传纯数据和原始文本，不传 Vue ref、Monaco model 或 DOM 对象。页面卸载、取消或新请求覆盖旧请求时必须终止或取消对应工作；终止后不得晚到覆盖新结果。

### 3.4 编辑器选择与生命周期

编辑器选择在路由进入时用能力条件决定：

```text
viewport >= 768px 且 pointer: fine  → Monaco
其他情况                          → CodeMirror 6
```

窗口跨过条件时，先把最新文本复制到普通内存状态，销毁旧编辑器，再动态加载并创建新编辑器。一个编辑面同时只有一个编辑器实例；不得在 CSS 下同时挂载两套编辑器。

Monaco 约束：

- 只从 ESM 路径加载编辑器核心、JSON 和 YAML 基础语言贡献以及必要 worker。
- JSON/YAML 业务校验由本项目 Worker 完成，不增加 Monaco YAML language server，也不启用网络 Schema。
- Diff 使用 `createDiffEditor`；Vue 卸载时销毁 editor、diffEditor、每个 text model 和自建 worker。
- 不导入全语言集合，不让 Monaco 进入知识模块或首页 bundle。

CodeMirror 6 约束：

- 只组合 `state`、`view`、`commands`、当前语言和需要时的 `merge`。
- 移动 Diff 使用统一视图；达到计算上限时显示“为保证响应速度，已降级为概览”，不伪装为精确 Diff。
- 离开页面时销毁 `EditorView`；不创建另一套业务逻辑，输入输出合同与 Monaco 共用。

### 3.5 OCR 客户端资产

- `tesseract.js`、worker、WASM core、`eng` 与 `chi_sim` 语言数据全部由本站静态路径提供，不依赖运行时 CDN。
- OCR 路由首次打开时只显示下载说明；用户开始本地识别后再加载模型。
- 同一标签页最多一个 Tesseract worker。路由离开、取消或固定 5 分钟空闲后终止；下一次需要时重新创建。
- 浏览器 cache 可以保存公共 worker/WASM/语言模型；图片、OCR 输入和 OCR 文本不得进入 cache 或持久化存储。
- 模型计算消耗客户端 CPU、内存和网络，不消耗 API 容器运行内存；页面必须如实提示。

## 4. 前端依赖决策

所有新增依赖由一个 Web integrator 一次性修改 `apps/web/package.json` 与 `pnpm-lock.yaml`，使用精确版本，不使用 `^`、`~`。下表批准的是包身份和用途，不批准额外包装库：

| 能力 | 允许依赖 | 使用边界 |
|---|---|---|
| 桌面编辑器/Diff | `monaco-editor` | 仅 JSON/YAML 桌面路由动态加载 |
| 手机编辑器/Diff | `@codemirror/state`、`@codemirror/view`、`@codemirror/commands`、`@codemirror/lang-json`、`@codemirror/lang-yaml`、`@codemirror/merge` | 仅手机 JSON/YAML 路由 |
| JSON 无损数值 | `lossless-json` | 所有 JSON 解析和序列化禁止绕回原生 `JSON.parse/stringify` 破坏数值 |
| JSON Schema | `ajv` 的 2020 入口 | 仅 Draft 2020-12；没有 `loadSchema`，无远程 `$ref` |
| JSONPath | `jsonpath-plus` | 锁定精确版本，`eval: false`，不开放脚本过滤 |
| YAML 1.2 | `yaml` | strict、无 custom tags、`maxAliasCount=100` |
| JWT | `jose` | 只用浏览器 WebCrypto 和本地 key/JWKS |
| Cron 预览 | `croner` | 只计算未来时间，不传执行回调；严格拒绝无法正确表达的 Quartz 语义 |
| 文件摘要 | `hash-wasm` | Worker 内按算法精确导入和分块更新 |
| 时区/日期 | `@js-temporal/polyfill` | 先检测原生 `Temporal`，缺失才动态加载 |
| 本地 OCR | `tesseract.js` | V2.2 OCR 路由、单 worker、本站资产 |

明确不引入 Vue Monaco/CodeMirror 包装器、`vite-plugin-monaco-editor`、`quicktype`、`jsonrepair`、`re2-wasm`、`jsondiffpatch`、前端 Kubernetes/YAML server 或通用 worker pool。

### 4.1 无损 JSON 的已知边界

`lossless-json` 的大数不是原生 JavaScript `number`，而 Ajv 的 `type: number/integer` 和数值关键字都要求原生 number。本期选择明确降级，不写动态 Schema 改写器：

- 格式化、压缩、路径、Diff、Schema 生成和类型生成始终保留数字原始词法值。
- 校验前遍历无损 AST；只有当每个 `LosslessNumber` 都被当前锁定版本库判定为可安全转为 JavaScript number 时，才构造一份仅用于 Ajv 的 shadow value；原 AST/文本不改变。
- 只要任一数字不安全，Ajv 仍编译并验证 Schema 本身，但本次**整份实例 Schema 校验不执行**；UI 显示“实例包含无法安全映射到 JavaScript number 的数值，为避免错误结论，本次实例校验未执行”。
- 该状态是 `not_run_precision_guard`，不是 pass/fail/partial pass；不继续评估 `oneOf`、`if/then`、`$ref` 或任何其他实例关键字，避免组合语义产生假结果。
- 不把不安全值强转为 `number`，也不为本期实现任意精度 JSON Schema 引擎。

### 4.2 YAML 和 Cron 的已知边界

- YAML 格式化由 AST 重新序列化，尽力保留注释，但允许注释位置变化；只有用户点击格式化才改写输入。
- YAML 拒绝 `%TAG` 自定义指令和非标准 `!tag`，不启用 YAML 1.1 merge 行为。
- Cron 支持 Unix 5 段和本项目声明的 Spring/Quartz 兼容 6–7 段预览；如果 DOM/DOW 同时被具体指定，或 `?` 的严格语义无法可靠表达，则拒绝并提示，不静默按 `*` 计算。

## 5. Go API 模块

### 5.1 模块位置

阿里云功能统一放在 `apps/api/internal/aliyun/`，因为翻译、OCR、凭据、额度和并发共享同一个外部服务边界。建议文件按真实职责拆分：

```text
internal/aliyun/
  service.go          # 构造与路由注册
  settings.go         # 设置读写、密钥加解密
  quota.go            # 月度预留/结算
  queue.go            # 进程内短队列与 permit
  translation.go      # TranslateGeneral / Translate
  translation_languages.v1.json # 官方 214 语种与六个 Scene 的冻结元数据
  ocr.go              # RecognizeGeneral
  http.go             # 请求/响应映射和错误 envelope
```

不创建 `internal/tools` 万能模块，也不把阿里云功能放入 `knowledge` 或一期 `ai` task 表。只有确实需要的文件才创建；上面的清单是责任边界，不是强制一文件一层包装。

### 5.2 SDK 与出口

- 翻译：`github.com/alibabacloud-go/alimt-20181012/v2`。
- OCR：`github.com/alibabacloud-go/ocr-api-20210707/v3`。
- 公共配置：`github.com/alibabacloud-go/darabonba-openapi/v2`。
- WebP 尺寸解码复用仓库现有 `golang.org/x/image/webp` 的 decoder 注册；这是服务端 `image.DecodeConfig` 校验 PNG/JPEG/WebP 的批准实现，不增加第二个图片库。
- 翻译 endpoint 固定为 `mt.cn-hangzhou.aliyuncs.com`。
- OCR endpoint 固定为 `ocr-api.cn-hangzhou.aliyuncs.com`。
- 不接受浏览器传入 endpoint、回调 URL、OSS URL 或额外请求头。
- 同一份凭据和 endpoint 的 SDK client 复用；设置版本变化时原子替换 client，不逐请求创建。
- 每次阿里云 SDK 调用的总 deadline 固定为 45 秒并传播请求取消；设置页不暴露任意 timeout，每次上游请求不自动重试。
- `translation_languages.v1.json` 是通用版 214 code 与专业 Scene 有向 pair 的唯一源码，由 Go embed；Web 通过只读语言 API消费，不复制常量或运行时抓取官网。精确数据与更新停止条件见 `11` 第 2.1.1 节。

Aliyun 客户端只接受模块内部已校验的 DTO。浏览器不能直接接触 AccessKey，AI worker 也不能接触阿里云凭据。

### 5.3 身份与授权

当前产品仍是单实例、单所有者：

- “实例所有者”“管理员”“用户”在 V2 云服务范围内指同一个已登录 owner，不引入角色表或 RBAC。
- 设置读写、云调用、队列 ticket 均要求 owner Web 会话和现有 mutation 的 Origin/CSRF 保护。
- 现有 PAT 不获得阿里云设置或云工具权限；不增加新 PAT scope。
- 所有响应使用 `Cache-Control: no-store`，日志不记录正文、结果、图片和凭据。

## 6. 阿里云调用数据流

### 6.1 翻译

```text
Browser local source
  → local protect/chunk/count
  → preflight API (quota and engine decision, no source)
  → user confirmation
  → acquire in-memory permit
  → send one chunk + request key
  → transactional quota reservation
  → Aliyun SDK call
  → quota settlement + metadata
  → response in browser memory
  → next chunk, sequentially
  → release permit
```

一个翻译运行持有一个 permit，片段必须顺序发送。这样能保留进度、只重试失败片段，并避免同一文本的并发乱序。服务器不接收整个长文队列，也不保存尚未发送片段。

### 6.2 云 OCR

```text
Browser image
  → local size/type/dimension check and optional resize
  → preflight API (1 OCR call, no image)
  → user confirmation
  → acquire permit
  → multipart image stream + request key
  → reserve 1 call
  → RecognizeGeneral Body stream
  → settle metadata
  → OCR text returned to browser memory
  → release permit
```

图片不落盘、不进入附件模块、不转发 URL。Go 端只在请求生命周期中以有界流读取并转给 SDK；如 SDK 必须缓冲，最多缓冲已经通过 5 MiB 限制的一张图，调用结束立即释放引用。

## 7. 进程内短队列

短队列只解决用户已确认的云调用并发与可见排队，不是后台任务系统：

- 默认当前 owner 并发 1，全局并发 3。
- 设置允许 owner 并发 `1–3`、全局并发 `1–10`，并要求全局值大于或等于 owner 值。
- 当前只有一个 owner，“owner 限制”仍按 owner ID 跨会话计数，不能因此增加用户/租户模型。在单 owner 且 `global >= owner` 的 V2 中，全局值实际不会比 owner 值更早触发；保留两值是用户已确认的显式例外，不得为“让全局值有作用”增加第二用户、PAT 或内部调用者。
- 队列是 Go 进程内 FIFO，只保存随机 ticket ID、owner ID、operation、创建时间、状态，以及 translation permit 已预留的 chunk/UTF-16 units 累计值；不保存输入、图片、译文或片段。累计值只执行单次运行 `191`/`950000` 上限，不是内容历史。
- ticket 以 owner ID 授权，同一 owner 的任意有效 Web 会话持有 ticket ID 时都可查询或取消；V2 不存 session ID，也不宣称绑定到创建时的那一个浏览器会话。
- 最多 20 个等待 ticket；满时返回明确 `QUEUE_FULL`，不自动重试。
- 等待 ticket 2 分钟未取得 permit 则过期；进入 ready 后 15 秒未领取则释放给下一位。
- 活跃 permit 每完成一个片段续期；没有请求 in-flight 时连续 60 秒没有新的有效请求才释放。SDK 调用开始到 handler 完成结算之间，slot 必须始终占用。
- 一个活跃 permit 同一时刻只允许一个新 `Idempotency-Key` 的 handler in-flight；不同 key 并发进入返回 `CLOUD_PERMIT_BUSY`，既有相同 key 仍优先按幂等合同返回。这个互斥只保护单次运行，不扩展成通用任务锁。
- 完整翻译运行达到 10 分钟绝对上限后拒绝新 chunk；如正有一个 SDK 请求 in-flight，先标记 `cancel_requested`并传播取消，但 slot 仍保留到该 handler 返回并结算。剩余未发片段由浏览器明确重新排队。
- 浏览器离开页面或取消时：无 in-flight 则立即释放；有 in-flight 只记录 `cancel_requested` 并尝试取消，不提前释放 slot。断连的空闲 permit 依靠到期释放。
- API 重启会清空 ticket；浏览器收到未知 ticket 后显示“服务已重启，请重新排队”。这是进程内并发限制；重启前已发出的阿里云请求可能仍在上游完成，本地账本按 `uncertain` 恢复，不宣称跨重启仍能严格维持云端瞬时并发。

建议合同是创建 ticket、查询 ticket、领取/携带 permit、释放 permit。不要为它建表、增加 worker 或提供队列历史。具体 HTTP 见 `11-V2-CLOUD-SERVICES-CONTRACTS.md`。

## 8. JSON AI 类型生成

### 8.1 为什么是窄同步接口

类型生成是当前页面上的一次显式增强，不需要历史、重试中心、调度、Artifact 版本或条目关联。因此：

- 公开接口固定为 `POST /api/v1/tools/json/type-generation/ai`。
- Go 公开 handler 固定新增在 `apps/api/internal/ai/json_type_generation.go`；沿用现有 AI Service 的数据库、密钥和 worker client。`internal/ai/service.go` 只增加一条路由注册，不创建 `internal/tools` 或第二套 Provider service。
- Go API 读取用户选择的现有启用 Provider/模型，解密快照后调用 ai-worker 的窄内部接口。
- 内部接口固定为 `POST /internal/v2/json-type-generation`，继续使用现有内部服务令牌。
- AI worker 只接收目标语言、结构/完整样本、Provider 快照中的原始 `contextWindow`/`maxOutputTokens` 和截止时间；固定 prompt 与有效输出上限公式都由 worker 唯一生成，Go 不传 prompt 或预计算上限。
- 固定单轮、无工具、无图片、无 Agent loop、一次 provider attempt、30 秒总截止时间。
- 返回纯代码文本和可选 token usage；Go API 不创建 AI task、event、Artifact 或数据库记录。
- 浏览器取消会中断当前 HTTP 请求；服务端尽力传播取消，不做后台续跑。

不得复用 `organize_record`、`review_record`、`analyze_image` 任务类型，也不得为此向一期 task schema 增加假 `item_id`。

### 8.2 内容边界

- 结构模式由浏览器确定性生成，只包含字段名、容器关系和 JSON 原始类型。
- 完整模式的实际 JSON 在浏览器确认层逐字显示，并受 256 KiB 限制。
- API 与 worker 二次验证 mode、目标语言、字节上限和截止时间，但不重复实现 JSON 业务解析。
- prompt 固定在仓库并有版本号；用户不能编辑 system prompt 或添加任意工具。
- 可用模型必须同时满足：Provider 与模型均启用且未删除、Provider 已配置 API key、`context_window` 与 `max_output_tokens` 都非空且为正数。否则返回 `AI_MODEL_UNAVAILABLE`，不调用 worker/provider。
- worker 生成最终固定 system/user prompt 后，以两段 prompt 的 UTF-8 字节数之和作为保守的 `estimatedInputTokens` 上界，并保留 128 tokens 协议余量；`effectiveMaxOutputTokens = min(4096, max_output_tokens, context_window - estimatedInputTokens - 128)`。小于 256 时返回 `AI_CONTEXT_TOO_LARGE`，不得截断、缩写、换模型或发出 Provider 请求。
- Provider 错误只映射为稳定类别，不把上游正文、密钥或内部 prompt 返回浏览器。

## 9. 配置、密钥和数据库边界

- 新迁移从 `007_v2_aliyun_services.sql` 开始，不修改 `001`–`006`；应用要求的 schema version 同步更新。
- AccessKey ID 和 Secret 使用现有应用主密钥与 `platform/secretbox` AES-GCM 加密；列表/读取接口只返回是否配置和尾部掩码。
- 更新凭据必须同时提交新的 AccessKey ID 与 Secret；不接受空 Secret 表示沿用的隐式语义。
- 数据库不保存工具正文、JSON、JWT、翻译文本、译文、OCR 图片或 OCR 结果。
- 仅保存 `11-V2-CLOUD-SERVICES-CONTRACTS.md` 定义的设置、月度账本和调用元数据。
- 本期不提供独立“零费用连接测试”。第一次用户确认的真实调用才更新最近成功/失败状态；如以后加入测试，它必须走正常额度预留并明确计费，不能另开绕过配额的路径。

## 10. 资源与性能边界

### 10.1 服务器

- 八个本地工具不会增加 API CPU/RAM；它们只增加静态资源体积和客户端计算。
- Tesseract 不在服务器执行；服务器只托管可缓存静态模型文件。
- 云翻译/OCR 是短同步请求和轻量数据库事务；进程内队列上限 20，不能无界积累。
- 阿里云 client 数量随有效设置版本固定，不按请求增长。
- 不为当前单 owner 增加连接池、Redis 或后台清理器；月度账本惰性创建，队列到期在已有操作与轻量 ticker 中清理。

### 10.2 浏览器

- 首页初始包不包含编辑器、OCR、语言模型或全部工具实现。
- Monaco、CodeMirror、Ajv、Tesseract 分别按需要形成异步 chunk；禁止为方便把它们导入共享 shell。
- 5 MiB 文本操作和文件摘要不在主线程做完整计算。
- OCR 页面必须显示模型下载体积可能较大、客户端内存/CPU 占用明显；不承诺低端手机流畅，本地失败时只提供用户主动选择云 OCR 的按钮。
- 构建验收以实际 bundle 报告证明依赖没有进入非目标 chunk，不在设计阶段虚构一个任意 gzip 数字门槛。

## 11. 日志与可观测性

允许记录：稳定 operation 名、内部 request ID、Aliyun RequestId、引擎、成功/失败/不确定类别、预留/实际计量数、耗时、HTTP 状态和 queue wait；不允许记录输入、输出、图片、文件名、语言片段、AccessKey、Secret、JWT、完整上游错误正文或任意请求体。

状态页可以显示阿里云功能是否配置、最近成功时间、最近稳定失败类别和本地账本余量。它不显示调用历史列表，不把本地计数包装成阿里云官方实时余额。

## 12. 明确不做的架构

- 不做通用 `Tool` 接口、动态 registry、manifest、插件加载或运行时模块发现。
- 不做通用 job/queue 表、事件总线、CQRS、计费平台、套餐或 entitlement。
- 不让本地工具绕 API 记录使用次数、遥测或崩溃正文。
- 不把翻译/OCR塞入一期 AI task/Artifact；不让 AI worker 持有阿里云凭据。
- 不增加本地 OCR 后端、Python、Java 服务、GPU 探测或模型容器。
- 不抽象第二个云供应商；没有第二个真实实现时只写阿里云模块。
- 不把编辑器适配器扩展为通用 IDE 平台；只覆盖 JSON/YAML 当前操作。

## 13. 架构实现完成条件

- 实际目录与依赖符合本文，无额外常驻服务。
- 路由和 bundle 证明确实懒加载 Monaco、CodeMirror 与 Tesseract。
- V2.0 确定性路径证明零业务 API/零内容存储；JSON AI 只在确认分支，Tesseract 公共资产加载与图片/文本上传分别断言。
- Go 模块只调用固定阿里云 endpoint，凭据只在服务端解密。
- 进程内队列有容量、到期、取消、重启失效和并发测试。
- JSON AI 不创建一期 task/Artifact，也不能执行代码或任意 prompt。
- 所有新增数据库对象都能指向设置、配额或幂等调用这一真实消费者；没有预留未来字段。

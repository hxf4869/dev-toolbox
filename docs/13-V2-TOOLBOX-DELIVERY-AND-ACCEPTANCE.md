# 开发百宝箱第二期工具箱交付与验收

状态：**V2.0–V2.2 已实现，并于 2026-09-01 以 `v2.2.0-rc.1` 发布候选提交、部署并打 tag；真实 Provider/阿里云、目标版本备份恢复与性能、完整浏览器矩阵和 `release-check` 尚未验证，因此未标记为稳定版**

最后更新：2026-09-01

## 1. 文档目的

本文规定 V2 的实施顺序、最小交付物、测试层次和发布门槛。它不会因为写入计划就把能力标成完成。每项状态只能在对应代码、测试和浏览器证据实际存在后更新。

产品边界见 `09-V2-TOOLBOX-BASELINE.md`，技术合同见 `10`/`11`，页面规范见 `12`，多 Agent ownership 见 `14-V2-AGENT-RUNBOOK.md`。

## 2. 版本与门槛

| 版本 | 交付范围 | 前置 | 当前状态 |
|---|---|---|---|
| V2.0 | 中立首页、工具导航、八个本地工具、JSON 可选 AI 类型生成 | V1 继续通过；Foundation 完成 | 已包含在 `v2.2.0-rc.1` 并部署；真实 Provider 待验证 |
| V2.1 | 阿里云设置、免费额度账本、短队列、文本翻译 | V2.0 已发布或稳定候选 | 已包含在 `v2.2.0-rc.1` 并部署；真实阿里云待验证 |
| V2.2 | 本地 OCR、用户确认的阿里云 OCR、OCR 后翻译 | V2.1 合同稳定 | 已包含在 `v2.2.0-rc.1` 并部署；真实阿里云与完整浏览器矩阵待验证 |

每个版本都可以独立发布。不得为了“看起来完整”在 V2.0 菜单放置 V2.1/V2.2 空页面，也不得把未完成版本写进当前能力列表。

## 3. 实施顺序

### 3.1 Foundation

唯一 Web shell/integrator 负责：

1. `/` 中立首页与 `/knowledge` 路由迁移。
2. 旧知识入口兼容：`/knowledge` 保留 route name `workspace`；`/` query 含 `view`、`folderId`、`tagId`、`sort`、`kind`、`sensitivity`、`from`、`to` 任一 key 时，只用 Vue Router guard + `replace: true` 原样迁移到 `/knowledge`；不做服务端 302，不新增 `q` query 合同。
3. `/items/:itemId` 与其 query 保持不变。
4. AppRail、ModuleNav、手机工具 drawer 和工具路由动态加载。
5. 本地/云徽标、复制反馈、错误摘要等已有真实复用者的最小共享组件。

验收 Foundation 后，独立工具 owner 才能接入正式路由。工具实现可以先在隔离组件测试中并行进行，但不得各自修改 shell。

### 3.2 V2.0 工作流

建议按依赖和共享风险分三批：

1. 简单本地工具：Base64、URL、JWT。
2. 编辑器与数据工具：编辑器适配、业务 Worker、JSON、YAML。
3. 计算工具：时间与 Cron、哈希摘要、正则。
4. JSON AI：本地四语言稳定后，再增加窄 API/worker 在线增强。

不先建设通用工具框架；第二个真实消费者出现时才提取共享代码。

### 3.3 V2.1 工作流

顺序固定：

1. 迁移 007、加密设置、使用账本和 fake Aliyun client。
2. 预留/结算/幂等与进程内短队列测试。
3. 设置页与本地账本状态。
4. 浏览器保护、分块、UTF-16 计数和确认层。
5. 单 chunk API 与官方 SDK adapter。
6. 多 chunk 顺序调用、取消、失败与结果不确定状态。
7. 默认 mock 验收完成后，才可由 owner 明确授权真实阿里云烟测。

不能先接真实 SDK 再补额度硬停止。

### 3.4 V2.2 工作流

顺序固定：

1. 本站托管 Tesseract worker/core/`eng`/`chi_sim` 资产。
2. 单 worker 本地 OCR、进度、取消、卸载和可编辑结果。
3. 阿里云 OCR 的 1 次预留和 multipart 有界流。
4. 云重识别确认层。
5. OCR 文本经用户确认后复用 V2.1 翻译预检；不复制第二套翻译实现。

## 4. 测试层次

### 4.1 Web 单元与组件测试

使用现有 Vitest/jsdom/fetch mock，至少覆盖：

- 纯转换函数和边界 fixture。
- Worker 请求 ID、取消、晚到结果丢弃。
- 路由懒加载和旧知识 query 迁移。
- V2.0 确定性处理路径不发业务 API 请求、不写 local/session storage/IndexedDB；路由动态 chunk 和本站静态资产不计作业务 API。JSON 只有用户选择 AI、确认发送后才允许调用其窄接口。
- 云确认前不发正文；额度/排队/结果不确定 UI。
- Monaco/CodeMirror 适配的 create/dispose 使用最小 fake，不在 jsdom 加载完整编辑器。

目标命令：

```bash
pnpm --filter @dev-toolbox/web test
pnpm --filter @dev-toolbox/web check
```

### 4.2 Go 单元与集成测试

- SDK 由窄 interface 替换为 deterministic fake；默认不访问网络。
- PostgreSQL 集成覆盖行锁、并发预留、月份边界、重复 key、崩溃遗留 reservation。
- handler 覆盖 session、Origin/CSRF、PAT 拒绝、body/图片限制和 no-store。
- 日志捕获断言不出现正文、图片字节、AccessKey/Secret 或上游完整错误。

目标命令：

```bash
cd apps/api && go test ./...
```

集成后增加一个仓库级 `make v2-integration-test` 入口，只编排 V2 所需测试库和本地 fake，不连接真实阿里云。不要把该目标扩展为全产品 E2E 平台。

### 4.3 AI worker 测试

- 固定 prompt 与输入 schema。
- structure/full 256 KiB 边界、单轮、无工具、输出上限和取消。
- Provider/模型启用且未删除、API key 存在、`context_window`/`max_output_tokens` 非空为正才可用；逐项缺失都在 Provider 调用前返回 `AI_MODEL_UNAVAILABLE`。
- UTF-8 字节保守估算、128 token 余量与三项 `min` 公式一致；有效输出上限 255/256/4096 及配置更小值有边界测试，容量不足返回 `AI_CONTEXT_TOO_LARGE` 且不截断、不发 Provider 请求。
- 接近 256 KiB 且含大量 `<>&`、引号和反斜杠的公开 payload 经 Go 内部重编码后仍遵守 320 KiB 实际字节上限；HTML escape 关闭，worker 收到的值逐字等价，超限在发送前拒绝且不泄露 Provider snapshot。
- 三种现有 Provider 协议均使用本地 fake。
- 断言不创建/claim 一期 AI task，不生成 Artifact。

目标命令：

```bash
pnpm --filter @dev-toolbox/ai-worker test
pnpm --filter @dev-toolbox/ai-worker check
```

### 4.4 构建与浏览器验证

集成候选运行：

```bash
make check
make test
make build
```

V2 还需检查构建产物：

- 首页/登录/知识入口 chunk 不包含 Monaco、CodeMirror、Tesseract 或 OCR 语言数据。
- 非编辑器工具不依赖编辑器 chunk。
- 桌面 JSON/YAML 只加载 Monaco；手机条件只加载 CodeMirror，切换条件后旧实例已销毁。
- OCR 模型路径来自本站，没有运行时 CDN 请求。

不预设一个没有现有基线支撑的 gzip 数字门槛；记录实际 chunk 大小并在同一候选中确认没有意外聚合。

### 4.5 真实浏览器矩阵

每个发布候选至少：

- 当前项目支持的桌面 Chrome：完整功能和键盘。
- 桌面 Safari：Temporal polyfill、WebCrypto、文件流和编辑器。
- 390 px 手机布局：至少一次真实 iPhone Safari 或等价真实移动 WebKit 验证；仅桌面 responsive mode 不足以发布手机编辑器/OCR。
- 1024 px：ModuleNav drawer、编辑器不被压缩。

Edge、Firefox 仍不属于默认发布承诺；未经实测不宣称兼容。

## 5. Foundation 验收

| 编号 | 用例 | 通过条件 |
|---|---|---|
| F-01 | 打开 `/` | 显示 Screen 34 对应中立首页，不请求知识列表 |
| F-02 | 打开 `/knowledge` | 一期 Workspace 功能与筛选行为不回归 |
| F-03 | 分别打开只含 `view/folderId/tagId/sort/kind/sensitivity/from/to` 中一种的旧 `/` 链接 | 原 query 完整迁移到 route name `workspace` 的 `/knowledge`，使用 Router replace，不产生循环 |
| F-04 | 打开 `/items/:id` | 旧深链接仍进入知识条目，query 保留 |
| F-05 | 打开 `/tools` | 只列当前已发布工具，未发布路由返回正常 404 |
| F-06 | 1024/390 宽度 | 工具列表有 drawer 入口，焦点进入/返回正确 |
| F-07 | 加载首页/知识页 | 网络与构建记录无重型工具依赖 |

## 6. V2.0 工具验收

### 6.1 Base64

| 编号 | 输入/动作 | 通过条件 |
|---|---|---|
| B64-01 | `中文🙂` UTF-8 往返 | 原文逐字恢复 |
| B64-02 | Base64URL 无 padding | 正确解码且不误切标准模式 |
| B64-03 | 非法字符/长度/无效 UTF-8 | 精确错误，输入保留，无猜测 |
| B64-04 | 5 MiB 边界和超限 | 边界可处理；超限在处理前拒绝 |
| B64-05 | 全流程 | 无 fetch、无内容持久化、文案不写“加密” |

### 6.2 JSON

| 编号 | 用例 | 通过条件 |
|---|---|---|
| JSON-01 | `9007199254740993`、`1.2300`、`1e1000`、`-0` | 格式化/压缩/转换不先转 JS number，已定义词法值不丢失 |
| JSON-02 | 注释、尾逗号、单引号、普通裸键 | 只给受限修复候选和 diff；确认前不改输入 |
| JSON-03 | `NaN`、`undefined`、函数 | 明确拒绝，不调用 AI 修复 |
| JSON-04 | JSONPath 根/属性/索引/通配/递归/切片/并集 | 值、规范路径和数量正确；脚本过滤不可用 |
| JSON-05 | 文本/结构 diff、数组索引/身份字段 | 模式语义符合基线；不自动猜身份字段 |
| JSON-06 | Draft 2020-12 本地 `$ref`，实例只含安全数值 | 完整实例校验正确；远程 `$ref` 拒绝 |
| JSON-07 | 任意位置包含不安全数值，Schema 同时含结构、`oneOf`、`$ref` 和数值关键字 | Schema 本身仍编译验证；整份实例状态为 `not_run_precision_guard`，不评估任何实例关键字，不显示 pass/fail/partial pass |
| JSON-08 | 本地 TS/Java/Go/Kotlin：nested object、缺失/null、空/混合数组、非法/冲突 key、大整数/小数、根 array | 相同输入稳定逐字生成；数字/optional/nullable/通用类型和命名规则符合基线，不丢 key，不猜日期/UUID/枚举；标量根稳定拒绝 |
| JSON-09 | AI structure 模式 | 确认 payload 不含值；返回仅普通代码文本 |
| JSON-10 | AI full 模式 | 二次确认逐字预览；256 KiB 超限拒绝且不截断 |
| JSON-11 | 5 MiB 编辑、取消、路由离开 | 重任务在 Worker；晚到结果无效；编辑器/model/worker 释放 |

### 6.3 URL

- 完整 URL 与 component 编解码 fixture 正确。
- 非法 `%` 定位；不做重复自动解码。
- `a=1&a=2&b=` 保序、保重复、保空值重建。
- 解析不触发网络，不自动打开地址，不擅自规范化路径/query。

### 6.4 JWT

- 每个允许算法至少有一组有效/无效签名 fixture；`none` 和 EdDSA 明确拒绝。
- 解码未验签持续显示“不可信”。
- 签名通过 + 已过期显示两个独立状态，不能给总“有效”。
- `exp`/`nbf`、60 秒默认容差、非法 claim 类型和手动期望 `iss/aud/sub` 正确。
- `kid` 缺失/重复匹配需要用户选择；不联网获取 JWKS，不逐 key 尝试。
- key/token 在清空、卸载、刷新后不可恢复。

### 6.5 时间与 Cron

- 秒/毫秒/ISO/UTC/IANA 时区往返，显示基准与 offset。
- 覆盖一个 DST 不存在时间和一个重复时间，必须要求明确处理。
- “明天下午 3 点”“3 天后”“下周一”“tomorrow 3pm”按 grammar 和选定时区确定；`03/04` 拒绝歧义。
- Unix 5 段与兼容 6–7 段未来 5 次正确；严格 Quartz `?` 无法表达时拒绝。
- 不出现任务保存/执行 API，不联网取节假日。

### 6.6 哈希摘要与校验和

- 文本和单文件 SHA-256/384/512 与可信 fixture 一致。
- MD5/SHA-1 结果正确且持续显示不安全说明。
- 大于一个 4 MiB chunk 的文件以流式 Worker 处理；可见进度、取消，无整文件 arrayBuffer。
- 期望值忽略大小写/ASCII 空白/可选 `0x` 后精确比较。
- 不上传文件，不支持目录、批量、HMAC 或文本总结。

### 6.7 正则

- flags、全局匹配、范围、捕获组和替换预览 fixture 正确。
- 灾难性回溯 fixture 在约 500 ms 主线程终止一次性 Worker，页面仍响应。
- 超时不自动重试、不换语法；不执行函数/回调源码。

### 6.8 YAML

- YAML 1.2、多文档、普通 anchor/alias 和注释格式化 fixture 正确。
- 重复 key、custom tag、merge key、超过 alias 上限明确拒绝。
- 大整数/高精度转 JSON 不丢失；时间戳保持字符串。
- YAML→JSON 后注释不可恢复的说明可见；格式化只有点击后改输入。
- 没有 Kubernetes Schema、Helm 或远程 Schema UI/依赖。

## 7. V2.1 文本翻译验收

### 7.1 设置与安全

- 首次保存、只显示 ID 末 4 位、替换、删除和 master key 加密 round-trip。
- Secret 不出现在 GET 响应、日志、错误、测试快照或浏览器持久化。
- 自动专业版开启时 scene 必选且只允许六值；中文名与官方场景一致，不把 `communication` 标为工程记录或默认推荐。
- 上限、并发范围和 `global >= owner` 前后端一致；新上限不得低于当前月 `used + reserved`。并发执行“降低 limit”与“新预留”的竞态测试，二者按统一锁顺序串行，绝不出现保存后立即超限。
- SDK 只连接两个固定 endpoint；PAT、任意 endpoint 和任意 Context 被拒绝。
- `translation_languages.v1.json` 恰好 214 个唯一 code，含 `zh/en/ja/ko/zh-tw/yue` 等官方 fixture；语言 GET 与服务端校验读取同一嵌入文件。Scene 有向 pair 数固定为 finance 2、medical 4、social 6、title 34、description 34、communication 38，并测试代表性允许/拒绝方向，不从集合成员推导不存在的互译。

### 7.2 额度与并发

- 50 个并发 fake 请求争抢临界剩余额度，成功预留总数绝不超过 limit。
- 通用足够用通用；不足时完整 chunk 切专业；scene 缺失/专业不足在调用前停止。
- preflight 按语言与 `chunkUnits` 顺序返回双 meter 计划；实际预留的引擎与 `expectedEngine` 不同时先返回当前 chunk 的 `PREFLIGHT_CHANGED`，浏览器再用“当前 + 剩余”调用第二次 preflight，展示完整新计划；再次确认前 fake SDK 调用数仍为 0。
- 通用计划允许 `sourceLanguage=auto`；计划或竞态需要专业版时，auto 返回 `SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL`，明确但不受 Scene 支持的 pair 返回 `PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED`，两者都不预留、不调用 SDK。
- 成功、调用前释放、明确失败计量、结果不确定和重复结算账本正确。
- 并发调用乱序结算时最近成功/失败时间只前进不回退，较旧失败不覆盖较新 `failureCategory`；preflight/队列/本地错误不更新云状态。
- 月末跨时区、跨响应和旧 reservation 恢复符合合同。
- 同 Idempotency-Key 不产生第二次 fake SDK 调用。
- 同一 permit 用两个不同 `Idempotency-Key` 并发请求时，只有先取得 in-flight 标志的请求可以预留并调用 fake SDK，另一个返回 `CLOUD_PERMIT_BUSY`；相同 key 的并发请求仍返回 `CALL_IN_PROGRESS` 或已结算结果。被拒请求不得新增 call row、占用额度或调用 SDK。
- owner/global 限制、FIFO position、20 ticket 上限、2 分钟等待、15 秒 claim、60 秒 idle、10 分钟 run、取消和 API 重启失效均有确定性时钟测试。特别覆盖 DELETE/idle/absolute 在 fake SDK in-flight 时不释放 slot，直到 handler 结算后下一 ticket 才能 active。
- 队列终态最多保留 2 分钟/20 项并按最旧淘汰；ticket 未知/过期/取消、permit 无效/过期/operation 不匹配分别返回合同错误，且 quota 行与 fake SDK 调用数都不变化。同 owner 跨 Web 会话可访问，其他 owner 统一 404。
- 45 秒 SDK deadline 和取消传播使用 fake clock；客户端与 SDK adapter 均无自动重试。
- 11 个 `failureCategory` 都映射到固定 UI 动作；上游原始 message 不进响应/日志，翻译保守计量和 OCR 可证明未成功时释放的差异有测试。

### 7.3 文本与交互

- 最终每个 `SourceText` 为 `1..4999` UTF-16；emoji/surrogate pair 不被切断。
- chunker 合并相邻短句；原文/保护后 payload 的 950,000-unit 边界和 191-chunk 边界分别测试等于/超过。Web 在 preflight 前拒绝原文超限，preflight 与 active permit 都拒绝最终 units/chunks 超限，额度/SDK 不变化；同 key 重放不重复累计。
- Markdown fence、inline code、URL、路径、命令保护并完整恢复。
- 占位符被上游删除、重复、改写或乱序时，原 chunk 保留并报恢复失败，不返回损坏结果。
- 手动源语言、自动检测、目标语言和交换规则符合 UX。
- 云确认前没有 source API 请求；确认层显示最终计费字符/chunk/meter/接收方。
- 多 chunk 顺序进行；失败只影响失败片段；恢复只在当前标签页。
- timeout 后显示结果不确定、已保守计量且无自动重试。
- 额度不足无继续付费旁路。

## 8. V2.2 OCR 验收

### 8.1 本地 OCR

- PNG/JPEG/WebP 粘贴、拖放、选择；其他格式拒绝。
- >5 MiB 提示；最长边 >4096 在浏览器按比例缩小并显示调整后尺寸；宽/高 `<=15` 或长短边比 `>=50` 明确拒绝且不自动放大/裁切。
- 首次使用只从本站加载 Tesseract worker/core/`eng`/`chi_sim`；没有 CDN 请求。
- 单 worker、进度、取消、路由卸载和 5 分钟空闲终止。
- 中英印刷体合成 fixture 有可编辑文本和低置信度标记；不承诺手写。
- 本地 OCR 允许从本站加载 worker/WASM/`eng`/`chi_sim` 公共资产，但图片和 OCR 文本没有业务 API 请求、内容存储或服务器计算。

### 8.2 云 OCR 与翻译

- 用户未点击云重识别时，即使本地失败也不上传。
- 确认层显示接收方、图片元数据、预计 1 次和剩余；确认后才创建 ticket。
- 服务端再次验证 magic bytes、类型、大小、宽高 >15、最长边 <=4096、长短边比 <50 和单 part；URL/base64 JSON/多 part 拒绝。WebP 通过现有 `golang.org/x/image/webp` decoder 验证。
- fake `RecognizeGeneral` 的 `Data.content` 正确解析；不要求 `Code==200`。
- 190 默认/200 最大硬额度、幂等、不确定状态和无自动重试正确。
- 云 OCR 文本仍需用户校对；点击翻译出现第二次独立确认并走 V2.1，不绕额度。
- 服务器不落图片、不建附件、不保存 OCR 文本/坐标/译文。

## 9. 性能与资源验收

| 目标 | 验证方法 | 通过条件 |
|---|---|---|
| 本地工具不吃服务器计算 | API 日志/网络断言 + 服务指标对比 | 操作期间没有业务 API；API CPU/RAM 无对应任务 |
| 首页保持轻 | Vite 构建产物与浏览器 network | 重型依赖不在初始/知识 chunk |
| 大文本可取消 | 5 MiB JSON/YAML/regex fixture + UI timer | 主线程仍可响应取消；取消后无结果覆盖 |
| 文件不整体入内存 | Worker 测试与代码审查 | 使用 `File.stream()`/4 MiB chunk，无整文件 `arrayBuffer()` |
| OCR 资源有界 | 浏览器 performance/memory 抽查 | 同页最多一个 worker；离页/空闲释放；不在服务器运行 |
| 云调用有界 | 队列/并发测试 | 等待最多 20；活跃数不超过配置；无 goroutine/ticket 无界增长 |

记录真实测试设备、浏览器、输入规模和观察值；没有证据时写“未验证”，不填猜测数字。

## 10. 隐私与越界验收

发布候选必须证明：

- V2.0 确定性操作期间业务 API spy 为零，输入不在 URL、storage、数据库、日志或错误报告；动态代码 chunk/静态资产请求单独统计，不误报为内容上传。
- JSON AI 的 structure/full 发送范围与确认一致；取消确认发送为零。
- 本地 OCR 可以读取本站公共模型资产，但图片与 OCR 文本的业务上传 spy 为零；只有用户确认云重识别后才允许单次图片 API。
- Aliyun Secret 只在 Go 解密，浏览器/worker 不持有。
- 翻译/OCR 日志只有 operation、计量、状态、耗时和 RequestId。
- 云图片只在请求生命周期；没有临时文件和附件记录。
- 未增加 Redis、队列服务、动态插件、RBAC、Kubernetes 或通用 billing。

## 11. 真实付费服务联调规则

默认检查不得调用阿里云或真实 AI Provider。真实联调需同时满足：

1. owner 在当前任务中明确授权。
2. 使用专用最小权限 RAM 凭据，不把凭据放进命令输出。
3. 先确认本地 fake 全部通过。
4. 页面/命令明确显示预计消耗；调用进入同一应用账本。
5. 只使用无敏感信息的最小合成文本/图片。
6. 实际调用次数、meter、时间和结果分类写进本地验收记录，但不记录正文/密钥。

没有真实联调可以发布 mock 完整的开发候选，但不得对外宣称“阿里云真实调用已验证”。

## 12. 缺陷与发布门槛

- P0：泄露 Secret/内容、额度可绕过、自动付费路径、内容损坏、签名误报可信、V1 原始数据受损。任何一个阻止发布。
- P1：主工具闭环不可用、取消无效、移动端无法完成、路由回归、重型依赖进入首包。任何一个阻止对应版本发布。
- P2：不影响正确性和边界的视觉/文案小问题，可记录后排期；不能把缺失错误态或可访问性主路径降为 P2。

## 13. 版本完成定义

某个版本只有同时满足才可标完成：

- 该版本所有表中必需用例有真实结果，未运行项为 0。
- `make check`、`make test`、`make build` 在最终候选上通过。
- 必需浏览器/宽度和 Stitch Screen 对照完成。
- 没有 P0/P1；P2 有明确记录且不越界。
- 文档、帮助、README 与当前发布能力一致；未发布路由不可见。
- 变更文件、迁移、依赖、实际命令和未验证项写入交付记录。
- V1 知识、认证、AI task、备份与发布门禁没有被 V2 修改或伪造为通过。

完成 V2.0 不代表 V2.1/V2.2 完成；每个版本单独更新状态与证据，不把未来计划写成已上线能力。

## 14. V2.0 完整验收记录（2026-08-31）

### 14.1 已实现范围

- `/` 为 Screen 34 对应的中立首页；一期知识模块迁移到 `/knowledge`，旧根路径筛选 query 使用 Router replace 原样迁移，`q` 不触发迁移；`/items/:itemId` 及 query 合同保持不变。
- 唯一 App shell 接入桌面 AppRail、ModuleNav、窄屏工具 drawer 和路由级动态加载；工具入口只包含 V2.0 的 Base64、JSON、URL、JWT、时间/Cron、摘要与校验和、正则、YAML。
- JSON/YAML 桌面按能力加载 Monaco，窄屏加载 CodeMirror 6；编辑器、业务 Worker、取消、晚到结果丢弃、动态可访问名称和资源释放均有回归覆盖。
- JSON 本地类型生成实现 TypeScript、Java、Go、Kotlin 冻结规则；窄 JSON AI 接口只在用户选择 AI、看到准确发送范围并确认后调用，不创建 task、Artifact 或历史记录。
- 未加入翻译、OCR、云额度/队列、Redis、第二数据库、微服务、RBAC、Kubernetes、动态插件或通用 AI 平台；未新增数据库迁移。

### 14.2 自动化证据

- `make check`：Web 与 ai-worker TypeScript 检查通过；Go `go test ./...` 全部通过。
- `make test`：Web `34` 个测试文件、`159` 项测试通过；ai-worker `5` 个测试文件、`146` 项测试通过；Go 全部包测试通过。jsdom 的 `scrollTo()` 未实现提示不影响结果，未伪装成浏览器证据。
- `make build`：Web/ai-worker 生产构建通过，API、gateway、ai-worker 三个应用镜像构建通过。
- `make v2-integration-test`：隔离测试库中的 `TestM3V2JSONAINarrowSynchronousPath` 通过；使用本地 fake，不连接真实 Provider。
- `git diff --check`：通过。
- 路由迁移、壳层、确定性工具零业务 API/零浏览器内容持久化、Worker 取消/晚到结果/dispose、JSON AI structure/full 确认与取消均包含在上述测试中。

### 14.3 构建与资源边界

- 初始 `index` chunk 为 `88.16 kB`（本机与容器构建 gzip `32.98`–`32.99 kB`），Home chunk 为 `2.61 kB`；首页与知识入口未聚合 Monaco/CodeMirror。
- JSON 与 YAML 页面 chunk 分别为 `27.78 kB` 和 `6.22 kB`；Monaco `editor.api`（`2,654.35 kB`）、JSON mode（`1,207.81 kB`）、CodeMirror adapter 和业务 Worker 保持独立动态 chunk。
- Vite 对 Monaco 大动态 chunk 给出超过 500 kB 的提示；它没有进入首包，符合本版本按路由和设备懒加载的合同，不把提示记录成测试失败。

### 14.4 浏览器证据

- 真实桌面 Chrome：八个工具的主流程均使用合成输入实际执行；Base64 `中文🙂`、URL 组件编码、JWT HS256 WebCrypto、SHA-256 `abc`、正则 Worker、JSON/YAML、Cron 未来 5 次均得到预期结果。JSON/YAML 冷启动只初始化两个 Monaco、没有 CodeMirror；深浅主题实时同步；动态编辑器名称、AI 安全默认焦点/焦点回退、Cron 横向宽度及 `/help#local-tools` 冷启动锚点直达通过；干净标签页控制台无 warning/error。
- 真实桌面 Safari：Temporal/IANA/Cron、Monaco、JSON 大数与原始数字词法、HS256 WebCrypto、单文件 File API/Worker SHA-256 通过。
- 按 4.5 允许的等价真实移动 WebKit 验收使用 Playwright `1.62.1` 的独立 WebKit build `2336`（bundle id `org.webkit.Playwright`，不是 Chromium responsive mode），加载 iPhone 13 移动参数：viewport `390 × 664`、screen `390 × 844`、DPR `3`、touch/mobile 开启，并确认 AppleWebKit/Mobile Safari UA。
- 该 WebKit 会话实际覆盖八个工具：所有页面无横向溢出，手机 AppRail 可横向滚动，抽屉焦点进入、Escape/路由切换关闭和焦点返回通过，可见按钮、选择框、文本输入与选择标签均至少 `44 × 44 px`。JSON/YAML 各只初始化两个 CodeMirror，Monaco 资源请求为零；JSON → YAML → Base64 路由切换后前页 Worker 和编辑器均释放。
- 移动 WebKit 主流程使用合成输入得到预期结果：Base64、URL、JWT HS256、JSON 格式化/四语言本地类型生成、YAML 转换、Cron 未来 5 次、SHA-256 和正则匹配/替换均通过。JSON AI 仅在显式选择后读取 Provider，确认框显示 structure 范围并安全默认“取消”，取消后没有 POST；localStorage、sessionStorage、IndexedDB 均为空，确定性工具没有业务 API 请求。
- 移动 WebKit 页面异常为零；WebKit 对 Vite `modulepreload` 产生未及时使用的诊断 warning，相关模块随后按路由使用，未把该浏览器诊断伪装成零 warning 或产品异常。
- 旧 query 迁移、`/items/:itemId?view=timeline&hit=...` 保留、JSON AI structure 不含值/full 逐字预览，以及确定性工具无正文业务 API 请求均在隔离浏览器中实际检查。

### 14.5 结论与限定

- 以下结论记录修复前 `v2.0.0-rc.1` 当次验收：当时的实现、自动化、桌面浏览器和等价真实移动 WebKit 门禁均有对应证据，独立终审当时未发现剩余代码 P0/P1。该结论已被 14.8 的后续 RC 审计重新打开，不能作为修复后候选的完成证据。
- 未调用真实付费 AI Provider；本版本按第 11 节使用本地 fake 验证窄接口，因此不宣称真实 Provider 已验证。
- 本轮未创建 Git commit；`v2.0.0-rc.1` 已部署供 owner 验证，但尚未完成真实 Provider 测试或正式发布。

### 14.6 补充浏览器全流程与布局复核

- Codex 内置浏览器在 `1440 × 900` 下再次实际执行：首页到工具箱导航；Base64 UTF-8 往返；URL 组件编解码与重复 Query 保序重建；JWT HS256 签名/Claims 通过及 `alg: none` 明确拒绝；JSON 格式化、大数保真、JSONPath、结构对比、Schema 精度保护、四语言类型生成和 AI 取消/确认；YAML 格式化与双向转换；时间转换、Cron 未来 5 次；SHA-256 精确比对；正则匹配与替换预览。旧 query 迁移、根路径 `q` 保留和 item 详情 query 保留也再次通过。
- 布局复核覆盖深浅主题、`1440 × 900`、`1024 × 768` 与 `390 × 844`。八个工具在 390 px 均无页面横向溢出，关键按钮、选择框、文本输入和选择标签没有低于 `44 × 44 px` 的目标；JSON/YAML 只出现两个 CodeMirror、Monaco 为零；手机 drawer 的焦点进入、Escape 关闭和焦点返回通过。
- 本轮浏览器请求日志中，确定性工具除页面认证会话外没有业务 API 调用；Provider 列表只在显式选择 AI 后读取，窄 JSON AI POST 只在确认框中点击确认后出现。合成数据由本地 mock 接收，不连接真实 Provider。浏览器控制台无 warning/error。
- 布局检查发现并修复两项可复现问题：首页标题在常见宽度出现单字孤行；JSON AI 操作栏在桌面可用宽度内把生成方式和确认按钮压成竖排。修复后在上述三个宽度复核通过，未增加新组件、抽象或兼容层。
- 修复后的最小自动化验证：Home、JSON AI、AppShell 共 `3` 个测试文件、`6` 项测试通过；Web TypeScript/Vue check 通过；Impeccable 机械检测无发现；`git diff --check` 见本轮最终检查。

### 14.7 `v2.0.0-rc.1` 部署证据

- 当前未提交工作树以固定候选标签构建 API、AI worker、gateway 三张镜像；生产 Secret、`.env.production` 和数据目录未进入候选归档。京东云访问 `proxy.golang.org` 超时后，按构建脚本已有 `GOPROXY` 覆盖能力改用 `https://goproxy.cn,direct`，三张镜像均构建成功。
- 使用最新成功的正式 OSS snapshot `730176ae` 在隔离空目录、隔离 Compose 项目和隔离边缘网络恢复到 `v2.0.0-rc.1`；迁移、API readiness、worker liveness、完整性检查和关键 SPA 路由通过，恢复报告 `state=succeeded`、`containsUserContent=false`。验收后隔离容器、网络和临时数据副本已删除。
- 正式升级脚本在切换前生成 snapshot `6a52181b`，随后完成 `v1.0.3 → v2.0.0-rc.1`；PostgreSQL 未重启。生产静态检查、正式域名 HTTP→HTTPS/TLS 检查、API readiness，以及 `/`、`/knowledge`、`/tools`、`/tools/json`、`/tools/base64`、`/tools/time` 公网响应通过。
- API、AI worker、gateway 与 PostgreSQL 重启计数均为 `0`；升级后 API、worker、gateway 的 `panic`/`fatal`/`uncaught`/`unhandled`/`error` 日志计数为 `0`。候选运维状态仅保留 `ai_policy=review`：真实 Provider 尚待 owner 配置和验证，不把本地 fake 与链路测试写成真实 API 已通过。

### 14.8 RC 审计重新打开（2026-08-31）

- 后续全库审计确认 JWT 晚到验签结果、YAML 多文档分隔符、ai-worker caller 断连取消、正则无界结果、JSON text diff 上限、JSONPath quoted property union、工作日循环和 Monaco/DOMPurify 实际生产依赖等九项问题；完整范围与 ownership 见 `15-V2-RC-AUDIT-REMEDIATION.md`。
- 九项问题全部修复、定向测试、稳定候选门禁、受影响浏览器流程和独立终审完成前，V2.0 保持“发布候选验收重新打开/发布阻断”。本节不删除或改写 14.1～14.7 已真实发生的历史证据。
- `v2.0.0-rc.1` 不包含本轮修复，其部署、恢复和升级证据不能继承给修复后候选。修复后候选当前未命名、未提交、未部署、未正式发布，也未验证真实 Provider。

### 14.9 RC 审计修复后的本地候选（2026-08-31）

- `15-V2-RC-AUDIT-REMEDIATION.md` 固定的 RC-01～RC-09 已按唯一 owner 关闭：JWT 晚到结果、YAML 多文档分隔符、caller 断连取消、正则结果上限、状态文案、JSON text diff 字节上限、JSONPath quoted union、工作日循环边界和 Monaco/DOMPurify 生产依赖均有对应实现与直接回归证据。
- 稳定候选实际运行 `pnpm check`、`pnpm test`、`pnpm build`：Web `36` 个测试文件、`177` 项通过；ai-worker `6` 个测试文件、`149` 项通过；TypeScript/Vue 检查和两个生产构建通过。Vite 仅保留已知的 Monaco 懒加载大 chunk 提示；jsdom 仅输出既有 `scrollTo()` 未实现提示。本轮未修改 Go，因此未把旧 Go 测试伪装成本轮新证据。
- `pnpm audit --prod` 返回 `No known vulnerabilities found`。Monaco patch 只把 sanitizer import 改为 bare `dompurify`，安装树和生产 `editor.api` bundle 实际使用 `dompurify@3.4.14`，未包含 vendored `3.4.8`；首页和 Home chunk 仍未包含 Monaco/CodeMirror。
- 受影响桌面流程在构建产物上实际检查：JWT HS256 通过/失败、JSONPath comma union、YAML 三文档、1 MiB 零宽正则前 500 条截断、工作日 `1000/1001` 均符合合同；JSON/YAML 为两个 Monaco、零 CodeMirror，离页后 Monaco 清零。浏览器同时发现 Monaco 0.56 JSON mode 晚注册 service 的控制台错误，随后只调整首次 model 前的加载顺序；新的 JSON-first 与 YAML-first→JSON 干净会话均为零 warning/error，没有导入 `editor.main` 或新增编辑器抽象。
- 移动验收使用 Playwright `1.62.1` 的 WebKit build `2336`，viewport `390 × 664`、screen `390 × 844`、DPR `3`、touch/mobile 开启。JSONPath 返回两个匹配；YAML 三文档保留三条注释和两个分隔符；1 MiB 正则只渲染 500 条并省略替换预览；工作日 `±1000` 分别约 `44/28 ms` 完成，`±1001` 分别约 `41/28 ms` 拒绝。四页均无横向溢出，JSON/YAML 为两个 CodeMirror、零 Monaco。
- 上述 WebKit 会话前后 localStorage、sessionStorage、IndexedDB 均为空，除四次合成认证 `GET /api/v1/auth/session` 外没有业务 API 请求，控制台 warning/error/pageerror 为空；没有访问真实 Provider。ai-worker 断连测试使用本地 `node:http` loopback 和合成 Provider。
- 独立只读终审核对九项 diff、直接测试、Monaco 加载顺序和生产依赖后未发现剩余代码级阻断，也未发现 V2.1/V2.2、基础设施、通用框架或无关 V1 重构混入本轮修复。
- 本节当时的结论仅为“修复后的本地 V2.0 RC 候选已验证”。候选后续经 owner 明确授权命名并部署为 `v2.0.0-rc.2`，详见 14.10；`v2.0.0-rc.1` 的历史证据仍不属于当前字节。

### 14.10 `v2.0.0-rc.2` 部署与生产验收（2026-08-31）

- owner 在本地修复验收完成后明确授权先部署。当前工作树按 `git ls-files -co --exclude-standard` 生成候选归档，排除 `.git`、依赖、构建产物、部署 Secret/环境文件和运行数据。首次生产构建发现两个 Dockerfile 未在 `pnpm install` 前复制已锁定的 `patches/`，只补齐该构建上下文后，API、AI worker、gateway 三张 `v2.0.0-rc.2` 镜像均构建成功。
- 使用 snapshot `6a52181b22f7178024a8a50393949894112ee528160b3054adbaf71a96265038` 从 `v1.0.3` 在隔离空目录恢复到 `v2.0.0-rc.2`；报告 `state=succeeded`、耗时 `27s`、完整性 `0/0/0`、`containsUserContent=false`。隔离容器和数据副本验收后已清理，恢复报告保留。
- 正式升级脚本在切换前生成 snapshot `2ce37835eda5418ffb83b70dd4de2d76acd957dc908811707f6b08971634f664`，然后完成 `v2.0.0-rc.1 → v2.0.0-rc.2`。PostgreSQL 未重启；API、worker 和 PostgreSQL 在后续网关配置修正中也未替换。
- 正式域名的 HTTP→HTTPS、TLS、HSTS、CSP、`nosniff`、Referrer Policy、API readiness 和 worker liveness 通过。生产摘要工具实测暴露 `hash-wasm` 被原 CSP 拒绝；只在 `script-src` 增加 `wasm-unsafe-eval` 并同步 HTTPS 校验后重载 gateway，没有放开通用 `unsafe-eval`。修正后生产 Chrome 中 SHA-256(`abc`) 返回标准值，当前 WebKit 对该 CSP 下 `WebAssembly.compile` 的能力检查也通过。
- 生产 Chrome 实际覆盖中立首页、旧 query 迁移、桌面 JSON/时间与 Cron，以及 `390 × 844` 的手机导航、JSON、YAML、正则、Base64、URL、JWT 和摘要主流程；页面无横向溢出，控制台无新增 warning/error。生产 WebKit 新会话因未认证不能直接复用登录态，因此不声称已运行生产登录后的 WebKit 全流程；部署前完整 WebKit 应用流程证据保留在 14.9。
- 只读运维状态已按 `v2.0.0-rc.2` 发布：`backup_restore`、`browser_accessibility`、`deployment_security` 为 `passed`，`ai_policy` 仍为 `review`。当前候选未创建 Git commit/tag、未正式发布，未调用真实 Provider；V2.1/V2.2 仍未实现。

## 15. V2.1/V2.2 本地稳定候选验收记录（2026-08-31）

本节记录 V2.1 与 V2.2 在发布前形成的本地稳定候选证据；后续发布事实见第 16 节。真实阿里云联调仍须按第 11 节由 owner 明确授权后进行。

### 15.1 已实现范围

- **V2.1 文本翻译**：`/settings/aliyun` 阿里云服务设置页（凭据 secretbox 加密保存与掩码/替换/删除、通用/专业/OCR 硬上限、专业六 Scene、owner/global 并发、本月本地保护账本、账号共享额度警告；保存不调用云服务）；`/tools/translate` 翻译页（服务端冻结语言清单、本地技术内容保护与占位符恢复、UTF-16 分块 1–4999/950,000/191 上限、preflight 确认层、队列/claim/顺序 chunk、PREFLIGHT_CHANGED 重新预检“当前+剩余”、失败片段继续、结果不确定保守计量、取消三分类）；Go `internal/aliyun` 模块（007 迁移三表、secretbox 设置、月度账本统一锁顺序、幂等、引擎决策、进程内短队列、SDK adapter 固定 endpoint 且不自动重试、日志无正文/密钥）。
- **V2.2 OCR 翻译**：`/tools/ocr-translate`（单图 PNG/JPEG/WebP 粘贴/拖放/选择、5 MiB/宽高/比例校验、>4096 本地等比缩放、单 Tesseract worker 本站资产/进度/取消/5 分钟空闲终止、可编辑校对与低置信度标记、用户明确确认的阿里云重识别、二次确认后复用 V2.1 翻译流程）；Go `POST /api/v1/aliyun/ocr`（multipart 单 part、magic bytes/类型/大小/尺寸/比例二次校验、RecognizeGeneral 固定 endpoint、OCR 专属结算差异、服务器不落盘不建附件）。
- 四服务拓扑不变；未新增 Redis/队列服务/对象存储/微服务；未建通用 tools API/插件注册器/云供应商抽象/调用历史/计费平台。

### 15.2 自动化证据

- Go：`go build ./...`、`go vet ./...`、`go vet -tags=integration ./integration/...` 通过；`go test ./...` 全包通过（internal/aliyun 40 项单测：语言文件 214 唯一 code 与六 Scene pair 2/4/6/34/34/38 不变量、UTF-16 代理对、引擎决策、错误映射、队列全时序、OCR 校验矩阵与结算）。
- 集成（`make v2-integration-test`，隔离测试库 + fake SDK）：`TestV2Aliyun*` 8 项 + `TestM3V2JSONAINarrowSynchronousPath` 全过；50 并发预留不越限、同 key 不二次调用 fake、四种结算账本、stale reserved 恢复、上海月份边界、PREFLIGHT_CHANGED 前 fake 调用为 0、OCR 成功后 used=1、确认类错误前置 fake=0、日志无正文/密钥/permit。
- Web：`pnpm --filter @dev-toolbox/web test` 45 个测试文件 265 项通过（翻译页 50、OCR 页 28、设置页 14 等）；`vue-tsc`/`tsc` 通过；`pnpm --filter @dev-toolbox/ai-worker test` 6 文件 149 项通过（未改动）。
- 构建：生产构建通过；TranslateView 21.30 kB、OcrTranslateView 45.18 kB、AliyunSettingsView 独立异步 chunk；首包 index 90.94 kB，未含 Monaco/CodeMirror/Tesseract；Tesseract 库为独立动态 chunk，OCR 静态资产（worker/core×3/eng/chi_sim.gz，来源与版本见 `apps/web/public/tesseract/PROVENANCE.md`）全部由本站 `/tesseract/*` 提供。
- CSP：`worker-src 'self' blob:` 已加入 Caddyfile 与 `verify-https.sh` 断言（Tesseract worker 经本站加载）。

### 15.3 浏览器证据（生产构建 + API 路由拦截 mock，未调用真实阿里云）

- V2.1：/tools 在线能力分组与云徽标、/settings/aliyun 三视口（1440/1024/390 无溢出、删除凭据确认层焦点在取消并圈闭、422 错误摘要 role=alert）、/tools/translate 全流程（确认前 chunk POST=0；确认后 ticket/claim/chunk 顺序调用；PREFLIGHT_CHANGED 后重新 preflight 且再次确认前 chunk 数不增加；结果不确定琥珀呈现且手动重试前计数不变；额度耗尽无付费按钮；未配置引导前往设置且输入保留；390 无溢出）。对齐 Stitch Screen 39/41/42：布局区域、实心主按钮唯一、状态色语义（淡紫=常规/确认、琥珀=不确定、红=硬停止）一致；9 项 P2 视觉差异中 4 项（信息横幅蓝灰、移除凭据红文字链接、剩余值 accent 高亮、专业版“后备”徽标）已收敛，其余为低置信度或状态板参考差异。
- V2.2：真实浏览器本地 OCR 识别合成图片“Hello 123 World”成功；网络证据仅本站 `/tesseract/*`（worker/core/chi_sim+eng），零 CDN、零业务 API；IndexedDB 仅有 tesseract.js 公共模型缓存（`keyval-store`，合同允许），localStorage/sessionStorage 为空；云重识别确认层打开时 `/api/v1/aliyun/ocr` 调用为 0，确认后 preflight→queue-tickets→claim→**恰好 1 次** `/aliyun/ocr`；390/1024/1440 均无横向溢出；低置信度行标记与“来自阿里云重新识别”徽标出现。
- 说明：本轮真实截图因本会话无视觉能力未逐像素复核；视觉对照由只读视觉子智能体对 Stitch 全分辨率规范稿与浏览器截图完成，且修复后的最终字节未整体重拍（390 溢出修复后已用真实浏览器 DOM 度量复核）。

### 15.4 形成本地稳定候选时尚未验证的内容

- 真实阿里云机器翻译/OCR 调用（需 owner 授权专用 RAM 凭据、确认服务开通与免费额度后按第 11 节联调）。
- 生产部署、TLS/CSP 生产验证、备份恢复演练、性能门禁、release-check 均未运行。
- 移动 WebKit/真实 iPhone 的 OCR 流程未在本机验证（仅 Chromium 390 视口）。
- 浅色主题下 V2.1/V2.2 页面的视觉复核未单独执行。

## 16. `v2.2.0-rc.1` 发布候选（2026-09-01）

### 16.1 版本与部署

- 发布范围为 V2.0、V2.1、V2.2 以及截至 2026-09-01 已确认的布局、滚动、翻译默认中文和交互修正；候选代码提交为 `c93b3e3`，Web 与 AI worker 包版本为 `2.2.0-rc.1`。
- 从候选提交归档在目标主机构建 `dev-toolbox-api:v2.2.0-rc.1`、`dev-toolbox-ai-worker:v2.2.0-rc.1`、`dev-toolbox-gateway:v2.2.0-rc.1`，固定锁文件安装与三个镜像构建成功。
- 生产静态部署契约通过后，只替换 API、AI worker、gateway 三个应用容器；PostgreSQL 容器保持原实例且未重启。迁移 007 已由此前 V2.2 临时部署应用，本次没有新增数据库迁移。

### 16.2 实际验证

- 本地运行 `pnpm check`、`pnpm test`、`pnpm build`：Web `45` 个测试文件、`271` 项通过，AI worker `6` 个测试文件、`149` 项通过，类型检查与生产构建通过；Vite 仅保留 Monaco 已知大 chunk 提示。
- Go 在固定 `golang:1.27.0-alpine3.23` 容器中运行 `go test ./...`、`go vet ./...`、`go build ./...` 通过；`make v2-integration-test` 的 8 项阿里云 fake 集成与 1 项 JSON AI 窄调用集成通过，没有调用真实阿里云或 Provider。
- 生产切换后 API readiness、worker liveness、三个应用容器零重启计数通过；`/`、`/knowledge`、`/tools`、`/tools/translate`、`/tools/ocr-translate`、`/settings/aliyun`、`/ai/tasks` 均返回 200。
- 正式域名 HTTP→HTTPS、有效 TLS、HSTS、CSP、`nosniff` 与 Referrer Policy 检查通过；应用镜像均显示 `v2.2.0-rc.1`。

### 16.3 RC 限制

- 未调用真实阿里云翻译/OCR，也未补做真实 Provider JSON AI；这些调用需要 owner 对当次凭据、额度和发送内容另行授权。
- 本次未访问 OSS，未运行目标版本备份、恢复演练、固定规模性能或完整 `release-check`；旧版本证据不冒充目标版本新证据。
- V2.1/V2.2 的移动 WebKit/真实 iPhone、浅色主题和完整辅助技术矩阵仍未补齐。机器可读发布状态将这些门禁保持为 `review`，因此该版本是 RC，不是稳定版。

## 17. OCR 换图与云错误修复（2026-09-02）

- 修复选择图片后隐藏 file input 被 `v-if` 卸载，导致“更换图片”失效；连续换图、重选同一文件会重置旧识别结果，取消或无效新文件保留原图和校对文本。本地换图不上传。
- 本地 HTTP fixture 复现实际 SDK 返回 `tea.SDKError`，原适配器只识别 `dara.SDKError`，把权限拒绝、限流和上游不可用误判为 unknown/uncertain；现复用既有分类与结算逻辑正确处理实际错误类型，不新增重试。
- Caddy 不再把 API 的 502/503/504 与额度 details 统一改写为维护 503；仅保留代理不可达时的维护响应。OCR 页面消费已有失败类别与结算状态，提供设置入口，并在失败后更新账本剩余。
- 实际验证：Web OCR 4 文件、38 项测试及 Web 类型检查通过；Go `internal/aliyun` 包测试通过，包括真实 SDK 对本地 HTTP fixture 的成功/权限拒绝/限流/503 四种响应，每例仅 1 次请求；生产边缘静态契约通过；隔离 Caddy fixture 验证 502/503/504 透传与 API 不可达回退 4 项通过。
- 快速更新已部署代码提交 `1c2a0a4`：API 与 gateway 镜像为 `v3-test-1c2a0a4`，`APP_VERSION` 仍为 `v2.2.0-rc.1`。仅替换这两个服务与 Caddy 错误透传配置，保留旧镜像与配置副本；Worker、Ollama、数据库容器及索引未改动。API healthy、gateway running，均零重启、无 OOM。
- 已登录测试站浏览器在 `1280×720` 打开 OCR 路由：新 file input 位于持久图片卡片而非条件上传区，格式限制、空状态禁用动作正常，页面与主区无横向溢出。随后通过真实浏览器文件选择接口完成首次选图及点击“更换图片”重选同一文件；连续换图/取消另由组件交互测试验证，未覆盖移动 WebKit 全流程。
- 只读排障发现既有 2 次 OCR 调用被保守结算为 uncertain，旧日志未保存足够信息还原具体上游拒绝原因；不追溯释放额度。
- owner 随后明确授权 1 次合成图片真实 OCR 复测：页面预检、明确确认、上传链路已执行；阿里云返回 `service_not_open`，页面正确显示“服务未开通”、上游 RequestId、设置入口及本次未扣减本地保护额度，剩余保持 `188/190`。本轮仅调用 OCR 1 次、翻译 0 次，无自动或手动重试。云 OCR 真实可用性尚未通过，需 owner 确认/开通对应阿里云服务后另行授权复测；未更改云账号配置，未提升 RC 或发布状态。

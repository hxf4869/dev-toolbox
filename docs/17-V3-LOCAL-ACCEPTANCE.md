# V3 本地验收与评测工具

日期：2026-09-02。依据：`docs/16` §20。本文先记录本地候选验证，后续测试环境同步及 `v3.0.0-rc.1` 发布记录见末尾；均不等同于稳定版或真实模型质量验收。

## 本轮范围

- 新增私有 40 题输入 Schema、Go 执行器/评分器和合成题集。
- 新增基于实际 Compose、Dockerfile、Caddy 和外置 Nginx 模板的隔离验收脚本。
- 修复验收实际发现的问题：Worker 事件批次超过 50 条、多轮历史消息不符合 SDK 内容块格式、Responses 在 off 时自动补 reasoning 参数，以及知识助手代码块缺少换行开关、复制反馈丢失键盘焦点。
- 不增加生产依赖、服务、表、公开接口或新产品功能；没有真实 Provider 调用、部署、推送、版本号或发布操作。

## 已运行结果

| 检查 | 结果与边界 |
| --- | --- |
| Go 评测工具 | 6 个测试通过；Schema/题型配额、门槛边界、引用归属、人工评分必填、MFA 和未授权不外发 |
| Worker 定向回归 | 5 个文件、73 个测试通过；含真实 SDK 三种协议的历史消息出站、reasoning、50 条批次上限、引用 parser、脱敏和 gateway |
| Web 定向回归 | 2 个文件、4 个测试通过；精确复制、独立换行、反馈前后焦点保留、安全引用 |
| 构建 | API、Worker、Web/Caddy 生产镜像构建成功；Worker/Web 类型检查通过 |
| 四容器 | 使用隔离空库，四个核心服务健康；不复用既有业务数据 |
| 代理链路 | Caddy、external Nginx → Caddy 首事件实时到达；持久 SSE 断开不取消 Run；临时断线取消 Provider、会话/消息/Run/Source 数量不变 |
| 功能与并发 | 引用/来源/reasoning、失败手动重试、持久停止、unavailable 跳过 Embedding；两条 chat 占用时 index 与旧 AI Task 仍可独立执行 |
| 合成 40 题 | 40/40 Run 成功，期望来源 34/34，引用检查 40/40，无依据拒答 6/6 |
| 人工评分门槛 | 合成报告的 40 个 `human.accepted` 保持 null；`score` 按预期退出 1，`realEvaluationAccepted=false` |
| 浏览器布局 | 内置 Chromium 上，390×844、1024×768、1440×900、1920×1080、CSS 3840×2160 的深浅主题均无页面横向溢出，输入框位于视口内；宽屏正文保持居中限宽 |
| 浏览器交互 | 引用抽屉键盘打开、Tab/Shift+Tab 闭环、Escape 恢复焦点；代码精确复制、反馈结束后保留焦点、逐块换行及键盘横向滚动；原始 HTML 显示为文本；实际运行信息可展开 |
| 会话边界 | 持久会话多轮成功，重命名并重新进入后内容恢复；临时会话两轮均到达成功终态，刷新后不保留消息 |
| 减弱动画与缩放 | `prefers-reduced-motion: reduce` 生效；200% 使用 1440×900 对应的 720×450 CSS 视口／DPR 2 等效重排检查，无横向溢出且输入区可见；未测试操作系统原生浏览器缩放 |

真实笔记与真实模型的 40 题人工评测尚未运行。合成 Provider 返回预定内容，只验证执行、检索、引用和评分链路，不证明模型回答质量。

## 复现隔离四容器验收

需要 OrbStack、Node.js、OpenSSL。所有命令在仓库根目录执行。初次需要下载已有版本镜像/依赖；没有付费 Provider 请求。

先编译开发用执行器（不会进入生产 API 镜像）：

```sh
docker --context orbstack run --rm \
  -v "$PWD:/repo" -v dev-toolbox-go-mod-cache:/go/pkg/mod \
  -w /repo/apps/api golang:1.27.0-alpine3.23 \
  sh -c 'go test ./cmd/assistant-eval && go build -o bin/assistant-eval ./cmd/assistant-eval'
node deploy/tests/v3/stack.mjs up
```

`up` 打印仓库外的私有 `state.json` 绝对路径。下列 `<STATE>` 替换为该路径：

```sh
node deploy/tests/v3/verify.mjs <STATE>
node deploy/tests/v3/stack.mjs eval <STATE>
node deploy/tests/v3/stack.mjs down <STATE>
```

- Compose project 固定为 `dev-toolbox-v3-acceptance`；发现同名容器时拒绝覆盖。只绑定本机 `127.0.0.1:18380`，Nginx fixture 使用 `127.0.0.1:18443`。
- Mock Provider 在测试 Worker 容器内运行；该 Worker 只有 internal backend 网络。测试不使用已有 Provider 配置和用户笔记。
- `verify` 可仅跑受影响组，如 `node deploy/tests/v3/verify.mjs <STATE> flows,lanes`。组名为 `caddy`、`flows`、`lanes`、`nginx`。
- 验收 UI：`http://localhost:18380/assistant`。登录使用 fixture 的 `owner` 账户、私有目录 `owner_password` 文件中的随机密码和测试 TOTP；私有状态含测试凭据，不能提交或放入共享日志。
- `eval` 输出一个独立的私有合成报告路径，旧报告不覆盖。原题集中的虚拟 fragment ID 会被映射为本次隔离库的真实 fragment ID。
- 执行器需在 `up` 前编译；若运行中重新编译了挂载二进制，需只重建测试 API 容器的挂载后再用，不要影响既有服务。
- `down` 只删除该测试 project 的容器与网络；数据库、凭据和报告仍保留在打印的临时目录，便于检查。并发测试新增的合成笔记移入隔离库回收站，不永久删除。

## 私有真实题集与人工评分

输入 Schema：`docs/contracts/assistant-evaluation.schema.json`。合成示例：`apps/api/cmd/assistant-eval/testdata/synthetic.json`。

题型必须为 `direct_fact=12`、`paraphrase=10`、`cross_note=6`、`follow_up=6`、`not_found=6`。每题显式给出 `noteOnly`、允许/期望 fragment ID、可答/拒答标记。追问题 `followUpTo` 指向更早的有答案题，按既有会话顺序追加，不创建分支。真实题集使用 `kind=real`，内容和来源 ID 都由人工准备，不能沿用合成数据冒充真实评测。

先只验证输入（从 `apps/api` 执行）：

```sh
go run ./cmd/assistant-eval validate --cases /private/path/cases.json
```

真实运行前必须另行取得当次授权，说明具体 Provider、模型、索引可用性和调用规模：至少 40 次回答，还包括必要的查询 Embedding、改写、标题/摘要，以及合同允许的首次输出前重试。索引应提前 ready，不把建立真实全库索引隐含在评测授权内。

获授权后，使用现有数据库连接配置，以及仓库外的私有登录文件 `{username,password,totpCode}`；TOTP 使用当前有效值。CLI 使用正常登录和 MFA，不绕过认证。数据库仅在只读事务中提取该轮实际证据；创建会话/回答仍走公开 API。

```sh
go run ./cmd/assistant-eval run \
  --cases /private/path/cases.json \
  --report /private/path/report.json \
  --auth-file /private/path/auth.json \
  --origin https://your-app.example \
  --model-id <已配置模型的UUID> --reasoning off \
  --allow-provider-calls
```

`run` 要求显式仓库外绝对报告路径，以 0600 新建且不覆盖。HTTPS 为默认要求，HTTP 仅支持回环地址。固定 `--fixture-api http://gateway` 只允许用于 `kind=synthetic` 的本地 Compose fixture，不用于真实评测。

保留输入文件与报告：题型、note-only、允许/期望来源由输入提供；报告按 `questionId` 记录问题、Run/模型/档位/Prompt/检索版本、knowledge generation、回答、实际 top 8/canonical 引用和自动判定。终态后逐题保存；失败或断流就停止，不自动重发整题，也不自动继续外发。命令输出只含进度、汇总和固定错误，不输出真实问题、摘录、凭据或 Provider 正文。

人工逐题核对主张是否正确且被片段支持，填写报告的 `human.accepted`。通过题 `failureCategory=""`；不通过题选 `retrieval`、`answer`、`citation`、`refusal`、`availability` 或 `runtime`。然后离线评分：

```sh
go run ./cmd/assistant-eval score \
  --cases /private/path/cases.json --report /private/path/report.json
```

评分器重算引用和检索检查，不信任报告中已有的 automatic 布尔值。必须完成 40 个人工判定，且达到来源 ≥31/34、正确且有依据 ≥29/34、无答案拒答 6/6、引用检查 40/40。未完成或未达标退出 1；合成题集即使满足全部门槛，也永远不会标记为真实评测通过。

## 后续测试环境同步（2026-09-02）

经用户另行授权，提交 `03056c7` 已构建为目标主机的三个 AMD64 应用镜像并同步至既有测试环境，镜像标签为 `v3-test-03056c7`。保留原 `APP_VERSION` 和正式发布记录，没有推送、Git tag 或正式发版。

- 使用现有数据库的服务器本地物理副本，验证 Schema 7 → 8 → 7、pgvector 运算，以及回到原 `postgres:18.6-alpine3.23` 镜像后的启动与读取。原始记录、搜索片段、Provider/模型、AI 派生结果和历史任务在各阶段逐字比较一致，无失效索引。
- 镜像切换前需按目标镜像中的 PostgreSQL 用户调整数据目录属主。此次源库使用 Alpine libc 且未记录 collation version；切换至 Debian libc 和回退时均重建数据库索引，保留原版本元数据，不直接修改系统目录。`REFRESH COLLATION VERSION` 不适用于此次空版本到有版本的切换。
- 实际环境已使用 `pgvector/pgvector:0.8.6-pg18-trixie` 和 Schema 8。迁移前后 17 条记录、18 条原始记录、1,619 个片段、1 个 Provider、1 个模型、21 个 AI 派生结果及 58 个历史任务数量一致。数据库、API、Worker 健康，Web/Caddy 正常运行，均无重启循环。
- 仅在该站的外置 Nginx 配置补充知识助手流式路径；配置校验通过并已热加载。公网 HTTPS 健康接口、原登录会话恢复、知识助手入口、已有模型目录及未配置知识库提示已实测；本次没有发送模型问题，不把配置校验记为真实 Provider/SSE 验收。
- 切换前的数据目录、旧镜像和配置仍保留供本次升级回退。副本及比较文件仅在服务器私有目录内，未访问 OSS、未运行 restic 或正式发布门禁。

该次同步时，测试环境的 Embedding 尚未配置，未启用索引、未外发真实笔记。真实 40 题评测仍待独立 Embedding 配置、索引授权及就绪、私有题集和当次真实模型调用授权；本次同步不构成 V3 完成验收。

## CPU Embedding 修复与真实三轮冒烟（2026-09-02）

经用户后续授权，内网 Ollama 的 `qwen3-embedding:0.6b` 已启用持续索引，使用 1,024 维向量及 `redact` 敏感策略。此次修复提交为 `5e70b77`，只更新测试环境 API 和 Worker 镜像，保留已有 Web、网关、数据库结构、应用版本及回退镜像和配置。

- 实际索引领取批次由 16 缩小为 4；仅后台 Embedding 超时由 60 秒调整为 180 秒，查询和连接测试仍为 60 秒，原有心跳及最多 16 项的完成/失败协议不变。
- 修复 Worker 将成功的 HTTP 204 当作 JSON 解析、导致失败上报后索引循环退出的问题；修复未配置或未启用时活跃片段计数为 0、影响首次启用确认的问题。
- Worker 定向回归 77 项、Web 设置回归 4 项、API 定向数据库集成测试 5 项及 `internal/assistant` 单元测试通过；Worker 类型检查、API/Worker AMD64 镜像构建通过。Web 无生产代码改动，未重新部署。
- 明确重试原有 16 个失败片段，保留已完成的 176 个向量及 Generation 2；北京时间 16:53，全部 1,605 个片段达到 `ready`，待处理、运行中、失败均为 0。问答后 API、Worker、Ollama 均健康，无容器重启或 OOM。

使用已有聊天 Provider 的 DeepSeek V4 Flash，在同一持久会话中仅发送获授权的三轮主问题及必要辅助调用。三轮 Run 均为 `succeeded`，但运行成功不等于回答质量或引用验收通过：

| 轮次 | 实测结果 |
| --- | --- |
| 笔记事实与来源 | `matched`，提供 8 个来源、形成 5 个规范引用；引用可打开，对应摘录支持回答的主要操作。主要来源为明确标注“未人工验证”的 AI 派生内容，不代表运维建议已验证。 |
| 上下文追问 | 正确沿用上一轮主题并完成回答，但输出 18 处 `[Sx]` 普通文本，而非协议要求的 `[[Sx]]`；提供 8 个来源，规范引用为 0，引用验收未通过。刷新后仍如此，非前端临时加载问题。 |
| 无资料拒答 | `not_found`，提供来源为 0；明确说明笔记没有所问信息，没有编造答案。 |

刷新并重新进入会话后，三组问题与回答均完整保留。三个查询 Embedding 用时分别为 796、566、580 毫秒；这是本次已加载模型下的观察值，不是性能基准。未将真实问题、笔记摘录或凭据写入本记录。

CPU 索引与启用计数修复已验证；该次三轮冒烟时，第二轮模型未遵循引用格式的问题尚未修复，不能将三轮冒烟标为全部通过。真实 40 题人工评测仍未执行，需私有题集及当次调用授权；本记录不构成 V3 完成验收。

## 引用格式与跨轮上下文修复（2026-09-02）

- 提交 `8c2c090`：Worker 在同一个有限状态解析器中接受真实模型出现的 `[S1]`–`[S8]` 写法，与 `[[S1]]`–`[[S8]]` 生成相同的本轮来源事件。继续拒绝越界编号、畸形数字标记及伪造的 `[[C`，保留普通 Markdown 标签；不在 Web 猜测来源或改写历史记录。
- 引用、脱敏及事件批次的 22 项定向测试通过，包含两种写法混用、任意 delta 边界、无来源/越界、伪造引用和 redactor 尾部标记；Worker 类型检查和 AMD64 镜像构建通过。
- 用户另行授权的 1 轮真实追问已执行，使用同一持久会话、DeepSeek V4 Flash、`off` 及 `redact`。Run 成功，提供 8 个来源、形成 3 个规范引用，正文 10 处引用均可点击；逐一打开三个来源成功，刷新后四组问答及新引用完整保留，新回答没有普通 `[Sx]` 残留。查询 Embedding 为 567 毫秒，回答阶段为 4,913 毫秒，仅为本轮观察值。
- 引用归属链路恢复，但至少一个被引用片段仅含章节标题，不能支持相应配置主张，因此未将本轮标记为回答质量完全通过。同步检查确认，旧版未解析的 `[Sx]` 会进入后续历史上下文；这是确定的过滤缺口，但不能仅凭一轮回答认定全部错引都由它引起。
- 补充提交 `479437a`：在 API 既有历史过滤函数中去除旧助手的 `[S1]`–`[S8]`，同一入口覆盖持久对话、临时对话及摘要输入，用户消息和已保存历史原文不改；Prompt 升为 `assistant-answer-v2`，明确本轮正文必须直接支持所引主张，标题/路径不能代替具体事实依据，禁止沿用旧编号。没有调整检索或索引规则。
- 补充修复的 API `internal/assistant` 单元测试、2 项 Worker 提示约束测试及类型检查通过；API/Worker AMD64 镜像构建成功，两服务均已更新为 `v3-test-479437a` 且健康。Web、网关、数据库结构和正式应用版本保持不变；旧镜像及配置保留供回退。
- 更新后原会话仍有四组问答，旧回答原文未改；Generation 2 的 1,605 个向量仍全部 `ready`。Ollama 保持用户指定的 4 核 CPU、4GB 内存上限，Worker 内网模型列表检查成功。

该轮真实调用授权已使用，没有自行追加模型请求。Prompt v2 与历史去编号的补充版本尚未进行真实问答复测，需额外 1 轮调用授权；不能把本地回归或上一版本的点击验证记为该版本的回答质量通过。真实 40 题人工评测仍未运行。

## v3.0.0-rc.1 发布候选（2026-09-02）

用户明确要求提交代码、发布版本并更新既有京东云服务。功能提交 `77ade61` 包含固定底部输入区与完整输入上下文计量；版本准备提交 `a979347` 将 Web、Worker 和帮助页版本统一为 `v3.0.0-rc.1`。三个 AMD64 应用镜像均从 `a979347` 的干净 Git 归档构建，未包含未跟踪文件或本机私有配置。

- Web 与 Worker 类型检查及生产构建通过，API 三个生产二进制和三个应用镜像构建成功。功能候选已通过的 41 项 Web、16 项 Worker 定向回归、Go assistant/operations 单元测试、5 项定向集成测试及隔离迁移验证，详见 `docs/16` §20.4；本轮只有版本元数据变化，没有重复运行整套测试。
- 北京时间 21:42，只切换 API、AI Worker、Web/Gateway 三个应用镜像。迁移预检为当前 8、目标 9、待应用 1；实际升级后 Schema 为 9，新增 `assistant_runs.answer_context_tokens` 为可空 bigint。既有 4 条 Run、8 条消息数量未变，历史完整输入计量仍为 NULL，没有伪造或回填为 0。
- API ready、Worker live、公网 HTTPS 健康接口通过；三个应用容器正常运行，重启计数为 0，无 OOM。PostgreSQL 与 Ollama 启动时间未变；保留已有内网 Embedding、HTTP 放行配置以及 Ollama 的资源限制。未改 Nginx、TLS、数据库镜像或系统软件。
- 已登录浏览器可恢复原会话，帮助页显示 `v3.0.0-rc.1`；知识助手新对话页显示知识库可用、上下文「待请求 / 200K」和独立字符计数。当前 835×866 视口下输入区位于底部，页面无外层横向或纵向溢出。本轮未发送模型问题，不将空态页面烟测当作真实计量或回答质量验收。
- 旧应用镜像及部署配置副本保留在服务器私有目录。没有执行 Schema 回退；若回退到只接受 Schema 8 的旧 API，需要单独处理数据库版本，不能仅恢复旧镜像便宣称可用。
- 本轮未调用真实 Provider、Embedding、阿里云或 OSS/S3/restic，未执行备份、恢复、性能测试、完整浏览器矩阵或 `release-check`。固定八项发布状态按当前证据标记为待检查/需复核，不沿用旧版通过结论。

该版本是可部署测试候选，不宣称 V3 稳定版完成。真实 40 题人工评测与目标版本完整发布门禁仍待独立授权及相应输入。

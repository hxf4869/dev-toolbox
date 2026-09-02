# V3 本地验收与评测工具

日期：2026-09-02。依据：`docs/16` §20。本文记录本地候选验证，不是正式发布或真实模型质量验收。

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

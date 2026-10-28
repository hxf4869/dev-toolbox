# 开发百宝箱（Dev Toolbox）

开发百宝箱是一个面向个人开发与运维的自托管工具集合，当前由知识与记录、工具箱、知识助手三个平级模块组成。原始记录和附件作为不可变事实层保存、不被覆盖，AI 整理只生成独立的可追溯、可重建派生候选；工具默认在本地处理，JSON AI 类型生成、机器翻译与云 OCR 等在线增强需相应配置并按界面确认后使用；知识助手支持一般交流，或基于知识库问答并查看引用。

一期 `v1.0.3` 已正式部署。当前 **M0–M5 已完成并验证，`v1.0.0` 已由八项门禁全部通过的 `v1.0-baseline` 原样晋级；`v1.0.1` 修复会话活跃时间刷新；`v1.0.2` 放宽 Provider 连接测试超时；`v1.0.3` 增加工具调用与严格 JSON 双通道的多模型 Artifact 兼容**。目标主机性能、Chrome/Safari 核心 E2E、VoiceOver 基础抽查，以及京东云 OSS 异地加密备份与回读均已有真实证据，详见 [一期验收记录](./docs/08-V1-ACCEPTANCE-REPORT.md)。Edge、Firefox 不属于一期发布验收范围，不安装、不宣称已验证兼容。

第二期 V2.0–V2.2 已实现，并于 2026-09-01 以 `v2.2.0-rc.1` 发布候选部署：包含中立首页、八个本地工具、JSON AI 类型生成、阿里云额度保护与文本翻译，以及本地/云 OCR 翻译。当前自动化、隔离数据库集成、生产静态契约、应用健康与正式 HTTPS 已通过；真实阿里云、目标版本备份恢复/性能门禁、完整浏览器矩阵和 `release-check` 尚未执行，因此未标记为稳定版。入口见 [V2 工具箱总基线](./docs/09-V2-TOOLBOX-BASELINE.md)、[V2 交付验收记录](./docs/13-V2-TOOLBOX-DELIVERY-AND-ACCEPTANCE.md) 与 [RC 审计修复执行文档](./docs/15-V2-RC-AUDIT-REMEDIATION.md)。

第三期知识助手于 2026-09-02 以 `v3.0.0-rc.1` 更新既有测试环境，包含持久/临时对话、知识检索与引用、内网 Embedding 接入，以及固定底部输入区和实测上下文占比。三个 AMD64 应用镜像构建、Schema 8→9 单列迁移、服务健康、HTTPS 与页面烟测通过；数据库及 Ollama 未重启。上下文计量的生产者/消费者与迁移回归已通过，但真实 40 题人工评测、目标版本备份恢复/性能门禁及完整 `release-check` 尚未完成，仍为候选版。范围见 [V3 实现合同](./docs/16-V3-KNOWLEDGE-ASSISTANT-IMPLEMENTATION.md)，本次发布与验证边界见 [V3 验收记录](./docs/17-V3-LOCAL-ACCEPTANCE.md)。

`v3.0.0-rc.2`（2026-10-27）为全仓代码审计修复候选版：补齐 redact 策略下相关记录标题与检索来源快照的脱敏；修正批量任务取消与租约回收的行锁顺序死锁；embedding 凭据读取/解密失败改为领取侧失败关闭并补充索引 reconciler 阶段化日志；worker 三条领取循环区分瞬时与永久错误；认证流程区分无效凭据与系统故障；修复登出成功分支的会话归属、"跟随系统"主题、Assistant SSE 404 清理与编辑器加载失败恢复；JSON diff 增加 500 条展示上限、embedding 响应按流执行 32 MiB 限额、Docker 构建上下文排除嵌套环境文件。前端/worker 单元测试与隔离数据库集成测试通过；真实评测、目标版本备份恢复/性能门禁及完整 `release-check` 仍未执行，维持候选版状态。

`v3.0.0-rc.3`（2026-10-28）为审计修复候选版：附件删除回滚失败时保留可恢复副本并返回错误；AI 持久和临时会话按有效策略处理输出，已产生用户可见内容后不再自动重试；修复 JSON Diff 原型同名属性漏报和 JSON→YAML 普通对象误判；助手消息列表改为按页批量查询 Run 与引用。相关 Web/Worker 单元测试、Go 单元及隔离 PostgreSQL 集成测试、类型检查已通过。底层 `lossless-json` 对字符串值 `__proto__` 字段的解析问题仍待修复；真实评测、目标版本备份恢复/性能门禁及完整 `release-check` 未执行，维持候选版状态。

## 使用入口

当前版本的应用入口与模块对应关系：

| 入口 | 模块与用途 |
|---|---|
| `/knowledge` | 知识与记录：保存、检索和管理原始资料与附件 |
| `/tools` | 工具箱：本地处理工具；JSON AI 类型生成、机器翻译与云 OCR 等在线增强需配置并按界面确认后使用 |
| `/assistant` | 知识助手：支持一般交流，或基于知识库问答并查看引用；能否检索取决于索引状态 |
| `/help` | 帮助：产品边界与安全说明，含 `/help#knowledge-assistant` 的配置、索引、引用与临时外发说明 |

三个模块的本地修复与代表流程记录见[产品迭代记录](./docs/19-PRODUCT-ITERATIONS.md)；该记录不改变部署与正式验收状态，版本发布与验收结论仍以前述版本段落和对应验收报告为准。

## 一期核心闭环

```text
登录与 MFA
  → 快速粘贴或上传
  → 保存不可变原始记录
  → 建立关键词与模糊搜索索引
  → 查看、复制和管理记录
  → 可选提交 AI 整理/检查
  → 保存版本化派生结果
```

## 本地开发

本机需提供 `make`、`openssl`、`jq` 和 OrbStack 的 Docker 兼容运行时。首次启动与后续启动使用同一条命令：

Agent Console 接入构建还要求其仓库默认位于本仓库同级的 `agent-console/`；
目录不同时，通过绝对路径 `AGENT_CONSOLE_SOURCE_ROOT` 指定。

```bash
make up
```

该命令会在已忽略的 `deploy/.env`、`deploy/secrets/` 和 `deploy/data/` 下创建本地配置、随机 Secret 与持久化目录，构建并启动 Caddy、API、AI worker、PostgreSQL 四个服务。启动后访问 <http://localhost:8080>，API 就绪检查为 <http://localhost:8080/health/ready>。

首次启动后在终端创建唯一所有者，随后打开 Web 完成 TOTP 绑定并保存一次性恢复码：

```bash
make init-owner
```

如果所有登录因素均丢失，可在主机终端运行 `make reset-auth`。该命令只重置密码、TOTP、恢复码、会话和可信设备，不修改知识记录或附件；下次登录必须重新绑定 TOTP。

`make install`、`make check`、`make test`、`make build` 在宿主机执行，要求本机已安装 Node.js `>=22.19.0` 且 `<25` 与 pnpm `11.9.0`（与根目录 `package.json` 的 `engines` 和 `packageManager` 一致）；`make up` 的镜像构建在 Docker 内完成，不要求宿主机安装这些 Node 工具。

常用开发命令：

```bash
make install      # 安装锁定的本地 Node 依赖
make check        # Web/worker 类型检查 + Go 测试
make test         # Web/worker/Go 单元与契约测试
make build        # Web/worker 构建 + 四服务镜像构建
make migrate      # 重复执行顺序迁移；无新迁移时不改变数据库
make init-owner   # 一次性创建所有者；重复执行不会覆盖
make reset-auth   # 主机侧重置认证，不修改知识数据
make rebuild-search # 确定性重建当前搜索分片，保留历史片段用于旧引用定位
make m1-integration-test # 在隔离测试库验证 M1 认证与录入闭环
make m2-integration-test # 在隔离测试库验证 M2 检索、附件与资料库闭环
make m3-integration-test # 在隔离测试库验证 M3 Provider、PAT 与外部 Artifact 闭环
make v2-integration-test # 在隔离测试库验证 V2.0 JSON AI 窄同步调用链
make m4-integration-test # 在隔离测试库验证 M4 任务、Artifact、批量与调度闭环
make m5-integration-test # 验证迁移、状态页、完整性、存储故障和真实 ENOSPC 原子性
make m5-performance-test # 生成 5 万记录/50 万片段/20 GiB 稀疏附件的固定规模报告
make m5-recovery-test # 在隔离生产四服务形态完成加密备份与空机恢复演练
make down         # 停止本地服务
make reset-dev    # 停止服务并清空本地开发数据，保留配置与 Secret
```

`make reset-dev` 只用于本地开发数据。执行后再次运行 `make up`，即可从空 PostgreSQL 数据目录重新迁移。

登录后可在 `/settings/operations` 查看服务、Provider、附件卷、备份、恢复和发布门禁的只读状态；`/help` 说明原始记录、AI 候选结果、V2.0 本地处理/JSON AI 发送边界与一期安全边界。宿主机脚本只把经过严格 JSON 校验的摘要写入状态目录，Web 不提供 Shell、SSH、SQL 或任意系统命令入口。门禁证据变化后先审核 `deploy/release-status.v1.json`，再运行 `make publish-release-status`；脚本会拒绝未知门禁、无效时间和部署版本不匹配。

## 生产部署

生产环境需要一个已解析到主机的正式域名、可从公网访问的 TCP 80/443，以及与部署主机故障域分离的 restic 仓库。仓库可以是应用数据目录之外的异地挂载路径，也可以是原生 S3 兼容对象存储。默认由 `gateway` 直接暴露 80/443；主机已有受控 Nginx 时可改用 `external_nginx`，此时四个应用容器均不映射宿主机端口，Nginx 通过已有 Docker 网络访问 gateway。两种模式下 API、AI worker 和 PostgreSQL 都只连接 Compose 网络。先准备配置：

```bash
cp deploy/env.production.example deploy/.env.production
chmod 600 deploy/.env.production
# 编辑 APP_DOMAIN、APP_VERSION、数据库名/用户，并在 RESTIC_LOCAL_REPOSITORY_PATH
# 与 RESTIC_REPOSITORY=s3:https://endpoint/bucket/prefix 中二选一
# 主机已有 Nginx 时另设 DEPLOY_EDGE_MODE=external_nginx、EDGE_NETWORK_NAME=<现有网络>
# 和 FAIL2BAN_AUTH_LOG_PATH=<Nginx access.log 的宿主机绝对路径>
make production-init
make build-release
make production-check
make production-up
# 固定部署在 /home/toolbox 时，启用 Asia/Shanghai 每日 03:17 备份：
sudo install -o root -g root -m 644 deploy/cron/dev-toolbox-backup /etc/cron.d/dev-toolbox-backup
# external_nginx 模式：渲染 Nginx、Fail2ban filter 与 jail；先分别执行
# nginx -t、fail2ban-regex 和 fail2ban-client -t，再备份旧配置并 reload。
make verify-https
make production-init-owner
# 完成正式浏览器矩阵并更新 release-status.v1.json 后：
make release-check
```

`production-init` 会生成随机数据库密码、内部服务令牌、32 字节应用主密钥和 restic 密码，并设置目录权限；它不会生成弱默认值。S3 模式还要求预先提供权限为 `0600`、仅含 `AWS_ACCESS_KEY_ID` 与 `AWS_SECRET_ACCESS_KEY` 的独立凭据文件，Secret 不写入仓库或命令参数。应用主密钥和 restic 密码必须立即另存到与主机故障域分离的离线位置。首次所有者密码从交互式标准输入读取，随后在浏览器完成 TOTP 绑定并保存只显示一次的恢复码。

`production-check` 会验证四服务拓扑、公网边缘模式、固定镜像版本、非 root/只读根文件系统、capability、Secret、数据目录与日志轮转。外置 Nginx 模式还会拒绝任何 gateway 宿主机端口映射，并要求目标 Docker 网络已经存在。`verify-https` 必须在真实 DNS 与受信任证书生效后运行，并校验 HTTP 跳转、健康响应、HSTS、CSP、`nosniff` 与 Referrer Policy；内部 CA 或跳过证书校验不算正式门禁。`release-check` 是最终只读门禁：它同时要求八项候选状态、固定规模性能、生产形态空机恢复、正式 HTTPS 和部署静态检查全部通过，任一证据缺失或版本不一致都会返回非零状态。

外置 Nginx 对登录端点按真实来源 IP 设为 `6r/m`、短突发 5 次并以 429 拒绝超额请求。现有 Fail2ban 可加载仓库渲染的 `dev-toolbox-auth` filter/jail：10 分钟内累计 12 次登录 401/429 时临时封禁 1 小时，重复触发递增、最长 24 小时；不做永久 IP 封禁。应用内部仍独立按来源 IP 与账号标识递增等待，因此 IP 防护不是唯一认证控制，密码成功后仍必须完成 TOTP。

## 备份、恢复与升级

备份会短暂停止 API 和 worker，导出 PostgreSQL custom dump，把原始附件和非敏感配置清单写入加密 restic snapshot，再恢复服务。生产机复用既有 cron，于 Asia/Shanghai 每天 03:17 调用同一版本仓库中的 `run-scheduled-backup.sh`；文件锁阻止重叠执行，输出写入系统日志，失败状态同时进入只读运维页。

S3 模式强制使用 HTTPS 和 DNS-style Bucket 访问；`RESTIC_REPOSITORY` 仍按 restic 约定填写为 `s3:https://Endpoint/Bucket/prefix`，运行时会访问 `Bucket.Endpoint`。配置容量上限与安全余量后，脚本会在停服前、实际上传前和上传后检查 restic 原始数据量；预计越过门禁时以 `BACKUP_CAPACITY_LIMIT` 失败，不会自动删除已有 snapshot。该门禁只覆盖专用 Bucket/prefix 中的 restic 数据；对象存储账号内的其他文件、版本控制产生的历史版本以及请求/公网流量计费仍须通过云控制台告警约束。

```bash
make backup          # 静默窗口备份，失败也会尝试恢复 API/worker
make check-backup    # restic check，并记录最近成功检查时间
make prune-backups   # 默认只显示 7 日/4 周/6 月保留策略的 dry-run
make check-integrity # 校验每个已引用附件的存在、大小和 SHA-256；只报告孤儿
```

恢复必须指向新的空目录和明确 snapshot，不覆盖当前数据：

```bash
RESTORE_ROOT=/absolute/empty/restore-root \
SNAPSHOT_ID=<verified-snapshot-id> \
make restore
```

恢复脚本先恢复空 PostgreSQL 与原始附件，再执行迁移预检和逐附件完整性检查；不一致会停止 worker/gateway 并保留现场。成功后恢复项目保持运行供登录、搜索、附件与 mock AI 验收，确认无误后再由维护者决定是否切换正式数据路径。

升级要求已审核的目标配置和该目标版本的成功空机恢复报告：

```bash
TARGET_ENV_FILE=/absolute/path/to/target.env \
REHEARSAL_REPORT_FILE=/absolute/path/to/restore-report.json \
./deploy/scripts/upgrade.sh
```

脚本先做升级前备份与迁移预检，再切换版本并执行向前迁移；不会伪造破坏性迁移的一键回滚。认证因素全部丢失时使用 `make production-reset-auth`，它只重置认证数据，不读取或修改知识记录与附件。

## Provider 配置与限制

在“设置 → Provider”中选择 OpenAI Responses、OpenAI Chat Completions 或 Anthropic Messages 协议，填写 HTTPS Base URL、API Key 和模型能力后执行连接测试。Key 使用应用主密钥加密，状态页只显示最近结果和稳定失败分类。默认测试全部使用本地 mock，不调用付费模型；真实模型烟测需要维护者明确启用并承担费用。

一期仍有这些历史边界：单所有者、非端到端加密、无高可用/PITR/病毒扫描/知识附件 OCR/语义搜索/插件系统；AI 只能读取已授权上下文和附件、检索相关记录并提交候选 Artifact，不能执行 Shell、SSH、SQL、浏览器、任意 HTTP、任意文件系统或代码。V2.2 只例外新增独立工具箱 OCR，不改造知识模块。其他延期能力以 [BACKLOG](./docs/BACKLOG.md) 为准。

## 文档入口

| 文档 | 作用 |
|---|---|
| [PRODUCT.md](./PRODUCT.md) | 长期稳定的产品事实、用户、定位和原则 |
| [docs/00-V1-BASELINE.md](./docs/00-V1-BASELINE.md) | 一期总基线、范围、术语、主流程和冻结决策 |
| [docs/01-ARCHITECTURE.md](./docs/01-ARCHITECTURE.md) | 系统边界、运行组件、模块职责和仓库结构 |
| [docs/02-DATA-MODEL.md](./docs/02-DATA-MODEL.md) | 原始数据湖、知识条目、附件、搜索和 AI 版本的数据模型 |
| [docs/03-API-AND-AI-CONTRACTS.md](./docs/03-API-AND-AI-CONTRACTS.md) | HTTP API、外部 Agent 接入、AI 任务引擎和动态 JSON 契约 |
| [docs/contracts/ai-artifact.schema.json](./docs/contracts/ai-artifact.schema.json) | 一期 AI 派生结果的机器可校验 JSON Schema |
| [docs/04-SECURITY-AND-OPERATIONS.md](./docs/04-SECURITY-AND-OPERATIONS.md) | 登录、MFA、可信设备、敏感数据、部署、备份和恢复 |
| [docs/05-UX-DESIGN-BASELINE.md](./docs/05-UX-DESIGN-BASELINE.md) | Stitch 视觉方向、布局、组件、状态、可访问性和一致性约束 |
| [docs/references/STITCH-CRITIQUE.md](./docs/references/STITCH-CRITIQUE.md) | 原始 Stitch 母版的可移植评审记录 |
| [docs/06-DELIVERY-AND-ACCEPTANCE.md](./docs/06-DELIVERY-AND-ACCEPTANCE.md) | 里程碑、完成定义、测试策略和验收用例 |
| [docs/07-DESIGN-HANDOFF.md](./docs/07-DESIGN-HANDOFF.md) | Stitch 项目入口、01–33 规范画面 ID、里程碑映射和开发使用规则 |
| [docs/08-V1-ACCEPTANCE-REPORT.md](./docs/08-V1-ACCEPTANCE-REPORT.md) | `v1.0.0` 的门禁证据、实测结果与正式发布结论 |
| [docs/09-V2-TOOLBOX-BASELINE.md](./docs/09-V2-TOOLBOX-BASELINE.md) | V2 工具箱范围、版本、每个工具的做/不做与硬边界 |
| [docs/10-V2-TOOLBOX-ARCHITECTURE.md](./docs/10-V2-TOOLBOX-ARCHITECTURE.md) | V2 模块、依赖、编辑器/Worker、Go 调用链与资源边界 |
| [docs/11-V2-CLOUD-SERVICES-CONTRACTS.md](./docs/11-V2-CLOUD-SERVICES-CONTRACTS.md) | 阿里云设置、数据表、额度事务、队列、API 与 JSON AI 契约 |
| [docs/12-V2-TOOLBOX-UX-AND-STITCH.md](./docs/12-V2-TOOLBOX-UX-AND-STITCH.md) | Stitch 34–42 规范 Screen ID、页面母版、状态、响应式和文案 |
| [docs/13-V2-TOOLBOX-DELIVERY-AND-ACCEPTANCE.md](./docs/13-V2-TOOLBOX-DELIVERY-AND-ACCEPTANCE.md) | V2.0/V2.1/V2.2 实施顺序、测试矩阵和发布门槛 |
| [docs/14-V2-AGENT-RUNBOOK.md](./docs/14-V2-AGENT-RUNBOOK.md) | 多 Agent ownership、共享文件、停止点、交付格式和可复制任务模板 |
| [docs/BACKLOG.md](./docs/BACKLOG.md) | 已确认版本之外的候选和产品方向变更，防止开发越界 |
| [AGENTS.md](./AGENTS.md) | 所有编码 Agent 必须遵守的仓库级规则 |

## 决策优先级

发生冲突时按以下顺序处理：

1. 用户当前明确要求。
2. `AGENTS.md` 中的仓库级约束。
3. 当前任务对应的版本基线：V2 使用 `docs/09`，一期使用 `docs/00`。
4. 对应版本专题文档中的具体契约。
5. 未被 V2 明确覆盖的一期冻结约束。
6. `PRODUCT.md` 中的长期产品事实。
7. 代码中的既有实现。

任何会扩大当前确认版本、改变原始数据不可变原则、增加运行服务、改变外发/额度或安全模型的决定，都必须先更新基线并由用户确认，不能由实现 Agent 自行推断。

## 重要说明

- 开发百宝箱不是密码管理器，不提供密码生成、自动填充、密钥轮换或零知识保险库能力。
- 一期服务端需要读取明文以完成搜索和 AI 处理，因此使用的是 TLS 传输加密，**不是端到端加密**。
- 原始知识内容和附件按用户要求以明文保存在受控数据卷中；备份必须加密。
- AI 的“正确性检查”只能生成建议和风险提示，不代表命令已经在目标服务器验证，更不会自动执行命令。
- 真实 Notion 数据和敏感样本不得提交到仓库；开发测试只使用脱敏的结构化样本。

## 名称说明

“开发百宝箱”直接说明产品面向开发与运维工作，并允许以后加入更多彼此独立的小工具；记录与检索只是第一个模块。英文显示名使用 `Dev Toolbox`，仓库名使用 `dev-toolbox`。这是项目工作名，不主张名称唯一性。

## 开源许可证

本项目采用 [MIT License](./LICENSE)。

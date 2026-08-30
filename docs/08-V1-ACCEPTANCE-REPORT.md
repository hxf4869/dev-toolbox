# 开发百宝箱 v1.0.2 正式版验收记录

状态：**v1.0.2 已部署到京东云正式环境；八项发布门禁全部通过，一期关闭**

正式版本：`v1.0.2`

初始已验收候选：`v1.0-baseline`

最近更新：2026-08-30（Asia/Shanghai）

本文只记录已经运行的检查及其限制。`v1.0.0` 由已通过全部门禁的 `v1.0-baseline` 原样晋级；`v1.0.1` 修复真实 PostgreSQL 环境下会话活跃时间刷新失败；`v1.0.2` 将 Provider 连接测试总超时延长至 60 秒，并在完成针对性自动化回归、隔离生产形态恢复演练、升级前备份和正式切换后部署。未重新执行的性能与浏览器历史证据仍对应初始候选，不宣称为补丁版本重复实测。机器可读摘要位于 `deploy/release-status.v1.json`，由 `deploy/scripts/publish-release-status.sh` 严格校验后原子写入只读运维页。性能与恢复报告生成在已忽略的 `deploy/data/operations/`，不把运行数据或 Secret 提交到仓库。

## 0. 补丁发布

### v1.0.2

- Provider 连接测试总超时由 10 秒延长至 60 秒，API 与 AI worker 的 deadline 窗口同步放宽，外置 Nginx 读取超时设为 65 秒；正式 AI 任务的 5 分钟上限未改变。
- AI worker 119 项测试、API AI 包测试、M3 Provider 集成、worker TypeScript 检查、Web/worker 构建、外置 Nginx 与 restic 后端部署契约均通过。
- 京东云使用已有正式 OSS snapshot `2885bcef` 在隔离目录、隔离 Compose 项目和隔离边缘网络完成 `v1.0.2` 恢复，四个目标服务均正常启动；该 snapshot 当时没有附件，所以这里只证明正式备份可恢复和目标版本可启动，不把它记作附件完整性证据。
- 完整合成数据恢复演练生成加密 snapshot `ceadfd51`，通过 `restic check` 后从空目录与空数据库恢复；20 条文本、5 张原图、5 个普通附件、10/10 引用附件及认证、组织、回收站、AI 状态全部一致。
- 正式升级前生成 OSS snapshot `4397f018`，随后从 `v1.0.1` 切换到 `v1.0.2`；公网健康检查返回 200，四个容器均在运行且重启计数为 0，API、AI worker、PostgreSQL 的容器健康检查均通过，gateway 按部署定义未配置 Docker healthcheck。升级后日志未发现 panic、fatal、uncaught、unhandled 或 error 标记。
- 外置 Nginx 配置校验与 reload 均通过，Provider 测试链路允许最长 65 秒读取等待；TLS 证书未在本次补丁中变更。

### v1.0.1

- 修复认证中间件的 PostgreSQL 时间参数类型推断错误；刷新失败仍不强制登出，但现在会写入净化后的结构化错误日志。
- 新增真实 PostgreSQL 回归：把会话活跃时间回拨 10 分钟后访问受保护接口，确认数据库中的 `last_seen_at` 被刷新。
- `make api-test`、`make m1-integration-test`、`make web-test`、`make worker-test`、`make m5-deployment-contract-test` 和完整 `make m5-recovery-test` 均通过；恢复测试验证 10/10 附件及认证、组织、AI 状态。
- 京东云使用正式 OSS snapshot `73140537` 在隔离目录、隔离 Compose 项目和隔离边缘网络完成 `v1.0.1` 空目录恢复；API、AI worker、gateway、PostgreSQL 均健康，验收后含正式数据副本的临时目录、容器和网络已删除。
- 正式升级前生成 snapshot `2885bcef`，随后从 `v1.0-baseline` 切换到 `v1.0.1`。公网健康检查返回 200，四个容器重启计数均为 0，升级后日志未发现会话刷新、panic、fatal 或 error 标记。
- Ubuntu 每日软件源刷新和 unattended security upgrade 已恢复并执行；安全更新队列为空。新内核 `6.8.0-138` 已安装，当前仍运行 `6.8.0-136`，待单独维护窗口重启，不在本次发布中自动重启正式机。

## 1. 发布门禁结论

| 门禁 | 状态 | 证据与限制 |
|---|---|---|
| 原始数据与附件 | 通过 | 迁移、原始记录不可变、原字节下载、MIME、SHA-256、损坏检测、孤儿只报告、不可写目录与真实 ENOSPC 原子失败均通过 |
| 认证与安全会话 | 通过 | Argon2id、TOTP、恢复码、可信设备、会话轮换/撤销、CSRF、Origin、PAT scope 与凭据密文/哈希测试通过；v1.0.1 增加真实 PostgreSQL 会话活跃时间刷新回归；正式所有者已绑定 TOTP 并离线保存恢复码 |
| 搜索与隐私脱敏 | 通过 | 字面/模糊搜索、固定排序和游标、敏感遮挡、`no-store`、URL/浏览器持久存储/日志边界通过 |
| AI 策略与版本 | 通过 | 三协议本地 mock、`block`/`redact`/`allow`、受控工具、重试上限、取消/超时、Artifact Schema 与版本动作通过；v1.0.2 验证 Provider 连接测试 60 秒 deadline |
| 备份与灾难恢复 | 通过 | v1.0.2 隔离生产形态空机恢复、京东云 OSS 加密 snapshot、`restic check`、10/10 引用附件及认证/组织/AI 状态回读均通过；每日单实例调度已启用 |
| 浏览器与可访问性 | 通过 | Chrome 与 Safari 已在正式 HTTPS 上完成核心 E2E；响应式、主题、键盘、reduced motion 与 VoiceOver 基础人工抽查通过 |
| 目标主机性能 | 通过 | 京东云正式硬件上的完整固定规模测试通过：搜索 P95 335.915 ms，纯文本保存 P95 4.692 ms |
| 生产部署与依赖 | 通过 | v1.0.2 已完成隔离恢复、升级前快照和正式切换；四容器运行且零重启，已有三项容器健康检查与公网就绪检查均通过，外置 Nginx 65 秒读取等待、零应用宿主机端口、安全头、登录限速、Fail2ban、Secret、日志、漏洞与许可证门禁通过；Ubuntu 安全更新已恢复自动执行 |

任何阻塞项存在时，都不得把 M5、发布候选或一期 Definition of Done 标为完成。

## 2. 自动化与契约证据

已验收候选上已经完成：

- `make test`：Web 25 项、AI worker 118 项及全部 Go 单元/契约测试通过。
- `make m1-integration-test` 至 `make m5-integration-test`：认证录入、检索资料库、Provider/PAT、AI 任务、迁移/运维/故障注入均通过；Provider 只使用本地 mock。
- `make build`：Web、worker 和四服务镜像构建通过。
- 共享数据库/API/Artifact 契约的生产者、消费者和从 Schema 5 到 6、空库到 6 的迁移路径通过。
- M5 存储故障覆盖不可写临时目录和隔离 1 MiB tmpfs 的真实 `ENOSPC`；两者都返回稳定错误且不产生半条记录或遗留上传临时文件。
- API 数据库故障返回固定 503 `INTERNAL_ERROR`，不泄漏 PostgreSQL、迁移、表名或堆栈；worker/Provider 故障不改变核心 readiness。
- 运行日志检查未发现正文、Cookie、Authorization、Provider Key、TOTP 或恢复码。

## 3. 目标主机性能实测

报告：京东云 `/home/toolbox/deploy/data/operations/performance-report.json`，`passed: true`，生成于 `2026-08-30T06:53:38Z`，不含用户内容。

环境为 Intel Xeon Gold 6267C、16,765,816,832 bytes 内存、amd64、Go 1.27.0、PostgreSQL 18.6。数据为 50,000 条知识记录、50,000 条原始记录、500,000 个搜索片段和 1,024 个可重复生成的 20 MiB 全零稀疏附件；附件 apparent size 为 20 GiB，allocated bytes 为 0。

| 指标 | P50 | P95 | 门槛/说明 |
|---|---:|---:|---|
| 关键词搜索第一页 | 302.150 ms | 335.915 ms | P95 ≤ 500 ms，通过 |
| 纯文本保存 | 3.790 ms | 4.692 ms | P95 ≤ 300 ms，通过 |
| 最近记录固定视图 | 1,977.034 ms | 2,039.306 ms | 记录项，不设伪 SLA |
| 记录详情 | 1.778 ms | 2.197 ms | 记录项 |
| 附件元数据 | 0.627 ms | 0.930 ms | 记录项 |

搜索索引完整重建耗时 608.171 秒；数据库峰值 615,315,135 bytes；Web 生产构建 544,689 bytes。正式报告包含全部固定规模数据并实际执行索引重建；跳过重建的诊断运行不会被脚本标为正式通过。

## 4. 备份与空机恢复

隔离恢复演练报告：`deploy/data/operations/recovery-test-report.json`，`state: succeeded`，不含用户内容。

演练在隔离生产 Compose 中构建并运行 gateway、API、AI worker、PostgreSQL，生成加密 restic snapshot，先验证备份失败会恢复 API/worker 并写稳定失败状态，再从选定 snapshot 恢复到新的空目录和空数据库。结果包括：

- 随机验收 20 条文本、5 张原图、5 个普通附件，附件原字节一致。
- 数据库引用附件 10/10 通过存在、大小和 SHA-256 校验；孤儿 0。
- 密码、TOTP、可信设备撤销状态、恢复码、目录、标签、回收站和 AI 版本恢复正确。
- 容器重启后状态保持；停止 worker 不影响 API readiness；停止数据库时响应已净化。
- 恢复报告记录 snapshot、环境、耗时和失败点字段，不含正文。
- 内部 CA 只用于恢复流程连通性演练；正式域名 HTTPS 已由单独门禁验证。

正式仓库现位于京东云 OSS `cn-north-1` 的私有 Bucket/prefix，使用公网 Endpoint 和 DNS-style `Bucket.Endpoint` 请求。轻量云主机与 OSS 内网地址默认不互通，内网 80/443 实测超时；公网 Bucket 域名的 DNS、TLS 和签名访问正常，因此按用户授权切换公网 Endpoint。浏览器不直连 Bucket，CORS 继续留空；公网请求与流量是否收费仍由京东云计费规则和控制台告警约束。

2026-08-30 的正式快照为 `73140537`，包含 PostgreSQL custom dump、原始附件目录和非敏感配置清单。`restic check` 返回无错误；仓库 `raw-data` 为 22,912 bytes，远低于 10,000,000,000 bytes 上限与 1,000,000,000 bytes 安全余量门禁。随后从同一 OSS snapshot 回读到一次性空目录，86,143-byte dump 通过 PostgreSQL 18.6 `pg_restore --list`，清单和附件树有效，明文恢复目录在验证后清理。此前同机 `/home/toolbox-backups/restic` 的两个加密快照保留但不再作为正式目标。

生产机复用现有 cron，按 Asia/Shanghai 每天 03:17 运行受版本控制的备份包装脚本；`flock` 阻止重叠任务，脚本失败会恢复 API/worker、写稳定失败状态并记录系统日志。固定 7 日、4 周、6 月策略已对正式仓库完成 dry-run，未在本次验收中删除任何 snapshot。生产恢复所需的应用主密钥、restic 密码与初始恢复材料另存于本机受限恢复目录，不与 OSS 数据共同保存。

## 5. 安全、依赖与许可证

- 正式域名 `https://toolbox.hxf4869.cn/` 的 HTTP 跳转、受信任证书、HSTS、CSP、`nosniff` 与 Referrer Policy 已通过 `make verify-https`。
- 公网只由既有 Nginx 监听 TCP 80/443；四个应用容器没有宿主机端口映射。登录端点按真实来源 IP 使用 `6r/m`、burst 5 的 429 限速；10 分钟内累计 12 次 401/429 会触发 1 小时临时封禁，重复触发递增且最长 24 小时，不做永久 IP 封禁。
- `pnpm audit --prod --audit-level high`：未发现漏洞。
- `govulncheck`：调用级和 package 级漏洞均为 0。模块图报告 `GO-2026-5932` 涉及未维护的 `golang.org/x/crypto/openpgp`，当前代码未导入、未调用，且没有可用修复；该模块级提示保留在发布复核记录中。
- Node 生产依赖许可证为 MIT、Apache-2.0、BSD、ISC、MPL-2.0、PSF 或 0BSD；Go 第三方依赖为 MIT、Apache 或 BSD。仓库自身使用 MIT License。
- Git 跟踪文件未发现私钥、OpenAI Key、Bearer 凭据或生产 `.env`/Secret；真实凭据只进入已忽略且权限受控的部署目录。
- 生产 Compose 恰有四个长期服务；API/worker 非 root 且只读根文件系统，capabilities 全部移除，不挂载 Docker socket。
- AI worker 的工具集合固定为读取已授权记录上下文、条件读取已授权附件、可选检索相关记录和提交候选 Artifact；未知工具被拒绝，不能执行 Shell、SSH、SQL、浏览器、任意网络/文件系统或代码。

## 6. UX 与浏览器证据

一期浏览器支持范围按用户选择限定为当前 Chrome 与 Safari。Edge、Firefox 不进入发布门禁，不安装、不宣称已验证兼容，也不在代码中主动阻断。

已完成的浏览器与 UI 检查：

- Chrome 在正式 HTTPS 上完成密码、TOTP、快速记录、精确搜索、高亮、详情元数据、按需只读原文、主题切换、系统运维页和键盘快捷键；合成记录曾移入回收站并由用户恢复，目前保留在原始收件箱，未获确认前不再次移动。
- Safari 在正式 HTTPS 上完成密码、TOTP、回收站恢复、收件箱、精确搜索、详情、按需只读原文，以及 `/` 聚焦搜索和 `⌘⇧Enter` 打开快速记录；期间一次导航中断在重载后恢复，服务端与 Nginx 同期请求均为完整 200，未形成稳定缺陷。
- 1366×768、1440×900、1920×1080、1024×768、390×844 无页面级横向溢出；移动设置子导航为有意的局部横向滚动。
- 深色/浅色、720×450 的 200% 等效视口、`prefers-reduced-motion`、Escape 关闭并恢复焦点均通过。
- 跳过链接可见并能把焦点移动到主内容；关键页面没有重复 ID、标题层级跳跃、无标签字段、无名称按钮或缺失 alt 的图片。
- API 停止时登录页显示稳定维护文案，服务恢复后页面可重新读取；浏览器控制台无应用 warning/error。
- VoiceOver 在用户即时确认后临时开启：页面地标、标题、跳到主要内容、搜索、结果、详情及快速记录控件均有可读名称；检查发现快速记录焦点会逃到背景页，修复后验证正向/反向 Tab 都在弹窗内循环，内容格式按钮同时暴露选中状态。VoiceOver 随后关闭，并在系统设置中确认 `off`。

## 7. 正式发布结论与后续运维

一期八项机器可读门禁均为 `passed`，`v1.0.2` 已部署到京东云正式环境，一期文档状态关闭。发布汇总会继续校验固定规模目标主机性能、生产形态空机恢复、正式 HTTPS、部署静态边界和当前异地备份状态；任何证据失效都不得沿用本结论。

后续按默认每日备份、每月 `restic check`、每季度抽样恢复执行。接近容量门禁时先审阅固定保留策略的 dry-run，再由维护者明确执行 `prune-backups.sh --apply`；不自动删除 snapshot，不调用付费模型，不推送远端。

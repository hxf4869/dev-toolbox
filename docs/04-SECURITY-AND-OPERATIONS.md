# 一期安全与运维基线

状态：**已完成并关闭，作为 `v1.0.0` 的冻结安全与运维基线**

适用范围：公网自托管、单所有者、Docker Compose 部署

## 1. 目的与边界

本文规定开发百宝箱一期必须实现的真实安全边界、部署方式、备份与恢复流程。它不是企业安全体系，也不为了理论攻击面引入 WAF、SIEM、密钥管理集群或零信任平台。

一期保护的对象按优先级排序：

1. 原始记录和原始附件不因应用故障、升级或模型处理而丢失。
2. 公网访问不能绕过密码、TOTP 和服务端会话校验。
3. Provider API Key、TOTP 密钥、会话凭据不以明文出现在数据库导出、日志或前端。
4. AI 不能执行记录中的命令，也不能静默把敏感记录发送给外部模型。
5. 备份损坏或主机丢失后，有一条经过演练的恢复路径。

一期不承诺：

- 端到端加密或零知识存储。
- 主机已被 root 权限攻破后的数据保密。
- 恶意文件检测、DLP、WAF、SIEM、硬件密钥或企业合规认证。
- 多人之间的权限隔离。
- 应用在线时的零停机备份或高可用恢复。

## 2. 数据保护模型

### 2.1 必须使用准确术语

- 浏览器到唯一公网边缘（gateway/Caddy，或主机已存在的受控 Nginx）使用 HTTPS/TLS，防止传输链路被窃听或篡改。
- Caddy 到 API 位于同一 Docker 内部网络，一期允许使用 HTTP；该端口不得映射到宿主机公网。
- 原始正文和附件按用户决定以明文保存在受控数据库/数据卷中，使其能被 PostgreSQL 搜索，也便于脱离应用恢复。
- 因为服务端能够读取原文，所以产品文案、README 和设置页都不得称为“端到端加密”。
- 备份仓库必须由 restic 加密；备份密码与备份数据分开保存。

### 2.2 数据分类与存储方式

| 数据 | 主存储 | 静态保护 | 可进入日志 |
|---|---|---|---|
| 登录密码 | PostgreSQL | Argon2id 哈希，不能解密 | 否 |
| 恢复码 | PostgreSQL | 每个恢复码独立哈希 | 否 |
| 会话、可信设备、PAT | PostgreSQL | 只保存随机令牌哈希 | 否 |
| TOTP 密钥 | PostgreSQL | 应用层 AES-256-GCM 加密 | 否 |
| Provider API Key | PostgreSQL | 应用层 AES-256-GCM 加密 | 否 |
| 原始文本 | PostgreSQL | 明文、宿主机访问控制、加密备份 | 正文不得记录 |
| 原始附件 | 映射数据卷 | 原始字节、宿主机访问控制、加密备份 | 内容不得记录 |
| AI 请求/响应 | 任务与派生表 | 按敏感策略最小化持久化 | 全文不得记录 |
| 搜索片段 | PostgreSQL | 与原始内容相同的访问边界 | 正文不得记录 |

不额外加密原始正文或搜索片段。为它们增加字段级加密会破坏一期的 PostgreSQL 搜索能力，也会制造另一套索引密钥与迁移机制，不符合已确认需求。

### 2.3 应用主密钥

- 部署时生成 32 字节随机主密钥，通过 Docker Secret 或仅宿主机管理员可读的环境文件注入。
- 主密钥不得写入数据库、镜像、仓库、Compose 默认值或日志。
- AES-256-GCM 每次加密使用新的随机 nonce；数据库保存 `key_version`、nonce 和密文。
- 一期只需要一个活动密钥版本，不建设在线轮换控制台。确需轮换时新增受测的离线管理命令，并先更新本文。
- 丢失主密钥不会影响原始正文和附件，但会导致 Provider Key 与 TOTP 密钥无法恢复。主密钥必须纳入独立的离线恢复材料。

## 3. 登录、MFA 与会话

### 3.1 所有者初始化

- 实例没有所有者时，Web 也不开放注册入口。
- 所有者通过容器内一次性初始化命令创建；命令从交互式标准输入或 Secret 读取密码，不接受明文命令行参数。
- 初始化事务必须保证所有者只能创建一次；重复执行返回明确状态，不覆盖现有账号。
- 初始化只创建密码凭据；首次密码登录必须在 5 分钟挑战内绑定并确认 TOTP，完成前不签发普通会话。
- 初始化成功后不保留初始化 Token 或临时口令。

### 3.2 密码存储

- 使用 Argon2id，唯一随机盐由成熟库生成并编码在哈希结果中。
- 一期默认下限采用 `m=19456 KiB, t=2, p=1`；部署验收时在目标主机上测量，并可向上调整到单次校验约 200–500 ms，但不得低于该下限。
- 只限制合理的请求体大小，不因为 Argon2 实现截断而把密码限制到 72 字节；规范化规则固定为按 UTF-8 原样处理，不自动去空格或改变大小写。
- 不另加自研 SHA、可逆加密或“二次哈希”。
- 参数记录在哈希编码中；用户成功登录时可以在参数落后于当前配置后重算哈希。

依据：[RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html) 推荐 Argon2id，并给出受限内存场景参数；一期下限采用 [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) 当前基线，以兼顾个人部署资源。

### 3.3 TOTP

- 实现 RFC 6238，默认 30 秒时间步、6 位验证码，兼容主流 Authenticator。
- 验证窗口只接受当前时间步及前后各一个时间步，服务器必须启用可靠的时间同步。
- 同一验证码在同一登录挑战中成功使用后，挑战立即失效。
- 首次配置只有在密码已验证的限时挑战中输入有效验证码后才启用 TOTP并生成普通会话。
- 同一未过期、未消费的 enroll challenge 重复调用 setup 时返回同一个 pending secret；不能重新生成导致先前二维码和手动密钥失效。
- 二维码只在当前已认证页面短时展示；页面不得从第三方加载二维码服务。
- 一期不允许关闭 TOTP。重置必须重新验证密码与现有 TOTP/恢复码；新 secret 确认后撤销全部旧会话、可信设备和恢复码。

上述时间步和有限延迟窗口遵循 [RFC 6238](https://www.rfc-editor.org/info/rfc6238/)；不得为了“更方便”扩大为多个分钟窗口。

### 3.4 恢复码

- 初次启用 TOTP 时生成 10 个高熵一次性恢复码。
- 明文只展示和下载一次；服务端仅保存独立哈希及使用时间。
- 使用一个恢复码后在同一事务中将其标记为已用并完成登录，重复提交必须失败。
- 重新生成恢复码会使旧恢复码全部失效。
- 一期没有邮箱、短信、客服或安全问题找回。密码、TOTP 和恢复码同时丢失时，只能通过部署主机的受控管理命令重置。

部署主机恢复命令固定为交互式 `dev-toolbox admin reset-auth` 语义：要求直接容器/宿主机管理权限，从标准输入读取并确认新密码；清除 TOTP secret 和恢复码，撤销全部会话/可信设备，写安全事件，使下一次密码登录强制重新绑定 TOTP。它不读取、导出或修改任何知识记录，也不接受远程 Web 调用。

### 3.5 普通会话与可信设备

普通会话和可信设备是两个不同凭据：

- 普通会话表示“当前已登录”，绝对有效期 7 天，连续 24 小时无活动则过期。
- 可信设备只表示“密码正确后 90 天内可跳过 TOTP”，不能独立登录，也不能替代密码。
- 两类令牌都使用至少 256 bit 的安全随机值；浏览器保存明文，服务端只保存哈希。
- Cookie 使用 `__Host-` 前缀、`Secure`、`HttpOnly`、`SameSite=Strict`、`Path=/`，不设置 `Domain`。
- 登录成功、修改密码、重置 TOTP 时轮换会话 ID，避免会话固定。
- 用户可以看到设备显示名、创建时间、最近使用和到期时间，但不以 IP 或 User-Agent 作为强绑定条件，以免正常网络和浏览器升级导致误锁。
- 修改密码、重置 TOTP、执行“退出全部设备”时撤销全部会话和可信设备。

Cookie 约束参考 [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。前端不得把会话、可信设备令牌或 PAT 放入 `localStorage`、`sessionStorage` 或 IndexedDB。

### 3.6 CSRF、登录限流与错误信息

- Cookie 会话下，所有改变状态的请求必须同时通过 `Origin` 校验和会话绑定的 CSRF Token 校验。
- CSRF Token 由会话引导接口返回，前端通过自定义 Header 发送；PAT Bearer 请求不使用 Cookie，也不要求 CSRF Token。
- 登录、TOTP 和恢复码接口使用 API 进程内的有界限流：按来源 IP 与账号标识分别限制，连续失败采用短暂递增等待。
- 一期单 API 实例下不引入 Redis。进程重启会清空短期限流状态，这是已接受的简化；安全事件仍写数据库。
- 外置 Nginx 对 `POST /api/v1/auth/login` 使用独立的每 IP 漏桶：`6r/m`、短突发 5 次，超额统一返回 429。该层在 Argon2id 计算前拒绝洪泛请求，并只使用被 Nginx 重写后的连接来源 IP。
- 主机已有 Fail2ban 时加载仓库的 `dev-toolbox-auth` filter/jail：同一 IP 在 10 分钟内累计 12 次登录 401/429 后临时封禁 1 小时；重复触发按 2 倍递增，最长 24 小时。不得设置永久 IP 封禁，避免共享出口、移动网络和动态 IP 造成不可恢复的误伤。
- 对外统一返回“凭据无效或已过期”等稳定错误，不区分用户名、密码、TOTP、恢复码哪一项错误。
- 日志不得记录用户输入的账号密码、验证码、恢复码或完整 IP。数据库中的会话与安全事件可以保存按可信代理规则解析的精确 IP，默认最多保留 90 天，供所有者排查登录；IP 不作为设备身份或授权条件。

## 4. 公共 API 与外部 Agent

### 4.1 浏览器 API

- 仅一个 TLS 边缘的 TCP 80/443 对公网开放；HTTP 只用于跳转 HTTPS 和证书签发。Caddy 直连模式可另用 UDP 443 提供 HTTP/3，外置 Nginx 模式不要求 UDP 443。
- Caddy 直连模式根据正式域名自动申请和续期证书；外置 Nginx 模式必须复用主机已有、已验证的证书与续期流程。官方行为见 [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)。
- API 对写请求设置 JSON 请求体上限；附件使用专门的流式上传上限。
- CORS 默认不开放跨域来源。一期 Web 与 API 同源部署。
- 返回统一安全响应头：HSTS、`X-Content-Type-Options: nosniff`、限制性的 CSP 和 `Referrer-Policy: no-referrer`。
- 原始搜索词只通过 `POST /api/v1/search` 的 JSON body 发送，不进入 URL、浏览器历史、`localStorage`、`sessionStorage` 或 IndexedDB。非敏感的视图、过滤器和排序可以进入 URL。
- 搜索、原始正文、Artifact、附件内容与元数据、session bootstrap、TOTP provisioning 和恢复码响应使用 `Cache-Control: no-store`。搜索框设置 `autocomplete="off"`、`autocapitalize="off"`、`spellcheck="false"`，但不能把这些浏览器提示当作唯一防护。
- Caddy 默认访问日志只记录方法、不含查询串的请求路径、状态、耗时和请求 ID；API 日志使用路由模板而不是原始 URI。两者都不记录请求正文、响应正文或搜索词，调试、Tracing 和错误上报同样遵守这一边界。

可信代理规则：

- Caddy 直连时覆盖客户端自带的 `X-Forwarded-For`、`X-Real-IP` 和 `Forwarded`。外置 Nginx 必须先把 `X-Forwarded-For`/`X-Real-IP` 重写为连接的真实来源地址，Caddy 只信任配置的私有代理网段并按严格的右到左规则解析，不能把客户端伪造链原样透传。
- API 只有在直接连接来自 Compose 内 gateway 的受信任地址时才读取转发头；其他来源使用连接的 `RemoteAddr`。
- 登录限流、会话记录和 security event 共用同一个客户端 IP 解析函数；不做 IP 白名单、地理定位、设备指纹或复杂代理链分析。
- IP 限速和临时封禁只是一层纵深防御，不能替代账号维度限流、强随机密码和必需的 TOTP；分布式来源可能绕过单 IP 阈值，因此应用账号维度等待始终保留。

初始 CSP：

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:;
font-src 'self';
connect-src 'self';
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
form-action 'self'
```

`style-src` 的 inline 只用于 Vue/Reka 的受控定位与主题 style 属性；模型 HTML 永远不进入 DOM，脚本策略仍不允许 inline。后续修改 CSP 必须说明具体资源消费者；不得加入 `unsafe-eval`、inline script、任意域名或通配符。

### 4.2 PAT

- PAT 明文只在创建响应中展示一次，数据库只保存带固定前缀标识的令牌哈希。
- 每个 PAT 明确名称、scope、创建时间、可选到期时间和最后使用时间。
- `sensitive:read` 独立且默认关闭；没有它的 PAT 不能读取敏感/未知原文或附件，也不能提交其派生结果。
- 服务端逐请求校验 scope，不把“已登录所有者”隐式等同于所有 PAT scope。
- PAT 不出现在 URL、查询参数、浏览器本地存储或访问日志中。
- 撤销立即生效；一期不实现 PAT 自动轮换、OAuth 或第三方应用授权页。

### 4.3 内部 worker API

- AI worker 与 API 只通过内部 Docker 网络通信，路由不由 Caddy 转发。
- 使用部署 Secret 中的固定内部服务凭据进行请求认证；凭据只解决容器间误访问，不伪装成完整服务网格身份系统。
- worker 只能调用 `03-API-AND-AI-CONTRACTS.md` 定义的任务领取、上下文读取、事件上报和结果提交接口。
- 公共连接测试请求只接受 API 已保存的 Provider/model 配置 ID；API 解析并校验后，只能调用 worker 的单用途 `provider-test` RPC，传递固定配置快照。worker 不提供通用代理、任意 URL 或任意模型请求接口，并独立复核出站边界。
- API 再次校验任务归属、状态和 artifact Schema；不能相信“请求来自内部网络”就跳过校验。

## 5. 原始内容、附件与渲染

### 5.1 原始记录

- 原始 Markdown 作为文本保存；前端展示必须使用禁用原始 HTML 的 Markdown 渲染器或先经过允许列表净化。
- 代码块只作为文本渲染和复制，不能生成可点击执行按钮。
- URL 默认按普通文本显示；若提供打开链接动作，必须清楚显示目标并只允许 `http`/`https`。
- UI 中“复制”只能写剪贴板，不能调用终端、SSH、系统命令或自定义协议。

### 5.2 上传

- 单文件最大 20 MiB、单次附件实际总字节最大 100 MiB；Caddy 的 multipart 请求上限必须为边界和有界 metadata 预留协议开销，不能直接等于 100 MiB。API 以实际流式文件字节计数为最终业务判定。
- 上传先写同一附件卷中的随机临时名；完成大小校验后，在创建附件的数据库事务提交前原子移动到正式路径，移动失败则回滚事务。
- 永远不使用用户文件名作为磁盘路径。客户端报告的 base name 作为有界原始元数据保留；另生成去除控制字符、路径分隔和 Header 语义的 `display_name` 用于 UI 与 `Content-Disposition`。
- 不按扩展名信任 MIME；分别记录浏览器声明值和服务端嗅探值，kind、预览、视觉任务和响应 `Content-Type` 只使用服务端值，未知或多义文件按普通附件处理。
- 在上传流中同步计算 SHA-256 并保存；它只用于完整性检查和恢复时逐项校验，不用于去重、秒传、内容寻址或存储路径。
- 文件没有可执行权限，附件卷不挂载到 Web 静态目录，也不挂载给 AI worker。
- 普通文件统一使用 `Content-Disposition: attachment` 下载，并返回 `nosniff`。
- 只允许确认可安全解码的 JPEG、PNG、WebP、GIF 在受控图片组件中内联预览；SVG、HTML、PDF 和未知类型一期按下载处理。
- 图片在解码前检查尺寸；超过 16,384 px 单边或 40 MP 时保留原始字节但禁用服务端缩略图、内联预览和视觉任务，避免压缩图片耗尽内存。用户可另建补充记录上传缩小副本。
- 一期明确不做病毒扫描。界面提示“文件由你上传，下载后由本机安全策略负责”。

### 5.3 敏感显示

- “敏感/非敏感”是用户必填决策，“未知”只用于迁移或系统导入。
- 默认敏感记录列表摘要遮挡，进入详情后需要一次明确揭示；同一页面会话内可保持揭示状态，但刷新后恢复遮挡。
- 未揭示前不请求完整敏感正文，或至少不把正文挂载到 DOM；未揭示内容不可通过隐藏 DOM、ARIA 文本、页面源码或复制快捷键泄漏。
- 敏感记录仍进入本地 PostgreSQL 搜索，这是产品需求；结果摘要遮挡不等于索引加密。
- 不实现字段级密码识别或保险库条目结构。包含密码的 Docker 命令仍是一条普通敏感原始记录。

## 6. 外部 AI 的数据边界

### 6.1 策略执行位置

- `block`、`redact`、`allow` 在 API 生成任务上下文时执行，不能只靠 Prompt 要求模型忽略敏感数据。
- worker 获取的是已经按策略处理的上下文，并同时得到策略枚举值，不拥有绕过策略读取原文的通用工具。
- `search_related_records` 的结果也先经过同一策略：block 排除敏感/未知候选，redact 返回脱敏副本，allow 仍受任务授权数量限制。
- `redact` 仅使用本地确定性规则；API 在 claim 上下文构建时处理外发文本，并在 worker complete 的最终 Artifact 入库边界再次递归处理全部字符串值。替换内容使用类型化占位符，例如 `<TOKEN_1>`、`<INTERNAL_IP_2>`。凭据键同时识别普通名称和以 `_`/`-` 分段的环境变量名称，例如 `password`、`DB_PASSWORD`、`KAFKA_MANAGER_USERNAME` 与 `APPLICATION_SECRET`。
- 二进制图片无法在没有 OCR/打码模型的前提下可靠 redact；敏感/未知图片在 redact 策略下不外发，必须改为用户明确允许或把记录标为 normal。
- 一次任务的映射只存在于内存，任务结束即释放，不持久化到 artifact、事件或日志。
- 当规则不确定时宁可保留并提示风险，不能声称完成可靠脱敏。

### 6.2 最小发送

- 默认只发送当前任务需要的原始片段、用户选择的附件和最多 10 条相关记录摘要。
- `analyze_image` 只有所选模型声明支持图片并且敏感策略允许时才发送原图。
- 普通文件正文一期不发送给模型。
- Provider 请求日志只记录 provider ID、model ID、`operationType=task|connection_test`、请求 ID、可空 task ID、状态、token 用量和耗时；不记录 URL 中可能含凭据的查询参数、请求正文或完整响应。
- Provider Base URL 默认必须为 HTTPS，请求拒绝重定向；只有部署者显式开启不安全 HTTP 后才能连接用户指定的内网网关，界面持续提示传输风险。
- 模型返回的任何命令都视为不可信文本，必须经 Schema 和业务校验后作为候选 artifact 保存。

### 6.3 错误与重试

- 鉴权失败、配额不足、能力不匹配、Schema 错误和普通 4xx 不自动重试，也不切换到其他 Provider。
- 只有网络连接中断/超时、HTTP 408、429、500、502、503、504 可以在同一 task run 内最多自动重试 2 次，并使用短指数退避。存在 `Retry-After` 时可以遵循，但不能突破 task deadline。
- Provider 连接测试不属于 task run；公共 API 只调用一次内部 worker RPC，worker 只发起一次外部请求且不自动重试。Key 不持久化到 task/event，只在 API 与 worker 的本次调用内存中短暂存在。
- Provider 网络重试保持同一个 task row 和任务输入；用户点击“重试”则创建新的 task row 并通过 `retry_of_task_id` 关联旧任务。两者都不能产生重复 Artifact 版本。
- 不建设多模型投票、自动兜底链、无限循环或“自愈”任务。

## 7. Docker Compose 部署基线

### 7.1 运行拓扑

一期只运行四个长期容器：

| 服务 | 公网端口 | 数据卷 | 说明 |
|---|---:|---|---|
| `gateway` | 默认 `80`, `443`；外置 Nginx 模式无映射 | Caddy 状态 | TLS 或受控边缘后的静态 Web、反向代理 |
| `api` | 无 | 附件卷 | Go API、附件读写与任务调度 |
| `ai-worker` | 无 | 无原始附件卷 | Node/TS AI 任务执行 |
| `postgres` | 无 | PostgreSQL 数据卷 | 唯一业务数据库和任务状态源 |

不增加 Redis、消息队列、MinIO、搜索服务、定时器服务或备份常驻容器。定期整理由 API 的单实例调度器按数据库唯一 schedule key 写任务表，每次最多 20 条；备份由宿主机计划任务调用受版本控制的脚本。

主机已有 Nginx 时不把它计为本应用新增的第五个服务。`compose.production.external-nginx.yaml` 会移除 gateway 的全部宿主机端口，只把它以固定别名加入 Nginx 已在使用的外部 Docker 网络；Nginx 仍是宿主机唯一的 80/443 监听者。部署检查必须同时验证 Compose 合并结果与外部网络存在。

### 7.2 目录映射

生产部署目录建议固定为：

```text
dev-toolbox-deploy/
├── compose.yaml
├── .env                 # 0600，不进入仓库
├── secrets/             # 0700，主密钥/数据库/备份 Secret
├── config/
│   └── Caddyfile
├── data/
│   ├── postgres/
│   ├── attachments/
│   └── caddy/
└── backup-staging/      # 临时数据库导出，可清理
```

- `data/postgres`、`data/attachments` 和 `data/caddy` 使用明确的宿主机路径，方便迁移；不能写进容器可写层。
- `config` 只读挂载；`secrets` 仅挂载给真正需要的容器。
- 不挂载 Docker Socket、宿主机根目录、用户主目录或 SSH 目录。
- API 与 worker 以非 root 用户运行；附件目录只授予 API 所需权限。
- 数据库只监听内部网络，Compose 不声明宿主机 `ports`。

### 7.3 配置与日志

- 仓库提供 `.env.example`，只含键名和安全说明，不含默认生产密码。
- 启动时校验必需配置；缺少主密钥、数据库密码或正式域名时快速失败，不生成弱默认值。
- 日志输出到 stdout/stderr，由 Docker 日志轮转限制大小和保留数量。
- `GET /health/live` 只表示进程存活；`GET /health/ready` 校验数据库和必要迁移。公网只需代理简单的总体健康状态，不暴露版本、表名、Provider 或错误堆栈。
- API readiness 不依赖 AI worker 或外部 Provider；它们故障时在设置页显示 degraded 状态，但录入、搜索、浏览和下载仍应可用。
- worker 健康状态由任务心跳写数据库并在设置页只读显示，不额外开放公网端口。

## 8. 备份、保留与恢复

### 8.1 恢复目标

- RPO：默认每日一次成功备份，最多丢失上一次成功备份后的数据。
- RTO：个人维护场景目标为 2 小时内在已准备的新主机完成手工恢复；不承诺自动故障切换。
- “任务显示成功”不算备份成功；必须同时有 PostgreSQL dump、原始附件、必要配置清单和可读取的 restic snapshot。

### 8.2 一期一致性方案

一期选择简单、可验证的静默备份窗口：

1. Caddy 保持运行；停止 `api` 和 `ai-worker`，确保没有新写入和永久删除。Caddy 对暂时不可用的 API 返回固定 503 维护响应，不需要应用内维护状态机。
2. 保持 PostgreSQL 运行，使用同版本或更新兼容版本的 `pg_dump --format=custom` 导出单库。
3. 把数据库 dump、`data/attachments`、必要的非密钥配置清单一起写入 restic 仓库。
4. 使用 `restic snapshots` 确认新 snapshot 存在后，恢复 API 与 worker。
5. 删除本机 `backup-staging` 中的明文数据库 dump。

这会产生短暂停写/不可用窗口，但不需要文件系统快照、WAL 归档或分布式一致性机制。`pg_dump` 是 PostgreSQL 官方逻辑导出工具，参见 [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)。

备份脚本必须使用退出钩子：任一步失败都恢复服务并返回非零状态；不得在失败时误删上一份成功备份。

### 8.3 备份位置与保留

- restic 仓库必须位于主机故障不会同时丢失的位置，例如另一台家用设备、对象存储或另一服务器。
- 对象存储使用 restic 原生 S3 后端，不在生产主机增加 FUSE 挂载或常驻同步服务；Endpoint 必须为 HTTPS，Bucket 保持私有，并使用 `Bucket.Endpoint` 的 DNS-style 请求。`RESTIC_REPOSITORY` 仍按 restic 约定写为 `s3:https://Endpoint/Bucket/prefix`；浏览器不直连，因此不配置 CORS。
- S3 凭据使用专用最小权限身份，并单独保存在 `0600` Secret 文件中；文件只允许 `AWS_ACCESS_KEY_ID` 与 `AWS_SECRET_ACCESS_KEY`，不得进入 Git、备份内容或命令参数。
- 有免费容量上限时配置十进制字节上限和安全余量。备份脚本在停服前、实际上传前及上传后检查 restic `raw-data`，预计超过门禁时失败并恢复服务，不自动删除已有 snapshot。Bucket/prefix 必须专用于该仓库且关闭会保留旧对象的版本控制，否则脚本无法对账号总计费量作硬保证。
- 生产机复用宿主机既有 cron，在 Asia/Shanghai 每天 03:17 调用 `deploy/scripts/run-scheduled-backup.sh`。包装脚本使用 `/run/lock/dev-toolbox-backup.lock` 拒绝重叠执行，并把输出写入系统日志；它不引入新的常驻服务。
- restic 密码不得只保存在被备份主机；至少一份放在离线密码管理器或纸质恢复材料中。
- 默认保留策略：最近 7 个日备、4 个周备、6 个月备。
- 清理先运行 `forget --dry-run` 验证，再按固定脚本执行 `forget --prune`；每月运行 `restic check`。
- restic 的 `forget`/`prune` 和 `--keep-*` 行为以[官方保留策略文档](https://restic.readthedocs.io/en/stable/060_forget.html)为准，不自行实现快照删除器。
- 一期不建设 Web 备份管理页面；设置页只显示最后一次成功时间、目标标识和最近错误摘要，不显示密码或完整目标 URL。

### 8.4 必须备份与不得备份

必须备份：

- PostgreSQL custom-format dump。
- 原始附件目录。
- Compose/Caddy 的非敏感配置副本或版本号清单。
- 应用主密钥和 restic 密码的独立离线副本；它们不与 restic 数据打包在一起。

可以重建、不要求备份：

- 图片缩略图等可删除派生文件。
- 容器镜像、Node/Go 构建缓存和日志。
- `backup-staging` 中旧的临时 dump。

### 8.5 空机恢复流程

1. 在干净主机安装兼容 Docker 运行时，准备正式域名和端口。
2. 恢复 Compose、Caddy 配置、应用主密钥与数据库 Secret。
3. 从选定 restic snapshot 恢复数据库 dump 和附件目录到新的数据路径。
4. 先启动 PostgreSQL，创建空库并用 `pg_restore` 恢复；恢复工具版本不得早于 dump 的服务端主版本。
5. 运行只读迁移预检，确认当前应用镜像兼容，再执行必要迁移。
6. 启动 API；逐一校验数据库引用的每个原始附件是否存在、实际大小及 `content_sha256`，并报告孤儿文件，不自动删除。任一被引用附件缺失、大小或摘要不匹配都会使本次恢复验收失败并阻止进入下一步；保留现场，由所有者改用已验证 snapshot 重新恢复或明确排查修正。
7. 启动 worker 和 gateway；若使用外置 Nginx，验证其配置后再切换反向代理。验证登录、TOTP、搜索、随机原文、图片下载和一次无费用 mock AI 任务。
8. 记录恢复日期、snapshot ID、耗时和发现的问题；恢复演练不得使用唯一一份生产备份作为可写仓库。

上线门禁要求至少完成一次空机恢复。之后每季度抽样恢复一次，或在数据库大迁移、备份脚本变更后立即重做。

## 9. 升级、迁移与回滚

### 9.1 版本固定

- Compose 使用明确镜像版本或不可变 digest，不使用生产 `latest`。
- Go、Node、PostgreSQL、Caddy 和关键 AI SDK 的大版本升级作为独立变更处理。
- 生产依赖升级必须有实际安全、兼容或功能理由，不做无人维护的自动合并发布。

### 9.2 升级顺序

1. 阅读目标版本迁移说明并确认数据库兼容范围。
2. 完成一次成功备份并验证 snapshot 可读取。
3. 在恢复副本上运行迁移和最小验收。
4. 生产进入维护模式，运行向前迁移，再启动新镜像。
5. 验证登录、录入、搜索、附件与任务状态后退出维护。

数据库迁移默认只向前。若迁移会删除列、重写原始记录或改变不可逆格式，必须拆成“先扩展、应用兼容、后清理”的单独版本，并取得用户确认；一期 Agent 不得自行执行破坏性清理。

### 9.3 回滚

- 没有数据库变更时可以回滚到上一镜像。
- 只有向后兼容的扩展迁移可以在保留新结构的情况下回滚应用。
- 破坏性迁移后不假装支持一键回滚；使用升级前 snapshot 恢复整个数据库与附件集合。
- 回滚决定和实际恢复结果必须记录在本地运维日志中，但不得包含敏感正文。

## 10. 最小监控与故障处理

一期只需要可行动的信息：

- Caddy/API/worker/PostgreSQL 容器状态和重启次数。
- API 请求错误率与 P95 耗时，不按原始内容打标签。
- 数据库连接失败、磁盘剩余空间和附件写失败。
- AI 任务排队数、最长等待时间、失败类型与最近 worker 心跳。
- 最后成功备份时间、最近 restic check 时间。

默认用结构化日志、Docker 状态和设置页只读状态完成；不引入 Prometheus/Grafana/Loki。连续故障需要趋势时再把这些作为二期运维增强评估。

故障处理顺序：

1. 先阻止继续丢数据：磁盘满或数据库异常时切换只读/维护状态。
2. 记录请求 ID、容器版本和稳定错误码，不复制用户正文到 Issue。
3. 对数据库、附件和备份做只读检查。
4. 只有确认恢复点后再执行迁移、清理或永久删除。

## 11. 安全验收清单

以下全部通过才允许公网使用：

`v1.0.0` 正式发布证据见 `08-V1-ACCEPTANCE-REPORT.md`。正式域名与公网边缘、目标主机性能、Chrome/Safari 核心 E2E、VoiceOver 基础抽查，以及异地加密备份与回读均已通过。

- [x] 公网边缘只监听 TCP 80/443；API、worker、PostgreSQL 与 gateway 无宿主机映射端口。
- [x] HTTP 自动跳转 HTTPS，正式证书与既有续期路径已验证。
- [x] 数据库中没有明文登录密码、恢复码、PAT、会话、TOTP 密钥或 Provider Key。
- [x] 浏览器存储中没有会话或 PAT；Cookie 属性符合本文。
- [x] 密码 + TOTP、恢复码、可信设备 90 天、单设备撤销和全撤销均有集成测试。
- [x] CSRF、Origin、未授权 PAT scope 和撤销后的 Token 均被拒绝。
- [x] 敏感搜索词不出现在 URL、浏览器持久化存储、Caddy/API 日志、Tracing 或错误上报中；相关响应带 `Cache-Control: no-store`。
- [x] 客户端伪造转发头不能改变 API 认定的来源 IP；普通日志不记录完整 IP。
- [x] 登录端点每 IP 限速与 Fail2ban 临时递增封禁已在正式 Nginx/主机规则上验证，不使用永久 IP 封禁。
- [x] 20 MiB 边界、路径穿越文件名、SVG/HTML 下载和中断上传均有测试。
- [x] 上传记录客户端/服务端 MIME 与 SHA-256，预览只依据服务端 MIME；恢复后逐一校验所有数据库引用附件，摘要检查能发现字节不一致。
- [x] 原始 Markdown、AI Markdown 和文件名不能产生可执行脚本或未净化 HTML。
- [x] `block` 不发请求，`redact` 只发占位副本，`allow` 有明确确认；日志无正文。
- [x] AI worker 没有 Shell、SSH、SQL、任意 HTTP 或任意文件系统工具。
- [x] Docker Secret、`.env` 和数据目录权限经过部署检查，仓库不含真实凭据。
- [x] 定时备份失败会告警且恢复服务；保留策略先 dry-run。
- [x] 已在隔离恢复演练中从独立 restic snapshot 向空环境恢复数据库、原图和随机抽样记录。
- [x] 正式备份仓库位于京东云 OSS 独立故障域；公网 DNS-style Endpoint 的加密 snapshot、`restic check` 与一次性空目录回读已通过。

## 12. 明确不实现的“安全增强”

除非出现新威胁或用户改变需求，一期不实现：

- 原始记录字段级加密、客户端密钥派生或端到端加密。
- WebAuthn/Passkey、短信、邮箱、硬件令牌、SSO。
- IP 白名单、强制 VPN、设备证书或浏览器指纹绑定。
- WAF 管理、验证码服务、入侵检测、SIEM、企业审计导出。
- 在线 WAL 归档、PITR、同步副本、自动故障切换。
- 附件病毒扫描沙箱或内容净化流水线。
- 自动 Provider Key 轮换、多层 KMS/HSM 或 Vault 集群。

这些项目进入 `BACKLOG.md` 或在真实风险出现时重新评估，不能作为一期“顺手加固”。

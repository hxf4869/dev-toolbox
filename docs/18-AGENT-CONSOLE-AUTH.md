# 18. Agent Console 统一认证集成（阶段 D）

本文说明 dev-toolbox 为 Agent Console（同域 `/agent-console/*`，Rust Relay + Mac Bridge）提供的统一认证后端能力。现有登录、TOTP、可信设备、PAT 与注销语义**零改变**；唯一数据改动是新增一张 ticket 表。

## 端点

### 公开（浏览器，走现有 session 认证）

| 方法与路径 | 行为 |
| --- | --- |
| `POST /api/v1/agent-console/ws-tickets` | 复用 `AuthenticateMutation`（Cookie + Origin + CSRF）。签发 32 字节随机 ticket，Base64URL 明文只返回一次，库中仅存 SHA-256 摘要。响应 `{"ticket","expiresAt","audience":"relay"}`，`Cache-Control: no-store`，有效期 30 秒，单次消费。 |

未登录/过期/已撤销 session 一律被现有中间件以 `AUTH_REQUIRED` 拒绝；Origin/CSRF 失败返回 `FORBIDDEN`（与现有写接口一致）。

### 内部（仅内网，独立服务 Token）

路由组 `POST|GET /internal/agent-console/*`，Caddy 不对外路由该前缀。鉴权使用独立的 `AGENT_CONSOLE_INTERNAL_TOKEN`（与 AI worker 的 `INTERNAL_SERVICE_TOKEN` 分离，Relay 无法据此调用 AI worker 端点），`Authorization: Bearer <token>`，constant-time 比较；未配置 Token 时这些端点返回 `503 SERVICE_UNAVAILABLE`（fail closed）。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /internal/agent-console/ws-tickets/consume` | `{"ticket":"..."}` | `{"valid":true,"authSessionId","ownerId","expiresAt"}`。原子消费（单条 `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING`），并发消费只有一个成功；对应 auth session 已失效时拒绝且 ticket 不复活。 |
| 失败 | — | `{"valid":false,"reason":"CONSUMED\|EXPIRED\|NOT_FOUND\|SESSION_INVALID"}` |
| `POST /internal/agent-console/auth-sessions/introspect` | `{"authSessionId":"..."}` | 按 session ID 检查 revoked、expires、24 小时 idle、`password_changed_at`，**不更新 `last_seen_at`**。有效：`{"valid":true,"ownerId","expiresAt"}`；无效：`{"valid":false,"revokedReason":"REVOKED\|EXPIRED\|IDLE_TIMEOUT\|PASSWORD_CHANGED\|NOT_FOUND"}` |
| `GET /internal/agent-console/auth-sessions/verify`（forward-auth） | 请求头携带浏览器原始 `Cookie`、`Origin`、`X-CSRF-Token` 与 `X-Agent-Console-Method`（原始方法；非 GET/HEAD/OPTIONS 或未知值按写请求处理，要求 Origin+CSRF） | 执行与浏览器接口相同的 session 验证（不含 last_seen touch）。有效：200 + JSON `{"valid":true,"authSessionId","ownerId","expiresAt"}`，并附带 `X-Agent-Console-Session-Id`、`X-Agent-Console-Owner-Id` 身份头；无效：401 `AUTH_REQUIRED`（forward-auth 直接拦截） |

## 内部 Token 配置

- `AGENT_CONSOLE_INTERNAL_TOKEN` 或 `AGENT_CONSOLE_INTERNAL_TOKEN_FILE`（≥32 字符；配置了但不合规会拒绝启动）。允许不配置：仅内部端点 503，其余功能不变，已有部署可直接升级。
- `make init-dev` / `deploy/scripts/init-production.sh` 生成 `agent_console_internal_token` Secret；`check-deploy.sh` 校验其存在与权限（0:20000，0640，与 `internal_service_token` 同组的 API/gateway 共享只读）。

## 数据迁移

`apps/api/migrations/010_agent_console_ws_tickets.sql` 新增 `agent_console_ws_tickets`：`ticket_digest`（bytea，唯一）、`auth_session_id`、`owner_id`（均外键级联）、`audience`、`expires_at`、`created_at`、`consumed_at`。索引：`ticket_digest` 唯一、`expires_at`。明文 ticket 不入库。

## last_seen touch 分离

`authenticateSession` 拆为 `lookupSession`（查询+验证，不写库）与 `touchSession`（原 5 分钟 last_seen 刷新）。全部现有浏览器接口行为不变（仍 touch）；Agent Console 的 introspect 与 verify 均 touch=false。

## 反向代理

公网路由合同(`deploy/Caddyfile` 生效配置;agent-console 仓库
`docs/DEPLOYMENT.md` §3 为同构对照表):

| 公网路径 | 网关鉴权 | 说明 |
| --- | --- | --- |
| `/agent-console/api/*` | `forward_auth` → 内部 verify | 转发浏览器 Cookie/Origin/X-CSRF-Token 与原始方法,`Authorization` 覆写为内部 Bearer;成功后删除客户端提交的内部身份头并 `copy_headers` 注入 verify 返回的身份头,再转发 relay(剥离 Cookie/CSRF/Origin/Authorization) |
| `/agent-console/ws` | 直接转发 | ticket 由 Relay 从 `Sec-WebSocket-Protocol` 消费;剥 Cookie 与伪造身份头 |
| `/agent-console/bridge/ws`、`/agent-console/bridge/pairing/register|claim` | **无 Cookie forward_auth** | Bearer 设备凭据 / pairing challenge 由 Relay 校验;pairing 两端点网关加 4KiB 请求体上限 |
| `/agent-console/transfers/*` | **无 forward_auth**(无浏览器 Cookie) | device credential + 短期 transfer token + 方向/目标设备由 Relay 校验;网关流式不缓冲(`flush_interval -1`) |
| `/agent-console/*` 其余路径 | 无 API 鉴权；前端启动后自行 bootstrap session | 从 `/srv/agent-console` 提供静态产物，任意 SPA 深链回退 `/agent-console/index.html` |
| `/internal/agent-console/*`(含 `/internal/*`) | **公网无路由,一律 404** | 仅网关自身 forward_auth 子请求与内网直连 api 可达 |

- relay 上游用 `AGENT_CONSOLE_RELAY_UPSTREAM`(默认 `agent-console-relay:8081`)。
- `Dockerfile.gateway` 从名为 `agent_console_web` 的构建上下文编译 Agent Console，
  并把产物写入 `/srv/agent-console`；开发 Compose 默认读取同级
  `agent-console` 仓库，`build-release.sh` 也使用该默认值，可用绝对路径环境变量
  `AGENT_CONSOLE_SOURCE_ROOT` 覆盖。该目录不与 dev-toolbox 自身
  `/srv/index.html` 混用。
- `deploy/nginx/external-nginx.conf.template`:`/agent-console/*` 边缘只剥离客户端伪造的内部身份头并透传(含 WebSocket 升级头与子协议),forward-auth 仍由内层 gateway(Caddy)统一执行。
- `deploy/gateway-entrypoint.sh` + `Dockerfile.gateway`:把 `agent_console_internal_token` Secret 注入 Caddy 环境供 forward_auth 使用;Secret 缺失时其余功能照常启动。
- Compose(dev/production)为 relay 保留注释占位:接入时加入 `frontend` 网络、挂载同一 Secret、服务名与 `AGENT_CONSOLE_RELAY_UPSTREAM` 一致;relay 自有 PostgreSQL 不接入本仓库 `backend` 网络。

## 零改变声明

- 现有 `/api/v1/auth/*`、TOTP、可信设备、PAT、注销的请求/响应与有效期逻辑不变；`GET /api/v1/auth/session` 仍按原逻辑 touch last_seen（有回归测试）。
- 不修改登录 UI、知识库、AI worker、Provider、工具模块或既有表结构。

## 测试

`apps/api/integration/agent_console_test.go`（`-tags=integration`，需 `TEST_DATABASE_URL`）覆盖 §29.3：ticket 创建必须 session+Origin+CSRF、明文只出现一次且库中只有摘要、并发消费单一赢家、过期/撤销 session 不能创建与消费、introspection 不触碰 last_seen、logout/logout-all/单 session revoke/密码变更后 invalid、浏览器 session 端点仍 touch、内部 Token 拒绝与未配置 fail-closed、forward-auth verify 的读写校验与 no-touch。

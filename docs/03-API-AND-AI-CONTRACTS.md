# 开发百宝箱一期 API 与 AI 契约

状态：**已确认，受 `00-V1-BASELINE.md` 约束**

## 1. 契约原则

- 公共 API 前缀固定为 `/api/v1`。
- 浏览器使用 Cookie 会话；外部 Agent 使用 Bearer PAT。
- API 返回稳定机器错误码和中文默认消息，前端不能解析自由文本判断业务。
- 原始记录没有覆盖更新接口。
- 所有模型结果先作为不可信输入校验，再保存为候选 artifact。
- 本文定义资源和语义；实现阶段应生成/维护 OpenAPI，但不得让生成文件反向改变本文边界。

## 2. 通用 HTTP 规则

### 2.1 Content-Type

- JSON：`application/json; charset=utf-8`。
- 附件上传：`multipart/form-data`。
- 附件下载：保存的实际 MIME，默认 `Content-Disposition: attachment`。
- AI 任务状态可以使用 JSON 轮询；SSE 仅作为进度优化，不是完成一期的必要前提。
- 公共与内部 HTTP JSON 字段统一使用 camelCase；数据模型文档中的 snake_case 表示数据库列或概念名，不是另一套 API 字段。

### 2.2 时间与 ID

- 所有 ID 为 UUID 字符串。
- 所有时间为 ISO 8601 UTC，例如 `2026-08-29T10:00:00Z`。
- 客户端不根据 ID 推断顺序。
- 公共请求中用于选择已配置模型的 `modelId`、`organizeModelId`、`visionModelId` 等引用字段都是 `provider_models.id` 的内部 UUID；只有创建/编辑模型资源时模型对象内的 `modelId`，以及 worker claim 的 `provider.modelId`，表示发给上游的文本模型 ID。

### 2.3 成功响应

单资源直接返回资源对象，不额外包裹无价值的 `data`：

```json
{
  "id": "0f44e0e7-0bf9-4baa-98f4-456f4e3ea71d",
  "title": "Linux 新磁盘挂载",
  "createdAt": "2026-08-29T10:00:00Z"
}
```

列表响应：

```json
{
  "items": [],
  "nextCursor": null,
  "total": 0
}
```

`total` 只在页面需要显示结果数的查询中返回；普通游标列表可以省略，避免每次昂贵计数。

### 2.4 错误响应

```json
{
  "error": {
    "code": "RAW_RECORD_IMMUTABLE",
    "message": "原始记录不能被覆盖修改",
    "requestId": "req_...",
    "fieldErrors": []
  }
}
```

一期基础错误码：

| code | HTTP | 含义 |
|---|---:|---|
| `AUTH_REQUIRED` | 401 | 未登录或 Token 无效 |
| `AUTH_INVALID_CREDENTIALS` | 401 | 用户名/密码或验证码无效，不细分外部提示 |
| `AUTH_METHOD_CONFLICT` | 400 | 同一请求同时携带 Cookie 会话和 Bearer PAT |
| `FORBIDDEN` | 403 | 已认证但 scope 不足 |
| `NOT_FOUND` | 404 | 资源不存在或无权访问 |
| `VALIDATION_FAILED` | 422 | 参数或字段错误 |
| `UPLOAD_TOO_LARGE` | 413 | 单文件超过 20 MiB 或单次请求附件总量超过 100 MiB |
| `RAW_RECORD_IMMUTABLE` | 409 | 尝试覆盖事实层 |
| `FOLDER_NOT_EMPTY` | 409 | 删除的目录仍有子目录或条目 |
| `PROVIDER_IN_USE` | 409 | Provider/模型仍被 queued 或 running 任务引用 |
| `ARTIFACT_SCHEMA_INVALID` | 422 | AI JSON 不符合 Schema |
| `AI_SENSITIVE_BLOCKED` | 409 | 当前策略禁止发送敏感内容 |
| `AI_TASK_ALREADY_ACTIVE` | 409 | 同一 item/type 已有 queued 或 running 任务 |
| `AI_TASK_NOT_CANCELLABLE` | 409 | 任务已 succeeded/failed，不能再取消 |
| `AI_TASK_LEASE_CONFLICT` | 409 | worker 使用过期租约更新任务 |
| `AI_CONTEXT_TOO_LARGE` | 422 | 当前记录无法完整放入所选模型上下文 |
| `AI_MODEL_LIMITS_UNKNOWN` | 422 | 模型上下文或最大输出限制尚未配置 |
| `AI_MODEL_CAPABILITY_MISSING` | 422 | 模型缺少任务所需工具或视觉能力 |
| `AI_PROVIDER_CREDENTIALS_INVALID` | 422 | 连接测试的上游 401/403，Provider 凭据被拒绝 |
| `AI_PROVIDER_UNAVAILABLE` | 503 | Provider 不可用 |
| `RATE_LIMITED` | 429 | 登录或 API 速率受限 |
| `INTERNAL_ERROR` | 500 | 未分类服务端错误 |

登录返回的 `202 mfa_required/mfa_setup_required` 是认证中间状态，不使用 error envelope，也不登记为错误码。

错误详情和 `fieldErrors` 只返回字段路径与安全原因，不得包含 SQL、文件绝对路径、Provider 原始响应、密码、Token、原文或密钥。只有前端或外部调用者需要稳定分支处理的错误才登记 code；文档登记时写清 HTTP 状态和中文默认文案，实现该 code 时同步增加 handler/契约测试并明确前端是否专门处理，不建立错误码生成器或多层错误类。

### 2.5 分页和排序

- 列表使用不透明 cursor。
- 默认页大小 30，允许 10–100。
- 时间列表 cursor 至少编码排序时间和 ID，避免同一时间漏项。
- 搜索第一页返回 `total`；相关性 cursor 编码 `matchClass + similarity + effectiveCapturedAt + itemId`，时间 cursor 编码 `effectiveCapturedAt + itemId`，都与实际 item 排序元组完全一致，避免重复或漏项。后续页面保持同一查询快照语义，但一期不承诺跨长时间写入的完全稳定快照。
- cursor 只做不透明 Base64URL 编码和结构校验，不加密、签名、持久化或创建服务端会话。

### 2.6 幂等

- 浏览器快速录入生成 `Idempotency-Key`，网络重试时复用。
- `POST /items`、两种 multipart 创建、添加 supplement 和外部批量迁移创建支持该键，服务端按认证主体+路由+键保存 24 小时结果。
- 附件上传的幂等只覆盖同一次 multipart 请求标识，不做全局内容哈希去重。
- 同一键再次提交时返回第一次成功创建的资源；服务端不重读或比较正文。调用者不得把一个键用于两个逻辑操作。

### 2.7 一期输入上限

这些是 API 与数据库共同执行的冻结边界，不由页面自行放宽。字符数按 Unicode code point 计算，字节上限按 UTF-8 编码后的实际字节计算。

| 输入 | 上限 |
|---|---:|
| 单条原始正文 | 1 MiB；无附件时至少 1 个非空字符 |
| 人工/派生标题 | 200 字符 |
| 人工备注 | 2,000 字符 |
| 目录名称 / 最大深度 | 80 字符 / 8 层 |
| 标签名称 / 单条正式标签数 | 40 字符 / 30 个 |
| 来源 external ID / source path | 500 / 2,048 字符 |
| `sourceMetadata` 序列化 JSON | 16 KiB |
| 搜索查询 | 500 字符 |
| Provider ID / 显示名 / 模型 ID | 64 / 120 / 200 字符 |
| Provider Base URL | 2,048 字符 |
| 设备名、PAT 名称 | 120 字符 |
| 单次 multipart 文件数 | 10 个 |
| 单文件 / 单次附件总字节 | 20 MiB / 100 MiB |
| 原始附件名 / 安全显示名 | 1,024 / 255 字符 |
| 单个 artifact 序列化 JSON | 2 MiB，且仍受 Schema 字段上限约束 |
| 单次 Provider 原始响应 | 4 MiB；超限任务失败 |

迁移内容超过单条正文上限时，迁移工具按自然页面/区块边界创建 primary + supplement raw records，并保留共同外部路径；不能静默截断。上限未来只有基于真实样本失败并更新基线后才能改变。

## 3. 浏览器认证 API

### 3.1 登录

`POST /api/v1/auth/login`

请求：

```json
{
  "username": "owner",
  "password": "..."
}
```

无有效可信设备时返回 `202`：

```json
{
  "status": "mfa_required",
  "challengeId": "...",
  "expiresAt": "..."
}
```

实例尚未绑定 TOTP 时返回同样的 `202`，但状态为：

```json
{
  "status": "mfa_setup_required",
  "challengeId": "...",
  "expiresAt": "..."
}
```

此时不签发普通会话。客户端调用 `POST /api/v1/auth/totp/setup` 获取一次 provisioning 信息，再调用 confirm。

可信设备有效时直接创建会话并返回 `200`。密码、challenge 和验证码不得写日志。

### 3.2 验证 MFA

`POST /api/v1/auth/mfa/verify`

```json
{
  "challengeId": "...",
  "method": "totp",
  "code": "123456",
  "trustDevice": true,
  "deviceName": "MacBook Pro · Chrome"
}
```

`method` 允许 `totp` 或 `recovery_code`；两者共用 `code` 字段但按各自格式校验。恢复码成功后在同一事务中作废。challenge 最多失败 5 次且 5 分钟到期。

成功后使用 `Set-Cookie` 写入会话；选择可信设备时另写可信设备 Cookie。

### 3.3 当前会话与退出

- `GET /api/v1/auth/session`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/logout-all`

`GET /auth/session` 在已登录时返回当前所有者摘要、会话到期时间和本会话的 `csrfToken`。Web 只保存在内存，请求变更状态的 Cookie API 时通过 `X-CSRF-Token` 发送；页面刷新后重新获取，不写浏览器持久存储。

### 3.4 安全设置

- `POST /api/v1/auth/password/change`
- `POST /api/v1/auth/totp/setup`
- `POST /api/v1/auth/totp/confirm`
- `POST /api/v1/auth/totp/reset`
- `POST /api/v1/auth/totp/recovery-codes/regenerate`
- `GET /api/v1/auth/trusted-devices`
- `PATCH /api/v1/auth/trusted-devices/{id}`
- `DELETE /api/v1/auth/trusted-devices/{id}`
- `GET /api/v1/auth/sessions`
- `DELETE /api/v1/auth/sessions/{id}`

首次 `totp/setup` 需要密码登录返回的 `mfa_setup_required` challenge；第一次调用为该 challenge 生成并加密保存 pending secret，同一未过期、未消费 challenge 重复调用时返回同一个 provisioning URI 与手动密钥，不重新生成。`totp/confirm` 接受 challenge、TOTP code、`trustDevice` 和可选 `deviceName`，原子启用 MFA、按选择创建可信设备、生成 10 个恢复码、签发普通会话并消费 challenge；成功响应丢失后不得通过重复 confirm 再次取得恢复码明文。

已绑定后的 `totp/reset` 要求当前会话、密码以及当前 TOTP 或未使用恢复码，创建新的 5 分钟 enroll challenge；旧 TOTP 在新 secret 确认前仍有效。确认新 secret 后撤销全部旧会话、可信设备和恢复码，并返回新恢复码。`recovery-codes/regenerate` 同样要求密码 + 当前 TOTP/恢复码，旧恢复码全部失效。

可信设备只允许修改显示名或撤销；会话只允许列出或撤销。撤销当前会话后当前 Cookie 立即失效，撤销其他会话不影响当前会话。

一期不提供关闭 TOTP 的端点。

session bootstrap、TOTP provisioning、恢复码及其他含认证秘密的响应统一使用 `Cache-Control: no-store`。

## 4. 知识条目与原始记录 API

### 4.1 快速创建

`POST /api/v1/items`

纯文本请求：

```json
{
  "body": "1. 查看磁盘信息\nlsblk\n...",
  "contentFormat": "plain_text",
  "sensitivity": "normal",
  "title": null,
  "folderId": null,
  "tagIds": []
}
```

响应包含创建的 item 和 primary raw record：

```json
{
  "item": {
    "id": "...",
    "title": "1. 查看磁盘信息",
    "sensitivity": "normal",
    "createdAt": "..."
  },
  "rawRecord": {
    "id": "...",
    "readOnly": true
  }
}
```

保存接口不自动调用模型。用户手动任务和每日/每周调度都在原始记录提交后独立创建，任何 AI 故障都不能改变本次保存结果。

#### 来源对象

Cookie 会话调用时，服务端固定写入 `sourceType=web_capture`，客户端不能伪造迁移来源。带 `records:write` 的 PAT 可以在 JSON 或 multipart `metadata` 中增加：

```json
{
  "source": {
    "sourceType": "notion_migration",
    "externalId": "notion:page-id",
    "path": "Server Ops / Disk",
    "createdAt": "2024-01-20T08:00:00Z",
    "updatedAt": "2024-01-21T09:00:00Z",
    "timeQuality": "exact",
    "metadata": {
      "importBatchId": "notion-2026-08"
    }
  }
}
```

- PAT 允许 `api`、`browser_extension`、`notion_migration`、`wecom_migration`；`system` 仅内部服务可写。
- `capturedAt` 永远由开发百宝箱服务端生成，不接受调用者覆盖。
- `externalId` 若存在，必须由调用者加来源命名空间并在同一 `sourceType` 内稳定；服务端用它实现长期幂等，冲突时返回已有记录而不是覆盖。
- 外部时间缺失时为 `null` 且 `timeQuality=unknown`，不能用导入时间伪装原始创建时间。
- `metadata` 一期只接受以下可选标量：`sourceApplication`（120 字符）、`importBatchId`（120）、`originalUrl`（2,048，HTTP(S)）、`exportRelativePath`（2,048）、`parentExternalId`（500）、`sequence`（非负整数）。拒绝未知键和嵌套对象；源系统的完整导出文件需要保留时作为原始附件上传。

### 4.2 带附件创建

`POST /api/v1/items:multipart`

multipart 字段：

- `metadata`：与 JSON 创建相同的结构。
- `files[]`：一个或多个文件，每个不超过 20 MiB。

单次最多 10 个文件，附件实际总字节最多 100 MiB；任一单文件仍不得超过 20 MiB。客户端尽早提示，Caddy 和 API 仍必须流式二次校验。

`contentKind` 由服务端根据正文与附件 kind 推导，客户端不能指定。每个附件同时保存客户端声明 MIME、服务端检测 MIME 与上传流计算的 SHA-256；kind、预览和响应类型只依据服务端检测值。

### 4.3 列表

`GET /api/v1/items`

查询参数：

- `view=inbox|recent|favorites|sensitive|images|files|trash`
- `folderId`
- `tagId`
- `sort=effective_desc|updated_desc`
- `cursor`
- `limit`

固定视图语义以 `02-DATA-MODEL.md` 4.5 节为准。列表响应不返回完整原文，只返回安全摘要、匹配附件、条目级有效采集时间和时间来源状态。敏感摘要按当前设置遮挡。

`sort` 可省略；`view=recent` 固定按 `effective_desc`，提交 `updated_desc` 时返回 `VALIDATION_FAILED`。其他固定视图默认 `updated_desc`，并允许用户显式改为 `effective_desc`。

### 4.4 详情

`GET /api/v1/items/{itemId}`

返回：

- 人工元数据。
- raw record 摘要列表。
- 按 `artifactType` 分组的当前 artifact 摘要，并包含服务端计算的 `isStale`。
- 附件列表。
- 可用历史版本。

该响应不返回完整原始正文；详情在用户打开“原始记录 · 只读”页签时调用下一节的 raw-record 端点。附件列表只返回元数据，不返回二进制内容。

### 4.5 获取原始记录

`GET /api/v1/items/{itemId}/raw-records/{rawRecordId}`

返回原始正文、来源、有效采集时间及其可信度和附件元数据。响应显式包含：

```json
{
  "readOnly": true,
  "body": "...",
  "declaredSensitivity": "sensitive"
}
```

不存在 `PUT/PATCH /raw-records/{id}`。

该响应以及附件元数据/内容响应使用 `Cache-Control: no-store`。敏感/未知正文在用户明确揭示前不请求；服务端仍按会话或 PAT scope 独立鉴权，不能依赖前端隐藏。

### 4.6 添加补充记录

`POST /api/v1/items/{itemId}/raw-records`

```json
{
  "body": "补充：该环境磁盘实际为 /dev/vdb",
  "contentFormat": "plain_text",
  "sensitivity": "normal",
  "relation": {
    "type": "supplements",
    "targetRawRecordId": "..."
  }
}
```

带附件补充使用：

`POST /api/v1/items/{itemId}/raw-records:multipart`

- `metadata`：与上面的 supplement JSON 相同，可省略/留空正文，但必须包含 `contentFormat`、`sensitivity` 和可选 relation。
- `files[]`：一个或多个文件，复用 4.2 节的文件数、单文件、总字节、临时文件和幂等约束。
- 正文和附件至少存在一种；每次调用创建新的 immutable supplement raw record，不向旧 raw record 追加附件。
- `supplements`/`supersedes` 的 target 必须属于同一 item；`migration_duplicate` 可以跨 item。
- Cookie 会话的来源仍固定为 `web_capture`；PAT 可按 4.1 节提交可选 `source`，每个 supplement 的 `externalId` 必须独立且稳定，超长迁移内容可以通过共同 `path` 和带分片后缀的 external ID 关联来源。

创建 supplement 的事务按 `sensitive > unknown > normal` 与 item 当前 sensitivity 取更严格者，只自动升级、不自动降级；若升级且当前标题来自系统生成，同时替换为安全通用标题。旧 Artifact 不删除，响应中的 `isStale` 随输入集合变化重新计算。

### 4.7 修改人工元数据

`PATCH /api/v1/items/{itemId}`

允许字段：

```json
{
  "title": "Linux 新磁盘挂载",
  "note": "适用于新服务器初始化",
  "folderId": "...",
  "tagIds": ["..."],
  "favorite": true,
  "sensitivity": "sensitive"
}
```

正文、来源和附件不在此接口中。

PATCH 语义固定为：

- 字段缺失：保持不变。
- `folderId: null`：移回收件箱。
- `note: null`：清空备注。
- `tagIds: []`：清空正式标签。
- `favorite: false`：取消收藏。
- `title`：trim 后必须是非空字符串并保存 trim 后值。
- `sensitivity`：用户显式改判并写不含正文的安全事件；不会修改历史 `declared_sensitivity`。

一期不增加 ETag、字段级 patch operation 或通用乐观锁；单用户多标签页采用最后一次成功提交，但每次请求仍在事务中完整校验关联资源。

### 4.8 回收站

- `DELETE /api/v1/items/{itemId}`：移入回收站。
- `POST /api/v1/items/{itemId}/restore`：恢复。
- `DELETE /api/v1/items/{itemId}/purge`：永久删除，只允许回收站条目并要求确认标识。

## 5. 附件 API

- `GET /api/v1/attachments/{id}/metadata`
- `GET /api/v1/attachments/{id}/content`
- `GET /api/v1/attachments/{id}/thumbnail`

下载权限继承所属 item。PAT 需要 `attachments:read` 且能读取所属 record。

敏感/未知条目的附件还要求 PAT 具备 `sensitive:read`；没有时不是通过下载响应做遮挡，而是拒绝二进制读取。

一期不提供覆盖更新附件。删除单个附件会改变原始记录事实，因此只允许永久删除整个条目；如果后续确需单附件删除，必须作为新的产品决策处理。

## 6. 搜索 API

`POST /api/v1/search`

搜索词可能包含密码、Token、私钥片段、内网地址和命令参数，因此只通过 JSON body 发送：

```json
{
  "q": "挂载 /dev/vdb1",
  "sort": "relevance",
  "folderId": null,
  "tagIds": [],
  "contentKinds": [],
  "sensitivity": [],
  "from": null,
  "to": null,
  "cursor": null,
  "limit": 30
}
```

`q` 必填，trim 后非空；其他字段沿用一期枚举和上限。`contentKinds` 只接受 `text|image|file|mixed`，条目存在任一对应 raw record 即命中且一个条目可命中多个值；图片/文件固定视图仍以 ready 附件为准。`from/to` 过滤条目下最大的 `effective_captured_at`，敏感状态、目录和标签过滤使用 item 当前元数据。原始 `q` 不进入 URL、访问日志或持久化浏览器存储；非敏感的 view、filter 和 sort 可以写入 URL。响应使用 `Cache-Control: no-store`。

一期搜索按字面文本处理，没有布尔表达式、字段语法、引号语法、减号排除、正则或 Lucene DSL。进入 SQL `LIKE/ILIKE` 前必须转义 `%`、`_` 和转义字符本身；索引与查询统一做 Unicode 小写、CRLF/CR→LF 和连续普通空白归一化，不删除 `/`、`\\`、`-`、`.`、`:`、`=`、`$` 或引号等路径/命令字符。短查询也保持字面精确、前缀和子串语义；是否加入 trigram 模糊扩展由固定排名 fixture 决定，不由实现临时发明查询语言。

响应：

```json
{
  "sort": "relevance",
  "total": 3,
  "items": [
    {
      "itemId": "...",
      "title": "Linux 新磁盘挂载",
      "snippetParts": [
        { "text": "Linux 新磁盘", "highlighted": false },
        { "text": "挂载", "highlighted": true },
        { "text": "步骤", "highlighted": false }
      ],
      "matchedSource": "raw_text",
      "matchedFragmentId": "...",
      "effectiveCapturedAt": "...",
      "sensitivity": "normal",
      "artifactIsStale": null
    }
  ],
  "nextCursor": null
}
```

`snippetParts` 只包含纯文本，不包含 HTML，避免 Go Unicode code point 与 JavaScript UTF-16 下标歧义。敏感结果由服务端直接返回遮挡分段，不能先返回未遮挡正文再由前端隐藏。`artifactIsStale` 仅在 `matchedSource` 为 `ai_text`/`image_text` 时返回布尔值，其他来源返回 `null`。

搜索先在每个 item 内按 `matchClass DESC, similarity DESC, matchedFragmentId DESC` 只选一个最佳命中片段。因此同一 item 不会因多个 fragment 重复出现在一页或跨页。`sort=relevance` 的 item 排序固定为 `matchClass DESC, similarity DESC, effectiveCapturedAt DESC, itemId DESC`；`sort=recency` 固定为 `effectiveCapturedAt DESC, itemId DESC`，各自 cursor 编码完整 item 级排序元组。非模糊字面命中的 `similarity` 固定为 `1.0`；fuzzy 与 AI 派生模糊命中使用 PostgreSQL 返回的相似度，字段始终非 null。`matchClass` 的整数映射与总基线 SRCH-03 完全一致；trigram 最低相似度是单一代码常量并由版本化排名 fixture 锁定，不暴露为用户设置，也不改变字面查询语义。

## 7. 目录与标签 API

### 7.1 目录

- `GET /api/v1/folders/tree`
- `POST /api/v1/folders`
- `PATCH /api/v1/folders/{id}`
- `POST /api/v1/folders/{id}/move`
- `DELETE /api/v1/folders/{id}`

移动接口服务端检查循环。删除非空目录返回 `FOLDER_NOT_EMPTY`，不级联条目。

### 7.2 标签

- `GET /api/v1/tags`
- `POST /api/v1/tags`
- `PATCH /api/v1/tags/{id}`
- `DELETE /api/v1/tags/{id}`

删除标签只解除 item 关联，不删除条目。

## 8. Provider 与模型 API

### 8.1 Provider

- `GET /api/v1/ai/providers`
- `POST /api/v1/ai/providers`
- `PATCH /api/v1/ai/providers/{id}`
- `DELETE /api/v1/ai/providers/{id}`
- `POST /api/v1/ai/providers/{id}/test`

创建示例：

```json
{
  "providerKey": "openrouter-main",
  "displayName": "OpenRouter",
  "protocol": "openai-completions",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "...",
  "models": [
    {
      "modelId": "provider/model-id",
      "displayName": "默认整理模型",
      "contextWindow": 128000,
      "maxOutputTokens": 8192,
      "supportsTools": true,
      "supportsVision": false
    }
  ]
}
```

API Key 在后续读取响应中永远不返回；只返回 `hasApiKey` 和掩码末尾。

ProviderKey 创建后不允许改，避免任务历史引用漂移；显示名、URL、密钥和模型可更新。

`DELETE` 是可审计软删除：存在 queued/running 任务时返回 `PROVIDER_IN_USE`；否则禁用全部模型、清除密钥密文和默认模型引用，并从普通列表隐藏。历史任务仍显示保存的 provider/model 名称。已删除的 ProviderKey 一期不复用。

Base URL 规则：

- 必须是绝对 `https://` URL，只允许可选路径；拒绝 userinfo、query、fragment 和非 HTTP(S) scheme。
- Base URL 表示所选协议的根地址，adapter 只规范化末尾 `/` 并拼接固定 endpoint：Chat Completions 为 `chat/completions`、Responses 为 `responses`、Anthropic Messages 为 `messages`。不得猜测用户输入的是根地址还是完整 endpoint，也不得自动重复补 `/v1`。
- 部署者显式设置 `ALLOW_INSECURE_PROVIDER_HTTP=true` 时才接受 `http://`，设置页持续显示风险；这用于用户主动配置的内网网关，不是默认降级。
- Provider 请求不跟随重定向，避免 API Key 被带到意外目标；需要新地址时由用户修改配置。
- 单用户所有者可以明确配置内网地址，一期不建设复杂 SSRF allowlist。连接测试和真实任务仍执行同一 URL、超时与响应大小校验。

连接测试请求固定为：

```json
{
  "modelId": "..."
}
```

`modelId` 必须属于路径中的 Provider 且未删除。服务端使用固定的最小输入和最小输出预算，不接受调用者提供任意 Prompt 或输出上限。成功响应只返回安全诊断：

```json
{
  "status": "ok",
  "latencyMs": 320,
  "usage": {
    "inputTokens": 8,
    "outputTokens": 1
  }
}
```

Provider 未返回 usage 时该字段为 `null`。连接测试只发起一次外部请求且不自动重试；UI 执行前说明可能产生 Provider 请求和费用。不自动遍历全部模型，不记录 Key 或完整响应，没有 Provider 明确费用字段时不维护价格表或估算金额。本地请求字段错误使用 `VALIDATION_FAILED`；上游 401/403 映射为脱敏的 `AI_PROVIDER_CREDENTIALS_INVALID`，网络错误、408、429、5xx 或畸形响应统一映射为 `AI_PROVIDER_UNAVAILABLE`，均不回传上游正文。真实 AI task 的 Provider 网络重试才使用 `04-SECURITY-AND-OPERATIONS.md` 6.3 节的白名单和 deadline。

### 8.2 模型目录

- `POST /api/v1/ai/providers/{id}/discover-models`：辅助获取，不是所有 Provider 必须支持。
- `POST /api/v1/ai/providers/{id}/models`
- `PATCH /api/v1/ai/models/{id}`
- `DELETE /api/v1/ai/models/{id}`

发现接口失败不能删除手工模型。

模型可先保存未知限制用于待配置列表；`contextWindow` 与 `maxOutputTokens` 未同时提供正整数时，服务端不允许把它设为默认或用于任务。`maxOutputTokens` 必须小于 `contextWindow`，worker还要为系统 Prompt 和输入保留空间。所有内置任务要求 `supportsTools=true`；`analyze_image` 还要求 `supportsVision=true`，一期不维护无工具调用的第二套 JSON 生成路径。

模型 `DELETE` 同样是软删除；queued/running 任务引用时返回 `PROVIDER_IN_USE`，其他历史引用保留。删除默认模型时同时清空对应默认设置，不自动选择另一个模型。

## 9. AI 任务与派生结果 API

### 9.1 创建任务

`POST /api/v1/ai/tasks`

```json
{
  "taskType": "organize_record",
  "itemId": "...",
  "modelId": "...",
  "sensitivePolicy": "redact",
  "options": {
    "includeRelatedRecords": true
  }
}
```

服务端检查：

- item 存在且不在回收站。
- 模型启用且声明支持工具调用；图片任务还必须支持视觉输入。
- 敏感策略允许。
- 同一 `itemId + taskType` 没有 `queued` 或 `running` 任务；即使手动点击也不允许并发创建，返回 `AI_TASK_ALREADY_ACTIVE`。不同 task type 可以并行。

手动批量使用同一端点：

```json
{
  "taskType": "batch_organize",
  "itemIds": ["..."],
  "organizeModelId": "...",
  "visionModelId": "...",
  "sensitivePolicy": "redact"
}
```

`itemIds` 去重后为 1–100 条。API 创建一个 batch 父任务，并按每个 item 的内容拆分：有正文且当前整理结果未覆盖最新 raw records 时创建 `organize_record`；有 ready 图片且当前图片分析结果未覆盖当前图片集合时，在 `visionModelId` 可用时创建 `analyze_image`。同一混合条目可以创建这两种子任务。只有普通文件的条目跳过；缺少视觉模型时只跳过图片分支，不影响其正文整理；已有同 item/type 活动任务的分支记录 `already_queued_or_running`，不让整个 batch 失败。父任务不调用模型、不产生 artifact，只汇总子任务成功/失败/取消以及按原因跳过的 item/分支数量。若没有创建任何子任务且所有输入都有明确 skip reason，父任务以 `succeeded` 返回全 skipped 摘要。

父任务的 `batchSummary` 在创建响应和后续查询中使用固定结构：

```json
{
  "selectedItems": 4,
  "createdChildren": 2,
  "childStatusCounts": {
    "queued": 2,
    "running": 0,
    "succeeded": 0,
    "failed": 0,
    "cancelled": 0
  },
  "skipped": {
    "total": 2,
    "byReason": {
      "already_covered": 1,
      "already_queued_or_running": 0,
      "no_supported_content": 1,
      "vision_model_unavailable": 0,
      "sensitive_blocked": 0,
      "sensitive_image_redaction_unsupported": 0
    }
  }
}
```

每个跳过的 item/task-type 分支只计入一个原因；`skipped.total` 等于各原因之和。混合 item 可产生两个分支，所以 `selectedItems` 不与 `createdChildren + skipped.total` 强制相等。全 skipped 成功要求 `createdChildren=0` 且每个输入都有上述稳定原因。

skip reason 映射固定为：

| 条件 | reason |
|---|---|
| 对应 active Artifact 已覆盖当前 raw/image 输入集合 | `already_covered` |
| 同 item/type 已有 queued/running 子任务 | `already_queued_or_running` |
| 条目没有非空正文或 ready 图片，例如只有普通文件 | `no_supported_content` |
| 有待分析 ready 图片但没有可用视觉模型 | `vision_model_unavailable` |
| 当前 item 为 sensitive/unknown 且 batch 策略为 `block` | `sensitive_blocked` |
| sensitive/unknown 图片分支使用 `redact`，无法可靠处理二进制原图 | `sensitive_image_redaction_unsupported` |

创建了子任务时父任务进入 running；每次子任务转换状态，API 在同一事务更新 `batchSummary`。全部子任务终止后，父任务自身有取消请求则 cancelled；否则任一 child failed 则 failed，无 failed 但任一 child cancelled 则 cancelled，其余 succeeded。skip 不使父任务失败，部分成功子任务及其 Artifact 始终保留。

### 9.2 查询和取消

- `GET /api/v1/ai/tasks/{id}`
- `GET /api/v1/ai/tasks?itemId=...`
- `POST /api/v1/ai/tasks/{id}/cancel`
- `POST /api/v1/ai/tasks/{id}/retry`

取消是请求，不保证能撤回已经发出的 Provider 请求。queued 任务取消后返回 `200` 和 `status=cancelled`；running 任务记录请求后返回 `202`、`status=running` 和 `cancelRequested=true`；重复取消已 cancelled 任务幂等返回 `200` 当前终态；对 succeeded/failed 任务取消固定返回 `409 AI_TASK_NOT_CANCELLABLE`。新到达的 worker complete 只有在尚无 Artifact 时才检查当前 `leaseVersion`、任务仍为 running、`cancelRequestedAt` 为空；取消先发生则丢弃候选、任务进入 cancelled，不能在成功后反向改成 cancelled。成功后的 complete 幂等重试走 11 节的既有 Artifact 返回路径。

取消 running 的 batch 父任务会在一个事务中设置父任务取消请求、把 queued 子任务置为 cancelled，并给 running 子任务设置 `cancelRequestedAt`；不再创建新子任务。全部子任务终止后父任务 cancelled，已成功子任务与 Artifact 保留。重复取消父任务幂等；已经 succeeded/failed 的父任务同样返回 `AI_TASK_NOT_CANCELLABLE`。

`retry` 是用户动作：只允许对 failed/cancelled 任务创建一个带 `retryOfTaskId` 的新 task row，旧任务状态和事件不变。Provider 网络重试发生在同一 task run 内，不能把旧失败任务改回 queued，也不能混淆两类重试。

### 9.3 Artifact

- `GET /api/v1/items/{itemId}/artifacts`
- `GET /api/v1/artifacts/{id}`
- `POST /api/v1/artifacts/{id}/activate`
- `POST /api/v1/artifacts/{id}/invalidate`
- `POST /api/v1/artifacts/{id}/apply-suggestions`

Artifact 列表、详情和当前版本摘要都返回服务端根据任务输入集合计算的 `isStale`。新增 raw record/ready 图片后，旧 active Artifact 不自动失效、删除、切换版本或退出搜索；UI 必须显示“此 AI 版本未覆盖最新原始记录”。所有历史版本仍可查看，只有未作废版本可以激活；只有当前激活版本的搜索片段处于 active，AI 搜索命中同时返回 `artifactIsStale`。详情字段名保持 `isStale`，搜索字段用可空的 `artifactIsStale` 表明它只描述 AI 命中来源。

激活只替换该 artifact 自身类型的当前版本；`organized_record`、`correctness_review` 和 `image_analysis` 可以各有一个当前版本，互不覆盖。激活 stale 版本前 UI 明确提示，但系统不替用户判断其内容无效。

`apply-suggestions` 一期只允许显式选择：

```json
{
  "title": true,
  "folder": false,
  "tags": ["Linux", "磁盘"]
}
```

服务端重新读取 artifact 建议，不接受客户端提交任意替换内容。标题、目录和标签在一个事务中应用；标签 trim 后按 Unicode 大小写折叠复用已有标签，目录按路径段复用同级现有目录。创建缺失标签或目录必须是确认 UI 中明确选择的结果，并正确处理唯一约束竞态。

未作废的 stale Artifact 仍可应用，但 UI 必须提示未覆盖最新原文；已作废 Artifact 只能查看，不能激活或应用建议。应用建议不修改 raw record、Artifact 或 sensitivity。敏感状态建议另走显式改判动作，不建设通用“模型动作执行器”。

### 9.4 定期整理

- `GET /api/v1/ai/schedule`
- `PUT /api/v1/ai/schedule`

```json
{
  "frequency": "weekly",
  "timezone": "Asia/Shanghai",
  "localTime": "03:00",
  "weekday": 1,
  "organizeModelId": "...",
  "visionModelId": "...",
  "sensitivePolicy": "block"
}
```

仅允许 `off`、`daily`、`weekly`。时区必须是服务端时区数据库支持的 IANA 名称；`weekday` 取 1（周一）到 7（周日），daily 时忽略。每个时间窗固定最多 20 条，不提供任意 Cron、并发数或无限批量参数。

## 10. 外部 Agent 接入

### 10.1 PAT 管理

- `GET /api/v1/tokens`
- `POST /api/v1/tokens`
- `DELETE /api/v1/tokens/{id}`

Token 形态包含可识别前缀，例如 `dtb_pat_`，但服务端不依赖前缀完成安全判断。

PAT 创建页默认不选 `sensitive:read`。没有该 scope 时，搜索/列表只返回敏感条目的遮挡元数据，raw-record 与敏感附件读取返回 `FORBIDDEN`，为敏感条目提交 artifact 也被拒绝。`tasks:run` 发起内置任务时仍由任务的敏感策略决定外发内容，不能借此换取原文响应。

PAT scope 到端点的固定矩阵：

| 操作 | Cookie 所有者会话 | PAT scope |
|---|---:|---|
| 列表、搜索、item 摘要 | 允许 | `records:read` |
| 读取 normal 原文 | 允许 | `records:read` |
| 读取 sensitive/unknown 原文 | 允许 | `records:read` + `sensitive:read` |
| 新建 item 或 supplement raw record | 允许 | `records:write` |
| 修改标题、目录、标签、收藏、敏感状态 | 允许 | 一期 PAT 不允许 |
| 移入回收站、恢复、永久删除 | 允许 | 一期 PAT 不允许 |
| 读取 normal 附件 | 允许 | `records:read` + `attachments:read` |
| 读取 sensitive/unknown 附件 | 允许 | 再加 `sensitive:read` |
| 提交 normal 候选 Artifact | 允许 | `artifacts:write` |
| 提交 sensitive/unknown Artifact | 允许 | `artifacts:write` + `sensitive:read` |
| 发起内置任务 | 允许 | `tasks:run`，外发仍受实例敏感策略约束 |
| 激活、作废或应用 Artifact | 允许 | 一期 PAT 不允许 |
| Provider、模型、定期任务设置 | 允许 | 一期 PAT 不允许 |
| PAT、密码、TOTP、设备和会话管理 | 允许 | PAT 不允许 |
| `/internal/ai/*` | 不允许 | 仅内部 worker token |

`sensitive:read` 只是附加门槛，不能单独赋予读取能力。PAT 可以用 `records:write` 创建声明为 sensitive/unknown 的原始记录，但创建响应不得回显完整正文；没有 `sensitive:read` 时随后仍不能读取它。

### 10.2 使用现有资源 API

外部 Agent 尽量复用 `/items`、`/search`、`/attachments`、`/ai/tasks` 和 `/artifacts` 资源，不为每个 Agent 建一套重复 API。

认证头：

```http
Authorization: Bearer dtb_pat_...
```

Cookie 与 Bearer 同时出现时固定返回 `AUTH_METHOD_CONFLICT`，不猜测优先级，也不把一个身份的 CSRF/权限语义套到另一个身份。

### 10.3 外部 Artifact 提交

`POST /api/v1/items/{itemId}/artifacts`

需要 `artifacts:write`：

```json
{
  "generator": "external_agent",
  "generatorName": "Codex",
  "modelName": "configured-by-caller",
  "schemaVersion": "1.0",
  "sourceRawRecordIds": ["..."],
  "content": {}
}
```

约束：

- `content` 通过同一 Schema。
- source ID 必须属于该 item。
- 外部结果创建候选版本，不直接激活，除非调用者另有 `artifacts:activate` scope；一期不提供该 scope，保持用户控制。
- 调用者不得指定 versionNumber、createdAt 或内部 task ID。

## 11. 内部服务 API

### 11.1 API 提供给 worker 的任务接口

前缀 `/internal/ai`，不由 gateway 暴露。

- `POST /internal/ai/tasks/claim`
- `POST /internal/ai/tasks/{id}/heartbeat`
- `POST /internal/ai/tasks/{id}/events`
- `POST /internal/ai/tasks/{id}/complete`
- `POST /internal/ai/tasks/{id}/fail`
- `GET /internal/ai/tasks/{id}/attachments/{attachmentId}`

API 与 worker 双向使用同一个独立固定长度随机服务 token 认证，接收方都使用常量时间比较。token 来自 Docker Secret/环境，不进入数据库。

Claim 每次增加任务的 `claimAttempt` 并把它作为 `leaseVersion` 返回。heartbeat、events、complete、fail 都必须携带当前 `leaseVersion`；租约过期并被重新领取后，旧 worker 的迟到提交固定返回冲突，不能创建 artifact。

complete 按固定顺序处理：

1. 验证内部身份、task ID，并确认请求 `leaseVersion` 等于该任务当前/成功 claim version。
2. 按 `task_run_id` 查询已有 Artifact；若存在且任务为 succeeded，直接返回原 Artifact 和终态，忽略重试正文，不再要求任务为 running。
3. 仅在 Artifact 不存在时，检查任务仍为 running、lease 有效且 `cancelRequestedAt` 为空，再执行 Schema/业务校验并在一个事务中创建 Artifact、分配版本和置任务 succeeded。
4. 唯一约束竞态命中 `ai_artifacts.task_run_id UNIQUE` 时重新读取并返回同一 Artifact；取消或 lease 冲突则不创建版本。

这只解决 complete 成功响应丢失，不建立通用幂等框架。

Claim 响应只包含本任务需要的数据：

```json
{
  "task": {
    "id": "...",
    "type": "organize_record",
    "leaseVersion": 1,
    "promptVersion": "organize-v1",
    "schemaVersion": "1.0",
    "limits": {
      "maxTurns": 4,
      "maxToolCalls": 8,
      "deadlineAt": "..."
    }
  },
  "input": {
    "itemId": "...",
    "rawRecords": [],
    "fragments": [],
    "attachments": []
  },
  "provider": {
    "protocol": "openai-responses",
    "baseUrl": "...",
    "apiKey": "...",
    "modelId": "..."
  }
}
```

该响应严禁日志记录。

### 11.2 worker 提供给 API 的 Provider 测试 RPC

`POST http://ai-worker/internal/provider-test` 只在 Compose 内部网络监听，不由 gateway 暴露。Go API 接收公共连接测试请求后，只调用一次该 RPC 并在严格整体超时内同步等待；worker 不可用或 RPC 超时映射为 `AI_PROVIDER_UNAVAILABLE`，API 不回退为自己直连 Provider。

RPC 使用同一内部服务凭据，输入仅包含公共请求 ID、经过 API 校验的 Provider 配置快照、解密后的 Key、上游文本模型 ID 和固定 deadline。worker 在出站前再次执行协议 URL、超时和响应大小边界，复用真实任务的 `ModelGateway`，只发起一次最小 Provider 请求且不自动重试。它不创建 task row、task event 或 Artifact；响应只含 `status`、`latencyMs`、可空 usage 和稳定安全失败类别，不含 Key、请求正文或上游响应正文。

API 与 worker 都不得记录该 RPC 请求体。Key 明文只存在于 API 组装本次内部请求及 worker 执行本次调用的短暂内存，调用结束立即释放。

## 12. AI 输出契约

机器契约见 `contracts/ai-artifact.schema.json`。本节规定语义。

### 12.1 顶层字段

| 字段 | 语义 |
|---|---|
| `schemaVersion` | 必须为任务要求版本，一期为 `1.0` |
| `artifactType` | `organized_record`、`correctness_review` 或 `image_analysis` |
| `title` | 派生标题，不覆盖人工标题 |
| `summary` | 简洁摘要，不包含未在来源中的事实声明 |
| `classification` | 内容类型、目录路径建议、标签和敏感建议 |
| `blocks` | 动态详情内容，严格 discriminated union |
| `warnings` | 风险、不一致和待确认项 |
| `sourceFragmentIds` | 本结果总体使用的来源片段 |
| `review` | 模型审阅状态与局限，不等于验证 |

### 12.2 Block 类型

一期支持：

- `markdown`：说明性 Markdown，不允许 HTML。
- `code`：代码/配置块。
- `command`：单条可复制命令。
- `command_steps`：有序步骤，每步可以包含命令和警告。
- `key_value`：适合环境、参数和说明。
- `table`：列和行均为纯文本。
- `checklist`：执行前检查项。
- `callout`：信息、提示、警告或危险说明。
- `image_reference`：引用已有图片附件。
- `attachment_reference`：引用已有普通附件。

模型不能返回 iframe、script、style、event handler、任意 Vue 组件名或任意 URL iframe。

### 12.3 来源引用

- 模型只能引用任务输入给出的、属于当前 item raw records 的 fragment ID 和 attachment ID；相关记录上下文不提供可引用 fragment ID。
- 服务端校验引用归属。
- 内置任务与结果类型固定对应：`organize_record → organized_record`、`review_record → correctness_review`、`analyze_image → image_analysis`；不接受模型自行改换结果类型。
- 可作为证据的 fragment 必须来自该 item 的不可变 raw record；AI/标题/元数据搜索片段不能反向充当“原始证据”。
- 有文本输入的 `organized_record`/`correctness_review` 顶层 `sourceFragmentIds` 必须非空；`image_analysis` 必须至少引用一张本任务授权图片，且任务实际发送的每张图片都要由一个 `image_reference` block 对应。未发送的超限/禁用图片不进入任务，并在任务跳过原因中说明。
- `basis=source_evidence` 的 warning 至少引用一个 source fragment；完全来自模型常识的提示允许无证据引用，但必须标记 `basis=model_knowledge`。固定“无原文依据，需外部核对”标签由 UI 根据枚举渲染，不校验模型 message 是否包含某句中文。
- 前端提供“查看原始证据”动作，定位到 fragment。

### 12.4 未知 Block

V1 Schema 不接受未知 block。前端仍必须实现运行时兜底，以处理服务端/前端滚动升级版本差异：

- 显示“不支持的内容块（需要升级客户端）”。
- 显示类型名和安全序列化摘要。
- 不渲染为 HTML，不丢弃整个 artifact。

### 12.5 校验顺序

1. 响应大小限制。
2. JSON 解析。
3. JSON Schema 校验。
4. 任务类型与 artifact type 对应校验。
5. 所有 block ID 唯一；block、`command_steps` step、checklist item 和 warning 的 `sourceFragmentIds` 都属于顶层集合，顶层集合覆盖全部实际引用。
6. fragment/attachment 属于本任务授权集，完成非空证据和图片覆盖校验。
7. table 每行单元格数量等于 columns 数量；`suggestedTags` 在 trim + Unicode 大小写折叠后去重。
8. block 数量、字符串长度及序列化后 2 MiB 总大小等业务上限。
9. 敏感输出策略检查。
10. 保存候选 artifact。

Schema 的 `format: uuid` 必须在 Go 与 Node 校验器中显式注册等价实现，服务端还要做 UUID 解析复核；使用同一组合法/非法 UUID fixture 证明两端结论一致。不得为这些规则建立通用规则引擎。

校验失败可以在一次任务内执行一次“仅修复格式”的模型重试；仍失败则任务失败。不得无限重试，也不得用正则从自然语言中强行截取看似 JSON 的片段后静默接受。

## 13. Prompt 与版本

- Prompt 以仓库文件管理并具有稳定版本名，例如 `organize-v1`。
- 修改 Prompt 行为但不改变输出结构，升级 promptVersion。
- 改变字段或 block 结构，升级 JSON Schema 版本并提供前端兼容。
- 任务保存实际 promptVersion、schemaVersion、模型和来源记录。
- 系统 Prompt 明确：不执行命令、不编造验证结果、不暴露未提供的秘密、不生成 HTML。
- 一期不提供用户在线编辑系统 Prompt。

## 14. API 明确禁止

- 不提供通用 `/execute`、`/sql`、`/shell`、`/ssh`、`/proxy`。
- 不提供原始记录 PUT/PATCH。
- 不提供任意 JSONB 字段更新器。
- 不允许客户端指定数据库列名、排序 SQL 或文件路径。
- 不为浏览器和外部 Agent 维护两套语义不同的资源模型。
- 不通过 API 返回 Provider Key、TOTP secret、恢复码哈希、会话/PAT 哈希或内部 worker token。
- 不让模型输出直接决定 HTTP 调用、目录写入或正式标签变更。

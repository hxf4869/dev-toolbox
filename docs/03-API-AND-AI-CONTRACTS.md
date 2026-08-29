# 开发百宝箱一期 API 与 AI 契约

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

### 2.2 时间与 ID

- 所有 ID 为 UUID 字符串。
- 所有时间为 ISO 8601 UTC，例如 `2026-08-29T10:00:00Z`。
- 客户端不根据 ID 推断顺序。

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
| `AUTH_MFA_REQUIRED` | 202 | 密码通过，等待 MFA challenge |
| `AUTH_METHOD_CONFLICT` | 400 | 同一请求同时携带 Cookie 会话和 Bearer PAT |
| `FORBIDDEN` | 403 | 已认证但 scope 不足 |
| `NOT_FOUND` | 404 | 资源不存在或无权访问 |
| `VALIDATION_FAILED` | 422 | 参数或字段错误 |
| `UPLOAD_TOO_LARGE` | 413 | 单文件超过 20 MiB 或单次请求附件总量超过 100 MiB |
| `RAW_RECORD_IMMUTABLE` | 409 | 尝试覆盖事实层 |
| `ARTIFACT_SCHEMA_INVALID` | 422 | AI JSON 不符合 Schema |
| `AI_SENSITIVE_BLOCKED` | 409 | 当前策略禁止发送敏感内容 |
| `AI_TASK_LEASE_CONFLICT` | 409 | worker 使用过期租约更新任务 |
| `AI_CONTEXT_TOO_LARGE` | 422 | 当前记录无法完整放入所选模型上下文 |
| `AI_MODEL_LIMITS_UNKNOWN` | 422 | 模型上下文或最大输出限制尚未配置 |
| `AI_MODEL_CAPABILITY_MISSING` | 422 | 模型缺少任务所需工具或视觉能力 |
| `AI_PROVIDER_UNAVAILABLE` | 503 | Provider 不可用 |
| `RATE_LIMITED` | 429 | 登录或 API 速率受限 |
| `INTERNAL_ERROR` | 500 | 未分类服务端错误 |

错误详情不得包含 SQL、文件绝对路径、Provider 原始响应或密钥。

### 2.5 分页和排序

- 列表使用不透明 cursor。
- 默认页大小 30，允许 10–100。
- 时间列表 cursor 至少编码排序时间和 ID，避免同一时间漏项。
- 搜索第一页返回 `total`；后续页面保持同一查询快照语义，但一期不承诺跨长时间写入的完全稳定快照。

### 2.6 幂等

- 浏览器快速录入生成 `Idempotency-Key`，网络重试时复用。
- `POST /items` 和外部批量迁移创建支持该键，服务端按认证主体+路由+键保存 24 小时结果。
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
- `DELETE /api/v1/auth/trusted-devices/{id}`

首次 `totp/setup` 需要密码登录返回的 `mfa_setup_required` challenge；响应只在这次流程展示 provisioning URI 与手动密钥。`totp/confirm` 接受 challenge、TOTP code、`trustDevice` 和可选 `deviceName`，原子启用 MFA、按选择创建可信设备、生成 10 个恢复码并签发普通会话；恢复码明文只在该响应出现一次。

已绑定后的 `totp/reset` 要求当前会话、密码以及当前 TOTP 或未使用恢复码，创建新的 5 分钟 enroll challenge；旧 TOTP 在新 secret 确认前仍有效。确认新 secret 后撤销全部旧会话、可信设备和恢复码，并返回新恢复码。`recovery-codes/regenerate` 同样要求密码 + 当前 TOTP/恢复码，旧恢复码全部失效。

一期不提供关闭 TOTP 的端点。

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

### 4.3 列表

`GET /api/v1/items`

查询参数：

- `view=inbox|recent|favorites|sensitive|images|files|trash`
- `folderId`
- `tagId`
- `sort=created_desc|updated_desc`
- `cursor`
- `limit`

列表响应不返回完整原文，只返回安全摘要、匹配附件和状态。敏感摘要按当前设置遮挡。

### 4.4 详情

`GET /api/v1/items/{itemId}`

返回：

- 人工元数据。
- raw record 摘要列表。
- 按 `artifactType` 分组的当前 artifact 摘要。
- 附件列表。
- 可用历史版本。

该响应不返回完整原始正文；详情在用户打开“原始记录 · 只读”页签时调用下一节的 raw-record 端点。附件列表只返回元数据，不返回二进制内容。

### 4.5 获取原始记录

`GET /api/v1/items/{itemId}/raw-records/{rawRecordId}`

返回原始正文、来源、时间和附件元数据。响应显式包含：

```json
{
  "readOnly": true,
  "body": "...",
  "declaredSensitivity": "sensitive"
}
```

不存在 `PUT/PATCH /raw-records/{id}`。

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

`GET /api/v1/search`

参数：

- `q`：必填，去除首尾空格后非空。
- `sort=relevance|recency`。
- `folderId`、`tagIds`。
- `contentKinds=text,image,file,mixed`。
- `sensitivity=normal,sensitive,unknown`。
- `from`、`to`。
- `cursor`、`limit`。

响应：

```json
{
  "query": "挂载",
  "sort": "relevance",
  "total": 3,
  "items": [
    {
      "itemId": "...",
      "title": "Linux 新磁盘挂载",
      "snippet": "...",
      "matchedSource": "raw_text",
      "matchedFragmentId": "...",
      "capturedAt": "...",
      "sensitivity": "normal",
      "highlights": [[0, 2]]
    }
  ],
  "nextCursor": null
}
```

`highlights` 是 snippet 的字符区间，不返回包含敏感值的未遮挡摘要。

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

`DELETE` 是可审计软删除：存在 queued/running 任务时返回冲突；否则禁用全部模型、清除密钥密文和默认模型引用，并从普通列表隐藏。历史任务仍显示保存的 provider/model 名称。已删除的 ProviderKey 一期不复用。

Base URL 规则：

- 必须是绝对 `https://` URL，只允许可选路径；拒绝 userinfo、query、fragment 和非 HTTP(S) scheme。
- 部署者显式设置 `ALLOW_INSECURE_PROVIDER_HTTP=true` 时才接受 `http://`，设置页持续显示风险；这用于用户主动配置的内网网关，不是默认降级。
- Provider 请求不跟随重定向，避免 API Key 被带到意外目标；需要新地址时由用户修改配置。
- 单用户所有者可以明确配置内网地址，一期不建设复杂 SSRF allowlist。连接测试和真实任务仍执行同一 URL、超时与响应大小校验。

### 8.2 模型目录

- `POST /api/v1/ai/providers/{id}/discover-models`：辅助获取，不是所有 Provider 必须支持。
- `POST /api/v1/ai/providers/{id}/models`
- `PATCH /api/v1/ai/models/{id}`
- `DELETE /api/v1/ai/models/{id}`

发现接口失败不能删除手工模型。

模型可先保存未知限制用于待配置列表；`contextWindow` 与 `maxOutputTokens` 未同时提供正整数时，服务端不允许把它设为默认或用于任务。`maxOutputTokens` 必须小于 `contextWindow`，worker还要为系统 Prompt 和输入保留空间。所有内置任务要求 `supportsTools=true`；`analyze_image` 还要求 `supportsVision=true`，一期不维护无工具调用的第二套 JSON 生成路径。

模型 `DELETE` 同样是软删除；queued/running 任务引用时拒绝，其他历史引用保留。删除默认模型时同时清空对应默认设置，不自动选择另一个模型。

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
- 同一 item/type 没有正在运行的重复任务，除非用户明确创建新任务。

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

`itemIds` 去重后为 1–100 条。API 创建一个 batch 父任务，并按每个 item 的内容拆分：有正文且当前整理结果未覆盖最新 raw records 时创建 `organize_record`；有 ready 图片且当前图片分析结果未覆盖当前图片集合时，在 `visionModelId` 可用时创建 `analyze_image`。同一混合条目可以创建这两种子任务。只有普通文件的条目跳过；缺少视觉模型时只跳过图片分支，不影响其正文整理。父任务不调用模型、不产生 artifact，只汇总子任务成功/失败/取消以及按原因跳过的 item/分支数量。

### 9.2 查询和取消

- `GET /api/v1/ai/tasks/{id}`
- `GET /api/v1/ai/tasks?itemId=...`
- `POST /api/v1/ai/tasks/{id}/cancel`
- `POST /api/v1/ai/tasks/{id}/retry`

取消是请求，不保证能撤回已完成的 Provider 请求；最终状态以 worker 回报为准。`retry` 创建一个带 `retryOfTaskId` 的新任务，旧任务状态和事件保持不变。

### 9.3 Artifact

- `GET /api/v1/items/{itemId}/artifacts`
- `GET /api/v1/artifacts/{id}`
- `POST /api/v1/artifacts/{id}/activate`
- `POST /api/v1/artifacts/{id}/invalidate`
- `POST /api/v1/artifacts/{id}/apply-suggestions`

激活只替换该 artifact 自身类型的当前版本；`organized_record`、`correctness_review` 和 `image_analysis` 可以各有一个当前版本，互不覆盖。

`apply-suggestions` 一期只允许显式选择：

```json
{
  "title": true,
  "folder": false,
  "tags": ["Linux", "磁盘"]
}
```

服务端重新读取 artifact 建议，不接受客户端提交任意替换内容。

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

## 11. 内部 worker API

前缀 `/internal/ai`，不由 gateway 暴露。

- `POST /internal/ai/tasks/claim`
- `POST /internal/ai/tasks/{id}/heartbeat`
- `POST /internal/ai/tasks/{id}/events`
- `POST /internal/ai/tasks/{id}/complete`
- `POST /internal/ai/tasks/{id}/fail`
- `GET /internal/ai/tasks/{id}/attachments/{attachmentId}`

worker 使用独立固定长度随机 token 认证；API 比较 token 时使用常量时间比较。token 来自 Docker Secret/环境，不进入数据库。

Claim 每次增加任务的 `claimAttempt` 并把它作为 `leaseVersion` 返回。heartbeat、events、complete、fail 都必须携带当前 `leaseVersion`；租约过期并被重新领取后，旧 worker 的迟到提交固定返回冲突，不能创建 artifact。

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
- `basis=source_evidence` 的 warning 至少引用一个 source fragment；完全来自模型常识的提示允许无证据引用，但必须标记 `basis=model_knowledge`，并在 message 中明确“需外部核对”。
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
5. fragment/attachment 引用归属、非空证据和图片覆盖校验。
6. block 数量、表格行列、字符串长度等业务上限。
7. 敏感输出策略检查。
8. 保存候选 artifact。

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

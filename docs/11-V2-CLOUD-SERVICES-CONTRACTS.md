# 开发百宝箱第二期云服务数据与 API 契约

状态：**V2.1/V2.2 实现契约；尚未完成、尚未发布**

最后更新：2026-08-31

## 1. 范围

本文只定义三条在线路径：

1. 阿里云机器翻译通用版与专业版。
2. 阿里云通用文字识别 `RecognizeGeneral`。
3. JSON 工作台显式选择的现有 AI Provider 类型生成。

八个本地工具没有 API。本文不建立通用云服务、账单、任务、历史或供应商抽象。产品范围以 `09-V2-TOOLBOX-BASELINE.md` 为准，进程和模块位置以 `10-V2-TOOLBOX-ARCHITECTURE.md` 为准。

## 2. 外部服务事实与项目策略

### 2.1 机器翻译

- 通用版调用 `TranslateGeneral`，`FormatType=text`、`Scene=general`。
- 专业版调用 `Translate`，`Scene` 必须是 `title`、`description`、`communication`、`medical`、`social`、`finance` 之一。
- 固定 endpoint：`mt.cn-hangzhou.aliyuncs.com`。
- 通用版和专业版各有每账号每月 1,000,000 字符免费额度，主账号与 RAM 子账号共享；每月 1 日重置且不结转，超出后阿里云会自动进入后付费。
- 单请求官方限制按 Java `String.length()` 计；项目发送的每个最终 `SourceText` 固定不超过 **4,999 UTF-16 code units**。
- 阿里云接口没有公开的 `ClientToken` 幂等字段。

因此本项目必须先做应用侧硬额度；不得把“阿里云可能还有余额”作为超出应用上限的理由，也不得自动重试结果不确定的请求。

#### 2.1.1 语言与专业场景的唯一静态来源

通用版使用阿里云官方“机器翻译语言代码列表”在 **2026-08-31** 显示的全部 214 个可用代码；源语言额外允许 `auto`。官方表中“维吾尔语”一行没有可直接使用的代码并要求单独联系，因此不属于这 214 个 V2 可选值。实现时把代码、中文名和英文名逐项冻结到 `apps/api/internal/aliyun/translation_languages.v1.json`，版本写为 `aliyun-language-list-2026-08-31`。该文件由 Go `embed` 读取并同时用于：

1. 服务端请求校验；
2. `GET /api/v1/aliyun/translation/languages` 的语言选择数据；
3. 专业版调用前的语言方向校验。

Web 不再复制第二份 code/pair 常量，也不在运行时抓取官网。冻结文件必须含 214 个唯一、非空 code，并逐项来自[官方代码表](https://help.aliyun.com/zh/machine-translation/support/supported-languages-and-codes)；实施时如官网与该日期的合同不一致，先停止并更新本文，不静默混入新版。

专业版六个 Scene 的有向语言对固定如下，不能把通用版“214 种两两互译”套用到专业版：

- `finance`：`zh→en`、`en→zh`。
- `medical`：`zh→en`、`en→zh`、`zh→ja`、`ja→zh`。
- `social`：`zh→en`、`en→zh`、`zh→ja`、`ja→zh`、`zh→ko`、`ko→zh`。
- `title` 与 `description`：`zh→{en,ja,ko,id,th,vi,ms,zh-tw,yue,es,fr,ru}`、`en→{zh,ru,ja,ko,ar,hi,he,pl,nl,tr,fr,es,it,de,th,id,vi,ms,zh-tw}`，以及 `ja→zh`、`zh-tw→zh`、`ms→en`，共 34 个有向方向。
- `communication`：`en` 与 `{zh,ar,ru,fr,th,tr,es,vi,it,ms}` 中每种语言双向互译，再加 `zh` 与 `{ar,ru,fr,th,tr,es,vi,it,ms}` 中每种语言双向互译；去重后的 `zh↔en` 只算一对，共 38 个有向方向。不能由此推导 `ar↔ru` 等集合内部互译。

Scene 的 UI 名称固定为“商品标题”“商品详情”“买卖家沟通”“医疗”“社交”“金融”。阿里云没有工程记录专用场景，不作无依据推荐。以上矩阵以[阿里云机器翻译专业版说明](https://help.aliyun.com/zh/machine-translation/product-overview/overview-of-machine-translation-professional-edition)为事实来源。

通用版可以使用 `sourceLanguage=auto`。但在调用前无法证明自动检测结果属于当前专业 Scene，V2 禁止以 `auto` 调用专业版：只要 preflight 中任一 chunk 需要专业版，就要求用户先明确源语言；明确语言对不在当前 Scene 矩阵中时也在调用前停止。不得为此额外调用语言识别 API，也不得“先试专业版看看”。

### 2.2 OCR

- 只调用 `RecognizeGeneral`，固定 endpoint `ocr-api.cn-hangzhou.aliyuncs.com`。
- 项目只接受 PNG、JPEG、WebP，最大 5 MiB、最长边 4096 px；同时遵守上游宽和高都大于 15 px、长边/短边小于 50 的边界。过小或过于狭长的图片在调用前拒绝。
- 云请求只使用二进制 `Body`，不使用 `Url`，不上传 OSS。
- 通用文字识别免费额度为每月 200 次，成功识别一张图计一次；免费额度耗尽后服务会进入后付费，项目必须在调用前硬停止。
- 响应中的 `Data` 是 JSON 字符串；成功判断以 SDK 成功响应和可解析 `Data.content` 为准，不能只判断 `Code == "200"`。
- 用户目前明确提供的是机器翻译服务事实，不代表 OCR 已开通。应用不得自动开通、购买或变更阿里云 OCR；V2.2 真实联调前必须由 owner 在控制台确认服务与免费额度状态。

### 2.3 本地账本不是云端实时余额

阿里云没有为这两个产品公开可供应用实时查询免费余额的产品 API；控制台统计也可能延迟。本项目的 `used/reserved/remaining` 是 **Dev Toolbox 本地保护账本**。它只记录本应用发起的调用；阿里云免费额度按主账号与 RAM 子账号共享，因此“专用 RAM 凭据”本身不能隔离该云账号下其他凭据的使用量。

如果云账号的对应 API 还被其他应用使用，owner 必须人工对账并把 Dev Toolbox 上限设为扣除外部使用与安全余量后的数值。设置页必须持续显示这项前提，并给出阿里云控制台人工对账入口。不得把本地值标为“阿里云官方剩余”或承诺单凭据即可保证零费用。

## 3. 最小 RAM 权限

专用 RAM 用户只授予：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "alimt:TranslateGeneral",
        "alimt:Translate",
        "ocr:RecognizeGeneral"
      ],
      "Resource": "*"
    }
  ]
}
```

不授予 `AliyunMTFullAccess`、`AliyunOCRFullAccess`，不复用服务器管理员或主账号 AccessKey。凭据只写入设置页并在 Go 服务加密保存；不写 `.env`、仓库、前端或日志。

## 4. 数据模型

新增迁移：`apps/api/migrations/007_v2_aliyun_services.sql`。表名和字段是合同，Agent 不得另建通用 billing/config 表。

### 4.1 `aliyun_service_settings`

单行设置，`id = 1`：

| 字段 | 类型 | 约束与消费者 |
|---|---|---|
| `id` | `smallint` | PK，`CHECK (id = 1)` |
| `access_key_id_ciphertext` | `bytea null` | 现有 secretbox 加密；与 Secret 同时存在或同时为空 |
| `access_key_secret_ciphertext` | `bytea null` | 现有 secretbox 加密 |
| `access_key_id_tail` | `text null` | 设置页只显示末 4 位；不用于调用 |
| `professional_scene` | `text null` | 官方六值 CHECK；自动切专业版前必须非空 |
| `auto_use_professional` | `boolean` | 默认 `true`；owner 可关闭 |
| `general_monthly_limit` | `integer` | 默认 950000，`1..1000000` |
| `professional_monthly_limit` | `integer` | 默认 950000，`1..1000000` |
| `ocr_monthly_limit` | `integer` | 默认 190，`1..200` |
| `owner_concurrency` | `smallint` | 默认 1，`1..3` |
| `global_concurrency` | `smallint` | 默认 3，`1..10` 且不小于 owner 值 |
| `credential_version` | `bigint` | 初始 0；每次替换/删除凭据递增，用于重建 SDK client |
| `last_success_at` | `timestamptz null` | 任一真实云调用最近成功时间 |
| `last_failure_at` | `timestamptz null` | 任一真实云调用最近失败时间 |
| `last_failure_category` | `text null` | 只存第 13.1 节 11 个稳定类别之一，不存上游正文；迁移加相同 CHECK |
| `created_at` | `timestamptz` | UTC |
| `updated_at` | `timestamptz` | UTC |

不增加自定义 endpoint、timeout、队列容量、货币、价格、资源包 ID、云账号 ID、地域选择或自由 JSON 配置。

### 4.2 `aliyun_usage_months`

每个上海自然月、每个 meter 一行：

| 字段 | 类型 | 约束 |
|---|---|---|
| `month_start` | `date` | 上海月份第一天，`CHECK (extract(day from month_start) = 1)` |
| `meter` | `text` | `mt_general`、`mt_professional`、`ocr_general` |
| `used_units` | `bigint` | `>= 0` |
| `reserved_units` | `bigint` | `>= 0` |
| `updated_at` | `timestamptz` | UTC |

主键为 `(month_start, meter)`。`remaining = configured_limit - used_units - reserved_units` 在读取时计算，不冗余存列。月份由请求惰性创建，不使用月初 cron，不删除历史账本；V2 UI 只读当前月。

### 4.3 `aliyun_usage_calls`

该表只用于幂等、预留结算和排障，不是调用历史产品：

| 字段 | 类型 | 约束与说明 |
|---|---|---|
| `request_key` | `uuid` | PK，浏览器每个实际上游调用生成一个 UUID |
| `owner_id` | `uuid` | `REFERENCES owner_account(id)`；当前调用者，不引入 tenant |
| `operation` | `text` | `translate_general`、`translate_professional`、`ocr_general` |
| `meter` | `text` | 与月表一致 |
| `month_start` | `date` | 预留发生的上海月份 |
| `reserved_units` | `bigint` | 翻译为最终 SourceText UTF-16 长度，OCR 为 1 |
| `counted_units` | `bigint` | 结算后计入 used 的数量；初始 0 |
| `status` | `text` | `reserved`、`succeeded`、`released`、`failed_counted`、`uncertain` |
| `upstream_request_id` | `text null` | 阿里云 RequestId，可排障，不含内容 |
| `failure_category` | `text null` | 第 13.1 节 11 个稳定类别之一；迁移加相同 CHECK |
| `created_at` | `timestamptz` | UTC |
| `settled_at` | `timestamptz null` | UTC |

不保存源语言内容、译文、图片、OCR 文本、文件名、占位符、完整上游响应、HTTP header 或 payload hash。

只增加一个有真实恢复消费者的部分索引：`status = 'reserved'` 时按 `created_at` 查找崩溃遗留预留。不为不存在的调用历史页增加 owner/时间列表索引。

## 5. 额度事务

所有额度事务使用同一锁顺序，不得各 handler 自定义：

1. `aliyun_service_settings` 单行（纯读取/预留 `FOR SHARE`；结算、过期恢复和设置变更因会更新最近状态或配置而 `FOR UPDATE`）。
2. 所有受影响的 `aliyun_usage_months` 按 `(month_start, meter)` 升序 `FOR UPDATE`。
3. 已存在的 `aliyun_usage_calls` 按 `request_key` 升序 `FOR UPDATE`。

这个顺序同时适用预留、结算、超时 reservation 恢复和降低 limit。如果先为恢复查询候选 call，只把它们当作候选 ID；取得上述锁后必须重新检查 `status='reserved'` 和时间，不使用旧快照结算。

### 5.1 预留

每个实际上游调用在同一数据库事务中：

1. 解析当前 `Asia/Shanghai` 月份，开启事务并按公共顺序以 `FOR SHARE` 锁设置行。
2. 惰性插入 meter 行，再按 `(month_start, meter)` 锁定额度行。
3. 从已锁定的 settings 读取最新 limit，检查 `used + reserved + requested <= configured_limit`。
4. 插入 `aliyun_usage_calls(status=reserved)`。
5. 增加 `reserved_units` 并提交。
6. 事务成功后才允许调用 SDK。

额度不足时事务不改变任何数据，返回 `QUOTA_EXHAUSTED`。不能先调用云服务再扣减，不能只在浏览器检查。

### 5.2 引擎决定

翻译请求的引擎由服务端在预检和最终预留时重复决定一次：

1. 通用版剩余足够：`mt_general`。
2. 通用版不足，`auto_use_professional=true`，已明确配置 `professional_scene`，且专业版足够：`mt_professional`。
3. 场景未配置：`PROFESSIONAL_SCENE_REQUIRED`。
4. 自动切换关闭或专业版也不足：`QUOTA_EXHAUSTED`。

同一 chunk 不跨两个 meter。预检只是提示，不占额度；真实预留才是最终决定，因此确认层与调用之间如额度变化，API 必须返回停止错误：可切换时用 `PREFLIGHT_CHANGED` 在 details 给出 `availableEngine`，auto/pair/scene/额度不满足时用各自 422/429。不得用 2xx 成功响应直接换引擎发送，浏览器必须重新 preflight 并确认。

### 5.3 结算

| 情况 | call 状态 | 额度动作 | 自动重试 |
|---|---|---|---|
| SDK 调用前本地失败、请求取消或确定未发出 | `released` | reserved 减少，不增加 used | 否 |
| 获得可用翻译/OCR 结果 | `succeeded` | reserved 转 used | 不需要 |
| 调用已发出，收到明确失败响应但无法从官方事实证明不计费 | `failed_counted` | reserved 转 used | 否，允许用户手动新请求 |
| 超时、连接中断、5xx 或无法确认是否完成 | `uncertain` | reserved 转 used | 绝不自动重试 |

OCR 官方说明成功调用才计次；实现能够明确证明 SDK 在上游返回非成功且没有识别结果时可以 `released`。任何无法确定的情况仍使用 `uncertain`。机器翻译采用更保守策略：SDK 请求一旦发出，除成功外都计入本地保护额度，避免本地账本低估导致真实后付费。

结算更新 call 与 month 必须在同一事务中且只允许从 `reserved` 转一次。重复结算是 no-op 并返回已有元数据。

同一结算事务按公共锁顺序更新 settings 最近状态：成功只把 `last_success_at` 取较大时间；`failed_counted`/`uncertain`/上游明确失败只在本次时间不早于现值时更新 `last_failure_at` 和对应 `last_failure_category`。并发较早完成的旧请求不得覆盖较新的状态；preflight、额度、队列和本地输入错误不更新这三项。

### 5.4 月份边界

一个请求按预留发生时的上海月份计量，即使响应跨过月末也结算到原 `month_start`。新月份第一次请求创建新行；旧月的未结算 reservation 不转入新月。

服务启动时，以及每次 usage 读取、preflight、新预留和 limit 更新之前，惰性扫描长期 `reserved`：

- 早于当前时间 10 分钟的一律转为 `uncertain`、`failure_category=unknown` 并计入其原月份 used；同事务按第 5.3 节只向前更新最近失败状态。
- 这是对崩溃中请求的唯一恢复动作，不重放云请求，不建后台任务或定时扫描服务。每个阿里云 SDK 调用总 deadline 固定为 45 秒且不自动重试，因此 10 分钟的 reservation 不可能是正常 in-flight 请求。

## 6. 幂等与内容不持久化的取舍

所有实际云调用要求 `Idempotency-Key: <UUID>`：

- 新 key：按第 5 节处理。
- 同 key 且 `reserved`：返回 `CALL_IN_PROGRESS`，不再调用。
- 同 key 已结算：返回 `409 CALL_SETTLED_WITHOUT_RESULT` 和已有的状态/额度元数据，`replayed=true`，不再调用。
- 同 key 的 operation、meter 或 units 与原记录不一致：返回 `IDEMPOTENCY_KEY_REUSED`。

服务器不保存译文/OCR 结果，因此结算后的幂等响应不能恢复内容。若原响应在网络中丢失，页面显示“调用状态已结算，但结果未收到”，不得凭同 key 重放；用户只能明确创建新 key 手动重试，并看到可能再次计费的提示。这是“不持久化内容”和“不重复云调用”之间的明确取舍。

## 7. 通用 HTTP 约定

- 所有路径位于 `/api/v1`，全部要求 owner Web session。
- mutation 使用现有 `AuthenticateMutation`，继续校验 Origin/CSRF；PAT 不可用。
- JSON 为 UTF-8，响应 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。
- 错误沿用一期 envelope：

```json
{
  "error": {
    "code": "QUOTA_EXHAUSTED",
    "message": "本月应用保护额度已用尽",
    "details": {
      "meter": "mt_general",
      "remaining": 0
    },
    "requestId": "..."
  }
}
```

`details` 只能包含本文定义的非敏感结构，不能透传上游响应正文。

## 8. 设置与用量 API

### 8.1 `GET /api/v1/aliyun/settings`

返回：

```json
{
  "credentials": {
    "configured": true,
    "accessKeyIdMasked": "****ABCD",
    "credentialVersion": 2
  },
  "translation": {
    "generalMonthlyLimit": 950000,
    "professionalMonthlyLimit": 950000,
    "autoUseProfessional": true,
    "professionalScene": "title"
  },
  "ocr": { "monthlyLimit": 190 },
  "concurrency": { "owner": 1, "global": 3 },
  "status": {
    "lastSuccessAt": null,
    "lastFailureAt": null,
    "lastFailureCategory": null
  }
}
```

未配置时 masked 值和 scene 可以为 `null`。不返回密文、完整 ID、Secret 或 endpoint。

### 8.2 `PUT /api/v1/aliyun/settings`

请求：

```json
{
  "credentials": {
    "accessKeyId": "LTAI...",
    "accessKeySecret": "..."
  },
  "translation": {
    "generalMonthlyLimit": 950000,
    "professionalMonthlyLimit": 950000,
    "autoUseProfessional": true,
    "professionalScene": "title"
  },
  "ocr": { "monthlyLimit": 190 },
  "concurrency": { "owner": 1, "global": 3 }
}
```

- `credentials` 属性省略表示保留；出现时两个字段都必填，空字符串无效。
- `translation`、`ocr`、`concurrency` 是完整替换的必填结构，不做字段级 PATCH 语义；前端必须先 GET 并提交完整当前值。
- 自动切专业版开启时必须提交一个官方 scene；关闭时 scene 可以保留或为 null。
- 新 limit 小于当前月 `used + reserved` 时拒绝降低，不允许保存一个立即超限的配置。
- 更新使用数据库事务：先 `FOR UPDATE` 锁 settings，按第 5.4 节处理过期 reservation，再按 meter 升序锁当前月三行并读取最新 `used + reserved`；全部新 limit 都通过后才写 settings。与并发预留竞态时只允许一个锁顺序，不接受先检查后更新的窗口。
- 并发下调只影响后续 ready/claim；已有 active permit 和 in-flight 请求不被强制终止。活跃数降到新上限以下前不再授予新 permit。
- 设置事务提交后，同一 API 进程的 queue manager 原子替换并发值；返回 200 前完成，不依赖轮询或重启。V2 不支持多 API 副本。
- 凭据加密失败时任何设置都不改变。
- 保存不发起真实云调用，不声称凭据已验证。

### 8.3 `DELETE /api/v1/aliyun/settings/credentials`

显式删除加密凭据并递增 credential version，不删除历史额度账本。删除前使用危险操作确认；删除后本地工具和本地 OCR 仍可用，云调用统一返回 `ALIYUN_NOT_CONFIGURED`。

### 8.4 `GET /api/v1/aliyun/usage/current`

返回服务器按上海时间判定的当前月：

```json
{
  "month": "2026-08",
  "timezone": "Asia/Shanghai",
  "meters": [
    { "meter": "mt_general", "limit": 950000, "used": 1200, "reserved": 0, "remaining": 948800 },
    { "meter": "mt_professional", "limit": 950000, "used": 0, "reserved": 0, "remaining": 950000 },
    { "meter": "ocr_general", "limit": 190, "used": 2, "reserved": 0, "remaining": 188 }
  ],
  "source": "dev_toolbox_local_ledger"
}
```

不接受任意月份参数，不提供调用明细 UI。

### 8.5 `GET /api/v1/aliyun/translation/languages`

返回第 2.1.1 节同一份嵌入式静态数据，不读取数据库、不抓取官网：

```json
{
  "version": "aliyun-language-list-2026-08-31",
  "generalLanguages": [
    { "code": "zh", "nameZh": "中文", "nameEn": "Chinese" },
    { "code": "en", "nameZh": "英语", "nameEn": "English" }
  ],
  "professionalPairsByScene": {
    "finance": [["zh", "en"], ["en", "zh"]]
  }
}
```

示例省略的 `generalLanguages` 实际必须恰好 214 项，六个 Scene 的 pair 必须完整等于第 2.1.1 节。pair 数组是有向 `[source, target]`，Web 只用这份响应筛选和解释专业版可用性；Go 用同一个嵌入文件校验，不维护另一份手写映射。

## 9. 预检与短队列 API

### 9.1 `POST /api/v1/aliyun/preflight`

请求不包含正文或图片：

```json
{
  "operation": "translation",
  "sourceLanguage": "zh",
  "targetLanguage": "en",
  "chunkUnits": [2431, 4999, 817]
}
```

或：

```json
{ "operation": "ocr", "units": 1 }
```

请求 JSON 最大 64 KiB。翻译时 `chunkUnits` 是长度 `1..191` 的数组，按顺序列出每个最终 `SourceText` 的 UTF-16 长度，每项 `1..4999`，总和不超过 950,000；浏览器 chunker 必须在不越过 4999 的前提下合并相邻短段，不能按每句生成无界 items。`sourceLanguage`/`targetLanguage` 使用第 2.1.1 节静态表，target 不允许 `auto`。服务端使用当前账本模拟逐 chunk 引擎选择，返回每个 meter 的预计 chunk 数/字符数、总计和是否需要专业 scene。OCR 只允许 `units=1` 且不接受语言字段。该接口不预留，不信任这些数值作为最终扣减，只服务确认层。

如果所有 chunk 都使用通用版，源语言可以是 `auto`。只要模拟结果有一个 chunk 需要专业版：

- 源语言仍为 `auto`：返回 `SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL`，引导用户明确选择后重新 preflight；
- 明确源/目标不在当前 Scene 的有向矩阵：返回 `PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED`；
- 只有明确 pair 受支持时才返回含专业版项目的计划。

这些判断都发生在排队、预留和 SDK 调用之前。

翻译成功响应的 `PreflightPlan` 形状固定为：

```json
{
  "operation": "translation",
  "month": "2026-08",
  "resetAt": "2026-09-01T00:00:00+08:00",
  "source": "dev_toolbox_local_ledger",
  "professionalScene": "title",
  "items": [
    { "index": 0, "units": 2431, "engine": "general", "meter": "mt_general", "scene": "general" },
    { "index": 1, "units": 4999, "engine": "professional", "meter": "mt_professional", "scene": "title" },
    { "index": 2, "units": 817, "engine": "professional", "meter": "mt_professional", "scene": "title" }
  ],
  "totals": [
    {
      "meter": "mt_general",
      "chunks": 1,
      "units": 2431,
      "limit": 950000,
      "used": 947000,
      "reserved": 0,
      "remainingBefore": 3000,
      "remainingAfterPlan": 569
    },
    {
      "meter": "mt_professional",
      "chunks": 2,
      "units": 5816,
      "limit": 950000,
      "used": 0,
      "reserved": 0,
      "remainingBefore": 950000,
      "remainingAfterPlan": 944184
    }
  ]
}
```

`items` 与请求 `chunkUnits` 一一按 index 对应；浏览器把每项 `engine` 作为对应 chunk 的 `expectedEngine`。未用到的 meter 可以不出现在 `totals`，数字都是 preflight 时快照，不是预留。

OCR 成功响应使用同一个顶层形状，`operation="ocr"`、`professionalScene=null`，`items` 只有 `{ "index": 0, "units": 1, "engine": "ocr", "meter": "ocr_general", "scene": null }`，`totals` 只有 OCR meter。

如最终 chunk 调用时账本导致引擎与 `expectedEngine` 不一致，API 只知道当前 chunk，不猜测浏览器尚未发送的剩余计划。`PREFLIGHT_CHANGED` 的 `error.details` 固定为：

```json
{
  "reason": "engine_changed",
  "expectedEngine": "general",
  "availableEngine": "professional",
  "meter": "mt_professional",
  "scene": "title",
  "units": 4999,
  "remaining": 950000
}
```

浏览器收到后，用自己内存中“当前 + 剩余未发”的 `chunkUnits` 重新调用 preflight，再展示完整新计划。该 409 发生在预留和 SDK 调用之前，不改变账本。

如果竞态后只有专业版可用，但当前 `sourceLanguage=auto`，返回 `SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL` 而不是构造一个不可保证的 `PREFLIGHT_CHANGED`；明确 pair 不受当前 Scene 支持时同理返回 `PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED`。两种情况 fake SDK 调用数都必须为 0。

### 9.2 `POST /api/v1/aliyun/queue-tickets`

请求：`{"operation":"translation"}` 或 `{"operation":"ocr"}`。返回 201：

```json
{
  "ticketId": "uuid",
  "operation": "translation",
  "status": "waiting",
  "position": 2,
  "expiresAt": "2026-08-31T10:02:00Z"
}
```

有空位时同样返回 201，但 body 固定为：

```json
{
  "ticketId": "uuid",
  "operation": "translation",
  "status": "ready",
  "claimBy": "2026-08-31T10:00:15Z"
}
```

create 的 waiting/ready 字段与第 9.3 节对应 GET 状态完全相同；两种都不返回 permit token。operation 只用于显示和占位，不携带内容。

### 9.3 `GET /api/v1/aliyun/queue-tickets/{ticketId}`

返回以下互斥形状；不返回 permit token：

- waiting：`{ ticketId, operation, status: "waiting", position, expiresAt }`
- ready：`{ ticketId, operation, status: "ready", claimBy }`
- active：`{ ticketId, operation, status: "active", idleExpiresAt, absoluteExpiresAt, cancelRequested }`
- terminal：`{ ticketId, operation, status: "expired" | "cancelled" }`

ticket 按 owner ID 授权：同一 owner 的任意有效 Web 会话持有 ticket ID 时都可访问；不保存或校验创建时的 session ID。其他 owner 一律表现为 `QUEUE_TICKET_NOT_FOUND`，不泄露存在性。所有时间为 ISO 8601 UTC。

### 9.4 `POST /api/v1/aliyun/queue-tickets/{ticketId}/claim`

只在 ready 时成功，返回 `{ ticketId, status: "active", permitToken, idleExpiresAt, absoluteExpiresAt }`。permit token 之后通过 `X-Cloud-Permit` header 发送，不进 URL、不写日志。同一 ticket 重复 claim 返回相同活跃 permit，不重复占并发；GET 永不返回 token。waiting 时 claim 返回 `QUEUE_TICKET_NOT_READY`，expired/cancelled 分别返回 `QUEUE_TICKET_EXPIRED`/`QUEUE_TICKET_CANCELLED`。

### 9.5 `DELETE /api/v1/aliyun/queue-tickets/{ticketId}`

等待态取消 ticket；活跃但没有 in-flight handler 时释放 permit。如果 handler 已进入 SDK 调用，DELETE 只把 ticket 标为 `cancel_requested` 并尝试传播取消；在上游返回或取消得到确认、handler 完成第 5.3 节结算之前，不得释放并发 slot。重复 DELETE 是 204，不重复传播取消。

60 秒 idle 和 10 分钟 absolute run 到期都只能回收无 in-flight 的 permit；有 in-flight 时仅标记取消/拒绝后续 chunk，slot 保留到 handler 退出。

终态 ticket 在内存中最多保留 2 分钟、最多 20 个，时间到或超容量时先淘汰最旧项，之后返回 `QUEUE_TICKET_NOT_FOUND`；这是有界状态提示，不是队列历史。每个携带 permit 的翻译/OCR handler 在预留前按固定顺序验证：token 存在且属于当前 owner、permit 仍 active、ticket operation 与 endpoint 一致、同一 permit 没有另一个 in-flight handler。对应失败固定为：

- token 缺失、未知、属于其他 owner 或与 ticket 不匹配：`409 CLOUD_PERMIT_INVALID`；
- permit 已因 idle、absolute、取消或释放而终止：`410 CLOUD_PERMIT_EXPIRED`；
- translation permit 用于 OCR 或反之：`409 CLOUD_PERMIT_OPERATION_MISMATCH`；
- 同一 permit 已有不同 request key 的 handler in-flight：`409 CLOUD_PERMIT_BUSY`。

同一 request key 已存在时先按第 6 节返回 `CALL_IN_PROGRESS`/已结算结果，不被 `CLOUD_PERMIT_BUSY` 掩盖；新 key 才原子占用 permit 的 in-flight 标志。上述错误不创建 quota call、不调用 SDK。错误响应不得回显 permit token、其他 owner 或 ticket 内部状态。

## 10. 翻译 API

### 10.1 浏览器分块合同

浏览器必须先保护技术片段，再按段落、句子和必要的硬边界切块。每个发送给 API 的 `sourceText`：

- 非空；UTF-8 JSON 字节受通用 body 限制；UTF-16 长度 `1..4999`。
- 已包含最终占位符；额度以它的实际 UTF-16 长度计算，不以用户原文或自然语言片段长度计算。
- 不把一个 Unicode surrogate pair 从字符串中间切断。
- 不自动合并已成功 chunk 后重新发送整篇。

原始文本在保护前不得超过 950,000 UTF-16 units；保护后所有最终 chunk 的 units 总和也不得超过 950,000，chunk 数不得超过 191。超过时在 preflight 前拒绝，不截断、不拆成隐形的第二次运行。active translation permit 在内存中累计真实预留的 chunk 数/units：handler 完成既有 key 查询并独占 in-flight 标志后，先检查 projected `<=191`/`<=950000`，quota reservation 成功后再增加；重复 Idempotency-Key 不重复增加。一次 permit 永远只有一个 chunk handler 进入预留/SDK/结算段。

占位符恢复只在浏览器完成。API 不理解 Markdown，不替换或保存占位符。

### 10.2 `POST /api/v1/aliyun/translation/chunks`

Headers：`Idempotency-Key`、`X-Cloud-Permit`，以及现有 mutation headers。

请求：

```json
{
  "sourceText": "请运行 __DT_A7F3_001__ 检查状态。",
  "sourceLanguage": "auto",
  "targetLanguage": "en",
  "expectedEngine": "general"
}
```

- `sourceLanguage` 为 `auto` 或第 8.5 节返回的官方语言代码；`targetLanguage` 必须是同一清单中的明确 code，不能为 `auto`，源/目标明确时不能相同。
- `expectedEngine` 必须来自用户刚确认的 preflight 计划。服务端在预留前重新选择引擎；不一致时只返回当前 chunk 的 `PREFLIGHT_CHANGED` 详情，浏览器重新 preflight 当前与剩余 chunk，绝不静默换引擎发送。
- `expectedEngine=professional` 时 source 必须明确且 pair 必须属于设置中 Scene；竞态从 general 变为 professional 时也先执行相同校验，不用额度试错。
- 语言清单和专业 pair 只来自服务端嵌入的 `translation_languages.v1.json`，不在运行时抓取官网。
- 服务端按当前真实账本选择通用/专业引擎；专业 scene 只读设置，不接受请求覆盖。
- `FormatType` 固定为 `text`，不提供 HTML 模式或任意 `Context` 输入。

成功：

```json
{
  "translatedText": "Please run __DT_A7F3_001__ to check the status.",
  "detectedLanguage": "zh",
  "engine": "general",
  "scene": "general",
  "billableUnits": 26,
  "upstreamRequestId": "...",
  "quota": { "meter": "mt_general", "remaining": 948774 },
  "replayed": false
}
```

`translatedText` 只在这次成功响应中存在，不写数据库和日志。浏览器收到后先验证占位符数量、标识和顺序；验证失败就保留原 chunk 并显示客户端状态 `PLACEHOLDER_RESTORE_FAILED`，但云额度已经使用。API 不接收预期占位符清单，因此不能返回这个错误码。

## 11. OCR API

### 11.1 `POST /api/v1/aliyun/ocr`

Headers：`Idempotency-Key`、`X-Cloud-Permit`、现有 mutation headers。Body 为 `multipart/form-data`，只允许一个 `image` part。

服务端在云调用前做一次真实边界校验：

- 总请求和文件均不超过 5 MiB 产品上限加固定 multipart 开销。
- magic bytes 与声明类型一致，只允许 PNG/JPEG/WebP。
- 用 Go 标准图片 decoder 加仓库已有的 `golang.org/x/image/webp` 注册解码配置；宽和高都必须大于 15 px、最长边不超过 4096 px、`max(width,height) / min(width,height) < 50`。
- 拒绝多个 part、URL、base64 JSON、文件路径和额外表单字段。

成功：

```json
{
  "text": "识别出的可编辑文本",
  "upstreamRequestId": "...",
  "billableUnits": 1,
  "quota": { "meter": "ocr_general", "remaining": 187 },
  "replayed": false
}
```

V2 只消费 `Data.content`。坐标块、表格、版面和置信度不作为云端合同；本地 Tesseract 的置信度也不传 API。

## 12. JSON AI 类型生成 API

### 12.1 `POST /api/v1/tools/json/type-generation/ai`

请求：

```json
{
  "providerId": "uuid",
  "modelId": "uuid",
  "targetLanguage": "rust",
  "mode": "structure",
  "input": {
    "kind": "object",
    "properties": {
      "id": { "kind": "integer" },
      "name": { "kind": "string" }
    }
  }
}
```

`mode=full` 时 `input` 是用户确认后的完整 JSON 值。整个请求最大 256 KiB；目标语言为 1–50 个可见字符，不接受 system prompt、模板、工具、URL、附件或执行选项。

成功：

```json
{
  "code": "...",
  "language": "rust",
  "promptVersion": "json-type-generation-v1",
  "usage": { "inputTokens": 320, "outputTokens": 180 }
}
```

`code` 最大 256 KiB，是不可信普通文本。API 不保存、不编译、不执行、不创建 Artifact。

Provider/model 的可用条件固定为：两者均启用且 `deleted_at IS NULL`、Provider 的 API key 密文存在、模型的 `context_window` 与 `max_output_tokens` 均非空且为正数；模型能力只需文本。任一条件不满足返回 `AI_MODEL_UNAVAILABLE`，不调用 worker/provider，本地四语言仍正常。

worker 生成版本固定的最终 system prompt 与 user prompt 后，按两段 UTF-8 字节数之和计算保守 `estimatedInputTokens`，再计算：

```text
effectiveMaxOutputTokens = min(
  4096,
  configured max_output_tokens,
  configured context_window - estimatedInputTokens - 128
)
```

128 是协议余量。结果小于 256 时返回 `AI_CONTEXT_TOO_LARGE`，不得截断 JSON/结构、缩短用户字段、改用其他模型或发起 Provider 请求。worker 是 prompt 与该公式的唯一 owner，把 `effectiveMaxOutputTokens` 作为这次调用唯一输出上限；Go 只负责从已校验的数据库行传入原始两项限制，不复制 prompt/token 估算。

### 12.2 `POST /internal/v2/json-type-generation`

Go 使用现有内部服务令牌调用；body 最大 320 KiB，deadline 固定为收到公开请求后 30 秒内。内部 JSON 必须用 `json.Encoder` 且 `SetEscapeHTML(false)` 编码，并在编码完成后校验实际字节数再发送；这样公开 256 KiB 边界内的大量 `<>&` 不会因 Go 默认 HTML escape 无意膨胀。引号/反斜杠已包含在公开请求的 256 KiB 编码边界内，Provider snapshot 仍受现有限长约束：

```json
{
  "targetLanguage": "rust",
  "mode": "structure",
  "input": { "kind": "object", "properties": {} },
  "provider": {
    "protocol": "openai-responses",
    "baseUrl": "https://provider.example/v1",
    "apiKey": "<decrypted only in transit>",
    "modelId": "model-name",
    "contextWindow": 32768,
    "maxOutputTokens": 8192
  },
  "deadlineAt": "2026-08-31T10:00:30Z"
}
```

worker 只接受三种现有 Provider protocol，复用既有 base URL 安全规则；`input` 与公开请求完全相同，不附加知识条目、历史、附件或 task ID。返回 `{ code, promptVersion, usage }`；`promptVersion` 必须是 `json-type-generation-v1`。内部请求/响应和 Provider snapshot 不写日志，API key 不进入错误。worker 只发一次 Provider attempt，gateway 的 `maxRetries` 为 0。

## 13. 稳定错误码

| HTTP | code | 含义与 UI 动作 |
|---:|---|---|
| 400 | `INVALID_INPUT` | 字段、语言、图片或单位非法；定位并修正 |
| 401 | `AUTH_REQUIRED` | 重新登录 |
| 403 | `MUTATION_NOT_ALLOWED` | Origin/CSRF/PAT 不允许 |
| 404 | `QUEUE_TICKET_NOT_FOUND` | ticket 不存在、已清理、服务重启或不属于当前 owner；重新排队 |
| 409 | `CALL_IN_PROGRESS` | 同 key 正在处理；查询/等待，不重发 |
| 409 | `CALL_SETTLED_WITHOUT_RESULT` | 同 key 已结算但内容未持久化；显示状态与手动新请求风险 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | key 与原 operation/units 不一致；客户端 bug，不自动生成新 key 隐藏问题 |
| 409 | `PREFLIGHT_CHANGED` | 确认后当前 chunk 可用引擎变化；浏览器用当前语言与“当前 + 剩余”本地 `chunkUnits` 重做 preflight 和确认 |
| 409 | `QUEUE_TICKET_NOT_READY` | ticket 仍 waiting；继续按 GET 状态等待，不 claim 重试循环 |
| 409 | `CLOUD_PERMIT_INVALID` | permit 缺失、未知或不属于当前 owner/ticket；停止请求并重新排队 |
| 409 | `CLOUD_PERMIT_OPERATION_MISMATCH` | permit 的 translation/OCR operation 与 endpoint 不一致；客户端 bug，不调用 SDK |
| 409 | `CLOUD_PERMIT_BUSY` | 同一 permit 已有另一新 key 请求 in-flight；等待当前请求结束，不自动重发 |
| 410 | `QUEUE_TICKET_EXPIRED` | waiting/ready 时限已过；重新排队 |
| 410 | `QUEUE_TICKET_CANCELLED` | ticket 已由用户取消；只有用户重新发起才排队 |
| 410 | `CLOUD_PERMIT_EXPIRED` | active permit 已 idle/absolute/cancel/release；重新排队，原 in-flight 结果按其结算状态处理 |
| 422 | `ALIYUN_NOT_CONFIGURED` | 引导设置凭据 |
| 422 | `PROFESSIONAL_SCENE_REQUIRED` | 引导所有者明确选择专业场景 |
| 422 | `SOURCE_LANGUAGE_REQUIRED_FOR_PROFESSIONAL` | 计划需要专业版但源语言仍为 auto；要求用户明确源语言后重做 preflight |
| 422 | `PROFESSIONAL_LANGUAGE_PAIR_UNSUPPORTED` | 当前 Scene 不支持该明确语言方向；修改语言或场景，不调用 SDK |
| 422 | `AI_MODEL_UNAVAILABLE` | 回到本地生成或选择已启用模型 |
| 422 | `AI_CONTEXT_TOO_LARGE` | 当前模型容量不足；选择更大模型或结构模式，不截断输入 |
| 429 | `QUOTA_EXHAUSTED` | 本月硬停止，无继续付费按钮 |
| 429 | `QUEUE_FULL` | 稍后由用户重新排队 |
| 429 | `UPSTREAM_THROTTLED` | 显示可手动重试；不自动重试 |
| 502 | `UPSTREAM_REJECTED` | 上游明确失败；展示稳定类别 |
| 503 | `UPSTREAM_UNAVAILABLE` | 可手动重试；说明可能计量 |
| 504 | `UPSTREAM_RESULT_UNCERTAIN` | 已保守计量，绝不自动重试 |

### 13.1 `failureCategory` 最小枚举

`failureCategory` 只表达 UI 有不同修正动作的稳定类别，不复制阿里云全部错误码：

| 值 | UI 动作 | 自动重试与计量 |
|---|---|---|
| `credential_invalid` | 检查/替换 AccessKey | 修复前不重试；按第 5.3 节结算 |
| `permission_denied` | 检查最小 RAM policy | 修复前不重试；按第 5.3 节结算 |
| `service_not_open` | 到阿里云控制台确认服务状态 | 开通前不重试；应用不得自动开通；按第 5.3 节结算 |
| `account_arrears` | 到控制台处理账号状态 | 修复前不重试；按第 5.3 节结算 |
| `unsupported_language` | 修改源/目标语言或专业 Scene | 不自动重试；按第 5.3 节结算 |
| `input_too_long` | 缩短/重新分块文本 | 不自动重试；按第 5.3 节结算 |
| `invalid_image` | 更换符合类型、大小、尺寸、比例的图片 | 不自动重试；按第 5.3 节结算 |
| `throttled` | 稍后由用户手动重试 | 不自动重试；按第 5.3 节结算 |
| `timeout` | 显示结果不确定与重复计费风险 | 仅用户手动新请求；`uncertain` |
| `unavailable` | 显示服务暂不可用；必要时人工排障 | 仅用户手动新请求；无法证明未受理时 `uncertain` |
| `unknown` | 显示 RequestId 并人工排障 | 仅用户手动新请求；无法证明未受理时 `uncertain` |

`UPSTREAM_*` 错误的 `error.details` 只允许 `{ failureCategory, upstreamRequestId, callStatus, meter, countedUnits, remaining }` 这组字段，其中未知值为 `null`；`callStatus` 只用第 4.3 节状态。这样 Web 不解析上游 message，也不靠 HTTP 码猜额度是否已结算。

机器翻译一旦进入 SDK，成功以外都按 `failed_counted` 或 `uncertain` 保守计量；OCR 只有能明确证明上游非成功且没有识别结果时才可 `released`，歧义仍为 `uncertain`。`failureCategory` 可以出现在上游失败 envelope、`aliyun_usage_calls.failure_category` 和设置页最近失败状态；本地参数/队列/额度错误不伪造该字段。不得把阿里云中文/英文原始消息完整返回；`RequestId` 可以显示并复制用于排障。

## 14. 请求取消、重试和刷新

- 本地 Worker：取消必须终止计算且不影响额度。
- 排队中：取消 ticket，不占额度。
- 已取得 permit、尚未预留：取消并释放。
- 已预留但明确未调用 SDK：release。
- SDK 已开始：尝试传播取消；最终仍按服务端能确认的状态结算。
- 浏览器对云调用、幂等冲突、5xx、timeout 不做自动重试。
- 页面刷新不恢复输入或结果；数据库额度和调用状态保留。
- 只有用户看到错误/不确定提示并再次点击，才使用新 request key 发起新计费尝试。

## 15. 测试替身与真实联调

- 默认 Go 测试使用本地 fake SDK/client 接口，覆盖预留、引擎选择、scene、结算、并发、重启恢复和错误映射。
- Web 测试 mock `/api/v1`，不包含真实 AccessKey 或真实用户文本。
- AI worker 使用本地协议 mock；不得调用付费模型。
- 真实阿里云联调不是默认测试，只在 owner 明确授权、使用专用 RAM 凭据且先显示预计额度时运行；联调产生的额度必须进入同一账本。
- 不把截图中的 AccessKey、控制台账号或真实响应提交仓库。

## 16. 官方依据

- [机器翻译通用版 API](https://help.aliyun.com/zh/machine-translation/developer-reference/api-alimt-2018-10-12-translategeneral)
- [机器翻译专业版 API](https://help.aliyun.com/zh/machine-translation/developer-reference/api-alimt-2018-10-12-translate/)
- [机器翻译专业版 Scene 与语言方向](https://help.aliyun.com/zh/machine-translation/product-overview/overview-of-machine-translation-professional-edition)
- [机器翻译限制与字符口径](https://help.aliyun.com/zh/machine-translation/developer-reference/limits)
- [机器翻译计费与免费额度](https://help.aliyun.com/zh/machine-translation/product-overview/billing-overview)
- [机器翻译 RAM 权限](https://help.aliyun.com/zh/machine-translation/developer-reference/api-alimt-2018-10-12-ram)
- [机器翻译支持语言](https://help.aliyun.com/zh/machine-translation/support/supported-languages-and-codes)
- [通用文字识别 API](https://help.aliyun.com/en/ocr/developer-reference/api-ocr-api-2021-07-07-recognizegeneral)
- [OCR 免费额度](https://help.aliyun.com/zh/ocr/product-overview/free-quota)
- [OCR 计费说明](https://help.aliyun.com/zh/ocr/product-overview/product-billing/)
- [OCR RAM 权限](https://help.aliyun.com/en/ocr/developer-reference/api-ocr-api-2021-07-07-recognizegeneral)

实现前应核对官方页面是否变化；如配额、必填字段、SDK 主版本或 endpoint 变化，不得静默修改代码，先更新本文和用户可见设置说明。

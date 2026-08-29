# 开发百宝箱（Dev Toolbox）

开发百宝箱是一个面向个人开发与运维工作的自托管工具集合。它从“快速保存、快速找到、保留原始事实、让 AI 生成可重建的整理结果”起步，后续可以继续容纳彼此独立的小工具，但不会在一期建设动态插件平台。

一期 `v1.0-baseline` 已确认，可直接约束设计与开发。当前 **M0 工程骨架与契约、M1 身份与原始事实层已经完成并验证**；M2–M5 尚未完成，仓库中的占位状态不代表对应业务能力已经可用。

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

本机需提供 `make`、`openssl` 和 OrbStack 的 Docker 兼容运行时。首次启动与后续启动使用同一条命令：

```bash
make up
```

该命令会在已忽略的 `deploy/.env`、`deploy/secrets/` 和 `deploy/data/` 下创建本地配置、随机 Secret 与持久化目录，构建并启动 Caddy、API、AI worker、PostgreSQL 四个服务。启动后访问 <http://localhost:8080>，API 就绪检查为 <http://localhost:8080/health/ready>。

首次启动后在终端创建唯一所有者，随后打开 Web 完成 TOTP 绑定并保存一次性恢复码：

```bash
make init-owner
```

如果所有登录因素均丢失，可在主机终端运行 `make reset-auth`。该命令只重置密码、TOTP、恢复码、会话和可信设备，不修改知识记录或附件；下次登录必须重新绑定 TOTP。

常用开发命令：

```bash
make install      # 安装锁定的本地 Node 依赖
make check        # Web/worker 类型检查 + Go 测试
make test         # Web/worker/Go 单元与契约测试
make build        # Web/worker 构建 + 四服务镜像构建
make migrate      # 重复执行顺序迁移；无新迁移时不改变数据库
make init-owner   # 一次性创建所有者；重复执行不会覆盖
make reset-auth   # 主机侧重置认证，不修改知识数据
make m1-integration-test # 在隔离测试库验证 M1 认证与录入闭环
make down         # 停止本地服务
make reset-dev    # 停止服务并清空本地开发数据，保留配置与 Secret
```

`make reset-dev` 只用于本地开发数据。执行后再次运行 `make up`，即可从空 PostgreSQL 数据目录重新迁移。

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
| [docs/BACKLOG.md](./docs/BACKLOG.md) | 明确推迟到一期之后的能力，防止开发越界 |
| [AGENTS.md](./AGENTS.md) | 所有编码 Agent 必须遵守的仓库级规则 |

## 决策优先级

发生冲突时按以下顺序处理：

1. 用户当前明确要求。
2. `AGENTS.md` 中的仓库级约束。
3. `docs/00-V1-BASELINE.md` 中的一期范围和冻结决策。
4. 专题文档中的具体契约。
5. `PRODUCT.md` 中的长期产品事实。
6. 代码中的既有实现。

任何会扩大一期范围、改变原始数据不可变原则、增加运行服务或改变安全模型的决定，都必须先更新基线并由用户确认，不能由实现 Agent 自行推断。

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

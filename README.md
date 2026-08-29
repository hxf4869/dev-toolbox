# 开发百宝箱（Dev Toolbox）

开发百宝箱是一个面向个人开发与运维工作的自托管工具集合。它从“快速保存、快速找到、保留原始事实、让 AI 生成可重建的整理结果”起步，后续可以继续容纳彼此独立的小工具，但不会在一期建设动态插件平台。

当前仓库处于**一期基线冻结阶段**：这里只包含产品、技术、交互、安全和验收基线，尚未创建业务代码、依赖或部署镜像。

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

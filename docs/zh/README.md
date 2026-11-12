# lark-remote 文档目录（中文）

English documentation: [../en/README.md](../en/README.md)

按需求选看：

## 第一次接触

- [**getting-started.md**](getting-started.md) — 入门指南：从零跑起来 + 基本维护。

## 日常使用

- [**usage.md**](usage.md) — 完整使用指南：安装、配置、所有命令详解、工作流示例、异常处理。

## 架构与设计

- [architecture/how-it-works.md](architecture/how-it-works.md) — 运行原理：一条消息的旅程（新手友好的图解入门，先读这篇）。
- [architecture/design.md](architecture/design.md) — 整体设计、JSONL 事件、配置语义、§9 已知坑点合集（最重要的设计文档）。
- [architecture/streaming-card.md](architecture/streaming-card.md) — 单卡流式输出架构（RunCardSession / BashCardSession 生命周期、降级、并发控制）。
- [architecture/token-usage-scope.md](architecture/token-usage-scope.md) — Token 用量统计的口径、各 reader 责任与回归史。
- [architecture/inbound-message-matrix.md](architecture/inbound-message-matrix.md) — 入站消息分派矩阵：飞书各 message_type 的实测处置。
- [architecture/inbound-unified-input-design.md](architecture/inbound-unified-input-design.md) — 入站统一输入回合设计（文字 + 附件合并成一个回合）。
- [cardkit-layout.md](cardkit-layout.md) — 飞书 CardKit 2.0 卡片布局避坑指南。

## 操作指南

- [guides/add-new-agent.md](guides/add-new-agent.md) — 新增 AI agent 接入的 10 步模板（registry 模式）。
- [guides/codex-config.md](guides/codex-config.md) — `/config` 卡片中 Codex 字段的工作原理、provider/model 切换联动。

## 外部参考

- [飞书 CardKit 2.0 组件官方文档](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/component-json-v2-overview) — 按钮/输入框/折叠面板等组件参考。

## 项目根文档

- [../../README.md](../../README.md) — 项目总览（安装/运行/命令一览）。

## 文档维护约定

- 路径稳定性：`architecture/design.md` 的 §9.x 章节编号被代码注释与文档互相引用，**不要随意重排**。
- 历史归档：设计文档中已不在代码中存在的模式直接删除，不再保留「历史归档」节；事故复盘进 git commit message 或 PR 描述。
- 新增文档：放在合适的子目录（architecture/guides/），并在此 README 同步加指针。

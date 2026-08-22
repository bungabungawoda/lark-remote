# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **cardAction direct-return allowlist** (`src/index.ts`): `order.textInput` and `approval.planFeedback` now return `{toast}`/`{card}` directly instead of being swallowed by the fire-and-forget `enqueueImmediate` (edit card stayed on the edit view; plan feedback toast disappeared)
- **DSH selectModel write amplification**: `session.selectModel` (which writes the server-side global default) is now aligned once per session via an `alignedSessions` set instead of every run; a start-up abort cancels the freshly created session and yields an `interrupted` terminal result instead of returning silently
- **order empty-last-page regression guard**: deleting the sole item on the last page now clamps `offset` back to a non-empty page (no blank card)
- **planFeedback gate**: modification opinions are accepted only for `ExitPlanMode` tool approvals; other approval kinds are rejected
- **planFilePath cross-run reset**: `doStartProcess` clears the in-session tracked plan file so a stale plan is never read by `resolvePlanContent`
- **order text edit** trim/validation unification: `updateText` trims internally, CLI `/order edit` joins+trims, edit card input gains `max_length: 200`
- **finalizeRun fallback card** now gates the compact button via `compactSupported` (matches `createRunSession`; agents without `runCompact` no longer render a dead button)

### Changed

- ESLint: all warnings resolved (0 errors 0 warnings)

## [0.1.9] - 2026-08-20

### 新增

- ExitPlanMode 计划审批：计划全文折叠展示 + 五决策对齐 TUI（自动放行 / 附意见 / 采纳修改）
- 卡片别名管理重构：`alias-store` 并入 `alias-resolve`，`/order` 卡片新增「＋别名」交互（绑定/修改/删除，已绑定指令显示 `$name` 标签 + ✕）
- DSH / connection-based runner 启动 / 配置热更 / 失败路径修复（CC-01~CC-08）

### 变更

- 别名 API 由「触发词 → 文本」改为「指令 → 别名」：`/order alias add <orderId|序号> <别名>` 绑定、`/order alias rm` 移除；别名随指令持久化在 `orders.json`，删除指令时别名一并删除；名称不能为保留子命令、不能数字开头
- 用户文档同步别名卡片化交互，移除 `/order alias <name> <text>` 旧用法

### 修复

- 别名卡片成功回调：携带 `card` 替换 pre-click 卡，删除文案对齐新交互
- kimi ACP runner 模型下发：迁移到纯 ACP 后 `session/set_config_option` 必须紧跟 `session/new|resume` 下发，否则实际跑的是默认模型（CC-07）

## [0.1.8] - 2026-08-19

### 新增

- DSH（DeepSeek Harness）Agent 接入：纯 HTTP 连接 DSH Web Host（无本地子进程），支持会话创建/续跑、`selectModel` 模型对齐、SSE mux 事件订阅、会话历史读取
- `/config` DSH 配置卡：Host 地址 / 会话 preset / 模型 / 推理强度，模型与预设目录预取动态加载（失败回退固定兜底清单）
- AskUserQuestion 公共契约（`question-common`）：标准提问审批事件工厂 + 按序答案映射，claude / codex / kimi / pi 统一接入
- Codex AskUserQuestion：支持自由文本题、补充说明（user_note）、`autoResolutionMs` 透传为单请求审批超时
- Kimi elicitation 表单回编 + request_permission 兜底桥
- 工具权限审批卡（`kind === 'tool'`）：ExitPlanMode 等非命令工具展示工具名 + 用途说明，计划审批语义
- 提问卡单选/多选图标区分（⚪/🔵 vs ⬜/☑️）、自由文本题输入框、自定义答案回显

### 变更

- claude session usage 扫描对齐 codex 语义：非累计字段为末轮（本 run）scope，累计走 `cumulative*` 字段
- Compact 按钮能力门控放开到所有 `runCompact` 能力 runner（claude / codex / kimi / opencode / pi）
- claude `/config` 权限模式下拉排除 `manual`（`default` 的别名，避免等价重复项）
- workspace 保存即触达：`save` 内部调用 `touch`，新保存的工作区排在列表最前
- DSH 可用性探测跳过二进制检查（HTTP-only Agent）

### 修复

- claude session usage 扫描：修复第三方网关（如 DeepSeek）将零 usage 写在占位行、真实 usage 只在末行导致的 per-run 统计全 0（改为按 message id 逐字段 max 聚合）
- 审批答案重复投递（重复 nonce 二次点击）改为中性提示，不再误报"提交失败"
- usage 统计一致性护栏：本 run 超出累计时显式标记 `⚠️ 累计异常`（只标记不修正，便于排查数据源问题）

## [0.1.7] - 2026-08-18

### 新增

- pi RPC 模式 runner：通过持久连接复用共享 `ConnectionManager`，支持审批与上下文压缩
- kimi / opencode ACP 模式 runner：纯 ACP 持久连接，支持审批 + Compact
- 共享 ACP / JSON-RPC 连接层（`runner/common/acp`、`runner/common/jsonrpc`）：统一 codex / kimi / opencode / pi 的连接管理
- 入站图片/文件自动落盘：往飞书私聊发图片/文件自动保存到 `.lark-remote-temp/`，可直接让 agent 处理
- `/order alias`：注册快捷别名，输入 `$name` 即展开
- 会话分页/截断共享辅助模块（`session/common/pagination`）
- Codex 命令审批卡片示例图

### 变更

- codex runner 统一走 app-server 审批模式；移除 codex/kimi/opencode/pi 的 exec/jsonl 旧模式与死代码
- `codex-bundled-test-helpers` 迁移至 `tests/lib/`
- 用户文档：新增入站文件、`/order alias`、kimi acp 配置说明

### 修复

- 修复文档引用指向被排除的本地文档导致的破链

## [0.1.6] - 2026-08-14

### 新增

- Codex App Server 集成：通过 stdio JSON-RPC 持久连接 Codex CLI，支持审批流（文件读写/命令执行）、Compact 上下文压缩、空闲超时自动断开
- Approval 审批系统：`approval-coordinator` 协调超时/取消/回复，`approval-render` 渲染审批按钮卡片
- Codex runner 工厂：自动选择直连模式或 App Server 模式
- `rollout-reader`：Codex App Server rollout 开关读取
- Run card 审批区域渲染 + context limit 百分比显示
- 架构文档：`docs/zh/guides/codex-config.md`

### 修复

- `/update` 命令移除自动重启逻辑
- Codex 配置枚举回归官方标准值

## [0.1.5] - 2026-08-14

### 新增

- `/update` / `/update check` 命令：检查 npm registry 最新版本并一键升级，升级后自动重启 bridge；开发模式（`--dev`）下自动拒绝自更新
- `--update` CLI 参数：非交互式升级（适用于 cron / 脚本自动化），升级后退出
- `checkUpdateOnStartup` 配置项：启动时静默检查版本更新并推送提示（默认关闭）
- 纯内存 session index（`session-index.ts`）：替代旧的 `readCwdFromJsonl`，完整 `cwdSet` 支持 EnterWorktree 连续搬迁 A→B→C 场景
- `verify-test-classification.ts` 脚本：测试分类校验工具

### 修复

- `/ws`、`/order` 卡片分页从 5 条/页调整为 15 条/页，修复飞书 ErrCode 11310 元素超限
- CLI `--dev` 帮助文本内部术语"看门狗"替换为用户可理解的"空闲超时自动停止"

### 变更

- 移除 husky / lint-staged pre-commit 和 pre-push 钩子及相关 devDependencies
- `sessions.ts` 重构：迁移到 `SessionIndex` + `parseSessionJsonl`，移除 `readCwdFromJsonl`

## [0.1.4] - 2026-08-13

### 新增

- 工作区列表支持 `lastUsedAt` 排序，最近使用的 workspace 排在前面；排序切换 UI 移至卡片上方，明确显示当前模式与切换目标
- `/config` 卡片：未安装的 Coding Agent 沉底排序，已安装 agent 保持注册顺序；探测结果过期（`undefined`）时保持原位不误沉底

### 修复

- `/ws`、`/order` 卡片分页降为 15 条/页，修复飞书 ErrCode 11310 元素超限
- workspace 排序相关 P2/P3 review findings 修复

## [0.1.3] - 2026-08-12

### 新增

- Agent 可用性探测：启动时自动检测本机已安装/可用的 Agent CLI（`which` 探测），不可用的 Agent 会在 `/config` 卡片中标注；探测失败不阻塞启动，打开 `/config` 时会重试
- 首次运行引导：PIN 绑定成功后自动设置默认工作目录，并发送欢迎卡片 + 帮助卡片
- `message.patch` 业务码可观测性探针
- Context 统计支持显示占比：codex 上报 `context window` 上限时，卡片按百分比展示上下文用量

### 修复

- `displayTitle`/`summary` 跳过 task-notification 注入
- 修复 `scanClaudeSessions` 对迁移到其他目录的会话的遗漏（S2）
- 修复 probe 生命周期、工厂回退、卡片回调等评审发现的问题（F1-F8）
- 清理引用已删除文档（lessons-redlines、resume-card-budget-failure-analysis）导致的失效链接

### 变更

- 提取 `createAgentRegistries` 工厂，统一各 Agent 注册逻辑
- 移除 Agent 二进制路径配置，CLI 名称改为硬编码
- 移除 `pnpm-lock.yaml`，统一使用 `bun.lock` 管理依赖
- 新增 husky lint-staged pre-commit / pre-push 钩子（提交前 lint + typecheck）
- 启用 npm provenance（构建产物可溯源）
- 移除 watchdog 相关用户文档及 `open-source-playbook` 等临时文档

### 测试

- 合并 stub 工厂、净化 fixtures、移除冗余测试
- 新增 P1-15 configContainer 锚点测试（含 codex 负向断言）

## [0.1.2] - 2026-08-10

### 修复

- claude / opencode / kimi 的 Agent 工厂改为从 `configContainer` 读取配置，避免使用过期闭包导致配置不生效（P1-15）
- codex / kimi 的 `readSessionContent` 增加 cwd 校验，防止越界读取会话
- `listClaudeSessions` / `isClaudeSessionActive` 支持跨目录回退，处理会话迁移后的定位
- 修复 `handleQueueInput` 竞态：替换任务在 await 之前注册
- 完成卡片 `resume.use` 携带 agent 字段，确保会话 reader 路由正确

### 维护

- 升级 `@vitest/coverage-v8` 至 4.1.10
- 移除 CLI 子进程 smoke test，清理测试套件

## [0.1.1] - 2026-08-09

版本号 0.1.0 → 0.1.1，无用户可见功能变更。

## [0.1.0] - 2026-08-06

Initial release.

### Added

- Feishu private-chat ↔ local coding agent bridge (Claude Code / Codex / opencode / pi / Kimi)
- CardKit 2.0 single-card streaming: one card per run, updated in place via `im.v1.message.patch`
- Run card: thinking, text, tool summaries; terminal states (done/error/interrupted/idle_timeout/finalizing)
- Bash card: `!<cmd>` executes bash with streaming card output (bypasses serial queue)
- Serial work queue + stop control lane for concurrency safety
- 5 agent runners with JSONL/NDJSON parsing, lifecycle management, and orphan process handling
- 5 session readers with unified contract (`listSessions`/`readSessionContent`)
- `/config` interactive card (agent-aware): switch agent, model, reasoning effort, idle watchdog
- `/order` global prompt storage with `order.exec` dispatch
- `/resume` paginated session list with per-agent filtering
- `/active` in-memory dashboard of running sessions
- `/cd`, `/ls` (paginated file browser), `/ws` (workspace aliases)
- `/restart` in-place self-restart with process handoff
- `/stop` immediate SIGKILL; stop button on run cards
- QR-code scan-to-create wizard for first-time Feishu app setup
- Single-instance lock per config directory
- Startup notification to most recent private chat
- Session persistence across bridge restarts (`last-session.json`)
- Agent switch session restore with `previousSessions`/`arrivalSessions` dual-field design
- Idle watchdog with configurable timeout
- Run card progressive degradation under 28KB budget (text > thinking > tools)
- 28KB+ budget enforcement using `Buffer.byteLength` (UTF-8)
- Dedup TTL workaround for SDK `safety.dedup` toggle button issue
- `classifyRejection` for SDK throttle/detach rejection (recoverable 4xx → log only)
- `SpawnHeartbeat` for spawn-stage stall detection (30s, log-only)
- Atomic file writes (tmp + rename, EXDEV fallback)
- Daily log rotation (file-only, no stdout)
- Node.js 20+ compatible (zero Bun runtime APIs in src/)
- Bilingual documentation (Chinese + English)
- MIT License

### Security

- Full-permission agent execution (hardcoded `bypassPermissions`/`approval_policy=never`)
- Designed for single-user p2p private chat only — never add bot to group chats
- Credentials stored locally in `config.yaml`, never committed to repository
- Live Feishu API tests gated behind `FEISHU_LIVE_TEST=1` (external contributors can run full test suite without credentials)

[0.1.0]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.0
[0.1.1]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.1
[0.1.2]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.2
[0.1.3]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.3
[0.1.4]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.4
[0.1.5]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.5
[0.1.6]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.6
[0.1.7]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.7
[0.1.8]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.8

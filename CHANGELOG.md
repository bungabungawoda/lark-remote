# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

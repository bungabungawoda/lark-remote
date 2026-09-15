# Contributing to lark-remote

[English](#english) | [简体中文](#简体中文)

---

## English

Thank you for your interest in contributing to lark-remote! This document provides guidelines for contributions.

### Prerequisites

- **Node.js ≥ 20** (no Bun runtime APIs in `src/`; Bun is used only as a dev task runner)
- **Bun** (for running dev commands — `bun run dev`, `bun run test`, etc.)
- A Feishu (Lark) account with app credentials for live testing

### Development Setup

```bash
git clone https://github.com/bungabungawoda/lark-remote.git
cd lark-remote
bun install
```

### Commands

| Command | Description |
|---------|-------------|
| `bun run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `bun run test` | Run tests (vitest) — **must use `bun run test`, not `bun test`** |
| `bun run lint` | ESLint check |
| `bun run lint:fix` | ESLint auto-fix |
| `bun run format:check` | Prettier check |
| `bun run format` | Prettier auto-format |
| `bun run build` | Build (`rm -rf dist && tsc`) |
| `bun run dev` | Start lark-remote in dev mode |

**After any code change, you must run `typecheck` then `test`. Both must pass.**

### Pull Request Process

1. Fork the repository and create a feature branch
2. Make your changes with appropriate tests
3. Ensure `bun run typecheck && bun run test && bun run lint && bun run format:check` all pass
4. Submit a pull request with a clear description of the change

### Testing Notes

- Tests use vitest and are co-located with source files (`*.test.ts`)
- **Live Feishu API tests** require `FEISHU_LIVE_TEST=1` — they are skipped by default so external contributors can run the full test suite without credentials. They make real external calls (real messages are sent to the configured chat), which is why they never run in the default gate.
- **Zero-skip full run (including real Feishu sends)**: `FEISHU_LIVE_TEST=1 bun run test`
  - Prerequisites: `~/.lark-remote-test/config.yaml` with Feishu credentials (live suites only use this isolated dir — your real `~/.lark-remote` is untouched), `startup-contact.json` in the same dir supplying the target `chatId` (messages really are sent to that chat), and a working `ps` (p1-10's pid-identity check).
  - The default `bun run test` skips 17 cases, all under `tests/feishu-live/**` (`FEISHU_LIVE_TEST` unset).
  - ⚠️ **Don't trust the exit code alone**: with `FEISHU_LIVE_TEST=1` but a missing config/chatId, live cases silently `return` from `beforeEach` (printing `⚠️ 跳过: …`) — "passed" without testing anything. Grep the output for `⚠️ 跳过`.
  - Platform gates cut both ways: POSIX-only cases skip on Windows and Windows-only ones (`describeWin32`) skip on macOS, so no single platform is 100% skip-free. Cross-platform changes must run on both; there are no Windows-only cases today, so on macOS `FEISHU_LIVE_TEST=1` gives a zero-skip run.
  - If a live suite mirrors a production payload dispatch (e.g. a real-delivery `bridge.sendResult` stub), it must cover **every** branch (card / markdown / text) **and** assert the payload shape (`expect(sent.card).toBeDefined()`, `expect(sent.text).toBeUndefined()`). Gated suites never run by default, so when production changes a notification's form (text ↔ card) the stub drifts silently and only the next manual live run reveals it — 2026-09-11 instance: after the agent-switch notice became a card, a text-only stub sent an empty text, the real API rejected it, production fell back to its documented toast, and "success path must not return a toast" failed.
- **Never run a real coding agent from a test**: a test must not spawn a real `claude` / `codex` / `opencode` / `pi` / `kimi` / `dsh` CLI to execute a model turn. Agent-facing input always comes from a mock or fake — `tests/lib/path-mock.ts` (Node launchers), `tests/lib/mock-acp-server.ts` (ACP; carries the `MOCK_ASSERT` outbound wire-shape guards), `tests/fake-app-server/server.mjs` (codex). Three reasons, all binding: real model calls cost tokens/money; model output is nondeterministic and slow, so it cannot serve as a gate; and the gate must stay green on a bare machine with no CLI installed and nobody logged in. When real-machine verification is genuinely needed, do it **by hand, once**, capture the wire sample, and replay it offline as a synthetic fixture (see `tests/anchor/kimi/kimi-session-tool-events.test.ts`). `tests/anchor/kimi/kimi-acp-live.test.ts` was removed on 2026-09-11 under this rule. Boundary: `tests/feishu-live/**` stays — it makes real **API** calls (network), not model calls, and is isolated through `~/.lark-remote-test`.
- Mock-based tests cover all critical paths (CardKit 2.0 schema validation, runner lifecycle, queue behavior)
- **Shared test infrastructure is typechecked**: `tsconfig.json` only includes `src` and excludes `src/**/*.test.ts`, so `tsc --noEmit` alone never sees test code. `bun run typecheck` therefore runs a **second pass** (`tsc -p tsconfig.test-infra.json`, standalone: `bun run typecheck:test-infra`) over the reusable stub/fixture factories — `tests/lib/**` plus `tests/feishu-live/live-helpers.ts`. Those files are consumed by dozens of suites, so a signature drifting from production types silently mis-types every consumer. Widen the include set carefully: sweeping in all of `tests/**` currently surfaces 400+ pre-existing errors.
- **Cross-platform fixtures**: mocks of agent CLIs live in `tests/lib/path-mock.ts` and are always Node launchers — `writeMockBin(dir, name, entry)` takes a **Node entry path**, and mock bodies go through `writeMockSource`. When changing that contract, audit every call site (`rg "writeMockBin|writeMockSource" tests src`) and re-run the full suite on a non-Windows host: `describePosix`-gated tests are skipped on Windows, so the Windows suite alone cannot catch missed call sites.

### Code Style

- TypeScript strict mode
- Follow existing patterns in the codebase
- No `as unknown as` double casting in tests — use seam interfaces
- CardKit 2.0 cards must pass the V1-action-container regression test (`expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/)`)

---

## 简体中文

感谢你对 lark-remote 的贡献兴趣！本文档提供贡献指南。

### 前置条件

- **Node.js ≥ 20**（`src/` 不使用任何 Bun 运行时 API；Bun 仅作为开发任务运行器）
- **Bun**（运行开发命令 — `bun run dev`、`bun run test` 等）
- 飞书账号及应用凭据（用于 live 测试）

### 开发环境搭建

```bash
git clone https://github.com/bungabungawoda/lark-remote.git
cd lark-remote
bun install
```

### 命令

| 命令 | 说明 |
|------|------|
| `bun run typecheck` | TypeScript 类型检查 (`tsc --noEmit`) |
| `bun run test` | 运行测试 (vitest) — **必须用 `bun run test`，不能用 `bun test`** |
| `bun run lint` | ESLint 检查 |
| `bun run lint:fix` | ESLint 自动修复 |
| `bun run format:check` | Prettier 检查 |
| `bun run format` | Prettier 自动格式化 |
| `bun run build` | 构建 (`rm -rf dist && tsc`) |
| `bun run dev` | 开发模式启动 lark-remote |

**改代码后必须先 `typecheck` 再 `test`，都过才算完成。**

### Pull Request 流程

1. Fork 仓库并创建 feature 分支
2. 修改代码并添加相应测试
3. 确保 `bun run typecheck && bun run test && bun run lint && bun run format:check` 全部通过
4. 提交 PR，附上清晰的变更说明

### 测试注意事项

- 测试使用 vitest，与源码同目录（`*.test.ts`）
- **飞书 API 实测**需设置 `FEISHU_LIVE_TEST=1` — 默认跳过，外部贡献者无需凭据即可跑全量测试。它是真实外部调用（消息**真的**发到配置的会话），故不进默认门禁。
- **零 skip 全量（含真发飞书）**：`FEISHU_LIVE_TEST=1 bun run test`
  - 前置：`~/.lark-remote-test/config.yaml` 含飞书凭据（live 用例只用这个隔离目录，不碰真实 `~/.lark-remote`）；同目录 `startup-contact.json` 提供目标 `chatId`（消息**真的**发到那个会话）；宿主 `ps` 可用（p1-10 的 pid 身份校验）。
  - 默认的 `bun run test` 会 skip 17 个用例，全部在 `tests/feishu-live/**`（`FEISHU_LIVE_TEST` 未设）。
  - ⚠️ **不能只看 exit code**：设了 `FEISHU_LIVE_TEST=1` 但配置/chatId 缺失时，live 用例会在 `beforeEach` 里静默 `return`（打印 `⚠️ 跳过: …`），结果是「通过但什么都没测」。要检查输出里有没有 `⚠️ 跳过`。
  - 平台门控是双向的：POSIX-only 用例在 Windows 上 skip，Windows-only（`describeWin32`）在 macOS 上 skip，**任意单一平台都不可能 100% 零 skip**。跨平台改动要在两个平台各跑一次（当前无 Windows-only 用例，故 macOS 上设 `FEISHU_LIVE_TEST=1` 即为零 skip）。
  - live 用例里若镜像了生产的**载荷分派**（如真实投递的 `bridge.sendResult` stub），必须覆盖 card / markdown / text **全部分支**，并**把载荷形状写成断言**（`expect(sent.card).toBeDefined()`、`expect(sent.text).toBeUndefined()`）。门控用例默认永不执行，生产换了通知形式（text ↔ card）后 stub 会静默漂移，只有下次手动跑 live 才暴露——2026-09-11 实例：切换通知卡片化后，只认 text 的 stub 把卡片当空文本发出 → 真实 API 拒绝 → 生产按设计兜底 toast →「成功路径不得返回 toast」假红。
- **测试禁止真跑 coding agent**：测试进程不得 spawn 真实的 `claude` / `codex` / `opencode` / `pi` / `kimi` / `dsh` CLI 去跑模型 turn。面向 agent 的输入一律来自 mock / fake——`tests/lib/path-mock.ts`（Node 启动器）、`tests/lib/mock-acp-server.ts`（ACP，含 `MOCK_ASSERT` 出站 wire-shape 断言）、`tests/fake-app-server/server.mjs`（codex）。三条理由缺一不可：真调模型消耗 token / 花钱；模型输出不确定且慢，无法作为门禁；门禁必须能在没装 CLI、没人登录的裸环境跑绿。确需真机验证时，**由人手工跑一次**、采集 wire 样本、脱敏后作为合成 fixture 离线回放（见 `tests/anchor/kimi/kimi-session-tool-events.test.ts`）。`tests/anchor/kimi/kimi-acp-live.test.ts` 已于 2026-09-11 按此规则删除。边界：`tests/feishu-live/**` 保留——它调的是真实 **API**（网络），不是模型，且用 `~/.lark-remote-test` 隔离。
- Mock 测试覆盖所有关键路径（CardKit 2.0 schema 验证、runner 生命周期、队列行为）
- **共享测试基建也进类型门禁**：`tsconfig.json` 只 include `src` 且 exclude `src/**/*.test.ts`，所以单跑 `tsc --noEmit` 永远看不到测试代码。`bun run typecheck` 因此加了**第二遍**（`tsc -p tsconfig.test-infra.json`，单跑：`bun run typecheck:test-infra`），覆盖被几十个套件复用的 stub/fixture 工厂——`tests/lib/**` 加 `tests/feishu-live/live-helpers.ts`。这类文件一旦与生产类型漂移，会静默污染所有消费者。扩大范围要谨慎：把 `tests/**` 全量纳入目前会炸出 400+ 个既有错。
- **跨平台 fixture**：mock agent CLI 的 helper 在 `tests/lib/path-mock.ts`，产物恒为 Node 启动器——`writeMockBin(dir, name, entry)` 第三参是 **Node 入口文件路径**，mock 正文一律走 `writeMockSource`。改这个契约时必须核对全部调用点（`rg "writeMockBin|writeMockSource" tests src`）并在**非 Windows 宿主**复跑全量：`describePosix` 门控的用例在 Windows 上被 skip，只跑 Windows 套件发现不了漏改。

### 代码风格

- TypeScript strict 模式
- 遵循代码库已有模式
- 测试中禁止 `as unknown as` 双重类型转换 — 使用 seam interface
- CardKit 2.0 卡片必须通过 V1-action-container 回归测试（`expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/)`）

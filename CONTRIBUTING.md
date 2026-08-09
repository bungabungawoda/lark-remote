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
| `bun run dev` | Start bridge in dev mode |

**After any code change, you must run `typecheck` then `test`. Both must pass.**

### Pull Request Process

1. Fork the repository and create a feature branch
2. Make your changes with appropriate tests
3. Ensure `bun run typecheck && bun run test && bun run lint && bun run format:check` all pass
4. Submit a pull request with a clear description of the change

### Testing Notes

- Tests use vitest and are co-located with source files (`*.test.ts`)
- **Live Feishu API tests** require `FEISHU_LIVE_TEST=1` — they are skipped by default so external contributors can run the full test suite without credentials
- Mock-based tests cover all critical paths (CardKit 2.0 schema validation, runner lifecycle, queue behavior)

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
| `bun run dev` | 开发模式启动 bridge |

**改代码后必须先 `typecheck` 再 `test`，都过才算完成。**

### Pull Request 流程

1. Fork 仓库并创建 feature 分支
2. 修改代码并添加相应测试
3. 确保 `bun run typecheck && bun run test && bun run lint && bun run format:check` 全部通过
4. 提交 PR，附上清晰的变更说明

### 测试注意事项

- 测试使用 vitest，与源码同目录（`*.test.ts`）
- **飞书 API 实测**需设置 `FEISHU_LIVE_TEST=1` — 默认跳过，外部贡献者无需凭据即可跑全量测试
- Mock 测试覆盖所有关键路径（CardKit 2.0 schema 验证、runner 生命周期、队列行为）

### 代码风格

- TypeScript strict 模式
- 遵循代码库已有模式
- 测试中禁止 `as unknown as` 双重类型转换 — 使用 seam interface
- CardKit 2.0 卡片必须通过 V1-action-container 回归测试（`expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/)`）

# lark-remote

English | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/lark-remote.svg)](https://www.npmjs.com/package/lark-remote)
[![CI](https://github.com/bungabungawoda/lark-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/bungabungawoda/lark-remote/actions/workflows/ci.yml)

A bridge between Feishu (Lark) private chat and local coding agents. Talk to Claude Code (or Codex / opencode / pi / Kimi) from Feishu — the agent reads/writes files and runs commands in a local directory you pick, with execution streamed live into a single CardKit 2.0 card.

Designed for a single-user, peer-to-peer private chat. The agent's system prompt is never modified.

![Streaming card demo](docs/images/demo.gif)

> **New here? Start with [docs/en/getting-started.md](docs/en/getting-started.md).**

## ⚠️ Security Warning (read first)

This tool turns Feishu messages directly into local agent executions. Claude runs with **full permissions** by default (fixed `bypassPermissions`); Codex uses the **app-server approval mode** (default `approvalPolicy=on-request` — command execution requires your confirmation on the Feishu card, sandbox defaults to `workspace-write`), which is relatively safe; other agents run with their CLI defaults. Agents can still read and write the local directories you specify. You MUST:

- **Use it only in your own private (p2p) chat.** Never add the bot to any group chat; never let anyone else talk to it.
- Restrict the app's visibility to **yourself only** in the Feishu Open Platform.
- Don't run it on a machine holding data you can't afford to lose; prefer a dedicated user / machine / container.
- Keep credentials such as `appSecret` in your local `config.yaml` only — **never commit them anywhere**.

In Codex approval mode, an approval card arrives before any command runs — approve or reject it right in Feishu:

![Codex command approval card example](docs/images/approval-card.png)

## Prerequisites

- OS: macOS / Linux. **Windows is not supported yet** (relies on POSIX behaviors such as Unix signals, bash, and file locks)
- Node.js 20+ ([Bun](https://bun.sh/) for development)
- A Feishu custom app (either way): scan-to-create (a QR code pops up in the terminal on first launch; scan it with the Feishu app to create the app and write credentials automatically); or create one manually in the Open Platform — enable bot capability, subscribe to `im.message.receive_v1` and `card.action.trigger` via **long connection** (WebSocket, no public address needed), with at least the `im:message` scope.
- Claude Code CLI installed locally and logged in once in a terminal (`claude` → browser OAuth). Same idea for other agents (codex / opencode / pi / kimi): install the corresponding CLI first.

## Installation

Option 1: npm / npx (no clone needed):

```bash
npx lark-remote          # run directly
# or install globally
npm install -g lark-remote
lark-remote
```

Option 2: from source:

```bash
git clone https://github.com/bungabungawoda/lark-remote.git
cd lark-remote
bun install
bun run build
bun install -g "$(pwd)"  # install globally as the lark-remote command (bun parses `.` as an empty package name; use an absolute path)
```

## Configuration

On first launch, if no Feishu credentials are found: an interactive terminal enters the scan-to-create wizard (a QR code is printed; scan it with the Feishu app to create the app, write credentials, and continue startup); non-interactive environments generate a template at `~/.lark-remote/config.yaml` and exit — fill in your credentials and restart. See [`docs/en/usage.md`](docs/en/usage.md) for all fields. Key options:

```yaml
feishu:
  appId: cli_xxx
  appSecret: xxx

# default agent: claude | codex | opencode | pi | kimi (default: claude)
defaultAgent: claude

claude:
  model: claude-opus-4-8
  effort: medium            # low | medium | high | xhigh | max
  # permissionMode is hardcoded to bypassPermissions (inside the runner)
  stopGraceMs: 5000

output:
  showThinking: true
  showToolUse: true
  showToolResult: true

logging:
  level: info               # debug | info | warn | error

idle:
  watchdogMinutes: 15       # 0 disables the idle timeout auto-stop
```

Override the config directory with `--config-dir <path>`; override the Claude settings path with `--settings <path>` or the `CLAUDE_SETTINGS_PATH` environment variable.

## Running

```bash
lark-remote                                     # after global install / via npx
bun run dev                                     # development (run TS directly with bun)
bun run build && node dist/index.js             # run the compiled output

# CLI flags
lark-remote --config-dir ~/.lark-remote-test    # custom config dir (multiple instances on one machine)
lark-remote --settings ~/.claude/settings.json  # specify Claude settings file
```

The bridge prints nothing to the terminal after startup; logs go to `~/.lark-remote/logs/YYYY-MM-DD/lark-remote-<pid>.log` (rotated daily, one subdirectory per day). Only one `lark-remote` instance is allowed per `configDir` — a duplicate start fails with the existing pid. After connecting to Feishu, a startup notification (with start time and pid) is sent to the most recent private chat.

Each agent run creates one CardKit 2.0 card that updates in place with thinking, body text, and tool summaries in real time.
Timestamps are read from the JSONL and shown in local time as `YYYY-MM-DD HH:mm` for thinking, body, tool call/result, and session history events.
The card clearly shows completion, error, interruption, or idle timeout at the end; the in-card "⏹ Stop" button is equivalent to `/stop`.
Cards use a lossy rolling summary — very long histories are not kept in full.
Your original message also gets an emoji reaction: `Typing` while the run is in progress, then the terminal-state emoji at the end — `Done` (finished), `ERROR` (failed), `Alarm` (idle timeout), or `SHHH` (you stopped it with `/stop`). `!` bash commands always end with `Done`.

## Commands

| Command | Alias | Behavior |
|---------|-------|----------|
| `/help` | `/h` | Command list |
| `/cd <path>` | - | Switch agent working directory (`~`, absolute/relative; clears the session) |
| `/ls [dir]` | - | Directory/file card; click a directory to switch, click a file ≤30MB to send it to Feishu; paginates beyond 30 entries |
| `/ws save\|use\|remove` | - | Named directory aliases (`/ws` lists by default) |
| `/resume [agent] [N\|id]` | `/r` | List/switch agent sessions for the current directory (card) |
| `/active` | - | List all running sessions |
| `/new` | - | Clear the current session (keeps cwd) |
| `/status` | `/s` | Current directory, session, model, process status |
| `/stop` | `/t` | Kill the current agent process (SIGKILL) |
| `/ps` | - | Whether a process is running |
| `/reconnect` | - | Reconnect to Feishu |
| `/restart` | - | In-place bridge self-restart (new process takes over with the same config) |
| `/config get\|set` | `/c` | View/change runtime config (agent-aware card) |
| `/order save\|list` | `/o` | Save or list frequently used prompts |
| `!<cmd>` | - | Run a bash command with streaming card output (bypasses the serial queue) |
| `/exit` | `/e` | Exit the bridge |

Any message not starting with `/` is forwarded to the current default agent.

## Testing

```bash
bun run test          # vitest (unit/integration tests, all run offline)
bun run typecheck     # tsc --noEmit
bun run lint          # eslint

# Live Feishu API integration tests (skipped by default; need valid
# credentials under ~/.lark-remote-test)
FEISHU_LIVE_TEST=1 bun run test tests/feishu-card-form-error.test.ts
FEISHU_LIVE_TEST=1 bun run test tests/feishu-reaction-emoji-live.test.ts
```

## Documentation

Full docs under [`docs/`](docs/):

- Getting started: [`docs/en/getting-started.md`](docs/en/getting-started.md)
- Usage guide (install, commands, workflows): [`docs/en/usage.md`](docs/en/usage.md)
- Overall design, JSONL events, known pitfalls: [`docs/en/architecture/design.md`](docs/en/architecture/design.md)
- Single-card streaming architecture and Feishu acceptance: [`docs/en/architecture/streaming-card.md`](docs/en/architecture/streaming-card.md)
- Template for adding a new agent: [`docs/en/guides/add-new-agent.md`](docs/en/guides/add-new-agent.md)
- Codex config card guide: [`docs/en/guides/codex-config.md`](docs/en/guides/codex-config.md)
- Feishu CardKit 2.0 component reference: [Official Feishu docs](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/component-json-v2-overview)

> This package is a CLI tool only — no programmatic API is exposed.

## Acknowledgments

This project was inspired by [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) — thanks for demonstrating the feasibility of bridging Feishu with local coding agents.

## License

[MIT](LICENSE) © bungabungawoda

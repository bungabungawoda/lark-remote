# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

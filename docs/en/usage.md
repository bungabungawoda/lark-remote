[简体中文](../zh/usage.md) | English

# Usage Guide

lark-remote turns Feishu private chat into a remote entry point for Claude Code CLI: send a message in Feishu, and the local Claude reads and writes files and runs commands in your specified directory, with responses sent back to Feishu.

Single-user, p2p private chat. Does not modify Claude's system prompt.

---

## 1. Prerequisites

1. **Node.js 20+**
2. **Feishu custom app** (one of two options)
   - **Recommended: Scan QR code to create** — on first launch, if no credentials are detected and the terminal is interactive, a QR code will be displayed. Scan it with the Feishu App to create the app and automatically write the credentials (see "Configuration" below).
   - **Manual creation**: Create a custom app on the Feishu Open Platform, enable the "Bot" capability, subscribe to events `im.message.receive_v1` and `card.action.trigger`, select "Long Connection" (WebSocket, no public URL required) as the subscription method, grant at least the `im:message` permission, then fill the App ID / App Secret into the configuration file.
3. **Claude Code CLI**
   - Installed locally
   - Complete a login in the terminal (run `claude` → browser OAuth)

---

## 2. Installation

```bash
git clone <repo> lark-remote
cd lark-remote
bun install
bun run build
```

You can also install globally as a CLI tool, then run `lark-remote` directly:

```bash
bun install -g "$(pwd)"   # Relative path `.` is resolved by bun as an empty package name (unsafe name), so an absolute path is required
lark-remote
```

---

## 3. Configuration

First launch behaves differently depending on the environment:

- **Interactive terminal with no credentials**: Enters the QR code creation wizard. The terminal prints a QR code; scan it with the Feishu App to create the app. Credentials are automatically written to the configuration file, and startup continues. No need to manually create an app on the Open Platform.
- **Non-interactive environment (e.g., CI, pipeline, redirected stdin) or existing configuration**: When no credentials are present, a template is automatically generated at `~/.lark-remote/config.yaml` and the process exits. Fill in the Feishu credentials and restart.

Complete configuration file fields:

```yaml
feishu:
  appId: cli_xxx            # Feishu app App ID
  appSecret: xxx            # Feishu app App Secret

# Default agent: claude | codex | opencode | pi | kimi, defaults to claude
defaultAgent: claude

claude:
  binary: claude            # Path to the claude CLI executable
  model: claude-opus-4-8    # Model
  effort: medium            # Reasoning effort: low | medium | high | xhigh | max
  # permissionMode is hardcoded as bypassPermissions (inside runner), not configurable via config
  stopGraceMs: 5000         # SIGTERM→SIGKILL grace period for watchdog auto-finish (milliseconds)

output:
  showThinking: true        # Whether to send thinking blocks
  showToolUse: true         # Whether to display tool calls
  showToolResult: true      # Whether to display tool results

logging:
  level: info               # debug | info | warn | error

idle:
  watchdogMinutes: 15       # Idle watchdog, 0 to disable
```

The configuration file path can be overridden with the `--config-dir` CLI parameter (e.g., `lark-remote --config-dir /path/to/dir`).

> **Do not commit the real config.yaml to the repository.**

---

## 4. Running

```bash
bun run dev      # Development (bun runs TS directly)
lark-remote      # Use directly after global install
```

The bridge produces no terminal output after startup. Runtime logs are written to `~/.lark-remote/logs/` (see below). Only one instance is allowed per `configDir`; a second launch will exit and report the existing pid. After successfully connecting to Feishu, the bridge sends a startup notification to the most recent private chat user, including the startup time and process ID.

Logs rotate daily and are stored at `~/.lark-remote/logs/YYYY-MM-DD/lark-remote-<pid>.log` (one subdirectory per day; path derived from configDir; level configured via `logging.level`).

---

## 5. Commands

Any message not starting with `/` is forwarded to Claude. Messages starting with `/` are treated as built-in commands. **Some commands support single-letter aliases** (`/help /h`, `/status /s`, `/stop /t`, `/exit /e`, `/resume /r`, `/config /c`, `/order /o`):

| Command | Alias | Behavior |
|---------|-------|----------|
| `/help` | `/h` | Show command list |
| `/cd <path>` | - | Switch Claude's working directory (supports `~`, absolute/relative paths; clears current session, next message starts a new conversation) |
| `/cd` | - | Without arguments, shows the current directory |
| `/ls` | - | Pop up a directory/file card; click a directory to browse, click a file under 30MB to send it to Feishu |
| `/ws save <name>` | - | Save the current directory as a named alias |
| `/ws use <name>` | - | Switch to the alias directory (clears session) |
| `/ws remove <name>` | - | Remove an alias |
| `/ws` `/ws list` | - | List all aliases (card with "Use" and "Remove" buttons) |
| `/resume [agent] [N]` | `/r` | List/switch agent sessions in the current directory (card, paginated, default 5 per page) |
| `/resume <id>` | - | Manually switch to a specific session id |
| `/active` | - | List in-progress tasks in the current process memory (including agent tasks and bash commands) |
| `/new` | - | Clear the current session (clears `sessionId` + `sessionCwds`, **working directory preserved**), next message starts a new conversation |
| `/status` | `/s` | Show working directory, session directory (if different), session, model, process status |
| `/stop` | `/t` | Terminate the current agent process (SIGTERM then immediate SIGKILL, no grace wait) |
| `/ps` | - | Check whether a process is running |
| `/reconnect` | - | Reconnect to Feishu WebSocket |
| `/config` | `/c` | View configuration (interactive card; boolean values toggle on click, others use button selection) |
| `/order save <text>` | `/o` | Save a frequently used instruction |
| `/order` `/order list` | `/o` | List saved instructions |
| `/exit` | `/e` | Exit the bridge |
| `/restart` | - | Restart the bridge in place: the new process takes over with the same config, startup notification arrives shortly |

### Command Details

#### `/cd` and `/ls`: Directory Navigation

- **`/cd <path>`** supports `~` (expanded to home directory), absolute paths, and relative paths (relative to current directory). Switching clears the session because `--resume` would restore Claude's memory of the old cwd; not clearing would cause file read/write confusion.
- **`/ls [dir]`** returns a CardKit 2.0 card listing **all** subdirectories and files in the current directory; pass `[dir]` to list a specific subdirectory (equivalent to bash `ls <dir>`). Clicking a directory button browses that directory (`ls.browse`, does not switch cwd); the "Switch" button changes the working directory to the currently browsed absolute path (`ls.switch`, validates that the target exists and is a directory). Clicking a file button uploads files under 30MB and sends them to the current Feishu private chat; files exceeding the limit return an error message.

#### `/ws`: Workspace Aliases

Save frequently used directories as short names, avoiding typing long paths each time. Aliases are persisted in `~/.lark-remote/workspace.json` (atomic write: write to temp file then rename).

```text
/ws save proj        # Save current directory as "proj"
/ws use proj         # Switch to the proj directory
/ws                  # Card showing all aliases (equivalent to /ws list)
/ws remove proj      # Remove proj
```

#### `/resume`: Switching Historical Sessions

Each agent's (claude/codex/opencode/pi/kimi) conversation has a session id. The bridge remembers it after each run and uses `--resume` to continue with the next message. `/resume` is used to switch between historical sessions:

- **`/resume`** or **`/resume list`**: List sessions for the current agent in the current directory (card, sorted by most recently used, 5 per page with pagination; click a button to switch). The current session is marked with ✓.
- **`/resume <agent>`**: View the session list for a specific agent (e.g., `/resume codex`).
- **`/resume <N>`**: Override the page size to N (clamped to `[1, 5]`, e.g., `/resume 3`).
- **`/resume <id>`**: Manually switch to a specific session id (requires setting the working directory with `/cd` first).

```text
/resume              # Card with paginated session list for the current directory (5 per page)
[Click the "bbbb1234-xxxx-xxxx-xxxx-xxxxxxxxxxxx fix bug" button]
/resume codex        # View codex session list
/resume aaaa5678     # Manually switch to another session
```

> `/cd`, `/ws use`, and clicking to switch directories in `/ls` all clear the session (start a new conversation, section 9.1), because `--resume` restores Claude's memory of the old cwd, and resuming a session across directories causes file read/write confusion. To resume an old session, switch to the corresponding directory first, then use `/resume`. When Claude uses `EnterWorktree` within a session, it relocates to the worktree; `/s` displays the "Session directory" to show the actual location, and `/new` returns to the working directory.

#### `/stop`: Terminating a Process

`/stop` uses a dedicated control channel and will not queue behind the current Claude run. It calls `runner.stop({ immediate: true })`: SIGTERM followed immediately by SIGKILL, **no grace wait** (`stopGraceMs` only serves the idle-watchdog auto-finish path, default 5s, not user-adjustable). The "⏹ Stop" button on the run card behaves identically.

#### `/restart`: Restarting the Bridge

`/restart` restarts the bridge process in place: while the old process still holds the lock, it spawns a detached successor (inheriting the same command-line arguments, i.e., the same `--config-dir`), replies with "♻️ Bridge restarting (new process pid N), startup notification will arrive shortly...", then exits cleanly and releases the singleton lock; the new process waits for the old one to die before acquiring the lock normally (waits up to 20s; on timeout it still attempts to acquire — if the old process is truly still alive, it will hit the lock and exit, so two instances cannot coexist). After restart completes, a startup notification is sent to the most recent private chat contact.

- **No single-letter alias**: `/r` remains assigned to `/resume`. Use the full `/restart` command (the `/restart` button on the `/help` card behaves identically to typing it).
- **Please `/stop` or wait for tasks to complete before restarting**: In-progress claude/bash runs are not preserved; when the old process exits, its in-memory state is lost (sessions in jsonl files remain and can be resumed via `/resume`).
- **Spawn failure does not exit the old process**: If the successor cannot be launched (e.g., log directory not writable), you will receive "Restart failed: ..., old process is still running", and the bridge continues serving.
- **Development mode note**: `bun run dev` restarts from source, `bun dist/cli.js` restarts from dist — if you modify code and `/restart` without `bun run build`, the new process still runs the old dist.

---

## 6. Workflow Examples

### Scenario 1: Remote Code Editing

```text
You: /cd ~/projects/my-app
You: Check the main function in src/index.ts and add error handling
Claude: [Reads file → modifies → shows diff]
You: Run the tests
Claude: [Runs npm test → returns results]
```

### Scenario 2: Multi-Project Switching

```text
You: /ws save backend ~/projects/api
You: /ws save frontend ~/projects/web
You: /ws use backend
You: Restart the service
Claude: ...
You: /ws use frontend
You: Restart this one too
Claude: ...
```

### Scenario 3: Card Navigation

```text
You: /cd ~/projects
You: /ls
[Card: my-app | api | web | ...]
You: [Click the "my-app" button]
Bot: Switched to: /Users/you/code/my-app
You: Start it up now
```

---

## 7. Output Format

Each Claude run creates only one CardKit 2.0 card on the normal path and continuously updates it in place:

- **thinking**: Controlled by `showThinking`; title displays local timestamp
- **Body**: Retains the latest scrolling window; local timestamp displayed before the body
- **tool_use / tool_result**: Controlled by `showToolUse` / `showToolResult`; older tools auto-collapse; tool title displays local timestamp
- **Run state**: Thinking, calling tools, or producing output
- **Terminal state**: Completed, error, interrupted, idle timeout; terminal state removes the stop button
- **Emoji reaction**: On your original message, `Typing` is added during processing; at completion, the terminal state determines the final emoji: `Done` (completed) / `ERROR` (error) / `Alarm` (idle timeout) / `SHHH` (user `/stop`). Bash (`!`) commands always get `Done`. Keys come from the official Feishu emoji list; new terminal state mappings require同步 anchor tests.

Cards have a strict UTF-8 byte budget and are lossy progress summaries, not complete transcripts.

---

## 8. Error Handling

| Situation | Behavior |
|-----------|----------|
| claude process killed externally | Bridge reports error but does not crash; next message is processed normally |
| claude produces no output for a long time (hung) | 15-minute idle watchdog auto-terminates the process; original card shows timeout; queue unblocks |
| Bridge exits abnormally | Orphaned claude processes are cleaned up (on startup, pid file is read to kill orphans) |
| Duplicate launch with same configDir | Second instance exits immediately and reports existing pid |
| Feishu rate limiting (99991400) | Automatically sleeps 200ms and retries once |
| `/ls` file send failure | Returns `Failed to send file: ...`; files over 30MB are rejected before upload |
| Concurrent message arrival | Processed serially (Promise chain); will not start multiple claude processes |
| Sending a message after `/cd` | Session is cleared; a new conversation starts (without `--resume`) |

---

## 9. Testing

```bash
bun run test        # vitest all tests
bun run typecheck   # tsc --noEmit static check
```

Test coverage: config, session, workspace, runner (JSONL parsing + exit code), card (state machine, rendering, stream lifecycle), bridge (work queue + control lane + watchdog + degradation), router, and integration.

---

## 10. Further Documentation

| Want to learn about | Where to look |
|---------------------|---------------|
| Overall design, JSONL events, pitfalls | [`architecture/design.md`](architecture/design.md) |
| Single-card streaming architecture and Feishu validation | [`architecture/streaming-card.md`](architecture/streaming-card.md) |
| New agent integration template | [`guides/add-new-agent.md`](guides/add-new-agent.md) |
| Codex configuration card guide | [`guides/codex-config.md`](guides/codex-config.md) |
| Feishu CardKit 2.0 component reference | [Feishu Open Platform official docs](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/component-json-v2-overview) |
| Getting started | [`getting-started.md`](getting-started.md) |

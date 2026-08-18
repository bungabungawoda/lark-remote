[简体中文](../../zh/architecture/design.md) | English

# lark-remote Design Document

Bridges Feishu private chat messages to the local Claude Code CLI. When a user sends a message or `/command`, the program passes the message to a `claude` process, reads the JSONL output, and updates thinking / text / tool summaries in real time on a single Feishu card. All Feishu I/O is handled by the program; it does not modify Claude's system prompt and only supports p2p private chat, single user.

---

## 1. Prerequisites

**Feishu custom app**: Enable bot capability, subscribe to `im.message.receive_v1` and `card.action.trigger` events, select "Long Connection" (WebSocket, no public URL required) as the subscription method. Requires at least the `im:message` permission.

**Claude Code CLI**: Installed locally with one login completed in the terminal (`claude` -> browser OAuth). The bridge does not handle OAuth; an unauthenticated first run will cause the claude process to hang.

**Tech stack**: Node.js 20+, TypeScript, `@larksuite/channel` (Feishu WebSocket long connection + message/card API), `axios` (file upload/send and other direct `open-apis/im/v1/*` REST calls), `zod` + `yaml` (configuration).

---

## 2. Architecture

```
Feishu Server
    │ WebSocket (@larksuite/channel SDK)
    ▼
InstanceLock             Only one bridge main process per configDir
    │
FeishuConnector          Receive p2p message + cardAction, send/update cards/files
    │
StartupContact           Record most recent private chat; send notification with startup time and pid after connection
    │
Bridge                   Normal work queue + stop control lane; non-command messages → forwardToClaude
    │                       getRunner() via AgentRegistry, sendCompletionNotificationCard via SessionReaderRegistry
CommandRouter            /-prefixed → built-in handler; otherwise delegate to bridge.forwardToClaude
    │                       session reads via SessionReaderRegistry (not direct claude/sessions import)
    │
ClaudeRunner             spawn claude -p, parse JSONL, check process terminal state, yield AgentEvent
    │
RunCardSession           RunState reduce → CardKit 2.0 render → patch original message
    │
FeishuConnector.streamCard() / updateCard()
```

---

## 3. Claude Process Invocation

```bash
claude \
  -p "<user_message>" \
  --output-format stream-json \
  --verbose \
  --permission-mode bypassPermissions \
  [--resume <session_id>] \
  [--model <model>] \
  [--settings <settings_json_path>]
```

- `--verbose`: **Must be included**, otherwise JSONL will not contain `thinking` blocks
- `--settings`: Optional, specifies the Claude configuration file (passed via CLI argument `--settings`, or auto-detected from `CLAUDE_SETTINGS_PATH` environment variable / `~/.claude/settings.json`)
- `cwd`: Passed via spawn's `cwd` option, not written into the prompt
- `stdin`: Must be set to `'ignore'`, otherwise the process may hang waiting for input

**JSONL event types (one JSON per line):**

```
{ type:'system',    subtype:'init',    session_id, cwd, model }
{ type:'assistant', message:{ content:[
    { type:'thinking', thinking:'...' },
    { type:'text',     text:'...' },
    { type:'tool_use', id, name, input }
  ]}}
{ type:'user',      message:{ content:[
    { type:'tool_result', tool_use_id, content, is_error }
  ]}}
{ type:'result',    subtype:'success'|'error', session_id, usage, total_cost_usd }
```

Within a single run, assistant -> user (tool_result) -> assistant can loop for multiple turns.

---

## 4. Session Management

In-memory Map, keyed by userId (open_id):

```typescript
interface SessionEntry {
  sessions: Map<AgentKind, string>;        // one sessionId per agent
  previousSessions: Map<AgentKind, string>; // parked session when switching away (restored after `/config` agent switch)
  arrivalSessions: Map<AgentKind, string>;  // arrival baseline: the sessionId the user last received when switching to this agent
  sessionCwds: Map<AgentKind, string>;      // session actual cwd (system.init event.cwd; only claude may differ from cwd)
  cwd: string;                              // controlled working directory (realpath)
}
const sessions = new Map<string, SessionEntry>();
```

- When `system.init` arrives, only `sessionId` and `sessionCwds[agent]` (the session's actual directory) are synced; `cwd` (the controlled working directory) retains the value passed when the bridge spawned Claude and **is never overwritten by `event.cwd`**; if Claude reports a cwd mismatch (e.g., after `EnterWorktree` relocate on resume), only log INFO, and `/s` displays "session directory" when they differ
- Next message includes `--resume sessionId`
- `/new` only clears `sessionId` + `sessionCwds`, keeping the current `cwd`
- `/cd` and `/ws use` **must clear sessionId** (see pitfall §9.1)
- When `/config` switches `defaultAgent`: the old agent's sessionId is parked in `previousSessions`, the new agent restores from its `arrivalSessions` baseline; switching back restores the parked session
- `<configDir>/last-session.json` persists all 5 fields; any missing field is treated as corrupt and skipped; bridge restart restores cwd + last-used sessionId

---

## 5. Command List

| Command | Behavior |
|---------|----------|
| `/new` | Clear session (keep cwd) |
| `/cd <path>` | Switch cwd, clear session |
| `/ls [dir]` | Pop up directory/file card; click directory to switch, click file under 30MB to send to Feishu; >30 items paginated |
| `/ws save/use/remove` | Named directory alias management (`/ws` defaults to list) |
| `/resume [list\|id]` | List/switch current agent's sessions (`/resume [agent] [N]` two-argument form, N clamped to [1,5] as page size); list paginated (`resume.page` callback for page navigation) |
| `/active` | List in-progress tasks (Agent + Bash) in this process's memory |
| `/status` | Show cwd, session_id, model, process status |
| `/stop` | SIGTERM then immediately SIGKILL (no grace wait) |
| `/ps` | Whether a process is running |
| `/help` | Command list |
| `/exit` | Exit bridge |
| `/reconnect` | Reconnect WebSocket |
| `/restart` | In-place self-restart bridge: spawn detached successor → old process releases instance lock and exits |
| `/config get\|set` | Query/modify runtime config (card interaction, agent-aware fields) |
| `/order save\|list` | Save or list frequent prompts |
| `!<cmd>` | Execute bash command with streaming output to card (bypasses serial queue) |

---

## 6. Card Interaction

### 6.1 `/ls` Card Construction (CardKit 2.0)

Uses **CardKit 2.0** format — interactive components are attached directly to `body.elements`, callbacks use `behaviors:[{type:"callback", value:{cmd,key}}]`, and the channel SDK reads from `action.formValue`/`action.option`, no `includeRawEvent` needed.

```json
{
  "schema": "2.0",
  "header": { "title": { "tag": "plain_text", "content": "📂 /path/to/cwd" } },
  "body": {
    "elements": [
      { "tag": "div", "text": { "tag": "lark_md", "content": "`/path/to/cwd`\n共 N 个子目录" } },
      { "tag": "hr" },
      { "tag": "div", "text": { "tag": "lark_md", "content": "**A**" } },
      {
        "tag": "button",
        "text": { "tag": "plain_text", "content": "apple" },
        "type": "default",
        "behaviors": [{ "type": "callback", "value": { "cmd": "ls.switch", "path": "/absolute/path/to/apple" } }]
      }
    ]
  }
}
```

Subdirectories and files are bucketed by first character (A-Z / `0-9` / `#`), with a lark_md heading before each bucket, and each button within the bucket laid flat in `body.elements` (wrapping in `action` container is forbidden — it triggers error 200861). Browse subdirectory buttons use `{ cmd: "ls.browse" }` (browsing doesn't switch cwd, refreshes the card in place), "switch" buttons use `{ cmd: "ls.switch" }` (existence check then switches cwd), file buttons use `{ cmd: "ls.file" }`. When a file is clicked, the router first verifies the target exists, is a file, and does not exceed 30MB, then the connector uploads and sends it to the current Feishu private chat. Regular files uploaded to `im/v1/files` use `file_type` of `stream`, and when sending via `im/v1/messages`, `receive_id_type` is `chat_id`.

### 6.2 cardAction Event Handling

After receiving a card click, extract the payload from `action.action.value`:

```typescript
channel.on('cardAction', async (action) => {
  const value = action.action.value as { cmd: string; path?: string; name?: string; sessionId?: string };
  if (value.cmd === 'ls.switch') {
    // Security check then switch cwd
  } else if (value.cmd === 'ls.browse') {
    // Browse directory (don't switch cwd, refresh card in place)
  } else if (value.cmd === 'ws.use') {
    // Execute /ws use <name>
  } else if (value.cmd === 'resume.use') {
    // Execute /resume <sessionId>
  } else if (value.cmd === 'resume.page') {
    // /resume list pagination (value: { agent, offset, pageSize }, updateCardInPlace)
  }
});
```

### 6.3 CardKit 2.0 Is the Only Standard

This project uses CardKit 2.0 exclusively (no 1.x code paths remain). 2.0 card constraints:
- Interactive components (button/select_static/input) **attach directly to body.elements**, wrapping in `action` container is forbidden
- Callbacks uniformly use `behaviors:[{type:"callback",value:{cmd,key}}]`
- Streaming output doesn't need tabs; content is arranged inline
- SDK 0.3.0+ reads payload from `action.action.value`, select selection from `action.option`, input value from `action.formValue` (the input submit icon's `input_value` is dropped by the normalizer — read from `action.raw.action.input_value` with `includeRawEvent: true`)

### 6.4 `/ws` Card

Uses CardKit 2.0, two buttons per alias:

```json
{ "cmd": "ws.use",    "name": "proj-a" }
{ "cmd": "ws.remove", "name": "proj-a" }
```

### 6.5 Claude Run Card

Each Claude run creates only one CardKit 2.0 card on the normal path. `channel.stream` sends the initial card first, then patches the entire card via `message_id`. During the run, thinking, main text, tool summaries, status line, and stop button are displayed; on terminal state, the header changes and the status line and buttons are removed.

The stop button payload is `{ "cmd": "stop", "runId": "<uuid>" }`. The entry point must validate `runId + operator.openId + chatId` and bypass the normal work queue, otherwise the stop would be queued behind the current run and unable to interrupt it.

---

## 7. Output Formatting

Claude conversation output is constructed as a CardKit 2.0 card by `RunState` and `renderRunCard`:

- thinking, text, tool use/result are reduced in JSONL order, preserving event `timestamp`;
- When live `stream-json` events lack a timestamp, `createJSONLStream` fills in the event arrival time;
- Card timestamps are uniformly displayed in local time `YYYY-MM-DD HH:mm`;
- `showThinking`, `showToolUse`, `showToolResult` continue to control visible content;
- Long content uses sliding window, truncation, tool folding, `collapsible_panel` visual folding, and UTF-8 byte budget;
- The card is a lossy progress summary; the complete transcript is not currently persisted;
- SDK applies throttle and FIFO UpdateQueue for patches;
- result.success / result.error → finalizing (not a terminal state, CLI may still be waiting for background tasks);
  After the CLI process exits, the bridge's finally block transitions to done/error; non-zero exit or exhaustion without result → error;
- The normal path no longer sends multiple markdown/text messages, nor does it send an end separator.

---

## 8. Configuration

```yaml
feishu:
  appId: cli_xxx
  appSecret: xxx

# Default agent: claude | codex | opencode | pi | kimi
# Determines which agent the bridge spawns and which agent name the run card header displays
defaultAgent: claude

claude:
  model: claude-opus-4-8
  effort: medium           # low | medium | high | xhigh | max
  permissionMode: bypassPermissions  # Claude official --permission-mode: default | acceptEdits | auto | bypassPermissions | manual | dontAsk | plan (switchable via /config card)
  stopGraceMs: 5000

codex:
  approvalPolicy: on-request  # Codex official AskForApproval: untrusted | on-request | never (default on-request)
  sandbox: workspace-write  # Codex official SandboxMode: read-only | workspace-write | danger-full-access (default workspace-write)

output:
  showThinking: true
  showToolUse: true
  showToolResult: true

logging:
  level: info             # debug | info | warn | error

idle:
  watchdogMinutes: 15     # 0 disables the idle watchdog
```

When `feishu.appId`/`appSecret` is not detected on first launch: interactive terminal (both stdin/stdout are TTY) goes through the scan-to-create wizard (`src/config/wizard.ts`, calling `@larksuite/channel`'s `registerApp`), which prints a QR code in the terminal; the user scans it with the Feishu App to create the app, and the returned `client_id`/`client_secret` is written back to the config file before continuing startup; non-interactive environments (no TTY) fall through to `loadConfig` which generates a template and exits.

---

## 9. Known Pitfalls

### 9.1 `/cd` Must Clear session_id

`claude --resume <session_id>` restores the context from Claude's memory (including the old cwd). If `session_id` is not cleared after `/cd`, Claude's remembered directory and the actual spawn cwd will be inconsistent, causing file read/write errors. Both `/cd` and `/ws use` must clear session_id.

`/cd` path resolution must expand `~` first: `path.resolve` does not recognize `~`, and passing `~/projects` directly would be treated as a relative path, resulting in `<bridge process.cwd()>/~/projects` (e.g., `/Users/.../lark-remote/~/projects`). `cmdCd` uses `path.join(os.homedir(), target.slice(1))` to preprocess `~`-prefixed input.

### 9.2 Missing `--verbose` Causes No Thinking Output

`--output-format stream-json` does not output thinking blocks by default; `--verbose` must also be included. Additionally, the model must support extended thinking (`claude-haiku-4-5` has no thinking).

### 9.3 Claude First Run Requires OAuth

`claude -p` triggers interactive browser OAuth when not logged in; with `stdin=ignore`, the process hangs or exits with an error. The bridge cannot perform this step on behalf of the user — if OAuth is incomplete on first launch, it will be logged and the user must run `claude` in the terminal manually to complete login.

### 9.4 JSONL Last Line May Lack Newline

When claude exits abnormally, the last chunk of stdout data may lack a trailing `\n`, and `readline` would drop that line. Use manual buffer handling: split by `\n` in the `data` event, store the last segment as `partialLine`, and manually flush on `stdout 'close'`.

### 9.5 Feishu Rate Limiting (Error Code 99991400)

New message sending is approximately 5 req/s. `sendWithRetry` retries once after sleeping 200ms for retryable errors: SDK's `rate_limited` (HTTP 429, SDK has built-in backoff retry, this is just a fallback), and Feishu business codes 99991400/99991401 (frequency control) — the latter are classified as `permission_denied` by `@larksuite/channel@0.3.0`'s `classifyError`, and the SDK fail-fasts on `permission_denied`. `shouldRetrySendError` must identify them from the `cause` chain (`cause.response.data.code`) to prevent the rate-limit retry path from dying. Regular `permission_denied` (e.g., missing scope) is not retried. Run card patches are controlled by the channel SDK's throttle + FIFO UpdateQueue; disabling tool use/result display by default further reduces card update volume.

### 9.6 Serial Message Processing

Concurrently processing multiple messages would cause multiple claude processes to compete for sessions and Feishu replies to arrive out of order. `Bridge.enqueue` uses a Promise chain to guarantee serial processing of normal messages and normal cardActions:

```typescript
// src/bridge/index.ts
enqueue(task: () => Promise<void>): void {
  this.queue = this.queue
    .then(() => task())
    .catch((err) => getLogger().error('[bridge] queue task error:', err));
}
```

`/stop` and stop cardAction are control operations that must bypass this Promise chain and call `Bridge.interruptCurrentRun()` directly. The active run stores runId/userId/chatId to prevent stale cards or other sessions from terminating the current run.

**Lanes share the same source as execution cwd**: Lane keys are partitioned by the `sessionStore` cwd at enqueue time, while slash commands like `/cd`, `/ws use`, `ls.switch` bypass the queue and immediately modify cwd. If `forwardToClaude` re-resolves cwd at execution time, a race condition occurs where two parallel lanes both resolve to the new cwd — the first occupies `activeRuns`, the second gets busy-dropped, and the queued message is silently lost. Fix: the `index.ts` enqueue closure passes the `workspace` at enqueue time as `cwdOverride` explicitly to `router.handle` → `bridge.forwardToClaude`; at execution time, the lane takes precedence (empty string falls back to `resolveCwd`). `finalizeRun` cleanup (`activeRuns.delete` + runner slot reclaim) executes in the `try/finally`'s finally block (review): even if `renderRunCard` throws during finalization, it must not leave a permanently busy workspace.

**Batch 6 P1 semantics**:
- Completion notification card: `sendCompletionNotificationCard` reads session content with `maxEvents: 5`, sends via `sendResult` (with `enforceCardBudget` as fallback), no longer directly calls the connector — long session cards will no longer exceed 28KB and be silently rejected by Feishu.
- Bash `!` process: `BashProcessRunner` registers to the process-level exit dispatcher during the process's lifetime (same source as the 5 agent runners); on `/restart`/SIGTERM, it group-kills bash and its child processes; on `run()` completion it unregisters — `!sleep 3600` will no longer become orphaned.
- Caching: session read caching uniformly uses "TTL based on cache write time + bounded LRU/FIFO".

### 9.7 `/ls` Switch Target: Aligned with Browse, No Subtree Restriction

`ls.switch` (switch cwd) is aligned with `ls.browse`/`ls.file`, only verifying "target exists and is a directory", no longer requiring the target to be an **any-depth descendant** or **parent directory** of cwd. Reasons:

1. **Sibling handlers already have equivalent capability**: `ls.browse` can browse any directory, `ls.file` can upload any file <=30MB. An attacker who passes owner authentication doesn't need `ls.switch` to achieve equal or greater harm.
2. **The real boundary is owner authentication** (`src/binder.ts`): both messages and card callbacks are strongly validated against a single owner openId (`isOwner(operator.openId)` in `src/index.ts`); subtree validation is redundant defense-in-depth.

```typescript
// handleLsSwitch validation logic (src/router/index.ts):
const resolvedTarget = path.resolve(targetPath);
if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isDirectory()) {
  return `Invalid path: ${resolvedTarget}`;
}
const canonical = fs.realpathSync(resolvedTarget); // cwd stored in canonical form
this.sessionStore.setCwd(ctx.userId, canonical);
```

> Note: The original `isParentDir` + realpath prefix matching validation (only allowing any-depth descendants + direct parent) has been deleted, and the `isParentDir` function has been removed synchronously. Residual risk (cwd can be switched to any directory) is mitigated by `binder` owner authentication.

### 9.8 Feishu Duplicate Delivery and cardAction Deduplication

Feishu WebSocket provides at-least-once delivery; the same event may be pushed multiple times. SDK `@larksuite/channel`'s `safety.dedup` (`SeenCache`: in-memory LRU + injectable long-term cache) handles deduplication: `pushMessage` uses `msg.messageId`, `pushAction` uses `card:{messageId}:{operator.openId}:{actionId}` as the seenCache key; duplicates arriving within the TTL are silently dropped. The project configures `dedup.ttl = DEDUP_TTL_MS` (300ms) in `src/connector/index.ts`.

**cardAction dedup design flaw**: `actionId = tag|name|option|JSON.stringify(value)`, which **does not include timestamp/event sequence/messageId**. When the same user clicks the same button on the same card, all three segments of the eventId are identical → the second click is treated as a duplicate by seenCache and dropped, and the handler is not executed.

**High-risk scenario for in-place card updates**: `updateCardInPlace` does not send a new card; the user always operates on the same card. Config card toggle buttons (`{cmd:'config.toggle', key: field.key}`) have fixed callback values. When a user clicks twice in succession (e.g., "show tool results" on→off→on):
- First click: eventId not in cache → toggle takes effect → card changes to "disabled" → finally adds eventId to seenCache
- Second click (within TTL): eventId already in cache → **drop duplicate action** → toggle not executed → card stuck at "disabled"

`configActionQueue` (`src/router/index.ts`) serialization cannot help — the dropped event never reaches the router.

**Solution: Reduce `DEDUP_TTL_MS`** (SDK does not support per-event-type configuration; ttl applies globally to message + cardAction). 300ms blocks Feishu's momentary redelivery (<100ms level) while allowing user double-clicks (slow double-clicks are typically >500ms). Trade-off: weakened protection against second-level message redelivery — but Feishu WS does not normally resend during active connections, and reconnection catch-up delays are often >60s which can't be blocked anyway. The serial queue (§9.6) provides fallback protection against concurrency, so the impact is acceptable. SDK default is 12h; the project previously used 60s, both of which would incorrectly suppress double-clicks.

**Dedup risk classification for in-place update logic** (reference for adding new in-place update buttons; use solution 1 — small TTL window dedup — uniformly):

| callback value | Risk | Notes |
|----------------|------|-------|
| Fixed (`config.toggle`/`config.set`/`config.input`/`config.save`/`new-session`) | **High** | Second click being dropped causes stuck state with no recovery within TTL; relies on `DEDUP_TTL_MS` small window to pass through |
| Contains dynamic fields (`stop`→runId, `queue.*`→messageId, `resume.use`→sessionId, `*.cd`→path, `ws.*`→name, `order.*`→orderId) | Low | Different targets produce different actionIds naturally safe; same-target double-click drop is idempotent and harmless |

**Guidelines for adding new in-place update buttons**:
1. callback values should include dynamic fields (runId/path/sessionId, etc.) whenever possible, so that different operations naturally have different actionIds;
2. For toggle-type buttons with fixed values (which inevitably exist), do not increase `DEDUP_TTL_MS` (>500ms may incorrectly suppress slow double-clicks);
3. Buttons requiring idempotent double-clicks (e.g., `order.exec`) — even if solution 1 lets the double-click through, the serial queue/runId validation provides fallback, causing no damage.

**Cannot reproduce in stub connector tests**: Tests call `router.handleCardAction` directly, bypassing the SDK safety layer; stubs don't simulate dedup. Relies on `DEDUP_TTL_MS` constant range assertions (`src/connector/dedup-config.test.ts`) to prevent regression + the documentation constraints in this section.

### 9.9 Process and Singleton

Only one bridge main process can run simultaneously per `configDir`. On startup, `InstanceLock` reads `<configDir>/lark-remote.pid`: if the pid is still alive, it refuses to start; if the pid no longer exists, it overwrites the stale lock; on process exit, only the lock belonging to the current pid is cleaned up.

When the bridge crashes, agent child processes become orphans. On startup, read `<configDir>/<agent>-*.pid` (isolated by workspace, P1-9), first verify process identity (`ps -o command=` matching binary to prevent pid reuse mistaken kills, P1-10), then send SIGTERM to the entire process group; on bridge exit (`process.on('exit'|'SIGINT'|'SIGTERM')`), send SIGTERM+SIGKILL cleanup to the process group and delete pid files.

### 9.10 workspace.json Write Atomicity

If the process crashes while `/ws save` is writing the file, it could produce truncated JSON. Write to a temporary file then `fs.rename` (atomic operation). On startup, JSON parse failure is treated as an empty store, and the user is notified "corrupted config has been reset".

### 9.11 Log Persistence and Rotation

`src/logger/` singleton `Logger`, **writes only to files, not stdout/stderr**. Logs rotate by local date (auto-switching files at midnight): directory is `<configDir>/logs/YYYY-MM-DD/`, filename is `lark-remote-<pid>.log` (date in directory name, not filename). Log directory is derived from `configDir` (`<configDir>/logs`), not separately configurable. Level is controlled by `logging.level`. Synchronous writes (`fs.appendFileSync`); log volume is small, no buffer flushing needed.

Fatal errors in `config/index.ts` **before** logger initialization (template generation, validation failure) and `config/wizard.ts` scan-code wizard interaction still use `console.*` (stderr/stdout), because the logger is not yet ready; all other modules must use `getLogger()`, and no new `console.*` should be added.

### 9.12 Claude Idle Watchdog

`Bridge.forwardToClaude` attaches a 15-minute idle timer on the `runner.run()` `for await` loop, resetting on each AgentEvent received. If the claude process has no stdout output for an extended period (typical symptom: process hangs, neither exiting nor producing events), the timer triggers `runner.stop()` and finalizes the original card as idle_timeout. This prevents a single stuck claude from permanently blocking the serial queue in §9.6, which would cause all subsequent messages to queue without processing. Constant `IDLE_TIMEOUT_MS = 15min` is at the top of `src/bridge/index.ts`. Window size is controlled by `config.idle.watchdogMinutes` (default 15, adjustable via the "Idle" tab in the `/config` card); setting to 0 means disabled (the card would still be finalized as idle_timeout, but it would never trigger).

**Difference from `/stop`**: When the watchdog triggers, it calls `runner.stop()` (without `immediate`), still going through the stopGraceMs (default 5s) waiting period for a graceful shutdown. `/stop` calls `runner.stop({ immediate: true })`, issuing SIGKILL immediately after SIGTERM with no grace wait — user-initiated stop never waits. Therefore `stopGraceMs` **only serves the watchdog's automatic finish path**; there is no longer a user command to control it (`/timeout` has been removed).

### 9.13 `/active` and `/resume` Session State Determination

**New semantics**: `/active` no longer scans the filesystem; it only shows active tasks in this bridge process's memory. Agent tasks are obtained via `Bridge.getActiveRuns()`, and Bash commands via `Bridge.getActiveBashRuns()`. Only tasks with `terminal` as `running` or `finalizing` are shown; completed tasks (done/error/interrupted) are not displayed. `/resume` and `/cd` / `/ws use` auto-resume cards use `readSessionContent` to read session content after the last user input. Background task state preferentially merges the in-memory `Bridge.getActiveRunFor(cwd)` active run from the current bridge process; memory state is only reused when `activeRun.sessionId === sessionId` and terminal is `finalizing`. JSONL serves as fallback: after `result` there is no `permission-mode`, or `system.away_summary` appears at the tail — both display as "finalizing" — but must be combined with mtime freshness check (`STALE_MS = 1h`, same source as `isSessionActive`): a file that hasn't been written to for over 1 hour cannot be from a still-running process. (Any completed normal turn ends with `result` and has no `permission-mode`; mtime gating is used to exclude such stale files.) The card's `stop` button, when `interruptCurrentRun` misses (runId mismatch or already exited), replies via `bridge.sendResult` with "task has ended, no need to stop", rather than silently returning.

If jsonl contains no user messages at all (very old/corrupted), fallback to reading the entire file instead of returning an empty card, to avoid `/resume use` getting a sessionId and then only showing a plain text "session_id has been set" without a history card.

**Usage data source (contextLength / compactCount)**: Context length and compaction count for the run card on completion (done/error/interrupted) are read from jsonl, not from stream-json — Claude CLI's stream-json does not emit `compact_boundary` events (they are only persisted to jsonl: `{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":N}}`), and the `result` event has no context length field. `Bridge.forwardToClaude`'s finish path calls `resolveFinalUsage(sessionId, cwd)`, which goes through `sessionReaderRegistry` to call `readSessionContent` to aggregate all `compact_boundary` events, yielding `compactCount = event count`; `contextLength = max(last compact's postTokens, last turn's complete prompt input+output+cacheRead+cacheCreation)` — postTokens is only accurate right after compaction and becomes stale as the session continues to grow; cache_read is the bulk of the prompt, and omitting it would cause severe underestimation. **Do not accumulate across all turns** (N turns accumulated produces N×context falsely huge values, regression 2ded6229: 55 turns accumulated 3,328,386, actual 79,816). `totalInput/totalOutput` are still accumulated, kept for reference.
The context length at the end of `/resume` uses the same source (`readSessionContent` shares `aggregateSessionUsage`).


`ClaudeRunner.run()` path probes (`src/runner/index.ts`):
- `spawn pid=... binary=... cwd=... sessionId=...` — spawn successful
- `spawn failed: ...` — `proc.once('error')` rejection
- `wrote pid file path=pid` — pid file written
- `sending SIGTERM to pid=...` / `cleaned pid file ...` — stop path
- `non-zero exit code=N stderr=...` — abnormal exit

**spawn-stage heartbeat** (critical): The window between successful spawn and the first line of stdout (approximately 30 seconds, OAuth popup unresponsive, stdio fd misalignment, cwd unreachable) is **not covered by §9.12 idle watchdog** — the watchdog is inside the `for await (runner.run())` loop and only starts after `runner.run` first yields an event. The spawn-stage heartbeat starts a 30-second timer **immediately** after spawn (WARN `spawn stage stalled`), and the timer is cleared when the first line of stdout arrives.

**No automatic stop**: spawn-stage stall typically requires user intervention (re-login OAuth or check cwd); automatic SIGTERM would confuse the user more. After detection, let the user decide `/stop` or `Ctrl+C` to re-login. This differs from §9.12 idle watchdog's automatic stop — the watchdog covers the window where the stream has already started emitting but stops advancing, which usually indicates an orphaned process.

`Bridge.forwardToClaude` path probes (`src/bridge/index.ts`):
- `forward entry userId=... cwd=... sessionId=... message=...`
- `workspace busy, dropping message userId=... cwd=...` — 2nd+ message dropped before queuing
- `activeRuns.set cwd=... runId=...` / `activeRuns.delete cwd=... runId=...` — add/delete pairing
- `cardSession.start() begin/ok runId=...` — card stream started
- `runner.run() begin runId=... message=...` — entering spawn stage
- `system.init received runId=... sessionId=...` — session_id obtained
- `result event received runId=...` — `result` event arrived (**not terminal**, CLI may be waiting for background task exit)
- `runner stream end runId=... sawResult=...` — stream ended
- `finally settle runId=... state.terminal=...` — finally block

**Critical invariant**: For the next similar event (queue blockage, activeRun stuck and not resetting, spawn hang), `activeRuns.delete cwd=... runId=...` must be logged — this is the only anchor point for reconstructing "whether cleanup completed" from logs. If this probe is missing, permanent blocking can occur silently.

Test coverage: `src/bridge/bridge.test.ts` `Bridge.forwardToClaude logging probes` group + `src/runner/claude/claude-runner.test.ts` `ClaudeRunner logging probes` group, using `vi.mock('../logger/index.js')` to replace `getLogger` with `vi.fn()`, asserting specific probe strings are called. Refactoring logger calls requires synchronously updating assertions.

### 9.16 `/active` In-Memory Implementation

> **New semantics**: The following content supersedes the old jsonl scanning approach. `/active` now only shows active tasks in this bridge process's memory.

**New implementation**: `/active` no longer scans all subdirectories of `~/.claude/projects/`.

- Data source: `Bridge.getActiveRuns()` (Agent tasks) + `Bridge.getActiveBashRuns()` (Bash commands)
- Determination logic: only includes tasks with `terminal` as `running` or `finalizing`
- Advantages:
  1. High certainty: not affected by filesystem state
  2. Clear semantics: users only see "what's running now"
  3. Consistent with `/stop`: both based on in-memory runId

**`Bridge.enqueue` defensive check**: Production logs repeatedly showed `[bridge] queue task error: TypeError: task is not a function`; root cause was non-function tasks slipping into the Promise chain and polluting the entire workspace queue. `enqueue` entry adds a `typeof task === 'function'` guard; non-functions get a warning + early return, not breaking subsequent task progression.

### 9.17 Card Folding (`collapsible_panel`)

Secondary information for all card types is wrapped in CardKit `collapsible_panel`; construction utilities are in `src/card/collapsible.ts` (`collapsiblePanel` / `collapsibleMarkdownPanel` / `markdownDiv`). Router-side shared utilities are in `src/router/card-helpers.ts` (`sessionEventPanel` / `formatTimestamp`).

**Key constraint**: Folding is **visual hiding**; the JSON payload still contains all content, and the 28KB byte budget (§9.14 `CARD_BUDGET_BYTES`) still applies. Folding reduces visual height, not serialized size.

**Run card folding strategy** (`src/card/run-renderer.ts` + `src/card/tool-render.ts`):

| Content | Folding behavior | Rationale |
|---------|-----------------|-----------|
| Thinking | Running: `expanded:true`; completed: `expanded:false` | Focus on progress during run; secondary info after completion |
| Running tools | `expanded:true`, border follows state (grey→red if error) | User needs to see real-time execution |
| Completed tools (<3) | `expanded:false` | Default collapsed, click to expand |
| Consecutive tool group (>=3) | Single collapsed panel, body only contains header list | See `collapsedToolSummary` |
| Main text block | Not folded, direct markdown | Claude's reply is the primary information |
| Terminal footer / Stop button | Not folded | Status summary must be visible |

**Tool rendering improvements** (`src/card/tool-render.ts`): Collapsed header displays a smart summary (e.g., `✅ **Bash** — pwd`, `✅ **Read** — /repo/a.ts`) with a local timestamp appended; not the meaningless `Tool0`. `toolHeaderText` extracts key fields by tool type; `toolBodyMd` renders structurally by type (Bash→command/output code blocks, Read→file_path, Grep→pattern/path). Truncation constants: `HEADER_SUMMARY_MAX=80`, `BODY_FIELD_MAX=600`, `OUTPUT_MAX=1200`, `BODY_TOTAL_MAX=2500`.

**Session content card folding** (auto-resume, `/resume <id>`): Each event is wrapped in `collapsible_panel`, with the last 2 expanded by default (user just resumed and needs to see the latest content), historical events collapsed.

**Dashboard card folding** (`/active`): Each session is wrapped in a collapsed panel, with the switch directory button placed outside the panel to remain operable. /active has been rewritten as an in-memory dashboard (`buildActiveCardFromMemory`), showing active tasks in the bridge process's memory, single card display.

**`/ls` folding**: When same-letter group has >5 entries, the entire group of buttons is wrapped in a collapsed panel.

**Streaming update limitation**: Run card updates via full-card patch (`controller.update()`), and each update resets `collapsible_panel`'s `expanded` state to the default. Running tools default to expanded (no user action needed); user-manually-expanded completed tool panels will collapse back on the next event — acceptable because new events usually mean context change. **Do not introduce incremental patches or state tracking** to preserve user expand state; the complexity is not worth it.

### 9.18 `!` Bash Command: Bypass Serial Queue + Single-Card Streaming

The `!` bash command does not start claude, does not touch session state, and the serial queue's design purpose (preventing concurrent claude) does not apply. Therefore `!` takes the immediate dispatch path in `src/index.ts` (same as slash commands), **not entering `Bridge.enqueue`**, and can run in parallel with a claude run on the same workspace.

**Dispatch** (`src/index.ts`): `/stop` → immediate; `/xxx` → immediate; `!xxx` → immediate (router calls `bridge.executeBash`); everything else → `bridge.enqueue` (claude).

**Tracking** (`src/bridge/index.ts`): bash runs use a separate `activeBashRuns: Map<runId, {bashRunner, userId, chatId, cwd}>`, indexed by **runId** (supporting multiple concurrent `!` on the same workspace), **not entering** `activeRuns` (claude-specific, single per cwd). The two are separated to avoid overwriting each other. `isBusy`/`isBusyFor`/`getAllActiveRuns`/`getActiveRunFor` only reflect `activeRuns`; bash does not appear in diagnostic cards / `/ps` view (but `/active` shows bash runs).

**`/stop`** (`interruptCurrentRun`): First iterates `activeRuns` (claude, calling `getRunner(cwd).stop` + `session.finish`), then iterates `activeBashRuns` (bash, calling `bashRunner.stop({ immediate: true })`). Bash cards are static streaming with no session.finish. Card stop buttons carry `runId`, precisely matching by userId/chatId/runId.

**Single-card streaming** (`src/card/bash-card-session.ts`): `BashCardSession` mirrors `RunCardSession`, creating one card via `connector.streamCard`, pushing stdout/stderr patches via `update()`, transitioning to terminal state via `finish()`, and waiting for stream close + `updateCard` fallback via `settle()`. **Do not** use multiple `sendWithRetry` calls (which would send multiple independent cards). Bash card running state has a "Stop" button; terminal state has no button (`src/card/bash-renderer.ts`).

**Deadlock history**: Previously `!` went through `enqueue → router → executeBash`, and `executeBash` reused `this.queues` for secondary queuing + `await taskDone`, forming a self-waiting deadlock (the enqueue's queue promise hadn't settled, executeBash waited for bashTask, bashTask hung behind that promise). After the fix, `executeBash` directly calls `await executeBashInternal`, no longer touching `this.queues`.

**SIGKILL exit detection** (`src/runner/bash/runner.ts`): When `/stop` kills the process with SIGKILL, `exitCode` remains `null` and only `signalCode` is set. The `run()` exit condition must be `proc.exitCode !== null || proc.signalCode !== null`, otherwise the loop spins idle and `executeBash` never resolves.

### 9.19 cardAction Dispatch Principle: Classify by Operation Semantics, Not by Trigger Method

**Correct mental model**: **Operations that do not produce Claude work, regardless of trigger method, should not enter the serial queue**.

The serial queue (`Bridge.enqueue`) exists to prevent concurrent spawning of multiple Claude processes (§9.6). Whether an operation needs to be queued depends on **whether it produces Claude work** (i.e., calls `forwardToClaude` to spawn a claude process), not whether it's triggered by a slash command or a cardAction.

Classification definitions:

| Category | Meaning | Queue behavior |
|----------|---------|----------------|
| **Control operation** | Does not spawn claude, only reads/writes session/workspace state | Queue-free (`enqueueImmediate` or direct execution) |
| **Work operation** | Spawns claude process or queues to wait for spawn | Serial queue (`enqueue`) |

Current implementation: the `isImmediateAction` allowlist (`src/router/index.ts`) follows this classification — control operations run queue-free, work operations (`order.exec`, normal messages) go through the serial queue.

### 9.20 SDK Throttle Patch Rejection Detach and unhandledRejection Fallback

Run card streaming patches go through SDK `@larksuite/channel`'s throttle + FIFO `UpdateQueue`. `Throttle.fireSoon` uses `setTimeout(() => this.doFire())` for delayed trigger; inside `doFire`, `(async () => { await this.fire(); })()` creates a **detached Promise** — its rejection is neither caught by `RunCardSession.update()`'s try-catch (`controller.update()` resolves immediately after calling `throttle.note()`, not waiting for the actual patch) nor awaited by the SDK internally. When a patch fails (e.g., Feishu 230027 "no permission to operate external chat", card not found, content exceeds limit), the rejection bubbles up to `process.unhandledRejection`.

**Fallback**: The unhandledRejection handler in `src/index.ts` calls `classifyRejection` (`src/error-classification.ts`, pure function for easy unit testing) to categorize:

| Classification | Condition | Behavior |
|----------------|-----------|----------|
| **recoverable** | 502/503/504/ETIMEDOUT/ECONNRESET; or Feishu 4xx business error (`status∈[400,500)` and `data.code` is numeric, e.g., 230027/230025) | Log only, process continues |
| **fatal** | TypeError and other programming errors; HTTP 5xx; pure HTTP 400 without Feishu code (not SDK patch path, real error) | Release lock + `exit(1)` |

Feishu 4xx business errors are classified as recoverable because they only affect a single card's patch attempt and should not bring down the entire bridge; subsequent patches may still succeed. 230027 was previously treated as fatal by the old handler, causing process exit.

**Refactoring reminder**: When modifying the handler / `classifyRejection`, preserve the detach escape regression test (`src/card/run-card-stream-error.test.ts`'s `test_anchor_sdk_throttle_detach_rejection_escapes_session`: simulates `controller.update` resolving immediately + `setTimeout` async fire of rejected patch, asserting rejection bubbles to `unhandledRejection`) and classification boundary tests (`src/error-classification.test.ts`). Old tests using `controller.update: async () => { throw }` synchronous throw **cannot reproduce detach** — must use `setTimeout` async fire to simulate SDK's real detached semantics.

### 9.21 Token Statistics Unified Caliber (ccusage Alignment)

Run card done statistics and `/resume` tail statistics share `formatUsageStats` (src/router/index.ts), uniformly aligned with [ccusage](https://github.com/sirmalloc/ccusage) token semantics. **Core invariants**:

- **`Total = max(totalTokens, input+output+cacheRead+cacheCreation)`**. Cannot revert to `input+output` — that would miss cache (codex/opencode's cache_read often accounts for 90%+ of input). When `totalTokens` is absent, total = sum of components (claude JSONL has no explicit total; the reader computes the component sum).
- **`input_tokens` everywhere represents "uncached input"**: codex derives it from `input_tokens − cached_input_tokens` (`src/session/codex/rollout-reader.ts` jsonl fallback); pi/opencode/claude's original values are already non-cached.
- **codex `total_token_usage` is session cumulative; `last_token_usage` is the single-turn incremental**: done card "this run" must use `last_token_usage` (when missing, derive from `total − prev_total`); cumulative uses the last `total_token_usage` in the main thread file. **Cannot** use "the last `token_count` event's `total_token_usage` to represent the last turn" — that's a cumulative value; on a long session resume, it would show the entire session's historical consumption as a single run (measured ~240x overstatement in practice).
- **Cache percentage**: `cacheRead/(input+cacheRead)` (input is already the uncached value, no need to subtract again).
- **Cache create row**: `cacheCreationTokens` (pi's `cacheWrite`, opencode's `tokens.cache.write`); codex is always 0.

**Passthrough chain and scope unification**: result event usage → `Bridge` extracts live values (claude native naming `cache_read_input_tokens`/`cache_creation_input_tokens` is compatible with unified naming); after process exit, `resolveFinalUsage` reads jsonl. **Flow fields (input/output/cache/total): when live has input/output, use live entirely (this-run scope); otherwise jsonl fallback.** The codex app-server `turn.completed` carries the protocol's `tokenUsage.last` (single-turn incremental, live scope), so it follows the same live-first rule as opencode; `contextLength`/`compactCount` always prefer jsonl (watermark/history count). A single card must not mix scopes (previously Input was this-run while Cache/Total were session cumulative, with cache% numerator and denominator from different sources).
→ `FinishMeta` → `RunState` → `run-renderer` passes to `formatUsageStats`.

**`/resume` populated by each session reader**: claude `aggregateSessionUsage` (`totalTokens` = component sum), pi `extractUsage` (`totalTokens = usage.totalTokens`), opencode reader (`cache.write`/`total`), codex `readCodexRollout` parses `token_count` events (`raw = last_token_usage ?? subtract(total, prev_total)`, tracking `previousTotals` for cumulative diff). When modifying token display, four readers + `formatUsageStats` + bridge must be kept consistent.

**contextLength**: claude/pi reader uses `max(last compact's postTokens, last turn's complete prompt input+output+cacheRead+cacheCreation)` — postTokens becomes stale as session grows (measured 85-95% underestimation); pi no longer uses pre-compaction `tokensBefore`; codex reader uses last turn's raw `input_tokens` (full prompt size including cache); bridge live path fallback `totalTokens ?? (input+cacheRead+cacheCreation+output)` (input is already uncached, cannot use just `input+output`).

### 9.22 `/resume` List Pagination

**Origin**: codex `/resume` list previously displayed an arbitrary walk subset (`listCodexRollouts` collected `limit*2` entries then broke and sorted; under APFS hash ordering, the newest directories were often skipped), and the total count displayed the truncated length.

**Reader contract** (`AgentSessionReader.listSessions`, unified across 5 agents):

```ts
listSessions(cwd: string, opts?: { limit?: number; offset?: number }): {
  sessions: AgentSession[]; // [offset, offset+limit) slice after mtime desc sort
  total: number;            // Full set size for cwd exact match (before pagination)
};
```

- Must first establish a **total order** by mtime desc on the **full set** before slicing; any early termination before establishing total order is wrong (§1.4 first principles).
- Negative offset is treated as 0 (all 5 readers use `Math.max(0, offset)` uniformly, preventing silent empty pages).
- `getNewestSession(cwd)` internally = `listSessions(cwd, { limit: 1 }).sessions[0] ?? null`.
- codex's `listCodexRollouts` returns `{ entries, total }`, based on `getSessionIndex` (full walk + first-line `session_meta` + stat mtime, 5s TTL), only fully parsing files within the page.
- kimi default limit 20, aligned with other agents.

**Router `/resume` pagination**:
- `RESUME_PAGE_SIZE = 5`; N in `/resume [agent] [N]` is clamped to `[1, 5]`, default 5.
- Pagination bar follows `/ls` structure: `Page x/y · N sessions total` + `Previous`/`Next` buttons, shown only when `total > pageSize`; N is the real total returned by the reader. Old fake prompt `Enter /resume N to see all` has been deleted.
- New callback `resume.page` (value `{ cmd, agent, offset, pageSize }`) → `handleResumePage` → `cmdResume(offset)` → `updateCardInPlace` refreshes in place; `resume.page` is an `isImmediateAction` whitelist member (control operation, queue-free). Missing agent field falls back to defaultAgent.
- Offset clamping: `[0, page-aligned last page start]` (last page start = `(ceil(total/pageSize)-1)*pageSize`, not `max(0, total-pageSize)` — the latter would produce a sliding window inconsistent with the pagination bar, violating "page navigation doesn't misalign"). After clamping, **pagination button values must use the clamped pageOffset for calculation** (otherwise clicking the previous button from an out-of-bounds page would clamp back to the last page again, causing the button to appear dead).
- `pageSize` is numerified and clamped to `[1, RESUME_PAGE_SIZE]` via handleResumePage; invalid values are not treated as sessionIds.
- Budget: 5 items per page × ~3 elements ≈ 15 elements (max 200), bytes well below 28KB.

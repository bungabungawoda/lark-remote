[简体中文](../../zh/architecture/streaming-card.md) | English

# Single-Card Streaming Architecture

Run/Bash card CardKit 2.0 single-card streaming architecture overview, covering data flow, state machine, rendering rules, budget control, and degradation strategy.

## 1. Goals

A single `claude -p` run creates only one CardKit 2.0 card on the Feishu side under normal paths:

- In-place updates for thinking, body text, and tool summaries during the run;
- Explicit terminal state distinction: done, error, interrupted, idle_timeout;
- The Claude process only outputs JSONL; it does not participate in card construction;
- Normal messages remain serialized; `/stop` and the stop button can immediately interrupt the current run.

A card is a lossy progress summary, not a complete transcript. Content beyond the sliding window is not persisted.

## 2. Verified SDK Mechanisms

The current dependency is `@larksuite/channel@0.1.2`.

`channel.stream(..., { card })` in card mode:

1. Sends an initial interactive card;
2. The producer receives a `CardStreamController`;
3. `controller.update(card)` updates the controller's current state, throttled by the SDK;
4. The SDK performs a full-card replacement on the same `message_id` via `im.v1.message.patch`;
5. After the producer returns, the SDK flushes the throttle and drains the FIFO update queue;
6. The `channel.stream()` Promise only resolves with `messageId` at the very end.

Therefore:

- CardKit 2.0 can achieve single-card updates via full-card patch;
- Controller ready does not mean the stream Promise has completed;
- `RunCardSession.start()` can only wait for controller ready, not for the entire stream;
- Cards do not write `streaming_mode` by default. Whether this field triggers client-side animations can only be verified on a real device.

## 3. Data Flow

```text
Normal Feishu message
  → Bridge work queue
  → ClaudeRunner.run()
  → AgentEvent
  → RunState reducer
  → renderRunCard()
  → CardStreamController.update()
  → Same message_id full-card patch

/stop or stop cardAction
  → control lane (bypasses work queue)
  → Bridge.interruptCurrentRun()
  → RunCardSession.finish(interrupted) + ClaudeRunner.stop()
```

Core modules:

| Module | Responsibility |
|--------|---------------|
| `src/card/run-state.ts` | AgentEvent → renderable state; idempotent terminal states |
| `src/card/run-renderer.ts` | RunState → CardKit 2.0 JSON |
| `src/card/run-card-session.ts` | controller-ready, producer-release, stream-done lifecycle |
| `src/bridge/index.ts` | Active run, watchdog, session sync, failure degradation |
| `src/connector/index.ts` | `streamCard()` and `updateCard()` SDK boundary |
| `src/index.ts` | Message entry point and stop control lane routing |

## 4. RunState

Key fields:

- `runId`
- `terminal`: running | finalizing | done | error | interrupted | idle_timeout
- `footer`: thinking | tool_running | streaming | null
- `reasoning`
- Ordered `blocks`: text or tool
- `resultSubtype`, `errorMsg`, `idleTimeoutMinutes`

Event transitions:

| Input | State change |
|-------|-------------|
| system.init | Record sessionId |
| assistant.thinking | Append reasoning, footer=thinking |
| assistant.text | Merge adjacent text, footer=streaming |
| assistant.tool_use | Add running tool, footer=tool_running |
| user.tool_result | Match tool id, set ok/error and output |
| result.success / result.error | finalizing (cache subtype/errorMsg, not terminal) |
| CLI process exit (for-await ends) + still finalizing | done / error (bridge finally transition) |
| Non-zero exit or run throws | error |
| stdout exhausted without result | error |
| `/stop` or stop button | interrupted (can transition from running or finalizing) |
| Idle watchdog | idle_timeout |

`finalizing` is a non-terminal state: Claude Code CLI 2.x writes a `result` event when the main turn ends, but if a `run_in_background` task was started within the turn, the CLI waits for the background task to exit before closing stream-json. So `result` no longer equals terminal state — only CLI process exit counts as truly complete. The card displays `⏳ Claude · Finalizing` (orange header), still showing a `⏹ Stop` button (which kills the main process + background child processes). New messages still queue in the workspace serial queue, not interrupting the background wait.

Terminal state is only written on first occurrence; subsequent result, watchdog, stop, or exception events must not overwrite it.

## 5. CardKit 2.0 Rendering

Running card:

1. Header: `🤖 Claude`
2. Optional thinking summary (title shows local time from JSONL timestamp)
3. text/tool blocks (body text prefix and tool title show local time)
4. Footer: thinking, invoking tool, or streaming
5. Danger stop button

Stop button payload:

```json
{ "cmd": "stop", "runId": "<uuid>" }
```

Terminal state cards:

| terminal | Header | Notes |
|----------|--------|-------|
| done | ✅ Claude · Done | subtype, empty content notice |
| error | ⚠️ Claude · Error | Error summary |
| interrupted | ⏹ Claude · Interrupted | Terminated by user |
| idle_timeout | ⏱ Claude · Timed out | Idle minutes |
| finalizing | ⏳ Claude · Finalizing | Non-terminal; **retains** ⏹ Stop button |

Terminal states do not render footer and stop button (except `finalizing`, see table above).

## 6. Long Content Budget

The state layer limits memory growth first, then the rendering layer truncates by UTF-8 byte size:

- Reasoning retains a limited window;
- Text retains the latest window;
- Tool input/output is truncated;
- Total block count has an upper limit;
- Consecutive tools beyond a threshold are collapsed;
- Whole card target is under 28KB; tests require under 30KB.

Budget uses `Buffer.byteLength(..., 'utf8')`; JavaScript string `.length` must not be used as a substitute.

## 7. Concurrency and Stop Control

Normal messages and normal cardActions continue entering the `Bridge.enqueue` Promise chain, ensuring at most one Claude run at a time.

Stop control must not enter that queue, otherwise it would wait until the current run completes. Entry rules:

- Exact `/stop` calls `interruptCurrentRun()` directly;
- Stop cardAction must carry runId;
- Bridge validates userId, chatId, runId;
- Stale cards, other users, or other chats cannot interrupt the current run;
- Both finish and runner.stop allow repeated calls.

Successful interruption does not send an additional confirmation text; the interrupted terminal state on the original card is the sole feedback.

## 8. Errors and Degradation

### Failure before initial send

Continue consuming Claude events; after the run ends, send a single static terminal card.

### Failure after initial send

Prefer calling `updateCard(messageId, finalCard)` to finalize the original card. Only when the original message also cannot be updated is a second fallback card allowed.

### Preventing permanent blocking

- Controller ready has a 5-second startup wait limit;
- Stream completion has a 5-second settle wait limit;
- Claude with no AgentEvent triggers the idle watchdog after 15 minutes by default (`IDLE_TIMEOUT_MS = 15 * 60 * 1000`);
- All Promise rejections are observed and logged.

Strict single-card is only guaranteed on the normal stream path; failure paths follow "prefer in-place finalization."

## 9. Configuration Semantics

- `showThinking`: Whether to render thinking
- `showToolUse`: Whether to render tool blocks
- `showToolResult`: Whether to render tool output

## 10. Automated Coverage

Extensive unit tests under `src/card/` and `src/bridge/` cover:

- success/error result, non-zero exit, missing result;
- Mixed content, tool result, all terminal states (done/error/interrupted/idle_timeout/finalizing) and idempotency;
- CardKit 2.0, runId, tool collapsing, Chinese/emoji UTF-8 byte budget;
- Stream lifecycle, startup/settle timeouts, degradation before and after initial send;
- Work queue, stop control lane, identity validation, and idle watchdog;
- Normal path single card without end separator;
- Throttle patch detach rejection unhandledRejection fallback.

Run tests: `bun test`; type check: `bun run typecheck`.

## 11. Feishu Integration

Real Feishu environment acceptance criteria (already live, maintained in regular iteration):

- CardKit 2.0 initial + patch;
- Stop action callback (bound to `runId`);
- done/error/interrupted/idle_timeout/finalizing client-side behavior;
- Chinese, emoji, many tools, and very long body text;
- Card schema, throttling (99991400), and final finalization.

External chat permission errors (230027) and other 4xx Feishu business errors are classified as recoverable by `classifyRejection`, only logged without exiting the process.

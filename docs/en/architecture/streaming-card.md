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

The current dependency is `@larksuite/channel@0.7.1`.

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
- `terminal`: running | finalizing | done | error | interrupted | idle_timeout | goal_continuing
- `footer`: thinking | tool_running | streaming | null
- `reasoning`
- Ordered `blocks`: text or tool
- `finalAnswer`: the protocol-marked or terminal-inferred answer, stored outside `blocks`
- `resultSubtype`, `errorMsg`, `idleTimeoutMinutes`

Event transitions:

| Input | State change |
|-------|-------------|
| system.init | Record sessionId |
| assistant.thinking | Append reasoning, footer=thinking |
| assistant.text | Merge adjacent text, footer=streaming |
| assistant.tool_use | Add running tool, footer=tool_running |
| user.tool_result | Match tool id, set ok/error and output |
| final_answer | Store `finalAnswer` and remove the streamed progress copy for the same item |
| result.success / result.error | finalizing (cache subtype/errorMsg, not terminal) |
| result without a final_answer marker | Promote the last non-empty assistant text to `finalAnswer` (source=inferred) |
| CLI process exit (for-await ends) + still finalizing | done / error (lark-remote finally transition) |
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
| goal_continuing | ⏳ Claude · Turn ended (goal continues) | The turn ended but the session's goal is still active: the task is not finished, the host starts the next round on its own; Compact is not rendered |

Terminal states do not render footer and stop button (except `finalizing`, see table above).

### 5.1 Goal view (DSH)

A DSH session can carry a long-running goal (the `goal` projection: objective / phase /
roundsStarted / maxGoalRounds). A goal is the **cross-turn** auto-continuation unit: within
milliseconds after `turn/end` the `goal-round-driver` may already have started the next round.
Therefore:

- A running card renders `🎯 **Goal in progress** · round r/N` plus the goal summary under the status line (a long goal goes into a collapsible panel);
- if the goal is still `active` when the run finalizes, the terminal state is `goal_continuing` (header "Turn ended (goal continues)") and the summary's first line reads "turn ended · goal still continuing" — "Done" never appears;
- no Compact button while the goal is `active`: DSH manual compaction requires an idle agent, so the click would always be rejected;
- `complete` / `paused` / `blocked` all mean "nothing continues automatically", so the run finalizes as a normal terminal state (blocked shows the blocking reason).

The data comes only from the host (the `goal` value in `session/projections`, `session/control` pushes and `goal/change` events). The bridge never infers "the task is finished" on its own.

## 6. Long Content Budget

The final answer outranks progress information. Terminal rendering:

1. Places status, approvals, and action controls first;
2. Places the complete `finalAnswer` next;
3. Uses only the remaining space for tools, plans, reasoning, and notices, newest first;
4. Omits the usage summary before declaring a physical overflow.

Codex app-server consumes `agentMessage.phase = "final_answer"` directly. Agents
without an explicit marker promote their last non-empty assistant text when the
turn finishes. Claude, opencode, Kimi, Pi, and DSH therefore share the same
protection.

The state layer still limits memory growth for ordinary progress content, then the rendering layer truncates by UTF-8 byte size:

- Reasoning retains a limited window;
- Ordinary text retains the latest window; `finalAnswer` is not evicted by that window or `MAX_BLOCKS`;
- Tool input/output is truncated;
- Total block count has an upper limit;
- Tool block count has its own upper limit (`MAX_BLOCKS`); each tool is a native collapsible panel (one title row by default) whose body ships with the card and is truncated by tool count;
- Whole card target is under 28KB; tests require under 30KB.

Budget uses `Buffer.byteLength(..., 'utf8')`; JavaScript string `.length` must not be used as a substitute.

If one card cannot hold even the final answer plus required controls, the card
shows `_最终回答较长，完整内容已随后发送_`. The bridge splits the complete
answer into plain-text messages at UTF-8 byte and line boundaries. Concatenating
those messages must reproduce the source exactly; silent truncation is not allowed.

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

- Thinking, tool_use and tool_result are always rendered (the legacy `output.show*`
  options were removed; there are no display toggles);
- `RunCardRenderOptions` only carries card-level metadata (`agentKind` for the header,
  `compactSupported` for the Compact button gate).

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

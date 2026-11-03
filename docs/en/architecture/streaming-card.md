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

| Module                         | Responsibility                                            |
| ------------------------------ | --------------------------------------------------------- |
| `src/card/run-state.ts`        | AgentEvent → renderable state; idempotent terminal states |
| `src/card/run-renderer.ts`     | RunState → CardKit 2.0 JSON                               |
| `src/card/run-card-session.ts` | controller-ready, producer-release, stream-done lifecycle |
| `src/bridge/index.ts`          | Active run, watchdog, session sync, failure degradation   |
| `src/connector/index.ts`       | `streamCard()` and `updateCard()` SDK boundary            |
| `src/index.ts`                 | Message entry point and stop control lane routing         |

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

| Input                                                | State change                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| system.init                                          | Record sessionId                                                             |
| assistant.thinking                                   | Append reasoning, footer=thinking                                            |
| assistant.text                                       | Merge adjacent text, footer=streaming                                        |
| assistant.tool_use                                   | Add running tool, footer=tool_running                                        |
| user.tool_result                                     | Match tool id, set ok/error and output                                       |
| final_answer                                         | Store `finalAnswer` and remove the streamed progress copy for the same item  |
| result.success / result.error                        | finalizing (cache subtype/errorMsg, not terminal)                            |
| result without a final_answer marker                 | Promote the last non-empty assistant text to `finalAnswer` (source=inferred) |
| CLI process exit (for-await ends) + still finalizing | done / error (lark-remote finally transition)                                |
| Non-zero exit or run throws                          | error                                                                        |
| stdout exhausted without result                      | error                                                                        |
| `/stop` or stop button                               | interrupted (can transition from running or finalizing)                      |
| Idle watchdog                                        | idle_timeout                                                                 |

`finalizing` is a non-terminal state: Claude Code CLI 2.x writes a `result` event when the main turn ends, but if a `run_in_background` task was started within the turn, the CLI waits for the background task to exit before closing stream-json. So `result` no longer equals terminal state — only CLI process exit counts as truly complete. The card displays `⏳ Claude · Finalizing` (orange header), still showing a `⏹ Stop` button (which kills the main process + background child processes). New messages still queue in the workspace serial queue, not interrupting the background wait.

Terminal state is only written on first occurrence; subsequent result, watchdog, stop, or exception events must not overwrite it.

The interruption source is distinguishable in terminal data (`interruptedReason`): `user_stop` (`/stop`, stop button), `approval_timeout` (the approval expired and the turn was cancelled automatically), and `approval_cancelled` (the user pressed cancel on the approval card). An explicit reason outranks inferred markers: if an approval expired earlier and the user stops the run later, the card says "terminated by user" instead of misreporting an approval timeout.

If `/stop` lands while the card is still being created and the run has not started, the card is finalized as interrupted first, and the bridge returns right after `cardSession.start()` without calling `runner.run()`. At that point the runner has no process to kill (`stop()` is a no-op before `run()` for both spawn-based and connection-based runners, and `run()` resets the stop flag); without this guard the agent finishes the whole turn behind an "interrupted" card.

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

| terminal        | Header                                  | Notes                                                                                                                                               |
| --------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| done            | ✅ Claude · Done                        | subtype, empty content notice                                                                                                                       |
| error           | ⚠️ Claude · Error                       | Error summary                                                                                                                                       |
| interrupted     | ⏹ Claude · Interrupted                  | Terminated by user                                                                                                                                  |
| idle_timeout    | ⏱ Claude · Timed out                    | Idle minutes                                                                                                                                        |
| finalizing      | ⏳ Claude · Finalizing                  | Non-terminal; **retains** ⏹ Stop button                                                                                                             |
| goal_continuing | ⏳ Claude · Turn ended (goal continues) | The turn ended but the session's goal is still active: the task is not finished, the host starts the next round on its own; Compact is not rendered |

Terminal states do not render footer and stop button (except `finalizing`, see table above).

The `done` header is further split by goal state: goal `complete` → `✅ Claude · Goal complete`; `blocked` → `⛔ Claude · Goal blocked`; `paused` → `⏸ Claude · Goal paused`; goal unreadable (`known=false`) → `✅ Claude · Done (goal unconfirmed)`, with the summary's first line reading "turn complete · goal state unconfirmed".

### 5.1 Goal view (DSH)

A DSH session can carry a long-running goal (the `goal` projection: objective / phase /
roundsStarted / maxGoalRounds). A goal is the **cross-turn** auto-continuation unit: within
milliseconds after `turn/end` the `goal-round-driver` may already have started the next round.
Therefore:

- A running card renders `🎯 **Goal in progress** · round r/N` plus the goal summary under the status line (a long goal goes into a collapsible panel);
- if the goal is still `active` when the run finalizes, the terminal state is `goal_continuing` (header "Turn ended (goal continues)") and the summary's first line reads "turn ended · goal still continuing" — "Done" never appears;
- no Compact button while the goal is `active`: DSH manual compaction requires an idle agent, so the click would always be rejected;
- `complete` / `paused` / `blocked` all mean "nothing continues automatically", so the run finalizes as a normal `done` terminal state, but the header reads "Goal complete", "Goal paused", or "Goal blocked" respectively; blocked also shows the blocking reason;
- when the final goal probe cannot read the goal (`known=false`), the card must not claim completion: the header reads "Done (goal unconfirmed)" and the summary's first line reads "turn complete · goal state unconfirmed";
- a projection snapshot **without a `goal` key** (a session that never used goals) counts as "explicitly no goal": no `goal_state` event is emitted and the unknown branch is not entered. Only a present-but-unparseable projection or a failed/timed-out read reports `known=false`.

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

The **complete** final answer has two guards:

1. State layer: only the **newest text block** is exempt from the
   `MAX_TEXT_CHARS` (12000 character) window. It falls back to the window only
   once a newer text block appears (`capStaleTextBlocks`, which leaves a
   `…（前 N 字符已省略）` marker). Storage therefore keeps one extra segment,
   and every other progress block stays bounded. Every agent's final answer is
   the newest text block, so this guard covers all of them.
2. Protocol layer: when a runner holds the complete body, it carries it on the
   `result` event (`ResultEvent.finalAnswerText`). DSH's durable
   `assistant/message` delivers the whole body at once; the translator hands it
   to the state layer at `turn/end`, and `promoteFinalAnswer` prefers it, using
   the block copy only as a fallback. This guard does not depend on
   concatenated stream deltas, so dropped frames on reconnect cannot lose it.

While a run is live (running / finalizing) the card is still a progress view:
text is shown through the rendering budget window (`TEXT_BYTES`), and the
terminal card swaps in the complete `finalAnswer`.

The state layer still limits memory growth for ordinary progress content, then the rendering layer truncates by UTF-8 byte size:

- Reasoning retains a limited window;
- Ordinary text keeps the newest segment in full and windows older ones; `finalAnswer` is not evicted by that window or `MAX_BLOCKS`;
- Tool input/output is truncated;
- Total block count has an upper limit;
- Tool block count has its own upper limit (`MAX_BLOCKS`); each tool is a native collapsible panel (one title row by default) whose body ships with the card and is truncated by tool count;
- Whole card target is under 28KB; tests require under 30KB.

Budget uses `Buffer.byteLength(..., 'utf8')`; JavaScript string `.length` must not be used as a substitute.

If one card cannot hold even the final answer plus required controls, the card
shows `_最终回答较长，完整内容见随附的 Markdown 文件_`. The bridge writes the
complete answer verbatim to a temporary `.md` file, sends it as a **file
message**, then deletes the temporary file. The file must match the source
exactly; silent truncation is not allowed.

A final answer is **never sent as plain chat text**: plain text loses tables and
code blocks, and duplicates the card body. The file channel is the only overflow
channel. When the upload fails, the bridge sends a notice card (also not plain
text) and logs the on-disk path that still holds the answer.

Exceeding the table limit does **not** count as "does not fit": a Feishu card
holds at most 5 tables (11310), so the oldest extra tables are dropped with an
in-place `_💡 前 N 个表格已省略_` hint while the answer body stays in the card.
That case must not use the overflow channel — the card already shows the answer,
so an extra copy makes the user read the same answer twice (field report
2026-11-02). The file channel is only for the case where the marker replaces the
body.

## 7. Concurrency and Stop Control

Normal messages and normal cardActions continue entering the `Bridge.enqueue` Promise chain, ensuring at most one Claude run at a time.

Stop control must not enter that queue, otherwise it would wait until the current run completes. Entry rules:

- Exact `/stop` calls `interruptCurrentRun()` directly;
- Stop cardAction uses the button runId first and also receives the callback card `messageId`;
- Bridge validates userId and chatId. An exact runId match wins. If the runId is
  missing or does not match, Bridge accepts the click only when the callback
  messageId identifies the current active run card;
- Stale cards, other users, or other chats cannot interrupt the current run;
- Both finish and runner.stop allow repeated calls.

Successful interruption does not send an additional confirmation text; the interrupted terminal state on the original card is the sole feedback.

## 8. Errors and Degradation

### Failure before initial send

Continue consuming Claude events; after the run ends, send a single static terminal card.

### Failure after initial send

Prefer calling `updateCard(messageId, finalCard)` to finalize the original card. Only when the original message also cannot be updated is a second fallback card allowed.

### Compact card stream failure

`/compact` shares `RunCardSession` with runs and the same "finalize in place, then fall back" rule: when `settle()` returns `unsent` (the card stream never started or never settled), a static terminal card is sent. Otherwise the user only sees "Compact triggered" and a reaction, with neither the failure nor its cause.

### Fallback completion notification

The completion notification sent after a failed stream card follows the terminal state for its title and template (done green / error red / interrupted grey / idle_timeout and goal_continuing orange). An errored run is never reported as a completed session.

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

[简体中文](../../zh/architecture/token-usage-scope.md) | English

# Token Usage Scope: Contract, Regression History, and Reader Responsibilities

> This document expands `design.md` §9.21 and answers three questions:
> 1. What scope do Input / Output / Total / Context / cumulative represent on a card?
> 2. Why did the "multi-step run under-reporting" bug reappear after it had already been fixed for opencode?
> 3. Which turn boundary does each session reader own (8 registered; the roster's single source is `AGENT_KINDS` in `src/agent-kinds.ts`; qoder reuses the claude reader kernel and is not listed separately), and what same-class gaps remain?

---

## 1. Three Scopes

One card carries three different token scopes. Mixing any two produces self-contradictory numbers.

| Display | Fields | Scope | Meaning |
|---|---|---|---|
| Input / Output / Cache / Total | `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheCreationTokens` / `totalTokens` | **This run (last turn)** | Sum of every model-request sample inside the last turn |
| Context | `contextLength` / `contextLimit` | **Last sample** | Current context-window occupancy; never summed |
| Cumulative | `cumulative*` fields | **Whole session** | Sum of every turn in the session |

**Hard invariants:**

1. **flow = sum of the last turn's samples.** One `assistant` message / `step-finish` / `usage.record` is usually **one model request**; a turn with tool round-trips has several. Taking only the last one systematically under-reports multi-step runs.
2. **context = the last sample's watermark.** Context length means "how many tokens are in the window after this turn"; summing samples is meaningless (it scales with the number of turns).
3. **cumulative = sum over the whole session.** Sub-agent usage may only enter cumulative, never "this run" (unless the sub-agent's turn boundary can be attributed).
4. **This run ≤ cumulative.** A violation means scopes were mixed; `formatUsageStats` only appends `⚠️ cumulative anomaly`, it does not rewrite numbers.
5. **Use live flow when live has input/output; otherwise fall back to jsonl.** Context/compactCount always prefer jsonl. Never mix scopes on one card.

---

## 2. Data Flow: Two Producers and One Fallback

```
live result event ─┐
                   ├─→ RunUsageCollector.finalize ─→ FinishMeta ─→ RunState ─→ card
session reader ────┘        (flow: live first; context/compact: jsonl first)
```

- **Live producers**
  - claude: `result` event passed through as-is (including native `cache_read_input_tokens` names).
  - pi: the RPC translator accumulates each `message_end.usage` within one run.
  - codex: app-server `thread/tokenUsage/updated` is gated by `turnId` and accumulated per turn.
  - dsh: the translator accumulates durable `assistant/message.usage` within one run.
  - opencode / kimi: ACP `usage_update` carries **only** `used` (context occupancy), `size`, and cost — **no input/output split**, so flow can only come from jsonl.
  - codebuddy: ACP `usage_update._meta.usage` carries per-request input/output and the translator sums per turn; CodeBuddy's session jsonl only records usage on the last assistant message of each turn (`requests: 1`), so the reader additionally rebuilds flow/cumulative from CodeBuddy's per-request logs.
- **jsonl fallback**: all 8 `AgentSessionReader.readSessionContent` implementations produce `AgentSessionUsage` (roster single-sourced from `AGENT_KINDS` in `src/agent-kinds.ts`).
- **Readers have a second consumer**: `/resume`, the auto-resume card, and the completion notification card display `readSessionContent` usage directly. Reader scope correctness cannot rely on "the done card has live data".

---

## 3. Regression History (2026-07 → 2026-11)

| Date | Change | Effect on flow |
|---|---|---|
| 2026-07-19 | Done-card rule established: flow prefers live, jsonl as fallback | Defines this-run scope |
| 2026-07-19 | The opencode **exec mode** stream translator added `accumulatedUsage`, summing every `step_finish` | First fix for multi-step under-reporting |
| 2026-08-17 | kimi CLI / opencode exec modes deleted; both moved to pure ACP | **The only "sum" implementation was deleted with the translator**; ACP live has no input/output |
| 2026-08-18 | opencode reader skips all-zero `step-finish` | Only fixes the degenerate step; still takes the "last non-empty sample"; the test pins that semantics |
| 2026-10-17 | opencode supports 2.0 exports; v2 reader added | v2 attaches tokens to messages; reuses "last assistant message" semantics |
| 2026-10-30 | opencode v1/v2 + kimi readers switch to "sum of every sample in the last turn" | Second fix, with an anchor test |
| 2026-11-01 | claude/pi/dsh readers also sum the last real-user turn; kimi and opencode v2 empty turns report 0; `usesLiveResultEvents()` split out of `usageAuthority` | All six readers now share one contract; scope assertions centralized in `tests/lib/usage-scope-contract.ts` |
| 2026-11-08 | codebuddy runner's flow authority switched to live; the reader rebuilds flow/cumulative from CodeBuddy's per-request logs (jsonl records only the last request per turn) | New log reader added; falls back to jsonl when logs are unavailable (lower bound) |

### Why It Reappeared

1. **The invariant had no code carrier.** §9.21 states "flow = this run", but `AgentSessionUsage.inputTokens` does not express scope; `UsageAccumulator` only offers `last` / `totals`, with no "reset at a turn boundary" semantics; opencode, dsh, and codex each hand-roll their aggregation.
2. **The fix was attached to an implementation that got deleted.** The first fix lived in the exec translator. The ACP migration deleted the translator and its tests; the replacement (ACP live) has no input/output at all, and the reader never inherited the semantics. **The fix was never moved to the durable data source.**
3. **External data models have the same shape but different meaning.** v1's `step-finish` is one per request; v2 attaches tokens to a message. It is easy to read "message = request" as "message = run", while the real granularity is `turn = N requests`. opencode's `idle`, kimi's `turn.prompt`, codex's `task_started`, and dsh's `turn/start` are the actual turn markers.
4. **Tests froze the implementation instead of checking the contract.** Old tests literally said `per-turn = last step-finish (overwrites)`, and v2 tests asserted the last message's numbers. Later changes only had to keep tests green, legalizing the bug.
5. **The fallback path was never held to the live standard.** Readers were treated as a degraded path "only used when live is missing", but they are the sole source for `/resume`, auto-resume, and completion notifications. `usageAuthority` also compresses "usage source" and "runner event semantics" into one field: ACP returns `'live'`, but live only has context and no input/output, which makes it easy to assume live covers flow.

**Conclusion:** the same invariant was lost across replacement implementations; this is not one code bug recurring.

---

## 4. Current Reader Responsibility Matrix

| Agent | Turn boundary | Flow source | Context formula | Cumulative source | Status |
|---|---|---|---|---|---|
| claude | Last real user message (`isRealUserPrompt` excludes tool_result / compact summary / `isMeta` / task notification / sidechain) | Sum of all assistant messages in the last turn; falls back to the last sample when there is no real user turn | Last message `input+output+cacheRead+cacheCreation`, max with compact `postTokens` | Sum over deduplicated message ids (multi-line same id: per-field max) | Sums the last turn |
| pi | Last user message | Sum of all assistant messages in the last turn; falls back to the last sample when there is no user turn | Last message occupancy | Sum over all assistant messages | Sums the last turn |
| opencode v1 | Last user message | Sum of every `step-finish` in the last turn | Last `step-finish` occupancy | Sum of every `step-finish` in the file | Sums the last turn (2026-10-30) |
| opencode v2 | A `user` message after the last sample *is* the boundary (empty turn); otherwise the last `idle` that still has samples after it; without `idle`, the last `user/synthetic/system` | Sum of every assistant sample in the last turn; empty turn = 0 | Last assistant sample occupancy | Sum of every assistant sample in the file | Empty turn reports 0 |
| kimi | `turn.prompt` | Sum of main-wire `usage.record` in the last turn; empty turn = 0, never the previous turn | Last main-wire usage occupancy | Main wire + all sub-agent wires | Empty turn reports 0 |
| codex | `event_msg.task_started` | Sum of every `token_count` sample in the last turn | Last raw `input_tokens` (includes cache, **excludes output**, existing convention) | Last `total_token_usage` | Sums the last turn (2026-10-12) |
| dsh | `turn/start` – `turn/end`; a `turn/start` without `turn/end` is the current boundary | `turnUsage ?? lastTurnUsage ?? last-sample fallback`, in-flight wins | `input + last output + cacheRead + cacheWrite`: only the last sample's output — summing the whole turn's output double-counts | Sum of all usage | In-flight wins; context double-count removed |
| codebuddy | The log line's `conversation_request_id` (same source as the jsonl's `providerData.conversationRequestId`) | Sum of all `agent.model_call.completed` log lines in the last turn; falls back to the jsonl's last request when logs are unavailable | Last request `input+output+cache` (input already excludes cache) | Sum of log lines over all turns; falls back to jsonl when logs are unavailable | Logs first + fallback (2026-11-08) |

Notes:

- claude/pi jsonl has no native turn marker, so a real user message serves as the boundary. "Last assistant message" only equals this-run for single-request turns.
- qoder reuses the claude reader kernel; its scope is the same as claude's and is not listed separately.
- **An empty last turn reports 0** (kimi / opencode v2): the current contract is "the last turn", not "the last non-empty turn". Switching to the latter is a contract change — §9.21, every reader, tests, and card copy have to move together.
- Fallbacks when no turn can be delimited split two ways: claude / pi / dsh fall back to the last sample; a kimi wire with no `turn.prompt` anywhere (legacy or truncated) keeps "whole file = one turn".
- codex context excluding the last turn's output is an existing documented convention but inconsistent with other readers; changing it requires updating §9.21 and every reader.
- Sub-agents: kimi sub-agent wires enter cumulative, not flow; codex sub-agent rollout files are excluded from lists and reads; claude's `isSidechain` currently only blocks turn boundaries — usage aggregation does not filter it, see §5.
- `AgentSessionReader.supportsCompactCount` declares whether a reader produces compaction statistics; readers that do not (opencode / dsh) show no usage block at all on the compact card — what they read is only the pre-compaction last sample, verbatim identical to the previous run card, and showing it would read as post-compaction numbers. They also no longer pay a full export/read for data that cannot arrive.
- dsh creates one live translator per run and only accumulates durable usage; live path itself has no scope problem.

---

## 5. Known Gaps and Unverified Items

- **Claude sidechain only blocks boundaries; it does not filter aggregation.** `scalarScan` excludes `isSidechain` only inside the turn-boundary check `isRealUserPrompt`; usage aggregation never consults it. If a real Claude JSONL file mixes sidechain messages, the impact is not limited to the last sample — **cumulative is also inflated**. No real fixture proves that mixing happens today, so this stays an unverified item. Before handling it, confirm three things with a sanitized real JSONL: whether sidechain messages land in the same file, whether message ids are unique, and whether the turn boundary is identifiable. Do not bundle it with a numeric-semantics change.
- **run-scope aggregation is still hand-written per reader.** `UsageAccumulator` only offers `last` / `totals`, with no "reset at a turn boundary" semantics, and the `cumulativeUsageFields` comment still says "opencode keeps its own conditional assignment". Every reader re-implements "find boundary + sum + take watermark". The shared primitive is described in §6.1 and has not landed.
- **The parameterized contract harness has not landed.** Cross-reader scope assertions now live in `tests/lib/usage-scope-contract.ts` and are shared by the claude / pi / dsh / kimi / opencode regression tests (codex still asserts in its own rollout tests); the "a new reader only supplies a fixture" parameterized harness from §6.2 is still missing.
- **codebuddy's exact usage depends on CodeBuddy's diagnostic logs.** The session jsonl records only the last request's usage per turn; per-request data lives only in `logs/<date>/<basename>__<md5(cwd)>.log`'s `agent.model_call.completed` lines. When the logs are cleaned up, drift in format, or file logging is disabled, the reader falls back to jsonl and both flow and cumulative degrade to the "last request per turn" lower bound. That log is a CodeBuddy internal format; the reader only fail-soft-parses it and does not treat it as a stable protocol.
- **opencode tests still carry an obsolete comment.** `per-turn = last step-finish (overwrites)` contradicts the §1 invariant; it is documentation debt waiting to be cleaned.
- **Field names do not express scope.** `AgentSessionUsage.inputTokens` / `outputTokens` give no hint that they mean "this run", so readers and callers are constrained only by comments and by this document. The rename/annotate direction is in §6.4.

---

## 6. Preventing the Next Regression

### 6.1 Turn the invariant into structure

Add a shared primitive in `src/session/common/`, alongside `usage-accumulator.ts`:

```ts
runScopeUsage({
  samples,          // ordered samples: input/output/cacheRead/cacheCreation/contextOccupancy
  turnStartIndex,   // each agent only finds the boundary
  declaredTotals,   // optional agent-native totals
}) => {
  flow: sum(samples after turnStartIndex),
  context: lastSample.occupancy,
  cumulative: sum(all samples),
}
```

Each reader supplies only the **sample sequence** and **boundary detection** (see the turn-boundary column in §4). Addition, watermark selection, and cumulative assembly exist in one place.

Do not ship that extraction in the same batch as a behavior fix: let the numeric semantics settle in the readers with their contract tests first, then extract. Otherwise a regression cannot be attributed between the refactor and the semantics change.

### 6.2 One cross-reader contract test

Every reader must answer these seven; the answers come from the scope contract, not from an implementation:

1. Last turn has N samples → flow = sum of N.
2. Previous-turn samples → cumulative only, never flow.
3. context = last sample, never a sum.
4. A zero-token trailing sample must not wipe the turn's flow.
5. In-flight turn → current partial samples take precedence over the previous turn.
6. Cumulative ≥ this run.
7. Sub-agent usage → cumulative only (where applicable).

A test that only asserts "the last sample equals some number" freezes the implementation, not the contract: it stays green when the implementation is changed incorrectly, which is exactly how the same under-reporting kept coming back. What exists today is the shared assertion library `tests/lib/usage-scope-contract.ts`, reused by the claude / pi / dsh / kimi / opencode / codebuddy regression tests; the parameterized harness is still to be added (see §5).

### 6.3 Migration rule

- When deleting or replacing a runner mode, **move the behavior and its tests together**; never delete the old implementation and its tests while the new one guesses semantics from scratch.
- Keep at least one `reader → Bridge → card` anchor numeric assertion (opencode landed one on 2026-10-30).
- When changing live protocol parsing, check the jsonl reader's same-named field scope, not just live.

### 6.4 Types and naming

- `AgentSessionUsage.inputTokens` still does not express scope (the rename/annotate to `runInputTokens` has not landed — see §5); cumulative fields keep the `cumulative*` prefix.
- `getUsageAuthority()` answers **the flow source only**: `'live'` when live carries input/output, `'jsonl'` for ACP-style runners whose live events have context only. Result-event semantics (pre-init result dropping, session writeback) go through `usesLiveResultEvents()`. The two responsibilities are already split; a new runner must not fold them back into one field.

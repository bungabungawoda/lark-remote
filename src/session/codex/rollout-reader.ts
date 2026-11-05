/**
 * Codex Rollout File Reader.
 *
 * Reads Codex session history from rollout JSONL files in `~/.codex/sessions/`.
 *
 * Rollout file format (appendix C in design doc):
 * ```
 * {"timestamp":"...","type":"session_meta","payload":{"session_id":"...","cwd":"...","originator":"lark-remote",...}}
 * {"timestamp":"...","type":"event_msg","payload":{"type":"task_started","turn_id":"..."}}
 * {"timestamp":"...","type":"response_item","payload":{"type":"message","role":"user|developer","content":[...]}}
 * ```
 *
 * Event vocabulary drift (codex CLI ≥0.153.4, transitional from 0.147.0): the
 * top-level `user_message` / `agent_message` events were removed; the same
 * payloads now ride on `event_msg` → `item_completed` envelopes whose
 * `item.type` is `UserMessage` / `AgentMessage` / `CommandExecution` / … .
 * Both spellings stay readable — `extractRealUserText` adapts per file.
 *
 * Deprecation: if ~6 months pass (≈2027-03) with the legacy `user_message` /
 * `agent_message` events still absent from every codex CLI and the old-codex
 * session tail effectively gone, drop the legacy branch + its fixtures.
 *
 * Note: This handles the **rollout file format** (historical logging), NOT the
 * `codex exec --json` stdout format（已随 exec 模式移除）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJsonlLines, findJsonlLine } from '../common/jsonl.js';
import { STALE_MS } from '../common/constants.js';
import { samePath } from '../../platform/path.js';
import { paginate, capEvents } from '../common/pagination.js';
import { sortByRecencyDesc } from '../common/recency.js';
import { getLogger } from '../../logger/index.js';
import { isRecord, stringValue } from '../../common/guards.js';
import { TtlCache } from '../../common/ttl-cache.js';
import { resolveCodexHome } from '../../config/codex-config.js';
import type {
  AgentSessionContentEvent,
  AgentSessionUsage,
  SessionContent,
  SessionSummary,
} from '../../session-contract.js';

interface CodexRolloutEntry {
  threadId: string; // = session_meta.payload.session_id
  cwd: string;
  /** First real (human-typed) user message, for session summary/title. */
  firstUserMessage: string;
  /** Last real (human-typed) user message, for the "最近输入" card label. */
  lastRealUserMessage: string;
  updatedAtMs: number;
  events: AgentSessionContentEvent[];
  /** Last-turn usage extracted from token_count events (ccusage-aligned). */
  usage?: AgentSessionUsage;
}

interface ListCodexRolloutsOptions {
  /** Override CODEX_HOME. Default: ~/.codex */
  codexHome?: string;
  /** Filter by working directory. */
  cwd?: string;
  /** Max entries to return. Default: 20 */
  limit?: number;
  /** Page offset into the mtime-desc full set. Default: 0 */
  offset?: number;
}

/**
 * Read a single rollout file and parse its content.
 *
 * Returns null if the file doesn't exist, is corrupted, or has no session_meta.
 */
interface RawTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** Field-wise difference (total - previous) for cumulative->incremental. */
function subtractRawUsage(a: RawTokenUsage, b: RawTokenUsage): RawTokenUsage {
  return {
    input_tokens: a.input_tokens - b.input_tokens,
    cached_input_tokens: a.cached_input_tokens - b.cached_input_tokens,
    output_tokens: a.output_tokens - b.output_tokens,
    total_tokens: a.total_tokens - b.total_tokens,
  };
}

/**
 * 单 turn 用量之和（ccusage 口径：input 已减去 cached）。
 * codex 每次采样落一条 `token_count`，一个 turn 内通常有多条（实测 7 次工具
 * 往返 = 7 条），卡片与 `/resume` 的「本 run」是整 turn 之和。
 */
interface TurnUsageTotals {
  input: number;
  cached: number;
  output: number;
  total: number;
}

function emptyTurnUsage(): TurnUsageTotals {
  return { input: 0, cached: 0, output: 0, total: 0 };
}

/**
 * `compacted` 事件自带的摘要调用 usage（`latest_token_usage_record.usage`）。
 * 用于把「压缩前窗口」与「摘要调用自身的消耗」区分开——两者都写在 compacted 前。
 */
function readCompactedCallTotal(payload: Record<string, unknown> | undefined): number | undefined {
  const record = payload?.latest_token_usage_record as
    { usage?: { total_tokens?: number } } | undefined;
  const total = record?.usage?.total_tokens;
  return typeof total === 'number' ? total : undefined;
}

export function readCodexRollout(filePath: string): CodexRolloutEntry | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const scan = scanCodexRollout(filePath, true);
    const { sessionMeta } = scan;
    if (!sessionMeta) {
      return null;
    }

    const sessionId = stringValue(sessionMeta.session_id) ?? stringValue(sessionMeta.id) ?? '';
    const cwd = stringValue(sessionMeta.cwd) ?? '';

    if (!sessionId) {
      return null;
    }

    const stats = fs.statSync(filePath);
    const updatedAtMs = stats.mtimeMs;

    const firstUserMessage = scan.realUserMessages[0] ?? '';
    const lastRealUserMessage = scan.realUserMessages[scan.realUserMessages.length - 1] ?? '';
    const usage = buildUsageFromScan(scan);

    return {
      threadId: sessionId,
      cwd,
      firstUserMessage: firstUserMessage || '(no user message)',
      lastRealUserMessage,
      updatedAtMs,
      events: scan.events,
      usage,
    };
  } catch (err) {
    getLogger().warn(`[codex-rollout-reader] failed to read ${filePath}: ${err}`);
    return null;
  }
}

/**
 * Lightweight single-file scan that extracts only the display-relevant fields
 * (last real user message + usage) — **without** constructing the `events`
 * array. Backs `readCodexSessionSummary` so the `/resume` list prefetch does
 * not pay the cost of JSON.parse-ing every response_item and building events
 * that are immediately discarded.
 *
 * Returns null if the file doesn't exist, is corrupted, or has no session_meta.
 */
function readCodexRolloutSummary(
  filePath: string,
): { lastRealUserMessage: string; usage?: AgentSessionUsage } | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const scan = scanCodexRollout(filePath, false);
    if (!scan.sessionMeta) return null;
    return {
      lastRealUserMessage: scan.realUserMessages[scan.realUserMessages.length - 1] ?? '',
      usage: buildUsageFromScan(scan),
    };
  } catch (err) {
    getLogger().warn(`[codex-rollout-reader] failed to read summary ${filePath}: ${err}`);
    return null;
  }
}

/** Intermediate scan state shared by the full parse and the summary variant. */
interface CodexRolloutScan {
  sessionMeta: Record<string, unknown> | null;
  events: AgentSessionContentEvent[];
  realUserMessages: string[];
  lastRawUsage: RawTokenUsage | undefined;
  lastContextLimit: number | undefined;
  lastTotalUsage: RawTokenUsage | undefined;
  previousTotals: RawTokenUsage | undefined;
  /**
   * 末个 turn（`task_started` 之后）内所有采样之和；文件里没有 `task_started`
   * （旧数据）时为 null，由调用方退回「末条 token_count」语义。
   */
  turnUsage: TurnUsageTotals | null;
  compactCount: number;
  compactPreContextLength: number | undefined;
  compactPostContextLength: number | undefined;
}

interface ParsedRolloutLine {
  type: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

/** 扫描过程中的可变状态；`CodexRolloutScan` 是它对外暴露的子集。 */
interface ScanState extends CodexRolloutScan {
  lastUserMessageSource: 'legacy' | 'item' | null;
  userResponseItemCount: number;
  previousRawUsage: RawTokenUsage | undefined;
}

function newScanState(): ScanState {
  return {
    sessionMeta: null,
    events: [],
    realUserMessages: [],
    lastRawUsage: undefined,
    lastContextLimit: undefined,
    lastTotalUsage: undefined,
    previousTotals: undefined,
    turnUsage: null,
    compactCount: 0,
    compactPreContextLength: undefined,
    compactPostContextLength: undefined,
    lastUserMessageSource: null,
    userResponseItemCount: 0,
    previousRawUsage: undefined,
  };
}

function scanResult(state: ScanState): CodexRolloutScan {
  return {
    sessionMeta: state.sessionMeta,
    events: state.events,
    realUserMessages: state.realUserMessages,
    lastRawUsage: state.lastRawUsage,
    lastContextLimit: state.lastContextLimit,
    lastTotalUsage: state.lastTotalUsage,
    previousTotals: state.previousTotals,
    turnUsage: state.turnUsage,
    compactCount: state.compactCount,
    compactPreContextLength: state.compactPreContextLength,
    compactPostContextLength: state.compactPostContextLength,
  };
}

function warnIfVocabularyDrift(state: ScanState, filePath: string): void {
  // 兼容性漂移探针：文件里有 `role:"user"` 注入，却识别不出任何真人输入 ——
  // 说明 codex 又换了 event_msg 词表，displayTitle 会静默变空（0.153 事故形态）。
  // 只告警不兜底：误用注入文本当标题是已修掉的缺陷。
  if (state.realUserMessages.length === 0 && state.userResponseItemCount > 0) {
    getLogger().warn(
      `[codex-rollout-reader] no human user message recognised in ${filePath} ` +
        `(${state.userResponseItemCount} role:"user" response_items seen) — codex rollout ` +
        `event vocabulary may have changed; session title will be empty`,
    );
  }
}

function recordHumanMessage(
  state: ScanState,
  human: { text: string; source: 'legacy' | 'item' },
): void {
  const text = human.text.slice(0, 200);
  const prev = state.realUserMessages[state.realUserMessages.length - 1];
  // 过渡期防御：同一 turn 若被旧版 user_message 与新版 item_completed
  // 各写一次，会得到相邻重复。仅在「通道切换且文本与上一条完全相同」
  // 时跳过——同通道连续相同输入（真人连发两条一样的话）不受影响。
  const duplicateAcrossChannels =
    state.lastUserMessageSource !== null &&
    state.lastUserMessageSource !== human.source &&
    prev === text;
  if (!duplicateAcrossChannels) {
    state.realUserMessages.push(text);
  }
  state.lastUserMessageSource = human.source;
}

function resolveRawUsage(
  info: Record<string, unknown> | undefined,
  previousTotals: RawTokenUsage | undefined,
): { raw: RawTokenUsage | undefined; total: RawTokenUsage | undefined } {
  const last = info?.last_token_usage as RawTokenUsage | undefined;
  const total = info?.total_token_usage as RawTokenUsage | undefined;
  let raw: RawTokenUsage | undefined;
  if (last) {
    raw = last;
  } else if (total && previousTotals) {
    raw = subtractRawUsage(total, previousTotals);
  } else {
    raw = total;
  }
  return { raw, total };
}

function accumulateTurnUsage(state: ScanState, raw: RawTokenUsage): void {
  if (!state.turnUsage) return;
  // token_count 每次采样一条，末 turn 的所有采样求和（见 buildUsageFromScan）。
  const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);
  state.turnUsage.input += raw.input_tokens - cached;
  state.turnUsage.cached += cached;
  state.turnUsage.output += raw.output_tokens;
  state.turnUsage.total += raw.total_tokens;
}

function updateCompactPostContext(state: ScanState, raw: RawTokenUsage | undefined): void {
  // 压缩后的水位：压缩收尾 token_count 全 0（不满足 zero-filter），
  // 但 total_tokens 表达真实窗口；之后若出现普通 turn（input>0），
  // 水位回归该 turn，post-compact 值失效。
  if (state.compactCount <= 0 || !raw) return;
  if (raw.total_tokens && !raw.input_tokens && !raw.cached_input_tokens && !raw.output_tokens) {
    state.compactPostContextLength = raw.total_tokens;
  } else if (raw.input_tokens > 0) {
    state.compactPostContextLength = undefined;
  }
}

function handleTokenCount(state: ScanState, payload: Record<string, unknown>): void {
  const info = payload.info as Record<string, unknown> | undefined;
  const { raw, total } = resolveRawUsage(info, state.previousTotals);
  if (total) {
    state.previousTotals = total;
    state.lastTotalUsage = total;
  }
  if (raw && (raw.input_tokens || raw.cached_input_tokens || raw.output_tokens)) {
    state.previousRawUsage = state.lastRawUsage;
    state.lastRawUsage = raw;
    const ctxWindow = info?.model_context_window;
    state.lastContextLimit = typeof ctxWindow === 'number' ? ctxWindow : undefined;
    accumulateTurnUsage(state, raw);
  }
  updateCompactPostContext(state, raw);
}

function handleEventMsg(state: ScanState, payload: Record<string, unknown>): void {
  const human = extractRealUserText(payload);
  if (human) {
    recordHumanMessage(state, human);
    return;
  }
  if (payload.type === 'task_started') {
    // turn 边界：一个 turn 一条 task_started，从这里开始重新累计本 turn 的用量。
    state.turnUsage = emptyTurnUsage();
    return;
  }
  if (payload.type === 'token_count') handleTokenCount(state, payload);
}

function handleCompacted(state: ScanState, payload: Record<string, unknown> | undefined): void {
  // 顶层 compacted 事件：压缩次数 +1，压缩前水位取「压缩调用之前」那条非零
  // token_count 的 total_tokens。真实 rollout 落盘顺序是
  // 末轮 → 摘要调用 → compacted → 压缩后水位：摘要调用自身的 token_count 紧贴
  // 在 compacted 之前，直接取 lastRawUsage 会把摘要调用的消耗当成压缩前窗口。
  // compacted 自带的摘要调用 usage 用于判定并回退一条；旧数据无该字段时保持原语义。
  state.compactCount++;
  const compactCallTotal = readCompactedCallTotal(payload);
  const preCompactUsage =
    compactCallTotal !== undefined && state.lastRawUsage?.total_tokens === compactCallTotal
      ? state.previousRawUsage
      : state.lastRawUsage;
  if (preCompactUsage?.total_tokens !== undefined) {
    state.compactPreContextLength = preCompactUsage.total_tokens;
  }
}

function handleResponseItem(
  state: ScanState,
  payload: Record<string, unknown>,
  timestamp: string | undefined,
): void {
  if (payload.type !== 'message' || !Array.isArray(payload.content)) return;
  if (payload.role === 'user') state.userResponseItemCount++;
  const messages = extractMessageContent(payload);
  for (const msg of messages) {
    state.events.push({
      type: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.text,
      timestamp,
    });
  }
}

function dispatchRolloutLine(
  state: ScanState,
  parsed: ParsedRolloutLine,
  includeEvents: boolean,
): void {
  if (parsed.type === 'session_meta' && parsed.payload) {
    state.sessionMeta = parsed.payload;
    return;
  }
  if (parsed.type === 'event_msg' && parsed.payload) {
    handleEventMsg(state, parsed.payload);
    return;
  }
  if (parsed.type === 'compacted') {
    handleCompacted(state, parsed.payload);
    return;
  }
  if (includeEvents && parsed.type === 'response_item' && parsed.payload) {
    handleResponseItem(state, parsed.payload, parsed.timestamp);
  }
}

/**
 * Scan a rollout file once, tracking user messages, usage and compaction state.
 * When `includeEvents` is true, response_item content is also extracted into
 * `events`; when false, response_item lines are skipped entirely (the summary
 * fast path).
 *
 * 真人输入只认 `user_message` / `item_completed.UserMessage`；`role:"user"`
 * response_item 是注入 scaffolding，只用于漂移探针，不进 displayTitle。
 */
function scanCodexRollout(filePath: string, includeEvents: boolean): CodexRolloutScan {
  const state = newScanState();
  for (const line of readJsonlLines(filePath)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ParsedRolloutLine;
      if (!parsed || typeof parsed.type !== 'string') continue;
      dispatchRolloutLine(state, parsed, includeEvents);
    } catch {
      // Skip malformed lines
      continue;
    }
  }
  warnIfVocabularyDrift(state, filePath);
  return scanResult(state);
}

/**
 * Build ccusage-aligned usage from a scan's last-turn raw tokens.
 * input = raw - cached (codex reports cached input separately), cache
 * creation is never reported by codex, reasoning is a subset of output
 * (display-only, never added to total).
 *
 * Flow fields (input/output/cache/total) are the **sum over the last turn's
 * samplings** when the file marks turn boundaries (`task_started`) — one codex
 * turn logs one `token_count` per sampling, so the last line alone understates
 * a tool-looping run (measured: 212 / 679 displayed vs 3,022 / 3,648 consumed).
 * Legacy files without `task_started` keep the last-`token_count` semantics.
 * contextLength = input_tokens (= (input_tokens-cached) + cached + 0),
 * i.e. input + cacheRead + cacheCreation — the unified context-window
 * occupancy contract across all five readers (excludes
 * output/reasoning).
 */
function buildUsageFromScan(scan: CodexRolloutScan): AgentSessionUsage | undefined {
  const {
    lastRawUsage,
    lastContextLimit,
    lastTotalUsage,
    turnUsage,
    compactCount,
    compactPreContextLength,
    compactPostContextLength,
  } = scan;
  if (!lastRawUsage) return undefined;

  const r = lastRawUsage;
  const cached = Math.min(r.cached_input_tokens, r.input_tokens);
  // 本 run = 末个 turn 全部采样之和；旧数据（无 task_started）退回末条。
  const flow = turnUsage ?? {
    input: r.input_tokens - cached,
    cached,
    output: r.output_tokens,
    total: r.total_tokens,
  };
  const usage: AgentSessionUsage = {
    inputTokens: flow.input,
    outputTokens: flow.output,
    contextLength: r.input_tokens,
    contextLimit: lastContextLimit,
    cacheReadTokens: flow.cached,
    cacheCreationTokens: 0,
    totalTokens: flow.total,
  };
  // Cumulative from the final total_token_usage (non-cached input +
  // output), summed across all turns in the session.
  if (lastTotalUsage) {
    const cumCached = Math.min(lastTotalUsage.cached_input_tokens, lastTotalUsage.input_tokens);
    usage.cumulativeInputTokens = lastTotalUsage.input_tokens - cumCached;
    usage.cumulativeOutputTokens = lastTotalUsage.output_tokens;
    usage.cumulativeTotalTokens = lastTotalUsage.total_tokens;
    usage.cumulativeCacheReadTokens = cumCached;
    usage.cumulativeCacheCreationTokens = 0; // Codex 不报告 cache creation
  }
  // 压缩统计：会话内出现过 compacted 事件就计数（供 /resume 与 Compact 卡
  // 展示）；仅当会话以压缩收尾时（post-compact 水位存在），contextLength
  // 覆盖为压缩后水位并暴露压缩前水位——后续还有普通 turn 时水位回归该 turn。
  if (compactCount > 0) {
    usage.compactCount = compactCount;
    if (compactPostContextLength !== undefined) {
      usage.contextLength = compactPostContextLength;
      usage.compactPreContextLength = compactPreContextLength;
    }
  }
  return usage;
}

/**
 * List Codex sessions from rollout files.
 *
 * Returns `{ entries, total }`: `total` is the size of the full cwd-matched
 * set before pagination; `entries` are the newest `limit` entries by mtime.
 *
 * A global order over the full set is established first (no early
 * termination before ordering) using the lightweight session index — full
 * walk + first-line session_meta parse + stat mtime, 5s TTL cache. Only the
 * returned page is fully parsed for summary/usage.
 */
export function listCodexRollouts(opts: ListCodexRolloutsOptions = {}): {
  entries: CodexRolloutEntry[];
  total: number;
} {
  const codexHome = resolveCodexHome(opts.codexHome);
  const filterCwd = opts.cwd;

  // Full index: every rollout file's session_meta + mtime, no early break.
  const index = getSessionIndex(codexHome);
  const matched: SessionIndexEntry[] = [];
  for (const entry of index.values()) {
    // Subagent thread rollouts are part of a thread tree, not standalone
    // sessions: exclude them explicitly so a pure-subagent
    // session (main file missing) never pollutes the list or total.
    if (entry.isSubagent) continue;
    if (filterCwd && !samePath(entry.cwd, filterCwd)) continue;
    matched.push(entry);
  }

  // Establish the global order by mtime desc, then slice the page.
  // Same-mtime ties use filePath as a deterministic secondary key so index
  // rebuilds / walk order changes never reorder the page.
  sortByRecencyDesc(
    matched,
    (e) => e.mtimeMs,
    (e) => e.filePath,
  );
  const { items: page, total } = paginate(matched, { limit: opts.limit, offset: opts.offset });

  // Full-parse only the page being returned (summary/usage).
  const entries: CodexRolloutEntry[] = [];
  for (const item of page) {
    const entry = readCodexRollout(item.filePath);
    if (entry) entries.push(entry);
  }

  return { entries, total };
}

/**
 * 单源：三处（readCodexSessionContent / readCodexSessionSummary /
 * isCodexSessionActive）共用的「索引查找 + miss 强制刷新重查」。
 * cwd 守卫与 subagent 过滤语义各异，留在调用方。
 */
function resolveRolloutEntry(sessionId: string, codexHome: string): SessionIndexEntry | undefined {
  // Use session index for direct file lookup
  let index = getSessionIndex(codexHome);
  let entry = index.get(sessionId);
  // On miss, the index may be stale (a rollout file created after the
  // cache was built but within the 5s TTL). Force a refresh and recheck so a
  // brand-new session is found without waiting for TTL expiry.
  if (!entry) {
    index = getSessionIndex(codexHome, true);
    entry = index.get(sessionId);
  }
  return entry;
}

/**
 * Read the full content of a specific session by its threadId.
 *
 * Uses session index for O(1) file lookup instead of walking the
 * entire directory tree and fully parsing every file. Only the matching
 * file is fully parsed.
 *
 * `maxEvents` (optional): when set, only the LAST `maxEvents` events are
 * returned (most recent activity). This matches the auto-resume use case
 * ("show recent history") and keeps the card payload small. Unlike claude,
 * codex events are already at message granularity (no multi-block split),
 * so a hard `slice(-maxEvents)` is sufficient — no soft-cap complication.
 */
export function readCodexSessionContent(
  sessionId: string,
  opts: { codexHome?: string; maxEvents?: number; cwd?: string } = {},
): SessionContent {
  const codexHome = resolveCodexHome(opts.codexHome);

  const entry = resolveRolloutEntry(sessionId, codexHome);
  if (!entry) {
    return { events: [] };
  }
  // subagent rollout 不得当父会话历史返回：子线程 rollout 的
  // session_meta.session_id 是父 id（§9.27），索引冲突解决在主文件缺失时会让
  // 子文件占据该 id 的槽位，threadId 检查因等于父 id 而天然通过——list/active
  // 都已过滤（isSubagent），按 id 读取必须同口径，否则「列表没有、active 报
  // false、读内容却成功」三处语义互相矛盾。
  if (entry.isSubagent) {
    return { events: [] };
  }

  // Cwd guard: when a cwd is provided, the session's working directory must
  // match. Without this, /resume <id> finds sessions by global ID lookup and
  // allows resuming a session from cwd B while the user is in cwd A.
  // Codex has no relocation (no EnterWorktree equivalent), so a simple equality
  // check suffices — unlike claude which needs fileContainsCwd to handle
  // relocated sessions with multiple cwd values.
  if (opts.cwd && !samePath(entry.cwd, opts.cwd)) {
    return { events: [] };
  }

  const rollout = readCodexRollout(entry.filePath);
  if (!rollout || rollout.threadId !== sessionId) {
    return { events: [] };
  }

  // Apply maxEvents cap: keep the LAST N events (most recent).
  // See function docstring for rationale.
  const events = capEvents(rollout.events, opts.maxEvents);

  return {
    events,
    // displayTitle = LAST real user message (matches the
    // "最近输入" label). recap is undefined: codex has no
    // compact-summary concept, so never fake one from a user
    // message (was: firstUserMessage = injected project rules).
    displayTitle: rollout.lastRealUserMessage || undefined,
    recap: undefined,
    usage: rollout.usage,
  };
}

/**
 * Read the summary (title + usage, no events) of a specific session by id.
 *
 * Mirrors `readCodexSessionContent`'s index lookup + cwd guard, but uses the
 * lightweight `readCodexRolloutSummary` instead of the full parse — so the
 * `/resume` list prefetch never constructs the events array it would discard.
 */
export function readCodexSessionSummary(
  sessionId: string,
  opts: { codexHome?: string; cwd?: string } = {},
): SessionSummary {
  const codexHome = resolveCodexHome(opts.codexHome);

  const entry = resolveRolloutEntry(sessionId, codexHome);
  if (!entry) {
    return {};
  }
  // subagent rollout 同样不得当父会话摘要（与 readCodexSessionContent 同口径）。
  if (entry.isSubagent) {
    return {};
  }

  // Cwd guard: same semantics as readCodexSessionContent — when a cwd is
  // provided, the session's working directory must match.
  if (opts.cwd && !samePath(entry.cwd, opts.cwd)) {
    return {};
  }

  const summary = readCodexRolloutSummary(entry.filePath);
  if (!summary) {
    return {};
  }

  return {
    // displayTitle = LAST real user message (matches the "最近输入" label).
    displayTitle: summary.lastRealUserMessage || undefined,
    // codex has no compact-summary concept, so recap is never faked.
    recap: undefined,
    usage: summary.usage,
  };
}

/**
 * Check if a session is still active (recently updated).
 *
 * Uses session index for direct file lookup, then checks mtime
 * via statSync — no full rollout parse required. This reduces the
 * cost from "walk entire directory + full-parse every file" to a single
 * statSync call for the matching file.
 */
export function isCodexSessionActive(
  sessionId: string,
  opts: { codexHome?: string; activeThresholdMs?: number; cwd?: string } = {},
): boolean {
  const codexHome = resolveCodexHome(opts.codexHome);
  // Unify with the other readers' 1-hour stale window (claude/pi/opencode/kimi
  // all use STALE_MS). Previously codex used a divergent 10-minute default.
  const threshold = opts.activeThresholdMs ?? STALE_MS;

  // Use session index for direct file lookup + mtime check
  const entry = resolveRolloutEntry(sessionId, codexHome);
  if (!entry) {
    return false;
  }
  // Subagent thread rollouts are never "active sessions": their mtime
  // reflects thread-tree activity, not the parent session's liveness
  // A pure-subagent session must report inactive.
  if (entry.isSubagent) {
    return false;
  }
  // Cwd guard: when a cwd is provided, the session's working directory must
  // match (align with claude/pi/opencode which validate cwd).
  if (opts.cwd && !samePath(entry.cwd, opts.cwd)) {
    return false;
  }

  // Re-stat to get fresh mtime (index may be up to INDEX_TTL_MS stale)
  try {
    const stat = fs.statSync(entry.filePath);
    return Date.now() - stat.mtimeMs < threshold;
  } catch {
    return false;
  }
}

/**
 * Walk the YYYY/MM/DD directory tree under `sessionsDir` and return all
 * rollout-*.jsonl file paths. Silently skips non-directory entries and
 * malformed names; returns an empty array if `sessionsDir` doesn't exist
 * or is unreadable.
 */
function walkRolloutFiles(sessionsDir: string): string[] {
  if (!fs.existsSync(sessionsDir)) return [];

  const result: string[] = [];
  // per-entry try/catch：目录在 readdir 与 stat 之间被删（并发归档/清理）时，
  // 旧实现整个 walk 提前终止并返回部分结果——索引漏掉后续文件，会话从
  // /resume 列表与 total 消失直到 5s TTL 重建。单条目失败只跳过自己。
  const years = safeReaddir(sessionsDir);
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearPath = path.join(sessionsDir, year);
    if (!safeIsDir(yearPath)) continue;

    for (const month of safeReaddir(yearPath)) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthPath = path.join(yearPath, month);
      if (!safeIsDir(monthPath)) continue;

      for (const day of safeReaddir(monthPath)) {
        if (!/^\d{2}$/.test(day)) continue;
        const dayPath = path.join(monthPath, day);
        if (!safeIsDir(dayPath)) continue;

        const files = safeReaddir(dayPath).filter(
          (f) => f.startsWith('rollout-') && f.endsWith('.jsonl'),
        );
        for (const file of files) {
          result.push(path.join(dayPath, file));
        }
      }
    }
  }
  return result;
}

/** readdir 的竞态安全版：目录消失/不可读返回空并记 debug（外层不再中断）。 */
function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    getLogger().debug(`[codex-rollout-reader] readdir failed (raced delete?): ${err}`);
    return [];
  }
}

/** statSync 的竞态安全目录判定。 */
function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lightweight session index for O(1) lookups by sessionId.
 *
 * Instead of walking the full directory tree + fully parsing every rollout
 * file for each `readCodexSessionContent` / `isCodexSessionActive` call,
 * build an index that maps sessionId → filePath + mtimeMs. The index uses
 * `findJsonlLine` (streaming early-stop) to extract only the session_meta
 * line from each file — no full parse required.
 *
 * TTL-based cache avoids rebuilding the index on every call within the
 * same /resume flow.
 */
interface SessionIndexEntry {
  filePath: string;
  cwd: string;
  mtimeMs: number;
  /**
   * True when this rollout belongs to a codex subagent thread (thread tree)
   * rather than the main session thread. Subagent rollouts share the parent
   * session's `session_id`, so they must never win the index conflict
   * resolution for that session id.
   */
  isSubagent: boolean;
}

const INDEX_TTL_MS = 5_000; // 5 seconds — covers a single /resume flow

/**
 * codexHome → 会话索引。共享 `TtlCache`（TTL 由写入时间判定 + LRU 上限），
 * 与 kimi/pi/opencode 三个 reader 同一套语义。生产侧 `CodexSessionReader`
 * 构造时就把 codexHome 解析定死，实际只会用到 1 个键；上限是防漏的界。
 */
const sessionIndexCache = new TtlCache<string, Map<string, SessionIndexEntry>>(INDEX_TTL_MS, 4);

/**
 * Build or return cached session index for a given resolved codexHome.
 * The index maps sessionId → {filePath, cwd, mtimeMs}.
 *
 * @param resolvedCodexHome  Already-resolved codex home path (from resolveCodexHome).
 * @param forceRefresh       When true, bypass the TTL cache and rebuild. Used
 *                           on an index MISS (readCodexSessionContent /
 *                           isCodexSessionActive) so a rollout file created
 *                           AFTER the cache was built — but still within the
 *                           5s TTL — is found without waiting for expiry.
 *
 * Cache shape note: the cache is module-level and keyed by the resolved
 * codexHome string; `TtlCache` caps entries (LRU) so a caller that injects
 * many distinct codexHomes cannot grow memory without bound.
 */
function getSessionIndex(
  resolvedCodexHome: string,
  forceRefresh = false,
): Map<string, SessionIndexEntry> {
  const cached = forceRefresh ? undefined : sessionIndexCache.get(resolvedCodexHome);
  if (cached) return cached;

  const sessionsDir = path.join(resolvedCodexHome, 'sessions');
  const files = walkRolloutFiles(sessionsDir);
  const index = new Map<string, SessionIndexEntry>();

  for (const filePath of files) {
    // Use findJsonlLine to extract session_meta without full file parse.
    // session_meta is always the first line of a rollout file.
    const metaLine = findJsonlLine(filePath, (line) => {
      try {
        const obj = JSON.parse(line);
        return obj.type === 'session_meta';
      } catch {
        return false;
      }
    });

    if (!metaLine) continue;

    try {
      const meta = JSON.parse(metaLine) as {
        payload?: {
          session_id?: string;
          cwd?: string;
          thread_source?: string;
          source?: { subagent?: unknown };
        };
      };
      const sessionId = meta.payload?.session_id;
      if (!sessionId) continue;

      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }

      // Codex multi-agent threads: subagent rollout files share the parent
      // session's session_id but carry thread_source === 'subagent' (or a
      // source.subagent marker). Keep only the main-thread file for a given
      // session id; among files of the same kind pick the newest mtime, with
      // filePath as a deterministic tie-breaker — resolution never depends on
      // fs.readdirSync order (APFS hash order is not filename order).
      const isSubagent =
        meta.payload?.thread_source === 'subagent' || meta.payload?.source?.subagent !== undefined;
      const candidate: SessionIndexEntry = {
        filePath,
        cwd: meta.payload?.cwd ?? '',
        mtimeMs,
        isSubagent,
      };
      const existing = index.get(sessionId);
      if (
        !existing ||
        (existing.isSubagent && !isSubagent) ||
        (existing.isSubagent === isSubagent && mtimeMs > existing.mtimeMs) ||
        (existing.isSubagent === isSubagent &&
          mtimeMs === existing.mtimeMs &&
          filePath.localeCompare(existing.filePath) < 0)
      ) {
        index.set(sessionId, candidate);
      }
    } catch {
      continue;
    }
  }

  sessionIndexCache.set(resolvedCodexHome, index);
  return index;
}

/** Clear the session index cache. Exposed for tests. */
export function clearSessionIndexCache(): void {
  sessionIndexCache.clear();
}

/**
 * Extract the human-typed text from a rollout `event_msg` payload, adapting to
 * codex's two rollout event vocabularies.
 *
 * - Legacy (CLI ≤0.150.1): a dedicated `{"type":"user_message","message":…}`
 *   event. Codex emitted it ONLY for text the human actually typed; injected
 *   scaffolding (project rules, `<environment_context>`, permissions) is
 *   written as `role:"user"` response_items but gets NO such event, so it stays
 *   out of displayTitle/recap/summary. (Without this, the first
 *   `role:user` message is the injected project rules, once shown as 最近输入.)
 * - Current (CLI ≥0.153.4, transitional from 0.147.0): the `user_message` /
 *   `agent_message` events were removed; the same authoritative text now rides
 *   on `{"type":"item_completed","item":{"type":"UserMessage","content":[…]}}`.
 *   A UserMessage may bundle several content parts — `text` parts are the human
 *   input, `skill` parts are injected skill files (e.g. a `$skill-name`
 *   invocation) that must not leak into the title.
 *
 * Real-data note: no rollout file observed carries BOTH spellings;
 * 0.147–0.149 are transitional (either spelling per file), 0.153.4+/0.154.0 are
 * item_completed-only. `source` reports which spelling matched so the scanner
 * can collapse a hypothetical double-write of the same turn.
 *
 * TODO(2027-03-11): drop the legacy branch (and its fixtures) once ~6 months
 * pass with the event still absent from every CLI and old-codex tails gone —
 * mirrors the deprecation note in the module header.
 */
function extractRealUserText(
  payload: Record<string, unknown>,
): { text: string; source: 'legacy' | 'item' } | null {
  if (payload.type === 'user_message') {
    const text = stringValue(payload.message);
    return text ? { text, source: 'legacy' } : null;
  }
  if (payload.type === 'item_completed') {
    const item = payload.item;
    if (!isRecord(item) || item.type !== 'UserMessage' || !Array.isArray(item.content)) {
      return null;
    }
    const texts: string[] = [];
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== 'text') continue;
      const text = stringValue(part.text);
      if (text) texts.push(text);
    }
    return texts.length > 0 ? { text: texts.join('\n'), source: 'item' } : null;
  }
  return null;
}

function extractMessageContent(
  payload: Record<string, unknown>,
): Array<{ role: string; text: string }> {
  const result: Array<{ role: string; text: string }> = [];
  const content = payload.content;

  if (!Array.isArray(content)) {
    return result;
  }

  const role = stringValue(payload.role) ?? 'assistant';

  for (const item of content) {
    if (!isRecord(item)) continue;
    const text = stringValue(item.text) ?? stringValue(item.input_text);
    if (text) {
      result.push({ role, text });
    }
  }

  return result;
}

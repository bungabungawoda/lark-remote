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
 * Note: This handles the **rollout file format** (historical logging), NOT the
 * `codex exec --json` stdout format（已随 exec 模式移除）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJsonlLines, findJsonlLine } from '../common/jsonl.js';
import { STALE_MS } from '../common/constants.js';
import { paginate, capEvents } from '../common/pagination.js';
import { getLogger } from '../../logger/index.js';
import { isRecord, stringValue } from '../../common/guards.js';
import { resolveCodexHome } from '../../config/codex-config.js';
import type {
  AgentSessionContentEvent,
  SessionContent,
  AgentSessionUsage,
} from '../../runner/index.js';

interface CodexRolloutEntry {
  threadId: string; // = session_meta.payload.session_id
  cwd: string;
  /** First real (human-typed) user message, for session summary/title. */
  firstUserMessage: string;
  /** Last real (human-typed) user message, for the "最近输入" card label. */
  lastRealUserMessage: string;
  createdAtMs: number;
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

export function readCodexRollout(filePath: string): CodexRolloutEntry | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const lines = readJsonlLines(filePath);
    const events: AgentSessionContentEvent[] = [];
    let sessionMeta: Record<string, unknown> | null = null;
    // Real user input is identified by a paired `event_msg` whose
    // payload.type === "user_message" - codex emits this ONLY for text the
    // human actually typed. Injected scaffolding (project rules,
    // <environment_context>, permissions) is also written as `role:"user"`
    // response_items but has NO user_message event, so it must be excluded
    // from displayTitle/recap/summary. Regression 2026-07-13: the first
    // `role:user` message is the injected project rules, mistakenly shown as
    // "最近输入".
    const realUserMessages: string[] = [];
    // token_count tracking: codex emits cumulative `total_token_usage` and an
    // incremental `last_token_usage`. We want the LAST turn's usage (matches
    // pi/opencode /resume "last turn" display semantics). When
    // last_token_usage is absent we derive it as total - previous_total.
    let lastRawUsage: RawTokenUsage | undefined;
    // Context window limit from the same token_count event as lastRawUsage
    // (codex reports info.model_context_window per turn; absent on old data).
    let lastContextLimit: number | undefined;
    // Final total_token_usage (cumulative across the whole session) for the
    // Run card's "累计" display. Codex emits this alongside last_token_usage.
    let lastTotalUsage: RawTokenUsage | undefined;
    let previousTotals: RawTokenUsage | undefined;
    // Compaction 统计：codex 的 compact turn 在会话文件里写顶层 `compacted`
    // 事件（含摘要），压缩前后的上下文水位由相邻 token_count 表达。压缩收尾的
    // token_count 增量是 input/cached/output 全 0、只有 total_tokens 有值
    // （窗口被摘要+replacement history 占据），现有 zero-filter 会跳过它，
    // 因此这里必须单独捕获，不能复用 lastRawUsage。
    // 单位口径（review P3-9）：前后两侧统一用 total_tokens —— 压缩前取最近一次
    // 非零 token_count 的 total_tokens（input+output，即该 turn 在窗口内的全部
    // token），压缩后取收尾事件的 total_tokens（压缩后窗口）。不得一边 input
    // 一边 total，否则「压缩前 X → 压缩后 Y」两边单位不一致。
    let compactCount = 0;
    let compactPreContextLength: number | undefined;
    let compactPostContextLength: number | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as {
          type: string;
          payload?: Record<string, unknown>;
          timestamp?: string;
        };
        if (!parsed || typeof parsed.type !== 'string') continue;

        if (parsed.type === 'session_meta' && parsed.payload) {
          sessionMeta = parsed.payload as Record<string, unknown>;
        } else if (parsed.type === 'event_msg' && parsed.payload) {
          // user_message events carry the authoritative human-typed text.
          const payload = parsed.payload as Record<string, unknown>;
          if (payload.type === 'user_message') {
            const text = stringValue(payload.message);
            if (text) {
              realUserMessages.push(text.slice(0, 200));
            }
          } else if (payload.type === 'token_count') {
            const info = payload.info as Record<string, unknown> | undefined;
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
            if (total) {
              previousTotals = total;
              lastTotalUsage = total;
            }
            if (raw && (raw.input_tokens || raw.cached_input_tokens || raw.output_tokens)) {
              lastRawUsage = raw;
              const ctxWindow = info?.model_context_window;
              lastContextLimit = typeof ctxWindow === 'number' ? ctxWindow : undefined;
            }
            // 压缩后的水位：压缩收尾 token_count 全 0（raw 不满足上面 zero-filter），
            // 但 total_tokens 表达真实窗口；之后若出现普通 turn（input>0），
            // 水位回归该 turn，post-compact 值失效。
            if (compactCount > 0 && raw) {
              if (
                raw.total_tokens &&
                !raw.input_tokens &&
                !raw.cached_input_tokens &&
                !raw.output_tokens
              ) {
                compactPostContextLength = raw.total_tokens;
              } else if (raw.input_tokens > 0) {
                compactPostContextLength = undefined;
              }
            }
          }
        } else if (parsed.type === 'compacted') {
          // 顶层 compacted 事件：压缩次数 +1，压缩前水位取最近一次非零 token_count。
          compactCount++;
          if (lastRawUsage?.total_tokens !== undefined) {
            compactPreContextLength = lastRawUsage.total_tokens;
          }
        } else if (parsed.type === 'response_item' && parsed.payload) {
          const payload = parsed.payload as Record<string, unknown>;
          if (payload.type === 'message' && Array.isArray(payload.content)) {
            // Extract text content for display
            const messages = extractMessageContent(payload);
            for (const msg of messages) {
              events.push({
                type: msg.role === 'user' ? 'user' : 'assistant',
                content: msg.text,
                timestamp: parsed.timestamp,
              });
            }
          }
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    const firstUserMessage = realUserMessages[0] ?? '';
    const lastRealUserMessage = realUserMessages[realUserMessages.length - 1] ?? '';

    if (!sessionMeta) {
      return null;
    }

    const sessionId = stringValue(sessionMeta.session_id) ?? stringValue(sessionMeta.id) ?? '';
    const cwd = stringValue(sessionMeta.cwd) ?? '';

    if (!sessionId) {
      return null;
    }

    // Use file mtime as updatedAtMs, or parse timestamp from session_meta
    const stats = fs.statSync(filePath);
    const createdAtMs = sessionMeta.timestamp
      ? new Date(String(sessionMeta.timestamp)).getTime()
      : stats.birthtimeMs;
    const updatedAtMs = stats.mtimeMs;

    // Build ccusage-aligned usage from the last turn's raw tokens.
    // input = raw - cached (codex reports cached input separately), cache
    // creation is never reported by codex, reasoning is a subset of output
    // (display-only, never added to total).
    // contextLength = input_tokens (= (input_tokens-cached) + cached + 0),
    // i.e. input + cacheRead + cacheCreation — the unified context-window
    // occupancy contract across all five readers (review P2-8, excludes
    // output/reasoning).
    let usage: AgentSessionUsage | undefined;
    if (lastRawUsage) {
      const r = lastRawUsage;
      const cached = Math.min(r.cached_input_tokens, r.input_tokens);
      usage = {
        inputTokens: r.input_tokens - cached,
        outputTokens: r.output_tokens,
        contextLength: r.input_tokens,
        contextLimit: lastContextLimit,
        cacheReadTokens: cached,
        cacheCreationTokens: 0,
        totalTokens: r.total_tokens,
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
    }

    return {
      threadId: sessionId,
      cwd,
      firstUserMessage: firstUserMessage || '(no user message)',
      lastRealUserMessage,
      createdAtMs,
      updatedAtMs,
      events,
      usage,
    };
  } catch (err) {
    getLogger().warn(`[codex-rollout-reader] failed to read ${filePath}: ${err}`);
    return null;
  }
}

/**
 * List Codex sessions from rollout files.
 *
 * Returns `{ entries, total }`: `total` is the size of the full cwd-matched
 * set before pagination; `entries` are the newest `limit` entries by mtime.
 *
 * A global order over the full set is established first (plan §1.4: no early
 * termination before ordering) using the lightweight session index — full
 * walk + first-line session_meta parse + stat mtime, 5s TTL cache. Only the
 * returned page is fully parsed for summary/usage (plan §2.2).
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
    // sessions: exclude them explicitly (plan §2.1) so a pure-subagent
    // session (main file missing) never pollutes the list or total.
    if (entry.isSubagent) continue;
    if (filterCwd && entry.cwd !== filterCwd) continue;
    matched.push(entry);
  }

  // Establish the global order by mtime desc, then slice the page.
  // Same-mtime ties use filePath as a deterministic secondary key so index
  // rebuilds / walk order changes never reorder the page.
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
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
 * Read the full content of a specific session by its threadId.
 *
 * P2-4: Uses session index for O(1) file lookup instead of walking the
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

  // P2-4: Use session index for direct file lookup
  let index = getSessionIndex(codexHome);
  let entry = index.get(sessionId);
  // P3-2: On miss, the index may be stale (a rollout file created after the
  // cache was built but within the 5s TTL). Force a refresh and recheck so a
  // brand-new session is found without waiting for TTL expiry.
  if (!entry) {
    index = getSessionIndex(codexHome, true);
    entry = index.get(sessionId);
  }
  if (!entry) {
    return { events: [] };
  }

  // Cwd guard: when a cwd is provided, the session's working directory must
  // match. Without this, /resume <id> finds sessions by global ID lookup and
  // allows resuming a session from workspace B while the user is in workspace A.
  // Codex has no relocation (no EnterWorktree equivalent), so a simple equality
  // check suffices — unlike claude which needs jsonlContainsCwd to handle
  // relocated sessions with multiple cwd values.
  if (opts.cwd && entry.cwd !== opts.cwd) {
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
 * Check if a session is still active (recently updated).
 *
 * P2-4: Uses session index for direct file lookup, then checks mtime
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

  // P2-4: Use session index for direct file lookup + mtime check
  let index = getSessionIndex(codexHome);
  let entry = index.get(sessionId);
  // P3-2: On miss, refresh the index in case the session file was created
  // after the cache was built (within the 5s TTL). See readCodexSessionContent.
  if (!entry) {
    index = getSessionIndex(codexHome, true);
    entry = index.get(sessionId);
  }
  if (!entry) {
    return false;
  }
  // Subagent thread rollouts are never "active sessions": their mtime
  // reflects thread-tree activity, not the parent session's liveness
  // (plan §2.1). A pure-subagent session must report inactive.
  if (entry.isSubagent) {
    return false;
  }
  // Cwd guard: when a cwd is provided, the session's working directory must
  // match (align with claude/pi/opencode which validate cwd).
  if (opts.cwd && entry.cwd !== opts.cwd) {
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
  try {
    const years = fs.readdirSync(sessionsDir);
    for (const year of years) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearPath = path.join(sessionsDir, year);
      if (!fs.statSync(yearPath).isDirectory()) continue;

      const months = fs.readdirSync(yearPath);
      for (const month of months) {
        if (!/^\d{2}$/.test(month)) continue;
        const monthPath = path.join(yearPath, month);
        if (!fs.statSync(monthPath).isDirectory()) continue;

        const days = fs.readdirSync(monthPath);
        for (const day of days) {
          if (!/^\d{2}$/.test(day)) continue;
          const dayPath = path.join(monthPath, day);
          if (!fs.statSync(dayPath).isDirectory()) continue;

          const files = fs
            .readdirSync(dayPath)
            .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
          for (const file of files) {
            result.push(path.join(dayPath, file));
          }
        }
      }
    }
  } catch (err) {
    getLogger().warn(`[codex-rollout-reader] failed to walk sessions dir: ${err}`);
  }
  return result;
}

/**
 * P2-4: Lightweight session index for O(1) lookups by sessionId.
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

const sessionIndexCache = new Map<
  string,
  {
    index: Map<string, SessionIndexEntry>;
    builtAt: number;
  }
>();

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
 * Cache shape note: `sessionIndexCache` is module-level and keyed by the
 * resolved codexHome string. In production `CodexSessionReader` resolves
 * codexHome once in its constructor and reuses it for every call, so a single
 * bridge instance produces exactly one cache entry — the Map does NOT grow
 * unbounded. The TTL refreshes the value on each rebuild; entries are never
 * evicted, but there is effectively just one.
 */
function getSessionIndex(
  resolvedCodexHome: string,
  forceRefresh = false,
): Map<string, SessionIndexEntry> {
  const cacheKey = resolvedCodexHome;
  const cached = sessionIndexCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.builtAt < INDEX_TTL_MS) {
    return cached.index;
  }

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

  sessionIndexCache.set(cacheKey, { index, builtAt: Date.now() });
  return index;
}

/** Clear the session index cache. Exposed for tests. */
export function clearSessionIndexCache(): void {
  sessionIndexCache.clear();
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

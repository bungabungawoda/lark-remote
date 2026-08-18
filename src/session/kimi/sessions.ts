import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonlLines as readJsonlLinesShared, readLastNJsonlLines } from '../common/jsonl.js';
import { UsageAccumulator } from '../common/usage-accumulator.js';
import { getLogger } from '../../logger/index.js';
import type {
  AgentSession,
  AgentSessionReader,
  AgentSessionUsage,
  SessionContent,
  AgentSessionContentEvent,
} from '../../runner/index.js';

import { STALE_MS } from '../common/constants.js';
import { capEvents, paginate } from '../common/pagination.js';
import { truncateUtf8, TOOL_RESULT_MAX_BYTES } from '../../common/truncate.js';
import { truncateToolInput } from '../common/content-blocks.js';

/** Default Kimi config directory */
function defaultKimiDir(): string {
  return path.join(os.homedir(), '.kimi-code');
}

// --- Kimi session index entry ---
interface KimiSessionIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

// --- Kimi session state ---
export interface KimiSessionState {
  version?: number; // schema version: undefined = v1, 2 = v2 (2026-08-08 kimi-code renamed workDir→cwd)
  createdAt: string | number; // v1: string (ISO), v2: number (epoch ms)
  updatedAt: string | number; // v1: string (ISO), v2: number (epoch ms)
  title?: string; // v2 omits this when no custom title set
  isCustomTitle?: boolean; // v2 may omit
  workDir?: string; // schema v1 (absent in v2)
  cwd?: string; // schema v2 (absent in v1)
  lastPrompt?: string; // v2 omits this
}

// --- Kimi wire.jsonl event types ---
interface KimiContextAppendLoopEvent {
  type: 'context.append_loop_event';
  event: {
    type: 'step.begin' | 'step.end' | 'content.part' | 'tool.call' | 'tool.result';
    step?: number;
    part?: {
      type: 'think' | 'text';
      text?: string;
    };
    // tool.call fields (verified against real ~/.kimi-code wire.jsonl, 2026-07-25)
    name?: string;
    args?: Record<string, unknown>;
    toolCallId?: string;
    // tool.result field: { output }, { output, note }, or { isError, output }
    result?: {
      output?: string;
      isError?: boolean;
      note?: string;
    };
    usage?: {
      inputOther: number;
      output: number;
      inputCacheRead: number;
      inputCacheCreation: number;
    };
  };
  time: number;
}

interface KimiUsageRecordEvent {
  type: 'usage.record';
  model: string;
  // Fields are optional: kimi's protocol evolves (usageScope etc. were added
  // later), so old/truncated wire.jsonl records may lack fields or even the
  // whole usage object. Aggregation treats missing fields as 0.
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
  time: number;
}

interface KimiTurnPromptEvent {
  type: 'turn.prompt';
  input: Array<{ type: 'text'; text: string }>;
  origin: { kind: string };
  time: number;
}

/**
 * Compaction completion record in wire.jsonl (§6.3 / kimi-code wire-manifest).
 *
 * REAL shape (2026-08-16 实弹 wire.jsonl + kimi-code 源码)：
 * - `context.apply_compaction`：带 `compactedCount` / `tokensBefore` /
 *   `tokensAfter`（以及 summary 等）；
 * - `full_compaction.complete`：只有 `{type, time}`。
 * `messagesCompacted` 是死字段，真实 record 里不存在——禁止再写。
 */
export interface KimiCompactionRecord {
  type: 'full_compaction.complete' | 'context.apply_compaction';
  /** 压缩掉的消息条数（仅 context.apply_compaction 携带）。 */
  compactedCount?: number;
  /** 压缩前上下文 token 水位（仅 context.apply_compaction 携带）。 */
  tokensBefore?: number;
  /** 压缩后上下文 token 水位（仅 context.apply_compaction 携带）。 */
  tokensAfter?: number;
  time: number;
}

type KimiJsonlEntry =
  | KimiContextAppendLoopEvent
  | KimiUsageRecordEvent
  | KimiTurnPromptEvent
  | KimiCompactionRecord
  | { type: string; [key: string]: unknown };

/** union 含 catch-all 成员，普通 `===` 判窄不生效，用显式守卫收窄（替代 as unknown as）。 */
function isAppendLoopEvent(entry: KimiJsonlEntry): entry is KimiContextAppendLoopEvent {
  return entry.type === 'context.append_loop_event';
}

function isUsageRecord(entry: KimiJsonlEntry): entry is KimiUsageRecordEvent {
  return entry.type === 'usage.record';
}

function isTurnPrompt(entry: KimiJsonlEntry): entry is KimiTurnPromptEvent {
  return entry.type === 'turn.prompt';
}

function isCompactionComplete(entry: KimiJsonlEntry): entry is KimiCompactionRecord {
  return entry.type === 'full_compaction.complete' || entry.type === 'context.apply_compaction';
}

/**
 * Max lines scanned backwards when looking for the last loop event.
 * Bounds the tail scan so huge wire files are not fully parsed.
 */
const LOOP_EVENT_SCAN_LIMIT = 20;

/**
 * Determine whether the last context.append_loop_event in a wire.jsonl is a
 * step.end (turn completed). kimi writes usage.record AFTER step.end at turn
 * completion, so judging by the raw last line never sees the step.end — scan
 * backwards from the tail, skipping non-loop entries (usage.record etc.),
 * until the last loop event is found. Returns false when no loop event is
 * found within the scan window (conservative: caller keeps the session
 * considered active).
 */
function lastLoopEventIsStepEnd(lines: readonly string[]): boolean {
  for (
    let i = lines.length - 1, scanned = 0;
    i >= 0 && scanned < LOOP_EVENT_SCAN_LIMIT;
    i--, scanned++
  ) {
    try {
      const entry = JSON.parse(lines[i]) as KimiJsonlEntry;
      if (!isAppendLoopEvent(entry)) continue;
      return entry.event.type === 'step.end';
    } catch {
      // Skip malformed lines and keep scanning backwards
      continue;
    }
  }
  return false;
}

/** Cache for JSONL file contents to avoid repeated full reads */
const jsonlCache: Map<string, { mtime: number; cachedAt: number; lines: string[] }> = new Map();
const CACHE_TTL_MS = 5000; // 5 second cache TTL
/** Upper bound on cached files; evict the least-recently-used entry past this. */
const CACHE_MAX_ENTRIES = 32;

/**
 * Read lines from a JSONL file with caching.
 * Delegates to the shared readJsonlLines for the actual file read,
 * but wraps it with a TTL-based mtime cache to avoid redundant I/O.
 */
function readJsonlLines(filePath: string): Iterable<string> {
  try {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;

    const cached = jsonlCache.get(filePath);
    // P1-17: TTL must be measured from the cache-write time (cachedAt), not
    // the FILE mtime — a file modified an hour ago would otherwise never hit
    // the cache, making every call re-read and re-write the same entry.
    if (cached && mtime === cached.mtime && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      // LRU refresh on hit: re-insert so recently-used entries survive eviction.
      jsonlCache.delete(filePath);
      jsonlCache.set(filePath, cached);
      return cached.lines;
    }

    const lines = readJsonlLinesShared(filePath);

    jsonlCache.set(filePath, { mtime, cachedAt: Date.now(), lines });
    // P1-17: bound the cache. Map iteration is insertion order; after the LRU
    // refresh above the least-recently-used entry is the first key.
    if (jsonlCache.size > CACHE_MAX_ENTRIES) {
      const oldest = jsonlCache.keys().next().value;
      if (oldest !== undefined) jsonlCache.delete(oldest);
    }

    return lines;
  } catch {
    return [];
  }
}

/** Detect schema version from state.json content */
export function detectSchemaVersion(state: KimiSessionState): 1 | 2 {
  if (state.version === 2) return 2;
  // Heuristic: v2 has `cwd` field and no `workDir`
  if (state.cwd !== undefined && state.workDir === undefined) return 2;
  return 1;
}

/**
 * Extract the working directory from state.json, version-aware.
 * v1 uses `workDir`, v2 uses `cwd`. Returns undefined when neither field is present.
 */
export function extractWorkDir(state: KimiSessionState): string | undefined {
  const version = detectSchemaVersion(state);
  if (version === 2) return state.cwd;
  return state.workDir;
}

/** Cwd guard result: verified / failed / unverifiable */
export type CwdGuardResult = 'verified' | 'failed' | 'unverifiable';

/**
 * Three-state cwd guard. Distinguishes:
 * - verified: session's workDir matches realCwd
 * - failed: session has a workDir but it doesn't match realCwd
 * - unverifiable: session has no workDir field (cannot verify)
 *
 * Unverifiable sessions are handled by the caller: when no cwd source can
 * verify the session, it is rejected (fail-closed), aligned with claude's
 * cwd guard semantics.
 */
export function checkCwdGuard(state: KimiSessionState, realCwd: string): CwdGuardResult {
  const sessionWorkDir = extractWorkDir(state);
  if (sessionWorkDir === undefined) return 'unverifiable';
  if (sessionWorkDir === realCwd) return 'verified';
  return 'failed';
}

/**
 * Kimi Session Reader
 * Reads session history from ~/.kimi-code/
 */
export class KimiSessionReader implements AgentSessionReader {
  private readonly kimiDir: string;

  constructor(kimiDir?: string) {
    this.kimiDir = kimiDir ?? defaultKimiDir();
  }

  /**
   * Scan the session index and return all parsed entries.
   * Returns an empty array when the index file doesn't exist or is unreadable.
   */
  private scanSessionIndex(): KimiSessionIndexEntry[] {
    const indexPath = path.join(this.kimiDir, 'session_index.jsonl');
    if (!fs.existsSync(indexPath)) return [];
    const entries: KimiSessionIndexEntry[] = [];
    for (const line of readJsonlLines(indexPath)) {
      try {
        entries.push(JSON.parse(line) as KimiSessionIndexEntry);
      } catch {
        continue;
      }
    }
    return entries;
  }

  /**
   * Find a single index entry by sessionId, or undefined if not found.
   */
  private findSessionIndexEntry(sessionId: string): KimiSessionIndexEntry | undefined {
    return this.scanSessionIndex().find((e) => e.sessionId === sessionId);
  }

  /**
   * Convenience wrapper: find sessionDir from index, or null if not found.
   */
  private findSessionDirFromIndex(sessionId: string): string | null {
    return this.findSessionIndexEntry(sessionId)?.sessionDir ?? null;
  }

  /**
   * Extract the last turn.prompt text from a wire.jsonl file.
   * Used as a fallback summary source when state.json has no title/lastPrompt
   * (v2 sessions). Scans the tail of the file for efficiency.
   * Returns undefined if no turn.prompt is found.
   */
  private extractLastPromptFromWire(wirePath: string): string | undefined {
    try {
      if (!fs.existsSync(wirePath)) return undefined;
      // Scan backwards from the tail — turn.prompt is typically near the end
      // of a completed turn (before content.part / step.end / usage.record).
      const lines = readLastNJsonlLines(wirePath, 50);
      let lastPrompt: string | undefined;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as KimiJsonlEntry;
          if (isTurnPrompt(entry)) {
            if (entry.input && entry.input.length > 0) {
              lastPrompt = entry.input[0].text;
            }
          }
        } catch {
          continue;
        }
      }
      return lastPrompt?.substring(0, 200);
    } catch {
      return undefined;
    }
  }

  /**
   * List all sessions for a given working directory
   */
  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    try {
      const realCwd = fs.realpathSync(cwd);
      const sessions: AgentSession[] = [];

      for (const entry of this.scanSessionIndex()) {
        // Index workDir is v1-only; v2 sessions may have empty/missing workDir.
        // When index workDir is absent, fall back to state.json's cwd field.
        let entryWorkDir: string | undefined = entry.workDir;
        if (!entryWorkDir) {
          const statePath = path.join(entry.sessionDir, 'state.json');
          try {
            if (fs.existsSync(statePath)) {
              const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as KimiSessionState;
              entryWorkDir = extractWorkDir(state);
            }
          } catch {
            // Unreadable state — cannot determine cwd, skip
          }
        }
        if (entryWorkDir !== realCwd) {
          continue;
        }

        const statePath = path.join(entry.sessionDir, 'state.json');
        let summary = 'New Session';

        if (fs.existsSync(statePath)) {
          try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as KimiSessionState;
            // v1: state.title / state.lastPrompt; v2: these fields may be absent
            summary = state.title || state.lastPrompt || '';
          } catch {
            // Corrupt state.json — fall through to wire.jsonl extraction
          }
        }

        // v2 state.json omits title/lastPrompt: extract from wire.jsonl's last
        // turn.prompt instead. Only scan a small tail to find it — the summary
        // only needs the most recent user prompt.
        if (!summary) {
          const wirePath = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
          summary = this.extractLastPromptFromWire(wirePath) || 'New Session';
        }

        // Get mtime. P1-16: the session DIRECTORY mtime only changes when
        // entries are created/deleted/renamed inside it — kimi appending to
        // agents/main/wire.jsonl during a run does NOT touch it, so dir-mtime
        // sorting lags real activity by minutes. Use the wire.jsonl mtime
        // (the file kimi keeps writing while the session is active) and fall
        // back to the dir mtime when the wire file is missing (e.g. a session
        // that never produced output).
        const wirePath = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(wirePath).mtimeMs;
        } catch {
          mtimeMs = fs.statSync(entry.sessionDir).mtimeMs;
        }

        sessions.push({
          sessionId: entry.sessionId,
          summary,
          mtime: mtimeMs,
        });
      }

      // Sort by mtime descending; same-mtime ties use a deterministic
      // secondary key so ordering is stable across scans.
      sessions.sort((a, b) => b.mtime - a.mtime || a.sessionId.localeCompare(b.sessionId));

      const { items, total } = paginate(sessions, opts ?? {});
      return {
        sessions: items,
        total,
      };
    } catch (error) {
      getLogger().error(`[kimi-session-reader] listSessions error: ${error}`);
      return { sessions: [], total: 0 };
    }
  }

  /**
   * Get the newest session for a given working directory
   */
  getNewestSession(cwd: string): AgentSession | null {
    return this.listSessions(cwd, { limit: 1 }).sessions[0] ?? null;
  }

  /**
   * Read session content (events + usage)
   */
  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number },
  ): SessionContent {
    const wirePath = this.resolveSessionWirePath(sessionId, cwd);
    if (wirePath === null) {
      return { events: [] };
    }

    try {
      const lines = Array.from(readJsonlLines(wirePath));
      const maxEvents = opts?.maxEvents ?? Number.MAX_SAFE_INTEGER;

      const events: AgentSessionContentEvent[] = [];
      let displayTitle: string | undefined;
      const acc = new UsageAccumulator();
      // contextLength is only from the main wire's last usage.record
      // (subagent context is an independent window). Tracked separately
      // from the accumulator's `last` (which could be a subagent record).
      let mainContextLength = 0;
      // §6.3: Compaction stats — count compact events, track last pre-compact context.
      let compactCount = 0;
      let compactPreContextLength: number | undefined;
      // Distinguish "no usage.record in any wire file" (no data → usage:
      // undefined, downstream omits the token block) from "records exist but
      // are all zero / malformed" (real data → aggregate with ?? 0 and return
      // the zeros as-is). A malformed record (usage.record line with missing
      // usage object/fields) still counts as data.
      let hasUsageRecord = false;

      // ccusage-style session-wide aggregation via UsageAccumulator: sum
      // every usage.record's per-component tokens; contextLength is the
      // current context window occupancy (not summable) — keep only the
      // last record's value, and only from the main wire (subagent context
      // is an independent window). Aggregation covers the whole wire.jsonl
      // and is independent of the maxEvents display slice
      // (usage = the session's overall token cost).
      const accumulateUsage = (
        u: KimiUsageRecordEvent['usage'],
        updateContextLength: boolean,
      ): void => {
        hasUsageRecord = true;
        // Malformed records (missing usage object or missing fields) must
        // not poison the accumulators with NaN: count missing fields as 0.
        const inputOther = u?.inputOther ?? 0;
        const output = u?.output ?? 0;
        const inputCacheRead = u?.inputCacheRead ?? 0;
        const inputCacheCreation = u?.inputCacheCreation ?? 0;
        acc.add({
          input: inputOther,
          output,
          cacheRead: inputCacheRead,
          cacheCreation: inputCacheCreation,
        });
        if (updateContextLength) {
          // review P2-8 unified contract: input + cacheRead + cacheCreation
          // (excludes output — generated, not part of the input window).
          mainContextLength = inputOther + inputCacheRead + inputCacheCreation;
        }
      };

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        try {
          const entry = JSON.parse(line) as KimiJsonlEntry;

          // Extract usage from usage.record.
          if (isUsageRecord(entry)) {
            accumulateUsage(entry.usage, true);
            continue;
          }

          // §6.3: Count compaction events and track pre-compact context length.
          // 展示计数只计 context.apply_compaction：一次手动 /compact 会同时写
          // full_compaction.complete + context.apply_compaction 两条（2026-08-16
          // 实弹 wire.jsonl），双计会把一次压缩虚报成 2 次。full_compaction.complete
          // 仅作 R2 runCompact 轮询的完成信号（readCompactionRecords 仍返回两种）。
          if (isCompactionComplete(entry) && entry.type === 'context.apply_compaction') {
            compactCount++;
            // Capture context length before this compaction as the pre-compact
            // watermark (the most recent one is most relevant for display).
            if (entry.tokensBefore !== undefined) {
              compactPreContextLength = entry.tokensBefore;
            }
            continue;
          }

          // P2-7: displayTitle + display events now scan ALL lines (not a
          // line-slice), then `events.slice(-maxEvents)` keeps the LAST N
          // EVENTS. Previously `lines.slice(-maxEvents)` cut raw lines, but
          // usage.record / step.begin / turn.prompt lines produce no display
          // event, so "last 5 lines" could yield only 1~2 visible events —
          // and `slice(-0)` returned the full array. displayTitle takes the
          // last turn.prompt across the whole session (the most recent user
          // prompt), which is the correct catch-up title.
          // Extract display title from turn.prompt
          if (isTurnPrompt(entry)) {
            if (entry.input && entry.input.length > 0) {
              displayTitle = entry.input[0].text;
            }
            continue;
          }

          // Convert loop events to content events
          if (isAppendLoopEvent(entry)) {
            const evt = entry.event;

            if (evt.type === 'content.part' && evt.part) {
              if (evt.part.type === 'think') {
                // Skip thinking blocks for display
                continue;
              } else if (evt.part.type === 'text' && evt.part.text) {
                events.push({
                  type: 'text',
                  content: evt.part.text,
                });
              }
            } else if (evt.type === 'tool.call' && evt.name) {
              // 复用 content-blocks 的 200 字符截断：大 args（整段文件内容
              // 写入、长 prompt）原文进事件会把 resume 卡顶到 28KB 预算之外
              // （2026-08-08 extreme_fallback 故障的推手之一）。
              const inputStr = truncateToolInput(JSON.stringify(evt.args ?? {}));
              events.push({
                type: 'tool_use',
                content: `${evt.name}(${inputStr})`,
              });
            } else if (evt.type === 'tool.result') {
              // result is { output }, { output, note }, or { isError, output }
              // 对齐 opencode reader 的 L2 预折叠：单条 tool_result 上限
              // TOOL_RESULT_MAX_BYTES，病理级输出（如 51KB 文件读取）不会
              // 撑爆 resume 卡，也约束 events[] 内存占用。
              const rawOut = evt.result?.output ?? `[tool result for ${evt.toolCallId}]`;
              events.push({
                type: 'tool_result',
                content: truncateUtf8(rawOut, TOOL_RESULT_MAX_BYTES),
              });
            }
          }
        } catch {
          continue;
        }
      }

      // Subagent wire files (agents/<name>/wire.jsonl, e.g. Task-derived
      // agent-0..N) belong to the same session and the same billing entity:
      // their token cost must be summed into the session-wide usage.
      // contextLength stays main-only (subagent context is an independent
      // window). Display events/title also stay main-only. Any unreadable
      // directory or missing/corrupt wire file is skipped silently.
      // wirePath = <sessionDir>/agents/main/wire.jsonl → agents dir is two
      // levels up (siblings of main hold subagent wires).
      const agentsDir = path.dirname(path.dirname(wirePath));
      try {
        for (const dirent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!dirent.isDirectory() || dirent.name === 'main') {
            continue;
          }
          const subWirePath = path.join(agentsDir, dirent.name, 'wire.jsonl');
          if (!fs.existsSync(subWirePath)) {
            continue;
          }
          for (const subLine of readJsonlLines(subWirePath)) {
            try {
              const subEntry = JSON.parse(subLine) as KimiJsonlEntry;
              if (isUsageRecord(subEntry)) {
                accumulateUsage(subEntry.usage, false);
              }
            } catch {
              continue;
            }
          }
        }
      } catch {
        // agents dir unreadable — fall back to main-only usage
      }

      // Build the final AgentSessionUsage from accumulator totals + main contextLength.
      const t = acc.totals;
      // Kimi semantics: preserve 0 values (not undefined) for cache fields to match original
      const totalUsage: AgentSessionUsage = {
        inputTokens: t.input,
        outputTokens: t.output,
        contextLength: mainContextLength,
        cacheReadTokens: t.cacheRead > 0 ? t.cacheRead : 0,
        cacheCreationTokens: t.cacheCreation > 0 ? t.cacheCreation : 0,
        totalTokens: t.input + t.output + t.cacheRead + t.cacheCreation,
        // Cumulative (session-wide): kimi sums all usage.records; mirrors
        // inputTokens/outputTokens which are already session totals.
        cumulativeTotalTokens: t.input + t.output + t.cacheRead + t.cacheCreation,
        cumulativeInputTokens: t.input,
        cumulativeOutputTokens: t.output,
        cumulativeCacheReadTokens: t.cacheRead > 0 ? t.cacheRead : 0,
        cumulativeCacheCreationTokens: t.cacheCreation > 0 ? t.cacheCreation : 0,
        // §6.3: compaction stats from wire.jsonl
        compactCount,
        ...(compactPreContextLength !== undefined ? { compactPreContextLength } : {}),
      };

      return {
        events: capEvents(events, maxEvents),
        usage: hasUsageRecord ? totalUsage : undefined,
        displayTitle,
      };
    } catch (error) {
      getLogger().error(`[kimi-session-reader] readSessionContent error: ${error}`);
      return { events: [] };
    }
  }

  /**
   * Read the compaction records (context.apply_compaction /
   * full_compaction.complete) from a session's wire.jsonl.
   *
   * Same cwd guard as readSessionContent. Used by KimiAcpRunner.runCompact
   * (R2) to wait for the background compaction to land before ending the run.
   */
  readCompactionRecords(sessionId: string, cwd: string): KimiCompactionRecord[] {
    const wirePath = this.resolveSessionWirePath(sessionId, cwd);
    if (wirePath === null) {
      return [];
    }
    const records: KimiCompactionRecord[] = [];
    try {
      for (const line of readJsonlLines(wirePath)) {
        try {
          const entry = JSON.parse(line) as KimiJsonlEntry;
          if (isCompactionComplete(entry)) {
            records.push({
              type: entry.type,
              ...(entry.compactedCount !== undefined
                ? { compactedCount: entry.compactedCount }
                : {}),
              ...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
              ...(entry.tokensAfter !== undefined ? { tokensAfter: entry.tokensAfter } : {}),
              time: entry.time,
            });
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      getLogger().error(`[kimi-session-reader] readCompactionRecords error: ${error}`);
      return [];
    }
    return records;
  }

  /**
   * Resolve the main wire.jsonl path for a session after passing the cwd
   * guard (state.json + session index fallback). Returns null when the
   * session is unknown, fails the guard, or has no wire file.
   */
  private resolveSessionWirePath(sessionId: string, cwd: string): string | null {
    // Find session directory from index (also retrieve index entry for
    // fallback cwd guard when state.json is missing or unparseable)
    const indexEntry = this.findSessionIndexEntry(sessionId);
    const sessionDir = indexEntry?.sessionDir ?? null;

    if (!sessionDir) {
      return null;
    }

    const statePath = path.join(sessionDir, 'state.json');
    let realCwd: string;
    try {
      realCwd = fs.realpathSync(cwd);
    } catch {
      getLogger().warn(
        `[kimi-session-reader] fs.realpathSync failed for cwd=${cwd} (session ${sessionId}), returning empty`,
      );
      return null;
    }
    let cwdGuardPassed = false;

    try {
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as KimiSessionState;
        const guardResult = checkCwdGuard(state, realCwd);
        if (guardResult === 'failed') {
          return null;
        }
        if (guardResult === 'unverifiable') {
          getLogger().warn(
            `[kimi-session-reader] state.json has no workDir/cwd field for session ${sessionId}, falling back to index workDir`,
          );
          // Fall through to index-based guard below
        } else {
          // verified — state.json cwd matches
          cwdGuardPassed = true;
        }
      }
    } catch {
      // state.json unparseable — fall through to index-based guard
      getLogger().warn(
        `[kimi-session-reader] state.json parse failed for session ${sessionId}, falling back to index workDir`,
      );
    }

    // Fallback: when state.json is missing, unparseable, or has no workDir/cwd,
    // use the workDir from the session index entry as a secondary guard.
    // This prevents /resume <id> from accessing a session belonging to a
    // different workspace when state.json is unavailable.
    if (!cwdGuardPassed) {
      const indexWorkDir = indexEntry?.workDir;
      if (indexWorkDir && indexWorkDir !== realCwd) {
        return null;
      }
      // v2 sessions have empty index workDir (v1-only field) and may lack
      // state.json cwd. When no cwd source can verify the session belongs to
      // the requested workspace, fail-closed to prevent cross-workspace access
      // (aligned with claude's fail-closed cwd guard).
      if (!indexWorkDir) {
        getLogger().warn(
          `[kimi-session-reader] no cwd source (state.json + index) for session ${sessionId}, rejecting (fail-closed)`,
        );
        return null;
      }
    }

    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!fs.existsSync(wirePath)) {
      return null;
    }
    return wirePath;
  }

  /**
   * Check if a session is currently active
   */
  isSessionActive(sessionId: string, cwd: string): boolean {
    const indexEntry = this.findSessionIndexEntry(sessionId);
    const sessionDir = indexEntry?.sessionDir;

    if (!sessionDir) {
      return false;
    }

    // Cwd guard: the session's working directory must match the requested
    // cwd (align with claude/pi/opencode). Mirrors readSessionContent's
    // fail-closed cwd check (state.json workDir/cwd, then index workDir).
    let realCwd: string;
    try {
      realCwd = fs.realpathSync(cwd);
    } catch {
      return false;
    }
    let cwdGuardPassed = false;
    const statePath = path.join(sessionDir, 'state.json');
    try {
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as KimiSessionState;
        const guardResult = checkCwdGuard(state, realCwd);
        if (guardResult === 'failed') return false;
        if (guardResult === 'verified') cwdGuardPassed = true;
      }
    } catch {
      // state.json unparseable — fall through to index-based guard
    }
    if (!cwdGuardPassed) {
      const indexWorkDir = indexEntry?.workDir;
      if (indexWorkDir && indexWorkDir !== realCwd) return false;
      // v2 sessions have empty index workDir (v1-only field) and may lack
      // state.json cwd — fail-closed to prevent cross-workspace access.
      if (!indexWorkDir) return false;
    }

    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!fs.existsSync(wirePath)) {
      return false;
    }

    try {
      const stat = fs.statSync(wirePath);
      const now = Date.now();

      // Check mtime freshness
      if (now - stat.mtimeMs > STALE_MS) {
        return false;
      }

      // Read the tail to check for active indicators. kimi appends
      // usage.record after step.end at turn completion, so the last loop
      // event (not the last line) decides whether the session is complete.
      // P2-5: `lastLoopEventIsStepEnd` only scans backwards up to
      // LOOP_EVENT_SCAN_LIMIT lines, so we read only that many trailing lines
      // via the tail-only helper instead of full-slurping the whole wire log
      // (which can be multi-MB) into a string[].
      const lines = readLastNJsonlLines(wirePath, LOOP_EVENT_SCAN_LIMIT);
      if (lines.length === 0) {
        return false;
      }

      // Consider the session inactive when its last loop event is step.end
      return !lastLoopEventIsStepEnd(lines);
    } catch {
      return false;
    }
  }
}

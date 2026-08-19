import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  findJsonlLine,
  readLastJsonlLine,
  scanJsonlLines,
  readJsonlLinesFromOffset,
} from '../common/jsonl.js';
import { STALE_MS } from '../common/constants.js';
import { capEvents } from '../common/pagination.js';
import { extractContentBlocks } from '../common/content-blocks.js';
import { UsageAccumulator } from '../common/usage-accumulator.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionUsage,
} from '../../runner/index.js';
import {
  SessionIndex,
  extractText,
  isTaskNotificationText,
  CLAUDE_MAPPING,
} from './session-index.js';

/**
 * Directory Claude Code uses to store session transcripts for a given cwd.
 * Claude encodes the cwd by replacing `/` with `-` (e.g.
 * `/Users/x/proj` -> `-Users-x-proj`). Underscores are also replaced with `-`.
 *
 * Note: this encoding is LOSSY (`disk_d/foo` and `disk-d/foo` both encode to
 * `disk-d-foo`). It is only safe to use the result to **locate** files; never
 * to **decode** a directory name back to a cwd. The cwd must always be read
 * from the JSONL content (regression 2026-06-21 /resume & /cd 路径错乱).
 */
function projectDirForCwd(cwd: string, projectsDir: string): string {
  const encoded = cwd.replace(/\//g, '-').replace(/_/g, '-');
  return path.join(projectsDir, encoded);
}

/**
 * cwd guard for the index-miss fallback (readSessionContent /
 * isClaudeSessionActive / findSessionFileInProjects): the project-dir
 * encoding is lossy (N-to-N), so a file located by directory must be verified
 * to actually belong to the requested cwd. A relocated session contains
 * MULTIPLE cwd values (pre- and post-relocate) — accept when ANY `cwd` field
 * matches. Early-stops on the first match (findJsonlLine), keeping the
 * P2-2 single-pass parse-count anchors intact on the fallback path.
 * Regression 2026-08-04 EnterWorktree relocate.
 */
function fileContainsCwd(filePath: string, cwd: string): boolean {
  return (
    findJsonlLine(filePath, (l) => {
      try {
        const obj = JSON.parse(l) as { cwd?: unknown };
        return typeof obj.cwd === 'string' && obj.cwd === cwd;
      } catch {
        return false; // skip malformed line
      }
    }) !== null
  );
}

function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * EnterWorktree relocate support (2026-08-04): Claude Code MOVES the
 * transcript file to the new cwd's project dir mid-session, so the file may
 * not exist under the requested cwd's encoded dir. Fall back to locating
 * `<sessionId>.jsonl` across all project dirs. Deterministic: entries are
 * sorted, first match wins; the cwd guard in `readSessionContent` still
 * validates the file afterwards.
 */
function findSessionFileInProjects(
  sessionId: string,
  projectsDir: string,
  cwd?: string,
): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  const name = `${sessionId}.jsonl`;
  const candidates: string[] = [];
  for (const entry of entries.sort()) {
    const candidate = path.join(projectsDir, entry, name);
    if (fs.existsSync(candidate)) {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  // Multiple copies: prefer the one whose jsonl contains the requested cwd
  // (handles EnterWorktree relocate where the same sessionId exists in
  // multiple project dirs). Fall back to the first sorted candidate.
  if (cwd) {
    for (const candidate of candidates) {
      if (fileContainsCwd(candidate, cwd)) return candidate;
    }
  }
  return candidates[0];
}

/**
 * Lazily-created in-memory session index per projectsDir (session-index.ts).
 * First list/read query builds it (full scan); afterwards refresh() is
 * throttled to a 5s on-demand incremental rescan — no background polling.
 * Keep-alive across calls so the index is actually reused.
 */
const sessionIndexByProjectsDir = new Map<string, SessionIndex>();

function ensureSessionIndex(projectsDir: string): SessionIndex {
  let index = sessionIndexByProjectsDir.get(projectsDir);
  if (!index) {
    index = new SessionIndex(projectsDir);
    sessionIndexByProjectsDir.set(projectsDir, index);
  }
  return index;
}

/**
 * List Claude Code sessions for a given cwd, newest first. Each entry has
 * the sessionId (= jsonl filename stem), a one-line summary extracted from
 * the first user message, and the file mtime. Returns an empty array when
 * the project directory doesn't exist or no jsonl has a matching cwd field.
 */
export function listClaudeSessions(
  cwd: string,
  opts: { limit?: number; projectsDir?: string } = {},
): AgentSession[] {
  // 不传 limit = 返回全集不切片；仅显式传值才 slice（契约迁移 plan §2.1，
  // reader 拿全集算 total 后再自己按 offset/limit 切片）。
  const limit = opts.limit;
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const index = ensureSessionIndex(projectsDir);
  // 首次调用延迟全量建索引；之后 5s 按需节流增量刷新（session-index-manual 拍板 3）。
  index.refresh();
  // 统一 parser 的完整 cwd 集合 → A→B→C 任意中间 cwd 都可列出（核心 bug 修复）。
  // readdir 失败时索引保留旧快照（首次失败则为空），与旧扫描的 readdir 兜底等价。
  const sessions = index.listByCwd(cwd).map((e) => ({
    sessionId: e.sessionId,
    summary: e.summary,
    mtime: e.mtimeMs,
  }));
  return limit === undefined ? sessions : sessions.slice(0, limit);
}

/** Get the newest session for a given cwd. Returns undefined if none exist. */
export function getNewestSession(
  cwd: string,
  opts: { projectsDir?: string } = {},
): AgentSession | undefined {
  const sessions = listClaudeSessions(cwd, { ...opts, limit: 1 });
  return sessions[0];
}

/**
 * Check if a session is still active. Two signals combined:
 *
 * 1. **mtime freshness** (authoritative): an active claude process flushes
 *    JSONL output continuously. A file whose mtime is older than
 *    `STALE_MS` cannot be from a running process. This catches the
 *    common Claude CLI 2.x case where the tail is `last-prompt` / `mode`
 *    (no `type:"result"`) and the process exited long ago (regression 2026-06-21).
 *
 * 2. **last-line terminal marker**: if the last JSON line is `result`
 *    (older CLI) or any explicit terminal event, the session is done
 *    regardless of mtime.
 *
 * Override `now` for tests.
 */

function isSessionActive(filePath: string, mtimeMs: number, now: number = Date.now()): boolean {
  // Hard signal: file untouched for over an hour → can't be from a live process
  if (now - mtimeMs > STALE_MS) return false;

  const lastLine = readLastJsonlLine(filePath);
  if (!lastLine) return false;

  try {
    const obj = JSON.parse(lastLine);
    // Explicit terminal markers — regardless of mtime. Claude CLI 2.x uses
    // `last-prompt` / `mode` (no `result` event) to mark turn end, so a
    // 24-minute-old session with a last-prompt tail is already done
    // (regression 2026-06-21: previously falsely reported as active).
    const TERMINAL_TYPES = new Set(['result', 'last-prompt', 'mode', 'permission-mode']);
    if (typeof obj.type === 'string' && TERMINAL_TYPES.has(obj.type)) return false;
  } catch {
    // ignore parse errors
  }
  return true;
}

/**
 * Check if a Claude session (by sessionId + cwd) is still active.
 * Public wrapper around the internal `isSessionActive(filePath, mtimeMs, now)`
 * for use by `ClaudeSessionReader` and the multi-agent adapter layer.
 *
 * Resolves the jsonl path via `projectDirForCwd`, stats it for mtime, then
 * applies the same mtime-freshness + terminal-marker heuristic
 * used for session-active detection. Returns false if the file doesn't exist.
 */
export function isClaudeSessionActive(
  sessionId: string,
  cwd: string,
  opts: { projectsDir?: string } = {},
): boolean {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const index = ensureSessionIndex(projectsDir);
  if (index.isBuilt) {
    // 索引定位: findBySessionIdAndCwd 内部 re-stat 比 fingerprint（拍板 3），
    // cwdSet 匹配即守卫通过，无需再全文件扫一遍。
    index.refresh();
    const entry = index.findBySessionIdAndCwd(sessionId, cwd);
    if (entry) {
      try {
        const st = fs.statSync(entry.path);
        return isSessionActive(entry.path, st.mtimeMs);
      } catch {
        return false;
      }
    }
  }

  // 索引 miss / 未构建 / 降级 → 精确 sessionId 全目录 fallback + cwd 守卫
  {
    const dir = projectDirForCwd(cwd, projectsDir);
    let filePath = path.join(dir, `${sessionId}.jsonl`);

    if (!fs.existsSync(filePath)) {
      // EnterWorktree relocate: transcript moved to the new cwd's project dir.
      const relocated = findSessionFileInProjects(sessionId, projectsDir, cwd);
      if (!relocated) return false;
      filePath = relocated;
    }

    // Verify the jsonl belongs to the requested cwd (any cwd field may match).
    if (!fileContainsCwd(filePath, cwd)) return false;

    try {
      const st = fs.statSync(filePath);
      return isSessionActive(filePath, st.mtimeMs);
    } catch {
      return false;
    }
  }
}

/**
 * First-pass scan result for readSessionContent.
 * P2-2: previously readSessionContent parsed allLines 3-4 times (usage,
 * findLastUser, events, title/recap). Now a first pass (scalarScan) parses
 * each line once to collect all metadata + the index of the last user
 * message; a second pass only re-parses the TAIL (events after the last user
 * message) so memory is O(tail) rather than O(whole-file) for parsed
 * objects. Total parses ≈ 1.x × line count (P3-1: replaced a parsed[]
 * array that retained every line's object for the function lifetime).
 *
 * P2-5: the index is now a **byte offset** (`tailOffset`) of the line
 * AFTER the last user message, captured during a streaming scan that
 * materializes no `string[]`. The second pass re-reads only the tail from
 * that offset via `readJsonlLinesFromOffset`, so raw line-string memory is
 * O(tail) too — not just the parsed objects. When there is no user message,
 * `tailOffset` stays -1 and the caller re-reads the whole file (the known
 * no-user asymptotic case).
 */
interface ScanResult {
  /** Byte offset where the tail begins (start of the line after the last
   *  user message), or -1 if no user message was found. */
  tailOffset: number;
  /** Aggregated usage from all assistant messages. */
  usage: AgentSessionUsage;
  /** Last ai-title string found, or undefined. */
  aiTitle: string | undefined;
  /** Last compact-summary content found, or undefined. */
  recap: string | undefined;
  /** Last real user text input (non-meta, non-tool-result, non-summary). */
  lastUserMessage: string | undefined;
}

/**
 * P2-2 + P2-5 first-pass scan: stream the file once via `scanJsonlLines`
 * (no `string[]` materialized), parse each line exactly once, and collect
 * all metadata needed by readSessionContent (usage, tailOffset, aiTitle,
 * recap, lastUserMessage). Does NOT retain parsed objects — the events tail
 * is re-parsed separately by `extractEventsFromTail` so memory for both raw
 * line strings and parsed objects is O(tail), not O(whole file).
 */
function scalarScan(filePath: string): ScanResult {
  const acc = new UsageAccumulator();
  // Per-message-id best usage record (per-field max). A streaming assistant
  // message spans multiple jsonl lines sharing the same message id; some
  // backends (third-party gateways, e.g. DeepSeek) write all-zero usage on
  // the early placeholder lines (empty thinking block) and the real usage
  // only on the final line carrying stop_reason. First-occurrence-wins dedup
  // would pin the zero record and discard the real one (regression
  // 2026-08-19: auto-resume card per-run stats all 0). Per-field max
  // reconstructs the full usage regardless of line order — on the official
  // API every line repeats identical usage, so max is a no-op there.
  const usageByMessageId = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheCreation: number }
  >();
  let lastPostTokens = 0;
  let tailOffset = -1;

  let lastAiTitle: string | undefined;
  let lastRecap: string | undefined;
  let lastUserMessage: string | undefined;

  scanJsonlLines(filePath, (line, offset) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }

    // --- usage aggregation (was aggregateSessionUsage) ---
    if (obj.type === 'assistant') {
      const msg = obj.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      if (usage) {
        const msgId = msg?.id as string | undefined;
        if (msgId) {
          const prev = usageByMessageId.get(msgId);
          usageByMessageId.set(msgId, {
            input: Math.max(prev?.input ?? 0, usage.input_tokens ?? 0),
            output: Math.max(prev?.output ?? 0, usage.output_tokens ?? 0),
            cacheRead: Math.max(prev?.cacheRead ?? 0, usage.cache_read_input_tokens ?? 0),
            cacheCreation: Math.max(
              prev?.cacheCreation ?? 0,
              usage.cache_creation_input_tokens ?? 0,
            ),
          });
        }
      }
    }
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      acc.bumpCompact();
      const cm = obj.compactMetadata as { postTokens?: number } | undefined;
      if (cm?.postTokens) {
        lastPostTokens = cm.postTokens;
      }
    }

    // --- last user message offset ---
    // Record the byte offset where the tail should start: the beginning of
    // the NEXT line after this user message. We compute it as this line's
    // start offset + its byte length + 1 (the trailing '\n').
    if (obj.type === 'user') {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg?.role === 'user') {
        tailOffset = offset + Buffer.byteLength(line, 'utf-8') + 1;
      }
    }

    // --- ai-title extraction ---
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      lastAiTitle = obj.aiTitle as string;
    }

    // --- recap extraction (last isCompactSummary wins) ---
    if (obj.type === 'user' && obj.isCompactSummary === true) {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg?.content) {
        const recapContent = extractText(msg.content);
        if (recapContent) {
          lastRecap = recapContent;
        }
      }
    }

    // --- last user message for displayTitle ---
    // Skip: 1) tool_result content, 2) isCompactSummary (recap),
    //       3) isMeta (skill injection / command echo / project rules)
    if (obj.type === 'user' && !obj.isCompactSummary && !obj.isMeta) {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg?.role === 'user' && msg.content) {
        const content = msg.content;
        const isToolResult =
          Array.isArray(content) &&
          content.length > 0 &&
          (content[0] as Record<string, unknown>)?.type === 'tool_result';
        if (!isToolResult) {
          const userContent = extractText(content);
          if (userContent && !isTaskNotificationText(userContent)) {
            lastUserMessage = userContent;
          }
        }
      }
    }
  });

  // Feed one best record per message id, in first-appearance order (Map
  // preserves insertion order), so acc.last is the LAST message's full usage
  // and totals sum each API response exactly once.
  for (const record of usageByMessageId.values()) {
    acc.add(record);
  }

  // Build usage result (same logic as old aggregateSessionUsage)
  const t = acc.totals;
  const l = acc.last;
  // contextLength = current context-window occupancy. Prefer compact_boundary
  // postTokens (the precise post-compact size); otherwise fall back to the
  // last turn's input + cacheRead + cacheCreation (review P2-8 unified
  // contract — excludes output/reasoning, which are generated, not part of
  // the input window). Take the max so a pre-compact turn larger than the
  // post-compact size is not under-reported.
  const lastWindow = l ? l.input + l.cacheRead + l.cacheCreation : 0;
  let contextLength = lastPostTokens;
  if (contextLength === 0 || lastWindow > contextLength) {
    contextLength = lastWindow;
  }

  // 非累计字段 = 末轮（本 run）scope，累计字段 = session 总和（所有 run）。
  // 对齐 codex reader 语义（§9.21：`last_token_usage`=单 turn 增量、
  // `total_token_usage`=session 累计）——否则 jsonl 兜底路径会把 session 累计
  // 当成"本 run"显示，与卡片"本 run ≤ 累计"不变量冲突（累计反而更小）。
  const lastTotal = l ? l.input + l.output + l.cacheRead + l.cacheCreation : 0;
  const usage: AgentSessionUsage = {
    inputTokens: l ? l.input : 0,
    outputTokens: l ? l.output : 0,
    contextLength,
    compactCount: acc.compactCount,
    cacheReadTokens: l && l.cacheRead > 0 ? l.cacheRead : undefined,
    cacheCreationTokens: l && l.cacheCreation > 0 ? l.cacheCreation : undefined,
    totalTokens: lastTotal,
    cumulativeTotalTokens: t.input + t.output + t.cacheRead + t.cacheCreation,
    cumulativeInputTokens: t.input,
    cumulativeOutputTokens: t.output,
    cumulativeCacheReadTokens: t.cacheRead,
    cumulativeCacheCreationTokens: t.cacheCreation,
  };

  return {
    tailOffset,
    usage,
    aiTitle: lastAiTitle,
    recap: lastRecap,
    lastUserMessage,
  };
}

/**
 * P2-2 + P2-5 second-pass: extract content-block events from the tail
 * (lines after the last user message), re-parsing only those lines.
 * `tailLines` is already the tail-only slice (read via
 * `readJsonlLinesFromOffset`), so both raw line-string memory and parsed-
 * object memory are O(tail), not O(whole file) — P3-1 + P2-5.
 *
 * `maxEvents` (optional): when set, only the LAST `maxEvents` events are kept
 * (review P2-7 — unified "last N events" contract across all five readers,
 * matching codex/opencode/pi's `slice(-maxEvents)`). The whole tail is parsed
 * first (usage/title extraction above already scanned the file; this pass only
 * re-parses the short tail), then `slice(-maxEvents)` keeps the most recent
 * events. `maxEvents <= 0` returns `[]` (guards the `slice(-0) === slice(0)`
 * full-array trap).
 */
function extractEventsFromTail(
  tailLines: string[],
  maxEvents?: number,
): AgentSessionContentEvent[] {
  const events: AgentSessionContentEvent[] = [];
  for (const line of tailLines) {
    if (!line.trim()) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const message = obj.message as { content?: unknown; role?: string } | undefined;

    // Expand all content blocks from this message into separate events.
    const blocks = extractContentBlocks(message?.content, CLAUDE_MAPPING);
    const role = message?.role ?? (obj.type as string | undefined) ?? 'unknown';
    const timestamp = obj.timestamp as string | undefined;
    for (const block of blocks) {
      events.push({ type: block.type, content: block.content, timestamp });
    }

    // If message has no content blocks (e.g., metadata-only lines like last-prompt),
    // still emit an event with the raw type so users see what happened
    if (blocks.length === 0 && message?.role) {
      events.push({ type: role, content: `(${role} event)`, timestamp });
    }
  }
  return capEvents(events, maxEvents);
}

export function readSessionContent(
  sessionId: string,
  cwd: string,
  opts: { projectsDir?: string; maxEvents?: number } = {},
): {
  events: AgentSessionContentEvent[];
  usage?: AgentSessionUsage;
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
} {
  const { maxEvents } = opts;
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  let filePath: string | undefined;

  const index = ensureSessionIndex(projectsDir);
  if (index.isBuilt) {
    // 索引定位: findBySessionIdAndCwd 内部 re-stat 比 fingerprint（拍板 3），
    // cwdSet 匹配即守卫通过，无需再全文件扫一遍（不许在指纹一致时全扫）。
    index.refresh();
    const entry = index.findBySessionIdAndCwd(sessionId, cwd);
    if (entry) filePath = entry.path;
  }

  if (filePath === undefined) {
    // 索引 miss / 未构建 / 降级 → 旧 fallback（精确 sessionId 全目录扫描 + cwd 守卫）
    const dir = projectDirForCwd(cwd, projectsDir);
    const direct = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) {
      filePath = direct;
    } else {
      // EnterWorktree relocate: transcript moved to the new cwd's project dir.
      const relocated = findSessionFileInProjects(sessionId, projectsDir, cwd);
      if (!relocated) return { events: [] };
      filePath = relocated;
    }

    // Verify the jsonl actually belongs to the requested cwd (dir encoding is
    // lossy). ANY cwd field may match: relocated sessions contain multiple.
    if (!fileContainsCwd(filePath, cwd)) {
      return { events: [] };
    }
  }

  // P2-2 + P3-1 + P2-5: First pass STREAMS the file once via
  // `scanJsonlLines` (no `string[]` materialized), parsing each line once to
  // collect scalars (usage, tailOffset, aiTitle, recap, lastUserMessage)
  // while retaining NO parsed objects and NO whole-file line array. The
  // tailOffset is the byte offset where the tail begins (start of the line
  // after the last user message). A second pass re-reads ONLY the tail from
  // that offset via `readJsonlLinesFromOffset` and re-parses it for events —
  // O(tail) memory for both raw line strings and parsed objects, instead of
  // O(whole file).
  //
  // Parse ratio: ≈1.0–1.5× line count when a user message exists (streaming
  // full-file scan + tail re-parse of the usually-short post-user lines).
  // When the session has NO user message, tailOffset stays -1 and the tail
  // IS the whole file → scan(N) + tail(N) = 2.0× — the known asymptotic
  // upper bound of the body's two-phase design (still better than pre-P2-2's
  // ~3×). Total parse count adds the index-miss fallback guard's fixed
  // early-stop overhead (~2 parses, independent of line count).
  const scan = scalarScan(filePath);

  // 有 usage 即返回：非累计字段已是末轮 scope，命中判定用 session 累计兜底
  // （末轮可能 input/output 为 0 而仍有 cacheRead，累计口径不会被末轮遮挡）。
  const usage: AgentSessionUsage | undefined =
    (scan.usage.cumulativeTotalTokens ?? 0) > 0 ? scan.usage : undefined;

  // Extract events AFTER the last user message by re-reading + re-parsing
  // only the tail. If no user message was found (tailOffset === -1), fall
  // back to re-reading the whole file so the card still has something to
  // show.
  const tailLines = readJsonlLinesFromOffset(filePath, scan.tailOffset >= 0 ? scan.tailOffset : 0);
  const events = extractEventsFromTail(tailLines, maxEvents);

  // Use aiTitle if available, otherwise fallback to last user message.
  // Truncation is deferred to the consumer (router card building).
  const displayTitle = scan.aiTitle ?? scan.lastUserMessage ?? undefined;

  return {
    events,
    usage,
    aiTitle: scan.aiTitle,
    recap: scan.recap,
    displayTitle,
  };
}

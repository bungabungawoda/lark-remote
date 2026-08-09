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
import { extractContentBlocks, type ContentBlockMapping } from '../common/content-blocks.js';
import { UsageAccumulator } from '../common/usage-accumulator.js';
import { getLogger } from '../../logger/index.js';
import { truncate } from '../../card/card-shared.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionUsage,
} from '../../runner/index.js';

/**
 * Directory Claude Code uses to store session transcripts for a given cwd.
 * Claude encodes the cwd by replacing `/` with `-` (e.g.
 * `/Users/x/proj` -> `-Users-x-proj`). Underscores are also replaced with `-`.
 *
 * Note: this encoding is LOSSY (`my_disk/foo` and `my-disk/foo` both encode to
 * `my-disk-foo`). It is only safe to use the result to **locate** files; never
 * to **decode** a directory name back to a cwd. Use `readCwdFromJsonl` for
 * cwd (regression 2026-06-21 /resume & /cd 路径错乱).
 */
function projectDirForCwd(cwd: string, projectsDir: string): string {
  const encoded = cwd.replace(/\//g, '-').replace(/_/g, '-');
  return path.join(projectsDir, encoded);
}

/**
 * Read cwd from a Claude session JSONL by scanning events for the first
 * `cwd` field. Claude CLI writes the absolute (symlink-resolved) cwd on
 * every event that produces one; older versions wrote it once on init.
 * Returns the first non-empty value, or undefined if absent.
 *
 * This is the SOLE source of truth for cwd. The directory name under
 * ~/.claude/projects/ is lossy (encodes `/` AND `_` as `-`), so it cannot
 * be decoded back to a real path. See regression 2026-06-21 /resume & /cd 路径错乱.
 */
export function readCwdFromJsonl(filePath: string): string | undefined {
  const line = findJsonlLine(filePath, (l) => {
    try {
      const obj = JSON.parse(l);
      return typeof obj.cwd === 'string' && !!obj.cwd;
    } catch {
      return false; // skip malformed line
    }
  });
  if (!line) return undefined;
  try {
    return (JSON.parse(line) as { cwd?: string }).cwd;
  } catch {
    return undefined;
  }
}

/**
 * cwd guard for readSessionContent: the project-dir encoding is lossy
 * (N-to-N), so a file located by directory must be verified to actually
 * belong to the requested cwd. A relocated session contains MULTIPLE cwd
 * values (pre- and post-relocate) — accept when ANY `cwd` field matches
 * (was: first-cwd-only via readCwdFromJsonl, which rejected relocated
 * sessions whose first cwd is the pre-relocate path). Regression
 * 2026-08-04 EnterWorktree relocate.
 */
function jsonlContainsCwd(filePath: string, cwd: string): boolean {
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
function findSessionFileInProjects(sessionId: string, projectsDir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  const name = `${sessionId}.jsonl`;
  for (const entry of entries.sort()) {
    const candidate = path.join(projectsDir, entry, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * P1-19: TTL cache for full project listings (mirror codex getSessionIndex's
 * 5s TTL). Repeated /resume pages re-scan the whole project dir per call
 * (readdir + 2 opens/file + full reads for files without a user message);
 * caching the full list within the TTL removes the redundant scans.
 */
const LIST_CACHE_TTL_MS = 5000;
/** Upper bound on cached project listings; FIFO eviction past this. */
const LIST_CACHE_MAX_ENTRIES = 32;
const claudeListCache = new Map<string, { builtAt: number; sessions: AgentSession[] }>();

/**
 * Extract a one-line summary from a session JSONL by finding the first
 * `type: "user"` record and returning its prompt text. Uses streaming
 * early-stop via `findJsonlLine` so only the lines up to the first user
 * message are read (not the entire file). Returns a fallback when the
 * file is unreadable or contains no user message.
 *
 * P2-3 optimization: previously used `readJsonlLines` (full-file slurp)
 * just to get the first user message. Now uses `findJsonlLine` which
 * stops reading as soon as the predicate matches — typically only the
 * first few lines of the file, saving ~99% I/O on large sessions.
 */
function summarizeSession(filePath: string): string {
  const line = findJsonlLine(filePath, (l) => {
    try {
      const obj: { type?: string; message?: { content?: unknown } } = JSON.parse(l);
      return obj.type === 'user' && !!obj.message?.content && !!extractText(obj.message.content);
    } catch {
      return false;
    }
  });
  if (!line) return '(无摘要)';
  try {
    const obj: { message?: { content?: unknown } } = JSON.parse(line);
    return extractText(obj.message?.content) ?? '(无摘要)';
  } catch {
    return '(无摘要)';
  }
}

/** Claude-specific field-name mapping for content block extraction. */
const CLAUDE_MAPPING: ContentBlockMapping = {
  toolUseType: 'tool_use',
  toolResultType: 'tool_result',
  toolInputField: 'input',
  toolErrorField: 'is_error',
};

/**
 * Extract first text from a user message.
 * Used by readFirstUserMessage.
 */
function extractText(content: unknown): string | null {
  // Handle string content directly (for simple user messages)
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  const blocks = extractContentBlocks(content, CLAUDE_MAPPING);
  // Prefer text block, skip if all blocks are tool_result (user just ran code)
  const textBlock = blocks.find((b) => b.type === 'text');
  if (textBlock) return textBlock.content;
  return null;
}

/**
 * List Claude Code sessions for a given cwd, newest first. Each entry has
 * the sessionId (= jsonl filename stem), a one-line summary extracted from
 * the first user message, and the file mtime. Returns an empty array when
 * the project directory doesn't exist or no jsonl has a matching cwd field.
 *
 * We locate the directory via `projectDirForCwd` (lossy but OK for locating
 * a known cwd) and then **verify** each jsonl's cwd field matches. This
 * prevents collision: `my_disk/foo` and `my-disk/foo` both encode to the same
 * directory name, but only the matching cwd field is kept.
 */
export function listClaudeSessions(
  cwd: string,
  opts: { limit?: number; projectsDir?: string } = {},
): AgentSession[] {
  // 不传 limit = 返回全集不切片；仅显式传值才 slice（契约迁移 plan §2.1，
  // reader 拿全集算 total 后再自己按 offset/limit 切片）。
  const limit = opts.limit;
  const dir = projectDirForCwd(cwd, opts.projectsDir ?? defaultProjectsDir());
  const cacheKey = `${dir}\u0000${cwd}`;
  const cached = claudeListCache.get(cacheKey);
  let sessions: AgentSession[];
  if (cached && Date.now() - cached.builtAt < LIST_CACHE_TTL_MS) {
    sessions = cached.sessions;
  } else {
    sessions = scanClaudeSessions(cwd, dir);
    claudeListCache.set(cacheKey, { builtAt: Date.now(), sessions });
    // Bound the cache (map iteration order = insertion order).
    if (claudeListCache.size > LIST_CACHE_MAX_ENTRIES) {
      const oldest = claudeListCache.keys().next().value;
      if (oldest !== undefined) claudeListCache.delete(oldest);
    }
  }
  return limit === undefined ? sessions : sessions.slice(0, limit);
}

/** Uncached scan of a claude project dir (the expensive part being cached). */
function scanClaudeSessions(cwd: string, dir: string): AgentSession[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const sessions: AgentSession[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      // Verify the jsonl's cwd field actually matches. Defends against
      // directory-name collisions where a different cwd encoded to the same
      // directory name.
      const fileCwd = readCwdFromJsonl(full);
      if (fileCwd !== cwd) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      sessions.push({
        sessionId,
        summary: truncate(summarizeSession(full), 60, { normalizeWhitespace: true }),
        mtime: st.mtimeMs,
      });
    } catch (err) {
      getLogger().warn(`[session] skip ${f}: ${(err as Error).message}`);
    }
  }

  // Same-mtime ties: secondary key keeps the full order deterministic.
  sessions.sort((a, b) => b.mtime - a.mtime || a.sessionId.localeCompare(b.sessionId));
  return sessions;
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
    // (regression 2026-06-21: c5e929a7 falsely reported as active).
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
  const dir = projectDirForCwd(cwd, opts.projectsDir ?? defaultProjectsDir());
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return false;
  try {
    const st = fs.statSync(filePath);
    return isSessionActive(filePath, st.mtimeMs);
  } catch {
    return false;
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
  const seenMessageIds = new Set<string>();
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
        if (msgId && !seenMessageIds.has(msgId)) {
          seenMessageIds.add(msgId);
          acc.add({
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheCreation: usage.cache_creation_input_tokens ?? 0,
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

    // --- last user message offset (was findLastUserIndex) ---
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
    //       3) isMeta (skill injection / command echo / CLAUDE.md)
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
          if (userContent) {
            lastUserMessage = userContent;
          }
        }
      }
    }
  });

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

  const usage: AgentSessionUsage = {
    inputTokens: t.input,
    outputTokens: t.output,
    contextLength,
    compactCount: acc.compactCount,
    cacheReadTokens: t.cacheRead > 0 ? t.cacheRead : undefined,
    cacheCreationTokens: t.cacheCreation > 0 ? t.cacheCreation : undefined,
    totalTokens: t.input + t.output + t.cacheRead + t.cacheCreation,
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
  if (maxEvents !== undefined) {
    if (maxEvents <= 0) return [];
    return events.slice(-maxEvents);
  }
  return events;
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
  const dir = projectDirForCwd(cwd, projectsDir);
  let filePath = path.join(dir, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    // EnterWorktree relocate: transcript moved to the new cwd's project dir.
    const relocated = findSessionFileInProjects(sessionId, projectsDir);
    if (!relocated) return { events: [] };
    filePath = relocated;
  }

  // Verify the jsonl actually belongs to the requested cwd (dir encoding is
  // lossy). ANY cwd field may match: relocated sessions contain multiple.
  if (!jsonlContainsCwd(filePath, cwd)) {
    return { events: [] };
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
  // ~3×). Total parse count adds readCwdFromJsonl's fixed overhead (~2
  // parses, independent of line count).
  const scan = scalarScan(filePath);

  const usage: AgentSessionUsage | undefined =
    scan.usage.inputTokens + scan.usage.outputTokens > 0 ? scan.usage : undefined;

  // Extract events AFTER the last user message by re-reading + re-parsing
  // only the tail. If no user message was found (tailOffset === -1), fall
  // back to re-reading the whole file so the card still has something to
  // show.
  const tailLines = readJsonlLinesFromOffset(filePath, scan.tailOffset >= 0 ? scan.tailOffset : 0);
  const events = extractEventsFromTail(tailLines, maxEvents);

  // Use aiTitle if available, otherwise fallback to last user message (truncated to 200 chars)
  const displayTitle =
    scan.aiTitle ??
    (scan.lastUserMessage
      ? truncate(scan.lastUserMessage, 200, { normalizeWhitespace: true })
      : undefined);

  return {
    events,
    usage,
    aiTitle: scan.aiTitle,
    recap: scan.recap,
    displayTitle,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findJsonlLine, scanJsonlLines, readJsonlLinesFromOffset } from '../common/jsonl.js';
import { extractContentBlocks, type ContentBlockMapping } from '../common/content-blocks.js';
import { UsageAccumulator } from '../common/usage-accumulator.js';
import type {
  AgentSession,
  AgentSessionReader,
  AgentSessionUsage,
  SessionContent,
  AgentSessionContentEvent,
} from '../../runner/index.js';

import { STALE_MS } from '../common/constants.js';
import { capEvents, paginate } from '../common/pagination.js';

/** PI JSONL entry type definitions for usage extraction. */
type PiJsonlEntry =
  | { type: 'message'; message: PiMessageEntry }
  | {
      type: 'compaction';
      tokensBefore?: number;
      firstKeptEntryIndex?: number;
      firstKeptEntryId?: string;
      summary: string;
      timestamp: string;
    }
  | { type: 'session'; id: string; cwd: string; provider: string; modelId: string }
  | { type: 'thinking_level_change' }
  | { type: 'model_change' }
  | { type: string; [key: string]: unknown };

type PiMessageEntry = {
  role: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: object;
  };
  content?: unknown;
  timestamp?: number;
};

function defaultPiDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}

/** Encode cwd to pi's directory name format: '--<cwd-with-/->- + '-' --' */
function projectDirForCwd(cwd: string, sessionsDir: string): string {
  const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
  const encoded = `--${encodedCwd}--`;
  return path.join(sessionsDir, encoded);
}

/**
 * P1-19: TTL cache for pi directory scans (mirror codex getSessionIndex's
 * 5s TTL). Repeated /resume pages re-scan the whole sessions dir per call.
 */
const PI_LIST_TTL_MS = 5000;
/** Upper bound on cached listings; FIFO eviction past this. */
const PI_LIST_MAX_ENTRIES = 32;
const piListCache = new Map<string, { builtAt: number; sessions: AgentSession[] }>();

/** Pi-specific field-name mapping for content block extraction. */
export const PI_MAPPING: ContentBlockMapping = {
  toolUseType: 'toolCall',
  toolResultType: 'toolResult',
  toolInputField: 'arguments',
  toolErrorField: 'isError',
};

/** Extract text from a pi content array (first text block). */
function extractPiText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        return p.text.trim();
      }
    }
  }
  return null;
}

/**
 * Compress a pi skill-injection body to `skill:<name>`.
 *
 * pi wraps an invoked SKILL.md as `<skill name="x" location="...">…</skill>`
 * and injects it through the user channel - often followed by the user's
 * real input on a new line. Without compression the multi-KB body head
 * dominates displayTitle and squeezes out the user's actual words.
 * Replace the whole `<skill>…</skill>` block with `skill:x`, preserving any
 * trailing real text. Falls back to the original text when no skill block
 * is present (or the block is malformed/unclosed). Regression 2026-07-13.
 */
function compressSkillInjection(text: string): string {
  return text
    .replace(/<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g, (_m, name) => `skill:${name}`)
    .trim();
}

/** Get a one-line summary from a pi session JSONL (first user message text).
 *
 * P2-3 optimization: previously used `readJsonlLines` (full-file slurp)
 * just to get the first user message. Now uses `findJsonlLine` which
 * stops reading as soon as the predicate matches — typically only the
 * first few lines of the file, saving ~99% I/O on large sessions.
 */
function summarizePiSession(filePath: string): string {
  const line = findJsonlLine(filePath, (l) => {
    try {
      const obj = JSON.parse(l) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      return (
        obj.type === 'message' &&
        obj.message?.role === 'user' &&
        !!extractPiText(obj.message.content)
      );
    } catch {
      return false;
    }
  });
  if (!line) return '(无摘要)';
  try {
    const obj = JSON.parse(line) as {
      message?: { content?: unknown };
    };
    return extractPiText(obj.message?.content) ?? '(无摘要)';
  } catch {
    return '(无摘要)';
  }
}

/** Read cwd from pi session JSONL first line (session event has cwd field). */
function readCwdFromPiJsonl(filePath: string): string | undefined {
  const line = findJsonlLine(filePath, (l) => {
    try {
      const obj = JSON.parse(l) as { type?: string; cwd?: string };
      return obj.type === 'session' && typeof obj.cwd === 'string' && !!obj.cwd;
    } catch {
      return false;
    }
  });
  if (!line) return undefined;
  try {
    return (JSON.parse(line) as { cwd?: string }).cwd;
  } catch {
    return undefined;
  }
}

/** Find the JSONL file path for a session by scanning the cwd's directory. */
function findSessionFile(sessionId: string, cwd: string, sessionsDir: string): string | null {
  const dir = projectDirForCwd(cwd, sessionsDir);
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    for (const f of files) {
      // pi filenames: <timestamp>_<uuid>.jsonl — match by sessionId (uuid) suffix
      if (f.includes(sessionId)) {
        return path.join(dir, f);
      }
    }
  } catch {
    // dir doesn't exist
  }
  return null;
}

/**
 * P2-6 + P2-5 first-pass scan result for readSessionContent.
 *
 * A single first pass (piScalarScan) parses each line once to collect usage +
 * the index of the last user message + the displayTitle; a second pass only
 * re-parses the TAIL (events after the last user message). Total parses ≈
 * 1.x × line count instead of ~4×.
 *
 * P2-5: the index is now a **byte offset** (`tailOffset`) of the line
 * AFTER the last user message, captured during a streaming scan that
 * materializes no `string[]`. The second pass re-reads only the tail from
 * that offset via `readJsonlLinesFromOffset`, so raw line-string memory is
 * O(tail) too — not just the parsed objects. When there is no user message,
 * `tailOffset` stays -1 and the caller re-reads from the start.
 */
interface PiScanResult {
  /** Byte offset where the tail begins (start of the line after the last
   *  user message), or -1 if no user message was found. */
  tailOffset: number;
  /** Aggregated usage from all assistant messages, or undefined if none. */
  usage: AgentSessionUsage | undefined;
  /** Last real user text input (skill-injection compressed), or undefined. */
  displayTitle: string | undefined;
}

/**
 * P2-6 + P2-5 first-pass scan: stream the file once via `scanJsonlLines`
 * (no `string[]` materialized), parse each line exactly once, and collect
 * all metadata needed by readSessionContent (usage, tailOffset, displayTitle).
 * Does NOT retain parsed objects — the events tail is re-parsed separately
 * by `extractPiEventsFromTail` so memory for both raw line strings and
 * parsed objects is O(tail), not O(whole file).
 *
 * Mirrors claude's scalarScan (P2-2 + P2-5). Preserves the skill-signature
 * compression (`<skill>…</skill>` → `skill:x`) for displayTitle and the
 * "last turn" semantics for usage tokens.
 */
function piScalarScan(filePath: string): PiScanResult {
  const acc = new UsageAccumulator();
  let tailOffset = -1;
  let lastUserText: string | undefined;

  scanJsonlLines(filePath, (line, offset) => {
    let obj: PiJsonlEntry;
    try {
      obj = JSON.parse(line) as PiJsonlEntry;
    } catch {
      return;
    }

    if (obj.type === 'message') {
      const msg = (obj as { message?: PiMessageEntry }).message;
      if (!msg) return;

      // usage aggregation (assistant only)
      if (msg.role === 'assistant' && msg.usage) {
        const u = msg.usage;
        acc.add({
          input: u.input ?? 0,
          output: u.output ?? 0,
          cacheRead: u.cacheRead ?? 0,
          cacheCreation: u.cacheWrite ?? 0,
          total: u.totalTokens ?? 0,
        });
      }

      // last user message offset + displayTitle. Record the byte offset
      // where the tail should start: the beginning of the NEXT line after
      // this user message.
      if (msg.role === 'user') {
        tailOffset = offset + Buffer.byteLength(line, 'utf-8') + 1;
        const text = extractPiText(msg.content);
        // Compress skill-injection bodies so the "最近输入" label shows what
        // the user invoked (skill:x) + any trailing real input, not a
        // truncated SKILL.md head. Regression 2026-07-13.
        if (text) lastUserText = compressSkillInjection(text);
      }
    } else if (obj.type === 'compaction') {
      acc.bumpCompact();
    }
  });

  return {
    tailOffset,
    usage: buildPiUsage(acc),
    // Whitespace-normalized single-line display title (no length truncation —
    // the consumer truncates). Normalization collapses the skill-injection
    // newlines so the title stays on one line.
    displayTitle: lastUserText ? lastUserText.replace(/\s+/g, ' ').trim() : undefined,
  };
}

/**
 * Build the AgentSessionUsage from an accumulator, preserving pi's
 * "last turn" semantics: inputTokens/outputTokens use the LAST turn's
 * values, contextLength = last turn's context-window occupancy
 * (input + cacheRead + cacheCreation, excludes output — review P2-8 unified
 * contract across all five readers), cumulative = session-wide sum.
 * Returns undefined when no usage data was observed.
 */
function buildPiUsage(acc: UsageAccumulator): AgentSessionUsage | undefined {
  const t = acc.totals;
  if (t.input + t.output === 0) {
    return undefined;
  }
  const l = acc.last!;
  const contextLength = l.input + l.cacheRead + l.cacheCreation;
  return {
    inputTokens: l.input,
    outputTokens: l.output,
    contextLength,
    compactCount: acc.compactCount > 0 ? acc.compactCount : undefined,
    cacheReadTokens: l.cacheRead > 0 ? l.cacheRead : 0,
    cacheCreationTokens: l.cacheCreation > 0 ? l.cacheCreation : 0,
    totalTokens: l.total > 0 ? l.total : undefined,
    // Cumulative (session-wide): sum of ALL runs in the jsonl file.
    cumulativeTotalTokens: t.input + t.output + t.cacheRead + t.cacheCreation,
    cumulativeInputTokens: t.input,
    cumulativeOutputTokens: t.output,
    cumulativeCacheReadTokens: t.cacheRead,
    cumulativeCacheCreationTokens: t.cacheCreation,
  };
}

/**
 * P2-6 + P2-5 second-pass: extract content-block events from the tail
 * (lines after the last user message), re-parsing only those lines.
 * `tailLines` is already the tail-only slice (read via
 * `readJsonlLinesFromOffset`), so both raw line-string memory and parsed-
 * object memory are O(tail), not O(whole file) — P2-6 + P2-5.
 */
function extractPiEventsFromTail(tailLines: string[]): AgentSessionContentEvent[] {
  const events: AgentSessionContentEvent[] = [];
  for (const line of tailLines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        message?: {
          content?: unknown;
          role?: string;
          stopReason?: string;
          errorMessage?: string;
        };
        timestamp?: string;
      };
      if (obj.type !== 'message' || !obj.message) continue;

      const message = obj.message;
      // Handle error messages: when stopReason is "error", content is empty
      // but errorMessage has details
      if (message.stopReason === 'error' && message.errorMessage) {
        events.push({
          type: 'error',
          content: `❌ ${message.errorMessage}`,
          timestamp: obj.timestamp,
        });
        continue;
      }

      const blocks = extractContentBlocks(message.content, PI_MAPPING) as Array<{
        type: string;
        content: string;
      }>;
      const role = message.role ?? 'unknown';
      for (const block of blocks) {
        events.push({ type: block.type, content: block.content, timestamp: obj.timestamp });
      }
      if (blocks.length === 0 && message.role) {
        events.push({ type: role, content: `(${role} event)`, timestamp: obj.timestamp });
      }
    } catch {
      /* skip */
    }
  }
  return events;
}

/**
 * PiSessionReader: reads pi agent sessions from `~/.pi/agent/`.
 *
 * pi is file-system based (like Claude), so this implements AgentSessionReader
 * directly. The session list comes from directory scanning.
 */
export class PiSessionReader implements AgentSessionReader {
  private readonly piDir: string;
  /** 会话目录（public：测试可重定向到 fixture 目录，替代 as any）。 */
  sessionsDir: string;

  constructor(opts: { piDir?: string } = {}) {
    this.piDir = opts.piDir ?? defaultPiDir();
    this.sessionsDir = path.join(this.piDir, 'sessions');
  }

  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    // SCAN: filesystem is the source of truth for pi sessions.
    const scanned = this.listSessionsByScan(cwd);
    const { items, total } = paginate(scanned, opts ?? {});
    return {
      sessions: items,
      total,
    };
  }

  getNewestSession(cwd: string): AgentSession | null {
    return this.listSessions(cwd, { limit: 1 }).sessions[0] ?? null;
  }

  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number },
  ): SessionContent {
    let filePath: string | null = null;

    filePath = findSessionFile(sessionId, cwd, this.sessionsDir);
    if (!filePath) {
      return { events: [] };
    }

    // Verify cwd matches
    const fileCwd = readCwdFromPiJsonl(filePath);
    if (fileCwd && fileCwd !== cwd) {
      return { events: [] };
    }

    // P2-5 + P2-6: First pass STREAMS the file once via `scanJsonlLines`
    // (no `string[]` materialized), parsing each line once to collect
    // scalars (usage, tailOffset, displayTitle) while retaining no parsed
    // objects and no whole-file line array. The tailOffset is the byte
    // offset where the tail begins (start of the line after the last user
    // message). A second pass re-reads ONLY the tail from that offset via
    // `readJsonlLinesFromOffset` and re-parses it for events — O(tail)
    // memory for both raw line strings and parsed objects, instead of
    // O(whole file).
    //
    // Parse ratio: ≈1.0–1.5× line count when a user message exists.
    // When the session has NO user message, tailOffset stays -1 and the
    // tail IS the whole file → scan(N) + tail(N) = 2.0× — the known
    // asymptotic upper bound of the two-phase design.
    const scan = piScalarScan(filePath);
    const tailLines = readJsonlLinesFromOffset(
      filePath,
      scan.tailOffset >= 0 ? scan.tailOffset : 0,
    );
    const events = extractPiEventsFromTail(tailLines);

    // Apply maxEvents cap: keep the LAST N events (most recent), matching
    // CodexSessionReader's slice(-maxEvents). maxEvents limits the catch-up
    // tail so auto-resume cards don't load the entire session.
    const cappedEvents = capEvents(events, opts?.maxEvents);

    return {
      events: cappedEvents,
      usage: scan.usage,
      displayTitle: scan.displayTitle,
    };
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    const filePath = findSessionFile(sessionId, cwd, this.sessionsDir);
    if (!filePath) return false;
    try {
      const st = fs.statSync(filePath);
      return Date.now() - st.mtimeMs < STALE_MS;
    } catch {
      return false;
    }
  }
  // --- Private helpers ---

  private listSessionsByScan(cwd: string): AgentSession[] {
    const cacheKey = `${this.sessionsDir}\u0000${cwd}`;
    const cached = piListCache.get(cacheKey);
    if (cached && Date.now() - cached.builtAt < PI_LIST_TTL_MS) {
      return cached.sessions;
    }

    const dir = projectDirForCwd(cwd, this.sessionsDir);
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
        const fileCwd = readCwdFromPiJsonl(full);
        if (fileCwd && fileCwd !== cwd) continue;
        // Extract sessionId (UUID) from filename: <timestamp>_<uuid>.jsonl
        // The timestamp and uuid are separated by '_', and neither contains '_'
        // (timestamps use '-'/'T'/':', UUIDs use '-'). Take the last '_' segment.
        const stem = f.replace('.jsonl', '');
        const sessionId = stem.includes('_') ? stem.slice(stem.lastIndexOf('_') + 1) : stem;
        sessions.push({
          sessionId,
          summary: summarizePiSession(full),
          mtime: st.mtimeMs,
        });
      } catch {
        // skip
      }
    }

    // Same-mtime ties: secondary key keeps the full order deterministic.
    sessions.sort((a, b) => b.mtime - a.mtime || a.sessionId.localeCompare(b.sessionId));

    piListCache.set(cacheKey, { builtAt: Date.now(), sessions });
    // Bound the cache (map iteration order = insertion order).
    if (piListCache.size > PI_LIST_MAX_ENTRIES) {
      const oldest = piListCache.keys().next().value;
      if (oldest !== undefined) piListCache.delete(oldest);
    }
    return sessions;
  }
}

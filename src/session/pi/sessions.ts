import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findJsonlLine } from '../common/jsonl.js';
import { scanJsonlOnce, tailOffsetAfter, scanTailEvents } from '../common/two-pass.js';
import { extractContentBlocks, type ContentBlockMapping } from '../common/content-blocks.js';
import {
  UsageAccumulator,
  contextWindowOccupancy,
  cumulativeUsageFields,
} from '../common/usage-accumulator.js';
import type {
  AgentSession,
  AgentSessionReader,
  AgentSessionUsage,
  SessionContent,
  AgentSessionContentEvent,
} from '../../runner/index.js';

import { isStale } from '../common/constants.js';
import { encodeProjectDirName } from '../../platform/path.js';
import { paginate } from '../common/pagination.js';
import { sortByRecencyDesc } from '../common/recency.js';
import { TtlCache } from '../../common/ttl-cache.js';

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

/**
 * Encode cwd to pi's directory name format: '--<cwd with / \ : -> - --'
 *
 * 与 claude 共用 `encodeProjectDirName`（同一套 win32 归一规则），再去掉
 * 前导分隔符产生的首个 `-`：`/Users/x` -> `Users-x`（不是 `-Users-x`）。
 * win32 同理：`C:\Users\x` -> `C--Users-x`。
 */
function projectDirForCwd(cwd: string, sessionsDir: string): string {
  const encodedCwd = encodeProjectDirName(cwd).replace(/^-+/, '');
  const encoded = `--${encodedCwd}--`;
  return path.join(sessionsDir, encoded);
}

/**
 * P1-19: TTL cache for pi directory scans (mirror codex getSessionIndex's
 * 5s TTL). Repeated /resume pages re-scan the whole sessions dir per call.
 */
const piListCache = new TtlCache<string, AgentSession[]>(5_000, 32);

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

  scanJsonlOnce(filePath, (rawObj, line, offset) => {
    const obj = rawObj as PiJsonlEntry;

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
      // this user message (see tailOffsetAfter).
      if (msg.role === 'user') {
        tailOffset = tailOffsetAfter(line, offset);
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
  return {
    inputTokens: l.input,
    outputTokens: l.output,
    contextLength: contextWindowOccupancy(l),
    compactCount: acc.compactCount > 0 ? acc.compactCount : undefined,
    cacheReadTokens: l.cacheRead > 0 ? l.cacheRead : 0,
    cacheCreationTokens: l.cacheCreation > 0 ? l.cacheCreation : 0,
    totalTokens: l.total > 0 ? l.total : undefined,
    // Cumulative (session-wide): sum of ALL runs in the jsonl file.
    ...cumulativeUsageFields(t),
  };
}

/**
 * P2-6 + P2-5 second-pass tail mapper: expand one parsed tail line into
 * content-block events. Re-parses only tail lines (scanTailEvents does the
 * offset re-read + line filtering), so both raw line-string memory and
 * parsed-object memory are O(tail), not O(whole file) — P2-6 + P2-5.
 * `maxEvents` capping is applied by scanTailEvents.
 */
function mapPiTailLine(rawObj: Record<string, unknown>): AgentSessionContentEvent[] {
  const events: AgentSessionContentEvent[] = [];
  const obj = rawObj as {
    type?: string;
    message?: {
      content?: unknown;
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    timestamp?: string;
  };
  if (obj.type !== 'message' || !obj.message) return events;

  const message = obj.message;
  // Handle error messages: when stopReason is "error", content is empty
  // but errorMessage has details
  if (message.stopReason === 'error' && message.errorMessage) {
    events.push({
      type: 'error',
      content: `❌ ${message.errorMessage}`,
      timestamp: obj.timestamp,
    });
    return events;
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

    // P2-5 + P2-6: Two-pass scan (see `scanJsonlOnce` / `scanTailEvents` in
    // session/common/two-pass.ts): pass 1 streams the file once collecting
    // scalars (usage, tailOffset, displayTitle) with O(1) parsed-object
    // retention; pass 2 re-reads ONLY the tail and re-parses it for events,
    // capped at maxEvents (keeps the LAST N events, matching
    // CodexSessionReader's slice(-maxEvents), so auto-resume cards don't
    // load the entire session).
    const scan = piScalarScan(filePath);
    const events = scanTailEvents(filePath, scan.tailOffset, mapPiTailLine, opts?.maxEvents);

    return {
      events,
      usage: scan.usage,
      displayTitle: scan.displayTitle,
    };
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    const filePath = findSessionFile(sessionId, cwd, this.sessionsDir);
    if (!filePath) return false;
    try {
      const st = fs.statSync(filePath);
      return !isStale(st.mtimeMs);
    } catch {
      return false;
    }
  }
  // --- Private helpers ---

  private listSessionsByScan(cwd: string): AgentSession[] {
    const cacheKey = `${this.sessionsDir}\u0000${cwd}`;
    const cached = piListCache.get(cacheKey);
    if (cached) {
      return cached;
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
    sortByRecencyDesc(
      sessions,
      (s) => s.mtime,
      (s) => s.sessionId,
    );

    piListCache.set(cacheKey, sessions);
    return sessions;
  }
}

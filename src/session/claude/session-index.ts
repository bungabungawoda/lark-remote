import fs from 'node:fs';
import path from 'node:path';
import { scanJsonlLines } from '../common/jsonl.js';
import { extractContentBlocks, type ContentBlockMapping } from '../common/content-blocks.js';
import { truncate } from '../../card/card-shared.js';
import { getLogger } from '../../logger/index.js';

// ─── Types ──────────────────────────────────────────────────

export interface SessionIndexEntry {
  sessionId: string;
  path: string;
  fingerprint: string;
  mtimeMs: number;
  summary: string;
  cwdSet: Set<string>;
}

export interface SessionIndexOptions {
  /** Minimum interval between refresh scans (ms). Default 5000. */
  refreshIntervalMs?: number;
}

// ─── Claude content block mapping (shared with sessions.ts) ─

/** Claude-specific field-name mapping for content block extraction. */
export const CLAUDE_MAPPING: ContentBlockMapping = {
  toolUseType: 'tool_use',
  toolResultType: 'tool_result',
  toolInputField: 'input',
  toolErrorField: 'is_error',
};

/**
 * Detect Claude CLI sub-agent completion notification text.
 * Claude CLI injects a `type:"user"` record with string content starting
 * with `<task-notification>` when a sub-agent (Agent tool) finishes.
 * These must be excluded from displayTitle/summary — they are machine
 * injections, not real user input. Primary criterion: extracted text
 * starts with `<task-notification` (works for both string and array
 * content since `extractText` is called first). Secondary (optional):
 * `origin.kind === 'task-notification'` (not all CLI versions write it).
 */
export function isTaskNotificationText(text: string): boolean {
  return text.trimStart().startsWith('<task-notification');
}

/**
 * Extract first text from a user message.
 * Used by parseSessionJsonl and sessions.ts readSessionContent.
 */
export function extractText(content: unknown): string | null {
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  const blocks = extractContentBlocks(content, CLAUDE_MAPPING);
  const textBlock = blocks.find((b) => b.type === 'text');
  if (textBlock) return textBlock.content;
  return null;
}

// ─── parseSessionJsonl ──────────────────────────────────────

export interface ParsedSession {
  cwdSet: Set<string>;
  summary: string;
}

/**
 * Unified parser: single streaming scan of a JSONL file producing both
 * the complete set of cwd values AND the first real user message summary.
 * Replaces the split readCwdFromJsonl (first-cwd) + jsonlContainsCwd (any-cwd).
 */
export function parseSessionJsonl(filePath: string): ParsedSession {
  const cwdSet = new Set<string>();
  let summary = '(无摘要)';
  let foundSummary = false;

  const ok = scanJsonlLines(filePath, (line) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }

    // Collect cwd values
    if (typeof obj.cwd === 'string' && obj.cwd) {
      cwdSet.add(obj.cwd);
    }

    // Find first real user message for summary (same logic as summarizeSession)
    if (!foundSummary && obj.type === 'user' && !!obj.message) {
      const msg = obj.message as Record<string, unknown>;
      if (msg.content) {
        const text = extractText(msg.content);
        if (text && !isTaskNotificationText(text)) {
          summary = text;
          foundSummary = true;
        }
      }
    }
  });

  // If file couldn't be opened, return empty result
  if (!ok) {
    return { cwdSet: new Set(), summary: '(无摘要)' };
  }

  return { cwdSet, summary };
}

// ─── buildFingerprint ───────────────────────────────────────

/**
 * Build a fingerprint string from file stat metadata.
 * Uses `size + mtimeNs + ctimeNs + dev + ino` (bigint stat).
 * `size`/`mtime` are required; the rest are best-effort.
 */
export function buildFingerprint(filePath: string): string {
  let st: fs.BigIntStats;
  try {
    st = fs.statSync(filePath, { bigint: true });
  } catch {
    return '';
  }
  const parts: string[] = [String(st.size), String(st.mtimeNs)];
  // ctimeNs, dev, ino: include if available
  try {
    parts.push(String(st.ctimeNs));
  } catch {
    /* skip */
  }
  try {
    parts.push(String(st.dev));
  } catch {
    /* skip */
  }
  try {
    parts.push(String(st.ino));
  } catch {
    /* skip */
  }
  return parts.join('|');
}

// ─── SessionIndex ───────────────────────────────────────────

/**
 * In-memory session index with three query views:
 *   byPath:      path → entry
 *   bySessionId: sessionId → Set<path>
 *   byCwd:       cwd → Set<path>
 *
 * Build once, refresh on demand (throttled). Single-file parse failure
 * doesn't affect other files; readdir failure preserves old index.
 */
export class SessionIndex {
  private readonly projectsDir: string;
  private readonly refreshIntervalMs: number;

  private readonly byPath = new Map<string, SessionIndexEntry>();
  private readonly bySessionId = new Map<string, Set<string>>();
  private readonly byCwd = new Map<string, Set<string>>();

  private lastRefreshAt = 0;
  private built = false;

  /** Test-only: count of parseSessionJsonl calls since creation */
  parseCount = 0;
  /** Test-only: count of directory scan operations */
  scanCount = 0;

  constructor(projectsDir: string, opts: SessionIndexOptions = {}) {
    this.projectsDir = projectsDir;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 5000;
  }

  /** Whether a full scan has ever completed successfully (readdir succeeded). */
  get isBuilt(): boolean {
    return this.built;
  }

  // ── Build (initial full scan) ───────────────────────────

  build(): void {
    this.scanCount++;
    this.fullScan();
    this.lastRefreshAt = Date.now();
  }

  // ── Refresh (throttled incremental) ─────────────────────

  refresh(): void {
    const now = Date.now();
    if (now - this.lastRefreshAt < this.refreshIntervalMs) {
      return; // throttled
    }
    this.scanCount++;
    this.fullScan();
    this.lastRefreshAt = now;
  }

  // ── Query: listByCwd ────────────────────────────────────

  listByCwd(cwd: string, opts: { limit?: number; offset?: number } = {}): SessionIndexEntry[] {
    const paths = this.byCwd.get(cwd);
    if (!paths || paths.size === 0) return [];

    // Gather entries, deduplicate by sessionId (keep mtime newest)
    const byId = new Map<string, SessionIndexEntry>();
    for (const p of paths) {
      const entry = this.byPath.get(p);
      if (!entry) continue;
      const existing = byId.get(entry.sessionId);
      if (!existing || entry.mtimeMs > existing.mtimeMs) {
        byId.set(entry.sessionId, entry);
      }
    }

    const sorted = [...byId.values()].sort(
      (a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId),
    );

    const offset = opts.offset ?? 0;
    const limit = opts.limit;
    const sliced =
      limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
    return sliced;
  }

  // ── Query: findBySessionIdAndCwd ────────────────────────

  /**
   * Find a session entry by sessionId and cwd.
   * Re-stats the file to verify fingerprint before returning (拍板 3):
   *   - fingerprint unchanged → trust index cwdSet
   *   - fingerprint changed → re-parse that one file, update index, re-check
   * Returns undefined if not found or cwd doesn't match.
   *
   * Note: we re-stat ALL paths for the sessionId regardless of the old cwdSet,
   * because a fingerprint change may have added the target cwd to the set.
   */
  findBySessionIdAndCwd(sessionId: string, cwd: string): SessionIndexEntry | undefined {
    const paths = this.bySessionId.get(sessionId);
    if (!paths || paths.size === 0) return undefined;

    for (const p of paths) {
      const entry = this.byPath.get(p);
      if (!entry) continue;

      // Re-stat to verify fingerprint (拍板 3)
      const currentFp = buildFingerprint(p);
      if (currentFp === '') {
        // File disappeared — remove from index
        this.removeEntry(p);
        continue;
      }

      if (currentFp === entry.fingerprint) {
        // Fingerprint matches → trust index
        if (entry.cwdSet.has(cwd)) return entry;
        continue;
      }

      // Fingerprint changed → re-parse this single file
      const parsed = parseSessionJsonl(p);
      this.parseCount++;
      try {
        const st = fs.statSync(p, { bigint: true });
        const updated: SessionIndexEntry = {
          sessionId: entry.sessionId,
          path: p,
          fingerprint: currentFp,
          mtimeMs: Number(st.mtimeMs),
          summary: truncate(parsed.summary, 60, { normalizeWhitespace: true }),
          cwdSet: parsed.cwdSet,
        };
        this.updateEntry(p, updated);
        // Re-check cwd after update
        if (updated.cwdSet.has(cwd)) return updated;
      } catch {
        // File gone
        this.removeEntry(p);
      }
    }
    return undefined;
  }

  // ── Internal: full scan ─────────────────────────────────

  private fullScan(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.projectsDir);
    } catch {
      // readdir failure → preserve old index, degrade to fallback
      getLogger().warn('[session-index] readdir failed, preserving old index');
      return;
    }
    // readdir succeeded → the snapshot is authoritative for what we could read.
    this.built = true;

    const currentPaths = new Set<string>();

    for (const entry of entries) {
      const subdir = path.join(this.projectsDir, entry);
      let st: fs.Stats;
      try {
        st = fs.statSync(subdir);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }

      let files: string[];
      try {
        files = fs.readdirSync(subdir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const f of files) {
        const fullPath = path.join(subdir, f);
        currentPaths.add(fullPath);

        // Check fingerprint
        const fp = buildFingerprint(fullPath);
        if (fp === '') continue; // can't stat, skip

        const existing = this.byPath.get(fullPath);
        if (existing && existing.fingerprint === fp) {
          // Unchanged, keep as-is
          continue;
        }

        // New file or fingerprint changed → parse
        // Concurrent-write guard: stat before and after parse, compare fingerprints
        const fpBefore = fp;
        const parsed = parseSessionJsonl(fullPath);
        this.parseCount++;
        const fpAfter = buildFingerprint(fullPath);

        if (fpBefore !== fpAfter) {
          // File was modified during parse → skip this round, retry next refresh
          getLogger().info(`[session-index] concurrent write detected for ${f}, skipping`);
          continue;
        }

        try {
          const fileStat = fs.statSync(fullPath, { bigint: true });
          const sessionId = f.slice(0, -'.jsonl'.length);
          const newEntry: SessionIndexEntry = {
            sessionId,
            path: fullPath,
            fingerprint: fpAfter,
            mtimeMs: Number(fileStat.mtimeMs),
            summary: truncate(parsed.summary, 60, { normalizeWhitespace: true }),
            cwdSet: parsed.cwdSet,
          };
          this.updateEntry(fullPath, newEntry);
        } catch (err) {
          getLogger().warn(`[session-index] skip ${f}: ${(err as Error).message}`);
        }
      }
    }

    // Remove entries for files that no longer exist
    for (const p of [...this.byPath.keys()]) {
      if (!currentPaths.has(p)) {
        this.removeEntry(p);
      }
    }
  }

  // ── Internal: index mutation ────────────────────────────

  private updateEntry(filePath: string, entry: SessionIndexEntry): void {
    const old = this.byPath.get(filePath);

    // Remove old entry's cross-references if it exists
    if (old) {
      this.removeCrossRefs(filePath, old);
    }

    // Set new entry
    this.byPath.set(filePath, entry);

    // bySessionId
    let idPaths = this.bySessionId.get(entry.sessionId);
    if (!idPaths) {
      idPaths = new Set();
      this.bySessionId.set(entry.sessionId, idPaths);
    }
    idPaths.add(filePath);

    // byCwd
    for (const cwd of entry.cwdSet) {
      let cwdPaths = this.byCwd.get(cwd);
      if (!cwdPaths) {
        cwdPaths = new Set();
        this.byCwd.set(cwd, cwdPaths);
      }
      cwdPaths.add(filePath);
    }
  }

  private removeEntry(filePath: string): void {
    const entry = this.byPath.get(filePath);
    if (!entry) return;
    this.removeCrossRefs(filePath, entry);
    this.byPath.delete(filePath);
  }

  private removeCrossRefs(filePath: string, entry: SessionIndexEntry): void {
    // bySessionId
    const idPaths = this.bySessionId.get(entry.sessionId);
    if (idPaths) {
      idPaths.delete(filePath);
      if (idPaths.size === 0) this.bySessionId.delete(entry.sessionId);
    }

    // byCwd
    for (const cwd of entry.cwdSet) {
      const cwdPaths = this.byCwd.get(cwd);
      if (cwdPaths) {
        cwdPaths.delete(filePath);
        if (cwdPaths.size === 0) this.byCwd.delete(cwd);
      }
    }
  }
}

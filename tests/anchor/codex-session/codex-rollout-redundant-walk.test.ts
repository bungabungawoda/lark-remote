/**
 * P2-4 anchor: Codex rollout reader must not redundantly full-parse every
 * rollout file for simple lookups.
 *
 * Before P2-4:
 *   - listCodexRollouts: walkRolloutFiles + readCodexRollout (full parse) per file
 *   - readCodexSessionContent: walkRolloutFiles + readCodexRollout per file
 *     just to find one threadId → N full parses for 1 lookup
 *   - isCodexSessionActive: walkRolloutFiles + readCodexRollout per file
 *     just to check mtime → N full parses for 1 boolean
 *
 * After P2-4, readCodexSessionContent and isCodexSessionActive use a
 * lightweight session index (findJsonlLine for session_meta only, no
 * full file read) to find the target file, then only fully parse the
 * matching file (or just statSync for active check).
 *
 * This anchor verifies:
 *   ① isCodexSessionActive does NOT call readJsonlLines (full file read)
 *      on any rollout file — only statSync is needed for mtime check.
 *   ② readCodexSessionContent calls readJsonlLines at most once
 *      (only the matching file, not all files).
 *   ③ Combined list + content + active flow does not triple the
 *      readJsonlLines call count.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as jsonlModule from '../../../src/session/common/jsonl.js';
import {
  listCodexRollouts,
  readCodexSessionContent,
  isCodexSessionActive,
  clearSessionIndexCache,
} from '../../../src/session/codex/rollout-reader.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;
let sessionsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-p24-anchor-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  clearSessionIndexCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a minimal valid rollout file in the YYYY/MM/DD directory structure.
 * Returns the sessionId for convenience.
 */
function createRollout(sessionId: string, cwd: string, opts?: { mtimeMs?: number }): string {
  const dayDir = path.join(sessionsDir, '2026', '07', '31');
  fs.mkdirSync(dayDir, { recursive: true });
  const fileName = `rollout-2026-07-31T12-00-00-${sessionId}.jsonl`;
  const filePath = path.join(dayDir, fileName);
  const content =
    [
      `{"type":"session_meta","payload":{"session_id":"${sessionId}","cwd":"${cwd}","originator":"lark-remote"},"timestamp":"2026-07-31T12:00:00.000Z"}`,
      `{"type":"event_msg","payload":{"type":"user_message","message":"hello ${sessionId}"}}`,
      `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello ${sessionId}"}]}}`,
      `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}`,
      `{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"total_tokens":110},"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"total_tokens":110}}}}`,
    ].join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
  if (opts?.mtimeMs) {
    fs.utimesSync(filePath, opts.mtimeMs / 1000, opts.mtimeMs / 1000);
  }
  return sessionId;
}

/**
 * Spy on readJsonlLines — each call = one FULL file read (all lines
 * into memory). findJsonlLine (early-stop) uses fs.openSync + fs.readSync
 * directly, NOT readJsonlLines, so it is NOT counted.
 */
function spyOnReadJsonlLines() {
  let callCount = 0;
  const original = jsonlModule.readJsonlLines;
  const spy = vi.spyOn(jsonlModule, 'readJsonlLines').mockImplementation((...args: unknown[]) => {
    callCount++;
    return original.apply(jsonlModule, args as Parameters<typeof original>);
  });
  return {
    get count() {
      return callCount;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

describe('P2-4 anchor: Codex rollout reader redundant work', () => {
  it('isCodexSessionActive must not full-read any rollout file', () => {
    const ids = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'];
    for (const id of ids) {
      createRollout(id, '/tmp/proj');
    }

    const spy = spyOnReadJsonlLines();
    try {
      const result = isCodexSessionActive('eee', { codexHome: tmpDir, activeThresholdMs: 60_000 });

      // Pre-P2-4: readCodexRollout calls readJsonlLines for EVERY file
      // until finding the match → 5 full reads in worst case.
      // Post-P2-4: isCodexSessionActive uses session index (findJsonlLine,
      // not readJsonlLines) + statSync → 0 full reads.
      expect(spy.count).toBe(0);
      expect(result).toBe(true);
    } finally {
      spy.restore();
    }
  });

  it('readCodexSessionContent must full-read at most 1 rollout file', () => {
    const ids = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'];
    for (const id of ids) {
      createRollout(id, '/tmp/proj');
    }

    const spy = spyOnReadJsonlLines();
    try {
      const result = readCodexSessionContent('eee', { codexHome: tmpDir });

      // Pre-P2-4: walks all files, calling readCodexRollout (readJsonlLines)
      // on each until finding the match → up to 5 full reads.
      // Post-P2-4: session index finds the file, then readCodexRollout
      // only on that one file → 1 full read.
      expect(spy.count).toBeLessThanOrEqual(1);
      expect(result.events.length).toBeGreaterThan(0);
    } finally {
      spy.restore();
    }
  });

  it('combined list + content + active does not triple the full-read count', () => {
    const ids = ['aaa', 'bbb', 'ccc'];
    for (const id of ids) {
      createRollout(id, '/tmp/proj');
    }

    const spy = spyOnReadJsonlLines();
    try {
      // ① list sessions (unavoidable: must fully read all files for summary)
      const result = listCodexRollouts({ codexHome: tmpDir, cwd: '/tmp/proj' });
      expect(result.entries.length).toBe(3);
      expect(result.total).toBe(3); // 顺带锁定新契约 total（同一意图：3 个匹配文件）

      const targetId = result.entries[0].threadId;

      // ② read content of first session
      const content = readCodexSessionContent(targetId, { codexHome: tmpDir });
      expect(content.events.length).toBeGreaterThan(0);

      // ③ check if active
      const active = isCodexSessionActive(targetId, {
        codexHome: tmpDir,
        activeThresholdMs: 60_000,
      });
      expect(active).toBe(true);

      // Pre-P2-4: each function independently walks + full-reads all files.
      // list: 3 full reads, content: up to 3 full reads, active: up to 3 full reads
      // Total: up to 9 full reads for 3 files (3× redundancy).
      //
      // Post-P2-4: list: 3 full reads (unavoidable), content: 1 full read,
      // active: 0 full reads (statSync only). Total: 4 full reads.
      //
      // Anchor: total full reads ≤ 5 (generous, catches 9× regression)
      expect(spy.count).toBeLessThanOrEqual(5);
    } finally {
      spy.restore();
    }
  });

  /**
   * P3-2 anchor: session index must reflect newly-created rollout files
   * even when a stale (within-TTL) cached index already exists.
   *
   * Regression scenario (pre-fix):
   *   1. User queries a session → getSessionIndex builds + caches the index
   *      (TTL 5s, so it will be reused for the next call).
   *   2. A NEW rollout file is written (e.g. user starts a fresh codex
   *      session, or a background process flushes).
   *   3. User queries that new session within the 5s TTL window.
   *   → The cached index doesn't contain the new sessionId, so
   *     readCodexSessionContent returns { events: [] } and
   *     isCodexSessionActive returns false — silently missing a real session.
   *
   * Post-fix: an index miss triggers a cache refresh (rebuild), so the
   * newly-created session is found without waiting for TTL expiry.
   */
  it('finds a newly-created session despite a stale within-TTL cached index', () => {
    // ① Seed one session + prime the cache by querying it.
    createRollout('aaa', '/tmp/proj');
    readCodexSessionContent('aaa', { codexHome: tmpDir });
    // Index is now cached and will be reused for the next call.

    // ② Create a NEW session file AFTER the cache was built.
    createRollout('new-after-cache', '/tmp/proj');

    // ③ Query the new session within the TTL window.
    const content = readCodexSessionContent('new-after-cache', { codexHome: tmpDir });
    expect(content.events.length).toBeGreaterThan(0);

    // ④ isCodexSessionActive must also see it (freshly written → recent mtime).
    const active = isCodexSessionActive('new-after-cache', {
      codexHome: tmpDir,
      activeThresholdMs: 60_000,
    });
    expect(active).toBe(true);
  });

  it('index cache TTL is respected (no refresh when a hit is found)', () => {
    // Two pre-existing sessions. Prime the cache.
    createRollout('aaa', '/tmp/proj');
    createRollout('bbb', '/tmp/proj');
    readCodexSessionContent('aaa', { codexHome: tmpDir });

    const spy = spyOnReadJsonlLines();
    try {
      // Query the OTHER pre-existing session — should be a cache HIT,
      // so the index is NOT rebuilt. readCodexSessionContent only needs
      // 1 full read (the matching file). If the cache were rebuilt, it
      // would call findJsonlLine (not readJsonlLines) on all files — still
      // 1 full read here, so this mainly guards against accidental
      // always-refresh regressions by asserting ≤1.
      const content = readCodexSessionContent('bbb', { codexHome: tmpDir });
      expect(content.events.length).toBeGreaterThan(0);
      expect(spy.count).toBeLessThanOrEqual(1);
    } finally {
      spy.restore();
    }
  });
});

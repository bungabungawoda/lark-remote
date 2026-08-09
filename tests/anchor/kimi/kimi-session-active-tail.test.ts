/**
 * P2-5 anchor: kimi isSessionActive tail-only read invariant
 *
 * Before P2-5, kimi isSessionActive (src/session/kimi/sessions.ts) called
 * `Array.from(readJsonlLines(wirePath))` which slurps the ENTIRE wire.jsonl
 * into a `string[]`. But `lastLoopEventIsStepEnd(lines)` only scans backwards
 * from the tail (LOOP_EVENT_SCAN_LIMIT = 20 lines) to find the last
 * `context.append_loop_event`. A multi-MB wire file is fully materialized
 * just to read its last ~20 lines.
 *
 * After P2-5, isSessionActive must use a tail-only helper (e.g.
 * `readLastNJsonlLines`) and must NOT call the full-slurp `readJsonlLines`
 * from the shared jsonl module.
 *
 * This anchor has two cases:
 * 1. Anti-degradation (true red): on a 200-line wire.jsonl ending with a
 *    `step.end` loop event, isSessionActive must not invoke the shared
 *    full-slurp `readJsonlLines` at all. Current implementation calls it → red.
 * 2. Parity (pin, currently green): on the same 200-line wire.jsonl whose
 *    last loop event is `step.end`, isSessionActive returns false (inactive).
 *    This pins the behavior so the tail-only rewrite does not flip the
 *    return value.
 *
 * Intent:
 *   target: isSessionActive reads only the tail of wire.jsonl, not the whole
 *           file, so the full-slurp `readJsonlLines` is never called.
 *   importance: /active and auto-resume call isSessionActive on every kimi
 *               session; full materialization of multi-MB wire files
 *               synchronously blocks the event loop and dominates I/O for
 *               a check that only needs the last ~20 lines.
 *   spec_basis: §P2-5 ("tail-only 读取").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockLogger, jsonlSpy } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  jsonlSpy: {
    readJsonlLines: vi.fn(),
    readLastJsonlLine: vi.fn(),
    findJsonlLine: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// Spy the shared jsonl module. The real implementations are imported lazily
// inside the factory so parity still works, while call counts are tracked.
vi.mock('../../../src/session/common/jsonl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/session/common/jsonl.js')>();
  jsonlSpy.readJsonlLines.mockImplementation(actual.readJsonlLines);
  jsonlSpy.readLastJsonlLine.mockImplementation(actual.readLastJsonlLine);
  jsonlSpy.findJsonlLine.mockImplementation(actual.findJsonlLine);
  return {
    ...actual,
    readJsonlLines: jsonlSpy.readJsonlLines,
    readLastJsonlLine: jsonlSpy.readLastJsonlLine,
    findJsonlLine: jsonlSpy.findJsonlLine,
  };
});

// Import AFTER mocks are in place so kimi sessions.ts picks up the spied
// shared readJsonlLines.
const { KimiSessionReader } = await import('../../../src/session/kimi/index.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-p25-kimi-anchor-'));
  jsonlSpy.readJsonlLines.mockClear();
  jsonlSpy.readLastJsonlLine.mockClear();
  jsonlSpy.findJsonlLine.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a kimi session directory under tmpDir and register it in the
 * session index, then return a KimiSessionReader pointed at tmpDir.
 *
 * Layout (per src/session/kimi/sessions.ts):
 *   <kimiDir>/session_index.jsonl           — one JSON entry per session
 *   <sessionDir>/agents/main/wire.jsonl     — the wire log
 *
 * session_index.jsonl entry: { sessionId, sessionDir, workDir }
 * isSessionActive only uses sessionDir from the index (it does not verify
 * workDir), so workDir is set to a placeholder.
 */
function buildReaderWithSession(sessionId: string): {
  reader: InstanceType<typeof KimiSessionReader>;
  wirePath: string;
} {
  const sessionDir = path.join(tmpDir, 'sessions', sessionId);
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  fs.mkdirSync(path.dirname(wirePath), { recursive: true });

  const indexPath = path.join(tmpDir, 'session_index.jsonl');
  const indexEntry = {
    sessionId,
    sessionDir,
    workDir: '/placeholder/cwd',
  };
  fs.writeFileSync(indexPath, JSON.stringify(indexEntry) + '\n', 'utf-8');

  const reader = new KimiSessionReader(tmpDir);
  return { reader, wirePath };
}

/**
 * Write `lines` (already-serialized JSON strings) to wirePath, joined by
 * newlines with a trailing newline. mtime is the current time, so the
 * STALE_MS (1h) freshness check in isSessionActive passes.
 */
function writeWire(wirePath: string, jsonLines: unknown[]): void {
  const body = jsonLines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(wirePath, body, 'utf-8');
}

describe('P2-5 anchor: kimi isSessionActive tail-only read', () => {
  it('test_anchor_p2_5_kimi_isession_active_no_full_slurp', () => {
    const { reader, wirePath } = buildReaderWithSession('sess-p25-red');

    // 200-line wire.jsonl. The first 180 lines are step.begin loop events
    // (irrelevant noise that the old full-slurp path would materialize).
    // Within the last 20 lines we place a step.end loop event as the final
    // loop event, followed by a usage.record (which kimi writes after
    // step.end at turn completion) so the last LINE is not a loop event —
    // exercising the backward scan in lastLoopEventIsStepEnd.
    const lines: unknown[] = [];
    for (let i = 0; i < 180; i++) {
      lines.push({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', step: i },
        time: i,
      });
    }
    lines.push({
      type: 'context.append_loop_event',
      event: { type: 'step.end', step: 180 },
      time: 180,
    });
    lines.push({
      type: 'usage.record',
      model: 'kimi',
      usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
      time: 181,
    });
    writeWire(wirePath, lines);

    // Sanity: the file actually has the expected number of non-empty lines.
    const nonEmpty = fs
      .readFileSync(wirePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;
    expect(nonEmpty).toBe(182);

    jsonlSpy.readJsonlLines.mockClear();

    const isActive = reader.isSessionActive('sess-p25-red', '/placeholder/cwd');

    // The return value is not asserted here (parity case does that); we
    // only care that the full-slurp helper was bypassed by a tail-only read.
    void isActive;

    // Core invariant: the full-slurp shared readJsonlLines must NOT be
    // called on the (potentially multi-MB) wire.jsonl by isSessionActive.
    // A tail-only helper (readLastNJsonlLines / readLastJsonlLine /
    // findJsonlLine) reads just the tail. The current implementation calls
    // `Array.from(readJsonlLines(wirePath))` → red.
    //
    // We scope the assertion to wirePath: the small session_index.jsonl
    // read (findSessionDirFromIndex) is a separate concern outside P2-5's
    // scope, but slurping the wire file is exactly what P2-5 targets.
    const wireSlurpCalls = jsonlSpy.readJsonlLines.mock.calls.filter(
      (call) => call[0] === wirePath,
    );
    expect(wireSlurpCalls).toHaveLength(0);
  });

  it('test_anchor_p2_5_kimi_isession_active_parity_step_end_inactive', () => {
    const { reader, wirePath } = buildReaderWithSession('sess-p25-parity');

    // Same 200-line fixture: last loop event is step.end → inactive (false).
    const lines: unknown[] = [];
    for (let i = 0; i < 180; i++) {
      lines.push({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', step: i },
        time: i,
      });
    }
    lines.push({
      type: 'context.append_loop_event',
      event: { type: 'step.end', step: 180 },
      time: 180,
    });
    lines.push({
      type: 'usage.record',
      model: 'kimi',
      usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
      time: 181,
    });
    writeWire(wirePath, lines);

    const isActive = reader.isSessionActive('sess-p25-parity', '/placeholder/cwd');

    // Parity pin: last loop event is step.end → session is inactive (false).
    // This must remain false after the tail-only rewrite.
    expect(isActive).toBe(false);
  });
});

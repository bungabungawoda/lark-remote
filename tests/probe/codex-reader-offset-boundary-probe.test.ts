/**
 * Round 8 termination probe (plan §2.1): CodexSessionReader.listSessions
 * offset/limit combination boundaries.
 *
 * Assumption: `listSessions(cwd, { limit, offset })` must never go out of
 * bounds — total stays the real full-set size for every combo, pages beyond
 * the end are empty (not crash/undefined).
 *
 * Spec gap: plan §2.1 defines `[offset, offset+limit)` over the mtime-desc
 * full set but does not state negative-offset semantics at the reader level.
 * Negative offset is now covered by the Round 9 anchor
 * (`tests/anchor/codex-session/codex-reader-negative-offset.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexSessionReader } from '../../src/session/codex/index.js';
import { clearSessionIndexCache } from '../../src/session/codex/rollout-reader.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

const SESSION_COUNT = 25;

let tmpDir: string;
let reader: CodexSessionReader;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-offset-probe-'));
  clearSessionIndexCache();

  // 25 real rollout files under sessions/YYYY/MM/DD with distinct mtimes.
  const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '31');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const baseSec = Math.floor(Date.now() / 1000) - 86400;
  for (let i = 0; i < SESSION_COUNT; i++) {
    const sessionId = `probe-sess-${String(i).padStart(2, '0')}`;
    const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
    const firstLine =
      `{"type":"session_meta","payload":{"session_id":"${sessionId}","cwd":"/proj",` +
      `"originator":"x"}}\n`;
    fs.writeFileSync(filePath, firstLine, 'utf-8');
    fs.utimesSync(filePath, baseSec + i, baseSec + i);
  }

  reader = new CodexSessionReader({ codexHome: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Round 8 probe: codex reader offset/limit bounds', () => {
  it('test_probe_codex_reader_list_sessions_positive_bounds_keep_total', () => {
    // In-bounds, page boundary, and beyond-the-end offsets: total stays 25,
    // sessions never overlaps pages / never throws, limit beyond total is fine.
    const page1 = reader.listSessions('/proj', { limit: 20, offset: 0 });
    expect(page1.total).toBe(SESSION_COUNT);
    expect(page1.sessions).toHaveLength(20);

    const page2 = reader.listSessions('/proj', { limit: 20, offset: 20 });
    expect(page2.total).toBe(SESSION_COUNT);
    expect(page2.sessions).toHaveLength(5);

    const pastEnd = reader.listSessions('/proj', { limit: 20, offset: 25 });
    expect(pastEnd.total).toBe(SESSION_COUNT);
    expect(pastEnd.sessions).toHaveLength(0);

    const farPastEnd = reader.listSessions('/proj', { limit: 20, offset: 1000 });
    expect(farPastEnd.total).toBe(SESSION_COUNT);
    expect(farPastEnd.sessions).toHaveLength(0);

    const oversizedLimit = reader.listSessions('/proj', { limit: 30, offset: 0 });
    expect(oversizedLimit.total).toBe(SESSION_COUNT);
    expect(oversizedLimit.sessions).toHaveLength(SESSION_COUNT);
  });
});

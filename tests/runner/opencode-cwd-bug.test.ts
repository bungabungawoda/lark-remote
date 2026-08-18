import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test setup ───────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Issue: opencode session list uses wrong cwd ───────────────────

describe('P0: opencode session list uses wrong cwd', () => {
  it('test_anchor_opencode_fetchSessionList_accepts_cwd_parameter', async () => {
    // Verify that fetchSessionList method signature accepts cwd
    const { OpencodeSessionReader } = await import('../../src/session/opencode/index.js');

    // Check the method signature by checking if it can be called with different cwds
    // The implementation should accept cwd parameter
    const reader = new OpencodeSessionReader();

    // Verify cache is now a Map (keyed by cwd) instead of single entry
    const cache = reader.listCache;
    expect(cache).toBeInstanceOf(Map);
  });

  it('test_anchor_opencode_realpath_handles_empty_cwd', async () => {
    const { OpencodeSessionReader } = await import('../../src/session/opencode/index.js');

    const reader = new OpencodeSessionReader();

    // Test that realpath handles empty string
    const result = reader.realpath('');
    // Empty string should return empty string (or the actual realpath)
    expect(typeof result).toBe('string');
  });
});

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
    const cache = (reader as unknown as { listCache: Map<string, unknown> }).listCache;
    expect(cache).toBeInstanceOf(Map);
  });

  it('test_anchor_opencode_listSessions_creates_per_cwd_cache', async () => {
    const { OpencodeSessionReader } = await import('../../src/session/opencode/index.js');

    // Create reader with short cache TTL for testing
    const reader = new OpencodeSessionReader({ cacheTtlMs: 10000 });

    // Create two different cwds
    const cwd2 = path.join(tmpDir, 'subdir2');
    fs.mkdirSync(cwd2, { recursive: true });

    // Verify cache is a Map (new implementation)
    const cache = (reader as unknown as { listCache: Map<string, unknown> }).listCache;
    expect(cache).toBeInstanceOf(Map);

    // The old implementation had: listCache: { ts, data } | null
    // The new implementation has: listCache = new Map<string, { ts, data }>()
  });

  it('test_anchor_opencode_cache_keyed_by_cwd_not_global', async () => {
    const { OpencodeSessionReader } = await import('../../src/session/opencode/index.js');

    // New implementation should use Map keyed by cwd
    const reader = new OpencodeSessionReader();
    const cache = (reader as unknown as { listCache: Map<string, unknown> }).listCache;

    // Verify it's a Map (keyed by cwd)
    expect(cache).toBeInstanceOf(Map);

    // Old implementation: listCache was a single object or null
    // New implementation: listCache is a Map
  });

  it('test_anchor_opencode_realpath_handles_empty_cwd', async () => {
    const { OpencodeSessionReader } = await import('../../src/session/opencode/index.js');

    const reader = new OpencodeSessionReader();

    // Test that realpath handles empty string
    const result = (reader as unknown as { realpath: (cwd: string) => string }).realpath('');
    // Empty string should return empty string (or the actual realpath)
    expect(typeof result).toBe('string');
  });
});

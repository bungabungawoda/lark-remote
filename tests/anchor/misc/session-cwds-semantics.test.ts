import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../../../src/session/session-store.js';

describe('sessionCwds semantics', () => {
  it('anchor_clearSessionId_preserves_sessionCwd_default', () => {
    const store = new SessionStore();
    store.setCwd('u1', '/main');
    store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/worktree');
    expect(store.getSessionCwd('u1', 'claude')).toBe('/worktree');

    // Default clearSessionId (parking) — must preserve sessionCwds
    store.clearSessionId('u1', 'claude');
    expect(store.getSessionId('u1', 'claude')).toBeUndefined();
    expect(store.getSessionCwd('u1', 'claude')).toBe('/worktree');
    expect(store.getCwd('u1')).toBe('/main');
  });

  it('anchor_clearSessionId_clearSessionCwd_true_clears', () => {
    const store = new SessionStore();
    store.setCwd('u1', '/main');
    store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/worktree');
    expect(store.getSessionCwd('u1', 'claude')).toBe('/worktree');

    // Explicit clearSessionCwd: true — must clear
    store.clearSessionId('u1', 'claude', { clearSessionCwd: true });
    expect(store.getSessionId('u1', 'claude')).toBeUndefined();
    expect(store.getSessionCwd('u1', 'claude')).toBeUndefined();
    expect(store.getCwd('u1')).toBe('/main');
  });

  it('anchor_setCwd_clears_sessionCwds', () => {
    const store = new SessionStore();
    store.setCwd('u1', '/main');
    store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/worktree');
    store.setSessionIdAndSessionCwd('u1', 'codex', 's2', '/codex-dir');
    expect(store.getSessionCwd('u1', 'claude')).toBe('/worktree');
    expect(store.getSessionCwd('u1', 'codex')).toBe('/codex-dir');

    // setCwd — must clear all sessionCwds
    store.setCwd('u1', '/new-main');
    expect(store.getSessionCwd('u1', 'claude')).toBeUndefined();
    expect(store.getSessionCwd('u1', 'codex')).toBeUndefined();
    expect(store.getCwd('u1')).toBe('/new-main');
  });

  it('anchor_sessionCwds_persist_round_trip', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scwds-'));
    try {
      const filePath = path.join(tmpDir, 'session.json');
      const store = new SessionStore(filePath);
      store.setCwd('u1', '/main');
      store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/worktree');

      // Rebuild from disk
      const restored = new SessionStore(filePath);
      expect(restored.getCwd('u1')).toBe('/main');
      expect(restored.getSessionId('u1', 'claude')).toBe('s1');
      expect(restored.getSessionCwd('u1', 'claude')).toBe('/worktree');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('anchor_all_construction_paths_carry_sessionCwds', () => {
    // Verify that set, setSessionId, setSessionIdAndCwd, setPreviousSessionId,
    // clearPreviousSessionId, setArrivalSessionId all preserve existing sessionCwds
    const store = new SessionStore();
    store.setCwd('u1', '/main');
    store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/worktree');

    // setSessionId preserves sessionCwds
    store.setSessionId('u1', 'claude', 's2');
    expect(store.getSessionCwd('u1', 'claude')).toBe('/worktree');

    // setSessionIdAndCwd preserves sessionCwds
    store.setSessionIdAndCwd('u1', 'claude', 's3', '/main');
    expect(store.getSessionCwd('u1', 'claude')).toBe('/worktree');

    // setPreviousSessionId preserves sessionCwds
    store.setPreviousSessionId('u1', 'codex', 'codex-s1');
    expect(store.getSessionCwd('u1', 'claude')).toBe('/worktree');

    // clearPreviousSessionId preserves sessionCwds
    store.clearPreviousSessionId('u1', 'codex');
    expect(store.getSessionCwd('u1', 'claude')).toBe('/worktree');

    // setArrivalSessionId preserves sessionCwds
    store.setArrivalSessionId('u1', 'claude', 's3');
    expect(store.getSessionCwd('u1', 'claude')).toBe('/worktree');
  });
});

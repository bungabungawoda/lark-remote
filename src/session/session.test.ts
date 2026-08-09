import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from './index.js';

describe('SessionStore', () => {
  it('stores and retrieves session entries', () => {
    const store = new SessionStore();
    store.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    const entry = store.get('user1');
    expect(entry?.cwd).toBe('/tmp');
    expect(entry?.sessions.get('claude')).toBe('s1');
  });

  it('returns undefined for unknown user', () => {
    const store = new SessionStore();
    expect(store.get('unknown')).toBeUndefined();
  });

  it('deletes session entry', () => {
    const store = new SessionStore();
    store.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    store.delete('user1');
    expect(store.get('user1')).toBeUndefined();
  });

  it('clears sessionId but keeps cwd', () => {
    const store = new SessionStore();
    store.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    store.clearSessionId('user1', 'claude');
    const entry = store.get('user1');
    expect(entry?.sessions.get('claude')).toBe('');
    expect(entry?.cwd).toBe('/tmp');
  });

  it('setCwd clears sessionId (§9.1)', () => {
    const store = new SessionStore();
    store.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    store.setCwd('user1', '/home');
    const entry = store.get('user1');
    expect(entry?.sessions.get('claude')).toBe('');
    expect(entry?.cwd).toBe('/home');
  });

  it('setCwd works for new user', () => {
    const store = new SessionStore();
    store.setCwd('user1', '/home');
    const entry = store.get('user1');
    // For new user, sessions map is empty (no agent pre-populated)
    expect(entry?.sessions.size).toBe(0);
    expect(entry?.cwd).toBe('/home');
  });

  it('getCwd returns cwd or undefined', () => {
    const store = new SessionStore();
    expect(store.getCwd('user1')).toBeUndefined();
    store.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    expect(store.getCwd('user1')).toBe('/tmp');
  });

  it('getSessionId returns sessionId or undefined', () => {
    const store = new SessionStore();
    expect(store.getSessionId('user1')).toBeUndefined();
    store.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    expect(store.getSessionId('user1', 'claude')).toBe('s1');
    // Empty sessionId returns undefined
    store.clearSessionId('user1', 'claude');
    expect(store.getSessionId('user1', 'claude')).toBeUndefined();
  });

  it('different users have independent sessions', () => {
    const store = new SessionStore();
    store.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    store.set('user2', {
      sessions: new Map([['claude', 's2']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/home',
    });
    expect(store.get('user1')?.cwd).toBe('/tmp');
    expect(store.get('user1')?.sessions.get('claude')).toBe('s1');
    expect(store.get('user2')?.cwd).toBe('/home');
    expect(store.get('user2')?.sessions.get('claude')).toBe('s2');
    store.delete('user1');
    expect(store.get('user1')).toBeUndefined();
    expect(store.get('user2')?.cwd).toBe('/home');
  });
});

describe('SessionStore persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists cwd to disk on setCwd', () => {
    const filePath = path.join(tmpDir, 'last-session.json');
    const store = new SessionStore(filePath);
    store.setCwd('user1', '/tmp/project');

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // New format: cwd is stored in an object with sessions, previousSessions
    // and arrivalSessions (both empty until set)
    expect(parsed.user1).toEqual({
      cwd: '/tmp/project',
      sessions: {},
      previousSessions: {},
      sessionCwds: {},
      arrivalSessions: {},
    });
  });

  it('restores cwd from disk on construction', () => {
    const filePath = path.join(tmpDir, 'last-session.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          user1: {
            cwd: '/tmp/project',
            sessions: {},
            previousSessions: {},
            arrivalSessions: {},
            sessionCwds: {},
          },
          user2: {
            cwd: '/home/code',
            sessions: {},
            previousSessions: {},
            arrivalSessions: {},
            sessionCwds: {},
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const store = new SessionStore(filePath);
    expect(store.getCwd('user1')).toBe('/tmp/project');
    expect(store.getCwd('user2')).toBe('/home/code');
    // sessionId is always empty after restore (process-scoped)
    expect(store.getSessionId('user1')).toBeUndefined();
  });

  it('handles corrupt file gracefully', () => {
    const filePath = path.join(tmpDir, 'last-session.json');
    fs.writeFileSync(filePath, 'not valid json{{{', 'utf-8');

    const store = new SessionStore(filePath);
    expect(store.getCwd('user1')).toBeUndefined();
  });

  it('handles missing file gracefully', () => {
    const filePath = path.join(tmpDir, 'nonexistent.json');
    const store = new SessionStore(filePath);
    expect(store.getCwd('user1')).toBeUndefined();
  });

  it('deletes user from persisted data', () => {
    const filePath = path.join(tmpDir, 'last-session.json');
    const store = new SessionStore(filePath);
    store.setCwd('user1', '/tmp');
    store.setCwd('user2', '/home');
    store.delete('user1');

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.user1).toBeUndefined();
    // New format: object with cwd + sessions + previousSessions + arrivalSessions
    expect(parsed.user2).toEqual({
      cwd: '/home',
      sessions: {},
      previousSessions: {},
      sessionCwds: {},
      arrivalSessions: {},
    });
  });

  it('clearSessionId persists cwd', () => {
    const filePath = path.join(tmpDir, 'last-session.json');
    const store = new SessionStore(filePath);
    store.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    store.clearSessionId('user1', 'claude');

    const restored = new SessionStore(filePath);
    expect(restored.getCwd('user1')).toBe('/tmp');
  });

  it('works without persistence when no path is given', () => {
    const store = new SessionStore();
    store.setCwd('user1', '/tmp');
    expect(store.getCwd('user1')).toBe('/tmp');
    // No file created
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('round-trip: set cwd → restart → same cwd', () => {
    const filePath = path.join(tmpDir, 'last-session.json');

    // First run
    const store1 = new SessionStore(filePath);
    store1.setCwd('user1', '/home/user/project');

    // Simulate restart
    const store2 = new SessionStore(filePath);
    expect(store2.getCwd('user1')).toBe('/home/user/project');
    expect(store2.getSessionId('user1')).toBeUndefined();
  });

  it('clearSessionId bumps epoch even when already empty or entry missing', () => {
    const store = new SessionStore();
    // 1. No entry at all → clearSessionId still bumps epoch
    store.clearSessionId('u1', 'claude');
    expect(store.getSessionEpoch('u1', 'claude')).toBe(1);

    // 2. setCwd bumps user-level epoch (+1), then clearSessionId bumps agent-level epoch (+1)
    store.setCwd('u1', '/tmp');
    store.clearSessionId('u1', 'claude');
    // epoch = user(1 from setCwd) + agent(1 from step1 + 1 from this clearSessionId) = 3
    expect(store.getSessionEpoch('u1', 'claude')).toBe(3);

    // 3. Second clearSessionId (empty→empty) still bumps
    store.clearSessionId('u1', 'claude');
    expect(store.getSessionEpoch('u1', 'claude')).toBe(4);
  });

  it('setSessionIdAndCwd / setSessionIdAndSessionCwd do NOT bump epoch', () => {
    const store = new SessionStore();
    store.setCwd('u1', '/tmp');
    const epochBefore = store.getSessionEpoch('u1', 'claude');

    store.setSessionIdAndCwd('u1', 'claude', 's1', '/tmp');
    expect(store.getSessionEpoch('u1', 'claude')).toBe(epochBefore);

    store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/tmp/session');
    expect(store.getSessionEpoch('u1', 'claude')).toBe(epochBefore);
  });

  it('setCwd bumps user-level epoch covering all agents', () => {
    const store = new SessionStore();
    store.setCwd('u1', '/tmp');
    // 'pi' was never in sessions map, but user-level epoch still covers it
    expect(store.getSessionEpoch('u1', 'pi')).toBeGreaterThanOrEqual(1);
  });

  it('setSessionId bumps epoch', () => {
    const store = new SessionStore();
    store.setCwd('u1', '/tmp');
    const epochBefore = store.getSessionEpoch('u1', 'claude');

    store.setSessionId('u1', 'claude', 's-new');
    expect(store.getSessionEpoch('u1', 'claude')).toBe(epochBefore + 1);
  });

  it('persists previousSessions and arrivalSessions across rebuild', () => {
    const filePath = path.join(tmpDir, 'last-session.json');
    const store = new SessionStore(filePath);
    store.setCwd('user1', '/tmp');
    store.setSessionId('user1', 'codex', 'codex-session-C');
    store.setPreviousSessionId('user1', 'codex', 'codex-session-C');
    // 显式「清空到达」：'' 条目必须持久化保留（A12 语义）
    store.setArrivalSessionId('user1', 'codex', '');

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.user1).toEqual({
      cwd: '/tmp',
      sessions: { codex: 'codex-session-C' },
      previousSessions: { codex: 'codex-session-C' },
      sessionCwds: {},
      arrivalSessions: { codex: '' },
    });

    const restored = new SessionStore(filePath);
    expect(restored.getSessionId('user1', 'codex')).toBe('codex-session-C');
    expect(restored.getPreviousSessionId('user1', 'codex')).toBe('codex-session-C');
    // '' 到达基线读取为 undefined（与 sessions 空串语义一致），但持久化侧保留
    expect(restored.getArrivalSessionId('user1', 'codex')).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from './index.js';

describe('SessionStore', () => {
  it('stores and retrieves session entries', () => {
    const store = new SessionStore();
    store.setSessionIdAndCwd('user1', 'claude', 's1', '/tmp');
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
    store.setSessionIdAndCwd('user1', 'claude', 's1', '/tmp');
    store.delete('user1');
    expect(store.get('user1')).toBeUndefined();
  });

  it('clears sessionId but keeps cwd', () => {
    const store = new SessionStore();
    store.setSessionIdAndCwd('user1', 'claude', 's1', '/tmp');
    store.clearSessionId('user1', 'claude');
    const entry = store.get('user1');
    expect(entry?.sessions.get('claude')).toBe('');
    expect(entry?.cwd).toBe('/tmp');
  });

  it('setCwd clears sessionId (§9.1)', () => {
    const store = new SessionStore();
    store.setSessionIdAndCwd('user1', 'claude', 's1', '/tmp');
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
    store.setSessionIdAndCwd('user1', 'claude', 's1', '/tmp');
    expect(store.getCwd('user1')).toBe('/tmp');
  });

  it('getSessionId returns sessionId or undefined', () => {
    const store = new SessionStore();
    expect(store.getSessionId('user1')).toBeUndefined();
    store.setSessionIdAndCwd('user1', 'claude', 's1', '/tmp');
    expect(store.getSessionId('user1', 'claude')).toBe('s1');
    // Empty sessionId returns undefined
    store.clearSessionId('user1', 'claude');
    expect(store.getSessionId('user1', 'claude')).toBeUndefined();
  });

  it('different users have independent sessions', () => {
    const store = new SessionStore();
    store.setSessionIdAndCwd('user1', 'claude', 's1', '/tmp');
    store.setSessionIdAndCwd('user2', 'claude', 's2', '/home');
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
    store.setSessionIdAndCwd('user1', 'claude', 's1', '/tmp');
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
    // 显式「清空到达」：'' 条目必须持久化保留（语义）
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

/**
 * load() 的字段完整性 / 空值语义（characterization）。
 *
 * 后续把逐字段解析抽成模块级纯函数后，这些分支必须原样保留：四字段缺一
 * 即整条跳过；'' arrival 是有意义的记录（不能当空态丢掉）；sessions /
 * previous / sessionCwds 的空串值被丢弃而 arrival 的空串值保留。
 */
describe('SessionStore load — 字段完整性与空值语义 (characterization)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-load-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function storeWith(data: unknown): SessionStore {
    const filePath = path.join(tmpDir, 'last-session.json');
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    return new SessionStore(filePath);
  }

  const full = {
    cwd: '/tmp',
    sessions: {},
    previousSessions: {},
    arrivalSessions: {},
    sessionCwds: {},
  };

  it('四个 session 字段任一缺失 → 整条记录跳过', () => {
    for (const key of ['sessions', 'previousSessions', 'arrivalSessions', 'sessionCwds']) {
      const row: Record<string, unknown> = { ...full };
      delete row[key];
      expect(storeWith({ u1: row }).get('u1')).toBeUndefined();
    }
  });

  it("'' arrival 条目让记录保留（cwd 空、其它 map 空）", () => {
    const store = storeWith({
      u1: { sessions: {}, previousSessions: {}, arrivalSessions: { codex: '' }, sessionCwds: {} },
    });
    const entry = store.get('u1');
    expect(entry).toBeDefined();
    expect(entry?.cwd).toBe('');
    expect(entry?.arrivalSessions.get('codex')).toBe('');
    // getter 仍把 '' 归一为 undefined
    expect(store.getArrivalSessionId('u1', 'codex')).toBeUndefined();
  });

  it('完全空记录（无 cwd / 无任何 map 内容）→ 跳过', () => {
    expect(
      storeWith({
        u1: { sessions: {}, previousSessions: {}, arrivalSessions: {}, sessionCwds: {} },
      }).get('u1'),
    ).toBeUndefined();
  });

  it('sessions/previous/sessionCwds 的空串值被丢弃，truthy 值保留', () => {
    const store = storeWith({
      u1: {
        cwd: '/tmp',
        sessions: { claude: '', codex: 's-C' },
        previousSessions: { claude: '', pi: 's-P' },
        arrivalSessions: { kimi: '' },
        sessionCwds: { claude: '', codex: '/tmp/session' },
      },
    });
    const entry = store.get('u1');
    expect(entry?.sessions.get('claude')).toBeUndefined();
    expect(entry?.sessions.get('codex')).toBe('s-C');
    expect(entry?.previousSessions.get('claude')).toBeUndefined();
    expect(entry?.previousSessions.get('pi')).toBe('s-P');
    expect(entry?.sessionCwds.get('claude')).toBeUndefined();
    expect(entry?.sessionCwds.get('codex')).toBe('/tmp/session');
    expect(entry?.arrivalSessions.get('kimi')).toBe('');
  });

  it('顶层非对象 / user data 非对象 → 安全跳过', () => {
    expect(storeWith(null).get('u1')).toBeUndefined();
    expect(storeWith([1, 2, 3]).get('u1')).toBeUndefined();
    expect(storeWith({ u1: 'nope', u2: 42, u3: null }).get('u3')).toBeUndefined();
    expect(
      storeWith({
        u1: {
          cwd: '/ok',
          sessions: {},
          previousSessions: {},
          arrivalSessions: {},
          sessionCwds: {},
        },
      }).get('u1')?.cwd,
    ).toBe('/ok');
  });

  it('corrupt 文件被改名保留现场（.corrupt-*）', () => {
    const filePath = path.join(tmpDir, 'last-session.json');
    fs.writeFileSync(filePath, '{broken', 'utf-8');
    new SessionStore(filePath);
    expect(fs.readdirSync(tmpDir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });
});

/**
 * previous / arrival 的 getter+setter 对称性（characterization）。
 *
 * 这两对方法体是完全重复块，合并成单一实现后，空串归一、agent 隔离、
 * 持久化行为必须逐项保持。
 */
describe('SessionStore previous/arrival getter+setter (characterization)', () => {
  it('getter：缺失 / 空串 → undefined；truthy → 原值；不同 agent 隔离', () => {
    const store = new SessionStore();
    expect(store.getPreviousSessionId('u1', 'claude')).toBeUndefined();
    expect(store.getArrivalSessionId('u1', 'claude')).toBeUndefined();

    store.setPreviousSessionId('u1', 'claude', 'prev-1');
    store.setArrivalSessionId('u1', 'claude', 'arr-1');
    expect(store.getPreviousSessionId('u1', 'claude')).toBe('prev-1');
    expect(store.getArrivalSessionId('u1', 'claude')).toBe('arr-1');

    store.setPreviousSessionId('u1', 'claude', '');
    store.setArrivalSessionId('u1', 'claude', '');
    expect(store.getPreviousSessionId('u1', 'claude')).toBeUndefined();
    expect(store.getArrivalSessionId('u1', 'claude')).toBeUndefined();

    store.setPreviousSessionId('u1', 'codex', 'prev-C');
    store.setArrivalSessionId('u1', 'codex', 'arr-C');
    expect(store.getPreviousSessionId('u1', 'claude')).toBeUndefined();
    expect(store.getArrivalSessionId('u1', 'claude')).toBeUndefined();
    expect(store.getPreviousSessionId('u1', 'codex')).toBe('prev-C');
    expect(store.getArrivalSessionId('u1', 'codex')).toBe('arr-C');
  });
});

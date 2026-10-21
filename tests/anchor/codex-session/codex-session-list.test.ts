/**
 * codex session 列表：offset/limit 边界、全局最新排序、同 mtime 稳定序、
 * subagent 排除（列表 + 活跃判定）。
 *
 * 合并自 codex-reader-offset-boundary / codex-reader-negative-offset /
 * codex-getnewest-session / codex-rollout-list-order /
 * codex-same-mtime-stable-order / codex-list-rollouts-excludes-subagent /
 * codex-session-active-excludes-subagent。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexSessionReader } from '../../../src/session/codex/index.js';
import {
  clearSessionIndexCache,
  isCodexSessionActive,
  listCodexRollouts,
} from '../../../src/session/codex/rollout-reader.js';
import {
  metaLine,
  writeMinimalRollout,
  writeRolloutLines,
} from '../../lib/codex-rollout-fixture.js';

const { state } = vi.hoisted(() => ({
  // Scripted readdirSync results keyed by absolute directory path —
  // deterministic simulation of APFS hash order.
  state: {
    scriptedReaddir: new Map<string, string[]>(),
  },
}));

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((p: unknown, ...args: unknown[]) => {
      const key = String(p);
      const scripted = state.scriptedReaddir.get(key);
      if (scripted !== undefined) return scripted;
      return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof actual.readdirSync,
  };
});

const OLD_MTIME_MS = Date.parse('2026-07-20T08:00:00.000Z');
const T_SAME_MS = Date.parse('2026-07-01T08:00:01.000Z');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-session-list-'));
  clearSessionIndexCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  state.scriptedReaddir.clear();
});

/** 写一个 subagent 线程 rollout（session_meta.thread_source=subagent）。 */
function writeThreadRollout(
  dayDir: string,
  fileName: string,
  sessionId: string,
  cwd: string,
  threadSource: string,
  mtimeMs: number,
  title?: string,
): void {
  const lines = [
    metaLine(sessionId, cwd, {
      id: threadSource === 'subagent' ? `thread-${fileName}` : sessionId,
      thread_source: threadSource,
      source:
        threadSource === 'subagent' ? { subagent: { thread_spawn: { depth: 1 } } } : undefined,
      originator: 'codex_exec',
    }),
  ];
  if (title) {
    lines.push(
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: title } }),
    );
  }
  writeRolloutLines(dayDir, fileName, lines, mtimeMs);
}

describe('codex session list', () => {
  // ── offset / limit 边界 ─────────────────────────────────────────────
  it('test_anchor_codex_reader_list_sessions_positive_bounds_keep_total', () => {
    const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '31');
    const baseSec = Math.floor(Date.now() / 1000) - 86400;
    for (let i = 0; i < 25; i++) {
      const sessionId = `anchor-sess-${String(i).padStart(2, '0')}`;
      writeMinimalRollout(sessionsDir, sessionId, '/proj', (baseSec + i) * 1000);
    }
    const reader = new CodexSessionReader({ codexHome: tmpDir });

    const page1 = reader.listSessions('/proj', { limit: 20, offset: 0 });
    expect(page1.total).toBe(25);
    expect(page1.sessions).toHaveLength(20);

    const page2 = reader.listSessions('/proj', { limit: 20, offset: 20 });
    expect(page2.total).toBe(25);
    expect(page2.sessions).toHaveLength(5);

    const pastEnd = reader.listSessions('/proj', { limit: 20, offset: 25 });
    expect(pastEnd.total).toBe(25);
    expect(pastEnd.sessions).toHaveLength(0);

    const farPastEnd = reader.listSessions('/proj', { limit: 20, offset: 1000 });
    expect(farPastEnd.total).toBe(25);
    expect(farPastEnd.sessions).toHaveLength(0);

    const oversizedLimit = reader.listSessions('/proj', { limit: 30, offset: 0 });
    expect(oversizedLimit.total).toBe(25);
    expect(oversizedLimit.sessions).toHaveLength(25);
  });

  it('test_anchor_codex_reader_negative_offset_clamps_to_first_page', () => {
    const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '31');
    const baseSec = Math.floor(Date.now() / 1000) - 86400;
    for (let i = 0; i < 5; i++) {
      const sessionId = `anchor-sess-${String(i).padStart(2, '0')}`;
      writeMinimalRollout(sessionsDir, sessionId, '/proj', (baseSec + i) * 1000);
    }
    const reader = new CodexSessionReader({ codexHome: tmpDir });

    // offset: -1 / -999 → clamp 到 0：返回完整第一页，不静默空页。
    for (const offset of [-1, -999]) {
      const result = reader.listSessions('/proj', { limit: 20, offset });
      expect(result.total).toBe(5);
      expect(result.sessions).toHaveLength(5);
      expect(result.sessions[0].sessionId).toBe('anchor-sess-04');
    }
  });

  // ── 全局最新（对抗 walk 顺序） ──────────────────────────────────────
  it('test_anchor_codex_reader_getnewest_returns_true_newest', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const day20Dir = path.join(sessionsDir, '2026', '07', '20');
    const day31Dir = path.join(sessionsDir, '2026', '07', '31');

    state.scriptedReaddir.set(sessionsDir, ['2026']);
    state.scriptedReaddir.set(path.join(sessionsDir, '2026'), ['07']);
    state.scriptedReaddir.set(path.join(sessionsDir, '2026', '07'), ['20', '31']);

    const day20Files: string[] = [];
    for (let i = 0; i < 50; i++) {
      const sessionId = `day20-proj-${String(i).padStart(2, '0')}`;
      day20Files.push(`rollout-${sessionId}.jsonl`);
      writeMinimalRollout(day20Dir, sessionId, '/proj', OLD_MTIME_MS);
    }
    for (let i = 0; i < 2; i++) {
      const sessionId = `day20-other-${i}`;
      day20Files.push(`rollout-${sessionId}.jsonl`);
      writeMinimalRollout(day20Dir, sessionId, '/other', OLD_MTIME_MS);
    }

    const newestSessionId = 'day31-proj-newest';
    writeMinimalRollout(day31Dir, newestSessionId, '/proj', Date.now());

    state.scriptedReaddir.set(day20Dir, day20Files);
    state.scriptedReaddir.set(day31Dir, [`rollout-${newestSessionId}.jsonl`]);

    const result = new CodexSessionReader({ codexHome: tmpDir }).getNewestSession('/proj');
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe(newestSessionId);
  });

  it('test_anchor_codex_list_rollouts_global_newest_with_total', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const day20Dir = path.join(sessionsDir, '2026', '07', '20');
    const day31Dir = path.join(sessionsDir, '2026', '07', '31');

    state.scriptedReaddir.set(sessionsDir, ['2026']);
    state.scriptedReaddir.set(path.join(sessionsDir, '2026'), ['07']);
    state.scriptedReaddir.set(path.join(sessionsDir, '2026', '07'), ['20', '31']);

    const day20Files: string[] = [];
    for (let i = 0; i < 50; i++) {
      const sessionId = `day20-proj-${String(i).padStart(2, '0')}`;
      day20Files.push(`rollout-${sessionId}.jsonl`);
      writeMinimalRollout(day20Dir, sessionId, '/proj', OLD_MTIME_MS);
    }
    for (let i = 0; i < 2; i++) {
      const sessionId = `day20-other-${i}`;
      day20Files.push(`rollout-${sessionId}.jsonl`);
      writeMinimalRollout(day20Dir, sessionId, '/other', OLD_MTIME_MS);
    }

    const newestSessionId = 'day31-proj-newest';
    writeMinimalRollout(day31Dir, newestSessionId, '/proj', Date.now());

    state.scriptedReaddir.set(day20Dir, day20Files);
    state.scriptedReaddir.set(day31Dir, [`rollout-${newestSessionId}.jsonl`]);

    const result = listCodexRollouts({ codexHome: tmpDir, cwd: '/proj', limit: 20 });

    // total = cwd 精确匹配的全集大小：50 + 1，不含 /other 的 2 个。
    expect(result.total).toBe(51);
    expect(result.entries).toHaveLength(20);
    expect(result.entries[0].threadId).toBe(newestSessionId);
  });

  it('test_anchor_codex_same_mtime_sessions_stable_order', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const yearDir = path.join(sessionsDir, '2026');
    const monthDir = path.join(yearDir, '07');
    const dayDir = path.join(monthDir, '01');

    writeMinimalRollout(dayDir, 'same-bbb', '/proj', T_SAME_MS);
    writeMinimalRollout(dayDir, 'same-aaa', '/proj', T_SAME_MS);
    writeMinimalRollout(dayDir, 'newest-zzz', '/proj', T_SAME_MS + 60_000);
    writeMinimalRollout(dayDir, 'oldest-zzz', '/proj', T_SAME_MS - 60_000);

    // Scripted walk order puts the same-mtime pair in REVERSE sessionId order.
    state.scriptedReaddir.set(sessionsDir, ['2026']);
    state.scriptedReaddir.set(yearDir, ['07']);
    state.scriptedReaddir.set(monthDir, ['01']);
    state.scriptedReaddir.set(dayDir, [
      'rollout-same-bbb.jsonl',
      'rollout-same-aaa.jsonl',
      'rollout-newest-zzz.jsonl',
      'rollout-oldest-zzz.jsonl',
    ]);

    const first = listCodexRollouts({ codexHome: tmpDir, cwd: '/proj', limit: 4 });
    const firstIds = first.entries.map((e) => e.threadId);
    expect(first.total).toBe(4);
    expect(firstIds).toHaveLength(4);

    // Rebuild the index and require the exact same order across calls.
    clearSessionIndexCache();
    const second = listCodexRollouts({ codexHome: tmpDir, cwd: '/proj', limit: 4 });
    expect(second.entries.map((e) => e.threadId)).toEqual(firstIds);

    // Deterministic secondary key: same-mtime sessions ordered by sessionId asc.
    expect(firstIds).toEqual(['newest-zzz', 'same-aaa', 'same-bbb', 'oldest-zzz']);
  });

  // ── subagent 排除 ──────────────────────────────────────────────────
  it('test_anchor_codex_list_rollouts_excludes_subagent_threads', () => {
    const dayDir = path.join(tmpDir, 'sessions', '2026', '08', '01');
    const SESSION_MAIN = 'sess-shared';
    const SESSION_ORPHAN_SUB = 'sess-orphan-sub';
    const T_MAIN_MS = Date.parse('2026-08-01T12:00:00.000Z');

    writeThreadRollout(
      dayDir,
      'rollout-main.jsonl',
      SESSION_MAIN,
      '/proj',
      'user',
      T_MAIN_MS,
      'main session title',
    );
    writeThreadRollout(
      dayDir,
      'rollout-sub.jsonl',
      SESSION_MAIN,
      '/proj',
      'subagent',
      T_MAIN_MS + 3_600_000,
    );
    writeThreadRollout(
      dayDir,
      'rollout-orphan.jsonl',
      SESSION_ORPHAN_SUB,
      '/proj',
      'subagent',
      T_MAIN_MS + 7_200_000,
      'orphan subagent title',
    );
    writeThreadRollout(
      dayDir,
      'rollout-other.jsonl',
      'sess-other',
      '/other',
      'user',
      T_MAIN_MS + 7_200_001,
    );

    const result = listCodexRollouts({ codexHome: tmpDir, cwd: '/proj', limit: 20 });

    expect(result.total).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].threadId).toBe(SESSION_MAIN);
    expect(result.entries[0].firstUserMessage).toBe('main session title');
  });

  it('test_anchor_codex_session_active_ignores_subagent_files', () => {
    const dayDir = path.join(tmpDir, 'sessions', '2026', '08', '01');
    const SESSION_MAIN = 'sess-shared-active-check';
    const SESSION_ORPHAN_SUB = 'sess-orphan-active-check';
    const NOW_MS = Date.parse('2026-08-01T14:00:00.000Z');
    const OLD_MS = NOW_MS - 60 * 60 * 1000;
    const threshold = 10 * 60 * 1000;

    // Pin "now" so mtime/threshold comparisons are deterministic.
    const realNow = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    try {
      writeThreadRollout(dayDir, 'rollout-main.jsonl', SESSION_MAIN, '/proj', 'user', OLD_MS);
      writeThreadRollout(
        dayDir,
        'rollout-sub.jsonl',
        SESSION_MAIN,
        '/proj',
        'subagent',
        NOW_MS - 1000,
      );
      writeThreadRollout(
        dayDir,
        'rollout-orphan.jsonl',
        SESSION_ORPHAN_SUB,
        '/proj',
        'subagent',
        NOW_MS,
      );

      // 主文件旧 → 不活跃（subagent 新文件不得翻转）；纯 subagent → 不活跃
      expect(
        isCodexSessionActive(SESSION_MAIN, { codexHome: tmpDir, activeThresholdMs: threshold }),
      ).toBe(false);
      expect(
        isCodexSessionActive(SESSION_ORPHAN_SUB, {
          codexHome: tmpDir,
          activeThresholdMs: threshold,
        }),
      ).toBe(false);

      // 对照：正常主会话（mtime 新）→ 活跃
      writeThreadRollout(dayDir, 'rollout-fresh.jsonl', 'sess-fresh', '/proj', 'user', NOW_MS);
      expect(
        isCodexSessionActive('sess-fresh', { codexHome: tmpDir, activeThresholdMs: threshold }),
      ).toBe(true);
    } finally {
      realNow.mockRestore();
    }
  });
});

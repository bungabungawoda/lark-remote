/**
 * Anchor (P3-5): 同 mtime 的 codex 会话排序必须确定（次级键）
 *
 * 验证什么行为：
 *   1. `listCodexRollouts` 连续两次调用（中间 clearSessionIndexCache 强制
 *      重建 index）对同一批文件返回完全一致的 entries 顺序。
 *   2. 同 mtime 的会话必须有确定性次级键（sessionId 升序），不能依赖目录
 *      walk 的插入序：用 vi.spyOn(fs, 'readdirSync') 把同 mtime 两文件按
 *      sessionId 降序 walk（same-bbb 先于 same-aaa），期望输出仍按 sessionId
 *      升序（newest-zzz, same-aaa, same-bbb, oldest-zzz）。
 *
 * 缺失/错误会导致什么：
 *   当前实现只按 mtimeMs 降序排序，同 mtime 时保留 index 插入序（目录 walk
 *   顺序）。文件系统/缓存重建/目录状态变化后同一批会话的顺序可能不同，
 *   auto-resume 与 /resume 翻页会恢复错会话，且分页 `[offset, offset+limit)`
 *   切片在两次请求间错位。
 *
 * 依据（review P3-5 / resume-pagination-plan §2.1）：
 *   "sessions: mtime desc 排序后的 [offset, offset+limit) 切片"——同 mtime
 *   时 desc 排序本身不定义顺序，必须补确定性次级键才能保证切片稳定；
 *   review 明确"同 mtime 会话排序确定（次级键）"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listCodexRollouts,
  clearSessionIndexCache,
} from '../../../src/session/codex/rollout-reader.js';

const { mockLogger, state } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  // Scripted readdirSync results keyed by absolute directory path.
  state: {
    scriptedReaddir: new Map<string, string[]>(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

const T_SAME_MS = Date.parse('2026-07-01T08:00:01.000Z');

let tmpDir: string;
let readdirSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-same-mtime-'));
  clearSessionIndexCache();
});

afterEach(() => {
  readdirSpy?.mockRestore();
  readdirSpy = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  state.scriptedReaddir.clear();
});

/** Write a minimal valid rollout file with a pinned mtime. */
function writeRollout(dayDir: string, sessionId: string, cwd: string, mtimeMs: number): void {
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, `rollout-${sessionId}.jsonl`);
  const firstLine =
    `{"type":"session_meta","payload":{"session_id":"${sessionId}","cwd":"${cwd}",` +
    `"originator":"x"}}\n`;
  fs.writeFileSync(filePath, firstLine, 'utf-8');
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
}

describe('codex 同 mtime 会话确定性排序', () => {
  it('test_anchor_codex_same_mtime_sessions_stable_order', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const yearDir = path.join(sessionsDir, '2026');
    const monthDir = path.join(yearDir, '07');
    const dayDir = path.join(monthDir, '01');

    // 4 matching /proj rollouts: 2 with IDENTICAL mtimeMs, 1 newer, 1 older.
    writeRollout(dayDir, 'same-bbb', '/proj', T_SAME_MS);
    writeRollout(dayDir, 'same-aaa', '/proj', T_SAME_MS);
    writeRollout(dayDir, 'newest-zzz', '/proj', T_SAME_MS + 60_000);
    writeRollout(dayDir, 'oldest-zzz', '/proj', T_SAME_MS - 60_000);

    // Scripted walk order puts the same-mtime pair in REVERSE sessionId order
    // (same-bbb before same-aaa), so a sort without a deterministic secondary
    // key will output same-bbb first (insertion order) → RED on sessionId asc.
    const originalReaddir = fs.readdirSync;
    readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...args) => {
      const key = String(p);
      const scripted = state.scriptedReaddir.get(key);
      if (scripted !== undefined) return scripted as never;
      return (originalReaddir as (...a: unknown[]) => unknown)(p, ...args) as never;
    });
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
    const secondIds = second.entries.map((e) => e.threadId);
    expect(secondIds).toEqual(firstIds);

    // Deterministic secondary key: same-mtime sessions ordered by sessionId
    // ascending, independent of walk/insertion order. Current implementation
    // keeps insertion order for ties → same-bbb before same-aaa → RED.
    expect(firstIds).toEqual(['newest-zzz', 'same-aaa', 'same-bbb', 'oldest-zzz']);
  });
});

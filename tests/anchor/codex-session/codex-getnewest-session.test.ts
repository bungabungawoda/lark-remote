/**
 * Round 8 regression guard (plan §4.1): CodexSessionReader.getNewestSession
 * must return the globally-newest rollout regardless of readdir walk order.
 *
 * 验证什么行为：
 *   CodexSessionReader({ codexHome }).getNewestSession('/proj') 返回
 *   { sessionId: <全局最新 session> } 而非 null —— 即复用 A1 修复后的
 *   listCodexRollouts 全局排序代码路径（index values → filter cwd → mtimeMs
 *   desc 排序 → 取首条）。
 *
 * 缺失/错误会导致什么：
 *   A1 修复前 walkRolloutFiles 从不排序，且 listCodexRollouts 在收集到
 *   limit*2 条匹配后 break —— day20 的 50 个旧文件会占满提前终止窗口，
 *   getNewestSession 永远看不到 day31 的最新会话（wiki 实例 /resume 全显示
 *   旧 `Say "test"` 会话的根因）。若绿方只修 listSessions 而 getNewestSession
 *   绕开同一代码路径，auto-resume 仍会恢复错会话。断言不返回 null 同时锁定
 *   "必须有结果"（不允许静默降级）。
 *
 * 依据（spec 原文）：
 *   docs/architecture/resume-pagination-plan.md §2.2："index values →
 *   filter cwd → 按 mtimeMs desc 排序 → total = length"；§1.4："必须先对
 *   全集建立全序再切片。任何在建立全序之前的提前终止都必然错"。
 *   CodexSessionReader.getNewestSession 实现即 listSessions(cwd, {limit:1})
 *   的首条，必须与 A1 同一排序路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexSessionReader } from '../../../src/session/codex/index.js';
import { clearSessionIndexCache } from '../../../src/session/codex/rollout-reader.js';

const { mockLogger, state } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  // Scripted readdirSync results keyed by absolute directory path —
  // deterministic simulation of APFS hash order.
  state: {
    scriptedReaddir: new Map<string, string[]>(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-newest-'));
  clearSessionIndexCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  state.scriptedReaddir.clear();
});

/**
 * Write a minimal valid rollout file whose first line is a legal
 * `session_meta` JSONL record, then pin its mtime to `mtimeMs`.
 */
function writeRollout(dayDir: string, sessionId: string, cwd: string, mtimeMs: number): void {
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, `rollout-${sessionId}.jsonl`);
  const firstLine =
    `{"type":"session_meta","payload":{"session_id":"${sessionId}","cwd":"${cwd}",` +
    `"originator":"x"}}\n`;
  fs.writeFileSync(filePath, firstLine, 'utf-8');
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
}

describe('codex getNewestSession global-newest (hostile walk order)', () => {
  it('test_anchor_codex_reader_getnewest_returns_true_newest', () => {
    // ── Deterministic APFS-hash-order simulation (same as A1) ───────────
    // Walk order: 2026 → 07 → day 20 first (52 files), day 31 last
    // (1 matching /proj, globally newest). Any implementation that breaks
    // after collecting limit*2 = 2 entries (limit=1 for getNewestSession)
    // will stop inside day 20 and never see day 31.
    const sessionsDir = path.join(tmpDir, 'sessions');
    const day20Dir = path.join(sessionsDir, '2026', '07', '20');
    const day31Dir = path.join(sessionsDir, '2026', '07', '31');

    state.scriptedReaddir.set(sessionsDir, ['2026']);
    state.scriptedReaddir.set(path.join(sessionsDir, '2026'), ['07']);
    state.scriptedReaddir.set(path.join(sessionsDir, '2026', '07'), ['20', '31']);

    // day 20: 50 matching /proj sessions (old mtime) + 2 from another cwd —
    // enough to trip the pre-A1 early-break even with limit=1, and to prove
    // cwd filtering applies before "newest" selection.
    const day20Files: string[] = [];
    for (let i = 0; i < 50; i++) {
      const sessionId = `day20-proj-${String(i).padStart(2, '0')}`;
      day20Files.push(`rollout-${sessionId}.jsonl`);
      writeRollout(day20Dir, sessionId, '/proj', OLD_MTIME_MS);
    }
    for (let i = 0; i < 2; i++) {
      const sessionId = `day20-other-${i}`;
      day20Files.push(`rollout-${sessionId}.jsonl`);
      writeRollout(day20Dir, sessionId, '/other', OLD_MTIME_MS);
    }

    // day 31 (walked LAST): the single globally-newest matching session.
    const newestSessionId = 'day31-proj-newest';
    writeRollout(day31Dir, newestSessionId, '/proj', Date.now());

    state.scriptedReaddir.set(day20Dir, day20Files);
    state.scriptedReaddir.set(day31Dir, [`rollout-${newestSessionId}.jsonl`]);

    // ── Contract under test ─────────────────────────────────────────────
    const result = new CodexSessionReader({ codexHome: tmpDir }).getNewestSession('/proj');

    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe(newestSessionId);
  });
});

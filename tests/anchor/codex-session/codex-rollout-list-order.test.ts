/**
 * Bug-mode anchor (Round 1): listCodexRollouts 必须返回全局最新 + 真实 total。
 *
 * 验证什么行为：
 *   listCodexRollouts({ codexHome, cwd, limit }) 返回
 *   { entries, total }：
 *   - entries 是 cwd 精确匹配全集按 mtimeMs 降序后的【全局】最新 limit 条，
 *     与 fs.readdirSync 的 walk 顺序无关；
 *   - total 是 cwd 精确匹配的全集大小（分页前），不是截断后的长度。
 *
 * 缺失会导致什么：
 *   当前实现 walkRolloutFiles 从不排序，收集到 entries.length > limit*2（41）
 *   就 break，先 break 后排序 → 返回"任意 walk 子集中的最新 limit 条"，
 *   07/20 一天 117 个匹配文件会占满 41 条提前终止，07/31、08/01 的最新会话
 *   永远不可见（wiki 实例 /resume 全部显示 07/20 `Say "test"` 的根因）；
 *   且没有 total 概念，router 把截断后长度当真实总数显示 → auto-resume
 *   恢复错会话、"/resume N" 第 21 条之后永远看不到。
 *
 * 依据（spec 原文）：
 *   - plan §1.2 根因："walkRolloutFiles 用 fs.readdirSync 逐层遍历从不排序……
 *     而 listCodexRollouts 在收集到 limit*2（41）条匹配后 break 提前退出。
 *     先 break 后排序 → 返回的是'任意子集中的最新 20 条'，不是全局最新 20 条"
 *   - plan §2.2 目标实现："index values → filter cwd → 按 mtimeMs desc 排序
 *     → total = length"
 *   - plan §1.4 设计原则："必须先对全集建立全序再切片。任何在建立全序之前
 *     的提前终止都必然错"
 *   - plan §4.2 测试验收："codex 单测：跨多日 fixture，断言返回全局最新 N
 *     （与 readdir 顺序无关）、total 为真实全集数"
 *
 * 确定性复现策略：
 *   mock node:fs.readdirSync，按路径返回脚本化顺序（sessions → 2026 → 07 →
 *   [20, 31]），模拟 APFS 哈希序；day20 有 50 个匹配 /proj 的旧文件（超过
 *   limit*2 断点），day31 的全局最新文件在 walk 顺序最后。当前实现必然在
 *   day20 中途 break，永远走不到 day31 → total 缺失 + entries[0] 不是最新。
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-order-'));
  clearSessionIndexCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  state.scriptedReaddir.clear();
});

/**
 * Write a minimal valid rollout file whose first line is a legal
 * `session_meta` JSONL record (the fixed implementation reads it with
 * findJsonlLine), then pin its mtime to `mtimeMs`.
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

describe('codex listCodexRollouts global-newest + total', () => {
  it('test_anchor_codex_list_rollouts_global_newest_with_total', () => {
    // ── Deterministic APFS-hash-order simulation ────────────────────────
    // Walk order: 2026 → 07 → day 20 first (52 files: 50 matching /proj +
    // 2 matching /other), day 31 last (1 matching /proj, globally newest).
    // Any implementation that breaks after collecting limit*2 = 41 entries
    // will stop inside day 20 and never see day 31.
    const sessionsDir = path.join(tmpDir, 'sessions');
    const day20Dir = path.join(sessionsDir, '2026', '07', '20');
    const day31Dir = path.join(sessionsDir, '2026', '07', '31');

    state.scriptedReaddir.set(sessionsDir, ['2026']);
    state.scriptedReaddir.set(path.join(sessionsDir, '2026'), ['07']);
    state.scriptedReaddir.set(path.join(sessionsDir, '2026', '07'), ['20', '31']);

    // day 20: 50 matching /proj sessions, all with the SAME old mtime
    // (so a walk-order-dependent implementation can never accidentally
    // return the day-31 file first), plus 2 sessions from another cwd to
    // prove `total` counts only the cwd-matched full set.
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

    // ── Contract under test (plan §2.2) ─────────────────────────────────
    const result = listCodexRollouts({
      codexHome: tmpDir,
      cwd: '/proj',
      limit: 20,
    }) as unknown as {
      entries: Array<{ threadId: string }>;
      total: number;
    };

    // total = cwd 精确匹配的全集大小（分页前）：50 + 1，不含 /other 的 2 个。
    expect(result.total).toBe(51);
    // entries = 全局最新 limit 条（当前实现返回数组，无 total → 真红）。
    expect(result.entries).toHaveLength(20);
    // 全局最新必须是 day 31 的会话；若只补 total 不修排序，这里照样拦住。
    expect(result.entries[0].threadId).toBe(newestSessionId);
  });
});

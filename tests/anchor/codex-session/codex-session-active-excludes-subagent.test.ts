/**
 * Anchor A3 (plan §2.4): isCodexSessionActive 必须基于主线程文件 mtime 判定，
 * subagent 线程文件不得参与活跃判定；纯 subagent session 必须判不活跃。
 *
 * 验证什么行为：
 *   1. 同一 session_id：主文件 mtime 旧（超过阈值）、subagent 文件 mtime 新
 *      → isCodexSessionActive 返回 false（主文件决定）；
 *   2. 纯 subagent session（独立 session_id、只有 subagent 文件、mtime 新）
 *      → 返回 false，即使文件刚更新；
 *   3. 主文件 mtime 新 → 返回 true（正常活跃路径不被破坏）。
 *
 * 缺失/错误会导致什么：
 *   活跃判定若只看"该 sessionId 对应文件的最新 mtime"而不区分线程归属，
 *   subagent 线程的持续活动会让父会话被误判活跃（/active 卡片显示"进行中"），
 *   且纯 subagent session 会以"活跃会话"身份出现在 dashboard——与"线程树
 *   不参与会话展示"的设计原则（plan §1.4.1）冲突。
 *
 * 依据（spec 原文）：
 *   plan §2.1 影响面："isCodexSessionActive 用子代理文件 mtime 判定活跃，可能
 *   误判"；plan §2.4 测试："isCodexSessionActive 用主文件 mtime（subagent 文件
 *   mtime 更新不误判）"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isCodexSessionActive,
  clearSessionIndexCache,
} from '../../../src/session/codex/rollout-reader.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

const SESSION_MAIN = 'sess-shared-active-check';
const SESSION_ORPHAN_SUB = 'sess-orphan-active-check';
const NOW_MS = Date.parse('2026-08-01T14:00:00.000Z');
const OLD_MS = NOW_MS - 60 * 60 * 1000; // 1h ago — beyond the test threshold

let tmpDir: string;
let realNow: { mockRestore: () => void } | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-active-'));
  clearSessionIndexCache();
  // Pin "now" so mtime/threshold comparisons are deterministic.
  realNow = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  realNow?.mockRestore();
  realNow = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRollout(
  dayDir: string,
  fileName: string,
  sessionId: string,
  cwd: string,
  threadSource: string,
  mtimeMs: number,
): void {
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, fileName);
  const meta = {
    type: 'session_meta',
    payload: {
      session_id: sessionId,
      id: threadSource === 'subagent' ? `thread-${fileName}` : sessionId,
      cwd,
      thread_source: threadSource,
      source:
        threadSource === 'subagent' ? { subagent: { thread_spawn: { depth: 1 } } } : undefined,
      originator: 'codex_exec',
    },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(meta)}\n`, 'utf-8');
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
}

describe('codex isCodexSessionActive 排除 subagent', () => {
  it('test_anchor_codex_session_active_ignores_subagent_files', () => {
    const dayDir = path.join(tmpDir, 'sessions', '2026', '08', '01');

    // 同一 sessionId：主文件旧 + subagent 新（subagent 不得让父会话变活跃）
    writeRollout(dayDir, 'rollout-main.jsonl', SESSION_MAIN, '/proj', 'user', OLD_MS);
    writeRollout(dayDir, 'rollout-sub.jsonl', SESSION_MAIN, '/proj', 'subagent', NOW_MS - 1000);
    // 纯 subagent session：mtime 最新，但必须判不活跃
    writeRollout(dayDir, 'rollout-orphan.jsonl', SESSION_ORPHAN_SUB, '/proj', 'subagent', NOW_MS);

    const threshold = 10 * 60 * 1000; // 10 minutes

    // 主文件旧 → 不活跃（subagent 新文件不得翻转）
    expect(
      isCodexSessionActive(SESSION_MAIN, { codexHome: tmpDir, activeThresholdMs: threshold }),
    ).toBe(false);
    // 纯 subagent session → 不活跃
    expect(
      isCodexSessionActive(SESSION_ORPHAN_SUB, {
        codexHome: tmpDir,
        activeThresholdMs: threshold,
      }),
    ).toBe(false);
    // 对照：正常主会话（mtime 新）→ 活跃，证明判定机制本身没坏
    writeRollout(dayDir, 'rollout-fresh.jsonl', 'sess-fresh', '/proj', 'user', NOW_MS);
    expect(
      isCodexSessionActive('sess-fresh', { codexHome: tmpDir, activeThresholdMs: threshold }),
    ).toBe(true);
  });
});

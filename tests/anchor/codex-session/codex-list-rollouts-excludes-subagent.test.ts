/**
 * Anchor A2 (plan §2.1 review 折回): listCodexRollouts 必须显式排除 subagent
 * 线程文件，一个 sessionId 只出一个主线程条目，total 只计主会话。
 *
 * 验证什么行为：
 *   1. 同一 session_id 下主线程 + subagent 两个 rollout 文件（subagent mtime 更新）
 *      → entries 只出 1 条（主线程摘要），total = 1；
 *   2. 纯 subagent session（只有 subagent 文件、无主文件，独立 session_id）→ 被
 *      显式排除，不进 entries、不计 total（不依赖"主线程优先"兜底）；
 *   3. 不同 cwd 的条目仍按 cwd 过滤。
 *
 * 缺失/错误会导致什么：
 *   "主线程优先"只解决同一 sessionId 内部的冲突；若一个 subagent 线程的
 *   session_id 是独立的（或主文件缺失），index 里仍会有 isSubagent 条目，
 *   listCodexRollouts 不排除它 → /resume 列表/auto-resume 可能列出线程树
 *   子会话。实测 2026-08-01 884 个 sessionId 0 例纯 subagent，但这是防御性
 *   不变量，spec 明文要求显式排除。
 *
 * 依据（spec 原文）：
 *   docs/architecture/codex-token-scope-plan.md §2.1："listCodexRollouts 在 cwd
 *   过滤后显式排除 isSubagent 条目，不依赖'主线程优先'兜底（防纯子代理
 *   session——主文件缺失——污染列表）"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listCodexRollouts,
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

const SESSION_MAIN = 'sess-shared';
const SESSION_ORPHAN_SUB = 'sess-orphan-sub';
const T_MAIN_MS = Date.parse('2026-08-01T12:00:00.000Z');
const T_SUB_MS = T_MAIN_MS + 3_600_000; // subagent mtime 更新，仍必须被排除
const T_ORPHAN_MS = T_SUB_MS + 3_600_000; // 纯 subagent mtime 最新，仍必须被排除

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-list-sub-'));
  clearSessionIndexCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRollout(
  dayDir: string,
  fileName: string,
  sessionId: string,
  cwd: string,
  threadSource: string,
  mtimeMs: number,
  title: string,
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
  const userMsg = {
    type: 'event_msg',
    payload: { type: 'user_message', message: title },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(meta)}\n${JSON.stringify(userMsg)}\n`, 'utf-8');
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
}

describe('codex listCodexRollouts 排除 subagent', () => {
  it('test_anchor_codex_list_rollouts_excludes_subagent_threads', () => {
    const dayDir = path.join(tmpDir, 'sessions', '2026', '08', '01');

    // 同一 sessionId：主线程 + subagent（subagent mtime 更新）
    writeRollout(
      dayDir,
      'rollout-main.jsonl',
      SESSION_MAIN,
      '/proj',
      'user',
      T_MAIN_MS,
      'main session title',
    );
    writeRollout(
      dayDir,
      'rollout-sub.jsonl',
      SESSION_MAIN,
      '/proj',
      'subagent',
      T_SUB_MS,
      'subagent thread title',
    );
    // 纯 subagent session：独立 session_id，mtime 最新
    writeRollout(
      dayDir,
      'rollout-orphan.jsonl',
      SESSION_ORPHAN_SUB,
      '/proj',
      'subagent',
      T_ORPHAN_MS,
      'orphan subagent title',
    );
    // 另一个 cwd 的主线程文件：确认 cwd 过滤仍生效
    writeRollout(
      dayDir,
      'rollout-other.jsonl',
      'sess-other',
      '/other',
      'user',
      T_ORPHAN_MS + 1,
      'other cwd title',
    );

    const result = listCodexRollouts({ codexHome: tmpDir, cwd: '/proj', limit: 20 });

    // 只出 1 条主线程条目，total = 1（subagent 与纯 subagent 均被排除）
    expect(result.total).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].threadId).toBe(SESSION_MAIN);
    expect(result.entries[0].firstUserMessage).toBe('main session title');
  });
});

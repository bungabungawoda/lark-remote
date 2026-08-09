/**
 * Anchor A1 (plan §2.1): 同一 sessionId 多 rollout 文件时，readCodexSessionContent
 * 必须解析到主线程文件，不能被 subagent 线程文件"后写覆盖"抢占。
 *
 * 验证什么行为：
 *   session_meta.session_id 相同的两个 rollout 文件（主线程 + subagent 线程，
 *   且 subagent 文件 mtime 更新、遍历顺序靠后）共存时，
 *   `readCodexSessionContent(sessionId, {codexHome})` 返回**主线程文件**的
 *   events / displayTitle / usage（per-turn = 末条 last_token_usage 推导，
 *   累计 = 末条 total_token_usage 推导）。
 *
 * 缺失/错误会导致什么：
 *   当前 `getSessionIndex` 用 `Map.set(session_id, filePath)` 后写覆盖，解析结果
 *   取决于 fs.readdirSync 目录项顺序。实测 index 落到子代理文件，
 *   done 卡"累计"显示冻结快照值，而主文件此时已有更大的真实累计——
 *   "累计 < 当前"且 Context 全是错值。
 *
 * 依据（spec）：
 *   docs/architecture/codex-token-scope-plan.md §2.1："主线程优先：!isSubagent 的
 *   文件胜过 isSubagent 文件；同类取 mtimeMs 更大者；mtime 相同按 filePath 字典序
 *   取小者兜底"，且解析必须"确定性，与 readdir 顺序无关"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readCodexSessionContent,
  clearSessionIndexCache,
} from '../../../src/session/codex/rollout-reader.js';

const { mockLogger, state } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  state: {
    scriptedReaddir: new Map<string, string[]>(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

const SESSION_ID = 'sess-multi';
const T_MAIN_MS = Date.parse('2026-08-01T12:00:00.000Z');
const T_SUB_MS = T_MAIN_MS + 3_600_000; // subagent 文件 mtime 更新，仍必须输

let tmpDir: string;
let readdirSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-main-thread-'));
  clearSessionIndexCache();
});

afterEach(() => {
  readdirSpy?.mockRestore();
  readdirSpy = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  state.scriptedReaddir.clear();
});

/** Write a rollout file with full session_meta + token_count + messages. */
function writeRollout(
  dayDir: string,
  fileName: string,
  meta: string,
  events: string[],
  mtimeMs: number,
): string {
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, fileName);
  fs.writeFileSync(filePath, [meta, ...events].join('\n') + '\n', 'utf-8');
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

describe('codex 同 sessionId 多文件主线程解析', () => {
  it('test_anchor_codex_read_session_content_prefers_main_thread_file', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const yearDir = path.join(sessionsDir, '2026');
    const monthDir = path.join(yearDir, '08');
    const dayDir = path.join(monthDir, '01');

    // 主线程文件：per-turn last=165/1363/445568/447096；累计 total=244381/256385/107833472/108334238
    writeRollout(
      dayDir,
      'rollout-main-thread.jsonl',
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: SESSION_ID,
          id: SESSION_ID,
          cwd: '/proj',
          thread_source: 'user',
          originator: 'codex_exec',
        },
      }),
      [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'main session message' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'main assistant reply' }],
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 445733,
                cached_input_tokens: 445568,
                output_tokens: 1363,
                total_tokens: 447096,
              },
              total_token_usage: {
                input_tokens: 108077853,
                cached_input_tokens: 107833472,
                output_tokens: 256385,
                total_tokens: 108334238,
              },
            },
          },
        }),
      ],
      T_MAIN_MS,
    );

    // subagent 线程文件：同一 session_id，thread_source='subagent'，mtime 更新，
    // 遍历顺序靠后（当前实现下"后写覆盖"会错误取胜）
    writeRollout(
      dayDir,
      'rollout-subagent-thread.jsonl',
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: SESSION_ID,
          id: 'thread-sub-1',
          parent_thread_id: SESSION_ID,
          cwd: '/proj',
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { depth: 1 } } },
          originator: 'codex_exec',
        },
      }),
      [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'subagent thread message' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'subagent assistant reply' }],
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 55469,
                cached_input_tokens: 55424,
                output_tokens: 95,
                total_tokens: 55564,
              },
              total_token_usage: {
                input_tokens: 856554,
                cached_input_tokens: 816640,
                output_tokens: 6838,
                total_tokens: 863392,
              },
            },
          },
        }),
      ],
      T_SUB_MS,
    );

    // 脚本化遍历顺序：主线程先、subagent 后（当前 Map.set 后写覆盖 → subagent 赢 → RED）
    const originalReaddir = fs.readdirSync;
    readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...args) => {
      const key = String(p);
      const scripted = state.scriptedReaddir.get(key);
      if (scripted !== undefined) return scripted as never;
      return (originalReaddir as (...a: unknown[]) => unknown)(p, ...args) as never;
    });
    state.scriptedReaddir.set(sessionsDir, ['2026']);
    state.scriptedReaddir.set(yearDir, ['08']);
    state.scriptedReaddir.set(monthDir, ['01']);
    state.scriptedReaddir.set(dayDir, [
      'rollout-main-thread.jsonl',
      'rollout-subagent-thread.jsonl',
    ]);

    const content = readCodexSessionContent(SESSION_ID, { codexHome: tmpDir });
    const usage = content.usage;

    // 内容来自主线程文件
    expect(content.displayTitle).toBe('main session message');
    expect(content.events.some((e) => e.content === 'main assistant reply')).toBe(true);
    expect(content.events.some((e) => e.content === 'subagent assistant reply')).toBe(false);

    // per-turn（last_token_usage 推导）来自主文件
    expect(usage?.inputTokens).toBe(165); // 445733 - 445568
    expect(usage?.outputTokens).toBe(1363);
    expect(usage?.cacheReadTokens).toBe(445568);
    expect(usage?.totalTokens).toBe(447096);
    expect(usage?.contextLength).toBe(445733);

    // 累计（total_token_usage 推导）来自主文件
    expect(usage?.cumulativeInputTokens).toBe(244381); // 108077853 - 107833472
    expect(usage?.cumulativeOutputTokens).toBe(256385);
    expect(usage?.cumulativeCacheReadTokens).toBe(107833472);
    expect(usage?.cumulativeTotalTokens).toBe(108334238);
  });
});

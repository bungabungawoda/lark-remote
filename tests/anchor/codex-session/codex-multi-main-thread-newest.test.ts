/**
 * Anchor A4 (plan §2.1 主文件唯一不变量): 同一 sessionId 出现多个主线程文件时，
 * 解析必须取 mtime 最新者。
 *
 * 验证什么行为：
 *   session_id 相同、thread_source 均非 subagent 的两个 rollout 文件（旧 mtime +
 *   新 mtime，readdir 顺序脚本化让旧文件靠后遍历）→ readCodexSessionContent 返回
 *   mtime 最新文件的内容与 usage。
 *
 * 缺失/错误会导致什么：
 *   当前数据（2026-08-01 实测 884 个 sessionId）中"主文件唯一"成立，但 codex
 *   跨重启/跨天可能新建主文件；若冲突解析只做"主线程优先"而不在同类文件间取
 *   最新，重启后的新主文件会被旧主文件覆盖（或取决于遍历顺序）→ 历史/累计
 *   缺段。此 anchor 为未来升级（按 timestamp 合并）留不变量锚点：mtime 最新者
 *   胜是当前确定性的底线。
 *
 * 依据（spec 原文）：
 *   plan §2.1："同类文件取 mtimeMs 更大者（活动最新）"；"主文件唯一不变量：
 *   实测 884 个 sessionId 均只有 1 个主线程文件。规则按此设计；若未来出现
 *   多主文件……届时升级为按 timestamp 合并事件。此假设写入单测与文档"。
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

const SESSION_ID = 'sess-multi-main';
const T_OLD_MS = Date.parse('2026-08-01T10:00:00.000Z');
const T_NEW_MS = Date.parse('2026-08-01T13:00:00.000Z');

let tmpDir: string;
let readdirSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-multi-main-'));
  clearSessionIndexCache();
});

afterEach(() => {
  readdirSpy?.mockRestore();
  readdirSpy = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  state.scriptedReaddir.clear();
});

function writeRollout(dayDir: string, fileName: string, title: string, mtimeMs: number): void {
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, fileName);
  const meta = {
    type: 'session_meta',
    payload: {
      session_id: SESSION_ID,
      id: SESSION_ID,
      cwd: '/proj',
      thread_source: 'user',
      originator: 'codex_exec',
    },
  };
  const userMsg = { type: 'event_msg', payload: { type: 'user_message', message: title } };
  fs.writeFileSync(filePath, `${JSON.stringify(meta)}\n${JSON.stringify(userMsg)}\n`, 'utf-8');
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
}

describe('codex 同 sessionId 多主文件 mtime 最新者胜', () => {
  it('test_anchor_codex_multi_main_thread_newest_mtime_wins', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const yearDir = path.join(sessionsDir, '2026');
    const monthDir = path.join(yearDir, '08');
    const dayDir = path.join(monthDir, '01');

    // 新主文件遍历在前、旧主文件遍历在后（Map.set 后写覆盖会让旧文件取胜 → RED）
    writeRollout(dayDir, 'rollout-new.jsonl', 'newer main title', T_NEW_MS);
    writeRollout(dayDir, 'rollout-old.jsonl', 'older main title', T_OLD_MS);

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
    state.scriptedReaddir.set(dayDir, ['rollout-new.jsonl', 'rollout-old.jsonl']);

    const content = readCodexSessionContent(SESSION_ID, { codexHome: tmpDir });

    expect(content.displayTitle).toBe('newer main title');
  });
});

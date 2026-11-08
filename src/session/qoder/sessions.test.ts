import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QoderSessionReader } from './sessions.js';
import { encodeProjectDirName } from '../../platform/path.js';
import { rmRf } from '../../../tests/lib/tmp-cleanup.js';
import { expectRunUsageScope } from '../../../tests/lib/usage-scope-contract.js';

/**
 * Qoder 会话 jsonl 与 Claude Code 同构；夹具只造合成数据（AABB 会话 id、
 * /home/user/project 路径风格——这里用临时目录本身当 cwd，无真实用户数据）。
 */

let tmpDir: string;
let configDir: string;
let projectsDir: string;
let cwd: string;

/** 写一个会话 jsonl（行 = claude 风格 + qoder 私有行混合）；目录编码用真实实现。 */
function writeSession(sessionId: string, lines: object[]): void {
  const dir = path.join(projectsDir, encodeProjectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  );
}

function userRow(text: string, sessionId: string): object {
  return {
    type: 'user',
    uuid: `u-${text}`,
    parentUuid: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
    cwd,
    sessionId,
    version: '1.0.0',
  };
}

function assistantRow(text: string, msgId: string, usage: object, sessionId: string): object {
  return {
    type: 'assistant',
    uuid: `a-${msgId}`,
    parentUuid: 'u-x',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      id: msgId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage,
    },
    model: 'qfmodel',
    cwd,
    sessionId,
    version: '1.0.0',
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-qoder-reader-'));
  configDir = path.join(tmpDir, 'qoder-home');
  projectsDir = path.join(configDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  cwd = path.join(tmpDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmRf(tmpDir);
});

describe('QoderSessionReader', () => {
  it('lists sessions of the cwd newest-first with summaries', () => {
    writeSession('aaaaaaaa-0001', [
      userRow('第一条', 'aaaaaaaa-0001'),
      assistantRow('回复一', 'msg-1', {}, 'aaaaaaaa-0001'),
    ]);
    // 另一个 cwd 的会话不得混入（行内 cwd 指向别的目录）
    const otherDir = path.join(projectsDir, '-home-user-other-project');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherDir, 'aaaaaaaa-0009.jsonl'),
      JSON.stringify({
        ...userRow('别的目录', 'aaaaaaaa-0009'),
        cwd: '/home/user/other-project',
      }) + '\n',
      'utf-8',
    );

    const reader = new QoderSessionReader({ configDir });
    const { sessions, total } = reader.listSessions(cwd);
    expect(total).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe('aaaaaaaa-0001');
    expect(sessions[0]!.summary).toBe('第一条');
  });

  it('reads catch-up tail (after the last user message) and last-turn usage flow', () => {
    writeSession('aaaaaaaa-0002', [
      userRow('第一轮问题', 'aaaaaaaa-0002'),
      // 第一轮采样（10+5）不计入本 run flow
      assistantRow(
        '第一轮回答',
        'msg-1',
        {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        'aaaaaaaa-0002',
      ),
      userRow('第二轮问题', 'aaaaaaaa-0002'),
      // qoder 私有行：忽略，不进事件流
      { type: 'task_reminder', sessionId: 'aaaaaaaa-0002' },
      assistantRow(
        '第二轮回答A',
        'msg-2',
        {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 3,
        },
        'aaaaaaaa-0002',
      ),
      assistantRow(
        '第二轮回答B',
        'msg-3',
        {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        'aaaaaaaa-0002',
      ),
    ]);

    const reader = new QoderSessionReader({ configDir });
    const content = reader.readSessionContent('aaaaaaaa-0002', cwd);

    // tail = 末条真人 user 之后的行；私有行不产出事件
    const texts = content.events.map((e) => (e as { content?: string }).content ?? '');
    expect(texts).toEqual(['第二轮回答A', '第二轮回答B']);
    expect(texts.join('')).not.toContain('第一轮');

    // flow = 末个真人 turn 内采样之和（多步 run 低报防线）；context = 末条
    // 采样占用（msg-3：50+10，水位不求和）。七条跨 reader 契约同源断言。
    expectRunUsageScope(content.usage, {
      flowInput: 150,
      flowOutput: 30,
      contextLength: 60,
      cumulativeInput: 10 + 100 + 50,
      cumulativeOutput: 5 + 20 + 10,
    });
    expect(content.usage?.totalTokens).toBe(190);
    expect(content.usage?.cumulativeTotalTokens).toBe(15 + 130 + 60);
    expect(content.displayTitle).toBe('第二轮问题');
  });

  it('detects active sessions by mtime and marks stale files inactive', () => {
    writeSession('aaaaaaaa-0003', [userRow('问题', 'aaaaaaaa-0003')]);
    const reader = new QoderSessionReader({ configDir });
    expect(reader.isSessionActive('aaaaaaaa-0003', cwd)).toBe(true);

    // mtime 拨老 → 不活跃（文件侧证据只有新鲜度）
    const dir = fs.readdirSync(projectsDir)[0]!;
    const file = path.join(projectsDir, dir, 'aaaaaaaa-0003.jsonl');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    expect(reader.isSessionActive('aaaaaaaa-0003', cwd)).toBe(false);
  });

  it('surfaces the -n custom-title as list title and content aiTitle', () => {
    // 2026-11-05 真机实测：`qodercn -n <名字>` 落盘 custom-title 行（可重命名，
    // last wins）；/resume 列表按 title 渲染标题，详情卡 displayTitle 优先于
    // 首条真人输入。
    writeSession('aaaaaaaa-0004', [
      { type: 'custom-title', sessionId: 'aaaaaaaa-0004', customTitle: '巡检会话' },
      userRow('第一条', 'aaaaaaaa-0004'),
      assistantRow('回复一', 'msg-4', {}, 'aaaaaaaa-0004'),
    ]);
    const reader = new QoderSessionReader({ configDir });

    const { sessions } = reader.listSessions(cwd);
    expect(sessions[0]!.title).toBe('巡检会话');
    expect(sessions[0]!.summary).toBe('第一条');

    const content = reader.readSessionContent('aaaaaaaa-0004', cwd);
    expect(content.aiTitle).toBe('巡检会话');
    expect(content.displayTitle).toBe('巡检会话');
  });

  it('returns empty content for a missing session without throwing', () => {
    const reader = new QoderSessionReader({ configDir });
    expect(reader.readSessionContent('aaaaaaaa-404', cwd)).toEqual({ events: [] });
    expect(reader.getNewestSession(cwd)).toBeNull();
  });
});

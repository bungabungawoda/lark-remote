import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CodebuddySessionReader } from './session-reader.js';
import { encodeCodebuddyProjectDirName, findFirstUserText, findSummaryText } from './sessions.js';
import { rmRf } from '../../../tests/lib/tmp-cleanup.js';
import { expectRunUsageScope } from '../../../tests/lib/usage-scope-contract.js';

/**
 * CodeBuddy 会话 jsonl（opencode 风格行）夹具：合成数据 + 临时目录当 cwd，
 * 无真实用户数据。
 */

let tmpDir: string;
let configDir: string;
let projectsDir: string;
let cwd: string;

function writeSession(sessionId: string, lines: object[]): void {
  const dir = path.join(projectsDir, encodeCodebuddyProjectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  );
}

function row(text: string, role: 'user' | 'assistant', sessionId: string, extra?: object) {
  const partType = role === 'user' ? 'input_text' : 'output_text';
  return {
    id: `id-${text}`,
    parentId: null,
    timestamp: 1767225600000,
    type: 'message',
    role,
    content: [{ type: partType, text }],
    providerData: {},
    sessionId,
    cwd,
    ...extra,
  };
}

/** 与 CodeBuddy 真机命名一致：`<basename>__<md5(cwd)>.log`。 */
function writeUsageLog(lines: string[], date = '2026-01-01'): void {
  const dir = path.join(configDir, 'logs', date);
  fs.mkdirSync(dir, { recursive: true });
  const hash = createHash('md5').update(cwd).digest('hex');
  fs.writeFileSync(
    path.join(dir, `${path.basename(cwd)}__${hash}.log`),
    `${lines.join('\n')}\n`,
    'utf-8',
  );
}

interface CallLogArgs {
  sessionId: string;
  turnId: string;
  step: number;
  input: number;
  output: number;
  cached: number;
  cacheWrite?: number;
}

/** 合成 `agent.model_call.completed` 日志行（真机字段形状）。 */
function callLogLine(args: CallLogArgs): string {
  const payload = {
    model: 'test-model',
    step: args.step,
    attempt_no: 1,
    input_tokens: args.input,
    output_tokens: args.output,
    total_tokens: args.input + args.output,
    cached_read_tokens: args.cached,
    cached_write_tokens: args.cacheWrite ?? 0,
    finish_reason: 'stop',
    event_name: 'agent.model_call.completed',
    conversation_id: args.sessionId,
    conversation_request_id: args.turnId,
    conversation_message_id: `msg-${args.step}`,
  };
  return `[2026/1/1 10:00:00.000] [Info] [pid=100] [ModelProvider]  ${JSON.stringify(payload)}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codebuddy-reader-'));
  configDir = path.join(tmpDir, 'codebuddy-home');
  projectsDir = path.join(configDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  cwd = path.join(tmpDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmRf(tmpDir);
});

describe('encodeCodebuddyProjectDirName', () => {
  it('strips the leading slash, keeps underscores, maps / and . to dash', () => {
    expect(encodeCodebuddyProjectDirName('/home/user/my-project')).toBe('home-user-my-project');
    expect(encodeCodebuddyProjectDirName('/home/user/my_project.v2')).toBe(
      'home-user-my_project-v2',
    );
  });
});

describe('summary text helpers (E11)', () => {
  function rawJsonl(lines: string[]): string {
    const file = path.join(tmpDir, 'summary-fixture.jsonl');
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
    return file;
  }

  it('findSummaryText returns text from a summary row', () => {
    const file = rawJsonl([
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '用户问题' }],
      }),
      JSON.stringify({ type: 'summary', summary: '会话摘要' }),
    ]);
    expect(findSummaryText(file)).toBe('会话摘要');
  });

  it('findSummaryText ignores malformed rows and returns undefined without a summary', () => {
    const file = rawJsonl(['{ broken json', JSON.stringify({ type: 'message' })]);
    expect(findSummaryText(file)).toBeUndefined();
  });

  it('findSummaryText returns undefined when the summary row has no display text', () => {
    const file = rawJsonl([
      JSON.stringify({ type: 'summary', summary: '' }),
      JSON.stringify({ type: 'summary', text: '' }),
    ]);
    expect(findSummaryText(file)).toBeUndefined();
  });

  it('findFirstUserText falls back to the first real user row and returns empty when none', () => {
    const file = rawJsonl([
      '{ broken json',
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '首个问题' }],
      }),
    ]);
    expect(findFirstUserText(file)).toBe('首个问题');
    expect(findFirstUserText(rawJsonl([]))).toBe('');
  });
});

describe('CodebuddySessionReader', () => {
  it('lists sessions newest-first, excluding subagent directories', () => {
    writeSession('bbbbbbbb-0001', [row('第一条', 'user', 'bbbbbbbb-0001')]);
    writeSession('bbbbbbbb-0002', [row('更早的', 'user', 'bbbbbbbb-0002')]);
    // 把 0002 的 mtime 拨老
    const dir = path.join(projectsDir, encodeCodebuddyProjectDirName(cwd));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, 'bbbbbbbb-0002.jsonl'), old, old);
    // 子 agent 同名目录（无扩展名）：不得被当会话列出
    fs.mkdirSync(path.join(dir, 'bbbbbbbb-0001', 'subagents'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bbbbbbbb-0001', 'subagents', 'agent-Explore-x.jsonl'),
      '{"type":"message"}\n',
      'utf-8',
    );

    const reader = new CodebuddySessionReader({ configDir });
    const { sessions, total } = reader.listSessions(cwd);
    expect(total).toBe(2);
    expect(sessions.map((s) => s.sessionId)).toEqual(['bbbbbbbb-0001', 'bbbbbbbb-0002']);
    expect(sessions[0]!.summary).toBe('第一条');
  });

  it('skips a .jsonl entry whose stat fails (dangling symlink)', () => {
    writeSession('bbbbbbbb-0008', [row('正常会话', 'user', 'bbbbbbbb-0008')]);
    const dir = path.join(projectsDir, encodeCodebuddyProjectDirName(cwd));
    // readdir 会列出这个名字，但 statSync 跟随悬空符号链接抛 ENOENT → 跳过该条目
    fs.symlinkSync(path.join(tmpDir, 'no-such-target'), path.join(dir, 'bbbbbbbb-broken.jsonl'));

    const reader = new CodebuddySessionReader({ configDir });
    const { sessions, total } = reader.listSessions(cwd);
    expect(total).toBe(1);
    expect(sessions.map((s) => s.sessionId)).toEqual(['bbbbbbbb-0008']);
    expect(sessions[0]!.summary).toBe('正常会话');
  });

  it('reads catch-up tail and last-turn usage flow (usage nested in providerData tolerated)', () => {
    writeSession('bbbbbbbb-0003', [
      row('第一轮问题', 'user', 'bbbbbbbb-0003'),
      row('第一轮回答', 'assistant', 'bbbbbbbb-0003', {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        model: 'hy4-preview',
      }),
      row('第二轮问题', 'user', 'bbbbbbbb-0003'),
      // summary 行：未知上下文里的摘要行，tail 装配跳过（无 content）
      { type: 'summary', summary: '会话摘要', sessionId: 'bbbbbbbb-0003', cwd },
      row('第二轮回答', 'assistant', 'bbbbbbbb-0003', {
        // 真机 2.142.0 形状：usage 在 providerData.usage，camelCase，inputTokens
        // 含缓存（cached_tokens 在 inputTokensDetails 里）
        providerData: {
          usage: {
            requests: 1,
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            inputTokensDetails: [{ cached_tokens: 7 }],
            outputTokensDetails: [{ reasoning_tokens: 3 }],
          },
        },
        model: 'hy4-preview',
      }),
    ]);

    const reader = new CodebuddySessionReader({ configDir });
    const content = reader.readSessionContent('bbbbbbbb-0003', cwd);

    const texts = content.events.map((e) => (e as { content?: string }).content ?? '');
    // tail = 末条真人 user 之后：summary 行无 message 结构被跳过，assistant 文本进事件
    expect(texts).toEqual(['第二轮回答']);

    // 七条跨 reader 契约同源断言（flow/context/cumulative + 本 run ≤ 累计）。
    // input 扣缓存（100-7=93）、cacheRead 取明细（7）——同一批 token 不双计。
    expectRunUsageScope(content.usage, {
      flowInput: 93,
      flowOutput: 20,
      contextLength: 93 + 7 + 20,
      cumulativeInput: 10 + 93,
      cumulativeOutput: 5 + 20,
    });
    expect(content.usage?.cacheReadTokens).toBe(7);
    expect(content.usage?.totalTokens).toBe(93 + 7 + 20);
    expect(content.usage?.cumulativeTotalTokens).toBe(15 + 120);
    expect(content.displayTitle).toBe('第二轮问题');
  });

  it('逐请求日志优先：flow/cumulative 按日志求和，不再被 jsonl 末次采样限制', () => {
    writeSession('bbbbbbbb-0004', [
      row('第一轮问题', 'user', 'bbbbbbbb-0004'),
      row('第一轮回答', 'assistant', 'bbbbbbbb-0004', {
        providerData: {
          usage: {
            requests: 1,
            inputTokens: 100,
            outputTokens: 20,
            inputTokensDetails: [{ cached_tokens: 80 }],
          },
        },
      }),
    ]);
    // 两个 turn 各两次模型请求；jsonl 的 100/20 只是末次请求。
    // 故意拆到两个日期目录：日志按日期分文件，reader 必须跨文件合并。
    writeUsageLog(
      [
        callLogLine({
          sessionId: 'bbbbbbbb-0004',
          turnId: 'turn-a',
          step: 1,
          input: 1000,
          output: 100,
          cached: 800,
        }),
        callLogLine({
          sessionId: 'bbbbbbbb-0004',
          turnId: 'turn-a',
          step: 2,
          input: 1200,
          output: 200,
          cached: 1000,
        }),
      ],
      '2026-01-01',
    );
    writeUsageLog(
      [
        callLogLine({
          sessionId: 'bbbbbbbb-0004',
          turnId: 'turn-b',
          step: 3,
          input: 2000,
          output: 300,
          cached: 1500,
        }),
        callLogLine({
          sessionId: 'bbbbbbbb-0004',
          turnId: 'turn-b',
          step: 4,
          input: 2500,
          output: 400,
          cached: 2000,
        }),
      ],
      '2026-01-02',
    );

    const reader = new CodebuddySessionReader({ configDir });
    const content = reader.readSessionContent('bbbbbbbb-0004', cwd);

    // turn-b 两次请求：非缓存 input (500+500)、output (300+400)；
    // context = 末次请求 2500 输入 + 400 输出（输入含缓存）。
    expectRunUsageScope(content.usage, {
      flowInput: 1000,
      flowOutput: 700,
      contextLength: 2900,
      cumulativeInput: 200 + 200 + 500 + 500,
      cumulativeOutput: 100 + 200 + 300 + 400,
    });
    expect(content.usage?.cacheReadTokens).toBe(1500 + 2000);
    expect(content.usage?.totalTokens).toBe(2000 + 300 + 2500 + 400);
    expect(content.usage?.cumulativeTotalTokens).toBe(
      1000 + 100 + 1200 + 200 + 2000 + 300 + 2500 + 400,
    );
  });

  it('日志里只有其他 session / 坏行时回退 jsonl 末次请求口径', () => {
    writeSession('bbbbbbbb-0005', [
      row('问题', 'user', 'bbbbbbbb-0005'),
      row('回答', 'assistant', 'bbbbbbbb-0005', {
        providerData: {
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            inputTokensDetails: [{ cached_tokens: 80 }],
          },
        },
      }),
    ]);
    writeUsageLog([
      callLogLine({
        sessionId: 'other-session',
        turnId: 'turn-x',
        step: 1,
        input: 999999,
        output: 999999,
        cached: 0,
      }),
      'broken line {"model":',
    ]);

    const reader = new CodebuddySessionReader({ configDir });
    const content = reader.readSessionContent('bbbbbbbb-0005', cwd);

    expectRunUsageScope(content.usage, {
      flowInput: 20,
      flowOutput: 20,
      contextLength: 20 + 80 + 20,
      cumulativeInput: 20,
      cumulativeOutput: 20,
    });
    expect(content.usage?.totalTokens).toBe(20 + 80 + 20);
  });

  it('autocompact 注入行（providerData.agent=compact）不切开 turn 边界（真机形状回归）', () => {
    writeSession('bbbbbbbb-0007', [
      row('第一轮问题', 'user', 'bbbbbbbb-0007'),
      row('第一轮回答', 'assistant', 'bbbbbbbb-0007', {
        providerData: { usage: { inputTokens: 30, outputTokens: 5 } },
      }),
      // 真机 autocompact 注入行形状：startsNewUserRequest=true 且无 skipRun
      {
        ...row('**IMPORTANT CONSTRAINTS:** 不要使用任何工具', 'user', 'bbbbbbbb-0007'),
        providerData: { agent: 'compact', startsNewUserRequest: true },
      },
      row('注入后的回答', 'assistant', 'bbbbbbbb-0007', {
        providerData: { usage: { inputTokens: 40, outputTokens: 6 } },
      }),
    ]);
    const reader = new CodebuddySessionReader({ configDir });
    const content = reader.readSessionContent('bbbbbbbb-0007', cwd);
    // 注入行不产生新 turn：两次采样同属唯一的真人 turn（30+5 与 40+6 都计入
    // flow）；旧实现会把注入行当边界、只算注入后的 40/6。
    expect(content.usage?.inputTokens).toBe(70);
    expect(content.usage?.outputTokens).toBe(11);
    expect(content.usage?.cumulativeInputTokens).toBe(70);
    expect(content.usage?.cumulativeOutputTokens).toBe(11);
  });

  it('ai-title row wins for aiTitle/displayTitle (claude-同口径，最后一条生效)', () => {
    writeSession('bbbbbbbb-0006', [
      row('第一轮问题', 'user', 'bbbbbbbb-0006'),
      row('第一轮回答', 'assistant', 'bbbbbbbb-0006'),
      { type: 'ai-title', aiTitle: '旧标题', sessionId: 'bbbbbbbb-0006', cwd },
      { type: 'ai-title', aiTitle: '计数器脚本计划', sessionId: 'bbbbbbbb-0006', cwd },
      row('第二轮问题', 'user', 'bbbbbbbb-0006'),
      row('第二轮回答', 'assistant', 'bbbbbbbb-0006'),
    ]);
    const reader = new CodebuddySessionReader({ configDir });
    const content = reader.readSessionContent('bbbbbbbb-0006', cwd);
    expect(content.aiTitle).toBe('计数器脚本计划');
    expect(content.displayTitle).toBe('计数器脚本计划');
  });

  it('rejects sessions whose rows do not carry the requested cwd (lossy dir encoding)', () => {
    // 文件放进本 cwd 的编码目录，但行内 cwd 指向别处 → 列表与读取都必须拒绝
    const dir = path.join(projectsDir, encodeCodebuddyProjectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bbbbbbbb-0004.jsonl'),
      JSON.stringify(row('别人的会话', 'user', 'bbbbbbbb-0004')) + '\n',
      'utf-8',
    );
    // 手工把行内 cwd 改成别的路径
    fs.writeFileSync(
      path.join(dir, 'bbbbbbbb-0004.jsonl'),
      JSON.stringify({ ...row('别人的会话', 'user', 'bbbbbbbb-0004'), cwd: '/home/user/other' }) +
        '\n',
      'utf-8',
    );

    const reader = new CodebuddySessionReader({ configDir });
    expect(reader.listSessions(cwd)).toEqual({ sessions: [], total: 0 });
    expect(reader.readSessionContent('bbbbbbbb-0004', cwd)).toEqual({ events: [] });
  });

  it('sanitizes sessionId (no path traversal) and reports active by mtime', () => {
    writeSession('bbbbbbbb-0005', [row('问题', 'user', 'bbbbbbbb-0005')]);
    const reader = new CodebuddySessionReader({ configDir });
    // 路径穿越尝试：净化后找不到文件，返回空而不抛错
    expect(reader.readSessionContent('../../etc/passwd', cwd)).toEqual({ events: [] });
    expect(reader.isSessionActive('bbbbbbbb-0005', cwd)).toBe(true);
    expect(reader.isSessionActive('bbbbbbbb-404', cwd)).toBe(false);
  });
});

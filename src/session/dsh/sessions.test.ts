/**
 * DshSessionReader tests against the fake DSH server.
 *
 * The reader bridges the synchronous AgentSessionReader contract with a sync
 * transport (default: spawnSync curl). spawnSync blocks the event loop, which
 * deadlocks against an in-process HTTP server — so these tests inject the
 * server's synchronous dispatch (`dispatchSync`) as the transport, exercising
 * all reader logic (filter/sort/pagination, event mapping, usage, cwd guard)
 * without HTTP. Synthetic fixtures only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, it, expect } from 'vitest';
import { DshSessionReader } from './sessions.js';
import { FakeDshServer } from '../../../tests/lib/fake-dsh-server.js';
import type { DshSessionEvent } from '../../dsh/types.js';
import { DSH_BROWSER_CREDENTIAL_KEY } from '../../dsh/auth.js';

const CWD = '/home/user/project';
const OTHER = '/home/user/other';
const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const SID_C = 'cccccccc-1111-2222-3333-444444444444';
const NO_CREDENTIALS_FILE = '/nonexistent/lark-remote-test/.credentials.yaml';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeCredentials(file: string, secret: Buffer): void {
  fs.writeFileSync(
    file,
    YAML.stringify({
      version: 1,
      records: {
        [DSH_BROWSER_CREDENTIAL_KEY]: {
          kind: 'grant',
          payload: { version: 1, secret: secret.toString('base64url') },
        },
      },
    }),
    { mode: 0o600 },
  );
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function makeReader(server: FakeDshServer): DshSessionReader {
  return new DshSessionReader({
    host: server.baseUrl,
    credentialsFile: NO_CREDENTIALS_FILE,
    syncRequest: (_baseUrl, method, payload) => {
      const resp = server.dispatchSync(method, payload);
      if (resp.result.ok !== true) {
        throw new Error(resp.result.error.message);
      }
      return resp.result.value;
    },
  });
}

/** Register a session/list row so the reader's cwd guard finds the session. */
function registerSession(server: FakeDshServer, cwd = CWD): void {
  server.register('session/list', () => ({
    ok: true,
    value: {
      items: [{ sessionId: SID_A, updatedAt: 1, running: false, blank: false, cwd }],
    },
  }));
}

describe('DshSessionReader', () => {
  it('listSessions filters by cwd, sorts by updatedAt desc, and paginates locally', () => {
    const server = new FakeDshServer();
    server.register('session/list', () => ({
      ok: true,
      value: {
        items: [
          { sessionId: SID_A, updatedAt: 3000, running: false, blank: false, cwd: CWD },
          { sessionId: SID_B, updatedAt: 1000, running: true, blank: false, cwd: OTHER },
          { sessionId: SID_C, updatedAt: 2000, running: false, blank: false, cwd: CWD },
        ],
      },
    }));

    const reader = makeReader(server);
    const all = reader.listSessions(CWD);
    expect(all.total).toBe(2);
    expect(all.sessions.map((s) => s.sessionId)).toEqual([SID_A, SID_C]); // 3000 before 2000
    expect(all.sessions[0].mtime).toBe(3000);

    const page = reader.listSessions(CWD, { limit: 1, offset: 1 });
    expect(page.sessions.map((s) => s.sessionId)).toEqual([SID_C]);
    expect(page.total).toBe(2);
  });

  it('getNewestSession returns the newest cwd-matched session or null', () => {
    const server = new FakeDshServer();
    server.register('session/list', () => ({
      ok: true,
      value: {
        items: [
          { sessionId: SID_A, updatedAt: 3000, running: false, blank: false, cwd: CWD },
          { sessionId: SID_B, updatedAt: 4000, running: false, blank: false, cwd: OTHER },
        ],
      },
    }));

    const reader = makeReader(server);
    const newest = reader.getNewestSession(CWD);
    expect(newest?.sessionId).toBe(SID_A);
    expect(reader.getNewestSession('/nonexistent')).toBeNull();
  });

  it('readSessionContent maps history events and accumulates usage', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          { type: 'event', event: userMsg(SID_A, 'hello dsh') },
          {
            type: 'event',
            event: assistantMsg(SID_A, 'hi there', { inputTokens: 100, outputTokens: 30 }),
          },
          { type: 'event', event: toolCall(SID_A, 'bash', '{"cmd":"ls"}') },
          { type: 'event', event: toolResult(SID_A, 'file list output') },
        ],
      },
    }));

    const reader = makeReader(server);
    const content = reader.readSessionContent(SID_A, CWD, { maxEvents: 10 });

    // 工具调用与结果合成一个事件（resume 卡里一次交互=一个面板）：
    // 标题是 `🔧 bash — …`，正文是结果输出。
    expect(content.events.map((e) => e.type)).toEqual(['user', 'assistant', 'tool_use']);
    expect(content.events[0].content).toBe('hello dsh');
    expect(content.events[1].content).toBe('hi there');
    expect(content.events[2].title).toContain('bash');
    expect(content.events[2].content).toBe('file list output');
    expect(content.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      cumulativeTotalTokens: 130,
    });
  });

  it('readSessionContent caps events with maxEvents (tail cap)', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          { type: 'event', event: userMsg(SID_A, 'one') },
          { type: 'event', event: assistantMsg(SID_A, 'two', undefined) },
          { type: 'event', event: assistantMsg(SID_A, 'three', undefined) },
        ],
      },
    }));

    const reader = makeReader(server);
    const content = reader.readSessionContent(SID_A, CWD, { maxEvents: 2 });
    expect(content.events).toHaveLength(2);
    expect(content.events[1].content).toBe('three');
  });

  it('usage: 无 turn 标记（旧数据）时本 run 退回末条 assistant/message，累计仍是全会话', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          {
            type: 'event',
            event: assistantMsg(SID_A, 'first turn', {
              inputTokens: 100,
              outputTokens: 30,
            }),
          },
          {
            type: 'event',
            event: assistantMsg(SID_A, 'last turn', {
              inputTokens: 200,
              outputTokens: 60,
              cacheReadTokens: 20,
              cacheWriteTokens: 10,
            }),
          },
        ],
      },
    }));

    const reader = makeReader(server);
    const content = reader.readSessionContent(SID_A, CWD);

    expect(content.usage).toMatchObject({
      // 无 turn/start 边界 → 退回末条 usage（旧数据语义，同 codex 无 task_started）。
      inputTokens: 200,
      outputTokens: 60,
      contextLength: 200 + 60 + 20 + 10, // §9.21: input + output + cacheRead + cacheWrite
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      totalTokens: 200 + 60 + 20 + 10,
      // Cumulative = full-session sum across both assistant/message.
      cumulativeInputTokens: 100 + 200,
      cumulativeOutputTokens: 30 + 60,
      cumulativeCacheReadTokens: 20,
      cumulativeCacheCreationTokens: 10,
      cumulativeTotalTokens: 130 + 290,
    });
  });

  it('usage: 本 run = 末个 turn 内所有采样之和，context 仍是末次采样水位', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          { type: 'event', event: turnStart(0) },
          {
            type: 'event',
            event: assistantMsg(SID_A, 'step 1', {
              inputTokens: 100,
              outputTokens: 30,
              cacheReadTokens: 900,
            }),
          },
          { type: 'event', event: toolCall(SID_A, 'bash', '{"cmd":"ls"}') },
          { type: 'event', event: toolResult(SID_A, 'file list') },
          {
            type: 'event',
            event: assistantMsg(SID_A, 'step 2', {
              inputTokens: 20,
              outputTokens: 70,
              cacheReadTokens: 1000,
            }),
          },
          { type: 'event', event: turnEnd(0) },
        ],
      },
    }));

    const reader = makeReader(server);
    const content = reader.readSessionContent(SID_A, CWD);

    expect(content.usage).toMatchObject({
      // 两步工具往返 = 两条 usage，本 run 是两者之和（不是末条 20/70）。
      inputTokens: 120,
      outputTokens: 100,
      cacheReadTokens: 1900,
      cacheCreationTokens: 0,
      totalTokens: 120 + 100 + 1900,
      // Context 是末次采样的窗口占用（input + cacheRead + cacheWrite）。
      contextLength: 20 + 100 + 1000,
      cumulativeInputTokens: 120,
      cumulativeOutputTokens: 100,
      cumulativeTotalTokens: 120 + 100 + 1900,
    });
  });

  it('usage: 本 run 只取末个 turn，累计覆盖所有 turn', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          { type: 'event', event: turnStart(0) },
          {
            type: 'event',
            event: assistantMsg(SID_A, 'turn 0 step 0', {
              inputTokens: 50,
              outputTokens: 10,
            }),
          },
          {
            type: 'event',
            event: assistantMsg(SID_A, 'turn 0 step 1', {
              inputTokens: 5,
              outputTokens: 20,
            }),
          },
          { type: 'event', event: turnEnd(0) },
          { type: 'event', event: turnStart(1) },
          {
            type: 'event',
            event: assistantMsg(SID_A, 'turn 1 step 0', {
              inputTokens: 7,
              outputTokens: 3,
              cacheReadTokens: 400,
            }),
          },
          { type: 'event', event: turnEnd(1) },
        ],
      },
    }));

    const reader = makeReader(server);
    const content = reader.readSessionContent(SID_A, CWD);

    expect(content.usage).toMatchObject({
      // 本 run = turn 1 的唯一一次采样。
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 400,
      totalTokens: 410,
      contextLength: 7 + 3 + 400,
      // 累计 = turn 0 两次采样 + turn 1 一次采样。
      cumulativeInputTokens: 50 + 5 + 7,
      cumulativeOutputTokens: 10 + 20 + 3,
      cumulativeCacheReadTokens: 400,
      cumulativeTotalTokens: 50 + 5 + 7 + (10 + 20 + 3) + 400,
    });
  });

  it('isSessionActive reflects the running flag for a cwd-matched session', () => {
    const server = new FakeDshServer();
    server.register('session/list', () => ({
      ok: true,
      value: {
        items: [
          { sessionId: SID_A, updatedAt: 1, running: true, blank: false, cwd: CWD },
          { sessionId: SID_B, updatedAt: 2, running: false, blank: false, cwd: CWD },
          { sessionId: SID_C, updatedAt: 3, running: true, blank: false, cwd: OTHER },
        ],
      },
    }));

    const reader = makeReader(server);
    expect(reader.isSessionActive(SID_A, CWD)).toBe(true);
    expect(reader.isSessionActive(SID_B, CWD)).toBe(false);
    // cwd guard: same running session in another cwd is NOT active here.
    expect(reader.isSessionActive(SID_C, CWD)).toBe(false);
  });

  it('test_anchor_dsh_session_cwd_mismatch_rejected', () => {
    // session 属于另一个 cwd 时，readSessionContent 必须 fail-closed。
    // 只按 sessionId 查 history 会让 /resume 跨 workspace 绑定会话。
    const server = new FakeDshServer();
    registerSession(server, OTHER);
    server.register('session/page', () => ({
      ok: true,
      value: {
        records: [{ type: 'event', event: userMsg(SID_A, 'belongs to other cwd') }],
        hasMore: false,
      },
    }));

    const reader = makeReader(server);
    expect(reader.readSessionContent(SID_A, CWD)).toEqual({ events: [] });
    // 用会话真实 cwd 读取则正常返回内容。
    const ok = reader.readSessionContent(SID_A, OTHER);
    expect(ok.events.map((e) => e.content)).toEqual(['belongs to other cwd']);
  });

  it('returns empty results on DSH error (fail-soft)', () => {
    const server = new FakeDshServer();
    server.register('session/list', () => ({
      ok: false,
      error: { code: 'internal', message: 'boom' },
    }));

    const reader = makeReader(server);
    expect(reader.listSessions(CWD)).toEqual({ sessions: [], total: 0 });
    expect(reader.getNewestSession(CWD)).toBeNull();
    expect(reader.isSessionActive(SID_A, CWD)).toBe(false);
  });

  it('uses a dynamic host via hostProvider so /config host changes take effect', () => {
    // DshRunner 每次重建读最新 host，但 reader 构造时固定 baseUrl，导致 host 变更后
    // /resume、用量、完成卡仍访问旧 host。hostProvider 每次调用解析当前 host。
    let currentHost = 'http://host-a:3080';
    const seenUrls: string[] = [];
    const reader = new DshSessionReader({
      hostProvider: () => currentHost,
      credentialsFile: NO_CREDENTIALS_FILE,
      syncRequest: (baseUrl, method) => {
        seenUrls.push(baseUrl);
        if (method === 'session/list') return { items: [] };
        return {};
      },
    });

    reader.listSessions(CWD);
    currentHost = 'http://host-b:3080';
    reader.listSessions(CWD);

    expect(seenUrls).toEqual(['http://host-a:3080', 'http://host-b:3080']);
  });

  it('exchanges the launch token for a cookie and pages from the projection watermark', () => {
    const cookies: Array<string | undefined> = [];
    const pagePayloads: unknown[] = [];
    const reader = new DshSessionReader({
      host: 'http://127.0.0.1:3080',
      token: 'http://127.0.0.1:3080/?token=abc',
      credentialsFile: NO_CREDENTIALS_FILE,
      syncConnect: (baseUrl, token) => {
        expect(baseUrl).toBe('http://127.0.0.1:3080');
        expect(token).toBe('abc');
        return 'dsh-auth-127.0.0.1:3080=operator';
      },
      syncRequest: (_baseUrl, method, payload, cookie) => {
        cookies.push(cookie);
        if (method === 'session/list') {
          return {
            items: [{ sessionId: SID_A, updatedAt: 1, running: false, blank: false, cwd: CWD }],
          };
        }
        if (method === 'session/projections') return { asOfSeq: 7, values: {} };
        if (method === 'session/page') {
          pagePayloads.push(payload);
          return { records: [], hasMore: false };
        }
        return {};
      },
    });

    reader.readSessionContent(SID_A, CWD);

    expect(cookies.every((cookie) => cookie === 'dsh-auth-127.0.0.1:3080=operator')).toBe(true);
    expect(pagePayloads[0]).toMatchObject({
      address: { kind: 'session', sessionId: SID_A },
      throughSeq: 7,
    });
  });

  it('mints a fresh v1 cookie from the DSH credentials file on every call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-dsh-reader-'));
    tempDirs.push(dir);
    const file = path.join(dir, '.credentials.yaml');
    writeCredentials(file, Buffer.alloc(32, 1));
    const cookies: Array<string | undefined> = [];
    const reader = new DshSessionReader({
      host: 'http://127.0.0.1:3080',
      credentialsFile: file,
      now: () => 1_700_000_000_000,
      syncRequest: (_baseUrl, _method, _payload, cookie) => {
        cookies.push(cookie);
        return { items: [] };
      },
    });

    reader.listSessions(CWD);
    writeCredentials(file, Buffer.alloc(32, 2));
    reader.listSessions(CWD);

    expect(cookies[0]).toContain('=v1.');
    expect(cookies[1]).toContain('=v1.');
    expect(cookies[1]).not.toBe(cookies[0]);
  });

  it('resolves credentials under the configured dshHome', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-dsh-reader-'));
    tempDirs.push(dir);
    const seen: string[] = [];
    const reader = new DshSessionReader({
      host: 'http://127.0.0.1:3080',
      dshHomeProvider: () => dir,
      readCredentials: (file) => {
        seen.push(file);
        return Buffer.alloc(32, 3);
      },
      now: () => 1_700_000_000_000,
      syncRequest: () => ({ items: [] }),
    });

    reader.listSessions(CWD);

    expect(seen).toEqual([path.join(dir, '.credentials.yaml')]);
  });

  it('accumulates usage across the whole session, not just the first 50 events', () => {
    // reader 固定请求 maxMessages=50 却把结果当 session-wide cumulative；>50 事件的会话
    // 累计 token 会少算。必须读取完整 history（或分页）再累加 usage。
    const server = new FakeDshServer();
    const events: Array<{ type: string; event: DshSessionEvent }> = [];
    for (let i = 0; i < 60; i++) {
      events.push({
        type: 'event',
        event: assistantMsg(SID_A, `msg-${i}`, { inputTokens: 1, outputTokens: 1 }),
      });
    }
    registerSession(server);
    server.register('session/page', (payload) => {
      const max = (payload as { maxMessages?: number }).maxMessages ?? 50;
      return {
        ok: true,
        value: { hasMore: events.length > max, records: events.slice(0, max) },
      };
    });

    const reader = makeReader(server);
    const content = reader.readSessionContent(SID_A, CWD);
    // 60 条 assistant/message，每条 input 1 + output 1 → cumulativeTotalTokens 应为 120
    expect(content.usage?.cumulativeTotalTokens).toBe(120);
    expect(content.usage?.cumulativeInputTokens).toBe(60);
  });
});

function userMsg(sessionId: string, text: string): DshSessionEvent {
  void sessionId;
  return {
    type: 'user/message',
    seq: 1,
    time: 1700000000000,
    data: { turn: 0, step: 0, content: [{ type: 'text', text }], source: { kind: 'user' } },
  };
}

function assistantMsg(
  sessionId: string,
  text: string,
  usage: Record<string, unknown> | undefined,
): DshSessionEvent {
  void sessionId;
  return {
    type: 'assistant/message',
    seq: 2,
    time: 1700000000000,
    data: {
      turn: 0,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      ...(usage ? { usage } : {}),
    },
  };
}

function toolCall(sessionId: string, name: string, args: string): DshSessionEvent {
  void sessionId;
  return {
    type: 'tool/call',
    seq: 3,
    time: 1700000000000,
    data: { turn: 0, step: 0, callId: 'call-1', name, arguments: args },
  };
}

function toolResult(sessionId: string, output: string, isError = false): DshSessionEvent {
  void sessionId;
  return {
    type: 'tool/result',
    seq: 4,
    time: 1700000000000,
    data: {
      turn: 0,
      step: 0,
      message: { role: 'tool', content: output, isError },
      callId: 'call-1',
    },
  };
}

function turnStart(turn: number): DshSessionEvent {
  return { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn } };
}

function turnEnd(turn: number): DshSessionEvent {
  return {
    type: 'turn/end',
    seq: 9,
    time: 1700000000000,
    data: { turn, reason: { kind: 'completed' } },
  };
}

/**
 * resume 卡的"思考 / 输出 / 工具"三件套（2026-10-19 反馈回归）。
 *
 * DSH 的 assistant 块类型是 `text` / `reasoning` / `tool-call`。旧映射只认
 * `text`，而一个真实的 31-turn 会话里 reasoning 有 371 块、text 只有 12 块——
 * resume 卡因此只剩 `🔧 工具调用` + `🟢 工具结果`，看着像"这轮什么都没想也没说"。
 */
describe('DshSessionReader resume transcript', () => {
  it('maps reasoning blocks to thinking and text blocks to assistant output', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          {
            type: 'event',
            event: {
              type: 'assistant/message',
              seq: 1,
              time: 1_760_000_000_000,
              data: {
                message: {
                  role: 'assistant',
                  content: [
                    { type: 'reasoning', text: '先看代码结构' },
                    { type: 'text', text: '结论：改渲染层' },
                  ],
                },
              },
            },
          },
        ],
      },
    }));

    const content = makeReader(server).readSessionContent(SID_A, CWD, { maxEvents: 10 });
    expect(content.events.map((e) => [e.type, e.title ?? ''])).toEqual([
      ['thinking', ''],
      ['assistant', ''],
    ]);
    expect(content.events[0].content).toBe('先看代码结构');
    expect(content.events[1].content).toBe('结论：改渲染层');
  });

  it('puts a readable summary in the tool-call title and keeps raw args as body', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          {
            type: 'event',
            event: toolCall(
              SID_A,
              'bash',
              JSON.stringify({ command: 'grep -n "play()" tests/e2e/site-e2e.mjs' }),
            ),
          },
        ],
      },
    }));

    const [event] = makeReader(server).readSessionContent(SID_A, CWD, { maxEvents: 10 }).events;
    // 折叠态只看得到标题：必须是"哪个工具 + 跑了什么"，不是 `bash({"command":...})`。
    expect(event.title).toBe('🔧 bash — grep -n "play()" tests/e2e/site-e2e.mjs');
    expect(event.content).toBe('{"command":"grep -n \\"play()\\" tests/e2e/site-e2e.mjs"}');
  });
});

describe('DshSessionReader tool call/result pairing', () => {
  it('merges a call with its result into one panel and keeps the summary as title', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          {
            type: 'event',
            event: toolCall(SID_A, 'bash', JSON.stringify({ command: 'npm test' })),
          },
          { type: 'event', event: toolResult(SID_A, 'all green') },
        ],
      },
    }));

    const events = makeReader(server).readSessionContent(SID_A, CWD, { maxEvents: 10 }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      title: '🔧 bash — npm test',
      content: 'all green',
    });
  });

  it('marks a failed call with ❌ instead of a separate result panel', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          {
            type: 'event',
            event: toolCall(SID_A, 'bash', JSON.stringify({ command: 'false' })),
          },
          { type: 'event', event: toolResult(SID_A, 'exit code 1', true) },
        ],
      },
    }));

    const events = makeReader(server).readSessionContent(SID_A, CWD, { maxEvents: 10 }).events;
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('❌ bash — false');
    expect(events[0].content).toBe('exit code 1');
  });

  it('keeps an interrupted call (no result) as its own panel', () => {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: {
        hasMore: false,
        records: [
          {
            type: 'event',
            event: toolCall(SID_A, 'bash', JSON.stringify({ command: 'sleep 100' })),
          },
        ],
      },
    }));

    const events = makeReader(server).readSessionContent(SID_A, CWD, { maxEvents: 10 }).events;
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('🔧 bash — sleep 100');
  });
});

/**
 * `user/message` 里的上下文注入必须过滤（2026-10-19 手机端回顾卡实测）。
 *
 * 真实会话 30 条 user/message 中只有 8 条是用户本人说的，其余是 time-context
 * （"Time sampled while preparing…"）、agent-instructions、skill-catalog、
 * runtime-context、compact-checkpoint。照单全收会把回顾卡灌满系统提示，还把
 * 它们标成「👤 你」。
 */
describe('DshSessionReader user/message sources', () => {
  function userMsgWithSource(kind: string | undefined, text: string): DshSessionEvent {
    return {
      type: 'user/message',
      seq: 1,
      time: 1_760_000_000_000,
      data: {
        content: [{ type: 'text', text }],
        ...(kind === undefined ? {} : { source: { kind } }),
      },
    };
  }

  function readOne(ev: DshSessionEvent) {
    const server = new FakeDshServer();
    registerSession(server);
    server.register('session/page', () => ({
      ok: true,
      value: { hasMore: false, records: [{ type: 'event', event: ev }] },
    }));
    return makeReader(server).readSessionContent(SID_A, CWD, { maxEvents: 10 }).events;
  }

  it('drops pure context injections (time-context / instructions / catalogs)', () => {
    for (const kind of [
      'time-context',
      'agent-instructions',
      'runtime-context',
      'skill-catalog',
      'compact-checkpoint',
    ]) {
      expect(readOne(userMsgWithSource(kind, 'Time sampled while preparing turn 20'))).toEqual([]);
    }
  });

  it('keeps the real user message as 👤 你', () => {
    const [ev] = readOne(userMsgWithSource('user', '帮我看下这个 bug'));
    expect(ev).toMatchObject({ type: 'user', content: '帮我看下这个 bug' });
    expect(ev.title).toBeUndefined();
  });

  it('renders tool-jobs / goal notices as 🔔 通知 instead of user text', () => {
    const [job] = readOne(userMsgWithSource('tool-jobs', 'background job bash-1 finished'));
    expect(job).toMatchObject({ type: 'notice', title: '🔔 通知' });
    expect(job.content).toContain('finished');
  });
});

/**
 * 列表卡预览数据。
 *
 * DSH 的 `session/list` 响应里已经带回 `projections.values.title` 与
 * `turnOutline`（每轮的 prompt/response），reader 必须把它们搬到行级字段：
 * 否则 /resume 列表卡只有一坨 session id（2026-10-21 反馈），而按会话逐个
 * 拉 `session/page` 才能拿到同样的信息（一次列表要 15 次 curl）。
 */
describe('DshSessionReader 会话预览字段', () => {
  function listWith(values: Record<string, unknown>): FakeDshServer {
    const server = new FakeDshServer();
    server.register('session/list', () => ({
      ok: true,
      value: {
        items: [
          {
            sessionId: SID_A,
            updatedAt: 1792541886753,
            running: true,
            blank: false,
            cwd: CWD,
            projections: { kind: 'sequenced', asOfSeq: 3784, values },
          },
        ],
      },
    }));
    return server;
  }

  it('从 projections 取 title 与末轮输入/输出，且只发一次 session/list', () => {
    const server = listWith({
      title: '梳理待办与依赖',
      turnOutline: [
        { turn: 1, seq: 11, prompt: '旧问题', response: '旧答复' },
        { turn: 2, seq: 20, prompt: '最后的问题', response: '最后的答复' },
      ],
    });

    const reader = makeReader(server);
    const { sessions } = reader.listSessions(CWD);
    const row = sessions[0];

    expect(row.summary).toBe('梳理待办与依赖');
    expect(row.title).toBe('梳理待办与依赖');
    expect(row.lastUserMessage).toBe('最后的问题');
    expect(row.lastAssistantMessage).toBe('最后的答复');
    // 投影随 session/list 一起返回：列表不得再拉 session/page。
    expect(server.requests.map((r) => r.method)).toEqual(['session/list']);
  });

  it('末轮 response 为空（在途 turn）时回溯到最近一条非空输出', () => {
    const server = listWith({
      title: '修复主轮收尾',
      turnOutline: [
        { turn: 1, seq: 11, prompt: '第一问', response: '第一答' },
        { turn: 2, seq: 20, prompt: '最新一问', response: '' },
      ],
    });

    const row = makeReader(server).listSessions(CWD).sessions[0];
    expect(row.lastUserMessage).toBe('最新一问');
    expect(row.lastAssistantMessage).toBe('第一答');
  });

  it('无 projections / title 非字符串 / turnOutline 非数组时不抛，字段留空', () => {
    const cases: Array<Record<string, unknown> | undefined> = [
      undefined,
      { title: null, turnOutline: 'oops' },
      { title: 42, turnOutline: [{ turn: 1, prompt: 7, response: {} }] },
    ];

    for (const values of cases) {
      const server = new FakeDshServer();
      server.register('session/list', () => ({
        ok: true,
        value: {
          items: [
            {
              sessionId: SID_A,
              updatedAt: 1792541886753,
              running: false,
              blank: false,
              cwd: CWD,
              ...(values === undefined ? {} : { projections: { asOfSeq: 1, values } }),
            },
          ],
        },
      }));

      const row = makeReader(server).listSessions(CWD).sessions[0];
      expect(row.summary).toBe('');
      expect(row.title).toBeUndefined();
      expect(row.lastUserMessage).toBeUndefined();
      expect(row.lastAssistantMessage).toBeUndefined();
    }
  });
});

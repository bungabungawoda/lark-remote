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

import { describe, it, expect } from 'vitest';
import { DshSessionReader } from './sessions.js';
import { FakeDshServer } from '../../runner/dsh/fake-dsh-server.js';
import type { DshSessionEvent } from '../../runner/dsh/types.js';

const CWD = '/home/user/project';
const OTHER = '/home/user/other';
const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const SID_C = 'cccccccc-1111-2222-3333-444444444444';

function makeReader(server: FakeDshServer): DshSessionReader {
  return new DshSessionReader({
    host: server.baseUrl,
    syncRequest: (_baseUrl, method, payload) => {
      const resp = server.dispatchSync(method, payload);
      if (resp.result.ok !== true) {
        throw new Error(resp.result.error.message);
      }
      return resp.result.value;
    },
  });
}

describe('DshSessionReader', () => {
  it('listSessions filters by cwd, sorts by updatedAt desc, and paginates locally', () => {
    const server = new FakeDshServer();
    server.register('session.list', () => ({
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
    server.register('session.list', () => ({
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
    server.register('session.history', () => ({
      ok: true,
      value: {
        hasMore: false,
        events: [
          { event: userMsg(SID_A, 'hello dsh'), view: undefined },
          {
            event: assistantMsg(SID_A, 'hi there', { inputTokens: 100, outputTokens: 30 }),
            view: undefined,
          },
          { event: toolCall(SID_A, 'bash', '{"cmd":"ls"}'), view: undefined },
          { event: toolResult(SID_A, 'file list output'), view: undefined },
        ],
      },
    }));

    const reader = makeReader(server);
    const content = reader.readSessionContent(SID_A, CWD, { maxEvents: 10 });

    expect(content.events.map((e) => e.type)).toEqual([
      'user',
      'assistant',
      'tool_use',
      'tool_result',
    ]);
    expect(content.events[0].content).toBe('hello dsh');
    expect(content.events[1].content).toBe('hi there');
    expect(content.events[2].content).toContain('bash');
    expect(content.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      cumulativeTotalTokens: 130,
    });
  });

  it('readSessionContent caps events with maxEvents (tail cap)', () => {
    const server = new FakeDshServer();
    server.register('session.history', () => ({
      ok: true,
      value: {
        hasMore: false,
        events: [
          { event: userMsg(SID_A, 'one'), view: undefined },
          { event: assistantMsg(SID_A, 'two', undefined), view: undefined },
          { event: assistantMsg(SID_A, 'three', undefined), view: undefined },
        ],
      },
    }));

    const reader = makeReader(server);
    const content = reader.readSessionContent(SID_A, CWD, { maxEvents: 2 });
    expect(content.events).toHaveLength(2);
    expect(content.events[1].content).toBe('three');
  });

  it('usage: contextLength reflects only the last assistant/message (cumulative sums full session)', () => {
    const server = new FakeDshServer();
    server.register('session.history', () => ({
      ok: true,
      value: {
        hasMore: false,
        events: [
          {
            event: assistantMsg(SID_A, 'first turn', {
              inputTokens: 100,
              outputTokens: 30,
            }),
            view: undefined,
          },
          {
            event: assistantMsg(SID_A, 'last turn', {
              inputTokens: 200,
              outputTokens: 60,
              cacheReadTokens: 20,
              cacheWriteTokens: 10,
            }),
            view: undefined,
          },
        ],
      },
    }));

    const reader = makeReader(server);
    const content = reader.readSessionContent(SID_A, CWD);

    expect(content.usage).toMatchObject({
      // Per-turn "current window" = LAST assistant/message only (ccusage 口径).
      inputTokens: 200,
      outputTokens: 60,
      contextLength: 200 + 20 + 10, // last input + cacheRead + cacheWrite (excludes output)
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

  it('isSessionActive reflects the running flag for a cwd-matched session', () => {
    const server = new FakeDshServer();
    server.register('session.list', () => ({
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

  it('returns empty results on DSH error (fail-soft)', () => {
    const server = new FakeDshServer();
    server.register('session.list', () => ({
      ok: false,
      error: { code: 'internal', message: 'boom' },
    }));

    const reader = makeReader(server);
    expect(reader.listSessions(CWD)).toEqual({ sessions: [], total: 0 });
    expect(reader.getNewestSession(CWD)).toBeNull();
    expect(reader.isSessionActive(SID_A, CWD)).toBe(false);
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

function toolResult(sessionId: string, output: string): DshSessionEvent {
  void sessionId;
  return {
    type: 'tool/result',
    seq: 4,
    time: 1700000000000,
    data: { turn: 0, step: 0, message: { role: 'tool', content: output }, callId: 'call-1' },
  };
}

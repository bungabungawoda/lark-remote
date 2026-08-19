/**
 * DshClient WebSocket transport tests.
 *
 * The real DSH `/api/events.mux` is a WebSocket upgrade endpoint. These tests
 * use synthetic fetches and a scripted WebSocket factory — no real sessions or
 * real network addresses.
 */

import { describe, expect, it } from 'vitest';
import { DshClient, type WebSocketFactory } from './client.js';
import { DshRunner } from './runner.js';
import type { AgentSessionReader, AgentEvent } from '../types.js';
import type { DshServerRequest, DshSessionEvent } from './types.js';

const CWD = '/home/user/project';
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

const stubReader: AgentSessionReader = {
  listSessions: () => ({ sessions: [], total: 0 }),
  getNewestSession: () => null,
  readSessionContent: () => ({ events: [] }),
  isSessionActive: () => false,
};

function textChunk(delta: string, seq: number): DshSessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 1700000000000,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: delta } },
  };
}

function turnEnd(reason: string, seq: number): DshSessionEvent {
  return {
    type: 'turn/end',
    seq,
    time: 1700000000000,
    data: { turn: 1, reason: { kind: reason } },
  };
}

function frame(method: string, payload: unknown): DshServerRequest {
  return {
    type: 'server-request',
    rpcId: `mux-${Math.random().toString(36).slice(2)}`,
    method,
    payload,
  };
}

class ScriptedWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    readonly messages: DshServerRequest[],
  ) {
    setTimeout(() => {
      for (const message of messages) this.onmessage?.({ data: JSON.stringify(message) });
      this.onclose?.({});
    }, 0);
  }

  close(): void {}
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: true, value } }),
  } as unknown as Response;
}

describe('DshClient WebSocket mux fallback', () => {
  it('switches from HTTP 426 to WebSocket and consumes live session events', async () => {
    let muxGetCalls = 0;
    let webSocketCreated = 0;

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'GET' && url.endsWith('/api/events.mux')) {
        muxGetCalls++;
        return {
          ok: false,
          status: 426,
          body: null,
        } as unknown as Response;
      }

      const method = url.split('/').pop() ?? '';
      if (method === 'session.history') return jsonResponse({ events: [] });
      if (method === 'session.prompt') return jsonResponse({ accepted: true });
      if (method === 'session.cancel') return jsonResponse({ accepted: true });
      throw new Error(`unexpected unary ${method}`);
    }) as typeof fetch;

    const webSocketImpl: WebSocketFactory = (url) => {
      webSocketCreated++;
      return new ScriptedWebSocket(url, [
        frame('session/subscribed', {
          type: 'session/subscribed',
          sessionId: SID,
          lastSeq: 0,
        }),
        frame('session/event', {
          type: 'session/event',
          sessionId: SID,
          event: textChunk('live websocket ', 1),
        }),
        frame('session/event', {
          type: 'session/event',
          sessionId: SID,
          event: turnEnd('completed', 2),
        }),
      ]);
    };

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: 'http://127.0.0.1:3080',
      fetchImpl,
      webSocketImpl,
    });

    const events = await collect(runner.run('live question', { cwd: CWD, sessionId: SID }));
    const texts = events
      .filter((e) => e.type === 'assistant')
      .map((e) => e.message.content.find((c) => c.type === 'text'))
      .filter((c): c is { type: 'text'; text: string } => !!c)
      .map((c) => c.text);

    expect(texts).toEqual(['live websocket ']);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
    expect(muxGetCalls).toBe(1);
    expect(webSocketCreated).toBe(1);
  });

  it('parses only server-request envelopes from WebSocket messages', async () => {
    const client = new DshClient('http://127.0.0.1:3080', fetch, (url) => {
      return new ScriptedWebSocket(url, [
        frame('session/subscribed', { type: 'session/subscribed', sessionId: SID }),
        frame('session/event', {
          type: 'session/event',
          sessionId: SID,
          event: textChunk('first ', 1),
        }),
        frame('session/event', {
          type: 'session/event',
          sessionId: SID,
          event: textChunk('second', 2),
        }),
      ]);
    });

    const seen: DshServerRequest[] = [];
    for await (const item of client.muxWebSocket(new AbortController().signal)) {
      seen.push(item);
    }

    expect(seen.map((f) => f.method)).toEqual([
      'session/subscribed',
      'session/event',
      'session/event',
    ]);
    expect(seen[1].payload).toMatchObject({ type: 'session/event', sessionId: SID });
  });
});

describe('DshClient config-plane unary methods', () => {
  it('selectModel posts provider/model/reasoningEffort and returns selected', async () => {
    let posted: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body));
      return jsonResponse({
        selected: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'max',
        },
      });
    }) as typeof fetch;

    const client = new DshClient('http://127.0.0.1:3080', fetchImpl);
    const selected = await client.selectModel({
      sessionId: SID,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
    expect(posted).toMatchObject({
      method: 'session.selectModel',
      payload: {
        sessionId: SID,
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      },
    });
    expect(selected).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
  });

  it('listModels returns the model catalog groups', async () => {
    const catalog = {
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek Official',
          models: [{ id: 'deepseek-v4-flash', name: 'Flash' }],
        },
      ],
      failures: [],
    };
    const fetchImpl = (async () => jsonResponse(catalog)) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', fetchImpl);
    const value = await client.listModels();
    expect(value.groups[0].models[0].id).toBe('deepseek-v4-flash');
  });

  it('listPresets returns preset entries', async () => {
    const value = {
      presets: [{ id: 'code', trust: 'system', isDefault: false, name: 'PTC 模式' }],
      authorable: false,
      hasDocument: false,
    };
    const fetchImpl = (async () => jsonResponse(value)) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', fetchImpl);
    const result = await client.listPresets();
    expect(result.presets[0].id).toBe('code');
  });

  it('createSession passes agentPreset through', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const posted = JSON.parse(String(init?.body)) as { payload: unknown };
      expect(posted.payload).toEqual({ cwd: CWD, agentPreset: 'code' });
      return jsonResponse({ sessionId: SID, agentPreset: 'code' });
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', fetchImpl);
    const created = await client.createSession({ cwd: CWD, agentPreset: 'code' });
    expect(created).toEqual({ sessionId: SID, agentPreset: 'code' });
  });
});
